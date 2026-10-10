---
'@derodero24/comprs': patch
---

Write LZ4 frames in blocks of at most 256 KiB. For more than 256 KiB of
input, `lz4Compress()` and `lz4CompressAsync()` wrote 4 MiB blocks, as the
`lz4` CLI does by default, so the encoder and every decoder of the frame
needed 4 MiB buffers. They now write 256 KiB blocks: compressing 1 MB of
repetitive data is about 3 times faster, and the output is about 0.3%
larger on text. They also make room for the whole frame up front, so
compressing 1 MB that does not compress is about 30% faster.
`Lz4CompressContext` and the LZ4 compression streams sized their blocks
from the first chunk and now always write 64 KiB blocks, so a first chunk
of more than 256 KiB no longer makes the context hold 8 MiB that it did not
report to V8; their output is then about 1.5 to 2% larger on text than with
the 4 MiB blocks that such a chunk gave. The compressed bytes change for
more than 256 KiB of input, and for streams whose first chunk holds more
than 64 KiB; they are still standard LZ4 frames that any LZ4 decoder reads.
