/**
 * PhobosHostManager.ts — Lifecycle manager for the PhobosHost binary.
 *
 * Replaces the prior CarlaManager. PhobosHost is the in-house JUCE-based VST3
 * host distributed as a single executable per platform. Wire contract is
 * documented in PHOBOS-PhobosHost-Spec.md and the Sessions 1–3 handoff.
 *
 * Layout on disk:
 *   Binary:   ~/.phobos/services/phobos-host/PhobosHost(.exe)
 *   Plugins:  ~/.phobos/services/phobos-host/plugins/   (bundled VST3s — Helm, Crystal)
 *
 * Wire surface:
 *   TCP/16332  control RPC (length-prefixed JSON, see PhobosHostControl)
 *   UDP/16331  OSC MIDI events (see OscClient)
 *
 * Lifecycle:
 *   - Lazy-start: PhobosHost is not spawned at PHOBOS boot. ensureRunning()
 *     spawns it on the first audio API request and leaves it running.
 *   - Stopped in PHASE 3 of server.ts shutdown (after DB close).
 *   - Stop sequence: send 'shutdown' op (graceful); fall back to SIGTERM →
 *     SIGKILL via SubprocessManager if the binary doesn't exit promptly.
 *
 * Threading: the host runs every op handler on its own message thread; from
 * the manager's side, requests and responses are correlated by id and the
 * persistent TCP socket is owned by PhobosHostControl. PhobosHostManager is
 * single-instance (module-level state) — there's only one host per process.
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import {
  makeManagedProcess,
  spawnProcess,
  stopProcess,
  type ManagedProcess,
  type SpawnConfig,
} from './SubprocessManager.js';
import { PhobosHostControl, type ServerEvent } from './PhobosHostControl.js';

// ── Wire constants ────────────────────────────────────────────────────────────

export const PHOBOS_HOST_TCP_PORT = 16332;
export const PHOBOS_HOST_UDP_PORT = 16331;
export const PHOBOS_HOST_HOST     = '127.0.0.1';

const READY_TIMEOUT_MS  = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the user's home directory honoring HOME/USERPROFILE at call time.
 *
 * Node's os.homedir() caches the result from system calls made at startup
 * and does NOT re-read HOME/USERPROFILE afterwards. Test harnesses that
 * override those env vars to redirect a scratch install must therefore get
 * a function that re-reads every time.
 */
function resolveHome(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  }
  return process.env.HOME ?? os.homedir();
}

export function resolveServiceDir(): string {
  return path.join(resolveHome(), '.phobos', 'services', 'phobos-host');
}

/** Bundled VST3 plugins (Helm, Crystal, etc.) ship into this directory. */
export function resolvePluginsDir(): string {
  return path.join(resolveServiceDir(), 'plugins');
}

export function resolveBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'PhobosHost.exe' : 'PhobosHost';
  return path.join(resolveServiceDir(), exe);
}

export function isBinaryPresent(): boolean {
  // Size threshold: PhobosHost is statically linked against JUCE; a real
  // build is several MB. Anything under 500 KB is a stub or truncated download.
  try { return fs.statSync(resolveBinaryPath()).size > 500_000; }
  catch { return false; }
}

// ── Plugin entry shape (mirrors host PluginScanner JSON output) ──────────────

export interface HostPluginEntry {
  name:         string;
  vendor:       string;
  version:      string;
  category:     string;
  format:       string;     // "VST3"
  isInstrument: boolean;
  numInputs:    number;
  numOutputs:   number;
  uid:          string;     // hex-formatted PluginDescription.uniqueId
  path:         string;
}

export interface ScanResult {
  plugins:      HostPluginEntry[];
  scannedFiles: number;
  failedFiles:  number;
}

export type PluginKind = 'instrument' | 'fx';

// ── Service state ─────────────────────────────────────────────────────────────

export type HostState = 'stopped' | 'starting' | 'running' | 'error';

