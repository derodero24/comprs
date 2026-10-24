// The unscoped `comprs` package re-exports each entry point of
// @derodero24/comprs with the same subpath (#752), so under this project's
// resolution its declarations must give the same values and types, in both
// directions. scripts/check-consumer-types.mjs installs both packed
// packages next to it.
import * as scopedNext from '@derodero24/comprs/next';
import * as unscopedNext from 'comprs/next';

/** `true` when A and B are the same type, `false` otherwise. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const valuesNext: [typeof scopedNext, typeof unscopedNext] = [unscopedNext, scopedNext];
export const typesNext: Equal<scopedNext.Format, unscopedNext.Format> = true;
