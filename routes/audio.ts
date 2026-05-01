/**
 * routes/audio.ts — PHOBOS audio subsystem REST endpoints.
 *
 * This file covers the DAW (authoring) pipeline — see PHOBOS-Audio-Subsystem-Spec.md §4.
 * Generative audio endpoints (/tts, /music, /sfx) will be added in a later session.
 *
 * ── PhobosHost lifecycle ─────────────────────────────────────────────────────
 * POST /api/audio/host/start                     — force-start PhobosHost (diagnostics)
 * POST /api/audio/host/stop                      — stop PhobosHost (diagnostics)
 * GET  /api/audio/host/status                    — {state, pid, uptime, ...}
 * POST /api/audio/host/ping                      — wire ping → {uptimeMs, version}
 *
 * ── PhobosHost plugin ops (1:1 with control protocol §3.2) ───────────────────
 * POST /api/audio/host/scan                      — {path}             → {plugins, scannedFiles, failedFiles}
 * POST /api/audio/host/load-plugin               — {channelIdx, pluginPath, kind, fxIndex?} → {slotId}
 * POST /api/audio/host/unload-plugin             — {slotId}           → {}
 * POST /api/audio/host/plugin-active             — {slotId, active}   → {}
 * POST /api/audio/host/reorder-fx                — {slotId, newFxIndex} → {}
 * POST /api/audio/host/plugin-state/get          — {slotId}           → {state}
 * POST /api/audio/host/plugin-state/set          — {slotId, state}    → {}
 * POST /api/audio/host/plugin-ui/show            — {slotId}           → {}
 * POST /api/audio/host/plugin-ui/close           — {slotId}           → {}
 * POST /api/audio/host/note                      — {slotId, midiChannel, type, note, velocity?} → {}
 *
 * ── Phobos synth (system audio engine on reserved channel 0) ─────────────────
 * GET  /api/audio/synth/status                    — {mounted, slotId}
 * POST /api/audio/synth/note                      — {type, note, velocity?} → {}
 * POST /api/audio/synth/ui/show                   — {} → {}
 * POST /api/audio/synth/ui/close                  — {} → {}
 *
 * ── Phobos Crystal (global FX on channel 0, after the synth) ─────────────────
 * GET  /api/audio/crystal/status                  — {mounted, slotId}
 * POST /api/audio/crystal/active                  — {active: boolean} → {}
 * POST /api/audio/crystal/ui/show                 — {} → {}
 * POST /api/audio/crystal/ui/close                — {} → {}
 *
 * ── Effect rack ──────────────────────────────────────────────────────────────
 * GET    /api/audio/effect-rack/presets          — list all presets
 * POST   /api/audio/effect-rack/presets          — create/update a preset
 * POST   /api/audio/effect-rack/activate         — STUB in Session 4 (see route comment)
 * DELETE /api/audio/effect-rack/presets/:id      — delete non-factory preset
 *
 * ── DAW projects ─────────────────────────────────────────────────────────────
 * GET  /api/audio/daw/projects                   — list projects
 * GET  /api/audio/daw/projects/:id               — get project XTK + metadata
 * POST /api/audio/daw/projects                   — save (upsert) project
 *
 * ── DAW sessions (.phobos-session, on-disk) ──────────────────────────────────
 * POST /api/audio/daw/sessions/save              — write a .phobos-session file
 * GET  /api/audio/daw/sessions                   — list .phobos-session files
 * GET  /api/audio/daw/sessions/:filename         — return a session's JSON text
 * POST /api/audio/daw/sessions/open-folder       — open the sessions folder in OS file manager
 *
 * ── ALDA ─────────────────────────────────────────────────────────────────────
 * POST /api/audio/alda/compile                   — compile ALDA text → MIDI events
 * POST /api/audio/alda/play                      — compile + play on Phobos synth, returns {sequenceId}
 * POST /api/audio/alda/stop                      — cancel a sequence by id
 *
 * ── File player (Polaris + game audio) ───────────────────────────────────────
 * POST /api/audio/player/play           — {path, startMs?, loop?}        → {audioId, durationMs}
 * POST /api/audio/player/play-polaris   — {virtualPath, startMs?, loop?} → {audioId, durationMs, localPath}
 * POST /api/audio/player/pause          — {audioId}                      → {}
 * POST /api/audio/player/resume         — {audioId}                      → {}
 * POST /api/audio/player/seek           — {audioId, positionMs}          → {}
 * POST /api/audio/player/stop           — {audioId}                      → {}
 * GET  /api/audio/player/status         — ?audioId=N                     → {playing, positionMs, durationMs, finished}
 */

