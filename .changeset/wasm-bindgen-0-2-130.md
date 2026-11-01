---
"@derodero24/comprs": patch
---

The browser WebAssembly builds use wasm-bindgen 0.2.130, which no longer leaks a value when converting some arguments. Each build is about 2 KB larger with gzip.
