/**
 * PersonaAI — Hub-mode autonomous behaviours for SAYON, SEREN, SYBIL.
 *
 * This file handles ONLY the hub world idle/goofing-off behaviours.
 * Combat party AI is in AllyAI.ts.
 *
 * Each persona has a personality-specific wander routine that activates
 * when their GameStore state is 'idle'. When working states are active,
 * they return to their functional waypoints (handled by AnimatedCharacterSprite).
 *
 * ── SAYON (coordinator) ──────────────────────────────────────────────────────
 * Hub behaviour: Restless pacer. Short pause at each waypoint then moves on.
 * Occasionally jogs to the plaza, checks on other personas, circles back.
 * Fast mover (2.0 speed). When truly idle, might walk over toward the player.
 *
 * ── SEREN (reasoning engine) ─────────────────────────────────────────────────
 * Hub behaviour: Slow, contemplative drift. Sits at telescope, stares at obelisk,
 * occasionally drifts toward plaza center and stops as if lost in thought.
 * Slow mover (0.8 speed). Long pauses between movements.
 *
 * ── SYBIL (archive) ──────────────────────────────────────────────────────────
 * Hub behaviour: Systematic zone patrol. Methodically visits each corner of her
 * archive zone in sequence. Occasionally invisible (offline state). When online
 * and idle, small random offsets from the patrol path — "cataloguing" feel.
 * Medium speed (1.2).
 *
 * All movement is communicated by calling setHubTarget(x, y) on the sprite,
 * which overrides the state-driven waypoint targeting.
 */

import type { PersonaName } from './GameStore';

// ── Hub waypoint sets ─────────────────────────────────────────────────────────
// These are world-space pixel coordinates (from tileToScreen measurements).

const HUB_WANDER: Record<PersonaName, Array<{ x: number; y: number }>> = {
  sayon: [
    { x: 320, y: 288 },  // tile (14,22) dispatch desk
    { x: 288, y: 240 },  // tile (10,20) relay tower area
    { x: 192, y: 256 },  // tile (8,24)  west patrol
    { x: 320, y: 352 },  // tile (18,26) south edge
    { x: 416, y: 272 },  // tile (16,18) north edge
    { x: 224, y: 304 },  // tile (12,26) south-west
    { x: 320, y: 224 },  // tile (10,18) north-west
  ],
  seren: [
    { x: 832, y: 256 },  // tile (28,4)  telescope
    { x: 912, y: 264 },  // tile (31,2)  crystal lab
    { x: 928, y: 336 },  // tile (36,6)  thought chamber
    { x: 896, y: 384 },  // tile (38,10) east edge
    { x: 704, y: 288 },  // tile (26,10) south edge
    { x: 800, y: 304 },  // tile (30,8)  mid zone
    { x: 928, y: 304 },  // tile (34,4)  north-east
  ],
  sybil: [
    { x: 416, y: 144 },  // tile (8,10)  catalogue table
    { x: 448, y:  64 },  // tile (4,4)   archive mound
    { x: 576, y: 128 },  // tile (12,4)  east archive
    { x: 480, y: 176 },  // tile (12,10) south-east
    { x: 480, y: 112 },  // tile (8,6)   mid archive
    { x: 352, y: 112 },  // tile (4,10)  west archive
    { x: 352, y:  80 },  // tile (2,8)   north-west
  ],
};

// Pause duration (ms) at each waypoint — personality driven
const PAUSE_MIN: Record<PersonaName, number> = { sayon: 6000,  seren: 6000,  sybil: 6000  };
const PAUSE_MAX: Record<PersonaName, number> = { sayon: 18000, seren: 18000, sybil: 18000 };

// ── PersonaAI ────────────────────────────────────────────────────────────────

export type HubBehaviourMode = 'wandering' | 'paused' | 'working' | 'offline';

export class PersonaAI {
  readonly persona: PersonaName;

