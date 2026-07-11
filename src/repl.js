// The 700 AI interactive terminal loop.
import readline from 'readline';
import prompts from 'prompts';
import { c, brand } from './theme.js';
import { config, wallet } from './store.js';
import { renderSplash, frameLeft } from './splash.js';
import { spinner, workingAnimation, glyph, centerLine, rule, termWidth } from './ui.js';
import { boxInput } from './input.js';
import { runSetup, SEARCH_PROVIDERS, chooseModel } from './setup.js';
import { SKILLS, getSkill } from './skills/index.js';
import { chatStream, generateImage, PRESETS } from './providers.js';
import { STORE, priceLabel, installPlugin, loadPlugins } from './plugins.js';
import { openWallet } from './wallet.js';
import { manageAgents, findAgent } from './agents.js';
import { startPreview } from './build/preview.js';
import { webSearch } from './search.js';

export async function startRepl() {
  renderSplash();

  const ctx = { config, wallet, say: (s) => console.log(s) };
  const pluginSkills = await loadPlugins(ctx);
  const allSkills = [...SKILLS, ...pluginSkills];

  const history = [];
  for (;;) {
    const raw = await boxInput({ indent: frameLeft(), placeholder: 'Ask anything...' });
    const line = (raw || '').trim();
    if (!line) continue;

    // slash-command or bare command
    const isCmd = line.startsWith('/') || getCommand(line);
    if (isCmd) {
      const [name, ...rest] = line.replace(/^\//, '').split(' ');
      const arg = rest.join(' ');
      const done = await runCommand(name.toLowerCase(), arg, { history, allSkills });
      if (done === 'exit') break;
      continue;
    }

    // @agent routing
    const routed = findAgent(line);
    if (routed) {
      await streamChat([{ role: 'system', content: routed.agent.system }, ...history, { role: 'user', content: routed.message }], history, routed.message, routed.agent.model);
      continue;
    }

    // plain conversation
    await streamChat([...history, { role: 'user', content: line }], history, line);
  }
}

function getCommand(line) {
  const first = line.split(' ')[0].toLowerCase();
  return getSkill(first);
}

async function runCommand(name, arg, { history, allSkills }) {
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

// Writes streamed text with a soft left gutter bar on every line.
function gutterWriter(prefix) {
  let atStart = true;
  return (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (atStart) { process.stdout.write(prefix); atStart = false; }
      const nl = chunk.indexOf('\n', i);
      if (nl === -1) { process.stdout.write(c.white(chunk.slice(i))); break; }
      process.stdout.write(c.white(chunk.slice(i, nl)) + '\n');
      atStart = true;
      i = nl + 1;
    }
  };
}

async function streamChat(messages, history, userText, modelOverride) {
  const cfg = config.read();
  if (!cfg.provider) {
    console.log('\n  ' + c.orange(glyph.warn + ' No provider configured.') + c.dim(' Run ') + c.white('700 setup') + c.dim(' first.\n'));
    return;
  }
  const provider = modelOverride ? { ...cfg.provider, model: modelOverride } : cfg.provider;
  const pad = ' '.repeat(frameLeft() + 1);
  process.stdout.write('\n');

  // Show a "working" animation until the first token streams back.
  const working = workingAnimation('700 is thinking', pad);
  const write = gutterWriter(pad + c.faint('│ '));
  let full = '';
  let started = false;
  try {
    const controller = new AbortController();
    for await (const delta of chatStream(provider, messages, { signal: controller.signal })) {
      if (!started) {
        started = true;
        working.stop();
        process.stdout.write(pad + c.gold(glyph.spark + ' 700') + c.dim('  ' + glyph.dot + '  ' + provider.model) + '\n' + pad + c.faint('│') + '\n');
      }
      write(delta);
      full += delta;
    }
  } catch (e) {
    working.stop();
    console.log(pad + c.red(glyph.err + ' request failed: ') + c.dim(e.message));
    return;
  }
  working.stop();
  process.stdout.write('\n');
  history.push({ role: 'user', content: userText }, { role: 'assistant', content: full });
}

function printSkills(allSkills) {
  const W = termWidth();
  console.log('\n' + centerLine(brand('700 AI') + c.dim('   ' + glyph.dot + '   ' + allSkills.length + ' commands'), W) + '\n');
  const groups = {};
  for (const s of allSkills) (groups[s.group || 'plugin'] ||= []).push(s);
  const order = ['core', 'create', 'code', 'write', 'know', 'plugin'];
  const label = { core: 'Core', create: 'Create', code: 'Code', write: 'Write', know: 'Knowledge', plugin: 'Plugins' };
  for (const g of order) {
    const list = groups[g];
    if (!list) continue;
    console.log('  ' + c.orange(glyph.bar) + ' ' + c.orange(label[g] || g));
    for (const s of list) {
      const tag = s.plugin ? c.gold('  ' + glyph.spark) : '';
      console.log('    ' + c.gold(glyph.prompt) + ' ' + c.white(('/' + s.name).padEnd(13)) + c.dim(s.desc) + tag);
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
    const r = await prompts({ type: 'text', name: 'k', message: 'Paste your license key from checkout:' });
    key = r.k;
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
    for await (const delta of chatStream(cfg.provider, [{ role: 'system', content: sys }, { role: 'user', content: goal }])) {
      process.stdout.write(c.faint(delta));
      full += delta;
    }
  } catch (e) { console.log(c.red('\n  build failed: ') + c.dim(e.message)); return; }

  const html = (full.match(/```html\n([\s\S]*?)```/) || [null, full])[1];
  win.write('index.html', html);
  console.log('\n\n' + c.green('  ✓ Build complete — see the live window.') + c.dim(`  files in ${win.dir}\n`));
  history.push({ role: 'user', content: 'build: ' + goal }, { role: 'assistant', content: '[built index.html]' });
}
