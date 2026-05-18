/**
 * AUTARCH — Code Companion Web Service
 * ─────────────────────────────────────
 * Serves the Vite production build AND handles license API routes.
 * Replaces the static site deployment on Render.
 *
 * Environment variables (set in Render dashboard):
 *   GITHUB_PAT            — GitHub Personal Access Token (repo scope)
 *   GITHUB_REPO           — e.g. "armyofbear136/code-companion"
 *   LICENSE_AES_KEY        — 64-char hex string (32 bytes) for AES-256-GCM
 *   PHOBOS_LICENSE_SEED    — HMAC seed (must match phobos-core)
 *   PAYPAL_WEBHOOK_ID      — PayPal webhook ID for signature verification (future)
 *   ADMIN_SECRET           — Secret for manual license admin endpoints
 *   PORT                   — Provided by Render automatically
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ─── Config ──────────────────────────────────────────────────────────────────
const GITHUB_PAT       = process.env.GITHUB_PAT       ?? '';
const GITHUB_REPO      = process.env.GITHUB_REPO      ?? 'armyofbear136/PHOBOS';
const LICENSE_AES_KEY   = process.env.LICENSE_AES_KEY   ?? '';  // 64 hex chars = 32 bytes
const LICENSE_SEED      = process.env.PHOBOS_LICENSE_SEED ?? '';
const ADMIN_SECRET      = process.env.ADMIN_SECRET     ?? '';
const WHITELIST_PATH    = 'data/licenses.enc';   // path within the GitHub repo
const GITHUB_BRANCH     = 'main';

// ─── AES-256-GCM helpers ────────────────────────────────────────────────────
function getAesKey() {
  if (!LICENSE_AES_KEY || LICENSE_AES_KEY.length !== 64) {
    throw new Error('LICENSE_AES_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(LICENSE_AES_KEY, 'hex');
}

function encryptEntry(plaintext) {
  const key = getAesKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(24hex):tag(32hex):ciphertext(hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptEntry(encoded) {
  const key = getAesKey();
  const [ivHex, tagHex, ctHex] = encoded.split(':');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed encrypted entry');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plain = decipher.update(ctHex, 'hex', 'utf8') + decipher.final('utf8');
  // Format: TXID|USERNAME|AMOUNT  (legacy entries are bare TXID with no pipes)
  const [txId, username = '', amount = '0'] = plain.split('|');
  return { txId, username, amount: parseFloat(amount) || 0 };
}

// ─── License key generation (matches phobos-core) ───────────────────────────
const KEY_VERSION = 'PH1';

function generateLicenseKey(transactionId) {
  if (!LICENSE_SEED) throw new Error('PHOBOS_LICENSE_SEED not configured');
  const normalized = transactionId.trim().toUpperCase();
  const hmac = createHmac('sha256', LICENSE_SEED);
  hmac.update(normalized);
  const hash = hmac.digest('hex').toUpperCase();
  const chunks = hash.match(/.{1,8}/g).slice(0, 5).join('-');
  return `${KEY_VERSION}-${chunks}`;
}

// ─── GitHub-backed whitelist ─────────────────────────────────────────────────
// In-memory cache to avoid hammering GitHub API
let cachedWhitelist = null;   // { entries: string[], sha: string, fetchedAt: number }
const CACHE_TTL_MS = 30_000; // 30 seconds

async function githubFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  });
  return res;
}

async function loadWhitelist(forceRefresh = false) {
  if (!GITHUB_PAT) throw new Error('GITHUB_PAT not configured');

  // Return cache if fresh
  if (!forceRefresh && cachedWhitelist && (Date.now() - cachedWhitelist.fetchedAt) < CACHE_TTL_MS) {
    return cachedWhitelist;
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${WHITELIST_PATH}?ref=${GITHUB_BRANCH}`;
  const res = await githubFetch(url);

  if (res.status === 404) {
    // File doesn't exist yet — empty whitelist
    return { entries: [], sha: null, fetchedAt: Date.now() };
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  const entries = content.split('\n').filter(line => line.trim().length > 0);

  cachedWhitelist = { entries, sha: data.sha, fetchedAt: Date.now() };
  return cachedWhitelist;
}

async function appendToWhitelist(encryptedEntry) {
  const current = await loadWhitelist(true); // force refresh before write

  const newEntries = [...current.entries, encryptedEntry];
  const newContent = newEntries.join('\n') + '\n';
  const contentBase64 = Buffer.from(newContent, 'utf8').toString('base64');

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${WHITELIST_PATH}`;
  const body = {
    message: `license: add entry [${new Date().toISOString()}]`,
    content: contentBase64,
    branch: GITHUB_BRANCH,
  };

  // Include SHA if file already exists (required for updates)
  if (current.sha) {
    body.sha = current.sha;
  }

  const res = await githubFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub write failed ${res.status}: ${errBody}`);
  }

  // Invalidate cache
  cachedWhitelist = null;
}

async function isTransactionInWhitelist(transactionId) {
  const normalized = transactionId.trim().toUpperCase();
  const { entries } = await loadWhitelist();

  for (const entry of entries) {
    try {
      const { txId } = decryptEntry(entry);
      if (txId === normalized) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function getWhitelistEntry(transactionId) {
  const normalized = transactionId.trim().toUpperCase();
  const { entries } = await loadWhitelist();

  for (const entry of entries) {
    try {
      const parsed = decryptEntry(entry);
      if (parsed.txId === normalized) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

// ─── PayPal verification ─────────────────────────────────────────────────────
// Requires PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET env vars.
// When absent, falls back to trusting the user-supplied amount (dev/manual mode).

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     ?? '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? '';
const PAYPAL_API_BASE      = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let paypalTokenCache = null; // { token: string, expiresAt: number } — null forces fresh token on first call

async function getPayPalAccessToken() {
  if (paypalTokenCache && Date.now() < paypalTokenCache.expiresAt) {
    return paypalTokenCache.token;
  }
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Furi.paypal.com%2Fservices%2Freporting%2Fsearch%2Fread',
  });
  if (!res.ok) throw new Error(`PayPal token error ${res.status}`);
  const data = await res.json();
  paypalTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

// Returns { amount: number } on success, throws on invalid/not-found TX.
async function verifyPayPalTransaction(txId) {
  const token = await getPayPalAccessToken();
  const normalized = txId.trim().toUpperCase();
  // PayPal transaction search requires a date range — use a broad window.
  const end   = new Date();
  const start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000); // 180 days back
  const url   = `${PAYPAL_API_BASE}/v1/reporting/transactions`
    + `?transaction_id=${encodeURIComponent(normalized)}`
    + `&start_date=${start.toISOString()}`
    + `&end_date=${end.toISOString()}`
    + `&fields=transaction_info`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`PayPal search error ${res.status}`);
  const data = await res.json();
  const details = data.transaction_details?.[0]?.transaction_info;
  if (!details) throw new Error('transaction_not_found');
  const status = details.transaction_status;
  if (status !== 'S') throw new Error(`transaction_status_${status}`); // S = Success
  const amount = parseFloat(details.transaction_amount?.value ?? '0');
  return { amount };
}

// Cross-Origin Isolation headers — required for SharedArrayBuffer (PluginWorker)
// These must be set on every response, including the Vite static files.
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  if (
    !origin ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes('autarch.net') ||
    origin.includes('onrender.com') ||
    origin.includes('10.0.0.*')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── API Routes ──────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Verify a TX ID against the whitelist — called by phobos-core
app.get('/api/licenses/verify/:txId', async (req, res) => {
  try {
    const txId = req.params.txId;
    if (!txId?.trim()) return res.status(400).json({ valid: false, reason: 'missing_tx_id' });

    const entry = await getWhitelistEntry(txId);
    if (!entry) return res.json({ valid: false, reason: 'not_found' });

    const key = generateLicenseKey(txId);
    return res.json({ valid: true, key, username: entry.username, amount: entry.amount });
  } catch (err) {
    console.error('License verify error:', err.message);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
});

// Activate a license — verify TX with PayPal, write TXID|USERNAME|AMOUNT, return key.
// Called by Pricing page and LicenseDialog.
// If the TX is already registered (user re-submitting), returns their existing entry.
app.post('/api/license/validate', async (req, res) => {
  try {
    const { transactionId, username } = req.body ?? {};
    if (!transactionId?.trim()) {
      return res.status(400).json({ valid: false, reason: 'missing_transaction_id' });
    }
    if (!username?.trim()) {
      return res.status(400).json({ valid: false, reason: 'missing_username' });
    }

    const normalized  = transactionId.trim().toUpperCase();
    const cleanName   = username.trim().slice(0, 64);

    // If already registered, just return the key — idempotent re-activation.
    const existing = await getWhitelistEntry(normalized);
    if (existing) {
      const key = generateLicenseKey(normalized);
      return res.json({ valid: true, key, username: existing.username, amount: existing.amount, source: 'existing' });
    }

    // Verify with PayPal when credentials are configured; otherwise accept and write.
    let amount = 0;
    if (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) {
      try {
        const verified = await verifyPayPalTransaction(normalized);
        amount = verified.amount;
      } catch (err) {
        const reason = err.message ?? 'verification_failed';
        if (reason === 'transaction_not_found' || reason.startsWith('transaction_status_')) {
          return res.status(403).json({ valid: false, reason });
        }
        // PayPal API error — fail closed, do not write.
        console.error('PayPal verify error:', reason);
        return res.status(502).json({ valid: false, reason: 'paypal_error' });
      }

      // Certificate requires minimum $19.99. Lesser amounts are recorded as donations
      // but do not generate a license — this protects the auvera.ink integration.
      if (amount < 19.99) {
        console.log(`License denied: ${normalized.slice(0, 6)}... amount=${amount} (below minimum)`);
        return res.status(403).json({ valid: false, reason: 'insufficient_amount', amount });
      }
    }
    // PayPal not configured — dev/admin mode, amount stays 0.

    const payload   = `${normalized}|${cleanName}|${amount.toFixed(2)}`;
    const encrypted = encryptEntry(payload);
    await appendToWhitelist(encrypted);

    const key = generateLicenseKey(normalized);
    console.log(`License activated: ${normalized.slice(0, 6)}... username=${cleanName} amount=${amount}`);
    return res.json({ valid: true, key, username: cleanName, amount, source: 'new' });
  } catch (err) {
    console.error('License validate error:', err.message);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
});

// Public patrons leaderboard — top 100 by amount descending.
// Strips TX IDs from the response; only username + amount are exposed.
app.get('/api/patrons', async (_req, res) => {
  try {
    const { entries } = await loadWhitelist();
    const patrons = [];
    for (const entry of entries) {
      try {
        const { username, amount } = decryptEntry(entry);
        if (username) patrons.push({ username, amount });
      } catch {
        continue;
      }
    }
    patrons.sort((a, b) => b.amount - a.amount);
    return res.json({ patrons: patrons.slice(0, 100) });
  } catch (err) {
    console.error('Patrons error:', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

// PayPal webhook — stub for now
// When you have a PayPal business account, configure IPN/webhook to POST here.
// PayPal sends the TX details; we extract TX ID, encrypt it, add to whitelist.
app.post('/api/paypal/webhook', async (req, res) => {
  try {
    // ── FUTURE: Validate PayPal webhook signature ──
    // const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    // const isValid = await verifyPayPalWebhook(req.headers, req.body, webhookId);
    // if (!isValid) return res.status(401).json({ error: 'invalid_signature' });

    // ── Extract TX ID from PayPal payload ──
    // PayPal IPN/webhook format varies. Common fields:
    //   IPN: req.body.txn_id
    //   Webhooks v2: req.body.resource.id
    const txId = req.body.txn_id
              ?? req.body.resource?.id
              ?? req.body.transactionId;  // manual fallback for testing

    if (!txId?.trim()) {
      return res.status(400).json({ error: 'no_transaction_id' });
    }

    // Check for duplicates
    const exists = await isTransactionInWhitelist(txId);
    if (exists) {
      return res.json({ status: 'already_registered' });
    }

    // Encrypt and store
    const normalized = txId.trim().toUpperCase();
    const encrypted = encryptEntry(normalized);
    await appendToWhitelist(encrypted);

    console.log(`License registered: ${normalized.slice(0, 6)}...`);
    return res.json({ status: 'registered' });
  } catch (err) {
    console.error('PayPal webhook error:', err.message);
    return res.status(500).json({ error: 'processing_failed' });
  }
});

// Admin: manually add a TX ID (for testing / manual sales)
// Protected by ADMIN_SECRET
app.post('/api/admin/license/add', async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { transactionId, username = 'Admin', amount = 0 } = req.body ?? {};
    if (!transactionId?.trim()) {
      return res.status(400).json({ error: 'missing_transaction_id' });
    }

    const normalized  = transactionId.trim().toUpperCase();
    const cleanName   = String(username).trim().slice(0, 64) || 'Admin';
    const cleanAmount = parseFloat(amount) || 0;

    const existing = await getWhitelistEntry(normalized);
    if (existing) {
      return res.json({ status: 'already_exists', key: generateLicenseKey(normalized), username: existing.username });
    }

    const payload   = `${normalized}|${cleanName}|${cleanAmount.toFixed(2)}`;
    const encrypted = encryptEntry(payload);
    await appendToWhitelist(encrypted);

    const key = generateLicenseKey(normalized);
    console.log(`Admin added license: ${normalized.slice(0, 6)}... username=${cleanName}`);
    return res.json({ status: 'added', key, username: cleanName });
  } catch (err) {
    console.error('Admin add error:', err.message);
    return res.status(500).json({ error: 'failed' });
  }
});

// Admin: list all entries (decrypted) — for debugging only
app.get('/api/admin/licenses', async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { entries } = await loadWhitelist(true);
    const licenses = [];
    for (const entry of entries) {
      try {
        licenses.push(decryptEntry(entry));
      } catch {
        licenses.push({ txId: '[MALFORMED]', username: '', amount: 0 });
      }
    }
    return res.json({ count: licenses.length, licenses });
  } catch (err) {
    console.error('Admin list error:', err.message);
    return res.status(500).json({ error: 'failed' });
  }
});

// ─── WebRTC Signaling Relay ──────────────────────────────────────────────────
// Brokers SDP offer/answer and trickle ICE between phobos-core (host) and
// the mobile app (mobile) for owner self-access.
//
// Two WebSocket clients per session:
//   core  — connects, sends { type:'register', activeUser }, receives { type:'registered', code, iceServers }
//   mobile — connects, sends { type:'connect', code, sdp, activeUser }, receives { type:'configured', sdp, iceServers }
//
// Code format: 6 chars, A-Z excluding I,L,O (no ambiguous chars), plus 2-9.
// Code TTL: 10 minutes. One active session per core instance.

const CODE_CHARS    = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN      = 6;
const CODE_TTL_MS   = 10 * 60 * 1000;   // 10 minutes
const ICE_QUEUE_TTL = 30 * 1000;         // 30s — max time to buffer ICE before session exists

// ── Static ICE server config ─────────────────────────────────────────────────
// Free STUN servers. TURN is added when TURN_URL is configured.
// For production, provision a coturn instance or use a TURN SaaS.
const TURN_URL      = process.env.TURN_URL      ?? '';
const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_PASSWORD = process.env.TURN_PASSWORD ?? '';

function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_URL && TURN_USERNAME && TURN_PASSWORD) {
    servers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_PASSWORD });
  }
  return servers;
}

function generateCode() {
  let code = '';
  const arr = randomBytes(CODE_LEN);
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_CHARS[arr[i] % CODE_CHARS.length];
  }
  return code;
}

// ── Session store ─────────────────────────────────────────────────────────────
// Map<code, RelaySession>
const relaySessions = new Map();

function makeSession(code, coreWs, activeUser, iceServers) {
  return {
    code,
    coreWs,
    mobileWs:     null,
    activeUser,
    iceServers,
    pendingIce:   [],   // ICE candidates buffered before the other peer connects
    expiresAt:    Date.now() + CODE_TTL_MS,
  };
}

function wsSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Reap expired sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of relaySessions) {
    if (session.expiresAt !== Infinity && session.expiresAt <= now) {
      wsSend(session.coreWs,   { type: 'error', code, reason: 'code_expired' });
      wsSend(session.mobileWs, { type: 'error', code, reason: 'code_expired' });
      relaySessions.delete(code);
    }
  }
}, 60_000);

// ── WebSocket relay handler ───────────────────────────────────────────────────
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/relay' });

wss.on('connection', (ws) => {
  // Each WS connection identifies itself with the first message
  ws.once('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { ws.close(1003, 'bad_json'); return; }
    handleFirstMessage(ws, msg);
  });

  ws.on('error', (err) => console.error('[Relay] WS error:', err.message));
});

function handleFirstMessage(ws, msg) {
  if (msg.type === 'register') {
    // ── Core registration ─────────────────────────────────────────────────────
    const activeUser = msg.activeUser ?? 'owner';
    const iceServers = buildIceServers();

    // Accept client-supplied instanceId; fall back to generated code for compat.
    const instanceId = msg.instanceId ?? generateCode();

    // Invalidate any prior session registered by this exact WebSocket connection.
    for (const [code, session] of relaySessions) {
      if (session.coreWs === ws) relaySessions.delete(code);
    }

    // If a session already exists for this instanceId (relay restart recovery),
    // update coreWs in-place to preserve buffered ICE candidates.
    const existing = relaySessions.get(instanceId);
    if (existing) {
      existing.coreWs = ws;
      wsSend(ws, { type: 'registered', code: instanceId, iceServers, expiresIn: 0 });
      console.log(`[Relay] Core re-registered instanceId=${instanceId} user=${activeUser}`);

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        handleCoreMessage(existing, m);
      });

      ws.on('close', () => {
        console.log(`[Relay] Core disconnected instanceId=${instanceId}`);
      });

    } else {
      const session = makeSession(instanceId, ws, activeUser, iceServers);
      session.expiresAt = Infinity; // instanceId sessions never expire
      relaySessions.set(instanceId, session);

      wsSend(ws, { type: 'registered', code: instanceId, iceServers, expiresIn: 0 });
      console.log(`[Relay] Core registered instanceId=${instanceId} user=${activeUser}`);

      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        handleCoreMessage(session, m);
      });

      ws.on('close', () => {
        console.log(`[Relay] Core disconnected instanceId=${instanceId}`);
      });
    }

  } else if (msg.type === 'connect') {
    // ── Mobile connection ─────────────────────────────────────────────────────
    // Accept instanceId (Phase 6) or legacy code field for backward compat.
    const instanceId = msg.instanceId ?? msg.code;
    const { sdp } = msg;
    if (!instanceId || !sdp) { ws.close(1003, 'missing_fields'); return; }

    const session = relaySessions.get(instanceId);
    if (!session) {
      wsSend(ws, { type: 'error', reason: 'code_not_found' });
      ws.close();
      return;
    }
    // Only check TTL for legacy short-code sessions (instanceId sessions are permanent).
    if (session.expiresAt !== Infinity && session.expiresAt <= Date.now()) {
      wsSend(ws, { type: 'error', reason: 'code_expired' });
      ws.close();
      relaySessions.delete(instanceId);
      return;
    }

    session.mobileWs = ws;
    // Forward offer to core
    wsSend(session.coreWs, { type: 'offer', code: instanceId, sdp, activeUser: session.activeUser });
    wsSend(session.coreWs, { type: 'consumed', code: instanceId });
    console.log(`[Relay] Mobile connected instanceId=${instanceId}, offer forwarded to core`);

    // Flush any ICE candidates core already sent before mobile arrived
    for (const ice of session.pendingIce) {
      wsSend(ws, { type: 'ice', ...ice });
    }
    session.pendingIce = [];

    // Wire subsequent messages from mobile
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      handleMobileMessage(session, m);
    });

    ws.on('close', () => {
      console.log(`[Relay] Mobile disconnected instanceId=${instanceId}`);
      session.mobileWs = null;
    });

  } else {
    ws.close(1003, 'unknown_type');
  }
}

function handleCoreMessage(session, msg) {
  switch (msg.type) {
    case 'answer':
      // Forward answer + ICE servers to mobile
      wsSend(session.mobileWs, {
        type:       'configured',
        sdp:        msg.sdp,
        iceServers: session.iceServers,
      });
      break;

    case 'ice':
      if (session.mobileWs) {
        wsSend(session.mobileWs, {
          type:          'ice',
          candidate:     msg.candidate,
          sdpMid:        msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex,
        });
      } else {
        // Mobile not yet connected — buffer (30s TTL guarded by session expiry)
        session.pendingIce.push({
          candidate:     msg.candidate,
          sdpMid:        msg.sdpMid,
          sdpMLineIndex: msg.sdpMLineIndex,
        });
      }
      break;

    case 'register':
      // Core re-registering (reconnect) — issue a new code
      handleFirstMessage(session.coreWs, msg);
      break;
  }
}

function handleMobileMessage(session, msg) {
  switch (msg.type) {
    case 'ice':
      wsSend(session.coreWs, {
        type:          'ice',
        code:          session.code,
        candidate:     msg.candidate,
        sdpMid:        msg.sdpMid,
        sdpMLineIndex: msg.sdpMLineIndex,
      });
      break;
  }
}

// ─── Serve Vite build ────────────────────────────────────────────────────────
const distPath = join(__dirname, 'dist');
app.use('/phobos', express.static(distPath));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.sendFile(join(distPath, 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n◈ Autarch web service running on port ${PORT}`);
  console.log(`  Static:  ${distPath}`);
  console.log(`  GitHub:  ${GITHUB_REPO}`);
  console.log(`  Relay:   wss://autarch.net/relay`);
  console.log(`  TURN:    ${TURN_URL || '⚠ not configured (STUN only)'}`);
  console.log(`  AES key: ${LICENSE_AES_KEY ? 'configured' : '⚠ MISSING'}`);
  console.log(`  Seed:    ${LICENSE_SEED ? 'configured' : '⚠ MISSING'}`);
  console.log(`  Admin:   ${ADMIN_SECRET ? 'configured' : '⚠ MISSING'}\n`);
});