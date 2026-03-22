import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliCompressAsync,
  brotliDecompressAsync,
  brotliDecompressWithCapacityAsync,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompressAsync,
  deflateDecompressWithCapacityAsync,
  gzipCompress,
  gzipCompressAsync,
  gzipDecompressAsync,
  gzipDecompressWithCapacityAsync,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdCompressWithDictAsync,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDict,
  zstdDecompressWithDictAsync,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
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

describe('decompress async (auto-detect)', () => {
  const original = Buffer.from('Hello, async auto-detect decompression!');

  it('should auto-detect and decompress zstd', async () => {
    const compressed = zstdCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress gzip', async () => {
    const compressed = gzipCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-detect and decompress brotli', async () => {
    const compressed = brotliCompress(original);
    const result = await decompressAsync(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should reject unknown format', async () => {
    const data = Buffer.from('not compressed');
    await expect(decompressAsync(data)).rejects.toThrow(/unable to detect compression format/);
  });

  it('should produce the same output as sync decompress', async () => {
    const compressed = zstdCompress(original);
    const syncResult = decompress(compressed);
    const asyncResult = await decompressAsync(compressed);
    expect(Buffer.compare(asyncResult, syncResult)).toBe(0);
  });
});

describe('zstdDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async zstd with capacity!');
    const compressed = zstdCompress(input);
    const decompressed = await zstdDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', () => {
    const compressed = zstdCompress(Buffer.from('test'));
    expect(() => zstdDecompressWithCapacityAsync(compressed, -1)).toThrow(
      'capacity must be a non-negative integer',
    );
  });
});

describe('zstdCompressWithDictAsync / zstdDecompressWithDictAsync', () => {
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

  it('should round-trip with dictionary', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 999,
        name: 'test_user',
        email: 'test@example.com',
        active: true,
      }),
    );
    const compressed = await zstdCompressWithDictAsync(original, dict);
    const decompressed = await zstdDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop async compress with sync decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 42,
        name: 'interop_user',
        email: 'interop@example.com',
        active: false,
      }),
    );
    const compressed = await zstdCompressWithDictAsync(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });

  it('should interop sync compress with async decompress', async () => {
    const dict = zstdTrainDictionary(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 77,
        name: 'interop_user_2',
        email: 'interop2@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = await zstdDecompressWithDictAsync(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('zstdTrainDictionaryAsync', () => {
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

  it('should train a valid dictionary', async () => {
    const dict = await zstdTrainDictionaryAsync(samples);
    expect(dict.length).toBeGreaterThan(0);
  });

  it('should produce a dictionary usable for compression', async () => {
    const dict = await zstdTrainDictionaryAsync(samples);
    const original = Buffer.from(
      JSON.stringify({
        id: 123,
        name: 'async_dict_user',
        email: 'async@example.com',
        active: true,
      }),
    );
    const compressed = zstdCompressWithDict(original, dict);
    const decompressed = zstdDecompressWithDict(compressed, dict);
    expect(Buffer.compare(decompressed, original)).toBe(0);
  });
});

describe('gzipDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async gzip with capacity!');
    const compressed = gzipCompress(input);
    const decompressed = await gzipDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', () => {
    const compressed = gzipCompress(Buffer.from('test'));
    expect(() => gzipDecompressWithCapacityAsync(compressed, -1)).toThrow(
      'capacity must be a non-negative integer',
    );
  });
});

describe('deflateDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async deflate with capacity!');
    const compressed = deflateCompress(input);
    const decompressed = await deflateDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', () => {
    const compressed = deflateCompress(Buffer.from('test'));
    expect(() => deflateDecompressWithCapacityAsync(compressed, -1)).toThrow(
      'capacity must be a non-negative integer',
    );
  });
});

describe('brotliDecompressWithCapacityAsync', () => {
  it('should round-trip with capacity', async () => {
    const input = Buffer.from('Hello, async brotli with capacity!');
    const compressed = brotliCompress(input);
    const decompressed = await brotliDecompressWithCapacityAsync(compressed, 1024 * 1024);
    expect(Buffer.compare(decompressed, input)).toBe(0);
  });

  it('should reject with invalid capacity', () => {
    const compressed = brotliCompress(Buffer.from('test'));
    expect(() => brotliDecompressWithCapacityAsync(compressed, -1)).toThrow(
      'capacity must be a non-negative integer',
    );
  });
});
