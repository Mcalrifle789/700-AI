// Real-time terminal state animations (spec 2.3). Five agent states, each with
// its own render style and target frame rate, drawn as a single centered,
// low-flicker line (`\r` + clear-to-EOL each frame — never a scroll). Silent
// when stdout is not a TTY so piped output stays clean.
//
//   State           Render style                     FPS   Meaning
//   thinking        Pulsating single-ring spinner    15    Parsing prompt/context
//   thinking-deeper Expanding multi-orbit wave       20    Complex logic / CoT
//   running         Indeterminate progress bar       30    Local scripts / tests
//   connecting      Signal-strength / handshake      10    Remote handshake
//   paused          Static bracket pulse             2     Idle / awaiting input
import chalk from 'chalk';
import { c } from './theme.js';
import { termWidth } from './ui.js';

// hex colour lerp for the pulse effects.
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => {
  const A = hex(a), B = hex(b);
  const to = (n) => Math.round(n).toString(16).padStart(2, '0');
  return '#' + to(A[0] + (B[0] - A[0]) * t) + to(A[1] + (B[1] - A[1]) * t) + to(A[2] + (B[2] - A[2]) * t);
};
// 0..1 triangle/sine pulse from a monotonic frame counter.
const pulse = (i, period) => (Math.sin((i / period) * Math.PI * 2) + 1) / 2;

// ── per-state frame renderers → colored inner string (no centering) ─────────
const RING = ['◜', '◠', '◝', '◞', '◡', '◟'];
function thinking(i, label) {
  const t = pulse(i, 10);
  const col = lerp('#6b6b6b', '#f1c40f', t);
  const ring = RING[i % RING.length];
  const dotL = t > 0.5 ? '(' : ' ';
  const dotR = t > 0.5 ? ')' : ' ';
  return chalkHex(col)(dotL + ' ' + ring + ' ' + dotR) + '  ' + c.dim(label);
}

// Expanding multi-orbit wave: dots radiate outward from a bright core, reset.
const ORBITS = [
  '      ●      ',
  '    · ● ·    ',
  '  · ∘ ● ∘ ·  ',
  '· ∘ ○ ● ○ ∘ ·',
  '  ∘ ○   ○ ∘  ',
  '·           ·',
];
function thinkingDeeper(i, label) {
  const frame = ORBITS[i % ORBITS.length];
  const col = lerp('#e67e22', '#f1c40f', pulse(i, ORBITS.length));
  return chalkHex(col)(frame) + '  ' + c.dim(label);
}

// Indeterminate progress bar: a lit segment sweeps back and forth.
function running(i, label, width = 22) {
  const span = (width - 1) * 2;
  const p = i % span;
  const head = p < width ? p : span - p;                 // ping-pong position
  let bar = '';
  for (let x = 0; x < width; x++) {
    const d = Math.abs(x - head);
    if (d === 0) bar += chalkHex('#f1c40f')('█');
    else if (d <= 1) bar += chalkHex('#e67e22')('▓');
    else if (d <= 2) bar += chalkHex('#8a2b1a')('▒');
    else bar += c.faint('░');
  }
  return c.dim('[') + bar + c.dim(']') + '  ' + c.dim(label);
}

// Signal-strength pulse: rising bars cycle like a handshake negotiating.
const SIG = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function connecting(i, label) {
  const bars = [0, 1, 2, 3].map((k) => {
    const level = (Math.sin((i / 6 + k * 0.6) * Math.PI) + 1) / 2;
    const ch = SIG[Math.floor(level * (SIG.length - 1))];
    const col = lerp('#6b6b6b', '#7ba428', level);
    return chalkHex(col)(ch);
  }).join('');
  const arrow = i % 2 ? '⇄' : '⇆';
  return bars + '  ' + c.green(arrow) + '  ' + c.dim(label);
}

// Static bracket pulse: [ ⏸ ] breathing slowly.
function paused(i, label) {
  const t = pulse(i, 4);
  const col = lerp('#444444', '#e8e6e3', t);
  return chalkHex(col)('[ ⏸ ]') + '  ' + c.dim(label);
}

const STATES = {
  thinking: { fps: 15, render: thinking, label: '700 is thinking' },
  'thinking-deeper': { fps: 20, render: thinkingDeeper, label: '700 is reasoning' },
  running: { fps: 30, render: running, label: 'running' },
  connecting: { fps: 10, render: connecting, label: 'connecting' },
  paused: { fps: 2, render: paused, label: 'paused' },
};

// Cache chalk.hex builders — one per distinct interpolated colour per frame.
const _hexCache = new Map();
function chalkHex(h) {
  let fn = _hexCache.get(h);
  if (!fn) { fn = chalk.hex(h); _hexCache.set(h, fn); }
  return fn;
}

const visLen = (s) => s.replace(/\x1B\[[0-9;]*m/g, '').length;
const center = (s, w) => ' '.repeat(Math.max(0, Math.floor((w - visLen(s)) / 2))) + s;

// Start a state animation. Returns a controller:
//   .to(state, label?)  — switch state live (re-times the interval)
//   .stop(finalLine?)   — clear the line; optionally print a final centered line
// `centered` (default true) centers on the terminal; pass false + prefix for a
// left-aligned indicator.
export function stateAnimation(initial = 'thinking', { label, centered = true, prefix = '' } = {}) {
  if (!process.stdout.isTTY) {
    return { to() {}, stop(final) { if (final) process.stdout.write(final + '\n'); } };
  }
  let spec = STATES[initial] || STATES.thinking;
  let text = label || spec.label;
  let i = 0;
  let id = null;

  const draw = () => {
    const inner = spec.render(i, text);
    const lineStr = centered ? center(inner, termWidth()) : prefix + inner;
    process.stdout.write('\r\x1B[K' + lineStr);
    i++;
  };
  const arm = () => { if (id) clearInterval(id); id = setInterval(draw, Math.round(1000 / spec.fps)); };

  process.stdout.write('\x1B[?25l'); // hide cursor for flicker-free frames
  draw();
  arm();

  return {
    to(state, newLabel) {
      if (STATES[state]) spec = STATES[state];
      if (newLabel != null) text = newLabel;
      else text = spec.label;
      i = 0;
      draw();
      arm();
    },
    stop(final) {
      if (id) clearInterval(id);
      process.stdout.write('\r\x1B[K\x1B[?25h'); // clear line, show cursor
      if (final) process.stdout.write(final + '\n');
    },
  };
}

// Names for the /states demo command.
export const STATE_NAMES = Object.keys(STATES);
