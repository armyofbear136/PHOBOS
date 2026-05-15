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

  // ── 1a. Bundle coordinator worker_thread ──────────────────────────────────
  // The coordinator runs as a worker_thread sibling .cjs to the SEA binary.
  // Worker spawn uses the normal Node module loader to read this file, which
  // works regardless of whether the host process is a SEA. Same externals and
  // aliases as the main bundle, but with a strict guard: the coordinator must
  // never reach DatabaseManager — all DB-bound work routes back to main via
  // postMessage. We enforce this by scanning the bundle output and failing
  // the build if `class DatabaseManager` appears.
  log('📦 Bundling coordinator...');
  const coordinatorPath = path.join(distDir, 'coordinator.cjs');
  await esbuild({
    entryPoints: ['coordinator/coordinator.ts'],
    bundle:   true,
    platform: 'node',
    target:   'node22',
    format:   'cjs',
    outfile:  coordinatorPath,
    alias: {
      'duckdb':      './sea-native-duckdb.cjs',
      'tree-sitter': './sea-native-treesitter.cjs',
    },
    external: [
      'onnxruntime-node',
      '@xenova/transformers',
      '@imgly/background-removal-node',
      'sharp',
      'tree-sitter-javascript',
      'tree-sitter-typescript',
    ],
  });

  // Post-bundle DB-import guard. If anyone reintroduces a DatabaseManager
  // import to the coordinator's reachable graph, the bundle will contain the
  // class definition and this check will fail the build immediately.
  {
    const bundleSrc = fs.readFileSync(coordinatorPath, 'utf8');
    if (bundleSrc.includes('class DatabaseManager')) {
      throw new Error(
        '[build] coordinator.cjs contains DatabaseManager — coordinator must not import DB. ' +
        'Check ai/clients.ts, ai/LoopController.ts, ai/DispatchComposer.ts, ai/TaskPlanner.ts ' +
        'and any newly added files in their import graph for DatabaseManager references.',
      );
    }
  }
  log('✅ Coordinator bundle complete');

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
      'tree-sitter-javascript',
      'tree-sitter-typescript',
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
                              'example', 'examples', '.github', 'scripts',
                              'src', 'include', 'third_party', 'vendor']);
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
    // Prune C++ source trees that got copied — only runtime files needed
    for (const pruneDir of ['src', 'third_party']) {
      const p = path.join(dest, pruneDir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
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

  // package-lock.json — copied into dist/ so DependencyAuditor finds it in SEA context
  const lockSrc = path.join(__dirname, 'package-lock.json');
  if (fs.existsSync(lockSrc)) {
    fs.copyFileSync(lockSrc, path.join(distDir, 'package-lock.json'));
    log('  ✅ package-lock.json (staged for dependency audit)');
  } else {
    log('  ⚠️  package-lock.json not found — run npm install before building');
  }

  // tree-sitter grammar packages — staged to dist/node_modules/ so CodeAuditor's
  // dynamic import('tree-sitter-javascript') resolves via the globalPaths banner.
  for (const grammarPkg of ['tree-sitter-javascript', 'tree-sitter-typescript']) {
    const grammarSrc = path.join(__dirname, 'node_modules', grammarPkg);
    if (fs.existsSync(grammarSrc)) {
      const dest = path.join(distDir, 'node_modules', grammarPkg);
      copyDir(grammarSrc, dest);
      // Each grammar package needs node-gyp-build to load its .node binary at runtime
      writeFake(dest, 'node-gyp-build', FAKE_NODE_GYP_BUILD);
      log(`  ✅ ${grammarPkg}/`);
    } else {
      log(`  ⚠️  ${grammarPkg} not installed — code audit will degrade gracefully`);
    }
  }

  // argon2.wasm — raw Argon2 WASM binary for PHOBOS Vault KDBX4 support.
  // VaultCrypto.ts loads this directly via WebAssembly.instantiate + fs.readFileSync.
  // No argon2-browser JS wrapper is used — only the compiled WASM binary is needed.
  const argon2WasmSrc = path.join(__dirname, 'node_modules', 'argon2-browser', 'dist', 'argon2.wasm');
  if (fs.existsSync(argon2WasmSrc)) {
    const argon2WasmDest = path.join(distDir, 'node_modules', 'argon2-browser', 'dist');
    fs.mkdirSync(argon2WasmDest, { recursive: true });
    fs.copyFileSync(argon2WasmSrc, path.join(argon2WasmDest, 'argon2.wasm'));
    log('  ✅ argon2-browser/dist/argon2.wasm');
  } else {
    log('  ⚠️  argon2.wasm not found — Vault KDBX4 unlock will fail');
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
    // Nest onnxruntime-node inside @xenova/transformers/node_modules/ so ESM
    // import('onnxruntime-node') from onnx.js resolves correctly in SEA context.
    // ESM resolution walks up from the importing file's package root, and in SEA
    // the outer node_modules/ may not be found. Nesting guarantees resolution.
    if (fs.existsSync(onnxSrc)) {
      const nestedOrt = path.join(dest, 'node_modules', 'onnxruntime-node');
      copyDir(onnxSrc, nestedOrt);
    }
    // Patch onnx.js to force onnxruntime-node via createRequire instead of ESM import().
    // ESM import() in SEA context resolves from baked-in file URLs which break on
    // other machines. This patch replaces the dynamic import with a CJS require
    // anchored to the package's own directory.
    const onnxJsPath = path.join(dest, 'src', 'backends', 'onnx.js');
    if (fs.existsSync(onnxJsPath)) {
      let onnxJs = fs.readFileSync(onnxJsPath, 'utf8');
      // Replace any import('onnxruntime-node') or import("onnxruntime-node") with
      // a createRequire-based resolution that works in SEA context.
      if (onnxJs.includes('onnxruntime-node')) {
        onnxJs = onnxJs.replace(
          /import\s*\(\s*['"]onnxruntime-node['"]\s*\)/g,
          `(async()=>{const{createRequire:cr}=await import('node:module');return cr(import.meta.url||__filename)('onnxruntime-node')})()`
        );
        // Also prevent the onnxruntime-web fallback from firing
        onnxJs = onnxJs.replace(
          /import\s*\(\s*['"]onnxruntime-web['"]\s*\)/g,
          `Promise.reject(new Error('onnxruntime-web not available'))`
        );
        fs.writeFileSync(onnxJsPath, onnxJs, 'utf8');
        log('    → patched onnx.js: forced onnxruntime-node via createRequire');
      }
    }
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

  // @img/* — native addon packages introduced in sharp >= v0.33.
  // sharp v0.33 replaced its bundled libvips binary with scoped @img packages.
  // The top-level sharp/ requires @img/sharp-win32-x64 (or the platform equivalent)
  // to load its .node binding, and @img/colour for the colour module.
  // These live at node_modules/@img/ in the project root (npm hoists them there).
  // Without this block the top-level sharp silently fails with
  // "Cannot find module '@img/colour'" — which also crashes the kokoro daemon
  // because phobos-kokoro.mjs runs with cwd=dist/ where sharp is resolved.
  const imgAtSrc = path.join(__dirname, 'node_modules', '@img');
  if (fs.existsSync(imgAtSrc)) {
    const imgAtDest = path.join(distDir, 'node_modules', '@img');
    copyDir(imgAtSrc, imgAtDest);
    log('  ✅ @img/ (sharp v0.33+ native addon packages)');
  } else {
    log('  ⚠️  @img not found — sharp may fail to load (run npm install)');
  }

  // sharp runtime deps — staged at top-level dist/node_modules/ so sharp finds them
  // via the globalPaths banner. These are all pure JS (no .node binaries).
  // In development npm hoists them to the project root; in dist/ they must be explicit.
  //
  // Full transitive tree (verified against package-lock.json):
  //   semver        → (no deps)       sharp/lib/libvips.js: semver/functions/coerce + gte
  //   color         → color-convert, color-string
  //   color-convert → color-name
  //   color-string  → color-name, simple-swizzle
  //   simple-swizzle→ is-arrayish
  //   color-name    → (no deps)
  //   is-arrayish   → (no deps)
  //   detect-libc   → (no deps)       sharp/lib/platform.js + utility.js
  //   tunnel-agent  → safe-buffer     sharp/lib/agent.js
  //   safe-buffer   → (no deps)
  for (const depName of [
    'semver', 'color', 'color-convert', 'color-string', 'color-name',
    'simple-swizzle', 'is-arrayish',
    'detect-libc', 'tunnel-agent', 'safe-buffer',
  ]) {
    const depSrc = path.join(__dirname, 'node_modules', depName);
    if (fs.existsSync(depSrc)) {
      copyDir(depSrc, path.join(distDir, 'node_modules', depName));
      log(`  ✅ ${depName}/ (sharp dep)`);
    } else {
      log(`  ⚠️  ${depName} not found — sharp may fail to load`);
    }
  }

  // camofox-browser — headless Firefox server used by CamofoxManager.
  // Must use fs.cpSync, NOT copyDir — copyDir skips 'src' directories but
  // camofox-browser's compiled output lives at dist/src/server.js which
  // bin/camofox-browser.js requires directly. No .node binaries to worry about.
  const camofoxSrc = path.join(__dirname, 'node_modules', 'camofox-browser');
  if (fs.existsSync(camofoxSrc)) {
    const camofoxDest = path.join(distDir, 'node_modules', 'camofox-browser');
    fs.cpSync(camofoxSrc, camofoxDest, { recursive: true });
    log('  ✅ camofox-browser/');
    // camofox-browser's deps (express, camoufox-js, playwright-core and their
    // transitive trees) are hoisted by npm to the project root during development.
    // In dist the portable node binary resolves modules relative to its own
    // node_modules only — the project root hoisting is invisible to it.
    // Running npm install inside the staged package installs the full dep tree
    // locally, self-contained, with no manual enumeration required.
    // --ignore-scripts skips playwright-core's browser download hooks.
    execSync(
      'npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error',
      { cwd: camofoxDest, stdio: 'inherit' }
    );
    log('  ✅ camofox-browser/node_modules/ (deps installed)');
  } else {
    log('  ⚠️  camofox-browser not installed — run npm install');
  }

  // @imgly/background-removal-node — optional (RemoveBg node only)
  //
  // WHY WE PRE-BUNDLE instead of copyDir:
  // imgly's dist/index.cjs makes 6 external require() calls at runtime: lodash, ndarray,
  // zod, sharp, onnxruntime-node, and fs/promises. In development npm hoists all of these
  // to the project root node_modules/ so they resolve transparently. In the SEA dist only
  // onnxruntime-node and sharp are staged — lodash, ndarray, and zod are never copied,
  // causing "Cannot find module 'lodash'" on every user machine.
  //
  // Fix: use esbuild to pre-bundle imgly's dist/index.cjs + its pure-JS deps (lodash,
  // ndarray, zod) into a single self-contained imgly-bundle.cjs, keeping only
  // onnxruntime-node and sharp as externals (they have .node binaries that cannot be
  // bundled). This eliminates all dep-resolution problems for pure-JS dependencies.
  //
  // The model chunk files (resources.json + hash-named binary chunks) are copied
  // alongside the bundle so imgly finds them via the publicPath we pass at runtime.
  // VisionProcessor.ts passes publicPath: 'file:///execdir/node_modules/@imgly/.../dist/'
  // so imgly reads resources.json and chunk files from the staged dist location instead
  // of trying to fetch from its CDN (which doesn't work in the SEA context).
  //
  // onnxruntime-node (1.17.x) is still nested inside the imgly dir and CPU-patched —
  // the top-level staged 1.14.0 cannot be shared because imgly's ONNX models require
  // ops only available in 1.17.x.
  const imglySrc = path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node');
  if (fs.existsSync(imglySrc)) {
    const imglyDist = path.join(distDir, 'node_modules', '@imgly', 'background-removal-node', 'dist');
    fs.mkdirSync(imglyDist, { recursive: true });

    // ── Step 1: esbuild pre-bundle ──────────────────────────────────────────
    // Bundle imgly + lodash + ndarray + zod into one CJS file.
    // onnxruntime-node and sharp remain external (have .node binaries).
    const imglyEntry   = path.join(imglySrc, 'dist', 'index.cjs');
    const imglyBundle  = path.join(imglyDist, 'imgly-bundle.cjs');
    await esbuild({
      entryPoints: [imglyEntry],
      bundle:      true,
      platform:    'node',
      target:      'node22',
      format:      'cjs',
      outfile:     imglyBundle,
      external:    ['onnxruntime-node', 'sharp'],
      // Suppress the "use of eval" warning from imgly's zod dependency — it's harmless.
      logOverride: { 'indirect-require': 'silent' },
    });
    log('  🔧 Pre-bundled imgly + lodash + ndarray + zod → imgly-bundle.cjs');

    // ── Step 2: copy resources.json + model chunk files ────────────────────
    // resources.json maps model names to chunk hashes + offsets.
    // The hash-named files ARE the model weights — they must travel with the bundle.
    // VisionProcessor.ts sets publicPath to point here at runtime.
    const imglySrcDist = path.join(imglySrc, 'dist');
    for (const entry of fs.readdirSync(imglySrcDist)) {
      if (entry === 'index.cjs' || entry === 'index.cjs.map' ||
          entry === 'index.mjs' || entry === 'index.mjs.map') continue; // replaced by bundle
      const src = path.join(imglySrcDist, entry);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(imglyDist, entry));
      }
    }
    log('  📦 Copied resources.json + model chunks');

    // Write a minimal package.json so require('@imgly/background-removal-node')
    // resolves to our bundle via the 'main' field.
    const imglyPkgDir = path.join(distDir, 'node_modules', '@imgly', 'background-removal-node');
    fs.writeFileSync(path.join(imglyPkgDir, 'package.json'), JSON.stringify({
      name:    '@imgly/background-removal-node',
      version: '1.4.5',
      main:    'dist/imgly-bundle.cjs',
    }, null, 2));

    // ── Step 3: stage imgly's own onnxruntime-node (1.17.x) + CPU patch ───
    // imgly requires onnxruntime-node 1.17.x — its ONNX models use ops absent in 1.14.x.
    // Prefer the nested copy; fall back to the hoisted top-level if version is 1.17.x.
    // npm 7+ hoists onnxruntime-node when the top-level version matches what imgly wants.
    // Fall back to the hoisted copy only when it's 1.17.x — 1.14.0 lacks required ops.
    const imglyOnnxNested  = path.join(imglySrc, 'node_modules', 'onnxruntime-node');
    const imglyOnnxHoisted = path.join(__dirname, 'node_modules', 'onnxruntime-node');
    let imglyOnnxSrc = imglyOnnxNested;
    if (!fs.existsSync(imglyOnnxNested) && fs.existsSync(imglyOnnxHoisted)) {
      try {
        const hoistedPkg = JSON.parse(fs.readFileSync(path.join(imglyOnnxHoisted, 'package.json'), 'utf8'));
        const hoistedVer = hoistedPkg.version ?? '';
        if (hoistedVer.startsWith('1.17.')) {
          imglyOnnxSrc = imglyOnnxHoisted;
          log('  ℹ️  onnxruntime-node hoisted to top-level (v' + hoistedVer + ') — using for imgly staging');
        } else {
          imglyOnnxSrc = '';
          log('  ⚠️  imgly nested onnxruntime-node not found; hoisted copy is v' + hoistedVer + ' (need 1.17.x) — RemoveBg may fail');
        }
      } catch {
        imglyOnnxSrc = '';
      }
    }
    if (imglyOnnxSrc && fs.existsSync(imglyOnnxSrc)) {
      const onnxDest = path.join(imglyPkgDir, 'node_modules', 'onnxruntime-node');
      copyDir(imglyOnnxSrc, onnxDest);

      // Patch onnxruntime entry to force CPU execution provider.
      // onnxruntime 1.17.x tries CUDA first by default; on NVIDIA hardware this
      // crashes the SEA process before JS error handlers fire.
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
          const ortSrc = fs.readFileSync(ortIndex, 'utf8');
          if (!ortSrc.includes('SEA patch') && ortSrc.includes('InferenceSession')) {
            fs.writeFileSync(ortIndex, ortSrc + cpuPatch);
            log('  🔧 Patched ' + path.basename(ortIndex) + ' (imgly onnxruntime CPU-only)');
            break;
          }
        } catch {}
      }
    } else {
      log('  ⚠️  imgly nested onnxruntime-node not found — RemoveBg may fail at inference');
    }

    // ── Step 4: stage onnxruntime-common 1.17.x alongside onnxruntime-node ─
    // onnxruntime-node requires onnxruntime-common at runtime (dist/index.js line 1).
    // In the lock file it sits at @imgly/node_modules/onnxruntime-common — a sibling
    // to onnxruntime-node, NOT nested inside it. Node resolution walks up from
    // onnxruntime-node and finds it at the imgly node_modules level before it could
    // fall through to the top-level 1.14.0 (wrong version — would crash inference).
    const imglyOrtCommonNested  = path.join(imglySrc, 'node_modules', 'onnxruntime-common');
    const imglyOrtCommonHoisted = path.join(__dirname, 'node_modules', 'onnxruntime-common');
    const imglyOrtCommonSrc = fs.existsSync(imglyOrtCommonNested)  ? imglyOrtCommonNested
                            : fs.existsSync(imglyOrtCommonHoisted) ? imglyOrtCommonHoisted
                            : '';
    if (imglyOrtCommonSrc) {
      copyDir(imglyOrtCommonSrc, path.join(imglyPkgDir, 'node_modules', 'onnxruntime-common'));
      const ortCommonOrigin = imglyOrtCommonSrc === imglyOrtCommonNested ? 'nested' : 'hoisted';
      log('  ✅ onnxruntime-common (staged from ' + ortCommonOrigin + ')');
    } else {
      log('  ⚠️  onnxruntime-common not found (nested or hoisted) — inference may fail');
    }
  } else {
    log('  ⚠️  @imgly/background-removal-node not installed — RemoveBg node unavailable');
  }

  if (fs.existsSync(path.join(__dirname, '.env.build'))) {
    fs.copyFileSync(path.join(__dirname, '.env.build'), path.join(distDir, '.env'));
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

  // ── Portable node binary ─────────────────────────────────────────────────
  // Fetch node-{platform}-{arch}[.exe] into bin/ if missing, then it gets
  // staged alongside everything else in the bin/ loop below.
  // CamofoxManager and MeridianManager require this at runtime — process.execPath
  // in production is the SEA binary and cannot execute .js scripts.
  // ── Portable node binary ─────────────────────────────────────────────────
  // Stage node-{platform}-{arch}[.exe] from bin/ into dist/ if present.
  // On production installs, DepPrep downloads this from PHOBOS-DEPS at first boot.
  // On dev builds, place it in bin/ manually (download from PHOBOS-DEPS release)
  // or run fetch-phobos-release-deps.js to populate it.
  (function stageNodeBinary() {
    const isWin     = process.platform === 'win32';
    const nodeName  = isWin
      ? `node-${process.platform}-${process.arch}.exe`
      : `node-${process.platform}-${process.arch}`;
    const binNode   = path.join(__dirname, 'bin', nodeName);
    if (fs.existsSync(binNode)) {
      fs.copyFileSync(binNode, path.join(distDir, nodeName));
      log(`  ✅ ${nodeName} (staged from bin/)`);
    } else {
      log(`  ℹ️  ${nodeName} — not in bin/ (DepPrep will install it at first boot)`);
    }
  })();

  // llama-server + sd-cli — stage all platform binaries present in bin/ into dist/
  // Copies everything recursively: binaries, dylibs, DLLs, and subdirectories
  // (sd-cuda/, sd-vulkan/, sd-cpu/ for Windows sd-cli isolation).
  // On production installs, DepPrep downloads llama-server and sd-server at first boot.
  // In dev, populate bin/ by running: node scripts/fetch-llamacpp.js
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
    else            log('  ℹ️  bin/ is empty — llama-server and sd-server will be installed by DepPrep at first boot');
  } else {
    log('  ℹ️  bin/ missing — llama-server and sd-server will be installed by DepPrep at first boot');
  }

  // ── PyTorch script + bundled model configs ─────────────────────────────────
  // Python scripts spawned by PHOBOS managers.
  // phobos-diffusers.py — ImageServerManager (PyTorch image generation)
  // phobos-lm-trainer.py — CartridgeTrainer (LLM LoRA training)
  // _torchcodec.py — PythonEnvManager patches torchaudio with this after install
  // unsloth_zoo_utils.py — PythonEnvManager copies this into unsloth_zoo on ROCm after install
  // unsloth_zoo_device_type.py — PythonEnvManager copies this into unsloth_zoo on ROCm after install
  const pyScripts = [
    ['phobos-diffusers.py', 'phobos-diffusers.py', 'PyTorch generation script'],
    ['phobos-lm-trainer.py', 'phobos-lm-trainer.py', 'LLM LoRA training script'],
    ['_torchcodec.py', '_torchcodec.py', 'torchaudio soundfile fallback patch'],
    ['unsloth_zoo_utils.py', 'unsloth_zoo_utils.py', 'unsloth_zoo ROCm torch.distributed patch'],
    ['phobos_rocm_patch.py', 'phobos_rocm_patch.py', 'ROCm Windows unsloth device_type startup patch'],
    ['nf4tensor.py', 'nf4tensor.py', 'torchao NF4 distributed op stub for ROCm Windows'],
    ['unsloth_zoo_temporary_patches_utils.py', 'unsloth_zoo_temporary_patches_utils.py', 'unsloth_zoo temporary_patches/utils.py ROCm Windows _distributed_c10d patch'],
    ['torchao_float8_distributed_utils.py', 'torchao_float8_distributed_utils.py', 'torchao float8/distributed_utils.py ROCm Windows distributed import guard'],
    ['torch_distributed_c10d.py', 'torch_distributed_c10d.py', 'torch distributed/distributed_c10d.py ROCm Windows _distributed_c10d stub'],
    ['torch_distributed_constants.py', 'torch_distributed_constants.py', 'torch distributed/constants.py ROCm Windows _distributed_c10d stub'],
  ];
  for (const [src, dst, label] of pyScripts) {
    const pyScript = path.join(__dirname, 'phobos', src);
    if (fs.existsSync(pyScript)) {
      fs.copyFileSync(pyScript, path.join(distDir, dst));
      log(`  ✅ ${dst} (${label})`);
    }
  }

  // ── phobos-kokoro.mjs — Kokoro TTS subprocess script ─────────────────────
  // Spawned by AudioServerManager as a standalone Node process (not in-process).
  // Running as a subprocess with the correct cwd means kokoro-js and
  // @huggingface/transformers resolve via node_modules without any SEA issues.
  const kokoroScriptSrc = path.join(__dirname, 'phobos', 'phobos-kokoro.mjs');
  if (fs.existsSync(kokoroScriptSrc)) {
    fs.copyFileSync(kokoroScriptSrc, path.join(distDir, 'phobos-kokoro.mjs'));
    log('  ✅ phobos-kokoro.mjs (Kokoro TTS subprocess script)');
  } else {
    log('  ⚠️  phobos-kokoro.mjs not found — Kokoro TTS will be unavailable');
  }

  // ── kokoro-js + @huggingface/transformers — staged to dist/node_modules/ ──
  //
  // These are pure-JS ESM packages (no .node binaries) so they can be staged
  // directly. phobos-kokoro.mjs is spawned with cwd=dist/ so Node resolves
  // bare specifiers against dist/node_modules/.
  //
  // @huggingface/transformers v3 ships its own onnxruntime-node@1.21.x, which
  // is a different version from the top-level 1.17.x staged for VisionProcessor.
  // We nest it inside @huggingface/transformers/node_modules/ so the two copies
  // coexist without version conflicts — exactly the same pattern used for imgly.
  const kokoroJsSrc = path.join(__dirname, 'node_modules', 'kokoro-js');
  if (fs.existsSync(kokoroJsSrc)) {
    const kokoroJsDest = path.join(distDir, 'node_modules', 'kokoro-js');
    copyDir(kokoroJsSrc, kokoroJsDest);
    log('  ✅ kokoro-js/');
  } else {
    log('  ⚠️  kokoro-js not installed — run npm install');
  }

  const hfTransformersSrc = path.join(__dirname, 'node_modules', '@huggingface', 'transformers');
  if (fs.existsSync(hfTransformersSrc)) {
    const hfDest = path.join(distDir, 'node_modules', '@huggingface', 'transformers');
    copyDir(hfTransformersSrc, hfDest);
    log('  ✅ @huggingface/transformers/');

    // Nest @huggingface/transformers own onnxruntime-node (1.21.x) inside it so
    // it doesn't collide with the top-level 1.17.x staged for VisionProcessor.
    // Check nested first (npm may have deduplicated it to top-level if versions match).
    const hfOnnxNested  = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node');
    const hfOnnxHoisted = path.join(__dirname, 'node_modules', 'onnxruntime-node');
    const hfOnnxSrc = fs.existsSync(hfOnnxNested) ? hfOnnxNested : null;
    // Only use the hoisted copy if it's 1.21.x — don't let 1.17.x stand in for it
    const resolvedHfOnnxSrc = hfOnnxSrc ?? (() => {
      if (!fs.existsSync(hfOnnxHoisted)) return null;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(hfOnnxHoisted, 'package.json'), 'utf8')).version ?? '';
        return v.startsWith('1.21.') ? hfOnnxHoisted : null;
      } catch { return null; }
    })();

    if (resolvedHfOnnxSrc) {
      copyDir(resolvedHfOnnxSrc, path.join(hfDest, 'node_modules', 'onnxruntime-node'));
      log('  ✅ @huggingface/transformers/node_modules/onnxruntime-node (nested)');
    } else {
      log('  ⚠️  @huggingface/transformers onnxruntime-node not found — Kokoro TTS may fail at inference');
    }
  } else {
    log('  ⚠️  @huggingface/transformers not installed — run npm install');
  }
  // Shared recursive directory copy -- used for configs/ and phobos/skills/
  const copyDirRec = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      e.isDirectory() ? copyDirRec(s, d) : fs.copyFileSync(s, d);
    }
  };

  const configsDir = path.join(__dirname, 'phobos', 'configs');
  if (fs.existsSync(configsDir)) {
    copyDirRec(configsDir, path.join(distDir, 'configs'));
    log('  ✅ configs/ (bundled model configs for PyTorch)');
  }

  // ── SYBIL model ─────────────────────────────────────────────────────────────
  // Installed by DepPrep at first boot from PHOBOS-DEPS — not bundled in dist/.
  log('  ℹ️  SYBIL model — installed by DepPrep at first boot (not bundled)');

  // ── DuckDB VSS extension ─────────────────────────────────────────────────────
  // Installed by DepPrep at first boot from PHOBOS-DEPS — not bundled in dist/.
  log('  ℹ️  DuckDB VSS extension — installed by DepPrep at first boot (not bundled)');

  // phobos/skills/ must ship alongside the exe so SkillManager can find it at
  // runtime via process.execPath. The directory structure is preserved exactly:
  //   dist/phobos/skills/_registry.json
  //   dist/phobos/skills/core/<id>/manifest.json + instruction_manual.md
  //   dist/phobos/skills/tools/prime/<id>/...
  //   dist/phobos/skills/tools/reserve/<id>/...
  const skillsSrc = path.join(__dirname, 'phobos', 'skills');
  if (fs.existsSync(skillsSrc)) {
    const skillsDst = path.join(distDir, 'phobos', 'skills');
    copyDirRec(skillsSrc, skillsDst);
    // Count staged skill manifests for confirmation
    let skillCount = 0;
    const countManifests = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) countManifests(path.join(dir, e.name));
        else if (e.name === 'manifest.json') skillCount++;
      }
    };
    countManifests(skillsDst);
    log(`  ✅ phobos/skills/ (${skillCount} skills staged → dist/phobos/skills/)`);
  } else {
    log('  ⚠️  phobos/skills/ missing — skills will not load on client machines');
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