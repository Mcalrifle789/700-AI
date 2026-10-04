// Session persistence for 700 AI (~/.700ai/sessions.json).
// Powers /new (create) and /session (switch). Keys/transcripts never leave
// the machine; the file is 0600 like the rest of the store.
import fs from 'fs';
import path from 'path';
import { HOME } from './store.js';

const FILE = path.join(HOME, 'sessions.json');

function ensureDir() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function write(all) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Save or update a session record: { id, title, at, history, staged }.
export function saveSession(sess) {
  if (!sess || !sess.id) return null;
  const all = read();
  const rec = { ...sess, at: new Date().toISOString() };
  const i = all.findIndex((s) => s.id === sess.id);
  if (i >= 0) all[i] = rec; else all.unshift(rec);
  write(all.slice(0, 100)); // keep the 100 most recent
  return rec;
}

export function listSessions() {
  return read().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

export function loadSession(id) {
  return read().find((s) => s.id === id) || null;
}

export function deleteSession(id) {
  write(read().filter((s) => s.id !== id));
}

export function newId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Short human title from the first user message.
export function titleFrom(history) {
  const first = (history || []).find((m) => m.role === 'user');
  const t = String((first && first.content) || 'empty session').replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
}