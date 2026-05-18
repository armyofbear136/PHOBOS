/**
 * PatternTrackList.tsx — The tracker grid (Phase 3).
 *
 * Columns = channels (one per instrument track).
 * Rows    = steps in the SELECTED channel's active clip.
 *
 * Phase 3 changes:
 *   • Reads from useSessionStore.activeSession instead of useSongStore.
 *   • Each channel's column shows that channel's ACTIVE CLIP's notes.
 *     (Q4: "Currently-active clip's editor.") Selecting a different clip
 *     in a channel's ClipGrid changes what its column displays.
 *   • Different channels may have different-length active clips. The grid
 *     row count is the SELECTED channel's active clip step count. Other
 *     channels with longer active clips are visually truncated; channels
 *     with shorter active clips show empty cells beyond their length.
 *     This is the Session 2 gate behavior — full per-cursor-per-channel
 *     visualisation lands in Session 3.
 *
 * Reactivity:
 *   • Subscribes to sessionVersion so any clip mutation (note write, active
 *     clip change, scheduler advance) re-renders.
 *   • The active-clip channel buffers are gathered into a fresh array on
 *     every render — new identity, so downstream PatternTrackRow's React
 *     memo correctly picks up content changes. An earlier version held a
 *     module-level "scratch" array and mutated it in place to avoid the
 *     allocation; that scheme defeated memo (identity-equal array → bail)
 *     and caused stale rows after activeClipIdx changes (drag-copied clips
 *     wouldn't show their notes). One N-element array per session-version
 *     bump (~40Hz during playback, N≈8) is dwarfed by React reconciliation.
 *     Audio-side is unaffected — the scheduler reads the session directly.
 */

import { memo, useCallback, useRef } from 'react';
import type { EffluxChannel }   from '@/components/audio/engine/model/types/channel';
import { useSessionStore }      from '@/store/daw/useSessionStore';
import { useEditorStore }       from '@/store/daw/useEditorStore';
import { ChannelHeader, CHANNEL_HEADER_HEIGHT_PX } from './ChannelHeader';
import { PatternTrackRow, ROW_HEIGHT_PX, CELL_WIDTH_PX } from './PatternTrackRow';
import { StepCursor }           from './StepCursor';

// Fixed layout constants used by StepCursor's positioning math.
const STEP_GUTTER_PX = 64;                       // left-most step-number column

/**
 * Empty-channel sentinel buffer for columns where a channel has no active
 * clip. Single shared reference — its contents NEVER mutate, only zeros.
 * Sized lazily as needed.
 */
const EMPTY_CHANNEL: EffluxChannel = [];
function ensureEmptyChannelLength(steps: number): void {
  if (EMPTY_CHANNEL.length < steps) {
    for (let i = EMPTY_CHANNEL.length; i < steps; i++) EMPTY_CHANNEL[i] = 0;
  }
}

function PatternTrackListImpl() {
  // Subscribe to sessionVersion so any in-place session mutation re-renders.
  const _v = useSessionStore((s) => s.sessionVersion);                    // eslint-disable-line @typescript-eslint/no-unused-vars
  const session = useSessionStore((s) => s.activeSession);
  const selectedStep       = useEditorStore((s) => s.selectedStep);
  const selectedInstrument = useEditorStore((s) => s.selectedInstrument);

  // Scroll-to-selected: stable ref callback. Only fires on first mount of
  // the scroll container; subsequent scrolls are user-driven.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollToSelected = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!node) return;
    const top = selectedStep * ROW_HEIGHT_PX;
    if (top < node.scrollTop || top > node.scrollTop + node.clientHeight - ROW_HEIGHT_PX) {
      node.scrollTop = Math.max(0, top - node.clientHeight / 2);
    }
  }, [selectedStep]);

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-[10px] font-terminal text-muted-foreground/40 uppercase tracking-widest">
        No session loaded
      </div>
    );
  }

  // ── Determine the row count from the SELECTED channel's active clip ──
  // (Session 2 simplification — see file header.)
  const selectedChannel = session.channels[selectedInstrument];
  const selectedClip    = selectedChannel?.clips[selectedChannel.activeClipIdx];
  const rowSteps        = selectedClip?.steps ?? 16;

  ensureEmptyChannelLength(rowSteps);

  // ── Build a fresh per-channel active-clip buffer array. NEW IDENTITY on
  //    every render so PatternTrackRow's memo sees content changes. Cost:
  //    one N-element array allocation per session-version bump.
  const activeChannels: EffluxChannel[] = new Array(session.channels.length);
  for (let c = 0; c < session.channels.length; c++) {
    const ch         = session.channels[c];
    const activeClip = ch.clips[ch.activeClipIdx];
    activeChannels[c] = activeClip ? activeClip.channel : EMPTY_CHANNEL;
  }

  // Visible channel count = session.channels.length - 1 (channel 0 reserved).
  const visibleChannelCount = session.channels.length - 1;
  const gridWidthPx = STEP_GUTTER_PX + visibleChannelCount * CELL_WIDTH_PX;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Channel headers — sticky across horizontal scroll */}
      <div
        className="flex items-stretch border-b border-border/30 bg-black/80 shrink-0"
        style={{ height: CHANNEL_HEADER_HEIGHT_PX, width: gridWidthPx, minWidth: '100%' }}
      >
        <div
          className="w-16 shrink-0 border-r border-border/30 flex items-center justify-center text-sm font-terminal text-muted-foreground/40 uppercase tracking-widest"
        >
          #
        </div>
        {session.channels.map((ch, channelIndex) => {
          if (channelIndex === 0) return null;        // reserved system channel — never surfaced in DAW
          const instrument = session.instruments[ch.instrumentIndex];
          if (!instrument) return null;
          return (
            <ChannelHeader
              key={channelIndex}
              channelIndex={channelIndex}
              instrument={instrument}
              selected={channelIndex === selectedInstrument}
            />
          );
        })}
      </div>

      {/* Scrollable grid */}
      <div ref={scrollToSelected} className="flex-1 overflow-auto relative">
        <div className="relative" style={{ width: gridWidthPx, minWidth: '100%' }}>
          {Array.from({ length: rowSteps }, (_, stepIndex) => (
            <PatternTrackRow
              key={stepIndex}
              stepIndex={stepIndex}
              channels={activeChannels}
              selectedChannel={selectedInstrument}
              selectedStep={selectedStep}
            />
          ))}

          <StepCursor
            rowHeight={ROW_HEIGHT_PX}
            leftOffset={STEP_GUTTER_PX}
          />
        </div>
      </div>
    </div>
  );
}

export const PatternTrackList = memo(PatternTrackListImpl);
