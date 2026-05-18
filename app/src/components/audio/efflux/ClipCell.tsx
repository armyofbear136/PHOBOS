/**
 * ClipCell.tsx — One clip in the per-channel ClipGrid.
 *
 * Visual states (from PHOBOS-DAW-Phase-3-Session-Model.md §4.4):
 *
 *   • idle    — name + faint colored border. Default look.
 *   • active  — selected for editing. Brighter border, "current" background
 *               tint. The tracker grid below shows THIS clip's notes.
 *   • armed   — queued to launch on next bar boundary. Pulsing border at
 *               the global clock's cycle frequency.
 *   • playing — currently sounding. Solid filled background in clip color.
 *
 * `active`, `armed`, and `playing` are independent — a clip can be all three
 * at once (it's the editor target AND queued AND already playing on a loop).
 * The visual layers in priority: playing fills the background, armed adds
 * the pulse ring, active adds the editor highlight border.
 *
 * Interaction:
 *   • Click            — arm (or un-arm if already armed). Per Q1, the launch
 *                        snaps to the next quantization boundary; immediate
 *                        feedback comes from the pulsing armed-border.
 *   • Cmd/Ctrl-click   — set active (edit this clip in the tracker below)
 *                        without changing arm state. Useful for editing a
 *                        non-playing clip without launching it.
 *   • Right-click      — opens ClipPropsPopover (rename/color/loop/delete).
 *                        Session 3 wires the popover; Batch D right-click
 *                        is a stub that selects active and logs an event.
 *
 * Reads `useSessionStore.sessionVersion` so any state mutation upstream
 * (cursor advance via scheduler, arm transitions) re-renders the cell. The
 * cell is `memo`ised on its own props so unrelated channels don't repaint.
 *
 * Hot-path: cells render at the scheduler tick rate when their channel is
 * playing (~40Hz). Style classes are pre-computed strings — no allocation
 * on each render except the className concatenation, which V8 interns.
 */

import { memo, useCallback, useState }   from 'react';
import { useSessionStore }     from '@/store/daw/useSessionStore';
import { useClipPopoverStore } from '@/store/daw/useClipPopoverStore';

export const CLIP_CELL_WIDTH_PX  = 64;
export const CLIP_CELL_HEIGHT_PX = 22;

/**
 * MIME for clip drag-drop payloads. Distinct from the tracker note cell's
 * MIME so a clip cell drag cannot accidentally drop into a note cell, or
 * vice versa.
 */
const CLIP_DRAG_MIME = 'application/x-phobos-clip';

interface ClipCellProps {
  channelIndex: number;
  clipIndex:    number;
  /** Clip name shown inside the cell. Truncated visually if too long. */
  name:         string;
  /** Clip color (hex). Drives idle border, playing fill, armed pulse. */
  color:        string;
  /** True if this clip is the channel's activeClipIdx. */
  isActive:     boolean;
  /** True if this clip is the channel's armedClipIdx. */
  isArmed:      boolean;
  /** True if this clip is the channel's playingClipIdx. */
  isPlaying:    boolean;
}

