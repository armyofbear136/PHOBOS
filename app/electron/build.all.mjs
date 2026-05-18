// electron/build.all.mjs — trigger a multi-platform electron build via GitHub Actions
//
// Usage:
//   npm run electron:build:all                  <- trigger and stream live logs, download on complete
//   npm run electron:build:all -- --no-wait     <- trigger and exit immediately
//   npm run electron:build:all -- --version 1.2.1  <- pass version explicitly (default: reads version.ts)
//
// Requires: gh CLI (https://cli.github.com) installed and authenticated.
//   winget install GitHub.cli   /   brew install gh   /   apt install gh
//   gh auth login

import { execSync } from 'node:child_process';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const args      = process.argv.slice(2);
const noWait    = args.includes('--no-wait');
const versionArg = args.find(a => a.startsWith('--version='))?.split('=')[1]
                ?? args[args.indexOf('--version') + 1];

// ── helpers ───────────────────────────────────────────────────────────────────
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });

const capture = (cmd) =>
  execSync(cmd, { encoding: 'utf8', cwd: ROOT }).trim();

const ghAvailable = () => {
  try { capture('gh --version'); return true; } catch { return false; }
};

// ── version ───────────────────────────────────────────────────────────────────
function readVersion() {
  if (versionArg) return versionArg;
  const src = fs.readFileSync(path.join(ROOT, 'src', 'version.ts'), 'utf8');
  const m   = src.match(/CLIENT_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('Could not read CLIENT_VERSION from src/version.ts');
  return m[1];
}

// ── main ─────────────────────────────────────────────────────────────────────
if (!ghAvailable()) {
  console.error('❌ gh CLI not found.');
  console.error('   Install: winget install GitHub.cli  then: gh auth login');
  process.exit(1);
}

const version = readVersion();
const branch  = capture('git rev-parse --abbrev-ref HEAD');

console.log(`🚀 Triggering electron build v${version} on branch: ${branch}`);
run(`gh workflow run build-electron.yml --ref ${branch} --field version=${version}`);

if (noWait) {
  console.log('✅ Workflow triggered. Monitor at:');
  console.log('   gh run list --workflow=build-electron.yml');
  process.exit(0);
}

// Wait for the run to register, then watch it
console.log('⏳ Waiting for run to start...');
await new Promise(r => setTimeout(r, 4000));

const runId = capture('gh run list --workflow=build-electron.yml --limit=1 --json databaseId --jq ".[0].databaseId"');
console.log(`📋 Run ID: ${runId}`);
console.log('   Streaming logs (Ctrl+C to detach — build continues on GitHub)...\n');

run(`gh run watch ${runId}`);

// Check conclusion
const conclusion = capture(`gh run view ${runId} --json conclusion --jq ".conclusion"`);
if (conclusion !== 'success') {
  console.error(`❌ Build failed (conclusion: ${conclusion})`);
  console.error(`   Details: gh run view ${runId} --log-failed`);
  process.exit(1);
}

// Download artifacts into electron-dist-all/
console.log('\n📥 Downloading artifacts...');
const outDir = path.join(ROOT, 'electron-dist-all');
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir);

run(`gh run download ${runId} --dir ${outDir}`);

// Flatten — gh download nests each artifact in its own subdirectory
const flatDir = path.join(outDir, 'flat');
fs.mkdirSync(flatDir, { recursive: true });
for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'flat') continue;
  const subDir = path.join(outDir, entry.name);
  for (const file of fs.readdirSync(subDir)) {
    const src  = path.join(subDir, file);
    const dest = path.join(flatDir, file);
    fs.renameSync(src, dest);
  }
  fs.rmdirSync(subDir);
}

console.log(`\n✅ All platforms built — v${version}`);
console.log(`   Artifacts in: electron-dist-all/flat/`);
for (const file of fs.readdirSync(flatDir)) {
  const size = (fs.statSync(path.join(flatDir, file)).size / 1024 / 1024).toFixed(1);
  console.log(`     ${file}  (${size} MB)`);
}
