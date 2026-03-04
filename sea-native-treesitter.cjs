// SEA loader for tree-sitter. Same pattern as sea-native-duckdb.cjs.
'use strict';
const path   = require('path');
const Module = require('module');
const fs     = require('fs');

const exeDir  = path.dirname(process.execPath);
const pkgDir  = path.join(exeDir, 'tree-sitter');
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const main    = pkgJson.main || 'tree_sitter.js';
const entry   = path.join(pkgDir, main);

module.exports = Module.createRequire(entry)(entry);
