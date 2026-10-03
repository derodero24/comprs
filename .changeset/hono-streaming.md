---
'@derodero24/comprs-middleware': patch
---

The Hono middleware now compresses streamed responses while they are sent,
instead of reading the whole body first. A `stream()` or `streamText()`
response reaches the client as the handler writes it, and one that never ends
no longer hangs; the body is read only as fast as the client takes it, and is
no longer held twice through `Response.clone()`. A body that is available at
once, such as that of `c.text()` or `c.json()`, is compressed in one call on
the libuv thread pool instead of on the event loop. Errors are no longer
swallowed: one that occurs before the response is sent, such as a failed
compression or a body stream that fails right away, goes to the app's error
handler, and a body stream that fails later aborts the response. The README
now states that the Hono middleware runs on Node.js and Bun, not on edge
runtimes such as Cloudflare Workers.

This also changes three details of the Hono middleware: a failed compression
produces the error handler's response instead of the uncompressed body; a
streamed body has no known size, so `threshold` only applies to it when the
response declares a `Content-Length`; and a body that is available at once
loses the `Transfer-Encoding: chunked` that `streamText()` sets, so that the
server can send it with a `Content-Length`.
