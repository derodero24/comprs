# @derodero24/comprs-middleware

HTTP compression middleware powered by [comprs](https://github.com/derodero24/comprs). Express middleware with **zstd**, **brotli**, **gzip**, and **deflate** support.

## Features

- **zstd, brotli, gzip, deflate** — all algorithms via a single middleware
- **Accept-Encoding negotiation** — automatically selects the best encoding
- **Configurable priority** — control which algorithm is preferred
- **Threshold support** — skip compression for small responses
- **Content-Type filtering** — only compresses responses with known compressible types (text, JSON, XML, etc.); skips responses without a Content-Type header
- **Rust-powered** — uses comprs native bindings for maximum throughput

## Installation

```bash
npm install @derodero24/comprs @derodero24/comprs-middleware
```

## Usage

```ts
import express from 'express';
import { comprs } from '@derodero24/comprs-middleware';

const app = express();

// Use defaults: zstd > br > gzip > deflate, threshold 1024 bytes
app.use(comprs());

app.get('/', (req, res) => {
  res.json({ hello: 'world' });
});

app.listen(3000);
```

### Custom options

```ts
app.use(comprs({
  // Algorithm priority (first match wins)
  encodings: ['zstd', 'br', 'gzip'],

  // Minimum response size to compress (bytes)
  threshold: 512,

  // Per-algorithm compression levels
  level: {
    zstd: 3,    // 1-22 (default: 3)
    br: 6,      // 0-11 (default: 6)
    gzip: 6,    // 0-9  (default: 6)
  },

  // Custom filter function
  filter: (req, res) => {
    const ct = res.getHeader('content-type');
    return typeof ct === 'string' && ct.includes('application/json');
  },
}));
```

## API

### `comprs(options?)`

Returns an Express-compatible middleware function `(req, res, next) => void`.

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `encodings` | `Encoding[]` | `['zstd', 'br', 'gzip', 'deflate']` | Algorithm priority order |
| `threshold` | `number` | `1024` | Minimum response size (bytes) to compress |
| `level` | `LevelOptions` | `{}` | Per-algorithm compression levels |
| `filter` | `(req, res) => boolean` | Compressible types | Custom filter function |

### `negotiate(acceptEncoding, preferred?)`

Low-level Accept-Encoding negotiation. Returns the best encoding or `null`.

```ts
import { negotiate } from '@derodero24/comprs-middleware';

negotiate('gzip, br;q=0.8, zstd');
// => 'zstd' (highest server preference accepted by client)
```

## Behavior

The middleware automatically:

- Sets `Content-Encoding` header
- Removes `Content-Length` (compressed size is unknown)
- Sets `Vary: Accept-Encoding` for caching correctness
- Skips compression when:
  - Response already has `Content-Encoding`
  - `Cache-Control: no-transform` is set
  - Content-Type is not compressible (images, etc.)
  - Response body is below threshold
  - Request method is `HEAD`
  - Client does not accept any supported encoding

## License

[MIT](../../LICENSE)
