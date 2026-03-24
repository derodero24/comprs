---
"comprs": patch
---

Use `decompress_with_limit` in async auto-detect decompression for gzip and brotli, replacing manual chunk-read loops that performed a double-copy through an intermediate stack buffer.
