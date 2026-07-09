// Plugin system for 700 AI.
// Plugins are proprietary and distributed from the 700 AI GitHub store.
// Paid plugins require a license key (validated locally + against the store).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { c } from './theme.js';
import { licenses } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, '..', 'plugins');

// The official store catalog. In production this is fetched from the
// 700 AI GitHub Pages catalog; bundled here as the source of truth.
export const STORE = [
  { id: 'music-player', name: 'Music Player', price: 3.0, desc: 'A visual music player inside 700 AI.' },
  { id: 'elevenlabs', name: 'ElevenLabs Voice', price: 0.0, desc: 'Text-to-speech with your ElevenLabs API key.' },
  { id: 'privacy', name: 'Universal Privacy', price: 1.55, desc: 'Local-only redaction & telemetry lockdown.' },
  { id: 'app-connect-100', name: '100+ App Connections', price: 20.0, taxed: true, desc: 'Connect 100+ apps & services to 700 AI.' },
];

export function priceLabel(item) {
  if (item.price === 0) return c.green('free');
  const base = `$${item.price.toFixed(2)}`;
  return item.taxed ? c.gold(base) + c.dim(' + tax') : c.gold(base);
}

// Load every installed + licensed plugin. Returns extra skills they register.
export async function loadPlugins(ctx) {
  const extraSkills = [];
  if (!fs.existsSync(PLUGIN_DIR)) return extraSkills;
  for (const dir of fs.readdirSync(PLUGIN_DIR)) {
    const manifestPath = path.join(PLUGIN_DIR, dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    // Paid plugins must be licensed to load.
    if (manifest.price > 0 && !licenses.has(manifest.id)) continue;
    try {
      const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, dir, manifest.entry || 'index.js')).href);
      if (typeof mod.register === 'function') {
        const skills = (await mod.register(ctx)) || [];
        for (const s of skills) extraSkills.push({ ...s, plugin: manifest.id });
      }
    } catch (e) {
      console.log(c.red(`  plugin ${manifest.id} failed to load: `) + c.dim(e.message));
    }
  }
  return extraSkills;
}

// Simulated purchase → license grant. Real checkout is a Stripe/Gumroad
// link on the store page; this activates the returned license key locally
// and records the sale into the private wallet.
export async function installPlugin(id, key) {
  const item = STORE.find((s) => s.id === id);
  if (!item) throw new Error(`Unknown plugin: ${id}`);
  licenses.grant(id, key || `LOCAL-${Date.now()}`);
  return item;
}
