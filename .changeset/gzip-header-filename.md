---
'@derodero24/comprs': patch
---

Reject gzip header filenames that cannot be stored. `gzipCompressWithHeader()`
with a `filename` that contains a NUL character (`'\u0000'`) aborted the
Node.js process, and trapped with `RuntimeError: unreachable` in the WASM
build. It now throws `gzip filename must not contain NUL characters`. A
filename longer than 65535 bytes in UTF-8 was written, but `gzipDecompress()`
and `gzipReadHeader()` could not read the result back; it now throws `gzip
filename must be at most 65535 bytes long`.
