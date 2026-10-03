#!/usr/bin/env node

/**
 * Check the npm packages that prepare-release.mjs assembled, without
 * publishing anything.
 *
 * The `release-dry-run` job of .github/workflows/ci.yml runs this after
 * prepare-release.mjs on every CI run. It checks that:
 *
 *   1. every npm/<platform> package belongs to a napi target and has the root
 *      package's version. `napi prepublish` adds the native ones to the root
 *      package's optionalDependencies with that version, and any
 *      optionalDependencies already in package.json must agree;
 *   2. `napi prepublish --dry-run` accepts the platform packages, as the real
 *      publish (the prepublishOnly script) must;
 *   3. `npm pack --dry-run` of each platform package includes its binary and
 *      every file its manifest names;
 *   4. the root package, packed into a temporary tarball, includes every file
 *      and entry point its package.json names and no platform binary, and
 *      its browser entry only loads files from the package itself, down to
 *      the wasm-bindgen WebAssembly module (#564);
 *   5. publint and attw accept that tarball.
 *
 * Usage:
 *   node scripts/check-release.mjs [--allow-missing-targets]
 *
 *   --allow-missing-targets  Skip the platform packages whose binary was not
 *                            built (steps 2 and 3), for CI runs that build
 *                            some targets. Without it, a missing binary is an
 *                            error.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAst } from 'vite';
import {
  annotate,
  capture,
  group,
  isRecord,
  napiTargetArgs,
  ROOT,
  readJson,
  readRelease,
  run,
  runMain,
  runTool,
} from './release-utils.mjs';

/** @typedef {import('./release-utils.mjs').Release} Release */
/** @typedef {import('./release-utils.mjs').ReleaseTarget} ReleaseTarget */

/** ESTree nodes whose `source` names a module that the module loads. */
const MODULE_NODE_TYPES = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);

/**
 * Problems found so far; any of them fails the run at the end.
 *
 * @type {string[]}
 */
const problems = [];

