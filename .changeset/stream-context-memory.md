---
'@derodero24/comprs': minor
---

Report the native memory of the stream contexts to V8 and allow releasing
it early. A context keeps its encoder or decoder state outside the
JavaScript heap, from a few hundred kilobytes for gzip to about 90 MB for
zstd at level 19, but V8 saw only a small object and had no reason to
collect it. A server that dropped contexts, such as the streams of aborted
responses, could grow to gigabytes before an unrelated garbage collection
freed them. The contexts now report their memory, so that V8 collects
abandoned contexts in time.

Every context class gains a `close()` method that releases the native state
right away; later calls throw `<format> stream already closed`. Contexts are
also disposable, so `using ctx = new ZstdCompressContext()` closes the
context at the end of the scope. `finish()` releases the state too, and
`Lz4DecompressContext` gains the `finish()` that the other contexts have.
The Web streams and Node.js Transforms close their context when they end,
fail, or are cancelled or destroyed. The contexts of the browser build gain
`close()` and `Lz4DecompressContext.finish()` as well.
