// Compositing engine for the 700 AI splash — recreates assets/screenshot.png:
// a per-cell truecolor "wallpaper" (molten embers bottom-left fading to a green
// nebula upper-right), with the glowing 700 AI wordmark and the input card
// stamped on top. Everything is drawn into a 2D cell buffer, then emitted.
import chalk from 'chalk';
import { VERSION } from './theme.js';

const WORDMARK = [
  ' ███████╗  ██████╗   ██████╗      █████╗  ██╗',
  ' ╚════██║ ██╔═══██╗ ██╔═══██╗    ██╔══██╗ ██║',
  '     ██╔╝ ██║   ██║ ██║   ██║    ███████║ ██║',
  '    ██╔╝  ██║   ██║ ██║   ██║    ██╔══██║ ██║',
  '    ██║   ╚██████╔╝ ╚██████╔╝    ██║  ██║ ██║',
  '    ╚═╝    ╚═════╝   ╚═════╝     ╚═╝  ╚═╝ ╚═╝',
];

// Color ramps.
const EMBER = ['#1c0603', '#5c0f06', '#a52a1a', '#e0621f', '#f4b024', '#ffe07a'];
const NEBULA = ['#08140a', '#16300f', '#33581c', '#6f8a2e', '#b6b84e', '#e9ea86'];
const BRAND = ['#e74c3c', '#e67e22', '#f1c40f', '#8bbf3a']; // 700 (red→gold) → AI (gold→green)

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
      if (hash(x + 101, y + 53) > 0.992) s.set(x, y, '✦', '#fff2c0');
    }
  }
}

function stampWordmark(s, x0, y0) {
  const width = Math.max(...WORDMARK.map((l) => l.length));
  for (let row = 0; row < WORDMARK.length; row++) {
    const line = WORDMARK[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === ' ') continue;
      // Brighten slightly toward the vertical middle for a glow.
      const glow = 1 - Math.abs(row - (WORDMARK.length - 1) / 2) / WORDMARK.length;
      const base = ramp(BRAND, col / width);
      const fg = mix(base, '#fff2c0', glow * 0.22);
      s.set(x0 + col, y0 + row, ch, fg);
    }
  }
  return width;
}

function clearRow(s, x, y, len) { for (let i = 0; i < len; i++) s.set(x + i, y, ' ', null); }
function seg(s, x, y, str, fg) { s.text(x, y, str, fg); return x + [...str].length; }

// A compact hero band: ember/nebula wallpaper behind the glowing wordmark plus
// a status line. No input card — the REPL renders the single, real input box
// (the "Ask anything…" box) directly below this.
export function buildScene(cfg) {
  const cols = process.stdout.columns || 100;
  const W = Math.max(64, Math.min(cols, 160));
  const marginX = Math.max(3, Math.round(W * 0.05));
  const H = WORDMARK.length + 6; // top pad + wordmark + tagline + status + pad

  const s = new Screen(W, H);
  paintBackground(s);
  stampWordmark(s, marginX + 1, 2);
  _frameLeft = marginX;

  const white = '#e8e6e3';
  const dim = '#6b6b6b';
  const gold = '#f1c40f';

  const tagY = 2 + WORDMARK.length + 1;
  clearRow(s, marginX + 1, tagY, W - marginX * 2 - 2);
  seg(s, marginX + 1, tagY, 'Your terminal.   Any model.   Your keys.', dim);

  const statY = tagY + 1;
  clearRow(s, marginX + 1, statY, W - marginX * 2 - 2);
  const model = cfg.provider?.model || 'not configured';
  const providerLabel = cfg.provider?.label || '700 AI Terminal';
  let sx = marginX + 1;
  sx = seg(s, sx, statY, providerLabel + '   ', white);
  sx = seg(s, sx, statY, '· ', dim);
  sx = seg(s, sx, statY, model + '   ', cfg.provider ? gold : dim);
  sx = seg(s, sx, statY, '· v' + VERSION, dim);

  return s.render();
}

let _frameLeft = 4;
export function sceneFrameLeft() { return _frameLeft; }
