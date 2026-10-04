---
'@derodero24/comprs': patch
---

Shrink the WebAssembly build that browsers load. `comprs-wasm_bg.wasm` is
now compiled for size: it is 1.87 MB instead of 2.37 MB, and 14% smaller to
download with gzip (792 KB at level 9) and 12% smaller with brotli (545 KB
at quality 11). In exchange, brotli compression runs about 40% slower in
the browser, brotli decompression about 30%, gzip decompression about 20%
and LZ4 compression about 10% slower; zstd, gzip compression and LZ4
decompression keep their speed. The native addon is unchanged.
