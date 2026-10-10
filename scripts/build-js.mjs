#!/usr/bin/env node

/**
 * Compile the JavaScript modules of the package from their TypeScript sources
 * in src/: the stream helpers (streams.js, node.js and browser/streams.js),
 * the ES module entry (index.mjs), and the declaration files of each. npm
 * publishes the outputs, so they are tracked; CI runs this script and fails
 * if they change.
 *
 * Each TypeScript project in PROJECTS is compiled with tsc, which TypeScript
 * 7 provides as a command only. The CommonJS outputs then lose the line that
 * marks them as compiled from ES modules (see ES_MODULE_MARKER).
 *
 * Usage:
 *   node scripts/build-js.mjs   (or pnpm run build:js)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, posix, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The tsconfig files of the projects to compile: the modules for Node.js,
 * then the browser module.
 */
const PROJECTS = ['tsconfig.build.json', 'tsconfig.browser.json'];

/**
 * The line by which tsc marks a CommonJS module that it compiled from an ES
 * module. Node.js would expose it as an export named `__esModule`, from the
 * CommonJS module and through `export *` in index.mjs, which the modules did
 * not export when they were written in JavaScript (__test__/export-parity.mjs
 * checks the exported names). The package itself does not read it.
 */
const ES_MODULE_MARKER = 'Object.defineProperty(exports, "__esModule", { value: true });';

/**
 * @typedef {object} Project
 * @property {string} module The `module` compiler option.
 * @property {string} rootDir
 * @property {string} outDir
 * @property {string[]} files The input files.
 */

/**
 * Whether a value is a JSON object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the options of a project that this script relies on, from its
 * tsconfig file alone: each project sets them itself. The file must be plain
 * JSON, without the comments that tsc allows.
 *
 * @param {string} config Path of the tsconfig file, relative to ROOT.
 * @returns {Project}
 */
function readProject(config) {
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(readFileSync(join(ROOT, config), 'utf8'));
  } catch (error) {
    throw new Error(`${config} is not plain JSON, which this script reads`, { cause: error });
  }
  const options = isRecord(json) ? json['compilerOptions'] : undefined;
  const files = isRecord(json) ? json['files'] : undefined;
  /** @param {string} name */
  const option = (name) => {
    const value = isRecord(options) ? options[name] : undefined;
    if (typeof value !== 'string') {
      throw new Error(`${config} does not set compilerOptions.${name}`);
    }
    return value;
  };
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
    throw new Error(`${config} does not list its input files`);
  }
  return {
    module: option('module'),
    rootDir: option('rootDir'),
    outDir: option('outDir'),
    files,
  };
}

/**
 * Return the CommonJS modules that a project emits: the .js output of each
 * .ts input if the project compiles with `module` NodeNext, as package.json
 * sets `"type": "commonjs"`. The .mts inputs compile to ES modules.
 *
 * @param {Project} project
 * @returns {string[]} Paths relative to ROOT.
 */
function commonJsOutputs(project) {
  if (project.module.toLowerCase() !== 'nodenext') {
    return [];
  }
  return project.files
    .filter((file) => extname(file) === '.ts' && !file.endsWith('.d.ts'))
    .map((file) =>
      posix.join(project.outDir, posix.relative(project.rootDir, file)).replace(/\.ts$/, '.js'),
    );
}

/**
 * Remove ES_MODULE_MARKER from a CommonJS module that tsc emitted.
 *
 * @param {string} file Path relative to ROOT.
 */
function removeEsModuleMarker(file) {
  const path = join(ROOT, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.indexOf(ES_MODULE_MARKER);
  if (index === -1) {
    throw new Error(`${file} does not hold the line ${ES_MODULE_MARKER}`);
  }
  lines.splice(index, 1);
  writeFileSync(path, lines.join('\n'));
}

for (const config of PROJECTS) {
  console.log(`tsc -p ${config}`);
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  for (const file of commonJsOutputs(readProject(config))) {
    removeEsModuleMarker(file);
  }
}
