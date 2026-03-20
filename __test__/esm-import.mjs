import assert from 'node:assert';
import {
  brotliCompress,
  brotliCompressAsync,
  brotliDecompress,
  brotliDecompressAsync,
  brotliDecompressWithCapacity,
  createBrotliCompressStream,
  createBrotliDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createZstdCompressStream,
  createZstdDecompressStream,
  decompress,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompress,
  deflateDecompressAsync,
  deflateDecompressWithCapacity,
  detectFormat,
  gzipCompress,
  gzipCompressAsync,
  gzipDecompress,
  gzipDecompressAsync,
  gzipDecompressWithCapacity,
  version,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdTrainDictionary,
} from '../index.mjs';

assert.strictEqual(typeof version, 'function', 'version should be a function');
assert.strictEqual(typeof zstdCompress, 'function', 'zstdCompress should be a function');
assert.strictEqual(typeof zstdDecompress, 'function', 'zstdDecompress should be a function');
assert.strictEqual(
  typeof createZstdCompressStream,
  'function',
  'createZstdCompressStream should be a function',
);
assert.strictEqual(
  typeof createZstdDecompressStream,
  'function',
  'createZstdDecompressStream should be a function',
);
assert.strictEqual(typeof gzipCompress, 'function', 'gzipCompress should be a function');
assert.strictEqual(typeof gzipDecompress, 'function', 'gzipDecompress should be a function');
assert.strictEqual(typeof deflateCompress, 'function', 'deflateCompress should be a function');
assert.strictEqual(typeof deflateDecompress, 'function', 'deflateDecompress should be a function');
assert.strictEqual(
  typeof createGzipCompressStream,
  'function',
  'createGzipCompressStream should be a function',
);
assert.strictEqual(
  typeof createGzipDecompressStream,
  'function',
  'createGzipDecompressStream should be a function',
);
assert.strictEqual(
  typeof createDeflateCompressStream,
  'function',
  'createDeflateCompressStream should be a function',
);
assert.strictEqual(
  typeof createDeflateDecompressStream,
  'function',
  'createDeflateDecompressStream should be a function',
);
assert.strictEqual(typeof brotliCompress, 'function', 'brotliCompress should be a function');
assert.strictEqual(typeof brotliDecompress, 'function', 'brotliDecompress should be a function');
assert.strictEqual(
  typeof brotliDecompressWithCapacity,
  'function',
  'brotliDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithCapacity,
  'function',
  'zstdDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof gzipDecompressWithCapacity,
  'function',
  'gzipDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof deflateDecompressWithCapacity,
  'function',
  'deflateDecompressWithCapacity should be a function',
);
assert.strictEqual(typeof decompress, 'function', 'decompress should be a function');
assert.strictEqual(typeof detectFormat, 'function', 'detectFormat should be a function');
assert.strictEqual(
  typeof zstdTrainDictionary,
  'function',
  'zstdTrainDictionary should be a function',
);
assert.strictEqual(
  typeof zstdCompressWithDict,
  'function',
  'zstdCompressWithDict should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithDict,
  'function',
  'zstdDecompressWithDict should be a function',
);
assert.strictEqual(typeof zstdCompressAsync, 'function', 'zstdCompressAsync should be a function');
assert.strictEqual(
  typeof zstdDecompressAsync,
  'function',
  'zstdDecompressAsync should be a function',
);
assert.strictEqual(typeof gzipCompressAsync, 'function', 'gzipCompressAsync should be a function');
assert.strictEqual(
  typeof gzipDecompressAsync,
  'function',
  'gzipDecompressAsync should be a function',
);
assert.strictEqual(
  typeof deflateCompressAsync,
  'function',
  'deflateCompressAsync should be a function',
);
assert.strictEqual(
  typeof deflateDecompressAsync,
  'function',
  'deflateDecompressAsync should be a function',
);
assert.strictEqual(
  typeof brotliCompressAsync,
  'function',
  'brotliCompressAsync should be a function',
);
assert.strictEqual(
  typeof brotliDecompressAsync,
  'function',
  'brotliDecompressAsync should be a function',
);
assert.strictEqual(
  typeof createBrotliCompressStream,
  'function',
  'createBrotliCompressStream should be a function',
);
assert.strictEqual(
  typeof createBrotliDecompressStream,
  'function',
  'createBrotliDecompressStream should be a function',
);

// Zstd round-trip test
const input = Buffer.from('ESM smoke test');
const compressed = zstdCompress(input);
const decompressed = zstdDecompress(compressed);
assert.deepStrictEqual(decompressed, input, 'zstd round-trip should produce identical output');

// Gzip round-trip test
const gzCompressed = gzipCompress(input);
const gzDecompressed = gzipDecompress(gzCompressed);
assert.deepStrictEqual(gzDecompressed, input, 'gzip round-trip should produce identical output');

// Deflate round-trip test
const dfCompressed = deflateCompress(input);
const dfDecompressed = deflateDecompress(dfCompressed);
assert.deepStrictEqual(dfDecompressed, input, 'deflate round-trip should produce identical output');

// Brotli round-trip test
const brCompressed = brotliCompress(input);
const brDecompressed = brotliDecompress(brCompressed);
assert.deepStrictEqual(brDecompressed, input, 'brotli round-trip should produce identical output');

// Auto-detect decompress test
const autoResult = decompress(zstdCompress(input));
assert.deepStrictEqual(autoResult, input, 'auto-detect decompress should work with zstd');
assert.strictEqual(detectFormat(zstdCompress(input)), 'zstd', 'detectFormat should identify zstd');

console.log('ESM import smoke test passed');
