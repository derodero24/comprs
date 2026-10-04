---
'@derodero24/comprs': patch
---

Speed up small one-shot zstd calls. `zstdCompress()`, `zstdDecompress()`,
`zstdDecompressWithCapacity()`, their `*Async` variants, and `decompress()`
and `decompressAsync()` for zstd input reuse one compression and one
decompression context per thread instead of creating one per call:
compressing messages of about 110 bytes is about 6 times faster, and
decompressing them about 12 times. A thread keeps a context only while it
holds at most 8 MiB, so a large or high-level call does not leave its
workspace behind. The output is unchanged, and the dictionary functions
still create a context per call.
