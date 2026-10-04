// 700 AI brand gradient: bright gold → deep red, ANSI truecolor.
// Pure module — no dependencies — so any render path (splash wordmark, box
// title, palette header) can use it without pulling the theme stack.
//
//   gradient(text)          → static gold→red gradient
//   gradientAnimated(text, phase) → same gradient with a sliding phase;
//                                   phase advances forever (ping-pong, so the
//                                   slide is endless and never jumps).
//   animateGradient(text, el)     → drives `el(renderedText)` on a timer and
//                                   returns a stop() function.

const STOPS = [
  [255, 196, 15],  // bright gold
  [255, 138, 20],  // amber
  [234, 60, 35],   // brand red
];

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Sample the gradient at position p ∈ [0,1].
function sample(p) {
  const t = Math.max(0, Math.min(1, p)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(t));
  const f = t - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

const rgb = ([r, g, b]) => `\x1B[38;2;${r};${g};${b}m`;

// Ping-pong wave: smooth back-and-forth in [0,1], continuous forever.
function tri(x) {
  const m = ((x % 2) + 2) % 2;
  return m < 1 ? m : 2 - m;
}

function render(text, posFor) {
  const chars = [...String(text)];
  const n = Math.max(1, chars.length - 1);
  let s = '';
  chars.forEach((ch, i) => {
    if (ch === ' ') { s += ch; return; }
    s += rgb(sample(posFor(i, n))) + ch;
  });
  return s + '\x1B[39m';
}

// Static gradient across the text.
export function gradient(text) {
  return render(text, (i, n) => i / n);
}

// Animated gradient: `phase` (in seconds) slides the palette across the text
// endlessly — gold slides toward red and back, never jumping.
export function gradientAnimated(text, phase) {
  return render(text, (i, n) => tri(phase * 0.6 + i / n));
}

// Driver for callers that redraw (e.g. splash wordmark / box title).
// Calls el(renderedText) every periodMs; returns a stop() function.
export function animateGradient(text, el, periodMs = 120) {
  const start = Date.now();
  const timer = setInterval(() => {
    try { el(gradientAnimated(text, (Date.now() - start) / 1000)); } catch { /* keep animating */ }
  }, periodMs);
  return () => clearInterval(timer);
}
// Raw sampling for cell-by-cell renderers (the splash wordmark): position
// p ∈ [0,1] → [r,g,b], and the endless ping-pong wave used to slide it.
export const sampleRGB = sample;
export const wave = tri;
