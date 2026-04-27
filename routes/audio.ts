/**
 * routes/audio.ts — PHOBOS audio subsystem REST endpoints.
 *
 * This file covers the DAW (authoring) pipeline — see PHOBOS-Audio-Subsystem-Spec.md §4.
 * Generative audio endpoints (/tts, /music, /sfx) will be added in a later session.
 *
 * ── Carla lifecycle ──────────────────────────────────────────────────────────
 * POST /api/audio/carla/start                    — force-start Carla (diagnostics)
 * POST /api/audio/carla/stop                     — stop Carla (diagnostics)
 * GET  /api/audio/carla/status                   — {state, pid, uptime, activePreset}
 * POST /api/audio/carla/param                    — set a single plugin parameter
 * POST /api/audio/carla/note                     — send note on/off
 *
 * ── Effect rack ──────────────────────────────────────────────────────────────
 * GET    /api/audio/effect-rack/presets          — list all presets
 * POST   /api/audio/effect-rack/presets          — create/update a preset
 * POST   /api/audio/effect-rack/activate         — activate preset by id
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
  ensureRunning as ensureCarlaRunning,
  stopCarla,
  getStatus as getCarlaStatus,
  setParam as carlaSetParam,
  noteOn as carlaNoteOn,
  noteOff as carlaNoteOff,
  activatePreset as carlaActivatePreset,
  showPluginUi as carlaShowPluginUi,
  setPluginActive as carlaSetPluginActive,
  setEffectRackStore,
  PLUGIN_IDX_HELM,
  PLUGIN_IDX_SURGE,
  PLUGIN_IDX_CRYSTAL,
} from '../phobos/CarlaManager.js';
import { aldaToMidi } from '../phobos/alda-parser/index.js';

const execFileAsync = promisify(execFile);

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

  // Register the store with CarlaManager so it can resolve preset ids.
  setEffectRackStore(effectRack);

  // ── Carla ────────────────────────────────────────────────────────────────

  fastify.post('/api/audio/carla/start', async (_req, reply) => {
    try {
      await ensureCarlaRunning();
      return reply.send({ ok: true, status: getCarlaStatus() });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/carla/stop', async (_req, reply) => {
    await stopCarla();
    return reply.send({ ok: true, status: getCarlaStatus() });
  });

  fastify.get('/api/audio/carla/status', async (_req, reply) => {
    return reply.send(getCarlaStatus());
  });

  fastify.post<{
    Body: { pluginIdx: number; paramId: number; value: number };
  }>('/api/audio/carla/param', async (req, reply) => {
    try {
      const { pluginIdx, paramId, value } = req.body;
      if (typeof pluginIdx !== 'number' || typeof paramId !== 'number' || typeof value !== 'number') {
        return reply.status(400).send({ error: 'pluginIdx, paramId, and value must be numbers' });
      }
      await ensureCarlaRunning();
      carlaSetParam(pluginIdx, paramId, value);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { pluginIdx: number; type: 'on' | 'off'; note: number; velocity?: number; channel?: number };
  }>('/api/audio/carla/note', async (req, reply) => {
    try {
      const { pluginIdx, type, note } = req.body;
      const velocity = req.body.velocity ?? 100;
      const channel  = req.body.channel  ?? 0;
      if (typeof pluginIdx !== 'number' || typeof note !== 'number' || (type !== 'on' && type !== 'off')) {
        return reply.status(400).send({ error: 'Bad payload' });
      }
      await ensureCarlaRunning();
      if (type === 'on') carlaNoteOn(pluginIdx, channel, note, velocity);
      else               carlaNoteOff(pluginIdx, channel, note);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Open or close the plugin's native custom UI window. Accepts a plugin key
   * ("helm" | "surge" | "crystal") so clients don't have to know the OSC
   * index numbering (those are internal wire contracts — see Audio Subsystem
   * Spec §10.2).
   */
  fastify.post<{
    Body: { plugin: 'helm' | 'surge' | 'crystal'; show: boolean };
  }>('/api/audio/carla/plugin-ui', async (req, reply) => {
    try {
      const { plugin, show } = req.body;
      if (plugin !== 'helm' && plugin !== 'surge' && plugin !== 'crystal') {
        return reply.status(400).send({ error: 'plugin must be "helm", "surge", or "crystal"' });
      }
      if (typeof show !== 'boolean') {
        return reply.status(400).send({ error: 'show must be a boolean' });
      }
      const idx = plugin === 'helm'   ? PLUGIN_IDX_HELM
                : plugin === 'surge'  ? PLUGIN_IDX_SURGE
                : PLUGIN_IDX_CRYSTAL;
      await ensureCarlaRunning();
      carlaShowPluginUi(idx, show);
      return reply.send({ ok: true, plugin, show });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Activate or bypass a plugin. Bypass routes audio around the plugin
   * unchanged; active re-engages processing.
   */
  fastify.post<{
    Body: { plugin: 'helm' | 'surge' | 'crystal'; active: boolean };
  }>('/api/audio/carla/plugin-active', async (req, reply) => {
    try {
      const { plugin, active } = req.body;
      if (plugin !== 'helm' && plugin !== 'surge' && plugin !== 'crystal') {
        return reply.status(400).send({ error: 'plugin must be "helm", "surge", or "crystal"' });
      }
      if (typeof active !== 'boolean') {
        return reply.status(400).send({ error: 'active must be a boolean' });
      }
      const idx = plugin === 'helm'   ? PLUGIN_IDX_HELM
                : plugin === 'surge'  ? PLUGIN_IDX_SURGE
                : PLUGIN_IDX_CRYSTAL;
      await ensureCarlaRunning();
      carlaSetPluginActive(idx, active);
      return reply.send({ ok: true, plugin, active });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Plugin enumeration (VST3 scanner) ───────────────────────────────────

  /**
   * List discoverable VST3 plugins — bundled (phobos) and system.
   * Defaults to cached results; pass ?refresh=true to force a filesystem rescan.
   * Cache is automatically refreshed if older than 1 hour.
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

  fastify.post<{
    Body: { id: string };
  }>('/api/audio/effect-rack/activate', async (req, reply) => {
    try {
      await carlaActivatePreset(req.body.id);
      return reply.send({ ok: true, activePresetId: req.body.id });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
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
  // separate, parallel format used by Carla/Efflux upstream tooling.

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
}
