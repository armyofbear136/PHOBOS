/**
 * PHOBOS Artist Plugin System — API Routes
 * Register via: await registerPluginRoutes(fastify, db)  in server.ts
 *
 * GET    /api/phobos/plugins                  — list all
 * GET    /api/phobos/plugins/:id              — get one
 * DELETE /api/phobos/plugins/:id              — remove (no auth — just a local delete)
 * POST   /api/phobos/plugins/upload           — multipart install / staging
 * POST   /api/phobos/plugins/:id/check-auth   — verify credential, returns { ok, via }
 * PATCH  /api/phobos/plugins/:id              — update metadata (credential required in body)
 * POST   /api/phobos/plugins/:id/add-license  — add license unlock (credential required)
 * GET    /api/phobos/plugins/:id/license-unlocked — silent local license check
 */

import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { PluginStore } from '../db/PluginStore.js';
import type { PluginRecord } from '../phobos/PluginTypes.js';

const TRAINING_DIR = path.join(os.homedir(), '.phobos', 'plugin-training');
const IMAGE_EXTS   = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp']);

// ── Upload endpoint ────────────────────────────────────────────────────────
//
// Accepts one file per POST as a raw binary body (application/octet-stream).
// The filename is passed as a query param: POST /api/phobos/plugins/upload?filename=foo.phobos
// The frontend sends files sequentially, one fetch per file.
//
// This avoids a @fastify/multipart dependency while supporting arbitrarily
// large files (the existing 10MB body limit in server.ts covers plugin use;
// training image batches can be uploaded as a zip).
//
// Classification by extension:
//   .phobos          → installPhobosArchive
//   .safetensors     → installRawLora
//   .gguf            → installRawLora
//   .zip             → if contains plugin.json + lora.safetensors → installPhobosArchive
//                      else → extract all images → training session staging
//   image extensions → training session staging

