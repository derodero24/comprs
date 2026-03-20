import { describe, expect, test } from 'bun:test';

// Bun does not support node:wasi (wasi.initialize is undefined),
// so we use the browser loader which works via @napi-rs/wasm-runtime.
const wasm = await import('../zflate.wasi-browser.js');

function arrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const testData = new TextEncoder().encode('Hello, Bun WASM zflate! '.repeat(100));

describe('zflate WASM on Bun', () => {
  test('zstd round-trip', () => {
    const compressed = wasm.zstdCompress(testData);
    const decompressed = wasm.zstdDecompress(compressed);
    expect(arrayEqual(new Uint8Array(decompressed), testData)).toBe(true);
  });

  test('gzip round-trip', () => {
    const compressed = wasm.gzipCompress(testData);
    const decompressed = wasm.gzipDecompress(compressed);
    expect(arrayEqual(new Uint8Array(decompressed), testData)).toBe(true);
  });

  test('deflate round-trip', () => {
    const compressed = wasm.deflateCompress(testData);
    const decompressed = wasm.deflateDecompress(compressed);
    expect(arrayEqual(new Uint8Array(decompressed), testData)).toBe(true);
  });

  test('brotli round-trip', () => {
    const compressed = wasm.brotliCompress(testData);
    const decompressed = wasm.brotliDecompress(compressed);
    expect(arrayEqual(new Uint8Array(decompressed), testData)).toBe(true);
  });

  test('auto-detect decompression', () => {
    const compressed = wasm.zstdCompress(testData);
    const decompressed = wasm.decompress(compressed);
    expect(arrayEqual(new Uint8Array(decompressed), testData)).toBe(true);
  });

  test('version', () => {
    const ver = wasm.version();
    expect(typeof ver).toBe('string');
    expect(ver).toMatch(/^\d+\.\d+\.\d+/);
  });
});
