---
'@derodero24/comprs': patch
---

Fix the type declarations of the ES module entry. `index.d.mts` re-exported
declaration files, which TypeScript rejects with TS2846, so ES module
projects that type-check their dependencies (`skipLibCheck: false`) got two
errors from `node_modules`. It now re-exports `./index.js` and
`./streams.js`, and the exported types are unchanged.
