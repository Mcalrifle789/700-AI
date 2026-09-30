// Music subsystem for 700 AI — a thin provider-agnostic layer over Spotify and
// Apple Music. Handles the /music, /play, /playlists, /pause, /next commands.
import prompts from 'prompts';
import { c } from '../theme.js';
import { glyph } from '../ui.js';
import { config } from '../store.js';
import * as spotify from './spotify.js';
import * as apple from './apple.js';

const PROVIDERS = { spotify, apple };

function activeProvider() {
  const m = config.read().music;
  if (!m || !m.provider) return null;
  const mod = PROVIDERS[m.provider];
  if (!mod || !m[m.provider]) return null;
  return { id: m.provider, mod, creds: m[m.provider] };
}

function needConnect() {
  console.log('\n  ' + c.orange(glyph.warn + ' No music service connected.') + c.dim(' Run ') + c.white('/music') + c.dim(' first.\n'));
}

// /music — choose and connect a provider.
export async function connectMusic() {
  console.log('\n' + c.gold('  ' + glyph.spark + ' 700 AI — Music') + '\n');
  const active = activeProvider();
  if (active) console.log(c.dim('  Currently connected: ') + c.white(active.mod.label) + '\n');
  const { provider } = await prompts({
    type: 'select', name: 'provider', message: 'Connect a music service',
    choices: [
      { title: 'Spotify  ' + c.dim('(play/pause/next, playlists — needs Premium)'), value: 'spotify' },
      { title: 'Apple Music  ' + c.dim('(catalog search + open-in-app)'), value: 'apple' },
    ],
  });
  if (!provider) return;
  let creds;
  try { creds = await PROVIDERS[provider].connect(); } catch (e) { console.log(c.red('  ' + e.message)); return; }
  if (!creds) { console.log(c.dim('  Cancelled.\n')); return; }
  const m = config.read().music || {};
  m.provider = provider;
  m[provider] = creds;
  config.write({ music: m });
  console.log('\n  ' + c.green(glyph.ok + ' ' + PROVIDERS[provider].label + ' connected.')
    + c.dim('  Try ') + c.white('/play') + c.dim(' or ') + c.white('/playlists') + c.dim('.\n'));
}

async function pick(items, message) {
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  const { i } = await prompts({
    type: 'select', name: 'i', message,
    choices: items.map((it, idx) => ({
      title: it.artist ? `${it.name} — ${it.artist}` : it.name, value: idx,
    })),
  });
  return i == null ? null : items[i];
}

// /play [song or playlist]
export async function doPlay(arg) {
  const active = activeProvider();
  if (!active) return needConnect();
  const query = arg || (await prompts({ type: 'text', name: 'q', message: 'Play what?' })).q;
  if (!query) return;
  const { id, mod, creds } = active;

  try {
    if (id === 'spotify') {
      let tracks = await mod.search(creds, query, 'track');
      if (tracks.length) {
        const chosen = await pick(tracks, 'Play which track?');
        if (!chosen) return;
        await mod.play(creds, { uri: chosen.uri });
        console.log('\n  ' + c.green(glyph.ok + ' Playing ') + c.white(chosen.name) + c.dim(' — ' + chosen.artist) + '\n');
        return;
      }
      // fall back to a playlist match
      const pls = await mod.search(creds, query, 'playlist');
      const pl = await pick(pls, 'Play which playlist?');
      if (!pl) { console.log(c.dim('\n  Nothing found for “' + query + '”.\n')); return; }
      await mod.play(creds, { contextUri: pl.uri });
      console.log('\n  ' + c.green(glyph.ok + ' Playing playlist ') + c.white(pl.name) + '\n');
      return;
    }
    // Apple Music: search catalog and open the track in the app/web player.
    const songs = await mod.search(creds, query, 'songs');
    const chosen = await pick(songs, 'Open which track in Apple Music?');
    if (!chosen) { console.log(c.dim('\n  Nothing found for “' + query + '”.\n')); return; }
    await mod.play(creds, { url: chosen.url });
    console.log('\n  ' + c.green(glyph.ok + ' Opening in Apple Music: ') + c.white(chosen.name) + c.dim(' — ' + chosen.artist) + '\n');
  } catch (e) {
    console.log('\n  ' + c.red(glyph.err + ' ' + e.message) + '\n');
  }
}

// /playlists — list and switch playlists.
export async function doPlaylists() {
  const active = activeProvider();
  if (!active) return needConnect();
  const { mod, creds } = active;
  try {
    const pls = await mod.listPlaylists(creds);
    if (!pls.length) { console.log(c.dim('\n  No playlists found.\n')); return; }
    const chosen = await pick(pls.map((p) => ({ name: `${p.name}  (${p.tracks} tracks)`, uri: p.uri })), 'Switch to playlist');
    if (!chosen) return;
    await mod.play(creds, { contextUri: chosen.uri });
    console.log('\n  ' + c.green(glyph.ok + ' Playing playlist.') + '\n');
  } catch (e) {
    console.log('\n  ' + c.red(glyph.err + ' ' + e.message) + '\n');
  }
}

async function control(action, verb) {
  const active = activeProvider();
  if (!active) return needConnect();
  try {
    await active.mod[action](active.creds);
    console.log('\n  ' + c.green(glyph.ok + ' ' + verb) + '\n');
  } catch (e) {
    console.log('\n  ' + c.red(glyph.err + ' ' + e.message) + '\n');
  }
}

export const doPause = () => control('pause', 'Paused.');
export const doNext = () => control('next', 'Skipped to next.');
export const doPrev = () => control('prev', 'Back to previous.');

export async function doNowPlaying() {
  const active = activeProvider();
  if (!active) return needConnect();
  try {
    const np = await active.mod.nowPlaying(active.creds);
    if (!np) { console.log(c.dim('\n  Nothing playing.\n')); return; }
    console.log('\n  ' + c.gold(glyph.spark + ' ') + c.white(np.name) + c.dim(' — ' + np.artist)
      + (np.playing ? '' : c.dim('  (paused)')) + '\n');
  } catch (e) {
    console.log('\n  ' + c.red(glyph.err + ' ' + e.message) + '\n');
  }
}
