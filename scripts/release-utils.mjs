/**
 * Helpers shared by the release packaging scripts, prepare-release.mjs and
 * check-release.mjs, and by check-consumer-types.mjs and
 * e2e/install-package.mjs, which pack the package. The checks of
 * check-release.mjs that __test__/release-utils.spec.ts tests are here too,
 * as importing that script runs it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, posix, resolve } from 'node:path';
import { readNapiConfig } from '@napi-rs/cli';
import { parseAst } from 'vite';

/** Repository root, where the root package lives. */
export const ROOT = resolve(import.meta.dirname, '..');

const IN_GITHUB_ACTIONS = process.env['GITHUB_ACTIONS'] === 'true';

/**
 * @typedef {object} ReleaseTarget
 * @property {string} triple Rust target triple, as listed in `napi.targets`.
 * @property {string} abi napi platform-arch-ABI identifier, e.g. `linux-x64-gnu`.
 * @property {string} artifact File name of the build output, e.g. `comprs.linux-x64-gnu.node`.
 * @property {string} packageName Name of the npm package that ships the artifact.
 * @property {string} packageDir Absolute path of that package, `npm/<abi>`.
 */

/**
 * @typedef {object} Release
 * @property {Record<string, unknown>} packageJson The root package.json.
 * @property {string} packageName
 * @property {string} version
 * @property {string} binaryName
 * @property {ReleaseTarget[]} targets
 */

/**
 * Read the root package.json and its napi targets, as `napi artifacts` and
 * `napi prepublish` see them.
 *
 * @returns {Promise<Release>}
 */
export async function readRelease() {
  const config = await readNapiConfig(join(ROOT, 'package.json'));
  const packageJson = readJson(join(ROOT, 'package.json'));
  const { version } = packageJson;
  if (typeof version !== 'string') {
    throw new Error('package.json has no version');
  }
  return {
    packageJson,
    packageName: config.packageName,
    version,
    binaryName: config.binaryName,
    targets: config.targets.map((target) => ({
      triple: target.triple,
      abi: target.platformArchABI,
      artifact: `${config.binaryName}.${target.platformArchABI}.node`,
      packageName: `${config.packageName}-${target.platformArchABI}`,
      packageDir: join(ROOT, 'npm', target.platformArchABI),
    })),
  };
}

/**
 * Parse a JSON file that must hold an object.
 *
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function readJson(path) {
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)) {
    throw new Error(`${path} does not hold a JSON object`);
  }
  return value;
}

/**
 * Whether a value is a plain object, such as a JSON object or an AST node.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @typedef {object} Manifest
 * @property {string} path Path of the package.json, as problems name it.
 * @property {Record<string, unknown>} json Its parsed contents.
 */

/**
 * Check the `repository` URLs of the packages that the release publishes
 * with provenance: the registry rejects a package whose `repository.url`
 * does not name the GitHub repository that built it.
 *
 * Each URL is compared without a leading `git+`, a trailing `.git` and a
 * trailing `/`. The root package's must name a GitHub repository, and every
 * other package's must name the same one. The root package stands in for the
 * repository that runs the release, so that CI passes in forks as well.
 *
 * @param {Manifest[]} manifests The root package.json first.
 * @returns {string[]} The problems found, each naming its package.json.
 */
export function repositoryUrlProblems(manifests) {
  const [root, ...others] = manifests;
  if (root === undefined) {
    return [];
  }
  const rootUrl = repositoryUrl(root.json);
  if (rootUrl === undefined || !isGitHubRepositoryUrl(rootUrl)) {
    return [
      `${root.path} must name a GitHub repository, https://github.com/<owner>/<repository>, ` +
        `but has ${describeRepositoryUrl(rootUrl)}`,
    ];
  }
  return others
    .map(({ path, json }) => ({ path, url: repositoryUrl(json) }))
    .filter(({ url }) => url !== rootUrl)
    .map(
      ({ path, url }) =>
        `${path} must name the repository ${rootUrl}, as ${root.path} does, ` +
        `but has ${describeRepositoryUrl(url)}`,
    );
}

/** The characters of a GitHub owner or repository name. */
const GITHUB_NAME = /^[\w.-]+$/;

/**
 * Whether `url` is exactly `https://github.com/<owner>/<repository>`: parsed
 * as a URL, without credentials, a port, a query, a fragment or more path.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isGitHubRepositoryUrl(url) {
  if (!URL.canParse(url) || /[?#]/.test(url)) {
    return false;
  }
  const { protocol, username, password, host, pathname } = new URL(url);
  const [, owner, repository, ...rest] = pathname.split('/');
  return (
    protocol === 'https:' &&
    username === '' &&
    password === '' &&
    host === 'github.com' &&
    rest.length === 0 &&
    owner !== undefined &&
    GITHUB_NAME.test(owner) &&
    repository !== undefined &&
    GITHUB_NAME.test(repository)
  );
}

/**
 * @param {string | undefined} url
 * @returns {string}
 */
