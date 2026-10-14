import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlAgent, GuardrailError } from '../src/control.js';
import { redactPII, validateCompanyInput, checkAgentOutput } from '../src/guardrails.js';
import { scoreText, aspectSentiments } from '../src/sentiment.js';
import { SAMPLE_FORM } from '../src/sample.js';
import { assertPublicUrl, detectKind, parseFeed, parseHtmlReviews, parseJsonReviews } from '../src/scrapers.js';
import { useFeedbackFile, recordReviewCorrection, recordRecommendationVote, feedbackStats, resetFeedbackForTests } from '../src/feedback.js';
import { getLearnedWeights, setLearnedWeights } from '../src/sentiment.js';
process.env.OLLAMA_DISABLED = '1'; // keep tests deterministic: no model calls
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

useFeedbackFile(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-test-')), 'feedback.json'));

const waitForJob = async (control, job, timeoutMs = 10_000) => {
  const started = Date.now();
  while (job.status !== 'completed' && job.status !== 'failed') {
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((r) => setTimeout(r, 10));
  }
  return job;
};

test('guardrails reject missing company name and missing metrics', () => {
  const verdict = validateCompanyInput({ companyName: 'A', metrics: '' });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('Company name')));
  assert.ok(verdict.errors.some((e) => e.includes('metrics')));
});

test('guardrails reject negative numbers and missing revenue', () => {
  const verdict = validateCompanyInput({
    companyName: 'Acme',
    metrics: 'month,revenue,leads\n2026-01,-5,10\n2026-02,,4',
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('revenue must be a non-negative number')));
  assert.ok(verdict.errors.some((e) => e.includes('Metrics row 2 revenue is required')));
});

test('guardrails accept the sample and normalise unknown industries to general', () => {
  const ok = validateCompanyInput(SAMPLE_FORM);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.metrics.length, 8);
  assert.equal(ok.value.reviews.length, 12);
  const unknown = validateCompanyInput({ ...SAMPLE_FORM, industry: 'astrology' });
  assert.equal(unknown.value.industry, 'general');
  assert.ok(unknown.warnings.length >= 1);
});

test('PII is redacted from review text', () => {
  const r = redactPII('Mail jane.doe@example.com or call 555-123-4567 about card 4111 1111 1111 1111');
  assert.ok(!r.text.includes('jane.doe@example.com'));
  assert.ok(!r.text.includes('555-123-4567'));
  assert.ok(!r.text.includes('4111 1111'));
  assert.equal(r.counts.email, 1);
  assert.equal(r.counts.phone, 1);
});

test('negation flips sentiment and intensifiers strengthen it', () => {
  assert.ok(scoreText('This is great').score > 0);
  assert.ok(scoreText('This is not great').score < 0);
  assert.ok(scoreText('This is extremely bad').score < scoreText('This is bad').score);
  assert.equal(scoreText('The box is blue').hits, 0);
});

test('aspect tagging attaches sentiment to the right feature area', () => {
  const a = aspectSentiments('Pricing feels expensive. Support was great.');
  assert.ok(a.price < 0);
  assert.ok(a.support > 0);
});

test('output guardrail rejects NaN and missing summaries', () => {
  assert.ok(checkAgentOutput('analyzer', { summary: 'ok', x: Number.NaN }).length > 0);
  assert.ok(checkAgentOutput('analyzer', { x: 1 }).includes('missing summary'));
  assert.deepEqual(checkAgentOutput('analyzer', { summary: 'ok', x: 1 }), []);
});

