import assert from 'node:assert/strict';
// Resolved through the package's `exports`, as an `npm:` import is: Deno picks
// the `import` entry (index.mjs), which loads the native addon through
// Node-API. That needs --allow-ffi, and the loader needs --allow-read and
// --allow-env (see the test:deno script).
import {
  brotliCompress,
  brotliDecompress,
  createZstdCompressStream,
  createZstdDecompressStream,
  decompress,
  deflateCompress,
  deflateDecompress,
  gzipCompress,
  gzipDecompress,
  lz4Compress,
  lz4Decompress,
  version,
  zstdCompress,
  zstdCompressAsync,
  zstdDecompress,
  zstdDecompressAsync,
} from '@derodero24/comprs';

const testData = new TextEncoder().encode('Hello, Deno comprs! '.repeat(100));

async function pipe(
  data: Uint8Array<ArrayBuffer>,
  stream: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

Deno.test('zstd round-trip', () => {
  assert.deepEqual(new Uint8Array(zstdDecompress(zstdCompress(testData))), testData);
});

Deno.test('gzip round-trip', () => {
  assert.deepEqual(new Uint8Array(gzipDecompress(gzipCompress(testData))), testData);
});

Deno.test('deflate round-trip', () => {
  assert.deepEqual(new Uint8Array(deflateDecompress(deflateCompress(testData))), testData);
});

Deno.test('brotli round-trip', () => {
  assert.deepEqual(new Uint8Array(brotliDecompress(brotliCompress(testData))), testData);
});

Deno.test('lz4 round-trip', () => {
  assert.deepEqual(new Uint8Array(lz4Decompress(lz4Compress(testData))), testData);
});

Deno.test('auto-detect decompression', () => {
  assert.deepEqual(new Uint8Array(decompress(zstdCompress(testData))), testData);
});

// Async functions run on the Node-API thread pool; only the native addon
// provides them.
Deno.test('async round-trip', async () => {
  const compressed = await zstdCompressAsync(testData);
  assert.deepEqual(new Uint8Array(await zstdDecompressAsync(compressed)), testData);
});

Deno.test('Web Streams round-trip', async () => {
  const compressed = await pipe(testData, createZstdCompressStream());
  assert.deepEqual(await pipe(compressed, createZstdDecompressStream()), testData);
});

Deno.test('version', () => {
  assert.match(version(), /^\d+\.\d+\.\d+/);
});
