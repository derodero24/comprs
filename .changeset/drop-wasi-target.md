---
'@derodero24/comprs': minor
---

Stop building and publishing `@derodero24/comprs-wasm32-wasi`, the WASI
build of the native addon; 2.0.2 is its last version. Since 2.0.2 it was no
longer an optional dependency of `@derodero24/comprs`, so it was only used
where it had been installed by hand. Node.js, Deno and Bun keep loading the
native addon for their platform. The wasm-bindgen build, which the
package's `browser` entry loads, is now the only WebAssembly build.

If you installed `@derodero24/comprs-wasm32-wasi` or set
`NAPI_RS_FORCE_WASI`, uninstall the package and unset the variable: on a
supported platform the native addon loads instead, and in browsers the
wasm-bindgen build. The generated loader still looks for the WASI package
when no native binary loads or when `NAPI_RS_FORCE_WASI` is `true` or
`error`, so a copy left in `node_modules` would be loaded with a newer
`@derodero24/comprs` whose API it does not match. On a platform without a
native binary, loading comprs in Node.js, Deno or Bun throws `Cannot find
native binding`; if you relied on the WASI build there, stay on
`@derodero24/comprs` 2.0.x.
