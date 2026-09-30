// Intake orchestrator (spec 2.1). The main-thread entry point that stages an
// arbitrary file: it consults the RAG cache first, and on a miss dispatches the
// heavy work to the intake worker thread so the CLI input loop never blocks.
// Also formats a staged record for prompt injection and for on-screen summary.
import fsp from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import { humanBytes, humanDuration } from './limits.js';
import { getCached, putCached } from './cache.js';

const WORKER_URL = new URL('./intake-worker.js', import.meta.url);

// Stage one file. Resolves to the intake record, or rejects with a coded error
// (code drives the self-healing diagnostic). Off-main-thread via a worker.
export async function stageFile(filePath, { timeout = 180_000 } = {}) {
  const abs = path.resolve(filePath.replace(/^~(?=$|\/|\\)/, process.env.HOME || process.env.USERPROFILE || '~'));

  // Cache probe (spec 2.2): unchanged file ⇒ no re-hash, no re-parse.
  try {
    const st = await fsp.stat(abs);
    if (st.isFile()) {
      const hit = getCached(abs, st.size, st.mtimeMs);
      if (hit) return hit;
    }
  } catch { /* let the worker raise FILE_NOT_FOUND with proper context */ }

  const record = await runInWorker(abs, timeout);
  putCached(record);
  return record;
}

function runInWorker(filePath, timeout) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Object.assign(new Error('intake timed out'), { code: 'INTAKE_TIMEOUT' }));
    }, timeout);
    const done = (fn, arg) => { clearTimeout(timer); worker.terminate(); fn(arg); };
    worker.once('message', (msg) => {
      if (msg.ok) return done(resolve, msg.record);
      const err = new Error(msg.error?.message || 'intake failed');
      err.code = msg.error?.code; err.path = msg.error?.path; err.limit = msg.error?.limit;
      done(reject, err);
    });
    worker.once('error', (err) => done(reject, err));
    worker.postMessage({ filePath });
  });
}

// A compact metadata line for the category, used in the on-screen summary.
export function metaSummary(rec) {
  const m = rec.metadata || {};
  switch (rec.kind) {
    case 'audio': return [m.duration && humanDuration(m.duration), m.channels && m.channels + 'ch', m.sampleRate && (m.sampleRate / 1000) + 'kHz', m.codec].filter(Boolean).join('  ·  ');
    case 'video': return [m.resolution, m.fps && Math.round(m.fps) + 'fps', m.duration && humanDuration(m.duration), m.codec, m.trackCount && m.trackCount + ' tracks'].filter(Boolean).join('  ·  ');
    case 'document': return [m.schemaType, m.pageCount != null && m.pageCount + ' pages', m.lineCount != null && m.lineCount + ' lines', m.byteDensity != null && m.byteDensity + ' B/char'].filter(Boolean).join('  ·  ');
    case 'text': return [m.language, m.lineCount + ' lines', m.tokenCount + ' tok', m.importCount ? m.importCount + ' imports' : null].filter(Boolean).join('  ·  ');
    case 'image': return [m.resolution, 'base64 envelope'].filter(Boolean).join('  ·  ');
    case 'archive': return [m.memberCount != null && m.memberCount + ' members'].filter(Boolean).join('  ·  ');
    default: return [m.entropy != null && 'entropy ' + m.entropy, m.note].filter(Boolean).join('  ·  ');
  }
}

// The standard encoded multimodal schema payload injected into the inference
// prompt (spec 2.1 — "Converts validated assets into standard encoded
// multimodal schema payloads before transmitting to the inference engine").
export function toPromptBlock(rec) {
  const m = rec.metadata || {};
  const lines = [];
  lines.push(`<asset name="${rec.name}" kind="${rec.kind}" mime="${rec.mime}" size="${humanBytes(rec.size)}" sha256="${rec.sha256.slice(0, 16)}…">`);
  lines.push('  metadata: ' + JSON.stringify(compactMeta(rec.kind, m)));
  if (rec.preview?.text) {
    lines.push('  preview' + (rec.preview.truncated ? ' (truncated)' : '') + ':');
    lines.push(rec.preview.text.split('\n').map((l) => '  | ' + l).join('\n'));
  }
  lines.push('</asset>');
  return lines.join('\n');
}

// Drop bulky/nested fields (waveform arrays, member lists) from the inline JSON.
function compactMeta(kind, m) {
  const { waveform, members, imports, ...rest } = m;
  if (kind === 'text' && imports?.length) rest.imports = imports.slice(0, 12);
  if (kind === 'archive' && members?.length) rest.sampleMembers = members.slice(0, 8);
  return rest;
}

// Build the combined system context from every staged asset, or null if none.
export function stagedContext(staged) {
  if (!staged.length) return null;
  const blocks = staged.map(toPromptBlock).join('\n\n');
  return `The user has staged ${staged.length} file(s) into the session. Treat these as authoritative context and reference them by name when relevant.\n\n${blocks}`;
}
