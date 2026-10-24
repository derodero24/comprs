/* sys/types.h for wasm32-unknown-unknown, which has no C library:
   brotli/c/common/platform.h includes it for endian.h, but finds the byte
   order from the compiler's __BYTE_ORDER__ without it. */
#ifndef COMPRS_BROTLI_WASM_SYS_TYPES_H
#define COMPRS_BROTLI_WASM_SYS_TYPES_H
#endif