  private _aiState      = 'idle';
  private _mode: HubBehaviourMode = 'paused';
  private _wpIndex      = 0;
  private _pauseTimer   = 0;
  private _pauseDuration = 0;
  private _onTarget: ((x: number, y: number) => void) | null = null;
  private _frozen       = false;

  constructor(persona: PersonaName) {
    this.persona = persona;
    this._wpIndex = Math.floor(Math.random() * HUB_WANDER[persona].length);
    this._pauseDuration = this._randPause();
  }

  /**
   * Register the callback that moves the sprite to a new target.
   * WorldScene calls this after creating the AnimatedCharacterSprite.
   */
  setMoveCallback(cb: (x: number, y: number) => void): void {
    this._onTarget = cb;
  }

  /** Called when GameStore state changes for this persona. */
  setState(state: string): void {
    this._aiState = state;
    // Always record the latest state so unfreeze() can re-apply it correctly.
    // When frozen (persona is in party), do not move the hub sprite.
    if (this._frozen) return;
    const isOff     = state === 'offline';
    const isWorking = !isOff && state !== 'idle';

    if (isOff)     { this._mode = 'offline';  return; }
    if (isWorking) { this._mode = 'working';  return; }
    // Idle — start hub wander
    this._mode = 'paused';
    this._pauseTimer = 0;
    this._pauseDuration = this._randPause() * 0.3; // short first pause
  }

  /**
   * Freeze hub behaviour. Called when this persona joins the player's party.
   * SSE state changes are still recorded but do not drive sprite movement.
   */
  freeze(): void {
    this._frozen = true;
  }

  /**
   * Unfreeze hub behaviour. Called when this persona leaves the player's party.
   * Re-applies the last known GameStore state so the hub sprite snaps back to
   * the correct position (work desk, wander, etc.) without waiting for the
   * next SSE event.
   */
  unfreeze(): void {
    this._frozen = false;
    this.setState(this._aiState);
  }

  /**
   * Called from WorldScene.update() each frame.
   * delta in ms.
   */
  update(delta: number): void {
    if (this._frozen) return;
    if (this._mode !== 'wandering' && this._mode !== 'paused') return;

    if (this._mode === 'paused') {
      this._pauseTimer += delta;
      if (this._pauseTimer >= this._pauseDuration) {
        this._advanceWaypoint();
      }
      return;
    }

    // 'wandering' — sprite is already moving toward target via AnimatedCharacterSprite.
    // We don't need to drive movement here; we just wait for the sprite to arrive.
    // Arrival is detected by WorldScene checking distance. Here we just expose state.
  }

  /** Call from WorldScene when sprite arrives at its current target. */
  onArrived(): void {
    if (this._mode !== 'wandering') return;
    this._mode = 'paused';
    this._pauseTimer = 0;
    this._pauseDuration = this._randPause();
  }

  get mode(): HubBehaviourMode { return this._mode; }
  get aiState(): string { return this._aiState; }
  get frozen(): boolean { return this._frozen; }

  // ── Private ────────────────────────────────────────────────────────────────

  private _advanceWaypoint(): void {
    const wps = HUB_WANDER[this.persona];
    // Pick next waypoint — SYBIL sequential, others with small random skip
    if (this.persona === 'sybil') {
      this._wpIndex = (this._wpIndex + 1) % wps.length;
    } else {
      // Occasionally skip ahead or stay nearby for more organic movement
      const skip = Math.random() < 0.25 ? 2 : 1;
      this._wpIndex = (this._wpIndex + skip) % wps.length;
    }

    const wp = wps[this._wpIndex];

    // Small random offset so they don't always hit exact same pixel
    const jitter = this.persona === 'sybil' ? 8 : 18;
    const tx = wp.x + (Math.random() - 0.5) * jitter;
    const ty = wp.y + (Math.random() - 0.5) * jitter;

    this._onTarget?.(tx, ty);
    this._mode = 'wandering';
  }

  private _randPause(): number {
    const min = PAUSE_MIN[this.persona];
    const max = PAUSE_MAX[this.persona];
    return min + Math.random() * (max - min);
  }
}
