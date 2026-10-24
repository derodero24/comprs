---
"@derodero24/comprs": patch
---

`decompressSync()` of `@derodero24/comprs/next` decodes zstd frames that declare their content size straight into the memory of its result, as `zstdDecompress()` does, also when it detects the format. A synchronous loop that gets results of 4 MiB runs about 7 times as fast, and no longer holds the memory of every result until it yields (800 MiB for 200 calls). Its results also skip a zero-fill, which makes zstd results of 256 KiB to 1 MiB up to 1.7 times as fast.
