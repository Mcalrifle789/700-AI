// ffmpeg/ffprobe bridge for the audio + video legs of the ingestion pipeline
// (spec 2.1: "Frame extraction & waveform subsampling", "Keyframe sampling at
// 1 fps"). ffmpeg is an OPTIONAL system dependency: when it is missing the
// pipeline degrades to the native header parsers in this file and raises the
// FFMPEG_MISSING diagnostic instead of throwing a raw ENOENT.
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const run = (bin, args, { timeout = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });

// Cached availability probe — `which ffmpeg` equivalent, done once per process.
let _have = null;
export async function ffmpegAvailable() {
  if (_have) return _have;
  const probe = async (bin) => {
    try {
      await run(bin, ['-version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probe('ffmpeg'), probe('ffprobe')]);
  _have = { ffmpeg, ffprobe };
  return _have;
}

// Full stream/format dump for a media file.
export async function ffprobe(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return JSON.parse(out);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Parse an ffprobe rational ("30000/1001") into a number.
function rational(s) {
  if (!s) return null;
  const [a, b] = String(s).split('/').map(Number);
  if (!Number.isFinite(a)) return null;
  if (!b) return a;
  return b === 0 ? null : a / b;
}

// Audio metadata per the spec matrix: duration, channels, sample rate, codec.
export async function probeAudio(filePath) {
  const info = await ffprobe(filePath);
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw Object.assign(new Error('no audio stream found'), { code: 'NO_AUDIO_STREAM' });
  return {
    source: 'ffprobe',
    duration: num(info.format?.duration) ?? num(a.duration),
    channels: num(a.channels),
    channelLayout: a.channel_layout || null,
    sampleRate: num(a.sample_rate),
    codec: a.codec_name || null,
    bitRate: num(a.bit_rate) ?? num(info.format?.bit_rate),
    trackCount: (info.streams || []).length,
  };
}

// Video metadata per the spec matrix: fps, resolution, track count, duration.
export async function probeVideo(filePath) {
  const info = await ffprobe(filePath);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw Object.assign(new Error('no video stream found'), { code: 'NO_VIDEO_STREAM' });
  return {
    source: 'ffprobe',
    duration: num(info.format?.duration) ?? num(v.duration),
    fps: rational(v.avg_frame_rate) || rational(v.r_frame_rate),
    width: num(v.width),
    height: num(v.height),
    resolution: v.width && v.height ? `${v.width}x${v.height}` : null,
    codec: v.codec_name || null,
    trackCount: (info.streams || []).length,
    audioTracks: (info.streams || []).filter((s) => s.codec_type === 'audio').length,
    bitRate: num(info.format?.bit_rate),
  };
}

// Waveform subsampling: decode to mono 8-bit PCM at a low rate and reduce to
// `buckets` peak amplitudes. Gives the model a compact shape-of-the-audio
// summary without shipping the whole waveform.
export async function waveformPeaks(filePath, buckets = 64) {
  const rate = 1000;
  const out = await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-v', 'error', '-i', filePath,
      '-ac', '1', '-ar', String(rate), '-f', 'u8', '-',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true },
    (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  if (!out.length) return [];
  const per = Math.max(1, Math.floor(out.length / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const start = b * per;
    const end = Math.min(out.length, start + per);
    if (start >= out.length) break;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(out[i] - 128));
    peaks.push(Math.round((peak / 128) * 100) / 100);
  }
  return peaks;
}

// Keyframe sampling at 1 fps (spec 2.1). Writes JPEG frames into a temp dir and
// returns their paths, capped at `limit` so a 2-hour film doesn't fill the disk.
export async function sampleKeyframes(filePath, { fps = 1, limit = 8 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '700ai-frames-'));
  const pattern = path.join(dir, 'kf-%03d.jpg');
  await run('ffmpeg', [
    '-v', 'error', '-i', filePath,
    '-vf', `fps=${fps}`,
    '-frames:v', String(limit),
    '-q:v', '4',
    pattern,
  ], { timeout: 180_000 });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
  return { dir, frames: files.map((f) => path.join(dir, f)) };
}

// ── Native fallbacks (no ffmpeg) ───────────────────────────────────────────
// Enough header parsing to fill the spec's metadata columns for the two most
// common uncompressed/simple formats, so `/stage` still reports real numbers on
// a machine without ffmpeg installed.

// RIFF/WAVE: walk chunks for `fmt ` and `data`.
export function parseWavHeader(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataSize = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        byteRate: buf.readUInt32LE(off + 16),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt) return null;
  const WAV_CODECS = { 1: 'pcm_s16le', 3: 'pcm_f32le', 6: 'pcm_alaw', 7: 'pcm_mulaw', 0xfffe: 'pcm_extensible' };
  return {
    source: 'native-wav',
    duration: dataSize && fmt.byteRate ? dataSize / fmt.byteRate : null,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    codec: WAV_CODECS[fmt.format] || 'wav-' + fmt.format,
    bitsPerSample: fmt.bitsPerSample,
    bitRate: fmt.byteRate ? fmt.byteRate * 8 : null,
    trackCount: 1,
  };
}

// MP3: read the first valid MPEG audio frame header for sample rate/channels,
// and an ID3v2 size field so we can skip the tag.
export function parseMp3Header(buf) {
  let off = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3' && buf.length > 10) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }
  const RATES = {
    3: [44100, 48000, 32000],   // MPEG-1
    2: [22050, 24000, 16000],   // MPEG-2
    0: [11025, 12000, 8000],    // MPEG-2.5
  };
  const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  for (let i = Math.min(off, buf.length - 4); i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buf[i + 1] >> 3) & 0x03;
    const layer = 4 - ((buf[i + 1] >> 1) & 0x03);
    const rates = RATES[versionBits];
    const rateIdx = (buf[i + 2] >> 2) & 0x03;
    if (!rates || rateIdx === 3) continue;
    const mode = (buf[i + 3] >> 6) & 0x03;
    return {
      source: 'native-mp3',
      duration: null,                            // needs a full frame walk / ffprobe
      channels: mode === 3 ? 1 : 2,
      channelLayout: mode === 3 ? 'mono' : 'stereo',
      sampleRate: rates[rateIdx],
      codec: 'mp3',
      layer,
      bitRate: (BITRATES_V1L3[(buf[i + 2] >> 4) & 0x0f] || 0) * 1000 || null,
      trackCount: 1,
    };
  }
  return null;
}

// PNG IHDR / JPEG SOFn / GIF logical screen — dimensions without a decoder.
export function parseImageSize(buf) {
  if (buf.length > 24 && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + (i + 3 < buf.length ? buf.readUInt16BE(i + 2) : 0);
    }
    return null;
  }
  if (buf.toString('latin1', 0, 3) === 'GIF' && buf.length > 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('latin1', 0, 2) === 'BM' && buf.length > 26) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  return null;
}
