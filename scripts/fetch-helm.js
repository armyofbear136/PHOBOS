#!/usr/bin/env node
// scripts/fetch-helm.js — Download the Helm synth and extract the VST3 plugin.
//
// Helm is a free polyphonic synthesizer (GPLv3) by Matt Tytel. In the PHOBOS
// DAW stack, Carla loads Helm.vst3 as plugin index 0 in the default rack.
// The goal of this script is: `Helm.vst3` on disk at
// `~/.phobos/services/helm/Helm.vst3` so Carla's VST3 scan finds it.
//
// tytel.org ships platform-specific installers, not portable archives:
//
//   Windows 64:  Helm_64bit_v0_9_0_r.msi     — Microsoft Installer package
//   Windows 32:  Helm_32bit_v0_9_0_r.msi
//   macOS:       Helm_v0_9_0_r.pkg           — Apple installer package
//   Linux 64:    helm_0.9.0_amd64_r.deb      — Debian package
//   Linux 32:    helm_0.9.0_i386_r.deb
//
// We extract them WITHOUT installing system-wide:
//   • Windows: `msiexec /a <msi> /qn TARGETDIR=<scratch>` — administrative
//     install; writes files to a target dir, no registry changes, no admin.
//   • macOS: `pkgutil --expand-full <pkg> <scratch>` — unpacks payload.
//   • Linux: `dpkg-deb -x <deb> <scratch>` — extracts data.tar content.
//
// URLs verified 2026-04 against https://tytel.org/helm/downloads .

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import { execFile, exec } from 'node:child_process';
import { promisify }      from 'node:util';
import { fileURLToPath }  from 'node:url';

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));

const HELM_BASE = 'https://tytel.org/static/dist';

const PLATFORM_ASSETS = {
  'win32-x64':    { file: 'Helm_64bit_v0_9_0_r.msi', method: 'msi', minBytes: 4_000_000 },
  'win32-ia32':   { file: 'Helm_32bit_v0_9_0_r.msi', method: 'msi', minBytes: 4_000_000 },
  'darwin-x64':   { file: 'Helm_v0_9_0_r.pkg',       method: 'pkg', minBytes: 4_000_000 },
  'darwin-arm64': { file: 'Helm_v0_9_0_r.pkg',       method: 'pkg', minBytes: 4_000_000 },
  'linux-x64':    { file: 'helm_0.9.0_amd64_r.deb',  method: 'deb', minBytes: 2_000_000 },
  'linux-ia32':   { file: 'helm_0.9.0_i386_r.deb',   method: 'deb', minBytes: 2_000_000 },
  'linux-arm64':  { file: 'helm_0.9.0_amd64_r.deb',  method: 'deb', minBytes: 2_000_000 },
};

const DEST_DIR = path.join(os.homedir(), '.phobos', 'services', 'helm');
const TMP_DIR  = path.join(DEST_DIR, '.tmp');

