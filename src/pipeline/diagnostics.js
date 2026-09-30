// Self-Healing Diagnostics (spec 2.4). Raw stack traces are banned from
// production rendering: every operational block routes its failures through
// this module, which maps a known error to a structured report — module, status
// code, plain-language cause, and an ordered list of remediation steps — then
// draws it inside the DIAGNOSTIC FAILURE REPORT box from the spec.
//
// Steps use `backticks` to mark literal commands/paths; the renderer highlights
// those spans in white. Everything else is dim, numbered in gold.
import { c } from '../theme.js';
import { termWidth, visLen } from '../ui.js';

// ── Diagnostic registry ─────────────────────────────────────────────────────
const REGISTRY = {
  FFMPEG_MISSING: {
    module: 'Pipeline.Multimodal.MediaProbe',
    status: '0x409',
    cause: 'Missing ffmpeg system dependency required for waveform subsampling and keyframe extraction.',
    resolve: (x) => [
      'Install ffmpeg via your package manager: `brew install ffmpeg` (macOS), `winget install Gyan.FFmpeg` (Windows), or `apt install ffmpeg` (Linux).',
      'Verify the binary is on PATH: `ffmpeg -version`',
      'Re-stage the target file: `/stage ' + (x.path || '<filepath>') + '`',
    ],
  },
  OCR_REQUIRED: {
    module: 'Pipeline.Multimodal.DocumentExtract',
    status: '0x422',
    cause: 'The PDF carries no extractable text layer — it is a scan or image-only document.',
    resolve: () => [
      'Run OCR to add a text layer, e.g. `ocrmypdf in.pdf out.pdf`.',
      'Re-stage the OCR-processed copy so the parser can read real text.',
      'Or attach the pages as images to let a vision model read them directly.',
    ],
  },
  OVERSIZE: {
    module: 'Pipeline.Multimodal.Intake',
    status: '0x413',
    cause: 'File exceeds the hard size ceiling for its category and was rejected before any content was read.',
    resolve: (x) => [
      'Trim or split the asset below the ' + (x.limit || 'category') + ' limit.',
      'For video, transcode to a lower bitrate/resolution first.',
      'Stage a representative excerpt instead of the full file.',
    ],
  },
  EXT_MISMATCH: {
    module: 'Pipeline.Multimodal.MimeVerify',
    status: '0x415',
    cause: 'The file extension does not match its magic bytes — the real type differs from what the name claims.',
    resolve: (x) => [
      'Confirm the file is not corrupted or mislabeled.',
      'Its true type is ' + (x.actual || 'unknown') + '; rename or re-export if the extension was wrong.',
      'Re-stage once the type is consistent.',
    ],
  },
  NETWORK: {
    module: 'Provider.Transport',
    status: '0x503',
    cause: 'The request to the model provider failed after automatic retries with exponential backoff.',
    resolve: (x) => [
      'Check your connection and that the endpoint is reachable: `' + (x.baseURL || '<provider URL>') + '`.',
      'Confirm the provider is not rate-limiting or having an outage.',
      'Retry the request; transient socket errors usually clear on their own.',
    ],
  },
  AUTH: {
    module: 'Provider.Auth',
    status: '0x401',
    cause: 'The provider rejected your API key (unauthorized or expired credentials).',
    resolve: () => [
      'Refresh your key now: `/provider` (re-key the active provider).',
      'Verify the key is active and has quota on the provider dashboard.',
      'Ensure the key matches the selected provider / base URL.',
    ],
  },
  CONTEXT_OVERFLOW: {
    module: 'Reasoning.ContextWindow',
    status: '0x507',
    cause: 'The prompt plus staged context exceeds the model context window.',
    resolve: (x) => [
      'Excess is ~' + (x.excess || 'some') + ' tokens over the window.',
      'Drop or unstage large assets: `/unstage`.',
      'Summarize first, or switch to a larger-context model: `/model`.',
    ],
  },
  NO_PROVIDER: {
    module: 'Config.Provider',
    status: '0x428',
    cause: 'No model provider is configured, so the request cannot be sent.',
    resolve: () => ['Run guided setup and connect a provider: `/setup`.'],
  },
  NO_KEY: {
    module: 'Provider.Auth',
    status: '0x428',
    cause: 'The configured provider requires an API key, but none is stored — requests cannot be authenticated.',
    resolve: () => [
      'Re-run guided setup to enter your key (masked input, verified live): `/setup`.',
      'Confirm the key is active and has quota on the provider dashboard.',
      'For local models with no key, choose `Ollama (local)` in /setup.',
    ],
  },
  FILE_NOT_FOUND: {
    module: 'Pipeline.Multimodal.Intake',
    status: '0x404',
    cause: 'The staging path does not resolve to a readable file.',
    resolve: (x) => [
      'Check the path is correct and quoted if it contains spaces.',
      'Confirm the file exists: `ls -l ' + (x.path || '<filepath>') + '`',
      'Re-stage with an absolute path.',
    ],
  },
  GIT_NOT_REPO: {
    module: 'Deploy.VersionControl',
    status: '0x501',
    cause: 'The working directory is not a git repository, so there is nothing to sync.',
    resolve: () => ['Initialize a repo (`git init`) or run /deploy from inside one.'],
  },
  GIT_NO_REMOTE: {
    module: 'Deploy.VersionControl',
    status: '0x502',
    cause: 'No upstream remote is configured for the current branch.',
    resolve: () => [
      'Add a remote: `git remote add origin https://github.com/org/repo.git`.',
      'Then push once to set the upstream branch.',
    ],
  },
  GIT_AUTH: {
    module: 'Deploy.VersionControl',
    status: '0x403',
    cause: 'The push was rejected — the GitHub token is missing, expired, or lacks scope.',
    resolve: () => [
      'Set a classic token in the environment: `export GITHUB_PAT=ghp_xxx`.',
      'The token needs the `repo` scope (and `workflow` to touch Actions).',
      'Regenerate at `https://github.com/settings/tokens` if expired.',
    ],
  },
  GIT_NOTHING: {
    module: 'Deploy.VersionControl',
    status: '0x304',
    cause: 'There are no changes to commit — the working tree is clean.',
    resolve: () => ['Make a change first, then run /deploy again.'],
  },
};

