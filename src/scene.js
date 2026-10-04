// Compositing engine for the 700 AI splash — recreates assets/screenshot.png:
// a per-cell truecolor "wallpaper" (molten embers bottom-left fading to a green
// nebula upper-right), with the glowing 700 AI wordmark and the input card
// stamped on top. Everything is drawn into a 2D cell buffer, then emitted.
import chalk from 'chalk';
import { VERSION } from './theme.js';
import { sampleRGB, wave } from './gradient.js';

// Engraved-serif wordmark. Rasterized from the installed Engravers (engravrl.ttf)
// font and shaded into terminal cells (░▒▓█), so the letterforms match the real
// Engravers logo as closely as a text terminal allows. Regenerate via
// scripts/gen-wordmark.py if you want a different size/font.
const WORDMARK = [
  '█▓█▓▓█▓▓▒    ▒▓▓▓▒      ▒▓▓▓▒              ░▓▓       ▓▒',
  '▒▒▒▒▒▒▓█░  ░█▓▒░▒█▓   ░█▓▒░▒█▓             ▓██░      █▓',
  '      █▒   █▓     █▓  █▓     █▓           ░█░█▓      █▓',
  '     ▓▓   ░█░     ▒█ ░█      ▒█           █▓ ░█░     █▓',
  '    ▒█░   ░█░     ░█ ▒█      ▒█          ▒█░░ ▓█     █▓',
  '    █▒     █▒     ▓█ ░█▒     ▓█          ███████▒    █▓',
  '   ▓▓      ▒█▒   ▒█░  ▒█▒  ░▓█░         ▒█     ▒█    █▓',
  '  ▒█░       ░▓█▓█▓░    ░▓█▓█▓░          █▒      █▓   █▓',
];

// Star accents scattered around the wordmark [row, col, char], relative to the
// wordmark's top-left. Negative/overflowing coords sit just outside the letters.
const STAR_COLORS = ['#fff2c0', '#ffe07a', '#f1c40f'];
const STARS = [
  [-1, 3, '✧'], [-1, 27, '⋆'], [-1, 50, '✦'],
  [0, -2, '✦'], [3, 37, '✦'], [5, 34, '✧'],
  [6, -3, '⋆'], [7, 53, '✦'], [1, 54, '·'],
];

// Color ramps.
const EMBER = ['#1c0603', '#5c0f06', '#a52a1a', '#e0621f', '#f4b024', '#ffe07a'];
const NEBULA = ['#08140a', '#16300f', '#33581c', '#6f8a2e', '#b6b84e', '#e9ea86'];

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

function hex2rgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function rgb2hex(r) { const t = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0'); return '#' + t(r[0]) + t(r[1]) + t(r[2]); }
function mix(c1, c2, t) { const A = hex2rgb(c1), B = hex2rgb(c2); return rgb2hex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]); }
function ramp(stops, t) {
  t = clamp(t);
  const seg = (stops.length - 1) * t;
  const i = Math.floor(seg);
  if (i >= stops.length - 1) return stops[stops.length - 1];
  return mix(stops[i], stops[i + 1], seg - i);
}

// Deterministic per-cell pseudo-random in [0,1).
function hash(x, y) {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 100000) / 100000;
}

class Screen {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', fg: null })));
  }
  set(x, y, ch, fg) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.cells[y][x] = { ch, fg };
  }
  text(x, y, str, fg) { for (let i = 0; i < str.length; i++) this.set(x + i, y, str[i], fg); }
  render() {
    const out = [];
    for (let y = 0; y < this.h; y++) {
      let line = '';
      for (let x = 0; x < this.w; x++) {
        const cell = this.cells[y][x];
        if (cell.ch === ' ') { line += ' '; continue; }
        line += cell.fg ? chalk.hex(cell.fg)(cell.ch) : cell.ch;
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
}

function paintBackground(s) {
  const { w, h } = s;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / (w - 1);
      const ny = y / (h - 1);

      // Embers: brightest in the bottom-left, fading up and to the right.
      const ember = clamp((1 - nx) * 0.85 + ny * 0.5 - 0.5);

      // Nebula: a diagonal green/gold band sweeping to the upper-right.
      const band = 1 - Math.abs((nx - (1 - ny)) - 0.18) * 1.9;
      const nebula = clamp(band) * clamp(nx * 1.25 - 0.15) * (0.5 + (1 - ny) * 0.6);

      const inten = Math.max(ember, nebula);
      const r = hash(x, y);
      const density = 0.05 + inten * 0.72;
      if (r > density) continue;

      const isNeb = nebula > ember;
      const jitter = 0.12 * hash(x + 31, y + 17);
      const color = isNeb ? ramp(NEBULA, nebula + jitter) : ramp(EMBER, ember + jitter);

      let chars;
      if (inten > 0.72) chars = ['▓', '▒', '█'];
      else if (inten > 0.48) chars = ['▒', '░'];
      else if (inten > 0.24) chars = ['░', '∙', '•'];
      else chars = ['·', '˙', '.', '·'];
      const ch = chars[Math.floor(hash(x + 7, y + 3) * chars.length)];
      s.set(x, y, ch, color);

      // Occasional bright spark for the galaxy shimmer.
      if (hash(x + 101, y + 53) > 0.986) s.set(x, y, '✦', '#fff2c0');
      else if (hash(x + 211, y + 97) > 0.99) s.set(x, y, '✧', '#e9ea86');
    }
  }
}

