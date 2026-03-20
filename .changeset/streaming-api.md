---
"zflate": minor
---

Add streaming compression/decompression API using Web Streams API (`TransformStream`). New functions `createZstdCompressStream()` and `createZstdDecompressStream()` enable chunked processing of large data with bounded memory usage. Streaming output is fully interoperable with one-shot `zstdCompress()`/`zstdDecompress()`.
