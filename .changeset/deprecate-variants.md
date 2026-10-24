---
'@derodero24/comprs': minor
---

Deprecate the `*WithCapacity`, `*WithDict` and `*WithDictWithCapacity` functions of the package root and their `*Async` forms, in favor of the `maxOutputSize` and `dictionary` options of `compressSync()`, `decompressSync()`, `compress()` and `decompress()` of `@derodero24/comprs/next` (#577). They keep working in 2.x. Their declarations carry a `@deprecated` tag that names the replacement, so editors show them struck through, and link to the table of replacements on the website (https://derodero24.github.io/comprs/reference/classic-api/#deprecated-functions).
