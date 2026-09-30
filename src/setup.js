// `700 setup` — guided onboarding: API provider, model, search, image model.
import prompts from 'prompts';
import readline from 'readline';
import { c, brand } from './theme.js';
import { config } from './store.js';
import { PRESETS, listModels } from './providers.js';
import { classify, diagnostic, renderDiagnostic } from './pipeline/diagnostics.js';

export const SEARCH_PROVIDERS = [
  { id: 'none', title: 'None / skip', needsKey: false },
  { id: 'duckduckgo', title: 'DuckDuckGo  (no key, limited)', needsKey: false },
];

const cancel = { onCancel: () => process.exit(0) };

// Raw-mode masked reader: echoes one '*' per typed character (pastes arrive as
// regular keypress events, so they mask too), backspace edits, Enter submits.
// Resolves with the entered string; Esc resolves null (cancel). Falls back to
// an invisible prompts read when stdin is not a TTY (piped/scripted input).
export function maskedInput(message, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) {
    return prompts({ type: 'invisible', name: 'v', message }).then((r) => (r?.v ?? ''));
  }
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
    input.on('keypress', onKey);
  });
}

// Fetch the provider's live model list and let the user pick one. Falls back to
// manual text entry if the list can't be fetched or comes back empty.
export async function chooseModel(provider, current) {
  process.stdout.write(c.dim('\n  fetching models from ' + (provider.label || provider.id || 'provider') + '…') + '\n');
  let models;
  try {
    models = await listModels(provider);
  } catch (e) {
    const r = await prompts({ type: 'text', name: 'model', message: `Couldn't fetch models (${e.message}). Enter model id:`, initial: current });
    return r.model || current;
  }
  if (!models.length) {
    const r = await prompts({ type: 'text', name: 'model', message: 'No models returned. Enter model id:', initial: current });
    return r.model || current;
  }
  models.sort();
  const r = await prompts({
    type: 'autocomplete',
    name: 'model',
    message: `Select a model — ${models.length} available (type to filter)`,
    choices: models.map((m) => ({ title: m, value: m })),
  });
  return r.model || current;
}

export async function runSetup() {
  console.log('\n' + brand('  700 AI — Guided Setup') + '\n');
  console.log(c.dim('  Nothing you enter here leaves your machine. Keys are stored in ~/.700ai\n'));

  // 1. Provider
  const { presetId } = await prompts({
    type: 'select',
    name: 'presetId',
    message: 'Which API provider do you want to use?',
    choices: PRESETS.map((p) => ({ title: p.label, value: p.id })),
  }, cancel);
  const preset = PRESETS.find((p) => p.id === presetId);

  let baseURL = preset.baseURL;
  if (!baseURL) {
    const r = await prompts({ type: 'text', name: 'url', message: 'Base URL (OpenAI-compatible):' }, cancel);
    baseURL = r.url;
  }

  // API key — masked entry ('*' per keystroke), required for hosted providers,
  // and verified against the live provider BEFORE anything is saved. (The old
  // `apiKey || 'ollama'` fallback stored a bogus placeholder key for hosted
  // providers, so every chat request failed auth; hosted keys must be real.)
  let apiKey = 'ollama';
  if (preset.id !== 'ollama') {
    for (;;) {
      const entered = await maskedInput(`Paste your ${preset.label} API key:`);
      if (entered === null) { console.log(c.dim('\n  Setup cancelled.\n')); return; }
      const key = (entered || '').trim();
      if (!key) {
        console.log(c.red('  ✗ A key is required for ' + preset.label + '.') + c.dim('  Paste it, or press Esc to cancel.\n'));
        continue;
      }
      const probe = { id: preset.id, label: preset.label, baseURL, kind: preset.kind, apiKey: key };
      console.log(c.dim('\n  verifying key with ' + preset.label + '…'));
      try {
        await listModels(probe);
        apiKey = key;
        console.log(c.green('  ✓ Key accepted — ' + preset.label + ' responded.') + '\n');
        break;
      } catch (e) {
        const cls = classify(e) || {};
        if (cls.code === 'AUTH') {
          console.log('\n' + renderDiagnostic(diagnostic('AUTH', { baseURL })) + '\n');
          continue; // bad key — ask again
        }
        // Network/provider outage: verification couldn't run. Let them keep it.
        console.log('\n' + renderDiagnostic(diagnostic('NETWORK', { baseURL })) + '\n');
        const { keep } = await prompts({ type: 'confirm', name: 'keep', message: 'Key could not be verified right now — use it anyway?', initial: true }, cancel);
        if (keep) { apiKey = key; break; }
      }
    }
  }

  const model = await chooseModel(
    { id: preset.id, label: preset.label, baseURL, kind: preset.kind, apiKey },
    preset.defaultModel,
  );

  config.write({
    provider: { id: preset.id, label: preset.label, baseURL, kind: preset.kind, apiKey, model },
  });

  // 2. Search provider
  const { searchId } = await prompts({
    type: 'select',
    name: 'searchId',
    message: 'Which search provider should skills use?',
    choices: SEARCH_PROVIDERS.map((s) => ({ title: s.title, value: s.id })),
  }, cancel);
  const search = SEARCH_PROVIDERS.find((s) => s.id === searchId);
  let searchKey = null;
  if (search.needsKey) {
    const entered = await maskedInput(`${search.title.split('  ')[0]} API key:`);
    searchKey = entered === null ? null : ((entered || '').trim() || null);
  }
  config.write({ search: { id: searchId, apiKey: searchKey } });

  // 3. Image model (optional)
  const { wantImages } = await prompts({
    type: 'confirm', name: 'wantImages', message: 'Enable image generation?', initial: true,
  }, cancel);
  if (wantImages) {
    const r = await prompts([
      { type: 'text', name: 'imgModel', message: 'Image model id:', initial: 'gpt-image-1' },
    ], cancel);
    config.write({ imageModel: { provider: preset.id, model: r.imgModel } });
  }

  config.write({ onboarded: true });
  console.log('\n' + c.green('  ✓ 700 AI is configured.') + c.dim('  Run ') + c.white('700') + c.dim(' to start chatting.\n'));
}
