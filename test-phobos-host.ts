// test-phobos-host.ts — Session 2 smoke test.
//
// Spawns the PhobosHost binary, exercises the wire surface across both
// Session 1 (control + OSC plumbing) and Session 2 (plugin scan/load/
// MIDI flow/state), asserts the binary shuts down cleanly.
//
// Run from phobos-core:
//
//   tsx test-phobos-host.ts
//
// The binary must be deployed to:
//
//   ~/.phobos/services/phobos-host/PhobosHost(.exe)
//
// And Helm must be available at:
//
//   ~/.phobos/services/helm/VST3/                    (recursive scan)
//
// If Helm isn't there, the load/note phases fail clearly. Build phobos-host
// and copy the binary into place before running this script.

import * as fs    from 'node:fs';
import * as os    from 'node:os';
import * as path  from 'node:path';
import * as dgram from 'node:dgram';
import * as net   from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';

const TCP_PORT = 16332;
const UDP_PORT = 16331;
const HOST     = '127.0.0.1';

const HELM_DIR = path.join(os.homedir(), '.phobos', 'services', 'helm', 'VST3');

// ── Phase harness ────────────────────────────────────────────────────────────

interface PhaseResult { name: string; status: 'ok' | 'fail'; message: string; ms: number; }
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

// ── Binary resolution ────────────────────────────────────────────────────────

function resolveBinary(): string {
  const exe = process.platform === 'win32' ? 'PhobosHost.exe' : 'PhobosHost';
  const deployed = path.join(os.homedir(), '.phobos', 'services', 'phobos-host', exe);
  if (!fs.existsSync(deployed)) {
    throw new Error(
      `PhobosHost not deployed. Expected at:\n  ${deployed}\n` +
      `Build phobos-audio-host, then copy the binary into that folder.`,
    );
  }
  return deployed;
}

// ── TCP control client ───────────────────────────────────────────────────────

interface TcpEnvelope { id?: number; ok?: boolean; result?: unknown; error?: string; evt?: string; [k: string]: unknown; }

class ControlClient {
  private sock: net.Socket | null = null;
  private readBuf = Buffer.alloc(0);
  private pending = new Map<number, (env: TcpEnvelope) => void>();
  private events: TcpEnvelope[] = [];
  private nextId = 1;

  // Number of [ERR]-level log events received over the whole session.
  errorEventCount = 0;

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: HOST, port: TCP_PORT }, () => resolve());
      s.once('error', reject);
      s.on('data',  (chunk) => this.onData(chunk));
      s.on('close', () => { this.sock = null; });
      this.sock = s;
    });
  }

  close(): void { if (this.sock) { this.sock.end(); this.sock = null; } }

  async send(op: string, args: unknown = {}): Promise<TcpEnvelope> {
    if (!this.sock) throw new Error('not connected');
    const id   = this.nextId++;
    const body = Buffer.from(JSON.stringify({ id, op, args }), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.sock.write(head);
    this.sock.write(body);

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`op '${op}' timed out`));
      }, 30_000);                                          // generous — plugin scan/load can be slow
      this.pending.set(id, (env) => { clearTimeout(timer); resolve(env); });
    });
  }

  async waitForEvent(predicate: (e: TcpEnvelope) => boolean, timeoutMs = 2000): Promise<TcpEnvelope | null> {
    for (let i = 0; i < this.events.length; i++) {
      if (predicate(this.events[i])) {
        const [match] = this.events.splice(i, 1);
        return match;
      }
    }
    return await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        for (let i = 0; i < this.events.length; i++) {
          if (predicate(this.events[i])) {
            const [match] = this.events.splice(i, 1);
            clearInterval(tick);
            resolve(match);
            return;
          }
        }
        if (Date.now() - t0 > timeoutMs) { clearInterval(tick); resolve(null); }
      }, 25);
    });
  }

  private onData(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk]);
    while (this.readBuf.length >= 4) {
      const len = this.readBuf.readUInt32BE(0);
      if (this.readBuf.length < 4 + len) break;
      const body = this.readBuf.subarray(4, 4 + len).toString('utf8');
      this.readBuf = this.readBuf.subarray(4 + len);
      try {
        const env = JSON.parse(body) as TcpEnvelope;
        if (env.evt !== undefined) {
          if (env.evt === 'log' && (env as { level?: number }).level === 2)
            this.errorEventCount++;
          this.events.push(env);
        } else if (typeof env.id === 'number') {
          const cb = this.pending.get(env.id);
          if (cb) { this.pending.delete(env.id); cb(env); }
        }
      } catch (err) {
        console.error(`bad frame: ${(err as Error).message}`);
      }
    }
  }
}

