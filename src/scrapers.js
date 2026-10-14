// Live fetchers and scrapers for user-supplied source URLs.
// Supports RSS/Atom feeds, JSON review feeds and HTML pages with review markup.
// Guards: http(s) only, no credentials, no private/loopback addresses (also on redirects),
// robots.txt honoured, timeouts and a size cap. Every source is one-shot: nothing is crawled.
import dns from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT = 'AnalyticsSwarm/1.0 (one-shot business analytics fetch)';
const MAX_BYTES = 1_000_000;
const MAX_ITEMS = 300;
const robotsCache = new Map();

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    return a === '::1' || a === '::' || /^(fc|fd|fe[89ab])/.test(a) || a.startsWith('::ffff:');
  }
  return true;
}

export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  const records = await dns.lookup(url.hostname, { all: true }).catch(() => {
    throw new Error(`Could not resolve ${url.hostname}`);
  });
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new Error('Private, loopback or link-local addresses are not allowed');
  }
  return url;
}

async function robotsAllows(url) {
  const origin = url.origin;
  let rules = robotsCache.get(origin);
  if (!rules || rules.expires < Date.now()) {
    let disallow = [];
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (res.ok) {
        const lines = (await res.text()).split(/\r?\n/);
        let applies = false;
        for (const raw of lines) {
          const line = raw.split('#')[0].trim();
          const [key, ...rest] = line.split(':');
          const value = rest.join(':').trim();
          if (/^user-agent$/i.test(key)) applies = value === '*' || /analyticsswarm/i.test(value);
          else if (applies && /^disallow$/i.test(key) && value) disallow.push(value);
        }
      }
    } catch {
      disallow = []; // unreachable robots.txt is treated as no restrictions
    }
    rules = { disallow, expires: Date.now() + 10 * 60_000 };
    robotsCache.set(origin, rules);
  }
  return !rules.disallow.some((rule) => url.pathname.startsWith(rule));
}

export async function fetchText(startUrl, { timeoutMs = 8000 } = {}) {
  let url = await assertPublicUrl(startUrl);
  if (!(await robotsAllows(url))) throw new Error('Disallowed by robots.txt');

  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,application/rss+xml,application/atom+xml,text/xml;q=0.9,*/*;q=0.5',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).href);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error('Response is larger than 1 MB');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Response is larger than 1 MB');
    return { text: buffer.toString('utf8'), contentType: res.headers.get('content-type') ?? '', finalUrl: url.href };
  }
  throw new Error('Too many redirects');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function cleanText(html) {
  return String(html ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

const toRating = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

export function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const pick = (block, tags) => {
    for (const tag of tags) {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      if (m) return cleanText(m[1]);
    }
    return '';
  };
  return blocks
    .map((b) => {
      const title = pick(b, ['title']);
      const body = pick(b, ['content:encoded', 'content', 'description', 'summary']);
      return { rating: null, text: [title, body].filter(Boolean).join('. ').slice(0, 2000), source };
    })
    .filter((i) => i.text)
    .slice(0, MAX_ITEMS);
}

export function parseJsonReviews(json, source) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Response is not valid JSON');
  }
  const list = Array.isArray(data) ? data : data.reviews ?? data.items ?? data.data ?? [];
  if (!Array.isArray(list)) throw new Error('JSON has no list of reviews (expected an array or reviews/items/data)');
  return list
    .map((item) => {
      if (typeof item === 'string') return { rating: null, text: item, source };
      const text = item?.text ?? item?.body ?? item?.review ?? item?.content ?? item?.comment ?? '';
      return { rating: toRating(item?.rating ?? item?.stars ?? item?.score), text: cleanText(text).slice(0, 2000), source };
    })
    .filter((i) => i.text)
    .slice(0, MAX_ITEMS);
}

export function parseHtmlReviews(html, source) {
  const patterns = [
    /<([a-z0-9]+)\b[^>]*itemprop=["']reviewBody["'][^>]*>([\s\S]*?)<\/\1>/gi,
    /<([a-z0-9]+)\b[^>]*class=["'][^"']*\breview[-_]?(?:text|body|content)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi,
  ];
  const items = [];
  for (const pattern of patterns) {
    for (const m of html.matchAll(pattern)) {
      const text = cleanText(m[2]).slice(0, 2000);
      if (text) items.push({ rating: null, text, source });
    }
    if (items.length) break;
  }
  return items.slice(0, MAX_ITEMS);
}

export function detectKind(contentType, text) {
  const body = text.trimStart();
  if (/json/i.test(contentType) || body.startsWith('{') || body.startsWith('[')) return 'json';
  if (/rss|atom|xml/i.test(contentType) || /^<\?xml|^<rss|^<feed/i.test(body)) return 'feed';
  return 'html';
}

// Fetches one source and returns { url, status, kind, count, items } or { status: 'error', error }.
export async function fetchSource(url) {
  try {
    const { text, contentType, finalUrl } = await fetchText(url);
    const kind = detectKind(contentType, text);
    const items =
      kind === 'json' ? parseJsonReviews(text, url)
        : kind === 'feed' ? parseFeed(text, url)
          : parseHtmlReviews(text, url);
    return { url, status: 'ok', kind, finalUrl, count: items.length, items };
  } catch (err) {
    return { url, status: 'error', error: err.message, count: 0, items: [] };
  }
}
