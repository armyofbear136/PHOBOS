/**
 * DawApi.ts — REST client for the PHOBOS audio backend.
 *
 * Hits the audio routes documented in phobos-core/routes/audio.ts:
 *   /api/audio/host/*      — PhobosHost lifecycle + plugin ops (channel >= 1)
 *   /api/audio/synth/*     — Phobos synth (system instrument on channel 0)
 *   /api/audio/crystal/*   — Phobos Crystal (global FX on channel 0)
 *   /api/audio/plugins     — VST3 catalog from the filesystem scanner
 *   /api/audio/daw/*       — project + session CRUD
 *   /api/audio/alda/*      — ALDA → MIDI compile + play through Phobos synth
 *   /api/audio/player/*    — file playback (Polaris audio + future game audio)
 *
 * Vite proxies /api/* to http://localhost:3001 in dev, so relative URLs work
 * from both the dev server and the production build served by Fastify itself.
 *
 * Architecture notes for callers:
 *
 *   • Slot identity. Plugin operations target a `slotId` returned by
 *     `loadPlugin`. Slot IDs are host-assigned, monotonically increasing,
 *     never reused, and NOT persistent across host restarts. Persist the
 *     `pluginRef` ({ uid, path }) in session JSON instead.
 *
 *   • Reserved channel. Host channel 0 is the system audio chain
 *     (Phobos synth → Phobos Crystal → device). User-DAW channels start
 *     at 1. The host rejects loadPlugin against channel 0 with
 *     kind=instrument; the route layer additionally rejects the entire
 *     channel-0 namespace from /api/audio/host/load-plugin.
 *
 *   • Synth + Crystal slot IDs are deliberately not exposed to the UI —
 *     Polaris controls them via the typed /api/audio/synth/* and
 *     /api/audio/crystal/* routes, which the manager resolves internally.
 */

import type { EffluxSong } from '@/components/audio/engine/model/types/song';

// ── Engine base URL ──────────────────────────────────────────────────────────
// In dev, Vite proxies /api → localhost:3001, so ENGINE_BASE is empty and
// relative paths work. In production (served from autarch.net), phobos-core
// runs locally and the browser must reach it directly. VITE_ENGINE_URL is
// set to http://localhost:3001 in .env.local and carried through the build.
const ENGINE_BASE = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/g, '');

// ── Shared parse helper ─────────────────────────────────────────────────────

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
  }
  return res.json() as Promise<T>;
}

// ── PhobosHost lifecycle + status ───────────────────────────────────────────

export interface HostStatus {
  state:                'stopped' | 'starting' | 'running' | 'error';
  pid:                  number | null;
  tcpPort:              number;
  udpPort:              number;
  uptimeMs:             number | null;
  error:                string | null;
  binaryPresent:        boolean;
  phobosSynthSlotId:    number | null;
  phobosSynthMounted:   boolean;
  phobosCrystalSlotId:  number | null;
  phobosCrystalMounted: boolean;
}

export async function getHostStatus(): Promise<HostStatus> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/status');
  return parseOrThrow<HostStatus>(res);
}

export async function startHost(): Promise<HostStatus> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/start', { method: 'POST' });
  const body = await parseOrThrow<{ ok: boolean; status: HostStatus }>(res);
  return body.status;
}

export async function stopHost(): Promise<HostStatus> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/stop', { method: 'POST' });
  const body = await parseOrThrow<{ ok: boolean; status: HostStatus }>(res);
  return body.status;
}

// ── PhobosHost plugin ops (channel >= 1) ────────────────────────────────────

export type PluginKind = 'instrument' | 'fx';

export interface ScanPluginEntry {
  name:         string;
  vendor:       string;
  version:      string;
  category:     string;
  format:       string;       // "VST3"
  isInstrument: boolean;
  numInputs:    number;
  numOutputs:   number;
  uid:          string;
  path:         string;
}

export interface ScanResult {
  ok:           boolean;
  plugins:      ScanPluginEntry[];
  scannedFiles: number;
  failedFiles:  number;
}

/**
 * Ask the host to scan a VST3 directory and return plugin metadata. This is
 * the AUTHORITATIVE source for `uid`, `category`, `numInputs`, etc. — the
 * filesystem-side `listPlugins()` returns less detail. Use this when the
 * caller needs to instantiate a plugin (i.e., you'll feed `path` into
 * loadPlugin).
 */
