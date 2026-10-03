import { randomBytes } from 'node:crypto';
import type { Transform } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { createCompressTransform } from '../src/compress.js';

/** Write `chunks` to a compressor and collect its output. */
function compress(stream: Transform, chunks: readonly Uint8Array[]): Promise<Buffer> {
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return buffer(stream);
}

/** The window size a zstd frame header declares (RFC 8878, section 3.1.1.1). */
function zstdWindowSize(frame: Buffer): number {
  expect(frame.readUInt32LE(0)).toBe(0xfd2fb528);
  // Frame_Header_Descriptor: with Single_Segment_flag unset, Window_Descriptor follows.
  expect((frame[4] ?? 0) & 0x20).toBe(0);
  const descriptor = frame[5] ?? 0;
  const base = 2 ** (10 + (descriptor >> 3));
  return base + (base / 8) * (descriptor & 0x07);
}

describe('createCompressTransform', () => {
  describe('deflate', () => {
    it('should produce the zlib format, whatever the chunks', async () => {
      const data = randomBytes(100_000);
      const chunks = [data.subarray(0, 1), data.subarray(1, 70_000), data.subarray(70_000)];
      const output = await compress(createCompressTransform('deflate'), chunks);
      expect([...output.subarray(0, 2)]).toEqual([0x78, 0x9c]);
      expect(inflateSync(output)).toEqual(data);
    });

    it('should produce the zlib format for no data', async () => {
      const output = await compress(createCompressTransform('deflate', { deflate: 1 }), []);
      expect([...output.subarray(0, 2)]).toEqual([0x78, 0x01]);
      expect(inflateSync(output)).toHaveLength(0);
    });
  });

  describe('zstd', () => {
    // RFC 9659, section 3: encoders MUST NOT generate frames requiring a
    // Window_Size larger than 8 MB. A stream does not know its size up front,
    // so its frame declares the full window of the level.
    it.each([
      { level: 19, allowed: true },
      { level: 20, allowed: false },
    ])(
      'should keep the window within 8 MiB at level $level: $allowed',
      async ({ level, allowed }) => {
        const output = await compress(createCompressTransform('zstd', { zstd: level }), [
          Buffer.from('Hello, World! '.repeat(200)),
        ]);
        expect(zstdWindowSize(output) <= 8 * 1024 * 1024).toBe(allowed);
      },
    );
  });
});
