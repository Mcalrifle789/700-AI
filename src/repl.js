// The 700 AI interactive terminal loop.
import readline from 'readline';
import prompts from 'prompts';
import { c, brand, ember } from './theme.js';
import { config, wallet } from './store.js';
import { renderSplash, frameLeft } from './splash.js';
import { spinner, glyph, centerLine, rule, termWidth, setTerminalTitle, enterFullscreen, leaveFullscreen, onResize } from './ui.js';
import { boxInput, requestRefresh, inputActive } from './input.js';
import { runSetup, SEARCH_PROVIDERS, chooseModel, maskedInput } from './setup.js';
import { SKILLS, getSkill } from './skills/index.js';
import { chatStream, generateImage, PRESETS, requiresKey } from './providers.js';
import { STORE, priceLabel, installPlugin, loadPlugins } from './plugins.js';
import { openWallet } from './wallet.js';
import { manageAgents, findAgent } from './agents.js';
import { startPreview } from './build/preview.js';
import { webSearch } from './search.js';
import { connectMusic, doPlay, doPlaylists, doPause, doNext, doPrev, doNowPlaying } from './music/index.js';
import { stageFile, metaSummary, stagedContext } from './pipeline/intake.js';
import { humanBytes } from './pipeline/limits.js';
import { classify, diagnostic, renderDiagnostic, reportFor } from './pipeline/diagnostics.js';
import { stateAnimation, STATE_NAMES } from './animations.js';
import { createRenderer } from './format.js';
import { route, withScaffold } from './reason.js';
import { runDeploy } from './deploy.js';

// Set while a reply is streaming; Ctrl+C then cancels that reply instead of
// exiting the app.
let streamCancel = null;

export async function startRepl() {
  // Name the terminal tab and take over the full screen (restored on exit).
  setTerminalTitle('700 AI');
  if (enterFullscreen()) {
    process.once('exit', leaveFullscreen);
  }
  // Ctrl+C cancels a running stream instead of killing the app; with nothing
  // streaming it exits as usual.
  process.on('SIGINT', () => {
    if (streamCancel) { streamCancel.cancelled = true; return; }
    leaveFullscreen();
    process.exit(0);
  });

  renderSplash();

  // Terminal resize (minimize/maximize/drag): re-fit the whole app — redraw
  // the splash scene for the new size, then have the active input widget
  // (box or palette) redraw fresh beneath it. Skipped while output is
  // streaming or a command runs, so live output isn't wiped mid-flight.
  let resizeTimer = null;
  onResize(() => {
    if (!inputActive()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!inputActive()) return; // widget closed while we waited
      console.clear();
      renderSplash();
      requestRefresh();
    }, 120);
  });

  // Provider sanity check: a hosted provider with no real key stored (e.g. the
  // legacy 'ollama' placeholder) can never authenticate — say so up front.
  const cfg0 = config.read();
  if (cfg0.provider && requiresKey(cfg0.provider) && (!cfg0.provider.apiKey || cfg0.provider.apiKey === 'ollama')) {
    console.log(c.gold('\n  ⚠ ' + cfg0.provider.label + ' has no API key stored — chat requests will fail auth.')
      + c.dim('  Run ') + c.white('/setup') + c.dim(' to enter it (masked, verified live).\n'));
  }

  const ctx = { config, wallet, say: (s) => console.log(s) };
  const pluginSkills = await loadPlugins(ctx);
  // /history — session transcript review. Registered on SKILLS so the palette,
  // /skills and bare-name lookup all see it.
  SKILLS.push({ name: 'history', desc: 'Review this session conversation', group: 'know' });
  const allSkills = [...SKILLS, ...pluginSkills];

  const history = [];
  const staged = [];   // multimodal assets staged via /stage, injected as context
  for (;;) {
    const raw = await boxInput({ indent: frameLeft(), placeholder: staged.length ? `${staged.length} file(s) staged · ask anything…` : 'Ask anything…', commands: allSkills });
    if (raw === null) break;  // EOF on piped/scripted stdin — exit cleanly
    const line = (raw || '').trim();
    if (!line) continue;

    // slash-command or bare command. A bare word only counts when it IS the
    // command (no arguments) — otherwise natural sentences whose first word
    // happens to be a command name ("image of a cat", "search the web for…")
    // hijacked the conversation into running that command.
    const isCmd = line.startsWith('/') || (line.split(' ').length === 1 && !!getCommand(line));
    if (isCmd) {
      const [name, ...rest] = line.replace(/^\//, '').split(' ');
      const arg = rest.join(' ');
      const done = await runCommand(name.toLowerCase(), arg, { history, allSkills, staged });
      if (done === 'exit') break;
      continue;
    }

    // @agent routing
    const routed = findAgent(line);
    if (routed) {
      echoUser(line);
      const msgs = injectStaged([{ role: 'system', content: routed.agent.system }, ...windowHistory(history), { role: 'user', content: routed.message }], staged);
      await streamChat(msgs, history, routed.message, { model: routed.agent.model });
      continue;
    }

    // plain conversation — speculative routing + CoT scaffolding (spec 2.2)
    echoUser(line);
    const cfg = config.read();
    const r = route(line, cfg, { staged: staged.length });
    let msgs = injectStaged([...windowHistory(history), { role: 'user', content: line }], staged);
    msgs = withScaffold(msgs, { cot: r.cot });
    await streamChat(msgs, history, line, { model: r.model, tier: r.tier, complexity: r.complexity });
  }
}

