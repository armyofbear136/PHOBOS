/**
 * ClamAvManager.ts — portable ClamAV binary fetch, definition management, and scan execution.
 *
 * Binary paths: ~/.phobos/tools/clamav/bin/{clamscan,freshclam}[.exe]
 * Definitions:  ~/.phobos/tools/clamav/db/
 * Config:       ~/.phobos/tools/clamav/freshclam.conf (generated on first use)
 *
 * No installer, no PATH dependency. The binary is fetched from GitHub releases
 * via POST /api/security/tools/clamav/fetch. Until then, malware_scan degrades
 * gracefully to tool_missing — all six other scanners remain fully functional.
 */

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify }  from 'node:util';
import * as fs        from 'node:fs';
import * as path      from 'node:path';
import * as os        from 'node:os';
import * as stream    from 'node:stream';
import { pipeline }   from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { SecurityStore, type SecurityFinding } from '../db/SecurityStore.js';
import { engineStream } from '../ai/clients.js';

const execFile = promisify(execFileCb);

// ── Constants ─────────────────────────────────────────────────────────────────

const IS_WIN             = process.platform === 'win32';
const DIGEST_TIMEOUT_MS  = 60_000;
const RAW_OUTPUT_CAP     = 64 * 1024;
const DIGEST_INPUT_CAP   = 4_000;
const SCAN_TIMEOUT_MS    = 10 * 60_000;   // 10 minutes
const FRESHCLAM_TIMEOUT  = 10 * 60_000;   // 10 minutes
const STALE_DAYS         = 7;
const GITHUB_API         = 'https://api.github.com/repos/Cisco-Talos/clamav/releases/latest';

// ── Paths ─────────────────────────────────────────────────────────────────────

function clamavRoot(): string {
  const base = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
  return path.join(base, 'tools', 'clamav');
}

function binDir(): string  { return path.join(clamavRoot(), 'bin'); }
function dbDir():  string  { return path.join(clamavRoot(), 'db');  }
function confPath(): string { return path.join(clamavRoot(), 'freshclam.conf'); }

function clamscanBin(): string {
  return path.join(binDir(), IS_WIN ? 'clamscan.exe' : 'clamscan');
}

function freshclamBin(): string {
  return path.join(binDir(), IS_WIN ? 'freshclam.exe' : 'freshclam');
}

// ── Binary detection ──────────────────────────────────────────────────────────