test('control agent runs the full swarm on sample data and produces a dashboard', async () => {
  const control = new ControlAgent({ maxConcurrent: 2 });
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));

  assert.equal(job.status, 'completed', job.error ?? '');
  for (const name of ['collector', 'parser', 'analyzer', 'refiner', 'leadgen', 'consultant', 'visualizer']) {
    assert.equal(job.agents[name].status, 'done', `${name} should be done`);
  }

  const dash = job.result;
  assert.equal(dash.currency, 'USD');
  assert.equal(dash.kpiTiles.length, 7);
  const types = dash.widgets.map((w) => w.type);
  assert.deepEqual(types, ['line', 'forecast', 'graph', 'funnel', 'donut', 'bars', 'insights', 'table', 'documents', 'table', 'reviews', 'text']);

  const sentiment = dash.widgets.find((w) => w.id === 'sentiment');
  const total = sentiment.slices.reduce((a, s) => a + s.value, 0);
  assert.equal(total, 12);

  const reviews = dash.widgets.find((w) => w.type === 'reviews');
  assert.ok(reviews.items.every((r) => !r.text.includes('jane.doe@example.com')), 'PII must not reach the dashboard');

  const insights = dash.widgets.find((w) => w.type === 'insights').items;
  assert.ok(insights.some((i) => i.title === 'Revenue is growing'));
});

test('control agent rejects invalid input before starting any agent', () => {
  const control = new ControlAgent();
  assert.throws(() => control.submit({ companyName: '' }), GuardrailError);
  assert.equal(control.jobs.size, 0);
});

test('control agent emits ordered events ending with an end event', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const seqs = job.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(job.events.at(-1).type, 'end');
  const started = job.events.filter((e) => e.type === 'agent' && e.status === 'running').map((e) => e.agent);
  assert.deepEqual(started, ['collector', 'parser', 'analyzer', 'refiner', 'leadgen', 'forecaster', 'consultant', 'visualizer']);
});

test('SSRF guard rejects private, loopback, local and credentialed URLs', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1/reviews'), /Private|loopback/);
  await assert.rejects(assertPublicUrl('http://localhost:8080/reviews'), /Private|loopback/);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /Private|loopback/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /Only http/);
  await assert.rejects(assertPublicUrl('https://user:pass@example.com/'), /credentials/);
});

test('feed parser extracts items and strips markup and CDATA', () => {
  const xml = `<rss><channel>
    <item><title>Great tool</title><description><![CDATA[<p>Setup was <b>fast</b> &amp; easy</p>]]></description></item>
    <item><title>Broken export</title><description>Exports time out.</description></item>
  </channel></rss>`;
  assert.equal(detectKind('application/rss+xml', xml), 'feed');
  const items = parseFeed(xml, 'https://example.com/feed');
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'Great tool. Setup was fast & easy');
  assert.equal(items[0].rating, null);
});

test('JSON review parser accepts arrays or wrapped lists and reads ratings', () => {
  const wrapped = JSON.stringify({ reviews: [{ body: 'Solid product', stars: 5 }, { text: 'Too slow', rating: 9 }] });
  const items = parseJsonReviews(wrapped, 'https://example.com/r.json');
  assert.equal(items.length, 2);
  assert.equal(items[0].rating, 5);
  assert.equal(items[1].rating, null, 'out-of-range ratings are dropped');
  assert.throws(() => parseJsonReviews('not json', 's'), /not valid JSON/);
});

test('HTML scraper pulls review bodies from itemprop and review-class markup', () => {
  const html = `<div itemprop="review"><span itemprop="reviewBody">Love the dashboards &amp; alerts</span></div>
    <p class="review-text">Pricing is <em>high</em></p>`;
  const items = parseHtmlReviews(html, 'https://example.com/p');
  assert.deepEqual(items.map((i) => i.text), ['Love the dashboards & alerts']);
});

test('feedback: a review correction moves word weights toward the chosen label', () => {
  resetFeedbackForTests();
  const before = scoreWord('dashboards');
  recordReviewCorrection('The dashboards are sluggish and dashboards keep freezing', 'negative');
  const after = scoreWord('dashboards');
  assert.ok(after < before, `expected ${after} < ${before}`);
  assert.ok(getLearnedWeights().sluggish < 0);
  assert.equal(feedbackStats().corrections, 1);
});

