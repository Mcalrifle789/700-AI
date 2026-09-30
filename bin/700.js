#!/usr/bin/env node
// 700 AI — CLI entry point.
// Usage:
//   700 start      start the interactive terminal (REPL)
//   700 setup      run guided setup (provider, model, search, images)
//   700 --version  print version
//   700 --help     show usage
import { startRepl } from '../src/repl.js';
import { runSetup } from '../src/setup.js';
import { c, brand, VERSION } from '../src/theme.js';

function printHelp() {
  console.log('\n' + brand('  700 AI') + c.dim('  — a local AI assistant for your terminal') + '\n');
  console.log('  ' + c.white('700 start') + c.dim('      start the interactive terminal'));
  console.log('  ' + c.white('700 setup') + c.dim('      guided setup (provider, model, search, images)'));
  console.log('  ' + c.white('700 --version') + c.dim('  print version'));
  console.log('  ' + c.white('700 --help') + c.dim('     show this help'));
  console.log('');
  console.log('  ' + c.dim('PowerShell can\'t run commands that start with a digit — use ')
    + c.white('ai700 start') + c.dim(' there'));
  console.log('  ' + c.dim('(or ') + c.white('& 700 start') + c.dim('). ')
    + c.dim('cmd.exe and Git Bash accept ') + c.white('700 start') + c.dim(' directly.'));
  console.log('');
}

async function main() {
  const [cmd] = process.argv.slice(2);

  switch (cmd) {
    case 'start':
      await startRepl();
      break;
    case undefined:
      printHelp();
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
