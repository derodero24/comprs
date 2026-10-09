// Checks that each entry point exports the names its declaration files
// declare, from require() and from import, so that the CommonJS and ES module
// entries cannot drift apart (#73, #211, #313, #568). The entries load
// through the package name, as the package can import itself, so the
// `exports` conditions pick them. export-parity.spec.ts runs this in a fresh
// Node.js process; `node __test__/export-parity.mjs` runs it directly.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACKAGE = '@derodero24/comprs';
const DECLARED_VALUE = /^export declare (?:function|class|(?:const )?enum|const) (\w+)/gm;

/** @param {string} file */
function declaredNames(file) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(DECLARED_VALUE)].map((match) => match[1]);
}

// Names that Node.js adds to the namespace of a CommonJS module that is
// imported: `default`, and from Node.js 23 also `module.exports`.
const CJS_NAMESPACE_KEYS = new Set(['default', 'module.exports']);

/**
 * The names an ES module namespace exports, without those Node.js adds.
 *
 * @param {object} namespace
 */
function keysOf(namespace) {
  return Object.keys(namespace).filter((key) => !CJS_NAMESPACE_KEYS.has(key));
}

/** @type {string[]} */
const problems = [];

/**
 * @param {string} label
 * @param {string[]} actual
 * @param {string[]} expected
 */
function compare(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name)).sort();
  const extra = actual.filter((name) => !expectedSet.has(name)).sort();
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      [
        `${label}: ${actual.length} exports, ${expected.length} declared`,
        ...missing.map((name) => `  - ${name} (declared, not exported)`),
        ...extra.map((name) => `  + ${name} (exported, not declared)`),
      ].join('\n'),
    );
  }
  if (actualSet.has('__esModule')) {
    problems.push(`${label}: exports __esModule`);
  }
}

const rootNames = declaredNames('index.d.ts');
const streamNames = declaredNames('streams.d.ts');
const nodeNames = declaredNames('node.d.ts');
if (rootNames.length < 60) {
  problems.push(
    `index.d.ts: only ${rootNames.length} declared values found; is the pattern stale?`,
  );
}

compare('require(root)', Object.keys(require(PACKAGE)), rootNames);
// The ES module root also re-exports the stream helpers (index.d.mts).
compare('import(root)', keysOf(await import(PACKAGE)), [...rootNames, ...streamNames]);

for (const [subpath, names] of [
  ['streams', streamNames],
  ['node', nodeNames],
]) {
  const specifier = `${PACKAGE}/${subpath}`;
  compare(`require(./${subpath})`, Object.keys(require(specifier)), names);
  compare(`import(./${subpath})`, keysOf(await import(specifier)), names);
}

if (problems.length > 0) {
  process.stderr.write(`Export parity check failed:\n\n${problems.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Export parity OK: ${rootNames.length} root, ${streamNames.length} streams and ` +
      `${nodeNames.length} node values.\n`,
  );
}
