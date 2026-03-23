import * as zlib from 'node:zlib';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
} from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  brotliDecompress,
  deflateCompress,
  deflateDecompress,
  gzipCompress,
  gzipDecompress,
  zstdCompress,
  zstdDecompress,
} from '../index.js';

// Check if zstd is available in current Node.js version (22.15+)
const zstdAvailable = 'zstdCompressSync' in zlib;

describe('brotli Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with brotli compression!'.repeat(10));

  it('comprs brotli output should be decompressible by node:zlib', () => {
    const compressed = brotliCompress(testData);
    const decompressed = brotliDecompressSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib brotli output should be decompressible by comprs', () => {
    const compressed = brotliCompressSync(testData);
    const decompressed = brotliDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different quality levels', () => {
    for (const quality of [0, 4, 11]) {
      const compressed = brotliCompress(testData, quality);
      const decompressed = brotliDecompressSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    // comprs compress -> node decompress -> node compress -> comprs decompress
    const step1 = brotliCompress(testData);
    const step2 = brotliDecompressSync(step1);
    const step3 = brotliCompressSync(step2);
    const step4 = brotliDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe('gzip Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with gzip compression!'.repeat(10));

  it('comprs gzip output should be decompressible by node:zlib', () => {
    const compressed = gzipCompress(testData);
    const decompressed = gunzipSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib gzip output should be decompressible by comprs', () => {
    const compressed = gzipSync(testData);
    const decompressed = gzipDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 6, 9]) {
      const compressed = gzipCompress(testData, level);
      const decompressed = gunzipSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = gzipCompress(testData);
    const step2 = gunzipSync(step1);
    const step3 = gzipSync(step2);
    const step4 = gzipDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe('deflate Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with deflate compression!'.repeat(10));

  it('comprs deflate output should be decompressible by node:zlib', () => {
    const compressed = deflateCompress(testData);
    const decompressed = inflateRawSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib deflate output should be decompressible by comprs', () => {
    const compressed = deflateRawSync(testData);
    const decompressed = deflateDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 6, 9]) {
      const compressed = deflateCompress(testData, level);
      const decompressed = inflateRawSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = deflateCompress(testData);
    const step2 = inflateRawSync(step1);
    const step3 = deflateRawSync(step2);
    const step4 = deflateDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe.skipIf(!zstdAvailable)('zstd Node.js zlib interop', () => {
  const testData = Buffer.from('Hello, interop testing with zstd compression!'.repeat(10));

  // Cast to access experimental zstd functions
  // biome-ignore lint/suspicious/noExplicitAny: zstd is experimental and not in all type definitions
  const zlibWithZstd = zlib as any;

  it('comprs zstd output should be decompressible by node:zlib', () => {
    const compressed = zstdCompress(testData);
    const decompressed = zlibWithZstd.zstdDecompressSync(compressed);
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('node:zlib zstd output should be decompressible by comprs', () => {
    const compressed = zlibWithZstd.zstdCompressSync(testData);
    const decompressed = zstdDecompress(Buffer.from(compressed));
    expect(Buffer.from(decompressed)).toEqual(testData);
  });

  it('should interop at different compression levels', () => {
    for (const level of [1, 3, 19]) {
      const compressed = zstdCompress(testData, level);
      const decompressed = zlibWithZstd.zstdDecompressSync(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    }
  });

  it('should round-trip through both implementations', () => {
    const step1 = zstdCompress(testData);
    const step2 = zlibWithZstd.zstdDecompressSync(step1);
    const step3 = zlibWithZstd.zstdCompressSync(step2);
    const step4 = zstdDecompress(Buffer.from(step3));
    expect(Buffer.from(step4)).toEqual(testData);
  });
});

describe('cross-algorithm output differentiation', () => {
  const data = Buffer.from('Test data for cross-algorithm verification'.repeat(10));

  it('same input produces different compressed output per algorithm', () => {
    const zstd = zstdCompress(data);
    const gzip = gzipCompress(data);
    const brotli = brotliCompress(data);
    const deflate = deflateCompress(data);

    // All should be different from each other
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(gzip));
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(brotli));
    expect(Buffer.from(zstd)).not.toEqual(Buffer.from(deflate));
    expect(Buffer.from(gzip)).not.toEqual(Buffer.from(brotli));
    expect(Buffer.from(gzip)).not.toEqual(Buffer.from(deflate));
    expect(Buffer.from(brotli)).not.toEqual(Buffer.from(deflate));
  });

  it('all algorithms decompress back to the original data', () => {
    expect(Buffer.from(zstdDecompress(zstdCompress(data)))).toEqual(data);
    expect(Buffer.from(gzipDecompress(gzipCompress(data)))).toEqual(data);
    expect(Buffer.from(brotliDecompress(brotliCompress(data)))).toEqual(data);
    expect(Buffer.from(deflateDecompress(deflateCompress(data)))).toEqual(data);
  });

  it('compressed output has distinct magic bytes per format', () => {
    const zstd = zstdCompress(data);
    const gzip = gzipCompress(data);
    const brotli = brotliCompress(data);

    // zstd magic number: 0xFD2FB528 (little-endian)
    expect(zstd[0]).toBe(0x28);
    expect(zstd[1]).toBe(0xb5);
    expect(zstd[2]).toBe(0x2f);
    expect(zstd[3]).toBe(0xfd);

    // gzip magic number: 0x1F8B
    expect(gzip[0]).toBe(0x1f);
    expect(gzip[1]).toBe(0x8b);

    // brotli has no fixed magic bytes, but first byte should differ from others
    expect(brotli[0]).not.toBe(0x28); // not zstd
    expect(brotli[0]).not.toBe(0x1f); // not gzip
  });
});
