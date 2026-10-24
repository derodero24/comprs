/* stdlib.h for wasm32-unknown-unknown, which has no C library: the
   functions of it that libbrotli calls. */
#ifndef COMPRS_BROTLI_WASM_STDLIB_H
#define COMPRS_BROTLI_WASM_STDLIB_H

#include <stddef.h>

/* libbrotli's default memory functions call these. comprs never uses
   them, as every instance gets the memory functions of src/alloc.rs,
   which defines these too. */
void *comprs_brotli_malloc(size_t size);
void comprs_brotli_free(void *ptr);
#define malloc(size) comprs_brotli_malloc(size)
#define free(ptr) comprs_brotli_free(ptr)

/* libbrotli exits only on states that it rules out, such as a hasher
   that is not set up (brotli/c/enc/hash_composite_inc.h), and on
   allocation failures, which BROTLI_ENCODER_CLEANUP_ON_OOM turns into
   errors. A trap is how a panic ends in WebAssembly too. */
#define EXIT_FAILURE 1
#define exit(status) __builtin_trap()

#endif