function extractImagesFromZip(buf: Buffer): Array<{ filename: string; data: Buffer }> {
  const zip = new AdmZip(buf);
  return zip.getEntries()
    .filter(e => !e.isDirectory && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map(e => ({ filename: e.name, data: e.getData() }));
}

// ── Serialization ─────────────────────────────────────────────────────────────

function deser(r: PluginRecord): unknown {
  return {
    ...r,
    compatible_models: tryJson(r.compatible_models, []),
    trigger_words:     tryJson(r.trigger_words, []),
    tags:              tryJson(r.tags, []),
  };
}

function tryJson(v: string | null, fallback: unknown): unknown {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ── Credential helper ─────────────────────────────────────────────────────────
// Routes accept:  { password: string }  or  { useLicense: true }
// Never both — the frontend sends exactly one.

type Credential = { password: string } | { useLicense: true };

function parseCredential(body: Record<string, unknown>): Credential {
  if (body.useLicense === true) return { useLicense: true };
  if (typeof body.password === 'string' && body.password.length > 0) return { password: body.password };
  throw new Error('Either password or useLicense:true required');
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerPluginRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const db    = DatabaseManager.getInstance();
  const store = new PluginStore(db);
  await store.ensureTable();

  // ── List ──────────────────────────────────────────────────────────────────

  fastify.get('/api/phobos/plugins', async (_req, reply) => {
    return reply.send((await store.list()).map(deser));
  });

  // ── Get one ───────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/phobos/plugins/:id', async (req, reply) => {
    const r = await store.get(req.params.id);
    if (!r) return reply.status(404).send({ error: 'Plugin not found' });
    return reply.send(deser(r));
  });

  // ── Silent license check (called at panel open) ───────────────────────────
  // Returns { unlocked: true } when local license matches plugin's fingerprint.
  // Frontend uses this to skip the password prompt for the Edit button.

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/plugins/:id/license-unlocked',
    async (req, reply) => {
      const r = await store.get(req.params.id);
      if (!r) return reply.status(404).send({ error: 'Plugin not found' });
      if (r.kind !== 'plugin') return reply.send({ unlocked: false });
      return reply.send({ unlocked: store.checkLicenseUnlock(r.archive_path) });
    },
  );

  // ── Check auth (used by frontend Edit button before switching to edit mode) ─

  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/phobos/plugins/:id/check-auth',
    async (req, reply) => {
      const r = await store.get(req.params.id);
      if (!r) return reply.status(404).send({ error: 'Plugin not found' });
      if (r.kind !== 'plugin') return reply.status(400).send({ error: 'Raw LoRAs have no auth' });

      let credential: Credential;
      try { credential = parseCredential(req.body); }
      catch (e) { return reply.status(400).send({ error: (e as Error).message }); }

      const result = store.checkAuth(r.archive_path, credential);
      if (result.ok) return reply.send({ ok: true, via: result.via });
      return reply.status(403).send({ ok: false, reason: result.reason });
    },
  );

  // ── Update metadata ───────────────────────────────────────────────────────
  // Body: { password?, useLicense?, name?, description?, tags?, recommendedWeight? }

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/phobos/plugins/:id',
    async (req, reply) => {
      const r = await store.get(req.params.id);
      if (!r) return reply.status(404).send({ error: 'Plugin not found' });

      let credential: Credential;
      try { credential = parseCredential(req.body); }
      catch (e) { return reply.status(400).send({ error: (e as Error).message }); }

      try {
        await store.updateMetadata(
          req.params.id,
          {
            name:              typeof req.body.name              === 'string' ? req.body.name              : undefined,
            description:       typeof req.body.description       === 'string' ? req.body.description       : undefined,
            tags:              Array.isArray(req.body.tags)                   ? req.body.tags as string[]  : undefined,
            recommendedWeight: typeof req.body.recommendedWeight  === 'number' ? req.body.recommendedWeight : undefined,
          },
          credential,
        );
        return reply.send(deser((await store.get(req.params.id))!));
      } catch (e) {
        const msg = (e as Error).message;
        const status = msg === 'wrong_password' || msg === 'no_license_match' ? 403 : 400;
        return reply.status(status).send({ error: msg });
      }
    },
  );

  // ── Add license unlock ────────────────────────────────────────────────────
  // Body: { password } or { useLicense: true }
  // Requires valid existing credential. Adds local license fingerprint to sig.

  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/phobos/plugins/:id/add-license',
    async (req, reply) => {
      const r = await store.get(req.params.id);
      if (!r) return reply.status(404).send({ error: 'Plugin not found' });
      if (r.kind !== 'plugin') return reply.status(400).send({ error: 'Raw LoRAs do not support license unlock' });

      let credential: Credential;
      try { credential = parseCredential(req.body); }
      catch (e) { return reply.status(400).send({ error: (e as Error).message }); }

      try {
        await store.addLicenseUnlock(req.params.id, credential);
        return reply.send({ ok: true });
      } catch (e) {
        const msg = (e as Error).message;
        const status = msg.includes('password') || msg.includes('license') ? 403 : 400;
        return reply.status(status).send({ error: msg });
      }
    },
  );

  // ── Delete ────────────────────────────────────────────────────────────────
  // No auth on delete — it's a local operation. The file is on the user's machine.

  fastify.delete<{ Params: { id: string } }>('/api/phobos/plugins/:id', async (req, reply) => {
    const r = await store.get(req.params.id);
    if (!r) return reply.status(404).send({ error: 'Plugin not found' });
    try { if (fs.existsSync(r.archive_path)) fs.unlinkSync(r.archive_path); }
    catch (e) { console.warn(`[PluginRoutes] Could not delete ${r.archive_path}:`, e); }
    await store.remove(r.id);
    return reply.send({ ok: true, deleted: r.id });
  });

  // ── Upload (binary, one file per request) ────────────────────────────────
  // POST /api/phobos/plugins/upload?filename=foo.phobos[&sessionId=xyz]
  // Body: raw binary (application/octet-stream or any content-type)
  // Returns: { installed?, staged?, error? }

  fastify.post<{ Querystring: { filename?: string; sessionId?: string } }>(
    '/api/phobos/plugins/upload',
    async (req, reply) => {
      const filename  = req.query.filename ?? 'unknown';
      const sessionId = req.query.sessionId ?? `session_${Date.now()}`;
      const rawDir    = path.join(TRAINING_DIR, sessionId, 'raw');
      const data      = req.body as Buffer;

      if (!data || data.length === 0) {
        return reply.status(400).send({ error: 'Empty body' });
      }

      const ext = path.extname(filename).toLowerCase();

      try {
        if (ext === '.phobos') {
          const record = deser(await store.installPhobosArchive(data, filename));
          return reply.send({ installed: record, staged: null });

        } else if (ext === '.safetensors' || ext === '.gguf') {
          const record = deser(await store.installRawLora(data, filename));
          return reply.send({ installed: record, staged: null });

        } else if (ext === '.zip') {
          let isPlugin = false;
          try {
            const z = new AdmZip(data);
            const names = z.getEntries().map(e => e.entryName);
            isPlugin = names.includes('plugin.json') && names.some(n => n.endsWith('lora.safetensors'));
          } catch { /* not a valid zip */ }

          if (isPlugin) {
            const record = deser(await store.installPhobosArchive(data, filename));
            return reply.send({ installed: record, staged: null });
          } else {
            fs.mkdirSync(rawDir, { recursive: true });
            const images = extractImagesFromZip(data);
            for (const img of images) {
              fs.writeFileSync(path.join(rawDir, path.basename(img.filename)), img.data);
            }
            return reply.send({ installed: null, staged: { sessionId, imageCount: images.length } });
          }

        } else if (IMAGE_EXTS.has(ext)) {
          fs.mkdirSync(rawDir, { recursive: true });
          fs.writeFileSync(path.join(rawDir, path.basename(filename)), data);
          return reply.send({ installed: null, staged: { sessionId, imageCount: 1 } });

        } else {
          return reply.status(400).send({ error: `Unsupported file type: ${ext}` });
        }

      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );
}
