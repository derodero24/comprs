---
'@derodero24/comprs': minor
---

New entry `@derodero24/comprs/next` for Node.js and browsers: `compress`,
`compressSync`, `decompress`, `decompressSync`, `detectFormat`,
`trainDictionary` and `trainDictionarySync`. It takes options objects,
supports zlib (`'deflate'`) and raw deflate (`'deflate-raw'`), returns plain
`Uint8Array` results, gives every error a stable `code`, and has a `workers`
option for zstd in Node.js. The root API is unchanged.
