// The unscoped `comprs` package re-exports each entry point of
// @derodero24/comprs with the same subpath (#752), so under this project's
// resolution its declarations must give the same values and types, in both
// directions. scripts/check-consumer-types.mjs installs both packed
// packages next to it.
import * as scoped from '@derodero24/comprs';
import * as scopedNext from '@derodero24/comprs/next';
import * as scopedNode from '@derodero24/comprs/node';
import * as scopedStreams from '@derodero24/comprs/streams';
import * as unscoped from 'comprs';
import * as unscopedNext from 'comprs/next';
import * as unscopedNode from 'comprs/node';
import * as unscopedStreams from 'comprs/streams';

/** `true` when A and B are the same type, `false` otherwise. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export const values: [typeof scoped, typeof unscoped] = [unscoped, scoped];
export const valuesStreams: [typeof scopedStreams, typeof unscopedStreams] = [
  unscopedStreams,
  scopedStreams,
];
export const valuesNode: [typeof scopedNode, typeof unscopedNode] = [unscopedNode, scopedNode];
export const valuesNext: [typeof scopedNext, typeof unscopedNext] = [unscopedNext, scopedNext];
export const types: Equal<scoped.GzipHeader, unscoped.GzipHeader> = true;
export const typesNext: Equal<scopedNext.Format, unscopedNext.Format> = true;
