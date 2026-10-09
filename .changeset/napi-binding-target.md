---
'@derodero24/comprs': patch
---

The Node.js entry of the package root now also exports
`__napiBindingTarget`, through `require()` and `import`. The loader that
@napi-rs/cli 3.10 generates adds it to report which binding it loaded.
It is declared as `'native' | 'wasm32-wasi' | 'wasm32-wasip1'`, and with
the native addons that this package publishes its value is `'native'`.
It comes from napi-rs and is not part of the comprs API. The browser
entry and the `streams` and `node` subpaths do not export it.
