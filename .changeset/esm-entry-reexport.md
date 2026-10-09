---
'@derodero24/comprs': patch
---

Derive the ES module entry from the CommonJS one. `index.mjs` listed every
export by hand and has drifted from the native addon before; it now
re-exports the CommonJS loader and the stream helpers with `export *`, so
the two entries cannot drift apart. Node.js and Deno see the same exports
as before. Bundlers now follow the entry into the loader and bundle it,
instead of leaving a `require('./index.js')` that fails once the bundle
moves; as before, the native addon itself must stay external.