// Prepend the staged multimodal context block as a system message, if any.
function injectStaged(messages, staged) {
  const ctx = stagedContext(staged);
  return ctx ? [{ role: 'system', content: ctx }, ...messages] : messages;
}

// Keep the prompt context within a budget: recent turns are sent verbatim,
// older ones drop off (the full transcript stays reviewable via /history).
// Previously history grew unbounded, which eventually overflows the model's
// context window on long sessions.
const CONTEXT_MAX_CHARS = 12000;
const CONTEXT_MAX_TURNS = 30;
function windowHistory(history) {
  const out = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && out.length < CONTEXT_MAX_TURNS; i--) {
    const cost = (history[i].content || '').length;
    if (out.length >= 2 && used + cost > CONTEXT_MAX_CHARS) break;
    out.unshift(history[i]);
    used += cost;
  }
  return out;
}

function getCommand(line) {
  const first = line.split(' ')[0].toLowerCase();
  return getSkill(first);
}

async function runCommand(name, arg, { history, allSkills, staged }) {
  switch (name) {
    case 'setup': await runSetup(); return;
    case 'wallet': await openWallet(); return;
    case 'skills': case 'help': printSkills(allSkills); return;
    case 'plugins': await pluginMenu(); return;
    case 'agents': await manageAgents(); return;
    case 'sessions': console.log(c.dim('\n  Sessions are saved per run in ~/.700ai. (demo build)\n')); return;
    case 'provider': await runSetup(); return;
    case 'model': await switchModel(); return;
    case 'image': await doImage(arg); return;
    case 'build': await doBuild(arg, history); return;
    case 'search': await doSearch(arg, history); return;
    case 'stage': case 'attach': await doStage(arg, staged); return;
    case 'staged': case 'attachments': showStaged(staged); return;
    case 'unstage': doUnstage(arg, staged); return;
    case 'deploy': case 'push': await runDeploy(arg); return;
    case 'route': await configureRoute(); return;
    case 'states': await demoStates(); return;
    case 'history': showHistory(history); return;
    case 'music': await connectMusic(); return;
    case 'play': await doPlay(arg); return;
    case 'playlists': await doPlaylists(); return;
    case 'pause': await doPause(); return;
    case 'next': case 'skip': await doNext(); return;
    case 'prev': case 'previous': await doPrev(); return;
    case 'nowplaying': await doNowPlaying(); return;
    case 'voice': {
      const vs = allSkills.find((s) => s.name === 'voice' && s.plugin);
      if (vs?.run) { await vs.run(arg); return; }
      console.log(c.dim('\n  Voice needs the ') + c.white('ElevenLabs') + c.dim(' plugin. Try ') + c.white('/plugins') + c.dim('.\n'));
      return;
    }
    case 'clear': history.length = 0; console.clear(); renderSplash(); return;
    case 'exit': case 'quit': console.log(c.dim('\n  bye ✦\n')); return 'exit';
    default: {
      const skill = getSkill(name);
      if (skill?.kind === 'prompt') {
        const msg = arg || (await prompts({ type: 'text', name: 'm', message: `${skill.name}:` })).m;
        if (msg) await streamChat([{ role: 'system', content: skill.system }, { role: 'user', content: msg }], history, msg);
        return;
      }
      if (skill?.run) { await skill.run(arg); return; }
      console.log(c.red(`\n  Unknown command: ${name}`) + c.dim('  — try /skills\n'));
    }
  }
}

