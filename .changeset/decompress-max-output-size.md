---
'@derodero24/comprs': minor
---

Add an optional `maxOutputSize` argument to `decompress()` and
`decompressAsync()`, in the native addon and the WASM build. Like the
`maxOutputSize` of `createDecompressStream()`, it limits the decompressed
size in bytes whatever the detected format, and it defaults to 256 MB, so
code that auto-detects the format no longer has to call `detectFormat()`
and dispatch to the `*DecompressWithCapacity()` functions to set another
limit. A second argument used to be silently ignored and is now the limit,
so code that passes one by accident, such as `buffers.map(decompress)`,
which passes the array index, must call `buffers.map((data) =>
decompress(data))` instead. Values that are not integers from 0 to
`Number.MAX_SAFE_INTEGER` throw.
