/**
 * StirlingManager.ts — Lifecycle manager for the Stirling PDF service.
 *
 * Stirling PDF is a Spring Boot web app. PHOBOS embeds it in a fullscreen
 * iframe — no postMessage protocol required. Every PDF operation happens
 * inside Stirling's own UI; exports land in the browser's download folder.
 *
 * Binary: Stirling-PDF.jar (all platforms — requires Java 21+)
 *   ~/.phobos/services/stirling/Stirling-PDF.jar
 *
 * The server jar is the correct choice for PHOBOS's headless iframe use case.
 * The platform-native .msi/.dmg desktop apps are GUI applications that cannot
 * be spawned headlessly — they open a Tauri window, not a web server.
 *
 * Port:    16346 (permanent wire contract)
 *
 * Java 21+ must be on PATH. Checked on first start with a clear error if missing.
 *
 * Stirling has no auth in its default config (SECURITY_ENABLELOGIN=false).
 * PHOBOS is local-only — this is correct.
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify }  from 'util';
import * as fs   from 'fs';
import * as net  from 'net';
import * as path from 'path';
import * as os   from 'os';

const execFileAsync = promisify(execFile);

// ── Wire constants ─────────────────────────────────────────────────────────────
export const STIRLING_PORT = 16346;

// ── Paths ──────────────────────────────────────────────────────────────────────

export function resolveServiceDir(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'stirling');
}

export function resolveJarPath(): string {
  return path.join(resolveServiceDir(), 'Stirling-PDF.jar');
}

export function isBinaryPresent(): boolean {
  const jar = resolveJarPath();
  if (!fs.existsSync(jar)) return false;
  return fs.statSync(jar).size > 10_000_000;
}

// ── Java version check ────────────────────────────────────────────────────────

async function checkJava(): Promise<{ ok: boolean; version: string; error?: string }> {
  try {
    const { stderr } = await execFileAsync('java', ['-version'], { timeout: 5_000 });
    const line  = stderr.split('\n')[0] ?? '';
    const match = line.match(/version "(\d+)/);
    const major = match ? parseInt(match[1], 10) : 0;
    if (major < 21) {
      return { ok: false, version: line.trim(), error: `Java 21+ required, found: ${line.trim()}` };
    }
    return { ok: true, version: line.trim() };
  } catch {
    return { ok: false, version: '', error: 'Java not found on PATH. Install Java 21+: https://adoptium.net' };
  }
}

// ── Port wait ──────────────────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error',   () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Stirling PDF did not start within ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 1_000);
      });
    };
    attempt();
  });
}

// ── Service state ──────────────────────────────────────────────────────────────

interface ManagedService {
  process: ChildProcess | null;
  state:   'stopped' | 'starting' | 'running' | 'error';
  error:   string | null;
}

const service: ManagedService = { process: null, state: 'stopped', error: null };

// ── Start ──────────────────────────────────────────────────────────────────────

export async function startStirling(): Promise<void> {
  if (service.state === 'running')  return;
  if (service.state === 'starting') return;

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'Stirling-PDF.jar not found. Run: node scripts/fetch-stirling.js';
    throw new Error(service.error);
  }

  const java = await checkJava();
  if (!java.ok) {
    service.state = 'error';
    service.error = java.error!;
    throw new Error(service.error);
  }

  service.state = 'starting';
  service.error = null;

  const jar = resolveJarPath();
  const dir = resolveServiceDir();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SECURITY_ENABLELOGIN:    'false',
    STIRLING_PDF_DESKTOP_UI: 'false',
    // Spring Boot reads SERVER_PORT env var — belt-and-suspenders alongside the JVM arg
    SERVER_PORT: String(STIRLING_PORT),
  };

  try {
    const proc = spawn('java', [
      // JVM system property — must come BEFORE -jar
      `-Dserver.port=${STIRLING_PORT}`,
      '-Djava.awt.headless=true',
      '-Dspring.main.web-application-type=servlet',
      '-jar', jar,
      // Spring Boot program argument — overrides application.properties
      `--server.port=${STIRLING_PORT}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd:   dir,
      env,
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[stirling] ${line}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[stirling] ${line}`);
    });
    proc.on('exit', (code, signal) => {
      console.log(`[StirlingManager] exited code=${code} signal=${signal}`);
      service.process = null;
      service.state   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
      if (code !== 0 && code !== null && signal == null) {
        service.error = `Stirling PDF exited with code ${code}`;
      }
    });

    service.process = proc;
    await waitForPort(STIRLING_PORT, 90_000);
    service.state = 'running';
    console.log(`[StirlingManager] ready on :${STIRLING_PORT} (${java.version})`);
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

// ── Stop ───────────────────────────────────────────────────────────────────────

export async function stopStirling(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;
  if (service.process) {
    service.process.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 8_000);
      service.process!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    service.process = null;
  }
  service.state = 'stopped';
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface StirlingStatus {
  state:         'stopped' | 'starting' | 'running' | 'error';
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  platform:      string;
}

export function getStirlingStatus(): StirlingStatus {
  return {
    state:         service.state,
    port:          STIRLING_PORT,
    error:         service.error,
    binaryPresent: isBinaryPresent(),
    platform:      process.platform,
  };
}
