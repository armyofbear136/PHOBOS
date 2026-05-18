/**
 * StirlingPanel.tsx — Fullscreen Stirling PDF panel.
 *
 * Persist pattern: the iframe mounts on first open and never unmounts.
 * Visibility is controlled by CSS (invisible + pointer-events-none) when
 * closed, not by conditional rendering. display:none must never be used —
 * it causes COEP failures on cross-origin iframes in Chrome.
 *
 * Stirling PDF runs as a Spring Boot subprocess on port 16346.
 * The iframe points to the Node proxy on port 16349 (StirlingManager's
 * startProxyServer), which pipes all traffic transparently and injects
 * COOP+COEP+CORP headers that Spring Boot does not set itself.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL   = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STIRLING_URL = 'http://localhost:16349/';
const POLL_MS      = 4_000;

type ServiceState = 'stopped' | 'starting' | 'running' | 'error';
type ReadyState   = 'waiting' | 'ready' | 'notInstalled' | 'error';

interface StirlingStatus {
  state:         ServiceState;
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  platform:      string;
}

function useStirlingReady() {
  const [status,     setStatus]  = useState<StirlingStatus | null>(null);
  const [readyState, setReady]   = useState<ReadyState>('waiting');
  const [loading,    setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    let st: StirlingStatus | null = null;
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/stirling/status`);
      if (res.ok) { st = await res.json(); setStatus(st); }
    } catch { return; }

    if (!st) return;
    if (!st.binaryPresent) { setReady('notInstalled'); return; }
    if (st.state === 'error')   { setReady('error');   return; }
    if (st.state === 'running') { setReady('ready');   return; }
    setReady((s) => s === 'ready' ? 'waiting' : s);
  }, []);

  const start = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/stirling/start`, { method: 'POST' });
      if (res.ok) setStatus(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    check();
    pollRef.current = setInterval(check, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [check]);

  return { status, readyState, loading, start };
}

export function StirlingPanel() {
  const stirlingPanelOpen   = useAppStore((s) => s.stirlingPanelOpen);
  const toggleStirlingPanel = useAppStore((s) => s.toggleStirlingPanel);
  const { status, readyState, loading, start } = useStirlingReady();

  // Track whether the panel has ever been opened — iframe only mounts after first open.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (stirlingPanelOpen) setEverOpened(true);
  }, [stirlingPanelOpen]);

  // Start service on first open if stopped.
  useEffect(() => {
    if (!stirlingPanelOpen) return;
    if (status && status.state === 'stopped' && status.binaryPresent) start();
  }, [stirlingPanelOpen, status, start]);

  // Escape to close.
  useEffect(() => {
    if (!stirlingPanelOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') toggleStirlingPanel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stirlingPanelOpen, toggleStirlingPanel]);

  // Never opened yet — render nothing.
  if (!everOpened) return null;

  const starting = status?.state === 'starting' || loading;

  return (
    <div className={`fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-background ${
      stirlingPanelOpen ? '' : 'invisible pointer-events-none'
    }`}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/40 bg-background shrink-0">
        <span className="text-[10px] font-terminal text-phobos-green/60 uppercase tracking-widest">
          STIRLING PDF
        </span>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-sm border ${
          readyState === 'ready'
            ? 'border-phobos-green/30 text-phobos-green/60 bg-phobos-green/5'
            : starting
              ? 'border-phobos-amber/30 text-phobos-amber/60 bg-phobos-amber/5'
              : readyState === 'error'
                ? 'border-destructive/30 text-destructive/60 bg-destructive/5'
                : 'border-border/30 text-muted-foreground/40'
        }`}>
          {readyState === 'ready' ? 'running' : starting ? 'starting…' : status?.state ?? 'waiting'}
        </span>
        <div className="flex-1" />
        <button onClick={toggleStirlingPanel} title="Close (Esc)"
          className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {readyState === 'waiting' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Loader2 className="w-8 h-8 text-phobos-green/40 animate-spin" />
            <span className="text-xs font-mono text-muted-foreground/40">
              {starting ? 'Starting Stirling PDF…' : 'Waiting for Stirling PDF…'}
            </span>
            {starting && (
              <span className="text-[10px] font-mono text-muted-foreground/25">
                Spring Boot takes 10–20 seconds on first start
              </span>
            )}
          </div>
        )}
        {readyState === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background">
            <AlertTriangle className="w-8 h-8 text-destructive/50" />
            <span className="text-sm font-mono text-destructive/70">Stirling PDF failed to start</span>
            <span className="text-xs font-mono text-muted-foreground/40 max-w-md text-center">{status?.error}</span>
            <button onClick={start}
              className="px-3 py-1.5 text-xs font-mono border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all">
              retry
            </button>
          </div>
        )}
        {readyState === 'notInstalled' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <span className="text-sm font-mono text-muted-foreground/50">Stirling PDF not installed</span>
            <span className="text-[10px] font-mono text-muted-foreground/30 max-w-sm text-center">
              Run <code className="text-phobos-green/40">node scripts/fetch-stirling.js</code><br />
              Requires Java 21+ on PATH.
            </span>
          </div>
        )}
        {/* Iframe mounts once ready and persists — never re-keyed after first mount */}
        {readyState === 'ready' && (
          <iframe
            src={STIRLING_URL}
            title="Stirling PDF"
            className="absolute inset-0 w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"
          />
        )}
      </div>
    </div>
  );
}
