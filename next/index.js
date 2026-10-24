"use strict";
exports.trainDictionarySync = exports.trainDictionary = exports.detectFormat = exports.decompressSync = exports.decompress = exports.Dictionary = exports.DecompressionStream = exports.compressSync = exports.compress = exports.CompressionStream = void 0;
// The entry point of @derodero24/comprs/next for Node.js: the functions of
// api.ts, with the native addon as their backend. The names are re-exported
// one by one, which every CommonJS lexer recognizes (cjs-module-lexer of
// Node.js, Bun, Deno and bundlers), so that ES modules can import them.
require("./native.js");
var api_js_1 = require("./api.js");
Object.defineProperty(exports, "CompressionStream", { enumerable: true, get: function () { return api_js_1.CompressionStream; } });
Object.defineProperty(exports, "compress", { enumerable: true, get: function () { return api_js_1.compress; } });
Object.defineProperty(exports, "compressSync", { enumerable: true, get: function () { return api_js_1.compressSync; } });
Object.defineProperty(exports, "DecompressionStream", { enumerable: true, get: function () { return api_js_1.DecompressionStream; } });
Object.defineProperty(exports, "Dictionary", { enumerable: true, get: function () { return api_js_1.Dictionary; } });
Object.defineProperty(exports, "decompress", { enumerable: true, get: function () { return api_js_1.decompress; } });
Object.defineProperty(exports, "decompressSync", { enumerable: true, get: function () { return api_js_1.decompressSync; } });
Object.defineProperty(exports, "detectFormat", { enumerable: true, get: function () { return api_js_1.detectFormat; } });
Object.defineProperty(exports, "trainDictionary", { enumerable: true, get: function () { return api_js_1.trainDictionary; } });
Object.defineProperty(exports, "trainDictionarySync", { enumerable: true, get: function () { return api_js_1.trainDictionarySync; } });
