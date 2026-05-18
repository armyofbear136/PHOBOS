/**
 * BlockbenchPanel.tsx — Fullscreen Blockbench 3D model editor panel.
 *
 * Persist pattern: the iframe mounts on first open and never unmounts.
 * Visibility is controlled by CSS (invisible + pointer-events-none) when
 * closed, not by conditional rendering. display:none must never be used —
 * it causes COEP failures on cross-origin iframes in Chrome.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { X, Loader2, Boxes } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL     = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const BLOCKBENCH_URL = 'http://localhost:16347';
const POLL_MS        = 3_000;

type BlockbenchState = 'stopped' | 'starting' | 'running' | 'error';

interface BlockbenchStatus {
  state:        BlockbenchState;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
}

function useBlockbenchStatus() {
  const [status,  setStatus]  = useState<BlockbenchStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/blockbench/status`);
      if (res.ok) setStatus(await res.json());
    } catch { /* keep last known state */ }
  }, []);

  const start = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/tools/blockbench/start`, { method: 'POST' });
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

export function BlockbenchPanel() {
  const blockbenchPanelOpen   = useAppStore((s) => s.blockbenchPanelOpen);
  const toggleBlockbenchPanel = useAppStore((s) => s.toggleBlockbenchPanel);
  const { status, loading, start } = useBlockbenchStatus();

  // Track whether the panel has ever been opened — iframe only mounts after first open.
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (blockbenchPanelOpen) setEverOpened(true);
  }, [blockbenchPanelOpen]);

  // Start service on first open if stopped.
  useEffect(() => {
    if (!blockbenchPanelOpen) return;
    if (status && status.state === 'stopped' && status.buildPresent) start();
  }, [blockbenchPanelOpen, status, start]);

  // Escape to close.
  useEffect(() => {
    if (!blockbenchPanelOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') toggleBlockbenchPanel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blockbenchPanelOpen, toggleBlockbenchPanel]);

  // Never opened yet — render nothing.
  if (!everOpened) return null;

  const running      = status?.state === 'running';
  const starting     = status?.state === 'starting' || loading;
  const notInstalled = status && !status.buildPresent && !running;

  return (
    <div className={`fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-background ${
      blockbenchPanelOpen ? '' : 'invisible pointer-events-none'
    }`}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/40 bg-background shrink-0">
        <Boxes className="w-3.5 h-3.5 text-phobos-green/50 shrink-0" />
        <span className="text-[10px] font-terminal text-phobos-green/60 uppercase tracking-widest">
          BLOCKBENCH
        </span>
        <div className="flex-1" />
        <button
          onClick={toggleBlockbenchPanel}
          title="Close (Esc)"
          className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {starting && !running && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Loader2 className="w-6 h-6 text-phobos-green/30 animate-spin" />
            <span className="text-xs font-mono text-muted-foreground/40">Starting Blockbench…</span>
          </div>
        )}
        {notInstalled && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Boxes className="w-8 h-8 text-phobos-green/20" />
            <span className="text-sm font-mono text-muted-foreground/50">Blockbench not installed</span>
            <span className="text-[10px] font-mono text-muted-foreground/30">
              Run <code className="text-phobos-green/40">node scripts/fetch-blockbench.js</code>
            </span>
          </div>
        )}
        {/* Iframe mounts once running and persists — never re-keyed after first mount */}
        {running && (
          <iframe
            src={BLOCKBENCH_URL}
            title="Blockbench"
            className="absolute inset-0 w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"
          />
        )}
      </div>
    </div>
  );
}
