// build.js — PHOBOS single-platform build
// Builds phobos-core for the current platform only.
// For all platforms at once, use: npm run build:all
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';

// Read version from source tree — stamps the output binary name.
// Tries version.ts first (dev), falls back to version.js (if pre-compiled).
const _versionFile = fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.ts'))
  ? pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.ts')).href
  : pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.js')).href;
const { CORE_VERSION } = await import(_versionFile);

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
    // SEA resolution: native addon packages (onnxruntime, sharp, @xenova/transformers,
    // @imgly/background-removal-node) are marked external so esbuild doesn't try to
    // bundle their .node binaries. At runtime, the require() calls need to find the
    // staged copies in dist/node_modules/. This banner prepends the exe-adjacent
    // node_modules to Module's global paths so require() resolves correctly in SEA mode.
    banner: {
      js: `try{const _p=require("path"),_m=require("module");` +
          `const _d=_p.join(_p.dirname(process.execPath),"node_modules");` +
          `if(!_m.globalPaths.includes(_d))_m.globalPaths.unshift(_d);}catch{}`,
    },
    alias: {
      'duckdb':      './sea-native-duckdb.cjs',
      'tree-sitter': './sea-native-treesitter.cjs',
    },
    external: [
      'onnxruntime-node',
      '@xenova/transformers',
      '@imgly/background-removal-node',
      'sharp',
    ],
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

  // onnxruntime-node — native ONNX runtime (VisionProcessor face/hand/depth detection)
  // Only staged if installed — VisionProcessor lazy-imports and throws a clear message if absent.
  const onnxSrc = path.join(__dirname, 'node_modules', 'onnxruntime-node');
  if (fs.existsSync(onnxSrc)) {
    const dest = path.join(distDir, 'node_modules', 'onnxruntime-node');
    copyDir(onnxSrc, dest);
    log(`  ✅ onnxruntime-node/`);
  } else {
    log('  ⚠️  onnxruntime-node not installed — VisionProcessor will be unavailable');
  }

  // @xenova/transformers — ML pipeline framework (VisionProcessor detection/depth models)
  const xenovaSrc = path.join(__dirname, 'node_modules', '@xenova', 'transformers');
  if (fs.existsSync(xenovaSrc)) {
    const dest = path.join(distDir, 'node_modules', '@xenova', 'transformers');
    copyDir(xenovaSrc, dest);
    log(`  ✅ @xenova/transformers/`);
  } else {
    log('  ⚠️  @xenova/transformers not installed — VisionProcessor will be unavailable');
  }

  // sharp — image processing (used by VisionProcessor for PNG read/write)
  const sharpSrc = path.join(__dirname, 'node_modules', 'sharp');
  if (fs.existsSync(sharpSrc)) {
    const dest = path.join(distDir, 'node_modules', 'sharp');
    copyDir(sharpSrc, dest);
    log(`  ✅ sharp/`);
  } else {
    log('  ⚠️  sharp not installed — some vision features may be unavailable');
  }

  // @imgly/background-removal-node — optional (RemoveBg node only)
  const imglySrc = path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node');
  if (fs.existsSync(imglySrc)) {
    const dest = path.join(distDir, 'node_modules', '@imgly', 'background-removal-node');
    copyDir(imglySrc, dest);
    // Point imgly at the TOP-LEVEL staged onnxruntime-node rather than its own
    // bundled copy. imgly's bundled .node binary may be a different napi ABI than
    // the one the SEA executable was built with, causing "cannot run %1" on Windows.
    // Symlinking (or copying) from the top-level staged version ensures ABI consistency.
    // Keep imgly's own onnxruntime-node (1.17.3) — do NOT junction to top-level 1.14.0.
    // imgly's ONNX model requires ops from 1.17.x; using 1.14.0 crashes the process.
    // We stage imgly's own copy and patch its index.js to force CPU execution provider,
    // preventing the CUDA init crash that happens in the SEA binary context.
    const imglyOnnx = path.join(imglySrc, 'node_modules', 'onnxruntime-node');
    if (fs.existsSync(imglyOnnx)) {
      const onnxDest = path.join(dest, 'node_modules', 'onnxruntime-node');
      copyDir(imglyOnnx, onnxDest);
      // Patch the staged onnxruntime-node index.js to force CPU execution provider.
      // This prevents the CUDA provider init crash in SEA context on NVIDIA hardware.
      // Find and patch onnxruntime-node entry point to force CPU execution provider.
      // onnxruntime 1.17.x tries CUDA first which crashes the SEA process on NVIDIA hardware.
      const ortPkgPath = path.join(onnxDest, 'package.json');
      const ortCandidates = [
        path.join(onnxDest, 'dist', 'cjs', 'onnxruntime-node.js'),
        path.join(onnxDest, 'dist', 'cjs', 'backend-onnxruntime-node.js'),
        path.join(onnxDest, 'dist', 'cjs', 'index.js'),
        path.join(onnxDest, 'lib', 'index.js'),
        path.join(onnxDest, 'index.js'),
      ];
      if (fs.existsSync(ortPkgPath)) {
        try {
          const ortPkg = JSON.parse(fs.readFileSync(ortPkgPath, 'utf8'));
          const ortMain = ortPkg.main || 'index.js';
          ortCandidates.unshift(path.join(onnxDest, ortMain));
        } catch {}
      }
      const cpuPatch = '\n// SEA patch: force CPU execution provider\nif (typeof exports !== "undefined" && exports.InferenceSession) { const _oc = exports.InferenceSession.create.bind(exports.InferenceSession); exports.InferenceSession.create = async (m,o) => _oc(m, Object.assign({},o||{},{executionProviders:[\'cpu\']})); }\n';
      for (const ortIndex of ortCandidates) {
        if (!fs.existsSync(ortIndex)) continue;
        try {
          let ortSrc = fs.readFileSync(ortIndex, 'utf8');
          if (!ortSrc.includes('SEA patch') && ortSrc.includes('InferenceSession')) {
            fs.writeFileSync(ortIndex, ortSrc + cpuPatch);
            log('  🔧 Patched ' + path.basename(ortIndex) + ' (imgly onnxruntime CPU-only)');
            break;
          }
        } catch {}
      }
    }
    log(`  ✅ @imgly/background-removal-node/`);
  } else {
    log('  ⚠️  @imgly/background-removal-node not installed — RemoveBg node unavailable');
  }

  if (fs.existsSync(path.join(__dirname, '.env'))) {
    fs.copyFileSync(path.join(__dirname, '.env'), path.join(distDir, '.env'));
    log('  ✅ .env (copied from source)');
  } else if (process.env.PHOBOS_LICENSE_SEED) {
    // CI build: generate .env from environment variables
    const envLines = [];
    if (process.env.PHOBOS_LICENSE_SEED) envLines.push(`PHOBOS_LICENSE_SEED=${process.env.PHOBOS_LICENSE_SEED}`);
    if (process.env.AUTARCH_LICENSE_URL) envLines.push(`AUTARCH_LICENSE_URL=${process.env.AUTARCH_LICENSE_URL}`);
    envLines.push('');
    fs.writeFileSync(path.join(distDir, '.env'), envLines.join('\n'));
    log('  ✅ .env (generated from CI environment)');
  }

  // llama-server + sd-cli — stage all platform binaries present in bin/ into dist/
  // Copies everything recursively: binaries, dylibs, DLLs, and subdirectories
  // (sd-cuda/, sd-vulkan/, sd-cpu/ for Windows sd-cli isolation).
  const binDir = path.join(__dirname, 'bin');
  if (fs.existsSync(binDir)) {
    let staged = 0;
    const stageBinDir = (srcDir, dstDir) => {
      fs.mkdirSync(dstDir, { recursive: true });
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (entry.name === '.tmp') continue;
        const src = path.join(srcDir, entry.name);
        const dst = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
          stageBinDir(src, dst);
        } else {
          fs.copyFileSync(src, dst);
          if (!entry.name.endsWith('.exe') && !entry.name.endsWith('.dll')) fs.chmodSync(dst, 0o755);
          staged++;
        }
      }
    };
    stageBinDir(binDir, distDir);
    if (staged > 0) log(`  ✅ bin/ (${staged} files staged, including subdirs)`);
    else            log('  ⚠️  llama-server — no binaries in bin/ (run: node scripts/fetch-llamacpp.js)');
  } else {
    log('  ⚠️  bin/ missing — run: node scripts/fetch-llamacpp.js');
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
