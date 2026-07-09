// The 700 AI welcome screen — mirrors assets/screenshot.png.
import { c, brand, ember, VERSION } from './theme.js';
import { config } from './store.js';

// Blocky "700 AI" wordmark rendered to match the brand image feel.
const WORDMARK = [
  ' ███████╗  ██████╗   ██████╗      █████╗  ██╗',
  ' ╚════██║ ██╔═══██╗ ██╔═══██╗    ██╔══██╗ ██║',
  '     ██╔╝ ██║   ██║ ██║   ██║    ███████║ ██║',
  '    ██╔╝  ██║   ██║ ██║   ██║    ██╔══██║ ██║',
  '    ██║   ╚██████╔╝ ╚██████╔╝    ██║  ██║ ██║',
  '    ╚═╝    ╚═════╝   ╚═════╝     ╚═╝  ╚═╝ ╚═╝',
];

function pad(line, width) {
  const visible = line.replace(/\[[0-9;]*m/g, '');
  const gap = Math.max(0, width - visible.length);
  return line + ' '.repeat(gap);
}

export function renderSplash() {
  const cfg = config.read();
  const width = Math.min(process.stdout.columns || 80, 92);
  const provider = cfg.provider;
  const modelLabel = provider?.model || 'Claude Opus 4.8';
  const providerLabel = provider?.label || '700 AI Terminal';
  const tier = provider ? 'ready' : 'max';

  const out = [];
  out.push('');
  for (const row of WORDMARK) out.push('  ' + brand(row));
  out.push('');

  // input box
  const inner = width - 6;
  const top = c.box('  ┌' + '─'.repeat(inner) + '┐');
  const bottom = c.box('  └' + '─'.repeat(inner) + '┘');
  const line1 = c.box('  │ ') + pad(c.dim('Ask anything...  ') + c.faint('"Fix a TODO in the codebase"'), inner - 1) + c.box('│');
  const status =
    c.red('Build') + c.dim(' · ') + c.white(modelLabel) + c.dim('  ' + providerLabel + '  · ') + c.gold(tier);
  const line2 = c.box('  │ ') + pad(status, inner - 1) + c.box('│');
  const blank = c.box('  │ ') + pad('', inner - 1) + c.box('│');

  out.push(top);
  out.push(line1);
  out.push(blank);
  out.push(line2);
  out.push(bottom);
  out.push('');
  out.push(pad('', width - 34) + c.white('tab') + c.dim(' agents   ') + c.white('ctrl+p') + c.dim(' commands'));
  out.push('');
  out.push('  ' + c.gold('●') + ' ' + c.orange('Tip') + c.dim(' Use ') + c.white('/skills') + c.dim(' to list all 35 commands · ') + c.white('700 setup') + c.dim(' to configure'));
  out.push('');
  const footer = c.dim('  ~') + pad('', width - 12) + c.dim(VERSION);
  out.push(footer);
  out.push('');

  process.stdout.write(out.join('\n') + '\n');

  if (!cfg.onboarded) {
    console.log(c.orange('  First run detected.') + c.dim(' Type ') + c.white('700 setup') + c.dim(' (or ') + c.white('/setup') + c.dim(') to connect a provider.\n'));
  }
}
