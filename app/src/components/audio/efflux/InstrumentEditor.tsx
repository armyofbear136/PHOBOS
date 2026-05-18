/**
 * InstrumentEditor.tsx — Container for the per-instrument editor.
 *
 * Opened via ChannelHeader double-click or Ctrl+E. Shows:
 *   • Header — instrument name (editable), volume slider, pan slider
 *   • Subtab selector — Oscillators / Modules / Sample (Sample is Phase 2c.1 stub)
 *   • Active subtab body mounts here (OscillatorEditor in Phase 2c.1)
 *
 * All mutations go in-place against `song.instruments[idx]` with
 * `bumpSongVersion()` after. AudioService's volume/pan setters are called
 * alongside for real-time audible feedback.
 */

import { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import AudioService          from '@/components/audio/engine/services/audio-service';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useInstrumentStore, type InstrumentSubtab } from '@/store/daw/useInstrumentStore';
import { OscillatorEditor }  from './OscillatorEditor';
import { ModuleEditor }      from './ModuleEditor';
import { SampleEditor }      from './SampleEditor';
import { WaveformDisplay }   from './WaveformDisplay';

// ── Styles (shared with other editor widgets) ───────────────────────────────
const BTN_BASE  = 'px-2.5 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all';
const BTN_IDLE  = `${BTN_BASE} border-border/30 text-muted-foreground/50 hover:text-foreground hover:border-border/60`;
const BTN_ACTIVE_GREEN = `${BTN_BASE} border-phobos-green/60 text-phobos-green bg-phobos-green/10`;

function InstrumentEditorImpl() {
  const open           = useInstrumentStore((s) => s.editorOpen);
  const close          = useInstrumentStore((s) => s.closeEditor);
  const instrumentIdx  = useInstrumentStore((s) => s.editingInstrumentIdx);
  const subtab         = useInstrumentStore((s) => s.subtab);
  const setSubtab      = useInstrumentStore((s) => s.setSubtab);
  const _songVersion   = useSongStore((s) => s.songVersion);              // eslint-disable-line @typescript-eslint/no-unused-vars
  const song           = useSongStore((s) => s.activeSong);

  const instrument = song?.instruments[instrumentIdx] ?? null;

  const onNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!instrument) return;
    instrument.name = e.target.value;                         // in-place
    useSongStore.getState().bumpSongVersion();
  }, [instrument]);

  const onVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!instrument) return;
    const v = Number(e.target.value);
    instrument.volume = v;                                    // in-place
    AudioService.adjustInstrumentVolume(instrumentIdx, v);
    useSongStore.getState().bumpSongVersion();
  }, [instrument, instrumentIdx]);

  const onPanChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!instrument) return;
    const v = Number(e.target.value);
    instrument.panning = v;                                   // in-place
    AudioService.adjustInstrumentPanning(instrumentIdx, v);
    useSongStore.getState().bumpSongVersion();
  }, [instrument, instrumentIdx]);

  if (!open || !instrument) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[720px] max-w-[95vw] max-h-[90vh] bg-background border border-phobos-green/30 rounded-sm shadow-2xl flex flex-col"
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-border/30 shrink-0">
          <div className="text-[8px] font-mono text-phobos-green/40 uppercase tracking-widest w-10">
            INS {instrumentIdx.toString().padStart(2, '0')}
          </div>

          <input
            value={instrument.name}
            onChange={onNameChange}
            className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
            placeholder="Instrument name"
          />

          <label className="flex items-center gap-1.5 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
            Vol
            <input
              type="range"
              min={0} max={1} step={0.01}
              value={instrument.volume}
              onChange={onVolumeChange}
              className="w-20 accent-phobos-green"
            />
            <span className="w-8 text-right text-phobos-green/70 font-mono">
              {Math.round(instrument.volume * 100)}
            </span>
          </label>

          <label className="flex items-center gap-1.5 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
            Pan
            <input
              type="range"
              min={-1} max={1} step={0.01}
              value={instrument.panning}
              onChange={onPanChange}
              className="w-20 accent-phobos-amber"
            />
            <span className="w-8 text-right text-phobos-amber/70 font-mono">
              {instrument.panning === 0 ? 'C' : instrument.panning > 0 ? `R${Math.round(instrument.panning * 100)}` : `L${Math.round(-instrument.panning * 100)}`}
            </span>
          </label>

          <button
            onClick={close}
            className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Waveform display ─────────────────────────────────────────── */}
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className="border border-border/20 rounded-sm bg-black/60">
            <WaveformDisplay
              analyserIndex={instrumentIdx + 1}
              width={688}
              height={64}
              color="#22c55e"
            />
          </div>
        </div>

        {/* ── Subtabs ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 shrink-0">
          {(['oscillator', 'module', 'sample'] as InstrumentSubtab[]).map((t) => (
            <button
              key={t}
              onClick={() => setSubtab(t)}
              className={subtab === t ? BTN_ACTIVE_GREEN : BTN_IDLE}
            >
              {t === 'oscillator' ? 'Oscillators' : t === 'module' ? 'Modules' : 'Sample'}
            </button>
          ))}
        </div>

        {/* ── Subtab body ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {subtab === 'oscillator' && <OscillatorEditor instrument={instrument} />}
          {subtab === 'module' && <ModuleEditor instrument={instrument} />}
          {subtab === 'sample' && <SampleEditor instrument={instrument} />}
        </div>
      </div>
    </div>
  );
}

export const InstrumentEditor = memo(InstrumentEditorImpl);