import type { FastifyInstance } from 'fastify';
import fs        from 'fs';
import fsp       from 'fs/promises';
import path      from 'path';
import os        from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { DatabaseManager } from '../db/DatabaseManager.js';
import { EffectRackStore, EffectPreset, EffectContext } from '../db/EffectRackStore.js';
import { DawProjectStore } from '../db/DawProjectStore.js';
import { PluginScanner } from '../phobos/PluginScanner.js';
import {
  ensureRunning as ensureHostRunning,
  stopPhobosHost,
  getStatus as getHostStatus,
  ping as hostPing,
  scanVst3Path as hostScanVst3Path,
  loadPlugin as hostLoadPlugin,
  unloadPlugin as hostUnloadPlugin,
  setPluginActive as hostSetPluginActive,
  reorderFx as hostReorderFx,
  getPluginState as hostGetPluginState,
  setPluginState as hostSetPluginState,
  showPluginUi as hostShowPluginUi,
  closePluginUi as hostClosePluginUi,
  getPhobosSynthSlotId,
  showPhobosSynthUi,
  closePhobosSynthUi,
  getPhobosCrystalSlotId,
  setPhobosCrystalActive,
  showPhobosCrystalUi,
  closePhobosCrystalUi,
  playAudioFile,
  pauseAudio,
  resumeAudio,
  seekAudio,
  stopAudio,
  getAudioStatus,
  PHOBOS_HOST_HOST,
  PHOBOS_HOST_UDP_PORT,
  type PluginKind,
} from '../phobos/PhobosHostManager.js';
import { OscClient } from '../phobos/OscClient.js';
import { aldaToMidi } from '../phobos/alda-parser/index.js';
import { playSourceOnPhobosSynth, stopAldaSequence } from '../phobos/AldaPlayer.js';
import { playPolarisFile } from '../phobos/PolarisHostPlayer.js';

const execFileAsync = promisify(execFile);

// ── Module-scope OSC client ───────────────────────────────────────────────────
//
// One UDP socket reused for the lifetime of the server. PhobosHost binds its
// OSC listener at startup; we send into it whenever a /note request arrives.
// The OscClient buffer is pre-allocated; this is the standard hot-path pattern.
let oscClient: OscClient | null = null;

function getOscClient(): OscClient {
  if (!oscClient) {
    oscClient = new OscClient({ host: PHOBOS_HOST_HOST, port: PHOBOS_HOST_UDP_PORT });
  }
  return oscClient;
}

// ── Session-file helpers ──────────────────────────────────────────────────────

const SESSION_EXTENSION = '.phobos-session';

/**
 * Resolve the on-disk folder for .phobos-session files. Honors PHOBOS_DATA_DIR
 * for tests/CI. Lazy-creates the folder on first call so the user doesn't see
 * an error before they've ever saved.
 */
function sessionsDir(): string {
  const root = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
  const dir  = path.join(root, 'media', 'efflux');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Validate a client-supplied filename. The frontend slugifies titles before
 * sending; this is the defence-in-depth check on the wire. Returns the safe
 * filename, or null if it violates any constraint.
 */
function validateSessionFilename(name: unknown): string | null {
  if (typeof name !== 'string')              return null;
  if (!name.endsWith(SESSION_EXTENSION))     return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('..'))                   return null;
  if (name === SESSION_EXTENSION)            return null;   // empty stem
  return name;
}

/**
 * Best-effort title extraction from a .phobos-session file. Skips files we
 * can't parse — the listing should never crash on one bad file.
 */
