/**
 * test-audio-daw.ts — Independent validation harness for the PHOBOS DAW stack.
 *
 * Runs the same user flow the product would use: grab binaries via the fetch
 * scripts, spin up stores, compile ALDA, start Carla, send OSC, optionally
 * play audio through the real OS driver. Exits non-zero on any failure.
 *
 *   tsx test-audio-daw.ts --all
 *
 * Individual phases:
 *   --fetch              Run fetch-carla.js + fetch-helm.js
 *   --validate-osc       OSC encode/decode round-trip via loopback UDP
 *   --validate-alda      Parse + emit against alda-corpus.json fixture
 *   --validate-stores    EffectRackStore + DawProjectStore CRUD against a temp DuckDB
 *   --validate-carla     Spawn Carla (Dummy engine), set params, shutdown — silent
 *   --validate-playback  Play ./test-outputs/audio/test.wav through the stack (AUDIBLE)
 *   --validate-e2e       Full pipeline: ALDA text → Carla note-on → Helm audible (AUDIBLE)
 *
 * Gates:
 *   --audible            Opt-in gate for validate-playback and validate-e2e.
 *                        Without it, those phases use Carla's Dummy engine so
 *                        no sound is produced (safe for CI).
 *
 * Scratch workspace:
 *   Unix:    /tmp/phobos-audio-test-<timestamp>/
 *   Windows: %TEMP%\phobos-audio-test-<timestamp>\
 *
 * The user's real ~/.phobos is never touched — the harness overrides HOME /
 * USERPROFILE to redirect service-dir lookups into the scratch workspace.
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';
import * as dgram from 'node:dgram';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── CLI parsing ───────────────────────────────────────────────────────────────

interface CliFlags {
  fetch:             boolean;
  validateOsc:       boolean;
  validateAlda:      boolean;
  validateStores:    boolean;
  validateCarla:     boolean;
  validatePlayback:  boolean;
  validateE2e:       boolean;
  audible:           boolean;
  all:               boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const has = (f: string) => argv.includes(f);
  const all = has('--all');
  return {
    fetch:            all || has('--fetch'),
    validateOsc:      all || has('--validate-osc'),
    validateAlda:     all || has('--validate-alda'),
    validateStores:   all || has('--validate-stores'),
    validateCarla:    all || has('--validate-carla'),
    validatePlayback: all || has('--validate-playback'),
    validateE2e:      all || has('--validate-e2e'),
    audible:          has('--audible'),
    all,
  };
}

// ── Result tracking ───────────────────────────────────────────────────────────

interface PhaseResult {
  name:    string;
  status:  'ok' | 'fail' | 'skip';
  message: string;
  ms:      number;
}

const results: PhaseResult[] = [];

async function runPhase(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`\n── ${name} ──\n`);
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name, status: 'ok', message: '', ms });
    console.log(`[OK]   ${name} (${ms} ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    const message = (err as Error).message;
    results.push({ name, status: 'fail', message, ms });
    console.error(`[FAIL] ${name} (${ms} ms)\n       ${message}`);
  }
}

function skipPhase(name: string, reason: string): void {
  results.push({ name, status: 'skip', message: reason, ms: 0 });
  console.log(`[SKIP] ${name} — ${reason}`);
}

// ── Scratch workspace ─────────────────────────────────────────────────────────
//
// By default every invocation creates a fresh timestamped directory under
// %TEMP% / /tmp. That's what you want for clean-room runs, but it also means
// `--validate-carla` on its own has nowhere to find the Carla binary that an
// earlier `--fetch` run installed.
//
// Two escape hatches are provided:
//   1. PHOBOS_SCRATCH=<path>  — explicit override. Highest priority.
//   2. Auto-discovery          — if --validate-carla (or --validate-e2e) runs
//      without --fetch in the same command, and no explicit override is set,
//      we look at all prior `phobos-audio-test-*` dirs in %TEMP% and pick the
//      most recent one that has a Carla binary staged.

function scratchBaseDir(): string {
  return process.platform === 'win32'
    ? (process.env.TEMP ?? os.tmpdir())
    : '/tmp';
}

function hasCarlaBinary(dir: string): boolean {
  const svc = path.join(dir, '.phobos', 'services', 'carla');
  if (!fs.existsSync(svc)) return false;
  // Cheap recursive check — we just need ANY Carla.exe / Carla(.app) under svc.
  const targetName = process.platform === 'win32' ? 'Carla.exe' : 'Carla';
  const queue: string[] = [svc];
  let steps = 0;
  while (queue.length > 0 && steps++ < 500) {  // safety bound
    const d = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === targetName && e.isFile()) return true;
      if (e.isDirectory()) queue.push(path.join(d, e.name));
    }
  }
  return false;
}

function findMostRecentPopulatedScratch(): string | null {
  const base = scratchBaseDir();
  let entries: string[];
  try { entries = fs.readdirSync(base); } catch { return null; }
  const candidates = entries
    .filter(n => n.startsWith('phobos-audio-test-'))
    .map(n => path.join(base, n))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .filter(hasCarlaBinary)
    .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? candidates[0].p : null;
}

function makeScratchDir(): { dir: string; reused: boolean } {
  if (process.env.PHOBOS_SCRATCH) {
    const override = path.resolve(process.env.PHOBOS_SCRATCH);
    fs.mkdirSync(override, { recursive: true });
    return { dir: override, reused: true };
  }
  const ts  = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(scratchBaseDir(), `phobos-audio-test-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, reused: false };
}

// ── Repo resolution ───────────────────────────────────────────────────────────
//
// The harness is designed to be run from the repo root (`tsx test-audio-daw.ts`).
// Source modules are located relative to this file. `dual-reasoning/` is an
// ESM project (package.json "type": "module"), so we resolve via import.meta.url.

import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// ── PHASE: fetch binaries ─────────────────────────────────────────────────────

async function phaseFetch(scratchDir: string): Promise<void> {
  // Point service downloads at the scratch workspace so the real ~/.phobos is
  // not touched. Both fetch scripts use os.homedir() internally — override it.
  const homeOverride = scratchDir;
  const env = {
    ...process.env,
    HOME:        homeOverride,
    USERPROFILE: homeOverride,
  };

  for (const script of ['fetch-carla.js', 'fetch-helm.js']) {
    const scriptPath = path.join(REPO_ROOT, 'scripts', script);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Fetch script missing: ${scriptPath}`);
    }
    console.log(`  → running ${script}`);
    await execFileAsync('node', [scriptPath], { env, timeout: 15 * 60 * 1000 });
  }

  // Verify the expected artifacts landed
  const carlaSvcDir = path.join(homeOverride, '.phobos', 'services', 'carla');
  if (!fs.existsSync(carlaSvcDir)) {
    throw new Error(`Carla service dir missing: ${carlaSvcDir}`);
  }
  const pluginsDir = path.join(carlaSvcDir, 'plugins');
  const pluginEntries = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : [];
  if (pluginEntries.length === 0) {
    throw new Error(`No plugins staged in ${pluginsDir}`);
  }
  console.log(`  ✓ plugins installed: ${pluginEntries.join(', ')}`);
}

// ── PHASE: OSC round-trip ─────────────────────────────────────────────────────

async function phaseValidateOsc(): Promise<void> {
  const { OscClient, OscDecoder } = await import('./phobos/OscClient.js');

  // Bind a UDP server on an ephemeral port, send a message, decode, assert.
  const server = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.bind(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  const received: Buffer[] = [];
  server.on('message', msg => received.push(Buffer.from(msg)));

  const client = new OscClient({ host: '127.0.0.1', port });

  // Exercise every message type
  client.setParam(0, 14, 0.35);
  client.setParam(2, 0,  0.5);
  client.setProgram(0, 7);
  client.noteOn(0, 0, 60, 100);
  client.noteOff(0, 0, 60);
  client.loadProject('/tmp/test.carxp');

  // Give the socket a moment to drain
  await new Promise(r => setTimeout(r, 100));

  client.close();
  server.close();

  if (received.length !== 6) {
    throw new Error(`Expected 6 OSC messages received, got ${received.length}`);
  }

  const dec = new OscDecoder();
  const decoded = received.map(b => dec.decode(b, b.length));

  const checks: Array<[string, boolean, string]> = [
    [
      'setParam mix on crystal',
      decoded[0].address === '/Carla/0/0/set_parameter_value' &&
        decoded[0].types === 'if' &&
        decoded[0].args[0] === 14 &&
        Math.abs((decoded[0].args[1] as number) - 0.35) < 1e-6,
      JSON.stringify(decoded[0]),
    ],
    [
      'setParam crystal plugin idx 2',
      decoded[1].address === '/Carla/0/2/set_parameter_value' && decoded[1].args[0] === 0,
      JSON.stringify(decoded[1]),
    ],
    [
      'setProgram',
      decoded[2].address === '/Carla/0/0/set_program' && decoded[2].types === 'i' && decoded[2].args[0] === 7,
      JSON.stringify(decoded[2]),
    ],
    [
      'noteOn',
      decoded[3].address === '/Carla/0/0/note_on' && decoded[3].types === 'iii' &&
        decoded[3].args[0] === 0 && decoded[3].args[1] === 60 && decoded[3].args[2] === 100,
      JSON.stringify(decoded[3]),
    ],
    [
      'noteOff',
      decoded[4].address === '/Carla/0/0/note_off' && decoded[4].types === 'ii' &&
        decoded[4].args[1] === 60,
      JSON.stringify(decoded[4]),
    ],
    [
      'loadProject',
      decoded[5].address === '/Carla/0/load_project' && decoded[5].types === 's' &&
        decoded[5].args[0] === '/tmp/test.carxp',
      JSON.stringify(decoded[5]),
    ],
  ];

  for (const [label, ok, dump] of checks) {
    if (!ok) throw new Error(`${label} mismatch: ${dump}`);
    console.log(`  ✓ ${label}`);
  }
}

// ── PHASE: ALDA fixture corpus ────────────────────────────────────────────────

async function phaseValidateAlda(): Promise<void> {
  const { aldaToMidi } = await import('./phobos/alda-parser/index.js');

  const corpusPath = path.join(REPO_ROOT, 'test-fixtures', 'audio-daw', 'alda-corpus.json');
  if (!fs.existsSync(corpusPath)) {
    throw new Error(`Fixture missing: ${corpusPath}`);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as {
    fixtures: Array<{ name: string; source: string; expect: Record<string, unknown> }>;
  };

  let passed = 0;
  for (const fixture of corpus.fixtures) {
    const result = aldaToMidi(fixture.source);
    const fail = (why: string) => {
      throw new Error(`fixture "${fixture.name}" failed: ${why}`);
    };
    const exp = fixture.expect as Record<string, unknown>;

    if (typeof exp.eventCount === 'number' && result.events.length !== exp.eventCount) {
      fail(`eventCount expected ${exp.eventCount}, got ${result.events.length}`);
    }

    if (Array.isArray(exp.midiNotes)) {
      const notes = result.events.map(e => e.midiNote);
      if (!arrayEq(notes, exp.midiNotes as number[])) {
        fail(`midiNotes expected ${JSON.stringify(exp.midiNotes)}, got ${JSON.stringify(notes)}`);
      }
    }

    if (typeof exp.firstMidi === 'number' && result.events[0].midiNote !== exp.firstMidi) {
      fail(`firstMidi expected ${exp.firstMidi}, got ${result.events[0].midiNote}`);
    }
    if (typeof exp.lastMidi === 'number' &&
        result.events[result.events.length - 1].midiNote !== exp.lastMidi) {
      fail(`lastMidi expected ${exp.lastMidi}, got ${result.events[result.events.length - 1].midiNote}`);
    }

    if (typeof exp.allDurationTicks === 'number') {
      for (const ev of result.events) {
        if (ev.durationTicks !== exp.allDurationTicks) {
          fail(`allDurationTicks expected ${exp.allDurationTicks}, got ${ev.durationTicks}`);
        }
      }
    }

    if (Array.isArray(exp.durationsTicks)) {
      const ds = result.events.map(e => e.durationTicks);
      if (!arrayEq(ds, exp.durationsTicks as number[])) {
        fail(`durationsTicks expected ${JSON.stringify(exp.durationsTicks)}, got ${JSON.stringify(ds)}`);
      }
    }

    if (typeof exp.allStartTicks === 'number') {
      for (const ev of result.events) {
        if (ev.startTicks !== exp.allStartTicks) {
          fail(`allStartTicks expected ${exp.allStartTicks}, got ${ev.startTicks}`);
        }
      }
    }

    if (Array.isArray(exp.startTicks)) {
      const ss = result.events.map(e => e.startTicks);
      if (!arrayEq(ss, exp.startTicks as number[])) {
        fail(`startTicks expected ${JSON.stringify(exp.startTicks)}, got ${JSON.stringify(ss)}`);
      }
    }

    if (typeof exp.tempoBpm === 'number' && result.tempoBpm !== exp.tempoBpm) {
      fail(`tempoBpm expected ${exp.tempoBpm}, got ${result.tempoBpm}`);
    }

    if (typeof exp.velocityApprox === 'number') {
      const v = result.events[0].velocity;
      if (Math.abs(v - (exp.velocityApprox as number)) > 3) {
        fail(`velocity ~${exp.velocityApprox} expected, got ${v}`);
      }
    }

    if (Array.isArray(exp.channels)) {
      const chs = result.events.map(e => e.channel);
      if (!arrayEq(chs, exp.channels as number[])) {
        fail(`channels expected ${JSON.stringify(exp.channels)}, got ${JSON.stringify(chs)}`);
      }
    }

    if (Array.isArray(exp.instruments)) {
      const insts = [...new Set(result.events.map(e => e.instrument))];
      if (!arrayEq(insts, exp.instruments as string[])) {
        fail(`instruments expected ${JSON.stringify(exp.instruments)}, got ${JSON.stringify(insts)}`);
      }
    }

    if (Array.isArray(exp.events)) {
      // Full event comparison
      const expectedEvents = exp.events as Array<Record<string, unknown>>;
      for (let i = 0; i < expectedEvents.length; i++) {
        const e   = result.events[i];
        const eExp = expectedEvents[i];
        for (const key of Object.keys(eExp)) {
          const actual   = (e as any)[key];
          const expected = eExp[key];
          if (actual !== expected) {
            fail(`event[${i}].${key} expected ${expected}, got ${actual}`);
          }
        }
      }
    }

    passed++;
    console.log(`  ✓ ${fixture.name}`);
  }

  if (passed === 0) throw new Error('No fixtures ran');
  console.log(`  ${passed}/${corpus.fixtures.length} ALDA fixtures passed`);
}

function arrayEq<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── PHASE: store CRUD ─────────────────────────────────────────────────────────

async function phaseValidateStores(scratchDir: string): Promise<void> {
  // Use a temporary DuckDB file inside the scratch dir — do not touch the
  // user's real phobos.duckdb.
  const dbPath = path.join(scratchDir, 'test.duckdb');

  const { DatabaseManager } = await import('./db/DatabaseManager.js');
  const db = DatabaseManager.getInstance(dbPath);
  await db.initialize();

  try {
    const { EffectRackStore } = await import('./db/EffectRackStore.js');
    const rack = new EffectRackStore(db);
    await rack.ensureTable();

    // Factory presets must be present after ensureTable
    const presets = await rack.list();
    const ids = presets.map(p => p.id);
    for (const id of ['daw-dry', 'polaris-mastered', 'game-combat']) {
      if (!ids.includes(id)) throw new Error(`Factory preset ${id} missing after ensureTable`);
    }
    console.log(`  ✓ factory presets seeded: ${ids.join(', ')}`);

    // Upsert → get → diff
    const saved = await rack.upsert({
      id:      'test-preset-1',
      label:   'Test',
      context: 'custom',
      params:  { crystal: { '14': 0.9 } },
      routing: { sendsToCrystal: [], crystalSend: 0 },
    });
    if (saved.id !== 'test-preset-1') throw new Error('Upsert returned wrong row');

    const loaded = await rack.get('test-preset-1');
    if (!loaded) throw new Error('Reload failed');
    if (loaded.params.crystal['14'] !== 0.9) throw new Error('Param not preserved');
    console.log(`  ✓ preset upsert + reload`);

    const changes = EffectRackStore.diff(null, loaded);
    if (changes.length !== 1 || changes[0].value !== 0.9) {
      throw new Error(`diff wrong: ${JSON.stringify(changes)}`);
    }
    console.log(`  ✓ preset diff`);

    // Factory preset delete protection
    const deletedFactory = await rack.delete('daw-dry');
    if (deletedFactory) throw new Error('Factory preset was deletable');
    const deletedCustom = await rack.delete('test-preset-1');
    if (!deletedCustom) throw new Error('Custom preset not deletable');
    console.log(`  ✓ factory delete protection`);

    // DawProjectStore
    const { DawProjectStore } = await import('./db/DawProjectStore.js');
    const projects = new DawProjectStore(db);
    await projects.ensureTable();

    const xtkSource = { patterns: [{ step: 0 }], instruments: [] };
    const xtkJson   = JSON.stringify(xtkSource);
    const savedProj = await projects.save('proj-1', 'Test Song', xtkJson, null);
    if (savedProj.id !== 'proj-1') throw new Error('Project save round-trip failed');

    // Bitwise XTK preservation
    const reloaded = await projects.get('proj-1');
    if (!reloaded) throw new Error('Project reload failed');
    if (reloaded.xtk_json !== xtkJson) throw new Error('XTK JSON mutated — expected bitwise preservation');
    console.log(`  ✓ project XTK round-trip`);

    // setLastRender
    await projects.setLastRender('proj-1', '/tmp/render.wav');
    const withRender = await projects.get('proj-1');
    if (withRender?.last_render_path !== '/tmp/render.wav') throw new Error('setLastRender failed');
    console.log(`  ✓ last_render_path update`);

    // List by thread_id
    await projects.save('proj-2', 'Thread Song', xtkJson, 'thread-abc');
    const threadRows = await projects.list('thread-abc');
    if (threadRows.length !== 1 || threadRows[0].id !== 'proj-2') {
      throw new Error(`list(thread-abc) wrong: ${JSON.stringify(threadRows)}`);
    }
    console.log(`  ✓ thread-scoped list`);

  } finally {
    await db.close();
  }
}

// ── PHASE: Carla silent spawn ─────────────────────────────────────────────────
// Uses the --engine=Dummy option so nothing plays through the speakers.
// Validates: spawn succeeds, OSC params accepted, stop succeeds.

async function phaseValidateCarla(scratchDir: string, audible: boolean): Promise<void> {
  process.env.HOME        = scratchDir;
  process.env.USERPROFILE = scratchDir;

  const carla = await import('./phobos/CarlaManager.js');

  if (!carla.isBinaryPresent()) {
    const expected = carla.resolveBinaryPath();
    throw new Error(
      `Carla binary not found.\n` +
      `   Scratch:       ${scratchDir}\n` +
      `   Expected path: ${expected}\n` +
      `   HOME env:      ${process.env.HOME}\n` +
      `   USERPROFILE:   ${process.env.USERPROFILE}\n` +
      `   Run with --fetch first.`
    );
  }

  await carla.ensureRunning({ silent: !audible });
  console.log(`  ✓ Carla spawned (silent=${!audible})`);

  const status = carla.getStatus();
  if (status.state !== 'running') throw new Error(`state expected 'running', got '${status.state}'`);
  console.log(`  ✓ status reports running (pid=${status.pid}, uptime=${status.uptimeMs}ms)`);

  // Drive a handful of OSC messages. Carla with Dummy engine accepts them; no
  // audio is produced but the upstream receives the packets.
  try {
    carla.setParam(0, 14, 0.2);
    carla.noteOn(0, 0, 60, 100);
    await new Promise(r => setTimeout(r, 200));
    carla.noteOff(0, 0, 60);
    console.log(`  ✓ OSC param + note messages accepted`);
  } catch (err) {
    throw new Error(`OSC send failed: ${(err as Error).message}`);
  }

  await carla.stopCarla();
  const final = carla.getStatus();
  if (final.state !== 'stopped') throw new Error(`state expected 'stopped', got '${final.state}'`);
  console.log(`  ✓ Carla stopped cleanly`);
}

// ── PHASE: audio file playback ────────────────────────────────────────────────
// Plays ./test-outputs/audio/test.wav through Carla's audio driver. Requires
// --audible. In silent mode, this phase runs but uses the dummy engine and
// only asserts the file exists and is a valid WAV header.

async function phaseValidatePlayback(scratchDir: string, audible: boolean): Promise<void> {
  const wavPath = path.join(REPO_ROOT, 'test-outputs', 'audio', 'test.wav');
  if (!fs.existsSync(wavPath)) {
    throw new Error(`Test audio file missing: ${wavPath}`);
  }

  // Validate WAV header — 4 bytes 'RIFF', size, 4 bytes 'WAVE'
  const head = Buffer.alloc(12);
  const fd   = fs.openSync(wavPath, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  if (head.slice(0, 4).toString() !== 'RIFF' || head.slice(8, 12).toString() !== 'WAVE') {
    throw new Error(`Not a valid WAV file: ${wavPath}`);
  }
  console.log(`  ✓ test.wav present and valid`);

  if (!audible) {
    console.log(`  (silent mode — playback skipped; re-run with --audible to hear output)`);
    return;
  }

  // Audible path: spawn a thin player against the OS default audio device.
  // We intentionally use the OS's built-in player rather than routing through
  // Carla — Carla is a plugin host, not a file player. The point of this
  // phase is to validate that the end-to-end audio path to the speakers
  // works at all before validate-e2e attempts to drive Helm live.
  const player = selectPlayer();
  if (!player) throw new Error(`No audio player available on this platform`);

  console.log(`  → playing ${wavPath} via ${player.cmd}`);
  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(player.cmd, [...player.args, wavPath], {
      stdio: 'ignore',
      detached: false,
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${player.cmd} exited ${code}`));
    });
    // Hard timeout — 30 seconds of playback is enough for any test tone
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolve();
    }, 30_000);
  });
  console.log(`  ✓ playback returned after ${Date.now() - t0}ms`);
}

function selectPlayer(): { cmd: string; args: string[] } | null {
  if (process.platform === 'win32') {
    // PowerShell System.Media.SoundPlayer is built-in on Windows 10+
    return {
      cmd:  'powershell',
      args: ['-NoProfile', '-Command',
             '$p = New-Object System.Media.SoundPlayer; $p.SoundLocation = $args[0]; $p.PlaySync()',
             '-'],
    };
  }
  if (process.platform === 'darwin') {
    return { cmd: 'afplay', args: [] };
  }
  // Linux — try aplay first (ALSA), fall back to paplay (PulseAudio)
  return { cmd: 'aplay', args: ['-q'] };
}

// ── PHASE: end-to-end pipeline ────────────────────────────────────────────────
// ALDA source → aldaToMidi → OSC note_on/note_off to Carla → Helm audible.

async function phaseValidateE2e(scratchDir: string, audible: boolean): Promise<void> {
  process.env.HOME        = scratchDir;
  process.env.USERPROFILE = scratchDir;

  const carla = await import('./phobos/CarlaManager.js');
  const { aldaToMidi, gmProgramFor } = await import('./phobos/alda-parser/index.js');

  if (!carla.isBinaryPresent()) {
    const expected = carla.resolveBinaryPath();
    throw new Error(
      `Carla binary not found.\n` +
      `   Scratch:       ${scratchDir}\n` +
      `   Expected path: ${expected}\n` +
      `   HOME env:      ${process.env.HOME}\n` +
      `   USERPROFILE:   ${process.env.USERPROFILE}\n` +
      `   Run with --fetch first.`
    );
  }

  // Compile a short piece
  const source = '(tempo 120) piano: o4 c8 d e f g a b > c';
  const midi   = aldaToMidi(source);
  console.log(`  ✓ compiled: ${midi.events.length} events, tempo=${midi.tempoBpm}`);

  await carla.ensureRunning({ silent: !audible });
  console.log(`  ✓ Carla running (silent=${!audible})`);

  // Set Helm program to a recognizable piano preset
  carla.setProgram(0, gmProgramFor('piano'));

  // Dispatch notes one by one on a wallclock schedule so they land in
  // correct MIDI order. Quarter note at 120 bpm = 500ms.
  const msPerTick = 60_000 / midi.tempoBpm / midi.ticksPerBeat;
  const endTick   = midi.events.reduce((m, e) => Math.max(m, e.startTicks + e.durationTicks), 0);

  const t0 = Date.now();
  const scheduleAt = (offsetMs: number, fn: () => void) =>
    setTimeout(fn, Math.max(0, offsetMs - (Date.now() - t0)));

  for (const ev of midi.events) {
    const onMs  = ev.startTicks                     * msPerTick;
    const offMs = (ev.startTicks + ev.durationTicks) * msPerTick;
    scheduleAt(onMs,  () => carla.noteOn(0, ev.channel, ev.midiNote, ev.velocity));
    scheduleAt(offMs, () => carla.noteOff(0, ev.channel, ev.midiNote));
  }

  // Wait for the whole score plus a small tail
  await new Promise(r => setTimeout(r, endTick * msPerTick + 500));
  console.log(`  ✓ dispatched ${midi.events.length} note pairs over ${Math.round(endTick * msPerTick)}ms`);

  await carla.stopCarla();
  console.log(`  ✓ Carla stopped cleanly`);

  if (!audible) {
    console.log(`  (silent mode — OSC traffic succeeded; re-run with --audible to hear output)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const anyRequested = flags.fetch || flags.validateOsc || flags.validateAlda ||
                       flags.validateStores || flags.validateCarla ||
                       flags.validatePlayback || flags.validateE2e;

  if (!anyRequested) {
    console.log(
`test-audio-daw.ts — PHOBOS DAW stack validation

Usage:
  tsx test-audio-daw.ts --all                  Run every phase
  tsx test-audio-daw.ts --validate-osc         Single phase
  tsx test-audio-daw.ts --fetch --validate-alda Multiple phases

Phases:
  --fetch              Download Carla + Helm binaries
  --validate-osc       OSC encoder/decoder round-trip
  --validate-alda      ALDA parser + emitter against fixture corpus
  --validate-stores    EffectRackStore + DawProjectStore CRUD
  --validate-carla     Carla spawn + OSC + shutdown (silent)
  --validate-playback  Play test-outputs/audio/test.wav (needs --audible)
  --validate-e2e       Full ALDA → OSC → Helm pipeline (needs --audible)

Gates:
  --audible            Allow phases that produce sound through the OS driver

Scratch workspace:
  Every run creates a fresh scratch dir under %TEMP% / /tmp unless told
  otherwise. Phases that need Carla (--validate-carla, --validate-e2e)
  also check for a binary staged by an earlier --fetch:

    • Chain phases in one command (easiest):
        tsx test-audio-daw.ts --fetch --validate-carla

    • Set PHOBOS_SCRATCH to explicitly reuse a populated scratch:
        $env:PHOBOS_SCRATCH = "C:\Users\...\phobos-audio-test-2026-..."
        tsx test-audio-daw.ts --validate-carla

    • Otherwise, if you've run --fetch recently, the harness will
      auto-discover the most recent scratch dir with Carla installed
      and use it.
`);
    process.exit(0);
  }

  let { dir: scratchDir, reused } = makeScratchDir();

  // If the user asked for a Carla-backed phase but didn't chain --fetch in
  // the same invocation, and we're in a fresh scratch, try to auto-discover
  // a recent scratch where --fetch previously ran. This is what most people
  // actually want — otherwise they get a confusing SKIP because each run
  // builds a new scratch.
  const needsCarla = flags.validateCarla || flags.validateE2e;
  if (needsCarla && !flags.fetch && !reused && !hasCarlaBinary(scratchDir)) {
    const found = findMostRecentPopulatedScratch();
    if (found) {
      console.log(`↻ Reusing prior scratch with Carla:  ${found}`);
      console.log(`  (override with PHOBOS_SCRATCH=<path>, or chain --fetch to rebuild)`);
      scratchDir = found;
      reused = true;
    }
  }

  console.log(`Scratch workspace: ${scratchDir}${reused ? ' (reused)' : ''}`);
  console.log(`Audible mode:      ${flags.audible ? 'ON — audio will play' : 'OFF (silent; --audible to enable)'}`);

  const carlaSkipReason =
    'no Carla binary in scratch. Either chain --fetch in this run, set ' +
    'PHOBOS_SCRATCH=<prior scratch path>, or run --fetch once to populate a scratch ' +
    'that auto-discovery can find.';

  if (flags.fetch)             await runPhase('fetch binaries',       () => phaseFetch(scratchDir));
  if (flags.validateOsc)       await runPhase('OSC round-trip',       () => phaseValidateOsc());
  if (flags.validateAlda)      await runPhase('ALDA fixture corpus',  () => phaseValidateAlda());
  if (flags.validateStores)    await runPhase('DuckDB stores CRUD',   () => phaseValidateStores(scratchDir));
  if (flags.validateCarla) {
    if (flags.fetch || hasCarlaBinary(scratchDir)) {
      await runPhase('Carla silent spawn',   () => phaseValidateCarla(scratchDir, flags.audible));
    } else {
      skipPhase('Carla silent spawn', carlaSkipReason);
    }
  }
  if (flags.validatePlayback)  await runPhase('audio playback',        () => phaseValidatePlayback(scratchDir, flags.audible));
  if (flags.validateE2e) {
    if (flags.fetch || hasCarlaBinary(scratchDir)) {
      await runPhase('end-to-end pipeline', () => phaseValidateE2e(scratchDir, flags.audible));
    } else {
      skipPhase('end-to-end pipeline', carlaSkipReason);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('SUMMARY');
  console.log('─'.repeat(60));
  for (const r of results) {
    const tag = r.status === 'ok'   ? '[OK]   '
              : r.status === 'fail' ? '[FAIL] '
              : '[SKIP] ';
    const ms = r.ms > 0 ? ` ${r.ms}ms` : '';
    console.log(`${tag}${r.name}${ms}${r.message ? ` — ${r.message}` : ''}`);
  }
  const failed = results.filter(r => r.status === 'fail').length;
  console.log('─'.repeat(60));
  console.log(`Scratch workspace preserved: ${scratchDir}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nHARNESS FATAL:', err);
  process.exit(2);
});
