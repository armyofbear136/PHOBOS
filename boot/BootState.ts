// boot/BootState.ts
//
// Single source of truth for the server's boot phase.
// Written once per phase transition, read by:
//   - /api/status  (adds bootPhase + bootProgress fields — polled every 5s)
//   - /api/boot/events  (SSE stream — pushed on every event for granular progress)
//
// No emitter, no EventEmitter — just a flat mutable record and a registered
// listener list.  Phase transitions are one-way: they only ever advance forward.

export type BootPhase =
  | 'prep_deps'      // downloading / extracting PHOBOS-DEPS
  | 'db_init'        // database initialising
  | 'core_init'      // services, schedulers, cartridges, LLMs starting
  | 'ready';         // fully initialised — frontend may enter

export interface BootProgress {
  dep?:       string;   // current dep label
  file?:      string;   // current filename
  bytes?:     number;
  total?:     number;
  pct?:       number;
  depsTotal?: number;
  depsDone?:  number;
}

export interface BootState {
  phase:    BootPhase;
  progress: BootProgress;
  error:    string | null;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

const state: BootState = {
  phase:    'prep_deps',
  progress: {},
  error:    null,
};

type BootListener = (s: BootState) => void;
const listeners = new Set<BootListener>();

function notify(): void {
  const snap = snapshot();
  for (const fn of listeners) {
    try { fn(snap); } catch { /* never let a listener crash the boot sequence */ }
  }
}

// ── Mutation API ──────────────────────────────────────────────────────────────

export function setBootPhase(phase: BootPhase): void {
  state.phase    = phase;
  state.progress = {};
  state.error    = null;
  notify();
}

export function setBootProgress(progress: BootProgress): void {
  // Mutate in place — no spread, no new object on the hot path.
  if (progress.dep       !== undefined) state.progress.dep       = progress.dep;
  if (progress.file      !== undefined) state.progress.file      = progress.file;
  if (progress.bytes     !== undefined) state.progress.bytes     = progress.bytes;
  if (progress.total     !== undefined) state.progress.total     = progress.total;
  if (progress.pct       !== undefined) state.progress.pct       = progress.pct;
  if (progress.depsTotal !== undefined) state.progress.depsTotal = progress.depsTotal;
  if (progress.depsDone  !== undefined) state.progress.depsDone  = progress.depsDone;
  notify();
}

export function setBootError(error: string): void {
  state.error = error;
  notify();
}

// ── Read API ──────────────────────────────────────────────────────────────────

export function snapshot(): BootState {
  return {
    phase:    state.phase,
    error:    state.error,
    progress: { ...state.progress },
  };
}

export function isReady(): boolean {
  return state.phase === 'ready';
}

// ── Listener registration ─────────────────────────────────────────────────────

export function onBootStateChange(fn: BootListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
