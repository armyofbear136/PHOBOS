/**
 * useEditorStore.ts — Zustand replacement for upstream editor-module.ts.
 *
 * Phase 2b — owns the tracker cursor (channel × step), the editing flag
 * (when true, key presses write into the active pattern), the active note-
 * entry slot (slot 0 = note, 1 = instrument, 2 = mp module, 3 = mp value),
 * and the upper/lower keyboard octave assignments used by the note input
 * handler in `engine/services/keyboard/note-input-handler.ts`.
 *
 * The shape of state.editor in the daw-bridge snapshot is exactly the
 * subset of fields read by the engine's keyboard handlers — keep this
 * store's surface minimal and additive only.
 */

import { create } from 'zustand';

export interface EditorState {
  /** Channel index of the cursor — also the "selectedInstrument" upstream. */
  selectedInstrument:   number;
  /** Step index of the cursor within the active pattern. */
  selectedStep:         number;
  /** Slot inside the step (0 = note, 1 = instrument, 2 = module, 3 = value). */
  selectedSlot:         number;
  /** When true, modal note-entry editor is visible. */
  showNoteEntry:        boolean;
  /** Octave for the QWERTY upper-row keys (Q W E R T Y U I O P …). */
  higherKeyboardOctave: number;
  /** Octave for the QWERTY lower-row keys (Z X C V B N M , . / …). */
  lowerKeyboardOctave:  number;

  setSelectedInstrument:   (v: number)  => void;
  setSelectedStep:         (v: number)  => void;
  setSelectedSlot:         (v: number)  => void;
  setShowNoteEntry:        (v: boolean) => void;
  setHigherKeyboardOctave: (v: number)  => void;
  setLowerKeyboardOctave:  (v: number)  => void;

  /** Move cursor by ±1 channel, clamped to [0, channelCount − 1]. */
  moveChannel: (delta: number, channelCount: number) => void;
  /** Move cursor by ±1 step, wrapping. */
  moveStep:    (delta: number, stepCount: number)    => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  // Cursor lands on channel 1 by default — channel 0 is the reserved system
  // chain (Helm + Crystal) and is never user-addressable from the DAW.
  selectedInstrument:   1,
  selectedStep:         0,
  selectedSlot:         0,
  showNoteEntry:        false,
  higherKeyboardOctave: 4,
  lowerKeyboardOctave:  2,

  setSelectedInstrument:   (v) => {
    // Channel 0 is the reserved system chain — never user-addressable.
    // Defensive guard: even if a future caller forgets to range-check,
    // the cursor cannot land on the reserved channel.
    if (v <= 0) return;
    set({ selectedInstrument: v });
  },
  setSelectedStep:         (v) => set({ selectedStep:         v }),
  setSelectedSlot:         (v) => set({ selectedSlot:         v }),
  setShowNoteEntry:        (v) => set({ showNoteEntry:        v }),
  setHigherKeyboardOctave: (v) => set({ higherKeyboardOctave: v }),
  setLowerKeyboardOctave:  (v) => set({ lowerKeyboardOctave:  v }),

  moveChannel: (delta, channelCount) => set((s) => {
    if (channelCount <= 1) return s;                  // only the reserved channel — nothing to move to
    let next = s.selectedInstrument + delta;
    if (next < 1)             next = 1;               // never land on the reserved channel 0
    if (next >= channelCount) next = channelCount - 1;
    return { selectedInstrument: next };
  }),

  moveStep: (delta, stepCount) => set((s) => {
    if (stepCount <= 0) return s;
    let next = s.selectedStep + delta;
    while (next < 0)         next += stepCount;
    while (next >= stepCount) next -= stepCount;
    return { selectedStep: next };
  }),
}));
