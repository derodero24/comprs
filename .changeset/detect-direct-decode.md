---
"@derodero24/comprs": patch
---

`decompress()` decodes zstd and LZ4 frames that declare their content size straight into the memory of its result, as `zstdDecompress()` and `lz4Decompress()` do, so that its large results get the same speed and memory in synchronous loops.
