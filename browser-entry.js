// Browser entry point: re-export all WASM APIs with streaming context adapters.
// Streaming contexts are replaced with JS-side adapters that wrap one-shot APIs
// to work around WebAssembly.Memory growth invalidating ArrayBuffer views.
// See: https://github.com/derodero24/comprs/issues/106

// One-shot APIs (pass through from WASM)
export {
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  crc32,
  decompress,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  detectFormat,
  gzipCompress,
  gzipDecompress,
  gzipCompressWithHeader,
  gzipReadHeader,
  gzipDecompressWithCapacity,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  version,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
  zstdTrainDictionary,
} from './browser.js'

// Streaming context adapters (override native WASM contexts)
export {
  GzipCompressContext,
  GzipDecompressContext,
  DeflateCompressContext,
  DeflateDecompressContext,
  BrotliCompressContext,
  BrotliDecompressContext,
  BrotliCompressDictContext,
  BrotliDecompressDictContext,
  Lz4CompressContext,
  Lz4DecompressContext,
  ZstdCompressContext,
  ZstdDecompressContext,
  ZstdCompressDictContext,
  ZstdDecompressDictContext,
} from './browser-streaming.js'
