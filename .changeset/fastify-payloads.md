---
'@derodero24/comprs-middleware': minor
---

The Fastify plugin now compresses Web `ReadableStream` and `Response`
payloads, which it used to send uncompressed. The status and headers of a
`Response` are applied to the reply first, as Fastify does, so the built-in
checks see them. `string`, `Buffer` and `Uint8Array` payloads are compressed
in one call on the libuv thread pool instead of through a stream, and are
sent with the `Content-Length` of the compressed body instead of chunked; if
that compression fails, the reply is sent uncompressed and a warning is
logged. A stream whose reply declares a `Content-Length` below `threshold`
is no longer compressed.

Add the `shouldCompress(request, reply)` option, which receives the Fastify
request and reply and so sees the headers set with `reply.header()` or
`reply.type()`. `filter(req, res)` keeps receiving `request.raw` and
`reply.raw`, which do not have those headers yet when it runs. A route can
opt out with `config: { compress: false }`, which the plugin adds to
Fastify's route config type. The plugin is now wrapped with `fastify-plugin`
and named `@derodero24/comprs-middleware`, so other plugins can list it in
their `dependencies`, and Fastify checks that it runs on Fastify 5.
`fastify-plugin` becomes a dependency of the package.
