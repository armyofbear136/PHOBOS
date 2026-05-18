/**
 * useSequencerStore.ts — Zustand replacement for upstream sequencer-module.ts.
 *
 * Holds transport state (playing, looping, tempo, position). Phase 2a surface
 * is minimal: enough for the shell panel to start/stop the hardcoded test
 * song. Full sequencer step scheduling and pattern/order navigation land in
 * Phase 2b along with the tracker grid UI.
 */

import { create } from 'zustand';

export interface SequencerState {
  playing:            boolean;
  looping:            boolean;
  recording:          boolean;
  /** 0 = 16th, 1 = 8th, 2 = 4th — step precision of the metronome. */
  stepPrecision:      number;
  /** Current step within the active pattern, 0-indexed. */
  currentStep:        number;
  /** Index into song.order (the pattern order list). */
  activeOrderIndex:   number;
  /** Index into song.patterns — derived from order[activeOrderIndex]. */
  activePatternIndex: number;

  setPlaying:            (v: boolean) => void;
  setLooping:            (v: boolean) => void;
  setRecording:          (v: boolean) => void;
  setStepPrecision:      (v: number) => void;
  setCurrentStep:        (v: number) => void;
  setActiveOrderIndex:   (v: number) => void;
  setActivePatternIndex: (v: number) => void;
}

export const useSequencerStore = create<SequencerState>((set) => ({
  playing:            false,
  looping:            false,
  recording:          false,
  stepPrecision:      1,
  currentStep:        0,
  activeOrderIndex:   0,
  activePatternIndex: 0,

  setPlaying:            (v) => set({ playing: v }),
  setLooping:            (v) => set({ looping: v }),
  setRecording:          (v) => set({ recording: v }),
  setStepPrecision:      (v) => set({ stepPrecision: v }),
  setCurrentStep:        (v) => set({ currentStep: v }),
  setActiveOrderIndex:   (v) => set({ activeOrderIndex: v }),
  setActivePatternIndex: (v) => set({ activePatternIndex: v }),
}));
