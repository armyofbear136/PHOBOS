/**
 * ClipGrid.tsx — The 2-row scrollable grid of clip cells under each
 * ChannelHeader.
 *
 * From the design doc §4.4:
 *
 *   ┌──────────────────────┐
 *   │ ┌─┐┌─┐┌─┐┌─┐┌+┐      │  CLIP GRID — 2 rows of clip cells, scrollable
 *   │ │1││2││3││4││ │      │  Click = arm. Right-click name to rename.
 *   │ └─┘└─┘└─┘└─┘└─┘      │  Right-click delete icon to delete.
 *   │ ┌─┐                  │  Loop toggle next to name+delete in clip props popover.
 *   │ │5│                  │
 *   │ └─┘                  │
 *   └──────────────────────┘
 *
 * Layout policy:
 *   • Cells flow left-to-right, wrapping into a second row when the first
 *     fills. Two visible rows; if more than 2 rows of cells exist, the grid
 *     scrolls vertically inside its fixed-height container.
 *   • The empty `+` cell is ALWAYS last, regardless of clip count. Clicking
 *     it appends a new clip to this channel via useSessionStore.addClip().
 *   • Channels with zero clips show only the `+` cell.
 *
 * Reactivity:
 *   • Subscribes to useSessionStore.sessionVersion so any clip CRUD or
 *     state change re-renders.
 *   • Reads the channel's clip array, activeClipIdx, armedClipIdx,
 *     playingClipIdx by index — no slice, no map of objects, no allocation
 *     on subscribe.
 *
 * Hot-path: when a clip is playing, the channel's playingClipIdx field is
 * mutated each scheduler tick (40Hz) — but that mutation does NOT change
 * which clip is "the playing clip" except at launch transitions. Cells
 * are memoised, so most ticks cause zero ClipCell re-renders. The grid
 * itself does re-render on every sessionVersion bump, but only if its
 * own props (channelIndex) cause it to re-derive — React's reconciler
 * skips children whose props are reference-equal.
 */

import { memo, useCallback, useState }  from 'react';
import { useSessionStore }    from '@/store/daw/useSessionStore';
import { ClipCell, CLIP_CELL_HEIGHT_PX } from './ClipCell';

/** Shared MIME type — matches ClipCell. Keep in sync if either file changes. */
const CLIP_DRAG_MIME = 'application/x-phobos-clip';

/** Total grid height: 2 rows + inter-row gap + outer padding. */
export const CLIP_GRID_HEIGHT_PX = (CLIP_CELL_HEIGHT_PX * 2) + 4 + 4;   // 52px

interface ClipGridProps {
  channelIndex: number;
}

function ClipGridImpl({ channelIndex }: ClipGridProps) {
  // Subscribe to sessionVersion — any mutation upstream re-renders.
  const _v = useSessionStore((s) => s.sessionVersion);                    // eslint-disable-line @typescript-eslint/no-unused-vars
  const session = useSessionStore((s) => s.activeSession);

  // Container-level drag state. Cell-level handlers stopPropagation on drop,
  // so this fires only when the user releases over the container's empty
  // space — i.e. wants to drop the clip into THIS channel without targeting
  // an existing cell. Same channel = no-op; cross channel = copy.
  const [isContainerDragOver, setIsContainerDragOver] = useState(false);

  const onContainerDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(CLIP_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isContainerDragOver) setIsContainerDragOver(true);
  }, [isContainerDragOver]);

  const onContainerDragLeave = useCallback(() => {
    if (isContainerDragOver) setIsContainerDragOver(false);
  }, [isContainerDragOver]);

  const onContainerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsContainerDragOver(false);
    const raw = e.dataTransfer.getData(CLIP_DRAG_MIME);
    if (!raw) return;
    const sep    = raw.indexOf('|');
    const srcCh  = Number(raw.slice(0, sep));
    const srcIdx = Number(raw.slice(sep + 1));
    if (!Number.isInteger(srcCh) || !Number.isInteger(srcIdx)) return;
    if (srcCh === channelIndex) return;                       // same-channel container drop = no-op
    useSessionStore.getState().copyClipToChannel(srcCh, srcIdx, channelIndex);
  }, [channelIndex]);

  if (!session) return null;
  const channel = session.channels[channelIndex];
  if (!channel) return null;

  const clips           = channel.clips;
  const activeClipIdx   = channel.activeClipIdx;
  const armedClipIdx    = channel.armedClipIdx;
  const playingClipIdx  = channel.playingClipIdx;

  const ringClass = isContainerDragOver ? 'ring-2 ring-phobos-amber/80' : '';

  return (
    <div
      className={`flex flex-wrap content-start gap-1 overflow-y-auto scrollbar-hidden px-1 py-0.5 border-t border-border/20 ${ringClass}`}
      style={{ height: CLIP_GRID_HEIGHT_PX }}
      onClick={(e) => e.stopPropagation()}      // don't bubble to header's `select`
      onDragOver={onContainerDragOver}
      onDragLeave={onContainerDragLeave}
      onDrop={onContainerDrop}
    >
      {clips.map((clip, idx) => (
        <ClipCell
          key={clip.id}
          channelIndex={channelIndex}
          clipIndex={idx}
          name={clip.name}
          color={clip.color}
          isActive={idx === activeClipIdx}
          isArmed={idx === armedClipIdx}
          isPlaying={idx === playingClipIdx}
        />
      ))}
    </div>
  );
}

export const ClipGrid = memo(ClipGridImpl);
