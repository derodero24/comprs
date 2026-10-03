---
'@derodero24/comprs': patch
---

Enforce `maxOutputSize` while streaming decompression runs instead of after
each chunk. The gzip, deflate and brotli decompression streams and contexts
used to inflate a whole input chunk before checking the limit, so one small,
highly compressed chunk could allocate gigabytes before the size-limit error.
They now stop as soon as the output would exceed the limit, keeping memory
near `maxOutputSize`. `finish()` on `GzipDecompressContext` and
`DeflateDecompressContext` now counts its output toward the limit too.
