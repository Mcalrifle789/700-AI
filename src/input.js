// A single-line input rendered *inside* a box that you type directly into.
// Uses raw-mode keypress capture and redraws the box on every keystroke, so the
// text appears within the frame (not on a separate readline prompt below it).
// Falls back to a plain line reader when stdin is not a TTY (piped / tests).
import readline from 'readline';
import { c, brand, ember } from './theme.js';
import { glyph } from './ui.js';

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

// Active-widget registry for terminal resize. The REPL re-renders the splash
// scene when the window is resized, then calls requestRefresh() so whichever
// input widget is on screen (input box or command palette) redraws itself
// fresh beneath it. `inputActive()` tells the REPL whether an input widget is
// on screen at all — if not (streaming output, command running), the resize is
// left alone so live output isn't wiped.
let refreshCb = null;
let activeWidgets = 0;
export function requestRefresh() { refreshCb?.(); }
export const inputActive = () => activeWidgets > 0;
function registerRefresh(fn) { refreshCb = fn; activeWidgets++; }
function unregisterRefresh(fn) { if (refreshCb === fn) refreshCb = null; activeWidgets = Math.max(0, activeWidgets - 1); }

// Non-TTY line reader shared across prompts. A persistent 'line' listener
// queues every line as the stream delivers it, so input buffered during an
// async gap (e.g. while a staged file is processed off-thread) is never lost.
let _fallback = null;
function ensureFallback(input, output) {
  if (_fallback) return _fallback;
  const rl = readline.createInterface({ input, output });
  const state = { queue: [], waiters: [], ended: false };
  rl.on('line', (l) => {
    if (state.waiters.length) state.waiters.shift()(l);
    else state.queue.push(l);
  });
  rl.on('close', () => { state.ended = true; while (state.waiters.length) state.waiters.shift()(null); });
  _fallback = state;
  return state;
}

