// A single-line input rendered *inside* a box that you type directly into.
// Uses raw-mode keypress capture and redraws the box on every keystroke, so the
// text appears within the frame (not on a separate readline prompt below it).
// Falls back to a plain line reader when stdin is not a TTY (piped / tests).
import readline from 'readline';
import { c, brand, ember } from './theme.js';
import { glyph } from './ui.js';
import { pickList } from './picker.js';
import { registerRefresh, unregisterRefresh, readLine, createReportFilter } from './term.js';

// Group → accent color + marker, shared by the command palette.
const GROUP_STYLE = {
  core: { color: c.gold, dot: '●' },
  create: { color: c.orange, dot: '◆' },
  music: { color: c.green, dot: '♪' },
  code: { color: c.red, dot: '▸' },
  write: { color: c.green, dot: '✎' },
  know: { color: c.gold, dot: '✦' },
  plugin: { color: c.orange, dot: '⊕' },
};
const groupStyle = (g) => GROUP_STYLE[g] || { color: c.dim, dot: '·' };

const ESC = '\x1B[';
const up = (n = 1) => ESC + n + 'A';
const down = (n = 1) => ESC + n + 'B';
const right = (n) => (n > 0 ? ESC + n + 'C' : '');
const clearDown = ESC + '0J';

// Resize registry and the non-TTY reader live in term.js (shared with the
// dropdown engine); re-exported here for the REPL.
export { requestRefresh, inputActive } from './term.js';

// The "/" command palette — a thin wrapper over the shared dropdown engine
// (picker.js). The leading "/" is a real, deletable character: backspacing an
// empty filter deletes it and hands control back to the input box. Esc closes.
// Layout: the box erased itself and left the cursor on its top line; the
// palette prints a blank separator + header there, and on close erases exactly
// that region plus the box's own leading blank line (eraseAbove: 1), so the
// next box lands where this one was — no drift, no eaten wallpaper.
async function pickSlash(commands, output, input = process.stdin) {
  const labelWidth = Math.max(...commands.map((cmd) => cmd.name.length)) + 2;
  const items = commands.map((cmd) => {
    const st = groupStyle(cmd.group);
    return { label: '/' + cmd.name, desc: cmd.desc || '', value: '/' + cmd.name, color: st.color, dot: st.dot };
  });
  const picked = await pickList({
    title: 'Command Palette', items, filter: true, prefix: '/', backspaceExits: true,
    leadingBlank: true, eraseAbove: 1, resizable: true, summary: false, labelWidth, input, output,
  });
  return picked || '';
}

// Session-wide input history for ↑/↓ recall (messages and commands alike).
const inputHistory = [];
function rememberInput(line) {
  const l = String(line || '').trim();
  if (!l) return;
  if (inputHistory[inputHistory.length - 1] !== l) {
    inputHistory.push(l);
    if (inputHistory.length > 100) inputHistory.shift();
  }
}