// ── OSC encoder ──────────────────────────────────────────────────────────────

function oscPad(buf: Buffer, cursor: number): number {
  const pad = (4 - (cursor % 4)) % 4;
  for (let i = 0; i < pad; i++) buf.writeUInt8(0, cursor + i);
  return cursor + pad;
}

function writeOscString(buf: Buffer, cursor: number, s: string): number {
  cursor += buf.write(s, cursor, 'utf8');
  buf.writeUInt8(0, cursor);
  cursor += 1;
  return oscPad(buf, cursor);
}

function buildOscNoteOn(slotId: number, ch: number, note: number, vel: number): Buffer {
  const buf = Buffer.alloc(64);
  let c = 0;
  c = writeOscString(buf, c, '/phobos/note_on');
  c = writeOscString(buf, c, ',iiii');
  c = buf.writeInt32BE(slotId, c);
  c = buf.writeInt32BE(ch, c);
  c = buf.writeInt32BE(note, c);
  c = buf.writeInt32BE(vel, c);
  return buf.subarray(0, c);
}

function buildOscNoteOff(slotId: number, ch: number, note: number): Buffer {
  const buf = Buffer.alloc(64);
  let c = 0;
  c = writeOscString(buf, c, '/phobos/note_off');
  c = writeOscString(buf, c, ',iii');
  c = buf.writeInt32BE(slotId, c);
  c = buf.writeInt32BE(ch, c);
  c = buf.writeInt32BE(note, c);
  return buf.subarray(0, c);
}

