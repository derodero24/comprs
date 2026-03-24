import { randomBytes } from 'node:crypto';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateCompress, deflateDecompress, gzipCompress, gzipDecompress } from '../index.js';
import {
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
} from '../streams.js';

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

describe('createGzipCompressStream', () => {
  const data = Buffer.from('Hello, comprs gzip streaming! '.repeat(100));

  it('should compress data through a stream', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream(9)));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(data, data.length);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(data, 16);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const stream = toChunkedStream(Buffer.alloc(0), 1);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gzipDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('should handle random (incompressible) data', async () => {
    const random = randomBytes(10_000);
    const stream = toChunkedStream(random, 512);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, random)).toBe(0);
  });

  it('should produce output decompressible by Node.js gunzipSync', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
    const decompressed = gunzipSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createGzipDecompressStream', () => {
  const data = Buffer.from('Hello, comprs gzip streaming decompression! '.repeat(100));
  const compressed = gzipCompress(data);

  it('should decompress data through a stream', async () => {
    const stream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(compressed, compressed.length);
    const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle small chunks', async () => {
    const stream = toChunkedStream(compressed, 8);
    const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should decompress Node.js gzipSync output', async () => {
    const nodeCompressed = gzipSync(data);
    const stream = toChunkedStream(nodeCompressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle concatenated gzip streams', async () => {
    const a = gzipCompress(Buffer.from('Hello'));
    const b = gzipCompress(Buffer.from(' World'));
    const concatenated = Buffer.concat([a, b]);
    const stream = toChunkedStream(concatenated, concatenated.length);
    const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(decompressed.toString()).toBe('Hello World');
  });
});

describe('gzip streaming round-trip', () => {
  it('should compress then decompress through piped streams', async () => {
    const data = Buffer.from('Piped gzip streaming test '.repeat(200));
    const stream = toChunkedStream(data, 128);

    const result = await collectStream(
      stream.pipeThrough(createGzipCompressStream()).pipeThrough(createGzipDecompressStream()),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should handle large data (1MB)', { timeout: 30_000 }, async () => {
    const large = Buffer.alloc(1_000_000);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    const stream = toChunkedStream(large, 64 * 1024);

    const result = await collectStream(
      stream.pipeThrough(createGzipCompressStream()).pipeThrough(createGzipDecompressStream()),
    );
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Gzip interop test data '.repeat(50));
    const oneShotCompressed = gzipCompress(data);

    const stream = toChunkedStream(oneShotCompressed, 32);
    const result = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Gzip interop test data '.repeat(50));
    const stream = toChunkedStream(data, 64);
    const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));

    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createDeflateCompressStream', () => {
  const data = Buffer.from('Hello, comprs deflate streaming! '.repeat(100));

  it('should compress data through a stream', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should accept compression level', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream(9)));
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty input', async () => {
    const stream = toChunkedStream(Buffer.alloc(0), 1);
    const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));
    const decompressed = deflateDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('should produce output decompressible by Node.js inflateRawSync', async () => {
    const stream = toChunkedStream(data, 256);
    const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));
    const decompressed = inflateRawSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('createDeflateDecompressStream', () => {
  const data = Buffer.from('Hello, comprs deflate streaming decompression! '.repeat(100));
  const compressed = deflateCompress(data);

  it('should decompress data through a stream', async () => {
    const stream = toChunkedStream(compressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle single chunk', async () => {
    const stream = toChunkedStream(compressed, compressed.length);
    const decompressed = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should decompress Node.js deflateRawSync output', async () => {
    const nodeCompressed = deflateRawSync(data);
    const stream = toChunkedStream(nodeCompressed, 64);
    const decompressed = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('deflate streaming round-trip', () => {
  it('should compress then decompress through piped streams', async () => {
    const data = Buffer.from('Piped deflate streaming test '.repeat(200));
    const stream = toChunkedStream(data, 128);

    const result = await collectStream(
      stream
        .pipeThrough(createDeflateCompressStream())
        .pipeThrough(createDeflateDecompressStream()),
    );
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot compress', async () => {
    const data = Buffer.from('Deflate interop test data '.repeat(50));
    const oneShotCompressed = deflateCompress(data);

    const stream = toChunkedStream(oneShotCompressed, 32);
    const result = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
    expect(Buffer.compare(result, data)).toBe(0);
  });

  it('should interop with one-shot decompress', async () => {
    const data = Buffer.from('Deflate interop test data '.repeat(50));
    const stream = toChunkedStream(data, 64);
    const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));

    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});
