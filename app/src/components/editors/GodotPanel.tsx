/**
 * GodotPanel.tsx — Fullscreen Godot 4.6.2 web editor panel.
 *
 * CREATE → 3D → Godot
 *
 * Same pattern as BlockbenchPanel. See that file for architecture notes.
 *
 * Godot requires COOP/COEP for SharedArrayBuffer (Wasm threads).
 * Its service.worker.js is intercepted by toolsRoute.ts with a no-op.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { X, Loader2, Boxes } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const GODOT_URL  = '/tools/godot/godot.editor.html';
const POLL_MS    = 3_000;

type ReadyState = 'waiting' | 'ready' | 'notInstalled';

function useRouteReady(statusEndpoint: string, probeUrl: string): ReadyState {
  const [state, setState] = useState<ReadyState>('waiting');
  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef        = useRef(true);

  const check = useCallback(async () => {
    try {
      const res = await fetch(statusEndpoint);
      if (!res.ok) return;
      const json = await res.json();
      if (!json.buildPresent) {
        if (mountedRef.current) setState('notInstalled');
        return;
      }
    } catch { return; }

    try {
      const probe = await fetch(probeUrl, { method: 'HEAD' });
      if (mountedRef.current) setState(probe.ok ? 'ready' : 'waiting');
    } catch {
      if (mountedRef.current) setState((s) => s === 'ready' ? 'waiting' : s);
    }
  }, [statusEndpoint, probeUrl]);

  useEffect(() => {
    mountedRef.current = true;
    check();
    pollRef.current = setInterval(check, POLL_MS);
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [check]);

  return state;
}

export function GodotPanel() {
  const godotPanelOpen   = useAppStore((s) => s.godotPanelOpen);
  const toggleGodotPanel = useAppStore((s) => s.toggleGodotPanel);

  const readyState = useRouteReady(`${ENGINE_URL}/api/tools/godot/status`, GODOT_URL);
  const [everLoaded, setEverLoaded] = useState(false);

  useEffect(() => {
    if (readyState === 'ready') setEverLoaded(true);
  }, [readyState]);

  useEffect(() => {
    if (!godotPanelOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') toggleGodotPanel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [godotPanelOpen, toggleGodotPanel]);

  const showIframe = readyState === 'ready' || everLoaded;

  return (
    <div
      className="fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-background"
      style={{ display: godotPanelOpen ? 'flex' : 'none' }}
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border/40 bg-background shrink-0">
        <Boxes className="w-3.5 h-3.5 text-phobos-green/50 shrink-0" />
        <span className="text-[10px] font-terminal text-phobos-green/60 uppercase tracking-widest">
          GODOT 4.6.2
        </span>
        <div className="flex-1" />
        <button
          onClick={toggleGodotPanel}
          title="Close (Esc)"
          className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {readyState === 'waiting' && !everLoaded && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
            <Loader2 className="w-6 h-6 text-phobos-green/30 animate-spin" />
          </div>
        )}
        {readyState === 'notInstalled' && !everLoaded && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Boxes className="w-8 h-8 text-phobos-green/20" />
            <span className="text-sm font-mono text-muted-foreground/50">Godot 4.6.2 Web Editor not installed</span>
            <span className="text-[10px] font-mono text-muted-foreground/30">
              Run <code className="text-phobos-green/40">node scripts/fetch-godot-editor.js</code>
            </span>
          </div>
        )}
        {showIframe && (
          <iframe
            key="godot-iframe"
            src={GODOT_URL}
            title="Godot 4.6.2 Web Editor"
            className="absolute inset-0 w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals"
          />
        )}
      </div>
    </div>
  );
}