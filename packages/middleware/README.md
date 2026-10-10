# @derodero24/comprs-middleware

HTTP compression middleware powered by [comprs](https://github.com/derodero24/comprs). Supports **Express**, **Fastify**, and **Hono** with **zstd**, **brotli**, **gzip**, and **deflate**.

## Features

- **Multi-framework** — Express, Fastify, and Hono via subpath imports
- **zstd, brotli, gzip, deflate** — all algorithms via a single package
- **Accept-Encoding negotiation** — parses `Accept-Encoding` as RFC 9110 defines it and picks the preferred encoding the client accepts
- **Configurable priority** — control which algorithm is preferred
- **Threshold support** — skip compression for small responses
- **Content-Type filtering** — only compresses known compressible types; skips responses without a Content-Type header
- **Rust-powered** — uses comprs native bindings for maximum throughput

## Installation

```bash
npm install @derodero24/comprs @derodero24/comprs-middleware
```

`@derodero24/comprs` 2.1 or later is a peer dependency. Fastify 5 and Hono 4 are optional peer dependencies, needed only by their adapters. Express is not a peer dependency, as the Express adapter does not use it (see [Express](#express)).

The package requires Node.js 22.12 or later. It consists of ES modules, which Node.js 22.12 and later load with `require()` as well as with `import`:

```js
const { comprs } = require('@derodero24/comprs-middleware/express');
```

In a TypeScript project that compiles to CommonJS, set `module` to `nodenext` (TypeScript 5.8 or later) or `node20` (TypeScript 5.9 or later): with those, TypeScript lets CommonJS files import ES modules, while with `node16` it reports error TS1479.

## Usage

### Express

```ts
import express from 'express';
import { comprs } from '@derodero24/comprs-middleware/express';

const app = express();
app.use(comprs());
```

The adapter is a Connect-style `(req, res, next)` middleware that only uses the Node.js `IncomingMessage` and `ServerResponse`, not Express itself, so it works with Express 4 and 5 and with other frameworks that run such middleware. The package's tests run it under Express 5.

### Fastify

```ts
import Fastify from 'fastify';
import { comprs } from '@derodero24/comprs-middleware/fastify';

const app = Fastify();
app.register(comprs);

// Leave the replies of one route alone
app.get('/raw', { config: { compress: false } }, async () => 'sent as it is');
```

### Hono

```ts
import { Hono } from 'hono';
import { comprs } from '@derodero24/comprs-middleware/hono';

const app = new Hono();
app.use(comprs());
```

The Hono middleware compresses with the native addon of `@derodero24/comprs`, so it runs on Node.js (with `@hono/node-server`) and Bun. Edge runtimes such as Cloudflare Workers cannot load the addon: use Hono's built-in [`hono/compress`](https://hono.dev/docs/middleware/builtin/compress) there, which compresses gzip and deflate with `CompressionStream`. Cloudflare Workers and Deno Deploy also compress responses themselves.

### Options

All adapters accept the same core options:

```ts
comprs({
  encodings: ['zstd', 'br', 'gzip'],   // Algorithm priority
  threshold: 512,                        // Min response size (bytes)
  level: { zstd: 3, br: 6, gzip: 6 },  // Per-algorithm levels
  filter: (req, res) => true,            // Custom filter (Express/Fastify)
})
```

The Fastify adapter also accepts `shouldCompress`, a filter that receives the Fastify request and reply:

```ts
app.register(comprs, {
  shouldCompress: (request, reply) => reply.getHeader('x-no-compression') === undefined,
});
```

The options are checked when the middleware is created: an unsupported encoding, an empty `encodings` list, a level that is not an integer in its range or that names an unknown encoding, a `threshold` that is not a finite number of 0 or more, or a `filter` or `shouldCompress` that is not a function throws a `TypeError` or `RangeError` (for Fastify, `register()` rejects with it).

## API

### Subpath exports

| Import path | Framework | Returns |
|-------------|-----------|---------|
| `@derodero24/comprs-middleware/express` | Express/Connect | `(req, res, next) => void` |
| `@derodero24/comprs-middleware/fastify` | Fastify | `FastifyPluginAsync` |
| `@derodero24/comprs-middleware/hono` | Hono | `MiddlewareHandler` |
| `@derodero24/comprs-middleware` | — | `negotiate()`, types |

### Option reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `encodings` | `readonly Encoding[]` | `['zstd', 'br', 'gzip', 'deflate']` | Algorithm priority order; must not be empty |
| `threshold` | `number` | `1024` | Minimum response size (bytes) to compress; finite, 0 or more |
| `level` | `LevelOptions` | `{}` | Per-algorithm compression levels (integers) |
| `filter` | `(req, res) => boolean` | — | Custom filter (Express/Fastify), applied on top of the built-in checks |
| `shouldCompress` | `(request, reply) => boolean` | — | Custom filter (Fastify only) that receives the Fastify request and reply |

> Hono adapter accepts `filter: (c: Context) => boolean` instead.

| Level | Range | Default |
|-------|-------|---------|
| `zstd` | -131072 to 19 | 3 |
| `br` | 0 to 11 | 6 |
| `gzip` | 0 to 9 | 6 |
| `deflate` | 0 to 9 | 6 |

zstd levels 20 to 22 are rejected: they need a window larger than the 8 MiB that [RFC 9659](https://www.rfc-editor.org/rfc/rfc9659#section-3) allows for the `zstd` content coding, and Chromium-based browsers refuse such responses.

The filter, like the Fastify adapter's `shouldCompress`, narrows the built-in checks rather than replacing them: a response whose Content-Type is not compressible stays uncompressed even when the filter returns `true`. Since the filter also decides whether `Vary` is added, it is called for requests that do not get compressed as well, such as `HEAD` requests and requests that accept none of the encodings.

### `negotiate(acceptEncoding, preferred?)`

Low-level Accept-Encoding negotiation. Returns the first encoding of `preferred` that the client accepts, or `null`.

```ts
import { negotiate } from '@derodero24/comprs-middleware';

negotiate('gzip, br;q=0.8, zstd');
// => 'zstd' (highest server preference accepted by client)
negotiate('gzip;q=0, *');
// => 'zstd' (* covers every encoding not listed; gzip is excluded)
```

The field is parsed as [RFC 9110, section 12.5.3](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.3) defines it: coding names and the `q` parameter are case-insensitive, `q=0` excludes an encoding, `*` stands for every encoding that is not listed, and an element whose weight is not a valid `qvalue` (0 to 1 with at most three decimals) is ignored. Without the field, or with an empty one, the result is `null`.

The server's order decides among the encodings the client accepts; the client's weights only rule encodings out. This is a deliberate choice, as in `@fastify/compress`: browsers send equal weights, and the server knows best which encoding it can produce efficiently.

## Behavior

All adapters automatically:

- Set `Content-Encoding` header
- Remove the `Content-Length` of the uncompressed body; the Fastify and Hono adapters send that of the compressed body instead when the body is in memory
- Turn a strong `ETag` into a weak one (`W/"..."`) on compressed responses, since a strong tag must differ between the compressed and the uncompressed representation ([RFC 9110, section 8.8.3.3](https://www.rfc-editor.org/rfc/rfc9110#section-8.8.3.3))
- Send `deflate` in the zlib format (RFC 1950), as [RFC 9110, section 8.4.1.2](https://www.rfc-editor.org/rfc/rfc9110#section-8.4.1.2) defines the coding
- Set `Vary: Accept-Encoding` on every response whose headers allow compression (none of the first four conditions below applies, and the `filter`, as well as `shouldCompress` on Fastify, returns `true`), whether or not this request gets compressed: also for `HEAD` requests, requests without `Accept-Encoding`, 304 responses and responses below the threshold. Other responses are never compressed and do not get it.
- Skip compression when:
  - Response already has `Content-Encoding`
  - `Cache-Control: no-transform` is set
  - Content-Type is not compressible (images, etc.) or is `text/event-stream`, whose events would otherwise be held back by the compressor
  - Content-Type is not set
  - Response has no content: status 1xx, 204 or 304, or an empty body
  - Response is a range: status 206 or a `Content-Range` header, whose offsets count uncompressed bytes
  - Response body is below threshold
  - Request method is `HEAD`
  - Client does not accept any supported encoding

### Express

The Express adapter decides whether to compress when the response headers are sent: by `res.writeHead()`, `res.flushHeaders()`, or the first `res.write()` or `res.end()`. Handlers may therefore send headers before the body, and header fields passed to `res.writeHead()` are taken into account.

A compressed response keeps the behavior of a plain `ServerResponse`:

- `res.write()` returns `false` while the client reads more slowly than the handler writes, and `'drain'` follows, so `stream.pipe(res)` pauses instead of buffering the body.
- Writes after `res.end()` fail with `ERR_STREAM_WRITE_AFTER_END`, and callbacks passed to `res.end()` run once the response has finished.
- A compression error aborts the response, and the compressor is released when the response closes, including when the client disconnects.
- Whenever the handler stops writing, the client receives what it has written so far, so a response that never ends still flows. Writes that come together are compressed together.

The adapter also adds `res.flush()`, as [`compression`](https://github.com/expressjs/compression) does: it sends the compressed output of what was written so far right away, without waiting for the handler to stop writing. React's `renderToPipeableStream` calls it when the destination has it. It does nothing when the response is not compressed or has ended. Importing the adapter adds `flush()` to the type of Express's `Response`.

### Fastify

The Fastify plugin compresses every payload type Fastify sends:

- A `string`, `Buffer` or `Uint8Array` is compressed in one call that runs on the libuv thread pool, so the event loop is not held up, and is sent with the `Content-Length` of the compressed body. If compression fails, the payload is sent uncompressed and a warning is logged.
- A Node.js stream, a Web `ReadableStream`, or the body of a `Response` is compressed while it is sent. Whenever the stream stops producing data, the client receives what it has produced so far, so a stream that never ends still flows. Its size is unknown, so the threshold only applies when the reply declares a `Content-Length`. The status and headers of a `Response` are applied to the reply first, as Fastify does, so the built-in checks and the filters see them.

Set `config: { compress: false }` on a route to leave its replies alone: they are neither compressed nor given `Vary`. The `compress` field is added to Fastify's route config type when the plugin is imported.

`shouldCompress(request, reply)` sees the headers set with `reply.header()` or `reply.type()`. `filter(req, res)` receives the raw Node.js objects, `request.raw` and `reply.raw`, which do not have those headers yet when the filter runs, so a filter that reads response headers should be written as `shouldCompress`. When both are given, a reply is only compressed when both return `true`.

The plugin is wrapped with [`fastify-plugin`](https://github.com/fastify/fastify-plugin): its hook applies to the routes of the context it is registered in, including those of child contexts, and it is registered under the name `@derodero24/comprs-middleware`, which other plugins can list in their `dependencies`. It requires Fastify 5.

### Hono

The Hono middleware compresses a response once the handler has returned it, in one of two ways:

- A body that is available at once, such as that of `c.text()`, `c.json()` or `c.body()` with a string or bytes, or a stream that ends without waiting for anything, is compressed in one call that runs on the libuv thread pool, so the event loop is not held up. The threshold applies to its size, and the server sends it with the `Content-Length` of the compressed body.
- Any other body, such as that of a `stream()` or `streamText()` callback that waits between writes, or of a stream that has more than 1 MiB ready at once, is compressed while it is sent, and read only as fast as the client takes it. Whenever the handler stops writing, the client receives what it has written so far, so a stream that never ends still flows. Its size is unknown, so the threshold only applies when the response declares a `Content-Length`.

`streamSSE()` responses are `text/event-stream` and are not compressed. An error before the response is sent, such as a body stream that fails right away or a failed compression, is passed to the app's error handler (`app.onError()`); a body stream that fails later aborts the response.

## License

[MIT](../../LICENSE)
