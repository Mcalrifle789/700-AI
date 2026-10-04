// `ai700 setup` / /setup — guided onboarding.
//
//   1. Providers  — pick one or more from the full list (multi-select)
//   2. API keys   — one per selected provider, masked, verified live; the
//                   verification call also discovers that provider's models
//   3. Model      — default model, chosen from every discovered model
//   4. Search     — optional search provider
//   5. Images     — optional image model (on any selected provider)
//
// Nothing is saved until the end: cancelling midway leaves the previous config
// untouched and `onboarded` unset, so the launch gate sends the user back here.
// Returns true when setup completed, false when cancelled.
import readline from 'readline';
import { c, brand } from './theme.js';
import { config } from './store.js';
import { glyph } from './ui.js';
import { PRESETS, listModels, requiresKey } from './providers.js';
import { classify, diagnostic, renderDiagnostic } from './pipeline/diagnostics.js';
import { pickList, askText, askConfirm } from './picker.js';
import { readLine } from './term.js';
import { choiceKey, parseChoice } from './models.js';

export const SEARCH_PROVIDERS = [
  { id: 'none', title: 'None / skip', needsKey: false },
  { id: 'duckduckgo', title: 'DuckDuckGo  (no key, limited)', needsKey: false },
];

// Raw-mode masked reader: echoes one '*' per typed character (pastes arrive as
// regular keypress events, so they mask too), backspace edits, Enter submits.
// Resolves with the entered string; Esc resolves null (cancel). Non-TTY input
// reads a plain line from the shared queue.
export function maskedInput(message, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return readLine({ input, output, prompt: '  ' + message + ' ' });
  return new Promise((resolve) => {
    let value = '';
    output.write('\n  ' + c.white(message) + c.faint('  (each keystroke shows as *)\n  '));
    const done = (v) => {
      input.off('keypress', onKey);
      input.setRawMode(false);
      output.write('\n');
      resolve(v);
    };
    const onKey = (str, key) => {
      key = key || {};
      if (key.ctrl && key.name === 'c') { output.write('\n'); process.exit(0); return; }
      if (key.name === 'escape') return done(null);
      if (key.name === 'return' || key.name === 'enter') return done(value);
      if (key.name === 'backspace') {
        if (value.length) { value = value.slice(0, -1); output.write('\b \b'); }
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        const printable = [...str].filter((ch) => ch.codePointAt(0) >= 32).join('');
        if (printable) { value += printable; output.write('*'.repeat(printable.length)); }
      }
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
  });
}

// Ask for (and live-verify) one provider's key. The verification call doubles
// as model discovery. Resolves { apiKey, models } or null when cancelled.
async function connectProvider(conn, existing) {
  if (!requiresKey(conn)) {
    process.stdout.write(c.dim('\n  ' + conn.label + ' is local — no key needed. Discovering models…\n'));
    try {
      const models = await listModels(conn);
      console.log(c.green('  ' + glyph.ok + ' ' + conn.label + ': ' + models.length + ' models'));
      return { apiKey: conn.apiKey || '', models };
    } catch (e) {
      console.log(c.gold('  ⚠ ' + conn.label + ' is not reachable right now (' + e.message.split('\n')[0] + ').')
        + c.dim(' You can enter a model id manually.'));
      return { apiKey: conn.apiKey || '', models: existing?.models || [] };
    }
  }
  for (;;) {
    const keep = existing?.apiKey ? ' (Enter keeps the saved key)' : '';
    const entered = await maskedInput(`${conn.label} API key${keep}:`);
    if (entered === null) return null;
    const key = entered.trim() || existing?.apiKey || '';
    if (!key) {
      console.log(c.red('  ✗ ' + conn.label + ' needs an API key.') + c.dim('  Paste it, or press Esc to cancel setup.'));
      continue;
    }
    process.stdout.write(c.dim('  verifying with ' + conn.label + '…\n'));
    try {
      const models = await listModels({ ...conn, apiKey: key });
      console.log(c.green('  ' + glyph.ok + ' Key accepted — ' + models.length + ' models available on ' + conn.label + '.'));
      return { apiKey: key, models };
    } catch (e) {
      const code = classify(e)?.code;
      if (code === 'AUTH') {
        console.log('\n' + renderDiagnostic(diagnostic('AUTH', { baseURL: conn.baseURL })) + '\n');
        continue; // wrong key — ask again
      }
      console.log('\n' + renderDiagnostic(diagnostic('NETWORK', { baseURL: conn.baseURL })) + '\n');
      const use = await askConfirm('Could not verify ' + conn.label + ' right now. Use this key anyway?', { initial: true });
      if (use === null) return null;
      if (use) return { apiKey: key, models: existing?.models || [] };
    }
  }
}

export async function runSetup() {
  const cfg = config.read();
  console.log('\n' + brand('  700 AI — Guided Setup') + '\n');
  console.log(c.dim('  Nothing you enter here leaves your machine. Keys are stored in ~/.700ai'));
  console.log(c.dim('  Press Esc at any step to cancel — nothing is saved until the end.\n'));

  // 1 — providers (multi-select)
  const configured = new Set(cfg.providers.map((p) => p.id));
  let ids;
  for (;;) {
    ids = await pickList({
      title: 'Model providers', subtitle: 'select one or more', multi: true, filter: false,
      items: PRESETS.map((p) => ({
        label: p.label, value: p.id, checked: configured.has(p.id),
        desc: configured.has(p.id) ? 'configured' : (requiresKey(p) || !p.baseURL ? 'API key required' : 'local, no key'),
      })),
    });
    if (ids === null) return cancelled();
    if (ids.length) break;
    console.log(c.red('  ✗ Select at least one provider') + c.dim(' (space toggles, ↵ confirms).'));
  }

  // 2 — key + model discovery for each selected provider
  const providers = [];
  for (const id of ids) {
    const preset = PRESETS.find((p) => p.id === id);
    const existing = cfg.providers.find((p) => p.id === id);
    let baseURL = existing?.baseURL || preset.baseURL;
    if (!preset.baseURL) {
      baseURL = await askText('Base URL for the custom OpenAI-compatible endpoint:', { initial: baseURL || '' });
      if (baseURL === null) return cancelled();
      baseURL = baseURL.trim().replace(/\/+$/, '');
      if (!baseURL) { console.log(c.red('  ✗ A base URL is required for a custom provider.')); return cancelled(); }
    }
    // A custom endpoint is labelled by its host ("Custom · api.example.com").
    const label = preset.baseURL ? preset.label : 'Custom · ' + (baseURL.replace(/^\w+:\/\//, '').split('/')[0] || 'endpoint');
    const conn = { id, label, baseURL, kind: preset.kind };
    console.log('\n  ' + c.gold(glyph.spark + ' ' + label));
    const got = await connectProvider(conn, existing);
    if (!got) return cancelled();
    providers.push({ ...conn, apiKey: got.apiKey, models: got.models, modelsAt: Date.now() });
  }

  // 3 — default model across every selected provider
  const items = [];
  for (const p of providers) {
    for (const m of p.models) items.push({ label: m, desc: p.label, value: choiceKey({ kind: 'provider', providerId: p.id, model: m }) });
  }
  items.push({ label: '✎ Enter a model id manually…', desc: '', value: '__manual__' });
  const current = cfg.provider ? choiceKey({ kind: 'provider', providerId: cfg.provider.id, model: cfg.provider.model }) : null;
  let picked = await pickList({
    title: 'Default model', subtitle: (items.length - 1) + ' available', items, filter: true,
    initial: items.some((it) => it.value === current) ? current : 0,
  });
  if (picked === null) return cancelled();
  let active;
  if (picked === '__manual__') {
    const pid = providers.length === 1 ? providers[0].id
      : await pickList({ title: 'Provider for this model', items: providers.map((p) => ({ label: p.label, value: p.id })) });
    if (pid === null) return cancelled();
    const preset = PRESETS.find((p) => p.id === pid);
    const model = await askText('Model id:', { initial: preset?.defaultModel || '' });
    if (!model) return cancelled();
    active = { providerId: pid, model: model.trim() };
  } else {
    const ch = parseChoice(picked);
    active = { providerId: ch.providerId, model: ch.model };
  }
  const activeProvider = providers.find((p) => p.id === active.providerId);
  const { models: _m, modelsAt: _t, ...activeConn } = activeProvider;

  // 4 — search
  const searchId = await pickList({
    title: 'Search provider', filter: false,
    items: SEARCH_PROVIDERS.map((s) => ({ label: s.title, value: s.id })),
    initial: cfg.search?.id || 'none',
  });
  if (searchId === null) return cancelled();

  // 5 — images (optional)
  let imageModel = null;
  const wantImages = await askConfirm('Enable image generation?', { initial: !!cfg.imageModel });
  if (wantImages === null) return cancelled();
  if (wantImages) {
    const pid = providers.length === 1 ? providers[0].id
      : await pickList({ title: 'Image provider', items: providers.map((p) => ({ label: p.label, value: p.id })), initial: cfg.imageModel?.provider || active.providerId });
    if (pid === null) return cancelled();
    const m = await askText('Image model id:', { initial: cfg.imageModel?.model || 'gpt-image-1' });
    if (m === null) return cancelled();
    imageModel = { provider: pid, model: m.trim() || 'gpt-image-1' };
  }

  // Save everything at once.
  config.write({
    providers,
    provider: { ...activeConn, model: active.model },
    search: { id: searchId, apiKey: null },
    imageModel,
    // Speculative routing must point at a provider that is still configured.
    routing: cfg.routing?.small && !providers.some((p) => p.id === cfg.routing.small.providerId) ? null : cfg.routing,
    onboarded: true,
  });
  console.log('\n' + c.green('  ' + glyph.ok + ' 700 AI is configured.')
    + c.dim('  ' + providers.length + ' provider' + (providers.length === 1 ? '' : 's') + ' · default model ')
    + c.white(active.model) + '\n');
  return true;
}

function cancelled() {
  console.log(c.dim('\n  Setup cancelled — nothing was saved.\n'));
  return false;
}
