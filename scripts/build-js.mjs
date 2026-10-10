#!/usr/bin/env node

/**
 * Compile the JavaScript modules of the package from their TypeScript sources
 * in src/: the stream helpers (streams.js, node.js and browser/streams.js),
 * the ES module entry (index.mjs), the unified API (next/), and the
 * declaration files of each. npm publishes the outputs, so they are tracked;
 * CI runs this script and fails if they change.
 *
 * Each TypeScript project in PROJECTS is compiled with tsc, which TypeScript
 * 7 provides as a command only. The CommonJS outputs, every file that tsc
 * emits for a module of the project, then lose the line that marks them as
 * compiled from ES modules (see ES_MODULE_MARKER).
 *
 * Usage:
 *   node scripts/build-js.mjs   (or pnpm run build:js)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

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
 * The prefix of the lines in which `tsc --listEmittedFiles` names the files
 * that it wrote.
 */
const EMITTED_FILE = 'TSFILE: ';

/**
 * @typedef {object} Project
 * @property {string} module The `module` compiler option.
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
  const module = isRecord(options) ? options['module'] : undefined;
  if (typeof module !== 'string') {
    throw new Error(`${config} does not set compilerOptions.module`);
  }
  return { module };
}

/**
 * Compile a project with tsc, which prints its diagnostics, and return the
 * files that it emitted.
 *
 * @param {string} config Path of the tsconfig file, relative to ROOT.
 * @returns {string[]} Paths relative to ROOT.
 */
function compile(config) {
  const args = ['node_modules/typescript/bin/tsc', '-p', config, '--listEmittedFiles'];
  // tsc colors its diagnostics only when it writes to a terminal itself.
  if (process.stdout.isTTY) args.push('--pretty');
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error !== undefined) throw result.error;
  /** @type {string[]} */
  const emitted = [];
  /** @type {string[]} */
  const diagnostics = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(EMITTED_FILE)) {
      emitted.push(relative(ROOT, line.slice(EMITTED_FILE.length)));
    } else {
      diagnostics.push(line);
    }
  }
  // Blank lines separate the diagnostics in the --pretty format: keep all
  // but those at either end.
  const output = diagnostics.join('\n').trim();
  if (output !== '') console.log(output);
  if (result.status !== 0) {
    throw new Error(`tsc -p ${config} failed`);
  }
  return emitted;
}

/**
 * Return the CommonJS modules among the files that a project emitted: the
 * .js files if the project compiles with `module` NodeNext, as package.json
 * sets `"type": "commonjs"`. The .mts inputs compile to ES modules, .mjs
 * files.
 *
 * @param {Project} project
 * @param {string[]} emitted Paths relative to ROOT.
 * @returns {string[]} Paths relative to ROOT.
 */
function commonJsOutputs(project, emitted) {
  if (project.module.toLowerCase() !== 'nodenext') {
    return [];
  }
  return emitted.filter((file) => extname(file) === '.js');
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
  const emitted = compile(config);
  for (const file of commonJsOutputs(readProject(config), emitted)) {
    removeEsModuleMarker(file);
  }
}
