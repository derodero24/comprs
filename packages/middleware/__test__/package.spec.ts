import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The package as an application gets it from npm: built, installed in the
// application's node_modules, and loaded by name through its exports map.

const NAME = '@derodero24/comprs-middleware';
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSC = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
);

/** The names each entry point exports, and the name read from package.json. */
const EXPECTED = {
  [NAME]: ['negotiate'],
  [`${NAME}/express`]: ['comprs'],
  [`${NAME}/fastify`]: ['comprs'],
  [`${NAME}/hono`]: ['comprs'],
  [`${NAME}/package.json`]: NAME,
};
const ENTRY_POINTS = JSON.stringify(Object.keys(EXPECTED).filter((id) => !id.endsWith('.json')));

let app: string | undefined;

/** Run Node.js in the application directory and return what it prints. */
function node(...args: string[]): string {
  const { status, stdout, stderr } = spawnSync(process.execPath, args, {
    cwd: app,
    encoding: 'utf8',
  });
  if (status !== 0) {
    throw new Error(`node ${args.join(' ')} exited with ${status}:\n${stdout}${stderr}`);
  }
  return stdout;
}

beforeAll(() => {
  app = mkdtempSync(join(tmpdir(), 'comprs-middleware-'));
  const installed = join(app, 'node_modules', ...NAME.split('/'));
  mkdirSync(installed, { recursive: true });
  copyFileSync(join(PACKAGE_DIR, 'package.json'), join(installed, 'package.json'));
  // The dependencies of the package, and @types/node for the application.
  symlinkSync(join(PACKAGE_DIR, 'node_modules'), join(installed, 'node_modules'), 'junction');
  node(TSC, '-p', join(PACKAGE_DIR, 'tsconfig.build.json'), '--outDir', join(installed, 'dist'));

  writeFileSync(
    join(app, 'require.cjs'),
    `const loaded = {};
for (const id of ${ENTRY_POINTS}) loaded[id] = Object.keys(require(id));
loaded['${NAME}/package.json'] = require('${NAME}/package.json').name;
console.log(JSON.stringify(loaded));
`,
  );
  writeFileSync(
    join(app, 'import.mjs'),
    `const loaded = {};
for (const id of ${ENTRY_POINTS}) loaded[id] = Object.keys(await import(id));
const manifest = await import('${NAME}/package.json', { with: { type: 'json' } });
loaded['${NAME}/package.json'] = manifest.default.name;
console.log(JSON.stringify(loaded));
`,
  );
  writeFileSync(
    join(app, 'index.cts'),
    `import { type Encoding, negotiate } from '${NAME}';
import { comprs as express } from '${NAME}/express';
import { comprs as fastify } from '${NAME}/fastify';
import { comprs as hono } from '${NAME}/hono';

export const encoding: Encoding | null = negotiate('gzip');
export const middleware = [express(), fastify, hono()];
`,
  );
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'node20',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node'],
        typeRoots: [join(PACKAGE_DIR, 'node_modules', '@types')],
      },
      files: ['index.cts'],
    }),
  );
}, 60_000);

afterAll(() => {
  if (app !== undefined) rmSync(app, { recursive: true, force: true });
});

it('loads every entry point with require()', () => {
  expect(JSON.parse(node('require.cjs'))).toEqual(EXPECTED);
});

it('loads every entry point with import()', () => {
  expect(JSON.parse(node('import.mjs'))).toEqual(EXPECTED);
});

it('resolves the type declarations from a CommonJS TypeScript project', () => {
  // tsc exits with its diagnostics when a module or its types cannot be found.
  expect(node(TSC, '-p', 'tsconfig.json')).toBe('');
}, 30_000);
