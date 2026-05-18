/**
 * PolarisPlayerDock.tsx — Compact Polaris player for the conversations sidebar.
 *
 * Mirrors `usePolarisPlaybackStore`. All playback goes through the host's
 * FilePlayerNode; the dock just renders state + dispatches actions. Undock
 * toggles the store's `view` to `floating` — the floating PolarisPlayer
 * picks up immediately because both surfaces read the same store.
 *
 * Visible features:
 *   • Compact transport: prev / play-pause / next
 *   • Track title + time readout (mm:ss / mm:ss)
 *   • Seek bar
 *   • Waveform background — taps AudioService.getAnalysers()[0] (master bus)
 *   • Crystal LED — tap = toggle Crystal bypass on the host;
 *                   long-press / right-click = open Crystal's native UI
 *   • Undock button — toggles to floating mode
 *
 * Audio flows host-side:
 *   FilePlayerNode → audioSumNode (channel 0) → Crystal → device output
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, ExternalLink, Volume2 } from 'lucide-react';
import MasterEq from '@/components/audio/MasterEq';
import { WaveformDisplay } from '@/components/audio/efflux/WaveformDisplay';
import { setCrystalActive as apiSetCrystalActive, showCrystalUi } from '@/components/audio/services/DawApi';
import {
  usePolarisPlaybackStore,
  usePolarisStatusPolling,
} from '@/store/usePolarisPlaybackStore';

// Layout constants (chosen to fit inside the 224px-wide sidebar with padding).
const DOCK_WIDTH_PX  = 208;
const DOCK_HEIGHT_PX = 92;
const WAVEFORM_H_PX  = DOCK_HEIGHT_PX;

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function PolarisPlayerDockImpl() {
  // ── Store subscriptions ────────────────────────────────────────────────
  const view        = usePolarisPlaybackStore((s) => s.view);
  const queue       = usePolarisPlaybackStore((s) => s.queue);
  const queueIdx    = usePolarisPlaybackStore((s) => s.queueIdx);
  const playing     = usePolarisPlaybackStore((s) => s.playing);
  const positionSec = usePolarisPlaybackStore((s) => s.positionSec);
  const durationSec = usePolarisPlaybackStore((s) => s.durationSec);

  const togglePlay      = usePolarisPlaybackStore((s) => s.togglePlay);
  const skip            = usePolarisPlaybackStore((s) => s.skip);
  const volume          = usePolarisPlaybackStore((s) => s.volume);
  const setVolume       = usePolarisPlaybackStore((s) => s.setVolume);
  const seek            = usePolarisPlaybackStore((s) => s.seek);
  const toggleDockFloat = usePolarisPlaybackStore((s) => s.toggleDockFloat);

  // Drive host-status polling whenever the dock is the visible surface. The
  // floating player has its own poller; only one runs at a time because of
  // the view-mode mutex.
  usePolarisStatusPolling(100);

  // Crystal LED is unrelated to playback state and lives locally.
  const [crystalActive,  setCrystalActiveLocal] = useState(false);
  const [crystalError,   setCrystalError]       = useState<string | null>(null);
  const [eqOpen,         setEqOpen]             = useState(false);
  const crystalLongPressTimer = useRef<number | null>(null);

  // Core deactivates crystal immediately after mounting, so it always boots
  // bypassed. LED initializes to false (the useState default) — no async read needed.
  // The effect is kept as a no-op placeholder in case boot timing ever changes.

  const current = queue[queueIdx];
  const title   = current?.title ?? null;

  // ── Crystal LED ─────────────────────────────────────────────────────────
  const toggleCrystal = useCallback(async () => {
    const next = !crystalActive;
    setCrystalError(null);
    try {
      await apiSetCrystalActive(next);
      setCrystalActiveLocal(next);
    } catch (err) {
      setCrystalError((err as Error).message);
    }
  }, [crystalActive]);

  const openCrystal = useCallback(async () => {
    setCrystalError(null);
    try { await showCrystalUi(); }
    catch (err) { setCrystalError((err as Error).message); }
  }, []);

  const onCrystalPointerDown = useCallback(() => {
    setCrystalError(null);
    crystalLongPressTimer.current = window.setTimeout(() => {
      void openCrystal();
      crystalLongPressTimer.current = null;
    }, 600);
  }, [openCrystal]);

  const onCrystalPointerUp = useCallback(() => {
    if (crystalLongPressTimer.current !== null) {
      window.clearTimeout(crystalLongPressTimer.current);
      crystalLongPressTimer.current = null;
      void toggleCrystal();
    }
  }, [toggleCrystal]);

  const onCrystalContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void openCrystal();
  }, [openCrystal]);

  // Cancel any pending long-press timer on unmount.
  useEffect(() => () => {
    if (crystalLongPressTimer.current !== null) {
      window.clearTimeout(crystalLongPressTimer.current);
    }
  }, []);

  // ── Transport handlers ─────────────────────────────────────────────────
  const onPlayPause = useCallback(() => { void togglePlay(); }, [togglePlay]);
  const onSkipPrev  = useCallback(() => { void skip(-1); },     [skip]);
  const onSkipNext  = useCallback(() => { void skip(1);  },     [skip]);

  const onSeekClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    void seek(frac * durationSec * 1000);
  }, [durationSec, seek]);

  // Hide entirely when view is floating or hidden — the floating window
  // takes over rendering. Returning null is cheaper than display:none for
  // re-render churn.
  if (view !== 'docked') return null;

  const progressPct = durationSec > 0 ? (positionSec / durationSec) * 100 : 0;

  return (
    <>
    <div
      id="polaris-dock"
      className="relative border-b border-border/30 overflow-hidden bg-background"
      style={{ width: DOCK_WIDTH_PX, height: DOCK_HEIGHT_PX }}
    >
      {/* ── Waveform background (master analyser tap) ────────────────────── */}
      <div className="absolute inset-0 pointer-events-none opacity-40">
        <WaveformDisplay
          analyserIndex={0}
          width={DOCK_WIDTH_PX}
          height={WAVEFORM_H_PX}
          color="#3b82f6"
          background="transparent"
          lineWidth={1}
        />
      </div>

      {/* ── Foreground content ───────────────────────────────────────────── */}
      <div className="relative h-full flex flex-col justify-between px-2 py-1.5">
        {/* Top row: label + Crystal + undock */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full bg-phobos-amber"
              style={{ boxShadow: '0 0 5px #f59e0b' }}
            />
            <span className="text-[8px] font-terminal text-muted-foreground/60 tracking-[0.18em] uppercase">
              Polaris
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onPointerDown={onCrystalPointerDown}
              onPointerUp={onCrystalPointerUp}
              onPointerLeave={() => {
                if (crystalLongPressTimer.current !== null) {
                  window.clearTimeout(crystalLongPressTimer.current);
                  crystalLongPressTimer.current = null;
                }
              }}
              onContextMenu={onCrystalContextMenu}
              title={
                crystalError
                  ? `Crystal: ${crystalError}`
                  : crystalActive
                    ? 'Crystal active — tap to bypass, long-press or right-click for UI'
                    : 'Crystal bypassed — tap to enable, long-press or right-click for UI'
              }
              className={`px-1.5 py-0.5 text-[8px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all ${
                crystalError
                  ? 'border-destructive/60 text-destructive bg-destructive/10'
                  : crystalActive
                    ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10'
                    : 'border-border/40 text-muted-foreground/60 hover:text-phobos-green/70 hover:border-phobos-green/40'
              }`}
            >
              Crystal
            </button>

            <button
              onClick={() => setEqOpen(o => !o)}
              title="Master EQ"
              className={`px-1.5 py-0.5 text-[8px] font-terminal uppercase tracking-[0.12em] rounded-sm border transition-all ${
                eqOpen
                  ? 'border-phobos-amber/60 text-phobos-amber bg-phobos-amber/10'
                  : 'border-border/40 text-muted-foreground/60 hover:text-phobos-amber/70 hover:border-phobos-amber/40'
              }`}
            >
              EQ
            </button>

            <button
              onClick={() => toggleDockFloat()}
              title="Undock to floating player"
              className="p-0.5 text-muted-foreground/40 hover:text-foreground transition-colors"
            >
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>

        {/* Middle row: title + time */}
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span
            className="flex-1 min-w-0 truncate text-[10px] font-mono text-phobos-green/80"
            title={title ?? ''}
          >
            {title ?? '—'}
          </span>
          <span className="text-[8px] font-mono text-muted-foreground/50 tracking-wider shrink-0">
            {fmtTime(positionSec)} / {fmtTime(durationSec)}
          </span>
        </div>

        {/* Seek bar */}
        <div
          onClick={onSeekClick}
          className="h-0.5 bg-border/40 cursor-pointer relative"
        >
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-phobos-amber transition-[width] duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Transport */}
        <div className="flex items-center gap-2">
          {/* Vertical volume slider — sits to the left of transport */}
          <div className="flex flex-col items-center gap-0.5" title={`Volume ${Math.round(volume * 100)}%`}>
            <Volume2 className="w-2.5 h-2.5 text-muted-foreground/40" />
            <input
              type="range"
              min={0} max={1} step={0.02}
              value={volume}
              onChange={(e) => { void setVolume(parseFloat(e.target.value)); }}
              className="h-14 w-1.5 cursor-pointer accent-phobos-green/80"
              style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
              aria-label="Volume"
            />
          </div>

          <div className="flex items-center justify-center gap-2 flex-1">
          <button
            onClick={onSkipPrev}
            className="p-1 rounded text-muted-foreground/50 hover:text-phobos-green/80 transition-colors"
            title="Previous"
          >
            <SkipBack className="w-3 h-3" fill="currentColor" />
          </button>

          <button
            onClick={onPlayPause}
            className={`w-6 h-6 flex items-center justify-center rounded-sm border transition-all ${
              playing
                ? 'border-blue-500/60 text-blue-400 bg-blue-500/10'
                : 'border-phobos-amber/60 text-phobos-amber bg-phobos-amber/10 hover:bg-phobos-amber/20'
            }`}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing
              ? <Pause className="w-3 h-3" fill="currentColor" />
              : <Play  className="w-3 h-3" fill="currentColor" />}
          </button>

          <button
            onClick={onSkipNext}
            className="p-1 rounded text-muted-foreground/50 hover:text-phobos-green/80 transition-colors"
            title="Next"
          >
            <SkipForward className="w-3 h-3" fill="currentColor" />
          </button>
          </div>{/* end inner transport */}
        </div>
      </div>
    </div>
    {eqOpen && <MasterEq onClose={() => setEqOpen(false)} />}
    </>
  );
}

export const PolarisPlayerDock = memo(PolarisPlayerDockImpl);