// Wordmark colour: bright gold → red gradient (spec: logo gradient), with a
// soft glow toward the vertical middle. `phase` slides the gradient — 0 is the
// static logo, and the splash animation advances it forever (ping-pong wave,
// so the slide is continuous and never jumps).
const WM_WIDTH = Math.max(...WORDMARK.map((l) => l.length));
function wordmarkColor(row, col, phase = 0) {
  const glow = 1 - Math.abs(row - (WORDMARK.length - 1) / 2) / WORDMARK.length;
  return mix(rgb2hex(sampleRGB(wave(phase + col / WM_WIDTH))), '#fff2c0', glow * 0.22);
}

// One animation frame: re-colour every letter run in place. Spaces are skipped
// with absolute cursor moves, so the plaque and the star accents that sit
// between letters are never overwritten. topRow/leftCol are 1-based screen
// coordinates of the wordmark's top-left cell. Cursor is saved/restored so the
// input box underneath keeps its caret.
export function wordmarkFrame(phase, topRow, leftCol) {
  let out = '\x1B7';
  for (let row = 0; row < WORDMARK.length; row++) {
    const line = WORDMARK[row];
    for (let col = 0; col < line.length;) {
      if (line[col] === ' ') { col++; continue; }
      let end = col;
      while (end < line.length && line[end] !== ' ') end++;
      out += `\x1B[${topRow + row};${leftCol + col}H`;
      for (let k = col; k < end; k++) out += chalk.hex(wordmarkColor(row, k, phase))(line[k]);
      col = end;
    }
  }
  return out + '\x1B8';
}

let _geo = null; // { x0, y0 } of the wordmark inside the last built scene
export const wordmarkGeometry = () => _geo;

function stampWordmark(s, x0, y0) {
  const width = Math.max(...WORDMARK.map((l) => l.length));
  // Clear a clean plaque behind the wordmark so the thin engraved serifs read
  // against black instead of the ember/nebula shimmer bleeding through them.
  const padX = 2, padY = 1;
  for (let y = -padY; y < WORDMARK.length + padY; y++)
    for (let x = -padX; x < width + padX; x++) s.set(x0 + x, y0 + y, ' ', null);
  for (let row = 0; row < WORDMARK.length; row++) {
    const line = WORDMARK[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === ' ') continue;
      s.set(x0 + col, y0 + row, ch, wordmarkColor(row, col));
    }
  }
  // Scatter bright star accents around the wordmark for extra detail.
  for (const [row, col, ch] of STARS) {
    const color = STAR_COLORS[Math.abs(row * 7 + col) % STAR_COLORS.length];
    s.set(x0 + col, y0 + row, ch, color);
  }
  return width;
}

function clearRow(s, x, y, len) { for (let i = 0; i < len; i++) s.set(x + i, y, ' ', null); }
function seg(s, x, y, str, fg) { s.text(x, y, str, fg); return x + [...str].length; }

// A full-screen hero: ember/nebula wallpaper filling the whole terminal, with
// the glowing wordmark centered and a status line below it. No input card — the
// REPL renders the single, real input box (the "Ask anything…" box) underneath.
export function buildScene(cfg) {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const W = Math.max(64, cols);                  // fill the full terminal width
  const marginX = Math.max(3, Math.round(W * 0.05));

  const wmWidth = Math.max(...WORDMARK.map((l) => l.length));
  // Fill (nearly) the whole terminal height; leave room for the hint line and
  // the input box the REPL draws directly below the scene.
  const minH = WORDMARK.length + 6;
  const H = Math.max(minH, rows - 6);

  const s = new Screen(W, H);
  paintBackground(s);

  // Center the wordmark horizontally and sit it a little above the middle.
  const x0 = Math.max(1, Math.floor((W - wmWidth) / 2));
  const y0 = Math.max(2, Math.floor(H * 0.42) - Math.floor(WORDMARK.length / 2));
  stampWordmark(s, x0, y0);
  _geo = { x0, y0 };
  _frameLeft = marginX;

  const white = '#e8e6e3';
  const dim = '#6b6b6b';
  const gold = '#f1c40f';
  const center = (str) => Math.max(0, Math.floor((W - str.length) / 2));

  const tag = 'Your terminal.   Any model.   Your keys.';
  const tagY = y0 + WORDMARK.length + 1;
  clearRow(s, 0, tagY, W);
  seg(s, center(tag), tagY, tag, dim);

  const model = cfg.provider?.model || 'not configured';
  const providerLabel = cfg.provider?.label || '700 AI Terminal';
  const statStr = providerLabel + '   · ' + model + '   · v' + VERSION;
  const statY = tagY + 1;
  clearRow(s, 0, statY, W);
  let sx = center(statStr);
  sx = seg(s, sx, statY, providerLabel + '   ', white);
  sx = seg(s, sx, statY, '· ', dim);
  sx = seg(s, sx, statY, model + '   ', cfg.provider ? gold : dim);
  sx = seg(s, sx, statY, '· v' + VERSION, dim);

  return s.render();
}

let _frameLeft = 4;
export function sceneFrameLeft() { return _frameLeft; }
