/**
 * OscillatorEditor.tsx — Per-oscillator controls for the active instrument.
 *
 * Each instrument has N oscillators (Config.OSCILLATOR_AMOUNT = 3). The user
 * selects one via the slot selector at top, then edits its properties:
 *   • enabled toggle
 *   • waveform (SAW / SINE / TRIANGLE / SQUARE / PWM / NOISE / CUSTOM / SAMPLE)
 *   • volume (0..1)
 *   • detune cents (-50..+50)
 *   • octave shift (-2..+2)
 *   • fine shift semitones (-7..+7)
 *   • ADSR envelope (4 sliders: attack, decay, sustain, release)
 *   • pitch envelope (range, attack, decay, sustain, release)
 *
 * Philosophy: all mutations in-place on `instrument.oscillators[slot]`.
 * Bump songVersion once per write. Call AudioService.updateOscillator so the
 * engine re-caches custom tables when CUSTOM waveform is set.
 */

import { memo, useCallback } from 'react';
import OscillatorTypes from '@/components/audio/engine/definitions/oscillator-types';
import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import AudioService       from '@/components/audio/engine/services/audio-service';
import { useSongStore }   from '@/store/daw/useSongStore';
import { useInstrumentStore } from '@/store/daw/useInstrumentStore';
import { SliderRow }      from './SliderRow';

const WAVEFORMS: OscillatorTypes[] = [
  OscillatorTypes.SAW,
  OscillatorTypes.SINE,
  OscillatorTypes.TRIANGLE,
  OscillatorTypes.SQUARE,
  OscillatorTypes.PWM,
  OscillatorTypes.NOISE,
  OscillatorTypes.CUSTOM,
  OscillatorTypes.SAMPLE,
];

// ── Editor ──────────────────────────────────────────────────────────────────

interface OscillatorEditorProps {
  instrument: Instrument;
}

function OscillatorEditorImpl({ instrument }: OscillatorEditorProps) {
  const slot          = useInstrumentStore((s) => s.activeOscillatorIdx);
  const setSlot       = useInstrumentStore((s) => s.setActiveOscillator);
  const _songVersion  = useSongStore((s) => s.songVersion);              // eslint-disable-line @typescript-eslint/no-unused-vars

  const osc = instrument.oscillators[slot];
  const bump = useSongStore((s) => s.bumpSongVersion);

  const onEnabledToggle = useCallback(() => {
    osc.enabled = !osc.enabled;
    bump();
  }, [osc, bump]);

  const onWaveformChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    osc.waveform = e.target.value as OscillatorTypes;
    bump();
    AudioService.updateOscillator('waveform', instrument, slot, osc);
  }, [osc, instrument, slot, bump]);

  const mutate = useCallback((fn: () => void) => { fn(); bump(); }, [bump]);

  // Ensure pitch envelope object exists before user touches a pitch slider.
  const ensurePitch = useCallback(() => {
    if (!osc.pitch) {
      osc.pitch = { range: 0, attack: 0, decay: 0, sustain: 0.75, release: 0 };
    }
    return osc.pitch;
  }, [osc]);

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* ── Slot selector ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-terminal text-muted-foreground/60 uppercase tracking-[0.12em]">
          Oscillator
        </span>
        {instrument.oscillators.map((_, i) => {
          const isActive = i === slot;
          const isEnabled = instrument.oscillators[i].enabled;
          const cls = isActive
            ? 'border-phobos-green/70 text-phobos-green bg-phobos-green/10'
            : isEnabled
              ? 'border-border/50 text-phobos-green/50 hover:border-phobos-green/40'
              : 'border-border/30 text-muted-foreground/40 hover:border-border/60';
          return (
            <button
              key={i}
              onClick={() => setSlot(i)}
              className={`w-8 h-7 text-[10px] font-mono rounded-sm border transition-colors ${cls}`}
            >
              {i + 1}
            </button>
          );
        })}

        <div className="w-px h-4 bg-border/30 mx-1" />

        <button
          onClick={onEnabledToggle}
          className={`px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all ${
            osc.enabled
              ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10'
              : 'border-border/30 text-muted-foreground/50 hover:text-foreground'
          }`}
        >
          {osc.enabled ? 'Enabled' : 'Disabled'}
        </button>

        <div className="flex-1" />

        <label className="flex items-center gap-2 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
          Waveform
          <select
            value={osc.waveform}
            onChange={onWaveformChange}
            className="px-2 py-1 text-[10px] font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
          >
            {WAVEFORMS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Tuning block ─────────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <legend className="px-1 text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest">Tuning</legend>
        <SliderRow
          label="Volume"  min={0} max={1} step={0.01} value={osc.volume}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => mutate(() => { osc.volume = v; })}
        />
        <SliderRow
          label="Detune"  min={-50} max={50} step={1} value={osc.detune} unit=" ct"
          onChange={(v) => mutate(() => { osc.detune = v; })}
        />
        <SliderRow
          label="Octave"  min={-2} max={2} step={1} value={osc.octaveShift} unit=" oct"
          onChange={(v) => mutate(() => { osc.octaveShift = v; })}
          color="amber"
        />
        <SliderRow
          label="Fine"    min={-7} max={7} step={1} value={osc.fineShift} unit=" st"
          onChange={(v) => mutate(() => { osc.fineShift = v; })}
          color="amber"
        />
      </fieldset>

      {/* ── Amplitude envelope ───────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <legend className="px-1 text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest">Amp Envelope (ADSR)</legend>
        <SliderRow
          label="Attack"  min={0}  max={2}  step={0.001} value={osc.adsr.attack}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { osc.adsr.attack = v; })}
        />
        <SliderRow
          label="Decay"   min={0}  max={2}  step={0.001} value={osc.adsr.decay}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { osc.adsr.decay = v; })}
        />
        <SliderRow
          label="Sustain" min={0}  max={1}  step={0.01} value={osc.adsr.sustain}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => mutate(() => { osc.adsr.sustain = v; })}
        />
        <SliderRow
          label="Release" min={0}  max={3}  step={0.001} value={osc.adsr.release}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { osc.adsr.release = v; })}
        />
      </fieldset>

      {/* ── Pitch envelope ───────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <legend className="px-1 text-[9px] font-terminal text-phobos-amber/50 uppercase tracking-widest">Pitch Envelope</legend>
        <SliderRow
          label="Range"   min={-24} max={24} step={1}
          value={osc.pitch?.range ?? 0} unit=" st"
          onChange={(v) => mutate(() => { ensurePitch().range = v; })}
          color="amber"
        />
        <SliderRow
          label="Attack"  min={0} max={2} step={0.001}
          value={osc.pitch?.attack ?? 0}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { ensurePitch().attack = v; })}
          color="amber"
        />
        <SliderRow
          label="Decay"   min={0} max={2} step={0.001}
          value={osc.pitch?.decay ?? 0}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { ensurePitch().decay = v; })}
          color="amber"
        />
        <SliderRow
          label="Sustain" min={0} max={1} step={0.01}
          value={osc.pitch?.sustain ?? 0.75}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => mutate(() => { ensurePitch().sustain = v; })}
          color="amber"
        />
        <SliderRow
          label="Release" min={0} max={3} step={0.001}
          value={osc.pitch?.release ?? 0}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => mutate(() => { ensurePitch().release = v; })}
          color="amber"
        />
      </fieldset>
    </div>
  );
}

export const OscillatorEditor = memo(OscillatorEditorImpl);
