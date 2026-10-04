// Stands in for the wasm-bindgen module (browser/comprs-wasm.js) when Vitest
// loads browser/streaming.js; see the plugin in vitest.config.mts.
import * as native from '../index.js';

export const {
  brotliCompress,
  brotliCompressWithDict,
  brotliDecompress,
  brotliDecompressWithCapacity,
  brotliDecompressWithDict,
  brotliDecompressWithDictWithCapacity,
  deflateCompress,
  deflateDecompress,
  deflateDecompressWithCapacity,
  gzipCompress,
  gzipDecompress,
  gzipDecompressWithCapacity,
  lz4Compress,
  lz4Decompress,
  lz4DecompressWithCapacity,
  zstdCompress,
  zstdCompressWithDict,
  zstdDecompress,
  zstdDecompressWithCapacity,
  zstdDecompressWithDict,
  zstdDecompressWithDictWithCapacity,
} = native;
