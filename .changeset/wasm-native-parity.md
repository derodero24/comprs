---
'@derodero24/comprs': patch
---

Make the WebAssembly build take and return what the native addon does.
Its `gzipCompressWithHeader()` took `(data, level, filename, mtime)`
rather than the `(data, header, level)` of the published types, so
`gzipCompressWithHeader(data, { filename }, 6)` failed with
`RuntimeError: memory access out of bounds`. It now takes
`(data, header, level)`, as the native addon does; the positional form was
never part of the published types, and calls that use it must pass the
header as an object. `gzipReadHeader()` now leaves out the header fields
that are absent, rather than setting them to `null`, as the native addon
does.

Byte array arguments are now checked as the native addon checks them:
anything but a `Uint8Array` (a `Buffer` is one) or another `ArrayBuffer`
view throws an `Error`. The WebAssembly build used to compress an
`ArrayBuffer` as empty input and a string as one zero byte per character,
and its stream contexts took an `ArrayBuffer` or an array of numbers as a
chunk.
