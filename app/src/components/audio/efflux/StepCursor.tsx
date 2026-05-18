/**
 * StepCursor.tsx — Absolute-positioned playback step indicator.
 *
 * Rendered inside PatternTrackList's scroll container. Shows a thin
 * horizontal highlight bar at the row of the currently-playing step when
 * `playing` is true. The editor cursor (the cell the user is editing) is
 * rendered inline inside each PatternTrackRow — this component only shows
 * the SEQUENCER's cursor, not the editor's.
 *
 * Positioned via transform so the hot path is GPU-composited — no layout
 * thrash as currentStep changes.
 */

import { memo } from 'react';
import { useSequencerStore } from '@/store/daw/useSequencerStore';

interface StepCursorProps {
  /** Height (px) of one step row — must match PatternTrackRow's row height. */
  rowHeight: number;
  /** Left offset (px) — should match the header column width so the bar sits over grid cells. */
  leftOffset: number;
  /** Right edge padding so the bar doesn't overflow. */
  rightPadding?: number;
}

function StepCursorImpl({ rowHeight, leftOffset, rightPadding = 0 }: StepCursorProps) {
  const playing     = useSequencerStore((s) => s.playing);
  const currentStep = useSequencerStore((s) => s.currentStep);

  if (!playing) return null;

  return (
    <div
      aria-hidden
      className="absolute left-0 right-0 pointer-events-none transition-transform will-change-transform"
      style={{
        transform: `translateY(${currentStep * rowHeight}px)`,
        top:       0,
        height:    rowHeight,
      }}
    >
      <div
        className="h-full bg-phobos-green/10 border-y border-phobos-green/40"
        style={{ marginLeft: leftOffset, marginRight: rightPadding }}
      />
    </div>
  );
}

export const StepCursor = memo(StepCursorImpl);
