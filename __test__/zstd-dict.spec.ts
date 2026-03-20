import { describe, expect, it } from 'vitest';
import {
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import { createZstdCompressDictStream, createZstdDecompressDictStream } from '../streams.js';

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

describe('zstd dictionary compression', () => {
  // Generate sample data (JSON-like patterns)
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ),
  );

  it('should train a dictionary from samples', () => {
    const dict = zstdTrainDictionary(samples);
    expect(dict.length).toBeGreaterThan(0);
  });

  it('should round-trip with dictionary', () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should compress better than without dictionary for small data', () => {
    const dict = zstdTrainDictionary(samples);
    const small = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'dict_test',
        email: 'dict@test.com',
        active: true,
      }),
    );
    const withDict = zstdCompressWithDict(small, dict);
    const withoutDict = zstdCompress(small);
    expect(withDict.length).toBeLessThan(withoutDict.length);
  });
});

describe('zstd streaming dictionary compression', () => {
  // Generate sample data (JSON-like patterns)
  const samples = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(
      JSON.stringify({
        id: i,
        name: `user_${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0,
      }),
    ),
  );

  it('should round-trip through stream with dictionary', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 500,
        name: 'stream_user',
        email: 'stream@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressDictStream(dict)));
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createZstdDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should handle larger data through stream with dictionary', async () => {
    const dict = zstdTrainDictionary(samples);
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
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressDictStream(dict)));
    const decompStream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createZstdDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop with one-shot dict compress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'interop_user',
        email: 'interop@example.com',
        active: false,
      }),
    );

    // Compress with one-shot, decompress with stream
    const compressed = zstdCompressWithDict(original, dict);
    const decompStream = toChunkedStream(compressed, 16);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createZstdDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop with one-shot dict decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 456,
        name: 'interop_user_2',
        email: 'interop2@example.com',
        active: true,
      }),
    );

    // Compress with stream, decompress with one-shot
    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(stream.pipeThrough(createZstdCompressDictStream(dict)));
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should accept compression level with dictionary', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 789,
        name: 'level_test',
        email: 'level@example.com',
        active: true,
      }),
    );

    const stream = toChunkedStream(original, 32);
    const compressed = await collectStream(
      stream.pipeThrough(createZstdCompressDictStream(dict, 19)),
    );
    const decompStream = toChunkedStream(compressed, 32);
    const decompressed = await collectStream(
      decompStream.pipeThrough(createZstdDecompressDictStream(dict)),
    );
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});
