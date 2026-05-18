/**
 * NoteEntryEditor.tsx — Modal note-entry overlay.
 *
 * Opens when useEditorStore.showNoteEntry is true. Lets the user type a
 * specific note name, octave, and (optionally) instrument index for the
 * cell at the cursor, then commits via Enter. Escape closes without
 * writing.
 *
 * While the modal is open it registers itself with KeyboardService as the
 * listener override so the grid's keyboard handling is bypassed — otherwise
 * typing "C" into the note field would write a C-note directly into the
 * pattern via useKeyboardInput.
 *
 * Notes: "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B".
 * Octave: 1–8.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import EventFactory from '@/components/audio/engine/model/factories/event-factory';
import { ACTION_NOTE_ON } from '@/components/audio/engine/model/types/audio-event';
import KeyboardService from '@/components/audio/engine/services/keyboard-service';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useSequencerStore } from '@/store/daw/useSequencerStore';
import { useEditorStore }    from '@/store/daw/useEditorStore';

const VALID_NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

export function NoteEntryEditor() {
  const show = useEditorStore((s) => s.showNoteEntry);
  const setShow = useEditorStore((s) => s.setShowNoteEntry);

  const [note,       setNote]       = useState('C');
  const [octave,     setOctave]     = useState(4);
  const [instrument, setInstrument] = useState(1);
  const noteInputRef = useRef<HTMLInputElement>(null);

  // Seed with the cursor's current cell when opened.
  useEffect(() => {
    if (!show) return;
    const editor    = useEditorStore.getState();
    const song      = useSongStore.getState().activeSong;
    const patternIx = useSequencerStore.getState().activePatternIndex;
    if (!song) return;
    const pattern = song.patterns[patternIx];
    if (!pattern) return;

    const cell = pattern.channels[editor.selectedInstrument]?.[editor.selectedStep];
    // `cell` is EffluxAudioEvent | 0 | undefined. The truthy check below
    // narrows to EffluxAudioEvent (0 and undefined are both falsy).
    if (cell && cell.note) {
      setNote(cell.note);
      setOctave(cell.octave);
      setInstrument(cell.instrument);
    } else {
      setInstrument(editor.selectedInstrument);
    }
    // Focus the note field on open so the user can type immediately.
    requestAnimationFrame(() => noteInputRef.current?.focus());
  }, [show]);

  // While the modal is open, take over keyboard from the tracker grid.
  useEffect(() => {
    if (!show) return;
    const close = () => setShow(false);
    KeyboardService.setListener((type, keyCode) => {
      if (type === 'down' && keyCode === 27 /* Esc */) {
        close();
        return true;
      }
      return false;                                 // let the modal's native input handle it
    });
    return () => KeyboardService.setListener(null);
  }, [show, setShow]);

  const commit = useCallback(() => {
    const editor    = useEditorStore.getState();
    const song      = useSongStore.getState().activeSong;
    const patternIx = useSequencerStore.getState().activePatternIndex;
    if (!song) return;
    const pattern = song.patterns[patternIx];
    if (!pattern) return;
    if (!VALID_NOTES.includes(note))     return;
    if (octave < 1 || octave > 8)        return;
    if (instrument < 1 || instrument >= song.instruments.length) return;     // ch 0 reserved

    const channel = pattern.channels[editor.selectedInstrument];
    if (!channel) return;

    const event = EventFactory.create(instrument);
    event.note   = note;
    event.octave = octave;
    event.action = ACTION_NOTE_ON;
    channel[editor.selectedStep] = event;               // in-place mutation
    useSongStore.getState().bumpSongVersion();

    setShow(false);
  }, [note, octave, instrument, setShow]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShow(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-80 bg-background border border-phobos-green/30 rounded-sm shadow-2xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-terminal text-phobos-green/80 uppercase tracking-widest">
            Note Entry
          </h2>
          <button onClick={() => setShow(false)} className="text-muted-foreground/40 hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <label className="flex flex-col gap-1 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
          Note
          <input
            ref={noteInputRef}
            value={note}
            onChange={(e) => setNote(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            className="px-2 py-1 text-xs font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
            placeholder="C, C#, D…"
          />
        </label>

        <label className="flex flex-col gap-1 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
          Octave
          <input
            type="number"
            min={1} max={8} step={1}
            value={octave}
            onChange={(e) => setOctave(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            className="px-2 py-1 text-xs font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
          />
        </label>

        <label className="flex flex-col gap-1 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
          Instrument
          <input
            type="number"
            min={1}
            step={1}
            value={instrument}
            onChange={(e) => setInstrument(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            className="px-2 py-1 text-xs font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
          />
        </label>

        <div className="flex gap-2 justify-end mt-1">
          <button
            onClick={() => setShow(false)}
            className="px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border border-border/30 text-muted-foreground/60 hover:text-foreground hover:border-border/60"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border border-phobos-green/50 text-phobos-green hover:bg-phobos-green/10"
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
