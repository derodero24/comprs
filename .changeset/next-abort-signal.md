---
'@derodero24/comprs': minor
---

`compress`, `decompress` and `trainDictionary` from `@derodero24/comprs/next`
accept an `AbortSignal` as the `signal` option. An aborted call rejects with
the `reason` of the signal. In Node.js, a call whose work no thread of the
libuv pool has started yet rejects at once, and the pool skips the work; work
that has started finishes, and its result is discarded. The `*Async`
functions of the package root take no signal.
