/**
 * ClipPropsPopover.tsx — Per-clip properties editor.
 *
 * Triggered by right-click on a ClipCell (see ClipCell.onContextMenu). The
 * popover positions itself near the right-click point and offers:
 *
 *   • Rename — text input bound to clip.name
 *   • Color picker — swatches from DEFAULT_CLIP_COLORS, updates clip.color
 *   • Loop toggle — flips clip.loop (true = restart at step 0, false = stop)
 *   • Delete — removes the clip from the channel
 *
 * Positioning model:
 *   The popover is fixed-positioned at the right-click coordinates with
 *   viewport edge clamping — it never spills off-screen. The overlay
 *   backdrop captures click-outside-to-close.
 *
 * Reactivity:
 *   The popover is a controlled component — parent owns the {open, anchor,
 *   channelIndex, clipIndex} state and toggles `open` from the right-click
 *   handler in ClipCell. This keeps the popover stateless on its own and
 *   lets multiple clip cells share a single popover instance (mounted in
 *   EffluxPanel) rather than each cell carrying its own.
 *
 * Hot-path: zero — the popover is closed during playback. When open, all
 * mutations route through useSessionStore actions which already match the
 * mutation discipline (in-place + bump version).
 */

import { memo, useCallback, useEffect, useState, useRef } from 'react';
import { Trash2, Repeat, X } from 'lucide-react';
import { useSessionStore, DEFAULT_CLIP_COLORS } from '@/store/daw/useSessionStore';

const POPOVER_WIDTH_PX  = 240;
const POPOVER_HEIGHT_PX = 168;        // approximate — swatches + name + actions
const VIEWPORT_PAD_PX   = 8;

export interface ClipPropsPopoverAnchor {
  x: number;
  y: number;
}

interface ClipPropsPopoverProps {
  open:         boolean;
  anchor:       ClipPropsPopoverAnchor | null;
  channelIndex: number;
  clipIndex:    number;
  onClose:      () => void;
}

