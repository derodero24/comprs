---
'@derodero24/comprs': patch
---

Update flate2 to 1.1.10 with its `runtime_detection` feature, so zlib-rs
keeps using SIMD and CRC instructions and gzip and deflate keep their
speed in the native binary. One-shot gzip decompression (`gzipDecompress`,
its variants and `decompress`) of input that ends inside the compressed
data can now report "incomplete deflate stream" instead of "unexpected end
of file"; the gzip streams and contexts report the same errors as before.
