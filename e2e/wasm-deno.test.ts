// Deno does not support the WASI CJS loader (Context is not supported),
// so we use the browser loader which works via @napi-rs/wasm-runtime.
const wasm = await import('../zflate.wasi-browser.js');

function arrayEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const testData = new TextEncoder().encode('Hello, Deno WASM zflate! '.repeat(100));

Deno.test('zstd round-trip', () => {
  const compressed = wasm.zstdCompress(testData);
  const decompressed = wasm.zstdDecompress(compressed);
  if (!arrayEqual(new Uint8Array(decompressed), testData)) {
    throw new Error('zstd round-trip failed');
  }
});

Deno.test('gzip round-trip', () => {
  const compressed = wasm.gzipCompress(testData);
  const decompressed = wasm.gzipDecompress(compressed);
  if (!arrayEqual(new Uint8Array(decompressed), testData)) {
    throw new Error('gzip round-trip failed');
  }
});

Deno.test('deflate round-trip', () => {
  const compressed = wasm.deflateCompress(testData);
  const decompressed = wasm.deflateDecompress(compressed);
  if (!arrayEqual(new Uint8Array(decompressed), testData)) {
    throw new Error('deflate round-trip failed');
  }
});

Deno.test('brotli round-trip', () => {
  const compressed = wasm.brotliCompress(testData);
  const decompressed = wasm.brotliDecompress(compressed);
  if (!arrayEqual(new Uint8Array(decompressed), testData)) {
    throw new Error('brotli round-trip failed');
  }
});

Deno.test('auto-detect decompression', () => {
  const compressed = wasm.zstdCompress(testData);
  const decompressed = wasm.decompress(compressed);
  if (!arrayEqual(new Uint8Array(decompressed), testData)) {
    throw new Error('auto-detect failed');
  }
});

Deno.test('version', () => {
  const ver = wasm.version();
  if (typeof ver !== 'string' || !/^\d+\.\d+\.\d+/.test(ver)) {
    throw new Error(`Invalid version: ${ver}`);
  }
});
