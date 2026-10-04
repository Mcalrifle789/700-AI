// Low-level terminal plumbing shared by every interactive widget (input box,
// command palette, dropdown pickers):
//
//   • resize registry — which widget redraws after the REPL re-renders the splash
//   • non-TTY line reader — piped/scripted stdin, queued so no line is lost
//   • report filter — reassembles mouse / cursor-position reports that Node's
//     readline splits into one keypress per byte
//
// Why the report filter exists: readline does not understand SGR mouse reports
// (ESC[<b;x;yM). It emits "ESC[<" as an unnamed key and then every digit, ';'
// and the final M/m as separate keypresses. Handlers that only matched a whole
// sequence never fired, and the digits fell through as typed text — clicking a
// command "inserted only numbers into the chatbox". Cursor-position replies
// (ESC[r;cR) split the same way and leaked a stray "R".
import readline from 'readline';

// ── resize registry ────────────────────────────────────────────────────────
let refreshCb = null;
let activeWidgets = 0;
export function requestRefresh() { refreshCb?.(); }
export const inputActive = () => activeWidgets > 0;
export function registerRefresh(fn) { refreshCb = fn; activeWidgets++; }
export function unregisterRefresh(fn) { if (refreshCb === fn) refreshCb = null; activeWidgets = Math.max(0, activeWidgets - 1); }

// ── non-TTY line reader ────────────────────────────────────────────────────
// A persistent 'line' listener queues every line as the stream delivers it,
// so input buffered during an async gap is never lost. Resolves null on EOF.
let _fallback = null;
function ensureFallback(input, output) {
  if (_fallback) return _fallback;
  const rl = readline.createInterface({ input, output, terminal: false });
  const state = { queue: [], waiters: [], ended: false };
  rl.on('line', (l) => {
    if (state.waiters.length) state.waiters.shift()(l);
    else state.queue.push(l);
  });
  rl.on('close', () => { state.ended = true; while (state.waiters.length) state.waiters.shift()(null); });
  _fallback = state;
  return state;
}

export function readLine({ input = process.stdin, output = process.stdout, prompt = '' } = {}) {
  const state = ensureFallback(input, output);
  if (prompt) output.write(prompt);
  if (state.queue.length) return Promise.resolve(state.queue.shift());
  if (state.ended) return Promise.resolve(null);
  return new Promise((resolve) => state.waiters.push(resolve));
}

// ── report filter ──────────────────────────────────────────────────────────
// createReportFilter(onReport) → filter(str, key): returns true when the
// keypress belongs to a terminal report and must NOT be treated as input.
// Completed reports are delivered to onReport as
//   { type: 'mouse', button, x, y, press }   (SGR mouse)
//   { type: 'cursor', row, col }             (DSR reply)
export function createReportFilter(onReport = () => {}) {
  let mode = null;   // null | 'mouse' | 'csi'
  let acc = '';

  const finishMouse = (final) => {
    const m = acc.match(/^(\d+);(\d+);(\d+)$/);
    mode = null; acc = '';
    if (m) onReport({ type: 'mouse', button: +m[1], x: +m[2], y: +m[3], press: final === 'M' });
  };

  return function filter(str, key = {}) {
    const seq = key.sequence ?? str ?? '';
    // readline names partial CSI sequences with the *string* 'undefined'.
    const unnamed = !key.name || key.name === 'undefined';

    // Whole sequences (some decoders deliver them intact).
    let m = /^\x1B\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
    if (m) { onReport({ type: 'mouse', button: +m[1], x: +m[2], y: +m[3], press: m[4] === 'M' }); return true; }
    m = /^\x1B\[(\d+);(\d+)R$/.exec(seq);
    if (m) { onReport({ type: 'cursor', row: +m[1], col: +m[2] }); return true; }

    // Split SGR mouse: "ESC[<" then digits/';' then M|m.
    if (seq === '\x1B[<') { mode = 'mouse'; acc = ''; return true; }
    if (mode === 'mouse') {
      if (/^[\d;]$/.test(seq)) { acc += seq; return true; }
      if (seq === 'M' || seq === 'm') { finishMouse(seq); return true; }
      mode = null; acc = '';            // malformed — stop capturing, swallow
      return true;
    }

    // Split DSR: "ESC[12;40" (unnamed) then "R".
    m = /^\x1B\[(\d+);(\d+)$/.exec(seq);
    if (m && unnamed) { mode = 'csi'; acc = m[1] + ';' + m[2]; return true; }
    if (mode === 'csi') {
      const [row, col] = acc.split(';').map(Number);
      mode = null; acc = '';
      if (seq === 'R') { onReport({ type: 'cursor', row, col }); return true; }
      if (/^[A-Za-z~]$/.test(seq)) return true; // other CSI final byte
    }

    // Any other unnamed escape sequence is never text.
    if (!key.name && seq && seq.startsWith('\x1B')) return true;
    return false;
  };
}

export const MOUSE_ON = '\x1B[?1000h\x1B[?1006h';
export const MOUSE_OFF = '\x1B[?1006l\x1B[?1000l';
