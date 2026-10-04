// The one dropdown engine behind every menu in 700 AI — the "/" command
// palette, setup's provider list, /model, /session, /models, plugin/wallet/
// agent/music menus. Raw-mode, single implementation, so every menu behaves
// the same:
//
//   ↑ ↓  or  W S        move (W/S: always in plain lists; in filterable lists
//                        when the filter is empty, or with Shift held)
//   PgUp PgDn Home End  jump
//   mouse wheel         scroll        ·  click   select, click again to choose
//   type                filter        ·  space   toggle (multi-select)
//   ↵                   choose        ·  esc     cancel (resolves null)
//
// Layout guarantees (the old palette duplicated itself on redraw): every line
// is truncated to the terminal width so nothing wraps, and the list height is
// clamped to the screen so the block never scrolls the terminal. Redraws use
// relative cursor moves over a block whose height is therefore exact.
import readline from 'readline';
import prompts from 'prompts';
import { c, brand, ember } from './theme.js';
import { glyph, visLen } from './ui.js';
import { createReportFilter, registerRefresh, unregisterRefresh, readLine, MOUSE_ON, MOUSE_OFF } from './term.js';

const ESC = '\x1B[';
const up = (n) => (n > 0 ? ESC + n + 'A' : '');
const clearDown = ESC + '0J';

