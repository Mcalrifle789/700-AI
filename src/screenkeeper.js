// Persistent background for 700 AI: keeps the splash wallpaper behind the
// conversation instead of letting it scroll off-screen.
//
// How it works: a pass-through hook on process.stdout counts every printed
// line and keeps a plain-text transcript (ANSI stripped) of the conversation.
// When enough content has pushed the wallpaper out of the viewport, the
// keeper repaints the splash and re-prints the recent transcript tail before
// the next prompt — so the background is always behind whatever is on screen.
//
// Printing done BY the keeper (or by deliberate repaints) is suspended from
// counting via suspend()/resume(), so the splash never ends up inside its own
// transcript.

import { renderSplash } from './splash.js';
import { c } from './theme.js';

let installed = false;
let suspended = false;
let linesSinceSplash = 0;
let transcript = []; // plain-text lines, oldest first

const MAX_TRANSCRIPT = 400;

function stripAnsi(s) {
  return String(s)
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[>=]/g, '');
}

function countChunk(chunk) {
  if (suspended) return;
  if (typeof chunk !== 'string') return;
  const parts = String(chunk).split('\n');
  for (let i = 0; i < parts.length - 1; i++) {
    linesSinceSplash++;
    const line = stripAnsi(parts[i]).trimEnd();
    if (line.trim()) transcript.push(line);
  }
  if (transcript.length > MAX_TRANSCRIPT) transcript.splice(0, transcript.length - MAX_TRANSCRIPT);
}

// Install the pass-through write hook (once). Never alters the bytes written.
export function startScreenKeeper() {
  if (installed || !process.stdout.isTTY) return;
  installed = true;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = function hook(chunk, ...rest) {
    try { countChunk(chunk); } catch { /* never break output */ }
    return orig(chunk, ...rest);
  };
}

// Pause/resume counting — wrap deliberate full repaints (resize, /clear) so
// the splash isn't recorded as conversation.
export function suspendScreenKeeper() { suspended = true; }
export function resumeScreenKeeper() { suspended = false; }
export function resetScreenKeeper() { linesSinceSplash = 0; }

// True when the wallpaper has been pushed out of the viewport.
function needsRepaint() {
  if (!process.stdout.isTTY) return false;
  const rows = process.stdout.rows || 40;
  const room = Math.max(10, rows - 34); // splash ≈ up to ~30 rows + box
  return linesSinceSplash > room;
}

// Called before each prompt: if the wallpaper scrolled away, repaint the
// splash and the recent transcript tail beneath it.
export function repaintBeforePrompt() {
  if (!needsRepaint()) return;
  suspended = true;
  try {
    console.clear();
    renderSplash();
    const rows = process.stdout.rows || 40;
    const tailCount = Math.max(6, Math.min(60, rows - 36));
    const tail = transcript.slice(-tailCount);
    if (tail.length) {
      process.stdout.write('\n' + c.faint('  ── recent conversation ──') + '\n');
      for (const line of tail) process.stdout.write('  ' + c.faint('│ ') + line + '\n');
    }
    linesSinceSplash = 0;
  } catch { /* never break the loop */ } finally {
    suspended = false;
  }
}