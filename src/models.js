// Model catalog — every model 700 AI can talk to, across all configured
// providers (live-discovered with the user's own keys) plus user-added custom
// models (/models). /model, /route and setup all pick from this one list, and
// resolve() turns a choice into a ready-to-call provider object.
import { config } from './store.js';
import { discoverModels, requiresKey } from './providers.js';

const STALE_MS = 6 * 60 * 60 * 1000; // re-discover a provider's list after 6 h

// A choice is { kind: 'provider', providerId, model } or { kind: 'custom', name }.
// Encoded as a string so pickers can use it as a value.
export const choiceKey = (ch) => (ch.kind === 'custom' ? 'custom:' + ch.name : `p:${ch.providerId}:${ch.model}`);
export function parseChoice(key) {
  if (key.startsWith('custom:')) return { kind: 'custom', name: key.slice(7) };
  const [, providerId, ...rest] = key.split(':');
  return { kind: 'provider', providerId, model: rest.join(':') };
}

// Refresh model lists for every configured provider in parallel (or only stale
// ones unless force). Persists the lists so the next /model is instant.
// Returns { [providerId]: error|null }.
export async function refreshModels({ force = false } = {}) {
  const cfg = config.read();
  const due = cfg.providers.filter((p) => (force || !p.models || Date.now() - (p.modelsAt || 0) > STALE_MS)
    && (!requiresKey(p) || p.apiKey));
  if (!due.length) return {};
  const found = await discoverModels(due);
  const errors = {};
  const latest = config.read(); // re-read: setup may have written meanwhile
  const providers = latest.providers.map((p) => {
    const r = found[p.id];
    if (!r) return p;
    errors[p.id] = r.error;
    return r.models ? { ...p, models: r.models, modelsAt: Date.now() } : p;
  });
  config.write({ providers });
  return errors;
}

// Flat list of every selectable model, for pickers.
export function catalog(cfg = config.read()) {
  const items = [];
  for (const p of cfg.providers) {
    for (const m of p.models || []) items.push({ kind: 'provider', providerId: p.id, providerLabel: p.label, model: m });
  }
  for (const cm of cfg.customModels) items.push({ kind: 'custom', name: cm.name, model: cm.model, providerLabel: 'custom' });
  return items;
}

// Turn a choice into the provider object chatStream needs.
export function resolve(choice, cfg = config.read()) {
  if (!choice) return null;
  if (choice.kind === 'custom') {
    const cm = cfg.customModels.find((m) => m.name === choice.name);
    if (!cm) return null;
    const base = cm.providerId ? config.provider(cm.providerId, cfg) : null;
    return {
      id: 'custom:' + cm.name, label: cm.name,
      baseURL: cm.baseURL || base?.baseURL, kind: cm.kind || base?.kind || 'openai',
      apiKey: cm.apiKey || base?.apiKey, model: cm.model,
    };
  }
  const p = config.provider(choice.providerId, cfg);
  if (!p) return null;
  const { models, modelsAt, ...conn } = p;
  return { ...conn, model: choice.model };
}

// The default (setup-chosen) model as a choice.
export function defaultChoice(cfg = config.read()) {
  return cfg.provider ? { kind: 'provider', providerId: cfg.provider.id, model: cfg.provider.model } : null;
}

// Human label for a choice: "model · Provider".
export function describe(choice, cfg = config.read()) {
  if (!choice) return 'not configured';
  if (choice.kind === 'custom') return choice.name + ' · custom';
  return choice.model + ' · ' + (config.provider(choice.providerId, cfg)?.label || choice.providerId);
}
