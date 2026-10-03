---
'@derodero24/comprs': patch
---

Make the stream contexts of the browser entry stream. They were JavaScript
stand-ins that kept every chunk until the end and then ran the one-shot
function: they held the whole input in memory, kept a view of each chunk
rather than a copy, so a caller that reused its buffer compressed
overwritten data, returned nothing from `flush()` (or, when decompressing
zstd, brotli or LZ4, ended the stream there), reported corrupt input only
at the end, and passed a zstd `maxOutputSize` on as a capacity that grew
the WebAssembly memory to that size. The browser entry now exports the
stream contexts of the WebAssembly build, which work like the native
ones: `transform()` and `flush()` return output as soon as it is ready,
so code that kept only what `finish()` returned must keep what every call
returns, as on Node.js. Like those, they have `close()`, which
`[Symbol.dispose]()` calls, and `Lz4DecompressContext.finish()`; they
also have a `free()` method, which frees the context object and its
WebAssembly memory before garbage collection does.
