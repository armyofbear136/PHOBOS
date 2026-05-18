/**
 * PatternTrackRow.tsx — One pattern row (single step across all channels).
 *
 * Each cell shows the note + octave at `(channelIndex, stepIndex)`, or a
 * dash for empty. Clicking a cell places the editor cursor there. The
 * currently-edited cell gets a green border; the sequencer's playing step
 * (across all channels) is highlighted by StepCursor (separate overlay).
 *
 * Every 4th step is rendered slightly brighter as a beat marker.
 *
 * Memoised per row — only re-renders when its own step's channel contents
 * change, or when this row becomes / stops being the edit row. The song
 * version counter is read at the list level; individual cells subscribe to
 * the editor cursor selectors they need.
 *
 * ── Phase 3 Batch F additions ──────────────────────────────────────────
 *
 *   • Right-click on a cell — instant delete. Clears the event in place
 *     and bumps sessionVersion. If the deleted note's voice is currently
 *     sounding (held by the scheduler), it keeps ringing until the next
 *     event on that channel — cutting it off mid-sustain would be more
 *     jarring than letting it tail.
 *
 *   • Drag-drop within and ACROSS channels — drag a non-empty cell, drop
 *     on another cell to move (or swap if target was non-empty). Cross-
 *     channel drag intentionally re-instruments the note, since channel
 *     and instrument are 1:1 in the session model — that's the user's
 *     intent when they drop a note in a different column.
 *
 * Both ops mutate the channel buffer reference passed in via props. The
 * buffer is the SAME array that the audio scheduler reads from, so changes
 * are picked up on the next tick.
 *
 * KNOWN LIMITATION (documented in Batch D delivery notes): note ENTRY via
 * the keyboard handler still writes through the legacy upstream path
 * (event-add.ts → song.patterns[0].channels[c]). When a non-zero clip is
 * the active clip on a channel, keyboard-entered notes still land in clip
 * 0. Right-click delete and drag-drop here operate on the displayed buffer
 * (channelsScratch[c] in PatternTrackList = active clip's channel) so they
 * work correctly across all clips. Fixing keyboard entry to write through
 * the active clip is upstream-refactor scope, deferred to a follow-up.
 */

import { memo, useState, useCallback } from 'react';
import type { EffluxChannel } from '@/components/audio/engine/model/types/channel';
import { ACTION_NOTE_OFF }    from '@/components/audio/engine/model/types/audio-event';
import { useEditorStore }     from '@/store/daw/useEditorStore';
import { useSessionStore }    from '@/store/daw/useSessionStore';

export const ROW_HEIGHT_PX  = 34;
export const CELL_WIDTH_PX  = 148;

interface PatternTrackRowProps {
  stepIndex:    number;
  channels:     EffluxChannel[];
  /** Channel index that currently holds the editor cursor. */
  selectedChannel: number;
  /** Step index that currently holds the editor cursor (for this row match). */
  selectedStep:    number;
}

/**
 * Drag payload format — channel index and step index of the source cell,
 * pipe-delimited. Pipe is safe (never appears in numeric content).
 */
const DRAG_MIME = 'application/x-phobos-note';

function encodeDragPayload(channelIndex: number, stepIndex: number): string {
  return `${channelIndex}|${stepIndex}`;
}

function decodeDragPayload(s: string): { channelIndex: number; stepIndex: number } | null {
  const [c, st] = s.split('|');
  const ci = Number(c);
  const si = Number(st);
  if (!Number.isInteger(ci) || !Number.isInteger(si)) return null;
  return { channelIndex: ci, stepIndex: si };
}

function formatCell(entry: EffluxChannel[number]): string {
  if (entry === 0 || entry === undefined) return '---';
  if (entry.action === ACTION_NOTE_OFF)   return 'OFF';
  if (!entry.note)                        return '---';
  return `${entry.note}${entry.octave}`;
}

function onCellClick(channelIndex: number, stepIndex: number): void {
  const editor = useEditorStore.getState();
  editor.setSelectedInstrument(channelIndex);
  editor.setSelectedStep(stepIndex);
}

