---
'@derodero24/comprs': patch
---

`flush()` of `GzipCompressContext` and `DeflateCompressContext` now emits
all the input written so far, in the Node.js and browser builds. After a
`transform()` of much poorly compressible input, such as random or already
compressed data, a flush could leave up to about 16 KiB of it in the
encoder until the next call, so a client decoding the output as it arrives,
such as that of a response the middleware flushes while its handler waits,
got less than had been written. A flush that was already complete returns
the same bytes as before.
