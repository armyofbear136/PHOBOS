/**
 * SampleEditor.tsx — Per-instrument sample management.
 *
 * Upload a WAV / MP3 / FLAC → decodeAudioData → cache via useSampleStore.
 * Assign the cached sample to the current oscillator (sets osc.waveform =
 * SAMPLE and osc.sample = sample.id).
 *
 * Controls:
 *   • File upload (drop or click)
 *   • Waveform preview canvas (static — reads buffer.getChannelData(0))
 *   • Trim start/end sliders
 *   • Loop toggle
 *   • Pitch root note selector (determines playbackRate for pitch-shift)
 *   • Per-sample delete
 *
 * Samples persist in `useSampleStore`'s cache for the app's lifetime. They
 * are NOT yet serialized into the XTK song file — that lands in Phase 3
 * with the session model.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import type { Sample } from '@/components/audio/engine/model/types/sample';
import { PlaybackType } from '@/components/audio/engine/model/types/sample';
import OscillatorTypes from '@/components/audio/engine/definitions/oscillator-types';
import { loadSample } from '@/components/audio/engine/services/audio/sample-loader';
import AudioService from '@/components/audio/engine/services/audio-service';
import Pitch       from '@/components/audio/engine/services/audio/pitch';
import { useSongStore }   from '@/store/daw/useSongStore';
import { useSampleStore } from '@/store/daw/useSampleStore';
import { useInstrumentStore } from '@/store/daw/useInstrumentStore';
import { SliderRow } from './SliderRow';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ── Waveform preview canvas ────────────────────────────────────────────────

function WaveformPreview({ buffer, width, height }: { buffer: AudioBuffer; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.scale(dpr, dpr);

    ctx2d.clearRect(0, 0, width, height);

    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / width));
    const midY = height / 2;

    // Peak-aggregated rendering — max abs per column pixel.
    ctx2d.strokeStyle = '#22c55e';
    ctx2d.lineWidth   = 1;
    ctx2d.beginPath();
    for (let x = 0; x < width; x++) {
      let max = 0;
      const offset = x * step;
      for (let i = 0; i < step; i++) {
        const s = Math.abs(data[offset + i] ?? 0);
        if (s > max) max = s;
      }
      const y = max * midY;
      ctx2d.moveTo(x, midY - y);
      ctx2d.lineTo(x, midY + y);
    }
    ctx2d.stroke();

    // Centre line
    ctx2d.strokeStyle = 'rgba(34, 197, 94, 0.15)';
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY);
    ctx2d.lineTo(width, midY);
    ctx2d.stroke();
  }, [buffer, width, height]);

  return <canvas ref={canvasRef} style={{ width, height, display: 'block' }} />;
}

// ── Editor ─────────────────────────────────────────────────────────────────

interface SampleEditorProps {
  instrument: Instrument;
}

function SampleEditorImpl({ instrument }: SampleEditorProps) {
  const slot = useInstrumentStore((s) => s.activeOscillatorIdx);
  const osc  = instrument.oscillators[slot];
  const bump = useSongStore((s) => s.bumpSongVersion);

  const _version = useSampleStore((s) => s.version);                  // eslint-disable-line @typescript-eslint/no-unused-vars
  const cacheSample  = useSampleStore((s) => s.cacheSample);
  const updateSample = useSampleStore((s) => s.updateSample);
  const removeSample = useSampleStore((s) => s.removeSample);
  const getAllSamples = useSampleStore((s) => s.getAllSamples);

  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const allSamples = getAllSamples();
  const activeEntry = osc.sample ? allSamples.find((e) => e.sample.id === osc.sample || e.sample.name === osc.sample) : null;
  const activeSample = activeEntry?.sample;
  const activeBuffer = activeEntry?.buffer ?? null;

  // ── Upload ──
  const onFile = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const ctx = AudioService.getAudioContext();
      if (!ctx) throw new Error('AudioContext not initialized — press Play first');
      const buffer = await loadSample(file, ctx);
      if (!buffer) throw new Error('Failed to decode sample');

      const id = `${file.name}-${Date.now()}`;
      const sample: Sample = {
        id,
        name:       file.name,
        source:     file,
        buffer,
        rate:       buffer.sampleRate,
        duration:   buffer.duration,
        rangeStart: 0,
        rangeEnd:   buffer.duration,
        loop:       true,
        pitch:      null,
        slices:     [],
        type:       PlaybackType.DEFAULT,
        optimized:  false,
      };
      cacheSample(sample, buffer);

      // Assign to the current oscillator.
      osc.sample   = id;
      osc.waveform = OscillatorTypes.SAMPLE;
      bump();
      AudioService.updateOscillator('waveform', instrument, slot, osc);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }, [cacheSample, osc, bump, instrument, slot]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = '';                                   // allow re-uploading same filename
  }, [onFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }, [onFile]);

  // ── Assign an already-cached sample to the current osc ──
  const assignSample = useCallback((sampleId: string) => {
    osc.sample   = sampleId;
    osc.waveform = OscillatorTypes.SAMPLE;
    bump();
    AudioService.updateOscillator('waveform', instrument, slot, osc);
  }, [osc, bump, instrument, slot]);

  const clearSample = useCallback(() => {
    osc.sample   = '';
    osc.waveform = OscillatorTypes.SAW;                    // revert to default
    bump();
    AudioService.updateOscillator('waveform', instrument, slot, osc);
  }, [osc, bump, instrument, slot]);

  // ── Active sample mutations ──
  const mutateActive = useCallback((patch: Partial<Sample>) => {
    if (!activeSample) return;
    updateSample(activeSample.id, patch);
  }, [activeSample, updateSample]);

  const setPitchRoot = useCallback((note: string, octave: number) => {
    if (!activeSample) return;
    const frequency = Pitch.getFrequency(note, octave);
    mutateActive({ pitch: { frequency, note, octave, cents: 0 } });
  }, [activeSample, mutateActive]);

  // ── Render ──
  return (
    <div className="p-4 flex flex-col gap-4">
      {/* ── Upload zone ─────────────────────────────────────────────── */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border border-dashed border-border/30 rounded-sm px-4 py-6 flex flex-col items-center gap-2 hover:border-phobos-green/40 transition-colors"
      >
        <Upload className="w-4 h-4 text-muted-foreground/40" />
        <label className="cursor-pointer">
          <input type="file" accept="audio/*" onChange={onFileInput} className="hidden" />
          <span className="text-[10px] font-terminal text-phobos-green/60 uppercase tracking-[0.15em] hover:text-phobos-green">
            {uploading ? 'Decoding…' : 'Drop audio file or click to upload'}
          </span>
        </label>
        <span className="text-[8px] font-mono text-muted-foreground/40">
          WAV · MP3 · FLAC · OGG
        </span>
        {error && (
          <span className="text-[9px] font-mono text-destructive/80 mt-1">{error}</span>
        )}
      </div>

      {/* ── Available samples ───────────────────────────────────────── */}
      {allSamples.length > 0 && (
        <fieldset className="border border-border/20 rounded-sm px-3 py-2">
          <legend className="px-1 text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest">
            Library
          </legend>
          <div className="flex flex-col gap-1 max-h-32 overflow-y-auto scrollbar-thin">
            {allSamples.map((entry) => {
              const isActive = osc.sample === entry.sample.id;
              return (
                <div
                  key={entry.sample.id}
                  className={`flex items-center gap-2 px-2 py-1 rounded-sm border transition-colors ${
                    isActive
                      ? 'border-phobos-green/60 bg-phobos-green/10'
                      : 'border-border/20 hover:border-border/50 hover:bg-black/40'
                  }`}
                >
                  <button
                    onClick={() => assignSample(entry.sample.id)}
                    className={`flex-1 text-left text-[10px] font-mono truncate ${
                      isActive ? 'text-phobos-green/90' : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                    title={entry.sample.name}
                  >
                    {entry.sample.name}
                  </button>
                  <span className="text-[8px] font-mono text-muted-foreground/40 shrink-0">
                    {entry.sample.duration.toFixed(2)}s
                  </span>
                  <button
                    onClick={() => {
                      if (isActive) clearSample();
                      removeSample(entry.sample.id);
                    }}
                    className="p-0.5 text-muted-foreground/40 hover:text-destructive transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="w-2.5 h-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      {/* ── Active sample editor ────────────────────────────────────── */}
      {activeSample && activeBuffer && (
        <fieldset className="border border-border/20 rounded-sm px-3 py-2">
          <legend className="px-1 text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest">
            {activeSample.name}
          </legend>

          <div className="border border-border/10 rounded-sm bg-black/60 my-2">
            <WaveformPreview buffer={activeBuffer} width={660} height={80} />
          </div>

          <SliderRow
            label="Trim In"
            min={0} max={activeBuffer.duration} step={0.001}
            value={activeSample.rangeStart}
            format={(v) => `${v.toFixed(3)}s`}
            onChange={(v) => mutateActive({ rangeStart: Math.min(v, activeSample.rangeEnd - 0.01) })}
          />
          <SliderRow
            label="Trim Out"
            min={0} max={activeBuffer.duration} step={0.001}
            value={activeSample.rangeEnd}
            format={(v) => `${v.toFixed(3)}s`}
            onChange={(v) => mutateActive({ rangeEnd: Math.max(v, activeSample.rangeStart + 0.01) })}
          />

          <label className="flex items-center gap-3 py-1.5">
            <span className="w-20 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
              Loop
            </span>
            <button
              onClick={() => mutateActive({ loop: !activeSample.loop })}
              className={`px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all ${
                activeSample.loop
                  ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10'
                  : 'border-border/30 text-muted-foreground/50 hover:text-foreground'
              }`}
            >
              {activeSample.loop ? 'Looping' : 'One-shot'}
            </button>
          </label>

          <div className="flex items-center gap-3 py-1.5">
            <span className="w-20 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
              Pitch Root
            </span>
            <select
              value={activeSample.pitch?.note ?? 'none'}
              onChange={(e) => {
                if (e.target.value === 'none') {
                  mutateActive({ pitch: null });
                } else {
                  setPitchRoot(e.target.value, activeSample.pitch?.octave ?? 4);
                }
              }}
              className="px-2 py-1 text-[10px] font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-amber/90 focus:outline-none focus:border-phobos-amber/60"
            >
              <option value="none">none (natural)</option>
              {NOTE_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select
              value={activeSample.pitch?.octave ?? 4}
              onChange={(e) => {
                if (!activeSample.pitch) return;
                setPitchRoot(activeSample.pitch.note, Number(e.target.value));
              }}
              disabled={!activeSample.pitch}
              className="px-2 py-1 text-[10px] font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-amber/90 focus:outline-none focus:border-phobos-amber/60 disabled:opacity-40"
            >
              {[1, 2, 3, 4, 5, 6, 7].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {activeSample.pitch && (
              <span className="text-[9px] font-mono text-phobos-amber/50">
                {activeSample.pitch.frequency.toFixed(1)} Hz
              </span>
            )}
          </div>
        </fieldset>
      )}

      {!activeSample && (
        <div className="text-center text-[10px] font-terminal text-muted-foreground/40 uppercase tracking-widest py-4">
          No sample assigned — upload one or pick from the library
        </div>
      )}
    </div>
  );
}

export const SampleEditor = memo(SampleEditorImpl);
