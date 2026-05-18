/**
 * GameStore — SSE → Phaser bridge.
 *
 * Plain JS object. Phaser reads per frame. SSE handler writes.
 * No React, no Zustand. Pre-allocated, mutation-only.
 */

// ── Types ──────────────────────────────────────────────────────────────────
export type PersonaName = 'sayon' | 'seren' | 'sybil';

export interface PersonaVisualState {
  state: string;
  taskType: string;
  changed: boolean;     // true for one frame after state change
}

export interface CoinEvent {
  source: PersonaName;
  value: number;
  size: 'small' | 'medium' | 'large';
  consumed: boolean;    // Phaser sets true after spawning the coin sprite
}

export interface WorldState {
  imageGenerating: boolean;
  allIdle: boolean;
}

// ── Pre-allocated store ────────────────────────────────────────────────────
const MAX_PENDING_COINS = 64;

function makePersona(): PersonaVisualState {
  return { state: 'idle', taskType: '', changed: false };
}

export const gameStore = {
  sayon: makePersona(),
  seren: makePersona(),
  sybil: makePersona() as PersonaVisualState & { state: string },

  // Coin ring buffer — Phaser consumes by setting consumed=true
  pendingCoins: new Array<CoinEvent>(MAX_PENDING_COINS),
  coinHead: 0,
  coinTail: 0,

  world: { imageGenerating: false, allIdle: true } as WorldState,

  // Connection state
  connected: false,
};

// Fill the ring buffer with reusable objects
for (let i = 0; i < MAX_PENDING_COINS; i++) {
  gameStore.pendingCoins[i] = { source: 'sayon', value: 0, size: 'small', consumed: true };
}

// ── Writers (called by SSE handler) ────────────────────────────────────────

export function setPersonaState(persona: PersonaName, state: string, taskType?: string): void {
  const p = gameStore[persona];
  p.state = state;
  p.taskType = taskType ?? '';
  p.changed = true;
}

export function pushCoin(source: PersonaName, value: number, size: 'small' | 'medium' | 'large'): void {
  const slot = gameStore.pendingCoins[gameStore.coinHead];
  slot.source = source;
  slot.value = value;
  slot.size = size;
  slot.consumed = false;
  gameStore.coinHead = (gameStore.coinHead + 1) % MAX_PENDING_COINS;
  // If head catches tail, advance tail (oldest coin lost)
  if (gameStore.coinHead === gameStore.coinTail) {
    gameStore.coinTail = (gameStore.coinTail + 1) % MAX_PENDING_COINS;
  }
}

export function setWorldState(imageGenerating: boolean, allIdle: boolean): void {
  gameStore.world.imageGenerating = imageGenerating;
  gameStore.world.allIdle = allIdle;
}

// ── Reader (called by Phaser each frame) ───────────────────────────────────

/** Returns next unconsumed coin or null. Call in update loop. */
export function consumeNextCoin(): CoinEvent | null {
  while (gameStore.coinTail !== gameStore.coinHead) {
    const slot = gameStore.pendingCoins[gameStore.coinTail];
    if (!slot.consumed) {
      return slot; // Caller must set slot.consumed = true after spawning
    }
    gameStore.coinTail = (gameStore.coinTail + 1) % MAX_PENDING_COINS;
  }
  return null;
}

/** Clear the changed flag after Phaser has processed the state change. */
export function clearChanged(persona: PersonaName): void {
  gameStore[persona].changed = false;
}