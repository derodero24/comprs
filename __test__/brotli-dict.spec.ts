import { describe, expect, it } from 'vitest';
import {
  BrotliCompressDictContext,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompressWithDict,
  brotliDecompressWithDictAsync,
  brotliDecompressWithDictWithCapacity,
  brotliDecompressWithDictWithCapacityAsync,
} from '../index.js';
import { createBrotliCompressDictStream, createBrotliDecompressDictStream } from '../streams.js';

/** Collect all chunks from a ReadableStream into a single Buffer. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Create a ReadableStream from data, split into chunks of the given size. */
function toChunkedStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += chunkSize) {
        controller.enqueue(data.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

/** Build a raw byte dictionary for brotli (no training step). */
function buildDict(): Buffer {
  return Buffer.from(
    Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ).join(''),
  );
}

describe('brotli dictionary compression', () => {
  const dict = buildDict();

  it('should round-trip with dictionary', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should round-trip with various quality levels', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'quality_test',
        email: 'quality@test.com',
        active: true,
      }),
    );
    for (const quality of [0, 3, 6, 9, 11]) {
      const compressed = brotliCompressWithDict(original, dict, quality);
      const decompressed = brotliDecompressWithDict(compressed, dict);
      expect(Buffer.compare(decompressed, original)).toBe(0);
    }
  });

  it('should round-trip async with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 100,
        name: 'async_user',
        email: 'async@example.com',
        active: false,
      }),
    );
    const compressed = await brotliCompressWithDictAsync(original, dict);
    const decompressed = await brotliDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('brotliDecompressWithDictWithCapacity', () => {
  const dict = buildDict();

  it('should decompress with exact capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'capacity_test',
        email: 'capacity@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDictWithCapacity(compressed, dict, original.length);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 888,
        name: 'oversized_test',
        email: 'oversized@example.com',
        active: false,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = brotliDecompressWithDictWithCapacity(
      compressed,
      dict,
      original.length * 10,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 777,
        name: 'insufficient_test',
        email: 'insufficient@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    expect(() => brotliDecompressWithDictWithCapacity(compressed, dict, 1)).toThrow();
  });
});

describe('brotliDecompressWithDictWithCapacityAsync', () => {
  const dict = buildDict();

  it('should decompress async with exact capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'async_capacity_test',
        email: 'async_capacity@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = await brotliDecompressWithDictWithCapacityAsync(
      compressed,
      dict,
      original.length,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should decompress async with oversized capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 888,
        name: 'async_oversized_test',
        email: 'async_oversized@example.com',
        active: false,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    const decompressed = await brotliDecompressWithDictWithCapacityAsync(
      compressed,
      dict,
      original.length * 10,
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should reject with insufficient capacity', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 777,
        name: 'async_insufficient_test',
        email: 'async_insufficient@example.com',
        active: true,
      }),
    );
    const compressed = brotliCompressWithDict(original, dict);
    await expect(brotliDecompressWithDictWithCapacityAsync(compressed, dict, 1)).rejects.toThrow();
  });
});

describe('brotli streaming dictionary compression', () => {
  const dict = buildDict();

  it('should round-trip through stream with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 500,
        name: 'stream_user',
        email: 'stream@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should handle larger data through stream with dictionary', async () => {
    const original = Buffer.from(
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({
          id: i,
          name: `bulk_user_${i}`,
          email: `bulk${i}@example.com`,
          active: i % 2 === 0,
        }),
      ).join('\n'),
    );

    const stream = toChunkedStream(original, 256);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompStream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop: one-shot compress -> stream decompress', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'interop_user',
        email: 'interop@example.com',
        active: false,
      }),
    );

    const compressed = brotliCompressWithDict(original, dict);
    const decompStream = toChunkedStream(compressed, 16);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop: stream compress -> one-shot decompress', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 456,
        name: 'interop_user_2',
        email: 'interop2@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict)),
    );
    const decompressed = brotliDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should accept quality parameter with dictionary', async () => {
    const original = Buffer.from(
      JSON.stringify({
        id: 789,
        name: 'quality_test',
        email: 'quality@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createBrotliCompressDictStream(dict, 9)),
    );
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createBrotliDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('brotli dict compress context finish guard', () => {
  const dict = buildDict();

  it('should throw when calling transform() after finish() on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
  });

  it('should throw when calling finish() twice on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.finish()).toThrow(/already finished/);
  });

  it('should throw when calling flush() after finish() on BrotliCompressDictContext', () => {
    const ctx = new BrotliCompressDictContext(dict);
    ctx.transform(Buffer.from('hello'));
    ctx.finish();
    expect(() => ctx.flush()).toThrow(/already finished/);
  });
});
