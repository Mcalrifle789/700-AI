// `700 setup` — guided onboarding: API provider, model, search, image model.
import prompts from 'prompts';
import { c, brand } from './theme.js';
import { config } from './store.js';
import { PRESETS } from './providers.js';

export const SEARCH_PROVIDERS = [
  { id: 'none', title: 'None / skip', needsKey: false },
  { id: 'duckduckgo', title: 'DuckDuckGo  (no key, limited)', needsKey: false },
];

const cancel = { onCancel: () => process.exit(0) };

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

  const { apiKey } = await prompts({
    type: preset.id === 'ollama' ? null : 'password',
    name: 'apiKey',
    message: `Paste your ${preset.label} API key:`,
  }, cancel);

  const { model } = await prompts({
    type: 'text',
    name: 'model',
    message: 'Model id:',
    initial: preset.defaultModel,
  }, cancel);

  config.write({
    provider: { id: preset.id, label: preset.label, baseURL, kind: preset.kind, apiKey: apiKey || 'ollama', model },
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
    const r = await prompts({ type: 'password', name: 'k', message: `${search.title.split('  ')[0]} API key:` }, cancel);
    searchKey = r.k;
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
