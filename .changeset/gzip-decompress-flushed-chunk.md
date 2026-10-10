---
'@derodero24/comprs': patch
---

`transform()` of `GzipDecompressContext` now returns all the output of its
chunk, in the Node.js and browser builds. It kept the last 32 KiB or less
until the next call, so a gzip stream that is flushed after each message,
such as a response the middleware flushes after each event, reached a
reader of `createGzipDecompressStream()`, `createGzipDecompressTransform()`
or the auto-detecting streams one message late, and a short message not at
all until the next one.
