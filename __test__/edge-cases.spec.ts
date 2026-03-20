import { describe, expect, it } from 'vitest';
import {
  BrotliCompressContext,
  brotliCompress,
  brotliDecompress,
  DeflateCompressContext,
  DeflateDecompressContext,
  deflateCompress,
  deflateDecompress,
  GzipCompressContext,
  GzipDecompressContext,
  gzipCompress,
  gzipDecompress,
  zstdCompress,
  zstdDecompress,
} from '../index.js';
import {
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createZstdCompressStream,
  createZstdDecompressStream,
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

// ---------------------------------------------------------------------------
// Decompression error handling
// ---------------------------------------------------------------------------

describe('decompression error handling', () => {
  const testData = Buffer.from('Hello, edge case testing! '.repeat(100));

  describe('truncated compressed data', () => {
    it('should throw when decompressing truncated zstd data', () => {
      const compressed = zstdCompress(testData);
      const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
      expect(() => zstdDecompress(truncated)).toThrow();
    });

    it('should throw when decompressing truncated gzip data', () => {
      const compressed = gzipCompress(testData);
      const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
      expect(() => gzipDecompress(truncated)).toThrow();
    });

    it('should not decompress truncated deflate data to the original', () => {
      const compressed = deflateCompress(testData);
      const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
      // Raw deflate may produce partial output from truncated data without throwing.
      // Verify the result is not equal to the original data.
      let result: Buffer | null = null;
      try {
        result = deflateDecompress(truncated);
      } catch {
        // Throwing is also acceptable
        return;
      }
      expect(Buffer.compare(result, testData)).not.toBe(0);
    });

    it('should throw when decompressing truncated brotli data', () => {
      const compressed = brotliCompress(testData);
      const truncated = compressed.subarray(0, Math.floor(compressed.length / 2));
      expect(() => brotliDecompress(truncated)).toThrow();
    });
  });

  describe('corrupted compressed data', () => {
    it('should not decompress corrupted zstd data correctly', () => {
      const compressed = Buffer.from(zstdCompress(testData));
      // Flip bits in the middle of the compressed data
      const mid = Math.floor(compressed.length / 2);
      compressed.writeUInt8(compressed.readUInt8(mid) ^ 0xff, mid);
      compressed.writeUInt8(compressed.readUInt8(mid + 1) ^ 0xff, mid + 1);
      // Corrupted data should either throw or produce different output
      let result: Buffer | null = null;
      try {
        result = zstdDecompress(compressed);
      } catch {
        // Throwing is acceptable
        return;
      }
      expect(Buffer.compare(result, testData)).not.toBe(0);
    });

    it('should throw when decompressing corrupted gzip data', () => {
      const compressed = Buffer.from(gzipCompress(testData));
      const mid = Math.floor(compressed.length / 2);
      compressed.writeUInt8(compressed.readUInt8(mid) ^ 0xff, mid);
      compressed.writeUInt8(compressed.readUInt8(mid + 1) ^ 0xff, mid + 1);
      expect(() => gzipDecompress(compressed)).toThrow();
    });

    it('should throw when decompressing corrupted deflate data', () => {
      const compressed = Buffer.from(deflateCompress(testData));
      const mid = Math.floor(compressed.length / 2);
      compressed.writeUInt8(compressed.readUInt8(mid) ^ 0xff, mid);
      compressed.writeUInt8(compressed.readUInt8(mid + 1) ^ 0xff, mid + 1);
      expect(() => deflateDecompress(compressed)).toThrow();
    });

    it('should throw when decompressing corrupted brotli data', () => {
      const compressed = Buffer.from(brotliCompress(testData));
      const mid = Math.floor(compressed.length / 2);
      compressed.writeUInt8(compressed.readUInt8(mid) ^ 0xff, mid);
      compressed.writeUInt8(compressed.readUInt8(mid + 1) ^ 0xff, mid + 1);
      expect(() => brotliDecompress(compressed)).toThrow();
    });
  });

  describe('wrong algorithm', () => {
    it('should throw when feeding gzip data to zstdDecompress', () => {
      const gzipped = gzipCompress(testData);
      expect(() => zstdDecompress(gzipped)).toThrow();
    });

    it('should throw when feeding zstd data to gzipDecompress', () => {
      const zstdData = zstdCompress(testData);
      expect(() => gzipDecompress(zstdData)).toThrow();
    });

    it('should throw when feeding brotli data to zstdDecompress', () => {
      const brotliData = brotliCompress(testData);
      expect(() => zstdDecompress(brotliData)).toThrow();
    });

    it('should throw when feeding zstd data to brotliDecompress', () => {
      const zstdData = zstdCompress(testData);
      expect(() => brotliDecompress(zstdData)).toThrow();
    });

    it('should throw when feeding gzip data to deflateDecompress', () => {
      const gzipped = gzipCompress(testData);
      expect(() => deflateDecompress(gzipped)).toThrow();
    });

    it('should throw when feeding deflate data to gzipDecompress', () => {
      const deflated = deflateCompress(testData);
      expect(() => gzipDecompress(deflated)).toThrow();
    });

    it('should throw when feeding brotli data to gzipDecompress', () => {
      const brotliData = brotliCompress(testData);
      expect(() => gzipDecompress(brotliData)).toThrow();
    });

    it('should throw when feeding gzip data to brotliDecompress', () => {
      const gzipped = gzipCompress(testData);
      expect(() => brotliDecompress(gzipped)).toThrow();
    });
  });

  describe('empty buffer input to decompress', () => {
    it('should return empty buffer when decompressing empty buffer with zstd', () => {
      // zstd treats empty input as a valid empty frame
      const result = zstdDecompress(Buffer.alloc(0));
      expect(result.length).toBe(0);
    });

    it('should throw when decompressing empty buffer with gzip', () => {
      expect(() => gzipDecompress(Buffer.alloc(0))).toThrow();
    });

    it('should return empty buffer when decompressing empty buffer with deflate', () => {
      // Raw deflate treats empty input as a valid empty stream
      const result = deflateDecompress(Buffer.alloc(0));
      expect(result.length).toBe(0);
    });

    it('should throw when decompressing empty buffer with brotli', () => {
      expect(() => brotliDecompress(Buffer.alloc(0))).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming edge cases
// ---------------------------------------------------------------------------

describe('streaming edge cases', () => {
  describe('transform after finish on gzip context', () => {
    it('should throw when calling transform() after finish() on GzipCompressContext', () => {
      const ctx = new GzipCompressContext();
      ctx.transform(Buffer.from('hello'));
      ctx.flush();
      ctx.finish();
      expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
    });

    it('should throw when calling transform() after finish() on GzipDecompressContext', () => {
      // Create valid gzip data to feed the context
      const data = Buffer.from('test data');
      const compressed = gzipCompress(data);
      const ctx = new GzipDecompressContext();
      ctx.transform(compressed);
      ctx.finish();
      expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
    });
  });

  describe('finish twice on gzip context', () => {
    it('should throw when calling finish() twice on GzipCompressContext', () => {
      const ctx = new GzipCompressContext();
      ctx.transform(Buffer.from('hello'));
      ctx.finish();
      expect(() => ctx.finish()).toThrow(/already finished/);
    });

    it('should throw when calling finish() twice on GzipDecompressContext', () => {
      const data = Buffer.from('test data');
      const compressed = gzipCompress(data);
      const ctx = new GzipDecompressContext();
      ctx.transform(compressed);
      ctx.finish();
      expect(() => ctx.finish()).toThrow(/already finished/);
    });
  });

  describe('transform after finish on deflate context', () => {
    it('should throw when calling transform() after finish() on DeflateCompressContext', () => {
      const ctx = new DeflateCompressContext();
      ctx.transform(Buffer.from('hello'));
      ctx.flush();
      ctx.finish();
      expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
    });

    it('should throw when calling transform() after finish() on DeflateDecompressContext', () => {
      const data = Buffer.from('test data');
      const compressed = deflateCompress(data);
      const ctx = new DeflateDecompressContext();
      ctx.transform(compressed);
      ctx.finish();
      expect(() => ctx.transform(Buffer.from('more data'))).toThrow(/already finished/);
    });
  });

  describe('finish twice on deflate context', () => {
    it('should throw when calling finish() twice on DeflateCompressContext', () => {
      const ctx = new DeflateCompressContext();
      ctx.transform(Buffer.from('hello'));
      ctx.finish();
      expect(() => ctx.finish()).toThrow(/already finished/);
    });

    it('should throw when calling finish() twice on DeflateDecompressContext', () => {
      const data = Buffer.from('test data');
      const compressed = deflateCompress(data);
      const ctx = new DeflateDecompressContext();
      ctx.transform(compressed);
      ctx.finish();
      expect(() => ctx.finish()).toThrow(/already finished/);
    });
  });

  describe('single-byte chunks through streaming', () => {
    const data = Buffer.from('Single byte chunk test data.');

    it('should handle single-byte chunks through gzip stream', async () => {
      const stream = toChunkedStream(data, 1);
      const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
      const decompressed = gzipDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle single-byte chunks through deflate stream', async () => {
      const stream = toChunkedStream(data, 1);
      const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));
      const decompressed = deflateDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle single-byte chunks through zstd stream', async () => {
      const stream = toChunkedStream(data, 1);
      const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle single-byte decompression chunks through gzip stream', async () => {
      const compressed = gzipCompress(data);
      const stream = toChunkedStream(compressed, 1);
      const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle single-byte decompression chunks through deflate stream', async () => {
      const compressed = deflateCompress(data);
      const stream = toChunkedStream(compressed, 1);
      const decompressed = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle single-byte decompression chunks through zstd stream', async () => {
      const compressed = zstdCompress(data);
      const stream = toChunkedStream(compressed, 1);
      const decompressed = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });
  });

  describe('zero-length chunk in the middle of a stream', () => {
    const data = Buffer.from('Zero-length chunk test data '.repeat(10));

    it('should handle zero-length chunk in gzip compression stream', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 10));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(data.subarray(10));
          controller.close();
        },
      });
      const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
      const decompressed = gzipDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle zero-length chunk in deflate compression stream', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 10));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(data.subarray(10));
          controller.close();
        },
      });
      const compressed = await collectStream(stream.pipeThrough(createDeflateCompressStream()));
      const decompressed = deflateDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle zero-length chunk in zstd compression stream', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 10));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(data.subarray(10));
          controller.close();
        },
      });
      const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle zero-length chunk in gzip decompression stream', async () => {
      const compressed = gzipCompress(data);
      const mid = Math.floor(compressed.length / 2);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed.subarray(0, mid));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(compressed.subarray(mid));
          controller.close();
        },
      });
      const decompressed = await collectStream(stream.pipeThrough(createGzipDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle zero-length chunk in deflate decompression stream', async () => {
      const compressed = deflateCompress(data);
      const mid = Math.floor(compressed.length / 2);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed.subarray(0, mid));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(compressed.subarray(mid));
          controller.close();
        },
      });
      const decompressed = await collectStream(stream.pipeThrough(createDeflateDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should handle zero-length chunk in zstd decompression stream', async () => {
      const compressed = zstdCompress(data);
      const mid = Math.floor(compressed.length / 2);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(compressed.subarray(0, mid));
          controller.enqueue(new Uint8Array(0)); // zero-length chunk
          controller.enqueue(compressed.subarray(mid));
          controller.close();
        },
      });
      const decompressed = await collectStream(stream.pipeThrough(createZstdDecompressStream()));
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Compression level edge cases
// ---------------------------------------------------------------------------

