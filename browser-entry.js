// Browser entry point: re-export all WASM APIs with streaming context adapters.
// Streaming contexts are replaced with JS-side adapters that wrap one-shot APIs
// to work around WebAssembly.Memory growth invalidating ArrayBuffer views.
// See: https://github.com/derodero24/zflate/issues/106

// One-shot APIs (pass through from WASM)
export {
  brotliCompress,
  brotliCompressAsync,
  brotliDecompress,
  brotliDecompressAsync,
  brotliDecompressWithCapacity,
  brotliDecompressWithCapacityAsync,
  crc32,
  CompressionFormat,
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
  gzipDecompress,
  gzipDecompressAsync,
  gzipDecompressWithCapacity,
  gzipDecompressWithCapacityAsync,
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
  zstdTrainDictionary,
  zstdTrainDictionaryAsync,
} from './browser.js'

// Streaming context adapters (override native WASM contexts)
export {
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
  BrotliCompressContext,
  BrotliDecompressContext,
  ZstdCompressContext,
  ZstdDecompressContext,
  ZstdCompressDictContext,
  ZstdDecompressDictContext,
} from './browser-streaming.js'
