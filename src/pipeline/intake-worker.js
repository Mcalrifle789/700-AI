// Async intake worker (spec 2.1 / 2.2 — "the client spawns a background thread
// or asynchronous task queue to process the file off the main thread").
//
// Runs in a worker_thread so heavy CPU (SHA-256 of a 500 MB video, PDF text
// extraction, entropy scans) never blocks the REPL input loop — keypresses keep
// flowing while a file is validated and harvested. Posts exactly one message
// back: { ok, record } on success or { ok:false, error:{ code, message } }.
import { parentPort } from 'worker_threads';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { sniffFile, declaredMime } from './mime.js';
import { categoryFor, humanBytes } from './limits.js';
import { extractDocument } from './docs.js';
import { openZip } from './zip.js';
import {
  ffmpegAvailable, probeAudio, probeVideo, waveformPeaks, sampleKeyframes,
  parseWavHeader, parseMp3Header, parseImageSize,
} from './ffmpeg.js';

const PREVIEW_CHARS = 1200;
const estTokens = (chars) => Math.max(0, Math.ceil(chars / 4)); // ~4 chars/token

// SHA-256 by streaming — never loads the whole file into memory.
function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (d) => hash.update(d));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

async function head(filePath, bytes) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// ── metadata harvesters, one per category ──────────────────────────────────
async function harvestAudio(filePath) {
  const warnings = [];
  const have = await ffmpegAvailable();
  if (have.ffprobe) {
    try {
      const meta = await probeAudio(filePath);
      if (have.ffmpeg) { try { meta.waveform = await waveformPeaks(filePath, 48); } catch { /* non-fatal */ } }
      return { meta, warnings };
    } catch (e) { warnings.push('ffprobe failed: ' + e.message); }
  } else warnings.push('FFMPEG_MISSING');
  // Native header fallback (WAV/MP3) so numbers still appear without ffmpeg.
  const buf = await head(filePath, 64 * 1024);
  const native = parseWavHeader(buf) || parseMp3Header(buf);
  return { meta: native || { source: 'none', note: 'install ffmpeg for full audio metadata' }, warnings };
}

async function harvestVideo(filePath) {
  const warnings = [];
  const have = await ffmpegAvailable();
  if (!have.ffprobe) { warnings.push('FFMPEG_MISSING'); return { meta: { source: 'none', note: 'install ffmpeg for video metadata' }, warnings }; }
  const meta = await probeVideo(filePath);
  if (have.ffmpeg) {
    try { const { frames } = await sampleKeyframes(filePath, { fps: 1, limit: 6 }); meta.keyframesSampled = frames.length; }
    catch (e) { warnings.push('keyframe sampling failed: ' + e.message); }
  }
  return { meta, warnings };
}

async function harvestDocument(filePath, mime, size) {
  const warnings = [];
  const doc = await extractDocument(filePath, { mime, size });
  if (doc.needsOcr) warnings.push('OCR_REQUIRED');
  const meta = {
    schemaType: doc.schemaType, pageCount: doc.pageCount, lineCount: doc.lineCount,
    charCount: doc.charCount, byteDensity: doc.byteDensity,
    wordCount: doc.wordCount, sheetCount: doc.sheetCount, slideCount: doc.slideCount,
    encrypted: doc.encrypted || undefined,
  };
  const previewText = (doc.text || '').slice(0, PREVIEW_CHARS);
  return { meta, warnings, previewText, fullChars: doc.charCount };
}

// Language + import summary for code/text (spec matrix: "Language, token count,
// imports summary").
const LANG_BY_EXT = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript',
  py: 'Python', rb: 'Ruby', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', swift: 'Swift', sh: 'Shell', bash: 'Shell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  md: 'Markdown', sql: 'SQL', lua: 'Lua', r: 'R', dart: 'Dart', ex: 'Elixir', exs: 'Elixir',
};
const IMPORT_RE = [
  /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm,   // JS/TS
  /^\s*import\s+['"]([^'"]+)['"]/gm,             // JS side-effect
  /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/gm, // Python
  /^\s*(?:use|extern crate)\s+([\w:]+)/gm,       // Rust
  /^\s*#include\s*[<"]([^>"]+)[>"]/gm,           // C/C++
  /^\s*(?:require|require_relative)\s*\(?['"]([^'"]+)['"]/gm, // Ruby/Node require
  /^\s*import\s+([\w.]+)/gm,                     // Java/Go single
];
async function harvestText(filePath, ext, size) {
  const text = await fsp.readFile(filePath, 'utf8');
  const lines = text.split('\n');
  const imports = new Set();
  for (const re of IMPORT_RE) {
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) && imports.size < 40) {
      const hit = m[1] || m[2]; if (hit) imports.add(hit);
    }
  }
  const meta = {
    language: LANG_BY_EXT[ext] || 'Plain text',
    lineCount: lines.length,
    charCount: text.length,
    tokenCount: estTokens(text.length),
    imports: [...imports].slice(0, 24),
    importCount: imports.size,
    blankLines: lines.filter((l) => !l.trim()).length,
  };
  return { meta, warnings: [], previewText: text.slice(0, PREVIEW_CHARS), fullChars: text.length };
}

