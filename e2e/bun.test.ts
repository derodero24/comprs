import { describe, expect, test } from 'bun:test';
// Resolved through the package's `exports`, as in an application that
// depends on comprs: Bun picks the `import` entry (index.mjs), which loads
// the native addon through Node-API.
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

const testData = new TextEncoder().encode('Hello, Bun comprs! '.repeat(100));

async function pipe(
  data: Uint8Array<ArrayBuffer>,
  stream: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

describe('comprs on Bun', () => {
  test('zstd round-trip', () => {
    expect(new Uint8Array(zstdDecompress(zstdCompress(testData)))).toEqual(testData);
  });

  test('gzip round-trip', () => {
    expect(new Uint8Array(gzipDecompress(gzipCompress(testData)))).toEqual(testData);
  });

  test('deflate round-trip', () => {
    expect(new Uint8Array(deflateDecompress(deflateCompress(testData)))).toEqual(testData);
  });

  test('brotli round-trip', () => {
    expect(new Uint8Array(brotliDecompress(brotliCompress(testData)))).toEqual(testData);
  });

  test('lz4 round-trip', () => {
    expect(new Uint8Array(lz4Decompress(lz4Compress(testData)))).toEqual(testData);
  });

  test('auto-detect decompression', () => {
    expect(new Uint8Array(decompress(zstdCompress(testData)))).toEqual(testData);
  });

  // Async functions run on the Node-API thread pool; only the native addon
  // provides them.
  test('async round-trip', async () => {
    const compressed = await zstdCompressAsync(testData);
    expect(new Uint8Array(await zstdDecompressAsync(compressed))).toEqual(testData);
  });

  test('Web Streams round-trip', async () => {
    const compressed = await pipe(testData, createZstdCompressStream());
    expect(await pipe(compressed, createZstdDecompressStream())).toEqual(testData);
  });

  test('version', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
