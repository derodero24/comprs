---
"comprs": minor
---

Add LZ4 frame compression/decompression support via `lz4Compress()` and `lz4Decompress()` functions. Includes streaming API with `createLz4CompressStream()` and `createLz4DecompressStream()`, and Node.js Transform streams via `createLz4CompressTransform()` and `createLz4DecompressTransform()`. Auto-detect (`decompress()`, `detectFormat()`) now recognizes LZ4 frames.
