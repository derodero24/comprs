# zflate

## 0.2.0

### Minor Changes

- fb7c15f: Add streaming compression/decompression API using Web Streams API (`TransformStream`). New functions `createZstdCompressStream()` and `createZstdDecompressStream()` enable chunked processing of large data with bounded memory usage. Streaming output is fully interoperable with one-shot `zstdCompress()`/`zstdDecompress()`.
- 9ceb306: Add zstd compression and decompression support via `zstdCompress()`, `zstdDecompress()`, and `zstdDecompressWithCapacity()` functions. Supports compression levels 1-22 (default: 3) and negative levels for fast mode.
