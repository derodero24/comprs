/* math.h for wasm32-unknown-unknown, which has no C library: the part of
   it that libbrotli uses. Rust's compiler-builtins defines log2 for the
   target. */
#ifndef COMPRS_BROTLI_WASM_MATH_H
#define COMPRS_BROTLI_WASM_MATH_H

/* brotli/c/enc/fast_log.h */
double log2(double x);

/* brotli/c/enc/histogram_inc.h starts bit costs at HUGE_VAL. */
#define HUGE_VAL __builtin_huge_val()

#endif
