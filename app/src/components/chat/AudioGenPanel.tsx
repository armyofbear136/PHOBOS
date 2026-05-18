/**
 * AudioGenPanel.tsx — Music generation and voice cloning workflow panel.
 *
 * Fixed 280px height, sits in the same bottom slot as WorkflowPanel (mutual
 * exclusion enforced by useAudioGenStore.openPanel calling useWorkflowStore.closePanel).
 *
 * Three-column layout mirrors WorkflowPanel exactly:
 *   LEFT   — tab selector (MUSIC / VOICE CLONE) + RTF estimate
 *   CENTER — params for active tab + generate/abort action row + lockout overlay
 *   RIGHT  — waveform preview + play/pause + export
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Play, Pause, Loader2, Music, Mic, Upload, AlertTriangle,
  CheckCircle, Download, Shuffle,
} from 'lucide-react';
import { useAudioGenStore }         from '@/store/useAudioGenStore';
import { useAppStore }              from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const PANEL_H    = 280; // px — matches WorkflowPanel

// Chunk size for base64 encoding — avoids call-stack overflow on large files
const B64_CHUNK  = 8192;

// ── Dep / model status (fetched once on panel mount) ─────────────────────────

interface DepStatus {
  kokoro:      boolean;
  whisper:     boolean;
  aceStep:     boolean;  // true if either CPU or GPU route is ready
  aceStepGpu:  boolean;  // true if Python GPU route is ready
  aceStepCpu:  boolean;  // true if C++ CPU route is ready
}

interface ModelStatus {
  whisperLargeV3: boolean;
  aceStepModels:  boolean;
  f5tts:          boolean;
}

// ── Waveform canvas ───────────────────────────────────────────────────────────
// Draws amplitude bars from a Float32Array. Called once when output is decoded;
// the canvas ref is reused on subsequent renders.

function drawWaveform(canvas: HTMLCanvasElement, data: Float32Array): void {
  const ctx  = canvas.getContext('2d');
  if (!ctx) return;
  const W    = canvas.width;
  const H    = canvas.height;
  const bars = Math.min(W, 200);           // never more than one bar per pixel

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.45)';   // phobos-green tint

  const step    = Math.floor(data.length / bars);
  const barW    = W / bars;
  const midY    = H / 2;

  for (let i = 0; i < bars; i++) {
    // RMS of chunk — more perceptually accurate than peak
    let sum = 0;
    const base = i * step;
    for (let j = 0; j < step; j++) { const v = data[base + j] ?? 0; sum += v * v; }
    const rms  = Math.sqrt(sum / step);
    const barH = Math.max(1, rms * H * 2.4);
    ctx.fillRect(i * barW, midY - barH / 2, Math.max(1, barW - 1), barH);
  }
}

// ── WaveformCanvas — thin wrapper so the canvas ref lifecycle is isolated ─────

function WaveformCanvas({
  waveform,
  accent = 'green',
}: {
  waveform: Float32Array;
  accent?: 'green' | 'cyan';
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || waveform.length === 0) return;
    // Override accent colour before drawing
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const color = accent === 'cyan'
        ? 'rgba(34, 211, 238, 0.40)'
        : 'rgba(34, 197, 94, 0.45)';
      ctx.fillStyle = color;
    }
    drawWaveform(canvas, waveform);
  }, [waveform, accent]);

  return (
    <canvas
      ref={canvasRef}
      width={208}
      height={60}
      className="w-full rounded"
      style={{ background: 'rgba(0,0,0,0.4)' }}
    />
  );
}

// ── AudioPreviewPane ──────────────────────────────────────────────────────────

function AudioPreviewPane({
  outputPath,
  waveform,
  refWaveform,
  elapsedMs,
  category,
  onExport,
  generating,
  progress,
}: {
  outputPath:   string | null;
  waveform:     Float32Array | null;
  refWaveform:  Float32Array | null;
  elapsedMs:    number;
  category:     'music' | 'tts';
  onExport:     () => void;
  generating:   boolean;
  progress:     { phase: string; pct: number; message?: string } | null;
}) {
  const [playing,     setPlaying]     = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  const ctxRef    = useRef<AudioContext | null>(null);
  const srcRef    = useRef<AudioBufferSourceNode | null>(null);
  const bufRef    = useRef<AudioBuffer | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const startAtRef = useRef<number>(0);   // ctx.currentTime when play started

  // Decode WAV whenever outputPath changes
  useEffect(() => {
    if (!outputPath) { bufRef.current = null; setDurationSec(0); return; }
    // Stop any current playback
    stopPlayback();
    // Fetch and decode
    fetch(`${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(outputPath)}`)
      .then(r => r.ok ? r.arrayBuffer() : null)
      .then(async (ab) => {
        if (!ab) return;
        if (!ctxRef.current) ctxRef.current = new AudioContext();
        const buf = await ctxRef.current.decodeAudioData(ab);
        bufRef.current = buf;
        setDurationSec(buf.duration);
        setPositionSec(0);
      })
      .catch(() => { /* best-effort */ });
  }, [outputPath]);

  function stopPlayback() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (srcRef.current) { try { srcRef.current.stop(); } catch { /* already stopped */ } srcRef.current = null; }
    setPlaying(false);
    setPositionSec(0);
  }

  const handlePlayPause = useCallback(() => {
    const buf = bufRef.current;
    const ctx = ctxRef.current ?? (ctxRef.current = new AudioContext());
    if (!buf) return;

    if (playing) {
      stopPlayback();
      return;
    }

    if (ctx.state === 'suspended') ctx.resume();

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      srcRef.current = null;
      setPlaying(false);
      setPositionSec(0);
    };
    src.start();
    srcRef.current     = src;
    startAtRef.current = ctx.currentTime;
    setPlaying(true);

    // Position ticker — runs every 250ms, no allocation (just numeric math)
    timerRef.current = setInterval(() => {
      setPositionSec(ctx.currentTime - startAtRef.current);
    }, 250);
  }, [playing]);

  // Cleanup on unmount
  useEffect(() => () => { stopPlayback(); }, []);

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  if (generating) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 px-2">
        <Loader2 className="w-5 h-5 text-cyan-400/50 animate-spin" />
        {progress && (
          <>
            <span className="text-[9px] font-terminal tracking-[0.12em] text-cyan-400/50 uppercase">
              {progress.phase === 'lm'        ? 'Language model'
               : progress.phase === 'synth'   ? 'Synthesis'
               : progress.phase === 'decode'  ? 'Audio decode'
               : progress.phase === 'transcribe' ? 'Transcribing ref…'
               : progress.phase === 'synthesize' ? 'Synthesizing…'
               : progress.message ?? 'Working…'}
            </span>
            <div className="w-full h-0.5 bg-muted/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-400/50 rounded-full transition-all duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
            <span className="text-[8px] font-mono text-muted-foreground/40">
              {progress.pct}%
            </span>
          </>
        )}
      </div>
    );
  }

  if (!outputPath || !waveform) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-2 select-none">
        <Music className="w-6 h-6 text-muted-foreground/15" />
        <span className="text-[10px] font-mono text-muted-foreground/40">No output yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-2 pt-1">
      {/* Ref audio waveform (clone mode only) */}
      {refWaveform && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[8px] font-terminal text-muted-foreground/30 uppercase tracking-[0.1em] px-0.5">
            Reference
          </span>
          <WaveformCanvas waveform={refWaveform} accent="cyan" />
        </div>
      )}

      {/* Output waveform */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[8px] font-terminal text-muted-foreground/30 uppercase tracking-[0.1em] px-0.5">
          Output
        </span>
        <WaveformCanvas waveform={waveform} accent="green" />
      </div>

      {/* Transport row */}
      <div className="flex items-center gap-2">
        <button
          onClick={handlePlayPause}
          className="flex items-center justify-center w-7 h-7 rounded-full border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 transition-all shrink-0"
        >
          {playing
            ? <Pause className="w-3 h-3" />
            : <Play  className="w-3 h-3" />}
        </button>
        <span className="text-[9px] font-mono text-muted-foreground/50 tabular-nums">
          {fmt(positionSec)} / {fmt(durationSec)}
        </span>
      </div>

      {/* Elapsed + export */}
      <div className="mt-auto flex items-center justify-between pt-1 border-t border-border/20">
        <span className="text-[8px] font-mono text-muted-foreground/30">
          {elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : ''}
        </span>
        <button
          onClick={onExport}
          className="flex items-center gap-1 px-2 py-1 text-[9px] font-terminal tracking-[0.1em] border border-border/30 text-ui-glow hover:text-phobos-green/70 hover:border-phobos-green/30 rounded-sm transition-all"
          title="Export to thread workspace"
        >
          <Download className="w-2.5 h-2.5" />
          EXPORT
        </button>
      </div>
    </div>
  );
}

