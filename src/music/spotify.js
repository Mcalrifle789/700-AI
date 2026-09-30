// Spotify provider for 700 AI.
// Uses the Spotify Web API with OAuth 2.0 (Authorization Code flow). Playback is
// controlled on whatever Spotify device is already active (desktop app / phone /
// web player) — the Web API cannot stream audio itself, and play/pause/next
// require a Spotify **Premium** account. Nothing is stored but on this machine.
import http from 'http';
import { URL } from 'url';
import prompts from 'prompts';
import open from 'open';
import { c } from '../theme.js';
import { glyph } from '../ui.js';

const REDIRECT_PORT = 8700;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

const _tokenCache = new Map(); // refreshToken -> { access, exp }

export const label = 'Spotify';
export const redirectUri = REDIRECT_URI;

// One-time interactive connect: collect the developer app credentials, run the
// browser auth handshake, and return { clientId, clientSecret, refreshToken }.
export async function connect() {
  console.log('\n' + c.gold('  ' + glyph.spark + ' Connect Spotify') + '\n');
  console.log(c.dim('  1. Create an app at ') + c.white('https://developer.spotify.com/dashboard'));
  console.log(c.dim('  2. In its settings, add this Redirect URI:'));
  console.log('     ' + c.white(REDIRECT_URI));
  console.log(c.dim('  3. Copy the Client ID and Client Secret below.') + '\n');
  console.log(c.dim('  Note: playback control (') + c.white('/play') + c.dim(') needs Spotify ')
    + c.white('Premium') + c.dim(' and an open Spotify app to play into.\n'));

  const { clientId } = await prompts({ type: 'text', name: 'clientId', message: 'Spotify Client ID:' });
  if (!clientId) return null;
  const { clientSecret } = await prompts({ type: 'password', name: 'clientSecret', message: 'Spotify Client Secret:' });
  if (!clientSecret) return null;

  const state = Math.random().toString(36).slice(2);
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state,
  });

  const code = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== '/callback') { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<body style="font-family:system-ui;background:#0a0a0a;color:#e8e6e3;display:grid;place-items:center;height:100vh"><h2>700 AI &times; Spotify connected. You can close this tab.</h2></body>');
      server.close();
      if (u.searchParams.get('state') !== state) return resolve(null);
      resolve(u.searchParams.get('code'));
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
      console.log(c.dim('\n  Opening Spotify authorization in your browser…\n'));
      try { await open(authUrl); } catch { console.log(c.dim('  Open this URL:\n  ') + c.white(authUrl)); }
    });
    server.on('error', () => resolve(null));
  });
  if (!code) { console.log(c.red('  Authorization cancelled.')); return null; }

  const tok = await tokenRequest(clientId, clientSecret, {
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
  });
  if (!tok.refresh_token) { console.log(c.red('  Token exchange failed.')); return null; }
  return { clientId, clientSecret, refreshToken: tok.refresh_token };
}

async function tokenRequest(clientId, clientSecret, body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Spotify auth ${res.status}: ${await res.text()}`);
  return res.json();
}

async function accessToken(creds) {
  const cached = _tokenCache.get(creds.refreshToken);
  if (cached && cached.exp > Date.now() + 5000) return cached.access;
  const tok = await tokenRequest(creds.clientId, creds.clientSecret, {
    grant_type: 'refresh_token', refresh_token: creds.refreshToken,
  });
  const access = tok.access_token;
  _tokenCache.set(creds.refreshToken, { access, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  return access;
}

async function api(creds, path, { method = 'GET', body } = {}) {
  const token = await accessToken(creds);
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;              // no content (playback ok)
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message || text || res.status;
    const err = new Error(`Spotify ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function search(creds, query, type = 'track') {
  const q = new URLSearchParams({ q: query, type, limit: '10' });
  const r = await api(creds, '/search?' + q);
  if (type === 'track') return (r.tracks?.items || []).map((t) => ({
    uri: t.uri, name: t.name, artist: (t.artists || []).map((a) => a.name).join(', '),
  }));
  if (type === 'playlist') return (r.playlists?.items || []).map((p) => ({ uri: p.uri, name: p.name }));
  return [];
}

export async function listPlaylists(creds) {
  const r = await api(creds, '/me/playlists?limit=50');
  return (r.items || []).map((p) => ({ uri: p.uri, name: p.name, tracks: p.tracks?.total ?? 0 }));
}

// Start playback on the active device. `uri` for a single track, `contextUri`
// for a playlist/album. Surfaces a friendly error when no device is active.
export async function play(creds, { uri, contextUri } = {}) {
  const body = contextUri ? { context_uri: contextUri } : uri ? { uris: [uri] } : undefined;
  try {
    await api(creds, '/me/player/play', { method: 'PUT', body });
  } catch (e) {
    if (e.status === 404) throw new Error('No active Spotify device. Open Spotify on any device and press play once, then try again.');
    if (e.status === 403) throw new Error('Playback control needs Spotify Premium.');
    throw e;
  }
}

export async function pause(creds) { return api(creds, '/me/player/pause', { method: 'PUT' }); }
export async function next(creds) { return api(creds, '/me/player/next', { method: 'POST' }); }
export async function prev(creds) { return api(creds, '/me/player/previous', { method: 'POST' }); }

export async function nowPlaying(creds) {
  const r = await api(creds, '/me/player/currently-playing');
  if (!r || !r.item) return null;
  return { name: r.item.name, artist: (r.item.artists || []).map((a) => a.name).join(', '), playing: r.is_playing };
}
