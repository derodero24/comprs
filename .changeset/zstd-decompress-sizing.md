---
'@derodero24/comprs': patch
---

Size zstd one-shot decompression output from the data instead of reserving
it up front. `zstdDecompress()`, `zstdDecompressWithDict()`, their async
variants and `decompress()` reserved 256 MB for every frame without a
content size, which streaming encoders such as `ZstdCompressContext` write,
and the `*WithCapacity()` variants allocated the whole `capacity`, so a value
such as `2 ** 40` aborted the process. The output buffer now grows with the
decompressed data: frames that declare their size still decode straight
into a buffer of that size, as long as the input could actually expand to
it, and everything else goes through the streaming decoder. `capacity` is
only a limit, and output over it throws `zstd decompress exceeded maximum
size of <capacity> bytes` like the other formats, instead of `Destination
buffer is too small`.

The one-shot zstd functions now accept concatenated frames and skippable
frames, as the streaming API already did, and report truncated input as
`zstd stream is truncated: unexpected end of input`; data after the last
frame now usually reports `Unknown frame descriptor` instead of `Src size is
incorrect`. Like the streaming API and `zstd -d`, they reject a frame
without a content size whose window exceeds 128 MiB (written by
`zstd --long=28` or higher on piped input) with `Frame requires too much
memory for decoding`.
