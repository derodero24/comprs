# comprs

## 1.0.1

### Patch Changes

- af5c0b8: Fix missing zstdDecompressWithDictWithCapacityAsync ESM export and sync Cargo.toml versions

## 1.0.0

### Major Changes

- 796774f: First stable release with wasm-bindgen browser support (no SharedArrayBuffer required), three-crate architecture, and full algorithm coverage (zstd, gzip, brotli, lz4)

## 0.4.1

### Patch Changes

- 5130974: Fix npm publish for scoped platform packages by adding publishConfig and release workflow permissions

## 0.4.0

### Minor Changes

- 3ac395a: Add Brotli dictionary compression and decompression support

## 0.3.1

### Patch Changes

- 38a3787: Enforce maxOutputSize in browser WASM ZstdDecompressDictContext by adding zstdDecompressWithDictWithCapacity
- 764ba82: Use `decompress_with_limit` in async auto-detect decompression for gzip and brotli, replacing manual chunk-read loops that performed a double-copy through an intermediate stack buffer.
- ad5add2: Fix missing validation for maxDictSize parameter in zstdTrainDictionary

## 0.3.0

### Minor Changes

- c23b4e6: Add brotli compression/decompression support via `brotliCompress()` and `brotliDecompress()` functions. Includes streaming API with `createBrotliCompressStream()` and `createBrotliDecompressStream()`. Quality levels 0-11 (default: 6).
- 98e64a9: Add gzip and raw deflate compression/decompression support via `gzipCompress()`, `gzipDecompress()`, `deflateCompress()`, `deflateDecompress()` functions. Includes streaming API with `createGzipCompressStream()`, `createGzipDecompressStream()`, `createDeflateCompressStream()`, and `createDeflateDecompressStream()`.
- 356319f: Add LZ4 frame compression/decompression support via `lz4Compress()` and `lz4Decompress()` functions. Includes streaming API with `createLz4CompressStream()` and `createLz4DecompressStream()`, and Node.js Transform streams via `createLz4CompressTransform()` and `createLz4DecompressTransform()`. Auto-detect (`decompress()`, `detectFormat()`) now recognizes LZ4 frames.

### Patch Changes

- 49b5c2d: Rename package from `zflate` to `comprs` to avoid npm typosquat protection.

## 0.2.0

### Minor Changes

- fb7c15f: Add streaming compression/decompression API using Web Streams API (`TransformStream`). New functions `createZstdCompressStream()` and `createZstdDecompressStream()` enable chunked processing of large data with bounded memory usage. Streaming output is fully interoperable with one-shot `zstdCompress()`/`zstdDecompress()`.
- 9ceb306: Add zstd compression and decompression support via `zstdCompress()`, `zstdDecompress()`, and `zstdDecompressWithCapacity()` functions. Supports compression levels 1-22 (default: 3) and negative levels for fast mode.
