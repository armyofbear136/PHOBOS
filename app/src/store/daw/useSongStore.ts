/**
 * useSongStore.ts — Zustand replacement for upstream src/store/modules/song-module.ts.
 *
 * Holds the active EffluxSong plus the local persistence registry.
 *
 * IMPORTANT — mutation discipline:
 *   Pattern channels are mutated IN PLACE (philosophy: zero allocation on hot
 *   paths, no spread, no reconstruct). React re-renders are driven by a
 *   monotonic `songVersion` counter. Any code that mutates the song must call
 *   `bumpSongVersion()` once after the mutation batch so subscribers re-read.
 *
 * Subscribers that must react to pattern/instrument edits should include
 * `songVersion` in their selector:
 *
 *     const song         = useSongStore(s => s.activeSong);
 *     const songVersion  = useSongStore(s => s.songVersion);   // re-render trigger
 *     // then read song.patterns[...].channels[...] directly
 *
 * Subscribers that only need the song reference (e.g. for save) can omit it.
 */

import { create } from 'zustand';
import type { EffluxSong, StoredEffluxSongDescriptor } from '@/components/audio/engine/model/types/song';

export interface SongState {
  activeSong:      EffluxSong | null;
  /** Bump this on every in-place mutation of `activeSong` to drive re-renders. */
  songVersion:     number;
  songs:           StoredEffluxSongDescriptor[];
  showSaveMessage: boolean;
  statesOnSave:    number;
  /** Dirty flag — set true on any mutation, cleared on successful save. */
  dirty:           boolean;

  setActiveSong:   (song: EffluxSong | null) => void;
  setSongs:        (songs: StoredEffluxSongDescriptor[]) => void;
  setStatesOnSave: (n: number) => void;
  bumpSongVersion: () => void;
  markClean:       () => void;
}

export const useSongStore = create<SongState>((set) => ({
  activeSong:      null,
  songVersion:     0,
  songs:           [],
  showSaveMessage: true,
  statesOnSave:    0,
  dirty:           false,

  setActiveSong:   (song)  => set({ activeSong: song, songVersion: 0, dirty: false }),
  setSongs:        (songs) => set({ songs }),
  setStatesOnSave: (n)     => set({ statesOnSave: n }),
  bumpSongVersion: ()      => set((s) => ({ songVersion: s.songVersion + 1, dirty: true })),
  markClean:       ()      => set({ dirty: false }),
}));
