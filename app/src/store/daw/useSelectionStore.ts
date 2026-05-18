/**
 * useSelectionStore.ts — Zustand replacement for upstream selection-module.ts.
 *
 * Phase 2b — owns the rectangular range selection (channel × step) and a
 * single in-memory clipboard. Selection ranges use −1 as the "no selection"
 * sentinel to match upstream Efflux's contract; the daw-bridge maps these
 * fields straight through into `state.selection`.
 *
 * Clipboard storage rule: `events` is an array of channel slices, each slice
 * an array of `EffluxAudioEvent | 0` (matching the `EffluxChannelEntry` shape).
 * On copy we DEEP-CLONE the events into the buffer; on paste we DEEP-CLONE
 * back out. Without the deep clone, paste would alias the channel's actual
 * objects and edits to the pasted notes would silently rewrite the source.
 */

import { create } from 'zustand';
import type { EffluxAudioEvent } from '@/components/audio/engine/model/types/audio-event';
import type { EffluxChannelEntry } from '@/components/audio/engine/model/types/channel';

export interface SelectionState {
  minSelectedStep:      number;
  maxSelectedStep:      number;
  firstSelectedChannel: number;
  lastSelectedChannel:  number;

  /** Clipboard slices — outer array is channels, inner is steps. */
  copiedEvents: EffluxChannelEntry[][];

  setSelection: (
    firstChannel: number, lastChannel: number,
    minStep:      number, maxStep:     number,
  ) => void;
  clearSelection: () => void;

  /** True when a non-empty rect is selected. */
  hasSelection: () => boolean;
  /** True when the clipboard holds a non-empty paste buffer. */
  hasCopiedEvents: () => boolean;

  /** Replace the clipboard buffer (deep-cloned by caller). */
  setCopiedEvents: (events: EffluxChannelEntry[][]) => void;
  clearCopiedEvents: () => void;
}

const NO_SELECTION = -1;

export const useSelectionStore = create<SelectionState>((set, get) => ({
  minSelectedStep:      NO_SELECTION,
  maxSelectedStep:      NO_SELECTION,
  firstSelectedChannel: NO_SELECTION,
  lastSelectedChannel:  NO_SELECTION,

  copiedEvents: [],

  setSelection: (firstChannel, lastChannel, minStep, maxStep) => set({
    firstSelectedChannel: firstChannel,
    lastSelectedChannel:  lastChannel,
    minSelectedStep:      minStep,
    maxSelectedStep:      maxStep,
  }),

  clearSelection: () => set({
    firstSelectedChannel: NO_SELECTION,
    lastSelectedChannel:  NO_SELECTION,
    minSelectedStep:      NO_SELECTION,
    maxSelectedStep:      NO_SELECTION,
  }),

  hasSelection: () => {
    const s = get();
    return s.firstSelectedChannel !== NO_SELECTION
        && s.minSelectedStep      !== NO_SELECTION;
  },

  hasCopiedEvents: () => get().copiedEvents.length > 0,

  setCopiedEvents:   (events) => set({ copiedEvents: events }),
  clearCopiedEvents: ()       => set({ copiedEvents: [] }),
}));

// ── Helpers (used by useKeyboardInput when copy/cut/paste fire) ───────────────

/** Deep-clone a single event so the copy doesn't alias the source. */
export function cloneEvent(ev: EffluxAudioEvent): EffluxAudioEvent {
  return {
    instrument: ev.instrument,
    note:       ev.note,
    octave:     ev.octave,
    action:     ev.action,
    recording:  false,                                 // never carry recording flag into clipboard
    seq:        { ...ev.seq, playing: false },         // reset transient seq state
    mp:         ev.mp ? { ...ev.mp }  : undefined,
  };
}