// Truncate a colored string to `max` visible columns (ANSI codes preserved).
export function fit(s, max) {
  if (max <= 0) return '';
  if (visLen(s) <= max) return s;
  let out = '';
  let vis = 0;
  for (let i = 0; i < s.length;) {
    const m = /^\x1B\[[0-9;]*m/.exec(s.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (vis >= max - 1) { out += '…'; break; }
    out += ch; vis++; i += ch.length;
  }
  return out + '\x1B[0m';
}

// pickList(options) → Promise<value | value[] | null>
//   title       header title (plain text)
//   subtitle    dim text after the title
//   items       [{ label, desc?, value, color?, dot?, checked?, disabled? }]
//   multi       multi-select with space; resolves an array of values
//   filter      type-to-filter (default: items.length > 8)
//   prefix      text rendered before the filter query (palette uses '/')
//   backspaceExits  backspacing an empty filter cancels (palette: deletes "/")
//   initial     index or value to preselect
//   limit       max visible rows (clamped to the terminal height)
//   leadingBlank / eraseAbove — palette layout hooks (see pickSlash)
//   resizable   register with the resize registry (palette only)
//   summary     after choosing, leave a one-line "✓ title: choice" behind
export async function pickList(opts) {
  const {
    title = 'Select', subtitle = '', items = [], multi = false,
    prefix = '', backspaceExits = false, initial = 0, leadingBlank = true,
    eraseAbove = 0, resizable = false, summary = true,
    input = process.stdin, output = process.stdout,
  } = opts;
  const filterable = opts.filter ?? items.length > 8;
  if (!items.length) return multi ? [] : null;

  if (!input.isTTY) return pickFallback({ title, items, multi, initial, input, output });

  const cols = () => Math.max(20, (output.columns || 80) - 1);
  const headerLines = (leadingBlank ? 1 : 0) + 4;
  const visibleRows = () => {
    const room = (output.rows || 24) - headerLines - 2; // query line + margin
    return Math.max(3, Math.min(opts.limit || 12, items.length, room));
  };

  const checked = new Set(items.filter((it) => it.checked).map((it) => it.value));
  let query = '';
  let sel = typeof initial === 'number' ? initial : Math.max(0, items.findIndex((it) => it.value === initial));
  let scroll = 0;
  let drawn = 0;
  let queryRow = null; // absolute screen row of the query line (cursor report)

  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(MOUSE_ON);

  const results = () => {
    const q = query.toLowerCase();
    if (!q) return items;
    return items.filter((it) => (prefix + it.label + ' ' + (it.desc || '')).toLowerCase().includes(q));
  };

  function writeHeader() {
    const w = Math.min(cols(), 76);
    const rule = ember('─'.repeat(Math.max(10, w - 2)));
    const keys = (filterable ? 'type to filter   ' + glyph.dot + '   ' : '')
      + '↑↓ / W S move   ' + glyph.dot + '   click select   ' + glyph.dot + '   '
      + (multi ? 'space toggle   ' + glyph.dot + '   ' : '')
      + '↵ ' + (multi ? 'confirm' : 'choose') + '   ' + glyph.dot + '   esc ' + (backspaceExits ? 'close' : 'cancel');
    let s = leadingBlank ? '\n' : '';
    s += fit('  ' + rule, cols()) + '\n';
    s += fit('  ' + c.gold(glyph.spark + ' ') + brand('700 AI') + c.dim('   ' + title) + (subtitle ? c.faint('   ' + subtitle) : ''), cols()) + '\n';
    s += fit('  ' + c.faint(keys), cols()) + '\n';
    s += fit('  ' + rule, cols()) + '\n';
    output.write(s);
  }

  function rowText(it, active) {
    const mark = active ? c.gold('❯') : ' ';
    const box = multi ? (checked.has(it.value) ? c.green('◉ ') : c.faint('○ ')) : '';
    const color = it.color || c.white;
    const dot = it.dot ? color(it.dot) + '  ' : '';
    const label = active ? c.white(it.label) : color(it.label);
    const pad = ' '.repeat(Math.max(1, (opts.labelWidth || 0) - visLen(it.label) + 1));
    return '  ' + mark + ' ' + box + dot + label + (it.desc ? pad + c.dim(it.desc) : '');
  }

  function render() {
    const res = results();
    const limit = visibleRows();
    sel = Math.max(0, Math.min(sel, res.length - 1));
    if (sel < scroll) scroll = sel;
    if (sel >= scroll + limit) scroll = sel - limit + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, res.length - limit)));

    const at = res.length ? (sel + 1) + '/' + res.length : '0';
    const status = filterable
      ? '  ' + c.gold('❯ ' + prefix) + c.white(query) + (res.length ? c.faint('   ' + at) : c.red('  no match' + (backspaceExits ? ' — ⌫ to go back' : '')))
      : '  ' + c.faint(at + (multi ? '   ' + checked.size + ' selected' : ''));
    const lines = [status];
    for (let i = 0; i < limit; i++) {
      const it = res[scroll + i];
      lines.push(it ? rowText(it, scroll + i === sel) : '');
    }

    // The cursor is always parked on the status line (top of the block), so a
    // redraw starts right here: clear the old block, write the new one.
    let s = '\r' + clearDown;
    drawn = lines.length;
    s += lines.map((l, i) => ESC + '2K' + fit(l, cols()) + (i < lines.length - 1 ? '\n' : '')).join('');
    s += up(lines.length - 1) + '\r'; // park on the status/query line
    output.write(s);
  }

  return new Promise((resolve) => {
    const refresh = () => { drawn = 0; queryRow = null; writeHeader(); render(); output.write(ESC + '6n'); };
    if (resizable) registerRefresh(refresh);

    function finish(value) {
      input.off('keypress', onKey);
      if (resizable) unregisterRefresh(refresh);
      output.write(MOUSE_OFF);
      input.setRawMode(false);
      // Cursor is parked on the status line; erase exactly the header + block.
      output.write(up(headerLines + eraseAbove) + '\r' + clearDown);
      if (summary && value != null) {
        const chosen = multi
          ? items.filter((it) => value.includes(it.value)).map((it) => it.label).join(', ') || 'none'
          : (items.find((it) => it.value === value)?.label ?? '');
        output.write(fit('  ' + c.green(glyph.ok) + ' ' + c.dim(title + ': ') + c.white(chosen), cols()) + '\n');
      }
      resolve(value);
    }

    const choose = () => {
      const res = results();
      if (multi) return finish(items.filter((it) => checked.has(it.value)).map((it) => it.value));
      if (res[sel] && !res[sel].disabled) finish(res[sel].value);
    };
    const toggle = (it) => { if (!it || it.disabled) return; if (checked.has(it.value)) checked.delete(it.value); else checked.add(it.value); };
    const move = (d) => { const n = results().length; sel = Math.max(0, Math.min(n - 1, sel + d)); render(); };

    const filter = createReportFilter((r) => {
      if (r.type === 'cursor') { if (queryRow === null) queryRow = r.row; return; }
      if (r.type !== 'mouse') return;
      if (r.button === 64) return move(-1);      // wheel up
      if (r.button === 65) return move(1);       // wheel down
      if (r.button !== 0 || !r.press || queryRow === null) return;
      const rel = r.y - queryRow;
      if (rel < 1 || rel > visibleRows()) return;
      const target = scroll + rel - 1;
      const res = results();
      if (!res[target]) return;
      if (multi) { sel = target; toggle(res[target]); render(); return; }
      if (target === sel) return choose();      // click the selected row = choose
      sel = target; render();
    });

    function onKey(str, key) {
      key = key || {};
      if (filter(str, key)) return;
      if (key.ctrl && key.name === 'c') return finish(null);
      const isEscape = key.name === 'escape' || str === '\x1b' || (key.ctrl && key.name === '[');
      if (isEscape) return finish(null);
      if (key.name === 'return' || key.name === 'enter') return choose();
      if (key.name === 'up') return move(-1);
      if (key.name === 'down') return move(1);
      if (key.name === 'w' || key.name === 's') {
        if (!filterable || key.shift || query === '') return move(key.name === 'w' ? -1 : 1);
      }
      if (key.name === 'pageup') return move(-visibleRows());
      if (key.name === 'pagedown') return move(visibleRows());
      if (key.name === 'home') { sel = 0; return render(); }
      if (key.name === 'end') { sel = results().length - 1; return render(); }
      if (multi && key.name === 'space') { toggle(results()[sel]); return render(); }
      if (key.name === 'backspace') {
        if (query.length) { query = query.slice(0, -1); sel = 0; return render(); }
        if (backspaceExits) return finish(null);
        return;
      }
      if (filterable && str && !key.ctrl && !key.meta) {
        const printable = [...str].filter((ch) => ch.codePointAt(0) >= 32).join('');
        if (printable) { query += printable; sel = 0; render(); }
      }
    }

    input.on('keypress', onKey);
    writeHeader();
    render();
    output.write(ESC + '6n'); // where is the status line? (for click hit-testing)
  });
}

