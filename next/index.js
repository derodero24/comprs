"use strict";
exports.trainDictionarySync = exports.trainDictionary = exports.detectFormat = exports.decompressSync = exports.decompress = exports.Dictionary = exports.DecompressionStream = exports.compressSync = exports.compress = exports.CompressionStream = void 0;
// The entry point of @derodero24/comprs/next for Node.js: the functions of
// api.ts, with the native addon as their backend for every format. The names
// are re-exported one by one, which every CommonJS lexer recognizes
// (cjs-module-lexer of Node.js, Bun, Deno and bundlers), so that ES modules
// can import them.
const api_js_1 = require("./api.js");
const backend_js_1 = require("./backend.js");
const native_js_1 = require("./native.js");
(0, backend_js_1.registerBackend)(native_js_1.native, api_js_1.FORMATS);
var api_js_2 = require("./api.js");
Object.defineProperty(exports, "CompressionStream", { enumerable: true, get: function () { return api_js_2.CompressionStream; } });
Object.defineProperty(exports, "compress", { enumerable: true, get: function () { return api_js_2.compress; } });
Object.defineProperty(exports, "compressSync", { enumerable: true, get: function () { return api_js_2.compressSync; } });
Object.defineProperty(exports, "DecompressionStream", { enumerable: true, get: function () { return api_js_2.DecompressionStream; } });
Object.defineProperty(exports, "Dictionary", { enumerable: true, get: function () { return api_js_2.Dictionary; } });
Object.defineProperty(exports, "decompress", { enumerable: true, get: function () { return api_js_2.decompress; } });
Object.defineProperty(exports, "decompressSync", { enumerable: true, get: function () { return api_js_2.decompressSync; } });
Object.defineProperty(exports, "detectFormat", { enumerable: true, get: function () { return api_js_2.detectFormat; } });
Object.defineProperty(exports, "trainDictionary", { enumerable: true, get: function () { return api_js_2.trainDictionary; } });
Object.defineProperty(exports, "trainDictionarySync", { enumerable: true, get: function () { return api_js_2.trainDictionarySync; } });
