---
'@derodero24/comprs-middleware': minor
---

Follow RFC 9110 in all adapters. `deflate` responses now use the zlib format
(RFC 1950) that the `deflate` content coding requires, instead of raw DEFLATE
that strict clients such as `zlib.inflateSync()` reject. `Accept-Encoding` is
parsed case-insensitively, including the `q` parameter, and an element whose
weight is not a valid `qvalue` is ignored instead of read as `q=1`; the
server's `encodings` order still decides among the encodings the client
accepts. `Vary: Accept-Encoding` is added to every response that could be
compressed, also for `HEAD` requests and requests without `Accept-Encoding`,
and to no other response. As the `filter` takes part in that decision, it is
now also called for requests that do not get compressed. Responses with
status 204, 304 or 206, with a `Content-Range` header, or with an empty body
are no longer compressed, and compressed responses get a weak `ETag`.
`text/event-stream` responses are no longer compressed, so Server-Sent Events
are not held back. The Hono adapter no longer keeps a `Content-Length` set by
the handler on a compressed response, and the Fastify adapter no longer
responds with 500 when a route sets `Vary` or `Cache-Control` as an array.

The options are now checked when the middleware is created: an empty or
unsupported `encodings` list, a level that is not an integer in its range or
that names an unknown encoding, a `threshold` that is not a finite number of 0
or more, or a `filter` that is not a function throws a `TypeError` or
`RangeError` instead of failing on each request. zstd levels 20 to 22 are
rejected, because their window exceeds the 8 MiB that RFC 9659 allows for
HTTP and Chromium refuses such responses. `encodings` and the `preferred`
argument of `negotiate()` accept readonly arrays.
