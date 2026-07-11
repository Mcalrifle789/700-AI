// Shared terminal UI primitives for 700 AI — frames, rules, spinners, layout.
import { c } from './theme.js';

export const glyph = {
  prompt: '❯',
  ok: '✓',
  err: '✗',
  warn: '▲',
  bullet: '●',
  spark: '✦',
  dot: '·',
  bar: '▌',
  arrow: '→',
};

// Actual terminal width (min 40), used for centering.
export const termWidth = () => Math.max(40, process.stdout.columns || 80);

// Visible length of a string, ignoring ANSI color codes.
export function visLen(s) {
  return s.replace(/\x1B\[[0-9;]*m/g, '').length;
}

export function centerLine(s, width = termWidth()) {
  const left = Math.max(0, Math.floor((width - visLen(s)) / 2));
  return ' '.repeat(left) + s;
}

export function rule(width = termWidth(), ch = '─', color = c.faint) {
  return color(ch.repeat(Math.max(0, width)));
}

export function indentBlock(lines, n) {
  const p = ' '.repeat(Math.max(0, n));
  return lines.map((l) => p + l);
}

// A rounded box around centered content lines. Returns { lines, width }.
export function boxed(contentLines, { padX = 3, color = c.box } = {}) {
  const inner = Math.max(...contentLines.map(visLen)) + padX * 2;
  const top = color('╭' + '─'.repeat(inner) + '╮');
  const bottom = color('╰' + '─'.repeat(inner) + '╯');
  const mids = contentLines.map((l) => {
    const total = inner - visLen(l);
    const left = Math.floor(total / 2);
    return color('│') + ' '.repeat(left) + l + ' '.repeat(total - left) + color('│');
  });
  return { lines: [top, ...mids, bottom], width: inner + 2 };
}

// Braille spinner for discrete async waits. Falls back to a single line when
// stdout is not a TTY (piped/non-interactive) so logs stay clean.
export function spinner(text, color = c.orange) {
  if (!process.stdout.isTTY) {
    process.stdout.write(c.dim('  ' + text) + '\n');
    return { stop: (sym, msg) => { if (sym || msg) process.stdout.write('  ' + (sym || '') + (msg ? ' ' + msg : '') + '\n'); } };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const tick = () => process.stdout.write('\r  ' + color(frames[i = (i + 1) % frames.length]) + ' ' + c.dim(text) + '   ');
  tick();
  const id = setInterval(tick, 80);
  return {
    stop(sym, msg) {
      clearInterval(id);
      process.stdout.write('\r\x1B[K  ' + (sym || '') + (msg ? ' ' + msg : '') + '\n');
    },
  };
}