interface HostService {
  managed:   ManagedProcess;
  control:   PhobosHostControl | null;
  state:     HostState;
  error:     string | null;
  startedAt: number | null;
  /** In-memory channelIdx → slotId mapping. Persisted version is Session 5. */
  channelSlots: Map<number, number>;
  /**
   * Slot ID of the Phobos synth — the always-mounted system instrument on
   * host channel 0. Held privately by the manager; the user-DAW frontend
   * never sees this value. Set during ensureRunning(); cleared on stop.
   */
  phobosSynthSlotId: number | null;
  /**
   * Slot ID of the Phobos Crystal — the global FX appended to channel 0's
   * FX chain after the synth. Same lifecycle as the synth (mounted during
   * ensureRunning, cleared on stop). The "Crystal Prism" toggle in Polaris
   * bypasses this slot to A/B the global FX.
   */
  phobosCrystalSlotId: number | null;
}

const service: HostService = {
  managed:             makeManagedProcess({ cmd: '', args: [] }),
  control:             null,
  state:               'stopped',
  error:               null,
  startedAt:           null,
  channelSlots:        new Map(),
  phobosSynthSlotId:   null,
  phobosCrystalSlotId: null,
};

// ── Phobos synth + Phobos Crystal ─────────────────────────────────────────────
//
// Channel 0 is the system audio channel. It's wired:
//
//     [Phobos synth]  →  [Phobos Crystal (global FX)]  →  device
//
// The synth is the always-mounted instrument PHOBOS uses for ALDA playback,
// background audio, and any non-DAW sound. It lives on channel 0's instrument
// slot, which is reserved by the host (loadPlugin rejects channelIdx 0 with
// kind=instrument; only loadPhobosSynth may target it).
//
// Phobos Crystal is the global FX layer. It sits at the tail of channel 0's
// FX chain. The "Crystal Prism" toggle in Polaris bypasses this slot to A/B
// the global FX without unloading it. Channel 0's FX slots are NOT reserved
// — eventually Polaris exposes user-added master FX that sit ahead of Crystal
// in the chain.
//
// User-DAW channels (1..N) are entirely separate; they don't pass through
// either of these slots.

/** Resolve the directory containing the Phobos synth's bundle. */
export function resolvePhobosSynthDir(): string {
  return path.join(resolveHome(), '.phobos', 'services', 'helm', 'VST3');
}

