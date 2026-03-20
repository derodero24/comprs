import { randomBytes } from 'node:crypto';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  DeflateCompressContext,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  GzipCompressContext,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
} from '../index.js';

describe('gzipCompress / gzipDecompress', () => {
  it('should round-trip a simple string', () => {
    const input = Buffer.from('Hello, zflate!');
    const compressed = gzipCompress(input);
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', () => {
    const input = Buffer.alloc(0);
    const compressed = gzipCompress(input);
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip a 1-byte buffer', () => {
    const input = Buffer.from([42]);
    const compressed = gzipCompress(input);
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1KB of data', () => {
    const input = Buffer.alloc(1024, 'a');
    const compressed = gzipCompress(input);
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1MB of data', { timeout: 30_000 }, () => {
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    const compressed = gzipCompress(input);
    const decompressed = gzipDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should actually compress repetitive data', () => {
    const input = Buffer.alloc(10000, 'x');
    const compressed = gzipCompress(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('should compress with different levels', () => {
    const input = Buffer.from('Repeating data for compression. '.repeat(100));
    const fast = gzipCompress(input, 1);
    const normal = gzipCompress(input, 6);
    const best = gzipCompress(input, 9);

    // All should decompress to the same data
    expect(gzipDecompress(fast)).toEqual(input);
    expect(gzipDecompress(normal)).toEqual(input);
    expect(gzipDecompress(best)).toEqual(input);

    // Higher levels should produce smaller or equal output
    expect(best.length).toBeLessThanOrEqual(normal.length);
    expect(normal.length).toBeLessThanOrEqual(fast.length);
  });

  it('should throw on level > 9', () => {
    const input = Buffer.from('test');
    expect(() => gzipCompress(input, 10)).toThrow(/level must be between 0 and 9/);
  });

  it('should throw on very high level', () => {
    const input = Buffer.from('test');
    expect(() => gzipCompress(input, 100)).toThrow(/level must be between 0 and 9/);
  });

  it('should accept level 0 and level 9', () => {
    const input = Buffer.from('test');
    expect(() => gzipCompress(input, 0)).not.toThrow();
    expect(() => gzipCompress(input, 9)).not.toThrow();
  });

  it('should throw on invalid compressed data', () => {
    const invalid = Buffer.from('this is not gzip data');
    expect(() => gzipDecompress(invalid)).toThrow();
  });

  it('should handle incompressible random data', () => {
    const random = randomBytes(1024);
    const compressed = gzipCompress(random);
    const result = gzipDecompress(compressed);
    expect(Buffer.compare(result, random)).toBe(0);
  });
});

describe('gzipDecompressWithCapacity', () => {
  const original = Buffer.from('Capacity test data '.repeat(100));
  const compressed = gzipCompress(original);

  it('should decompress with exact capacity', () => {
    const result = gzipDecompressWithCapacity(compressed, original.length);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const result = gzipDecompressWithCapacity(compressed, original.length * 10);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    expect(() => gzipDecompressWithCapacity(compressed, 1)).toThrow(/exceeded maximum size/);
  });

  it('should throw with negative capacity', () => {
    expect(() => gzipDecompressWithCapacity(compressed, -1)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with NaN capacity', () => {
    expect(() => gzipDecompressWithCapacity(compressed, NaN)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with Infinity capacity', () => {
    expect(() => gzipDecompressWithCapacity(compressed, Infinity)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should accept capacity of 0 for empty data', () => {
    const empty = Buffer.alloc(0);
    const emptyCompressed = gzipCompress(empty);
    const result = gzipDecompressWithCapacity(emptyCompressed, 0);
    expect(result.length).toBe(0);
  });
});

describe('gzip interop with Node.js zlib', () => {
  const data = Buffer.from('Interoperability test data '.repeat(50));

  it('should decompress Node.js gzipSync output', () => {
    const compressed = gzipSync(data);
    const decompressed = gzipDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should produce output decompressible by Node.js gunzipSync', () => {
    const compressed = gzipCompress(data);
    const decompressed = gunzipSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should produce valid gzip header (magic bytes)', () => {
    const compressed = gzipCompress(data);
    // Gzip magic number: 0x1f 0x8b
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });
});

describe('deflateCompress / deflateDecompress', () => {
  it('should round-trip a simple string', () => {
    const input = Buffer.from('Hello, raw deflate!');
    const compressed = deflateCompress(input);
    const decompressed = deflateDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip empty data', () => {
    const input = Buffer.alloc(0);
    const compressed = deflateCompress(input);
    const decompressed = deflateDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should round-trip 1MB of data', { timeout: 30_000 }, () => {
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = i % 256;
    }
    const compressed = deflateCompress(input);
    const decompressed = deflateDecompress(compressed);
    expect(decompressed).toEqual(input);
  });

  it('should actually compress repetitive data', () => {
    const input = Buffer.alloc(10000, 'x');
    const compressed = deflateCompress(input);
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('should throw on level > 9', () => {
    const input = Buffer.from('test');
    expect(() => deflateCompress(input, 10)).toThrow(/level must be between 0 and 9/);
  });

  it('should throw on very high level', () => {
    const input = Buffer.from('test');
    expect(() => deflateCompress(input, 100)).toThrow(/level must be between 0 and 9/);
  });

  it('should accept level 0 and level 9', () => {
    const input = Buffer.from('test');
    expect(() => deflateCompress(input, 0)).not.toThrow();
    expect(() => deflateCompress(input, 9)).not.toThrow();
  });

  it('should throw on invalid compressed data', () => {
    const invalid = Buffer.from('this is not deflate data');
    expect(() => deflateDecompress(invalid)).toThrow();
  });

  it('should handle incompressible random data', () => {
    const random = randomBytes(1024);
    const compressed = deflateCompress(random);
    const result = deflateDecompress(compressed);
    expect(Buffer.compare(result, random)).toBe(0);
  });
});

describe('deflateDecompressWithCapacity', () => {
  const original = Buffer.from('Capacity test data '.repeat(100));
  const compressed = deflateCompress(original);

  it('should decompress with exact capacity', () => {
    const result = deflateDecompressWithCapacity(compressed, original.length);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should decompress with oversized capacity', () => {
    const result = deflateDecompressWithCapacity(compressed, original.length * 10);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw with insufficient capacity', () => {
    expect(() => deflateDecompressWithCapacity(compressed, 1)).toThrow(/exceeded maximum size/);
  });

  it('should throw with negative capacity', () => {
    expect(() => deflateDecompressWithCapacity(compressed, -1)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with NaN capacity', () => {
    expect(() => deflateDecompressWithCapacity(compressed, NaN)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should throw with Infinity capacity', () => {
    expect(() => deflateDecompressWithCapacity(compressed, Infinity)).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('should accept capacity of 0 for empty data', () => {
    const empty = Buffer.alloc(0);
    const emptyCompressed = deflateCompress(empty);
    const result = deflateDecompressWithCapacity(emptyCompressed, 0);
    expect(result.length).toBe(0);
  });
});

describe('deflate interop with Node.js zlib', () => {
  const data = Buffer.from('Deflate interop test data '.repeat(50));

  it('should decompress Node.js deflateRawSync output', () => {
    const compressed = deflateRawSync(data);
    const decompressed = deflateDecompress(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });

  it('should produce output decompressible by Node.js inflateRawSync', () => {
    const compressed = deflateCompress(data);
    const decompressed = inflateRawSync(compressed);
    expect(Buffer.compare(decompressed, data)).toBe(0);
  });
});

describe('gzip vs deflate output difference', () => {
  it('should produce different output for gzip and deflate', () => {
    const data = Buffer.from('Test data for format comparison '.repeat(20));
    const gzipped = gzipCompress(data);
    const deflated = deflateCompress(data);

    // gzip has header/footer overhead, so it should be larger
    expect(gzipped.length).toBeGreaterThan(deflated.length);

    // Both should round-trip correctly
    expect(gzipDecompress(gzipped)).toEqual(data);
    expect(deflateDecompress(deflated)).toEqual(data);
  });
});

describe('GzipCompressContext level validation', () => {
  it('should throw on level > 9', () => {
    expect(() => new GzipCompressContext(10)).toThrow(/level must be between 0 and 9/);
  });

  it('should accept level 0 and level 9', () => {
    expect(() => new GzipCompressContext(0)).not.toThrow();
    expect(() => new GzipCompressContext(9)).not.toThrow();
  });
});

describe('DeflateCompressContext level validation', () => {
  it('should throw on level > 9', () => {
    expect(() => new DeflateCompressContext(10)).toThrow(/level must be between 0 and 9/);
  });

  it('should accept level 0 and level 9', () => {
    expect(() => new DeflateCompressContext(0)).not.toThrow();
    expect(() => new DeflateCompressContext(9)).not.toThrow();
  });
});
