/**
 * GameStateManager — PHOBOS World engine state bridge.
 *
 * Singleton. Tracks persona states, accumulates tokens on a 1-second tick,
 * converts them to coin events, and broadcasts SSE to connected game clients.
 *
 * Hot path: incrementTokens() is called on every output/think token.
 * All allocations happen at startup. Nothing allocates per-token.
 */

// ── Persona state names (from PHOBOS-World-Design-v1.1 §4) ────────────────
export type SayonState =
  | 'idle' | 'classifying_intent' | 'triaging_files' | 'assembling_context'
  | 'coordinating' | 'reviewing_output' | 'delivering_result'
  | 'copilot_active' | 'error_state';

export type SerenState =
  | 'idle' | 'decomposing_tasks' | 'deep_thinking' | 'writing_code'
  | 'validating_output' | 'composing_delivery' | 'copilot_active'
  | 'extended_thinking' | 'error_state';

export type SybilState =
  | 'idle' | 'embedding' | 'searching' | 'retrieving_memory'
  | 'writing_memory' | 'startup' | 'offline';

export type PersonaName = 'sayon' | 'seren' | 'sybil';
export type PersonaState = SayonState | SerenState | SybilState;

// ── SSE event shapes ───────────────────────────────────────────────────────
export interface PersonaStateEvent {
  type: 'persona_state';
  persona: PersonaName;
  state: PersonaState;
  taskType?: string;
}

export interface CoinTickEvent {
  type: 'coin_tick';
  source: PersonaName;
  value: number;
  size: 'small' | 'medium' | 'large';
}

export interface WorldStateEvent {
  type: 'world_state';
  imageGenerating: boolean;
  allIdle: boolean;
}

export interface HeartbeatEvent {
  type: 'heartbeat';
  ts: number;
}

type GameSSEEvent =
  | PersonaStateEvent
  | CoinTickEvent
  | WorldStateEvent
  | HeartbeatEvent
  | { type: 'task_start'; persona: PersonaName; taskType: string; threadId: string }
  | { type: 'task_complete'; persona: PersonaName; taskType: string; threadId: string }
  | { type: 'thinking_start'; persona: PersonaName }
  | { type: 'thinking_end'; persona: PersonaName }
  | { type: 'error_event'; persona: PersonaName; message: string };

// ── Connected SSE client handle ────────────────────────────────────────────
interface SSEClient {
  id: number;
  write: (data: string) => boolean;
  onClose: () => void;
}

// ── Coin size tiers (design doc §5.1) ──────────────────────────────────────
function coinSize(value: number): 'small' | 'medium' | 'large' {
  if (value <= 3)  return 'small';
  if (value <= 10) return 'medium';
  return 'large';
}

// ── Singleton ──────────────────────────────────────────────────────────────
class GameStateManager {
  // Persona states — mutated in place, never replaced
  private _sayonState: SayonState   = 'idle';
  private _serenState: SerenState   = 'idle';
  private _sybilState: SybilState   = 'offline';

  // Token accumulator — reset every tick
  private _tokenCount = 0;
  private _activeSource: PersonaName = 'sayon';

  // World flags
  private _imageGenerating = false;

  // SSE clients — pre-allocated array, compact on remove
  private _clients: SSEClient[] = [];
  private _nextClientId = 1;

  // Timers
  private _coinTickInterval: ReturnType<typeof setInterval> | null = null;
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // ── Startup / shutdown ───────────────────────────────────────────────
  start(): void {
    // 1-second coin tick
    this._coinTickInterval = setInterval(() => this._coinTick(), 1000);
    // 5-second heartbeat
    this._heartbeatInterval = setInterval(() => {
      this._broadcast({ type: 'heartbeat', ts: Date.now() });
    }, 5000);
    console.log('[GameStateManager] Started — coin tick 1s, heartbeat 5s');
  }

  stop(): void {
    if (this._coinTickInterval) { clearInterval(this._coinTickInterval); this._coinTickInterval = null; }
    if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
  }

