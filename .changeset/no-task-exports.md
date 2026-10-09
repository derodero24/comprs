---
'@derodero24/comprs': patch
---

`require('@derodero24/comprs')` no longer lists 23 undeclared `*Task`
classes, such as `ZstdCompressTask`, that napi-rs generated for the
`*Async` functions and that could not be constructed. The ES module entry,
which now re-exports the CommonJS loader, does not list them under Bun and
bundlers either. The `*Async` functions, their results and their errors
are unchanged.
