// Retrieval-augmented caching (spec 2.2 — "Local storage caches ... to avoid
// redundant remote/processing"). Here it caches completed intake records so a
// file that has not changed on disk is never re-hashed or re-parsed: the cache
// key is path + size + mtime, and a hit returns the stored record instantly.
//
// Backed by a single JSON file under ~/.700ai (no native SQLite dependency, so
// it runs anywhere Node does). Bounded to MAX_ENTRIES, evicting least-recently
// used records.
import fs from 'fs';
import path from 'path';
import { HOME } from '../store.js';

const CACHE_FILE = path.join(HOME, 'intake-cache.json');
const MAX_ENTRIES = 256;

function load() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { v: 1, entries: {} }; }
}

function save(db) {
  try {
    if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(db), { mode: 0o600 });
  } catch { /* cache is best-effort; never fail the pipeline over it */ }
}

const keyFor = (rec) => `${rec.path}:${rec.size}:${Math.round(rec.mtimeMs)}`;
const keyForStat = (absPath, size, mtimeMs) => `${absPath}:${size}:${Math.round(mtimeMs)}`;

// Returns the cached record for a file whose stat matches, or null.
export function getCached(absPath, size, mtimeMs) {
  const db = load();
  const hit = db.entries[keyForStat(absPath, size, mtimeMs)];
  if (!hit) return null;
  hit.usedAt = Date.now();
  save(db);
  return { ...hit.record, cached: true };
}

// Store a completed intake record.
export function putCached(record) {
  const db = load();
  db.entries[keyFor(record)] = { record, usedAt: Date.now() };
  const keys = Object.keys(db.entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (db.entries[a].usedAt || 0) - (db.entries[b].usedAt || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete db.entries[k];
  }
  save(db);
}

export function clearCache() {
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* ignore */ }
}
