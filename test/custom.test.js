import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { ControlAgent, GuardrailError } from '../src/control.js';
import { validateCompanyInput } from '../src/guardrails.js';
import { validateWorkflow } from '../src/workflow.js';
import { SAMPLE_FORM } from '../src/sample.js';

// The model is stubbed: no network, no keys, deterministic replies.
const realFetch = globalThis.fetch;
const realLookup = dns.lookup;
let requests;
let respond;

beforeEach(() => {
  requests = [];
  respond = (system) => (system.includes('custom analysis agent') ? 'CUSTOM-OUTPUT: raise the mid tier price 8%.' : 'CONSULTANT-OUTPUT.');
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages.find((m) => m.role === 'system').content;
    const user = body.messages.find((m) => m.role === 'user').content;
    requests.push({ system, user });
    const out = respond(system, user);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  dns.lookup = realLookup;
});

const llm = { provider: 'openai', model: 'm', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test-0123456789' };
const pricing = { id: 'custom-abc123', name: 'Pricing strategist', prompt: 'Act as a pricing strategist. Propose three pricing experiments using the KPIs and sentiment.' };
const order = ['collector', 'parser', 'analyzer', 'refiner', 'leadgen', 'forecaster', 'consultant', 'custom-abc123', 'visualizer'];

const wait = async (job) => {
  const start = Date.now();
  while (job.status !== 'completed' && job.status !== 'failed') {
    if (Date.now() - start > 15_000) throw new Error('job timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
  return job;
};

test('custom agents: names and instructions are required and limited', () => {
  const bad = (customAgents) => validateCompanyInput({ ...SAMPLE_FORM, customAgents }).errors.join(' | ');
  assert.match(bad([{ id: 'custom-abc123', name: 'A', prompt: 'long enough instructions here' }]), /name of at least 2/);
  assert.match(bad([{ id: 'custom-abc123', name: 'Okay', prompt: 'too short' }]), /instructions of at least 10/);
  assert.match(bad([{ id: 'bad id', name: 'Okay', prompt: 'long enough instructions here' }]), /invalid id/);
  const dup = { id: 'custom-abc123', name: 'Okay', prompt: 'long enough instructions here' };
  assert.match(bad([dup, dup]), /duplicate id/);
  assert.match(bad(Array.from({ length: 6 }, (_, i) => ({ ...dup, id: `custom-abc12${i}` }))), /At most 5/);
  assert.match(bad('nope'), /must be a list/);
});

test('custom agents: they must be defined, and must run after the parser and refiner', () => {
  assert.equal(validateWorkflow(order, [pricing]).ok, true);
  assert.match(validateWorkflow(order, []).errors[0], /Unknown agent "custom-abc123"/);
  const early = ['parser', 'custom-abc123', 'analyzer', 'refiner', 'consultant', 'visualizer'];
  assert.ok(validateWorkflow(early, [pricing]).errors.some((e) => e.includes('Pricing strategist must run after Refiner')));
  assert.ok(validateWorkflow(['parser', 'analyzer', 'refiner', 'consultant', 'visualizer', 'custom-abc123'], [pricing]).errors.some((e) => e.includes('Visualizer must be the last')));
});

test('custom agents: the prompt harness carries the user instructions and keeps data separate and untrusted', async () => {
  const job = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, workflow: order, customAgents: [pricing], llm }));
  assert.equal(job.status, 'completed', job.error ?? '');
  const call = requests.find((r) => r.system.includes('custom analysis agent'));
  assert.ok(call.system.includes('"Pricing strategist"'));
  assert.ok(call.system.includes('<instructions>\nAct as a pricing strategist.'), 'user instructions go in the trusted section');
  assert.match(call.system, /untrusted/);
  assert.match(call.user, /^<data>\n\{/, 'company facts are passed as data');
  assert.ok(call.user.includes('"kpis"') && call.user.includes('"insights"') && call.user.includes('"recommendations"'));
  assert.ok(!call.user.includes('Act as a pricing strategist'), 'instructions are not mixed into the data');
  assert.ok(!call.user.includes('jane.doe@example.com'), 'redacted data only');
});

test('custom agents: the answer becomes a dashboard widget and the agent shows in the run', async () => {
  const job = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, workflow: order, customAgents: [pricing], llm }));
  const widget = job.result.widgets.find((w) => w.id === 'custom-abc123');
  assert.equal(widget.custom, true);
  assert.equal(widget.title, 'Pricing strategist');
  assert.equal(widget.body, 'CUSTOM-OUTPUT: raise the mid tier price 8%.');
  assert.deepEqual(job.pipeline.map((p) => p.name), order);
  assert.equal(job.agents['custom-abc123'].status, 'done');
  assert.ok(job.result.meta.stages.includes('custom-abc123'));
});

