/**
 * VideosPanel.tsx — Fullscreen Omniclip video editor panel.
 *
 * Persist pattern: the iframe mounts on first open and never unmounts.
 * Visibility is controlled by CSS (invisible + pointer-events-none) when
 * closed, not by conditional rendering. display:none must never be used —
 * it causes COEP failures on cross-origin iframes in Chrome.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { X, Loader2, AlertTriangle, Film } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL    = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const OMNICLIP_PORT = 16345;
const OMNICLIP_URL  = `http://localhost:${OMNICLIP_PORT}`;
const POLL_MS       = 3_000;

type OmniclipState = 'stopped' | 'starting' | 'running' | 'error';

interface OmniclipStatus {
  state:        OmniclipState;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
  version:      string | null;
}

function useOmniclipStatus() {
  const [status,  setStatus]  = useState<OmniclipStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/omniclip/status`);
      if (res.ok) setStatus(await res.json());
    } catch { /* keep last known state */ }
  }, []);

  const start = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/omniclip/start`, { method: 'POST' });
      if (res.ok) setStatus(await res.json());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  return { status, loading, start };
}

export function VideosPanel() {
  const videosPanelOpen   = useAppStore((s) => s.videosPanelOpen);
  const toggleVideosPanel = useAppStore((s) => s.toggleVideosPanel);
  const { status, loading, start } = useOmniclipStatus();

  // Track whether the panel has ever been opened — iframe only mounts after first open.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (videosPanelOpen) setEverOpened(true);
  }, [videosPanelOpen]);

  // Start service on first open if stopped.
  useEffect(() => {
    if (!videosPanelOpen) return;
    if (status && status.state === 'stopped' && status.buildPresent) start();
  }, [videosPanelOpen, status, start]);

  // Escape to close.
  useEffect(() => {
    if (!videosPanelOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') toggleVideosPanel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [videosPanelOpen, toggleVideosPanel]);

  // Never opened yet — render nothing.
  if (!everOpened) return null;

  const running      = status?.state === 'running';
  const starting     = status?.state === 'starting' || loading;
  const errored      = status?.state === 'error' && !loading;
  const notInstalled = status && !status.buildPresent && !running && !errored;

  return (
    <div className={`fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-background ${
      videosPanelOpen ? '' : 'invisible pointer-events-none'
    }`}>

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/40 bg-background shrink-0">
        <Film className="w-3.5 h-3.5 text-phobos-green/40" />
        <span className="text-[10px] font-terminal text-phobos-green/60 uppercase tracking-widest">
          VIDEO EDITOR
        </span>

        {status?.version && (
          <span className="text-[9px] font-mono text-muted-foreground/25">
            v{status.version}
          </span>
        )}

        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded-sm border ${
          running
            ? 'border-phobos-green/30 text-phobos-green/60 bg-phobos-green/5'
            : starting
              ? 'border-phobos-amber/30 text-phobos-amber/60 bg-phobos-amber/5'
              : errored
                ? 'border-destructive/30 text-destructive/60 bg-destructive/5'
                : 'border-border/30 text-muted-foreground/40'
        }`}>
          {running ? 'running' : starting ? 'starting…' : status?.state ?? 'unknown'}
        </span>

        <div className="flex-1" />

        <button
          onClick={toggleVideosPanel}
          title="Close (Esc)"
          className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">

        {starting && !running && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Loader2 className="w-8 h-8 text-phobos-green/40 animate-spin" />
            <span className="text-xs font-mono text-muted-foreground/40">Starting Omniclip…</span>
          </div>
        )}

        {errored && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background">
            <AlertTriangle className="w-8 h-8 text-destructive/50" />
            <span className="text-sm font-mono text-destructive/70">Omniclip failed to start</span>
            <span className="text-xs font-mono text-muted-foreground/40 max-w-md text-center">
              {status?.error}
            </span>
            {!status?.buildPresent && (
              <span className="text-[10px] font-mono text-muted-foreground/30 max-w-sm text-center">
                Run <code className="text-phobos-green/40">npm install</code> in phobos-core, then restart.
              </span>
            )}
            <button
              onClick={start}
              className="px-3 py-1.5 text-xs font-mono border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all"
            >
              retry
            </button>
          </div>
        )}

        {notInstalled && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Film className="w-8 h-8 text-muted-foreground/20" />
            <span className="text-sm font-mono text-muted-foreground/50">Omniclip not installed</span>
            <span className="text-[10px] font-mono text-muted-foreground/30 max-w-sm text-center">
              Run <code className="text-phobos-green/40">npm install</code> in phobos-core, then restart.
            </span>
          </div>
        )}

        {/* Iframe mounts once running and persists — never re-keyed after first mount */}
        {running && (
          <iframe
            src={OMNICLIP_URL}
            title="Omniclip Video Editor"
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"
          />
        )}
      </div>
    </div>
  );
}
