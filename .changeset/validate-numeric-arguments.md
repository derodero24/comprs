---
'@derodero24/comprs': patch
---

Reject invalid numeric arguments instead of silently converting them.
Compression levels and qualities, the `crc32()` initial value and the gzip
header `mtime` were converted to 32-bit integers before any check ran, so
`NaN` and `Infinity` became 0 (no compression for gzip, deflate and brotli),
`1.9` became 1, `2 ** 32 + 1` became 1 and `crc32(data, -1)` used
`0xFFFFFFFF`. This applied to the one-shot and async functions and to the
stream contexts, in the native addon and in the WASM build, which also
turned non-numeric strings and objects into 0. `maxOutputSize` truncated
fractions (`0.5` became a limit of 0 bytes), and a `capacity` of `2 ** 64`
passed validation. All of these now throw an error that names the argument
and its accepted range, for example `gzip compression level must be an
integer between 0 and 9`; the messages of the existing range errors changed
to this form. `capacity` and `maxOutputSize` accept integers from 0 to
`Number.MAX_SAFE_INTEGER` on every platform (the WASM build used to reject a
`capacity` of `2 ** 32` or more), and a limit of 0 accepts only data that
decompresses to nothing. `maxDictSize` accepts integers from 0 to 16777216.