await runMain(async () => {
  const { values } = parseArgs({
    options: { 'allow-missing-targets': { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: false,
  });
  const release = await readRelease();
  const targets = selectTargets(release.targets, values['allow-missing-targets']);
  const targetArgs = targets.length < release.targets.length ? napiTargetArgs(targets) : [];

  await step('Platform package manifests', () => checkManifests(release));
  await step('napi prepublish --dry-run', () => {
    runTool('napi', [
      'prepublish',
      '--tag-style',
      'npm',
      '--dry-run',
      '--no-gh-release',
      ...targetArgs,
    ]);
    console.log(`napi prepublish accepted ${targets.map((target) => target.abi).join(', ')}.`);
  });
  for (const target of targets) {
    await step(`npm pack ${relative(ROOT, target.packageDir)}`, () => checkPlatformPackage(target));
  }

  const workDir = mkdtempSync(join(tmpdir(), 'comprs-pack-'));
  try {
    const tarball = await step('npm pack (root package)', () => checkRootPackage(release, workDir));
    if (tarball !== undefined) {
      await step('publint', () => runTool('publint', ['run', tarball]));
      await step('attw', () => runTool('attw', [tarball]));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    throw new Error(
      `The release dry run found ${problems.length} problem(s):\n${problems.join('\n')}`,
    );
  }
  console.log(`\nThe root package and ${targets.length} platform package(s) are ready to publish.`);
});

/**
 * Run one check in a log group. A problem it reports, or an error it throws,
 * fails the run at the end, after the other checks had their turn.
 *
 * @template T
 * @param {string} title
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
function step(title, fn) {
  return group(title, async () => {
    const before = problems.length;
    try {
      return await fn();
    } catch (error) {
      problems.push(`${title}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      for (const problem of problems.slice(before)) {
        console.log(`Problem: ${problem}`);
      }
    }
  });
}

/**
 * Pick the platform packages to check: all of them, or with `allowMissing`
 * the ones that prepare-release.mjs filled with a binary.
 *
 * @param {ReleaseTarget[]} targets
 * @param {boolean} allowMissing
 */
function selectTargets(targets, allowMissing) {
  const built = targets.filter((target) => existsSync(join(target.packageDir, target.artifact)));
  const missing = targets.filter((target) => !built.includes(target));
  if (missing.length === 0) {
    return targets;
  }
  const names = missing.map((target) => relative(ROOT, join(target.packageDir, target.artifact)));
  if (!allowMissing || built.length === 0) {
    throw new Error(
      `Missing ${names.join(', ')}; run scripts/prepare-release.mjs with the build artifacts first`,
    );
  }
  annotate(
    'notice',
    `Partial release dry run. Built: ${built.map((target) => target.abi).join(', ')}. ` +
      `Not built, so napi prepublish and npm pack skip them: ` +
      `${missing.map((target) => target.abi).join(', ')}. The root package is checked in full.`,
  );
  return built;
}

/**
 * Check that every platform package matches its napi target and the root
 * package's version, and that optionalDependencies agree.
 *
 * @param {Release} release
 */
function checkManifests(release) {
  for (const target of release.targets) {
    checkPlatformManifest(release, target);
  }
  for (const entry of readdirSync(join(ROOT, 'npm'), { withFileTypes: true })) {
    if (entry.isDirectory() && !release.targets.some((target) => target.abi === entry.name)) {
      problems.push(`npm/${entry.name} does not belong to any target in napi.targets`);
    }
  }
  const declared = release.packageJson.optionalDependencies;
  const optionalDependencies = isRecord(declared) ? Object.entries(declared) : [];
  for (const [name, range] of optionalDependencies) {
    const managed = name.startsWith(`${release.packageName}-`);
    if (managed && !release.targets.some((target) => target.packageName === name)) {
      problems.push(`optionalDependencies lists ${name}, which no napi target publishes`);
    } else if (managed && range !== release.version) {
      problems.push(`optionalDependencies pins ${name} to ${range}, not ${release.version}`);
    }
  }
}

/**
 * @param {Release} release
 * @param {ReleaseTarget} target
 */
function checkPlatformManifest(release, target) {
  const manifestPath = join(target.packageDir, 'package.json');
  const shownPath = relative(ROOT, manifestPath);
  if (!existsSync(manifestPath)) {
    problems.push(`${shownPath} does not exist`);
    return;
  }
  const manifest = readJson(manifestPath);
  if (manifest.name !== target.packageName) {
    problems.push(`${shownPath} is named ${manifest.name}, not ${target.packageName}`);
  }
  if (manifest.version !== release.version) {
    problems.push(
      `${shownPath} has version ${manifest.version}, but the root package has ` +
        `${release.version}; run napi version`,
    );
  }
}

/**
 * Check what `npm pack` would publish for a platform package.
 *
 * @param {ReleaseTarget} target
 */
function checkPlatformPackage(target) {
  const manifest = readJson(join(target.packageDir, 'package.json'));
  const { files: packed } = npmPack(target.packageDir, ['--dry-run']);
  const required = [
    'package.json',
    target.artifact,
    ...stringList(manifest.files),
    ...[manifest.main, manifest.types, manifest.browser].filter(
      (entry) => typeof entry === 'string',
    ),
  ];
  for (const file of new Set(required.map(normalizePath))) {
    if (!packed.includes(file)) {
      problems.push(`${target.packageName} would be published without ${file}`);
    }
  }
  console.log(packed.join('\n'));
}

/**
 * Pack the root package into `workDir`, check the tarball's contents and
 * return its path.
 *
 * @param {Release} release
 * @param {string} workDir
 * @returns {string}
 */
function checkRootPackage(release, workDir) {
  const { filename, files: packed } = npmPack(ROOT, ['--pack-destination', workDir]);
  console.log(packed.join('\n'));
  const tarball = join(workDir, filename);
  const contents = join(workDir, 'contents');
  mkdirSync(contents);
  run('tar', ['-xzf', tarball, '-C', contents]);

  checkRootFiles(release, packed);
  const { packageJson } = release;
  const browserEntries = exportTargets(packageJson.exports, 'browser');
  if (typeof packageJson.browser === 'string') {
    browserEntries.push(packageJson.browser);
  }
  const browserModules = browserEntries
    .map(normalizePath)
    .filter((file) => !/\.d\.[cm]?ts$/.test(file));
  checkBrowserEntry(join(contents, 'package'), packed, [...new Set(browserModules)]);
  return tarball;
}

/**
 * Check that the root package holds every file and entry point its
 * package.json names, and no platform binary.
 *
 * @param {Release} release
 * @param {string[]} packed
 */
function checkRootFiles(release, packed) {
  const { packageJson } = release;
  for (const entry of stringList(packageJson.files)) {
    const file = normalizePath(entry);
    if (/[*?[\]{}!]/.test(file)) {
      problems.push(
        `package.json files entry ${entry} is a pattern, which this check cannot verify`,
      );
    } else if (!packed.some((path) => path === file || path.startsWith(`${file}/`))) {
      problems.push(`The root package would be published without ${entry}`);
    }
  }
  const entryPoints = [packageJson.main, packageJson.module, packageJson.browser, packageJson.types]
    .filter((entry) => typeof entry === 'string')
    .concat(exportTargets(packageJson.exports));
  for (const file of new Set(entryPoints.map(normalizePath))) {
    if (!file.includes('*') && !packed.includes(file)) {
      problems.push(`The root package entry point ${file} would not be published`);
    }
  }
  const binaryName = release.binaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binary = new RegExp(`(^|/)${binaryName}\\.[^/]+\\.(node|wasm)$`);
  for (const file of packed.filter((path) => binary.test(path))) {
    problems.push(`The root package would ship the platform binary ${file}`);
  }
}

/**
 * Follow every module the browser entry points load and check that each one
 * is a file of the package. A bare specifier fails: the browser build must
 * not depend on another package (2.0.2's browser.js imported the WASI
 * package, which is not even installed). The chain must reach a WebAssembly
 * module.
 *
 * @param {string} packageDir Extracted package.
 * @param {string[]} packed Files in the package.
 * @param {string[]} entries Browser entry points.
 */
function checkBrowserEntry(packageDir, packed, entries) {
  if (entries.length === 0) {
    problems.push('package.json declares no browser entry point');
    return;
  }
  const seen = new Set(entries);
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!packed.includes(file)) {
      problems.push(`The browser entry loads ${file}, which the package does not include`);
      continue;
    }
    for (const dependency of localDependencies(packageDir, file)) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  console.log(`Browser entry modules: ${[...seen].join(', ')}`);
  if (![...seen].some((file) => file.endsWith('.wasm') && packed.includes(file))) {
    problems.push(
      `The browser entry (${entries.join(', ')}) does not load a WebAssembly module from the package`,
    );
  }
}

/**
 * Return the package files that a JavaScript file of the package loads, and
 * report every module it imports from elsewhere.
 *
 * @param {string} packageDir
 * @param {string} file Path relative to `packageDir`.
 * @returns {string[]}
 */
function localDependencies(packageDir, file) {
  if (!/\.[cm]?js$/.test(file)) {
    return [];
  }
  const ast = parseAst(readFileSync(join(packageDir, file), 'utf8'));
  /** @type {string[]} */
  const dependencies = [];
  for (const { specifier, url } of moduleReferences(ast)) {
    const local = url
      ? !/^[a-z][a-z\d+.-]*:|^\//i.test(specifier)
      : specifier.startsWith('./') || specifier.startsWith('../');
    if (local) {
      dependencies.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
    } else {
      problems.push(
        `The browser entry module ${file} imports ${specifier}, which is not part of the package`,
      );
    }
  }
  return dependencies;
}

/**
 * Yield the modules and assets an ES module loads: static and dynamic
 * imports, re-exports, and `new URL('…', import.meta.url)` references (the
 * way wasm-bindgen's `web` target locates its .wasm file).
 *
 * @param {unknown} node ESTree node, or an array or value inside one.
 * @returns {Generator<{ specifier: string, url: boolean }>}
 */
function* moduleReferences(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      yield* moduleReferences(child);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const source = stringLiteral(node.source);
  if (source !== undefined && MODULE_NODE_TYPES.has(String(node.type))) {
    yield { specifier: source, url: false };
  }
  const url = importMetaUrl(node);
  if (url !== undefined) {
    yield { specifier: url, url: true };
  }
  for (const value of Object.values(node)) {
    yield* moduleReferences(value);
  }
}

/**
 * Return the path of a `new URL('<path>', import.meta.url)` expression.
 *
 * @param {Record<string, unknown>} node
 * @returns {string | undefined}
 */
function importMetaUrl(node) {
  const { callee } = node;
  if (node.type !== 'NewExpression' || !isRecord(callee) || callee.name !== 'URL') {
    return undefined;
  }
  /** @type {unknown[]} */
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const [path, base] = args;
  const isImportMetaUrl =
    isRecord(base) &&
    base.type === 'MemberExpression' &&
    isRecord(base.object) &&
    base.object.type === 'MetaProperty' &&
    isRecord(base.property) &&
    base.property.name === 'url';
  return isImportMetaUrl ? stringLiteral(path) : undefined;
}

/**
 * @param {unknown} node
 * @returns {string | undefined}
 */
function stringLiteral(node) {
  if (!isRecord(node) || node.type !== 'Literal') {
    return undefined;
  }
  const { value } = node;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Collect the file paths of an `exports` field: all of them, or those under
 * the given condition.
 *
 * @param {unknown} value `exports`, or a value inside it.
 * @param {string} [condition]
 * @param {boolean} [matched] Whether `value` is under `condition` already.
 * @returns {string[]}
 */
function exportTargets(value, condition, matched = condition === undefined) {
  if (typeof value === 'string') {
    return matched ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => exportTargets(item, condition, matched));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    exportTargets(item, condition, matched || key === condition),
  );
}

/**
 * Run `npm pack` for a single package and return the tarball's name and the
 * paths it holds. Like `npm publish`, it runs the package's prepack, prepare
 * and postpack scripts (npm runs prepare even with --ignore-scripts); only
 * prepublishOnly, the real `napi prepublish`, is left out. Their output is
 * captured rather than printed, so that it stays out of the JSON.
 *
 * @param {string} cwd Package directory.
 * @param {string[]} args
 * @returns {{ filename: string, files: string[] }}
 */
function npmPack(cwd, args) {
  const output = capture('npm', ['pack', '--json', '--foreground-scripts=false', ...args], { cwd });
  /** @type {unknown} */
  const parsed = JSON.parse(output);
  /** @type {unknown} */
  const result = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  /** @type {Record<string, unknown>} */
  const fields = isRecord(result) ? result : {};
  const { filename, files } = fields;
  if (typeof filename !== 'string' || !Array.isArray(files)) {
    throw new Error(`Unexpected npm pack output: ${output}`);
  }
  /** @type {unknown[]} */
  const entries = files;
  return {
    filename,
    files: entries
      .map((entry) => (isRecord(entry) ? entry.path : undefined))
      .filter((path) => typeof path === 'string')
      .sort(),
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  /** @type {unknown[]} */
  const entries = Array.isArray(value) ? value : [];
  return entries.filter((entry) => typeof entry === 'string');
}

/**
 * Turn a package.json path such as `./index.js` into a packed path.
 *
 * @param {string} path
 */
function normalizePath(path) {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}