async function readSessionMeta(filePath: string): Promise<{ title: string; modifiedIso: string } | null> {
  try {
    const [text, stat] = await Promise.all([
      fsp.readFile(filePath, 'utf8'),
      fsp.stat(filePath),
    ]);
    const obj = JSON.parse(text);
    const title = obj?.meta?.title;
    return {
      title:       typeof title === 'string' && title.length > 0 ? title : '(untitled)',
      modifiedIso: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerAudioRoutes(fastify: FastifyInstance): Promise<void> {
  const db             = DatabaseManager.getInstance();
  const effectRack     = new EffectRackStore(db);
  const dawProjects    = new DawProjectStore(db);
  const pluginScanner  = new PluginScanner(db);
  await effectRack.ensureTable();
  await dawProjects.ensureTable();
  await pluginScanner.ensureTable();

  // EffectRackStore is registered for read/write (presets list/upsert/delete).
  // The activate path is a stub in Session 4 — see route comment below.

  // ── PhobosHost lifecycle ─────────────────────────────────────────────────

  fastify.post('/api/audio/host/start', async (_req, reply) => {
    try {
      await ensureHostRunning();
      return reply.send({ ok: true, status: getHostStatus() });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/host/stop', async (_req, reply) => {
    await stopPhobosHost();
    return reply.send({ ok: true, status: getHostStatus() });
  });

  fastify.get('/api/audio/host/status', async (_req, reply) => {
    return reply.send(getHostStatus());
  });

  fastify.post('/api/audio/host/ping', async (_req, reply) => {
    try {
      await ensureHostRunning();
      const result = await hostPing();
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── PhobosHost plugin ops ────────────────────────────────────────────────

  /**
   * Scan a VST3 directory. Returns plugin metadata (name, vendor, uid, etc).
   * The scan is performed by PhobosHost (using JUCE's AudioPluginFormatManager),
   * which is more authoritative than the filesystem walk used by PluginScanner —
   * use this when the caller needs uid/category/numInputs from each plugin.
   */
  fastify.post<{
    Body: { path: string };
  }>('/api/audio/host/scan', async (req, reply) => {
    try {
      const scanPath = req.body?.path;
      if (typeof scanPath !== 'string' || scanPath.length === 0) {
        return reply.status(400).send({ error: 'path must be a non-empty string' });
      }
      await ensureHostRunning();
      const result = await hostScanVst3Path(scanPath);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Instantiate a plugin into a channel chain. `kind: "instrument"` puts it at
   * the head of the channel; `kind: "fx"` appends (or inserts at fxIndex).
   * Returns the host-assigned slotId. SlotId is monotonic, never reused, and
   * is the handle for every subsequent op on this plugin.
   *
   * Slot identity is NOT persistent across host restarts. Persist the
   * { uid, path } pluginRef in session JSON instead — Session 5 territory.
   */
  fastify.post<{
    Body: { channelIdx: number; pluginPath: string; kind: PluginKind; fxIndex?: number };
  }>('/api/audio/host/load-plugin', async (req, reply) => {
    try {
      const { channelIdx, pluginPath, kind } = req.body ?? {};
      const fxIndex = req.body?.fxIndex;
      if (typeof channelIdx !== 'number' || channelIdx < 1) {
        return reply.status(400).send({
          error: 'channelIdx must be >= 1; channel 0 is reserved for the Phobos synth',
        });
      }
      if (typeof pluginPath !== 'string' || pluginPath.length === 0) {
        return reply.status(400).send({ error: 'pluginPath must be a non-empty string' });
      }
      if (kind !== 'instrument' && kind !== 'fx') {
        return reply.status(400).send({ error: 'kind must be "instrument" or "fx"' });
      }
      if (fxIndex !== undefined && typeof fxIndex !== 'number') {
        return reply.status(400).send({ error: 'fxIndex must be a number when provided' });
      }
      await ensureHostRunning();
      const result = await hostLoadPlugin({ channelIdx, pluginPath, kind, fxIndex });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { slotId: number };
  }>('/api/audio/host/unload-plugin', async (req, reply) => {
    try {
      const { slotId } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      await ensureHostRunning();
      await hostUnloadPlugin(slotId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Bypass or reactivate a plugin. For instrument slots, bypass produces
   * silence; for FX slots, bypass passes audio through unchanged.
   */
  fastify.post<{
    Body: { slotId: number; active: boolean };
  }>('/api/audio/host/plugin-active', async (req, reply) => {
    try {
      const { slotId, active } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      if (typeof active !== 'boolean') {
        return reply.status(400).send({ error: 'active must be a boolean' });
      }
      await ensureHostRunning();
      await hostSetPluginActive(slotId, active);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { slotId: number; newFxIndex: number };
  }>('/api/audio/host/reorder-fx', async (req, reply) => {
    try {
      const { slotId, newFxIndex } = req.body ?? {};
      if (typeof slotId !== 'number' || typeof newFxIndex !== 'number') {
        return reply.status(400).send({ error: 'slotId and newFxIndex must be numbers' });
      }
      await ensureHostRunning();
      await hostReorderFx(slotId, newFxIndex);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Read a plugin's serialized state. Returned as base64. The plugin's state
   * is not byte-stable across audio-thread ticks (live voice/LFO state mutates
   * every block); the wire contract is round-trip survival, not byte equality.
   */
  fastify.post<{
    Body: { slotId: number };
  }>('/api/audio/host/plugin-state/get', async (req, reply) => {
    try {
      const { slotId } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      await ensureHostRunning();
      const state = await hostGetPluginState(slotId);
      return reply.send({ ok: true, state });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { slotId: number; state: string };
  }>('/api/audio/host/plugin-state/set', async (req, reply) => {
    try {
      const { slotId, state } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      if (typeof state !== 'string' || state.length === 0) {
        return reply.status(400).send({ error: 'state must be a non-empty base64 string' });
      }
      await ensureHostRunning();
      await hostSetPluginState(slotId, state);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Open a plugin's native UI window. Idempotent — opening twice brings the
   * existing window forward instead of creating a second one.
   */
  fastify.post<{
    Body: { slotId: number };
  }>('/api/audio/host/plugin-ui/show', async (req, reply) => {
    try {
      const { slotId } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      await ensureHostRunning();
      await hostShowPluginUi(slotId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Hide a plugin's UI window without destroying the editor — next show is fast.
   */
  fastify.post<{
    Body: { slotId: number };
  }>('/api/audio/host/plugin-ui/close', async (req, reply) => {
    try {
      const { slotId } = req.body ?? {};
      if (typeof slotId !== 'number') {
        return reply.status(400).send({ error: 'slotId must be a number' });
      }
      await ensureHostRunning();
      await hostClosePluginUi(slotId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Send a MIDI note to PhobosHost via OSC. midiChannel is 1-indexed
   * (channel 0 → midiChannel 1) — the host's per-channel MidiChannelFilter
   * routes by this value. slotId is informational on the wire (preserved for
   * future routing modes).
   */
  fastify.post<{
    Body: { slotId: number; type: 'on' | 'off'; note: number; midiChannel: number; velocity?: number };
  }>('/api/audio/host/note', async (req, reply) => {
    try {
      const { slotId, type, note, midiChannel } = req.body ?? {};
      const velocity = req.body?.velocity ?? 100;
      if (typeof slotId !== 'number' || typeof note !== 'number' || typeof midiChannel !== 'number') {
        return reply.status(400).send({ error: 'slotId, note, and midiChannel must be numbers' });
      }
      if (type !== 'on' && type !== 'off') {
        return reply.status(400).send({ error: 'type must be "on" or "off"' });
      }
      await ensureHostRunning();
      const osc = getOscClient();
      if (type === 'on') osc.noteOn(slotId, midiChannel, note, velocity);
      else               osc.noteOff(slotId, midiChannel, note);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Phobos synth (system audio engine on reserved channel 0) ─────────────
  //
  // The Phobos synth is mounted automatically when the host starts and lives
  // on host channel 0 — reserved by the host itself. These routes are how
  // backend modules and the (eventual) Polaris hidden button interact with it
  // without ever knowing the underlying slotId.

  fastify.get('/api/audio/synth/status', async (_req, reply) => {
    const slotId = getPhobosSynthSlotId();
    return reply.send({ mounted: slotId !== null, slotId });
  });

  /**
   * Send a MIDI note to the Phobos synth via OSC. No channelIdx — the synth
   * is always on host channel 0, so midiChannel is hardcoded to 1 (channel
   * index + 1, matching the host's MidiChannelFilter convention).
   */
  fastify.post<{
    Body: { type: 'on' | 'off'; note: number; velocity?: number };
  }>('/api/audio/synth/note', async (req, reply) => {
    try {
      const { type, note } = req.body ?? {};
      const velocity = req.body?.velocity ?? 100;
      if (typeof note !== 'number') {
        return reply.status(400).send({ error: 'note must be a number' });
      }
      if (type !== 'on' && type !== 'off') {
        return reply.status(400).send({ error: 'type must be "on" or "off"' });
      }
      await ensureHostRunning();
      const slotId = getPhobosSynthSlotId();
      if (slotId === null) {
        return reply.status(503).send({ error: 'phobos synth not mounted' });
      }
      const osc = getOscClient();
      if (type === 'on') osc.noteOn(slotId, 1, note, velocity);
      else               osc.noteOff(slotId, 1, note);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/synth/ui/show', async (_req, reply) => {
    try {
      await ensureHostRunning();
      await showPhobosSynthUi();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/synth/ui/close', async (_req, reply) => {
    try {
      await ensureHostRunning();
      await closePhobosSynthUi();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Phobos Crystal (global FX on channel 0, after the synth) ─────────────
  //
  // Crystal sits at the tail of channel 0's FX chain. It processes the synth
  // output (and, in a future session, the Polaris media-player output once
  // we relocate that audio into the host). The "Crystal Prism" toggle in
  // Polaris bypasses this slot via /api/audio/crystal/active.

  fastify.get('/api/audio/crystal/status', async (_req, reply) => {
    const slotId = getPhobosCrystalSlotId();
    return reply.send({ mounted: slotId !== null, slotId });
  });

  /**
   * Bypass or re-engage Crystal. Bypass is the "Crystal Prism off" state in
   * Polaris — audio passes through unprocessed; active re-engages the FX.
   */
  fastify.post<{
    Body: { active: boolean };
  }>('/api/audio/crystal/active', async (req, reply) => {
    try {
      const { active } = req.body ?? {};
      if (typeof active !== 'boolean') {
        return reply.status(400).send({ error: 'active must be a boolean' });
      }
      await ensureHostRunning();
      await setPhobosCrystalActive(active);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/crystal/ui/show', async (_req, reply) => {
    try {
      await ensureHostRunning();
      await showPhobosCrystalUi();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/crystal/ui/close', async (_req, reply) => {
    try {
      await ensureHostRunning();
      await closePhobosCrystalUi();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Plugin enumeration (filesystem catalog) ──────────────────────────────

  /**
   * List discoverable VST3 plugins — bundled (phobos) and system.
   * Defaults to cached results; pass ?refresh=true to force a filesystem rescan.
   * Cache is automatically refreshed if older than 1 hour.
   *
   * This is the FILESYSTEM-side scan (PluginScanner); for plugin metadata
   * authoritative for instantiation (uid, category, etc.), use
   * /api/audio/host/scan which goes through PhobosHost itself.
   */
  fastify.get<{
    Querystring: { refresh?: string };
  }>('/api/audio/plugins', async (req, reply) => {
    try {
      const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
      const listing = await pluginScanner.list({ refresh });
      return reply.send(listing);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Effect rack ──────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: { context?: string };
  }>('/api/audio/effect-rack/presets', async (req, reply) => {
    const context = req.query.context as EffectContext | undefined;
    const rows    = await effectRack.list(context);
    return reply.send({ presets: rows });
  });

  fastify.post<{
    Body: Omit<EffectPreset, 'created_at' | 'updated_at'>;
  }>('/api/audio/effect-rack/presets', async (req, reply) => {
    try {
      const saved = await effectRack.upsert(req.body);
      return reply.send({ ok: true, preset: saved });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Effect-rack preset activation — STUBBED in Session 4.
   *
   * The Carla path was per-parameter OSC diff (`setParam` per change). PhobosHost
   * has no per-param op yet; only whole getPluginState/setPluginState. The
   * EffectRackStore preset-as-param-bag schema needs to redesign around
   * setPluginState before this can do real work — likely Session 5/6 territory.
   *
   * Returns ok=true so the existing frontend doesn't break, but logs a WARN
   * so the no-op is visible in logs. Frontend behavior is unchanged for now.
   */
  fastify.post<{
    Body: { id: string };
  }>('/api/audio/effect-rack/activate', async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return reply.status(400).send({ error: 'id must be a non-empty string' });
    }
    process.stderr.write(`[audio:WARN] effect-rack/activate is a stub in Session 4 (id="${id}")\n`);
    return reply.send({ ok: true, activePresetId: id, stub: true });
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/audio/effect-rack/presets/:id', async (req, reply) => {
    const ok = await effectRack.delete(req.params.id);
    if (!ok) return reply.status(409).send({ error: 'Preset not found or is a factory preset' });
    return reply.send({ ok: true });
  });

  // ── DAW projects ─────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: { thread_id?: string };
  }>('/api/audio/daw/projects', async (req, reply) => {
    const threadId = req.query.thread_id ?? undefined;
    const rows = await dawProjects.list(threadId);
    return reply.send({ projects: rows });
  });

  fastify.get<{
    Params: { id: string };
  }>('/api/audio/daw/projects/:id', async (req, reply) => {
    const p = await dawProjects.get(req.params.id);
    if (!p) return reply.status(404).send({ error: 'Project not found' });
    return reply.send(p);
  });

  fastify.post<{
    Body: { id: string; name: string; xtk: unknown; thread_id?: string | null };
  }>('/api/audio/daw/projects', async (req, reply) => {
    const { id, name, xtk } = req.body;
    const threadId = req.body.thread_id ?? null;
    if (!id || !name || xtk == null) {
      return reply.status(400).send({ error: 'id, name, and xtk are required' });
    }
    const xtkJson = typeof xtk === 'string' ? xtk : JSON.stringify(xtk);
    const saved = await dawProjects.save(id, name, xtkJson, threadId);
    return reply.send({ ok: true, project: saved });
  });

  // ── DAW sessions (.phobos-session, on-disk) ──────────────────────────────
  //
  // These persist the Phase 3 Session model to disk under the user's data dir
  // (`~/.phobos/media/efflux/`). The DB-backed XTK projects above are a
  // separate, parallel format used by the Efflux engine's own serializer.

  /**
   * Save a .phobos-session file. The frontend pre-slugifies the filename
   * (lowercase, alphanumeric + hyphen, trailing `.phobos-session`); we
   * validate it again here. Returns 409 when the target exists and the
   * caller didn't pass `allowOverwrite: true` — frontend turns 409 into a
   * "name already taken, rename to save" toolbar error.
   */
  fastify.post<{
    Body: { filename: string; content: string; allowOverwrite?: boolean };
  }>('/api/audio/daw/sessions/save', async (req, reply) => {
    try {
      const { filename, content } = req.body ?? {};
      const allowOverwrite = req.body?.allowOverwrite === true;

      const safeName = validateSessionFilename(filename);
      if (!safeName) {
        return reply.status(400).send({ error: 'invalid filename' });
      }
      if (typeof content !== 'string' || content.length === 0) {
        return reply.status(400).send({ error: 'content is required' });
      }

      const targetPath = path.join(sessionsDir(), safeName);
      if (fs.existsSync(targetPath) && !allowOverwrite) {
        return reply.status(409).send({ error: 'exists' });
      }

      await fsp.writeFile(targetPath, content, 'utf8');
      return reply.send({ ok: true, filename: safeName });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * List every .phobos-session file in the user's sessions folder. Each
   * entry includes the filename, the title pulled from the file's
   * `meta.title`, and the file's mtime. Files that fail to parse are
   * silently skipped — a single corrupt file shouldn't break the picker.
   */
  fastify.get('/api/audio/daw/sessions', async (_req, reply) => {
    try {
      const dir   = sessionsDir();
      const names = await fsp.readdir(dir);

      const sessionFiles: string[] = [];
      for (let i = 0; i < names.length; i++) {
        if (names[i].endsWith(SESSION_EXTENSION)) sessionFiles.push(names[i]);
      }

      const out: Array<{ filename: string; title: string; modified: string }> = [];
      for (let i = 0; i < sessionFiles.length; i++) {
        const fname = sessionFiles[i];
        const meta  = await readSessionMeta(path.join(dir, fname));
        if (meta === null) continue;
        out.push({ filename: fname, title: meta.title, modified: meta.modifiedIso });
      }
      return reply.send({ sessions: out });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Return the raw JSON text of a single session file. The frontend feeds
   * this directly into deserialize(); no server-side parsing.
   */
  fastify.get<{
    Params: { filename: string };
  }>('/api/audio/daw/sessions/:filename', async (req, reply) => {
    try {
      const safeName = validateSessionFilename(req.params.filename);
      if (!safeName) {
        return reply.status(400).send({ error: 'invalid filename' });
      }
      const filePath = path.join(sessionsDir(), safeName);
      if (!fs.existsSync(filePath)) {
        return reply.status(404).send({ error: 'not found' });
      }
      const text = await fsp.readFile(filePath, 'utf8');
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .send(text);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Open the sessions folder in the OS-native file explorer. Pattern copied
   * from kavitaIngestRoutes — explorer on win32, `open` on darwin,
   * xdg-open on linux. Linux call is fire-and-forget because headless
   * environments will fail and we don't want to surface that.
   *
   * Windows quirk: `explorer.exe <folder>` opens the folder correctly but
   * exits with code 1, which `execFileAsync` interprets as a rejection.
   * We swallow that specific case so the user doesn't see a spurious
   * "Open folder failed" toast on a successful open. (The Kavita route at
   * routes/kavitaIngestRoutes.ts:260 has the same latent issue but isn't
   * in scope here.)
   */
  fastify.post('/api/audio/daw/sessions/open-folder', async (_req, reply) => {
    try {
      const dir = sessionsDir();
      if (process.platform === 'win32') {
        try {
          await execFileAsync('explorer', [dir]);
        } catch (err) {
          // Exit code 1 from explorer is a known false-positive — folder
          // opened fine. Anything else is a real failure (binary missing,
          // path doesn't exist, etc).
          const code = (err as { code?: number }).code;
          if (code !== 1) throw err;
        }
      } else if (process.platform === 'darwin') {
        await execFileAsync('open', [dir]);
      } else {
        execFile('xdg-open', [dir], () => {});
      }
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── File player (Polaris audio + future game audio) ─────────────────────
  //
  // Audio files play through the host's FilePlayerNode and route through
  // channel 0's audioSumNode → Phobos Crystal → device output. Multiple
  // files can play concurrently; each gets its own audioId.
  //
  // Path is interpreted by the host on its own filesystem. Since the host
  // and backend run on the same machine, the path the frontend hands the
  // backend is the same path the host opens. Backend doesn't translate.

  fastify.post<{
    Body: { path: string; startMs?: number; loop?: boolean };
  }>('/api/audio/player/play', async (req, reply) => {
    const { path: filePath, startMs, loop } = req.body ?? {};
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return reply.status(400).send({ error: 'missing or empty "path"' });
    }
    try {
      await ensureHostRunning();
      const result = await playAudioFile({ path: filePath, startMs, loop });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found') || message.includes('unsupported')) {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Play an audio file by its Polaris virtual path. The backend translates
   * the virtual path (`<mountName>/Artist/Album/Track.ext`) to a local
   * filesystem path by reading polaris.toml's `[[mount_dirs]]` entries, then
   * hands the local path to the host's FilePlayerNode.
   *
   * Frontend callers (the dock, the floating player) hit this route rather
   * than `/play` so they don't have to know anything about Polaris's mount
   * config — they just pass through whatever `path` field Polaris's API gave
   * them on the song object.
   *
   * On any resolution failure (no mount, traversal attempt, file missing on
   * disk after resolution), returns 400 with a descriptive error so the UI
   * can show something more useful than a generic 500.
   */
  fastify.post<{
    Body: { virtualPath: string; startMs?: number; loop?: boolean };
  }>('/api/audio/player/play-polaris', async (req, reply) => {
    const { virtualPath, startMs, loop } = req.body ?? {};
    if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
      return reply.status(400).send({ error: 'missing or empty "virtualPath"' });
    }
    try {
      const result = await playPolarisFile({ virtualPath, startMs, loop });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      if (
        message.includes('could not be resolved') ||
        message.includes('does not exist on disk') ||
        message.includes('unsupported')
      ) {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  fastify.post<{
    Body: { audioId: number };
  }>('/api/audio/player/pause', async (req, reply) => {
    const audioId = req.body?.audioId;
    if (typeof audioId !== 'number' || audioId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "audioId"' });
    }
    try {
      await pauseAudio(audioId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { audioId: number };
  }>('/api/audio/player/resume', async (req, reply) => {
    const audioId = req.body?.audioId;
    if (typeof audioId !== 'number' || audioId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "audioId"' });
    }
    try {
      await resumeAudio(audioId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { audioId: number; positionMs: number };
  }>('/api/audio/player/seek', async (req, reply) => {
    const { audioId, positionMs } = req.body ?? {};
    if (typeof audioId !== 'number' || audioId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "audioId"' });
    }
    if (typeof positionMs !== 'number' || !isFinite(positionMs) || positionMs < 0) {
      return reply.status(400).send({ error: 'missing or invalid "positionMs"' });
    }
    try {
      await seekAudio(audioId, positionMs);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { audioId: number };
  }>('/api/audio/player/stop', async (req, reply) => {
    const audioId = req.body?.audioId;
    if (typeof audioId !== 'number' || audioId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "audioId"' });
    }
    try {
      await stopAudio(audioId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.get<{
    Querystring: { audioId: string };
  }>('/api/audio/player/status', async (req, reply) => {
    const audioIdStr = req.query?.audioId;
    const audioId = typeof audioIdStr === 'string' ? parseInt(audioIdStr, 10) : NaN;
    if (!isFinite(audioId) || audioId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "audioId" query param' });
    }
    try {
      const status = await getAudioStatus(audioId);
      return reply.send({ ok: true, ...status });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── ALDA ─────────────────────────────────────────────────────────────────

  fastify.post<{
    Body: { source: string };
  }>('/api/audio/alda/compile', async (req, reply) => {
    try {
      const result = aldaToMidi(req.body.source);
      return reply.send({
        ok:            true,
        ticksPerBeat:  result.ticksPerBeat,
        tempoBpm:      result.tempoBpm,
        eventCount:    result.events.length,
        events:        result.events,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Compile ALDA source and immediately play it on the Phobos synth via the
   * host's SchedulerNode. Fire-and-forget — returns the sequenceId; audio
   * plays asynchronously. Use POST /api/audio/alda/stop with the same id to
   * cancel mid-playback.
   *
   * Compile errors return 400 (caller's source is bad). Host/scheduler errors
   * return 500. The compiled-zero-events case is treated as a 400 too — empty
   * playback is almost always a caller mistake.
   */
  fastify.post<{
    Body: { source: string };
  }>('/api/audio/alda/play', async (req, reply) => {
    const source = req.body?.source;
    if (typeof source !== 'string' || source.length === 0) {
      return reply.status(400).send({ error: 'missing or empty "source"' });
    }
    try {
      const result = await playSourceOnPhobosSynth(source);
      return reply.send({
        ok:         true,
        sequenceId: result.sequenceId,
        eventCount: result.eventCount,
        tempoBpm:   result.tempoBpm,
      });
    } catch (err) {
      const message = (err as Error).message;
      // Compile failures and "compiled to zero events" are caller errors.
      if (message.includes('compiled to zero events')
       || message.includes('parse')
       || message.includes('syntax')
       || message.includes('expected')) {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  fastify.post<{
    Body: { sequenceId: number };
  }>('/api/audio/alda/stop', async (req, reply) => {
    const sequenceId = req.body?.sequenceId;
    if (typeof sequenceId !== 'number' || sequenceId < 0) {
      return reply.status(400).send({ error: 'missing or invalid "sequenceId"' });
    }
    try {
      await stopAldaSequence(sequenceId);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
