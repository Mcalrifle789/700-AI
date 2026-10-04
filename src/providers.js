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

// ── transport ───────────────────────────────────────────────────────────────
// Every request gets a connect timeout (headers must arrive) and streams get
// an idle timeout (no bytes for too long => abort). Previously a stalled
// provider hung the REPL forever. Timeouts surface as ETIMEDOUT, which the
// diagnostics layer maps to the NETWORK report and the chat loop retries.
let CONNECT_MS = 60_000;
let IDLE_MS = 90_000;
export function setTransportTimeouts({ connectMs, idleMs } = {}) {
  if (connectMs) CONNECT_MS = connectMs;
  if (idleMs) IDLE_MS = idleMs;
}

function timeoutError(what, ms) {
  return Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`), { code: 'ETIMEDOUT' });
}

async function guardedFetch(url, init, { signal, connectMs } = {}) {
  connectMs ??= CONNECT_MS;
  const ctl = new AbortController();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, connectMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    res.controller = ctl;
    return res;
  } catch (e) {
    if (timedOut) throw timeoutError('connection', connectMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function failFrom(res) {
  const body = await res.text().catch(() => '');
  return Object.assign(new Error(`${res.status} ${body.slice(0, 600)}`), { status: res.status });
}

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
  const res = await guardedFetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model: provider.model, messages, stream: true }),
  }, { signal });
  if (!res.ok) throw await failFrom(res);
  yield* sse(res, (json) => {
    if (json.error) throw Object.assign(new Error(json.error.message || JSON.stringify(json.error)), { status: json.error.code });
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
  const res = await guardedFetch(`${provider.baseURL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: provider.model, system, messages: conv, max_tokens: 8192, stream: true }),
  }, { signal });
  if (!res.ok) throw await failFrom(res);
  yield* sse(res, (json) => {
    if (json.type === 'error') throw new Error(json.error?.message || 'provider stream error');
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
    let idle;
    const stalled = new Promise((_, reject) => {
      idle = setTimeout(() => { reject(timeoutError('stream', IDLE_MS)); res.controller?.abort(); }, IDLE_MS);
    });
    let chunk;
    const read = reader.read();
    read.catch(() => {}); // aborted by the idle timer — the race reports it
    try { chunk = await Promise.race([read, stalled]); }
    finally { clearTimeout(idle); }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { continue; } // keep-alive / non-JSON frame
      const ev = extract(json); // may throw a provider-reported error
      if (ev && ev.text) yield ev;
    }
  }
}

// Image generation (OpenAI-compatible /images/generations).
export async function generateImage(provider, prompt, { size = '1024x1024' } = {}) {
  keyGuard(provider);
  const res = await guardedFetch(`${provider.baseURL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model: provider.model, prompt, size, n: 1 }),
  }, { connectMs: 180_000 });
  if (!res.ok) throw await failFrom(res);
  const json = await res.json();
  return json.data?.[0]?.url || json.data?.[0]?.b64_json;
}

// List available models from a provider (live API call, ~15 s timeout).
// OpenAI-compatible: GET /models. Anthropic: GET /models, paginated.
// Returns a sorted, de-duplicated array of model ids.
export async function listModels(provider, { timeout = 15_000 } = {}) {
  keyGuard(provider);
  const kind = provider.kind || 'openai';
  const headers = kind === 'anthropic'
    ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
    : (provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {});
  const ids = new Set();
  let after = null;
  for (let page = 0; page < 20; page++) {
    const qs = kind === 'anthropic' ? `?limit=1000${after ? '&after_id=' + encodeURIComponent(after) : ''}` : '';
    const res = await guardedFetch(`${provider.baseURL}/models${qs}`, { headers }, { connectMs: timeout });
    if (!res.ok) throw await failFrom(res);
    const json = await res.json();
    const data = json.data || json.models || [];
    for (const m of data) { const id = typeof m === 'string' ? m : m.id || m.name; if (id) ids.add(id); }
    if (kind === 'anthropic' && json.has_more && json.last_id) { after = json.last_id; continue; }
    break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

// Dynamic model discovery across every configured provider, in parallel.
// Resolves { [providerId]: { models, error } } - one slow or failing provider
// never blocks the others.
export async function discoverModels(providers, opts) {
  const settled = await Promise.allSettled(providers.map((p) => listModels(p, opts)));
  const out = {};
  providers.forEach((p, i) => {
    const r = settled[i];
    out[p.id] = r.status === 'fulfilled' ? { models: r.value, error: null } : { models: null, error: r.reason };
  });
  return out;
}

export const presetFor = (id) => PRESETS.find((p) => p.id === id) || null;
