// Deployment & version control (spec 3). Built-in automation that stages,
// commits, and pushes the working tree to the configured GitHub repository:
//
//   Local change set → validate integrity/workspace → construct staging tree &
//   commit → push via GitHub Classic token → remote up-to-date.
//
// Authentication uses a GitHub Personal Access Token (classic) read from the
// GITHUB_PAT (or GITHUB_TOKEN) environment variable — never stored, never
// echoed. The token is passed to git via an http.extraHeader so it stays out of
// the remote URL and the command's visible arguments. Every failure is surfaced
// as a self-healing diagnostic (spec 2.4), not a raw git error.
import { execFile } from 'child_process';
import prompts from 'prompts';
import { c } from './theme.js';
import { glyph } from './ui.js';
import { classify, diagnostic, renderDiagnostic } from './pipeline/diagnostics.js';

const git = (args, opts = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = String(stderr || ''); return reject(err); }
    resolve(String(stdout).trim());
  });
});

const token = () => process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || null;
const isHttpsGitHub = (url) => /^https:\/\/[^/]*github\.com\//i.test(url || '');

// The vertical deployment flow diagram from spec 3, with the active step lit.
const FLOW = ['Local change set', 'Validate integrity & workspace', 'Construct staging tree & commit', 'Push via GitHub token auth', 'Remote up-to-date'];
function flowStep(active, label) {
  const box = c.orange('╭' + '─'.repeat(38) + '╮') + '\n' +
    c.orange('│') + ' ' + (active ? c.gold(glyph.spark + ' ') : c.dim('  ')) + c.white(label.padEnd(34)) + c.orange('│') + '\n' +
    c.orange('╰' + '─'.repeat(38) + '╯');
  return box.split('\n').map((l) => '    ' + l).join('\n');
}
function showFlow(activeIndex) {
  console.clear?.();
  const parts = [];
  FLOW.forEach((label, i) => {
    parts.push(flowStep(i === activeIndex, label));
    if (i < FLOW.length - 1) parts.push('                     ' + c.dim('│') + '\n                     ' + c.dim('▼'));
  });
  console.log('\n' + parts.join('\n') + '\n');
}

function emitDiagnostic(code, ctx) {
  console.log('\n' + renderDiagnostic(diagnostic(code, ctx)) + '\n');
}

// Build a semantic commit message. Uses the user's message if given; otherwise a
// conventional-commits default scoped to core.
function semanticMessage(arg, changedFiles) {
  if (arg && arg.trim()) {
    // If the user didn't give a conventional prefix, wrap it as feat(core).
    return /^\w+(\([^)]+\))?!?:/.test(arg.trim()) ? arg.trim() : `feat(core): ${arg.trim()}`;
  }
  const n = changedFiles;
  return `feat(core): update 700 AI terminal engine (${n} file${n === 1 ? '' : 's'})`;
}

export async function runDeploy(arg) {
  // 1 — validate workspace is a git repo.
  showFlow(1);
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    emitDiagnostic('GIT_NOT_REPO'); return;
  }

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  let remoteUrl = null;
  try {
    const remoteName = await git(['config', '--get', `branch.${branch}.remote`]).catch(() => 'origin');
    remoteUrl = await git(['remote', 'get-url', remoteName || 'origin']);
  } catch {
    emitDiagnostic('GIT_NO_REMOTE'); return;
  }

  // What will change.
  const statusPorc = await git(['status', '--porcelain']);
  if (!statusPorc) { emitDiagnostic('GIT_NOTHING'); return; }
  const changed = statusPorc.split('\n').filter(Boolean);

  // Preflight token check for https GitHub remotes.
  if (isHttpsGitHub(remoteUrl) && !token()) {
    emitDiagnostic('GIT_AUTH'); return;
  }

  const message = semanticMessage(arg, changed.length);

  // Show the plan and confirm — pushing is an external action, so we always ask.
  console.log(c.dim('  remote  ') + c.white(remoteUrl.replace(/\/\/[^@]*@/, '//')) );
  console.log(c.dim('  branch  ') + c.white(branch));
  console.log(c.dim('  commit  ') + c.gold(message));
  console.log(c.dim('  files   ') + c.white(changed.length + ' change' + (changed.length === 1 ? '' : 's')));
  changed.slice(0, 12).forEach((l) => console.log('    ' + c.dim(l)));
  if (changed.length > 12) console.log('    ' + c.faint(`… and ${changed.length - 12} more`));

  const { go } = await prompts({ type: 'confirm', name: 'go', message: `Stage all, commit, and push to ${branch}?`, initial: false });
  if (!go) { console.log(c.dim('\n  Deploy cancelled.\n')); return; }

  try {
    // 3 — atomic staging + semantic commit.
    showFlow(2);
    await git(['add', '-A']);
    await git(['commit', '-m', message]);

    // 4 — push via token auth (extraHeader keeps the PAT out of URL/args).
    showFlow(3);
    const pushArgs = ['push'];
    if (isHttpsGitHub(remoteUrl) && token()) {
      const basic = Buffer.from('x-access-token:' + token()).toString('base64');
      pushArgs.unshift('-c', 'http.extraHeader=Authorization: Basic ' + basic);
    }
    // Set upstream if the branch has none.
    const hasUpstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then(() => true).catch(() => false);
    await git([...pushArgs, ...(hasUpstream ? [] : ['-u', 'origin', branch])]);

    // 5 — done.
    showFlow(4);
    console.log(c.green('  ' + glyph.ok + ' Pushed ') + c.white(branch) + c.green(' — remote is up to date.') + '\n');
  } catch (err) {
    const cls = classify(err) || {};
    const msg = (err.stderr || err.message || '').toLowerCase();
    if (cls.code === 'AUTH' || /authentication|denied|403|invalid username or password|could not read/i.test(msg)) {
      emitDiagnostic('GIT_AUTH');
    } else if (/no upstream|no configured push destination|does not appear to be a git repo/i.test(msg)) {
      emitDiagnostic('GIT_NO_REMOTE');
    } else if (/nothing to commit/i.test(msg)) {
      emitDiagnostic('GIT_NOTHING');
    } else {
      console.log('\n' + renderDiagnostic({ code: 'GIT_FAIL', module: 'Deploy.VersionControl', status: '0x500', cause: (err.stderr || err.message || 'git failed').split('\n')[0], steps: ['Review the git error above.', 'Resolve conflicts or auth, then run /deploy again.'] }) + '\n');
    }
  }
}
