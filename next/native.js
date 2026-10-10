"use strict";
const backend_js_1 = require("./backend.js");
// The backend of the native build: the hidden binding of the native addon,
// crates/core/src/next.rs, which the addon keeps on its exports under
// Symbol.for('@derodero24/comprs/internal') so that the root entry does not
// list it. Importing this module makes it the backend of api.ts.
/** The key of the hidden binding on the exports of the addon. */
const INTERNAL = Symbol.for('@derodero24/comprs/internal');
/** The functions of the binding that api.ts calls. */
const FUNCTIONS = [
    'compress',
    'compressAsync',
    'decompress',
    'decompressAsync',
    'detectFormat',
    'trainDictionary',
    'trainDictionaryAsync',
];
function isBackend(value) {
    return (typeof value === 'object' &&
        value !== null &&
        FUNCTIONS.every((name) => typeof Reflect.get(value, name) === 'function'));
}
// A plain require() call, which returns the exports of the loader as they
// are: `import * as` would copy them with the interop helper of tsc, which
// leaves out properties keyed by symbols.
const binding = Reflect.get(require('../index.js'), INTERNAL);
if (!isBackend(binding)) {
    throw new Error('the native addon of @derodero24/comprs has no binding for @derodero24/comprs/next: it is older than the JavaScript of the package, so reinstall the package');
}
(0, backend_js_1.setBackend)(binding);
