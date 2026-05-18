/**
 * LmTrainingPanel.tsx — Live training progress for LLM Cartridge sessions.
 *
 * Renders as a fixed 75%-screen overlay so it dominates the UI during a
 * long-running training job. Used by both CartridgesPanel and WeclonePanel —
 * both pass sessionId / onCancel / onDone; the overlay handles everything else.
 *
 * Sub-views by status:
 *   installing / preprocessing        →  PhaseView (spinner + phase label)
 *   training                          →  TrainingProgressView (large stats + big graph)
 *   converting / packaging            →  PhaseView (spinner + phase label)
 *   done                              →  DoneView (cartridge card + cache delete)
 *   error / aborted                   →  ErrorView
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Loader2, CheckCircle2, AlertTriangle, ChevronRight,
  BarChart2, Zap, Package, RotateCcw, Cpu, Trash2,
} from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

interface LmSession {
  session_id:      string;
  status:          string;
  name:            string;
  base_model_id:   string;
  training_hf_id:  string;
  current_step:    number;
  total_steps:     number;
  current_loss:    number;
  current_phase:   string;
  rank:            number;
  steps:           number;
  data_mode:       string;
  cartridge_id:    string | null;
  error:           string | null;
  started_at:      string | null;
  finished_at:     string | null;
}

export interface LmTrainingPanelProps {
  sessionId: string;
  onCancel:  () => void;
  onDone:    (cartridgeId: string) => void;
}

// ── Loss chart — large, fills its container ───────────────────────────────────

function LossChart({ history }: { history: number[] }) {
  if (history.length < 2) return (
    <div className="w-full h-full flex items-center justify-center">
      <span className="text-[10px] font-mono text-muted-foreground/20 uppercase tracking-widest">
        Waiting for data…
      </span>
    </div>
  );

  const W = 800, H = 200;
  const max   = Math.max(...history);
  const min   = Math.min(...history);
  const range = max - min || 0.001;
  const PAD   = { t: 16, b: 28, l: 52, r: 16 };
  const iW    = W - PAD.l - PAD.r;
  const iH    = H - PAD.t - PAD.b;

  const pts = history.map((v, i) => {
    const x = PAD.l + (i / Math.max(history.length - 1, 1)) * iW;
    const y = PAD.t + (1 - (v - min) / range) * iH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Y-axis ticks
  const ticks = [max, (max + min) / 2, min];

  // X-axis step labels — show ~5 evenly spaced
  const xTicks: { x: number; label: string }[] = [];
  const xCount = Math.min(5, history.length);
  for (let i = 0; i < xCount; i++) {
    const idx = Math.round((i / Math.max(xCount - 1, 1)) * (history.length - 1));
    const x   = PAD.l + (idx / Math.max(history.length - 1, 1)) * iW;
    xTicks.push({ x, label: String(idx + 1) });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none">
      {/* Grid lines */}
      {ticks.map((v, i) => {
        const y = PAD.t + (1 - (v - min) / range) * iH;
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y}
              stroke="hsl(120 100% 50% / 0.07)" strokeWidth="1" strokeDasharray="4 4" />
            <text x={PAD.l - 6} y={y + 3.5}
              fill="hsl(120 100% 50% / 0.30)" fontSize="9" fontFamily="monospace"
              textAnchor="end">
              {v.toFixed(3)}
            </text>
          </g>
        );
      })}

      {/* X-axis ticks */}
      {xTicks.map(({ x, label }, i) => (
        <text key={i} x={x} y={H - 6}
          fill="hsl(120 100% 50% / 0.25)" fontSize="9" fontFamily="monospace"
          textAnchor="middle">
          {label}
        </text>
      ))}

      {/* Area fill */}
      <polyline
        points={[
          `${PAD.l},${PAD.t + iH}`,
          pts,
          `${PAD.l + iW},${PAD.t + iH}`,
        ].join(' ')}
        fill="hsl(120 100% 50% / 0.04)"
        stroke="none"
      />

      {/* Loss line */}
      <polyline
        points={pts}
        fill="none"
        stroke="hsl(120 100% 50% / 0.65)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Current value dot */}
      {(() => {
        const last = history[history.length - 1];
        const x    = PAD.l + iW;
        const y    = PAD.t + (1 - (last - min) / range) * iH;
        return (
          <circle cx={x} cy={y} r="3"
            fill="hsl(120 100% 50% / 0.9)"
            stroke="hsl(120 100% 50% / 0.3)"
            strokeWidth="4"
          />
        );
      })()}
    </svg>
  );
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({ ratio, indeterminate }: { ratio: number; indeterminate?: boolean }) {
  return (
    <div className="h-0.5 w-full bg-border/20 rounded-full overflow-hidden">
      {indeterminate ? (
        <div className="h-full w-1/3 bg-phobos-green/40 rounded-full"
          style={{ animation: 'lm-slide 1.8s ease-in-out infinite' }} />
      ) : (
        <div className="h-full bg-phobos-green/60 rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      )}
      <style>{`@keyframes lm-slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }`}</style>
    </div>
  );
}

// ── Phase view (installing / preprocessing / converting / packaging) ───────────

function PhaseView({ session, livePhase }: { session: LmSession; livePhase: string }) {
  const isTerminal = ['converting', 'packaging'].includes(session.status);
  return (
    <div className="flex flex-col h-full">
      <div className="px-8 py-5 border-b border-border/40 shrink-0 space-y-3">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-phobos-green/50 animate-spin" />
          <span className="text-sm font-terminal uppercase tracking-widest text-phobos-green/70">
            {livePhase || session.current_phase || session.status}
          </span>
        </div>
        <ProgressBar ratio={0} indeterminate />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-10">
        <div className="border border-border/20 rounded-sm p-6 bg-black/30 w-full max-w-lg space-y-4">
          <p className="text-[10px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/30">Session</p>
          <p className="text-lg font-terminal text-foreground/80">{session.name}</p>
          <p className="text-sm font-mono text-muted-foreground/40">
            {session.training_hf_id} · rank {session.rank}
          </p>
          {isTerminal && (
            <p className="text-sm font-mono text-phobos-amber/50">
              Training complete — finalizing output…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Training progress view ─────────────────────────────────────────────────────

function TrainingProgressView({
  session,
  lossHistory,
}: {
  session:     LmSession;
  lossHistory: number[];
}) {
  const pct     = session.total_steps > 0 ? session.current_step / session.total_steps : 0;
  const elapsed = session.started_at ? _elapsedLabel(session.started_at) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Phase bar */}
      <div className="px-8 py-4 border-b border-border/30 shrink-0 space-y-2">
        <div className="flex items-center gap-3">
          <Zap className="w-4 h-4 text-phobos-green/60" />
          <span className="text-sm font-terminal uppercase tracking-widest text-phobos-green/70">
            {session.current_phase || 'Training'}
          </span>
          {elapsed && (
            <span className="ml-auto text-xs font-mono text-muted-foreground/30">{elapsed}</span>
          )}
        </div>
        <ProgressBar ratio={pct} />
      </div>

      {/* Stats row */}
      <div className="px-8 py-5 border-b border-border/20 shrink-0">
        <div className="grid grid-cols-3 gap-4">
          {/* Step — big */}
          <div className="border border-border/20 rounded-sm p-4 bg-black/40 space-y-1">
            <div className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35">Step</div>
            <div className="text-3xl font-mono text-foreground/90 tabular-nums leading-none">
              {session.current_step.toLocaleString()}
            </div>
            <div className="text-xs font-mono text-muted-foreground/35">
              / {session.total_steps > 0 ? session.total_steps.toLocaleString() : '?'}
            </div>
          </div>

          {/* Loss — big */}
          <div className="border border-border/20 rounded-sm p-4 bg-black/40 space-y-1">
            <div className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35">Loss</div>
            <div className="text-3xl font-mono text-phobos-green/80 tabular-nums leading-none">
              {session.current_loss > 0 ? session.current_loss.toFixed(4) : '—'}
            </div>
            <div className="text-xs font-mono text-muted-foreground/35">
              rank {session.rank} · {session.data_mode}
            </div>
          </div>

          {/* Progress % */}
          <div className="border border-border/20 rounded-sm p-4 bg-black/40 space-y-1">
            <div className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35">Progress</div>
            <div className="text-3xl font-mono text-foreground/60 tabular-nums leading-none">
              {session.total_steps > 0 ? `${Math.floor(pct * 100)}%` : '—'}
            </div>
            <div className="text-xs font-mono text-muted-foreground/35">
              {elapsed ? `elapsed ${elapsed}` : 'running'}
            </div>
          </div>
        </div>
      </div>

      {/* Chart — fills the rest */}
      <div className="flex-1 min-h-0 flex flex-col px-8 py-5 gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <BarChart2 className="w-4 h-4 text-muted-foreground/30" />
          <span className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/35">
            Loss Curve — last {lossHistory.length} steps
          </span>
        </div>
        <div className="flex-1 min-h-0 border border-border/15 rounded-sm bg-black/50 p-3">
          <LossChart history={lossHistory} />
        </div>
        <div className="shrink-0 border border-border/10 rounded-sm px-4 py-2 bg-black/20">
          <p className="text-[9px] font-mono text-muted-foreground/30">
            Base model: {session.training_hf_id}
            <span className="ml-4 text-muted-foreground/20">
              cache at ~/.phobos/cartridge-training-cache — delete after training from the cartridges panel
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Done view ──────────────────────────────────────────────────────────────────

function DoneView({
  session,
  onOpen,
  onResume,
}: {
  session:  LmSession;
  onOpen:   () => void;
  onResume: () => void;
}) {
  const [cacheGb,       setCacheGb]       = useState<number | null>(null);
  const [deletingCache, setDeletingCache] = useState(false);
  const [cacheDeleted,  setCacheDeleted]  = useState(false);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/cache`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { totalBytes?: number } | null) => {
        if (d?.totalBytes) setCacheGb(parseFloat((d.totalBytes / 1e9).toFixed(1)));
      })
      .catch(() => {});
  }, []);

  const handleDeleteCache = async () => {
    if (!window.confirm(
      `Delete the HuggingFace training cache for ${session.training_hf_id}?\n\n` +
      `This removes the downloaded base model weights (${cacheGb ? `~${cacheGb} GB` : 'large'}). ` +
      `You can re-download them next time you train.`
    )) return;
    setDeletingCache(true);
    try {
      await fetch(`${ENGINE_URL}/api/phobos/training/cache`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trainingHfIds: [session.training_hf_id] }),
      });
      setCacheDeleted(true);
      setCacheGb(null);
    } catch { /* ignore */ } finally { setDeletingCache(false); }
  };

  const elapsed = session.started_at && session.finished_at
    ? _durationLabel(session.started_at, session.finished_at) : null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex flex-col items-center justify-center gap-6 px-10 pt-14 pb-8 border-b border-border/20">
        <div className="relative">
          <Cpu className="w-16 h-16 text-phobos-green/15" />
          <CheckCircle2 className="w-7 h-7 text-phobos-green/60 absolute -bottom-1 -right-1" />
        </div>
        <div className="text-center space-y-2">
          <p className="text-xl font-terminal text-foreground/80">{session.name}</p>
          <p className="text-sm font-mono text-muted-foreground/45">
            {session.current_step.toLocaleString()} steps · rank {session.rank}
            {elapsed ? ` · ${elapsed}` : ''}
          </p>
        </div>
        <button
          onClick={onOpen}
          className="flex items-center gap-2 px-8 py-3 text-sm font-terminal uppercase tracking-[0.15em] text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_24px_hsl(120_100%_50%/0.12)] transition-all"
        >
          <ChevronRight className="w-4 h-4" /> Open Cartridge
        </button>
      </div>

      <div className="px-10 py-6 border-b border-border/15">
        <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/30 mb-4">Training Cache</p>
        {cacheDeleted ? (
          <div className="flex items-center gap-2 text-sm font-mono text-phobos-green/50">
            <CheckCircle2 className="w-4 h-4" /> Cache deleted
          </div>
        ) : (
          <div className="border border-border/20 rounded-sm p-4 flex items-center justify-between gap-6 bg-black/20">
            <div>
              <p className="text-sm font-mono text-foreground/50">{session.training_hf_id}</p>
              <p className="text-xs font-mono text-muted-foreground/30 mt-1">
                {cacheGb ? `~${cacheGb} GB on disk` : 'HF safetensors base model cache'}
              </p>
            </div>
            <button
              onClick={handleDeleteCache}
              disabled={deletingCache}
              className="flex items-center gap-2 px-4 py-2 text-xs font-terminal uppercase tracking-[0.15em] text-red-400/50 border border-red-900/25 rounded-sm hover:border-red-400/40 hover:text-red-400/70 transition-all disabled:opacity-40 whitespace-nowrap"
            >
              {deletingCache ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Delete Cache
            </button>
          </div>
        )}
        <p className="text-[8px] font-mono text-muted-foreground/20 mt-3 leading-relaxed">
          The training cache holds the HuggingFace safetensors base model used during training.
          Your trained cartridge (.gguf adapter) is unaffected by deleting this cache.
        </p>
      </div>

      <div className="px-10 py-5 flex items-center justify-between">
        <p className="text-sm font-mono text-muted-foreground/25">Train additional steps from the last checkpoint?</p>
        <button
          onClick={onResume}
          className="flex items-center gap-2 px-4 py-2 text-xs font-terminal uppercase tracking-widest text-muted-foreground/40 border border-border/20 rounded-sm hover:border-phobos-amber/30 hover:text-phobos-amber/60 transition-all"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Resume
        </button>
      </div>
    </div>
  );
}

// ── Error view ─────────────────────────────────────────────────────────────────

function ErrorView({
  session,
  onClose,
  onResume,
}: {
  session:  LmSession;
  onClose:  () => void;
  onResume: () => void;
}) {
  const [hasCheckpoint, setHasCheckpoint] = useState(false);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${session.session_id}/checkpoint`)
      .then(r => r.ok ? r.json() : { checkpoint: null })
      .then((d: { checkpoint: string | null }) => setHasCheckpoint(d.checkpoint !== null))
      .catch(() => {});
  }, [session.session_id]);

  const aborted = session.status === 'aborted';

  return (
    <div className="flex flex-col h-full items-center justify-center gap-6 p-12">
      <AlertTriangle className="w-14 h-14 text-red-400/30" />
      <div className="text-center space-y-3 max-w-lg">
        <p className="text-xl font-terminal text-foreground/55">
          {aborted ? 'Training stopped' : 'Training failed'}
        </p>
        {session.error && (
          <p className="text-sm font-mono text-red-400/55 leading-relaxed">{session.error}</p>
        )}
        {hasCheckpoint && !aborted && (
          <p className="text-sm font-mono text-phobos-amber/55 leading-relaxed pt-1">
            A checkpoint exists — resume to continue from where training stopped.
          </p>
        )}
      </div>
      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        {(hasCheckpoint || aborted) && (
          <button
            onClick={onResume}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 text-sm font-terminal uppercase tracking-widest text-phobos-amber border border-phobos-amber/25 rounded-sm hover:border-phobos-amber/50 transition-all"
          >
            <RotateCcw className="w-4 h-4" /> Resume from Checkpoint
          </button>
        )}
        <button
          onClick={onClose}
          className="text-sm font-terminal uppercase tracking-widest text-muted-foreground/35 hover:text-muted-foreground/60 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ── Main panel — fixed 75% screen overlay ─────────────────────────────────────

export function LmTrainingPanel({ sessionId, onCancel, onDone }: LmTrainingPanelProps) {
  const [session,     setSession]     = useState<LmSession | null>(null);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [livePhase,   setLivePhase]   = useState('');
  const [connecting,  setConnecting]  = useState(true);

  // Load initial session state on mount
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}`)
      .then(r => r.ok ? r.json() : null)
      .then((s: LmSession | null) => { if (s) setSession(s); })
      .catch(() => {});
  }, [sessionId]);

  const runningRef = useRef(false);

  useEffect(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    let active = true;

    async function run() {
      setConnecting(true);

      const res = await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/run`,
        { method: 'POST' },
      ).catch(() => null);

      if (!res || !res.ok) {
        const err = await res?.json().catch(() => ({ error: 'unknown' })) as { error?: string };
        setSession(s => s ? { ...s, status: 'error', error: err.error ?? 'Run failed' } : s);
        setConnecting(false);
        return;
      }
      setConnecting(false);

      const POLL_MS  = 1500;
      // LLM training runs for hours — allow up to 20 hours
      const DEADLINE = Date.now() + 20 * 60 * 60 * 1000;
      let   errCount = 0;

      while (active && Date.now() < DEADLINE) {
        await new Promise(r => setTimeout(r, POLL_MS));
        if (!active) break;
        try {
          const sr = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/run-status`);
          if (!sr.ok) { errCount++; if (errCount > 10) break; continue; }
          errCount = 0;
          const st = await sr.json() as { training: boolean; session: LmSession | null };
          if (st.session) {
            setSession(st.session);
            if (st.session.current_loss > 0) {
              setLossHistory(h => {
                const n = [...h, st.session!.current_loss];
                return n.length > 500 ? n.slice(-500) : n;
              });
            }
            if (st.session.current_phase) setLivePhase(st.session.current_phase);
            if (st.session.status === 'done' && st.session.cartridge_id) {
              onDone(st.session.cartridge_id);
            }
          }
          if (!st.training) break;
        } catch { errCount++; if (errCount > 10) break; }
      }
    }

    run().catch(() => { setConnecting(false); });
    return () => { active = false; };
  }, [sessionId, onDone]);

  const handleAbort = async () => {
    await fetch(
      `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/abort`,
      { method: 'POST' },
    ).catch(() => {});
    setSession(s => s ? { ...s, status: 'aborted' } : s);
    onCancel();
  };

  const handleResume = useCallback(async () => {
    setLossHistory([]);
    setLivePhase('');
    setConnecting(true);

    const res = await fetch(
      `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/run`,
      { method: 'POST' },
    ).catch(() => null);

    if (!res || !res.ok) {
      const err = await res?.json().catch(() => ({ error: 'unknown' })) as { error?: string };
      setSession(s => s ? { ...s, status: 'error', error: err.error ?? 'Resume failed' } : s);
      setConnecting(false);
      return;
    }
    setConnecting(false);

    const POLL_MS  = 1500;
    const DEADLINE = Date.now() + 20 * 60 * 60 * 1000;
    let   errCount = 0;

    while (Date.now() < DEADLINE) {
      await new Promise(r => setTimeout(r, POLL_MS));
      try {
        const sr = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/run-status`);
        if (!sr.ok) { errCount++; if (errCount > 10) break; continue; }
        errCount = 0;
        const st = await sr.json() as { training: boolean; session: LmSession | null };
        if (st.session) {
          setSession(st.session);
          if (st.session.current_loss > 0) {
            setLossHistory(h => { const n = [...h, st.session!.current_loss]; return n.length > 500 ? n.slice(-500) : n; });
          }
          if (st.session.current_phase) setLivePhase(st.session.current_phase);
          if (st.session.status === 'done' && st.session.cartridge_id) onDone(st.session.cartridge_id);
        }
        if (!st.training) break;
      } catch { errCount++; if (errCount > 10) break; }
    }
  }, [sessionId, onDone]);

  const status      = session?.status ?? 'installing';
  const activePhase = connecting ? 'Connecting…' : livePhase || session?.current_phase || '';
  const showAbort   = ['installing', 'preprocessing', 'training', 'converting'].includes(status);

  return (
    // Fixed full-screen backdrop
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      {/* Panel — 75% of viewport, max capped for readability */}
      <div
        className="relative flex flex-col bg-background border border-border/40 rounded-sm overflow-hidden shadow-2xl"
        style={{ width: '75vw', height: '75vh', maxWidth: '1400px', maxHeight: '900px' }}
      >
        {/* Header */}
        <div className="px-8 py-4 border-b border-border/40 flex items-center justify-between shrink-0 bg-black/60">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-phobos-green/50" />
            <span className="text-sm font-terminal uppercase tracking-widest text-phobos-green/70">
              LM Training
            </span>
            {session?.name && (
              <span className="text-sm font-mono text-muted-foreground/35">— {session.name}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {showAbort && (
              <button
                onClick={handleAbort}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-terminal uppercase tracking-widest text-red-400/55 border border-red-400/20 rounded-sm hover:border-red-400/45 hover:text-red-400/80 transition-all"
              >
                <X className="w-3 h-3" /> Abort
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {!session ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="w-8 h-8 text-muted-foreground/20 animate-spin" />
            </div>
          ) : (
            <>
              {['installing', 'preprocessing', 'converting', 'packaging'].includes(status) && (
                <PhaseView session={session} livePhase={activePhase} />
              )}
              {status === 'training' && (
                <TrainingProgressView session={session} lossHistory={lossHistory} />
              )}
              {status === 'done' && (
                <DoneView
                  session={session}
                  onOpen={() => session.cartridge_id && onDone(session.cartridge_id)}
                  onResume={handleResume}
                />
              )}
              {(status === 'error' || status === 'aborted') && (
                <ErrorView session={session} onClose={onCancel} onResume={handleResume} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _elapsedLabel(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function _durationLabel(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}