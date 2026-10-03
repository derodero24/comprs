# @derodero24/comprs-middleware

HTTP compression middleware powered by [comprs](https://github.com/derodero24/comprs). Supports **Express**, **Fastify**, and **Hono** with **zstd**, **brotli**, **gzip**, and **deflate**.

## Features

- **Multi-framework** — Express, Fastify, and Hono via subpath imports
- **zstd, brotli, gzip, deflate** — all algorithms via a single package
- **Accept-Encoding negotiation** — automatically selects the best encoding
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
| `encodings` | `Encoding[]` | `['zstd', 'br', 'gzip', 'deflate']` | Algorithm priority order |
| `threshold` | `number` | `1024` | Minimum response size (bytes) to compress |
| `level` | `LevelOptions` | `{}` | Per-algorithm compression levels |
| `filter` | `(req, res) => boolean` | Compressible types | Custom filter (Express/Fastify) |

> Hono adapter accepts `filter: (c: Context) => boolean` instead.

### `negotiate(acceptEncoding, preferred?)`

Low-level Accept-Encoding negotiation. Returns the best encoding or `null`.

```ts
import { negotiate } from '@derodero24/comprs-middleware';

negotiate('gzip, br;q=0.8, zstd');
// => 'zstd' (highest server preference accepted by client)
```

## Behavior

All adapters automatically:

- Set `Content-Encoding` header
- Remove `Content-Length` (compressed size is unknown)
- Set `Vary: Accept-Encoding` for caching correctness
- Skip compression when:
  - Response already has `Content-Encoding`
  - `Cache-Control: no-transform` is set
  - Content-Type is not compressible (images, etc.)
  - Content-Type is not set
  - Response body is below threshold
  - Request method is `HEAD`
  - Client does not accept any supported encoding

### Express

The Express adapter decides whether to compress when the response headers are sent: by `res.writeHead()`, `res.flushHeaders()`, or the first `res.write()` or `res.end()`. Handlers may therefore send headers before the body, and header fields passed to `res.writeHead()` are taken into account. Responses with status 204 or 304 are never compressed, and `Vary: Accept-Encoding` is only added to responses that could be compressed.

A compressed response keeps the behavior of a plain `ServerResponse`:

- `res.write()` returns `false` while the client reads more slowly than the handler writes, and `'drain'` follows, so `stream.pipe(res)` pauses instead of buffering the body.
- Writes after `res.end()` fail with `ERR_STREAM_WRITE_AFTER_END`, and callbacks passed to `res.end()` run once the response has finished.
- A compression error aborts the response, and the compressor is released when the response closes, including when the client disconnects.

## License

[MIT](../../LICENSE)
