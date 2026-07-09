// Local persistent store for 700 AI.
// Everything lives under ~/.700ai — keys never leave the machine.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const HOME = path.join(os.homedir(), '.700ai');
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
  provider: null,        // { id, label, baseURL, apiKey, model }
  imageModel: null,      // { provider, model }
  search: null,          // { id, apiKey }
  onboarded: false,
};

export const config = {
  read: () => ({ ...defaultConfig, ...readJSON(CONFIG, {}) }),
  write: (patch) => {
    const next = { ...config.read(), ...patch };
    writeJSON(CONFIG, next);
    return next;
  },
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
