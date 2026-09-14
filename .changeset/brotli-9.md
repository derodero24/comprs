---
'@derodero24/comprs': patch
---

Update the `brotli` crate to 9.0 (with `brotli-decompressor` 6.0) and the
Criterion benchmark harness to `codspeed-criterion-compat` 5.0. The brotli
API and output format used by comprs are unchanged; this ships in the
native binary and WASM build.
