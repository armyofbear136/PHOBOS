/**
 * userManagement.ts — PHOBOS User Management API.
 *
 * All management routes are under /api/admin/* and require a session token.
 * Auth is per-user: each user's bcrypt hash is stored in guest_credentials.
 * Session tokens are random 32-byte hex strings held in a module-level Map
 * (token → username) with a 30-minute TTL. Never persisted — restart clears all.
 * Token passed as Authorization: Bearer <token> on protected routes.
 *
 * Route surface:
 *
 *   POST   /api/admin/auth              — verify username+password → { token, role }
 *   POST   /api/admin/auth/setup        — first-time or pre-upgrade password set
 *   POST   /api/admin/auth/change       — change own password (requires token)
 *   GET    /api/admin/status            — { activeUser, userCount, passwordSet } [no token]
 *
 *   GET    /api/admin/users             — list all users [token]
 *   POST   /api/admin/users             — create user + full provision [token, admin/owner only]
 *   PATCH  /api/admin/users/:username   — update display_name or role [token]
 *   DELETE /api/admin/users/:username   — delete user (role hierarchy enforced) [token]
 *   POST   /api/admin/users/:username/reprovision — retry failed service provision [token]
 *
 *   POST   /api/admin/switch-user       — write active-user.json + restart [token, admin/owner only]
 *
 *   GET    /api/admin/access-codes      — list codes for this admin's users [token]
 *   POST   /api/admin/access-codes      — generate a guest or self access code [token]
 *   DELETE /api/admin/access-codes/:code — revoke (mark consumed) [token]
 *
 *   GET    /api/users/list              — public: username + display_name list for login screen
 *   POST   /api/session/login           — public: verify credentials, write active-user.json
 *
 *   POST   /api/user/invite             — generate a guest invite code [full/admin/owner via WebRTC]
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as crypto from 'node:crypto';
import bcrypt      from 'bcryptjs';
import { DatabaseManager, getActiveUser, writeActiveUser } from '../db/DatabaseManager.js';
import { performUserSwitch } from '../server.js';
import { encodeAccessCode, generateNonce, decodeAccessCode, isStructuredCode } from '../webrtc/AccessCodeEncoder.js';
import { SecurityStore }                           from '../db/SecurityStore.js';
import { UserStore, type UserRole }               from '../db/UserStore.js';
import { UserServiceTokenStore }                   from '../db/UserServiceTokenStore.js';
import { provisionSystemUser, deprovisionSystemUser, queryDeprovisionInventory, type ProvisionResult } from '../db/UserProvisioner.js';
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

// Roles the management panel can assign. 'admin' is excluded — only the
// owner account holds admin, and it cannot be granted from the panel.
const VALID_ROLES = new Set<UserRole>(['full', 'guest', 'read']);

// ── In-memory session store ────────────────────────────────────────────────────

const _sessions = new Map<string, string>();  // token → username

function issueToken(username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  _sessions.set(token, username);
  setTimeout(() => _sessions.delete(token), SESSION_TTL_MS);
  return token;
}

function validateToken(token: string): boolean {
  return _sessions.has(token);
}

function tokenUsername(token: string): string | null {
  return _sessions.get(token) ?? null;
}

// ── Local browser session store ────────────────────────────────────────────────
// Separate from the admin token store. These tokens authenticate the local
// browser UI — they are reset every server restart (in-memory only).
// The frontend stores the token in sessionStorage and sends it as
// x-local-session on every request. Cleared on logout or tab close.

const _localSessions = new Set<string>();

export function issueLocalSession(): string {
  const token = crypto.randomBytes(32).toString('hex');
  _localSessions.add(token);
  return token;
}

export function validateLocalSession(token: string): boolean {
  return _localSessions.has(token);
}

export function revokeLocalSession(token: string): void {
  _localSessions.delete(token);
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
  port:       number;
}

let _ctx: UserMgmtContext = {
  systemDb:   null,
  instanceId: '',
  relayUrl:   '',
  port:       3001,
};

export function setUserManagementContext(
  systemDb:   ReturnType<typeof DatabaseManager.getInstance>,
  instanceId: string,
  relayUrl:   string,
  port:       number,
): void {
  _ctx.systemDb   = systemDb;
  _ctx.instanceId = instanceId;
  _ctx.relayUrl   = relayUrl;
  _ctx.port       = port;
}

export async function registerUserManagementRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const systemDb      = _ctx.systemDb ?? DatabaseManager.getInstance();
  const securityStore = new SecurityStore(systemDb);
  const userStore     = new UserStore(systemDb);

  // ── Public: status (no token required) ────────────────────────────────────

  fastify.get('/api/admin/status', async (_req, reply) => {
    const activeUser  = getActiveUser();
    const userCount   = await userStore.count();
    // passwordSet reflects whether the active user has a credential row.
    const rows = await systemDb.query<{ username: string }>(
      `SELECT username FROM guest_credentials WHERE username = ?`, [activeUser],
    );
    return reply.send({
      activeUser,
      userCount,
      passwordSet: rows.length > 0,
    });
  });

  // ── POST /api/admin/auth — verify per-user password, issue token ──────────

  fastify.post('/api/admin/auth', async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password required' });
    }

    const user = await userStore.getByUsername(username);
    if (!user || (user.role !== 'admin' && user.role !== 'full')) {
      return reply.status(403).send({ error: 'Insufficient role' });
    }

    const rows = await systemDb.query<{ password_hash: string }>(
      `SELECT password_hash FROM guest_credentials WHERE username = ?`, [username],
    );
    if (rows.length === 0) {
      return reply.status(403).send({ error: 'no_password_set' });
    }

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return reply.status(401).send({ error: 'Invalid password' });

    return reply.send({ token: issueToken(username), role: user.role });
  });

  // ── POST /api/admin/auth/setup — first-time password set (pre-upgrade or new user) ──
  // Used when a user has no guest_credentials row yet. Accepts username +
  // password + confirm, writes the credential row, returns a token.

  fastify.post('/api/admin/auth/setup', async (req, reply) => {
    const { username, password, confirm } = req.body as {
      username?: string; password?: string; confirm?: string;
    };
    if (!username || !password || !confirm) {
      return reply.status(400).send({ error: 'username, password, and confirm required' });
    }
    if (password !== confirm) {
      return reply.status(400).send({ error: 'Passwords do not match' });
    }
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    const user = await userStore.getByUsername(username);
    if (!user || (user.role !== 'admin' && user.role !== 'full')) {
      return reply.status(403).send({ error: 'Insufficient role' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await systemDb.execWithParams(
      `INSERT INTO guest_credentials (username, password_hash, created_at, updated_at)
       VALUES (?, ?, now(), now())
       ON CONFLICT (username) DO UPDATE SET password_hash = ?, updated_at = now()`,
      [username, hash, hash],
    );
    return reply.send({ token: issueToken(username), role: user.role });
  });

  // ── POST /api/admin/auth/change — change own password [token required] ────

  fastify.post('/api/admin/auth/change', { preHandler: requireToken }, async (req, reply) => {
    const callerUsername = tokenUsername(req.headers['authorization']?.slice(7) ?? '');
    if (!callerUsername) return reply.status(401).send({ error: 'Invalid session' });

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

    const rows = await systemDb.query<{ password_hash: string }>(
      `SELECT password_hash FROM guest_credentials WHERE username = ?`, [callerUsername],
    );
    if (rows.length === 0) return reply.status(403).send({ error: 'no_password_set' });

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return reply.status(401).send({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await systemDb.execWithParams(
      `UPDATE guest_credentials SET password_hash = ?, updated_at = now() WHERE username = ?`,
      [hash, callerUsername],
    );
    return reply.send({ ok: true });
  });

  // ── GET /api/admin/users — list all users [token required] ────────────────

  fastify.get('/api/admin/users', { preHandler: requireToken }, async (_req, reply) => {
    const users = await userStore.list();
    return reply.send({ users });
  });

  // ── POST /api/admin/users — create user [token required] ──────────────────

  fastify.post('/api/admin/users', { preHandler: requireToken }, async (req, reply) => {
    const callerUsername = tokenUsername(req.headers['authorization']?.slice(7) ?? '');
    const caller = callerUsername ? await userStore.getByUsername(callerUsername) : null;
    if (!caller || (caller.role !== 'admin')) {
      return reply.status(403).send({ error: 'Only admins can add users' });
    }

    const { username, display_name, role, password } = req.body as {
      username?:     string;
      display_name?: string;
      role?:         string;
      password?:     string;
    };

    if (!username || !display_name || !role || !password) {
      return reply.status(400).send({ error: 'username, display_name, role, and password required' });
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
    if (password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    try {
      const provResult = await provisionSystemUser(
        username, role as UserRole, userStore, display_name.trim(), password, systemDb,
      );
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
    // Owner's role is permanent — cannot be changed from the panel.
    if (role !== undefined && username === 'owner') {
      return reply.status(403).send({ error: 'Cannot change the owner role' });
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

  // ── GET /api/admin/users/:username/deprovision-inventory — pre-flight query ─
  // Returns what the user owns before any deletion so the UI can show a
  // summary and present the preservation choice.

  fastify.get('/api/admin/users/:username/deprovision-inventory', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.params as { username: string };

    if (username === 'owner') {
      return reply.status(403).send({ error: 'The owner account cannot be deleted' });
    }

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    try {
      const inventory = await queryDeprovisionInventory(username, systemDb);
      return reply.send({ username, inventory });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── DELETE /api/admin/users/:username — delete user [token required] ──────
  // Body (optional): { preserveAll?: boolean }
  //   preserveAll = true  → workspaces + library moved to lost-and-found
  //   preserveAll = false → workspaces + library deleted (default)
  // Plugins, cartridges, and weclone are always moved to lost-and-found
  // regardless of preserveAll — they may be in use by other users.
  //
  // Response includes lostAndFoundPath and rescuedItems so the UI can show
  // the persistent "Collect your protected user data here" banner.

  fastify.delete('/api/admin/users/:username', { preHandler: requireToken }, async (req, reply) => {
    const { username } = req.params as { username: string };

    if (username === 'owner') {
      return reply.status(403).send({ error: 'The owner account cannot be deleted' });
    }

    const target = await userStore.getByUsername(username);
    if (!target) return reply.status(404).send({ error: `User '${username}' not found` });

    if (username === getActiveUser()) {
      return reply.status(409).send({ error: 'Cannot delete the currently active user. Switch user first.' });
    }

    // Enforce role hierarchy.
    const callerUsername = tokenUsername(req.headers['authorization']?.slice(7) ?? '');
    const caller = callerUsername ? await userStore.getByUsername(callerUsername) : null;

    if (caller?.role === 'admin') {
      // Admins cannot delete other admin accounts.
      if (target.role === 'admin') {
        return reply.status(403).send({ error: 'Admins cannot delete other admin accounts' });
      }
    } else if (caller?.role === 'full') {
      // Full users can only delete guests they personally provisioned.
      if (target.role !== 'guest' && target.role !== 'read') {
        return reply.status(403).send({ error: 'Full users can only delete guest accounts' });
      }
      const issued = await systemDb.query<{ issuing_username: string }>(
        `SELECT issuing_username FROM access_codes
         WHERE target_username = ? ORDER BY created_at DESC LIMIT 1`,
        [username],
      );
      if (!issued[0] || issued[0].issuing_username !== callerUsername) {
        return reply.status(403).send({ error: 'You can only delete guests you provisioned' });
      }
    } else {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { preserveAll = false } = (req.body ?? {}) as { preserveAll?: boolean };

    const result = await deprovisionSystemUser(username, systemDb, userStore, preserveAll);

    return reply.send({
      ok:               true,
      lostAndFoundPath: result.lostAndFoundPath,
      rescuedItems:     result.rescuedItems,
      message:          result.message,
    });
  });

  // ── POST /api/admin/switch-user — switch active user [token required] ─────
  fastify.post('/api/admin/switch-user', { preHandler: requireToken }, async (req, reply) => {
    const callerUsername = tokenUsername(req.headers['authorization']?.slice(7) ?? '');
    const caller = callerUsername ? await userStore.getByUsername(callerUsername) : null;
    if (!caller || (caller.role !== 'admin')) {
      return reply.status(403).send({ error: 'Only admins can switch the active user' });
    }

    const { username } = req.body as { username?: string };
    if (!username) return reply.status(400).send({ error: 'username required' });

    const existing = await userStore.getByUsername(username);
    if (!existing) return reply.status(404).send({ error: `User '${username}' not found` });

    await userStore.stampLastActive(username);

    // Reply before switching so the frontend receives 200 before any teardown.
    reply.send({ ok: true, switchingTo: username });

    setImmediate(async () => {
      try {
        const switchSecurityStore = new SecurityStore(_ctx.systemDb ?? DatabaseManager.getInstance());
        await performUserSwitch(username, switchSecurityStore, _ctx.port);
      } catch (err) {
        console.error('[UserSwitch] Failed to switch user in-process:', err);
      }
    });

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
      const existingKavita = await tokenStore.getKavita().catch(() => null);
      const kv = await kavitaProvisionUser(username, existingKavita?.password);
      await tokenStore.setKavita({
        user_id:       kv.userId,
        jwt:           kv.jwt,
        refresh_token: kv.refreshToken,
        api_key:       kv.apiKey,
        password:      kv.password,
      });
      result.kavitaOk = true;
    } catch (err) {
      result.errors.push(`Kavita: ${(err as Error).message}`);
    }

    return reply.send(result);
  });

  // ── GET /api/users/list — public user list for local login screen ──────────
  // Returns username + display_name only. No token required. Used by
  // ConnectionSplash.tsx to render the login screen user cards.

  fastify.get('/api/users/list', async (_req, reply) => {
    const users = await systemDb.query<{ username: string; display_name: string }>(
      `SELECT username, display_name FROM users ORDER BY username ASC`,
    );
    return reply.send({ users });
  });

  // ── POST /api/session/login — local login screen submission ───────────────
  // Verifies username + password against guest_credentials, writes
  // active-user.json, issues a local session token, and returns
  // { ok, username, role, sessionToken }.

  fastify.post('/api/session/login', async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password required' });
    }

    const user = await userStore.getByUsername(username);
    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const rows = await systemDb.query<{ password_hash: string }>(
      `SELECT password_hash FROM guest_credentials WHERE username = ?`, [username],
    );
    if (rows.length === 0) {
      return reply.status(403).send({ error: 'no_password_set' });
    }

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return reply.status(401).send({ error: 'Invalid credentials' });

    writeActiveUser(username);
    await userStore.stampLastActive(username);
    const sessionToken = issueLocalSession();
    return reply.send({ ok: true, username, role: user.role, sessionToken });
  });

  // ── POST /api/session/logout — invalidate local session ───────────────────

  fastify.post('/api/session/logout', async (req, reply) => {
    const token = req.headers['x-local-session'] as string | undefined;
    if (token) revokeLocalSession(token);
    return reply.send({ ok: true });
  });

  // ── GET /api/session/status — check if browser session is active ──────────
  // Returns { loggedIn, username, lastUser } where lastUser is the value from
  // active-user.json — used to pre-select the user card on the login screen.

  fastify.get('/api/session/status', async (req, reply) => {
    const token    = req.headers['x-local-session'] as string | undefined;
    const loggedIn = !!token && validateLocalSession(token);
    return reply.send({
      loggedIn,
      lastUser: getActiveUser(),
    });
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

  // ── POST /api/user/invite — generate a guest invite code [full/admin/owner] ──
  // Accessible to full and admin users without the admin panel password.
  // guest and read roles are blocked by the server-level RBAC preHandler.

  fastify.post('/api/user/invite', async (req, reply) => {
    const role = (req.headers['x-webrtc-role'] as string | undefined)?.trim() ?? 'owner';
    if (role === 'guest' || role === 'read') {
      return reply.status(403).send({ error: 'Forbidden: insufficient role' });
    }

    const issuingUser = (req.headers['x-webrtc-user'] as string | undefined)?.trim() ?? getActiveUser();

    const {
      code_type        = 'guest',
      expires_in_hours = 72,
    } = (req.body ?? {}) as {
      code_type?:        'guest' | 'self';
      expires_in_hours?: number;
    };

    // full users may only issue guest codes — not self codes.
    if (role === 'full' && code_type !== 'guest') {
      return reply.status(403).send({ error: 'full users may only issue guest invite codes' });
    }
    if (!['guest', 'self'].includes(code_type)) {
      return reply.status(400).send({ error: 'code_type must be guest or self' });
    }

    const nonce       = generateNonce();
    const expiresAt   = new Date(Date.now() + expires_in_hours * 3_600_000);
    const encoderType = code_type === 'self' ? 'OWN' : 'GST';
    const encodedCode = encodeAccessCode(encoderType, _ctx.instanceId, _ctx.relayUrl, expiresAt, nonce);

    await systemDb.execWithParams(
      `INSERT INTO access_codes
         (code, issuing_username, target_username, code_type, single_use, consumed, created_at, expires_at)
       VALUES (?, ?, NULL, ?, true, false, now(), ?)`,
      [nonce, issuingUser, code_type, expiresAt.toISOString()],
    );

    return reply.status(201).send({
      code: {
        nonce,
        encoded_code:     encodedCode,
        code_type,
        issuing_username: issuingUser,
        consumed:         false,
        expires_at:       expiresAt.toISOString(),
      },
    });
  });
}