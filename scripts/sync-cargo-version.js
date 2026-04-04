#!/usr/bin/env node
/**
 * Sync the version from package.json to all Cargo.toml files.
 *
 * Run after `changeset version` to keep Cargo.toml in sync with package.json.
 * This is needed because changesets only manages npm package versions.
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
  if (!fs.existsSync(cargoPath)) continue;

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
