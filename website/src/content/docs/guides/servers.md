---
title: Servers and frameworks
description: HTTP compression middleware for Express, Fastify and Hono, decompressing request bodies, and SSR framework setup.
sidebar:
  order: 5
---

## HTTP compression middleware

[`@derodero24/comprs-middleware`](https://github.com/derodero24/comprs/tree/main/packages/middleware) compresses responses with zstd, brotli, gzip or deflate, whichever the client accepts first in the server's order, for Express, Fastify and Hono:

```sh
npm install @derodero24/comprs @derodero24/comprs-middleware
```

```ts
// Express
import { comprs } from '@derodero24/comprs-middleware/express';
app.use(comprs());

// Fastify
import { comprs } from '@derodero24/comprs-middleware/fastify';
app.register(comprs);

// Hono, on Node.js or Bun
import { comprs } from '@derodero24/comprs-middleware/hono';
app.use(comprs());
```

It parses `Accept-Encoding` as RFC 9110 defines it, skips small responses, content types that do not compress, ranges and `Cache-Control: no-transform`, sets `Vary: Accept-Encoding`, weakens strong `ETag`s on compressed responses, and compresses bodies in memory on the libuv thread pool and streams as they are sent:

```ts
comprs({
  encodings: ['zstd', 'br', 'gzip'], // the server's order of preference
  threshold: 512, // the smallest body to compress, in bytes (1024 by default)
  level: { zstd: 3, br: 6, gzip: 6 },
});
```

zstd levels above 19 are rejected: they need a window larger than the 8 MiB that [RFC 9659](https://www.rfc-editor.org/rfc/rfc9659#section-3) allows for the `zstd` content coding, and Chromium-based browsers refuse such responses. The [middleware README](https://github.com/derodero24/comprs/tree/main/packages/middleware#readme) documents every option and behavior.

The middleware needs the native addon, so it does not run on edge runtimes such as Cloudflare Workers, which compress responses themselves.

## Decompressing request bodies

A request body that the client compressed, or an upload of compressed data, is untrusted input: decompress it with a limit, and map the error codes to HTTP statuses.

```ts
import { decompress } from '@derodero24/comprs/next';

const formats = { zstd: 'zstd', br: 'brotli', gzip: 'gzip', deflate: 'deflate' } as const;

async function readBody(request: Request): Promise<Uint8Array> {
  const body = new Uint8Array(await request.arrayBuffer());
  // Content codings are case-insensitive.
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase() ?? null;
  if (encoding === null || encoding === 'identity') return body;
  const format = formats[encoding as keyof typeof formats];
  if (format === undefined) throw new Response(null, { status: 415 });
  try {
    return await decompress(body, { format, maxOutputSize: 10 * 1024 * 1024 });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    throw new Response(null, { status: code === 'ERR_COMPRS_SIZE_LIMIT' ? 413 : 400 });
  }
}
```

`maxOutputSize` limits the decompressed body, but `request.arrayBuffer()` reads all of the compressed body first: limit its size too, such as with the request size limit of the server or the proxy in front of it. For bodies too large to hold, pipe them through a `DecompressionStream` with the same `maxOutputSize` (see [Streaming](/comprs/guides/streaming/)). `'deflate'` is zlib here, as HTTP's `deflate` content coding is.

## SSR frameworks

Server bundles should leave comprs to Node.js, which loads the native addon, rather than bundle it:

```js
// next.config.js
const nextConfig = {
  serverExternalPackages: ['@derodero24/comprs'],
};
export default nextConfig;
```

```js
// vite.config.js
export default {
  ssr: {
    external: ['@derodero24/comprs'],
  },
};
```

Client bundles resolve the `browser` condition and get the WebAssembly build, with the bundler setup of [Browsers](/comprs/guides/browsers/).

## Serverless and containers

The native addon has prebuilt binaries for Linux on x64 and ARM64, with glibc 2.17 or later and with musl (Alpine), so it runs on AWS Lambda, Google Cloud Run and in Docker images. Install the dependencies on the platform that runs the code, or for it (`npm install --os=linux --cpu=arm64`), since the package manager installs only the binary of the platform it runs on. See [Platforms](/comprs/reference/platforms/).
