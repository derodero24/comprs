import { describe, expect, it } from 'vitest';
import {
  brotliCompress,
  CompressionFormat,
  decompress,
  decompressAsync,
  deflateCompress,
  detectFormat,
  gzipCompress,
  lz4Compress,
  zstdCompress,
} from '../index.js';
import { lz4LegacyFrame, pseudoRandomBytes, ROWS, skippableFrame } from './detect-fixtures.js';

describe('detectFormat', () => {
  it('should detect zstd format', () => {
    const data = Buffer.from('test data for zstd detection');
    const compressed = zstdCompress(data);
    expect(detectFormat(compressed)).toBe('zstd');
  });

  it('should detect gzip format', () => {
    const data = Buffer.from('test data for gzip detection');
    const compressed = gzipCompress(data);
    expect(detectFormat(compressed)).toBe('gzip');
  });

  it('should detect brotli format', () => {
    const data = Buffer.from('test data for brotli detection');
    const compressed = brotliCompress(data);
    expect(detectFormat(compressed)).toBe('brotli');
  });

  it('should return unknown for raw deflate (no magic bytes)', () => {
    // Raw deflate has no magic bytes, cannot be auto-detected
    for (const data of [Buffer.from('test data for deflate'), ROWS]) {
      for (let level = 0; level <= 9; level++) {
        expect(detectFormat(deflateCompress(data, level))).toBe('unknown');
      }
    }
  });

  it('should return unknown for plain text', () => {
    const data = Buffer.from('this is not compressed data');
    expect(detectFormat(data)).toBe('unknown');
  });

  it('should return unknown for empty data', () => {
    expect(detectFormat(Buffer.alloc(0))).toBe('unknown');
  });

  it('should accept Uint8Array input', () => {
    const data = new Uint8Array(Buffer.from('test'));
    const compressed = zstdCompress(data);
    expect(detectFormat(compressed)).toBe('zstd');
  });
});

// CompressionFormat is declared as a regular enum rather than a const enum,
// so that code compiled one file at a time (isolatedModules, esbuild, swc)
// can use its members as values (#567); the type check covers that.
describe('CompressionFormat', () => {
  /** A switch over every member, with no default: TS2366 if one is missing. */
  function label(format: CompressionFormat): string {
    switch (format) {
      case CompressionFormat.Zstd:
        return 'Zstandard';
      case CompressionFormat.Gzip:
        return 'gzip';
      case CompressionFormat.Brotli:
        return 'Brotli';
      case CompressionFormat.Lz4:
        return 'LZ4';
      case CompressionFormat.Unknown:
        return 'unknown format';
    }
  }

  it('names what detectFormat returns', () => {
    const data = Buffer.from('test data for format detection');
    expect(detectFormat(zstdCompress(data))).toBe(CompressionFormat.Zstd);
    expect(detectFormat(gzipCompress(data))).toBe(CompressionFormat.Gzip);
    expect(detectFormat(brotliCompress(data))).toBe(CompressionFormat.Brotli);
    expect(detectFormat(lz4Compress(data))).toBe(CompressionFormat.Lz4);
    expect(detectFormat(data)).toBe(CompressionFormat.Unknown);
  });

  it('can be switched over exhaustively', () => {
    const data = Buffer.from('test data for format detection');
    expect(label(detectFormat(lz4Compress(data)))).toBe('LZ4');
    expect(label(detectFormat(data))).toBe('unknown format');
  });

  // As napi-rs defines them: read-only and not enumerable, so that
  // Object.keys() and Object.values() return []. The browser entry defines
  // its members the same way (wasm-parity.spec.ts).
  it('has read-only members that are not enumerable', () => {
    const member = (value: string) => ({
      value,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.getOwnPropertyDescriptors(CompressionFormat)).toStrictEqual({
      Zstd: member('zstd'),
      Gzip: member('gzip'),
      Brotli: member('brotli'),
      Lz4: member('lz4'),
      Unknown: member('unknown'),
    });
  });
});

describe('decompress (auto-detect)', () => {
  const original = Buffer.from('Hello, auto-detect decompression!');

  it('should auto-decompress zstd data', () => {
    const compressed = zstdCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-decompress gzip data', () => {
    const compressed = gzipCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-decompress brotli data', () => {
    const compressed = brotliCompress(original);
    const result = decompress(compressed);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should throw on unknown format', () => {
    const data = Buffer.from('not compressed');
    expect(() => decompress(data)).toThrow(/unable to detect compression format/);
  });

  it('should throw on empty data', () => {
    expect(() => decompress(Buffer.alloc(0))).toThrow(/unable to detect compression format/);
  });

  it('should round-trip large zstd data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256;
    }
    const compressed = zstdCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should round-trip large gzip data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256;
    }
    const compressed = gzipCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should round-trip large brotli data', () => {
    const large = Buffer.alloc(100_000);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256;
    }
    const compressed = brotliCompress(large);
    const result = decompress(compressed);
    expect(Buffer.compare(result, large)).toBe(0);
  });

  it('should accept Uint8Array input', () => {
    const compressed = zstdCompress(original);
    const uint8 = new Uint8Array(compressed);
    const result = decompress(uint8);
    expect(Buffer.compare(result, original)).toBe(0);
  });

  it('should auto-decompress concatenated gzip streams', () => {
    const a = gzipCompress(Buffer.from('Part1'));
    const b = gzipCompress(Buffer.from('Part2'));
    const concatenated = Buffer.concat([a, b]);
    const result = decompress(concatenated);
    expect(result.toString()).toBe('Part1Part2');
  });
});

