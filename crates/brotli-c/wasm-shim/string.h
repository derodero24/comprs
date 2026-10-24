/* string.h for wasm32-unknown-unknown, which has no C library: the
   functions of it that libbrotli calls. Rust's compiler-builtins defines
   them for the target. */
#ifndef COMPRS_BROTLI_WASM_STRING_H
#define COMPRS_BROTLI_WASM_STRING_H

#include <stddef.h>

int memcmp(const void *s1, const void *s2, size_t n);
void *memcpy(void *restrict dest, const void *restrict src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);

#endif
