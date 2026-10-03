---
'@derodero24/comprs': patch
---

Make the browser entry work with bundlers. In 2.0.x, browser builds of
`import … from '@derodero24/comprs'` failed with esbuild and webpack, and
Vite produced a bundle that threw on the first call: resolvers picked the
Node.js entry before the `browser` one, webpack refused to parse the
browser files as ES modules, `"sideEffects": false` let bundlers drop the
WebAssembly initialisation, esbuild could not bundle the `.wasm` import,
and the 2.0.2 browser entry imported the WASI package, which 2.0.2 does not
install.

Imports under the `browser` condition now resolve to the WebAssembly build,
ahead of the Node.js entry, with type declarations that describe it rather
than the native addon. The browser files moved to a `browser/` directory
that declares `"type": "module"`, and the entry instantiates the
WebAssembly module with top-level `await`, from
`new URL('./comprs-wasm_bg.wasm', import.meta.url)`: the functions are
ready once the import resolves, with no init call. Bundlers must support
top-level `await`. webpack 5 and Vite emit the `.wasm` file as an asset;
with esbuild, copy `browser/comprs-wasm_bg.wasm` next to the bundle. On
Vite 7 and older, `vite dev` needs
`optimizeDeps: { exclude: ['@derodero24/comprs'] }`, and before Vite 7,
`vite build` needs `build.target: 'es2022'`.

`require()` cannot load a module that uses top-level `await`, so
`require('@derodero24/comprs')` keeps loading the native addon even where
the `browser` condition is set, as in Jest with a jsdom environment. Under
Jest's ES module support, that environment now imports the WebAssembly
build, which does not load in Jest; set
`testEnvironmentOptions: { customExportConditions: ['node', 'node-addons'] }`
to keep the native addon. The top-level browser files (`browser-entry.js`,
`browser.js`, `browser-streaming.js` and `comprs-wasm*`) and the `browser`
field of `package.json`, which pointed at `browser-entry.js`, are gone.