export async function scanVst3Path(path: string): Promise<ScanResult> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/scan', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path }),
  });
  return parseOrThrow<ScanResult>(res);
}

/**
 * Instantiate a plugin into a channel chain. Returns the host-assigned slotId.
 *
 * `kind: "instrument"` puts it at the head of the channel; `kind: "fx"`
 * appends (or inserts at fxIndex). channelIdx must be >= 1; channel 0 is
 * the system chain and is rejected by the route handler.
 */
export async function loadPlugin(args: {
  channelIdx: number;
  pluginPath: string;
  kind:       PluginKind;
  fxIndex?:   number;
}): Promise<{ slotId: number }> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/load-plugin', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const body = await parseOrThrow<{ ok: boolean; slotId: number }>(res);
  return { slotId: body.slotId };
}

export async function unloadPlugin(slotId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/unload-plugin', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

/**
 * Bypass or re-engage a plugin. For instrument slots, bypass produces silence;
 * for FX slots, bypass passes audio through unchanged.
 */
export async function setPluginActive(slotId: number, active: boolean): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/plugin-active', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId, active }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

/** Move an FX slot to a new position within its channel's FX chain. */
export async function reorderFx(slotId: number, newFxIndex: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/reorder-fx', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId, newFxIndex }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

/**
 * Read a plugin's serialized state. Returned as base64. The plugin's state
 * is not byte-stable across audio-thread ticks (live voice/LFO state mutates
 * every block); the wire contract is round-trip survival, not byte equality.
 */
export async function getPluginState(slotId: number): Promise<string> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/plugin-state/get', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId }),
  });
  const body = await parseOrThrow<{ ok: boolean; state: string }>(res);
  return body.state;
}

export async function setPluginState(slotId: number, state: string): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/plugin-state/set', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId, state }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

/**
 * Open a plugin's native UI window. Idempotent — opening twice brings the
 * existing window forward instead of creating a second one.
 */
export async function showPluginUi(slotId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/plugin-ui/show', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function closePluginUi(slotId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/plugin-ui/close', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slotId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

/**
 * Send a MIDI note to a loaded plugin via OSC. Backend forwards to the
 * UDP/16331 OSC surface. midiChannel is 1-indexed (channel 0 → midiChannel 1).
 */
export async function hostNote(args: {
  slotId:      number;
  type:        'on' | 'off';
  note:        number;
  midiChannel: number;
  velocity?:   number;
}): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/host/note', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  await parseOrThrow<{ ok: true }>(res);
}

// ── Phobos synth (system instrument on channel 0) ───────────────────────────
//
// Always-mounted Helm at the head of the system chain. ALDA emit, background
// audio APIs, and the Polaris developer button all interact with it through
// this surface. The slotId stays server-side; clients never see it directly.

export interface SynthStatus {
  mounted: boolean;
  slotId:  number | null;
}

export async function getSynthStatus(): Promise<SynthStatus> {
  const res = await fetch(ENGINE_BASE + '/api/audio/synth/status');
  return parseOrThrow<SynthStatus>(res);
}

export async function synthNote(args: {
  type:      'on' | 'off';
  note:      number;
  velocity?: number;
}): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/synth/note', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function showSynthUi(): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/synth/ui/show', { method: 'POST' });
  await parseOrThrow<{ ok: true }>(res);
}

export async function closeSynthUi(): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/synth/ui/close', { method: 'POST' });
  await parseOrThrow<{ ok: true }>(res);
}

// ── Phobos Crystal (global FX on channel 0) ─────────────────────────────────
//
// Always-mounted Crystal at the tail of the system chain. The Polaris
// "Crystal Prism" button toggles bypass via setCrystalActive; long-press
// opens Crystal's parameter UI via showCrystalUi.

export interface CrystalStatus {
  mounted: boolean;
  slotId:  number | null;
}

export async function getCrystalStatus(): Promise<CrystalStatus> {
  const res = await fetch(ENGINE_BASE + '/api/audio/crystal/status');
  return parseOrThrow<CrystalStatus>(res);
}

/**
 * Bypass or re-engage the Phobos Crystal global FX. Bypass is the
 * "Crystal Prism off" state in Polaris.
 */
export async function setCrystalActive(active: boolean): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/crystal/active', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ active }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function showCrystalUi(): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/crystal/ui/show', { method: 'POST' });
  await parseOrThrow<{ ok: true }>(res);
}

export async function closeCrystalUi(): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/crystal/ui/close', { method: 'POST' });
  await parseOrThrow<{ ok: true }>(res);
}

