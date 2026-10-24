---
"@derodero24/comprs": minor
---

`lz4Compress()` and `lz4CompressAsync()`, and `compressSync()` and `compress()` of `@derodero24/comprs/next` for LZ4, write the content size into the frame, as `lz4 --content-size` does, which makes it 8 bytes longer. The synchronous LZ4 decompression functions, `lz4Decompress()`, `lz4DecompressWithCapacity()` and `decompressSync()` of `@derodero24/comprs/next`, decode frames that declare their content size straight into the memory of their result, as the zstd ones do. A synchronous loop that gets results of 4 MiB runs 5 to 8 times as fast, and no longer holds the memory of every result until it yields (800 MiB for 200 calls); yielding between calls, it runs about 3 times as fast.
