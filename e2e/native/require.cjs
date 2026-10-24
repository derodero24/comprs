// A CommonJS application of the installed package: Node.js, Deno and Bun
// resolve the `require` conditions of its exports.

const main = require('@derodero24/comprs');
const next = require('@derodero24/comprs/next');
const node = require('@derodero24/comprs/node');
const streams = require('@derodero24/comprs/streams');

import('./checks.js')
  .then(({ checkNativePackage }) =>
    checkNativePackage({
      main,
      streams,
      node,
      importMain: () => Promise.resolve(main),
      importNext: () => Promise.resolve(next),
      resolve: (specifier) => require.resolve(specifier),
      files: {
        '@derodero24/comprs': 'index.js',
        '@derodero24/comprs/streams': 'streams.js',
        '@derodero24/comprs/node': 'node.js',
        '@derodero24/comprs/next': 'next/index.js',
      },
    }),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
