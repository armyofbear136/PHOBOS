/**
 * useAudioContext.ts — WebAudio unlock + AudioService bootstrap.
 *
 * Browsers require a user gesture (click/touch/key) before an AudioContext
 * can emit sound. The DAW panel's Play button invokes `unlock()` from its
 * onClick, satisfying that requirement.
 *
 * Phase 2c change: we construct the AudioContext directly here inside the
 * gesture handler, then pass it explicitly into `AudioService.init(ctx)`.
 * Upstream Efflux's `webaudio-helper.init()` installs its own global
 * `click`/`keydown`/`drop` listeners and waits for a gesture to resolve its
 * Promise — using that from a React onClick leaks a second listener that
 * never fires cleanly. We skip it.
 *
 * On browsers where the context is created in 'suspended' state, we call
 * `ctx.resume()` which works because we're still inside the gesture handler.
 *
 * Phase 3 change: after the legacy song is loaded, we ALSO populate the
 * session store via fromEffluxSong(). The Phase 3 scheduler reads from
 * useSessionStore; without this call the scheduler refuses to play. The
 * legacy useSongStore continues to be populated in parallel during the
 * transition (per design doc §4.2) — applyModules and the instrument
 * editors still read from there.
 */

import { useCallback, useRef, useState } from 'react';
import { initDawBridge }     from '@/components/audio/engine/services/init-draw-bridge';
import AudioService, { setSampleCacheRef } from '@/components/audio/engine/services/audio-service';
import { fromEffluxSong }    from '@/components/audio/engine/services/session-serializer';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useSessionStore }   from '@/store/daw/useSessionStore';
import { useSampleStore }    from '@/store/daw/useSampleStore';
import { buildTestSong }     from '@/components/audio/engine/test-song';

export interface AudioContextUnlock {
  unlocked:  boolean;
  unlocking: boolean;
  error:     string | null;
  unlock:    () => Promise<void>;
  audioContext: AudioContext | null;
}

/**
 * Module-level reference so repeated mounts (StrictMode) share the same
 * AudioContext rather than leaking new ones.
 */
let sharedContext: AudioContext | null = null;

function createContext(): AudioContext {
  if (sharedContext) return sharedContext;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('WebAudio API not supported');
  sharedContext = new Ctor();
  return sharedContext;
}

export function useAudioContext(): AudioContextUnlock {
  const [unlocked,  setUnlocked]  = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const initPromiseRef            = useRef<Promise<void> | null>(null);

  const unlock = useCallback(async (): Promise<void> => {
    if (unlocked) return;
    if (initPromiseRef.current) return initPromiseRef.current;

    const run = async (): Promise<void> => {
      setUnlocking(true);
      setError(null);
      try {
        // 1. Install the bridge so the engine can read state.
        initDawBridge();

        // 2. Ensure a song is loaded — applyModules() needs instruments.
        if (!useSongStore.getState().activeSong) {
          useSongStore.getState().setActiveSong(buildTestSong());
        }

        // 2a. Phase 3: ensure a session is loaded. The audio scheduler reads
        //     from useSessionStore; without an active session, togglePlayback
        //     refuses to play. Migrate the active song into a session via
        //     fromEffluxSong() — see PHOBOS-DAW-Phase-3-Session-Model.md §4.7.
        if (!useSessionStore.getState().activeSession) {
          const song = useSongStore.getState().activeSong;
          if (song) {
            useSessionStore.getState().setActiveSession(fromEffluxSong(song));
          }
        }

        // 3. Construct the AudioContext in the gesture window.
        const ctx = createContext();
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch { /* some browsers noop — continue */ }
        }

        // 4. Boot the engine with the live context.
        await AudioService.init(ctx);

        // 5. Wire the sample cache reference so SAMPLE-waveform oscillators
        //    can resolve their AudioBuffer by sample name during noteOn.
        setSampleCacheRef(useSampleStore.getState().sampleCache);

        // 6. Build per-instrument module graph + cache custom wavetables.
        //    The session shares the same Instrument[] array with the song
        //    by reference (see fromEffluxSong), so applyModules(song) builds
        //    the graph the session-scheduler will read against.
        const song = useSongStore.getState().activeSong;
        if (song) {
          AudioService.applyModules(song);
          AudioService.cacheCustomTables(song.instruments);
        }

        setUnlocked(true);
      } catch (err) {
        setError((err as Error).message);
        throw err;
      } finally {
        setUnlocking(false);
      }
    };

    initPromiseRef.current = run();
    try {
      await initPromiseRef.current;
    } finally {
      if (!unlocked) initPromiseRef.current = null;
    }
  }, [unlocked]);

  return { unlocked, unlocking, error, unlock, audioContext: sharedContext };
}
