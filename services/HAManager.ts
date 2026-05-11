/**
 * services/HAManager.ts — Home Assistant WebSocket connection manager.
 *
 * Owns a single persistent WebSocket to the user's HA instance.
 * Authenticates on connect, subscribes to state_changed events,
 * maintains a flat in-memory entity state map, and exposes a
 * rendered snapshot string for copilot context injection.
 *
 * Design constraints:
 *   - One connection per PHOBOS process (singleton).
 *   - State map is mutated in-place on every state_changed event — no realloc.
 *   - Reconnects with exponential backoff (max 60s) on any disconnect.
 *   - No write operations in Phase 1 — read-only.
 *
 * HA WebSocket protocol (stateless after auth):
 *   1. Server sends { type: 'auth_required' }
 *   2. Client sends { type: 'auth', access_token: TOKEN }
 *   3. Server sends { type: 'auth_ok' } or { type: 'auth_invalid' }
 *   4. Client sends commands with incrementing id integers.
 *   5. Server sends { type: 'result', id, success, result } or
 *                   { type: 'event', id, event }
 */

import WebSocket from 'ws';
import { HaStore, type HaConfig, DEFAULT_EXPOSED_DOMAINS } from '../db/HaStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

// ── Wire types (minimal — only what we use) ───────────────────────────────────

interface HaStateObject {
  entity_id:    string;
  state:        string;
  attributes:   Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface HaStateChangedEvent {
  entity_id: string;
  new_state: HaStateObject | null;
  old_state: HaStateObject | null;
}

// ── Connection state ──────────────────────────────────────────────────────────

export type HaConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

interface ManagedConnection {
  state:          HaConnectionState;
  error:          string | null;
  ws:             WebSocket | null;
  /** Incrementing command ID — HA requires each message to have a unique int id. */
  nextId:         number;
  /** Subscription id for the state_changed event stream */
  subId:          number | null;
  /** In-memory entity state map. Mutated in place. */
  entityStates:   Map<string, HaStateObject>;
  retryCount:     number;
  retryTimer:     ReturnType<typeof setTimeout> | null;
  config:         HaConfig | null;
}

const conn: ManagedConnection = {
  state:        'disconnected',
  error:        null,
  ws:           null,
  nextId:       1,
  subId:        null,
  entityStates: new Map(),
  retryCount:   0,
  retryTimer:   null,
  config:       null,
};

// Backoff: 2^n seconds, capped at 60s.
const RETRY_BASE_MS  = 2_000;
const RETRY_MAX_MS   = 60_000;
const RETRY_EXPONENT = 2;

function retryDelayMs(count: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(RETRY_EXPONENT, count), RETRY_MAX_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getHaStatus(): {
  state:          HaConnectionState;
  error:          string | null;
  entityCount:    number;
  last_connected_at: string | null;
  ha_url:         string | null;
  enabled:        boolean;
} {
  return {
    state:          conn.state,
    error:          conn.error,
    entityCount:    conn.entityStates.size,
    last_connected_at: conn.config?.last_connected_at ?? null,
    ha_url:         conn.config?.ha_url ?? null,
    enabled:        conn.config?.enabled ?? false,
  };
}

/**
 * Connect to HA using the config currently in HaStore.
 * Safe to call multiple times — tears down existing connection first.
 */
export async function connectHa(db: DatabaseManager): Promise<void> {
  const store  = new HaStore(db);
  const config = await store.get();

  if (!config || !config.enabled || !config.ha_url || !config.ha_token) {
    conn.state = 'disconnected';
    conn.error = 'No HA config or connection disabled.';
    return;
  }

  conn.config = config;
  _teardown();
  _connect();
}

/**
 * Update the in-memory exposed_domains filter without reconnecting.
 * Called after PATCH /api/ha/config so snapshot filtering takes effect immediately.
 * No-op if not connected (domains will be read fresh from DB on next connectHa).
 */
export function setExposedDomains(domains: string[]): void {
  if (conn.config) conn.config.exposed_domains = domains;
}

/** Disconnect and disable. Called when user disables HA in settings. */
export async function disconnectHa(db: DatabaseManager): Promise<void> {
  const store = new HaStore(db);
  await store.disable();
  conn.config = null;
  _teardown();
  conn.state = 'disconnected';
  conn.error = null;
}

/**
 * Returns the raw state object for a single entity by ID.
 * No domain filtering — caller asked for a specific entity.
 * Returns null if not connected or entity not in map.
 */
export function getHaEntity(entityId: string): HaStateObject | null {
  return conn.entityStates.get(entityId) ?? null;
}

/**
 * Returns a plain-text snapshot of current entity states for AI context.
 * Filtered to exposed_domains. Renders ~1 line per entity.
 * Returns null if not connected or no entities loaded.
 */
export function getHaSnapshot(): string | null {
  if (conn.state !== 'connected' || conn.entityStates.size === 0) return null;

  const domains = conn.config?.exposed_domains ?? DEFAULT_EXPOSED_DOMAINS;
  const domainSet = new Set(domains.length > 0 ? domains : DEFAULT_EXPOSED_DOMAINS);

  const lines: string[] = [];
  for (const [entityId, s] of conn.entityStates) {
    const domain = entityId.split('.')[0];
    if (!domainSet.has(domain)) continue;
    const friendlyName = (s.attributes['friendly_name'] as string | undefined) ?? entityId;
    lines.push(_renderEntity(entityId, friendlyName, s));
  }

  if (lines.length === 0) return null;

  lines.sort(); // stable alphabetical order by entity_id prefix
  return lines.join('\n');
}

// ── Phase 4 stub ──────────────────────────────────────────────────────────────

/**
 * Call a Home Assistant service. Phase 4 only — not implemented.
 *
 * In Phase 4 this will send a `call_service` command over the WebSocket and
 * await the result response. Every call site must pass through the approval
 * gate in the copilot panel before reaching here — no service call fires
 * without explicit user confirmation.
 *
 * @throws always — calling this in Phase 3 is a programming error.
 */
export function callService(
  _domain:  string,
  _service: string,
  _data:    Record<string, unknown>,
): never {
  throw new Error(
    '[HAManager] callService() is not implemented until Phase 4. ' +
    'Phase 3 is strictly read-only.'
  );
}

// ── Internal — connection lifecycle ──────────────────────────────────────────

function _connect(): void {
  if (!conn.config) return;

  const wsUrl = conn.config.ha_url.replace(/^http/, 'ws') + '/api/websocket';
  conn.state  = 'connecting';
  conn.error  = null;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    _onError(`Failed to create WebSocket: ${(err as Error).message}`);
    return;
  }

  conn.ws = ws;

  ws.on('open', () => {
    // HA sends auth_required immediately on open — we wait for it.
    conn.state = 'authenticating';
  });

  ws.on('message', (data: WebSocket.RawData) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    _handleMessage(msg);
  });

