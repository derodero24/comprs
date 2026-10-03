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

Reject truncated input instead of returning a shorter result. The zstd,
brotli and raw deflate decompression streams, `DeflateDecompressContext` and
the `deflateDecompress*()` functions used to succeed with whatever had been
decoded when the input ended mid-stream; they now throw `<format> stream is
truncated: unexpected end of input`. The zstd and brotli decompression
contexts gain a `finish()` method that performs this check, and their
streams, including the auto-detecting ones, call it when their input ends.

Empty input now throws for every format, in the one-shot functions and in
the streams alike, because no format has a valid zero-length encoding.
`zstdDecompress*()`, `deflateDecompress*()`, `lz4Decompress*()` and most
decompression streams used to return an empty result for it.
