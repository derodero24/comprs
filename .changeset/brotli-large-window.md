---
'@derodero24/comprs': patch
---

Reject Large Window Brotli streams in every brotli decompression function,
stream context and `decompress()`, as RFC 7932 decoders and Node.js zlib
do. Their header declares a window of up to 1 GiB, and the decoder
reserved a buffer of that size before writing any output, whatever the
output limit: 12 bytes of input grew the memory of the WebAssembly build
to 1.5 GiB, which it never returns. comprs does not write these streams;
only encoders with the extension explicitly enabled do.
