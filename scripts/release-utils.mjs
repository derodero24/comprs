/**
 * Helpers shared by the release packaging scripts, prepare-release.mjs and
 * check-release.mjs, and by check-consumer-types.mjs and
 * e2e/install-package.mjs, which pack the package.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readNapiConfig } from '@napi-rs/cli';

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
