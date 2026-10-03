---
'@derodero24/comprs': patch
---

Write a content checksum in LZ4 frames. `lz4Compress()`,
`lz4CompressAsync()`, `Lz4CompressContext` and the LZ4 compression streams
now add an xxHash32 of the data to each frame, as the `lz4` CLI does by
default, so decompression detects corrupted data instead of returning it.
The output is still a standard LZ4 frame that any LZ4 decoder reads, 4 bytes
longer than before, and its FLG byte changes from `0x60` to `0x64`.
Computing the checksum makes compression about 15% slower, and verifying it
makes decompressing these frames up to about 30% slower. Frames without a
checksum, as other encoders may write them, still decode.
