/**
 * usePolarisPlaybackStore.ts — Single source of truth for Polaris playback.
 *
 * Both the docked sidebar player (PolarisPlayerDock) and the floating window
 * player (PolarisPlayer) read from and write to this store. Either can drive
 * playback; the other reflects state automatically.
 *
 * The view mode (`docked` | `floating`) controls which surface is visible.
 * Toggling between them is purely UI — playback continues uninterrupted
 * because the host's audioId stays the same; only which React component is
 * rendering progress is changing.
 *
 * The host's FilePlayerNode is the authoritative source of position /
 * duration / playing state. The store mirrors what the host reports via
 * /api/audio/player/status (polled at ~10 Hz while playing). When the user
 * scrubs or play/pauses, the store optimistically updates locally and fires
 * the REST call; if the call fails the next status poll reconciles.
 */

import { create } from 'zustand';
import { useEffect } from 'react';
import {
  pauseAudio,
  resumeAudio,
  seekAudio,
  stopAudio,
  getAudioStatus,
  playPolarisFile,
  setAudioFileVolume,
} from '@/components/audio/services/DawApi';

// ── Types ────────────────────────────────────────────────────────────────────

/** Subset of Polaris's Song fields we care about for playback + display. */
export interface PolarisSong {
  /** Polaris virtual path — `<mountName>/Artist/Album/Track.ext`. */
  path:        string;
  title?:      string;
  artists?:    string[];
  album?:      string;
  album_artists?: string[];
  duration?:   number;       // seconds, if Polaris reported it
  artwork?:    string;
}

export type PolarisRepeatMode = 'none' | 'one' | 'all';
export type PolarisViewMode   = 'docked' | 'floating' | 'hidden';

interface PolarisPlaybackState {
  // ── Persistent UI state ───────────────────────────────────────────────────
  view:        PolarisViewMode;

  // ── Queue ─────────────────────────────────────────────────────────────────
  queue:       PolarisSong[];
  queueIdx:    number;
  shuffle:     boolean;
  repeat:      PolarisRepeatMode;

  // ── Active playback (mirrors host) ────────────────────────────────────────
  audioId:     number | null;
  playing:     boolean;
  /** Position in seconds, mirrored from host. UI displays as MM:SS. */
  positionSec: number;
  durationSec: number;

  // ── Dispatch ──────────────────────────────────────────────────────────────
  setView:        (view: PolarisViewMode) => void;
  /** Toggle between docked and floating. Hidden state is unaffected. */
  toggleDockFloat: () => void;

  /** Replace the queue and start playing from `startIdx`. */
  playQueue:      (songs: PolarisSong[], startIdx: number) => Promise<void>;
  /** Append songs to the queue without changing what's playing. */
  enqueue:        (songs: PolarisSong[]) => void;
  /** Remove a song from the queue. Adjusts queueIdx if needed. */
  removeFromQueue: (idx: number) => void;
  /** Move a song within the queue. Used for drag-reorder. */
  reorderQueue:    (fromIdx: number, toIdx: number) => void;
  clearQueue:     () => void;

  /** Play / pause toggle on the current track. */
  togglePlay:     () => Promise<void>;
  pause:          () => Promise<void>;
  resume:         () => Promise<void>;
  /** Hard stop — releases the host audioId. */
  stop:           () => Promise<void>;
  /** Seek the current track. positionMs >= 0. */
  seek:           (positionMs: number) => Promise<void>;
  /** Skip to next / prev. Direction +1 forwards, -1 backwards. */
  skip:           (dir: 1 | -1) => Promise<void>;

  setShuffle:     (s: boolean) => void;
  setRepeat:      (r: PolarisRepeatMode) => void;
  /** Linear gain sent to the host. 1.0 = unity, 0.0 = silence. */
  volume:         number;
  setVolume:      (gain: number) => Promise<void>;

  // ── Internal — called by the polling effect ──────────────────────────────
  applyHostStatus: (s: { playing: boolean; positionMs: number; durationMs: number; finished: boolean }) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextIndex(state: PolarisPlaybackState, dir: 1 | -1): number {
  const n = state.queue.length;
  if (n === 0) return 0;
  if (state.repeat === 'one') return state.queueIdx;
  if (state.shuffle) {
    // Simple uniform shuffle: pick any other index.
    if (n === 1) return 0;
    let next = state.queueIdx;
    while (next === state.queueIdx) next = Math.floor(Math.random() * n);
    return next;
  }
  return (state.queueIdx + dir + n) % n;
}


// ── Rehydration ──────────────────────────────────────────────────────────────

const ENGINE_BASE = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/g, '');

/**
 * Called once on mount. Hits /api/audio/player/session — if the backend has
 * an active Polaris session (i.e. music was playing before the page refresh),
 * restores the queue, queueIdx, shuffle, repeat, and audioId so the UI
 * reflects the real host state without restarting the track.
 */
