---
'@derodero24/comprs': patch
---

Brotli stream compression at qualities 0 and 1 no longer compresses small
chunks far worse than large ones. At those qualities the encoder
compresses the input of each call on its own: written in chunks of 100
bytes, 300 KB of text that compresses to 120 bytes in one call took
204,335 bytes at quality 1, and 233,478 bytes of 300 KB of random words
that compress to 53,598. `BrotliCompressContext`, the streams and Node.js
Transforms built on it, and the `CompressionStream` of
`@derodero24/comprs/next`, in the Node.js and browser builds, now pass
their input to the encoder in blocks of 64 KiB at qualities 0 and 1, so
that their output is the same however the input is split into chunks.
`transform()` holds up to 64 KiB of input until it completes a block, and
`flush()` and `finish()` compress what it holds. Qualities 2 to 11 are
unchanged.
