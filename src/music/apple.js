// Apple Music provider for 700 AI.
//
// What works from a terminal:
//   • Catalog search (songs/albums/playlists) using an Apple **developer token**
//     (a JWT signed with your MusicKit .p8 key), and opening a track in the
//     Apple Music app/web to play it.
//
// What is NOT possible from a terminal (and why):
//   • Your personal iCloud Music Library and native in-app playback require a
//     **Music User Token**, which Apple only issues through MusicKit running in a
//     browser or on an Apple device (user sign-in). There is no headless/Windows
//     way to obtain it, so `/playlists` (your library) is unavailable here.
import crypto from 'crypto';
import fs from 'fs';
import prompts from 'prompts';
import open from 'open';
import { c } from '../theme.js';
import { glyph } from '../ui.js';

export const label = 'Apple Music';

const _tokenCache = new Map(); // keyId -> { token, exp }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Sign an Apple Music developer token (ES256 JWT). Cached until near expiry.
function signDeveloperToken({ teamId, keyId, privateKey }) {
  const cached = _tokenCache.get(keyId);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 24 * 180; // Apple caps developer tokens at 180 days
  const payload = { iss: teamId, iat: now, exp };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const token = data + '.' + b64url(sig);
  _tokenCache.set(keyId, { token, exp: exp * 1000 });
  return token;
}

function developerToken(creds) {
  if (creds.teamId && creds.keyId && creds.privateKey) return signDeveloperToken(creds);
  if (creds.devToken) return creds.devToken;
  throw new Error('Apple Music is not fully configured — run /music to reconnect.');
}

export async function connect() {
  console.log('\n' + c.gold('  ' + glyph.spark + ' Connect Apple Music') + '\n');
  console.log(c.dim('  Requires an Apple Developer account with a MusicKit key.'));
  console.log(c.dim('  Create one at ') + c.white('https://developer.apple.com/account') + c.dim(' → Keys → MusicKit.') + '\n');
  console.log(c.orange('  ' + glyph.warn + ' Heads-up: ') + c.dim('a terminal can only do catalog search + open-in-app.'));
  console.log(c.dim('  Your personal iCloud library and native playback need MusicKit'));
  console.log(c.dim('  (browser/Apple device), so /playlists (your library) is unavailable here.') + '\n');

  const { how } = await prompts({
    type: 'select', name: 'how', message: 'How do you want to provide the developer token?',
    choices: [
      { title: 'From my MusicKit key (Team ID + Key ID + .p8)', value: 'key' },
      { title: 'Paste a developer token I already generated', value: 'token' },
    ],
  });
  if (!how) return null;

  const { storefront } = await prompts({ type: 'text', name: 'storefront', message: 'Storefront (2-letter, e.g. us):', initial: 'us' });
  const sf = (storefront || 'us').toLowerCase();

  if (how === 'token') {
    const { devToken } = await prompts({ type: 'password', name: 'devToken', message: 'Paste your Apple Music developer token (JWT):' });
    if (!devToken) return null;
    return { storefront: sf, devToken };
  }

  const { teamId } = await prompts({ type: 'text', name: 'teamId', message: 'Apple Team ID (10 chars):' });
  const { keyId } = await prompts({ type: 'text', name: 'keyId', message: 'MusicKit Key ID (10 chars):' });
  const { p8path } = await prompts({ type: 'text', name: 'p8path', message: 'Path to your AuthKey_XXXX.p8 file:' });
  if (!teamId || !keyId || !p8path) return null;
  let privateKey;
  try {
    privateKey = fs.readFileSync(p8path.replace(/^["']|["']$/g, '').trim(), 'utf8');
  } catch (e) {
    console.log(c.red('  Could not read .p8 file: ') + c.dim(e.message));
    return null;
  }
  const creds = { storefront: sf, teamId, keyId, privateKey };
  try { signDeveloperToken(creds); } catch (e) {
    console.log(c.red('  That key could not sign a token: ') + c.dim(e.message));
    return null;
  }
  return creds;
}

async function api(creds, path) {
  const token = developerToken(creds);
  const res = await fetch('https://api.music.apple.com' + path, { headers: { Authorization: 'Bearer ' + token } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Apple Music ${res.status}: ${json?.errors?.[0]?.detail || text}`);
  return json;
}

export async function search(creds, query, kind = 'songs') {
  const sf = creds.storefront || 'us';
  const q = new URLSearchParams({ term: query, types: kind, limit: '10' });
  const r = await api(creds, `/v1/catalog/${sf}/search?` + q);
  const items = r.results?.[kind]?.data || [];
  if (kind === 'songs') return items.map((s) => ({
    id: s.id, name: s.attributes?.name, artist: s.attributes?.artistName, url: s.attributes?.url,
  }));
  return items.map((s) => ({ id: s.id, name: s.attributes?.name, url: s.attributes?.url }));
}

// "Playback" from a terminal = open the track in the Apple Music app/web player.
export async function play(creds, { url } = {}) {
  if (!url) throw new Error('No track URL to open.');
  await open(url);
}

// Personal library / playlists are not reachable without a Music User Token.
export async function listPlaylists() {
  throw new Error('Your Apple Music library needs MusicKit (browser/Apple device) sign-in, which a terminal can\'t do. Use Spotify for /playlists, or connect Spotify.');
}

export async function pause() { throw new Error('Apple Music playback control isn\'t available from a terminal.'); }
export async function next() { throw new Error('Apple Music playback control isn\'t available from a terminal.'); }
export async function prev() { throw new Error('Apple Music playback control isn\'t available from a terminal.'); }
export async function nowPlaying() { return null; }
