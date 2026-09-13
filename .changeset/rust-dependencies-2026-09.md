---
'@derodero24/comprs': patch
---

Update Rust crate dependencies to their latest semver-compatible versions
(zstd 0.14, lz4_flex 0.14, brotli 8.0.4, crc32fast 1.5.1, napi 3.12,
wasm-bindgen 0.2.128, js-sys 0.3.105, thiserror 2.0.20, and transitive
crates). flate2 stays pinned at 1.1.9 because 1.1.10 regresses gzip and
deflate throughput with the zlib-rs backend. These compile into the
published native binary and WASM build.
