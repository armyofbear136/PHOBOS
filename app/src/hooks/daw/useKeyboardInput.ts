/**
 * useKeyboardInput.ts — Global keyboard handler for the DAW panel.
 *
 * Mounted by EffluxPanel while the panel is visible. Installs a single
 * `keydown` + `keyup` pair on `window` and delegates through
 * `KeyboardService` (which handles suspension + modal listener overrides).
 *
 * Behavior:
 *   • Note keys (QWERTY row + ZXCV row) → EffluxAudioEvent write into the
 *     active pattern channel at the cursor when recording, and always fire
 *     noteOn/noteOff through AudioService so Phase 2c gets audio for free.
 *   • Delete / Backspace → clear the event at the cursor, advance one step.
 *   • Arrow keys → move cursor (channel/step).
 *   • Shift+Up / Shift+Down → shift the KEYBOARD octave (upper row by default).
 *   • Tab / Shift+Tab → jump one channel.
 *   • Space → toggle playback (ignored when focus is in an <input>/<textarea>).
 *   • R → toggle recording.
 *
 * All pattern mutations are IN PLACE; after a mutation we call
 * `useSongStore.getState().bumpSongVersion()` once to drive subscribers.
 *
 * Zero-allocation discipline:
 *   • No object allocation in the keydown fast path OTHER than
 *     EventFactory.create when the user writes a note (user-rate, ~10 Hz max).
 *   • The PartialPitch passed to AudioService is a scratch object mutated
 *     in place — never returned, never captured.
 */

import { useEffect } from 'react';
import EventFactory from '@/components/audio/engine/model/factories/event-factory';
import {
  ACTION_NOTE_ON,
  ACTION_NOTE_OFF,
  type EffluxAudioEvent,
} from '@/components/audio/engine/model/types/audio-event';
import KeyboardService from '@/components/audio/engine/services/keyboard-service';
import AudioService, {
  noteOn as audioNoteOn,
  noteOff as audioNoteOff,
} from '@/components/audio/engine/services/audio-service';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useSequencerStore } from '@/store/daw/useSequencerStore';
import { useEditorStore }    from '@/store/daw/useEditorStore';
import { useInstrumentStore } from '@/store/daw/useInstrumentStore';

// ── Key → note map (mirrors upstream note-input-handler exactly) ─────────────

//                 Q  2  W  3  E  R  5  T  6  Y  7  U  I  9  O  0  P
const HIGHER_KEYS = [81,50,87,51,69,82,53,84,54,89,55,85,73,57,79,48,80];
const LOWER_KEYS  = [90,83,88,68,67,86,71,66,72,78,74,77,188,76,190,186,191];
const KEY_NOTE_LIST = [
  'C','C#','D','D#','E','F','F#','G','G#','A','A#','B','C','C#','D','D#','E',
];

// ── Non-note keycodes ────────────────────────────────────────────────────────

const KEY_SPACE     = 32;
const KEY_LEFT      = 37;
const KEY_UP        = 38;
const KEY_RIGHT     = 39;
const KEY_DOWN      = 40;
const KEY_DELETE    = 46;
const KEY_BACKSPACE = 8;
const KEY_TAB       = 9;
const KEY_R         = 82;
const KEY_E         = 69;

// ── Scratch objects (pre-allocated, mutated in place) ────────────────────────

interface ScratchPitch { note: string; octave: number; }
const scratchPitch: ScratchPitch = { note: '', octave: 0 };

/** Tracks currently-playing events by `${note}${octave}` so keyup releases them cleanly. */
const activeNotes = new Map<string, EffluxAudioEvent>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function decodeNoteKey(keyCode: number): { note: string; octave: number } | null {
  const editor = useEditorStore.getState();

  const higherIdx = HIGHER_KEYS.indexOf(keyCode);
  if (higherIdx > -1) {
    scratchPitch.note   = KEY_NOTE_LIST[higherIdx];
    scratchPitch.octave = editor.higherKeyboardOctave + (higherIdx >= 12 ? 1 : 0);
    return scratchPitch;
  }

  const lowerIdx = LOWER_KEYS.indexOf(keyCode);
  if (lowerIdx > -1) {
    scratchPitch.note   = KEY_NOTE_LIST[lowerIdx];
    scratchPitch.octave = editor.lowerKeyboardOctave + (lowerIdx >= 12 ? 1 : 0);
    return scratchPitch;
  }

  return null;
}

function pitchKey(note: string, octave: number): string {
  return `${note}${octave}`;
}

function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

/**
 * Write an EffluxAudioEvent into the active pattern channel at the given
 * (channelIndex, stepIndex). MUTATES the channel array in place.
 */
