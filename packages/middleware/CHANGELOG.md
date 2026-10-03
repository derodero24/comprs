# @derodero24/comprs-middleware

## 1.1.0

### Minor Changes

- 4f19597: The Fastify plugin now compresses Web `ReadableStream` and `Response`
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
- af30a69: Follow RFC 9110 in all adapters. `deflate` responses now use the zlib format
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

### Patch Changes

- 2429445: Fix the Express adapter for handlers that send the response headers before
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
- dd3f2b6: The Hono middleware now compresses streamed responses while they are sent,
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
- 8d84a8d: The package can now be loaded with `require()` as well as `import`. Its
  entry points were exported for `import` only, so `require()` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, and TypeScript projects that compile to
  CommonJS reported `TS2307`. `@derodero24/comprs-middleware/package.json` is
  exported too. The package still ships ES modules only, so it now requires
  Node.js 22.12 or later instead of 22.0: 22.12 is the first Node.js 22 release
  whose `require()` loads ES modules without a flag. A TypeScript project that
  compiles to CommonJS needs `module` set to `nodenext` or `node20`.
  
  Express is no longer a peer dependency: the Express adapter only uses the
  Node.js request and response, and works with Express 4 and 5.
  
  The `@derodero24/comprs` peer range is now `^2.0.2` (it was `^2.0.0`). When
  both packages are released together, the middleware is now published only
  after `@derodero24/comprs`, so its peer range can always be met. The
  published manifest no longer lists `workspace:*` for the `@derodero24/comprs`
  devDependency, and the package now includes its license file.
- 4f19597: Read `Vary` as a list of field names when adding `Accept-Encoding` to it. A
  `Vary` that names a field merely containing `accept-encoding`, such as
  `X-Accept-Encoding-Hint`, now gets `Accept-Encoding` added, which it used to
  miss, and a `Vary` that lists `*` next to other field names is left as it is.

## 1.0.0

### Patch Changes

- Updated dependencies [da8d285]
  - @derodero24/comprs@2.0.0

## 0.3.0

### Minor Changes

- 9232666: Restructure middleware to subpath exports with Fastify and Hono support

  - Add `@derodero24/comprs-middleware/express` subpath export
  - Add `@derodero24/comprs-middleware/fastify` Fastify plugin
  - Add `@derodero24/comprs-middleware/hono` Hono middleware
  - Extract shared logic (negotiate, compress, types) into framework-agnostic modules
  - Root export (`@derodero24/comprs-middleware`) now exports shared utilities only

## 0.2.0

### Minor Changes

- e7c9ef6: Add HTTP compression middleware for Express with zstd, brotli, gzip, and deflate support
