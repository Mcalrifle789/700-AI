// The 700 AI welcome screen — recreates assets/screenshot.png via the scene
// compositor (ember/nebula wallpaper + glowing wordmark + input card). Falls
// back to a plain banner if the compositor can't run (tiny/odd terminals).
//
// The wordmark carries a bright gold→red gradient that slides endlessly while
// the splash is on screen (see startLogoAnimation below).
import { c, brand, VERSION } from './theme.js';
import { config } from './store.js';
import { centerLine, termWidth, glyph } from './ui.js';
import { buildScene, sceneFrameLeft, wordmarkGeometry, wordmarkFrame } from './scene.js';

// Left edge of the input card, so the REPL prompt lines up under it.
let _frameLeft = 4;
export function frameLeft() { return _frameLeft; }

// renderSplash({ provider, notes })
//   provider — the session's active provider/model for the status line
//              (defaults to the configured default)
//   notes    — extra centered lines under the hint (e.g. "Resumed …"); printed
//              here so they are part of the measured splash height
export function renderSplash({ provider, notes = [] } = {}) {
  stopLogoAnimation();
  const cfg = config.read();
  let lines = 0;
  const write = (s) => { process.stdout.write(s); lines += (s.match(/\n/g) || []).length; };
  let animate = false;
  try {
    const scene = buildScene(provider ? { ...cfg, provider } : cfg);
    _frameLeft = sceneFrameLeft();
    write(scene + '\n');
    write(centerLine(
      c.dim('Type in the box below   ' + glyph.dot + '   ') + c.white('/skills') + c.dim(' commands   ' + glyph.dot + '   ')
      + c.white('/model') + c.dim(' switch model   ' + glyph.dot + '   ') + c.white('/exit') + c.dim(' quit')) + '\n');
    animate = true;
  } catch {
    renderFallback(cfg, write);
  }
  for (const n of notes) write(centerLine(n) + '\n');
  if (animate) startLogoAnimation(lines);
}

function renderFallback(cfg, write) {
  const W = termWidth();
  const model = cfg.provider ? cfg.provider.model : 'not configured';
  const out = ['', centerLine(brand('7 0 0   A I'), W), '',
    centerLine(c.dim('Your terminal.  Any model.  Your keys.'), W),
    centerLine(c.dim('model ') + c.white(model) + c.dim('  ·  v' + VERSION), W), '',
    centerLine(c.dim('Type on the ') + c.orange('700 ' + glyph.prompt) + c.dim(' line · ') + c.white('/skills') + c.dim(' for commands'), W), ''];
  write(out.join('\n') + '\n');
}

// ── animated logo gradient ─────────────────────────────────────────────────
// Frames are drawn at absolute screen positions, which is only safe while the
// splash sits exactly where it was drawn. Two guards make sure of that:
//   1. Right after the splash, ask the terminal for the cursor row (DSR). The
//      terminal answers in output order, so the reply says where the cursor
//      was immediately after the splash — it must equal the line count we just
//      wrote + 1, proving the splash starts on row 1 and nothing scrolled.
//   2. The input box (4 lines) must fit below without scrolling.
// The REPL stops the animation as soon as anything else is printed (a
// submitted message, the command palette, a resize); the next splash render
// restarts it.
const FPS = 12;
const SPEED = 0.35; // gradient cycles per second
let _anim = null;

export function stopLogoAnimation() {
  if (!_anim) return;
  _anim.stop();
  _anim = null;
}

function startLogoAnimation(splashLines) {
  const out = process.stdout;
  const inp = process.stdin;
  const geo = wordmarkGeometry();
  if (!out.isTTY || !inp.isTTY || !geo || process.env.AI700_NO_ANIM) return;
  if (splashLines + 4 > (out.rows || 24)) return; // box would scroll the logo

  let timer = null;
  let stopped = false;
  const onData = (d) => {
    const m = /\x1B\[(\d+);(\d+)R/.exec(String(d));
    if (!m) return;
    cleanupProbe();
    if (stopped || Number(m[1]) !== splashLines + 1) return; // splash moved — stay static
    const start = Date.now();
    const top = geo.y0 + 1, left = geo.x0 + 1;
    timer = setInterval(() => {
      out.write(wordmarkFrame(((Date.now() - start) / 1000) * SPEED, top, left));
    }, Math.round(1000 / FPS));
    timer.unref(); // never keep the process alive
  };
  const probeTimeout = setTimeout(() => cleanupProbe(), 800);
  probeTimeout.unref();
  function cleanupProbe() { clearTimeout(probeTimeout); inp.off('data', onData); }

  // Raw mode so the terminal's reply isn't echoed onto the screen; the input
  // box's report filter swallows it if the box is already listening.
  inp.setRawMode(true);
  inp.resume();
  inp.on('data', onData);
  out.write('\x1B[6n');

  _anim = {
    stop() {
      stopped = true;
      cleanupProbe();
      if (timer) clearInterval(timer);
    },
  };
}
