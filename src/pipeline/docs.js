// Document leg of the ingestion pipeline (spec 2.1 — "OCR / text layout
// parser"; metadata: page count, schema type, byte density). Extracts a text
// layout plus structural counts from PDF, OOXML, ODF, RTF and plain text.
//
// OCR of scanned/image-only PDFs needs an external engine; when a PDF yields no
// extractable text the result is flagged { needsOcr: true } and the diagnostic
// engine surfaces the OCR_REQUIRED remediation rather than silently returning
// an empty document.
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';
import { openZip } from './zip.js';

const inflate = promisify(zlib.inflate);

const collapse = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// ── PDF ────────────────────────────────────────────────────────────────────
// Page count comes from the page-tree /Count (or a /Type /Page tally as a
// fallback). Text comes from the content streams: FlateDecode them, then pull
// the string operands of Tj/TJ/'/" show-text operators.

function pdfPageCount(buf) {
  const latin = buf.toString('latin1');
  const counts = [...latin.matchAll(/\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) return Math.max(...counts);
  const pages = latin.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : null;
}

// Decode PDF string escapes (\n, \(, \251, …) inside a literal ( ... ) string.
function pdfLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, esc) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (simple[esc] !== undefined) return simple[esc];
    return String.fromCharCode(parseInt(esc, 8));
  });
}

