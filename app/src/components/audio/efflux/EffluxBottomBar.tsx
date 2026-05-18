/**
 * EffluxBottomBar.tsx — Bottom settings strip inside EffluxPanel.
 *
 * Read-only status surface for the active channel (whichever channel the
 * editor cursor is parked on). Per the chain modal session:
 *
 *   • Left:    active-channel context — Ins NN · Name · vol + pan readouts
 *   • Middle:  read-only host chain readout — engine + fx chain pills.
 *              Editing the chain happens in InstrumentChainModal (opens
 *              on double-click of the channel header). The bottom bar is
 *              purely informational — clicking does nothing here.
 *   • Right:   master volume slider — taps AudioService.adjustMasterVolume
 *              which writes to the master bus gain node.
 *
 * The strip is sticky-bottom within EffluxPanel's flex column — shrink-0 so
 * it never collapses when the viewport is short.
 */

import { memo, useCallback, useState, useEffect } from 'react';
import { Volume2 } from 'lucide-react';
import AudioService from '@/components/audio/engine/services/audio-service';
import { useSongStore }     from '@/store/daw/useSongStore';
import { useEditorStore }   from '@/store/daw/useEditorStore';
import { useSessionStore }  from '@/store/daw/useSessionStore';

const STRIP_HEIGHT_PX = 48;

function EffluxBottomBarImpl() {
  const _songVersion    = useSongStore((s) => s.songVersion);             // eslint-disable-line @typescript-eslint/no-unused-vars
  const _sessionVersion = useSessionStore((s) => s.sessionVersion);       // eslint-disable-line @typescript-eslint/no-unused-vars
  const song            = useSongStore((s) => s.activeSong);
  const session         = useSessionStore((s) => s.activeSession);
  const cursorChan      = useEditorStore((s) => s.selectedInstrument);

  const instrument = song?.instruments[cursorChan] ?? null;
  const instName   = instrument?.name || (instrument ? `Ins ${cursorChan}` : '—');

  // Channel 0 is the system chain (Helm + Crystal) — owned by
  // PhobosHostManager, not the session. We surface it as a static readout
  // rather than a chain inspection (the channel-state record on session.0
  // is empty by construction).
  const isSystemChain  = cursorChan === 0;
  const channelState   = session?.channels[cursorChan] ?? null;
  const hostInstrument = channelState?.hostInstrument ?? null;
  const fxChain        = channelState?.fxChain ?? null;

  // Master volume — we read from AudioService (authoritative) but hold a
  // local mirror so the slider drags smoothly. Resync on mount in case
  // another panel changed it.
  const [masterVol, setMasterVol] = useState(() => AudioService.getMasterVolume());
  useEffect(() => {
    setMasterVol(AudioService.getMasterVolume());
  }, []);

  const onMasterVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setMasterVol(v);
    AudioService.adjustMasterVolume(v);
  }, []);

  const volReadout = instrument ? Math.round(instrument.volume * 100) : 0;
  const panReadout =
    !instrument         ? '—' :
    instrument.panning === 0 ? 'C' :
    instrument.panning > 0   ? `R${Math.round(instrument.panning * 100)}` :
                               `L${Math.round(-instrument.panning * 100)}`;

  // Engine label: "Efflux Engine" for WebAudio-driven channels, the host
  // instrument name otherwise. Channel 0 is the locked system chain.
  const engineLabel = isSystemChain
    ? 'System chain'
    : hostInstrument
      ? hostInstrument.name
      : 'Efflux Engine';

  return (
    <div
      className="flex items-center gap-6 px-5 border-t border-border/30 bg-black/80 shrink-0"
      style={{ height: STRIP_HEIGHT_PX }}
    >
      {/* ── Active-channel context ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-xs font-mono text-muted-foreground/40 uppercase tracking-widest shrink-0">
          Active
        </span>
        <span className="text-sm font-mono text-phobos-green/70 shrink-0">
          {cursorChan.toString(16).toUpperCase()}
        </span>
        <span className="text-sm font-terminal text-phobos-green/80 uppercase truncate max-w-[180px]">
          {instName}
        </span>
        <div className="w-px h-4 bg-border/30" />
        <span className="text-xs font-mono text-phobos-green/50 shrink-0">
          V {volReadout}
        </span>
        <span className="text-xs font-mono text-phobos-amber/50 shrink-0">
          P {panReadout}
        </span>
      </div>

      {/* ── Read-only chain readout ───────────────────────────────────────
          Pills mirror the active channel's instrument chain. Editing happens
          in the InstrumentChainModal (double-click the channel header). */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-xs font-mono text-muted-foreground/40 uppercase tracking-widest shrink-0">
          Chain
        </span>

        {/* Engine pill — green for host instrument or Efflux fallback. */}
        <span
          className={`px-2 py-0.5 text-[10px] font-terminal uppercase tracking-tight border rounded-sm shrink-0 ${
            isSystemChain
              ? 'border-border/30 text-muted-foreground/50'
              : hostInstrument
                ? 'border-phobos-green/60 text-phobos-green/90'
                : 'border-border/40 text-muted-foreground/70'
          } ${hostInstrument?.bypassed ? 'opacity-40 line-through' : ''}`}
          title={hostInstrument?.bypassed ? `${engineLabel} (bypassed)` : engineLabel}
        >
          <span className="truncate max-w-[140px] inline-block align-middle">{engineLabel}</span>
        </span>

        {/* FX pills — amber, one per chain entry, in order. Bypassed FX
            render dimmed with a strikethrough. Chain overflow is hidden
            past the available width — the chain modal is the place to see
            the full list. */}
        {fxChain && fxChain.length > 0 && !isSystemChain && (
          <div className="flex items-center gap-1 min-w-0 overflow-hidden">
            {fxChain.map((fx, i) => (
              <span key={`${fx.uid}-${i}`} className="flex items-center gap-1 shrink-0">
                <span className="text-phobos-amber/40 text-xs">→</span>
                <span
                  className={`px-2 py-0.5 text-[10px] font-terminal text-phobos-amber/80 uppercase border border-phobos-amber/40 rounded-sm ${
                    fx.bypassed ? 'opacity-40 line-through' : ''
                  }`}
                  title={fx.bypassed ? `${fx.name} (bypassed)` : fx.name}
                >
                  <span className="truncate max-w-[100px] inline-block align-middle">{fx.name}</span>
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Hint when the channel has no host chain at all (most channels in
            a fresh session). */}
        {!isSystemChain && !hostInstrument && (!fxChain || fxChain.length === 0) && (
          <span className="text-[10px] font-mono text-muted-foreground/30 italic shrink-0">
            (double-click channel header to edit)
          </span>
        )}
      </div>

      {/* ── Master volume ──────────────────────────────────────────────── */}
      <label className="flex items-center gap-2 shrink-0">
        <Volume2 className="w-3.5 h-3.5 text-phobos-green/50" />
        <span className="text-xs font-mono text-muted-foreground/40 uppercase tracking-widest shrink-0">
          Master
        </span>
        <input
          type="range"
          min={0} max={1.5} step={0.01}
          value={masterVol}
          onChange={onMasterVolume}
          className="w-40 accent-phobos-green"
          title={`Master volume ${Math.round(masterVol * 100)}%`}
        />
        <span className="text-xs font-mono text-phobos-green/70 w-10 text-right">
          {Math.round(masterVol * 100)}
        </span>
      </label>
    </div>
  );
}

export const EffluxBottomBar = memo(EffluxBottomBarImpl);
