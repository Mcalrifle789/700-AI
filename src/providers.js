// Provider abstraction. 700 AI is provider-agnostic: any OpenAI-compatible
// endpoint works out of the box, plus native Anthropic. Bring your own key.

// True when the endpoint is remote and therefore needs a real API key. Local
// endpoints (Ollama, localhost) are exempt.
export function requiresKey(provider) {
  const kind = provider?.kind || 'openai';
  return kind !== 'ollama' && !/localhost|127\.0\.0\.1/.test(provider?.baseURL || '');
}

// Guard: hosted providers must carry a real key. Blocks requests that would
// otherwise go out unauthenticated (e.g. the legacy 'ollama' placeholder saved
// for a hosted provider) and raises a coded NO_KEY error that the diagnostics
// layer renders as a self-healing report.
function keyGuard(provider) {
  if (!requiresKey(provider)) return;
  const key = provider?.apiKey;
  if (!key || key === 'ollama') {
    const err = new Error('NO_KEY: the configured provider requires an API key — run /setup');
    err.code = 'NO_KEY';
    throw err;
  }
}

export const PRESETS = [
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', kind: 'openai', defaultModel: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic (Claude)', baseURL: 'https://api.anthropic.com/v1', kind: 'anthropic', defaultModel: 'claude-opus-4-8' },
  { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', kind: 'openai', defaultModel: 'anthropic/claude-opus-4-8' },
  { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', kind: 'openai', defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', kind: 'openai', defaultModel: 'mistral-large-latest' },
  { id: 'together', label: 'Together AI', baseURL: 'https://api.together.xyz/v1', kind: 'openai', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'ollama', label: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', kind: 'openai', defaultModel: 'llama3.1' },
  { id: 'custom', label: 'Custom (any OpenAI-compatible URL)', baseURL: '', kind: 'openai', defaultModel: '' },
];

// Streaming chat completion. Yields events of the shape
//   { type: 'content' | 'reasoning', text }
// so callers can render a reasoning model's "thinking" separately from its
// actual answer (reasoning models stream most tokens as `reasoning`, with the
// real reply arriving in `content` — if you only render `content` the response
// looks empty/frozen).
export async function* chatStream(provider, messages, { signal } = {}) {
  keyGuard(provider);
  const kind = provider.kind || 'openai';
  if (kind === 'anthropic') {
    yield* anthropicStream(provider, messages, signal);
  } else {
    yield* openaiStream(provider, messages, signal);
  }
}

async function* openaiStream(provider, messages, signal) {
  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model: provider.model, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  yield* sse(res, (json) => {
    const d = json.choices?.[0]?.delta || {};
    if (d.content) return { type: 'content', text: d.content };
    // OpenRouter/others expose chain-of-thought as `reasoning`; some use
    // `reasoning_content`. Surface it so the UI can show "thinking".
    const r = d.reasoning ?? d.reasoning_content;
    if (r) return { type: 'reasoning', text: r };
    return null;
  });
}

async function* anthropicStream(provider, messages, signal) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const conv = messages.filter((m) => m.role !== 'system');
  const res = await fetch(`${provider.baseURL}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: provider.model, system, messages: conv, max_tokens: 4096, stream: true }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  yield* sse(res, (json) => {
    if (json.type !== 'content_block_delta') return null;
    const d = json.delta || {};
    if (d.type === 'thinking_delta' && d.thinking) return { type: 'reasoning', text: d.thinking };
    if (d.text) return { type: 'content', text: d.text };
    return null;
  });
}

// Minimal Server-Sent-Events reader shared by both provider kinds.
async function* sse(res, extract) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const ev = extract(JSON.parse(data));
        if (ev && ev.text) yield ev;
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    }
  }
}

// Image generation (OpenAI-compatible /images/generations).
export async function generateImage(provider, prompt, { size = '1024x1024' } = {}) {
  keyGuard(provider);
  const res = await fetch(`${provider.baseURL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model: provider.model, prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data?.[0]?.url || json.data?.[0]?.b64_json;
}

// List available models from the configured provider (live API call).
// Works for OpenAI-compatible providers (GET /models) and native Anthropic.
export async function listModels(provider) {
  keyGuard(provider);
  const kind = provider.kind || 'openai';
  const headers = kind === 'anthropic'
    ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${provider.apiKey}` };
  const res = await fetch(`${provider.baseURL}/models`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  const data = json.data || json.models || [];
  return data.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}
