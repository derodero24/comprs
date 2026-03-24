import { describe, expect, it } from 'vitest';

// Check if WASM module is available (not built locally by default)
let wasmAvailable = false;
// biome-ignore lint/suspicious/noExplicitAny: WASM module loaded dynamically
let wasm: any;
try {
  wasm = require('../comprs.wasi.cjs');
  wasmAvailable = true;
} catch {
  // WASM binary not built — skip tests
}

describe.skipIf(!wasmAvailable)('WASM compatibility', () => {
  describe('one-shot compression', () => {
    const testData = Buffer.from('Hello, WASM comprs! '.repeat(100));

    it('should round-trip with zstd', () => {
      const compressed = wasm.zstdCompress(testData);
      const decompressed = wasm.zstdDecompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it('should round-trip with gzip', () => {
      const compressed = wasm.gzipCompress(testData);
      const decompressed = wasm.gzipDecompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it('should round-trip with deflate', () => {
      const compressed = wasm.deflateCompress(testData);
      const decompressed = wasm.deflateDecompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it('should round-trip with brotli', () => {
      const compressed = wasm.brotliCompress(testData);
      const decompressed = wasm.brotliDecompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });
  });

  describe('auto-detect decompression', () => {
    const testData = Buffer.from('Auto-detect test data '.repeat(50));

    it('should auto-detect zstd', () => {
      const compressed = wasm.zstdCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('zstd');
      const decompressed = wasm.decompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it('should auto-detect gzip', () => {
      const compressed = wasm.gzipCompress(testData);
      expect(wasm.detectFormat(compressed)).toBe('gzip');
      const decompressed = wasm.decompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });

    it('should auto-detect brotli via decompress', () => {
      // Brotli has no magic bytes, detectFormat may return 'unknown'
      // but decompress() should still try brotli as fallback
      const compressed = wasm.brotliCompress(testData);
      const decompressed = wasm.decompress(compressed);
      expect(Buffer.from(decompressed)).toEqual(testData);
    });
  });

  describe('version', () => {
    it('should return version string', () => {
      const ver = wasm.version();
      expect(typeof ver).toBe('string');
      expect(ver).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('native parity', () => {
    // Import native bindings for comparison
    // These are available because tests run after `pnpm run build`
    const native = require('../index.js');
    const testData = Buffer.from('Native parity verification data '.repeat(100));

    it('zstd: WASM output should match native output', () => {
      const wasmCompressed = wasm.zstdCompress(testData);
      const nativeCompressed = native.zstdCompress(testData);
      expect(Buffer.from(wasmCompressed)).toEqual(Buffer.from(nativeCompressed));
    });

    it('gzip: WASM decompression should match native decompression', () => {
      // Gzip includes timestamps, so compressed output may differ.
      // Instead, verify cross-decompression works.
      const nativeCompressed = native.gzipCompress(testData);
      const wasmDecompressed = wasm.gzipDecompress(nativeCompressed);
      expect(Buffer.from(wasmDecompressed)).toEqual(testData);

      const wasmCompressed = wasm.gzipCompress(testData);
      const nativeDecompressed = native.gzipDecompress(wasmCompressed);
      expect(Buffer.from(nativeDecompressed)).toEqual(testData);
    });

    it('deflate: WASM output should match native output', () => {
      const wasmCompressed = wasm.deflateCompress(testData);
      const nativeCompressed = native.deflateCompress(testData);
      expect(Buffer.from(wasmCompressed)).toEqual(Buffer.from(nativeCompressed));
    });

    it('brotli: WASM decompression should match native decompression', () => {
      const nativeCompressed = native.brotliCompress(testData);
      const wasmDecompressed = wasm.brotliDecompress(nativeCompressed);
      expect(Buffer.from(wasmDecompressed)).toEqual(testData);

      const wasmCompressed = wasm.brotliCompress(testData);
      const nativeDecompressed = native.brotliDecompress(wasmCompressed);
      expect(Buffer.from(nativeDecompressed)).toEqual(testData);
    });
  });
});
