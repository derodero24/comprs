import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { constants, gunzipSync, inflateSync } from 'node:zlib';
import {
  BrotliCompressContext,
  BrotliDecompressContext,
  brotliDecompress,
  DeflateCompressContext,
  GzipCompressContext,
  gzipDecompress,
  ZstdCompressContext,
  ZstdDecompressContext,
  zstdDecompress,
} from '@derodero24/comprs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compressBufferAsync, createCompressTransform, type Encoder } from '../src/compress.js';
import type { Encoding } from '../src/types.js';

const ENCODINGS: readonly Encoding[] = ['zstd', 'br', 'gzip', 'deflate'];

/** The context class each encoding compresses with. */
const CONTEXTS: Record<Encoding, { prototype: Encoder }> = {
  zstd: ZstdCompressContext,
  br: BrotliCompressContext,
  gzip: GzipCompressContext,
  deflate: DeflateCompressContext,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Write `chunks` to a compressor and collect its output. */
function compress(stream: Transform, chunks: readonly Uint8Array[]): Promise<Buffer> {
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return buffer(stream);
}

/** Settle like `promise`, or reject if it takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decode as much of a compressed stream as `data` holds. */
function decodeReceived(encoding: Encoding, data: Buffer): Buffer {
  switch (encoding) {
    case 'zstd':
      return new ZstdDecompressContext().transform(data);
    case 'br':
      return new BrotliDecompressContext().transform(data);
    case 'gzip':
      return gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
    case 'deflate':
      return inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
  }
}

/**
 * Read the output of `stream` until it decodes to `expected`, without ending
 * it. `received` is the output read before.
 */
function readUntil(
  stream: Transform,
  encoding: Encoding,
  expected: Uint8Array,
  received: readonly Buffer[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks = [...received];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (decodeReceived(encoding, Buffer.concat(chunks)).equals(expected)) resolve();
    });
    stream.on('error', reject);
  });
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
  it.each(ENCODINGS)('should close the context when destroyed (%s)', async (encoding) => {
    const close = vi.spyOn(CONTEXTS[encoding].prototype, 'close');
    const stream = createCompressTransform(encoding);
    stream.write(randomBytes(1024));
    stream.destroy();
    await once(stream, 'close');
    expect(close).toHaveBeenCalledOnce();
  });

  describe('flushing', () => {
    it.each(ENCODINGS)('should send what was written once input pauses (%s)', async (encoding) => {
      const stream = createCompressTransform(encoding);
      const input = randomBytes(1024);
      stream.write(input);
      await within(readUntil(stream, encoding, input));
      stream.destroy();
    });

    it.each(ENCODINGS)('should flush writes that come together once (%s)', async (encoding) => {
      const flush = vi.spyOn(CONTEXTS[encoding].prototype, 'flush');
      const stream = createCompressTransform(encoding);
      const chunks = Array.from({ length: 10 }, () => randomBytes(100));
      for (const chunk of chunks) stream.write(chunk);
      await within(readUntil(stream, encoding, Buffer.concat(chunks)));
      expect(flush).toHaveBeenCalledOnce();
      stream.destroy();
    });

    it('should flush input that waited until the output was read', async () => {
      const stream = createCompressTransform('zstd');
      // zstd emits the first 128 KiB block of these random bytes, which do
      // not compress, and keeps the rest. That output fills the buffer of
      // the readable side, so the stream holds the write back until the
      // output is read.
      const input = randomBytes(129 * 1024);
      stream.write(input);
      await nextTurn();
      expect(stream.writableLength).toBe(input.byteLength);
      const output: unknown = stream.read();
      if (!Buffer.isBuffer(output)) throw new Error('expected output from the write');
      expect(decodeReceived('zstd', output).byteLength).toBe(128 * 1024);
      // Reading let the write complete: the rest is flushed although no
      // other write follows.
      await within(readUntil(stream, 'zstd', input, [output]));
      stream.destroy();
    });

    it.each(ENCODINGS)('should flush right away with flush() (%s)', (encoding) => {
      const stream = createCompressTransform(encoding);
      const input = randomBytes(1024);
      stream.write(input);
      stream.flush();
      const output: unknown = stream.read();
      if (!Buffer.isBuffer(output)) throw new Error('expected output from flush()');
      expect(decodeReceived(encoding, output)).toEqual(input);
      // Without new input, flush() sends nothing, not even an empty block.
      stream.flush();
      expect(stream.readableLength).toBe(0);
      stream.destroy();
    });
  });

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

describe('compressBufferAsync', () => {
  const data = Buffer.from('Hello, World! '.repeat(200));

  it.each([
    { encoding: 'zstd', decompress: zstdDecompress },
    { encoding: 'br', decompress: brotliDecompress },
    { encoding: 'gzip', decompress: gzipDecompress },
  ] as const)('should compress with $encoding', async ({ encoding, decompress }) => {
    const output = await compressBufferAsync(encoding, data);
    expect(output.length).toBeLessThan(data.length);
    expect(decompress(output)).toEqual(data);
  });

  it('should produce the zlib format for deflate at the given level', async () => {
    const output = await compressBufferAsync('deflate', data, { deflate: 1 });
    expect(Buffer.isBuffer(output)).toBe(true);
    expect([...output.subarray(0, 2)]).toEqual([0x78, 0x01]);
    expect(inflateSync(output)).toEqual(data);
  });
});