  // ── SSE client management ────────────────────────────────────────────
  addClient(write: (data: string) => boolean, onClose: () => void): number {
    const id = this._nextClientId++;
    this._clients.push({ id, write, onClose });
    // Send initial state snapshot
    this._sendTo(this._clients[this._clients.length - 1], {
      type: 'persona_state', persona: 'sayon', state: this._sayonState,
    });
    this._sendTo(this._clients[this._clients.length - 1], {
      type: 'persona_state', persona: 'seren', state: this._serenState,
    });
    this._sendTo(this._clients[this._clients.length - 1], {
      type: 'persona_state', persona: 'sybil', state: this._sybilState,
    });
    this._sendTo(this._clients[this._clients.length - 1], {
      type: 'world_state', imageGenerating: this._imageGenerating, allIdle: this._isAllIdle(),
    });
    return id;
  }

  removeClient(id: number): void {
    const idx = this._clients.findIndex(c => c.id === id);
    if (idx >= 0) this._clients.splice(idx, 1);
  }

  // ── State setters (called from hooks) ────────────────────────────────
  setPersonaState(persona: PersonaName, state: PersonaState, taskType?: string): void {
    const prev = this._getState(persona);
    if (prev === state) return; // no-op if unchanged

    if (persona === 'sayon') this._sayonState = state as SayonState;
    else if (persona === 'seren') this._serenState = state as SerenState;
    else this._sybilState = state as SybilState;

    this._broadcast({ type: 'persona_state', persona, state, taskType });

    // Update world state if idle status changed
    this._broadcastWorldState();
  }

  setImageGenerating(active: boolean): void {
    if (this._imageGenerating === active) return;
    this._imageGenerating = active;
    this._broadcastWorldState();
  }

  // ── Token accumulation (HOT PATH — zero allocation) ──────────────────
  incrementTokens(source?: PersonaName): void {
    this._tokenCount++;
    if (source) this._activeSource = source;
  }

  // ── Task lifecycle events ────────────────────────────────────────────
  emitTaskStart(persona: PersonaName, taskType: string, threadId: string): void {
    this._broadcast({ type: 'task_start', persona, taskType, threadId });
  }

  emitTaskComplete(persona: PersonaName, taskType: string, threadId: string): void {
    this._broadcast({ type: 'task_complete', persona, taskType, threadId });
  }

  emitThinkingStart(persona: PersonaName): void {
    this._broadcast({ type: 'thinking_start', persona });
  }

  emitThinkingEnd(persona: PersonaName): void {
    this._broadcast({ type: 'thinking_end', persona });
  }

  emitError(persona: PersonaName, message: string): void {
    this._broadcast({ type: 'error_event', persona, message });
  }

  // ── Getters ──────────────────────────────────────────────────────────
  getState(persona: PersonaName): PersonaState {
    return this._getState(persona);
  }

  // ── Private ──────────────────────────────────────────────────────────
  private _getState(persona: PersonaName): PersonaState {
    if (persona === 'sayon') return this._sayonState;
    if (persona === 'seren') return this._serenState;
    return this._sybilState;
  }

  private _isAllIdle(): boolean {
    return this._sayonState === 'idle' && this._serenState === 'idle'
      && (this._sybilState === 'idle' || this._sybilState === 'offline');
  }

  private _coinTick(): void {
    if (this._tokenCount === 0) return;

    // Design doc §5.1: value = ceil(tokens / 10), cap 50
    const value = Math.min(Math.ceil(this._tokenCount / 10), 50);
    this._tokenCount = 0;

    const event: CoinTickEvent = {
      type: 'coin_tick',
      source: this._activeSource,
      value,
      size: coinSize(value),
    };
    this._broadcast(event);
  }

  private _broadcastWorldState(): void {
    this._broadcast({
      type: 'world_state',
      imageGenerating: this._imageGenerating,
      allIdle: this._isAllIdle(),
    });
  }

  private _broadcast(event: GameSSEEvent): void {
    if (this._clients.length === 0) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    // Iterate in reverse so splice during iteration is safe
    for (let i = this._clients.length - 1; i >= 0; i--) {
      try {
        const ok = this._clients[i].write(data);
        if (!ok) {
          this._clients[i].onClose();
          this._clients.splice(i, 1);
        }
      } catch {
        this._clients.splice(i, 1);
      }
    }
  }

  private _sendTo(client: SSEClient, event: GameSSEEvent): void {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* silent */ }
  }
}

// ── Singleton export ───────────────────────────────────────────────────────
export const gsm = new GameStateManager();
