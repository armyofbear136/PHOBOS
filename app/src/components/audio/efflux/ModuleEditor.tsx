/**
 * ModuleEditor.tsx — Per-instrument module chain editor.
 *
 * Four sections, each with an enable toggle and parameter sliders:
 *   • EQ         — lowGain / midGain / highGain (peaking EQ, post-voice-sum)
 *   • Overdrive  — drive / color / preBand / postCut (soft-clip waveshaper)
 *   • Filter     — frequency / Q / type / LFO speed / LFO depth (BiquadFilter + LFO)
 *   • Delay      — time / feedback / cutoff / offset / dry (stereo delay with LPF in feedback loop)
 *
 * All mutations are in-place on `instrument.eq` / `.overdrive` / `.filter` /
 * `.delay`, followed by `bumpSongVersion()` and `AudioService.applyModule()`
 * so the audio graph picks up changes on the next schedule boundary.
 *
 * Not re-routing on every keystroke — `applyModule` is debounced at the
 * AudioService level (Phase 2c.2 keeps the coarse per-instrument apply;
 * fine-grained param deltas land in a future optimization pass).
 */

import { memo, useCallback } from 'react';
import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import AudioService        from '@/components/audio/engine/services/audio-service';
import { useSongStore }    from '@/store/daw/useSongStore';
import { useInstrumentStore } from '@/store/daw/useInstrumentStore';
import { SliderRow }       from './SliderRow';

// Filter types exposed by the underlying BiquadFilterNode — a subset of
// the full WebAudio set that makes musical sense in a synth context.
const FILTER_TYPES: BiquadFilterType[] = [
  'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass',
];

const LFO_TYPES: Array<'off' | OscillatorType> = [
  'off', 'sine', 'square', 'sawtooth', 'triangle',
];

// ── Enable-toggle strip (shared header for each fieldset) ───────────────────

function EnableToggle({
  label, enabled, onToggle, color = 'green',
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  color?: 'green' | 'amber' | 'blue';
}) {
  const onCls =
    color === 'green' ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10' :
    color === 'amber' ? 'border-phobos-amber/60 text-phobos-amber bg-phobos-amber/10' :
                        'border-blue-500/60 text-blue-400 bg-blue-500/10';
  const offCls = 'border-border/30 text-muted-foreground/50 hover:text-foreground';
  return (
    <div className="flex items-center justify-between mb-2">
      <legend className="px-1 text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest">
        {label}
      </legend>
      <button
        onClick={onToggle}
        className={`px-2 py-0.5 text-[8px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all ${enabled ? onCls : offCls}`}
      >
        {enabled ? 'On' : 'Off'}
      </button>
    </div>
  );
}

// ── Main editor ─────────────────────────────────────────────────────────────

interface ModuleEditorProps {
  instrument: Instrument;
}

