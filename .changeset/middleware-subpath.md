---
"@derodero24/comprs-middleware": minor
---

Restructure middleware to subpath exports with Fastify and Hono support

- Add `@derodero24/comprs-middleware/express` subpath export
- Add `@derodero24/comprs-middleware/fastify` Fastify plugin
- Add `@derodero24/comprs-middleware/hono` Hono middleware
- Extract shared logic (negotiate, compress, types) into framework-agnostic modules
- Root export (`@derodero24/comprs-middleware`) now exports shared utilities only