  ws.on('close', (code: number) => {
    // Don't log 1000 (clean close) as an error.
    if (code !== 1000) {
      console.log(`[HAManager] WebSocket closed (code ${code}) — scheduling reconnect`);
    }
    conn.ws    = null;
    conn.subId = null;
    if (conn.config?.enabled) {
      _scheduleReconnect();
    } else {
      conn.state = 'disconnected';
    }
  });

  ws.on('error', (err: Error) => {
    _onError(err.message);
  });
}

function _handleMessage(msg: Record<string, unknown>): void {
  const type = msg['type'] as string;

  switch (type) {
    case 'auth_required':
      _send({ type: 'auth', access_token: conn.config!.ha_token });
      break;

    case 'auth_ok':
      conn.state     = 'connected';
      conn.error     = null;
      conn.retryCount = 0;
      console.log('[HAManager] Authenticated — fetching initial states');
      _fetchStates();
      _subscribeEvents();
      // Mark connected timestamp in DB (fire-and-forget).
      _markConnected();
      break;

    case 'auth_invalid':
      _onError('HA authentication failed — check token');
      conn.ws?.close();
      break;

    case 'result': {
      const id = msg['id'] as number;
      if (id === conn.subId) break; // subscription ack, no action needed

      // Initial get_states response — populate the map.
      if (msg['success'] === true && Array.isArray(msg['result'])) {
        _loadInitialStates(msg['result'] as HaStateObject[]);
      }
      break;
    }

    case 'event': {
      const event = msg['event'] as Record<string, unknown> | undefined;
      if (!event) break;
      const eventType = event['event_type'] as string;
      if (eventType === 'state_changed') {
        _applyStateChanged(event['data'] as HaStateChangedEvent);
      }
      break;
    }
  }
}

