---
'@derodero24/comprs': patch
---

The synchronous zstd decompression functions (`zstdDecompress()`, `zstdDecompressWithCapacity()`, `zstdDecompressWithDict()` and `zstdDecompressWithDictWithCapacity()`) decode frames that declare their content size, as `zstdCompress()` writes them, straight into memory that V8 allocates, without the copy that results of up to 2 MiB took, which makes calls that return 512 KiB to 2 MiB up to 1.5 times as fast. Results larger than 2 MiB are now freed as soon as V8 collects them, so a synchronous loop no longer holds their memory until it yields, and they can be transferred to a worker: on x86-64 Linux, a loop of calls that return 4 MiB each runs about 3 times as fast and grows the resident set by 8 MiB instead of 800 MiB. The musl builds (as on Alpine Linux) keep results larger than 2 MiB in the addon's memory, where decoding into V8's memory made programs that yield between calls 3 times as slow.