export async function rehydratePolarisSession(): Promise<void> {
  try {
    const res = await fetch(`${ENGINE_BASE}/api/audio/player/session`);
    if (!res.ok) return;
    const session = await res.json() as {
      audioId:     number;
      virtualPath: string;
      durationMs:  number;
      queue:       string[];
      queueIdx:    number;
      shuffle:     boolean;
      repeat:      'none' | 'one' | 'all';
    } | null;
    if (!session) return;

    // Verify the audioId is still alive on the host before restoring.
    const status = await getAudioStatus(session.audioId);

    // Restore transport state immediately so the UI isn't blank.
    usePolarisPlaybackStore.setState({
      audioId:     session.audioId,
      playing:     status.playing,
      positionSec: status.positionMs / 1000,
      durationSec: status.durationMs / 1000,
      queue:    session.queue.map((path) => ({ path })),
      queueIdx: session.queueIdx,
      shuffle:  session.shuffle,
      repeat:   session.repeat,
    });

    // Backfill song metadata (title, artists, album, artwork) from Polaris so
    // the player header and now-playing list aren't blank after rehydration.
    // Fire-and-forget — UI is already interactive above.
    void (async () => {
      try {
        const res2 = await fetch(
          `${ENGINE_BASE}/api/services/polaris/proxy/api/songs`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Accept-Version': '8' },
            body:    JSON.stringify({ paths: session.queue }),
          }
        );
        if (!res2.ok) return;
        const songs = await res2.json() as Array<{
          path: string; title?: string; artists?: string[];
          album_artists?: string[]; album?: string;
          track_number?: number; disc_number?: number;
          duration?: number; artwork?: string;
        }>;
        // Index by path so we preserve queue order.
        const byPath = new Map(songs.map(s => [s.path, s]));
        usePolarisPlaybackStore.setState(s => ({
          queue: s.queue.map(q => ({ ...q, ...(byPath.get(q.path) ?? {}) })),
        }));
      } catch { /* metadata backfill is best-effort */ }
    })();
  } catch {
    // Host unreachable or session expired — start fresh, no-op.
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export const usePolarisPlaybackStore = create<PolarisPlaybackState>((set, get) => ({
  // Default: dock is the always-on surface; floating shows on user intent.
  view:        'docked',

  queue:       [],
  queueIdx:    0,
  shuffle:     false,
  repeat:      'none',

  audioId:     null,
  playing:     false,
  positionSec: 0,
  durationSec: 0,
  volume:      1.0,

  setView: (view) => set({ view }),

  toggleDockFloat: () => {
    const v = get().view;
    if      (v === 'docked')   set({ view: 'floating' });
    else if (v === 'floating') set({ view: 'docked'   });
    // hidden → no-op; user must explicitly choose where it reappears
  },

  playQueue: async (songs, startIdx) => {
    if (songs.length === 0) return;
    const idx = Math.max(0, Math.min(startIdx, songs.length - 1));
    set({ queue: songs, queueIdx: idx });
    await playCurrentTrack();
  },

  enqueue: (songs) => {
    set((s) => ({ queue: [...s.queue, ...songs] }));
  },

  removeFromQueue: (idx) => {
    set((s) => {
      if (idx < 0 || idx >= s.queue.length) return {};
      const newQueue = s.queue.slice(0, idx).concat(s.queue.slice(idx + 1));
      let newIdx = s.queueIdx;
      // If we removed something before the current track, slide the cursor.
      // If we removed the current track, leave the cursor where it is — the
      // next song slides into that slot.
      if (idx < s.queueIdx) newIdx = s.queueIdx - 1;
      return { queue: newQueue, queueIdx: Math.max(0, Math.min(newIdx, newQueue.length - 1)) };
    });
  },

  reorderQueue: (fromIdx, toIdx) => {
    set((s) => {
      if (fromIdx === toIdx) return {};
      if (fromIdx < 0 || fromIdx >= s.queue.length) return {};
      if (toIdx   < 0 || toIdx   >= s.queue.length) return {};
      const newQueue = s.queue.slice();
      const [moved] = newQueue.splice(fromIdx, 1);
      newQueue.splice(toIdx, 0, moved);
      // Adjust queueIdx so the *currently playing* song stays current.
      let newCursor = s.queueIdx;
      if      (fromIdx === s.queueIdx) newCursor = toIdx;
      else if (fromIdx <  s.queueIdx && toIdx >= s.queueIdx) newCursor -= 1;
      else if (fromIdx >  s.queueIdx && toIdx <= s.queueIdx) newCursor += 1;
      return { queue: newQueue, queueIdx: newCursor };
    });
  },

  clearQueue: () => set({ queue: [], queueIdx: 0 }),

  togglePlay: async () => {
    const s = get();
    if (s.playing) await s.pause();
    else if (s.audioId !== null) await s.resume();
    else if (s.queue.length > 0) await playCurrentTrack();   // first play after a queue change
  },

  pause: async () => {
    const id = get().audioId;
    if (id === null) return;
    set({ playing: false });    // optimistic
    try { await pauseAudio(id); }
    catch (err) { console.error('[Polaris] pause failed:', err); }
  },

  resume: async () => {
    const id = get().audioId;
    if (id === null) return;
    set({ playing: true });
    try { await resumeAudio(id); }
    catch (err) { console.error('[Polaris] resume failed:', err); }
  },

  stop: async () => {
    const id = get().audioId;
    if (id === null) return;
    set({ playing: false, audioId: null, positionSec: 0, durationSec: 0 });
    try { await stopAudio(id); }
    catch (err) { console.error('[Polaris] stop failed:', err); }
  },

  seek: async (positionMs) => {
    const id = get().audioId;
    if (id === null) return;
    set({ positionSec: positionMs / 1000 });    // optimistic
    try { await seekAudio(id, positionMs); }
    catch (err) { console.error('[Polaris] seek failed:', err); }
  },

  skip: async (dir) => {
    const s = get();
    if (s.queue.length === 0) return;

    // Stop-on-end semantics: forward skip past the last track in repeat=none
    // mode pauses at the end.
    if (dir === 1 && s.repeat === 'none' && s.queueIdx === s.queue.length - 1) {
      await s.stop();
      return;
    }

    const next = nextIndex(s, dir);
    set({ queueIdx: next });
    await playCurrentTrack();
  },

  setShuffle: (shuffle) => set({ shuffle }),
  setRepeat:  (repeat)  => set({ repeat  }),

  setVolume: async (gain) => {
    set({ volume: gain });
    const { audioId } = get();
    if (audioId !== null) {
      try { await setAudioFileVolume(audioId, gain); } catch { /* best-effort */ }
    }
  },

  applyHostStatus: ({ playing, positionMs, durationMs, finished }) => {
    set({
      playing,
      positionSec: positionMs / 1000,
      durationSec: durationMs / 1000,
    });
    // Auto-advance on natural end. The host's `finished` flag flips true when
    // the transport's input source has run out. We trigger skip(+1) which
    // honors the queue/shuffle/repeat state.
    if (finished) {
      if (!skipInFlight) {
        skipInFlight = true;
        void Promise.resolve().then(() => get().skip(1));
      }
    } else {
      skipInFlight = false;
    }
  },
}));

// ── Internal: drive a fresh playback ────────────────────────────────────────

// Guard: prevents applyHostStatus from firing skip(1) on multiple consecutive
// poll ticks while finished=true (the gap between track end and new track start).
let skipInFlight = false;

async function playCurrentTrack(): Promise<void> {
  const store = usePolarisPlaybackStore;
  const s     = store.getState();
  const song  = s.queue[s.queueIdx];
  if (!song) return;

  // Stop any existing playback first. Best-effort — if the host has already
  // dropped the slot (e.g., the track ended), stopAudio returns ok=false
  // and we ignore.
  if (s.audioId !== null) {
    try { await stopAudio(s.audioId); }
    catch { /* ignore */ }
  }

  try {
    const s2 = store.getState();
    const result = await playPolarisFile({
      virtualPath: song.path,
      queue:    s2.queue.map((s) => s.path),
      queueIdx: s2.queueIdx,
      shuffle:  s2.shuffle,
      repeat:   s2.repeat,
    });
    skipInFlight = false;
    store.setState({
      audioId:     result.audioId,
      playing:     true,
      positionSec: 0,
      durationSec: result.durationMs / 1000,
    });
    // Apply the current volume setting to the new audioId.
    const vol = store.getState().volume;
    if (vol !== 1.0) {
      try { await setAudioFileVolume(result.audioId, vol); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.error('[Polaris] playPolarisFile failed:', err);
    store.setState({ audioId: null, playing: false });
  }
}

// ── Status polling hook (consumed by whichever player surface is mounted) ──

/**
 * Polls the host for the current audioId's status at the given interval
 * while playback is active. Stops polling when audioId becomes null. Mount
 * this once in either the dock or the floating player — both surfaces share
 * the same store so only one poller is needed at a time.
 */
export function usePolarisStatusPolling(intervalMs = 100): void {
  const audioId = usePolarisPlaybackStore((s) => s.audioId);
  const apply   = usePolarisPlaybackStore((s) => s.applyHostStatus);

  useEffect(() => {
    if (audioId === null) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const status = await getAudioStatus(audioId);
        if (!cancelled) apply({
          playing:    status.playing,
          positionMs: status.positionMs,
          durationMs: status.durationMs,
          finished:   status.finished,
        });
      } catch {
        // Status failure (host bounced, audioId no longer exists) — clear it
        // so the user can start a fresh play.
        if (!cancelled) usePolarisPlaybackStore.setState({ audioId: null, playing: false });
      }
    };
    void tick();
    const handle = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [audioId, apply, intervalMs]);
}
