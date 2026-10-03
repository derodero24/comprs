---
'@derodero24/comprs': patch
---

Reject a `maxDictSize` above 16 MiB (16777216 bytes) in
`zstdTrainDictionary()` and `zstdTrainDictionaryAsync()`. The value was
allocated up front, so one that could not be allocated, such as `2 ** 40`,
aborted the process (a trap in the WASM build). zstd recommends
dictionaries of about 100 KB, and training allocates several buffers of
`maxDictSize` bytes.
