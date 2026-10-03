---
'@derodero24/comprs': patch
---

Stop gzip decompression from reserving memory because of a forged size
trailer. `gzipDecompress()`, `gzipDecompressWithCapacity()`, their async
variants and `decompress()` sized their initial output buffer from the
ISIZE trailer, which nothing verifies until decoding ends, so a few bytes of
input could reserve up to 4 GiB, capped only by the output limit (256 MB by
default). The initial buffer is now also capped by what the input can
expand to and by 64 MiB, and larger outputs grow the buffer as they decode.
gzip, brotli and LZ4 decompression also report a failed reservation of the
initial output buffer as an error instead of aborting the process.
