---
'@derodero24/comprs': minor
---

`CompressionStream` and `DecompressionStream` from `@derodero24/comprs/next`
are ponyfills of the classes of the Compression Streams standard, in Node.js
and in browsers. They cover zstd, gzip, deflate (zlib), deflate-raw, brotli
and lz4, and `'auto'` for decompression, with the `level`, `dictionary`,
`gzipHeader`, `workers` and `maxOutputSize` options and the error codes of
the unified API. In Node.js, chunks that take 2 ms or more run on the libuv
thread pool. The WebAssembly binary grows by about 6 KB with gzip.
