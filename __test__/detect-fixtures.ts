import { Buffer } from 'node:buffer';

/** Text that compresses well, as the format detection issue used: 43,890 bytes. */
export const ROWS = Buffer.from(Array.from({ length: 5000 }, (_, i) => `row ${i}\n`).join(''));

/** `length` pseudo-random bytes, the same for each `seed`. */
export function pseudoRandomBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  // xorshift32, whose state must not be 0.
  let state = seed + 1;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

/** A skippable frame holding `payload`, as zstd and LZ4 define it. */
export function skippableFrame(payload: Uint8Array, magic = 0x184d2a50): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * An LZ4 legacy frame, as `lz4 -l` writes it, holding `content` in one block
 * of literals.
 */
export function lz4LegacyFrame(content: Buffer): Buffer {
  // The block's only sequence: a token holding the literal length, up to 15,
  // bytes that add the rest of it, then the literals.
  const lengthBytes = [Math.min(content.length, 15) << 4];
  if (content.length >= 15) {
    let rest = content.length - 15;
    for (; rest >= 255; rest -= 255) lengthBytes.push(255);
    lengthBytes.push(rest);
  }
  const block = Buffer.concat([Buffer.from(lengthBytes), content]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184c2102, 0);
  header.writeUInt32LE(block.length, 4);
  return Buffer.concat([header, block]);
}