describe('detectFormat edge cases', () => {
  const unknownFormat = /unable to detect compression format/;

  it('should detect an empty brotli stream', async () => {
    const empty = brotliCompress(Buffer.alloc(0));
    expect(detectFormat(empty)).toBe('brotli');
    expect(decompress(empty)).toEqual(Buffer.alloc(0));
    expect(await decompressAsync(empty)).toEqual(Buffer.alloc(0));
  });

  it('should detect zstd and LZ4 frames after skippable frames', () => {
    const skippable = Buffer.concat([
      skippableFrame(Buffer.from([1, 2, 3, 4])),
      skippableFrame(Buffer.alloc(0), 0x184d2a5f),
    ]);
    const zstd = Buffer.concat([skippable, zstdCompress(ROWS)]);
    const lz4 = Buffer.concat([skippable, lz4Compress(ROWS)]);
    expect(detectFormat(zstd)).toBe('zstd');
    expect(detectFormat(lz4)).toBe('lz4');
    expect(decompress(zstd)).toEqual(ROWS);
    expect(decompress(lz4)).toEqual(ROWS);
  });

  it('should not guess the format of skippable frames alone', () => {
    const skippable = skippableFrame(Buffer.from('metadata'));
    for (const data of [skippable, skippable.subarray(0, 10)]) {
      expect(detectFormat(data)).toBe('unknown');
      expect(() => decompress(data)).toThrow(unknownFormat);
    }
  });

  it('should detect LZ4 legacy frames', () => {
    const content = Buffer.from('legacy LZ4 frame, as lz4 -l writes it');
    const legacy = lz4LegacyFrame(content);
    expect(detectFormat(legacy)).toBe('lz4');
    expect(detectFormat(Buffer.from([0x02, 0x21, 0x4c, 0x18, 0, 0, 0, 0]))).toBe('lz4');
    expect(decompress(legacy)).toEqual(content);
  });

  it('should rarely report random data as brotli', () => {
    // About 6% of these used to be reported as brotli.
    for (const length of [64, 1024]) {
      let brotli = 0;
      for (let seed = 0; seed < 1000; seed++) {
        if (detectFormat(pseudoRandomBytes(seed, length)) === 'brotli') {
          brotli++;
        }
      }
      expect(brotli, `${length} bytes`).toBe(0);
    }
  });

  it('should report raw deflate as unknown format, not as invalid brotli', async () => {
    const compressed = deflateCompress(ROWS);
    expect(() => decompress(compressed)).toThrow(unknownFormat);
    await expect(decompressAsync(compressed)).rejects.toThrow(unknownFormat);
  });

  it('should report unknown format when data detected as brotli does not decode', async () => {
    const compressed = brotliCompress(ROWS);
    const truncated = compressed.subarray(0, compressed.length >> 1);
    expect(detectFormat(truncated)).toBe('brotli');
    expect(() => decompress(truncated)).toThrow(unknownFormat);
    await expect(decompressAsync(truncated)).rejects.toThrow(unknownFormat);
  });

  it('should detect brotli streams of data that does not compress', () => {
    const data = pseudoRandomBytes(1, 100 * 1024);
    const compressed = brotliCompress(data);
    expect(detectFormat(compressed)).toBe('brotli');
    expect(decompress(compressed)).toEqual(data);
    // Their start is detected once it fills the 64 KiB that detection decodes.
    expect(detectFormat(compressed.subarray(0, 64 * 1024 - 1))).toBe('unknown');
    expect(detectFormat(compressed.subarray(0, 64 * 1024))).toBe('brotli');
  });
});
