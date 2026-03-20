import { describe, expect, it } from 'vitest';
import { zstdCompress, zstdDecompress, zstdDecompressWithCapacity } from '../index.js';

describe('zstdCompress / zstdDecompress', () => {
  it('should round-trip a simple string', () => {
    const input = Buffer.from('Hello, zflate!');
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', () => {
    const input = Buffer.alloc(0);
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip a 1-byte buffer', () => {
    const input = Buffer.from([42]);
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1KB of data', () => {
    const input = Buffer.alloc(1024, 'a');
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1MB of data', { timeout: 30_000 }, () => {
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should actually compress repetitive data', () => {
    const input = Buffer.alloc(10000, 'x');
    const compressed = zstdCompress(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('should compress with different levels', () => {
    const input = Buffer.from('Repeating data for compression. '.repeat(100));
    const fast = zstdCompress(input, 1);
    const normal = zstdCompress(input, 3);
    const best = zstdCompress(input, 19);

    // All should decompress to the same data
    expect(zstdDecompress(fast)).toEqual(input);
    expect(zstdDecompress(normal)).toEqual(input);
    expect(zstdDecompress(best)).toEqual(input);

    // Higher levels should produce smaller or equal output
    expect(best.length).toBeLessThanOrEqual(normal.length);
    expect(normal.length).toBeLessThanOrEqual(fast.length);
  });

  it('should use default level (3) when level is not specified', () => {
    const input = Buffer.from('test data '.repeat(50));
    const withDefault = zstdCompress(input);
    const withExplicit3 = zstdCompress(input, 3);
    expect(withDefault).toEqual(withExplicit3);
  });

  it('should throw on invalid compressed data', () => {
    const invalid = Buffer.from('this is not zstd data');
    expect(() => zstdDecompress(invalid)).toThrow();
  });
});

describe('zstdDecompressWithCapacity', () => {
  it('should decompress with explicit capacity', () => {
    const input = Buffer.from('Hello with capacity!');
    const compressed = zstdCompress(input);
    const decompressed = zstdDecompressWithCapacity(compressed, input.length);
    expect(decompressed).toEqual(input);
  });
});