// Non-TTY fallback (piped/scripted): print a numbered list, read one line.
//   blank → initial · "3" or "1,4" → by number · text → first label match.
async function pickFallback({ title, items, multi, initial, input, output }) {
  output.write('\n  ' + title + '\n');
  items.forEach((it, i) => output.write(`   ${i + 1}. ${it.label}${it.desc ? '  — ' + it.desc : ''}\n`));
  const line = await readLine({ input, output, prompt: '  > ' });
  if (line === null) return null;
  const t = line.trim();
  const byIndex = (n) => items[Number(n) - 1];
  if (!t) {
    const it = typeof initial === 'number' ? items[initial] : items.find((x) => x.value === initial);
    return multi ? items.filter((x) => x.checked).map((x) => x.value) : (it || items[0]).value;
  }
  if (multi) {
    return t.split(/[\s,]+/).map((p) => byIndex(p) || items.find((x) => x.label.toLowerCase().includes(p.toLowerCase())))
      .filter(Boolean).map((x) => x.value);
  }
  const it = /^\d+$/.test(t) ? byIndex(t) : items.find((x) => x.label.toLowerCase() === t.toLowerCase()) || items.find((x) => x.label.toLowerCase().includes(t.toLowerCase()));
  return it ? it.value : null;
}

// Convenience: simple single-choice select from [{ title, value }] (prompts-style).
export function select(title, choices, opts = {}) {
  return pickList({ title, items: choices.map((ch) => ({ label: ch.title, desc: ch.desc, value: ch.value })), ...opts });
}

// Text / yes-no questions that cooperate with the shared non-TTY line queue
// (prompts opens its own reader on stdin, which would steal queued lines).
export async function askText(message, { initial = '', input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    const line = await readLine({ input, output, prompt: '  ' + message + (initial ? ` (${initial})` : '') + ' ' });
    if (line === null) return null;
    return line.trim() || initial;
  }
  let cancelled = false;
  const r = await prompts({ type: 'text', name: 'v', message, initial }, { onCancel: () => { cancelled = true; } });
  return cancelled ? null : (r.v ?? '');
}
export async function askConfirm(message, { initial = true, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    const line = await readLine({ input, output, prompt: '  ' + message + (initial ? ' (Y/n) ' : ' (y/N) ') });
    if (line === null) return null;
    const t = line.trim().toLowerCase();
    return t ? t.startsWith('y') : initial;
  }
  let cancelled = false;
  const r = await prompts({ type: 'confirm', name: 'v', message, initial }, { onCancel: () => { cancelled = true; } });
  return cancelled ? null : !!r.v;
}
