/**
 * vaultRoutes.ts — PHOBOS Vault API routes.
 *
 * Mirrors registerHaRoutes exactly: DatabaseManager.getInstance() is called
 * inside the function body, not at module load time. This is safe because
 * buildServer() is only called after the DB is initialized on both boot paths.
 * VaultStore is constructed here — no parameter needed from continueBootSequence.
 *
 * POST   /api/vault/create
 * POST   /api/vault/unlock
 * POST   /api/vault/lock
 * GET    /api/vault/status
 * GET    /api/vault/config
 * PUT    /api/vault/config
 * POST   /api/vault/change-password
 *
 * GET    /api/vault/entries
 * GET    /api/vault/entries/:uuid
 * GET    /api/vault/entries/:uuid/secret
 * POST   /api/vault/entries
 * PUT    /api/vault/entries/:uuid
 * DELETE /api/vault/entries/:uuid
 *
 * GET    /api/vault/groups
 * POST   /api/vault/groups
 * PUT    /api/vault/groups/:uuid
 * DELETE /api/vault/groups/:uuid
 *
 * Locked vault → 423. Wrong password → 401 opaque. Not found → 404.
 */

import type { FastifyInstance } from 'fastify';
import { DatabaseManager }      from '../db/DatabaseManager.js';
import { VaultStore }           from '../db/VaultStore.js';
import {
  unlockVault,
  lockVault,
  createVault,
  changeMasterPassword,
  vaultExists,
  getVaultStatus,
  listEntries,
  getEntry,
  getEntrySecret,
  searchEntries,
  listGroups,
  createEntry,
  updateEntry,
  deleteEntry,
  createGroup,
  renameGroup,
  deleteGroup,
  applyConfigUpdate,
} from '../vault/VaultManager.js';
import type { VaultEntryInput } from '../vault/VaultTypes.js';

function isVaultLocked(err: unknown): boolean {
  return (err as { vaultLocked?: boolean }).vaultLocked === true;
}

function isNotFound(err: unknown): boolean {
  return (err as Error).message?.includes('not found') ?? false;
}

