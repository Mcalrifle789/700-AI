// Provider abstraction. 700 AI is provider-agnostic: any OpenAI-compatible
// endpoint works out of the box, plus native Anthropic. Bring your own key.
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

// Streaming chat completion. Yields text deltas.
export async function* chatStream(provider, messages, { signal } = {}) {
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
  yield* sse(res, (json) => json.choices?.[0]?.delta?.content || '');
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
  yield* sse(res, (json) => (json.type === 'content_block_delta' ? json.delta?.text || '' : ''));
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
        const text = extract(JSON.parse(data));
        if (text) yield text;
      } catch {
        /* ignore keep-alive / non-JSON frames */
      }
    }
  }
}

// Image generation (OpenAI-compatible /images/generations).
export async function generateImage(provider, prompt, { size = '1024x1024' } = {}) {
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
