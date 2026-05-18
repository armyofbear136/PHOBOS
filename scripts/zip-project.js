#!/usr/bin/env node
// scripts/zip-project.js — Zip the phobos-core project directory
//
// Output: ../phobos-core.zip (sibling of the project root)
// Excludes build artifacts, generated dirs, and large asset folders.
//
// Usage:
//   node scripts/zip-project.js

import fs                from 'node:fs';
import path              from 'node:path';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT       = path.resolve(ROOT, '..', 'phobos-core.zip');

// ── Excluded paths (relative to project root, matched as prefixes) ─────────────
const EXCLUDED = [
  'app/dist',
  'app/dist-electron',
  'app/electron-dist',
  'app/node_modules',
  'app/public/game/Aseprite Files',
  'app/public/game/Atlas',
  'app/public/game/Decorations_tiles',
  'app/public/game/sprites',
  'app/public/game/Tiles',
  'app/public/pandoc/pandoc.wasm',
  '.git',
  'bin',
  'bin-master',
  'dist',
  'dist-all',
  'dist-deps-backup',
  'dist-lite',
  'node_modules',
  'test-outputs',
  'unsloth_compiled_cache',
];

// Normalise to forward-slash for consistent matching across platforms
const EXCLUDED_NORM = EXCLUDED.map(e => e.split(path.sep).join('/'));

function isExcluded(relPath) {
  const norm = relPath.split(path.sep).join('/');
  return EXCLUDED_NORM.some(ex => norm === ex || norm.startsWith(ex + '/'));
}

// ── Collect all files to zip ──────────────────────────────────────────────────
function collect(dir, base = '') {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const rel  = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    if (isExcluded(rel)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      entries.push(...collect(full, rel));
    } else {
      entries.push(rel);
    }
  }
  return entries;
}

console.log('📦 Collecting files...');
const files = collect(ROOT);
console.log(`   ${files.length} files to include`);

// ── Remove old zip ────────────────────────────────────────────────────────────
if (fs.existsSync(OUT)) {
  fs.unlinkSync(OUT);
  console.log('   Removed existing phobos-core.zip');
}

// ── Write file list to a temp file and pass to zip ───────────────────────────
// Using a list file avoids shell command-length limits on large projects.
const listFile = path.join(ROOT, '.zip-filelist.tmp');
fs.writeFileSync(listFile, files.join('\n'), 'utf8');

try {
  const isWin = process.platform === 'win32';

  if (isWin) {
    // PowerShell's Compress-Archive supports reading a list via pipeline
    // but has a 32K arg limit; easier to invoke 7-Zip if available, else
    // fall back to a pure-JS approach using the built-in PowerShell cmdlet
    // called per-file (slow but universally available).
    //
    // Preferred: 7-Zip (7z.exe) — fast, handles Unicode paths, respects list files
    let sevenZip = null;
    for (const candidate of [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    ]) {
      if (fs.existsSync(candidate)) { sevenZip = candidate; break; }
    }

    if (sevenZip) {
      console.log('🗜️  Zipping via 7-Zip...');
      execSync(
        `"${sevenZip}" a -tzip -mx=5 "${OUT}" @"${listFile}"`,
        { stdio: 'inherit', cwd: ROOT }
      );
    } else {
      // Fallback: PowerShell Compress-Archive
      // Reads the list file and adds files in batches to avoid arg-length limits.
      console.log('🗜️  Zipping via PowerShell (7-Zip not found — install it for faster zips)...');
      const batches = [];
      for (let i = 0; i < files.length; i += 200) {
        batches.push(files.slice(i, i + 200));
      }
      let first = true;
      for (const batch of batches) {
        const quoted = batch.map(f => `'${f.replace(/'/g, "''")}'`).join(',');
        const update = first ? '' : ' -Update';
        execSync(
          `powershell -NoProfile -Command "Compress-Archive -Path ${quoted} -DestinationPath '${OUT}'${update}"`,
          { stdio: 'inherit', cwd: ROOT }
        );
        first = false;
      }
    }
  } else {
    // macOS / Linux — zip is always available
    console.log('🗜️  Zipping via zip...');
    execSync(
      `zip -r "${OUT}" . --names-stdin < "${listFile}"`,
      { stdio: 'inherit', cwd: ROOT, shell: '/bin/sh' }
    );
  }

  const sizeMB = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`\n✅ Created: ../phobos-core.zip  (${sizeMB} MB)`);
} finally {
  if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
}
