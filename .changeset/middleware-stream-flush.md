---
'@derodero24/comprs-middleware': minor
---

Streamed responses of the Express and Fastify adapters now reach the client
whenever the handler stops writing, as with the Hono middleware, instead of
only once the encoder's buffer filled or the response ended, so a streamed
page, a token stream or a response that never ends flows as it is written.
Writes that come together are still compressed together. The Express
adapter adds `res.flush()`, as `compression` does, which sends the output
so far right away; React's `renderToPipeableStream` calls it. Importing the
adapter adds `flush()` to the type of Express's `Response`.

A streamed response that is aborted or fails now releases the native state
of its encoder right away in every adapter, instead of when the garbage
collector gets to it; for zstd at level 19, that state is about 90 MB. The
Express and Fastify adapters close the encoder when the compressing stream
is destroyed, for `deflate` as well, and the Hono middleware closes it when
the compressed body is cancelled or its stream fails.

The `@derodero24/comprs` peer range is now `^2.1.0` (it was `^2.0.2`), as
the middleware now calls the `close()` that 2.1 adds to the stream contexts.