export function boxInput({ input = process.stdin, output = process.stdout, indent = 2, width, placeholder = '', commands = [], onPalette } = {}) {
  // Non-interactive stdin (piped / no TTY): plain line reader, reused so
  // buffered lines aren't dropped between prompts.
  if (input === process.stdin && !input.isTTY) {
    // Resolves with the next queued line, or null on EOF, so the REPL exits
    // cleanly on stream close instead of throwing ERR_USE_AFTER_CLOSE.
    return readLine({ input, output, prompt: ' '.repeat(indent) + c.orange(glyph.prompt) + ' ' });
  }

  return new Promise((resolve) => {
    const isReal = input === process.stdin;
    let buf = '';
    let pos = 0;
    let drawn = false;
    let hist = inputHistory.length; // ↑/↓ browse cursor (=== len → live editing)
    let draft = '';                 // text typed before history recall started
    let pasteMode = false;          // inside a bracketed-paste marker block
    const reports = createReportFilter();

    if (isReal) {
      readline.emitKeypressEvents(input);
      if (input.isTTY) input.setRawMode(true);
      // Bracketed paste: supported terminals wrap pastes in \x1B[200~ …
      // \x1B[201~ markers, letting us fold pasted newlines into spaces instead
      // of submitting the box mid-paste. Ignored harmlessly if unsupported.
      output.write('\x1B[?2004h');
    }
    input.resume?.();

    const pad = ' '.repeat(indent);
    const label = glyph.prompt + ' '; // "❯ "

    // Decorative title (top) and hint (bottom), baked into gradient borders so
    // the box reads as a premium "chat card" rather than a plain rectangle.
    const title = glyph.spark + ' 700 AI ';
    const hint = ' ↵ send  ' + glyph.dot + '  / for commands ';

    function frame() {
      // Width is read live so redraws always fit the current window size.
      const w = Math.max(24, width || (output.columns || 100) - indent * 2);
      const innerW = w - 2;
      const avail = Math.max(1, innerW - 1 - label.length);
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

      // Top: one continuous warm gradient rule with the wordmark baked in.
      //   ╭─ ✦ 700 AI ────────────────────────────╮
      const titleFill = Math.max(0, innerW - title.length - 2);
      const top = pad + ember('╭─ ' + title + '─'.repeat(titleFill) + '╮');

      // Middle: solid warm rails, a bright gold chevron, bright input text.
      const mid = pad + c.orange('│') + ' ' + c.gold(label) + shownColored + trail + c.orange('│');

      // Bottom: calm rule with a faint hint tucked on the right.
      const hintFill = Math.max(0, innerW - hint.length - 1);
      const bot = pad + c.orange('╰') + c.dim('─'.repeat(hintFill)) + c.faint(hint) + c.dim('─') + c.orange('╯');

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

    // Redraw from scratch (no relative cursor math) — used after a terminal
    // resize re-rendered the splash above us.
    const boxRefresh = () => { drawn = false; render(); };
    registerRefresh(boxRefresh);

    function cleanup() {
      input.off('keypress', onKey);
      unregisterRefresh(boxRefresh);
      if (isReal && input.isTTY) { input.setRawMode(false); output.write('\x1B[?2004l'); }
    }

    function onKey(str, key) {
      key = key || {};
      // Bracketed-paste markers. Terminals deliver \x1B[200~ / \x1B[201~ as
      // parsed-CSI key events (key.sequence) or raw text (str) depending on
      // the decoder — accept both shapes.
      const seq = key.sequence || (typeof str === 'string' && str.startsWith('\x1B[') ? str : '');
      if (seq && /200~$/.test(seq)) { pasteMode = true; return; }
      if (seq && /201~$/.test(seq)) { pasteMode = false; return; }
      // Mouse reports, cursor-position replies and stray CSI bytes arrive
      // split into per-byte keypresses; the report filter reassembles and
      // swallows them so click coordinates never land in the chatbox.
      if (reports(str, key)) return;
      if (key.ctrl && key.name === 'c') {
        // Ctrl+C: clear typed text first — exiting on a non-empty line loses
        // work. Only an empty line exits (previous behaviour killed the app
        // even mid-sentence).
        if (buf.length) { buf = ''; pos = 0; render(); return; }
        cleanup(); output.write('\n'); process.exit(0); return;
      }
      // Typing "/" on an empty line opens the scrollable skills picker.
      if (buf === '' && str === '/' && !key.ctrl && !key.meta && commands.length) {
        cleanup();
        output.write(up(1) + '\r' + clearDown); // erase the empty box
        onPalette?.();
        pickSlash(commands, output, input).then(resolve);
        return;
      }
      // Inside a paste, Enter folds into a space (collapsing consecutive ones
      // so \r\n line endings don't double up); typed Enter still submits.
      if (key.name === 'return' || key.name === 'enter') {
        if (pasteMode) { if (buf[pos - 1] !== ' ') { buf = buf.slice(0, pos) + ' ' + buf.slice(pos); pos++; } render(); return; }
        cleanup();
        rememberInput(buf);
        // Erase the whole box on submit so the sent text doesn't stay stacked
        // on screen. The cursor sits on the middle (input) line, so step up to
        // the top border and clear everything below it. The REPL then echoes a
        // clean "you" line and a single fresh box is drawn next loop.
        output.write(up(1) + '\r' + clearDown);
        resolve(buf);
        return;
      }
      if (key.name === 'backspace') { if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; } render(); return; }
      if (key.name === 'delete') { buf = buf.slice(0, pos) + buf.slice(pos + 1); render(); return; }
      if (key.name === 'left') { if (pos > 0) pos--; render(); return; }
      if (key.name === 'right') { if (pos < buf.length) pos++; render(); return; }
      if (key.name === 'home') { pos = 0; render(); return; }
      if (key.name === 'end') { pos = buf.length; render(); return; }
      // ↑/↓ recall session input history (messages and commands alike).
      if (key.name === 'up') {
        if (!inputHistory.length || hist === 0) return;
        if (hist === inputHistory.length) draft = buf;
        hist--;
        buf = inputHistory[hist]; pos = buf.length; render(); return;
      }
      if (key.name === 'down') {
        if (hist >= inputHistory.length) return;
        hist++;
        buf = hist === inputHistory.length ? draft : inputHistory[hist];
        pos = buf.length; render(); return;
      }
      // Esc with text in the box clears it (with the palette closed, Esc is a
      // no-op on an empty box). Bare \x1b / Ctrl+[ forms accepted too.
      const isEsc = key.name === 'escape' || str === '\x1b' || (key.ctrl && key.name === '[');
      if (isEsc && buf.length) { buf = ''; pos = 0; render(); return; }
      if (str && !key.ctrl && !key.meta) {
        // Multi-line pastes: fold newlines/tabs into spaces instead of
        // silently dropping them.
        const printable = [...str]
          .map((ch) => (ch === '\n' || ch === '\r' || ch === '\t' ? ' ' : ch))
          .filter((ch) => ch.codePointAt(0) >= 32).join('');
        if (printable) {
          buf = buf.slice(0, pos) + printable + buf.slice(pos);
          pos += printable.length;
          hist = inputHistory.length; // editing leaves browse mode
          render();
        }
      }
    }

    output.write('\n');
    input.on('keypress', onKey);
    render();
  });
}
