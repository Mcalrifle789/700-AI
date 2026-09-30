// Magic-byte MIME resolution. Spec 2.1: validity is confirmed by reading the
// leading bytes of a file, never by trusting its extension — a .png that is
// really a ZIP must be rejected before it reaches the inference payload.
import fs from 'fs/promises';

// How many bytes the sniffer needs: enough for every signature below plus the
// ISO-BMFF `ftyp` box (offset 4), the RIFF/EBML headers, and the `ustar` magic
// that lives at offset 257 in a tar header.
export const SNIFF_BYTES = 4096;

const A = (...bytes) => Uint8Array.from(bytes);
const ascii = (s) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0)));

// Signature table. `offset` defaults to 0. Order matters: specific forms come
// before generic containers (OOXML before plain ZIP), because first match wins.
const SIGNATURES = [
  // ── Images ───────────────────────────────────────────────────
  { mime: 'image/png', ext: 'png', kind: 'image', magic: A(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { mime: 'image/jpeg', ext: 'jpg', kind: 'image', magic: A(0xff, 0xd8, 0xff) },
  { mime: 'image/gif', ext: 'gif', kind: 'image', magic: ascii('GIF8') },
  { mime: 'image/bmp', ext: 'bmp', kind: 'image', magic: ascii('BM') },
  { mime: 'image/webp', ext: 'webp', kind: 'image', magic: ascii('WEBP'), offset: 8 },
  { mime: 'image/tiff', ext: 'tif', kind: 'image', magic: A(0x49, 0x49, 0x2a, 0x00) },
  { mime: 'image/tiff', ext: 'tif', kind: 'image', magic: A(0x4d, 0x4d, 0x00, 0x2a) },
  { mime: 'image/avif', ext: 'avif', kind: 'image', magic: ascii('ftypavif'), offset: 4 },
  { mime: 'image/heic', ext: 'heic', kind: 'image', magic: ascii('ftypheic'), offset: 4 },

  // ── Audio ────────────────────────────────────────────────────
  { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', magic: ascii('ID3') },
  { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', magic: A(0xff, 0xfb) },
  { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', magic: A(0xff, 0xf3) },
  { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', magic: A(0xff, 0xf2) },
  { mime: 'audio/wav', ext: 'wav', kind: 'audio', magic: ascii('WAVE'), offset: 8 },
  { mime: 'audio/flac', ext: 'flac', kind: 'audio', magic: ascii('fLaC') },
  { mime: 'audio/ogg', ext: 'ogg', kind: 'audio', magic: ascii('OggS') },
  { mime: 'audio/aiff', ext: 'aiff', kind: 'audio', magic: ascii('AIFF'), offset: 8 },
  { mime: 'audio/mp4', ext: 'm4a', kind: 'audio', magic: ascii('ftypM4A'), offset: 4 },

  // ── Video ────────────────────────────────────────────────────
  // Matroska and WebM share the EBML header; the DocType sits further in, so
  // `refine` disambiguates after the signature hit.
  { mime: 'video/x-matroska', ext: 'mkv', kind: 'video', magic: A(0x1a, 0x45, 0xdf, 0xa3), refine: refineEbml },
  { mime: 'video/mp4', ext: 'mp4', kind: 'video', magic: ascii('ftyp'), offset: 4 },
  { mime: 'video/quicktime', ext: 'mov', kind: 'video', magic: ascii('moov'), offset: 4 },
  { mime: 'video/x-msvideo', ext: 'avi', kind: 'video', magic: ascii('AVI '), offset: 8 },
  { mime: 'video/mpeg', ext: 'mpg', kind: 'video', magic: A(0x00, 0x00, 0x01, 0xba) },

  // ── Documents ────────────────────────────────────────────────
  { mime: 'application/pdf', ext: 'pdf', kind: 'document', magic: ascii('%PDF-') },
  { mime: 'application/rtf', ext: 'rtf', kind: 'document', magic: ascii('{\\rtf') },
  // Legacy OLE2 compound file (.doc / .xls / .ppt)
  { mime: 'application/x-ole-storage', ext: 'doc', kind: 'document', magic: A(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) },
  // OOXML and ODF are ZIPs; `refine` inspects member names to tell a .docx from
  // a .jar from a plain archive.
  { mime: 'application/zip', ext: 'zip', kind: 'archive', magic: A(0x50, 0x4b), refine: refineZip },

  // ── Archives / binary ────────────────────────────────────────
  { mime: 'application/gzip', ext: 'gz', kind: 'archive', magic: A(0x1f, 0x8b) },
  { mime: 'application/x-bzip2', ext: 'bz2', kind: 'archive', magic: ascii('BZh') },
  { mime: 'application/x-xz', ext: 'xz', kind: 'archive', magic: A(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) },
  { mime: 'application/x-7z-compressed', ext: '7z', kind: 'archive', magic: A(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) },
  { mime: 'application/x-tar', ext: 'tar', kind: 'archive', magic: ascii('ustar'), offset: 257 },
  { mime: 'application/x-executable', ext: 'elf', kind: 'binary', magic: A(0x7f, 0x45, 0x4c, 0x46) },
  { mime: 'application/vnd.microsoft.portable-executable', ext: 'exe', kind: 'binary', magic: ascii('MZ') },
  { mime: 'application/wasm', ext: 'wasm', kind: 'binary', magic: A(0x00, 0x61, 0x73, 0x6d) },
  { mime: 'application/x-sqlite3', ext: 'sqlite', kind: 'binary', magic: ascii('SQLite format 3') },
];

function startsWith(buf, magic, offset = 0) {
  if (buf.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[offset + i] !== magic[i]) return false;
  return true;
}

const findAscii = (buf, s, limit = buf.length) =>
  buf.subarray(0, limit).indexOf(Buffer.from(s, 'latin1'));

// EBML containers: WebM and Matroska are byte-identical up front. The DocType
// string appears within the first few hundred bytes of the header.
function refineEbml(buf) {
  if (findAscii(buf, 'webm', 512) !== -1) return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  return null;
}

// ZIP containers: OOXML / ODF / JAR all begin PK\x03\x04. Their member paths
// identify the real format.
const ZIP_MEMBERS = [
  { needle: 'word/', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', kind: 'document' },
  { needle: 'xl/', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', kind: 'document' },
  { needle: 'ppt/', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', kind: 'document' },
  { needle: 'opendocument.text', mime: 'application/vnd.oasis.opendocument.text', ext: 'odt', kind: 'document' },
  { needle: 'opendocument.spreadsheet', mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: 'ods', kind: 'document' },
  { needle: 'application/epub', mime: 'application/epub+zip', ext: 'epub', kind: 'document' },
  { needle: 'META-INF/MANIFEST.MF', mime: 'application/java-archive', ext: 'jar', kind: 'archive' },
];

function refineZip(buf) {
  for (const m of ZIP_MEMBERS) {
    if (findAscii(buf, m.needle) !== -1) return { mime: m.mime, ext: m.ext, kind: m.kind };
  }
  return null;
}

// Heuristic text detection for files with no signature at all (source code,
// JSON, CSV, Markdown). A NUL byte or a high ratio of non-printable control
// bytes means binary; otherwise treat it as text and report the encoding.
function sniffText(buf) {
  if (buf.length === 0) return { mime: 'text/plain', ext: 'txt', kind: 'text', encoding: 'utf-8', empty: true };
  if (startsWith(buf, A(0xff, 0xfe))) return { mime: 'text/plain', ext: 'txt', kind: 'text', encoding: 'utf-16le' };
  if (startsWith(buf, A(0xfe, 0xff))) return { mime: 'text/plain', ext: 'txt', kind: 'text', encoding: 'utf-16be' };
  let control = 0;
  for (const b of buf) {
    if (b === 0x00) return null;               // NUL ⇒ definitely binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  if (control / buf.length > 0.02) return null;
  const encoding = startsWith(buf, A(0xef, 0xbb, 0xbf)) ? 'utf-8-bom' : 'utf-8';
  return { mime: 'text/plain', ext: 'txt', kind: 'text', encoding };
}

// Resolve a buffer's true type. Returns
//   { mime, ext, kind, confidence, encoding? }
// where `kind` is one of image|audio|video|document|text|archive|binary and
// `confidence` is magic | heuristic | fallback.
export function sniffBuffer(buf) {
  for (const sig of SIGNATURES) {
    if (!startsWith(buf, sig.magic, sig.offset || 0)) continue;
    const hit = sig.refine?.(buf) || sig;
    return { mime: hit.mime, ext: hit.ext, kind: hit.kind, confidence: 'magic' };
  }
  const text = sniffText(buf);
  if (text) return { ...text, confidence: 'heuristic' };
  return { mime: 'application/octet-stream', ext: 'bin', kind: 'binary', confidence: 'fallback' };
}

// Read only the head of a file and sniff it. Never loads the whole file, so a
// 500 MB video costs one 4 KB read.
export async function sniffFile(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return sniffBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

// The type an extension *claims*. Used only to report a mismatch against the
// magic bytes — never as the source of truth.
const EXT_HINT = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aiff: 'audio/aiff',
  pdf: 'application/pdf', rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  zip: 'application/zip', gz: 'application/gzip', wasm: 'application/wasm',
};

export function declaredMime(ext) {
  return EXT_HINT[String(ext || '').replace(/^\./, '').toLowerCase()] || null;
}