export async function registerVaultRoutes(fastify: FastifyInstance): Promise<void> {
  const db    = DatabaseManager.getInstance();
  const store = new VaultStore(db);
  await store.ensureTable();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  fastify.post('/api/vault/create', async (req, reply) => {
    const { password } = req.body as { password?: string };
    if (!password) return reply.status(400).send({ error: 'password required' });
    if (vaultExists()) return reply.status(409).send({ error: 'Vault already exists' });
    try {
      await createVault(password);
      await store.stampLastOpened();
      return reply.send({ ok: true, status: getVaultStatus() });
    } catch (err) {
      fastify.log.error(err, '[Vault] create failed');
      return reply.status(500).send({ error: 'Failed to create vault' });
    }
  });

  fastify.post('/api/vault/unlock', async (req, reply) => {
    const { password } = req.body as { password?: string };
    if (!password) return reply.status(400).send({ error: 'password required' });
    try {
      await unlockVault(password);
      const cfg    = await store.getAll();
      const status = getVaultStatus();
      status.lastOpenedAt = cfg.last_opened_at;
      return reply.send({ ok: true, status });
    } catch {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
  });

  fastify.post('/api/vault/lock', async (_req, reply) => {
    lockVault();
    return reply.send({ ok: true });
  });

  fastify.get('/api/vault/status', async (_req, reply) => {
    const status = getVaultStatus();
    const cfg    = await store.getAll();
    status.lastOpenedAt = cfg.last_opened_at;
    return reply.send(status);
  });

  fastify.post('/api/vault/change-password', async (req, reply) => {
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword) return reply.status(400).send({ error: 'newPassword required' });
    try {
      await changeMasterPassword(newPassword);
      return reply.send({ ok: true });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      fastify.log.error(err, '[Vault] change-password failed');
      return reply.status(500).send({ error: 'Failed to change password' });
    }
  });

  // ── Config ─────────────────────────────────────────────────────────────────

  fastify.get('/api/vault/config', async (_req, reply) => {
    const cfg = await store.getAll();
    return reply.send({
      db_path:              cfg.db_path,
      lock_timeout_seconds: cfg.lock_timeout_seconds,
    });
  });

  fastify.put('/api/vault/config', async (req, reply) => {
    const body = req.body as { db_path?: string; lock_timeout_seconds?: number };
    await store.patch({
      db_path:              body.db_path,
      lock_timeout_seconds: body.lock_timeout_seconds,
    });
    applyConfigUpdate({
      db_path:              body.db_path,
      lock_timeout_seconds: body.lock_timeout_seconds,
    });
    const cfg = await store.getAll();
    return reply.send({
      db_path:              cfg.db_path,
      lock_timeout_seconds: cfg.lock_timeout_seconds,
    });
  });

  // ── Entries ────────────────────────────────────────────────────────────────

  fastify.get('/api/vault/entries', async (req, reply) => {
    const { q, group } = req.query as { q?: string; group?: string };
    try {
      let entries = q ? searchEntries(q) : listEntries();
      if (group) entries = entries.filter(e => e.groupUuid === group);
      return reply.send({ entries });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.get<{ Params: { uuid: string } }>('/api/vault/entries/:uuid', async (req, reply) => {
    try {
      const entry = getEntry(req.params.uuid);
      if (!entry) return reply.status(404).send({ error: 'Entry not found' });
      return reply.send(entry);
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.get<{ Params: { uuid: string } }>('/api/vault/entries/:uuid/secret', async (req, reply) => {
    try {
      const secret = getEntrySecret(req.params.uuid);
      if (secret === null) return reply.status(404).send({ error: 'Entry not found' });
      return reply.send({ password: secret });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.post('/api/vault/entries', async (req, reply) => {
    const body = req.body as Partial<VaultEntryInput>;
    if (!body.title) return reply.status(400).send({ error: 'title required' });
    try {
      const uuid = await createEntry({
        groupUuid: body.groupUuid ?? '',
        title:     body.title    ?? '',
        username:  body.username ?? '',
        password:  body.password ?? '',
        url:       body.url      ?? '',
        notes:     body.notes    ?? '',
        tags:      body.tags     ?? [],
        expires:   body.expires  ?? null,
      });
      return reply.status(201).send({ uuid });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.put<{ Params: { uuid: string } }>('/api/vault/entries/:uuid', async (req, reply) => {
    const body = req.body as Partial<VaultEntryInput>;
    try {
      await updateEntry(req.params.uuid, body);
      return reply.send({ ok: true });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      if (isNotFound(err))    return reply.status(404).send({ error: 'Entry not found' });
      throw err;
    }
  });

  fastify.delete<{ Params: { uuid: string } }>('/api/vault/entries/:uuid', async (req, reply) => {
    try {
      await deleteEntry(req.params.uuid);
      return reply.send({ ok: true });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      if (isNotFound(err))    return reply.status(404).send({ error: 'Entry not found' });
      throw err;
    }
  });

  // ── Groups ─────────────────────────────────────────────────────────────────

  fastify.get('/api/vault/groups', async (_req, reply) => {
    try {
      return reply.send({ groups: listGroups() });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.post('/api/vault/groups', async (req, reply) => {
    const { name, parentUuid } = req.body as { name?: string; parentUuid?: string };
    if (!name) return reply.status(400).send({ error: 'name required' });
    try {
      const uuid = await createGroup(name, parentUuid ?? null);
      return reply.status(201).send({ uuid });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      throw err;
    }
  });

  fastify.put<{ Params: { uuid: string } }>('/api/vault/groups/:uuid', async (req, reply) => {
    const { name } = req.body as { name?: string };
    if (!name) return reply.status(400).send({ error: 'name required' });
    try {
      await renameGroup(req.params.uuid, name);
      return reply.send({ ok: true });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      if (isNotFound(err))    return reply.status(404).send({ error: 'Group not found' });
      throw err;
    }
  });

  fastify.delete<{ Params: { uuid: string } }>('/api/vault/groups/:uuid', async (req, reply) => {
    try {
      await deleteGroup(req.params.uuid);
      return reply.send({ ok: true });
    } catch (err) {
      if (isVaultLocked(err)) return reply.status(423).send({ error: 'Vault is locked' });
      if (isNotFound(err))    return reply.status(404).send({ error: 'Group not found' });
      throw err;
    }
  });
}
