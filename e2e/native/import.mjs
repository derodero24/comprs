// An ES module application of the installed package: Node.js, Deno and Bun
// resolve the `import` conditions of its exports.

import * as main from '@derodero24/comprs';
import * as node from '@derodero24/comprs/node';
import * as streams from '@derodero24/comprs/streams';
import { checkNativePackage } from './checks.js';

await checkNativePackage({
  main,
  streams,
  node,
  importMain: () => import('@derodero24/comprs'),
  importNext: () => import('@derodero24/comprs/next'),
  importFamilies: async () => ({
    zstd: await import('@derodero24/comprs/next/zstd'),
    gzip: await import('@derodero24/comprs/next/gzip'),
  }),
  resolve: (specifier) => import.meta.resolve(specifier),
  files: {
    '@derodero24/comprs': 'index.mjs',
    '@derodero24/comprs/streams': 'streams.js',
    '@derodero24/comprs/node': 'node.js',
    '@derodero24/comprs/next': 'next/index.mjs',
    '@derodero24/comprs/next/zstd': 'next/zstd.mjs',
    '@derodero24/comprs/next/gzip': 'next/gzip.mjs',
  },
});