function ClipPropsPopoverImpl({
  open, anchor, channelIndex, clipIndex, onClose,
}: ClipPropsPopoverProps) {
  // Subscribe to sessionVersion so external mutations (e.g. scheduler
  // changing playingClipIdx) refresh the popover's view of clip state.
  const _v = useSessionStore((s) => s.sessionVersion);                    // eslint-disable-line @typescript-eslint/no-unused-vars
  const session = useSessionStore((s) => s.activeSession);

  // Local rename buffer — mutating clip.name on every keystroke would
  // bumpSessionVersion 30+ times per typed name. Buffer locally, commit
  // on blur or Enter. This is the standard React pattern for "edit a
  // text field that lives in a global store".
  const [nameBuffer, setNameBuffer] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the buffer whenever the popover opens against a different clip.
  useEffect(() => {
    if (!open || !session) return;
    const ch = session.channels[channelIndex];
    const clip = ch?.clips[clipIndex];
    if (clip) {
      setNameBuffer(clip.name);
      // Focus + select on next tick so the user can type immediately.
      const tid = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(tid);
    }
  }, [open, session, channelIndex, clipIndex]);

  // Close on Escape — registered while open only, removed on close/unmount.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const commitName = useCallback(() => {
    const trimmed = nameBuffer.trim();
    if (trimmed.length === 0) return;     // refuse blank names
    useSessionStore.getState().renameClip(channelIndex, clipIndex, trimmed);
  }, [nameBuffer, channelIndex, clipIndex]);

  const onNameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitName();
      onClose();
    }
  }, [commitName, onClose]);

  const onPickColor = useCallback((color: string) => {
    useSessionStore.getState().setClipColor(channelIndex, clipIndex, color);
  }, [channelIndex, clipIndex]);

  const onToggleLoop = useCallback(() => {
    const ch = useSessionStore.getState().activeSession?.channels[channelIndex];
    const clip = ch?.clips[clipIndex];
    if (!clip) return;
    useSessionStore.getState().setClipLoop(channelIndex, clipIndex, !clip.loop);
  }, [channelIndex, clipIndex]);

  const onDelete = useCallback(() => {
    useSessionStore.getState().deleteClip(channelIndex, clipIndex);
    onClose();
  }, [channelIndex, clipIndex, onClose]);

  // ── Render guards ─────────────────────────────────────────────────────
  if (!open || !anchor || !session) return null;
  const ch = session.channels[channelIndex];
  if (!ch) return null;
  const clip = ch.clips[clipIndex];
  if (!clip) return null;

  // ── Position with viewport clamping ───────────────────────────────────
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let posX = anchor.x;
  let posY = anchor.y;
  if (posX + POPOVER_WIDTH_PX  + VIEWPORT_PAD_PX > vw) posX = vw - POPOVER_WIDTH_PX  - VIEWPORT_PAD_PX;
  if (posY + POPOVER_HEIGHT_PX + VIEWPORT_PAD_PX > vh) posY = vh - POPOVER_HEIGHT_PX - VIEWPORT_PAD_PX;
  if (posX < VIEWPORT_PAD_PX) posX = VIEWPORT_PAD_PX;
  if (posY < VIEWPORT_PAD_PX) posY = VIEWPORT_PAD_PX;

  return (
    <>
      {/* Click-outside backdrop — transparent, captures clicks anywhere
          outside the popover surface. z-50 to sit above the DAW panel
          (z-40) and below modals (z-50+). */}
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />

      <div
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        className="fixed z-50 bg-background border border-phobos-green/30 rounded-sm shadow-2xl flex flex-col"
        style={{
          left:  posX,
          top:   posY,
          width: POPOVER_WIDTH_PX,
        }}
      >
        {/* Header — clip color stripe + close button */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
          <span
            className="w-3 h-3 rounded-sm shrink-0"
            style={{ backgroundColor: clip.color }}
            aria-hidden
          />
          <span className="text-[8px] font-mono text-phobos-green/40 uppercase tracking-widest flex-1 truncate">
            CH {channelIndex.toString(16).toUpperCase()} · CLIP {clipIndex + 1}
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title="Close (Esc)"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* Rename */}
        <div className="px-3 py-2 border-b border-border/20">
          <label className="text-[8px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/60 mb-1 block">
            Name
          </label>
          <input
            ref={inputRef}
            value={nameBuffer}
            onChange={(e) => setNameBuffer(e.target.value)}
            onBlur={commitName}
            onKeyDown={onNameKeyDown}
            className="w-full px-2 py-1 text-xs font-mono bg-black/60 border border-border/30 rounded-sm text-phobos-green/90 focus:outline-none focus:border-phobos-green/60"
            placeholder="Clip name"
            maxLength={48}
          />
        </div>

        {/* Color swatches */}
        <div className="px-3 py-2 border-b border-border/20">
          <label className="text-[8px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/60 mb-1 block">
            Color
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {DEFAULT_CLIP_COLORS.map((c) => {
              const selected = c.toLowerCase() === clip.color.toLowerCase();
              return (
                <button
                  key={c}
                  onClick={() => onPickColor(c)}
                  className={`w-5 h-5 rounded-sm border transition-transform hover:scale-110 ${
                    selected ? 'border-white' : 'border-border/30'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                  aria-label={`Color ${c}`}
                />
              );
            })}
          </div>
        </div>

        {/* Loop toggle + Delete — actions row */}
        <div className="px-3 py-2 flex items-center gap-2">
          <button
            onClick={onToggleLoop}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-terminal uppercase tracking-tight rounded-sm border transition-colors ${
              clip.loop
                ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10'
                : 'border-border/30 text-muted-foreground/60 hover:text-muted-foreground'
            }`}
            title={clip.loop ? 'Looping — click to play once' : 'Play once — click to loop'}
          >
            {clip.loop ? <Repeat className="w-3 h-3" /> : <Repeat className="w-3 h-3 opacity-40" />}
            {clip.loop ? 'Loop' : 'Once'}
          </button>

          <button
            onClick={onDelete}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-terminal uppercase tracking-tight rounded-sm border border-destructive/40 text-destructive/80 hover:bg-destructive/10 hover:text-destructive transition-colors"
            title="Delete clip"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

export const ClipPropsPopover = memo(ClipPropsPopoverImpl);
