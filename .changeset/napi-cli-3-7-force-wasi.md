---
'@derodero24/comprs': patch
---

Regenerate the napi-rs loader with `@napi-rs/cli` 3.7. The generated
`index.js` now treats `NAPI_RS_FORCE_WASI` as a tri-state flag: only `'true'`
or `'error'` force the WASI fallback, so values like `NAPI_RS_FORCE_WASI=false`
or `=0` no longer inadvertently trigger the WASI path (which could fail with
ENOENT for packages shipped without a `.wasi.cjs` file).
