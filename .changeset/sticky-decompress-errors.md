---
'@derodero24/comprs': patch
---

`DeflateDecompressContext`, `BrotliDecompressContext` and
`BrotliDecompressDictContext` now keep failing after an error, in the
Node.js and browser builds: once `transform()` has thrown, for example on
data after the end of the compressed stream, `flush()` and `finish()` throw
the same error instead of `finish()` returning the output decoded before
that data, and the context releases its decoder state at once. The other
decompression contexts already failed there. The streams, which close their
context on any error, are not affected.