// ── RTF estimate banner ───────────────────────────────────────────────────────

function RtfBanner({ durationSec, aceStepReady }: { durationSec: number; aceStepReady: boolean }) {
  if (!aceStepReady) return null;
  // ~40× real-time on CPU; GPU is ~1–3×. We show CPU estimate without GPU check
  // because we don't want to hide it when users have no GPU.
  const minEstimate = Math.ceil(durationSec * 40 / 60);
  return (
    <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-sm bg-yellow-500/8 border border-yellow-500/20 mx-2 mb-2">
      <AlertTriangle className="w-3 h-3 text-yellow-500/60 shrink-0 mt-0.5" />
      <span className="text-[9px] font-mono text-yellow-500/60 leading-tight">
        ~{minEstimate}min est. (CPU)
      </span>
    </div>
  );
}

// ── DepWarning — shown when a required binary isn't installed ─────────────────

function DepWarning({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-mono text-destructive/60 bg-destructive/8 border-b border-destructive/20">
      <AlertTriangle className="w-3 h-3 shrink-0" />
      {label} not installed — open System Settings → Audio to install
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function AudioGenPanel() {
  const panelOpen        = useAudioGenStore((s) => s.panelOpen);
  const activeTab        = useAudioGenStore((s) => s.activeTab);
  const generating       = useAudioGenStore((s) => s.generating);
  const progress         = useAudioGenStore((s) => s.progress);
  const lastOutput       = useAudioGenStore((s) => s.lastOutput);
  const closePanel       = useAudioGenStore((s) => s.closePanel);
  const setGenerating    = useAudioGenStore((s) => s.setGenerating);
  const setProgress      = useAudioGenStore((s) => s.setProgress);
  const setLastOutput    = useAudioGenStore((s) => s.setLastOutput);

  // Music params
  const musicPrompt      = useAudioGenStore((s) => s.musicPrompt);
  const musicLyrics      = useAudioGenStore((s) => s.musicLyrics);
  const musicDuration    = useAudioGenStore((s) => s.musicDuration);
  const musicSeed        = useAudioGenStore((s) => s.musicSeed);
  const musicSteps       = useAudioGenStore((s) => s.musicSteps);
  const musicCfg         = useAudioGenStore((s) => s.musicCfg);
  const musicBackend     = useAudioGenStore((s) => s.musicBackend);
  const setMusicPrompt   = useAudioGenStore((s) => s.setMusicPrompt);
  const setMusicLyrics   = useAudioGenStore((s) => s.setMusicLyrics);
  const setMusicDuration = useAudioGenStore((s) => s.setMusicDuration);
  const setMusicSeed     = useAudioGenStore((s) => s.setMusicSeed);
  const setMusicSteps    = useAudioGenStore((s) => s.setMusicSteps);
  const setMusicCfg      = useAudioGenStore((s) => s.setMusicCfg);
  const setMusicBackend  = useAudioGenStore((s) => s.setMusicBackend);

  // Clone params
  const cloneText        = useAudioGenStore((s) => s.cloneText);
  const cloneRefData     = useAudioGenStore((s) => s.cloneRefData);
  const cloneRefName     = useAudioGenStore((s) => s.cloneRefName);
  const cloneRefWaveform = useAudioGenStore((s) => s.cloneRefWaveform);
  const cloneRefText     = useAudioGenStore((s) => s.cloneRefText);
  const cloneSpeed       = useAudioGenStore((s) => s.cloneSpeed);
  const cloneSteps       = useAudioGenStore((s) => s.cloneSteps);
  const setCloneText     = useAudioGenStore((s) => s.setCloneText);
  const setCloneRef      = useAudioGenStore((s) => s.setCloneRef);
  const setCloneRefWaveform = useAudioGenStore((s) => s.setCloneRefWaveform);
  const clearCloneRef    = useAudioGenStore((s) => s.clearCloneRef);
  const setCloneRefText  = useAudioGenStore((s) => s.setCloneRefText);
  const setCloneSpeed    = useAudioGenStore((s) => s.setCloneSpeed);
  const setCloneSteps    = useAudioGenStore((s) => s.setCloneSteps);

  const activeThreadId   = useAppStore((s) => s.activeThreadId);

  // ── Local state ───────────────────────────────────────────────────────────
  const [showLyrics,    setShowLyrics]    = useState(false);
  const [showAdvanced,  setShowAdvanced]  = useState(false);
  const [depStatus,     setDepStatus]     = useState<DepStatus | null>(null);
  const [modelStatus,   setModelStatus]   = useState<ModelStatus | null>(null);
  const [dragOver,      setDragOver]      = useState(false);

  // AbortController for in-flight SSE fetch
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch dep/model status once on open ───────────────────────────────────
  useEffect(() => {
    if (!panelOpen) return;
    fetch(`${ENGINE_URL}/api/audio/dep-status`)
      .then(r => r.ok ? r.json() : null)
      .then((d: DepStatus | null) => { if (d) setDepStatus(d); })
      .catch(() => {});
    fetch(`${ENGINE_URL}/api/audio/model-status`)
      .then(r => r.ok ? r.json() : null)
      .then((d: ModelStatus | null) => { if (d) setModelStatus(d); })
      .catch(() => {});
  }, [panelOpen]);

  // ── Decode output WAV for waveform drawing whenever lastOutput changes ────
  const audioCtxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!lastOutput?.path) return;
    fetch(`${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(lastOutput.path)}`)
      .then(r => r.ok ? r.arrayBuffer() : null)
      .then(async (ab) => {
        if (!ab) return;
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
        const buf     = await audioCtxRef.current.decodeAudioData(ab);
        // Downmix to mono for the waveform — sum channels, divide by channel count
        const nCh     = buf.numberOfChannels;
        const len     = buf.length;
        const mono    = new Float32Array(len);
        for (let c = 0; c < nCh; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < len; i++) mono[i] += ch[i];
        }
        for (let i = 0; i < len; i++) mono[i] /= nCh;
        // lastOutput is guaranteed non-null here: the effect only runs when
        // lastOutput?.path changes and the fetch only proceeds if path exists.
        if (lastOutput) setLastOutput({ ...lastOutput, waveform: mono });
      })
      .catch(() => {});
  }, [lastOutput?.path]);

  // ── Decode ref audio for the secondary waveform in clone mode ────────────
  useEffect(() => {
    if (!cloneRefData) { setCloneRefWaveform(null); return; }
    (async () => {
      try {
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
        const bytes = Uint8Array.from(atob(cloneRefData), c => c.charCodeAt(0));
        const buf   = await audioCtxRef.current.decodeAudioData(bytes.buffer);
        const nCh   = buf.numberOfChannels;
        const len   = buf.length;
        const mono  = new Float32Array(len);
        for (let c = 0; c < nCh; c++) {
          const ch = buf.getChannelData(c);
          for (let i = 0; i < len; i++) mono[i] += ch[i];
        }
        for (let i = 0; i < len; i++) mono[i] /= nCh;
        setCloneRefWaveform(mono);
      } catch { /* best-effort */ }
    })();
  }, [cloneRefData]);

  // ── Reference audio file handler (clone mode) ─────────────────────────────
  const loadRefAudio = useCallback(async (file: File) => {
    const allowed = ['audio/wav', 'audio/wave', 'audio/mp3', 'audio/mpeg', 'audio/flac', 'audio/x-flac'];
    if (!allowed.includes(file.type) && !file.name.match(/\.(wav|mp3|flac)$/i)) return;
    const arrayBuf = await file.arrayBuffer();
    const bytes    = new Uint8Array(arrayBuf);
    let   binary   = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
    }
    setCloneRef(btoa(binary), file.name);
  }, [setCloneRef]);

  // ── Abort ─────────────────────────────────────────────────────────────────
  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setProgress(null);
  }, [setGenerating, setProgress]);

  // ── Generate music ────────────────────────────────────────────────────────
  const handleGenerateMusic = useCallback(async () => {
    if (generating || !musicPrompt.trim()) return;
    if (!activeThreadId) return;

    setGenerating(true);
    setProgress({ phase: 'lm', pct: 0 });
    setLastOutput(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`${ENGINE_URL}/api/audio/music`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          prompt:        musicPrompt.trim(),
          lyrics:        musicLyrics.trim() || undefined,
          duration:      musicDuration,
          steps:         musicSteps,
          cfgStrength:   musicCfg,
          seed:          musicSeed,
          threadId:      activeThreadId,
          label:         'music',
          audioBackend:  musicBackend,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) throw new Error('Music generation request failed');

      // Read SSE stream
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as {
              type:       string;
              phase?:     string;
              pct?:       number;
              step?:      number;
              total?:     number;
              message?:   string;
              outputPath?: string;
              elapsedMs?: number;
              rtf?:       number;
            };
            if (evt.type === 'phase') {
              setProgress({ phase: evt.phase ?? '', pct: evt.pct ?? 0 });
            } else if (evt.type === 'progress') {
              setProgress({
                phase:   evt.phase ?? (evt.step ? 'synth' : 'lm'),
                pct:     evt.pct ?? 0,
                step:    evt.step,
                total:   evt.total,
                message: evt.message,
              });
            } else if (evt.type === 'done') {
              setLastOutput({
                path:      evt.outputPath ?? '',
                category:  'music',
                elapsedMs: evt.elapsedMs ?? 0,
                waveform:  null,   // decoded by the useEffect above
              });
            } else if (evt.type === 'error') {
              throw new Error(evt.message ?? 'Generation error');
            }
          } catch (parseErr) {
            if ((parseErr as Error).message !== 'Unexpected token') throw parseErr;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[AudioGenPanel] music generation error:', (err as Error).message);
      }
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }, [
    generating, musicPrompt, musicLyrics, musicDuration, musicSteps,
    musicCfg, musicSeed, activeThreadId,
    setGenerating, setProgress, setLastOutput,
  ]);

  // ── Generate voice clone ──────────────────────────────────────────────────
  const handleGenerateClone = useCallback(async () => {
    if (generating || !cloneText.trim() || !cloneRefData) return;
    if (!activeThreadId) return;

    setGenerating(true);
    setProgress({ phase: 'transcribe', pct: 5 });
    setLastOutput(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`${ENGINE_URL}/api/audio/tts-clone`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          text:         cloneText.trim(),
          refAudioData: cloneRefData,
          refText:      cloneRefText.trim() || undefined,
          speed:        cloneSpeed,
          steps:        cloneSteps,
          threadId:     activeThreadId,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) throw new Error('Clone request failed');

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as {
              type:       string;
              phase?:     string;
              pct?:       number;
              message?:   string;
              outputPath?: string;
              elapsedMs?: number;
            };
            if (evt.type === 'phase') {
              const pct = evt.phase === 'synthesize' ? 50 : 5;
              setProgress({ phase: evt.phase ?? '', pct, message: evt.message });
            } else if (evt.type === 'progress') {
              const cur = useAudioGenStore.getState().progress;
              setProgress({
                phase:   cur?.phase ?? '',
                pct:     cur?.phase === 'synthesize' ? Math.min(95, (cur?.pct ?? 50) + 3) : (cur?.pct ?? 5),
                message: evt.message,
              });
            } else if (evt.type === 'done') {
              setLastOutput({
                path:      evt.outputPath ?? '',
                category:  'tts',
                elapsedMs: evt.elapsedMs ?? 0,
                waveform:  null,
              });
            } else if (evt.type === 'error') {
              throw new Error(evt.message ?? 'Clone error');
            }
          } catch (parseErr) {
            if ((parseErr as Error).message !== 'Unexpected token') throw parseErr;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[AudioGenPanel] clone error:', (err as Error).message);
      }
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }, [
    generating, cloneText, cloneRefData, cloneRefText, cloneSpeed,
    cloneSteps, activeThreadId,
    setGenerating, setProgress, setLastOutput,
  ]);

  // ── Export — browser download of the generated file ──────────────────────
  const handleExport = useCallback(async () => {
    if (!lastOutput?.path) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(lastOutput.path)}`);
      if (!res.ok) return;
      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const filename = lastOutput.path.split(/[\\/]/).pop() ?? 'audio.wav';
      const a        = document.createElement('a');
      a.href         = url;
      a.download     = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* non-fatal */ }
  }, [lastOutput]);

  if (!panelOpen) return null;

  // Gate generates on deps
  const musicDepsReady  = depStatus?.aceStep ?? false;
  const cloneDepsReady  = (depStatus?.whisper ?? false) && (modelStatus?.f5tts ?? false);
  const canGenerateMusic = musicDepsReady && musicPrompt.trim().length > 0 && !!activeThreadId;
  const canGenerateClone = cloneDepsReady && cloneText.trim().length > 0 && !!cloneRefData && !!activeThreadId;

  return (
    <div
      className="border-t border-cyan-400/20 bg-black/95 shrink-0 flex flex-col"
      style={{ height: PANEL_H }}
    >
      {/* ── Panel header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border/30 shrink-0">
        <Music className="w-3 h-3 text-cyan-400/60" />
        <span className="text-[10px] font-terminal tracking-[0.15em] text-cyan-400/70 uppercase">
          Audio Gen
        </span>
        <span className="text-[9px] font-mono text-muted-foreground/50 ml-1">·</span>
        <span className="text-[9px] font-terminal tracking-[0.12em] text-cyan-400/50 uppercase">
          {activeTab === 'music' ? 'Music' : 'Voice Clone'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={closePanel}
            className="p-1 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title="Close audio gen panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Three-column body ─────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* LEFT: Tab info + RTF estimate ──────────────────────────────────── */}
        <div className="w-36 shrink-0 flex flex-col border-r border-border/30 py-2 gap-1">
          {/* Mode description */}
          <div className="px-3">
            <p className="text-[9px] font-mono text-muted-foreground/40 leading-relaxed">
              {activeTab === 'music'
                ? 'Generate music from a text prompt using ACE-Step.'
                : 'Clone a voice from a reference clip using F5-TTS.'}
            </p>
          </div>

          {/* Dep status dots */}
          <div className="px-3 mt-1 flex flex-col gap-1">
            {activeTab === 'music' && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${depStatus?.aceStep ? 'bg-phobos-green/60' : 'bg-destructive/50'}`} />
                  <span className="text-[9px] font-mono text-muted-foreground/40">
                    ACE-Step{depStatus?.aceStepGpu ? ' (GPU)' : depStatus?.aceStepCpu ? ' (CPU)' : ''}
                  </span>
                </div>
                {/* Backend selector — only shown when both routes are available */}
                {depStatus?.aceStepGpu && depStatus?.aceStepCpu && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[9px] font-mono text-muted-foreground/30">backend</span>
                    <select
                      value={musicBackend}
                      onChange={(e) => setMusicBackend(e.target.value as 'auto' | 'gpu' | 'cpu')}
                      disabled={generating}
                      className="text-[9px] font-mono text-ui-glow bg-black border border-border/30 rounded px-1 py-0 h-5 hover:border-muted-foreground/40 focus:border-muted-foreground/50 focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed appearance-none"
                      title="ACE-Step backend: GPU (Python) or CPU (C++ GGUF)"
                    >
                      <option value="auto" className="bg-black">Auto</option>
                      <option value="gpu"  className="bg-black">GPU (Python)</option>
                      <option value="cpu"  className="bg-black">CPU (C++)</option>
                    </select>
                  </div>
                )}
              </>
            )}
            {activeTab === 'clone' && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${depStatus?.whisper ? 'bg-phobos-green/60' : 'bg-destructive/50'}`} />
                  <span className="text-[9px] font-mono text-muted-foreground/40">Whisper</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${modelStatus?.f5tts ? 'bg-phobos-green/60' : 'bg-destructive/50'}`} />
                  <span className="text-[9px] font-mono text-muted-foreground/40">F5-TTS model</span>
                </div>
              </>
            )}
          </div>

          {/* RTF estimate — music only */}
          {activeTab === 'music' && (
            <div className="mt-auto px-2 pb-1">
              <RtfBanner durationSec={musicDuration} aceStepReady={depStatus?.aceStep ?? false} />
            </div>
          )}
        </div>

        {/* CENTER: Params + generate ───────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border/30 relative">

          {/* Dep missing banner */}
          {activeTab === 'music' && depStatus && !depStatus.aceStep && (
            <DepWarning label="ACE-Step binary" />
          )}
          {activeTab === 'clone' && depStatus && !depStatus.whisper && (
            <DepWarning label="Whisper binary" />
          )}
          {activeTab === 'clone' && modelStatus && !modelStatus.f5tts && (
            <DepWarning label="F5-TTS model" />
          )}

          {/* Generation lockout overlay — mirrors WorkflowPanel exactly */}
          {generating && (
            <div className="absolute inset-0 bg-black/70 z-10 flex flex-col items-center justify-center gap-3 px-6">
              <Loader2 className="w-5 h-5 text-cyan-400/50 animate-spin" />
              <span className="text-[11px] font-terminal tracking-[0.15em] text-cyan-400/60 uppercase">
                {activeTab === 'music' ? 'Generating Music…' : 'Cloning Voice…'}
              </span>
              {/* Phase checklist */}
              {activeTab === 'music' && (
                <div className="flex flex-col gap-1 w-full max-w-xs">
                  {(['lm', 'synth', 'decode'] as const).map((phase) => {
                    const currentPct = progress?.pct ?? 0;
                    const phaseMap   = { lm: 0, synth: 40, decode: 95 };
                    const done       = currentPct > (phaseMap[phase] + 2);
                    const active     = progress?.phase === phase;
                    return (
                      <div key={phase} className="flex items-center gap-2">
                        {done
                          ? <CheckCircle className="w-3 h-3 text-cyan-400/50 shrink-0" />
                          : active
                            ? <Loader2 className="w-3 h-3 text-cyan-400/40 animate-spin shrink-0" />
                            : <span className="w-3 h-3 shrink-0" />
                        }
                        <span className={`text-[10px] font-mono ${done ? 'text-muted-foreground/40' : active ? 'text-cyan-400/60' : 'text-muted-foreground/25'}`}>
                          {phase === 'lm' ? 'Language model' : phase === 'synth' ? 'Synthesis' : 'Audio decode'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {activeTab === 'clone' && progress?.phase && (
                <div className="flex flex-col gap-1 w-full max-w-xs">
                  {(['transcribe', 'synthesize'] as const).map((phase) => {
                    const done   = phase === 'transcribe' && (progress?.pct ?? 0) >= 50;
                    const active = progress?.phase === phase;
                    return (
                      <div key={phase} className="flex items-center gap-2">
                        {done
                          ? <CheckCircle className="w-3 h-3 text-cyan-400/50 shrink-0" />
                          : active
                            ? <Loader2 className="w-3 h-3 text-cyan-400/40 animate-spin shrink-0" />
                            : <span className="w-3 h-3 shrink-0" />
                        }
                        <span className={`text-[10px] font-mono ${done ? 'text-muted-foreground/40' : active ? 'text-cyan-400/60' : 'text-muted-foreground/25'}`}>
                          {phase === 'transcribe' ? 'Transcribe reference' : 'Synthesize voice'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Progress bar */}
              {progress && (
                <div className="w-full max-w-xs flex flex-col gap-1">
                  <div className="w-full h-1 bg-muted/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cyan-400/50 rounded-full transition-all duration-300"
                      style={{ width: `${progress.pct}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-cyan-400/40 text-center">
                    {progress.pct}%
                    {progress.step && progress.total ? ` · step ${progress.step}/${progress.total}` : ''}
                  </span>
                </div>
              )}
              <button
                onClick={handleAbort}
                className="mt-2 px-3 py-1 text-[9px] font-terminal tracking-[0.1em] border border-destructive/30 text-destructive/50 hover:text-destructive/80 hover:border-destructive/60 rounded-sm transition-all"
              >
                ■ ABORT
              </button>
            </div>
          )}

          {/* ── Action row: generate + abort ─────────────────────────────── */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/20">
            <button
              onClick={activeTab === 'music' ? handleGenerateMusic : handleGenerateClone}
              disabled={generating || (activeTab === 'music' ? !canGenerateMusic : !canGenerateClone)}
              className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-terminal tracking-[0.1em] border border-cyan-400/30 text-cyan-400/70 hover:text-cyan-400 hover:border-cyan-400/50 rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Play className="w-3 h-3" />
              GENERATE
            </button>
            {lastOutput?.path && !generating && (
              <button
                onClick={handleExport}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-[9px] font-terminal tracking-[0.1em] border border-border/30 text-ui-glow hover:text-cyan-400/70 hover:border-cyan-400/30 rounded-sm transition-all"
                title="Export to workspace"
              >
                <Download className="w-2.5 h-2.5" />
                EXPORT
              </button>
            )}
          </div>

          {/* ── Scrollable param area ─────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto scrollbar-phobos px-3 py-2 space-y-2">

            {/* ── MUSIC PARAMS ─────────────────────────────────────────── */}
            {activeTab === 'music' && (
              <>
                {/* Prompt */}
                <div>
                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Prompt</span>
                  <textarea
                    value={musicPrompt}
                    onChange={(e) => setMusicPrompt(e.target.value)}
                    rows={3}
                    placeholder="Describe the music style, mood, instruments…"
                    className="mt-0.5 w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40 resize-none"
                  />
                </div>

                {/* Lyrics toggle */}
                <button
                  onClick={() => setShowLyrics(!showLyrics)}
                  className="flex items-center gap-1 text-[9px] font-terminal text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                >
                  <span>{showLyrics ? '▾' : '▸'}</span> Lyrics (optional)
                </button>
                {showLyrics && (
                  <textarea
                    value={musicLyrics}
                    onChange={(e) => setMusicLyrics(e.target.value)}
                    rows={2}
                    placeholder="Song lyrics…"
                    className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40 resize-none"
                  />
                )}

                {/* Duration */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Duration</span>
                    <span className="text-[10px] font-mono text-cyan-400/60">{musicDuration}s</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={120}
                    step={5}
                    value={musicDuration}
                    onChange={(e) => setMusicDuration(Number(e.target.value))}
                    className="w-full accent-cyan-400 mt-1"
                  />
                </div>

                {/* Seed row */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Seed</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      <input
                        type="number"
                        value={musicSeed}
                        onChange={(e) => setMusicSeed(parseInt(e.target.value) || -1)}
                        className="flex-1 bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40"
                      />
                      <button
                        onClick={() => setMusicSeed(-1)}
                        title="Random seed"
                        className="p-1 text-muted-foreground/40 hover:text-cyan-400/70 transition-colors"
                      >
                        <Shuffle className="w-3 h-3" />
                      </button>
                    </div>
                    <span className="text-[9px] font-mono text-muted-foreground/25">-1 = random</span>
                  </div>
                </div>

                {/* Advanced toggle */}
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-[9px] font-terminal text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                >
                  <span>{showAdvanced ? '▾' : '▸'}</span> Advanced
                </button>
                {showAdvanced && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <div>
                      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Steps</span>
                      <input
                        type="number"
                        min={10}
                        max={200}
                        value={musicSteps}
                        onChange={(e) => setMusicSteps(parseInt(e.target.value) || 50)}
                        className="w-full mt-0.5 bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40"
                      />
                      <span className="text-[9px] font-mono text-muted-foreground/25">DiT denoising steps</span>
                    </div>
                    <div>
                      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">CFG</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        step={0.5}
                        value={musicCfg}
                        onChange={(e) => setMusicCfg(parseFloat(e.target.value) || 7.0)}
                        className="w-full mt-0.5 bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40"
                      />
                      <span className="text-[9px] font-mono text-muted-foreground/25">guidance strength</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── CLONE PARAMS ─────────────────────────────────────────── */}
            {activeTab === 'clone' && (
              <>
                {/* Reference audio upload zone */}
                <div>
                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Reference Audio</span>
                  {cloneRefData ? (
                    <div className="mt-0.5 flex items-center gap-2 px-2 py-1.5 rounded border border-phobos-green/20 bg-phobos-green/5">
                      <Mic className="w-3 h-3 text-phobos-green/60 shrink-0" />
                      <span className="text-[10px] font-mono text-phobos-green/70 flex-1 truncate">
                        {cloneRefName ?? 'audio.wav'}
                      </span>
                      <button
                        onClick={clearCloneRef}
                        className="text-muted-foreground/30 hover:text-destructive/70 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <div
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={async (e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files[0];
                        if (file) await loadRefAudio(file);
                      }}
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.wav,.mp3,.flac';
                        input.onchange = async () => {
                          const file = input.files?.[0];
                          if (file) await loadRefAudio(file);
                        };
                        input.click();
                      }}
                      className={`mt-0.5 flex flex-col items-center justify-center gap-1.5 py-3 rounded border-2 border-dashed cursor-pointer transition-colors ${
                        dragOver
                          ? 'border-cyan-400/50 bg-cyan-400/8'
                          : 'border-border/25 hover:border-cyan-400/30'
                      }`}
                    >
                      <Upload className="w-4 h-4 text-muted-foreground/30" />
                      <span className="text-[9px] font-mono text-muted-foreground/40">
                        Click or drop WAV / MP3 / FLAC
                      </span>
                      <span className="text-[8px] font-mono text-muted-foreground/25">
                        3–15s of clean speech recommended
                      </span>
                    </div>
                  )}
                </div>

                {/* Reference transcript (optional) */}
                <div>
                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">
                    Reference Transcript
                  </span>
                  <input
                    type="text"
                    value={cloneRefText}
                    onChange={(e) => setCloneRefText(e.target.value)}
                    placeholder="Leave blank to auto-transcribe via Whisper"
                    className="mt-0.5 w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40"
                  />
                </div>

                {/* Text to synthesize */}
                <div>
                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">
                    Text to Synthesize
                  </span>
                  <textarea
                    value={cloneText}
                    onChange={(e) => setCloneText(e.target.value)}
                    rows={3}
                    placeholder="Enter the text to speak in the cloned voice…"
                    className="mt-0.5 w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-cyan-400/40 resize-none"
                  />
                </div>

                {/* Speed + Steps */}
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Speed</span>
                      <span className="text-[10px] font-mono text-cyan-400/60">{cloneSpeed.toFixed(2)}×</span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={2.0}
                      step={0.05}
                      value={cloneSpeed}
                      onChange={(e) => setCloneSpeed(Number(e.target.value))}
                      className="w-full accent-cyan-400 mt-1"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Quality</span>
                    <div className="flex items-center gap-2 mt-1.5">
                      {([16, 32, 64] as const).map((s) => (
                        <label key={s} className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            name="cloneSteps"
                            value={s}
                            checked={cloneSteps === s}
                            onChange={() => setCloneSteps(s)}
                            className="accent-cyan-400"
                          />
                          <span className="text-[9px] font-mono text-muted-foreground/60">
                            {s === 16 ? 'Fast' : s === 32 ? 'Def' : 'Hi'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* RIGHT: Audio preview ────────────────────────────────────────────── */}
        <div className="w-56 shrink-0 flex flex-col p-2">
          <AudioPreviewPane
            outputPath={lastOutput?.path ?? null}
            waveform={lastOutput?.waveform ?? null}
            refWaveform={activeTab === 'clone' ? (cloneRefWaveform ?? null) : null}
            elapsedMs={lastOutput?.elapsedMs ?? 0}
            category={lastOutput?.category ?? 'music'}
            onExport={handleExport}
            generating={generating}
            progress={progress}
          />
        </div>
      </div>
    </div>
  );
}