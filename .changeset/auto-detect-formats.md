---
'@derodero24/comprs': patch
---

Detect every supported format reliably in `detectFormat()`, `decompress()`,
`decompressAsync()`, `createDecompressStream()` and
`createDecompressTransform()`. The empty brotli stream that
`brotliCompress()` writes for empty input, zstd and LZ4 frames that follow
skippable frames, and LZ4 legacy frames (`lz4 -l`) used to be reported as
`'unknown'`; they are now detected. The auto-detecting streams decided on
the format after 4 bytes and failed on brotli input that arrived in small
chunks; they now buffer the input until the format is detected, up to
64 KiB.

Brotli, which has no magic number, is now recognized by decoding up to the
first 64 KiB of the input instead of a single byte. Random data shorter than
64 KiB and raw deflate, some of which used to be reported as `'brotli'`, are
now `'unknown'`, and so is data that continues after the end of a brotli
stream shorter than 64 KiB, which `decompress()` used to decompress while
ignoring the rest. When data detected as brotli does not decode, including
a truncated brotli stream, `decompress()` throws the `unable to detect
compression format` error instead of a brotli error. That error now also
points to `deflateDecompress()` for raw deflate.
