/**
 * TrainingPanel.tsx — Live training UI for the Artist Plugin System.
 *
 * Replaces the right column of PluginsMenu when training is active.
 * Three sub-views driven by session.status:
 *
 *   pending / installing / captioning  →  CaptionReviewView (image grid + caption editing)
 *   training                           →  TrainingProgressView (step counter, loss chart, phase label)
 *   packaging / done                   →  DoneView (result card, open plugin button)
 *   error / aborted                    →  ErrorView
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Loader2, CheckCircle2, AlertTriangle, ChevronRight,
  BarChart2, Zap, Package, Image, RotateCcw, FolderOpen,
} from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrainingSession {
  session_id:     string;
  status:         string;
  name:           string;
  base_model:     string;
  current_step:   number;
  total_steps:    number;
  current_loss:   number;
  current_lr:     number;
  current_phase:  string;
  lora_path:      string | null;
  plugin_id:      string | null;
  error:          string | null;
  image_dir:      string;
  caption_file:   string;
  trigger_word:   string;
}

interface TrainingProgress {
  type:     string;
  session:  TrainingSession;
  message?: string;
}

export interface TrainingPanelProps {
  sessionId:    string;
  onCancel:     () => void;
  onDone:       (pluginId: string) => void;
}

// ── Loss chart ────────────────────────────────────────────────────────────────

function LossChart({ history }: { history: number[] }) {
  const W = 320, H = 80;
  if (history.length < 2) return null;

  const max = Math.max(...history);
  const min = Math.min(...history);
  const range = max - min || 1;

  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      <polyline points={pts} fill="none" stroke="hsl(120 100% 50% / 0.5)" strokeWidth="1.5" />
      <text x="2" y="10" fill="hsl(120 100% 50% / 0.4)" fontSize="8" fontFamily="monospace">
        {max.toFixed(4)}
      </text>
      <text x="2" y={H - 2} fill="hsl(120 100% 50% / 0.4)" fontSize="8" fontFamily="monospace">
        {min.toFixed(4)}
      </text>
    </svg>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ ratio, indeterminate }: { ratio: number; indeterminate?: boolean }) {
  return (
    <div className="h-1 w-full bg-border/30 rounded-full overflow-hidden">
      {indeterminate ? (
        <div className="h-full w-1/3 bg-phobos-green/50 rounded-full animate-[slide_1.5s_ease-in-out_infinite]"
          style={{ animation: 'slide 1.5s ease-in-out infinite' }} />
      ) : (
        <div className="h-full bg-phobos-green/60 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      )}
    </div>
  );
}

// ── Caption review ────────────────────────────────────────────────────────────

interface CaptionEntry { filename: string; caption: string; }

function CaptionReviewView({
  session,
  livePhase,
  captionMap,
  onCaptionEdit,
}: {
  session:       TrainingSession;
  livePhase:     string;
  captionMap:    Record<string, string>;
  onCaptionEdit: (filename: string, caption: string) => void;
}) {
  const files = Object.keys(captionMap);
  const done  = session.status !== 'captioning';

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {done
            ? <CheckCircle2 className="w-3.5 h-3.5 text-phobos-green/60" />
            : <Loader2       className="w-3.5 h-3.5 text-phobos-green/40 animate-spin" />
          }
          <span className="text-[10px] font-terminal uppercase tracking-widest text-phobos-green/70">
            {done ? `${files.length} captions ready` : livePhase}
          </span>
        </div>
        {!done && <ProgressBar ratio={files.length / Math.max(1, session.total_steps)} indeterminate />}
      </div>

      {files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <Loader2 className="w-6 h-6 text-muted-foreground/20 animate-spin mx-auto" />
            <p className="text-[10px] font-mono text-muted-foreground/30">Captioning images…</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
          {files.map(filename => (
            <div key={filename} className="border border-border/30 rounded-sm p-2 space-y-1.5 bg-background">
              <div className="text-[9px] font-mono text-muted-foreground/50 truncate">{filename}</div>
              <textarea
                value={captionMap[filename] ?? ''}
                onChange={e => onCaptionEdit(filename, e.target.value)}
                rows={2}
                className="w-full text-[10px] font-mono bg-transparent border-0 p-0 text-foreground/70 focus:outline-none resize-none leading-relaxed"
                placeholder="Caption will appear here…"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Training progress ─────────────────────────────────────────────────────────

function TrainingProgressView({
  session,
  lossHistory,
}: {
  session:     TrainingSession;
  lossHistory: number[];
}) {
  const pct    = session.total_steps > 0 ? session.current_step / session.total_steps : 0;
  const isTraining = session.status === 'training';

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2 mb-1.5">
          {isTraining
            ? <Zap className="w-3.5 h-3.5 text-phobos-green/60" />
            : <Package className="w-3.5 h-3.5 text-phobos-green/60" />
          }
          <span className="text-[10px] font-terminal uppercase tracking-widest text-phobos-green/70">
            {session.current_phase || (isTraining ? 'Training' : session.status)}
          </span>
        </div>
        <ProgressBar ratio={pct} indeterminate={!isTraining} />
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">

        {/* Step counter */}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Step"  value={`${session.current_step} / ${session.total_steps}`} />
          <Stat label="Loss"  value={session.current_loss > 0 ? session.current_loss.toFixed(4) : '—'} />
          <Stat label="LR"    value={session.current_lr   > 0 ? session.current_lr.toExponential(2) : '—'} />
        </div>

        {/* Loss chart */}
        {lossHistory.length >= 2 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <BarChart2 className="w-3 h-3 text-muted-foreground/30" />
              <span className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40">Loss</span>
            </div>
            <div className="border border-border/20 rounded-sm p-2 bg-black/40">
              <LossChart history={lossHistory} />
            </div>
          </div>
        )}

        {/* Phase log — last few phase labels */}
        <div>
          <span className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40">
            Base model: {session.base_model}
          </span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border/20 rounded-sm p-2 bg-black/40">
      <div className="text-[8px] font-terminal uppercase tracking-widest text-muted-foreground/40 mb-0.5">{label}</div>
      <div className="text-[12px] font-mono text-foreground/80">{value}</div>
    </div>
  );
}

