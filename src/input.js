// A single-line input rendered *inside* a box that you type directly into.
// Uses raw-mode keypress capture and redraws the box on every keystroke, so the
// text appears within the frame (not on a separate readline prompt below it).
// Falls back to a plain line reader when stdin is not a TTY (piped / tests).
import readline from 'readline';
import { c } from './theme.js';
import { glyph } from './ui.js';

const ESC = '\x1B[';
const up = (n = 1) => ESC + n + 'A';
const down = (n = 1) => ESC + n + 'B';
const right = (n) => (n > 0 ? ESC + n + 'C' : '');
const clearDown = ESC + '0J';

let _fallbackRl = null;

export function boxInput({ input = process.stdin, output = process.stdout, indent = 2, width, placeholder = '' } = {}) {
  const cols = output.columns || 100;
  const w = Math.max(24, width || cols - indent * 2);

  // Non-interactive stdin (piped / no TTY): plain line reader, reused so
  // buffered lines aren't dropped between prompts.
  if (input === process.stdin && !input.isTTY) {
    const promptStr = ' '.repeat(indent) + c.orange(glyph.prompt) + ' ';
    if (!_fallbackRl) _fallbackRl = readline.createInterface({ input, output });
    return new Promise((resolve) => _fallbackRl.question(promptStr, resolve));
  }

  return new Promise((resolve) => {
    const isReal = input === process.stdin;
    let buf = '';
    let pos = 0;
    let drawn = false;

    if (isReal) {
      readline.emitKeypressEvents(input);
      if (input.isTTY) input.setRawMode(true);
    }
    input.resume?.();

    const pad = ' '.repeat(indent);
    const innerW = w - 2;
    const label = glyph.prompt + ' '; // "❯ "
    const avail = Math.max(1, innerW - 1 - label.length);

    function frame() {
      const start = pos > avail ? pos - avail : 0;
      let shownRaw;
      let shownColored;
      if (buf.length === 0 && placeholder) {
        shownRaw = placeholder.slice(0, avail);
        shownColored = c.faint(shownRaw);
      } else {
        shownRaw = buf.slice(start, start + avail);
        shownColored = c.white(shownRaw);
      }
      const used = 1 + label.length + shownRaw.length;
      const trail = ' '.repeat(Math.max(0, innerW - used));
      const top = pad + c.red('╭') + c.dim('─'.repeat(innerW) + '╮');
      const mid = pad + c.red('│') + ' ' + c.orange(label) + shownColored + trail + c.dim('│');
      const bot = pad + c.red('╰') + c.dim('─'.repeat(innerW) + '╯');
      const curCol = indent + 1 + 1 + label.length + (pos - start);
      return { top, mid, bot, curCol };
    }

    function render() {
      const { top, mid, bot, curCol } = frame();
      let s = drawn ? up(1) + '\r' : '';
      drawn = true;
      s += clearDown + top + '\n' + mid + '\n' + bot;
      s += up(1) + '\r' + right(curCol);
      output.write(s);
    }

    function cleanup() {
      input.off('keypress', onKey);
      if (isReal && input.isTTY) input.setRawMode(false);
    }

    function onKey(str, key) {
      key = key || {};
      if (key.ctrl && key.name === 'c') { cleanup(); output.write('\n'); process.exit(0); return; }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        output.write(down(1) + '\r\n');
        resolve(buf);
        return;
      }
      if (key.name === 'backspace') { if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; } render(); return; }
      if (key.name === 'delete') { buf = buf.slice(0, pos) + buf.slice(pos + 1); render(); return; }
      if (key.name === 'left') { if (pos > 0) pos--; render(); return; }
      if (key.name === 'right') { if (pos < buf.length) pos++; render(); return; }
      if (key.name === 'home') { pos = 0; render(); return; }
      if (key.name === 'end') { pos = buf.length; render(); return; }
      if (str && !key.ctrl && !key.meta) {
        const printable = [...str].filter((ch) => ch.codePointAt(0) >= 32).join('');
        if (printable) {
          buf = buf.slice(0, pos) + printable + buf.slice(pos);
          pos += printable.length;
          render();
        }
      }
    }

    output.write('\n');
    input.on('keypress', onKey);
    render();
  });
}