function PatternTrackRowImpl({
  stepIndex, channels, selectedChannel, selectedStep,
}: PatternTrackRowProps) {
  const isBeatMarker = stepIndex % 4 === 0;
  const rowIsEdit    = stepIndex === selectedStep;

  // Track which cell (by channel index) is currently being dragged over,
  // for visual feedback. -1 = no cell highlighted. Local state because
  // it's purely visual and re-renders only this row when changed.
  const [dragOverChannel, setDragOverChannel] = useState<number>(-1);

  const baseBg =
    isBeatMarker ? 'bg-black/60' :
    rowIsEdit    ? 'bg-phobos-green/5' :
                   'bg-black/30';

  const onContextMenu = useCallback((channelIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ch = channels[channelIndex];
    if (!ch) return;
    if (ch[stepIndex] === 0 || ch[stepIndex] === undefined) return;   // already empty
    ch[stepIndex] = 0;                                                  // mutate in place
    useSessionStore.getState().bumpSessionVersion();
  }, [channels, stepIndex]);

  const onDragStart = useCallback((channelIndex: number, e: React.DragEvent) => {
    const ch = channels[channelIndex];
    if (!ch) { e.preventDefault(); return; }
    if (ch[stepIndex] === 0 || ch[stepIndex] === undefined) {
      // Empty cell — nothing to drag.
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData(DRAG_MIME, encodeDragPayload(channelIndex, stepIndex));
    e.dataTransfer.effectAllowed = 'move';
  }, [channels, stepIndex]);

  const onDragOver = useCallback((channelIndex: number, e: React.DragEvent) => {
    // Only accept our own MIME — ignore arbitrary drops (text, files etc.)
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverChannel !== channelIndex) setDragOverChannel(channelIndex);
  }, [dragOverChannel]);

  const onDragLeave = useCallback((channelIndex: number) => {
    if (dragOverChannel === channelIndex) setDragOverChannel(-1);
  }, [dragOverChannel]);

  const onDrop = useCallback((destChannelIdx: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverChannel(-1);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    const src = decodeDragPayload(raw);
    if (!src) return;

    // Same cell — no-op.
    if (src.channelIndex === destChannelIdx && src.stepIndex === stepIndex) return;

    const srcCh  = channels[src.channelIndex];
    const destCh = channels[destChannelIdx];
    if (!srcCh || !destCh) return;
    const srcEvent = srcCh[src.stepIndex];
    if (srcEvent === 0 || srcEvent === undefined) return;   // source vanished

    const targetEvent = destCh[stepIndex];
    // Move (or swap if target non-empty). Cross-channel drag is allowed:
    // moving a note from channel A to channel B intentionally re-instruments
    // it, since channel and instrument are 1:1 in the session model.
    destCh[stepIndex]    = srcEvent;
    srcCh[src.stepIndex] = targetEvent === 0 || targetEvent === undefined ? 0 : targetEvent;
    useSessionStore.getState().bumpSessionVersion();
  }, [channels, stepIndex]);

  return (
    <div
      className={`flex items-center ${baseBg} border-b border-border/10`}
      style={{ height: ROW_HEIGHT_PX }}
    >
      {/* Step number gutter */}
      <div
        className={`w-16 shrink-0 px-2 text-base font-mono text-right border-r border-border/20 tracking-wider ${
          isBeatMarker ? 'text-phobos-green/70' : 'text-muted-foreground/40'
        }`}
      >
        {stepIndex.toString(16).toUpperCase().padStart(2, '0')}
      </div>

      {/* Cells */}
      {channels.map((channel, channelIndex) => {
        if (channelIndex === 0) return null;          // reserved system channel — never surfaced in DAW
        const isEditCell = channelIndex === selectedChannel && stepIndex === selectedStep;
        const cellText   = formatCell(channel[stepIndex]);
        const hasNote    = cellText !== '---' && cellText !== 'OFF';
        const isDragTarget = channelIndex === dragOverChannel;

        const textColor =
          cellText === 'OFF' ? 'text-destructive/70' :
          hasNote            ? 'text-phobos-green/90' :
                               'text-muted-foreground/30';

        const borderColor =
          isDragTarget ? 'border-phobos-amber/80 bg-phobos-amber/10' :
          isEditCell   ? 'border-phobos-green/80 bg-phobos-green/10' :
                         'border-border/15';

        return (
          <button
            key={channelIndex}
            draggable={hasNote}
            onClick={() => onCellClick(channelIndex, stepIndex)}
            onContextMenu={(e) => onContextMenu(channelIndex, e)}
            onDragStart={(e) => onDragStart(channelIndex, e)}
            onDragOver={(e)  => onDragOver(channelIndex, e)}
            onDragLeave={()  => onDragLeave(channelIndex)}
            onDrop={(e)      => onDrop(channelIndex, e)}
            className={`shrink-0 h-full px-3 text-lg font-mono tracking-tight border-r ${borderColor} ${textColor} hover:bg-white/5 transition-colors text-left`}
            style={{ width: CELL_WIDTH_PX }}
            title={
              hasNote
                ? `Ch ${channelIndex} · Step ${stepIndex + 1} — drag to move, right-click to delete`
                : `Ch ${channelIndex} · Step ${stepIndex + 1}`
            }
          >
            {cellText}
          </button>
        );
      })}
    </div>
  );
}

export const PatternTrackRow = memo(PatternTrackRowImpl);
