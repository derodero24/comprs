import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { version, zstdCompress, zstdDecompress, zstdDecompressWithCapacity } from '../index.js';

const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')).version;

describe('zflate', () => {
  it('should return the package version', () => {
    expect(version()).toBe(pkgVersion);
  });
});

describe('zstdCompress', () => {
  const data = Buffer.from('Hello, zflate! '.repeat(100));

  it('should compress data with default level', () => {
    const compressed = zstdCompress(data);
    expect(compressed.length).toBeLessThan(data.length);
  });

  it('should produce valid output that decompresses back', () => {
    const compressed = zstdCompress(data);
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should handle empty buffer', () => {
    const empty = Buffer.alloc(0);
    const compressed = zstdCompress(empty);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('should handle single byte', () => {
    const single = Buffer.from([42]);
    const compressed = zstdCompress(single);
    const decompressed = zstdDecompress(compressed);
    expect(Buffer.compare(decompressed, single)).toBe(0);
  });

  describe('compression levels', () => {
    it('should accept level 0 (uses default)', () => {
      const compressed = zstdCompress(data, 0);
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should accept negative levels for fast compression', () => {
      const compressed = zstdCompress(data, -1);
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should accept level 22 (maximum standard level)', () => {
      const compressed = zstdCompress(data, 22);
      const decompressed = zstdDecompress(compressed);
      expect(Buffer.compare(decompressed, data)).toBe(0);
    });

    it('should produce smaller output at higher levels for compressible data', () => {
      const fast = zstdCompress(data, 1);
      const best = zstdCompress(data, 19);
      expect(best.length).toBeLessThanOrEqual(fast.length);
    });
  });
});

describe('zstdDecompress', () => {
  it('should decompress valid compressed data', () => {
    const original = Buffer.from('Test data for decompression');
    const compressed = zstdCompress(original);
    const result = zstdDecompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw on invalid input', () => {
    const invalid = Buffer.from('not valid zstd data');
    expect(() => zstdDecompress(invalid)).toThrow();
  });

  it('should handle data compressed at different levels', () => {
    const original = Buffer.from('Level test '.repeat(50));
    for (const level of [1, 3, 10, 22]) {
      const compressed = zstdCompress(original, level);
      const result = zstdDecompress(compressed);
      expect(Buffer.compare(result, original)).toBe(0);
    }
  });

  it('should handle incompressible random data', () => {
    const random = randomBytes(1024);
    const compressed = zstdCompress(random);
    const result = zstdDecompress(compressed);
    expect(Buffer.compare(result, random)).toBe(0);
  });
});

describe('zstdDecompressWithCapacity', () => {
  const original = Buffer.from('Capacity test data '.repeat(100));
  const compressed = zstdCompress(original);

  it('should decompress with exact capacity', () => {
    const result = zstdDecompressWithCapacity(compressed, original.length);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const result = zstdDecompressWithCapacity(compressed, original.length * 10);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, 1)).toThrow(
      /Destination buffer is too small/,
    );
  });

  it('should throw with negative capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, -1)).toThrow(
      /capacity must be a non-negative integer/,
    );
  });

  it('should throw with NaN capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, NaN)).toThrow(
      /capacity must be a non-negative integer/,
    );
  });

  it('should throw with Infinity capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, Infinity)).toThrow(
      /capacity must be a non-negative integer/,
    );
  });

  it('should throw with fractional capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, 1.5)).toThrow(
      /capacity must be a non-negative integer/,
    );
  });

  it('should throw with excessively large capacity', () => {
    expect(() => zstdDecompressWithCapacity(compressed, Number.MAX_VALUE)).toThrow(
      /capacity must be a non-negative integer/,
    );
  });

  it('should accept capacity of 0 for empty data', () => {
    const empty = Buffer.alloc(0);
    const emptyCompressed = zstdCompress(empty);
    const result = zstdDecompressWithCapacity(emptyCompressed, 0);
    expect(result.length).toBe(0);
  });
});
