// LLM client for the optional narrative and "Ask your data". Providers:
//   ollama     (default, no key): the server's own Ollama. Host comes from OLLAMA_HOST, never from the browser.
//   openai     any OpenAI-compatible /chat/completions API (OpenAI, OpenRouter, vLLM, LM Studio, ...)
//   anthropic  the Anthropic Messages API
// API keys come with each request from the user's browser. They are never written to disk or returned by the API.
import { assertPublicUrl } from './scrapers.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

export const PROVIDERS = {
  ollama: { label: 'Ollama (local, default)', needsKey: false, defaultModel: OLLAMA_MODEL },
  openai: { label: 'OpenAI-compatible', needsKey: true, defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', needsKey: true, defaultModel: 'claude-haiku-5-5' },
};

export const defaultLLM = () => ({ provider: 'ollama', model: OLLAMA_MODEL, baseUrl: '', apiKey: '' });

export function llmAvailable(llm = defaultLLM()) {
  const provider = llm?.provider ?? 'ollama';
  if (provider === 'ollama') return process.env.OLLAMA_DISABLED !== '1';
  return Boolean(PROVIDERS[provider] && llm.apiKey);
}

async function post(url, headers, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${url.includes('11434') ? 'Ollama' : 'LLM'} HTTP ${res.status}${detail ? `: ${detail.replace(/(key|token)[^,}]*/gi, '[redacted]')}` : ''}`);
  }
  return res.json();
}

export async function completeWithLLM({ system, user, maxTokens = 600 }, llm = defaultLLM()) {
  if (!llmAvailable(llm)) return null;
  const provider = llm?.provider ?? 'ollama';
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 90_000;
  const model = llm.model || PROVIDERS[provider].defaultModel;

  if (provider === 'ollama') {
    const data = await post(`${OLLAMA_HOST}/api/chat`, {}, {
      model,
      stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      options: { num_predict: maxTokens, temperature: 0.3 },
    }, timeoutMs);
    return data.message?.content?.trim() || null;
  }

  if (provider === 'openai') {
    const base = (llm.baseUrl || PROVIDERS.openai.defaultBaseUrl).replace(/\/+$/, '');
    await assertPublicUrl(base); // user-supplied URL: block private and loopback addresses
    const data = await post(`${base}/chat/completions`, { authorization: `Bearer ${llm.apiKey}` }, {
      model,
      max_tokens: maxTokens,
      temperature: 0.3,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, timeoutMs);
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' }, {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, timeoutMs);
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
}