test('feedback: helpful votes raise and unhelpful votes lower an area multiplier within bounds', () => {
  resetFeedbackForTests();
  assert.ok(recordRecommendationVote('Pricing', true) > 1);
  for (let i = 0; i < 40; i++) recordRecommendationVote('Pricing', false);
  assert.equal(feedbackStats().areaMultipliers.Pricing, 0.5, 'multiplier is clamped at 0.5');
  assert.equal(feedbackStats().votes.notHelpful, 40);
});

test('feedback changes the next run: a learned negative word lowers the review score', async () => {
  resetFeedbackForTests();
  const control = new ControlAgent();
  const first = await waitForJob(control, control.submit(SAMPLE_FORM));
  const avgBefore = first.result.kpiTiles.find((t) => t.label === 'Net review sentiment').value;
  // Users have marked praise words as negative in this workspace; the next run should reflect that.
  setLearnedWeights({ great: -0.9, love: -0.9, intuitive: -0.9, fantastic: -0.9 });
  const second = await waitForJob(control, control.submit(SAMPLE_FORM));
  const avgAfter = second.result.kpiTiles.find((t) => t.label === 'Net review sentiment').value;
  assert.equal(second.status, 'completed');
  assert.ok(avgAfter < avgBefore, `expected ${avgAfter} < ${avgBefore}`);
  resetFeedbackForTests();
});

test('documents: fenced sections become titled documents with facts and a summary', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const docs = job.result.widgets.find((w) => w.type === 'documents').items;
  assert.equal(docs.length, 2);
  assert.equal(docs[0].title, 'Q3 customer call notes');
  assert.ok(docs[0].facts.some((f) => f.includes('18%')));
  assert.ok(docs[0].summary.length > 0);
});

test('graph: every edge joins two nodes that exist, and columns run left to right', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const graph = job.result.widgets.find((w) => w.type === 'graph');
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.length > 0);
  for (const e of graph.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `dangling edge ${e.from} -> ${e.to}`);
  }
  assert.ok(graph.nodes.every((n) => n.x >= 0 && n.x <= 1 && n.y > 0 && n.y < 1));
});

test('refresh re-runs a job from its original input', async () => {
  const control = new ControlAgent();
  const first = await waitForJob(control, control.submit(SAMPLE_FORM));
  const second = control.submit(first.raw);
  assert.notEqual(second.id, first.id);
  await waitForJob(control, second);
  assert.equal(second.status, 'completed');
});

function scoreWord(word) {
  return scoreText(word).score;
}

import { healthOf, ruleAnswer, dashboardContext } from '../src/assistant.js';

test('health headline reflects the worst insight severity', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const health = healthOf(job.result);
  assert.ok(['attention', 'watch', 'healthy'].includes(health.status));
  const critical = job.result.widgets.find((w) => w.type === 'insights').items.some((i) => i.severity === 'critical');
  assert.equal(health.status === 'attention', critical);
});

test('ask: rule-based answers quote the right KPI and refuse unknown questions gracefully', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const revenue = ruleAnswer(job.result, 'what is our revenue?');
  assert.ok(revenue.startsWith('Monthly revenue:'), revenue);
  const unknown = ruleAnswer(job.result, 'what is the weather in Paris');
  assert.ok(unknown.includes('KPIs'));
});

test('ask context exposes the forecast and never includes raw review text', async () => {
  const control = new ControlAgent();
  const job = await waitForJob(control, control.submit(SAMPLE_FORM));
  const ctx = dashboardContext(job.result);
  const forecast = job.result.widgets.find((w) => w.type === 'forecast');
  assert.equal(forecast.points.filter((p) => p.projected).length, 3);
  assert.deepEqual(ctx.forecast, forecast.points);
  assert.ok(!JSON.stringify(ctx).includes('Setup took 10 minutes'), 'review text must not be sent to the model');
});

import { DEFAULT_ORDER, validateWorkflow } from '../src/workflow.js';
import { llmAvailable } from '../src/llm.js';

