import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliCompressAsync,
  brotliDecompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompressAsync,
  gzipCompress,
  gzipCompressAsync,
  gzipDecompressAsync,
  zstdCompress,
  zstdCompressAsync,
  zstdDecompress,
  zstdDecompressAsync,
} from '../index.js';

describe('zstd async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = zstdCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async zstd!');
    const compressed = await zstdCompressAsync(input);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await zstdCompressAsync(input);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = zstdCompress(input);
    const asyncResult = await zstdCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await zstdCompressAsync(input, 1);
    const decompressed = await zstdDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not zstd data');
    await expect(zstdDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('gzip async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = gzipCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async gzip!');
    const compressed = await gzipCompressAsync(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await gzipCompressAsync(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = gzipCompress(input);
    const asyncResult = await gzipCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await gzipCompressAsync(input, 1);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should throw on invalid level', () => {
    const input = Buffer.from('test');
    expect(() => gzipCompressAsync(input, 10)).toThrow(
      'gzip compression level must be between 0 and 9',
    );
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not gzip data');
    await expect(gzipDecompressAsync(invalid)).rejects.toThrow();
  });

  it('should decompress concatenated gzip streams', async () => {
    const a = gzipCompress(Buffer.from('Hello'));
    const b = gzipCompress(Buffer.from(' World'));
    const concatenated = Buffer.concat([a, b]);
    const result = await gzipDecompressAsync(concatenated);
    expect(result.toString()).toBe('Hello World');
  });
});

describe('deflate async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = deflateCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async deflate!');
    const compressed = await deflateCompressAsync(input);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await deflateCompressAsync(input);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = deflateCompress(input);
    const asyncResult = await deflateCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom level', async () => {
    const input = Buffer.from('Custom level test data. '.repeat(100));
    const compressed = await deflateCompressAsync(input, 1);
    const decompressed = await deflateDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should throw on invalid level', () => {
    const input = Buffer.from('test');
    expect(() => deflateCompressAsync(input, 10)).toThrow(
      'deflate compression level must be between 0 and 9',
    );
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not deflate data');
    await expect(deflateDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('brotli async', () => {
  it('should return a Promise', () => {
    const input = Buffer.from('hello');
    const result = brotliCompressAsync(input);
    expect(result).toBeInstanceOf(Promise);
  });

  it('should round-trip a simple string', async () => {
    const input = Buffer.from('Hello, async brotli!');
    const compressed = await brotliCompressAsync(input);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', async () => {
    const input = Buffer.alloc(0);
    const compressed = await brotliCompressAsync(input);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should produce the same output as sync', async () => {
    const input = Buffer.from('Sync vs async comparison data. '.repeat(50));
    const syncResult = brotliCompress(input);
    const asyncResult = await brotliCompressAsync(input);
    expect(asyncResult).toEqual(syncResult);
  });

  it('should compress with a custom quality', async () => {
    const input = Buffer.from('Custom quality test data. '.repeat(100));
    const compressed = await brotliCompressAsync(input, 1);
    const decompressed = await brotliDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should throw on invalid quality', () => {
    const input = Buffer.from('test');
    expect(() => brotliCompressAsync(input, 12)).toThrow('brotli quality must be between 0 and 11');
  });

  it('should reject on invalid compressed data', async () => {
    const invalid = Buffer.from('not brotli data');
    await expect(brotliDecompressAsync(invalid)).rejects.toThrow();
  });
});

describe('async cross-algorithm', () => {
  it('should async compress and sync decompress (zstd)', async () => {
    const input = Buffer.from('Cross async/sync test');
    const compressed = await zstdCompressAsync(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should sync compress and async decompress (gzip)', async () => {
    const input = Buffer.from('Cross sync/async test');
    const compressed = gzipCompress(input);
    const decompressed = await gzipDecompressAsync(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should handle concurrent async operations', async () => {
    const input = Buffer.from('Concurrent test data. '.repeat(50));
    const [zstdResult, gzipResult, deflateResult, brotliResult] = await Promise.all([
      zstdCompressAsync(input),
      gzipCompressAsync(input),
      deflateCompressAsync(input),
      brotliCompressAsync(input),
    ]);

    const [zstdDecomp, gzipDecomp, deflateDecomp, brotliDecomp] = await Promise.all([
      zstdDecompressAsync(zstdResult),
      gzipDecompressAsync(gzipResult),
      deflateDecompressAsync(deflateResult),
      brotliDecompressAsync(brotliResult),
    ]);

    expect(zstdDecomp).toEqual(input);
    expect(gzipDecomp).toEqual(input);
    expect(deflateDecomp).toEqual(input);
    expect(brotliDecomp).toEqual(input);
  });
});
