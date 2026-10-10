---
'@derodero24/comprs': minor
---

`Dictionary.from(bytes, { format, level })` in `@derodero24/comprs/next`
prepares a zstd or brotli dictionary once, which makes repeated zstd
compression and decompression of small messages with a dictionary much
cheaper: the `dictionary` option of `compress`, `decompress` and their
`*Sync` variants takes it in place of the bytes of a dictionary, and
decompression defaults to its format. `close()`, or a `using` declaration,
frees it early.
