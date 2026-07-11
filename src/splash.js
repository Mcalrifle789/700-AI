// The 700 AI welcome screen — recreates assets/screenshot.png via the scene
// compositor (ember/nebula wallpaper + glowing wordmark + input card). Falls
// back to a plain banner if the compositor can't run (tiny/odd terminals).
import { c, brand, VERSION } from './theme.js';
import { config } from './store.js';
import { centerLine, termWidth, glyph } from './ui.js';
import { buildScene, sceneFrameLeft } from './scene.js';

// Left edge of the input card, so the REPL prompt lines up under it.
let _frameLeft = 4;
export function frameLeft() { return _frameLeft; }

export function renderSplash() {
  const cfg = config.read();
  try {
    const scene = buildScene(cfg);
    _frameLeft = sceneFrameLeft();
    process.stdout.write('\n' + scene + '\n');
    process.stdout.write(centerLine(
      c.dim('Type in the box below   ' + glyph.dot + '   ') + c.white('/skills') + c.dim(' commands   ' + glyph.dot + '   ')
      + c.white('/setup') + c.dim(' configure   ' + glyph.dot + '   ') + c.white('/exit') + c.dim(' quit')) + '\n');
  } catch {
    renderFallback(cfg);
  }
  if (!cfg.onboarded) {
    process.stdout.write('\n' + centerLine(
      c.orange('First run  ' + glyph.arrow + '  ') + c.dim('run ') + c.white('/setup')
      + c.dim(' to connect a provider')) + '\n');
  }
}

function renderFallback(cfg) {
  const W = termWidth();
  const model = cfg.provider ? cfg.provider.model : 'not configured';
  const out = ['', centerLine(brand('7 0 0   A I'), W), '',
    centerLine(c.dim('Your terminal.  Any model.  Your keys.'), W),
    centerLine(c.dim('model ') + c.white(model) + c.dim('  ·  v' + VERSION), W), '',
    centerLine(c.dim('Type on the ') + c.orange('700 ' + glyph.prompt) + c.dim(' line · ') + c.white('/skills') + c.dim(' for commands'), W), ''];
  process.stdout.write(out.join('\n') + '\n');
}