function writeEventAt(channelIndex: number, stepIndex: number, event: EffluxAudioEvent | 0): void {
  const song = useSongStore.getState().activeSong;
  if (!song) return;
  const patternIndex = useSequencerStore.getState().activePatternIndex;
  const pattern = song.patterns[patternIndex];
  if (!pattern) return;
  const channel = pattern.channels[channelIndex];
  if (!channel) return;
  if (stepIndex < 0 || stepIndex >= pattern.steps) return;

  channel[stepIndex] = event;                                 // in-place mutation
  useSongStore.getState().bumpSongVersion();
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useKeyboardInput(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    KeyboardService.init();

    const onKeyDown = (event: KeyboardEvent): void => {
      KeyboardService.updateModifiers(event);

      // Scoped listener override (note-entry editor, etc.) takes priority.
      const override = KeyboardService.getListener();
      if (override) {
        const handled = override('down', event.keyCode, event);
        if (handled) { event.preventDefault(); return; }
      }

      if (KeyboardService.isSuspended())      return;
      if (event.repeat)                       return;
      if (isTextInputFocused())               return;

      const keyCode = event.keyCode;

      // ── Transport controls ───────────────────────────────────────────────
      if (keyCode === KEY_SPACE) {
        event.preventDefault();
        const seq = useSequencerStore.getState();
        seq.setPlaying(!seq.playing);
        try { AudioService.togglePlayback(!seq.playing); } catch { /* stub */ }
        return;
      }
      if (keyCode === KEY_R && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const seq = useSequencerStore.getState();
        seq.setRecording(!seq.recording);
        return;
      }
      if (keyCode === KEY_E && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const editor = useEditorStore.getState();
        useInstrumentStore.getState().openEditor(editor.selectedInstrument);
        return;
      }

      // ── Cursor navigation ────────────────────────────────────────────────
      const song = useSongStore.getState().activeSong;
      if (!song) return;
      const pattern = song.patterns[useSequencerStore.getState().activePatternIndex];
      if (!pattern) return;
      const channelCount = pattern.channels.length;
      const stepCount    = pattern.steps;
      const editor       = useEditorStore.getState();

      if (keyCode === KEY_LEFT)  { event.preventDefault(); editor.moveChannel(-1, channelCount); return; }
      if (keyCode === KEY_RIGHT) { event.preventDefault(); editor.moveChannel( 1, channelCount); return; }
      if (keyCode === KEY_UP && !event.shiftKey)   { event.preventDefault(); editor.moveStep(-1, stepCount); return; }
      if (keyCode === KEY_DOWN && !event.shiftKey) { event.preventDefault(); editor.moveStep( 1, stepCount); return; }
      if (keyCode === KEY_TAB) {
        event.preventDefault();
        editor.moveChannel(event.shiftKey ? -1 : 1, channelCount);
        return;
      }

      // ── Shift+Up / Shift+Down → octave shift (upper row) ────────────────
      if (event.shiftKey && keyCode === KEY_UP)   {
        event.preventDefault();
        editor.setHigherKeyboardOctave(Math.min(8, editor.higherKeyboardOctave + 1));
        return;
      }
      if (event.shiftKey && keyCode === KEY_DOWN) {
        event.preventDefault();
        editor.setHigherKeyboardOctave(Math.max(0, editor.higherKeyboardOctave - 1));
        return;
      }

      // ── Delete / Backspace → clear step, advance cursor ──────────────────
      if (keyCode === KEY_DELETE || keyCode === KEY_BACKSPACE) {
        event.preventDefault();
        writeEventAt(editor.selectedInstrument, editor.selectedStep, 0);
        editor.moveStep(1, stepCount);
        return;
      }

      // ── Note keys ────────────────────────────────────────────────────────
      const pitch = decodeNoteKey(keyCode);
      if (!pitch) return;

      const sequencer  = useSequencerStore.getState();
      const instrument = song.instruments[editor.selectedInstrument];
      if (!instrument) return;

      // Build the event. EventFactory allocates — acceptable, ~10 Hz max.
      const audioEvent       = EventFactory.create(editor.selectedInstrument);
      audioEvent.note        = pitch.note;
      audioEvent.octave      = pitch.octave;
      audioEvent.action      = ACTION_NOTE_ON;

      // Route through AudioService so Phase 2c automatically produces sound.
      try { audioNoteOn(audioEvent, instrument, 0); } catch { /* stub */ }
      activeNotes.set(pitchKey(pitch.note, pitch.octave), audioEvent);

      // Record → write into pattern; otherwise just audible preview.
      if (sequencer.recording) {
        const targetStep = sequencer.playing ? sequencer.currentStep : editor.selectedStep;
        writeEventAt(editor.selectedInstrument, targetStep, audioEvent);
        if (!sequencer.playing) {
          editor.moveStep(1, stepCount);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      KeyboardService.updateModifiers(event);

      const override = KeyboardService.getListener();
      if (override) {
        const handled = override('up', event.keyCode, event);
        if (handled) return;
      }

      if (KeyboardService.isSuspended()) return;
      if (isTextInputFocused())          return;

      const pitch = decodeNoteKey(event.keyCode);
      if (!pitch) return;

      const key = pitchKey(pitch.note, pitch.octave);
      const held = activeNotes.get(key);
      if (!held) return;
      activeNotes.delete(key);

      try { audioNoteOff(held, 0); } catch { /* stub */ }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      // Release any held notes on unmount.
      for (const ev of activeNotes.values()) {
        try { audioNoteOff(ev, 0); } catch { /* stub */ }
      }
      activeNotes.clear();
      KeyboardService.reset();
    };
  }, [enabled]);
}
