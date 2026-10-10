"use strict";
exports.setBackend = setBackend;
exports.backend = backend;
let current;
/**
 * Make `codecs` the backend of the functions of api.ts. The entry point of
 * each build calls this once, when it is loaded.
 */
function setBackend(codecs) {
    current = codecs;
}
/** The backend that the entry point set. */
function backend() {
    if (current === undefined) {
        throw new Error('@derodero24/comprs/next has no backend: import its entry point');
    }
    return current;
}
