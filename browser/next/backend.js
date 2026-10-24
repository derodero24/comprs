/** The backend of each format that an entry point registered. */
const registry = new Map();
/**
 * Make `codecs` the backend of `formats`, the formats of its entry point,
 * for the functions of api.ts. Each entry point calls this once, when it is
 * loaded: `@derodero24/comprs/next` for every format, and those of a family
 * of formats, such as `@derodero24/comprs/next/zstd`, for that family. A
 * format keeps the backend that was registered for it first, so that its
 * calls do not move to another one: the entry points of a page that loads
 * several WebAssembly builds share api.ts, which then calls each build for
 * its formats.
 */
export function registerBackend(codecs, formats) {
    for (const format of formats) {
        if (!registry.has(format)) {
            registry.set(format, codecs);
        }
    }
}
/** The backend registered for `format`, if any. */
export function backendOf(format) {
    return registry.get(format);
}
/** Every backend registered for a format, once each, in their order. */
export function registeredBackends() {
    return [...new Set(registry.values())];
}
/**
 * Make `replacement` the backend of every format whose backend is
 * `current`, as the tests do to watch the calls of a backend.
 */
export function replaceBackend(current, replacement) {
    for (const [format, codecs] of registry) {
        if (codecs === current) {
            registry.set(format, replacement);
        }
    }
}
