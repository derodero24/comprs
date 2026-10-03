---
'@derodero24/comprs': patch
---

Decode every frame of LZ4 input and reject truncated or trailing data.
`lz4Decompress()`, `lz4DecompressWithCapacity()`, their async variants,
`decompress()`, `Lz4DecompressContext` and the LZ4 decompression streams
used to stop at the end of the first frame and silently drop whatever
followed, accept a frame cut short at a block boundary, and reject input
that starts with a skippable frame. They now decode concatenated frames like
the `lz4` CLI, skip skippable frames, and also accept a legacy frame
(`lz4 -l`) followed by further frames, or with blocks of data that does not
compress, which used to fail with `BlockTooBig`. Input that ends inside a
frame, including a frame without its end mark, throws `lz4 stream is
truncated: unexpected end of input`, and a frame followed by data that is
not a frame throws an `unexpected data after the end of a frame` error. The
output limit (`capacity`, `maxOutputSize`) covers all frames together.
