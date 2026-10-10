---
'@derodero24/comprs': minor
---

LZ4 decompression streams now emit each block as soon as all of it has
arrived, and hold at most one block of their input (up to 4 MiB, or 8 MiB
in a legacy frame), instead of the whole input until it ends:
`createLz4DecompressStream()`, `createLz4DecompressTransform()`, and
`createDecompressStream()` and `createDecompressTransform()` for LZ4 input.
They report data after the last frame on the chunk that holds it.

`Lz4DecompressContext` accepts `{ incremental: true }` as a second argument,
which the streams use: `transform()` then returns each block as it
arrives and throws as soon as the input is invalid, `flush()` returns
nothing, `finish()` throws unless the input ended between frames, and
`maxOutputSize` limits the output of the whole stream. Without it, the
context keeps its documented buffering behaviour, including the output
limit that applies to each `flush()` on its own. The `StreamContextOptions`
type declares the options.
