"use strict";
exports.registerBackend = registerBackend;
exports.backendOf = backendOf;
exports.registeredBackends = registeredBackends;
exports.registeredFormatCount = registeredFormatCount;
exports.replaceBackend = replaceBackend;
/** The backend of each format that an entry point registered. */
const registry = new Map();
/**
 * The backends of the registry, once each, in their order, which the
 * functions of api.ts read on every call that detects a format: kept up to
 * date as the registry changes, rather than collected on each call.
 */
let backends = [];
/** Collect {@link backends} again, after the registry changed. */
function refresh() {
    backends = [...new Set(registry.values())];
}
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
function registerBackend(codecs, formats) {
    for (const format of formats) {
        if (!registry.has(format)) {
            registry.set(format, codecs);
        }
    }
    refresh();
}
/** The backend registered for `format`, if any. */
function backendOf(format) {
    return registry.get(format);
}
/** Every backend registered for a format, once each, in their order. */
function registeredBackends() {
    return backends;
}
/** How many formats have a backend. */
function registeredFormatCount() {
    return registry.size;
}
/**
 * Make `replacement` the backend of every format whose backend is
 * `current`, as the tests do to watch the calls of a backend.
 */
function replaceBackend(current, replacement) {
    for (const [format, codecs] of registry) {
        if (codecs === current) {
            registry.set(format, replacement);
        }
    }
    refresh();
}