// Echoes the message the user just sent as a clean "you" block. The input box
// erases itself on submit, so this is what keeps the conversation readable:
// one tidy user block, then the assistant reply — no stacked, half-filled boxes.
function echoUser(text) {
  const pad = ' '.repeat(frameLeft() + 1);
  process.stdout.write('\n' + pad + c.orange(glyph.prompt + ' you') + '\n' + pad + c.orange('│') + '\n');
  const write = gutterWriter(pad + c.orange('│ '));
  write(text);
  process.stdout.write('\n');
}

// Writes streamed text with a soft left gutter bar on every line, in the given
// color (defaults to white for answers; dim is used for a model's reasoning).
function gutterWriter(prefix, color = c.white) {
  let atStart = true;
  return (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (atStart) { process.stdout.write(prefix); atStart = false; }
      const nl = chunk.indexOf('\n', i);
      if (nl === -1) { process.stdout.write(color(chunk.slice(i))); break; }
      process.stdout.write(color(chunk.slice(i, nl)) + '\n');
      atStart = true;
      i = nl + 1;
    }
  };
}

async function streamChat(messages, history, userText, opts = {}) {
  const cfg = config.read();
  if (!cfg.provider) {
    console.log('\n' + renderDiagnostic(diagnostic('NO_PROVIDER')) + '\n');
    return;
  }
  const model = opts.model || cfg.provider.model;
  const provider = { ...cfg.provider, model };
  const pad = ' '.repeat(frameLeft() + 1);
  const gutter = pad + c.faint('│ ');
  process.stdout.write('\n');

  // Rich typography (spec 2.5): stream content through the layout node so
  // headers, code, callouts and emphasis render. Line-buffered — emits styled
  // lines as newlines arrive.
  const renderer = createRenderer({ emitLine: (l) => process.stdout.write(gutter + l + '\n'), width: Math.max(40, termWidth() - frameLeft() - 4) });
  const writeThinking = gutterWriter(gutter, c.dim);

  let full = '';
  let started = false;
  let phase = null; // 'reasoning' | 'content'

  // Connection with retry + exponential backoff (spec 2.4). We only retry while
  // nothing has streamed yet; once tokens arrive a failure is surfaced as-is.
  const anim = stateAnimation('connecting', { label: 'connecting' });
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const ev of chatStream(provider, messages, {})) {
        if (!started) { started = true; anim.stop(); }
        if (ev.type === 'reasoning') {
          if (phase !== 'reasoning') { phase = 'reasoning'; process.stdout.write(pad + c.dim(glyph.dot + ' thinking…') + '\n' + pad + c.faint('│') + '\n'); }
          writeThinking(ev.text);
        } else {
          if (phase !== 'content') {
            if (phase === 'reasoning') process.stdout.write('\n\n');
            phase = 'content';
            const tier = opts.tier === 'small' ? c.dim('  ' + glyph.dot + '  fast route') : '';
            process.stdout.write(pad + c.gold(glyph.spark + ' 700') + c.dim('  ' + glyph.dot + '  ' + model) + tier + '\n' + pad + c.faint('│') + '\n');
          }
          renderer.push(ev.text);
          full += ev.text;
        }
      }
      break; // stream completed
    } catch (e) {
      const cls = classify(e);
      if (!started && cls?.code === 'NETWORK' && attempt < 3) {
        anim.to('connecting', `reconnecting (try ${attempt + 2}/4)…`);
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }
      if (!started) anim.stop();
      const report = cls ? diagnostic(cls.code, { ...cls.ctx, baseURL: provider.baseURL }) : reportFor(e, { module: 'Provider.Transport' });
      console.log((started ? '\n' : '') + renderDiagnostic(report) + '\n');
      return;
    }
  }
  if (!started) anim.stop();
  if (phase === 'content') renderer.end();
  process.stdout.write('\n');
  history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
}