// ── Plugin enumeration (filesystem catalog) ─────────────────────────────────

export type PluginSource = 'phobos' | 'system';

export interface PluginEntry {
  id:           string;
  name:         string;
  path:         string;
  source:       PluginSource;
  platform:     string;
  category:     string;
  /**
   * Authoritative instrument-vs-effect flag from the host's deep-probe.
   * Trustworthy only when scanState === 'deep'. For shallow entries, fall
   * back to filtering by category.startsWith('Instrument') with the
   * understanding that may produce false negatives for plugins that don't
   * ship moduleinfo.json.
   */
  isInstrument: boolean;
  /** 'shallow' = moduleinfo only; 'deep' = host factory probed. */
  scanState:    'shallow' | 'deep';
  last_scanned: string;
}

export interface PluginListing {
  phobos: PluginEntry[];
  system: PluginEntry[];
}

/**
 * List discoverable VST3 plugins via the filesystem scanner. Faster than
 * scanVst3Path() and cached, but returns less detail per plugin (no uid,
 * no isInstrument, no port counts). Use this for browse / pick UIs; use
 * scanVst3Path() when the caller needs the full metadata to instantiate.
 *
 * Pass `refresh: true` to force a fresh filesystem scan; default returns
 * cached results (auto-refresh if > 1hr).
 */
export async function listPlugins(options: { refresh?: boolean } = {}): Promise<PluginListing> {
  const url = options.refresh
    ? '/api/audio/plugins?refresh=true'
    : '/api/audio/plugins';
  const res = await fetch(url);
  return parseOrThrow<PluginListing>(res);
}

// ── DAW projects (database-backed) ──────────────────────────────────────────

export interface DawProjectSummary {
  id:               string;
  name:             string;
  thread_id:        string | null;
  updated_at:       string;
  last_render_path: string | null;
}

export interface DawProject {
  id:               string;
  thread_id:        string | null;
  name:             string;
  xtk_json:         string;
  created_at:       string;
  updated_at:       string;
  last_render_path: string | null;
}

export async function listProjects(threadId?: string | null): Promise<DawProjectSummary[]> {
  const qs = threadId == null ? '' : `?thread_id=${encodeURIComponent(threadId)}`;
  const res = await fetch(`${ENGINE_BASE}/api/audio/daw/projects${qs}`);
  const body = await parseOrThrow<{ projects: DawProjectSummary[] }>(res);
  return body.projects;
}

export async function getProject(id: string): Promise<DawProject> {
  const res = await fetch(`${ENGINE_BASE}/api/audio/daw/projects/${encodeURIComponent(id)}`);
  return parseOrThrow<DawProject>(res);
}

export async function saveProject(
  id:       string,
  name:     string,
  song:     EffluxSong,
  threadId: string | null = null,
): Promise<DawProject> {
  const res = await fetch(ENGINE_BASE + '/api/audio/daw/projects', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ id, name, xtk: song, thread_id: threadId }),
  });
  const body = await parseOrThrow<{ ok: boolean; project: DawProject }>(res);
  return body.project;
}

// ── DAW sessions (.phobos-session, on-disk) ─────────────────────────────────

/**
 * Thrown when saveSession hits a name collision (HTTP 409). EffluxPanel's save
 * handler catches this specifically and surfaces a "rename to save" toolbar
 * message; all other failures bubble up as generic Errors.
 */
export class SessionExistsError extends Error {
  constructor(public readonly filename: string) {
    super(`A session named "${filename}" already exists`);
    this.name = 'SessionExistsError';
  }
}

export interface SessionListEntry {
  filename: string;
  title:    string;
  modified: string;
}

export async function saveSession(
  filename:       string,
  content:        string,
  allowOverwrite: boolean,
): Promise<{ filename: string }> {
  const res = await fetch(ENGINE_BASE + '/api/audio/daw/sessions/save', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename, content, allowOverwrite }),
  });
  if (res.status === 409) throw new SessionExistsError(filename);
  const body = await parseOrThrow<{ ok: boolean; filename: string }>(res);
  return { filename: body.filename };
}

export async function listSessions(): Promise<SessionListEntry[]> {
  const res  = await fetch(ENGINE_BASE + '/api/audio/daw/sessions');
  const body = await parseOrThrow<{ sessions: SessionListEntry[] }>(res);
  return body.sessions;
}

