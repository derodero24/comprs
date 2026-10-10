import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { finished } from 'node:stream/promises';
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

/**
 * Run `test` with `close()` removed from a context class, as in the cores
 * before 2.1, which some package managers install with only a warning about
 * the peer range.
 */
async function withoutClose(
  context: { prototype: Encoder },
  test: () => Promise<void>,
): Promise<void> {
  const { prototype } = context;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'close');
  if (!descriptor) throw new Error('expected close() on the prototype');
  Reflect.deleteProperty(prototype, 'close');
  try {
    await test();
  } finally {
    Object.defineProperty(prototype, 'close', descriptor);
  }
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

  it.each(ENCODINGS)('should end cleanly when the context has no close() (%s)', (encoding) =>
    withoutClose(CONTEXTS[encoding], async () => {
      const stream = createCompressTransform(encoding);
      const errors: Error[] = [];
      stream.on('error', (err) => errors.push(err));
      const closed = once(stream, 'close');
      const input = randomBytes(1024);
      const output = await compress(stream, [input]);
      await within(closed);
      expect(errors).toEqual([]);
      expect(decodeReceived(encoding, output)).toEqual(input);
    }),
  );

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

    it.each(['gzip', 'deflate'] as const)(
      'should send nothing for an empty write once input pauses (%s)',
      async (encoding) => {
        const flush = vi.spyOn(CONTEXTS[encoding].prototype, 'flush');
        const stream = createCompressTransform(encoding);
        const input = randomBytes(1024);
        stream.write(input);
        await nextTurn();
        const output: unknown = stream.read();
        if (!Buffer.isBuffer(output)) throw new Error('expected output once input paused');
        expect(decodeReceived(encoding, output)).toEqual(input);
        // Empty writes add no input, so no empty block follows them.
        stream.write(Buffer.alloc(0));
        stream.write('');
        await nextTurn();
        await nextTurn();
        expect(stream.readableLength).toBe(0);
        expect(flush).toHaveBeenCalledOnce();
        stream.destroy();
      },
    );

    it('should not flush a stream that ends before its input pauses', async () => {
      const flush = vi.spyOn(GzipCompressContext.prototype, 'flush');
      const stream = createCompressTransform('gzip');
      const input = randomBytes(1024);
      const output = await compress(stream, [input]);
      await finished(stream);
      await nextTurn();
      expect(flush).not.toHaveBeenCalled();
      expect(gunzipSync(output)).toEqual(input);
    });

    it('should include the chunk in a flush made while its output is emitted', async () => {
      const flush = vi.spyOn(GzipCompressContext.prototype, 'flush');
      const stream = createCompressTransform('gzip');
      const output: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        output.push(chunk);
        stream.flush();
      });
      // Once the stream flows, each output is emitted as it is pushed.
      await nextTurn();
      // The first output is the gzip header: the flush made while it is
      // emitted covers the chunk that produced it.
      const input = randomBytes(1024);
      stream.write(input);
      expect(flush).toHaveBeenCalledOnce();
      expect(decodeReceived('gzip', Buffer.concat(output))).toEqual(input);
      // This chunk fills the encoder's buffer, so it gives output of its own,
      // and the flush made while that is emitted covers the whole chunk: no
      // flush without new input, which would send an empty block, follows.
      stream.write(randomBytes(256 * 1024));
      expect(flush).toHaveBeenCalledTimes(2);
      const emitted = output.length;
      await nextTurn();
      await nextTurn();
      expect(flush).toHaveBeenCalledTimes(2);
      expect(output).toHaveLength(emitted);
      stream.destroy();
    });

    it('should fail when flushing fails', async () => {
      vi.spyOn(GzipCompressContext.prototype, 'flush').mockImplementationOnce(() => {
        throw new Error('injected flush failure');
      });
      const close = vi.spyOn(GzipCompressContext.prototype, 'close');
      const stream = createCompressTransform('gzip');
      stream.write(randomBytes(1024));
      const [err]: unknown[] = await within(once(stream, 'error'));
      expect(err).toHaveProperty('message', 'injected flush failure');
      expect(stream.destroyed).toBe(true);
      expect(close).toHaveBeenCalledOnce();
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
