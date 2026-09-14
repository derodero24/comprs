---
'@derodero24/comprs': patch
---

Regenerate the napi-rs loaders with `@napi-rs/cli` 3.9.1. The browser WASI
loader shipped in `@derodero24/comprs-wasm32-wasi` keeps lazy worker reuse
(`reuseWorker: true`): the eager worker pool that 3.9 generates makes
`@emnapi/wasi-threads` call Node-only worker APIs under Bun and Deno.
