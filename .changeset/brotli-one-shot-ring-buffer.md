---
'@derodero24/comprs': patch
---

The one-shot brotli decompression functions (`brotliDecompress()`,
`brotliDecompressWithDict()`, their `WithCapacity` and `Async` variants,
and `decompress()` and `decompressAsync()` on brotli data) hand the decoder
the whole input at once. Small brotli decompressions no longer allocate a
4 MiB ring buffer: 10 KB of incompressible data decompresses about 40 times
faster, and 1 MB of incompressible data about twice as fast.