export function clamavBinaryPath(): string | null {
  const bin = clamscanBin();
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

// ── Definition age ────────────────────────────────────────────────────────────

export function definitionAge(): { ageMs: number; stale: boolean } | null {
  // daily.cld is updated more frequently than main.cvd — use it for freshness
  const daily = path.join(dbDir(), 'daily.cld');
  const main  = path.join(dbDir(), 'main.cvd');
  const candidate = fs.existsSync(daily) ? daily : fs.existsSync(main) ? main : null;
  if (!candidate) return null;

  try {
    const { mtimeMs } = fs.statSync(candidate);
    const ageMs       = Date.now() - mtimeMs;
    return { ageMs, stale: ageMs > STALE_DAYS * 24 * 60 * 60_000 };
  } catch {
    return null;
  }
}

// ── Fetch progress singleton ──────────────────────────────────────────────────

export interface FetchProgress {
  phase:    'idle' | 'resolving' | 'downloading' | 'extracting' | 'updating-defs' | 'done' | 'error';
  message:  string;
  bytesDownloaded: number;
  totalBytes:      number;
}

const _progress: FetchProgress = {
  phase: 'idle', message: '', bytesDownloaded: 0, totalBytes: 0,
};

export function getFetchProgress(): FetchProgress {
  return { ..._progress };
}

function setProgress(update: Partial<FetchProgress>): void {
  Object.assign(_progress, update);
}

// ── GitHub release resolution ─────────────────────────────────────────────────

interface GithubRelease {
  tag_name: string;
  assets:   Array<{ name: string; browser_download_url: string }>;
}

function selectAsset(assets: GithubRelease['assets']): { name: string; url: string } | null {
  const platform = process.platform;
  const arch     = process.arch;

  let pattern: RegExp;
  if (platform === 'win32') {
    pattern = /clamav-[\d.]+\.win\.x64\.zip$/i;
  } else if (platform === 'darwin' && arch === 'arm64') {
    pattern = /clamav-[\d.]+\.macos\.arm64\.tar\.gz$/i;
  } else if (platform === 'darwin') {
    pattern = /clamav-[\d.]+\.macos\.x86_64\.tar\.gz$/i;
  } else {
    // Linux — default x86_64
    pattern = /clamav-[\d.]+\.linux\.x86_64\.tar\.gz$/i;
  }

  const asset = assets.find(a => pattern.test(a.name));
  return asset ? { name: asset.name, url: asset.browser_download_url } : null;
}

// ── Download helper ───────────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'PHOBOS-Security/2.0' },
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed: HTTP ${resp.status} for ${url}`);
  }

  const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10);
  setProgress({ totalBytes: contentLength || 0 });

  const out      = createWriteStream(dest);
  let downloaded = 0;

  const reader = resp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(value);
      downloaded += value.byteLength;
      setProgress({ bytesDownloaded: downloaded });
    }
  } finally {
    reader.releaseLock();
  }

  await new Promise<void>((resolve, reject) => out.end((err: Error | null) => err ? reject(err) : resolve()));
}

// ── Extract helpers ───────────────────────────────────────────────────────────

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await execFile('tar', ['-xzf', archivePath, '-C', destDir, '--strip-components=1'], {
    timeout: 60_000,
  });
}

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  // Use PowerShell on Windows — no unzip binary needed
  fs.mkdirSync(destDir, { recursive: true });
  await execFile('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
  ], { timeout: 60_000 });
}

// ── freshclam.conf generation ─────────────────────────────────────────────────

function ensureFreshclamConf(): void {
  const conf = confPath();
  if (fs.existsSync(conf)) return;

  const lines = [
    `DatabaseDirectory ${dbDir()}`,
    'DatabaseMirror database.clamav.net',
    IS_WIN ? 'UpdateLogFile nul' : 'UpdateLogFile /dev/null',
    'LogVerbose false',
    'MaxAttempts 3',
    'ConnectTimeout 30',
    'ReceiveTimeout 60',
  ];

  fs.mkdirSync(path.dirname(conf), { recursive: true });
  fs.writeFileSync(conf, lines.join('\n') + '\n', 'utf-8');
}

// ── Public: fetch binary + definitions ───────────────────────────────────────

export async function fetchClamAv(): Promise<void> {
  setProgress({ phase: 'resolving', message: 'Resolving latest ClamAV release…', bytesDownloaded: 0, totalBytes: 0 });

  // Clear any previous partial install so stale DLLs or a bad freshclam.conf
  // from a prior attempt don't interfere.
  try {
    const binD = binDir();
    if (fs.existsSync(binD)) fs.rmSync(binD, { recursive: true, force: true });
    const conf = confPath();
    if (fs.existsSync(conf)) fs.unlinkSync(conf);
  } catch { /* non-fatal */ }

  // 1. Resolve latest release
  const relResp = await fetch(GITHUB_API, {
    headers: { 'User-Agent': 'PHOBOS-Security/2.0', 'Accept': 'application/vnd.github+json' },
  });
  if (!relResp.ok) throw new Error(`GitHub API returned HTTP ${relResp.status}`);
  const release = await relResp.json() as GithubRelease;

  const asset = selectAsset(release.assets);
  if (!asset) {
    throw new Error(`No ClamAV asset found for ${process.platform}/${process.arch}`);
  }

  setProgress({ phase: 'downloading', message: `Downloading ${asset.name}…` });

  // 2. Download archive to temp
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'clamav-'));
  const archive = path.join(tmpDir, asset.name);
  await downloadFile(asset.url, archive);

  setProgress({ phase: 'extracting', message: 'Extracting…' });

  // 3. Extract to bin/
  const extractDest = path.join(tmpDir, 'extracted');
  if (IS_WIN) {
    await extractZip(archive, extractDest);
  } else {
    await extractTarGz(archive, extractDest);
  }

  // 4. Copy binaries to ~/.phobos/tools/clamav/bin/
  const binDest = binDir();
  fs.mkdirSync(binDest, { recursive: true });
  fs.mkdirSync(dbDir(),  { recursive: true });

  if (IS_WIN) {
    // On Windows, copy everything from the extracted directory's bin/ or root —
    // ClamAV ships with VC++ runtime DLLs (vcruntime140.dll, msvcp140.dll, etc.)
    // that must travel alongside the executables. Hardcoding names risks missing one.
    // PowerShell Expand-Archive preserves the top-level folder from the zip
    // (e.g. clamav-1.5.2.win.x64/). Find that single subdirectory and use it
    // as the source root — everything (exe, dll, certs/) lives flat inside it.
    const topLevelEntries = fs.readdirSync(extractDest, { withFileTypes: true })
      .filter(e => e.isDirectory());
    const sourceRoot = topLevelEntries.length === 1
      ? path.join(extractDest, topLevelEntries[0].name)
      : extractDest;
    console.log('[ClamAV extract] sourceRoot:', sourceRoot);

    let copiedCount = 0;

    // Copy all files (exe, dll) from the source root
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.exe' || ext === '.dll') {
        fs.copyFileSync(path.join(sourceRoot, entry.name), path.join(binDest, entry.name));
        copiedCount++;
      }
    }
    // Copy subdirectories (certs/, etc.) — ClamAV requires certs/ for signature verification
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      copyDirRecursive(path.join(sourceRoot, entry.name), path.join(binDest, entry.name));
    }
    if (copiedCount === 0) {
      // bin/ subdir had nothing — walk the entire extracted tree as fallback
      for (const src of findAllFiles(extractDest, ['.exe', '.dll'])) {
        fs.copyFileSync(src, path.join(binDest, path.basename(src)));
        copiedCount++;
      }
    }
    if (!fs.existsSync(path.join(binDest, 'freshclam.exe'))) {
      // List the archive structure in the error so we can diagnose the layout
      const listing = findAllFiles(extractDest, ['.exe', '.dll']).join('\n') || '(none found)';
      throw new Error(`freshclam.exe not found after extraction.\nFiles found:\n${listing}`);
    }
  } else {
    for (const bin of ['clamscan', 'freshclam']) {
      const found = findFile(extractDest, bin);
      if (found) {
        const dest = path.join(binDest, bin);
        fs.copyFileSync(found, dest);
        fs.chmodSync(dest, 0o755);
      }
    }
  }

  // 5. Clean up temp
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }

  // 6. Update definitions
  setProgress({ phase: 'updating-defs', message: 'Downloading virus definitions (this may take a few minutes)…' });
  await updateDefinitions();

  setProgress({ phase: 'done', message: 'ClamAV installed and definitions up to date.' });
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  try {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) copyDirRecursive(s, d);
      else fs.copyFileSync(s, d);
    }
  } catch { /* ignore */ }
}

function findFile(dir: string, filename: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return full;
      if (entry.isDirectory()) {
        const found = findFile(full, filename);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function findAllFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findAllFiles(full, extensions));
      else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()))
        results.push(full);
    }
  } catch { /* ignore */ }
  return results;
}

function findDir(dir: string, dirname: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === dirname) return full;
        const found = findDir(full, dirname);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── Definition update ─────────────────────────────────────────────────────────

export async function updateDefinitions(): Promise<void> {
  const freshclam = freshclamBin();
  try { fs.accessSync(freshclam, fs.constants.X_OK); } catch {
    throw new Error('freshclam binary not found — run ClamAV fetch first');
  }

  ensureFreshclamConf();
  fs.mkdirSync(dbDir(), { recursive: true });

  // Use spawn with stdio: 'ignore' — freshclam emits megabytes of progress
  // output that overflows execFile's default 1MB maxBuffer.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(freshclam, ['--config-file=' + confPath()], {
      stdio: 'ignore',
    });
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('freshclam timed out'));
    }, FRESHCLAM_TIMEOUT);

    child.on('close', (code) => {
      clearTimeout(watchdog);
      if (code === 0 || code === 1) {
        // Exit 1 = "up to date" — not an error
        resolve();
      } else {
        reject(new Error(`freshclam exited with code ${code}`));
      }
    });
    child.on('error', (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
  });
}

/** Standalone update with _progress tracking — use this from routes, not updateDefinitions() directly. */
export async function runUpdateDefinitions(): Promise<void> {
  setProgress({ phase: 'updating-defs', message: 'Downloading virus definitions (this may take a few minutes)…', bytesDownloaded: 0, totalBytes: 0 });
  try {
    await updateDefinitions();
    setProgress({ phase: 'done', message: 'Virus definitions updated.' });
  } catch (err) {
    setProgress({ phase: 'error', message: (err as Error).message });
    throw err;
  }
}

// ── ClamAV output parser ──────────────────────────────────────────────────────

function parseClamOutput(
  runId:     string,
  output:    string,
  priorKeys: Set<string>,
): Omit<SecurityFinding, 'id' | 'created_at'>[] {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];
  // ClamAV line format: /path/to/file: VirusName FOUND
  const lineRe = /^(.+?):\s+(.+?)\s+FOUND$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output)) !== null) {
    const [, filePath, virusName] = m;
    const title  = `Malware detected: ${virusName}`;
    const target = filePath.trim();
    findings.push({
      run_id:    runId,
      scan_type: 'malware_scan',
      severity:  'critical',
      title,
      detail:    `ClamAV signature: ${virusName}. File: ${target}`,
      target,
      cve_id:    null,
      is_new:    !priorKeys.has(`${title}||${target}`),
    });
  }
  return findings;
}

// ── Digest ────────────────────────────────────────────────────────────────────

async function buildDigest(
  findingCount: number,
  newCount:     number,
  rawOutput:    string,
  errorMessage: string | null,
): Promise<string> {
  const preview = rawOutput.slice(0, DIGEST_INPUT_CAP);
  const prompt  = [
    'You are reviewing a PHOBOS ClamAV malware scan result.',
    'Summarize the findings in 3-5 sentences.',
    'Focus on: infected files found, whether they are new, and recommended action.',
    'Be concise.',
    '',
    `New findings:   ${newCount}`,
    `Total findings: ${findingCount}`,
    errorMessage ? `Error: ${errorMessage}` : '',
    '',
    'Scan output:',
    preview,
  ].filter(l => l !== undefined).join('\n');

  try {
    return await Promise.race([
      engineStream({
        systemPrompt: 'You are a concise security analyst. Respond in plain text, no markdown.',
        messages:     [{ role: 'user', content: prompt }],
        maxTokens:    512,
        temperature:  0.2,
        mode:         'no_think',
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('digest timeout')), DIGEST_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    return `Digest unavailable: ${(err as Error).message}`;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runMalwareScan(
  store: SecurityStore,
  runId: string,
): Promise<void> {
  try {
    const bin = clamavBinaryPath();

    if (!bin) {
      await store.completeRun(
        runId, 'tool_missing', 0, 0, null,
        'ClamAV binary not found. Use the Security panel to download ClamAV.', null
      );
      return;
    }

    const priorKeys = await store.getPriorFindingKeys('malware_scan');
    const rawLines: string[] = [];

    // Stale definitions check — adds a low finding but does not block
    const age = definitionAge();
    if (!age) {
      rawLines.push('WARNING: Virus definitions not found. Run definition update before scanning.');
      const title = 'ClamAV virus definitions missing';
      const target = dbDir();
      await store.insertFindings([{
        run_id: runId, scan_type: 'malware_scan', severity: 'low',
        title, detail: 'Run definition update from the Security panel before scanning.',
        target, cve_id: null,
        is_new: !priorKeys.has(`${title}||${target}`),
      }]);
    } else if (age.stale) {
      const days = Math.floor(age.ageMs / (24 * 60 * 60_000));
      rawLines.push(`WARNING: Virus definitions are ${days} days old. Consider updating.`);
      const title = `ClamAV definitions stale (${days} days)`;
      const target = dbDir();
      await store.insertFindings([{
        run_id: runId, scan_type: 'malware_scan', severity: 'low',
        title, detail: `Definitions last updated ${days} days ago. Update from the Security panel.`,
        target, cve_id: null,
        is_new: !priorKeys.has(`${title}||${target}`),
      }]);
    }

    // Resolve scan targets
    const configPaths = await store.getConfig('malware_scan_paths');
    let targets: string[] = [];
    try { targets = JSON.parse(configPaths); } catch { targets = []; }
    if (targets.length === 0) {
      await store.completeRun(runId, 'error', 0, 0, null, 'No scan paths configured. Add at least one directory in the Security panel.', null);
      return;
    }

    rawLines.push(`Scanning: ${targets.join(', ')}`);

    // Run clamscan
    const dbPath = dbDir();
    const args   = ['--recursive', '--infected', '--no-summary', `--database=${dbPath}`, ...targets];

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let timedOut = false;

    await new Promise<void>((resolve) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let totalBytes = 0;
      const cap = RAW_OUTPUT_CAP;

      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= cap) stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8').slice(0, 2048);
      });

      const watchdog = setTimeout(() => {
        timedOut = true;
        if (IS_WIN) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
          try { process.kill(-(child.pid!), 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, SCAN_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(watchdog);
        exitCode = code ?? 1;
        resolve();
      });

      child.on('error', (err) => {
        clearTimeout(watchdog);
        stderr = err.message;
        exitCode = 1;
        resolve();
      });
    });

    rawLines.push(stdout || '(no infected files output)');
    if (stderr) rawLines.push(`stderr: ${stderr}`);

    const findings    = parseClamOutput(runId, stdout, priorKeys);
    const newCount    = findings.filter(f => f.is_new).length;
    const raw         = rawLines.join('\n').slice(0, RAW_OUTPUT_CAP);

    // Exit 0 = clean, exit 1 = infected found (both are success), exit >1 = error
    const isError = timedOut || exitCode > 1;
    const errMsg  = timedOut       ? 'ClamAV scan timed out after 10 minutes.' :
                    exitCode > 1   ? `clamscan exited with code ${exitCode}: ${stderr.slice(0, 256)}` : null;

    await store.insertFindings(findings);
    await store.setAnalyzing(runId);
    const digest = await buildDigest(findings.length, newCount, raw, errMsg);
    await store.completeRun(
      runId, isError ? 'error' : 'success',
      findings.length, newCount, raw, errMsg, digest
    );
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}