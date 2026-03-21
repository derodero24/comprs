import { describe, expect, it } from 'vitest';
import {
  BrotliDecompressContext,
  brotliCompress,
  DeflateDecompressContext,
  deflateCompress,
  GzipDecompressContext,
  gzipCompress,
  ZstdDecompressContext,
  ZstdDecompressDictContext,
  zstdCompress,
  zstdCompressWithDict,
  zstdTrainDictionary,
} from '../index.js';
import {
  createBrotliDecompressStream,
  createDecompressStream,
  createDeflateDecompressStream,
  createGzipDecompressStream,
  createZstdDecompressDictStream,
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

/** Fully decompress using a context (transform + finish/flush), returning all output. */
function decompressAll(
  ctx: { transform(chunk: Buffer): Buffer; finish?: () => Buffer; flush?: () => Buffer },
  compressed: Buffer,
): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(ctx.transform(compressed));
  if (ctx.flush) chunks.push(ctx.flush());
  if (ctx.finish) chunks.push(ctx.finish());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Custom maxOutputSize enforcement on decompression contexts
// ---------------------------------------------------------------------------

describe('maxOutputSize on decompression contexts', () => {
  // Use a large enough buffer that the decompressed output exceeds the limit.
  // 4096 bytes of repeating data compresses very well.
  const originalData = Buffer.alloc(4096, 0x42);

  describe('GzipDecompressContext', () => {
    const compressed = gzipCompress(originalData);

    it('should enforce custom maxOutputSize', () => {
      const ctx = new GzipDecompressContext(100);
      // Gzip buffers internally; the error may occur in transform or finish
      expect(() => decompressAll(ctx, compressed)).toThrow(/exceeded maximum size/);
    });

    it('should decompress normally when maxOutputSize is omitted', () => {
      const ctx = new GzipDecompressContext();
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });

    it('should decompress normally when maxOutputSize is large enough', () => {
      const ctx = new GzipDecompressContext(8192);
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });
  });

  describe('DeflateDecompressContext', () => {
    const compressed = deflateCompress(originalData);

    it('should enforce custom maxOutputSize', () => {
      const ctx = new DeflateDecompressContext(100);
      expect(() => decompressAll(ctx, compressed)).toThrow(/exceeded maximum size/);
    });

    it('should decompress normally when maxOutputSize is omitted', () => {
      const ctx = new DeflateDecompressContext();
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });

    it('should decompress normally when maxOutputSize is large enough', () => {
      const ctx = new DeflateDecompressContext(8192);
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });
  });

  describe('ZstdDecompressContext', () => {
    const compressed = zstdCompress(originalData);

    it('should enforce custom maxOutputSize', () => {
      const ctx = new ZstdDecompressContext(100);
      expect(() => ctx.transform(compressed)).toThrow(/exceeded maximum size/);
    });

    it('should decompress normally when maxOutputSize is omitted', () => {
      const ctx = new ZstdDecompressContext();
      const result = ctx.transform(compressed);
      expect(result.byteLength).toBe(4096);
    });

    it('should decompress normally when maxOutputSize is large enough', () => {
      const ctx = new ZstdDecompressContext(8192);
      const result = ctx.transform(compressed);
      expect(result.byteLength).toBe(4096);
    });
  });

  describe('BrotliDecompressContext', () => {
    const compressed = brotliCompress(originalData);

    it('should enforce custom maxOutputSize', () => {
      const ctx = new BrotliDecompressContext(100);
      expect(() => decompressAll(ctx, compressed)).toThrow(/exceeded maximum size/);
    });

    it('should decompress normally when maxOutputSize is omitted', () => {
      const ctx = new BrotliDecompressContext();
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });

    it('should decompress normally when maxOutputSize is large enough', () => {
      const ctx = new BrotliDecompressContext(8192);
      const result = decompressAll(ctx, compressed);
      expect(result.byteLength).toBe(4096);
    });
  });

  describe('ZstdDecompressDictContext', () => {
    // Train a minimal dictionary from sample data
    const samples = Array.from({ length: 10 }, (_, i) =>
      Buffer.from(`sample data entry ${i} `.repeat(20)),
    );
    const dict = zstdTrainDictionary(samples, 4096);
    const testData = Buffer.from('sample data entry 0 '.repeat(200));
    const compressed = zstdCompressWithDict(testData, dict);

    it('should enforce custom maxOutputSize', () => {
      const ctx = new ZstdDecompressDictContext(dict, 100);
      expect(() => ctx.transform(compressed)).toThrow(/exceeded maximum size/);
    });

    it('should decompress normally when maxOutputSize is omitted', () => {
      const ctx = new ZstdDecompressDictContext(dict);
      const result = ctx.transform(compressed);
      expect(result.byteLength).toBe(testData.byteLength);
    });
  });
});

// ---------------------------------------------------------------------------
// Validation of invalid maxOutputSize values
// ---------------------------------------------------------------------------

describe('maxOutputSize validation', () => {
  it('should throw for NaN', () => {
    expect(() => new GzipDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
  });

  it('should throw for Infinity', () => {
    expect(() => new GzipDecompressContext(Number.POSITIVE_INFINITY)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
  });

  it('should throw for negative Infinity', () => {
    expect(() => new GzipDecompressContext(Number.NEGATIVE_INFINITY)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
  });

  it('should throw for negative values', () => {
    expect(() => new GzipDecompressContext(-1)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
  });

  it('should accept zero as maxOutputSize', () => {
    // Zero means "no output allowed" — valid edge case
    const ctx = new GzipDecompressContext(0);
    const compressed = gzipCompress(Buffer.alloc(1024, 0x42));
    expect(() => decompressAll(ctx, compressed)).toThrow(/exceeded maximum size/);
  });

  it('should validate on all context types', () => {
    expect(() => new DeflateDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
    expect(() => new ZstdDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
    expect(() => new BrotliDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be a positive finite number/,
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming factory functions pass through maxOutputSize
// ---------------------------------------------------------------------------

describe('streaming factory functions with maxOutputSize', () => {
  const originalData = Buffer.alloc(4096, 0x42);

  it('should enforce maxOutputSize on createGzipDecompressStream', async () => {
    const compressed = gzipCompress(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(collectStream(input.pipeThrough(createGzipDecompressStream(100)))).rejects.toThrow(
      /exceeded maximum size/,
    );
  });

  it('should enforce maxOutputSize on createDeflateDecompressStream', async () => {
    const compressed = deflateCompress(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(
      collectStream(input.pipeThrough(createDeflateDecompressStream(100))),
    ).rejects.toThrow(/exceeded maximum size/);
  });

  it('should enforce maxOutputSize on createZstdDecompressStream', async () => {
    const compressed = zstdCompress(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(collectStream(input.pipeThrough(createZstdDecompressStream(100)))).rejects.toThrow(
      /exceeded maximum size/,
    );
  });

  it('should enforce maxOutputSize on createBrotliDecompressStream', async () => {
    const compressed = brotliCompress(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(
      collectStream(input.pipeThrough(createBrotliDecompressStream(100))),
    ).rejects.toThrow(/exceeded maximum size/);
  });

  it('should enforce maxOutputSize on createDecompressStream (gzip)', async () => {
    const compressed = gzipCompress(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(collectStream(input.pipeThrough(createDecompressStream(100)))).rejects.toThrow(
      /exceeded maximum size/,
    );
  });

  it('should enforce maxOutputSize on createZstdDecompressDictStream', async () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      Buffer.from(`sample data entry ${i} `.repeat(20)),
    );
    const dict = zstdTrainDictionary(samples, 4096);
    const testData = Buffer.from('sample data entry 0 '.repeat(200));
    const compressed = zstdCompressWithDict(testData, dict);

    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(compressed));
        controller.close();
      },
    });
    await expect(
      collectStream(input.pipeThrough(createZstdDecompressDictStream(dict, 100))),
    ).rejects.toThrow(/exceeded maximum size/);
  });
});