const GROUP_STYLE = {
  core: { color: c.gold, dot: '●', label: 'Core' },
  create: { color: c.orange, dot: '◆', label: 'Create' },
  music: { color: c.green, dot: '♪', label: 'Music' },
  code: { color: c.red, dot: '▸', label: 'Code' },
  write: { color: c.green, dot: '✎', label: 'Write' },
  know: { color: c.gold, dot: '✦', label: 'Knowledge' },
  plugin: { color: c.orange, dot: '⊕', label: 'Plugins' },
};

function printSkills(allSkills) {
  const W = termWidth();
  const rule = ember('─'.repeat(Math.min(Math.max(20, W - 4), 60)));
  console.log('');
  console.log('  ' + rule);
  console.log('  ' + c.gold(glyph.spark + ' ') + brand('700 AI')
    + c.dim('   ' + allSkills.length + ' commands')
    + c.faint('   ' + glyph.dot + '   type ') + c.white('/') + c.faint(' in the box for the palette'));
  console.log('  ' + rule + '\n');

  const groups = {};
  for (const s of allSkills) (groups[s.group || 'plugin'] ||= []).push(s);
  const order = ['core', 'create', 'music', 'code', 'write', 'know', 'plugin'];
  const nameW = Math.max(...allSkills.map((s) => s.name.length)) + 3;
  for (const g of order) {
    const list = groups[g];
    if (!list) continue;
    const st = GROUP_STYLE[g] || { color: c.dim, dot: '·', label: g };
    console.log('  ' + st.color(st.dot + '  ' + st.label.toUpperCase()));
    for (const s of list) {
      const tag = s.plugin ? c.gold(' ' + glyph.spark) : '';
      console.log('     ' + st.color(('/' + s.name).padEnd(nameW)) + c.dim(s.desc) + tag);
    }
    console.log('');
  }
}

async function pluginMenu() {
  console.log('\n' + brand('  700 AI — Plugin Store') + c.dim('  (github.com/700-ai/700-ai)') + '\n');
  for (const p of STORE) {
    console.log('  ' + c.white(p.id.padEnd(16)) + priceLabel(p).padEnd(20) + c.dim(p.desc));
  }
  console.log('');
  const { id } = await prompts({
    type: 'select', name: 'id', message: 'Install a plugin',
    choices: [...STORE.map((p) => ({ title: `${p.name} — ${p.price === 0 ? 'free' : '$' + p.price.toFixed(2)}`, value: p.id })), { title: 'Close', value: '' }],
  }, { onCancel: () => ({ id: '' }) });
  if (!id) return;
  const item = STORE.find((p) => p.id === id);
  let key = null;
  if (item.price > 0) {
    console.log(c.dim(`\n  Checkout: `) + c.white(`https://700-ai.dev/buy/${id}`) + c.dim(`  ($${item.price.toFixed(2)}${item.taxed ? ' + tax' : ''})`));
    const entered = await maskedInput('Paste your license key from checkout:');
    key = (entered || '').trim() || null;
    if (!key) { console.log(c.dim('  Cancelled.\n')); return; }
    wallet.record({ item: item.name, amount: item.price });
  }
  await installPlugin(id, key);
  console.log('\n' + c.green(`  ✓ Installed ${item.name}.`) + c.dim('  Restart 700 AI to activate.\n'));
}

