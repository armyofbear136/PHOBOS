// SEA loader for the duckdb package.
// Aliased via esbuild: { 'duckdb': './sea-native-duckdb.cjs' }
//
// Loads duckdb's lib/duckdb.js from the staged dist/duckdb/ directory.
// lib/duckdb.js uses @mapbox/node-pre-gyp to find and load duckdb.node.
// We stage a minimal fake node-pre-gyp that computes the correct binary path
// without needing the full node-pre-gyp dependency tree.
//
// Module.createRequire(entry) creates a require() scoped to the duckdb package
// directory, so all internal requires (including @mapbox/node-pre-gyp) resolve
// correctly against dist/duckdb/node_modules/.
'use strict';
const path   = require('path');
const Module = require('module');
const fs     = require('fs');

const exeDir  = path.dirname(process.execPath);
const pkgDir  = path.join(exeDir, 'duckdb');
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const main    = pkgJson.main || 'lib/duckdb.js';
const entry   = path.join(pkgDir, main);

// createRequire bound to the entry file so @mapbox/node-pre-gyp resolves
// from pkgDir/node_modules/ where we staged our fake implementation.
module.exports = Module.createRequire(entry)(entry);
