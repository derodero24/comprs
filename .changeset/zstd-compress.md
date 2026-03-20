---
"zflate": minor
---

Add zstd compression and decompression support via `zstdCompress()`, `zstdDecompress()`, and `zstdDecompressWithCapacity()` functions. Supports compression levels 1-22 (default: 3) and negative levels for fast mode.
