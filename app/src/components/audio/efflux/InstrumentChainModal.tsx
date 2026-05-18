/**
 * InstrumentChainModal.tsx — Per-channel instrument chain editor.
 *
 * Opens on double-click of a channel header. Three rows:
 *
 *   Row 1 — Header. Editable channel name + subtext.
 *
 *   Row 2 — Chain. Two visually distinct halves (one column, two regions):
 *     • Left ~1/8: GREEN instrument square. Locked position. Click to
 *       set browser mode = 'instrument'.
 *     • Right ~7/8: AMBER FX rail. Squares chained left-to-right with a
 *       trailing "+ Add FX" dashed square. Horizontal scroll past 7
 *       visible squares. Click anywhere in this region → browser mode = 'fx'.
 *     Each FX square has a hover-revealed × in the corner; dragging an
 *     FX square out of the modal also removes it. Beneath each FX square:
 *     a Bypass toggle, then an Edit button. Beneath the instrument square:
 *     just an Edit button.
 *
 *   Row 3 — Browser. Blue-shrouded, double-height grid (8 × 2 = 16 visible).
 *     Filtered by browserMode. Squares are draggable to row 2 (append /
 *     insert / replace via drop targets). Double-click to commit at the
 *     end of the chain (instruments) or as the next FX (effects).
 *
 * Persistence: every commit goes through daw-host-bridge, which loads the
 * plugin on PhobosHost and mutates the session store on success. The store
 * dirty flag triggers the existing save path. No new persistence code.
 *
 * Drag-and-drop wire contracts (permanent):
 *   • application/x-phobos-plugin-browser : payload "<source>:<basename>"
 *     — used by row 3 → row 2 drops.
 *   • application/x-phobos-fx-chain       : payload "<channelIdx>|<fxIndex>"
 *     — used by row 2 → row 2 reorder and row 2 → outside removal.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, Pencil, Power, RefreshCw, Loader2 } from 'lucide-react';
import { useSongStore }            from '@/store/daw/useSongStore';
import { useSessionStore }         from '@/store/daw/useSessionStore';
import { usePluginsStore }         from '@/store/daw/usePluginsStore';
import { useInstrumentChainStore } from '@/store/daw/useInstrumentChainStore';
import { useInstrumentStore }      from '@/store/daw/useInstrumentStore';
import {
  setHostInstrument,
  appendFx,
  removeFx,
  reorderFx,
  insertFx,
  replaceFx,
  setBypassed,
  pluginEntryToRef,
  getInstrumentSlotId,
  getFxSlotId,
} from '@/components/audio/engine/services/daw-host-bridge';
import { showPluginUi } from '@/components/audio/services/DawApi';
import type { PluginRef }    from '@/components/audio/engine/model/types/session';
import type { PluginEntry }  from '@/components/audio/services/DawApi';

// ── Wire contracts (permanent — see file header) ────────────────────────────

const MIME_BROWSER = 'application/x-phobos-plugin-browser';
const MIME_CHAIN   = 'application/x-phobos-fx-chain';

// ── Failure surfacing ────────────────────────────────────────────────────────
//
// Chain mutations dispatch to PhobosHost, which can fail in several ways:
//   • Plugin file not found (user moved it after scan).
//   • Plugin instantiation failed (broken bundle, wrong arch).
//   • Host crashed mid-call.
//   • Plugin loaded but rejected the requested kind (e.g., user dropped an
//     instrument into the FX rail).
// All are recoverable from the UI's perspective — the schema/store wasn't
// mutated since the bridge calls host first. We surface a toast describing
// the operation that failed; the host's own error message goes to console
// for diagnostics. Errors that aren't user-actionable (e.g. transient host
// blips) appear and dismiss; the user can retry.

function surfaceFailure(action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${action} failed`, err);
  toast.error(`${action} failed`, { description: message });
}

// ── Layout constants ─────────────────────────────────────────────────────────
//
// Modal: 60vw × 60vh (matches user request — "really use up a lot of the
// square footage"). Row heights tuned so row 2 fits one square + label +
// bypass + edit; row 3 fits two stacked squares with name labels.
//
// Square ratios — row 2 instrument is fixed-width = ~1/8 of chain area; FX
// rail occupies the remaining 7/8 with 7 squares visible at default modal
// width (~60vw on a 1920px display ≈ 1152px modal width; chain area ≈ 1100px
// after padding; instrument occupies ~140px; remaining ~960px hosts 7×~135px
// FX squares with gaps). These are tuned by eye and may need shimming after
// you see them on real devices.

const SQUARE_PX        = 172;        // chain row squares — large, prominent click targets
const BROWSER_SQUARE_PX = 124;        // browser row — slightly smaller (two stacked rows)
const CHAIN_LINK_PX    = 14;
const PSEUDO_FX_GAP_PX = 4;

// ── Synthetic Efflux Engine entry ────────────────────────────────────────────
//
// "Efflux Engine" isn't a host plugin — it's the WebAudio synth path. Showing
// it as the green-square default when channel.hostInstrument === null gives
// the user a stable "what's currently driving this channel" readout that
// matches the bottom-bar readout.

const EFFLUX_ENGINE_LABEL = 'Efflux Engine';

// ── Plugin classification ────────────────────────────────────────────────────
//
// Authoritative answer comes from the host's deep-probe (PluginEntry.
// isInstrument, populated when scanState === 'deep'). For shallow entries
// (host hasn't probed yet, or probe failed) we fall back to the category
// string heuristic — which works for plugins that ship moduleinfo.json
// but misses older / barebones bundles. Shallow rows are re-probed on
// every backend list(), so this fallback only matters during the first
// page load against a fresh duckdb cache.

function isInstrumentPlugin(p: { category: string; isInstrument: boolean; scanState: 'shallow' | 'deep' }): boolean {
  if (p.scanState === 'deep') return p.isInstrument;
  return p.category.startsWith('Instrument');
}

// ── Modal ────────────────────────────────────────────────────────────────────

function InstrumentChainModalImpl() {
  const open        = useInstrumentChainStore((s) => s.open);
  const close       = useInstrumentChainStore((s) => s.close);
  const channelIdx  = useInstrumentChainStore((s) => s.channelIdx);
  const browserMode = useInstrumentChainStore((s) => s.browserMode);
  const setBrowser  = useInstrumentChainStore((s) => s.setBrowserMode);

  const _sessionVersion = useSessionStore((s) => s.sessionVersion);       // eslint-disable-line @typescript-eslint/no-unused-vars
  const _songVersion    = useSongStore((s) => s.songVersion);             // eslint-disable-line @typescript-eslint/no-unused-vars
  const session         = useSessionStore((s) => s.activeSession);
  const song            = useSongStore((s) => s.activeSong);

  const channel    = session?.channels[channelIdx] ?? null;
  const instrument = song?.instruments[channelIdx] ?? null;
  // Plugin catalog — load on first open if not already loaded.
  const phobosPlugins = usePluginsStore((s) => s.phobos);
  const systemPlugins = usePluginsStore((s) => s.system);
  const pluginsLoaded = usePluginsStore((s) => s.loaded);
  const pluginsError  = usePluginsStore((s) => s.error);
  const pluginsLoading = usePluginsStore((s) => s.loading);
  const loadIfStale   = usePluginsStore((s) => s.loadIfStale);
  const refreshPlugins = usePluginsStore((s) => s.refresh);
  useEffect(() => {
    if (open) loadIfStale();
  }, [open, loadIfStale]);

  // ── Pending state for chain mutations ───────────────────────────────────
  //
  // Bridge ops are async — host RPC + plugin instantiation can take a few
  // hundred ms for system VST3s. The user clicks/drops, then sees nothing
  // change for a beat, which feels broken even when it's working. We mark
  // a target slot pending the moment the bridge call dispatches, render a
  // spinner overlay on that slot, and clear when the call resolves. State
  // is local — no need to persist across renders.
  //
  // Discriminated by 'kind':
  //   'instrument'   — the green square is mutating (load/replace/clear).
  //   'fx'           — an existing fx position at fxIndex is mutating
  //                    (replace, bypass toggle, remove). The square at that
  //                    chain position renders the spinner.
  //   'fx-add'       — the trailing "+ Add FX" slot is loading a new FX
  //                    (append/insert at end). The dashed slot renders the
  //                    spinner.
  //   'fx-insert'    — a gap-insert is in flight; we don't visually
  //                    distinguish from 'fx-add' because the visual cue is
  //                    "something new is appearing in the chain."
  type PendingSlot =
    | { kind: 'instrument' }
    | { kind: 'fx'; fxIndex: number }
    | { kind: 'fx-add' }
    | { kind: 'fx-insert' };

  const [pending, setPending] = useState<PendingSlot | null>(null);

  /**
   * Wrap an async bridge call with pending-state lifecycle. The pending
   * marker is set immediately and cleared in the finally block so it
   * resolves regardless of success/failure. Errors are surfaced through
   * the existing surfaceFailure path; pending state is purely visual.
   */
  const withPending = useCallback(
    async (slot: PendingSlot, action: string, fn: () => Promise<void>): Promise<void> => {
      setPending(slot);
      try {
        await fn();
      } catch (err) {
        surfaceFailure(action, err);
      } finally {
        setPending(null);
      }
    },
    [],
  );

  // Row 2 chain mutations ─────────────────────────────────────────────────────

  const onEditInstrument = useCallback(async () => {
    // Efflux Engine drill-in: open the legacy oscillator/modules/sample editor.
    // We deliberately leave the chain modal mounted so closing the legacy
    // editor returns the user here. The legacy editor is z-60 (vs our z-40)
    // so it stacks correctly.
    if (!channel?.hostInstrument) {
      useInstrumentStore.getState().openEditor(channelIdx);
      return;
    }
    // Host instrument: open its native UI via the engine. Native window
    // lives outside the React tree, so the modal stays open behind it.
    try {
      const slotId = getInstrumentSlotId(channelIdx);
      if (slotId !== null) await showPluginUi(slotId);
    } catch (err) {
      surfaceFailure('Open plugin UI', err);
    }
  }, [channel, channelIdx]);

  const onEditFx = useCallback(async (fxIndex: number) => {
    try {
      const slotId = getFxSlotId(channelIdx, fxIndex);
      if (slotId !== null) await showPluginUi(slotId);
    } catch (err) {
      surfaceFailure('Open plugin UI', err);
    }
  }, [channelIdx]);

  const onBypassInstrument = useCallback(async () => {
    if (!channel?.hostInstrument) return;
    const next = !channel.hostInstrument.bypassed;
    await withPending({ kind: 'instrument' }, 'Toggle bypass',
      () => setBypassed(channelIdx, 'instrument', next));
  }, [channel, channelIdx, withPending]);

  const onBypassFx = useCallback(async (fxIndex: number) => {
    const fx = channel?.fxChain[fxIndex];
    if (!fx) return;
    const next = !fx.bypassed;
    await withPending({ kind: 'fx', fxIndex }, 'Toggle bypass',
      () => setBypassed(channelIdx, fxIndex, next));
  }, [channel, channelIdx, withPending]);

  const onRemoveFx = useCallback(async (fxIndex: number) => {
    await withPending({ kind: 'fx', fxIndex }, 'Remove effect',
      () => removeFx(channelIdx, fxIndex));
  }, [channelIdx, withPending]);

  const onClearInstrument = useCallback(async () => {
    await withPending({ kind: 'instrument' }, 'Clear instrument',
      () => setHostInstrument(channelIdx, null));
  }, [channelIdx, withPending]);

  // Row 2 ↔ Row 3 — drag/drop & double-click commit ──────────────────────────

  const onBrowserDoubleClick = useCallback(async (p: PluginEntry) => {
    if (browserMode === 'instrument') {
      await withPending({ kind: 'instrument' }, 'Set instrument',
        () => setHostInstrument(channelIdx, pluginEntryToRef(p)));
    } else {
      await withPending({ kind: 'fx-add' }, 'Add effect',
        () => appendFx(channelIdx, pluginEntryToRef(p)));
    }
  }, [channelIdx, browserMode, withPending]);

  // Drop handlers — a small set of named handlers below. The shape is:
  //   onDropAtChainEnd   — append (dashed +Add FX square, or empty rail)
  //   onDropOnFxSquare   — replace at index
  //   onDropBetweenFx    — insert at index
  //   onDropOnInstrument — replace instrument
  //   onDropOutsideChain — remove (drag chain entry outside the row 2 area)

  const onDropAtChainEnd = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const browserUid = e.dataTransfer.getData(MIME_BROWSER);
    if (browserUid) {
      const entry = findEntryByUid(browserUid, phobosPlugins, systemPlugins);
      if (entry) {
        await withPending({ kind: 'fx-add' }, 'Add effect',
          () => appendFx(channelIdx, pluginEntryToRef(entry)));
      }
      return;
    }
    const chainPayload = e.dataTransfer.getData(MIME_CHAIN);
    if (chainPayload && channel) {
      const [chStr, idxStr] = chainPayload.split('|');
      const fromIdx = Number(idxStr);
      if (Number(chStr) === channelIdx && Number.isInteger(fromIdx)) {
        const lastIdx = channel.fxChain.length - 1;
        if (fromIdx !== lastIdx) {
          await withPending({ kind: 'fx', fxIndex: fromIdx }, 'Reorder effect',
            () => reorderFx(channelIdx, fromIdx, lastIdx));
        }
      }
    }
  }, [channelIdx, phobosPlugins, systemPlugins, channel, withPending]);

  const onDropOnFxSquare = useCallback(async (targetIdx: number, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const browserUid = e.dataTransfer.getData(MIME_BROWSER);
    if (browserUid) {
      const entry = findEntryByUid(browserUid, phobosPlugins, systemPlugins);
      if (entry) {
        await withPending({ kind: 'fx', fxIndex: targetIdx }, 'Replace effect',
          () => replaceFx(channelIdx, targetIdx, pluginEntryToRef(entry)));
      }
      return;
    }
    const chainPayload = e.dataTransfer.getData(MIME_CHAIN);
    if (chainPayload) {
      const [chStr, idxStr] = chainPayload.split('|');
      const fromIdx = Number(idxStr);
      if (Number(chStr) === channelIdx && Number.isInteger(fromIdx) && fromIdx !== targetIdx) {
        await withPending({ kind: 'fx', fxIndex: targetIdx }, 'Reorder effect',
          () => reorderFx(channelIdx, fromIdx, targetIdx));
      }
    }
  }, [channelIdx, phobosPlugins, systemPlugins, withPending]);

  const onDropBetweenFx = useCallback(async (insertAt: number, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const browserUid = e.dataTransfer.getData(MIME_BROWSER);
    if (browserUid) {
      const entry = findEntryByUid(browserUid, phobosPlugins, systemPlugins);
      if (entry) {
        await withPending({ kind: 'fx-insert' }, 'Insert effect',
          () => insertFx(channelIdx, insertAt, pluginEntryToRef(entry)));
      }
      return;
    }
    const chainPayload = e.dataTransfer.getData(MIME_CHAIN);
    if (chainPayload) {
      const [chStr, idxStr] = chainPayload.split('|');
      const fromIdx = Number(idxStr);
      if (Number(chStr) === channelIdx && Number.isInteger(fromIdx)) {
        // Reordering: a drop "between i and i+1" is equivalent to reorder
        // toIdx = insertAt; if dragging from before the gap, toIdx adjusts
        // down by 1 because the source is removed first.
        const toIdx = fromIdx < insertAt ? insertAt - 1 : insertAt;
        if (toIdx !== fromIdx) {
          await withPending({ kind: 'fx', fxIndex: fromIdx }, 'Reorder effect',
            () => reorderFx(channelIdx, fromIdx, toIdx));
        }
      }
    }
  }, [channelIdx, phobosPlugins, systemPlugins, withPending]);

  const onDropOnInstrument = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const browserUid = e.dataTransfer.getData(MIME_BROWSER);
    if (!browserUid) return;
    const entry = findEntryByUid(browserUid, phobosPlugins, systemPlugins);
    if (!entry || !isInstrumentPlugin(entry)) return;     // fx dropped on instrument: ignore
    await withPending({ kind: 'instrument' }, 'Set instrument',
      () => setHostInstrument(channelIdx, pluginEntryToRef(entry)));
  }, [channelIdx, phobosPlugins, systemPlugins, withPending]);

  // Drag-out removal — when a chain FX is dragged and dropped OUTSIDE the
  // row 2 chain area (anywhere on the modal backdrop or row 1/3), remove it.
  // We detect this by hooking onDragEnd on the FX square and checking
  // dropEffect. If it was dropped on a target that called preventDefault
  // (a real drop target), dropEffect is 'move'; otherwise it stays 'none'.
  const onChainDragEnd = useCallback(async (fromIdx: number, e: React.DragEvent) => {
    if (e.dataTransfer.dropEffect === 'none') {
      await withPending({ kind: 'fx', fxIndex: fromIdx }, 'Remove effect',
        () => removeFx(channelIdx, fromIdx));
    }
  }, [channelIdx, withPending]);

  // ── Render guards ────────────────────────────────────────────────────────

  if (!open || !channel || !song) return null;

  // Defensive defaults for pre-schema in-memory channels. Persisted sessions
  // always supply both fields (parser fills defaults at v1), but live
  // sessions migrated from XTK or constructed before the schema additions
  // landed may have undefined fields. Treat as "WebAudio-driven, no FX".
  const hostInstrument = channel.hostInstrument ?? null;
  const fxChain        = channel.fxChain        ?? [];

  // Filter the catalog by browserMode. Both source lists are tiny; per-render
  // filter is fine and avoids memo overhead.
  const allPlugins      = phobosPlugins.concat(systemPlugins);
  const filteredPlugins = browserMode === 'instrument'
    ? allPlugins.filter(isInstrumentPlugin)
    : allPlugins.filter((p) => !isInstrumentPlugin(p));

  const titleValue = instrument?.name ?? `Instrument ${channelIdx}`;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/75"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-background border border-phobos-green/30 rounded-sm shadow-2xl flex flex-col"
        style={{ width: '72vw', height: '76vh', minWidth: 1080, minHeight: 820 }}
      >
        {/* ── ROW 1 — Header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border/30 shrink-0">
          <div className="flex-1 min-w-0">
            <input
              value={titleValue}
              onChange={(e) => {
                if (instrument) {
                  instrument.name = e.target.value;
                  useSongStore.getState().bumpSongVersion();
                }
              }}
              className="w-full bg-transparent text-2xl font-terminal uppercase tracking-tight text-phobos-green/95 border-none focus:outline-none focus:bg-black/40 focus:ring-1 focus:ring-phobos-green/30 rounded-sm px-1"
              placeholder={`Instrument ${channelIdx}`}
            />
            <p className="mt-1.5 text-[11px] font-mono text-muted-foreground/60 leading-snug">
              The instrument chain is what drives this channel. Pick a synth (green) on the left, then add effects (amber) in order from left to right — signal flows down the chain into your mix. Drag plugins from the browser below to add. Drag a slot out of the chain to remove. Bypass keeps a slot in place but skips its processing.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { void refreshPlugins(); }}
              disabled={pluginsLoading}
              className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-terminal uppercase tracking-widest border border-phobos-blue/40 rounded-sm text-phobos-blue/80 hover:border-phobos-blue/70 hover:text-phobos-blue/95 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Rescan plugins — re-walk filesystem, deep-probe new VST3s"
            >
              <RefreshCw className={`w-3 h-3 ${pluginsLoading ? 'animate-spin' : ''}`} />
              {pluginsLoading ? 'Scanning' : 'Rescan'}
            </button>
            <button
              onClick={close}
              className="p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── ROW 2 — Chain ───────────────────────────────────────────────── */}
        <div className="flex gap-3 px-6 py-5 border-b border-border/30 shrink-0">

          {/* Instrument half — clickable region that switches browser mode.
              Frosted-glass styling: a higher-tint background and inner blur
              telegraph that this whole panel is interactive, not a passive
              border. Hover lifts the border, click selects (highlighted
              by the active-mode branch). */}
          <div
            onClick={() => setBrowser('instrument')}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(MIME_BROWSER)) e.preventDefault();
            }}
            onDrop={onDropOnInstrument}
            className={`shrink-0 rounded-sm border-2 transition-all cursor-pointer backdrop-blur-sm ${
              browserMode === 'instrument'
                ? 'border-phobos-green/80 bg-phobos-green/[0.10] shadow-[0_0_24px_rgba(0,255,0,0.08)_inset]'
                : 'border-phobos-green/40 bg-phobos-green/[0.05] hover:border-phobos-green/65 hover:bg-phobos-green/[0.08]'
            }`}
            style={{ padding: 14 }}
            title="Click to browse instruments below"
          >
            <SquareCard
              accent="green"
              label={hostInstrument?.name ?? EFFLUX_ENGINE_LABEL}
              bypassed={hostInstrument?.bypassed ?? false}
              isHostBacked={hostInstrument !== null}
              size={SQUARE_PX}
              loading={pending?.kind === 'instrument'}
              onEdit={onEditInstrument}
              onBypass={null}                              // instruments don't bypass
              onClear={hostInstrument ? onClearInstrument : null}
            />
          </div>

          {/* FX half — same frosted-glass treatment with amber tint. */}
          <div
            onClick={() => setBrowser('fx')}
            className={`flex-1 min-w-0 rounded-sm border-2 transition-all cursor-pointer backdrop-blur-sm ${
              browserMode === 'fx'
                ? 'border-phobos-amber/70 bg-phobos-amber/[0.08] shadow-[0_0_24px_rgba(255,176,46,0.06)_inset]'
                : 'border-phobos-amber/35 bg-phobos-amber/[0.04] hover:border-phobos-amber/55 hover:bg-phobos-amber/[0.06]'
            }`}
            style={{ padding: 14 }}
            title="Click to browse effects below"
          >
            <div className="flex items-stretch gap-0 overflow-x-auto h-full">
              {fxChain.map((fx, i) => (
                <div key={`${fx.uid}-${i}`} className="flex items-center shrink-0">
                  {/* Gap-drop target BEFORE this square. */}
                  <DropGap onDrop={(e) => onDropBetweenFx(i, e)} />

                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(MIME_CHAIN, `${channelIdx}|${i}`);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={(e) => onChainDragEnd(i, e)}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes(MIME_BROWSER) ||
                          e.dataTransfer.types.includes(MIME_CHAIN)) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => onDropOnFxSquare(i, e)}
                  >
                    <SquareCard
                      accent="amber"
                      label={fx.name}
                      bypassed={fx.bypassed}
                      isHostBacked={true}
                      size={SQUARE_PX}
                      loading={pending?.kind === 'fx' && pending.fxIndex === i}
                      onEdit={() => onEditFx(i)}
                      onBypass={() => onBypassFx(i)}
                      onClear={() => onRemoveFx(i)}
                    />
                  </div>
                </div>
              ))}

              {/* Trailing add-square — also serves as end-of-chain drop target. */}
              <div className="flex items-center shrink-0">
                {/* Gap-drop AFTER the last square (or before the add square). */}
                {fxChain.length > 0 && (
                  <DropGap onDrop={(e) => onDropBetweenFx(fxChain.length, e)} />
                )}
                <div
                  onClick={(e) => { e.stopPropagation(); setBrowser('fx'); }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(MIME_BROWSER) ||
                        e.dataTransfer.types.includes(MIME_CHAIN)) {
                      e.preventDefault();
                    }
                  }}
                  onDrop={onDropAtChainEnd}
                  className="relative flex flex-col items-center justify-center text-center border border-dashed border-phobos-amber/40 rounded-sm hover:border-phobos-amber/70 hover:text-phobos-amber/90 text-phobos-amber/50 cursor-pointer transition-colors"
                  style={{
                    width:  SQUARE_PX,
                    height: SQUARE_PX,
                  }}
                  title="Add an effect — drop a plugin here, or pick from the browser"
                >
                  <span className={`text-3xl font-mono leading-none ${pending?.kind === 'fx-add' || pending?.kind === 'fx-insert' ? 'opacity-30' : ''}`}>+</span>
                  <span className={`mt-2 text-[9px] font-terminal uppercase tracking-widest ${pending?.kind === 'fx-add' || pending?.kind === 'fx-insert' ? 'opacity-30' : ''}`}>
                    Add FX
                  </span>
                  {(pending?.kind === 'fx-add' || pending?.kind === 'fx-insert') && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[1px] rounded-sm pointer-events-none">
                      <Loader2 className="w-8 h-8 animate-spin text-phobos-amber/80" />
                    </div>
                  )}
                </div>
                {/* Reserve vertical space so the rail height matches a card
                    (which has buttons below). */}
                <div style={{ width: 0, height: SQUARE_PX + 56 }} />
              </div>
            </div>
          </div>
        </div>

        {/* ── ROW 3 — Browser ────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 px-6 py-5 flex flex-col">
          <div className="flex items-center gap-3 mb-3 shrink-0">
            <span className="text-[10px] font-terminal text-phobos-blue/70 uppercase tracking-widest">
              Browser —{' '}
              <span className={browserMode === 'instrument' ? 'text-phobos-green/80' : 'text-phobos-amber/80'}>
                {browserMode === 'instrument' ? 'Instruments' : 'Effects'}
              </span>
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/40">
              {filteredPlugins.length} available · click {browserMode === 'instrument' ? 'instrument' : 'effect'} half above to switch
            </span>
          </div>

          {/* Floor the browser at exactly two rows of squares + their padding +
              container padding + a little breathing room so the second row is
              never visually squeezed against the bottom border. */}
          <div
            className="flex-1 rounded-sm border-2 border-phobos-blue/40 bg-phobos-blue/[0.05] backdrop-blur-sm p-3 overflow-hidden"
            style={{ minHeight: BROWSER_SQUARE_PX * 2 + 60 }}
          >
            {pluginsError && (
              <div className="px-3 py-2 text-[10px] font-mono text-destructive/80">
                {pluginsError}
              </div>
            )}

            {!pluginsLoaded && !pluginsError && (
              <div className="px-3 py-2 text-[10px] font-terminal text-muted-foreground/50 uppercase tracking-widest">
                Scanning plugins…
              </div>
            )}

            {pluginsLoaded && filteredPlugins.length === 0 && (
              <div className="px-3 py-2 text-[10px] font-mono text-muted-foreground/40 italic">
                {browserMode === 'instrument'
                  ? 'No instrument plugins discovered. Run fetch scripts or check your VST3 path.'
                  : 'No effect plugins discovered.'}
              </div>
            )}

            {pluginsLoaded && filteredPlugins.length > 0 && (
              <div
                className="grid grid-flow-col h-full overflow-x-auto auto-cols-min"
                style={{
                  gridTemplateRows: `repeat(2, ${BROWSER_SQUARE_PX}px)`,
                  gap: 12,
                }}
              >
                {filteredPlugins.map((p) => (
                  <BrowserCard
                    key={p.id}
                    entry={p}
                    size={BROWSER_SQUARE_PX}
                    onDoubleClick={() => { void onBrowserDoubleClick(p); }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const InstrumentChainModal = memo(InstrumentChainModalImpl);

// ── SquareCard — used for both the green instrument and amber FX slots ─────

interface SquareCardProps {
  accent:       'green' | 'amber';
  label:        string;
  bypassed:     boolean;
  isHostBacked: boolean;
  size:         number;
  /** When true, the square is locked + overlaid with a spinner; clicks blocked. */
  loading:      boolean;
  onEdit:       (() => void)        | null;
  onBypass:     (() => void)        | null;
  onClear:      (() => void)        | null;
}

function SquareCard(props: SquareCardProps) {
  const { accent, label, bypassed, isHostBacked, size, loading, onEdit, onBypass, onClear } = props;

  const borderClass = accent === 'green'
    ? 'border-phobos-green/70 bg-phobos-green/[0.18]'
    : 'border-phobos-amber/70 bg-phobos-amber/[0.16]';
  const textClass = accent === 'green'
    ? 'text-phobos-green/90'
    : 'text-phobos-amber/90';

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      {/* Square */}
      <div
        className={`group relative rounded-sm border ${borderClass} ${textClass} flex items-center justify-center text-center transition-opacity ${
          bypassed ? 'opacity-40' : 'opacity-100'
        }`}
        style={{ width: size, height: size }}
      >
        <span className={`px-3 text-sm font-terminal uppercase tracking-tight leading-tight break-words text-center ${loading ? 'opacity-30' : ''}`}>
          {label}
        </span>

        {/* Hover-revealed × in top-right (only when the slot is something we
            can clear — empty Efflux Engine has no clear). Hidden during
            loading — the user can't act on a slot mid-mutation. */}
        {onClear && !loading && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="absolute top-1 right-1 p-0.5 rounded-sm bg-black/60 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
            title={accent === 'green' ? 'Clear (revert to Efflux Engine)' : 'Remove'}
          >
            <X className="w-3 h-3" />
          </button>
        )}

        {/* Spinner overlay — covers the whole square while a host RPC is in
            flight. Click-blocking via pointer-events-none on the parent
            isn't necessary because the buttons are also disabled. */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[1px] rounded-sm pointer-events-none">
            <Loader2 className={`w-8 h-8 animate-spin ${accent === 'green' ? 'text-phobos-green/80' : 'text-phobos-amber/80'}`} />
          </div>
        )}
      </div>

      {/* Below: bypass + edit. Bypass is FX-only (instrument has no bypass).
          Both disabled while loading — the slot isn't in a stable state. */}
      <div className="mt-2 flex flex-col items-center gap-1.5 w-full">
        {onBypass && (
          <button
            onClick={(e) => { e.stopPropagation(); onBypass(); }}
            disabled={loading}
            className={`w-full px-2 py-1 text-[9px] font-terminal uppercase tracking-widest border rounded-sm transition-colors flex items-center justify-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed ${
              bypassed
                ? 'border-destructive/60 text-destructive bg-destructive/10'
                : 'border-phobos-amber/40 text-phobos-amber/70 hover:border-phobos-amber/70'
            }`}
            title={bypassed ? 'Click to engage' : 'Click to bypass (signal passes through unchanged)'}
          >
            <Power className="w-2.5 h-2.5" />
            {bypassed ? 'Bypassed' : 'Engaged'}
          </button>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); if (onEdit) onEdit(); }}
          disabled={!onEdit || loading}
          className={`w-full px-2 py-1 text-[9px] font-terminal uppercase tracking-widest border rounded-sm transition-colors flex items-center justify-center gap-1 ${
            accent === 'green'
              ? 'border-phobos-green/40 text-phobos-green/80 hover:border-phobos-green/70'
              : 'border-phobos-amber/40 text-phobos-amber/80 hover:border-phobos-amber/70'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
          title={isHostBacked ? 'Open native plugin UI' : 'Open Efflux Engine editor'}
        >
          <Pencil className="w-2.5 h-2.5" />
          Edit
        </button>
      </div>
    </div>
  );
}

// ── DropGap — narrow gap between FX squares that accepts inserts ──────────

interface DropGapProps {
  onDrop: (e: React.DragEvent) => void;
}

function DropGap({ onDrop }: DropGapProps) {
  const [hot, setHot] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-phobos-plugin-browser') ||
            e.dataTransfer.types.includes('application/x-phobos-fx-chain')) {
          e.preventDefault();
          setHot(true);
        }
      }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => { setHot(false); onDrop(e); }}
      className="shrink-0 self-stretch flex items-center"
      style={{
        width:  hot ? CHAIN_LINK_PX + 12 : CHAIN_LINK_PX,
        marginLeft:  PSEUDO_FX_GAP_PX,
        marginRight: PSEUDO_FX_GAP_PX,
        transition: 'width 80ms',
      }}
    >
      <div
        className={`w-full rounded-sm transition-colors ${hot ? 'bg-phobos-amber/40' : 'bg-phobos-amber/20'}`}
        style={{ height: 2 }}
      />
    </div>
  );
}

// ── BrowserCard — row 3 grid entry ─────────────────────────────────────────

interface BrowserCardProps {
  entry:         PluginEntry;
  size:          number;
  onDoubleClick: () => void;
}

function BrowserCard({ entry, size, onDoubleClick }: BrowserCardProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME_BROWSER, entry.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={onDoubleClick}
      className="rounded-sm border border-phobos-blue/50 bg-phobos-blue/[0.12] hover:border-phobos-blue/80 hover:bg-phobos-blue/[0.20] cursor-grab active:cursor-grabbing flex flex-col items-center justify-center px-2 py-2 transition-colors"
      style={{ width: size, height: size }}
      title={`${entry.name} — ${entry.path} · double-click or drag to add`}
    >
      <span className="text-[10px] font-terminal text-phobos-blue/80 uppercase tracking-tight leading-tight text-center break-words">
        {entry.name}
      </span>
      <span className="mt-1 text-[8px] font-mono text-muted-foreground/40 uppercase">
        {entry.source}
      </span>
    </div>
  );
}

// ── Catalog lookups ────────────────────────────────────────────────────────

function findEntryByUid(uid: string, phobos: PluginEntry[], system: PluginEntry[]): PluginEntry | null {
  for (let i = 0; i < phobos.length; i++) if (phobos[i].id === uid) return phobos[i];
  for (let i = 0; i < system.length; i++) if (system[i].id === uid) return system[i];
  return null;
}
