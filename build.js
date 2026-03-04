// build.js — PHOBOS single-platform build
// Builds phobos-core for the current platform only.
// For all platforms at once, use: npm run build:all
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DIST_DIR   = path.join(__dirname, 'dist');

// ── Minimal fake @mapbox/node-pre-gyp ───────────────────────────────────────
// Staged into dist/duckdb/node_modules/@mapbox/node-pre-gyp/index.js.
// The real package computes the .node path from package.json's binary field;
// we replicate just find() — the only function duckdb's lib/duckdb.js calls.
const FAKE_NODE_PRE_GYP = `
'use strict';
const path = require('path');
const fs   = require('fs');
exports.find = function find(packageJsonPath) {
  const pkg    = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binary = pkg.binary || {};
  const nodeAbi    = 'node-' + process.versions.modules;
  const modulePath = (binary.module_path || './build/Release/')
    .replace('{configuration}', 'Release')
    .replace('{node_abi}',  nodeAbi)
    .replace('{platform}',  process.platform)
    .replace('{arch}',      process.arch)
    .replace('{libc}',      'unknown');
  const moduleName = binary.module_name || 'binding';
  const resolved = path.resolve(path.dirname(packageJsonPath), modulePath, moduleName + '.node');
  // Fallback: if computed path doesn't exist, deep-search for any .node file
  if (fs.existsSync(resolved)) return resolved;
  const walk = (dir, depth) => {
    if (depth < 0) return null;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'obj' || e.name === 'Debug') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = walk(p, depth-1); if (r) return r; }
        else if (e.name.endsWith('.node')) return p;
      }
    } catch {}
    return null;
  };
  const fallback = walk(path.dirname(packageJsonPath), 5);
  if (fallback) return fallback;
  throw new Error('node-pre-gyp: cannot find ' + moduleName + '.node near ' + packageJsonPath);
};
`.trim();

// ── Minimal fake node-gyp-build ─────────────────────────────────────────────
// Staged into dist/tree-sitter/node_modules/node-gyp-build/index.js.
const FAKE_NODE_GYP_BUILD = `
'use strict';
const path = require('path');
const fs   = require('fs');
module.exports = function nodeGypBuild(dir) {
  const walk = (d, depth) => {
    if (depth < 0) return null;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'obj' || e.name === 'Debug') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { const r = walk(p, depth-1); if (r) return r; }
        else if (e.name.endsWith('.node')) return require(p);
      }
    } catch {}
    return null;
  };
  const result = walk(dir, 5);
  if (result) return result;
  throw new Error('node-gyp-build: no .node binary found in ' + dir);
};
`.trim();

