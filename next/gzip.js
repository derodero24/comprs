"use strict";
exports.DecompressionStream = exports.CompressionStream = exports.decompressSync = exports.decompress = exports.compressSync = exports.compress = exports.detectFormat = void 0;
// The entry point of @derodero24/comprs/next/gzip for Node.js (#342): the
// functions of api.ts for the formats of the gzip family alone, with the
// native addon as their backend for those formats, as the browser entry
// point of the family, browser-gzip.ts, has the gzip WebAssembly build.
// The other formats fail with ERR_COMPRS_INVALID_ARG unless another entry
// point registered them, so code behaves in Node.js as in browsers. The
// names are exported one by one, as index.ts exports them.
const api_js_1 = require("./api.js");
const backend_js_1 = require("./backend.js");
const native_js_1 = require("./native.js");
(0, backend_js_1.registerBackend)(native_js_1.native, api_js_1.FAMILY_FORMATS.gzip);
var api_js_2 = require("./api.js");
Object.defineProperty(exports, "detectFormat", { enumerable: true, get: function () { return api_js_2.detectFormat; } });
/** {@link compressAny | compress}, for the formats of the gzip family. */
exports.compress = api_js_1.compress;
/** {@link compressSyncAny | compressSync}, for the formats of the gzip family. */
exports.compressSync = api_js_1.compressSync;
/** {@link decompressAny | decompress}, for the formats of the gzip family. */
exports.decompress = api_js_1.decompress;
/** {@link decompressSyncAny | decompressSync}, for the formats of the gzip family. */
exports.decompressSync = api_js_1.decompressSync;
/** {@link AnyCompressionStream | CompressionStream}, for the formats of the gzip family. */
exports.CompressionStream = api_js_1.CompressionStream;
/** {@link AnyDecompressionStream | DecompressionStream}, for the formats of the gzip family. */
exports.DecompressionStream = api_js_1.DecompressionStream;
