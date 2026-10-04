import { describe, expect, it } from 'vitest';
import {
  BrotliDecompressContext,
  brotliCompress,
  DeflateDecompressContext,
  decompress,
  decompressAsync,
  deflateCompress,
  GzipDecompressContext,
  gzipCompress,
  Lz4DecompressContext,
  lz4Compress,
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
import { BOMB_FORMATS, type BombFormat, makeBomb, peakRssKiB } from './bomb-fixtures.js';

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

    it('should count the output returned by finish()', () => {
      // flate2 keeps up to 32 KiB of output internally, so all of it comes out
      // of finish() when flush() is skipped.
      const ctx = new GzipDecompressContext(1000);
      const compressed = gzipCompress(Buffer.alloc(30_000, 'a'));
      expect(() => {
        ctx.transform(compressed);
        ctx.finish();
      }).toThrow('gzip stream decompress exceeded maximum size of 1000 bytes');
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

    it('should count the output returned by finish()', () => {
      const ctx = new DeflateDecompressContext(1000);
      const compressed = deflateCompress(Buffer.alloc(30_000, 'a'));
      expect(() => {
        ctx.transform(compressed);
        ctx.finish();
      }).toThrow('deflate stream decompress exceeded maximum size of 1000 bytes');
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
// maxOutputSize on auto-detecting one-shot decompression
// ---------------------------------------------------------------------------

describe('maxOutputSize on decompress() and decompressAsync()', () => {
  const content = Buffer.from('Auto-detected decompression with a limit. '.repeat(100));
  const formats = [
    ['zstd', zstdCompress(content)],
    ['gzip', gzipCompress(content)],
    ['brotli', brotliCompress(content)],
    ['lz4', lz4Compress(content)],
  ] as const;

  it.each(formats)('%s: should decompress output up to the limit', async (_format, compressed) => {
    for (const maxOutputSize of [content.length, content.length + 1, Number.MAX_SAFE_INTEGER]) {
      expect(decompress(compressed, maxOutputSize)).toEqual(content);
      expect(await decompressAsync(compressed, maxOutputSize)).toEqual(content);
    }
  });

  it.each(formats)('%s: should reject output above the limit', async (format, compressed) => {
    for (const maxOutputSize of [0, content.length - 1]) {
      const message = `${format} decompress exceeded maximum size of ${maxOutputSize} bytes`;
      expect(() => decompress(compressed, maxOutputSize)).toThrow(message);
      await expect(decompressAsync(compressed, maxOutputSize)).rejects.toThrow(message);
    }
  });

  it.each(formats)('%s: should default to 256 MB when omitted', async (_format, compressed) => {
    for (const maxOutputSize of [undefined, null]) {
      expect(decompress(compressed, maxOutputSize)).toEqual(content);
      expect(await decompressAsync(compressed, maxOutputSize)).toEqual(content);
    }
  });

  it('should no longer ignore the limit', async () => {
    const compressed = gzipCompress(Buffer.alloc(1024 * 1024));
    const message = 'gzip decompress exceeded maximum size of 1024 bytes';
    expect(() => decompress(compressed, 1024)).toThrow(message);
    await expect(decompressAsync(compressed, 1024)).rejects.toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// Validation of invalid maxOutputSize values
// ---------------------------------------------------------------------------

describe('maxOutputSize validation', () => {
  it('should throw for NaN', () => {
    expect(() => new GzipDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
  });

  it('should throw for Infinity', () => {
    expect(() => new GzipDecompressContext(Number.POSITIVE_INFINITY)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
  });

  it('should throw for negative Infinity', () => {
    expect(() => new GzipDecompressContext(Number.NEGATIVE_INFINITY)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
  });

  it('should throw for negative values', () => {
    expect(() => new GzipDecompressContext(-1)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
  });

  it('should throw for fractions instead of truncating them', () => {
    for (const maxOutputSize of [0.5, 1.7, 4096.5]) {
      expect(() => new GzipDecompressContext(maxOutputSize)).toThrow(
        'maxOutputSize must be an integer between 0 and 9007199254740991',
      );
    }
  });

  it('should throw for values above Number.MAX_SAFE_INTEGER', () => {
    for (const maxOutputSize of [2 ** 53, 2 ** 64, Number.MAX_VALUE]) {
      expect(() => new GzipDecompressContext(maxOutputSize)).toThrow(
        'maxOutputSize must be an integer between 0 and 9007199254740991',
      );
    }
    expect(() => new GzipDecompressContext(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('should accept zero, which allows only streams that decompress to nothing', () => {
    const empty = Buffer.alloc(0);
    const data = Buffer.alloc(1024, 0x42);
    const contexts = [
      [gzipCompress, () => new GzipDecompressContext(0)],
      [deflateCompress, () => new DeflateDecompressContext(0)],
      [zstdCompress, () => new ZstdDecompressContext(0)],
      [brotliCompress, () => new BrotliDecompressContext(0)],
      [lz4Compress, () => new Lz4DecompressContext(0)],
    ] as const;
    for (const [compress, createContext] of contexts) {
      expect(decompressAll(createContext(), compress(empty))).toEqual(empty);
      expect(() => decompressAll(createContext(), compress(data))).toThrow(
        'exceeded maximum size of 0 bytes',
      );
    }
  });

  it('should validate on all context types', () => {
    expect(() => new DeflateDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
    expect(() => new ZstdDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
    );
    expect(() => new BrotliDecompressContext(Number.NaN)).toThrow(
      /maxOutputSize must be an integer between 0 and 9007199254740991/,
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

// ---------------------------------------------------------------------------
// maxOutputSize bounds memory, not only the returned output
// ---------------------------------------------------------------------------

describe('streaming decompression of a single highly compressible chunk', () => {
  const limit = 64 * 1024;
  const bombMiB = 128;
  const createStream: Record<
    BombFormat,
    (maxOutputSize: number) => TransformStream<Uint8Array, Uint8Array>
  > = {
    gzip: createGzipDecompressStream,
    deflate: createDeflateDecompressStream,
    brotli: createBrotliDecompressStream,
    zstd: createZstdDecompressStream,
  };

  it('should stop inflating once maxOutputSize is reached', async () => {
    const bombs = await Promise.all(
      BOMB_FORMATS.map(async (format) => ({ format, bomb: await makeBomb(format, bombMiB) })),
    );
    const peakBefore = peakRssKiB();

    for (const { format, bomb } of bombs) {
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bomb));
          controller.close();
        },
      });
      await expect(collectStream(input.pipeThrough(createStream[format](limit)))).rejects.toThrow(
        `exceeded maximum size of ${limit} bytes`,
      );
    }

    // Inflating any one of the chunks completely would add 128 MiB.
    expect(peakRssKiB() - peakBefore).toBeLessThan(32 * 1024);
  });
});