// A scrollable, type-to-filter command palette, driven by raw-mode keypress
// capture (same mechanism as boxInput — not prompts, whose autocomplete can't
// delete its own prompt text). The leading "/" is a real, deletable character:
// typing appends to the filter, backspace removes characters, and backspacing
// an empty filter deletes the "/" itself — closing the palette and handing
// control back to the input box. Esc cancels. Returns the chosen command line
// (e.g. "/play") or '' if cancelled.
async function pickSlash(commands, output, input = process.stdin) {
  const limit = Math.min(12, Math.max(1, commands.length));
  const nameW = Math.max(...commands.map((cmd) => cmd.name.length)) + 2;
  // writeHeader() emits exactly this many lines (blank + rule + title + hint
  // + rule) before the dynamic block starts. finish() relies on this count to
  // erase precisely the palette region.
  const HEADER_LINES = 5;

  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);

  return new Promise((resolve) => {
    let query = '';   // characters typed after the "/"
    let sel = 0;
    let drawn = 0;    // dynamic lines currently on screen (for erase)
    let scroll = 0;   // first visible row index in the result list

    // Header — rebuilt on resize so the rules fit the new width.
    function writeHeader() {
      const cols = Math.min(output.columns || 80, 72);
      const rule = ember('─'.repeat(cols - 4));
      output.write('\n');
      output.write('  ' + rule + '\n');
      output.write('  ' + c.gold(glyph.spark + ' ') + brand('700 AI') + c.dim('   Command Palette') + '\n');
      output.write('  ' + c.faint('type to filter   ' + glyph.dot + '   ↑↓ move   ' + glyph.dot + '   ↵ run   ' + glyph.dot + '   ⌫ edit / go back   ' + glyph.dot + '   esc close') + '\n');
      output.write('  ' + rule + '\n');
    }

    const results = () => {
      const q = query.toLowerCase();
      if (!q) return commands;
      return commands.filter((cmd) => ('/' + cmd.name + ' ' + (cmd.desc || '')).toLowerCase().includes(q));
    };

    function render() {
      const res = results();
      sel = Math.min(sel, Math.max(0, res.length - 1));
      // Sliding window: the selection must always be visible, so the list
      // scrolls under it. (Previously rows beyond `limit` were selectable but
      // never rendered — long command lists simply couldn't be scrolled.)
      if (sel < scroll) scroll = sel;
      if (sel >= scroll + limit) scroll = sel - limit + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, res.length - limit)));
      const lines = [];
      const at = res.length ? (sel + 1) + '/' + res.length : '0';
      // The query line renders the "/" as part of the text, so the user sees
      // it — and can backspace it away (which closes the palette).
      lines.push('  ' + c.gold('❯ /') + c.white(query)
        + (res.length ? c.faint('   ' + at) : c.red('  no match — ⌫ to go back')));
      for (let i = 0; i < limit; i++) {
        const cmd = res[scroll + i];
        if (!cmd) { lines.push(''); continue; }
        const st = groupStyle(cmd.group);
        const name = ('/' + cmd.name).padEnd(nameW);
        const active = i === sel;
        lines.push('  ' + (active ? c.gold('❯') : ' ') + ' ' + st.color(st.dot) + '  '
          + (active ? c.white(name) : st.color(name)) + c.dim(cmd.desc || ''));
      }

      let s = drawn ? ESC + drawn + 'A\r' : '';
      drawn = lines.length;
      // NOTE: ESC already ends with '[' (\x1B[), so erase-line is ESC + '2K',
      // NOT ESC + '[2K' (double bracket is an invalid CSI and garbles redraw).
      s += lines.map((l, i) => ESC + '2K' + l + (i < lines.length - 1 ? '\n' : '')).join('');
      s += ESC + (lines.length - 1) + 'A\r'; // park the cursor on the query line
      output.write(s);
    }

    // Fresh full redraw after a terminal resize re-rendered the splash above.
    const paletteRefresh = () => { drawn = 0; writeHeader(); render(); };
    registerRefresh(paletteRefresh);

    function finish(value) {
      input.off('keypress', onKey);
      unregisterRefresh(paletteRefresh);
      if (input.isTTY) input.setRawMode(false);
      // Erase EXACTLY the palette and its leading blank separator line: the
      // cursor is parked on the block's top line, so step up over the 5 header
      // lines + the blank line and clear down. Never move further up —
      // overshooting lands inside the splash wallpaper and clearDown would eat
      // the background (this used to happen on every open/close cycle,
      // progressively deleting it). The cursor then sits exactly where the
      // next input box belongs, so the layout doesn't drift either.
      output.write(up(HEADER_LINES + 1) + '\r' + clearDown);
      resolve(value);
    }

    function onKey(str, key) {
      key = key || {};
      if (key.ctrl && key.name === 'c') { output.write('\n'); process.exit(0); return; }
      // Escape closes the palette. Terminals report Esc inconsistently: usually
      // key.name 'escape', but sometimes as the bare \x1b byte, Ctrl+[ (same
      // byte), or with a sequence field — accept all of them.
      const isEscape = key.name === 'escape' || str === '\x1b' || (key.ctrl && key.name === '[');
      if (isEscape) return finish('');
      if (key.name === 'return' || key.name === 'enter') {
        const res = results();
        if (!res.length) return; // nothing selected — keep editing
        return finish('/' + res[sel].name);
      }
      if (key.name === 'backspace') {
        if (query.length) query = query.slice(0, -1);
        else return finish(''); // deleting the "/" itself exits back to the box
        sel = 0; render(); return;
      }
      if (key.name === 'up') { if (sel > 0) sel--; render(); return; }
      if (key.name === 'down') { if (sel < results().length - 1) sel++; render(); return; }
      if (key.name === 'pageup') { sel = Math.max(0, sel - limit); render(); return; }
      if (key.name === 'pagedown') { sel = Math.min(Math.max(0, results().length - 1), sel + limit); render(); return; }
      if (key.name === 'home') { sel = 0; render(); return; }
      if (key.name === 'end') { sel = Math.max(0, results().length - 1); render(); return; }
      if (str && !key.ctrl && !key.meta) {
        const printable = [...str].filter((ch) => ch.codePointAt(0) >= 32).join('');
        if (printable) { query += printable; sel = 0; render(); }
      }
    }

    input.on('keypress', onKey);
    writeHeader();
    render();
  });
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

export function boxInput({ input = process.stdin, output = process.stdout, indent = 2, width, placeholder = '', commands = [] } = {}) {
  // Non-interactive stdin (piped / no TTY): plain line reader, reused so
  // buffered lines aren't dropped between prompts.
  if (input === process.stdin && !input.isTTY) {
    const promptStr = ' '.repeat(indent) + c.orange(glyph.prompt) + ' ';
    const state = ensureFallback(input, output);
    output.write(promptStr);
    // Resolve with the next queued line, or null on EOF, so the REPL exits
    // cleanly on stream close instead of throwing ERR_USE_AFTER_CLOSE.
    if (state.queue.length) return Promise.resolve(state.queue.shift());
    if (state.ended) return Promise.resolve(null);
    return new Promise((resolve) => state.waiters.push(resolve));
  }

  return new Promise((resolve) => {
    const isReal = input === process.stdin;
    let buf = '';
    let pos = 0;
    let drawn = false;
    let hist = inputHistory.length; // ↑/↓ browse cursor (=== len → live editing)
    let draft = '';                 // text typed before history recall started
    let pasteMode = false;          // inside a bracketed-paste marker block

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