function describeRepositoryUrl(url) {
  return url === undefined ? 'no repository URL' : `the repository URL ${url}`;
}

/**
 * Return the URL of a package's `repository` field, a string or the `url` of
 * an object, without a leading `git+`, a trailing `.git` and a trailing `/`.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {string | undefined}
 */
function repositoryUrl(manifest) {
  const { repository } = manifest;
  const url = isRecord(repository) ? repository['url'] : repository;
  if (typeof url !== 'string') {
    return undefined;
  }
  return url
    .replace(/^git\+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

/**
 * Return the `napi` arguments that limit a command to some of the configured
 * targets, through a temporary config file that overrides `napi.targets`.
 * The file is removed when the process exits.
 *
 * @param {ReleaseTarget[]} targets
 * @returns {string[]}
 */
export function napiTargetArgs(targets) {
  const dir = mkdtempSync(join(tmpdir(), 'comprs-napi-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'napi.json');
  writeFileSync(path, `${JSON.stringify({ targets: targets.map((target) => target.triple) })}\n`);
  return ['--config-path', path];
}

/**
 * Run a command with inherited stdio, from the repository root unless `cwd`
 * says otherwise. Throws if it exits with a non-zero status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
export function run(command, args, { cwd = ROOT } = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Run a command-line tool installed in node_modules, from the repository
 * root. It is run directly rather than through `pnpm exec`, which installs
 * dependencies first when package.json and node_modules disagree.
 *
 * @param {string} name
 * @param {string[]} args
 */
export function runTool(name, args) {
  run(`node_modules/.bin/${name}`, args);
}

/**
 * Run a command and return its standard output. Its standard error is passed
 * through. Throws if it exits with a non-zero status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
export function capture(command, args, { cwd = ROOT } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Run `fn` inside a collapsible log group on GitHub Actions.
 *
 * @template T
 * @param {string} title
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function group(title, fn) {
  console.log(IN_GITHUB_ACTIONS ? `::group::${title}` : `\n== ${title}`);
  try {
    return await fn();
  } finally {
    if (IN_GITHUB_ACTIONS) {
      console.log('::endgroup::');
    }
  }
}

/**
 * Print a message that GitHub Actions also shows as an annotation of the run.
 *
 * @param {'notice' | 'warning' | 'error'} level
 * @param {string} message
 */
export function annotate(level, message) {
  if (IN_GITHUB_ACTIONS) {
    // Workflow commands end at the first newline unless it is escaped.
    const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::${level}::${escaped}`);
  } else {
    console.log(`${level}: ${message}`);
  }
}

/**
 * Run a script's main function, and report any error it throws as a failed
 * run with exit status 1.
 *
 * @param {() => Promise<void>} main
 */
export async function runMain(main) {
  try {
    await main();
  } catch (error) {
    annotate('error', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
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
export function npmPack(cwd, args) {
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
      .map((entry) => (isRecord(entry) ? entry['path'] : undefined))
      .filter((path) => typeof path === 'string')
      .sort(),
  };
}

/** ESTree nodes whose `source` names a module that the module loads. */
const MODULE_NODE_TYPES = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);

/**
 * A package file that a module loads: through `new URL()` (`url`), or by
 * an import of the module for its side effects only, such as
 * `import './wasm.js'` (`sideEffectsOnly`), or otherwise.
 *
 * @typedef {{ path: string, url: boolean, sideEffectsOnly: boolean }} Dependency
 */

/**
 * Follow every module that each browser entry point loads and check that
 * each one is a file of the package. A bare specifier fails: the browser
 * build must not depend on another package (2.0.2's browser.js imported the
 * WASI package, which is not even installed), nor on Node.js. Each entry
 * point must reach a WebAssembly module, through `new URL()`: esbuild cannot
 * bundle a .wasm file that is imported as an ES module. Bundlers must parse
 * every module as an ES module, which also keeps the CommonJS loaders of the
 * native addon out, and keep the entry points, which initialise the
 * WebAssembly module, when they tree-shake. They must also keep every
 * module that a module on the way imports for its side effects only, as
 * browser/index.js imports browser/wasm.js, which initialises the module:
 * a bundler drops such an import when a `sideEffects` field marks the
 * module side-effect free.
 *
 * @param {string} packageDir Extracted package.
 * @param {string[]} packed Files in the package.
 * @param {string[]} entries Browser entry points.
 * @param {(line: string) => void} [log] Logs the files that each entry point
 *   loads.
 * @returns {string[]} The problems found, each naming the file it is about.
 */
export function browserEntryProblems(packageDir, packed, entries, log = console.log) {
  /** @type {string[]} */
  const problems = [];
  if (entries.length === 0) {
    problems.push('package.json declares no browser entry point');
    return problems;
  }
  const dependenciesOf = browserDependencies(problems, packageDir, packed);
  /**
   * The modules that a module imports for their side effects only, each
   * with the first module found to import it so.
   *
   * @type {Map<string, string>}
   */
  const importers = new Map();
  for (const entry of entries) {
    for (const manifest of sideEffectFreeManifests(packageDir, entry)) {
      problems.push(
        `${manifest} marks the browser entry ${entry} as side-effect free, so bundlers may ` +
          'drop the initialisation of the WebAssembly module',
      );
    }
    const loaded = loadedFiles(entry, dependenciesOf, importers);
    log(`Browser entry ${entry} loads: ${loaded.join(', ')}`);
    if (!loaded.some((file) => file.endsWith('.wasm') && packed.includes(file))) {
      problems.push(
        `The browser entry ${entry} does not load a WebAssembly module from the package`,
      );
    }
  }
  // The entry points are checked above, and files outside the package fail
  // already.
  const imported = [...importers].filter(
    ([file]) => !entries.includes(file) && packed.includes(file),
  );
  for (const [file, importer] of imported) {
    for (const manifest of sideEffectFreeManifests(packageDir, file)) {
      problems.push(
        `${manifest} marks ${file}, which ${importer} imports for its side effects only, as ` +
          'side-effect free, so bundlers may drop that import',
      );
    }
  }
  return problems;
}

/**
 * Return the files that a browser entry point loads, directly or through
 * other modules, and record in `importers` each module that one of them
 * imports for its side effects only, with that module, unless it has one.
 *
 * @param {string} entry
 * @param {(file: string) => Dependency[]} dependenciesOf
 * @param {Map<string, string>} importers
 * @returns {string[]}
 */
function loadedFiles(entry, dependenciesOf, importers) {
  const seen = new Set([entry]);
  for (const file of seen) {
    for (const { path, sideEffectsOnly } of dependenciesOf(file)) {
      seen.add(path);
      if (sideEffectsOnly && !importers.has(path)) {
        importers.set(path, file);
      }
    }
  }
  return [...seen].slice(1);
}

/**
 * Return a function that returns the package files that a browser module
 * loads, which checks each module once, and reports a module outside the
 * package.
 *
 * @param {string[]} problems Where to report problems.
 * @param {string} packageDir Extracted package.
 * @param {string[]} packed Files in the package.
 * @returns {(file: string) => Dependency[]}
 */
function browserDependencies(problems, packageDir, packed) {
  /** @type {Map<string, Dependency[]>} */
  const dependencies = new Map();
  return (file) => {
    let found = dependencies.get(file);
    if (found === undefined) {
      if (packed.includes(file)) {
        found = checkBrowserModule(problems, packageDir, file);
      } else {
        problems.push(`The browser entry loads ${file}, which the package does not include`);
        found = [];
      }
      dependencies.set(file, found);
    }
    return found;
  };
}

/**
 * Check that a JavaScript file that the browser entry loads is an ES module
 * and loads WebAssembly through `new URL()`, and return the package files it
 * loads. Return nothing for other files.
 *
 * @param {string[]} problems Where to report problems.
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 * @returns {Dependency[]}
 */
function checkBrowserModule(problems, packageDir, file) {
  if (!/\.[cm]?js$/.test(file)) {
    return [];
  }
  if (!isEsModule(packageDir, file)) {
    problems.push(
      `The browser entry module ${file} is not an ES module by its file extension or the ` +
        '"type" of its nearest package.json, so bundlers do not parse its import and export ' +
        'statements',
    );
  }
  const dependencies = localDependencies(problems, packageDir, file);
  for (const { path } of dependencies.filter(({ path, url }) => path.endsWith('.wasm') && !url)) {
    problems.push(
      `The browser entry module ${file} imports ${path} as an ES module, which needs ` +
        "WebAssembly ESM integration; load it through new URL('…', import.meta.url)",
    );
  }
  return dependencies;
}

/**
 * Return the package.json files whose `sideEffects` field lets bundlers
 * drop a file of the package, a browser entry point or a module imported
 * for its side effects only. Vite reads the field of the package root for
 * the entry point it resolves, webpack that of the package.json nearest to
 * the file.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 * @returns {string[]} Their paths, relative to `packageDir`.
 */
function sideEffectFreeManifests(packageDir, file) {
  const manifests = [{ dir: '.', manifest: readJson(join(packageDir, 'package.json')) }];
  const nearest = nearestManifest(packageDir, file);
  if (nearest.dir !== '.') {
    manifests.push(nearest);
  }
  return manifests
    .filter(
      ({ dir, manifest }) => !hasSideEffects(manifest['sideEffects'], posix.relative(dir, file)),
    )
    .map(({ dir }) => posix.join(dir, 'package.json'));
}

/**
 * Whether a `sideEffects` field marks a file as having side effects, as
 * webpack and Vite read it: a pattern without a `/` matches the file name in
 * any directory.
 *
 * @param {unknown} sideEffects
 * @param {string} file Path relative to the directory of the package.json.
 */
function hasSideEffects(sideEffects, file) {
  if (!Array.isArray(sideEffects)) {
    return sideEffects !== false;
  }
  /** @type {unknown[]} */
  const patterns = sideEffects;
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') {
      return false;
    }
    const glob = normalizePath(pattern);
    return matchesGlob(file, glob.includes('/') ? glob : `**/${glob}`);
  });
}

/**
 * Whether bundlers and Node parse a JavaScript file of the package as an ES
 * module.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 */
function isEsModule(packageDir, file) {
  if (file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return file.endsWith('.mjs');
  }
  return nearestManifest(packageDir, file).manifest['type'] === 'module';
}

/**
 * Return the package.json that applies to a file of the package, the
 * nearest one, with its directory relative to the package.
 *
 * @param {string} packageDir Extracted package.
 * @param {string} file Path relative to `packageDir`.
 * @returns {{ dir: string, manifest: Record<string, unknown> }}
 */
function nearestManifest(packageDir, file) {
  let dir = posix.dirname(file);
  while (dir !== '.' && !existsSync(join(packageDir, dir, 'package.json'))) {
    dir = posix.dirname(dir);
  }
  return { dir, manifest: readJson(join(packageDir, dir, 'package.json')) };
}

/**
 * Return the package files that a JavaScript file of the package loads, and
 * how it loads each one, and report every module it imports from elsewhere.
 *
 * @param {string[]} problems Where to report problems.
 * @param {string} packageDir
 * @param {string} file Path relative to `packageDir`.
 * @returns {Dependency[]}
 */
function localDependencies(problems, packageDir, file) {
  const ast = parseAst(readFileSync(join(packageDir, file), 'utf8'));
  /** @type {Dependency[]} */
  const dependencies = [];
  for (const { specifier, url, sideEffectsOnly } of moduleReferences(ast)) {
    const local = url
      ? !/^[a-z][a-z\d+.-]*:|^\//i.test(specifier)
      : specifier.startsWith('./') || specifier.startsWith('../');
    if (local) {
      const path = posix.normalize(posix.join(posix.dirname(file), specifier));
      dependencies.push({ path, url, sideEffectsOnly });
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
 * way wasm-bindgen's `web` target locates its .wasm file), and whether each
 * one is an import declaration without specifiers, which imports a module
 * for its side effects only.
 *
 * @param {unknown} node ESTree node, or an array or value inside one.
 * @returns {Generator<{ specifier: string, url: boolean, sideEffectsOnly: boolean }>}
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
  const source = stringLiteral(node['source']);
  if (source !== undefined && MODULE_NODE_TYPES.has(String(node['type']))) {
    const { specifiers } = node;
    const sideEffectsOnly =
      node['type'] === 'ImportDeclaration' && Array.isArray(specifiers) && specifiers.length === 0;
    yield { specifier: source, url: false, sideEffectsOnly };
  }
  const url = importMetaUrl(node);
  if (url !== undefined) {
    yield { specifier: url, url: true, sideEffectsOnly: false };
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
  if (node['type'] !== 'NewExpression' || !isRecord(callee) || callee['name'] !== 'URL') {
    return undefined;
  }
  /** @type {unknown[]} */
  const args = Array.isArray(node['arguments']) ? node['arguments'] : [];
  const [path, base] = args;
  const isImportMetaUrl =
    isRecord(base) &&
    base['type'] === 'MemberExpression' &&
    isRecord(base['object']) &&
    base['object']['type'] === 'MetaProperty' &&
    isRecord(base['property']) &&
    base['property']['name'] === 'url';
  return isImportMetaUrl ? stringLiteral(path) : undefined;
}

/**
 * @param {unknown} node
 * @returns {string | undefined}
 */
function stringLiteral(node) {
  if (!isRecord(node) || node['type'] !== 'Literal') {
    return undefined;
  }
  const { value } = node;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Turn a package.json path such as `./index.js` into a packed path.
 *
 * @param {string} path
 */
export function normalizePath(path) {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}
