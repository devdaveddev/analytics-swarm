import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { completeWithLLM, llmAvailable } from '../src/llm.js';

// No real network: fetch and DNS are replaced, so these tests also run offline and never send a key anywhere.
const realFetch = globalThis.fetch;
const realLookup = dns.lookup;
let calls;
let responder;

beforeEach(() => {
  calls = [];
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init, body: JSON.parse(init.body), headers: init.headers };
    calls.push(call);
    return responder(call, calls.length);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  dns.lookup = realLookup;
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ask = { system: 'Be brief.', user: 'Say hi.', maxTokens: 50 };

// ---------- OpenAI-compatible ----------

test('openai: posts to {baseUrl}/chat/completions with a bearer key and the documented body', async () => {
  responder = () => json({ choices: [{ message: { role: 'assistant', content: '  Hello there.  ' } }] });
  const text = await completeWithLLM(ask, { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://llm.example.com/v1/', apiKey: 'sk-abc123456789' });
  assert.equal(text, 'Hello there.');
  const [call] = calls;
  assert.equal(call.url, 'https://llm.example.com/v1/chat/completions', 'trailing slash is trimmed');
  assert.equal(call.headers.authorization, 'Bearer sk-abc123456789');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hi.' }]);
  assert.equal(call.body.model, 'gpt-4o-mini');
  assert.equal(call.body.max_tokens, 50);
  assert.equal(call.body.temperature, 0.3);
  assert.equal(call.init.redirect, 'error', 'redirects must not forward the key');
});

test('openai: defaults to api.openai.com and the default model when none is given', async () => {
  responder = () => json({ choices: [{ message: { content: 'ok' } }] });
  await completeWithLLM(ask, { provider: 'openai', apiKey: 'sk-abc123456789' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
});

test('openai: a reasoning model that rejects max_tokens is retried with max_completion_tokens and no temperature', async () => {
  responder = (_call, n) => n === 1
    ? json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400)
    : json({ choices: [{ message: { content: 'Retried fine.' } }] });
  const text = await completeWithLLM(ask, { provider: 'openai', model: 'o-series', apiKey: 'sk-abc123456789' });
  assert.equal(text, 'Retried fine.');
  assert.equal(calls.length, 2);
  assert.ok('max_tokens' in calls[0].body);
  assert.ok(!('max_tokens' in calls[1].body) && !('temperature' in calls[1].body));
  assert.ok(calls[1].body.max_completion_tokens >= 1024, 'reasoning tokens need headroom');
});

test('openai: other failures are not retried and never echo the key', async () => {
  responder = () => json({ error: { message: 'Incorrect API key provided: sk-abc123456789. Check your key.' } }, 401);
  await assert.rejects(
    completeWithLLM(ask, { provider: 'openai', apiKey: 'sk-abc123456789' }),
    (err) => err.message.includes('401') && !err.message.includes('sk-abc123456789') && err.message.includes('[redacted]'),
  );
  assert.equal(calls.length, 1, '401 must not be retried');
});

test('openai: an unrelated 400 mentioning neither parameter is not retried', async () => {
  responder = () => json({ error: { message: 'The model does not exist.' } }, 400);
  await assert.rejects(completeWithLLM(ask, { provider: 'openai', model: 'nope', apiKey: 'sk-abc123456789' }), /does not exist/);
  assert.equal(calls.length, 1);
});

test('openai: an empty choices list gives no text instead of crashing', async () => {
  responder = () => json({ choices: [] });
  assert.equal(await completeWithLLM(ask, { provider: 'openai', apiKey: 'sk-abc123456789' }), null);
});

test('openai: private and loopback base URLs are refused before any request is made', async () => {
  responder = () => json({});
  for (const baseUrl of ['http://127.0.0.1:8000/v1', 'http://localhost:1234/v1']) {
    dns.lookup = async (host) => [{ address: host === 'localhost' ? '127.0.0.1' : host, family: 4 }];
    await assert.rejects(completeWithLLM(ask, { provider: 'openai', baseUrl, apiKey: 'sk-abc123456789' }), /Private|loopback/);
  }
  assert.equal(calls.length, 0, 'the key must never be sent to a private address');
});

// ---------- Anthropic ----------

test('anthropic: posts to /v1/messages with x-api-key, anthropic-version and a top-level system field', async () => {
  responder = () => json({ content: [{ type: 'text', text: 'Hi.' }], stop_reason: 'end_turn' });
  const text = await completeWithLLM(ask, { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-ant-abc123456789' });
  assert.equal(text, 'Hi.');
  const [call] = calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-abc123456789');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers.authorization, undefined, 'Anthropic does not use a bearer header');
  assert.equal(call.body.system, 'Be brief.');
  assert.deepEqual(call.body.messages, [{ role: 'user', content: 'Say hi.' }]);
  assert.equal(call.body.max_tokens, 50);
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.init.redirect, 'error');
});

test('anthropic: only text blocks are returned, joined in order, and other block types are ignored', async () => {
  responder = () => json({ content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'text', text: 'First.' },
    { type: 'tool_use', id: 't1', name: 'x', input: {} },
    { type: 'text', text: 'Second.' },
  ] });
  assert.equal(await completeWithLLM(ask, { provider: 'anthropic', apiKey: 'sk-ant-abc123456789' }), 'First.\nSecond.');
});

test('anthropic: errors keep the status and hide the key', async () => {
  responder = () => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-abc123456789' } }, 401);
  await assert.rejects(
    completeWithLLM(ask, { provider: 'anthropic', apiKey: 'sk-ant-abc123456789' }),
    (err) => err.status === 401 && !err.message.includes('sk-ant-abc123456789'),
  );
});

// ---------- availability ----------

test('availability: keyed providers need a key, and an unknown provider is never available', () => {
  assert.equal(llmAvailable({ provider: 'openai', apiKey: '' }), false);
  assert.equal(llmAvailable({ provider: 'anthropic', apiKey: '' }), false);
  assert.equal(llmAvailable({ provider: 'openai', apiKey: 'k' }), true);
  assert.equal(llmAvailable({ provider: 'anthropic', apiKey: 'k' }), true);
  assert.equal(llmAvailable({ provider: 'constructor', apiKey: 'k' }), false);
});
