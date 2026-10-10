---
'@derodero24/comprs': patch
---

Bound the window of the zstd decoders by the output limit. A zstd frame
header can declare a window, or for a single-segment frame a content size,
of up to 128 MiB, which the streaming decoder allocated as soon as it had
read the header, whatever `capacity` or `maxOutputSize` said. Stream
contexts decode every frame with it, and the one-shot functions any input
whose frame headers do not size the output, such as frames without a
content size: 100 `ZstdDecompressContext`s with a `maxOutputSize` of 1024
bytes, fed the 6-byte header of such a frame, held 12.5 GiB of address
space and reported it to V8, and the WebAssembly build grew its memory by
128 MiB for good.

`zstdDecompressWithCapacity()`, `zstdDecompressWithDictWithCapacity()`,
their async variants, `decompress()` and `decompressAsync()` for zstd input,
`ZstdDecompressContext`, `ZstdDecompressDictContext` and the zstd
decompression streams now accept a window of at most the limit rounded up
to a power of two, but never less than 8 MiB, the most that zstd writes at
levels up to 19, nor more than zstd's default of 128 MiB. A frame whose
window exceeds the bound fails before the decoder allocates anything, in
one of two ways:

- A limit of 64 MiB or less lowers zstd's bound, and the frame throws
  `zstd frame window exceeded maximum size of <limit> bytes`, the size-limit
  error. Raising the limit decodes the frame if its window is at most
  128 MiB; a window over 128 MiB throws the same error, although no limit
  decodes it.
- A limit of more than 64 MiB, such as the default of 256 MB, keeps zstd's
  bound of 128 MiB, and a frame whose window exceeds it still throws zstd's
  `Frame requires too much memory for decoding`, a corrupt-data error.

Of the frames that zstd writes, only those without a content size whose
window exceeds 8 MiB can now fail under a limit that their output fits in:
streams that `ZstdCompressContext`, the streams built on it or
`zstd --ultra` reading a pipe compress at levels 20 to 22, and streams
compressed with `zstd --long`. Under an explicit limit, they now need one of
more than 16 MiB at level 20, 32 MiB at level 21, and 64 MiB at level 22 or
with `--long`. Frames that zstd compresses with a known size, such as those
of `zstdCompress()`, declare no window larger than their content and decode
under any limit that their content fits in.