function detectPlatformKey() {
  return process.env.PHOBOS_OVERRIDE_PLATFORM ?? `${process.platform}-${process.arch}`;
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-helm/1.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            follow(res.headers.location, hops + 1);
            return;
          }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function download(url, destPath) {
  const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) console.log(`\n📥 Resuming Helm from ${(existing / 1e6).toFixed(1)} MB…`);
  else              console.log(`\n📥 Downloading Helm…\n   ${url}`);

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — ${url}\n   The Helm version pinned in this script may have been moved. Check https://tytel.org/helm/downloads`);
  if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);

  const contentLen = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes = res.statusCode === 206 ? existing + contentLen : contentLen;

  await new Promise((resolve, reject) => {
    const tmpPath = destPath + '.download';
    const fd      = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received  = existing;
    res.on('data', chunk => {
      received += chunk.length;
      if (totalBytes > 0) {
        const pct = (received / totalBytes * 100).toFixed(1);
        process.stdout.write(`\r   ${pct}%  (${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
      }
    });
    res.pipe(fd);
    fd.on('finish', () => {
      fd.close();
      fs.renameSync(tmpPath, destPath);
      process.stdout.write('\n');
      resolve();
    });
    fd.on('error', reject);
  });
}

/**
 * Windows: administrative install of the MSI.
 * msiexec /a <msi> /qn TARGETDIR=<abs path>  — extracts all files to
 * TARGETDIR without running the full install sequence or writing registry
 * keys. /qn runs fully quiet (no UI). Requires NO admin rights.
 *
 * Note: TARGETDIR MUST be an absolute path, and msiexec dislikes trailing
 * backslashes. We normalize both.
 */
async function extractMsi(msiPath, outDir) {
  if (process.platform !== 'win32') {
    throw new Error('extractMsi only runs on Windows');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const abs = path.resolve(outDir).replace(/[\\/]+$/, '');
  const cmd = `msiexec /a "${msiPath}" /qn TARGETDIR="${abs}"`;
  await execAsync(cmd);
}

/**
 * macOS: expand the flat pkg into its components.
 * pkgutil --expand-full produces a directory tree with the payload already
 * unpacked. The .vst3 bundle lives somewhere under the resulting tree.
 */
async function extractPkg(pkgPath, outDir) {
  // pkgutil refuses to write to an existing directory, so expand to a
  // sibling and move/merge.
  const expandTarget = outDir + '.expanded';
  try { fs.rmSync(expandTarget, { recursive: true, force: true }); } catch {}
  await execFileAsync('pkgutil', ['--expand-full', pkgPath, expandTarget]);
  fs.mkdirSync(outDir, { recursive: true });
  await execAsync(`cp -R "${expandTarget}/"* "${outDir}/"`);
  try { fs.rmSync(expandTarget, { recursive: true, force: true }); } catch {}
}

/**
 * Linux: extract the data portion of the .deb.
 * dpkg-deb -x unpacks just the data tree (skipping control metadata). The
 * VST3 plugin lands at usr/lib/vst3/Helm.vst3 inside the output directory.
 */
async function extractDeb(debPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync('dpkg-deb', ['-x', debPath, outDir]);
}

/**
 * Walk the extracted tree looking for the best Helm plugin available.
 * Preference order (each stops at first match):
 *   1. Helm.vst3 / helm.vst3 / helm64.vst3 — VST3, preferred format
 *   2. helm64.dll / Helm.dll — VST2 DLL fallback (Windows only)
 *
 * Helm 0.9.0's Windows installer names files lowercase: helm.vst3 (32-bit),
 * helm64.vst3 (64-bit), helm64.dll (VST2 64-bit). On win32-x64 we prefer
 * the 64-bit builds.
 */
function findPlugin(rootDir, preferArch64) {
  const matches = {
    vst3_64: null,
    vst3_32: null,
    vst3_any: null,
    vst2_64: null,
    vst2_32: null,
  };

  const queue = [rootDir];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full  = path.join(dir, ent.name);
      const lower = ent.name.toLowerCase();

      // VST3 — either a directory bundle or a single file with .vst3 extension
      if (lower.endsWith('.vst3') && (lower.startsWith('helm') || lower === 'helm.vst3')) {
        if (lower.includes('64'))      matches.vst3_64 ??= full;
        else if (lower.includes('32')) matches.vst3_32 ??= full;
        else                           matches.vst3_any ??= full;
      }
      // VST2 DLL
      else if (ent.isFile() && lower.endsWith('.dll') && lower.startsWith('helm')) {
        if (lower.includes('64'))      matches.vst2_64 ??= full;
        else if (!lower.includes('32')) matches.vst2_32 ??= full;  // plain helm.dll
      }

      if (ent.isDirectory() && !lower.endsWith('.vst3')) queue.push(full);
    }
  }

  const preferred = preferArch64
    ? [matches.vst3_64, matches.vst3_any, matches.vst3_32, matches.vst2_64, matches.vst2_32]
    : [matches.vst3_32, matches.vst3_any, matches.vst3_64, matches.vst2_32, matches.vst2_64];

  return preferred.find(p => p != null) ?? null;
}

async function main() {
  const platformKey = detectPlatformKey();
  const asset       = PLATFORM_ASSETS[platformKey];
  if (!asset) throw new Error(`No Helm asset configured for platform ${platformKey}`);

  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR,  { recursive: true });

  // Skip if a Helm plugin is already in place.
  const preferArch64 = platformKey.endsWith('-x64') || platformKey.endsWith('-arm64');
  const existing = findPlugin(DEST_DIR, preferArch64);
  if (existing) {
    console.log(`✅ Helm plugin already installed at ${existing}`);
    return;
  }

  const archivePath = path.join(TMP_DIR, asset.file);
  const url         = `${HELM_BASE}/${asset.file}`;

  if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size < asset.minBytes) {
    await download(url, archivePath);
  } else {
    console.log(`✔ Archive already present at ${archivePath}`);
  }

  if (fs.statSync(archivePath).size < asset.minBytes) {
    throw new Error(`Downloaded archive below minimum size (${fs.statSync(archivePath).size} < ${asset.minBytes}). Corrupt download.`);
  }

  console.log(`\n📦 Extracting Helm…`);
  // Extract into a method-specific subdir so findPlugin has a single root.
  const extractDir = path.join(DEST_DIR, '.extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  if      (asset.method === 'msi') await extractMsi(archivePath, extractDir);
  else if (asset.method === 'pkg') await extractPkg(archivePath, extractDir);
  else if (asset.method === 'deb') await extractDeb(archivePath, extractDir);
  else throw new Error(`Unknown extract method: ${asset.method}`);

  const pluginPath = findPlugin(extractDir, preferArch64);
  if (!pluginPath) {
    throw new Error(`Could not locate a Helm plugin (.vst3 or .dll) after extracting ${asset.file} into ${extractDir}.\n   The installer layout may have changed. Inspect the extracted tree manually.`);
  }

  // Copy to the canonical location. Preserve the original basename so
  // CarlaManager can look for either Helm.vst3 or helm64.dll.
  const ext = path.extname(pluginPath);  // '.vst3' or '.dll'
  // Normalize to Helm<ext> at the top of the service dir — Carla's plugin
  // scan will pick it up there regardless of the original casing.
  const finalName = `Helm${ext}`;
  const finalPath = path.join(DEST_DIR, finalName);
  try { fs.rmSync(finalPath, { recursive: true, force: true }); } catch {}

  if (fs.statSync(pluginPath).isDirectory()) {
    // macOS/Linux: .vst3 is a bundle directory
    await execAsync(`${process.platform === 'win32' ? 'xcopy /E /I /Y' : 'cp -R'} "${pluginPath}" "${finalPath}"`);
  } else {
    // Windows: .vst3 is a single DLL file (or VST2 .dll)
    fs.copyFileSync(pluginPath, finalPath);
  }

  // Also stage into Carla's plugins scan directory at
  // ~/.phobos/services/carla/plugins/<finalName>. CarlaManager configures
  // Carla to scan this path at startup, so dropping a copy here is what
  // makes plugin index 0 = Helm work in the default phobos-rack.carxp.
  const carlaPluginsDir = path.join(os.homedir(), '.phobos', 'services', 'carla', 'plugins');
  fs.mkdirSync(carlaPluginsDir, { recursive: true });
  const carlaStagedPath = path.join(carlaPluginsDir, finalName);
  try { fs.rmSync(carlaStagedPath, { recursive: true, force: true }); } catch {}

  if (fs.statSync(pluginPath).isDirectory()) {
    await execAsync(`${process.platform === 'win32' ? 'xcopy /E /I /Y' : 'cp -R'} "${pluginPath}" "${carlaStagedPath}"`);
  } else {
    fs.copyFileSync(pluginPath, carlaStagedPath);
  }

  // Clean up the downloaded archive; extracted tree stays for post-install.
  try { fs.unlinkSync(archivePath); } catch { /* non-fatal */ }

  console.log(`\n✅ Helm installed.\n   Plugin:     ${finalPath}\n   Carla-scan: ${carlaStagedPath}\n   Source:     ${pluginPath}`);
}

main().catch(err => { console.error(`\n❌ fetch-helm failed: ${err.message}`); process.exit(1); });