// ── Done view ─────────────────────────────────────────────────────────────────

function DoneView({
  session,
  onOpen,
  onResume,
}: {
  session:  TrainingSession;
  onOpen:   () => void;
  onResume: () => void;
}) {
  const [previews,          setPreviews]          = useState<string[]>([]);
  const [generatingPreviews, setGeneratingPreviews] = useState(false);
  const [previewMsg,        setPreviewMsg]        = useState('');

  // Load any existing preview images
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/sessions/${session.session_id}/previews`)
      .then(r => r.ok ? r.json() : { images: [] })
      .then((d: { images: string[] }) => setPreviews(Array.isArray(d.images) ? d.images : []))
      .catch(() => {});
  }, [session.session_id]);

  const handleGeneratePreviews = async () => {
    setGeneratingPreviews(true);
    setPreviewMsg('');
    try {
      const res = await fetch(
        `${ENGINE_URL}/api/phobos/training/sessions/${session.session_id}/generate-previews`,
        { method: 'POST' },
      );
      const d = await res.json() as { ok: boolean; message: string };
      setPreviewMsg(d.message);
    } catch {
      setPreviewMsg('Could not connect to PHOBOS.');
    } finally {
      setGeneratingPreviews(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-thin">
      {/* Success header */}
      <div className="flex flex-col items-center justify-center gap-3 px-8 pt-10 pb-6 border-b border-border/30">
        <CheckCircle2 className="w-12 h-12 text-phobos-green/50" />
        <div className="text-center">
          <p className="text-base font-terminal text-foreground/90 mb-1">{session.name}</p>
          <p className="text-[11px] font-mono text-muted-foreground/50">
            Trained {session.current_step} steps · packaged as .phobos
          </p>
        </div>
        <button
          onClick={onOpen}
          className="flex items-center gap-1.5 px-5 py-2 text-[10px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_16px_hsl(120_100%_50%/0.12)] transition-all"
        >
          <ChevronRight className="w-3.5 h-3.5" /> Open Plugin
        </button>
      </div>

      {/* Previews section */}
      <div className="px-6 py-5 border-b border-border/30">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Image className="w-3.5 h-3.5 text-muted-foreground/40" />
            <span className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50">
              Preview Images
            </span>
            {previews.length > 0 && (
              <span className="text-[9px] font-mono text-phobos-green/50">{previews.length} generated</span>
            )}
          </div>
          <button
            onClick={handleGeneratePreviews}
            disabled={generatingPreviews}
            className="flex items-center gap-1 px-2.5 py-1 text-[8px] font-terminal uppercase tracking-widest text-muted-foreground/50 border border-border/30 rounded-sm hover:border-phobos-green/30 hover:text-phobos-green/60 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {generatingPreviews
              ? <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Generating…</>
              : <><Zap className="w-2.5 h-2.5" /> Generate Previews</>
            }
          </button>
        </div>

        {previews.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {previews.slice(0, 6).map((src, i) => (
              <div key={i} className="aspect-square bg-background border border-border/20 rounded-sm overflow-hidden">
                <img src={src} alt={`Preview ${i + 1}`} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 border border-dashed border-border/20 rounded-sm gap-2">
            <FolderOpen className="w-6 h-6 text-muted-foreground/20" />
            <p className="text-[10px] font-mono text-muted-foreground/30 text-center leading-relaxed max-w-[260px]">
              No preview images yet. Generate them to show what your plugin can do — they'll be embedded in the .phobos file.
            </p>
          </div>
        )}

        {previewMsg && (
          <p className="mt-2 text-[9px] font-mono text-muted-foreground/40 leading-relaxed">{previewMsg}</p>
        )}
      </div>

      {/* Resume / retrain section */}
      <div className="px-6 py-4 flex items-center justify-between">
        <p className="text-[10px] font-mono text-muted-foreground/30">Want to train more steps?</p>
        <button
          onClick={onResume}
          className="flex items-center gap-1 px-2.5 py-1 text-[8px] font-terminal uppercase tracking-widest text-muted-foreground/40 border border-border/20 rounded-sm hover:border-phobos-amber/30 hover:text-phobos-amber/60 transition-all"
        >
          <RotateCcw className="w-2.5 h-2.5" /> Resume Training
        </button>
      </div>
    </div>
  );
}

// ── Error view ────────────────────────────────────────────────────────────────

function ErrorView({
  session,
  onClose,
  onResume,
}: {
  session:  TrainingSession;
  onClose:  () => void;
  onResume: () => void;
}) {
  const [hasCheckpoint, setHasCheckpoint] = useState(false);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/sessions/${session.session_id}/checkpoint`)
      .then(r => r.ok ? r.json() : { checkpoint: null })
      .then((d: { checkpoint: string | null }) => setHasCheckpoint(d.checkpoint !== null))
      .catch(() => {});
  }, [session.session_id]);

  const aborted = session.status === 'aborted';

  return (
    <div className="flex flex-col h-full items-center justify-center gap-5 p-8">
      <AlertTriangle className="w-10 h-10 text-red-400/40" />
      <div className="text-center space-y-2 max-w-[320px]">
        <p className="text-sm font-terminal text-foreground/60">
          {aborted ? 'Training stopped' : 'Training failed'}
        </p>
        {session.error && (
          <p className="text-[10px] font-mono text-red-400/60 leading-relaxed">{session.error}</p>
        )}
        {hasCheckpoint && (
          <p className="text-[10px] font-mono text-phobos-amber/60 leading-relaxed pt-1">
            A checkpoint was saved — you can resume from where it left off.
          </p>
        )}
      </div>
      <div className="flex flex-col items-center gap-2 w-full max-w-[220px]">
        {hasCheckpoint && (
          <button
            onClick={onResume}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-[9px] font-terminal uppercase tracking-widest text-phobos-amber border border-phobos-amber/30 rounded-sm hover:border-phobos-amber/50 transition-all"
          >
            <RotateCcw className="w-3 h-3" /> Resume from Checkpoint
          </button>
        )}
        <button
          onClick={onClose}
          className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function TrainingPanel({ sessionId, onCancel, onDone }: TrainingPanelProps) {
  const [session,     setSession]     = useState<TrainingSession | null>(null);
  const [captionMap,  setCaptionMap]  = useState<Record<string, string>>({});
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [livePhase,   setLivePhase]   = useState('');
  const [connecting,  setConnecting]  = useState(true);

  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);

  // Fetch initial session state
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/sessions/${sessionId}`)
      .then(r => r.json())
      .then((s: TrainingSession) => setSession(s))
      .catch(() => {});
  }, [sessionId]);

  // Start training SSE stream
  useEffect(() => {
    let active = true;

    async function stream() {
      setConnecting(true);
      try {
        const res = await fetch(`${ENGINE_URL}/api/phobos/training/sessions/${sessionId}/run`, {
          method: 'POST',
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: 'unknown' }));
          setSession(s => s ? { ...s, status: 'error', error: err.error } : s);
          return;
        }

        setConnecting(false);
        const reader = res.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buf = '';

        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';

          for (const part of parts) {
            const dataLine = part.split('\n').find(l => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(6)) as TrainingProgress;
              setSession(ev.session);

              if (ev.type === 'step' && ev.session.current_loss > 0) {
                setLossHistory(h => {
                  const next = [...h, ev.session.current_loss];
                  return next.length > 200 ? next.slice(-200) : next;
                });
              }

              if (ev.type === 'phase') setLivePhase(ev.session.current_phase);

              if (ev.type === 'done' && ev.session.plugin_id) {
                onDone(ev.session.plugin_id);
              }
            } catch { /* malformed JSON — skip */ }
          }
        }
      } catch { /* network error */ } finally {
        setConnecting(false);
      }
    }

    stream();
    return () => {
      active = false;
      readerRef.current?.cancel();
    };
  }, [sessionId]);

  const handleAbort = async () => {
    readerRef.current?.cancel();
    await fetch(`${ENGINE_URL}/api/phobos/training/sessions/${sessionId}/abort`, { method: 'POST' });
    setSession(s => s ? { ...s, status: 'aborted' } : s);
    onCancel();
  };

  // Resume: abort current reader, re-fire the run endpoint (PluginTrainer
  // will auto-populate resume_from from the latest checkpoint).
  const handleResume = useCallback(async () => {
    readerRef.current?.cancel();
    setLossHistory([]);
    setLivePhase('');
    setConnecting(true);
    // Re-fetch session (clears error state) then restart — the SSE effect
    // won't re-fire because sessionId hasn't changed, so we trigger manually.
    const res = await fetch(`${ENGINE_URL}/api/phobos/training/sessions/${sessionId}/run`, {
      method: 'POST',
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: 'unknown' }));
      setSession(s => s ? { ...s, status: 'error', error: (err as {error:string}).error } : s);
      setConnecting(false);
      return;
    }
    setConnecting(false);
    const reader = res.body.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const ev = JSON.parse(dataLine.slice(6)) as TrainingProgress;
          setSession(ev.session);
          if (ev.type === 'step' && ev.session.current_loss > 0) {
            setLossHistory(h => { const n = [...h, ev.session.current_loss]; return n.length > 200 ? n.slice(-200) : n; });
          }
          if (ev.type === 'phase') setLivePhase(ev.session.current_phase);
          if (ev.type === 'done' && ev.session.plugin_id) onDone(ev.session.plugin_id);
        } catch { /* skip */ }
      }
    }
  }, [sessionId, onDone]);

  const handleCaptionEdit = (filename: string, caption: string) => {
    setCaptionMap(m => ({ ...m, [filename]: caption }));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <Header name="…" onAbort={handleAbort} />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-muted-foreground/20 animate-spin" />
        </div>
      </div>
    );
  }

  const status = session.status;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Header name={session.name} onAbort={handleAbort} showAbort={status === 'training' || status === 'captioning' || status === 'installing'} />

      <div className="flex-1 min-h-0 overflow-hidden">
        {(status === 'pending' || status === 'installing' || status === 'captioning') && (
          <CaptionReviewView
            session={session}
            livePhase={connecting ? 'Connecting…' : livePhase || session.current_phase}
            captionMap={captionMap}
            onCaptionEdit={handleCaptionEdit}
          />
        )}

        {(status === 'training' || status === 'packaging') && (
          <TrainingProgressView session={session} lossHistory={lossHistory} />
        )}

        {status === 'done' && (
          <DoneView
            session={session}
            onOpen={() => session.plugin_id && onDone(session.plugin_id)}
            onResume={handleResume}
          />
        )}

        {(status === 'error' || status === 'aborted') && (
          <ErrorView session={session} onClose={onCancel} onResume={handleResume} />
        )}
      </div>
    </div>
  );
}

function Header({
  name,
  onAbort,
  showAbort = true,
}: {
  name:       string;
  onAbort:    () => void;
  showAbort?: boolean;
}) {
  return (
    <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2">
        <Zap className="w-3.5 h-3.5 text-phobos-green/50" />
        <span className="text-[10px] font-terminal uppercase tracking-widest text-phobos-green/70">Training</span>
        {name && <span className="text-[10px] font-mono text-muted-foreground/50">— {name}</span>}
      </div>
      {showAbort && (
        <button
          onClick={onAbort}
          className="flex items-center gap-1 px-2 py-1 text-[9px] font-terminal uppercase tracking-widest text-red-400/60 border border-red-400/20 rounded-sm hover:border-red-400/40 transition-all"
        >
          <X className="w-2.5 h-2.5" /> Abort
        </button>
      )}
    </div>
  );
}
