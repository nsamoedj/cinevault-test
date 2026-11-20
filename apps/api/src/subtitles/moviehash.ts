// The OpenSubtitles hash: file size plus the 64-bit little-endian sums of the
// first and last 64 KiB. Two small reads, so cheap even over the WSL2 bind mount.

import { open } from 'node:fs/promises';

const CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

export async function movieHash(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < CHUNK * 2) return undefined;
    let hash = BigInt(size);
    for (const position of [0, size - CHUNK]) {
      const buffer = Buffer.alloc(CHUNK);
      await handle.read(buffer, 0, CHUNK, position);
      for (let i = 0; i < CHUNK; i += 8) hash = (hash + buffer.readBigUInt64LE(i)) & MASK;
    }
    return hash.toString(16).padStart(16, '0');
  } finally {
    await handle.close();
  }
}
