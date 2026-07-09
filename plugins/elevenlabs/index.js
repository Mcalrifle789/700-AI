// ElevenLabs Voice plugin for 700 AI.
// Registers the `/voice` skill: synthesizes text with the ElevenLabs
// text-to-speech API and plays the resulting audio via the system player.
//
// Key resolution order:
//   1. ELEVENLABS_API_KEY env var (never persisted)
//   2. elevenlabs.apiKey in ~/.700ai/config.json
//   3. interactive prompt (persisted to config for next time)
import fs from 'fs';
import os from 'os';
import path from 'path';
import prompts from 'prompts';
import open from 'open';

const API = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — a built-in ElevenLabs voice
const DEFAULT_MODEL = 'eleven_multilingual_v2';

export async function register(ctx) {
  const { config, say } = ctx;

  return [
    {
      name: 'voice',
      kind: 'action',
      group: 'create',
      desc: 'Speak text aloud with ElevenLabs',
      async run(arg) {
        const key = await resolveKey(config, say);
        if (!key) return;

        const cfg = config.read();
        const voiceId = cfg.elevenlabs?.voiceId || DEFAULT_VOICE;

        const text = (arg || '').trim()
          || (await prompts({ type: 'text', name: 't', message: 'Text to speak:' })).t;
        if (!text) { say('  Nothing to speak.'); return; }

        say('  🔊 synthesizing…');
        try {
          const audio = await synthesize(key, voiceId, text);
          const file = path.join(os.tmpdir(), `700ai-voice-${Date.now()}.mp3`);
          fs.writeFileSync(file, audio);
          if (process.env.SEVENHUNDRED_VOICE_NO_PLAY === '1') {
            say('  ✓ audio saved (playback skipped): ' + file);
          } else {
            try { await open(file); } catch { /* headless / no player */ }
            say('  ✓ playing: ' + file);
          }
        } catch (e) {
          say('  voice failed: ' + e.message);
        }
      },
    },
  ];
}

// Resolve an API key without persisting env-provided keys.
async function resolveKey(config, say) {
  const envKey = process.env.ELEVENLABS_API_KEY;
  if (envKey) return envKey;

  const cfg = config.read();
  if (cfg.elevenlabs?.apiKey) return cfg.elevenlabs.apiKey;

  const { k } = await prompts({ type: 'password', name: 'k', message: 'ElevenLabs API key:' });
  if (!k) { say('  No ElevenLabs key — cancelled.'); return null; }
  config.write({ elevenlabs: { ...(cfg.elevenlabs || {}), apiKey: k, voiceId: cfg.elevenlabs?.voiceId || DEFAULT_VOICE } });
  return k;
}

// Call the ElevenLabs TTS endpoint and return the audio as a Buffer.
export async function synthesize(apiKey, voiceId, text) {
  const res = await fetch(`${API}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: DEFAULT_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
