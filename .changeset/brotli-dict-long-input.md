---
'@derodero24/comprs': patch
---

`brotliCompressWithDict()`, `brotliCompressWithDictAsync()`, a
`BrotliCompressDictContext` without `{ incremental: true }` and `compress()`
of `@derodero24/comprs/next` with a brotli dictionary now compress an input
of more than 8 MiB without the dictionary, and without brotli's built-in
one, into output that decodes the same with or without the dictionary. The
brotli encoder could panic on such inputs with a dictionary: the browser
build threw `RuntimeError: unreachable`, and the native addon compressed the
input twice. The output of shorter inputs does not change.
