import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlAgent, PIPELINE } from './src/control.js';
import { llmAvailable } from './src/llm.js';
import { SAMPLE_FORM } from './src/sample.js';
import { feedbackStats, loadFeedback, recordRecommendationVote, recordReviewCorrection } from './src/feedback.js';
import { sanitizeText } from './src/guardrails.js';
import { askDashboard } from './src/assistant.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1_000_000;
const JOB_ID = /^[0-9a-f-]{36}$/;

// Clean URLs for the multi-page site. Every page opens in the same window (no target=_blank).
const PAGES = { '/': 'index.html', '/new': 'new.html', '/run': 'run.html', '/dashboard': 'dashboard.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const control = new ControlAgent({ maxConcurrent: Number(process.env.MAX_CONCURRENT) || 3 });
await loadFeedback();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is larger than 1 MB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function streamEvents(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...SECURITY,
  });
  const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

  job.events.forEach(send);
  if (job.status === 'completed' || job.status === 'failed') return res.end();

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    control.bus.off(job.id, onEvent);
  };
  const onEvent = (ev) => {
    send(ev);
    if (ev.type === 'end') {
      cleanup();
      res.end();
    }
  };
  control.bus.on(job.id, onEvent);
  req.on('close', cleanup);
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, llm: llmAvailable(), stages: PIPELINE.map((p) => p.name) });
  }
  if (req.method === 'GET' && pathname === '/api/sample') {
    return sendJson(res, 200, SAMPLE_FORM);
  }
  if (req.method === 'POST' && pathname === '/api/jobs') {
    const job = control.submit(await readJson(req));
    return sendJson(res, 202, {
      id: job.id,
      status: job.status,
      links: { run: `/run?id=${job.id}`, dashboard: `/dashboard?id=${job.id}` },
    });
  }

  if (req.method === 'GET' && pathname === '/api/feedback/stats') {
    return sendJson(res, 200, feedbackStats());
  }
  if (req.method === 'POST' && pathname === '/api/feedback') {
    const body = await readJson(req);
    if (body.type === 'review') {
      const label = ['positive', 'neutral', 'negative'].includes(body.label) ? body.label : null;
      const text = sanitizeText(body.text, 2000);
      if (!label || !text) throw new HttpError(400, 'Review feedback needs a label (positive, neutral or negative) and text.');
      const changed = recordReviewCorrection(text, label);
      return sendJson(res, 200, { ok: true, wordsLearned: changed, stats: feedbackStats() });
    }
    if (body.type === 'recommendation') {
      const area = sanitizeText(body.area, 80);
      if (!area || typeof body.helpful !== 'boolean') throw new HttpError(400, 'Recommendation feedback needs an area and a helpful flag.');
      const multiplier = recordRecommendationVote(area, body.helpful);
      return sendJson(res, 200, { ok: true, area, multiplier, stats: feedbackStats() });
    }
    throw new HttpError(400, 'Feedback type must be "review" or "recommendation".');
  }

  const ask = pathname.match(/^\/api\/jobs\/([^/]+)\/ask$/);
  if (ask && req.method === 'POST') {
    const job = JOB_ID.test(ask[1]) ? control.get(ask[1]) : null;
    if (!job) throw new HttpError(404, 'Unknown analysis.');
    if (job.status !== 'completed') throw new HttpError(409, 'Ask is available once the dashboard is ready.');
    const body = await readJson(req);
    const question = sanitizeText(body.question, 500);
    if (question.length < 3) throw new HttpError(400, 'Ask a question of at least 3 characters.');
    return sendJson(res, 200, await askDashboard(job.result, question));
  }

  const refresh = pathname.match(/^\/api\/jobs\/([^/]+)\/refresh$/);
  if (refresh && req.method === 'POST') {
    const previous = JOB_ID.test(refresh[1]) ? control.get(refresh[1]) : null;
    if (!previous) throw new HttpError(404, 'Unknown analysis.');
    const job = control.submit(previous.raw);
    return sendJson(res, 202, {
      id: job.id,
      status: job.status,
      links: { run: `/run?id=${job.id}`, dashboard: `/dashboard?id=${job.id}` },
    });
  }

  const match = pathname.match(/^\/api\/jobs\/([^/]+)(\/events|\/dashboard)?$/);
  if (match && req.method === 'GET') {
    const job = JOB_ID.test(match[1]) ? control.get(match[1]) : null;
    if (!job) throw new HttpError(404, 'Unknown analysis.');
    if (!match[2]) return sendJson(res, 200, control.snapshot(job));
    if (match[2] === '/events') return streamEvents(req, res, job);
    if (job.status !== 'completed') throw new HttpError(409, 'Dashboard is not ready yet.');
    return sendJson(res, 200, job.result);
  }

  throw new HttpError(404, 'Not found.');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Bad request path.');
  }
  const rel = PAGES[decoded] ?? decoded.replace(/^\/+/, '') ?? '';
  const file = path.resolve(PUBLIC, rel || 'index.html');
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Forbidden.');

  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Page not found.');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...SECURITY,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    const isPageRequest = !req.url.startsWith('/api/');
    if (isPageRequest && status === 404) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY });
      return res.end('<!doctype html><title>Not found</title><h1>Page not found</h1><p><a href="/">Back to home</a></p>');
    }
    sendJson(res, status, {
      error: status >= 500 ? 'Internal error' : err.message,
      ...(err.errors ? { details: err.errors } : {}),
    });
  }
});

server.listen(PORT, () => {
  console.log(`Analytics swarm running at http://localhost:${PORT}`);
});
