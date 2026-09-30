// Minimal ZIP reader, built on node:zlib. OOXML documents (.docx/.xlsx/.pptx)
// and ODF are ZIP containers, so the document leg of the pipeline needs to list
// and inflate members. Implemented here rather than pulling a dependency — the
// pipeline only ever needs stored (0) and deflate (8) entries, which is all any
// Office writer produces.
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD = 0x06054b50;          // End of central directory
const EOCD64_LOC = 0x07064b50;    // Zip64 EOCD locator
const EOCD64 = 0x06064b50;        // Zip64 EOCD
const CDH = 0x02014b50;           // Central directory file header

// Locate the end-of-central-directory record by scanning backwards from EOF
// (it is at most 64 KB from the end because of the comment field).
function findEocd(buf) {
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

// Read the central directory and return one descriptor per member.
export function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw Object.assign(new Error('not a zip archive (no end-of-central-directory record)'), { code: 'ZIP_CORRUPT' });

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // Zip64: the 32-bit fields are saturated and the real values live in the
  // Zip64 EOCD record pointed at by the locator just before the classic EOCD.
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOC) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) === EOCD64) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CDH) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      crc32: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Inflate a single member, given the whole archive buffer and its descriptor.
export async function readMember(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) {
    throw Object.assign(new Error(`corrupt local header for ${entry.name}`), { code: 'ZIP_CORRUPT' });
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRaw(raw);
  throw Object.assign(new Error(`unsupported zip compression method ${entry.method}`), { code: 'ZIP_METHOD' });
}

// Convenience: open a zip file, list members, and inflate the named ones.
export async function openZip(filePath) {
  const buf = await fs.readFile(filePath);
  const entries = readCentralDirectory(buf);
  return {
    entries,
    has: (name) => entries.some((e) => e.name === name),
    read: (name) => {
      const e = entries.find((x) => x.name === name);
      if (!e) throw Object.assign(new Error(`zip member not found: ${name}`), { code: 'ZIP_MEMBER_MISSING' });
      return readMember(buf, e);
    },
    readText: async (name) => (await readMember(buf, entries.find((x) => x.name === name))).toString('utf8'),
  };
}
