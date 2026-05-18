/**
 * userManagement.ts — PHOBOS User Management API.
 *
 * All routes are under /api/admin/*. The management panel is password-protected
 * independently of the rest of the app. A bcrypt hash of the management
 * password is stored in security_config under 'owner_password_hash'. An empty
 * hash means the password has never been set (first-run state).
 *
 * Session tokens are random 32-byte hex strings held in a module-level Set with
 * a 30-minute TTL. They are never persisted — app restart requires re-auth.
 * The token is passed as Authorization: Bearer <token> on protected routes.
 *
 * Route surface:
 *
 *   POST   /api/admin/auth              — verify password → token
 *   POST   /api/admin/auth/setup        — set initial password (only when none set)
 *   POST   /api/admin/auth/change       — change password (requires token)
 *   GET    /api/admin/status            — { activeUser, userCount, passwordSet } [no token]
 *
 *   GET    /api/admin/users             — list all users [token]
 *   POST   /api/admin/users             — create user + full provision [token]
 *   PATCH  /api/admin/users/:username   — update display_name or role [token]
 *   DELETE /api/admin/users/:username   — delete user (data dir preserved) [token]
 *   POST   /api/admin/users/:username/reprovision — retry failed service provision [token]
 *
 *   POST   /api/admin/switch-user       — write active-user.json + restart [token]
 *
 *   GET    /api/admin/access-codes      — list codes for this admin's users [token]
 *   POST   /api/admin/access-codes      — generate a guest or self access code [token]
 *   DELETE /api/admin/access-codes/:code — revoke (mark consumed) [token]
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';
import bcrypt      from 'bcryptjs';
import { DatabaseManager, getActiveUser, writeActiveUser } from '../db/DatabaseManager.js';
import { encodeAccessCode, generateNonce, decodeAccessCode, isStructuredCode } from '../webrtc/AccessCodeEncoder.js';
import { SecurityStore }                           from '../db/SecurityStore.js';
import { UserStore, type UserRole }               from '../db/UserStore.js';
import { UserServiceTokenStore }                   from '../db/UserServiceTokenStore.js';
import { provisionSystemUser, deprovisionSystemUser, type ProvisionResult } from '../db/UserProvisioner.js';
import {
  provisionUser  as jellyfinProvisionUser,
  deprovisionUser as jellyfinDeprovisionUser,
} from '../services/JellyfinManager.js';
import {
  provisionUser  as kavitaProvisionUser,
  deprovisionUser as kavitaDeprovisionUser,
} from '../services/KavitaManager.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const SALT_ROUNDS    = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 minutes

const VALID_ROLES = new Set<UserRole>(['admin', 'full', 'guest', 'read']);

// ── In-memory session store ────────────────────────────────────────────────────

const _sessions = new Set<string>();

function issueToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  _sessions.add(token);
  setTimeout(() => _sessions.delete(token), SESSION_TTL_MS);
  return token;
}

function validateToken(token: string): boolean {
  return _sessions.has(token);
}

// ── Auth preHandler ────────────────────────────────────────────────────────────

function requireToken(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Authorization required' });
    return;
  }
  const token = auth.slice(7);
  if (!validateToken(token)) {
    reply.status(401).send({ error: 'Session expired or invalid' });
    return;
  }
  done();
}

// ── Username validation ────────────────────────────────────────────────────────

function isValidUsername(u: string): boolean {
  // Lowercase alphanumeric and hyphens only, 1–32 chars.
  // Must be a valid directory name on all platforms.
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(u);
}


// ── User provisioning ──────────────────────────────────────────────────────────

// ── Route registration ─────────────────────────────────────────────────────────



// ── Route registration ─────────────────────────────────────────────────────────

interface UserMgmtContext {
  systemDb:   ReturnType<typeof DatabaseManager.getInstance> | null;
  instanceId: string;
  relayUrl:   string;
}

let _ctx: UserMgmtContext = {
  systemDb:   null,
  instanceId: '',
  relayUrl:   '',
};

export function setUserManagementContext(
  systemDb:   ReturnType<typeof DatabaseManager.getInstance>,
  instanceId: string,
  relayUrl:   string,
): void {
  _ctx.systemDb   = systemDb;
  _ctx.instanceId = instanceId;
  _ctx.relayUrl   = relayUrl;
}

export async function registerUserManagementRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const systemDb      = _ctx.systemDb ?? DatabaseManager.getInstance();
  const securityStore = new SecurityStore(systemDb);
  const userStore     = new UserStore(systemDb);

  // ── Helper: read and verify password hash ─────────────────────────────────

  async function getPasswordHash(): Promise<string> {
    return securityStore.getConfig('owner_password_hash');
  }

  async function setPasswordHash(plain: string): Promise<void> {
    const hash = await bcrypt.hash(plain, SALT_ROUNDS);
    await securityStore.setConfig('owner_password_hash', hash);
  }

  // ── Public: status (no token required) ────────────────────────────────────

  fastify.get('/api/admin/status', async (_req, reply) => {
    const hash        = await getPasswordHash();
    const activeUser  = getActiveUser();
    const userCount   = await userStore.count();
    return reply.send({
      activeUser,
      userCount,
      passwordSet: hash.length > 0,
    });
  });

  // ── POST /api/admin/auth — verify password, issue token ───────────────────

  fastify.post('/api/admin/auth', async (req, reply) => {
    const { password } = req.body as { password?: string };
    if (!password) return reply.status(400).send({ error: 'password required' });

    const hash = await getPasswordHash();
    if (!hash) {
      return reply.status(403).send({ error: 'no_password_set' });
    }

    const ok = await bcrypt.compare(password, hash);
    if (!ok) return reply.status(401).send({ error: 'Invalid password' });

    return reply.send({ token: issueToken() });
  });

  // ── POST /api/admin/auth/setup — set initial password (first-run only) ────

  fastify.post('/api/admin/auth/setup', async (req, reply) => {
    const hash = await getPasswordHash();
    if (hash.length > 0) {
      return reply.status(409).send({ error: 'Password already set. Use /auth/change.' });
    }

    const { password, confirm } = req.body as { password?: string; confirm?: string };
    if (!password || !confirm) {
      return reply.status(400).send({ error: 'password and confirm required' });
    }
    if (password !== confirm) {
      return reply.status(400).send({ error: 'Passwords do not match' });
    }
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    await setPasswordHash(password);
    return reply.send({ token: issueToken() });
  });

  // ── POST /api/admin/auth/change — change password [token required] ────────

  fastify.post('/api/admin/auth/change', { preHandler: requireToken }, async (req, reply) => {
    const { currentPassword, newPassword, confirm } = req.body as {
      currentPassword?: string;
      newPassword?:     string;
      confirm?:         string;
    };

    if (!currentPassword || !newPassword || !confirm) {
      return reply.status(400).send({ error: 'currentPassword, newPassword, and confirm required' });
    }
    if (newPassword !== confirm) {
      return reply.status(400).send({ error: 'New passwords do not match' });
    }
    if (newPassword.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    const hash = await getPasswordHash();
    const ok   = await bcrypt.compare(currentPassword, hash);
    if (!ok) return reply.status(401).send({ error: 'Current password incorrect' });

    await setPasswordHash(newPassword);
    return reply.send({ ok: true });
  });

  // ── GET /api/admin/users — list all users [token required] ────────────────

  fastify.get('/api/admin/users', { preHandler: requireToken }, async (_req, reply) => {
    const users = await userStore.list();
    return reply.send({ users });
  });

  // ── POST /api/admin/users — create user [token required] ──────────────────

  fastify.post('/api/admin/users', { preHandler: requireToken }, async (req, reply) => {
    const { username, display_name, role } = req.body as {
      username?:     string;
      display_name?: string;
      role?:         string;
    };

    if (!username || !display_name || !role) {
      return reply.status(400).send({ error: 'username, display_name, and role required' });
    }
    if (!isValidUsername(username)) {
      return reply.status(400).send({
        error: 'username must be lowercase alphanumeric (hyphens allowed), 1–32 chars',
      });
    }
    if (!VALID_ROLES.has(role as UserRole)) {
      return reply.status(400).send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    if (display_name.trim().length === 0 || display_name.length > 64) {
      return reply.status(400).send({ error: 'display_name must be 1–64 characters' });
    }

    try {
      const provResult = await provisionSystemUser(username, role as UserRole, userStore, display_name.trim());
      const created = await userStore.getByUsername(username);
      return reply.status(201).send({
        user:       created,
        jellyfinOk: provResult.jellyfinOk,
        kavitaOk:   provResult.kavitaOk,
        errors:     provResult.errors,
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('already exists')) return reply.status(409).send({ error: msg });
      throw err;
    }
  });

  // ── PATCH /api/admin/users/:username — update user [token required] ───────

  fastify.patch('/api/admin/users/:username', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.params as { username: string };
    const { display_name, role } = req.body as { display_name?: string; role?: string };

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    if (role !== undefined && !VALID_ROLES.has(role as UserRole)) {
      return reply.status(400).send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    // Prevent demoting the last admin.
    if (role && role !== 'admin' && username === 'owner') {
      const allUsers = await userStore.list();
      const adminCount = allUsers.filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return reply.status(409).send({ error: 'Cannot demote the last admin user' });
      }
    }
    if (display_name !== undefined && (display_name.trim().length === 0 || display_name.length > 64)) {
      return reply.status(400).send({ error: 'display_name must be 1–64 characters' });
    }

    await userStore.update(username, {
      display_name: display_name?.trim(),
      role: role as UserRole | undefined,
    });

    const updated = await userStore.getByUsername(username);
    return reply.send({ user: updated });
  });

  // ── DELETE /api/admin/users/:username — delete user [token required] ──────

  fastify.delete('/api/admin/users/:username', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.params as { username: string };

    if (username === 'owner') {
      return reply.status(403).send({ error: 'The owner account cannot be deleted' });
    }

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    // Block deleting the currently active user.
    if (username === getActiveUser()) {
      return reply.status(409).send({ error: 'Cannot delete the currently active user. Switch user first.' });
    }

    await deprovisionSystemUser(username, systemDb, userStore);

    return reply.send({ ok: true, note: `User removed. Data dir at ~/.phobos/users/${username}/ was preserved.` });
  });

  // ── POST /api/admin/switch-user — switch active user [token required] ─────

  fastify.post('/api/admin/switch-user', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.body as { username?: string };
    if (!username) return reply.status(400).send({ error: 'username required' });

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    // Write atomically before signalling restart so the new process reads it.
    writeActiveUser(username);

    await userStore.stampLastActive(username);

    // Signal the Electron shell to relaunch. process.exit(0) is the agreed
    // restart contract — the Electron main process watches for clean exit and
    // relaunches. Reply first so the frontend receives the 200 before teardown.
    reply.send({ ok: true, switchingTo: username });
    setImmediate(() => process.exit(0));

    return reply;
  });

  // ── POST /api/admin/users/:username/reprovision — retry service provision ──

  fastify.post('/api/admin/users/:username/reprovision', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.params as { username: string };

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    const userDb     = DatabaseManager.getUserDb(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    const result: ProvisionResult = { jellyfinOk: false, kavitaOk: false, errors: [] };

    try {
      const jf = await jellyfinProvisionUser(username);
      await tokenStore.setJellyfin({ user_id: jf.userId, access_token: jf.accessToken });
      result.jellyfinOk = true;
    } catch (err) {
      result.errors.push(`Jellyfin: ${(err as Error).message}`);
    }

    try {
      const kv = await kavitaProvisionUser(username);
      await tokenStore.setKavita({
        user_id:       kv.userId,
        jwt:           kv.jwt,
        refresh_token: kv.refreshToken,
        api_key:       kv.apiKey,
      });
      result.kavitaOk = true;
    } catch (err) {
      result.errors.push(`Kavita: ${(err as Error).message}`);
    }

    return reply.send(result);
  });

  // ── GET /api/admin/access-codes — list codes [token required] ─────────────────────────

  fastify.get('/api/admin/access-codes', { preHandler: requireToken }, async (_req, reply) => {
    const activeUser = getActiveUser();
    const rows = await systemDb.query<{
      code:             string;
      issuing_username: string;
      target_username:  string | null;
      code_type:        string;
      consumed:         boolean;
      created_at:       string;
      expires_at:       string;
    }>(
      `SELECT code, issuing_username, target_username, code_type,
              consumed,
              created_at::VARCHAR AS created_at,
              expires_at::VARCHAR AS expires_at
       FROM access_codes
       WHERE issuing_username = ?
       ORDER BY created_at DESC`,
      [activeUser],
    );

    // Re-encode each nonce into its full PH1.* string for display.
    const codes = rows.map(row => ({
      ...row,
      encoded_code: encodeAccessCode(
        row.code_type === 'self' ? 'OWN' : 'GST',
        _ctx.instanceId,
        _ctx.relayUrl,
        new Date(row.expires_at),
        row.code,
      ),
    }));

    return reply.send({ codes });
  });

  // ── POST /api/admin/access-codes — generate a code [token required] ───────────

  fastify.post('/api/admin/access-codes', { preHandler: requireToken }, async (req, reply) => {
    const {
      code_type        = 'guest',
      expires_in_hours = 72,
    } = req.body as {
      code_type?:        'guest' | 'self';
      expires_in_hours?: number;
    };

    if (!['guest', 'self'].includes(code_type)) {
      return reply.status(400).send({ error: 'code_type must be guest or self' });
    }

    const activeUser  = getActiveUser();
    const nonce       = generateNonce();
    const expiresAt   = new Date(Date.now() + expires_in_hours * 3_600_000);
    const encoderType = code_type === 'self' ? 'OWN' : 'GST';
    const encodedCode = encodeAccessCode(encoderType, _ctx.instanceId, _ctx.relayUrl, expiresAt, nonce);

    await systemDb.execWithParams(
      `INSERT INTO access_codes
         (code, issuing_username, target_username, code_type, single_use, consumed, created_at, expires_at)
       VALUES (?, ?, NULL, ?, true, false, now(), ?)`,
      [nonce, activeUser, code_type, expiresAt.toISOString()],
    );

    return reply.status(201).send({
      code: {
        nonce,
        encoded_code:     encodedCode,
        code_type,
        issuing_username: activeUser,
        consumed:         false,
        expires_at:       expiresAt.toISOString(),
      },
    });
  });

  // ── DELETE /api/admin/access-codes/:code — revoke a code [token required] ─────────
  // :code accepts either the raw nonce or the full PH1.* string.

  fastify.delete('/api/admin/access-codes/:code', { preHandler: requireToken }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const activeUser = getActiveUser();

    // Support both nonce and full encoded code for flexibility.
    const nonce = isStructuredCode(code) ? (decodeAccessCode(code)?.nonce ?? code) : code;

    const rows = await systemDb.query<{ issuing_username: string }>(
      `SELECT issuing_username FROM access_codes WHERE code = ?`,
      [nonce],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Code not found' });
    if (rows[0].issuing_username !== activeUser) {
      return reply.status(403).send({ error: 'Cannot revoke another user\'s access code' });
    }

    await systemDb.execWithParams(
      `UPDATE access_codes SET consumed = true WHERE code = ?`,
      [nonce],
    );
    return reply.send({ ok: true });
  });
}