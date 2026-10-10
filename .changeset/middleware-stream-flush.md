---
'@derodero24/comprs-middleware': patch
---

A streamed response that is aborted or fails now releases the native state
of its encoder right away in every adapter, instead of when the garbage
collector gets to it; for zstd at level 19, that state is about 90 MB. The
Express and Fastify adapters close the encoder when the compressing stream
is destroyed, for `deflate` as well, and the Hono middleware closes it when
the compressed body is cancelled or its stream fails.

The `@derodero24/comprs` peer range is now `^2.1.0` (it was `^2.0.2`), as
the middleware now calls the `close()` that 2.1 adds to the stream contexts.