async function switchModel() {
  const cfg = config.read();
  if (!cfg.provider) { console.log(c.dim('\n  Run 700 setup first.\n')); return; }
  const model = await chooseModel(cfg.provider, cfg.provider.model);
  if (model && model !== cfg.provider.model) {
    config.write({ provider: { ...cfg.provider, model } });
    console.log('\n  ' + c.green(glyph.ok + ' Model → ') + c.white(model) + '\n');
  } else {
    console.log(c.dim('\n  Model unchanged.\n'));
  }
}

async function doImage(arg) {
  const cfg = config.read();
  const prompt = arg || (await prompts({ type: 'text', name: 'p', message: 'Image prompt:' })).p;
  if (!prompt) return;
  if (!cfg.imageModel) { console.log(c.dim('\n  Enable images in ') + c.white('700 setup') + c.dim('.\n')); return; }
  const win = await startPreview('700 AI — Image');
  console.log('');
  const sp = spinner('generating image…');
  try {
    const provider = { ...cfg.provider, model: cfg.imageModel.model };
    const url = await generateImage(provider, prompt);
    const src = url.startsWith('http') ? url : `data:image/png;base64,${url}`;
    win.write('index.html', `<body style="margin:0;background:#0a0a0a;display:grid;place-items:center;height:100vh"><img src="${src}" style="max-width:96%;max-height:96%"></body>`);
    sp.stop(c.green(glyph.ok), c.dim('image ready in the live window'));
  } catch (e) {
    sp.stop(c.red(glyph.err), c.dim(e.message));
  }
}