/** Resolve the directory containing the Phobos Crystal bundle. */
export function resolvePhobosCrystalDir(): string {
  return path.join(resolveHome(), '.phobos', 'services', 'phobos-host', 'plugins');
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

interface StartOptions {
  /**
   * Override the binary path for tests that deploy to a scratch location.
   * Production callers pass nothing — resolveBinaryPath() is used.
   */
  binaryOverride?: string;
}

/**
 * Spawn PhobosHost if not already running. Idempotent — concurrent callers
 * await the same in-flight start. Throws if the binary is missing or the
 * spawn fails.
 */
export async function ensureRunning(opts: StartOptions = {}): Promise<void> {
  if (service.state === 'running') return;
  if (service.state === 'starting') {
    // Another caller is already starting. Wait for them.
    if (service.managed.readyPromise) {
      await service.managed.readyPromise;
      return;
    }
  }

  const binary = opts.binaryOverride ?? resolveBinaryPath();
  if (!fs.existsSync(binary)) {
    service.state = 'error';
    service.error = `PhobosHost binary not found at ${binary}. Run DepPrep or scripts/fetch-phobos-host.js.`;
    throw new Error(service.error);
  }

  service.state = 'starting';
  service.error = null;

  const cfg: SpawnConfig = {
    cmd:            binary,
    args:           [],
    env:            {},
    port:           PHOBOS_HOST_TCP_PORT,
    readyTimeoutMs: READY_TIMEOUT_MS,
  };

  try {
    await spawnProcess(service.managed, cfg, 'phobos-host');
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    throw err;
  }

  // Wire up the control connection. The TCP listener is open as of
  // spawnProcess resolving (port-probe success = listener up).
  const control = new PhobosHostControl(PHOBOS_HOST_HOST, PHOBOS_HOST_TCP_PORT);
  control.addEventListener(handleServerEvent);
  try {
    await control.connect();
  } catch (err) {
    service.state = 'error';
    service.error = `control connect failed: ${(err as Error).message}`;
    await stopProcess(service.managed, 'phobos-host', SHUTDOWN_GRACE_MS).catch(() => {});
    throw err;
  }

  service.control   = control;
  service.state     = 'running';
  service.startedAt = Date.now();
  console.log(`[PhobosHostManager] ready — TCP ${PHOBOS_HOST_HOST}:${PHOBOS_HOST_TCP_PORT}, OSC :${PHOBOS_HOST_UDP_PORT}`);

  // Mount the system audio chain on channel 0: Phobos synth (instrument)
  // followed by Phobos Crystal (global FX). This is part of the baseline
  // contract — every running host has a synth and a Crystal mounted. If
  // either fails, tear the host down and surface the error to the caller;
  // a half-mounted system chain is not a state any consumer should observe.
  try {
    await mountPhobosSystemChain();
  } catch (err) {
    service.state = 'error';
    service.error = `phobos system chain mount failed: ${(err as Error).message}`;
    if (service.control) {
      service.control.close();
      service.control = null;
    }
    await stopProcess(service.managed, 'phobos-host', SHUTDOWN_GRACE_MS).catch(() => {});
    throw new Error(service.error);
  }
}

// ── System chain mount (private helpers) ────────────────────────────────────

/**
 * Mount the Phobos system audio chain on channel 0:
 *   Phobos synth (Helm)  →  Phobos Crystal (global FX)  →  device output
 *
 * Both slots are recorded privately so subsequent ops (note emit, UI show,
 * bypass toggle) can address them. Throws on any failure — caller treats
 * throw as a fatal boot error.
 */
async function mountPhobosSystemChain(): Promise<void> {
  await mountPhobosSynth();
  await mountPhobosCrystal();
}

/**
 * Find the Phobos synth bundle on disk (via host-side scanVst3Path), then
 * load it onto the reserved channel 0 instrument slot with the
 * loadPhobosSynth op.
 */
async function mountPhobosSynth(): Promise<void> {
  if (!service.control || service.state !== 'running') {
    throw new Error('host not running');
  }

  const synthDir = resolvePhobosSynthDir();
  if (!fs.existsSync(synthDir)) {
    throw new Error(`synth directory missing: ${synthDir}. Run scripts/fetch-helm.js.`);
  }

  // Use the host's own scanner — it understands platform-specific bundle
  // shapes and returns the exact path to feed back to loadPhobosSynth.
  const scan = await service.control.call<{
    plugins: HostPluginEntry[];
    scannedFiles: number;
    failedFiles: number;
  }>('scanVst3Path', { path: synthDir }, 60_000);

  const synth = scan.plugins.find((p) => p.isInstrument);
  if (!synth) {
    throw new Error(
      `no instrument plugin found in ${synthDir} (scanned ${scan.scannedFiles}, ${scan.failedFiles} failed)`,
    );
  }

  const result = await service.control.call<{ slotId: number }>(
    'loadPhobosSynth',
    { pluginPath: synth.path },
    60_000,
  );

  service.phobosSynthSlotId = result.slotId;
  console.log(`[PhobosHostManager] phobos synth mounted: ${synth.name} (slot=${result.slotId})`);
}

/**
 * Find the Phobos Crystal bundle on disk and append it as FX to channel 0.
 * Symmetric to mountPhobosSynth but for the global-FX role.
 */
async function mountPhobosCrystal(): Promise<void> {
  if (!service.control || service.state !== 'running') {
    throw new Error('host not running');
  }

  const crystalDir = resolvePhobosCrystalDir();
  if (!fs.existsSync(crystalDir)) {
    throw new Error(
      `crystal directory missing: ${crystalDir}. Run scripts/fetch-crystal.js.`,
    );
  }

  // Crystal lives in the shared phobos-host plugins dir. The scanner walks
  // the directory; we pick the first non-instrument result, since Crystal
  // is the only FX bundled there. (If we ever ship multiple bundled FX,
  // identify Crystal by name explicitly.)
  const scan = await service.control.call<{
    plugins: HostPluginEntry[];
    scannedFiles: number;
    failedFiles: number;
  }>('scanVst3Path', { path: crystalDir }, 60_000);

  const crystal = scan.plugins.find((p) => p.name.toLowerCase().includes('crystal'));
  if (!crystal) {
    throw new Error(
      `no PhobosCrystal plugin found in ${crystalDir} (scanned ${scan.scannedFiles}, ${scan.failedFiles} failed)`,
    );
  }

  const result = await service.control.call<{ slotId: number }>(
    'loadPhobosCrystal',
    { pluginPath: crystal.path },
    60_000,
  );

  service.phobosCrystalSlotId = result.slotId;
  console.log(`[PhobosHostManager] phobos crystal mounted: ${crystal.name} (slot=${result.slotId})`);

  // Crystal boots active by default in the host. Bypass it immediately so
  // audio passes through dry until the user explicitly enables it.
  await setPhobosCrystalActive(false);
}

/**
 * Stop PhobosHost cleanly. Tries the 'shutdown' op first (which lets the host
 * tear down audio + plugins before exiting), then falls back to SIGTERM →
 * SIGKILL via SubprocessManager.
 */
export async function stopPhobosHost(): Promise<void> {
  const control = service.control;

  if (control && control.isConnected()) {
    // Best-effort graceful shutdown. The op resolves with ok=true and then the
    // host closes the socket as it exits — which we handle as a normal close.
    // If anything throws, fall through to the kill path.
    try {
      // Don't await for a response — the host exits before responding sometimes.
      // Instead, send and wait briefly for the process to exit, then kill.
      control.send('shutdown', {}, 2_000).catch(() => { /* expected on socket close */ });
    } catch {
      // ignore — we kill below regardless
    }
  }

  if (control) {
    control.close();
    service.control = null;
  }

  await stopProcess(service.managed, 'phobos-host', SHUTDOWN_GRACE_MS);
  service.state               = 'stopped';
  service.error               = null;
  service.startedAt           = null;
  service.channelSlots.clear();
  service.phobosSynthSlotId   = null;
  service.phobosCrystalSlotId = null;
}

// ── Event routing ────────────────────────────────────────────────────────────

/**
 * Server-initiated events from the host. Currently the only event the host
 * emits is `log` with `{ level: 0|1|2, message }` — levels 0=Info, 1=Warn,
 * 2=Error. Forward these to stderr with a uniform prefix so they show up in
 * the same output stream as the binary's own stderr.
 */
function handleServerEvent(event: ServerEvent): void {
  if (event.evt !== 'log') return;
  const level   = typeof event.level   === 'number' ? event.level   : 0;
  const message = typeof event.message === 'string' ? event.message : '';
  const tag = level >= 2 ? 'ERR' : level === 1 ? 'WARN' : 'INFO';
  process.stderr.write(`[phobos-host:${tag}] ${message}\n`);
}

// ── Event subscription (passthrough to Control) ──────────────────────────────

/**
 * Subscribe to server-initiated events from the host (currently `log` events
 * from PluginScanner / DawGraph / etc.). Listeners run on the Node main
 * thread alongside op handlers. Errors thrown by listeners are caught inside
 * Control to prevent one bad subscriber from breaking event delivery.
 *
 * Returns a no-op disposer if the host is not running yet — the caller should
 * subscribe AFTER `ensureRunning()` resolves to actually attach.
 */
export function addServerEventListener(fn: (event: ServerEvent) => void): () => void {
  if (!service.control) return () => {};
  service.control.addEventListener(fn);
  return () => service.control?.removeEventListener(fn);
}

// ── Op surface (typed methods for every host op) ─────────────────────────────

function requireControl(): PhobosHostControl {
  if (!service.control || service.state !== 'running') {
    throw new Error(`PhobosHost is not running (state=${service.state})`);
  }
  return service.control;
}

export async function ping(): Promise<{ uptimeMs: number; version: string }> {
  const result = await requireControl().call<{ uptimeMs: number; version: string }>('ping');
  return result;
}

export async function scanVst3Path(scanPath: string): Promise<ScanResult> {
  const result = await requireControl().call<{
    plugins:      HostPluginEntry[];
    scannedFiles: number;
    failedFiles:  number;
  }>('scanVst3Path', { path: scanPath }, 60_000);  // scans can be slow with many plugins
  return result;
}

/**
 * Single-file deep probe — used by the TS-side filesystem scanner to fill in
 * `category` and `isInstrument` for plugins whose moduleinfo.json was missing
 * or didn't carry the metadata. The host's JUCE deep-probe
 * (findAllTypesForFile) loads the bundle, instantiates the IPluginFactory,
 * walks classes, and unloads — milliseconds per plugin in practice.
 *
 * Returns an empty `plugins` array and `failed: true` if the file isn't a
 * loadable VST3 (broken bundle, wrong arch, etc.). Callers should treat that
 * as "this plugin is not usable" and exclude it from listings.
 */
export async function scanFile(vst3Path: string): Promise<{ plugins: HostPluginEntry[]; failed: boolean }> {
  const result = await requireControl().call<{
    plugins: HostPluginEntry[];
    failed:  boolean;
  }>('scanFile', { path: vst3Path }, 30_000);     // single-file probe is fast
  return result;
}

/**
 * Instantiate a plugin into a channel chain. Returns the host-assigned slotId
 * (monotonically increasing, never reused). The mapping is also recorded in
 * the in-memory channelSlots map for instrument loads, so subsequent ops on
 * that channel can address the slot without callers having to retain it.
 *
 * Note: slotId is NOT persistent across host restarts. Persistent state lives
 * in the session JSON via pluginRef { uid, path } — see Session 5.
 */
export async function loadPlugin(args: {
  channelIdx: number;
  pluginPath: string;
  kind:       PluginKind;
  fxIndex?:   number;
}): Promise<{ slotId: number }> {
  if (args.channelIdx < 0) {
    throw new Error(`channelIdx must be >= 0 (got ${args.channelIdx})`);
  }
  // The Phobos synth instrument slot on channel 0 is reserved. FX slots
  // on channel 0 are not — the system-bus FX chain (Phobos Crystal and any
  // future user-mounted master FX from Polaris) lives there. The host
  // enforces this too; rejecting at the manager edge produces a clearer
  // error and saves a round-trip. Routes layer additionally restricts
  // /api/audio/host/load-plugin to channelIdx >= 1 — that's where the
  // user-DAW boundary lives.
  if (args.channelIdx === 0 && args.kind === 'instrument') {
    throw new Error('channel 0 instrument is reserved for the Phobos synth');
  }

  const wireArgs: Record<string, unknown> = {
    channelIdx: args.channelIdx,
    pluginPath: args.pluginPath,
    kind:       args.kind,
  };
  if (args.fxIndex !== undefined) wireArgs.fxIndex = args.fxIndex;

  const result = await requireControl().call<{ slotId: number }>('loadPlugin', wireArgs, 60_000);

  if (args.kind === 'instrument') {
    service.channelSlots.set(args.channelIdx, result.slotId);
  }
  return result;
}

export async function unloadPlugin(slotId: number): Promise<void> {
  await requireControl().call('unloadPlugin', { slotId });

  // If this was an instrument slot we tracked, drop it from the map.
  for (const [chIdx, sId] of service.channelSlots) {
    if (sId === slotId) { service.channelSlots.delete(chIdx); break; }
  }
}

export async function setPluginActive(slotId: number, active: boolean): Promise<void> {
  await requireControl().call('setPluginActive', { slotId, active });
}

export async function reorderFx(slotId: number, newFxIndex: number): Promise<void> {
  await requireControl().call('reorderFx', { slotId, newFxIndex });
}

export async function getPluginState(slotId: number): Promise<string> {
  const result = await requireControl().call<{ state: string }>('getPluginState', { slotId });
  return result.state;
}

export async function setPluginState(slotId: number, state: string): Promise<void> {
  await requireControl().call('setPluginState', { slotId, state });
}

export async function showPluginUi(slotId: number): Promise<void> {
  await requireControl().call('showPluginUi', { slotId });
}

export async function closePluginUi(slotId: number): Promise<void> {
  await requireControl().call('closePluginUi', { slotId });
}

// ── Sequencer ─────────────────────────────────────────────────────────────────
//
// Tick-space MIDI sequence playback through the host's SchedulerNode. Used by
// AldaPlayer (and any future tick-emitting source) to play events on a
// specific instrument slot. The host resolves slot → channel → midiChannel
// internally; callers don't have to know the wire-MIDI mapping.
//
// Sequence ids are monotonic and never reused. A returned sequenceId stays
// valid until either (a) the sequence completes naturally, (b) stopSequence
// is called, or (c) the target slot is unloaded (auto-cancellation).

/**
 * Wire shape mirroring SchedulerNode::MidiEvent on the host side. The host
 * accepts ALDA's tick-space events directly; conversion to samples happens
 * on the host using the device's actual sample rate.
 */
export interface SequencerMidiEvent {
  /** 0–127. */
  midiNote: number;
  /** 0–127. */
  velocity: number;
  /** Absolute tick offset from the start of the sequence. */
  startTicks: number;
  /** Tick-space duration; must be > 0. */
  durationTicks: number;
}

export async function playMidiSequence(args: {
  slotId:       number;
  events:       SequencerMidiEvent[];
  ticksPerBeat: number;
  tempoBpm:     number;
}): Promise<{ sequenceId: number }> {
  if (args.slotId < 0)             throw new Error(`slotId must be >= 0 (got ${args.slotId})`);
  if (args.ticksPerBeat <= 0)      throw new Error(`ticksPerBeat must be > 0`);
  if (args.tempoBpm <= 0)          throw new Error(`tempoBpm must be > 0`);
  if (!Array.isArray(args.events)) throw new Error(`events must be an array`);

  const result = await requireControl().call<{ sequenceId: number }>(
    'playMidiSequence',
    {
      slotId:       args.slotId,
      events:       args.events,
      ticksPerBeat: args.ticksPerBeat,
      tempoBpm:     args.tempoBpm,
    },
  );
  return result;
}

export async function stopSequence(sequenceId: number): Promise<void> {
  await requireControl().call('stopSequence', { sequenceId });
}

// ── File player ──────────────────────────────────────────────────────────────
//
// Audio file playback through the host's FilePlayerNode. Multiple files can
// play concurrently; each gets a monotonic audioId. The host decodes via JUCE
// (WAV/AIFF/FLAC/OGG/MP3 supported by registerBasicFormats) and routes audio
// into channel 0's audioSumNode — the same mix point the synth feeds — so the
// audio flows through Phobos Crystal alongside any synth output.
//
// audioIds share no namespace with slotIds. Frontend code that holds both
// must keep them separate; the manager doesn't validate cross-confusion.

export interface AudioStatus {
  playing:    boolean;
  positionMs: number;
  durationMs: number;
  finished:   boolean;
}

/**
 * Play an audio file through the host. Path is server-relative — the host
 * needs to be able to read the file from its own filesystem view (typically
 * the same machine as the backend).
 */
export async function playAudioFile(args: {
  path:     string;
  startMs?: number;
  loop?:    boolean;
}): Promise<{ audioId: number; durationMs: number }> {
  if (typeof args.path !== 'string' || args.path.length === 0) {
    throw new Error('playAudioFile: path must be a non-empty string');
  }
  const wireArgs: Record<string, unknown> = { path: args.path };
  if (args.startMs !== undefined) wireArgs.startMs = args.startMs;
  if (args.loop    !== undefined) wireArgs.loop    = args.loop;

  // File decode + reader-thread spinup happens host-side; give it room.
  return await requireControl().call<{ audioId: number; durationMs: number }>(
    'playAudioFile', wireArgs, 30_000,
  );
}

export async function pauseAudio(audioId: number): Promise<void> {
  await requireControl().call('pauseAudio', { audioId });
}

export async function resumeAudio(audioId: number): Promise<void> {
  await requireControl().call('resumeAudio', { audioId });
}

export async function seekAudio(audioId: number, positionMs: number): Promise<void> {
  await requireControl().call('seekAudio', { audioId, positionMs });
}

export async function stopAudio(audioId: number): Promise<void> {
  await requireControl().call('stopAudio', { audioId });
}

export async function setAudioFileVolume(audioId: number, gain: number): Promise<void> {
  await requireControl().call('setAudioFileVolume', { audioId, gain });
}

export async function getAudioStatus(audioId: number): Promise<AudioStatus> {
  return await requireControl().call<AudioStatus>('getAudioStatus', { audioId });
}

// ── Phobos synth public surface ──────────────────────────────────────────────
//
// Backend modules (ALDA emit, system-audio APIs, the Polaris hidden button)
// use these to interact with the Phobos synth without ever seeing the
// underlying slotId or knowing the synth is "really just" a plugin on a
// reserved channel. The slotId itself stays private to the manager.

/**
 * Slot ID of the resident Phobos synth, or null if it isn't mounted yet
 * (the host isn't running, or mountPhobosSynth is in flight). Caller code
 * that needs to emit OSC notes to the synth uses this to address the OSC
 * `slotId` field; the OSC `midiChannel` field is always 1 (channel 0 + 1).
 */
export function getPhobosSynthSlotId(): number | null {
  return service.phobosSynthSlotId;
}

/**
 * Open the Phobos synth's native UI window. Wired into the hidden Polaris
 * developer button — lets the user inspect / tweak the synth's parameters
 * directly. No-ops cleanly if the synth isn't mounted.
 */
export async function showPhobosSynthUi(): Promise<void> {
  const slotId = service.phobosSynthSlotId;
  if (slotId === null) throw new Error('phobos synth not mounted');
  await requireControl().call('showPluginUi', { slotId });
}

export async function closePhobosSynthUi(): Promise<void> {
  const slotId = service.phobosSynthSlotId;
  if (slotId === null) throw new Error('phobos synth not mounted');
  await requireControl().call('closePluginUi', { slotId });
}

// ── Phobos Crystal public surface ────────────────────────────────────────────
//
// The Crystal global FX sits at the tail of channel 0's FX chain. The Polaris
// "Crystal Prism" toggle bypasses it without unloading. Future Polaris UI
// also exposes Crystal's parameter window via showPhobosCrystalUi.
//
// As with the synth, the slotId is held privately. Frontend code goes through
// the typed surface here (or the corresponding REST routes) rather than ever
// learning the underlying slotId.

/** Slot ID of the resident Phobos Crystal, or null if it isn't mounted. */
export function getPhobosCrystalSlotId(): number | null {
  return service.phobosCrystalSlotId;
}

/**
 * Bypass or re-engage Phobos Crystal. Bypass routes audio around the FX
 * unchanged (the Polaris "Crystal Prism" off state); active re-engages
 * processing.
 */
export async function setPhobosCrystalActive(active: boolean): Promise<void> {
  const slotId = service.phobosCrystalSlotId;
  if (slotId === null) throw new Error('phobos crystal not mounted');
  await requireControl().call('setPluginActive', { slotId, active });
}

/** Open Crystal's native UI window. */
export async function showPhobosCrystalUi(): Promise<void> {
  const slotId = service.phobosCrystalSlotId;
  if (slotId === null) throw new Error('phobos crystal not mounted');
  await requireControl().call('showPluginUi', { slotId });
}

export async function closePhobosCrystalUi(): Promise<void> {
  const slotId = service.phobosCrystalSlotId;
  if (slotId === null) throw new Error('phobos crystal not mounted');
  await requireControl().call('closePluginUi', { slotId });
}

/**
 * Set a single Crystal parameter by its APVTS string ID.
 *
 * `value` is normalised [0.0, 1.0] — the same space JUCE uses for all
 * parameter automation. The caller is responsible for converting from
 * user-facing units before calling here:
 *
 *   - Boolean params (e.g. chordDetect): 0.0 = false, 1.0 = true
 *   - Choice params (e.g. mode, chordType): index / (numChoices - 1)
 *   - Linear [0..1] params (e.g. depth, spread): pass directly
 *   - Non-linear params (attack ms, filterQ, etc.): use the APVTS
 *     NormalisableRange from Parameters.h as reference — JUCE normalises
 *     internally, but preset values stored in EffectRackStore must already
 *     be in [0..1] normalised form to be passed here.
 *
 * The host op is O(N) over Crystal's ~40 parameters. This is an effect-rack
 * preset switch path, not an audio-rate path — the cost is negligible.
 */
export async function setCrystalParam(paramId: string, value: number): Promise<void> {
  const slotId = service.phobosCrystalSlotId;
  if (slotId === null) throw new Error('phobos crystal not mounted');
  if (value < 0 || value > 1) {
    throw new Error(`setCrystalParam: value must be in [0, 1] (got ${value} for '${paramId}')`);
  }
  await requireControl().call('setPluginParam', { slotId, paramId, value });
}

export interface EqBandState {
  gainDb:  number;   // ±18 dB
  q:       number;   // 0.1 – 10.0 (shelf bands ignore Q)
  enabled: boolean;
}

export interface EqState {
  enabled: boolean;
  bands:   EqBandState[];
}

/** Fixed centre frequencies matching EqNode.h FREQS[] — index is the band index. */
export const EQ_BAND_FREQS = [60, 120, 250, 500, 1000, 3000, 8000, 16000] as const;

/**
 * Set one band of the master EQ.
 * gainDb: ±18 dB  |  q: 0.1–10  |  enabled: per-band bypass
 * Bands 0 and 7 are shelf filters; Q is accepted but has reduced audible effect.
 */
export async function setEqBand(
  band: number,
  params: EqBandState,
): Promise<void> {
  if (band < 0 || band > 7) throw new Error(`setEqBand: band must be 0-7 (got ${band})`);
  if (params.gainDb < -18 || params.gainDb > 18) {
    throw new Error(`setEqBand: gainDb must be in [-18, 18] (got ${params.gainDb})`);
  }
  if (params.q < 0.1 || params.q > 10) {
    throw new Error(`setEqBand: q must be in [0.1, 10] (got ${params.q})`);
  }
  await requireControl().call('setEqBand', {
    band,
    gainDb:  params.gainDb,
    q:       params.q,
    enabled: params.enabled,
  });
}

/** Master EQ on/off — bypasses the entire EqNode without touching band state. */
export async function setEqEnabled(enabled: boolean): Promise<void> {
  await requireControl().call('setEqEnabled', { enabled });
}

/** Read full EQ state (all 8 bands + master enabled). */
export async function getEqState(): Promise<EqState> {
  return requireControl().call<EqState>('getEqState', {});
}

// ── Channel ↔ slot mapping (in-memory; Session 5 persists this) ──────────────

/**
 * Read the instrument slot for a channel, or null if no instrument is loaded.
 * Source of truth for the smoke path; production flow goes through session JSON.
 */
export function getChannelInstrumentSlot(channelIdx: number): number | null {
  return service.channelSlots.get(channelIdx) ?? null;
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface HostStatus {
  state:                 HostState;
  pid:                   number | null;
  tcpPort:               number;
  udpPort:               number;
  uptimeMs:              number | null;
  error:                 string | null;
  binaryPresent:         boolean;
  phobosSynthSlotId:     number | null;
  phobosSynthMounted:    boolean;
  phobosCrystalSlotId:   number | null;
  phobosCrystalMounted:  boolean;
}

export function getStatus(): HostStatus {
  return {
    state:                service.state,
    pid:                  service.managed.process?.pid ?? null,
    tcpPort:              PHOBOS_HOST_TCP_PORT,
    udpPort:              PHOBOS_HOST_UDP_PORT,
    uptimeMs:             service.startedAt ? Date.now() - service.startedAt : null,
    error:                service.error,
    binaryPresent:        isBinaryPresent(),
    phobosSynthSlotId:    service.phobosSynthSlotId,
    phobosSynthMounted:   service.phobosSynthSlotId !== null,
    phobosCrystalSlotId:  service.phobosCrystalSlotId,
    phobosCrystalMounted: service.phobosCrystalSlotId !== null,
  };
}
