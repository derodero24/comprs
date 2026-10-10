---
'@derodero24/comprs': patch
---

gzip, zlib and raw deflate stream compression no longer compresses small
chunks worse than large ones. At levels 5 and 6 (6 is the default), the
output of zlib-rs depends on how its calls split the input: a stream
written in chunks of 1,000 bytes compressed repetitive text 17% larger
than in one call, and in chunks of 100 bytes 57% larger.
`GzipCompressContext`, `DeflateCompressContext`, the streams and Node.js
Transforms built on them, and the `CompressionStream` of
`@derodero24/comprs/next`, in the Node.js and browser builds, now compress
their input in blocks of 32 KiB, so that their output is the same however
the input is split into chunks, and small chunks compress faster.
`transform()` holds up to 32 KiB of input until it completes a block, and
`flush()` and `finish()` compress what it holds.

A stream that is flushed when its input pauses, as the middleware does,
still sends each write promptly: a small write now reaches the client with
that flush, the gzip header and the response headers included, instead of
partly before it.