// Search mode: query the configured provider, print results, and (if a chat
// provider is set) synthesize a cited answer grounded in those results.
async function doSearch(arg, history) {
  const cfg = config.read();
  const query = arg || (await prompts({ type: 'text', name: 'q', message: 'Search:' })).q;
  if (!query) return;

  console.log('');
  const sp = spinner('searching ' + (cfg.search?.id || 'none') + '…');
  let results;
  try {
    results = await webSearch(cfg.search, query);
  } catch (e) {
    sp.stop(c.red(glyph.err), c.dim(e.message));
    return;
  }
  sp.stop(c.green(glyph.ok), c.dim(`${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`));
  if (!results.length) return;

  console.log('');
  results.forEach((r, i) => {
    console.log('  ' + c.gold(`${i + 1}.`) + ' ' + c.white(r.title));
    if (r.url) console.log('      ' + c.orange(r.url));
    if (r.snippet) console.log('      ' + c.dim(truncate(r.snippet, 160)));
    console.log('');
  });

  if (cfg.provider) {
    const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    const sys = 'Answer the user question using ONLY the search results provided. Cite sources inline as [n]. If the results are insufficient, say so.';
    await streamChat(
      [{ role: 'system', content: sys }, { role: 'user', content: `Question: ${query}\n\nSearch results:\n${context}` }],
      history, `search: ${query}`,
    );
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// /history — print the session transcript (turn-by-turn, compact).
function showHistory(history) {
  if (!history.length) { console.log(c.dim('\n  No conversation yet this session.\n')); return; }
  console.log('\n  ' + c.gold(glyph.spark + ' Session history') + c.dim('   ' + (history.length / 2) + ' turn' + (history.length === 2 ? '' : 's')) + '\n');
  for (let i = 0; i < history.length; i += 2) {
    const u = history[i], a = history[i + 1] || { content: '' };
    console.log('  ' + c.orange(glyph.prompt + ' you') + c.dim('   turn ' + (i / 2 + 1)));
    console.log('  ' + c.white(truncate(String(u.content || '').replace(/\s+/g, ' '), 110)));
    console.log('  ' + c.gold(glyph.spark + ' 700') + c.dim('  ·  ~' + Math.max(1, Math.round(a.content.length / 4)) + ' tok'));
    console.log('  ' + c.faint(truncate(String(a.content || '').replace(/\s+/g, ' '), 110)));
    console.log('');
  }
}

// Build mode: model returns files; each is streamed into the live window.
async function doBuild(arg, history) {
  const cfg = config.read();
  if (!cfg.provider) { console.log(c.dim('\n  Run 700 setup first.\n')); return; }
  const goal = arg || (await prompts({ type: 'text', name: 'g', message: 'What should 700 AI build?' })).g;
  if (!goal) return;

  const win = await startPreview('700 AI — Live Build');
  const sys = `You build small web apps/sites as a SINGLE self-contained index.html
(inline CSS + JS, no external build). Output ONLY the file inside a \`\`\`html code block. Goal: ${goal}`;

  console.log(c.dim('\n  building…\n'));
  let full = '';
  try {
    for await (const ev of chatStream(cfg.provider, [{ role: 'system', content: sys }, { role: 'user', content: goal }])) {
      process.stdout.write(c.faint(ev.text));
      if (ev.type === 'content') full += ev.text; // keep reasoning out of the parsed file
    }
  } catch (e) { console.log(c.red('\n  build failed: ') + c.dim(e.message)); return; }

  const html = (full.match(/```html\n([\s\S]*?)```/) || [null, full])[1];
  win.write('index.html', html);
  console.log('\n\n' + c.green('  ✓ Build complete — see the live window.') + c.dim(`  files in ${win.dir}\n`));
  history.push({ role: 'user', content: 'build: ' + goal }, { role: 'assistant', content: '[built index.html]' });
}

// ── Multimodal staging (spec 2.1) ───────────────────────────────────────────
// Stage a file: validate + harvest metadata off the main thread, then keep it
// as session context injected into subsequent prompts.
async function doStage(arg, staged) {
  const path = (arg || (await prompts({ type: 'text', name: 'p', message: 'File to stage:' })).p || '').trim().replace(/^["']|["']$/g, '');
  if (!path) return;

  process.stdout.write('\n');
  const anim = stateAnimation('running', { label: 'ingesting ' + path.split(/[\\/]/).pop() });
  let rec;
  try {
    rec = await stageFile(path);
  } catch (e) {
    anim.stop();
    const cls = classify(e);
    const report = cls ? diagnostic(cls.code, { ...cls.ctx, path }) : reportFor(e, { module: 'Pipeline.Multimodal.Intake' });
    console.log(renderDiagnostic(report) + '\n');
    return;
  }
  anim.stop();

  // Replace any earlier staging of the same file.
  const idx = staged.findIndex((s) => s.path === rec.path);
  if (idx >= 0) staged[idx] = rec; else staged.push(rec);

  const pad = '  ';
  console.log(pad + c.green(glyph.ok + ' staged ') + c.white(rec.name) + c.dim('  ' + glyph.dot + '  ' + rec.category.label) + (rec.cached ? c.faint('  (cached)') : ''));
  console.log(pad + c.dim('  type    ') + c.white(rec.mime) + c.faint('  · ' + rec.confidence));
  console.log(pad + c.dim('  size    ') + c.white(humanBytes(rec.size)) + c.faint('  · sha256 ' + rec.sha256.slice(0, 12) + '…'));
  const summary = metaSummary(rec);
  if (summary) console.log(pad + c.dim('  meta    ') + c.white(summary));
  if (rec.preview?.text) console.log(pad + c.dim('  preview ') + c.faint(truncate(rec.preview.text.replace(/\s+/g, ' '), 72)));
  console.log(pad + c.dim('  strategy ') + c.faint(rec.category.strategy));

  // Surface pipeline warnings as self-healing diagnostics (informational).
  for (const w of rec.warnings) {
    const d = diagnostic(w, { path: rec.path, actual: rec.extMismatch?.actual });
    if (d) console.log('\n' + renderDiagnostic(d));
  }
  console.log('');
}

function showStaged(staged) {
  if (!staged.length) { console.log(c.dim('\n  No files staged. Use ') + c.white('/stage <path>') + c.dim(' to add context.\n')); return; }
  console.log('\n  ' + c.gold(glyph.spark + ' Staged context') + c.dim('   ' + staged.length + ' file' + (staged.length === 1 ? '' : 's')) + '\n');
  staged.forEach((s, i) => {
    console.log('  ' + c.gold((i + 1) + '.') + ' ' + c.white(s.name) + c.dim('  ' + glyph.dot + '  ' + s.category.label + '  ' + glyph.dot + '  ' + humanBytes(s.size)));
    const m = metaSummary(s);
    if (m) console.log('     ' + c.faint(m));
  });
  console.log('');
}

function doUnstage(arg, staged) {
  const a = (arg || '').trim().toLowerCase();
  if (!staged.length) { console.log(c.dim('\n  Nothing staged.\n')); return; }
  if (!a || a === 'all') { staged.length = 0; console.log(c.dim('\n  Cleared all staged files.\n')); return; }
  const n = Number(a);
  let removed;
  if (Number.isInteger(n) && n >= 1 && n <= staged.length) removed = staged.splice(n - 1, 1)[0];
  else {
    const idx = staged.findIndex((s) => s.name.toLowerCase() === a || s.path.toLowerCase().endsWith(a));
    if (idx >= 0) removed = staged.splice(idx, 1)[0];
  }
  console.log(removed ? c.dim('\n  Unstaged ') + c.white(removed.name) + '\n' : c.dim('\n  No staged file matched “' + arg + '”.\n'));
}

// Configure speculative routing (spec 2.2): pick a small/fast model for simple
// queries; complex ones stay on the primary model.
async function configureRoute() {
  const cfg = config.read();
  if (!cfg.provider) { console.log('\n' + renderDiagnostic(diagnostic('NO_PROVIDER')) + '\n'); return; }
  const cur = cfg.routing || {};
  const { enabled } = await prompts({ type: 'toggle', name: 'enabled', message: 'Speculative routing (small model for simple queries)?', initial: !!cur.enabled, active: 'on', inactive: 'off' });
  if (enabled === undefined) return;
  let small = cur.small || '';
  if (enabled) {
    let choices = [];
    try { const { listModels } = await import('./providers.js'); choices = (await listModels(cfg.provider)).slice(0, 60); } catch { /* manual entry */ }
    const r = choices.length
      ? await prompts({ type: 'autocomplete', name: 'm', message: 'Small/fast model for simple queries', choices: choices.map((m) => ({ title: m, value: m })), initial: 0 })
      : await prompts({ type: 'text', name: 'm', message: 'Small/fast model id', initial: small });
    small = r.m || small;
  }
  config.write({ routing: { enabled: !!enabled, small } });
  console.log('\n  ' + c.green(glyph.ok + ' Routing ') + c.white(enabled ? 'on' : 'off') + (enabled && small ? c.dim('  · simple → ') + c.white(small) + c.dim('  · complex → ') + c.white(cfg.provider.model) : '') + '\n');
}

// Demo the five agent-state animations (spec 2.3), so all render styles and
// frame rates can be seen on demand.
async function demoStates() {
  const labels = {
    thinking: 'Parsing initial prompt context & metadata',
    'thinking-deeper': 'Executing complex logic / CoT expansion',
    running: 'Executing local scripts, commands, or tests',
    connecting: 'Negotiating remote socket / API handshake',
    paused: 'Idle; waiting for human input or permission',
  };
  console.log('\n  ' + c.gold(glyph.spark + ' Agent state animations') + c.dim('   5 states\n'));
  for (const state of STATE_NAMES) {
    const anim = stateAnimation(state, { label: state + ' — ' + labels[state] });
    await new Promise((r) => setTimeout(r, 1600));
    anim.stop();
  }
  console.log('  ' + c.green(glyph.ok + ' all states rendered') + '\n');
}
