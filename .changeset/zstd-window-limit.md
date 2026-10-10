---
'@derodero24/comprs': patch
---

Bound the window of the zstd decoders by the output limit. A zstd frame
without a content size can declare a window of up to 128 MiB, which the
decoder allocated as soon as it had read the 6-byte frame header, whatever
`capacity` or `maxOutputSize` said: 100 `ZstdDecompressContext`s with a
`maxOutputSize` of 1024 bytes, fed that header, held 12.5 GiB of address
space and reported it to V8, and the WebAssembly build grew its memory by
128 MiB for good.

`zstdDecompressWithCapacity()`, `zstdDecompressWithDictWithCapacity()`,
their async variants, `decompress()` and `decompressAsync()` for zstd input,
`ZstdDecompressContext`, `ZstdDecompressDictContext` and the zstd
decompression streams now accept a window of at most the limit rounded up
to a power of two, but never less than 8 MiB, the most that zstd writes at
levels up to 19, nor more than zstd's default of 128 MiB. A frame that
declares a larger window throws `... exceeded maximum size of <limit>
bytes`, the error of output over the limit, before the decoder allocates
anything, because a larger limit can decode it. Limits of more than 64 MiB,
such as the default of 256 MB, keep the bound of 128 MiB, which no limit
raises: under them, a frame over it still throws `Frame requires too much
memory for decoding`.

Only frames without a content size whose window exceeds 8 MiB are affected:
streams that `ZstdCompressContext`, the streams built on it or
`zstd --ultra` reading a pipe compress at levels 20 to 22, and streams
compressed with `zstd --long`. Under an explicit limit, they now need one of
more than 16 MiB at level 20, 32 MiB at level 21, and 64 MiB at level 22 or
with `--long`. Frames that zstd compresses with a known size, such as those
of `zstdCompress()`, need no window larger than their content and decode
under any limit that their content fits in.
