import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { brotliCompress, brotliDecompress, brotliDecompressWithCapacity } from '../index.js';
import { createBrotliCompressStream, createBrotliDecompressStream } from '../streams.js';

/** Collect all chunks from a ReadableStream into a single Buffer. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
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

describe('brotliCompress / brotliDecompress', () => {
  it('should round-trip a simple string', () => {
    const input = Buffer.from('Hello, zflate brotli!');
    const compressed = brotliCompress(input);
    const decompressed = brotliDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', () => {
    const input = Buffer.alloc(0);
    const compressed = brotliCompress(input);
    const decompressed = brotliDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip a 1-byte buffer', () => {
    const input = Buffer.from([42]);
    const compressed = brotliCompress(input);
    const decompressed = brotliDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1KB of data', () => {
    const input = Buffer.alloc(1024, 'a');
    const compressed = brotliCompress(input);
    const decompressed = brotliDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1MB of data', { timeout: 30_000 }, () => {
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    const compressed = brotliCompress(input);
    const decompressed = brotliDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should actually compress repetitive data', () => {
    const input = Buffer.alloc(10000, 'x');
    const compressed = brotliCompress(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('should compress with different quality levels', () => {
    const input = Buffer.from('Repeating data for compression. '.repeat(100));

    for (const quality of [0, 6, 11]) {
      const compressed = brotliCompress(input, quality);
      const decompressed = brotliDecompress(compressed);
      expect(decompressed).toEqual(input);
    }
  });

  it('should use default quality (6) when quality is not specified', () => {
    const input = Buffer.from('test data '.repeat(50));
    const withDefault = brotliCompress(input);
    const withExplicit6 = brotliCompress(input, 6);
    expect(withDefault).toEqual(withExplicit6);
  });

  it('should throw on invalid compressed data', () => {
    const invalid = Buffer.from('this is not brotli data');
    expect(() => brotliDecompress(invalid)).toThrow();
  });

  it('should throw on quality > 11', () => {
    const input = Buffer.from('test');
    expect(() => brotliCompress(input, 12)).toThrow(/quality must be between 0 and 11/);
  });
});

describe('brotliDecompressWithCapacity', () => {
  const original = Buffer.from('Capacity test data '.repeat(100));
  const compressed = brotliCompress(original);

  it('should decompress with exact capacity', () => {
    const result = brotliDecompressWithCapacity(compressed, original.length);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const result = brotliDecompressWithCapacity(compressed, original.length * 10);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    expect(() => brotliDecompressWithCapacity(compressed, 1)).toThrow(/exceeded maximum size/);
  });

  it('should throw with negative capacity', () => {
    expect(() => brotliDecompressWithCapacity(compressed, -1)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with NaN capacity', () => {
    expect(() => brotliDecompressWithCapacity(compressed, NaN)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with Infinity capacity', () => {
    expect(() => brotliDecompressWithCapacity(compressed, Infinity)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should accept capacity of 0 for empty data', () => {
    const empty = Buffer.alloc(0);
    const emptyCompressed = brotliCompress(empty);
    const result = brotliDecompressWithCapacity(emptyCompressed, 0);
    expect(result.length).toBe(0);
  });
});

describe('brotli interop with Node.js zlib', () => {
  const data = Buffer.from('Interoperability test data for brotli. '.repeat(50));

  it('should produce output decompressible by Node.js zlib', () => {
    const compressed = brotliCompress(data);
    const decompressed = brotliDecompressSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should decompress Node.js zlib brotli output', () => {
    const compressed = brotliCompressSync(data);
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createBrotliCompressStream', () => {
  const data = Buffer.from('Hello, zflate brotli streaming! '.repeat(100));

  it('should compress data through a stream', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression quality', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream(11)));
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(data, data.length);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(data, 16);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));
    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const stream = toChunkedStream(Buffer.alloc(0), 1);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));
    const decompressed = brotliDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });
});

describe('createBrotliDecompressStream', () => {
  const data = Buffer.from('Hello, zflate brotli streaming decompression! '.repeat(100));
  const compressed = brotliCompress(data);

  it('should decompress data through a stream', async () => {
    const stream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createBrotliDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(compressed, compressed.length);
    const decompressed = await collectStream(stream.pipeThrough(createBrotliDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(compressed, 8);
    const decompressed = await collectStream(stream.pipeThrough(createBrotliDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('brotli streaming round-trip', () => {
  it('should compress then decompress through piped streams', async () => {
    const data = Buffer.from('Piped brotli streaming test '.repeat(200));
    const stream = toChunkedStream(data, 128);

    const result = await collectStream(
      stream.pipeThrough(createBrotliCompressStream()).pipeThrough(createBrotliDecompressStream()),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should handle large data (1MB)', { timeout: 30_000 }, async () => {
    const large = Buffer.alloc(1_000_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const stream = toChunkedStream(large, 64 * 1024);

    const result = await collectStream(
      stream.pipeThrough(createBrotliCompressStream()).pipeThrough(createBrotliDecompressStream()),
    );
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const oneShotCompressed = brotliCompress(data);

    const stream = toChunkedStream(oneShotCompressed, 32);
    const result = await collectStream(stream.pipeThrough(createBrotliDecompressStream()));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Interop test data '.repeat(50));
    const stream = toChunkedStream(data, 64);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));

    const decompressed = brotliDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should interop streaming compress with Node.js zlib decompress', async () => {
    const data = Buffer.from('Streaming to Node.js interop '.repeat(50));
    const stream = toChunkedStream(data, 128);
    const compressed = await collectStream(stream.pipeThrough(createBrotliCompressStream()));

    const decompressed = brotliDecompressSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});