describe('compression level edge cases', () => {
  const data = Buffer.from('Compression level edge case test data '.repeat(50));

  describe('zstd levels', () => {
    it('should use default level (3) when level 0 is specified', () => {
      const withZero = zstdCompress(data, 0);
      const withDefault = zstdCompress(data, 3);
      // Level 0 means "use default (3)", so output should be identical
      expect(Buffer.compare(withZero, withDefault)).toBe(0);
    });

    it('should work with very negative level (-131072)', () => {
      const compressed = zstdCompress(data, -131072);
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });
  });

  describe('brotli quality boundary values', () => {
    it('should work with quality 0 (fastest)', () => {
      const compressed = brotliCompress(data, 0);
      const decompressed = brotliDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should work with quality 11 (best compression)', () => {
      const compressed = brotliCompress(data, 11);
      const decompressed = brotliDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should throw with quality 12 (above max)', () => {
      expect(() => brotliCompress(data, 12)).toThrow(/quality must be between 0 and 11/);
    });

    it('should throw with BrotliCompressContext quality 12', () => {
      expect(() => new BrotliCompressContext(12)).toThrow(/quality must be between 0 and 11/);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-algorithm verification (magic bytes)
// ---------------------------------------------------------------------------

describe('cross-algorithm verification', () => {
  const data = Buffer.from('Magic bytes verification test data '.repeat(20));

  describe('gzip magic bytes', () => {
    it('should have gzip magic bytes (0x1f, 0x8b) at start of compressed output', () => {
      const compressed = gzipCompress(data);
      expect(compressed[0]).toBe(0x1f);
      expect(compressed[1]).toBe(0x8b);
    });

    it('should have gzip magic bytes in streaming compressed output', async () => {
      const stream = toChunkedStream(data, 64);
      const compressed = await collectStream(stream.pipeThrough(createGzipCompressStream()));
      expect(compressed[0]).toBe(0x1f);
      expect(compressed[1]).toBe(0x8b);
    });
  });

  describe('zstd magic number', () => {
    it('should have zstd magic number (0x28, 0xB5, 0x2F, 0xFD) at start of compressed output', () => {
      const compressed = zstdCompress(data);
      // Zstd magic number is 0xFD2FB528 in little-endian: bytes 0x28, 0xB5, 0x2F, 0xFD
      expect(compressed[0]).toBe(0x28);
      expect(compressed[1]).toBe(0xb5);
      expect(compressed[2]).toBe(0x2f);
      expect(compressed[3]).toBe(0xfd);
    });

    it('should have zstd magic number in streaming compressed output', async () => {
      const stream = toChunkedStream(data, 64);
      const compressed = await collectStream(stream.pipeThrough(createZstdCompressStream()));
      expect(compressed[0]).toBe(0x28);
      expect(compressed[1]).toBe(0xb5);
      expect(compressed[2]).toBe(0x2f);
      expect(compressed[3]).toBe(0xfd);
    });
  });
});
