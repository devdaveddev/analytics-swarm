// Optional local-LLM narrative via the Ollama API. Runs on by default; set OLLAMA_DISABLED=1 to turn it off.
// Env: OLLAMA_HOST (default http://localhost:11434), OLLAMA_MODEL (default qwen2.5:3b),
// OLLAMA_TIMEOUT_MS (default 90000; the consultant stage gets a 120 s budget to cover it).
const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

export const llmAvailable = () => process.env.OLLAMA_DISABLED !== '1';

export async function completeWithOllama({ system, user, maxTokens = 600 }) {
  if (!llmAvailable()) return null;
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 90_000;
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options: { num_predict: maxTokens, temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Ollama HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  return data.message?.content?.trim() || null;
}
