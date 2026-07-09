#!/usr/bin/env node
// 700 AI — CLI entry point.
// Usage:
//   700            start the interactive terminal (REPL)
//   700 setup      run guided setup (provider, model, search, images)
//   700 --version  print version
//   700 --help     show usage
import { startRepl } from '../src/repl.js';
import { runSetup } from '../src/setup.js';
import { c, brand, VERSION } from '../src/theme.js';

function printHelp() {
  console.log('\n' + brand('  700 AI') + c.dim('  — a local AI assistant for your terminal') + '\n');
  console.log('  ' + c.white('700') + c.dim('            start the interactive terminal'));
  console.log('  ' + c.white('700 setup') + c.dim('      guided setup (provider, model, search, images)'));
  console.log('  ' + c.white('700 --version') + c.dim('  print version'));
  console.log('  ' + c.white('700 --help') + c.dim('     show this help'));
  console.log('');
}

async function main() {
  const [cmd] = process.argv.slice(2);

  switch (cmd) {
    case undefined:
      await startRepl();
      break;
    case 'setup':
      await runSetup();
      break;
    case '-v':
    case '--version':
      console.log('700 AI v' + VERSION);
      break;
    case '-h':
    case '--help':
      printHelp();
      break;
    default:
      console.log(c.red(`\n  Unknown command: ${cmd}`) + c.dim('  — try ') + c.white('700 --help') + '\n');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c.red('\n  700 AI crashed: ') + c.dim(err?.stack || err?.message || String(err)) + '\n');
  process.exit(1);
});