export async function buildForPlatform({
  distDir = DIST_DIR,
  verbose  = true,
} = {}) {
  const log = verbose ? console.log.bind(console) : () => {};

  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // ── 1. Bundle JS ────────────────────────────────────────────────────────────
  log('📦 Bundling TypeScript...');
  const bundlePath = path.join(distDir, 'phobos.cjs');
  await esbuild({
    entryPoints: ['server.ts'],
    bundle:   true,
    platform: 'node',
    target:   'node22',
    format:   'cjs',
    outfile:  bundlePath,
    alias: {
      'duckdb':      './sea-native-duckdb.cjs',
      'tree-sitter': './sea-native-treesitter.cjs',
    },
  });
  log('✅ Bundle complete');

  // ── 2. SEA blob ─────────────────────────────────────────────────────────────
  log('📝 Creating SEA config...');
  const blobPath   = path.join(distDir, 'sea-prep.blob');
  const configPath = path.join(distDir, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    main:   bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  }, null, 2));

  log('🔧 Generating SEA blob...');
  execSync(`node --experimental-sea-config "${configPath}"`, { stdio: verbose ? 'inherit' : 'pipe' });

  // ── 3. Inject into node binary ──────────────────────────────────────────────
  log('💉 Injecting blob into executable...');
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const ext   = isWin ? '.exe' : '';
  const exePath = path.join(distDir, `phobos-core${ext}`);

  fs.copyFileSync(process.execPath, exePath);
  if (isMac) execSync(`codesign --remove-signature "${exePath}"`);

  const machoFlag = isMac ? '--macho-segment-name NODE_SEA' : '';
  execSync(
    `npx postject "${exePath}" NODE_SEA_BLOB "${blobPath}" ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ${machoFlag}`.trimEnd(),
    { stdio: verbose ? 'inherit' : 'pipe' }
  );
  if (isMac) execSync(`codesign --sign - "${exePath}"`);

  // ── 4. Stage native packages ────────────────────────────────────────────────
  log('📂 Staging native packages...');

  const SKIP_DIRS = new Set(['obj', '.cache', 'test', 'tests', 'docs', 'doc',
                              'example', 'examples', '.github', 'scripts']);
  const SKIP_EXT  = new Set(['.cc', '.cpp', '.h', '.gyp', '.gypi', '.c',
                              '.md', '.map', '.ts']);

  const copyDir = (src, dst) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isFile() && SKIP_EXT.has(path.extname(e.name))) continue;
      const [s, d] = [path.join(src, e.name), path.join(dst, e.name)];
      e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
    }
  };

  const writeFake = (destPkgDir, fakePkgName, indexContent) => {
    const d = path.join(destPkgDir, 'node_modules', fakePkgName);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.js'), indexContent);
    fs.writeFileSync(path.join(d, 'package.json'),
      JSON.stringify({ name: fakePkgName, version: '0.0.0-sea', main: 'index.js' }, null, 2));
  };

  // duckdb — prefer duckdb-async's nested copy (version-locked)
  const duckdbSrc = (() => {
    const nested = path.join(__dirname, 'node_modules', 'duckdb-async', 'node_modules', 'duckdb');
    return fs.existsSync(nested) ? nested : path.join(__dirname, 'node_modules', 'duckdb');
  })();
  if (!fs.existsSync(duckdbSrc)) {
    console.warn('  ⚠️  duckdb not found — run npm install');
  } else {
    const dest = path.join(distDir, 'duckdb');
    copyDir(duckdbSrc, dest);
    writeFake(dest, '@mapbox/node-pre-gyp', FAKE_NODE_PRE_GYP);
    log(`  ✅ duckdb/`);
  }

  // tree-sitter
  const tsSrc = path.join(__dirname, 'node_modules', 'tree-sitter');
  if (!fs.existsSync(tsSrc)) {
    console.warn('  ⚠️  tree-sitter not found — run npm install');
  } else {
    const dest = path.join(distDir, 'tree-sitter');
    copyDir(tsSrc, dest);
    writeFake(dest, 'node-gyp-build', FAKE_NODE_GYP_BUILD);
    log(`  ✅ tree-sitter/`);
  }

  if (fs.existsSync(path.join(__dirname, '.env'))) {
    fs.copyFileSync(path.join(__dirname, '.env'), path.join(distDir, '.env'));
    log('  ✅ .env');
  }

  // ── 5. Cleanup ──────────────────────────────────────────────────────────────
  for (const f of ['sea-prep.blob', 'sea-config.json']) {
    const p = path.join(distDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  return exePath;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const isWin = process.platform === 'win32';
const ext   = isWin ? '.exe' : '';

console.log('🚀 Starting PHOBOS build...');
buildForPlatform()
  .then(exe => {
    console.log(`\n✅ Build complete → dist/phobos-core${ext}`);
    console.log(`   dist/ layout: phobos-core${ext}  duckdb/  tree-sitter/  (.env)`);
    console.log(`   Run: cd dist && .${isWin ? '\\' : '/'}phobos-core${ext}`);
  })
  .catch(err => {
    console.error('❌ Build failed:', err.message);
    process.exit(1);
  });