// Map an arbitrary thrown error to a diagnostic CODE + context. Recognizes the
// coded errors this codebase raises, plus common transport/OS failures.
export function classify(err, extra = {}) {
  const code = err?.code;
  const msg = String(err?.message || err || '');
  if (extra.code && REGISTRY[extra.code]) return { code: extra.code, ctx: extra };
  if (REGISTRY[code]) return { code, ctx: { ...extra, message: msg } };
  if (code === 'ENOENT' && /ffmpeg|ffprobe/i.test(msg)) return { code: 'FFMPEG_MISSING', ctx: extra };
  if (code === 'ENOENT') return { code: 'FILE_NOT_FOUND', ctx: extra };
  if (/(invalid api key|unauthorized|authentication|\b401\b)/i.test(msg)) return { code: 'AUTH', ctx: extra };
  if (/\b40[03]\b/.test(msg) && /key|auth|forbidden/i.test(msg)) return { code: 'AUTH', ctx: extra };
  if (/(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|ECONNREFUSED|\b50[234]\b)/i.test(msg + ' ' + code)) {
    return { code: 'NETWORK', ctx: extra };
  }
  if (/(context length|maximum context|too many tokens|context_length_exceeded)/i.test(msg)) {
    return { code: 'CONTEXT_OVERFLOW', ctx: extra };
  }
  return null; // no known mapping — caller decides whether to show a generic note
}

// Build the structured report object for a code (or null if unknown).
export function diagnostic(code, ctx = {}) {
  const entry = REGISTRY[code];
  if (!entry) return null;
  return { code, module: entry.module, status: entry.status, cause: entry.cause, steps: entry.resolve(ctx) };
}

