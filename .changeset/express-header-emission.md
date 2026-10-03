---
'@derodero24/comprs-middleware': patch
---

Fix the Express adapter for handlers that send the response headers before
the body. The adapter now decides whether to compress when the headers are
emitted, so `res.writeHead()` and `res.flushHeaders()` no longer make the
response fail with `ERR_HTTP_HEADERS_SENT`. Compressed responses honor
backpressure: `res.write()` returns `false` while the client is slow and
`'drain'` follows, so `stream.pipe(res)` pauses instead of buffering the whole
body. A compressor error after the headers were sent aborts the response
instead of throwing an uncaught exception, and a client disconnect releases
the compressor. `Cache-Control` values set as arrays are checked for
`no-transform`. Writes after `res.end()` fail as they do on a plain
`ServerResponse`, passing `ERR_STREAM_WRITE_AFTER_END` to the callback and
emitting it as `'error'`, and `res.end()` callbacks run once the response has
finished.

Deciding at header emission also changes three details of the Express
adapter: a bare `res.end()` counts as an empty body for `threshold` instead
of producing an empty compressed stream, responses with status 204 or 304 are
no longer compressed, and `Vary: Accept-Encoding` is only added to responses
that could be compressed.
