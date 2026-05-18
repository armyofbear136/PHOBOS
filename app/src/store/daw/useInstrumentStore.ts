/**
 * useInstrumentStore.ts — Instrument editor UI state.
 *
 * The `Instrument` objects themselves live on `song.instruments[]` and are
 * mutated in place (philosophy: zero allocation, version counter in
 * useSongStore drives re-render). This store tracks only the UI-level
 * selection: which instrument slot is open in the editor and which
 * oscillator / module sub-tab is visible.
 *
 * Phase 2c scope: minimal. The editor components read mutation targets
 * directly from `useSongStore.getState().activeSong.instruments[index]` and
 * call `useSongStore.getState().bumpSongVersion()` after writes.
 */

import { create } from 'zustand';

export type InstrumentSubtab = 'oscillator' | 'module' | 'sample';

export interface InstrumentStoreState {
  /** True when the instrument editor panel is open. */
  editorOpen:           boolean;
  /** Slot index being edited (0 .. Config.INSTRUMENT_AMOUNT − 1). */
  editingInstrumentIdx: number;
  /** Which oscillator inside the instrument is active (0–2). */
  activeOscillatorIdx:  number;
  /** Which subtab of the editor is visible. */
  subtab:               InstrumentSubtab;

  openEditor:           (instrumentIdx: number) => void;
  closeEditor:          ()                      => void;
  setActiveOscillator:  (idx: number)           => void;
  setSubtab:            (tab: InstrumentSubtab) => void;
}

export const useInstrumentStore = create<InstrumentStoreState>((set) => ({
  editorOpen:           false,
  editingInstrumentIdx: 0,
  activeOscillatorIdx:  0,
  subtab:               'oscillator',

  openEditor: (instrumentIdx) => set({
    editorOpen: true,
    editingInstrumentIdx: instrumentIdx,
    activeOscillatorIdx:  0,
    subtab:               'oscillator',
  }),
  closeEditor:         ()    => set({ editorOpen: false }),
  setActiveOscillator: (idx) => set({ activeOscillatorIdx: idx }),
  setSubtab:           (tab) => set({ subtab: tab }),
}));