function ModuleEditorImpl({ instrument }: ModuleEditorProps) {
  const _songVersion = useSongStore((s) => s.songVersion);              // eslint-disable-line @typescript-eslint/no-unused-vars
  const instrumentIdx = useInstrumentStore((s) => s.editingInstrumentIdx);
  const bump = useSongStore((s) => s.bumpSongVersion);

  // Re-apply the module graph after any module-scope mutation. Coarse but
  // correct — the handful of params we touch here fire at most on slider
  // drag rate, which is well within AudioService's handling envelope.
  const commit = useCallback(() => {
    bump();
    AudioService.applyModule('module', instrumentIdx, null);
  }, [bump, instrumentIdx]);

  // ── EQ ──
  const toggleEq = useCallback(() => { instrument.eq.enabled = !instrument.eq.enabled; commit(); }, [instrument, commit]);

  // ── Overdrive (lazy-create if missing — ported instruments sometimes lack it) ──
  const ensureOverdrive = useCallback(() => {
    if (!instrument.overdrive) {
      instrument.overdrive = { enabled: false, preBand: 0.5, postCut: 8000, color: 8000, drive: 0.5 };
    }
    return instrument.overdrive;
  }, [instrument]);
  const toggleOverdrive = useCallback(() => {
    const od = ensureOverdrive();
    od.enabled = !od.enabled;
    commit();
  }, [ensureOverdrive, commit]);

  // ── Filter ──
  const toggleFilter = useCallback(() => { instrument.filter.enabled = !instrument.filter.enabled; commit(); }, [instrument, commit]);

  // ── Delay ──
  const toggleDelay  = useCallback(() => { instrument.delay.enabled  = !instrument.delay.enabled;  commit(); }, [instrument, commit]);

  const overdrive = ensureOverdrive();

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* ── EQ ───────────────────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <EnableToggle label="EQ" enabled={instrument.eq.enabled} onToggle={toggleEq} color="green" />
        <SliderRow
          label="Low Gain"  min={0} max={4} step={0.01} value={instrument.eq.lowGain}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => { instrument.eq.lowGain  = v; commit(); }}
          disabled={!instrument.eq.enabled}
        />
        <SliderRow
          label="Mid Gain"  min={0} max={4} step={0.01} value={instrument.eq.midGain}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => { instrument.eq.midGain  = v; commit(); }}
          disabled={!instrument.eq.enabled}
        />
        <SliderRow
          label="High Gain" min={0} max={4} step={0.01} value={instrument.eq.highGain}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => { instrument.eq.highGain = v; commit(); }}
          disabled={!instrument.eq.enabled}
        />
      </fieldset>

      {/* ── Overdrive ────────────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <EnableToggle label="Overdrive" enabled={overdrive.enabled} onToggle={toggleOverdrive} color="amber" />
        <SliderRow
          label="Drive"    min={0} max={1} step={0.01} value={overdrive.drive}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => { overdrive.drive   = v; commit(); }}
          disabled={!overdrive.enabled}
          color="amber"
        />
        <SliderRow
          label="Color"    min={500} max={16000} step={50} value={overdrive.color} unit=" Hz"
          onChange={(v) => { overdrive.color   = v; commit(); }}
          disabled={!overdrive.enabled}
          color="amber"
        />
        <SliderRow
          label="Pre-Band" min={0} max={1} step={0.01} value={overdrive.preBand}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => { overdrive.preBand = v; commit(); }}
          disabled={!overdrive.enabled}
          color="amber"
        />
        <SliderRow
          label="Post-Cut" min={500} max={16000} step={50} value={overdrive.postCut} unit=" Hz"
          onChange={(v) => { overdrive.postCut = v; commit(); }}
          disabled={!overdrive.enabled}
          color="amber"
        />
      </fieldset>

      {/* ── Filter ───────────────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <EnableToggle label="Filter" enabled={instrument.filter.enabled} onToggle={toggleFilter} color="blue" />

        <div className="flex items-center gap-3 py-1.5">
          <span className="w-20 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
            Type
          </span>
          <select
            value={instrument.filter.type}
            onChange={(e) => { instrument.filter.type = e.target.value as BiquadFilterType; commit(); }}
            disabled={!instrument.filter.enabled}
            className="flex-1 px-2 py-1 text-[10px] font-mono bg-black/60 border border-border/30 rounded-sm text-blue-400/90 focus:outline-none focus:border-blue-500/60 disabled:opacity-40"
          >
            {FILTER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <SliderRow
          label="Frequency" min={20} max={20000} step={1} value={instrument.filter.frequency} unit=" Hz"
          onChange={(v) => { instrument.filter.frequency = v; commit(); }}
          disabled={!instrument.filter.enabled}
          color="blue"
        />
        <SliderRow
          label="Q"         min={0} max={40} step={0.1} value={instrument.filter.q}
          format={(v) => v.toFixed(1)}
          onChange={(v) => { instrument.filter.q = v; commit(); }}
          disabled={!instrument.filter.enabled}
          color="blue"
        />

        <div className="flex items-center gap-3 py-1.5">
          <span className="w-20 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
            LFO Type
          </span>
          <select
            value={instrument.filter.lfoType}
            onChange={(e) => { instrument.filter.lfoType = e.target.value as OscillatorType | 'off'; commit(); }}
            disabled={!instrument.filter.enabled}
            className="flex-1 px-2 py-1 text-[10px] font-mono bg-black/60 border border-border/30 rounded-sm text-blue-400/90 focus:outline-none focus:border-blue-500/60 disabled:opacity-40"
          >
            {LFO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <SliderRow
          label="LFO Speed" min={0.01} max={20} step={0.01} value={instrument.filter.speed} unit=" Hz"
          format={(v) => v.toFixed(2)}
          onChange={(v) => { instrument.filter.speed = v; commit(); }}
          disabled={!instrument.filter.enabled || instrument.filter.lfoType === 'off'}
          color="blue"
        />
        <SliderRow
          label="LFO Depth" min={0} max={1} step={0.01} value={instrument.filter.depth}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => { instrument.filter.depth = v; commit(); }}
          disabled={!instrument.filter.enabled || instrument.filter.lfoType === 'off'}
          color="blue"
        />
      </fieldset>

      {/* ── Delay ────────────────────────────────────────────────────── */}
      <fieldset className="border border-border/20 rounded-sm px-3 py-2">
        <EnableToggle label="Delay" enabled={instrument.delay.enabled} onToggle={toggleDelay} color="green" />
        <SliderRow
          label="Time"     min={0} max={2} step={0.001} value={instrument.delay.time}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => { instrument.delay.time = v; commit(); }}
          disabled={!instrument.delay.enabled}
        />
        <SliderRow
          label="Feedback" min={0} max={0.95} step={0.01} value={instrument.delay.feedback}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => { instrument.delay.feedback = v; commit(); }}
          disabled={!instrument.delay.enabled}
        />
        <SliderRow
          label="Cutoff"   min={100} max={20000} step={10} value={instrument.delay.cutoff} unit=" Hz"
          onChange={(v) => { instrument.delay.cutoff = v; commit(); }}
          disabled={!instrument.delay.enabled}
        />
        <SliderRow
          label="Offset"   min={-0.5} max={0.5} step={0.01} value={instrument.delay.offset}
          format={(v) => `${(v * 1000).toFixed(0)}ms`}
          onChange={(v) => { instrument.delay.offset = v; commit(); }}
          disabled={!instrument.delay.enabled}
        />
        <SliderRow
          label="Dry"      min={0} max={1} step={0.01} value={instrument.delay.dry}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => { instrument.delay.dry = v; commit(); }}
          disabled={!instrument.delay.enabled}
        />
      </fieldset>
    </div>
  );
}

export const ModuleEditor = memo(ModuleEditorImpl);
