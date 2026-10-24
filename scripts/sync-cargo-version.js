#!/usr/bin/env node
/**
 * Sync the version from package.json to all Cargo.toml files.
 *
 * Run after `changeset version` to keep Cargo.toml in sync with package.json.
 * This is needed because changesets only manages npm package versions.
 *
 * The workspace's Cargo.lock follows on the next cargo build, which the
 * changeset:version script runs. The fuzz crate is a workspace of its own
 * that no build of the version job compiles, so its Cargo.lock, which lists
 * comprs-core, is updated here: Fuzz's clippy --locked fails otherwise.
 *
 * Usage:
 *   node scripts/sync-cargo-version.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PKG_PATH = path.resolve(__dirname, '..', 'package.json');
const CARGO_PATHS = [
  path.resolve(__dirname, '..', 'crates', 'core', 'Cargo.toml'),
  path.resolve(__dirname, '..', 'crates', 'core-lib', 'Cargo.toml'),
  path.resolve(__dirname, '..', 'crates', 'wasm', 'Cargo.toml'),
];

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const version = pkg.version;

for (const cargoPath of CARGO_PATHS) {
  if (!fs.existsSync(cargoPath)) {
    continue;
  }

  const cargo = fs.readFileSync(cargoPath, 'utf-8');
  const updated = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);

  const name = path.relative(path.resolve(__dirname, '..'), cargoPath);
  if (cargo === updated) {
    console.log(`${name} already at version ${version}`);
  } else {
    fs.writeFileSync(cargoPath, updated);
    console.log(`Synced ${name} version to ${version}`);
  }
}

const FUZZ_LOCK_PATH = path.resolve(__dirname, '..', 'crates', 'core-lib', 'fuzz', 'Cargo.lock');
const lock = fs.readFileSync(FUZZ_LOCK_PATH, 'utf-8');
const lockPattern = /^(name = "comprs-core"\nversion = )"[^"]*"/m;
if (!lockPattern.test(lock)) {
  throw new Error('comprs-core is missing from crates/core-lib/fuzz/Cargo.lock');
}
const updatedLock = lock.replace(lockPattern, `$1"${version}"`);
if (lock === updatedLock) {
  console.log(`crates/core-lib/fuzz/Cargo.lock already at version ${version}`);
} else {
  fs.writeFileSync(FUZZ_LOCK_PATH, updatedLock);
  console.log(`Synced crates/core-lib/fuzz/Cargo.lock version to ${version}`);
}