function ClipCellImpl({
  channelIndex, clipIndex, name, color,
  isActive, isArmed, isPlaying,
}: ClipCellProps) {

  const onClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useSessionStore.getState();
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl-click: set active without affecting arm/play state.
      store.setActiveClip(channelIndex, clipIndex);
      return;
    }
    // Plain click: toggle arm. If this clip is already armed, un-arm.
    // Otherwise arm it (replaces any prior arm on this channel — only one
    // arm per channel allowed at a time, per design doc §2 Glossary).
    const session = store.activeSession;
    if (!session) return;
    const ch = session.channels[channelIndex];
    if (!ch) return;
    store.armClip(channelIndex, ch.armedClipIdx === clipIndex ? -1 : clipIndex);
    // Make this clip the editor's active clip too — clicking to launch
    // implies "this is what I want to see in the tracker grid below".
    store.setActiveClip(channelIndex, clipIndex);
  }, [channelIndex, clipIndex]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Make this clip active so the tracker grid below shows it while the
    // popover is open — matches user expectation of "I right-clicked this
    // thing, the editor is now editing this thing".
    useSessionStore.getState().setActiveClip(channelIndex, clipIndex);
    // Open the props popover anchored at the click point.
    useClipPopoverStore.getState().openFor(channelIndex, clipIndex, {
      x: e.clientX,
      y: e.clientY,
    });
  }, [channelIndex, clipIndex]);

  // ── Drag-drop wiring ──────────────────────────────────────────────────
  // Same-channel drag = reorder. Cross-channel drag = copy clip (source
  // unchanged). MIME guards against accidental drops from elsewhere
  // (e.g. tracker note cells, which use a different MIME).

  const [isDragOver, setIsDragOver] = useState(false);

  const onDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(CLIP_DRAG_MIME, `${channelIndex}|${clipIndex}`);
    e.dataTransfer.effectAllowed = 'copyMove';
    // Don't propagate up to the ClipGrid container's drag handlers (none
    // currently, but defensive against future additions).
    e.stopPropagation();
  }, [channelIndex, clipIndex]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(CLIP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDragOver) setIsDragOver(true);
  }, [isDragOver]);

  const onDragLeave = useCallback(() => {
    if (isDragOver) setIsDragOver(false);
  }, [isDragOver]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData(CLIP_DRAG_MIME);
    const [chStr, idxStr] = raw.split('|');
    const srcCh  = Number(chStr);
    const srcIdx = Number(idxStr);
    if (!Number.isInteger(srcCh) || !Number.isInteger(srcIdx)) return;
    if (srcCh === channelIndex && srcIdx === clipIndex) return;       // dropped on self

    const store = useSessionStore.getState();
    if (srcCh === channelIndex) {
      // Same channel: reorder. Drop position becomes the new index of the
      // dragged clip.
      store.reorderClip(channelIndex, srcIdx, clipIndex);
    } else {
      // Cross-channel: copy the source clip into the destination channel.
      // The new clip is appended (we don't have a "drop here" insertion
      // point semantic in cross-channel — appending matches the doc spec
      // of "copy clip to other channel").
      store.copyClipToChannel(srcCh, srcIdx, channelIndex);
    }
  }, [channelIndex, clipIndex]);

  // ── Style assembly ────────────────────────────────────────────────────
  // Background: clip color at full opacity when playing, low opacity tint
  // when active (editor target), transparent otherwise.
  // Border: solid clip color when playing, dashed-pulse when armed, color
  // dim when idle, color bright when active.

  const bgStyle: React.CSSProperties = isPlaying
    ? { backgroundColor: color }
    : isActive
      ? { backgroundColor: color + '22' }   // 13% alpha hex tail
      : {};

  const borderStyle: React.CSSProperties = isPlaying
    ? { borderColor: color, borderWidth: 1 }
    : isActive
      ? { borderColor: color, borderWidth: 1 }
      : { borderColor: color + '66', borderWidth: 1 };

  // Armed pulse: tailwind's animate-pulse is fine for the visual pulse.
  // The "official" pulse-at-clock-cycle-frequency wants a custom keyframe;
  // tailwind pulse is good enough for Session 2 — beat-synced pulse is
  // a Session 3 polish item.
  const armedPulse = isArmed ? 'animate-pulse ring-1 ring-offset-0' : '';
  const armedRing: React.CSSProperties = isArmed ? { boxShadow: `inset 0 0 0 1px ${color}` } : {};

  // Text color: white-on-color when playing, color-on-dark otherwise.
  const textStyle: React.CSSProperties = isPlaying
    ? { color: '#ffffff' }
    : isActive
      ? { color: color }
      : { color: color + 'cc' };           // 80% alpha

  return (
    <div
      draggable
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`shrink-0 rounded-sm border cursor-pointer select-none transition-colors flex items-center justify-center ${armedPulse} ${
        isDragOver ? 'ring-2 ring-phobos-amber/80' : ''
      }`}
      style={{
        width:  CLIP_CELL_WIDTH_PX,
        height: CLIP_CELL_HEIGHT_PX,
        ...bgStyle,
        ...borderStyle,
        ...armedRing,
      }}
      title={`${name}${isPlaying ? ' (playing)' : isArmed ? ' (queued)' : ''} — drag to reorder or copy across channels`}
    >
      <span
        className="text-[9px] font-terminal uppercase tracking-tight truncate px-1"
        style={textStyle}
      >
        {name}
      </span>
    </div>
  );
}

export const ClipCell = memo(ClipCellImpl);