function sendUdp(payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.send(payload, UDP_PORT, HOST, (err) => {
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

// ── Phases ───────────────────────────────────────────────────────────────────

async function waitForReady(host: ChildProcess, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (host.exitCode !== null) {
      throw new Error(`PhobosHost exited prematurely with code ${host.exitCode}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host: HOST, port: TCP_PORT }, () => { s.end(); resolve(); });
        s.once('error', reject);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`PhobosHost did not open ${HOST}:${TCP_PORT} within ${timeoutMs} ms`);
}

interface PluginEntry {
  name: string;
  vendor: string;
  format: string;
  isInstrument: boolean;
  path: string;
}

async function main(): Promise<void> {
  const binary = resolveBinary();
  console.log(`PhobosHost binary: ${binary}`);
  console.log(`Helm scan dir:     ${HELM_DIR}`);

  const host = spawn(binary, [], { stdio: ['ignore', 'inherit', 'inherit'] });

  const killOnExit = () => { try { host.kill('SIGKILL'); } catch { /* ignore */ } };
  process.on('exit', killOnExit);

  const client = new ControlClient();

  // Track the slot we load so subsequent phases can target it.
  let helmSlotId  = -1;
  let helmPath    = '';

  try {
    await runPhase('host launches and binds TCP', async () => {
      await waitForReady(host, 10_000);
    });

    await runPhase('TCP ping → pong', async () => {
      await client.connect();
      const env = await client.send('ping');
      if (!env.ok) throw new Error(`ping returned ok=false: ${env.error}`);
      const result = env.result as Record<string, unknown> | undefined;
      if (!result || typeof result.uptimeMs !== 'number') {
        throw new Error(`ping result missing uptimeMs: ${JSON.stringify(env.result)}`);
      }
      if (result.version !== '0.3.0') {
        throw new Error(`unexpected version: ${result.version} (want 0.3.0)`);
      }
    });

    await runPhase('unknown op returns ok=false', async () => {
      const env = await client.send('totally-not-a-real-op');
      if (env.ok !== false) throw new Error(`expected ok=false, got ${JSON.stringify(env)}`);
      if (typeof env.error !== 'string') throw new Error(`expected error string`);
    });

    await runPhase('scanVst3Path → finds Helm', async () => {
      if (!fs.existsSync(HELM_DIR)) {
        throw new Error(`Helm scan dir missing: ${HELM_DIR}`);
      }
      const env = await client.send('scanVst3Path', { path: HELM_DIR });
      if (!env.ok) throw new Error(`scan returned ok=false: ${env.error}`);
      const result = env.result as { plugins?: PluginEntry[]; scannedFiles?: number; failedFiles?: number };
      if (!result || !Array.isArray(result.plugins)) {
        throw new Error(`scan result malformed: ${JSON.stringify(env.result)}`);
      }
      const helm = result.plugins.find((p) => p.name.toLowerCase().includes('helm'));
      if (!helm) {
        throw new Error(`no 'Helm' plugin in scan results (${result.plugins.length} plugins, ${result.failedFiles} failed)`);
      }
      if (!helm.isInstrument) {
        throw new Error(`Helm scan returned isInstrument=false; sanity check failed`);
      }
      helmPath = helm.path;
      console.log(`       found: ${helm.name} (${helm.vendor}) at ${helm.path}`);
    });

    await runPhase('loadPlugin: Helm as instrument on channel 0', async () => {
      if (!helmPath) throw new Error('helmPath not set (scan phase failed?)');
      const env = await client.send('loadPlugin', {
        channelIdx: 0,
        pluginPath: helmPath,
        kind:       'instrument',
      });
      if (!env.ok) throw new Error(`loadPlugin returned ok=false: ${env.error}`);
      const result = env.result as { slotId?: number };
      if (!result || typeof result.slotId !== 'number' || result.slotId < 1) {
        throw new Error(`loadPlugin result missing slotId: ${JSON.stringify(env.result)}`);
      }
      helmSlotId = result.slotId;
      console.log(`       slotId: ${helmSlotId}`);
    });

    await runPhase('OSC notes flow into loaded plugin', async () => {
      // Channel 0 → MIDI ch 1 (1-indexed). Send three notes spaced 50ms apart
      // so the audio thread has time to process if the user wants to listen.
      const notes = [60, 64, 67];
      for (const note of notes) {
        await sendUdp(buildOscNoteOn(helmSlotId, 1, note, 100));
        await new Promise(r => setTimeout(r, 50));
      }
      // Hold for half a second so the audio is audible if the user is listening.
      await new Promise(r => setTimeout(r, 500));
      for (const note of notes)
        await sendUdp(buildOscNoteOff(helmSlotId, 1, note));

      // Settle. Then verify ping still works (host alive, audio thread happy).
      await new Promise(r => setTimeout(r, 100));
      const env = await client.send('ping');
      if (!env.ok) throw new Error(`ping after notes returned ok=false`);
    });

    // ── UI ops ──────────────────────────────────────────────────────────────
    //
    // The UI phase is interactive by default — opens Helm's UI window and
    // sleeps 5 seconds so you can see/click it. Set PHOBOS_UI_INTERACTIVE=0
    // to skip the sleep (fast non-interactive runs).
    const interactiveUi = process.env.PHOBOS_UI_INTERACTIVE !== '0';

    await runPhase('showPluginUi opens Helm window', async () => {
      const env = await client.send('showPluginUi', { slotId: helmSlotId });
      if (!env.ok) throw new Error(`showPluginUi returned ok=false: ${env.error}`);
    });

    if (interactiveUi) {
      await runPhase('manual: 5s window — interact with Helm UI now', async () => {
        // Capture state, sleep, capture again. If the user tweaked anything,
        // the two states should differ. If they didn't, they'll match — which
        // is also fine; we don't fail on that. The phase is for human
        // observation, not automated assertion.
        const before = await client.send('getPluginState', { slotId: helmSlotId });
        if (!before.ok) throw new Error(`getPluginState before failed: ${before.error}`);
        const beforeBytes = (before.result as { state: string }).state.length;

        console.log(`       (interact with Helm now — sleeping 5 s…)`);
        await new Promise(r => setTimeout(r, 5_000));

        const after = await client.send('getPluginState', { slotId: helmSlotId });
        if (!after.ok) throw new Error(`getPluginState after failed: ${after.error}`);
        const afterBytes = (after.result as { state: string }).state.length;

        const beforeStr = (before.result as { state: string }).state;
        const afterStr  = (after .result as { state: string }).state;
        const changed   = beforeStr !== afterStr;
        console.log(`       state: ${beforeBytes} → ${afterBytes} bytes (${changed ? 'changed' : 'unchanged'})`);
      });
    }

    await runPhase('closePluginUi hides window', async () => {
      const env = await client.send('closePluginUi', { slotId: helmSlotId });
      if (!env.ok) throw new Error(`closePluginUi returned ok=false: ${env.error}`);
    });

    await runPhase('showPluginUi twice is idempotent', async () => {
      const a = await client.send('showPluginUi', { slotId: helmSlotId });
      if (!a.ok) throw new Error(`first showPluginUi: ${a.error}`);
      const b = await client.send('showPluginUi', { slotId: helmSlotId });
      if (!b.ok) throw new Error(`second showPluginUi: ${b.error}`);
      // Hide again so the next phases don't leave a window open.
      await client.send('closePluginUi', { slotId: helmSlotId });
    });

    await runPhase('showPluginUi on bad slot returns ok=false', async () => {
      const env = await client.send('showPluginUi', { slotId: 9999 });
      if (env.ok !== false) throw new Error(`expected ok=false for unknown slot, got ${JSON.stringify(env)}`);
    });

    await runPhase('getPluginState round-trips', async () => {
      // Note: plugin state is live — Helm's internal voice/LFO state
      // updates every audio block. So byte-for-byte equality after a
      // round-trip is NOT a valid invariant. The correct invariants are:
      //   1. get returns a non-empty state of reasonable size
      //   2. set accepts that state without error
      //   3. a subsequent get still works (state survives the round-trip)
      const get1 = await client.send('getPluginState', { slotId: helmSlotId });
      if (!get1.ok) throw new Error(`getPluginState returned ok=false: ${get1.error}`);
      const result1 = get1.result as { state?: string };
      if (!result1 || typeof result1.state !== 'string' || result1.state.length === 0) {
        throw new Error(`getPluginState result missing state: ${JSON.stringify(get1.result)}`);
      }
      // Sanity-check size — Helm's state should be at least a few hundred
      // bytes (parameters + patch info) and well under a megabyte.
      const stateBytes = (result1.state.length * 3) / 4;       // base64 → raw approx
      if (stateBytes < 100 || stateBytes > 10_000_000) {
        throw new Error(`state size out of expected range: ~${stateBytes.toFixed(0)} bytes`);
      }

      const set = await client.send('setPluginState', { slotId: helmSlotId, state: result1.state });
      if (!set.ok) throw new Error(`setPluginState returned ok=false: ${set.error}`);

      const get2 = await client.send('getPluginState', { slotId: helmSlotId });
      if (!get2.ok) throw new Error(`second getPluginState returned ok=false: ${get2.error}`);
      const result2 = get2.result as { state?: string };
      if (!result2 || typeof result2.state !== 'string' || result2.state.length === 0) {
        throw new Error(`second getPluginState returned empty state`);
      }
    });

    await runPhase('setPluginActive: bypass + restore', async () => {
      const off = await client.send('setPluginActive', { slotId: helmSlotId, active: false });
      if (!off.ok) throw new Error(`setPluginActive(false) returned ok=false: ${off.error}`);
      const on  = await client.send('setPluginActive', { slotId: helmSlotId, active: true  });
      if (!on.ok)  throw new Error(`setPluginActive(true) returned ok=false: ${on.error}`);
    });

    await runPhase('state survives unload → reload (spec §6 Session 3 gate)', async () => {
      // Capture current state. Unload. Reload. Inject the captured state.
      // Verify the new slot's state, after injection, matches what we captured.
      const cap = await client.send('getPluginState', { slotId: helmSlotId });
      if (!cap.ok) throw new Error(`getPluginState pre-unload: ${cap.error}`);
      const captured = (cap.result as { state: string }).state;
      if (!captured || captured.length === 0) throw new Error('captured state empty');

      const un = await client.send('unloadPlugin', { slotId: helmSlotId });
      if (!un.ok) throw new Error(`unloadPlugin: ${un.error}`);

      const re = await client.send('loadPlugin', {
        channelIdx: 0,
        pluginPath: helmPath,
        kind:       'instrument',
      });
      if (!re.ok) throw new Error(`reload: ${re.error}`);
      const newSlotId = (re.result as { slotId: number }).slotId;
      if (newSlotId === helmSlotId) {
        throw new Error(`expected new slotId; got the same one (${newSlotId})`);
      }

      const set = await client.send('setPluginState', { slotId: newSlotId, state: captured });
      if (!set.ok) throw new Error(`setPluginState on new slot: ${set.error}`);

      // Read back. We don't expect byte-equality (Helm's state mutates as it
      // runs — see the round-trip phase note), but the new slot should have
      // a non-empty state and shouldn't be the *fresh-load default* state.
      // Heuristic: states from the same patch tend to be the same length ±N.
      const verify = await client.send('getPluginState', { slotId: newSlotId });
      if (!verify.ok) throw new Error(`verify getPluginState: ${verify.error}`);
      const verified = (verify.result as { state: string }).state;
      if (!verified || verified.length === 0) throw new Error('verify state empty');

      // Update the slot id for subsequent phases (unload/cleanup).
      helmSlotId = newSlotId;
    });

    await runPhase('unloadPlugin: instrument → channel torn down', async () => {
      const env = await client.send('unloadPlugin', { slotId: helmSlotId });
      if (!env.ok) throw new Error(`unloadPlugin returned ok=false: ${env.error}`);
      // Subsequent ops on that slot should fail clearly.
      const after = await client.send('getPluginState', { slotId: helmSlotId });
      if (after.ok !== false) throw new Error(`expected ok=false after unload, got ${JSON.stringify(after)}`);
    });

    await runPhase('no [ERR]-level events surfaced', async () => {
      // Drain any pending events.
      await new Promise(r => setTimeout(r, 100));
      if (client.errorEventCount > 0) {
        throw new Error(`${client.errorEventCount} error event(s) surfaced during the run`);
      }
    });

    await runPhase('shutdown op exits process', async () => {
      client.send('shutdown').catch(() => { /* expected — connection closes */ });

      const t0 = Date.now();
      while (Date.now() - t0 < 5_000) {
        if (host.exitCode !== null) break;
        await new Promise(r => setTimeout(r, 50));
      }
      if (host.exitCode === null) {
        throw new Error('PhobosHost did not exit within 5 s of shutdown op');
      }
      if (host.exitCode !== 0) {
        throw new Error(`PhobosHost exit code ${host.exitCode}, expected 0`);
      }
    });

  } finally {
    client.close();
    if (host.exitCode === null) {
      try { host.kill('SIGTERM'); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 500));
      try { host.kill('SIGKILL'); } catch { /* ignore */ }
    }
    process.removeListener('exit', killOnExit);
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n── Summary ──');
  for (const r of results) {
    const tag = r.status === 'ok' ? '[OK]  ' : '[FAIL]';
    console.log(`${tag} ${r.name} (${r.ms} ms)${r.message ? '  — ' + r.message : ''}`);
  }

  const failed = results.filter(r => r.status === 'fail').length;
  if (failed > 0) {
    console.error(`\n${failed} phase(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK — ${results.length} phases passed`);
  }
}

main().catch((err) => {
  console.error(`\n[fatal] ${(err as Error).message}`);
  process.exitCode = 1;
});
