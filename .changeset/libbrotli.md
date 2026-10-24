---
'@derodero24/comprs': minor
---

Brotli now runs on Google's brotli C library, libbrotli 1.2.1, in every build, including the WebAssembly one, instead of the Rust port. `node:zlib` uses the same library, in a release that depends on the Node.js version. Compression writes the same bytes as `node:zlib` at every quality (checked against Node.js 22, which bundles libbrotli 1.1.0) and is as fast: on x86-64 Linux, 1 MB of JSON at the default quality compresses in 19.5 ms instead of 29.1 ms, and 150 bytes in 0.016 ms instead of 0.088 ms. Decompression is as fast as before or faster. The WebAssembly module is 29% smaller with gzip (567 KB instead of 801 KB at level 9) and 18% smaller raw (1.52 MB instead of 1.84 MB).

Dictionary compression (`brotliCompressWithDict()`, its async and streaming forms, and dictionary contexts) now uses the dictionary for inputs of any length: it used to compress inputs longer than 8 MiB, and the input of incremental dictionary contexts and streams past their first 4 MiB, without it, and to compress some inputs at qualities 2 to 9 twice to recover from a panic of the Rust encoder (#623, #703). Each thread keeps the last four dictionaries of up to 256 KiB that it prepared, so repeated calls with the same dictionary no longer prepare it again: compressing 150 bytes with a 4 KiB dictionary takes 0.017 ms instead of 0.07 ms.

Decompression of large-window brotli streams is still rejected, as before.
