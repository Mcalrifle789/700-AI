// The file-category matrix from spec 2.1 — processing strategy, the metadata
// each category is expected to yield, and the hard size ceiling. The pipeline
// refuses anything over `maxBytes` before it reads a single content byte.

const MB = 1024 * 1024;

export const CATEGORIES = {
  audio: {
    label: 'Audio',
    strategy: 'Frame extraction & waveform subsampling',
    expects: ['duration', 'channels', 'sampleRate', 'codec'],
    maxBytes: 100 * MB,
  },
  video: {
    label: 'Video',
    strategy: 'Keyframe sampling at 1 fps',
    expects: ['fps', 'resolution', 'trackCount', 'duration'],
    maxBytes: 500 * MB,
  },
  document: {
    label: 'Documents',
    strategy: 'OCR / text layout parser',
    expects: ['pageCount', 'schemaType', 'byteDensity'],
    maxBytes: 50 * MB,
  },
  text: {
    label: 'Code / Text',
    strategy: 'Tokenization & AST parsing',
    expects: ['language', 'tokenCount', 'imports'],
    maxBytes: 20 * MB,
  },
  // Images and opaque blobs are not in the spec table but are accepted as
  // "arbitrary digital media"; they inherit the document ceiling.
  image: {
    label: 'Image',
    strategy: 'Dimension probe & base64 envelope',
    expects: ['resolution'],
    maxBytes: 50 * MB,
  },
  binary: {
    label: 'Binary',
    strategy: 'Checksum & entropy summary',
    expects: ['entropy'],
    maxBytes: 50 * MB,
  },
  archive: {
    label: 'Archive',
    strategy: 'Member listing',
    expects: ['memberCount'],
    maxBytes: 50 * MB,
  },
};

export const categoryFor = (kind) => CATEGORIES[kind] || CATEGORIES.binary;

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
}

export function humanDuration(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const ss = (s < 10 && (h || m) ? '0' : '') + (s % 1 ? s.toFixed(1) : String(Math.round(s)));
  return (h ? h + ':' + String(m).padStart(2, '0') + ':' : m + ':') + ss;
}
