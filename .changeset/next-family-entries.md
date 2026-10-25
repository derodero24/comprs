---
"@derodero24/comprs": minor
---

Add `@derodero24/comprs/next/zstd`, `/gzip`, `/brotli` and `/lz4`: the unified API for one family of formats each. In browsers, each loads a WebAssembly build with that family alone, 42 KB to 337 KB with gzip instead of 568 KB for every format; in Node.js, they use the native addon for the same formats. Their declarations take the formats of the family alone, and entry points imported together share their formats, with detection across them. `CompressOptions`, `DecompressOptions` and `DictionaryOptions` take the formats as an optional type parameter.
