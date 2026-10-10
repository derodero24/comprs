---
'@derodero24/comprs': patch
---

Decode LZ4 frames that declare large blocks faster. `lz4Decompress()`,
`lz4DecompressWithCapacity()`, their async variants, `decompress()` and
`decompressAsync()` on LZ4 input, `Lz4DecompressContext` and the LZ4
decompression streams zero-filled a buffer of the frame's block maximum
size on every call: 4 MiB for frames from the `lz4` CLI, which declares
4 MiB blocks by default even for small content. Each thread now keeps that
buffer for its next call while it holds at most 4 MiB, and only its growth
is zero-filled: decoding 10 KB from such a frame is about 35 times faster,
and 84 KB of JSON about 5 times. The 8 MiB buffer of a legacy frame
(`lz4 -l`) is not kept.
