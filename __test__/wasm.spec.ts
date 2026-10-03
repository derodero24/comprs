import { beforeAll, describe, expect, it } from 'vitest';
import * as native from '../index.js';
import { type BrowserEntry, HAS_WASM_BUILD, importBrowserEntry } from './load-browser-entry.js';

// Tests the wasm-bindgen build through the browser entry, which loads it.
// wasm-parity.spec.ts compares it with the native addon call by call.

let wasm: BrowserEntry;

describe.skipIf(!HAS_WASM_BUILD)('wasm-bindgen build', () => {
  beforeAll(async () => {
    wasm = await importBrowserEntry();
  });

  describe('one-shot compression', () => {
    const testData = Buffer.from('Hello, WASM comprs! '.repeat(100));

    it.each([
      ['zstd', 'zstdCompress', 'zstdDecompress'],
      ['gzip', 'gzipCompress', 'gzipDecompress'],
      ['deflate', 'deflateCompress', 'deflateDecompress'],
      ['brotli', 'brotliCompress', 'brotliDecompress'],
      ['lz4', 'lz4Compress', 'lz4Decompress'],
    ] as const)('should round-trip with %s', (_name, compress, decompress) => {
      const decompressed = wasm[decompress](wasm[compress](testData));
      expect(Buffer.from(decompressed)).toEqual(testData);
    });
  });

  describe('auto-detect decompression', () => {
    const testData = Buffer.from('Auto-detect test data '.repeat(50));

    it('should auto-detect zstd', () => {
      const compressed = wasm.zstdCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('zstd');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should auto-detect gzip', () => {
      const compressed = wasm.gzipCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('gzip');
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });

    it('should auto-detect brotli via decompress', () => {
      // Brotli has no magic bytes, so detectFormat cannot recognize it, but
      // decompress() still tries brotli as a fallback.
      const compressed = wasm.brotliCompress(testData);
      expect(Buffer.from(wasm.decompress(compressed))).toEqual(testData);
    });
  });

  describe('native parity', () => {
    const testData = Buffer.from('Native parity verification data '.repeat(100));

    it('version: should match the native addon', () => {
      expect(wasm.version()).toBe(native.version());
    });

    it('crc32: should match the native addon', () => {
      expect(wasm.crc32(testData)).toBe(native.crc32(testData));
    });

    it('zstd: WASM output should match native output', () => {
      expect(Buffer.from(wasm.zstdCompress(testData))).toEqual(native.zstdCompress(testData));
    });

    it('deflate: WASM output should match native output', () => {
      expect(Buffer.from(wasm.deflateCompress(testData))).toEqual(native.deflateCompress(testData));
    });

    // The compressed bytes of these may differ, so check that each side
    // decompresses the other's output.
    it('gzip: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.gzipDecompress(native.gzipCompress(testData)))).toEqual(testData);
      expect(native.gzipDecompress(wasm.gzipCompress(testData))).toEqual(testData);
    });

    it('brotli: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.brotliDecompress(native.brotliCompress(testData)))).toEqual(testData);
      expect(native.brotliDecompress(wasm.brotliCompress(testData))).toEqual(testData);
    });

    it('lz4: WASM and native should decompress each other', () => {
      expect(Buffer.from(wasm.lz4Decompress(native.lz4Compress(testData)))).toEqual(testData);
      expect(native.lz4Decompress(wasm.lz4Compress(testData))).toEqual(testData);
    });
  });
});
