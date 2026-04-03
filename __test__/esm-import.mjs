import assert from 'node:assert';
import {
  BrotliCompressDictContext,
  BrotliDecompressDictContext,
  brotliCompress,
  brotliCompressAsync,
  brotliCompressWithDict,
  brotliCompressWithDictAsync,
  brotliDecompress,
  brotliDecompressAsync,
  brotliDecompressWithCapacity,
  brotliDecompressWithCapacityAsync,
  brotliDecompressWithDict,
  brotliDecompressWithDictAsync,
  brotliDecompressWithDictWithCapacity,
  crc32,
  createBrotliCompressDictStream,
  createBrotliCompressStream,
  createBrotliDecompressDictStream,
  createBrotliDecompressStream,
  createDecompressStream,
  createDeflateCompressStream,
  createDeflateDecompressStream,
  createGzipCompressStream,
  createGzipDecompressStream,
  createLz4CompressStream,
  createLz4DecompressStream,
  createZstdCompressDictStream,
  createZstdCompressStream,
  createZstdDecompressDictStream,
  createZstdDecompressStream,
  decompress,
  decompressAsync,
  deflateCompress,
  deflateCompressAsync,
  deflateDecompress,
  deflateDecompressAsync,
  deflateDecompressWithCapacity,
  deflateDecompressWithCapacityAsync,
  detectFormat,
  gzipCompress,
  gzipCompressAsync,
  gzipCompressWithHeader,
  gzipDecompress,
  gzipDecompressAsync,
  gzipDecompressWithCapacity,
  gzipDecompressWithCapacityAsync,
  gzipReadHeader,
  lz4Compress,
  lz4CompressAsync,
  lz4Decompress,
  lz4DecompressAsync,
  lz4DecompressWithCapacity,
  lz4DecompressWithCapacityAsync,
  version,
  zstdCompress,
  zstdCompressAsync,
  zstdCompressWithDict,
  zstdCompressWithDictAsync,
  zstdDecompress,
  zstdDecompressAsync,
  zstdDecompressWithCapacity,
  zstdDecompressWithCapacityAsync,
  zstdDecompressWithDict,
  zstdDecompressWithDictAsync,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
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
assert.strictEqual(
  typeof createZstdCompressDictStream,
  'function',
  'createZstdCompressDictStream should be a function',
);
assert.strictEqual(
  typeof createZstdDecompressDictStream,
  'function',
  'createZstdDecompressDictStream should be a function',
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
  typeof brotliDecompressWithCapacityAsync,
  'function',
  'brotliDecompressWithCapacityAsync should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithCapacity,
  'function',
  'zstdDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithCapacityAsync,
  'function',
  'zstdDecompressWithCapacityAsync should be a function',
);
assert.strictEqual(
  typeof gzipDecompressWithCapacity,
  'function',
  'gzipDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof gzipDecompressWithCapacityAsync,
  'function',
  'gzipDecompressWithCapacityAsync should be a function',
);
assert.strictEqual(
  typeof deflateDecompressWithCapacity,
  'function',
  'deflateDecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof deflateDecompressWithCapacityAsync,
  'function',
  'deflateDecompressWithCapacityAsync should be a function',
);
assert.strictEqual(typeof decompress, 'function', 'decompress should be a function');
assert.strictEqual(typeof decompressAsync, 'function', 'decompressAsync should be a function');
assert.strictEqual(typeof detectFormat, 'function', 'detectFormat should be a function');
assert.strictEqual(
  typeof zstdTrainDictionary,
  'function',
  'zstdTrainDictionary should be a function',
);
assert.strictEqual(
  typeof zstdTrainDictionaryAsync,
  'function',
  'zstdTrainDictionaryAsync should be a function',
);
assert.strictEqual(
  typeof zstdCompressWithDict,
  'function',
  'zstdCompressWithDict should be a function',
);
assert.strictEqual(
  typeof zstdCompressWithDictAsync,
  'function',
  'zstdCompressWithDictAsync should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithDict,
  'function',
  'zstdDecompressWithDict should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithDictAsync,
  'function',
  'zstdDecompressWithDictAsync should be a function',
);
assert.strictEqual(
  typeof zstdDecompressWithDictWithCapacity,
  'function',
  'zstdDecompressWithDictWithCapacity should be a function',
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
assert.strictEqual(
  typeof brotliCompressWithDict,
  'function',
  'brotliCompressWithDict should be a function',
);
assert.strictEqual(
  typeof brotliCompressWithDictAsync,
  'function',
  'brotliCompressWithDictAsync should be a function',
);
assert.strictEqual(
  typeof brotliDecompressWithDict,
  'function',
  'brotliDecompressWithDict should be a function',
);
assert.strictEqual(
  typeof brotliDecompressWithDictAsync,
  'function',
  'brotliDecompressWithDictAsync should be a function',
);
assert.strictEqual(
  typeof brotliDecompressWithDictWithCapacity,
  'function',
  'brotliDecompressWithDictWithCapacity should be a function',
);
assert.strictEqual(
  typeof BrotliCompressDictContext,
  'function',
  'BrotliCompressDictContext should be a function',
);
assert.strictEqual(
  typeof BrotliDecompressDictContext,
  'function',
  'BrotliDecompressDictContext should be a function',
);
assert.strictEqual(
  typeof createBrotliCompressDictStream,
  'function',
  'createBrotliCompressDictStream should be a function',
);
assert.strictEqual(
  typeof createBrotliDecompressDictStream,
  'function',
  'createBrotliDecompressDictStream should be a function',
);
assert.strictEqual(typeof lz4Compress, 'function', 'lz4Compress should be a function');
assert.strictEqual(typeof lz4Decompress, 'function', 'lz4Decompress should be a function');
assert.strictEqual(typeof lz4CompressAsync, 'function', 'lz4CompressAsync should be a function');
assert.strictEqual(
  typeof lz4DecompressAsync,
  'function',
  'lz4DecompressAsync should be a function',
);
assert.strictEqual(
  typeof lz4DecompressWithCapacity,
  'function',
  'lz4DecompressWithCapacity should be a function',
);
assert.strictEqual(
  typeof lz4DecompressWithCapacityAsync,
  'function',
  'lz4DecompressWithCapacityAsync should be a function',
);
assert.strictEqual(
  typeof createLz4CompressStream,
  'function',
  'createLz4CompressStream should be a function',
);
assert.strictEqual(
  typeof createLz4DecompressStream,
  'function',
  'createLz4DecompressStream should be a function',
);
assert.strictEqual(
  typeof createDecompressStream,
  'function',
  'createDecompressStream should be a function',
);
assert.strictEqual(typeof crc32, 'function', 'crc32 should be a function');
assert.strictEqual(
  typeof gzipCompressWithHeader,
  'function',
  'gzipCompressWithHeader should be a function',
);
assert.strictEqual(typeof gzipReadHeader, 'function', 'gzipReadHeader should be a function');

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

// LZ4 round-trip test
const lz4Compressed = lz4Compress(input);
const lz4Decompressed = lz4Decompress(lz4Compressed);
assert.deepStrictEqual(lz4Decompressed, input, 'lz4 round-trip should produce identical output');

// CRC32 test
const crc = crc32(input);
assert.strictEqual(typeof crc, 'number', 'crc32 should return a number');

// Auto-detect decompress test
const autoResult = decompress(zstdCompress(input));
assert.deepStrictEqual(autoResult, input, 'auto-detect decompress should work with zstd');
assert.strictEqual(detectFormat(zstdCompress(input)), 'zstd', 'detectFormat should identify zstd');

console.log('ESM import smoke test passed');
