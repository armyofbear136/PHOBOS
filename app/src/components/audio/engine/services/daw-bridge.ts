/**
 * daw-bridge.ts — Adapter between the upstream Efflux engine (which reads state
 * from a Vuex store reference) and our React/Zustand state layer.
 *
 * The engine is kept verbatim where possible. Wherever upstream code read
 * `store.state.<module>` it now reads from `dawBridge.getState()`. Wherever it
 * called `store.commit` for user-visible side effects (notifications, modals),
 * it calls methods on the bridge that we wire up to our app's real handlers.
 *
 * This is NOT a reactive hook. The engine runs outside React, so reads are
 * point-in-time `getState()` snapshots. Mutations from UI into stores go
 * through the normal Zustand setters.
 */

import type { EffluxSong } from "../model/types/song";
import type { Instrument } from "../model/types/instrument";
import type { Sample } from "../model/types/sample";
import type { EffluxPattern } from "../model/types/pattern";
import type { Session } from "../model/types/session";

// ── The subset of Vuex state the engine reads ────────────────────────────────
// This is the shape AudioService, KeyboardService, MidiService etc. all expect
// at `state.<module>.<field>`. We reconstruct it from our Zustand stores.

export interface EffluxState {
  song: {
    activeSong: EffluxSong | null;
  };
  /**
   * Phase 3 session slice. The scheduler reads from here; useSongStore
   * continues to exist in parallel during the transition (see
   * PHOBOS-DAW-Phase-3-Session-Model.md §4.2). When `session.activeSession`
   * is non-null, it is the source of truth for clip data, channel layout,
   * armed/playing state, and the global clock parameters.
   */
  session: {
    activeSession: Session | null;
  };
  sequencer: {
    playing:          boolean;
    looping:          boolean;
    recording:        boolean;
    stepPrecision:    number;
    currentStep:      number;
    activeOrderIndex: number;
    activePatternIndex: number;
  };
  editor: {
    selectedInstrument: number;
    selectedStep:       number;
    selectedSlot:       number;
    showNoteEntry:      boolean;
    higherKeyboardOctave: number;
    lowerKeyboardOctave:  number;
  };
  instrument: {
    instruments: Instrument[];
  };
  sample: {
    sampleCache: Map<string, { sample: Sample; buffer: AudioBuffer | null; slices: AudioBuffer[] }>;
  };
  midi: {
    midiPortNumber:    number;
    midiConnected:     boolean;
    pairableParamId:   string | null;
  };
  selection: {
    minSelectedStep:         number;
    maxSelectedStep:         number;
    firstSelectedChannel:    number;
    lastSelectedChannel:     number;
  };
  settings: {
    properties: Record<string, unknown>;
  };
}

// ── Getter functions the engine's commonly-used code paths need ──────────────

export interface EffluxGetters {
  activeSong:         EffluxSong | null;
  activePattern:      EffluxPattern | null;
  activePatternIndex: number;
  activeOrderIndex:   number;
  jamMode:            boolean;
  samples:            Sample[];
  hasSelection:       boolean;
  hasCopiedEvents:    boolean;
  followPlayback:     boolean;
}

// ── Commit callbacks the engine uses for UI side effects ─────────────────────

export interface EffluxCommits {
  showNotification: (payload: { message: string; title?: string }) => void;
  /**
   * Bump useSessionStore.sessionVersion. Called by the audio scheduler once
   * per tick after batching all per-channel mutations (cursor advance,
   * launch transitions, end-of-clip stops). Centralising the bump here
   * means the engine never imports the Zustand store directly — the
   * engine→store boundary stays one-way through the bridge.
   */
  bumpSessionVersion: () => void;
}

// ── The bridge object ────────────────────────────────────────────────────────

export interface DawBridge {
  /** Snapshot of current Vuex-shaped state, built from Zustand stores. */
  getState(): EffluxState;
  /** Snapshot of derived getters. */
  getGetters(): EffluxGetters;
  /** Side-effect commits — only for UI notifications etc. */
  commit: EffluxCommits;
}

// ── Module-level singleton — the engine imports this and calls bridge.getState() ──
// The React layer sets the bridge instance during mount via setBridge().

let _bridge: DawBridge | null = null;

export function setDawBridge(bridge: DawBridge): void {
  _bridge = bridge;
}

export function getDawBridge(): DawBridge {
  if (!_bridge) {
    throw new Error(
      "DawBridge is not initialized. Call setDawBridge() before the engine runs. " +
      "Typically this is handled by EffluxPanel during mount."
    );
  }
  return _bridge;
}

/**
 * Convenience accessor matching upstream Efflux's `state` pattern so the
 * engine's existing `state.song.activeSong`-style reads work with minimal
 * code churn.
 *
 * IMPORTANT: This re-reads Zustand on every access. For hot paths (sequencer
 * tick, noteOn, noteOff), cache the result in a local variable.
 */
export function dawState(): EffluxState {
  return getDawBridge().getState();
}

export function dawGetters(): EffluxGetters {
  return getDawBridge().getGetters();
}

export function dawCommit(): EffluxCommits {
  return getDawBridge().commit;
}
