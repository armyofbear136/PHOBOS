/**
 * ChannelHeader.tsx — Per-channel column header with inline quick-edit strip.
 *
 * Layout (top to bottom):
 *   ┌──────────────────────┐
 *   │ 0       M S    [x]   │  index + mute/solo + per-channel enable toggle
 *   │ INSTRUMENT 1         │  name (truncated)
 *   │ V ━━━━━●━━   100     │  volume slider
 *   │ P ━━━●━━━━    C      │  pan slider
 *   │ [ efflux engine    ] │  plugin slot — placeholder until Phase 3 wires VST routing
 *   ├──────────────────────┤
 *   │ ┌─┐┌─┐┌─┐┌+┐         │  CLIP GRID (Phase 3 — 2 rows of clip cells)
 *   │ └─┘└─┘└─┘└─┘         │
 *   └──────────────────────┘
 *
 * Phase 3 additions:
 *   • Per-channel enable toggle in row 1 (right of mute/solo). Disabling
 *     mid-playback lets the current clip finish its loop, then stops
 *     (handled by the audio scheduler at bar boundaries).
 *   • ClipGrid embedded as row 6 — see ClipGrid.tsx for cell semantics.
 *
 * Clicking the header body selects the channel (moves cursor column).
 * Double-click opens the full InstrumentEditor modal. The slider rows use
 * onClick stopPropagation so dragging doesn't bubble up to `select` and
 * hijack the drag gesture.
 *
 * All mutations in-place on the Instrument object, `bumpSongVersion` after,
 * plus `AudioService.adjustInstrumentVolume/Panning` for real-time audible
 * feedback (matches the InstrumentEditor's header binding). The enable
 * toggle mutates session state, not instrument state — see Q3.5 for the
 * mute-vs-enabled distinction.
 */

import { memo, useCallback } from 'react';
import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import AudioService from '@/components/audio/engine/services/audio-service';
import { useSongStore }      from '@/store/daw/useSongStore';
import { useSessionStore }   from '@/store/daw/useSessionStore';
import { useEditorStore }    from '@/store/daw/useEditorStore';
import { useInstrumentChainStore } from '@/store/daw/useInstrumentChainStore';
import { ClipGrid, CLIP_GRID_HEIGHT_PX } from './ClipGrid';

export const CHANNEL_HEADER_WIDTH_PX  = 148;
/** Top section: 5 rows (index, name, vol, pan, plugin) — height locked by upstream UI. */
export const CHANNEL_HEADER_TOP_PX    = 128;
/** Total header height: top section + clip grid. Used by PatternTrackList for the sticky strip. */
export const CHANNEL_HEADER_HEIGHT_PX = CHANNEL_HEADER_TOP_PX + CLIP_GRID_HEIGHT_PX;

interface ChannelHeaderProps {
  channelIndex: number;
  instrument:   Instrument;
  selected:     boolean;
}