export async function loadSession(filename: string): Promise<string> {
  const res = await fetch(`${ENGINE_BASE}/api/audio/daw/sessions/${encodeURIComponent(filename)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
  }
  return res.text();
}

export async function openSessionFolder(): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/daw/sessions/open-folder', { method: 'POST' });
  await parseOrThrow<{ ok: true }>(res);
}

// ── ALDA ────────────────────────────────────────────────────────────────────

export interface AldaCompileResult {
  ok:           boolean;
  ticksPerBeat: number;
  tempoBpm:     number;
  eventCount:   number;
  events:       Array<{
    instrument:    string;
    midiNote:      number;
    velocity:      number;
    startTicks:    number;
    durationTicks: number;
    channel:       number;
  }>;
}

export async function compileAlda(source: string): Promise<AldaCompileResult> {
  const res = await fetch(ENGINE_BASE + '/api/audio/alda/compile', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ source }),
  });
  return parseOrThrow<AldaCompileResult>(res);
}

/** Compile + immediately play ALDA on the Phobos synth. Returns sequenceId. */
export async function playAldaSource(source: string): Promise<{
  sequenceId: number;
  eventCount: number;
  tempoBpm:   number;
}> {
  const res = await fetch(ENGINE_BASE + '/api/audio/alda/play', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ source }),
  });
  return parseOrThrow<{ ok: boolean; sequenceId: number; eventCount: number; tempoBpm: number }>(res)
    .then(({ sequenceId, eventCount, tempoBpm }) => ({ sequenceId, eventCount, tempoBpm }));
}

/** Cancel an ALDA sequence by id. Idempotent on the backend. */
export async function stopAldaSequence(sequenceId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/alda/stop', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sequenceId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

// ── File player (Polaris audio + future game audio) ────────────────────────
//
// Audio files play through the host's FilePlayerNode, summing into channel 0
// alongside the synth and flowing through Phobos Crystal. Multiple files can
// play concurrently; each gets a monotonic audioId.
//
// The Polaris dock and floating player drive these. Status polling at ~10 Hz
// is enough for a moving progress bar — the host exposes precise sample-
// accurate position via getCurrentPosition under the hood.

export interface AudioPlayerStatus {
  ok?:         boolean;       // present when wrapped in REST envelope
  playing:    boolean;
  positionMs: number;
  durationMs: number;
  finished:   boolean;
}

export async function playAudioFile(args: {
  path:     string;
  startMs?: number;
  loop?:    boolean;
}): Promise<{ audioId: number; durationMs: number }> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/play', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const body = await parseOrThrow<{ ok: boolean; audioId: number; durationMs: number }>(res);
  return { audioId: body.audioId, durationMs: body.durationMs };
}

/**
 * Play a Polaris virtual path (`<mountName>/Artist/Album/Track.ext`) — the
 * backend resolves it to a local fs path via polaris.toml and hands it to
 * the host. Use this from PolarisPlayer / PolarisPlayerDock instead of
 * `playAudioFile` so you don't have to know about Polaris mount config.
 */
export async function playPolarisFile(args: {
  virtualPath: string;
  startMs?:    number;
  loop?:       boolean;
  queue?:      string[];
  queueIdx?:   number;
  shuffle?:    boolean;
  repeat?:     'none' | 'one' | 'all';
}): Promise<{ audioId: number; durationMs: number; localPath: string }> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/play-polaris', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });
  const body = await parseOrThrow<{
    ok:         boolean;
    audioId:    number;
    durationMs: number;
    localPath:  string;
  }>(res);
  return { audioId: body.audioId, durationMs: body.durationMs, localPath: body.localPath };
}

export async function pauseAudio(audioId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/pause', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ audioId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function resumeAudio(audioId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/resume', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ audioId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function seekAudio(audioId: number, positionMs: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/seek', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ audioId, positionMs }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function stopAudio(audioId: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/stop', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ audioId }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

// gain: linear multiplier — 1.0 = unity, 0.0 = silence. Clamped [0, 2] in host.
export async function setAudioFileVolume(audioId: number, gain: number): Promise<void> {
  const res = await fetch(ENGINE_BASE + '/api/audio/player/volume', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ audioId, gain }),
  });
  await parseOrThrow<{ ok: true }>(res);
}

export async function getAudioStatus(audioId: number): Promise<AudioPlayerStatus> {
  const res = await fetch(`${ENGINE_BASE}/api/audio/player/status?audioId=${audioId}`);
  return parseOrThrow<AudioPlayerStatus>(res);
}
