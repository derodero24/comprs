---
'@derodero24/comprs': patch
---

Shrink the WebAssembly build that browsers load. `comprs-wasm_bg.wasm`,
which 2.0.2 compiled for speed, is now compiled for size, which makes the
same code about a fifth smaller, 14% smaller to download with gzip (level
9) and 12% smaller with brotli (quality 11). The README lists the sizes of
the current build, under "WASM bundle size". In exchange, brotli
compression runs about 40% slower in the browser, brotli decompression
about 30%, gzip decompression about 20% and LZ4 compression about 10%
slower; zstd, gzip compression and LZ4 decompression keep their speed. The
native addon is unchanged.