// Convenience: classify an error and return its rendered box (or a generic
// one-liner report when the error is unrecognized).
export function reportFor(err, extra = {}) {
  const cls = classify(err, extra);
  if (cls) return diagnostic(cls.code, cls.ctx);
  return {
    code: 'UNHANDLED', module: extra.module || 'Runtime', status: '0x500',
    cause: String(err?.message || err || 'Unknown error.'),
    steps: ['Retry the operation.', 'If it persists, check the input and configuration for this step.'],
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────
// Highlight `backtick` spans white, the rest dim. Returns a colored string sized
// so its VISIBLE length equals `text` (backticks removed) padded to `width`.
function markup(text, base = c.dim, width = null) {
  const plain = text.replace(/`/g, '');
  let out = '';
  let lit = false;
  let cur = '';
  const flush = () => { if (cur) out += (lit ? c.white(cur) : base(cur)); cur = ''; };
  for (const ch of text) {
    if (ch === '`') { flush(); lit = !lit; continue; }
    cur += ch;
  }
  flush();
  if (width != null) out += ' '.repeat(Math.max(0, width - plain.length));
  return out;
}

// Word-wrap on the visible (backtick-stripped) text, but keep backtick markers
// attached to their words so highlight survives wrapping.
function wrapMarked(text, width) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = '';
  let curVis = 0;
  const vis = (s) => s.replace(/`/g, '').length;
  for (const w of words) {
    const wv = vis(w);
    if (curVis + wv > width && cur.trim()) { lines.push(cur.trimEnd()); cur = w.replace(/^\s+/, ''); curVis = vis(cur); }
    else { cur += w; curVis += wv; }
    while (vis(cur) > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); curVis = vis(cur); }
  }
  if (cur.trim() || !lines.length) lines.push(cur.trimEnd());
  return lines;
}

// Pad a possibly-colored string to `n` VISIBLE columns (ignores ANSI codes).
const padVis = (s, n) => s + ' '.repeat(Math.max(0, n - visLen(s)));

// Render the DIAGNOSTIC FAILURE REPORT box (spec 2.4).
export function renderDiagnostic(report, { indent = 2 } = {}) {
  if (!report) return '';
  const pad = ' '.repeat(indent);
  const width = Math.min(termWidth() - indent * 2, 84);
  const innerW = width - 2;      // columns between the two vertical bars
  const textW = innerW - 2;      // one space of padding on each side
  const line = (colored) => pad + c.red('│') + ' ' + padVis(colored, textW) + ' ' + c.red('│');
  const rows = [];

  const push = (marked, base = c.dim) => {
    for (const piece of wrapMarked(marked, textW)) rows.push(line(markup(piece, base)));
  };
  const blank = () => rows.push(line(''));

  const top = pad + c.red('┌' + '─'.repeat(innerW) + '┐');
  const bot = pad + c.red('└' + '─'.repeat(innerW) + '┘');
  const sep = pad + c.red('├' + '─'.repeat(innerW) + '┤');

  rows.push(line(c.red('\x1B[1mDIAGNOSTIC FAILURE REPORT\x1B[22m')));
  rows.push(sep);
  push('Module: `' + report.module + '`');
  rows.push(line(c.dim('Status: ') + c.orange('FAILED (Code ' + report.status + ')')));
  blank();
  push('Cause: ' + report.cause);
  blank();
  rows.push(line(c.gold('Resolution Steps:')));
  report.steps.forEach((step, i) => {
    const label = ' ' + (i + 1) + '. ';
    const sub = wrapMarked(step, textW - label.length);
    sub.forEach((piece, j) => {
      const prefix = j === 0 ? c.gold(label) : ' '.repeat(label.length);
      rows.push(line(prefix + markup(piece, c.dim)));
    });
  });

  return [top, ...rows, bot].join('\n');
}

// Retry a promise-returning fn with exponential backoff (spec 2.4: network
// dropouts retry up to 3 times before surfacing a diagnostic). `onRetry` is
// called with (attempt, delayMs) so the UI can show a "Connecting" beat.
export async function withRetry(fn, { retries = 3, base = 400, factor = 2, onRetry, retryable } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const cls = classify(err);
      const isRetryable = retryable ? retryable(err) : cls?.code === 'NETWORK';
      if (!isRetryable || attempt >= retries) throw err;
      const delay = base * Math.pow(factor, attempt);
      attempt++;
      onRetry?.(attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
