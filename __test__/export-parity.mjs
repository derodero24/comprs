// Checks that each entry point exports the names its declaration files
// declare, from require() and from import, so that the CommonJS and ES module
// entries cannot drift apart (#73, #211, #313, #568). The entries are those
// of the `exports` of package.json, and load through the package name, as
// the package can import itself, so that the `require` and `import`
// conditions pick each one, and the declaration file that its `types` names.
// export-parity.spec.ts runs this in a fresh Node.js process;
// `node __test__/export-parity.mjs` runs it directly.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-5';

const require = createRequire(import.meta.url);
const PACKAGE = '@derodero24/comprs';
const ROOT = new URL('../', import.meta.url);

/**
 * The fewest values that the declarations of an entry may export, by its
 * subpath: fewer means that the declarations, or this script, lost some.
 * package.json must export each of these subpaths.
 *
 * @type {Record<string, number>}
 */
const MIN_VALUES = { '.': 60, './next': 10 };

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `symbol`, an export of a module, exports a value: whether it
 * names one, and no import or export on the way to it makes it a type only.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Symbol} symbol
 */
function exportsValue(checker, symbol) {
  /** @type {ts.Symbol | undefined} */
  let current = symbol;
  while (current !== undefined && current.flags & ts.SymbolFlags.Alias) {
    if (current.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return false;
    current = checker.getImmediateAliasedSymbol(current);
  }
  return current !== undefined && (current.flags & ts.SymbolFlags.Value) !== 0;
}

/**
 * The names of the values that each declaration file exports, as the
 * compiler resolves them, through `export { … } from` and `export *`,
 * without types, interfaces and the names of `export type`. TypeScript 7
 * has no JavaScript API, so this uses the compiler of TypeScript 5.9, the
 * `typescript-5` devDependency.
 *
 * @param {string[]} files Paths relative to the package root.
 * @returns {Map<string, string[]>}
 */
function declaredValues(files) {
  const paths = new Map(files.map((file) => [file, fileURLToPath(new URL(file, ROOT))]));
  const program = ts.createProgram([...paths.values()], { noLib: true, types: [], noEmit: true });
  const checker = program.getTypeChecker();
  return new Map(
    [...paths].map(([file, path]) => {
      const source = program.getSourceFile(path);
      const entry = source === undefined ? undefined : checker.getSymbolAtLocation(source);
      if (entry === undefined) throw new Error(`${file} is not a module`);
      const names = checker
        .getExportsOfModule(entry)
        .filter((symbol) => exportsValue(checker, symbol))
        .map((symbol) => symbol.name);
      return [file, names];
    }),
  );
}

/**
 * An entry point, as one condition of `exports` picks it.
 *
 * @typedef {object} Entry
 * @property {string} subpath The key of `exports`, such as `./next`.
 * @property {string} specifier The specifier that loads it.
 * @property {'require' | 'import'} condition
 * @property {string} types Its declaration file, relative to the package root.
 */

/**
 * The entry points of `exports` in Node.js: each subpath, under its
 * `require` and its `import` condition. Those of the `browser` condition,
 * the WebAssembly build, are left to browser-entry.spec.ts and
 * next-parity.spec.ts.
 *
 * @returns {Entry[]}
 */
function entries() {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
  const exportMap = isRecord(manifest) ? manifest['exports'] : undefined;
  if (!isRecord(exportMap)) throw new Error('package.json has no exports');
  return Object.entries(exportMap).flatMap(([subpath, conditions]) => {
    const specifier = subpath === '.' ? PACKAGE : `${PACKAGE}/${subpath.replace(/^\.\//, '')}`;
    return /** @type {const} */ (['require', 'import']).map((condition) => {
      const target = isRecord(conditions) ? conditions[condition] : undefined;
      const types = isRecord(target) ? target['types'] : undefined;
      if (typeof types !== 'string') {
        throw new Error(`exports['${subpath}'].${condition} names no types`);
      }
      return { subpath, specifier, condition, types: types.replace(/^\.\//, '') };
    });
  });
}

// Names that Node.js adds to the namespace of a CommonJS module that is
// imported: `default`, and from Node.js 23 also `module.exports`.
const CJS_NAMESPACE_KEYS = new Set(['default', 'module.exports']);

/**
 * The names that `entry` exports, without those that Node.js adds to the
 * namespace of an ES module.
 *
 * @param {Entry} entry
 * @returns {Promise<string[]>}
 */
async function exportedNames(entry) {
  if (entry.condition === 'require') return Object.keys(require(entry.specifier));
  const namespace = await import(entry.specifier);
  return Object.keys(namespace).filter((key) => !CJS_NAMESPACE_KEYS.has(key));
}

/** @type {string[]} */
const problems = [];

/**
 * @param {string} label
 * @param {string[]} actual
 * @param {string[]} expected
 * @param {string} [source] Where `expected` comes from, for the report.
 */
function compare(label, actual, expected, source = 'declared') {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name)).sort();
  const extra = actual.filter((name) => !expectedSet.has(name)).sort();
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      [
        `${label}: ${actual.length} exports, ${expected.length} ${source}`,
        ...missing.map((name) => `  - ${name} (${source}, not exported)`),
        ...extra.map((name) => `  + ${name} (exported, not ${source})`),
      ].join('\n'),
    );
  }
  if (actualSet.has('__esModule')) {
    problems.push(`${label}: exports __esModule`);
  }
}

const ENTRIES = entries();
const DECLARED = declaredValues([...new Set(ENTRIES.map((entry) => entry.types))]);
for (const subpath of Object.keys(MIN_VALUES)) {
  if (!ENTRIES.some((entry) => entry.subpath === subpath)) {
    problems.push(`package.json does not export ${subpath}`);
  }
}

/**
 * The names that each entry exports, by `<condition>(<subpath>)`.
 *
 * @type {Map<string, string[]>}
 */
const exported = new Map();
for (const entry of ENTRIES) {
  const label = `${entry.condition}(${entry.subpath})`;
  const declared = DECLARED.get(entry.types) ?? [];
  const minimum = MIN_VALUES[entry.subpath] ?? 1;
  if (declared.length < minimum) {
    problems.push(`${entry.types}: only ${declared.length} declared values, fewer than ${minimum}`);
  }
  const names = await exportedNames(entry);
  compare(label, names, declared);
  exported.set(label, names);
}

// The ES module entry of ./next re-exports the CommonJS entry and nothing
// else, unlike that of the root, which adds the stream helpers.
compare(
  'import(./next)',
  exported.get('import(./next)') ?? [],
  exported.get('require(./next)') ?? [],
  'exported by require()',
);

if (problems.length > 0) {
  process.stderr.write(`Export parity check failed:\n\n${problems.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  const counts = [...exported].map(([label, names]) => `${names.length} ${label}`);
  process.stdout.write(`Export parity OK: ${counts.join(', ')}.\n`);
}
