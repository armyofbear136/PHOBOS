/**
 * test-song.ts — Hardcoded demo song for the Phase 2a gate.
 *
 * Uses SongFactory to build a valid EffluxSong with two synth instruments
 * and a 16-step pattern containing a short descending motif. Enough signal
 * to confirm the engine and bridge are connected end-to-end: you hear
 * notes, you know playback works.
 *
 * Will be replaced in Phase 2b when the tracker grid allows real authoring.
 */

import SongFactory from './model/factories/song-factory';
import EventFactory from './model/factories/event-factory';
import { ACTION_NOTE_ON, type EffluxAudioEvent } from './model/types/audio-event';
import { EffluxSongType, type EffluxSong } from './model/types/song';

/**
 * Build a fresh demo song. Called from useAudioContext.unlock() when no song
 * is yet loaded. Returns a new object each call — the caller owns mutation.
 */
export function buildTestSong(): EffluxSong {
  const song = SongFactory.create(8, EffluxSongType.TRACKER);
  song.meta.title  = 'PHOBOS DAW — Test Song';
  song.meta.author = 'PHOBOS';

  // Place a short descending motif on channel 0 (first instrument) at steps
  // 0, 4, 8, 12 — a quarter-note arpeggio at 120 bpm. Middle C, B3, A3, G3.
  const pattern = song.patterns[0];
  const channel = pattern.channels[0];

  const placements: Array<{ step: number; note: string; octave: number }> = [
    { step: 0,  note: 'C', octave: 4 },
    { step: 4,  note: 'B', octave: 3 },
    { step: 8,  note: 'A', octave: 3 },
    { step: 12, note: 'G', octave: 3 },
  ];

  for (const p of placements) {
    const event: EffluxAudioEvent = EventFactory.create(
      0,         // instrument index
      p.note,
      p.octave,
      ACTION_NOTE_ON,
    );
    channel[p.step] = event;
  }

  return song;
}
