---
'@derodero24/comprs': patch
---

Speed up zstd stream compression with small chunks. `ZstdCompressContext`,
`ZstdCompressDictContext` and the zstd compression streams no longer
zero-fill a 128 KiB output buffer on every call: 10 MiB written in 1 KiB
chunks compresses about 10 times faster for highly compressible data and
up to twice as fast for JSON lines. The output is unchanged.