test('custom agents: with no model they are skipped, and the dashboard says why', async () => {
  process.env.OLLAMA_DISABLED = '1';
  try {
    const job = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, workflow: order, customAgents: [pricing] }));
    assert.equal(job.status, 'completed', job.error ?? '');
    const widget = job.result.widgets.find((w) => w.id === 'custom-abc123');
    assert.match(widget.body, /Skipped: this agent needs a model/);
    assert.equal(requests.length, 0);
  } finally {
    delete process.env.OLLAMA_DISABLED;
  }
});

test('custom agents: a failing model does not lose the dashboard', async () => {
  respond = (system) => (system.includes('custom analysis agent') ? new Response('{"error":{"message":"boom"}}', { status: 500 }) : 'CONSULTANT-OUTPUT.');
  const job = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, workflow: order, customAgents: [pricing], llm }));
  assert.equal(job.status, 'completed', job.error ?? '');
  assert.match(job.result.widgets.find((w) => w.id === 'custom-abc123').body, /Failed: LLM HTTP 500/);
  assert.ok(job.result.widgets.find((w) => w.id === 'summary').body.includes('CONSULTANT-OUTPUT'));
});

test('custom agents: several run in order and later ones see earlier notes', async () => {
  const second = { id: 'custom-def456', name: 'Risk reviewer', prompt: 'Review the risks in the analysis and rank the top three.' };
  const two = ['parser', 'analyzer', 'refiner', 'consultant', 'custom-abc123', 'custom-def456', 'visualizer'];
  const job = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, workflow: two, customAgents: [pricing, second], llm }));
  assert.equal(job.status, 'completed', job.error ?? '');
  const calls = requests.filter((r) => r.system.includes('custom analysis agent'));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].user.includes('notesFromEarlierCustomAgents') && calls[1].user.includes('CUSTOM-OUTPUT'));
  assert.ok(!calls[0].user.includes('CUSTOM-OUTPUT'));
});

test('guidance: the consultant summary prompt includes the user guidance, and omits it when empty', async () => {
  const guided = await wait(new ControlAgent().submit({ ...SAMPLE_FORM, llm, guidance: 'Write for a CFO. Lead with cash impact.' }));
  assert.equal(guided.status, 'completed');
  const withGuidance = requests.find((r) => r.system.includes('senior business consultant'));
  assert.ok(withGuidance.system.includes('Extra guidance from the user'));
  assert.ok(withGuidance.system.includes('Write for a CFO. Lead with cash impact.'));
  requests.length = 0;
  await wait(new ControlAgent().submit({ ...SAMPLE_FORM, llm }));
  assert.ok(!requests.find((r) => r.system.includes('senior business consultant')).system.includes('Extra guidance'));
});

test('custom agents: invalid definitions are rejected before any agent runs', () => {
  const control = new ControlAgent();
  assert.throws(() => control.submit({ ...SAMPLE_FORM, workflow: order, customAgents: [{ ...pricing, prompt: 'short' }] }), GuardrailError);
  assert.equal(control.jobs.size, 0);
});
