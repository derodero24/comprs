---
'@derodero24/comprs': patch
---

Buffers returned by the one-shot compression and decompression functions
no longer retain an allocation sized from the input. The encoders reserved
an output buffer as large as the input, and the decoders grew theirs by
doubling; the whole allocation lived as long as the returned Buffer, so 50
retained `brotliCompress()` results of an 8 MB input held about 400 MB of
memory for less than 1 KB of output. Results now release large spare
capacity before they are returned. The LZ4 compression streams also stop
copying each output chunk.
