// LLM client for the optional narrative and "Ask your data". Providers:
//   ollama     (default, no key): the server's own Ollama. Host comes from OLLAMA_HOST, never from the browser.
//   openai     any OpenAI-compatible /chat/completions API (OpenAI, OpenRouter, vLLM, LM Studio, ...)
//   anthropic  the Anthropic Messages API
// API keys come with each request from the user's browser. They are never written to disk or returned by the API.
import { assertPublicUrl } from './scrapers.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';

export const PROVIDERS = {
  ollama: { label: 'Ollama (local, default)', needsKey: false, defaultModel: OLLAMA_MODEL },
  openai: { label: 'OpenAI-compatible', needsKey: true, defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', needsKey: true, defaultModel: 'claude-haiku-5-5' },
};

export const DEFAULT_TEMPERATURE = 0.3;
export const clampTemperature = (t) => (Number.isFinite(Number(t)) ? Math.min(1, Math.max(0, Number(t))) : DEFAULT_TEMPERATURE);

export const defaultLLM = () => ({ provider: 'ollama', model: OLLAMA_MODEL, baseUrl: '', apiKey: '', temperature: DEFAULT_TEMPERATURE });

export function llmAvailable(llm = defaultLLM()) {
  const provider = llm?.provider ?? 'ollama';
  if (provider === 'ollama') return process.env.OLLAMA_DISABLED !== '1';
  return Object.hasOwn(PROVIDERS, provider) && Boolean(llm.apiKey);
}

// Removes the key (and anything shaped like one) from text that may be shown to the user.
function redact(text, secret) {
  let out = String(text);
  if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(/\b(sk|key|tok)-[A-Za-z0-9_-]{6,}/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

// redirect: 'error' keeps the API key from being forwarded to another host.
async function post(url, headers, body, timeoutMs, secret = '') {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = redact((await res.text().catch(() => '')).slice(0, 300), secret);
    const name = url.includes('11434') ? 'Ollama' : 'LLM';
    throw Object.assign(new Error(`${name} HTTP ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
  }
  return res.json();
}

// OpenAI's newer reasoning models reject max_tokens and a custom temperature and want max_completion_tokens.
// Older models and most compatible servers (OpenRouter, vLLM, LM Studio) accept max_tokens, so try that first.
async function openaiChat(base, llm, model, messages, maxTokens, temperature, timeoutMs) {
  const url = `${base}/chat/completions`;
  const headers = { authorization: `Bearer ${llm.apiKey}` };
  try {
    return await post(url, headers, { model, max_tokens: maxTokens, temperature, messages }, timeoutMs, llm.apiKey);
  } catch (err) {
    if (err.status !== 400 || !/max_completion_tokens|max_tokens|temperature/i.test(err.message)) throw err;
    // Reasoning tokens count toward the limit, so allow more room than the visible answer needs.
    return post(url, headers, { model, max_completion_tokens: Math.max(maxTokens * 4, 1024), messages }, timeoutMs, llm.apiKey);
  }
}

// temperature: 0 is the most consistent and factual, 1 the most varied. A per-call value beats the saved setting.
export async function completeWithLLM({ system, user, maxTokens = 600, temperature }, llm = defaultLLM()) {
  if (!llmAvailable(llm)) return null;
  const provider = llm?.provider ?? 'ollama';
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 90_000;
  const model = llm.model || PROVIDERS[provider].defaultModel;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const temp = clampTemperature(temperature ?? llm?.temperature);

  if (provider === 'ollama') {
    const data = await post(`${OLLAMA_HOST}/api/chat`, {}, {
      model,
      stream: false,
      messages,
      options: { num_predict: maxTokens, temperature: temp },
    }, timeoutMs);
    return data.message?.content?.trim() || null;
  }

  if (provider === 'openai') {
    const base = (llm.baseUrl || PROVIDERS.openai.defaultBaseUrl).replace(/\/+$/, '');
    await assertPublicUrl(base); // user-supplied URL: block private and loopback addresses
    const data = await openaiChat(base, llm, model, messages, maxTokens, temp, timeoutMs);
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  // Anthropic Messages API: system is a top-level field, and the reply is a list of typed content blocks.
  const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' }, {
    model,
    max_tokens: maxTokens,
    temperature: temp,
    system,
    messages: [{ role: 'user', content: user }],
  }, timeoutMs, llm.apiKey);
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
}