test('workflow: the default order is valid and every rule has a clear message', () => {
  assert.equal(validateWorkflow(DEFAULT_ORDER).ok, true);
  const swapped = validateWorkflow(['parser', 'refiner', 'analyzer', 'consultant', 'visualizer']);
  assert.equal(swapped.ok, false);
  assert.ok(swapped.errors.some((e) => e.includes('Refiner must run after Analyzer')));
  assert.ok(validateWorkflow(['parser', 'analyzer', 'refiner', 'consultant']).errors.some((e) => e.includes('Visualizer must be the last')));
  assert.ok(validateWorkflow(['parser', 'parser']).errors.some((e) => e.includes('more than once')));
  assert.ok(validateWorkflow(['constructor']).errors[0].includes('Unknown agent'));
  assert.ok(validateWorkflow(['analyzer', 'parser', 'refiner', 'consultant', 'visualizer']).errors.length > 0);
  assert.ok(validateWorkflow(DEFAULT_ORDER.filter((n) => n !== 'consultant')).errors.some((e) => e.includes('Consultant is required')));
});

test('workflow: optional agents can be removed and soft ordering only warns', () => {
  const trimmed = validateWorkflow(['parser', 'analyzer', 'refiner', 'consultant', 'visualizer']);
  assert.equal(trimmed.ok, true);
  const early = validateWorkflow(['parser', 'collector', 'analyzer', 'refiner', 'leadgen', 'forecaster', 'consultant', 'visualizer']);
  assert.equal(early.ok, true);
  assert.ok(early.warnings.some((w) => w.includes('Parser & Researcher runs before Collector')));
});

test('workflow: a reordered and trimmed pipeline runs end to end', async () => {
  const control = new ControlAgent();
  const workflow = ['parser', 'analyzer', 'refiner', 'forecaster', 'consultant', 'visualizer'];
  const job = await waitForJob(control, control.submit({ ...SAMPLE_FORM, workflow }));
  assert.equal(job.status, 'completed', job.error ?? '');
  assert.deepEqual(job.pipeline.map((p) => p.name), workflow);
  const types = job.result.widgets.map((w) => w.id);
  assert.ok(!types.includes('funnel'), 'no lead-gen agent, so no funnel');
  assert.ok(types.includes('forecast'));
  assert.deepEqual(job.result.meta.stages, workflow);
});

test('workflow: leadgen after consultant still completes, and invalid orders are rejected before any agent runs', async () => {
  const control = new ControlAgent();
  const order = ['collector', 'parser', 'analyzer', 'refiner', 'consultant', 'leadgen', 'forecaster', 'visualizer'];
  const job = await waitForJob(control, control.submit({ ...SAMPLE_FORM, workflow: order }));
  assert.equal(job.status, 'completed', job.error ?? '');
  assert.ok(job.warnings.some((w) => w.includes('Consultant runs before Lead Generation')));
  assert.throws(() => control.submit({ ...SAMPLE_FORM, workflow: ['visualizer', 'parser'] }), GuardrailError);
});

test('llm settings: ollama is the default; keys are kept out of snapshots and results', async () => {
  const control = new ControlAgent();
  const job = control.submit({ ...SAMPLE_FORM, llm: { provider: 'openai', model: 'x', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-secret-123' } });
  await waitForJob(control, job);
  const exposed = JSON.stringify(control.snapshot(job)) + JSON.stringify(job.result);
  assert.ok(!exposed.includes('sk-secret-123'), 'API key must never appear in API responses');
  assert.equal(llmAvailable(), process.env.OLLAMA_DISABLED !== '1');
  assert.equal(llmAvailable({ provider: 'openai', apiKey: '' }), false);
  assert.equal(llmAvailable({ provider: 'openai', apiKey: 'k' }), true);
  const bad = validateCompanyInput({ ...SAMPLE_FORM, llm: { provider: 'evil' } });
  assert.equal(bad.ok, false);
  const nokey = validateCompanyInput({ ...SAMPLE_FORM, llm: { provider: 'anthropic' } });
  assert.ok(nokey.warnings.some((w) => w.includes('No API key')));
});