function _fetchStates(): void {
  const id = conn.nextId++;
  _send({ id, type: 'get_states' });
}

function _subscribeEvents(): void {
  const id      = conn.nextId++;
  conn.subId    = id;
  _send({ id, type: 'subscribe_events', event_type: 'state_changed' });
}

function _loadInitialStates(states: HaStateObject[]): void {
  conn.entityStates.clear();
  for (const s of states) {
    conn.entityStates.set(s.entity_id, s);
  }
  console.log(`[HAManager] Loaded ${conn.entityStates.size} entities`);
}

function _applyStateChanged(data: HaStateChangedEvent): void {
  if (data.new_state) {
    // Mutate in-place: update existing entry or insert new one.
    conn.entityStates.set(data.entity_id, data.new_state);
  } else {
    // Entity was removed from HA.
    conn.entityStates.delete(data.entity_id);
  }
}

function _send(msg: Record<string, unknown>): void {
  if (conn.ws?.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(msg));
  }
}

function _onError(message: string): void {
  conn.state = 'error';
  conn.error = message;
  conn.ws    = null;
  console.error(`[HAManager] Error: ${message}`);
  if (conn.config?.enabled) {
    _scheduleReconnect();
  }
}

function _scheduleReconnect(): void {
  if (conn.retryTimer) return; // already scheduled
  const delay = retryDelayMs(conn.retryCount++);
  console.log(`[HAManager] Reconnecting in ${delay}ms (attempt ${conn.retryCount})`);
  conn.state      = 'connecting';
  conn.retryTimer = setTimeout(() => {
    conn.retryTimer = null;
    if (conn.config?.enabled) _connect();
  }, delay);
  conn.retryTimer.unref();
}

function _teardown(): void {
  if (conn.retryTimer) {
    clearTimeout(conn.retryTimer);
    conn.retryTimer = null;
  }
  if (conn.ws) {
    conn.ws.removeAllListeners();
    try { conn.ws.close(1000); } catch { /* ignore */ }
    conn.ws = null;
  }
  conn.entityStates.clear();
  conn.nextId    = 1;
  conn.subId     = null;
  conn.retryCount = 0;
}

async function _markConnected(): Promise<void> {
  try {
    const db    = DatabaseManager.getInstance();
    const store = new HaStore(db);
    await store.markConnected();
    if (conn.config) conn.config.last_connected_at = new Date().toISOString();
  } catch { /* non-fatal */ }
}

// ── Entity rendering ──────────────────────────────────────────────────────────

// Domains where we render key attributes beyond just state.
const ATTRIBUTE_RENDERERS: Record<string, (attrs: Record<string, unknown>) => string> = {
  light:         a => _attrStr(a, ['brightness', 'color_temp', 'rgb_color']),
  climate:       a => _attrStr(a, ['current_temperature', 'temperature', 'hvac_action']),
  cover:         a => _attrStr(a, ['current_position']),
  media_player:  a => _attrStr(a, ['media_title', 'volume_level', 'source']),
  sensor:        a => _attrStr(a, ['unit_of_measurement']),
  person:        a => _attrStr(a, ['latitude', 'longitude', 'source']),
  lock:          a => '',
  alarm_control_panel: a => _attrStr(a, ['code_format']),
};

function _renderEntity(entityId: string, name: string, s: HaStateObject): string {
  const domain   = entityId.split('.')[0];
  const renderer = ATTRIBUTE_RENDERERS[domain];
  const extra    = renderer ? renderer(s.attributes) : '';
  return extra
    ? `${name} (${entityId}): ${s.state}${extra}`
    : `${name} (${entityId}): ${s.state}`;
}

function _attrStr(attrs: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.length > 0 ? ' [' + parts.join(', ') + ']' : '';
}