async function harvestImage(filePath) {
  const buf = await head(filePath, 64 * 1024);
  const dim = parseImageSize(buf);
  return { meta: { resolution: dim ? `${dim.width}x${dim.height}` : null, width: dim?.width, height: dim?.height, envelope: 'base64' }, warnings: [] };
}

// Shannon entropy over a sample — a compressed/encrypted blob approaches 8.0.
async function harvestBinary(filePath, size) {
  const buf = await head(filePath, Math.min(size, 256 * 1024));
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let entropy = 0;
  for (const n of counts) { if (!n) continue; const p = n / buf.length; entropy -= p * Math.log2(p); }
  return { meta: { entropy: Math.round(entropy * 100) / 100, sampledBytes: buf.length, note: entropy > 7.5 ? 'high entropy (compressed/encrypted)' : 'structured binary' }, warnings: [] };
}

async function harvestArchive(filePath, mime) {
  try {
    const zip = await openZip(filePath);
    return { meta: { memberCount: zip.entries.length, members: zip.entries.slice(0, 20).map((e) => e.name) }, warnings: [] };
  } catch (e) {
    return { meta: { memberCount: null, note: 'non-zip archive; listing needs the matching extractor' }, warnings: [] };
  }
}

async function runIntake(filePath) {
  const abs = path.resolve(filePath);
  let stat;
  try { stat = await fsp.stat(abs); }
  catch { throw Object.assign(new Error('no such file: ' + abs), { code: 'FILE_NOT_FOUND', path: abs }); }
  if (!stat.isFile()) throw Object.assign(new Error('not a file: ' + abs), { code: 'FILE_NOT_FOUND', path: abs });

  const sniff = await sniffFile(abs);
  const cat = categoryFor(sniff.kind);

  // Enforce the hard size ceiling BEFORE reading any content (spec 2.1).
  if (stat.size > cat.maxBytes) {
    throw Object.assign(new Error('file exceeds ' + cat.label + ' ceiling'), {
      code: 'OVERSIZE', limit: humanBytes(cat.maxBytes), path: abs,
    });
  }

  const ext = path.extname(abs).replace(/^\./, '').toLowerCase();
  const declared = declaredMime(ext);
  const extMismatch = declared && declared !== sniff.mime ? { declared, actual: sniff.mime } : null;

  // Harvest metadata + hash in parallel — both are off the main thread here.
  const harvest = (async () => {
    switch (sniff.kind) {
      case 'audio': return harvestAudio(abs);
      case 'video': return harvestVideo(abs);
      case 'document': return harvestDocument(abs, sniff.mime, stat.size);
      case 'text': return harvestText(abs, ext, stat.size);
      case 'image': return harvestImage(abs);
      case 'archive': return harvestArchive(abs, sniff.mime);
      default: return harvestBinary(abs, stat.size);
    }
  })();
  const [{ meta, warnings, previewText, fullChars }, sha] = await Promise.all([harvest, sha256(abs)]);
  if (extMismatch) warnings.push('EXT_MISMATCH');

  const preview = previewText != null
    ? { text: previewText, tokensEstimate: estTokens(previewText.length), truncated: (fullChars || 0) > previewText.length }
    : null;

  return {
    path: abs,
    name: path.basename(abs),
    ext,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: sniff.mime,
    kind: sniff.kind,
    confidence: sniff.confidence,
    encoding: sniff.encoding || null,
    sha256: sha,
    extMismatch,
    category: { label: cat.label, strategy: cat.strategy, maxBytes: cat.maxBytes },
    metadata: meta,
    preview,
    warnings: [...new Set(warnings)],
    stagedAt: new Date().toISOString(),
  };
}

parentPort.on('message', async ({ filePath }) => {
  try {
    const record = await runIntake(filePath);
    parentPort.postMessage({ ok: true, record });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: { code: err.code || null, message: String(err.message || err), path: err.path, limit: err.limit } });
  }
});