function pdfShowText(streamText) {
  let out = '';
  // TJ arrays: [ (frag) -120 (frag) ] TJ  — and single Tj / ' / " strings.
  const re = /\[((?:[^[\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|\bT\*|\bET\b/g;
  let m;
  while ((m = re.exec(streamText)) !== null) {
    if (m[1] !== undefined) {
      for (const f of m[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) out += pdfLiteral(f[1]);
      out += ' ';
    } else if (m[2] !== undefined) {
      out += pdfLiteral(m[2]) + ' ';
    } else {
      out += '\n';   // T* / ET ⇒ line or text-object break
    }
  }
  return out;
}

async function pdfText(buf) {
  const latin = buf.toString('latin1');
  let text = '';
  // Walk every stream ... endstream span; inflate the ones that are FlateDecode.
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    re.lastIndex = end;
    const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
    const dict = latin.slice(dictStart, m.index);
    const raw = buf.subarray(start, end);
    let body;
    if (/FlateDecode/.test(dict)) {
      try { body = (await inflate(raw)).toString('latin1'); } catch { continue; }
    } else if (/\/Filter/.test(dict)) {
      continue;                         // DCT/CCITT/etc — image data, needs OCR
    } else {
      body = raw.toString('latin1');
    }
    if (/\b(Tj|TJ)\b/.test(body)) text += pdfShowText(body) + '\n';
  }
  return collapse(text);
}

async function readPdf(filePath, buf) {
  const pageCount = pdfPageCount(buf);
  const text = await pdfText(buf);
  const version = (buf.toString('latin1', 0, 16).match(/%PDF-(\d\.\d)/) || [])[1] || null;
  const encrypted = /\/Encrypt\b/.test(buf.toString('latin1', 0, Math.min(buf.length, 2_000_000)));
  return {
    schemaType: 'PDF' + (version ? ' ' + version : ''),
    pageCount,
    text,
    encrypted,
    // No extractable text across a multi-page PDF ⇒ it is a scan.
    needsOcr: !encrypted && text.length < 16 && (pageCount || 1) > 0,
  };
}

// ── OOXML (.docx / .xlsx / .pptx) ──────────────────────────────────────────

const stripTags = (xml) => xml
  .replace(/<w:tab\b[^>]*\/>/g, '\t')
  .replace(/<(?:w:br|w:cr)\b[^>]*\/>/g, '\n')
  .replace(/<\/w:p>/g, '\n')
  .replace(/<a:br\b[^>]*\/>/g, '\n')
  .replace(/<\/a:p>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

async function readDocx(zip) {
  const xml = await zip.readText('word/document.xml');
  const text = collapse(stripTags(xml));
  // Word does not store a page count in the part tree; app.xml carries the
  // count the last renderer wrote, which is the best available number.
  let pageCount = null;
  let words = null;
  try {
    const app = await zip.readText('docProps/app.xml');
    pageCount = Number((app.match(/<Pages>(\d+)<\/Pages>/) || [])[1]) || null;
    words = Number((app.match(/<Words>(\d+)<\/Words>/) || [])[1]) || null;
  } catch { /* docProps is optional */ }
  return {
    schemaType: 'OOXML WordprocessingML',
    pageCount,
    wordCount: words,
    paragraphs: (xml.match(/<w:p[ >]/g) || []).length,
    tables: (xml.match(/<w:tbl>/g) || []).length,
    images: zip.entries.filter((e) => e.name.startsWith('word/media/')).length,
    text,
  };
}

async function readXlsx(zip) {
  const sheets = zip.entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  let shared = [];
  try {
    const ss = await zip.readText('xl/sharedStrings.xml');
    shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripTags(m[1]));
  } catch { /* inline strings only */ }
  const parts = [];
  let cells = 0;
  for (const s of sheets.slice(0, 16)) {
    const xml = (await zip.read(s.name)).toString('utf8');
    cells += (xml.match(/<c[ >]/g) || []).length;
    // Resolve shared-string cells (t="s") against the table; take values as-is
    // otherwise. Good enough for a prompt-side text layout.
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 200);
    for (const r of rows) {
      const vals = [...r[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(([, attrs, body]) => {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (/t="s"/.test(attrs) && v !== undefined) return shared[Number(v)] ?? '';
        if (/t="inlineStr"/.test(attrs)) return stripTags(body);
        return v ?? '';
      });
      if (vals.some(Boolean)) parts.push(vals.join('\t'));
    }
  }
  return {
    schemaType: 'OOXML SpreadsheetML',
    pageCount: sheets.length,        // sheets are the natural "page" unit
    sheetCount: sheets.length,
    cellCount: cells,
    sharedStrings: shared.length,
    text: collapse(parts.join('\n')),
  };
}

async function readPptx(zip) {
  const slides = zip.entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parts = [];
  for (const s of slides) parts.push(stripTags((await zip.read(s.name)).toString('utf8')));
  return {
    schemaType: 'OOXML PresentationML',
    pageCount: slides.length,
    slideCount: slides.length,
    notes: zip.entries.filter((e) => /^ppt\/notesSlides\//.test(e.name)).length,
    images: zip.entries.filter((e) => e.name.startsWith('ppt/media/')).length,
    text: collapse(parts.join('\n\n')),
  };
}

async function readOdf(zip, kind) {
  const xml = await zip.readText('content.xml');
  return {
    schemaType: 'OpenDocument ' + kind,
    pageCount: (xml.match(/<text:p\b/g) || []).length ? null : null,
    paragraphs: (xml.match(/<text:p\b/g) || []).length,
    text: collapse(xml.replace(/<text:p\b[^>]*>/g, '\n').replace(/<[^>]+>/g, '')),
  };
}

// ── RTF + plain text ───────────────────────────────────────────────────────

function readRtf(buf) {
  const s = buf.toString('latin1');
  const text = s
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
  return {
    schemaType: 'RTF',
    pageCount: (s.match(/\\page\b/g) || []).length + 1,
    text: collapse(text),
  };
}

// Main entry: returns { schemaType, pageCount, byteDensity, text, ... }.
// `byteDensity` (spec 2.1) is bytes of file per character of extracted text —
// a compression/scan indicator: ~1-3 for plain text, 20+ for image-heavy PDFs.
export async function extractDocument(filePath, { mime, size }) {
  let result;
  if (mime === 'application/pdf') {
    result = await readPdf(filePath, await fs.readFile(filePath));
  } else if (mime === 'application/rtf') {
    result = readRtf(await fs.readFile(filePath));
  } else if (mime.includes('wordprocessingml')) {
    result = await readDocx(await openZip(filePath));
  } else if (mime.includes('spreadsheetml')) {
    result = await readXlsx(await openZip(filePath));
  } else if (mime.includes('presentationml')) {
    result = await readPptx(await openZip(filePath));
  } else if (mime.includes('opendocument.text')) {
    result = await readOdf(await openZip(filePath), 'Text');
  } else if (mime.includes('opendocument.spreadsheet')) {
    result = await readOdf(await openZip(filePath), 'Spreadsheet');
  } else if (mime === 'application/x-ole-storage') {
    // Legacy binary Office. Recoverable text requires an OLE2 stream walker;
    // report the format honestly instead of emitting garbage.
    result = { schemaType: 'OLE2 (legacy Office)', pageCount: null, text: '', unsupported: true };
  } else {
    const text = await fs.readFile(filePath, 'utf8');
    result = { schemaType: 'Plain text', pageCount: null, text: collapse(text) };
  }
  const chars = result.text ? result.text.length : 0;
  return {
    ...result,
    charCount: chars,
    lineCount: result.text ? result.text.split('\n').length : 0,
    byteDensity: chars ? Math.round((size / chars) * 100) / 100 : null,
  };
}