function ChannelHeaderImpl({ channelIndex, instrument, selected }: ChannelHeaderProps) {
  // Subscribe to sessionVersion so the enable toggle's visual state and the
  // ClipGrid's internal state stay in sync after mutation.
  const _v = useSessionStore((s) => s.sessionVersion);                    // eslint-disable-line @typescript-eslint/no-unused-vars
  const session = useSessionStore((s) => s.activeSession);
  const channelState   = session?.channels[channelIndex];
  const channelEnabled = channelState?.enabled ?? true;
  // "Waiting to stop": channel was disabled mid-playback but the scheduler
  // hasn't hit the next bar boundary to release it yet. Visual cue is the
  // toggle pulsing — once playingClipIdx returns to -1 the pulse stops.
  const waitingToStop  = !channelEnabled && (channelState?.playingClipIdx ?? -1) >= 0;

  // ── Beat counter ──────────────────────────────────────────────────────
  // Walks the currently-PLAYING clip's beat position when the channel is
  // sounding. Falls back to the ACTIVE clip (the one the user is editing)
  // at beat 1 when nothing's playing — the counter then doubles as a "this
  // is what would play if armed" preview length indicator.
  //
  // beatsInClip = ceil(steps / stepsPerBeat). For a 16-step clip at 4
  // steps/beat that's 4. Partial-beat clips (steps not divisible by
  // stepsPerBeat) round up — the final beat segment plays short.
  //
  // currentBeat advances once per stepsPerBeat scheduler steps. Updates
  // are driven by the sessionVersion bump the scheduler emits each tick.
  const stepsPerBeat = session?.stepsPerBeat ?? 4;
  const playingClip  = channelState && channelState.playingClipIdx >= 0
    ? channelState.clips[channelState.playingClipIdx]
    : null;
  const referenceClip = playingClip
    ?? channelState?.clips[channelState.activeClipIdx ?? 0]
    ?? null;
  const beatsInClip = referenceClip
    ? Math.max(1, Math.ceil(referenceClip.steps / stepsPerBeat))
    : 0;
  const currentBeat = playingClip
    ? Math.floor((channelState?.playingCursor ?? 0) / stepsPerBeat) + 1
    : 1;

  const select = useCallback(() => {
    useEditorStore.getState().setSelectedInstrument(channelIndex);
  }, [channelIndex]);

  const openEditor = useCallback(() => {
    useEditorStore.getState().setSelectedInstrument(channelIndex);
    // Channel 0 is the system chain (host-owned Helm + Crystal) and has no
    // user-editable surface. Double-click is a select-only no-op for it.
    // For channel 1+, the chain modal is the new primary editor — the
    // legacy oscillator/modules/sample editor opens as a drill-in from the
    // chain modal's green-square Edit button.
    if (channelIndex === 0) return;
    useInstrumentChainStore.getState().openFor(channelIndex);
  }, [channelIndex]);

  const toggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    instrument.muted = !instrument.muted;
    useSongStore.getState().bumpSongVersion();
  }, [instrument]);

  const toggleSolo = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    instrument.solo = !instrument.solo;
    useSongStore.getState().bumpSongVersion();
  }, [instrument]);

  const addClip = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().addClip(channelIndex);
  }, [channelIndex]);

  const toggleEnabled = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useSessionStore.getState().setChannelEnabled(channelIndex, !channelEnabled);
  }, [channelIndex, channelEnabled]);

  const onVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    instrument.volume = v;
    AudioService.adjustInstrumentVolume(channelIndex, v);
    useSongStore.getState().bumpSongVersion();
  }, [instrument, channelIndex]);

  const onPan = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    instrument.panning = v;
    AudioService.adjustInstrumentPanning(channelIndex, v);
    useSongStore.getState().bumpSongVersion();
  }, [instrument, channelIndex]);

  // Swallow clicks on slider/plugin rows so they don't bubble up to `select`.
  const stopBubble = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  const borderColor = selected ? 'border-phobos-green/60' : 'border-border/20';
  const textColor   = selected ? 'text-phobos-green/90'   : 'text-muted-foreground/60';

  const volPct   = Math.round(instrument.volume * 100);
  const panLabel =
    instrument.panning === 0 ? 'C' :
    instrument.panning > 0   ? `R${Math.round(instrument.panning * 100)}` :
                               `L${Math.round(-instrument.panning * 100)}`;

  return (
    <div
      onClick={select}
      onDoubleClick={openEditor}
      className={`shrink-0 border-r ${borderColor} bg-black/40 flex flex-col cursor-pointer select-none transition-colors hover:bg-black/60`}
      style={{ width: CHANNEL_HEADER_WIDTH_PX, height: CHANNEL_HEADER_HEIGHT_PX }}
      title="Double-click to edit instrument (Ctrl+E)"
    >
      {/* Top section — 5 rows, fixed 128px */}
      <div className="flex flex-col gap-1 px-3 py-2" style={{ height: CHANNEL_HEADER_TOP_PX }}>
        {/* Row 1: index + mute/solo + enable */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-mono text-muted-foreground/40 uppercase">
            {channelIndex.toString(16).toUpperCase()}
          </span>
          <div className="flex gap-1">
            <button
              onClick={toggleMute}
              className={`px-1.5 py-0.5 text-xs font-terminal uppercase rounded-sm border transition-colors ${
                instrument.muted
                  ? 'border-destructive/60 text-destructive bg-destructive/10'
                  : 'border-border/30 text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title="Mute"
            >M</button>
            <button
              onClick={toggleSolo}
              className={`px-1.5 py-0.5 text-xs font-terminal uppercase rounded-sm border transition-colors ${
                instrument.solo
                  ? 'border-phobos-amber/60 text-phobos-amber bg-phobos-amber/10'
                  : 'border-border/30 text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title="Solo"
            >S</button>
            <button
              onClick={toggleEnabled}
              className={`px-1.5 py-0.5 text-[10px] font-mono uppercase rounded-sm border transition-colors min-w-[2.25rem] tabular-nums ${
                waitingToStop
                  ? 'border-destructive/60 text-destructive bg-destructive/10 animate-pulse'
                  : playingClip
                    ? 'border-phobos-green/60 text-phobos-green bg-phobos-green/10'
                    : 'border-border/30 text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title={
                waitingToStop ? 'Stopping at next bar boundary' :
                playingClip   ? `Playing — beat ${currentBeat}/${beatsInClip}. Click to disable.` :
                channelEnabled ? `Idle — ${beatsInClip || '–'} beats. Click to disable channel.` :
                                 'Channel disabled — click to enable'
              }
            >{waitingToStop ? '◌' : beatsInClip > 0 ? `${currentBeat}/${beatsInClip}` : '–'}</button>
          </div>
        </div>

        {/* Row 2: name */}
        <span
          className={`text-sm font-terminal uppercase tracking-tight truncate ${textColor}`}
          title={instrument.name}
        >
          {instrument.name || `Ins ${channelIndex}`}
        </span>

        {/* Row 3: volume */}
        <div className="flex items-center gap-1.5" onClick={stopBubble}>
          <span className="text-[9px] font-terminal text-muted-foreground/50 uppercase w-4 shrink-0">V</span>
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={instrument.volume}
            onChange={onVolume}
            className="flex-1 min-w-0 h-1 accent-phobos-green"
            title={`Volume ${volPct}%`}
          />
          <span className="text-[9px] font-mono text-phobos-green/60 w-7 text-right shrink-0">{volPct}</span>
        </div>

        {/* Row 4: pan */}
        <div className="flex items-center gap-1.5" onClick={stopBubble}>
          <span className="text-[9px] font-terminal text-muted-foreground/50 uppercase w-4 shrink-0">P</span>
          <input
            type="range"
            min={-1} max={1} step={0.01}
            value={instrument.panning}
            onChange={onPan}
            className="flex-1 min-w-0 h-1 accent-phobos-amber"
            title={`Pan ${panLabel}`}
          />
          <span className="text-[9px] font-mono text-phobos-amber/60 w-7 text-right shrink-0">{panLabel}</span>
        </div>

        {/* Row 5: Add-a-clip action.
            Replaces the Phase 4 plugin slot placeholder — the action lives
            here because it's the highest-frequency channel-level operation
            during session authoring (more frequent than mute/solo). The
            dashed-border treatment matches the prior plugin-slot pill so
            the channel column's vocabulary stays consistent. */}
        <button
          onClick={addClip}
          className="mt-auto px-1.5 py-0.5 text-[9px] font-terminal text-white/80 uppercase tracking-tight border border-dashed border-border/40 rounded-sm flex items-center justify-center gap-1.5 hover:text-phobos-green hover:border-phobos-green/60 transition-colors"
          title="Add a new clip to this channel"
        >
          <span className="truncate">Add a clip</span>
          <span className="text-[12px] leading-none font-mono shrink-0">+</span>
        </button>
      </div>

      {/* Row 6: clip grid (Phase 3) */}
      <ClipGrid channelIndex={channelIndex} />
    </div>
  );
}

export const ChannelHeader = memo(ChannelHeaderImpl);
