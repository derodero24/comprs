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

## Usage

### Express

```ts
import express from 'express';
import { comprs } from '@derodero24/comprs-middleware/express';

const app = express();
app.use(comprs());
```

### Fastify

```ts
import Fastify from 'fastify';
import { comprs } from '@derodero24/comprs-middleware/fastify';

const app = Fastify();
app.register(comprs);
```

### Hono

```ts
import { Hono } from 'hono';
import { comprs } from '@derodero24/comprs-middleware/hono';

const app = new Hono();
app.use(comprs());
```

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

The options are checked when the middleware is created: an unsupported encoding, an empty `encodings` list, a level that is not an integer in its range or that names an unknown encoding, a `threshold` that is not a finite number of 0 or more, or a `filter` that is not a function throws a `TypeError` or `RangeError` (for Fastify, `register()` rejects with it).

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

> Hono adapter accepts `filter: (c: Context) => boolean` instead.

| Level | Range | Default |
|-------|-------|---------|
| `zstd` | -131072 to 19 | 3 |
| `br` | 0 to 11 | 6 |
| `gzip` | 0 to 9 | 6 |
| `deflate` | 0 to 9 | 6 |

zstd levels 20 to 22 are rejected: they need a window larger than the 8 MiB that [RFC 9659](https://www.rfc-editor.org/rfc/rfc9659#section-3) allows for the `zstd` content coding, and Chromium-based browsers refuse such responses.

The filter narrows the built-in checks rather than replacing them: a response whose Content-Type is not compressible stays uncompressed even when the filter returns `true`. Since the filter also decides whether `Vary` is added, it is called for requests that do not get compressed as well, such as `HEAD` requests and requests that accept none of the encodings.

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
- Remove `Content-Length` (compressed size is unknown)
- Turn a strong `ETag` into a weak one (`W/"..."`) on compressed responses, since a strong tag must differ between the compressed and the uncompressed representation ([RFC 9110, section 8.8.3.3](https://www.rfc-editor.org/rfc/rfc9110#section-8.8.3.3))
- Send `deflate` in the zlib format (RFC 1950), as [RFC 9110, section 8.4.1.2](https://www.rfc-editor.org/rfc/rfc9110#section-8.4.1.2) defines the coding
- Set `Vary: Accept-Encoding` on every response whose headers allow compression (none of the first four conditions below applies, and the `filter` returns `true`), whether or not this request gets compressed: also for `HEAD` requests, requests without `Accept-Encoding`, 304 responses and responses below the threshold. Other responses are never compressed and do not get it.
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

## License

[MIT](../../LICENSE)
