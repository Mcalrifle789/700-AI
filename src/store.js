// Local persistent store for 700 AI.
// Everything lives under ~/.700ai — keys never leave the machine.
import fs from 'fs';
import os from 'os';
import path from 'path';

// AI700_HOME overrides the data directory (tests, portable installs).
export const HOME = process.env.AI700_HOME || path.join(os.homedir(), '.700ai');
const CONFIG = path.join(HOME, 'config.json');
const WALLET = path.join(HOME, 'wallet.json');
const AGENTS = path.join(HOME, 'agents.json');
const LICENSES = path.join(HOME, 'licenses.json');

function ensure() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const defaultConfig = {
  provider: null,        // ACTIVE default: { id, label, baseURL, kind, apiKey, model }
  providers: [],         // every configured provider: { id, label, baseURL, kind, apiKey, models[], modelsAt }
  customModels: [],      // user-added models: { name, model, baseURL, kind, apiKey, providerId? }
  imageModel: null,      // { provider, model }
  search: null,          // { id, apiKey }
  music: null,           // { provider, spotify:{...}, apple:{...} }
  routing: null,         // { enabled, small: { providerId, model } } — speculative routing
  onboarded: false,
};

// Older configs held a single `provider`; lift it into `providers` so the rest
// of the app only ever deals with the multi-provider shape.
function normalize(raw) {
  const cfg = { ...defaultConfig, ...raw };
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  if (!Array.isArray(cfg.customModels)) cfg.customModels = [];
  if (cfg.provider && !cfg.providers.some((p) => p.id === cfg.provider.id)) {
    const { model, ...rest } = cfg.provider;
    cfg.providers = [...cfg.providers, rest];
  }
  if (cfg.routing && typeof cfg.routing.small === 'string') {
    cfg.routing = { ...cfg.routing, small: { providerId: cfg.provider?.id, model: cfg.routing.small } };
  }
  return cfg;
}

// Config is read on every turn; cache it in-process and re-read only when the
// file changes on disk (another 700 AI window, or a manual edit). Callers get
// a copy so mutating the result can never corrupt the cache.
let _cache = null;
let _cacheMtime = -1;
function loadConfig() {
  let mtime = -1;
  try { mtime = fs.statSync(CONFIG).mtimeMs; } catch { /* no config yet */ }
  if (!_cache || mtime !== _cacheMtime) {
    _cache = normalize(readJSON(CONFIG, {}));
    _cacheMtime = mtime;
  }
  return structuredClone(_cache);
}

export const config = {
  read: () => loadConfig(),
  write: (patch) => {
    const next = normalize({ ...loadConfig(), ...patch });
    writeJSON(CONFIG, next);
    _cache = next;
    try { _cacheMtime = fs.statSync(CONFIG).mtimeMs; } catch { _cacheMtime = -1; }
    return structuredClone(next);
  },
  // Look up a configured provider record by id (null if not configured).
  provider: (id, cfg = loadConfig()) => cfg.providers.find((p) => p.id === id) || null,
};

export const wallet = {
  read: () => readJSON(WALLET, { stripeKey: null, currency: 'usd', ledger: [] }),
  write: (patch) => {
    const next = { ...wallet.read(), ...patch };
    writeJSON(WALLET, next);
    return next;
  },
  record: (entry) => {
    const w = wallet.read();
    w.ledger.push({ ...entry, at: new Date().toISOString() });
    writeJSON(WALLET, w);
    return w;
  },
};

export const agents = {
  list: () => readJSON(AGENTS, []),
  save: (agent) => {
    const all = agents.list().filter((a) => a.name !== agent.name);
    all.push(agent);
    writeJSON(AGENTS, all);
    return all;
  },
};

export const licenses = {
  read: () => readJSON(LICENSES, {}),
  grant: (pluginId, key) => {
    const l = licenses.read();
    l[pluginId] = { key, activatedAt: new Date().toISOString() };
    writeJSON(LICENSES, l);
    return l;
  },
  has: (pluginId) => Boolean(licenses.read()[pluginId]),
};
