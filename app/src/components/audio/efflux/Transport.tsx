/**
 * Transport.tsx — DAW transport bar.
 *
 * Phase 3 changes:
 *   • BPM source switched from useSongStore to useSessionStore. Previously
 *     two stores held the tempo (Phase 2 carried it on EffluxSong, Phase 3
 *     introduced Session.tempo for the session-aware scheduler). The
 *     session is the source of truth from here on; useSongStore.tempo is
 *     untouched for now to avoid disturbing legacy editor paths.
 *   • Added Quantization dropdown — drives session.quantization, which
 *     audio-service caches at togglePlayback to set the launch-grid
 *     boundary (1bar / 2bar / half_bar / 1beat). Mid-playback changes
 *     take effect on next play, matching the tempo behavior.
 *   • Tempo edits write through useSessionStore.setTempo, which mutates
 *     in place and bumps sessionVersion.
 *
 * This is PURELY a control surface — actual step scheduling lives in the
 * audio-service tick. The STEP X/Y readout reads useSequencerStore.currentStep,
 * which useTransportTick mirrors from the selected channel's per-clip
 * cursor (see useTransportTick.ts header).
 */

import { memo, useCallback } from 'react';
import { Play, Square, Circle, Repeat } from 'lucide-react';
import { useSequencerStore } from '@/store/daw/useSequencerStore';
import { useSessionStore }   from '@/store/daw/useSessionStore';
import type { Quantization } from '@/components/audio/engine/model/types/session';

interface TransportProps {
  onPlay:  () => void;
  onStop:  () => void;
}

// ── Styles ─────────────────────────────────────────────────────────────────
const BTN_BASE   = 'flex items-center gap-1.5 px-3 py-1.5 text-sm font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all';
const BTN_GREEN  = `${BTN_BASE} border-phobos-green/25 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/50`;
const BTN_RED    = `${BTN_BASE} border-destructive/25 text-destructive/60 hover:text-destructive hover:border-destructive/50`;
const BTN_AMBER  = `${BTN_BASE} border-phobos-amber/25 text-phobos-amber/60 hover:text-phobos-amber hover:border-phobos-amber/50`;
const BTN_ACTIVE_RED   = `${BTN_BASE} border-destructive/70 text-destructive bg-destructive/10`;
const BTN_ACTIVE_AMBER = `${BTN_BASE} border-phobos-amber/70 text-phobos-amber bg-phobos-amber/10`;

// ── Quantization dropdown options ──────────────────────────────────────────
// Order matches the doc: coarsest → finest top-to-bottom is conventional in
// DAWs but Ableton-style menus go finest-on-top. Going with finest first.
const QUANTIZATION_OPTIONS: ReadonlyArray<{ value: Quantization; label: string }> = [
  { value: '1beat',    label: '1 BEAT'    },
  { value: 'half_bar', label: '1/2 BAR'   },
  { value: '1bar',     label: '1 BAR'     },
  { value: '2bar',     label: '2 BAR'     },
];

function TransportImpl({ onPlay, onStop }: TransportProps) {
  // Subscribe to sessionVersion so tempo and quantization changes from
  // elsewhere (e.g. session load) refresh the UI.
  const _v = useSessionStore((s) => s.sessionVersion);                    // eslint-disable-line @typescript-eslint/no-unused-vars

  const playing      = useSequencerStore((s) => s.playing);
  const recording    = useSequencerStore((s) => s.recording);
  const looping      = useSequencerStore((s) => s.looping);
  const currentStep  = useSequencerStore((s) => s.currentStep);
  const setRecording = useSequencerStore((s) => s.setRecording);
  const setLooping   = useSequencerStore((s) => s.setLooping);

  const session      = useSessionStore((s) => s.activeSession);
  const tempo        = session?.tempo ?? 120;
  const quantization = session?.quantization ?? '1bar';

  // Step count for the X/Y readout — show the SELECTED channel's active
  // clip's step count (same convention as PatternTrackList's row count).
  const selectedInstrument = useSequencerStore((s) => s.activeOrderIndex);  // unused; prefer editor below
  void selectedInstrument;
  // Use the selected channel's active clip step count (Session 2 simplification,
  // matches PatternTrackList row count).
  const totalSteps = (() => {
    if (!session) return 16;
    const sel = session.channels[1];                 // fallback: first user channel (ch 0 reserved)
    const clip = sel?.clips[sel.activeClipIdx];
    return clip?.steps ?? 16;
  })();

  const toggleRecord = useCallback(() => setRecording(!recording), [recording, setRecording]);
  const toggleLoop   = useCallback(() => setLooping(!looping),     [looping, setLooping]);

  const onTempoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value < 20 || value > 320) return;
    useSessionStore.getState().setTempo(value);
  }, []);

  const onQuantizationChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    useSessionStore.getState().setQuantization(e.target.value as Quantization);
  }, []);

  return (
    <div className="h-14 flex items-center gap-3 px-5 border-b border-border/30 bg-black/60 shrink-0">
      {!playing ? (
        <button onClick={onPlay} className={BTN_GREEN} title="Play (Space)">
          <Play className="w-4 h-4" />
          Play
        </button>
      ) : (
        <button onClick={onStop} className={BTN_RED} title="Stop (Space)">
          <Square className="w-4 h-4" />
          Stop
        </button>
      )}

      <button
        onClick={toggleRecord}
        className={recording ? BTN_ACTIVE_RED : BTN_RED}
        title="Record (R)"
      >
        <Circle className={`w-4 h-4 ${recording ? 'fill-current' : ''}`} />
        Rec
      </button>

      <button
        onClick={toggleLoop}
        className={looping ? BTN_ACTIVE_AMBER : BTN_AMBER}
        title="Loop"
      >
        <Repeat className="w-4 h-4" />
        Loop
      </button>

      <div className="w-px h-5 bg-border/30 mx-1" />

      <label className="flex items-center gap-2 text-sm font-terminal text-muted-foreground/60 uppercase tracking-[0.12em]">
        BPM
        <input
          type="number"
          min={20}
          max={320}
          step={1}
          value={tempo}
          onChange={onTempoChange}
          className="w-20 px-2 py-1 text-base font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
        />
      </label>

      <div className="w-px h-5 bg-border/30 mx-1" />

      <label className="flex items-center gap-2 text-sm font-terminal text-muted-foreground/60 uppercase tracking-[0.12em]">
        QNT
        <select
          value={quantization}
          onChange={onQuantizationChange}
          className="px-2 py-1 text-sm font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60 cursor-pointer"
          title="Launch quantization grid (takes effect on next Play)"
        >
          {QUANTIZATION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value} className="bg-black">
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="w-px h-5 bg-border/30 mx-1" />

      <span className="text-sm font-mono text-muted-foreground/50 tracking-wider">
        STEP {(currentStep + 1).toString().padStart(2, '0')} / {totalSteps}
      </span>
    </div>
  );
}

export const Transport = memo(TransportImpl);
