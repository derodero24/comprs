# @derodero24/comprs-middleware

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
