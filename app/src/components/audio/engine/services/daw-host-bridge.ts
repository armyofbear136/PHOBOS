/**
 * daw-host-bridge.ts — Mirror per-channel host plugin chain to PhobosHost.
 *
 * The session schema (Step 1) records a channel's host instrument and FX
 * chain as PluginRefs. Slot IDs are NOT in the schema — they are host-
 * assigned, monotonic, and not stable across PhobosHost restarts (Audio
 * Spec v2.2 §10.4). This module is the runtime that closes the gap:
 *
 *   • mountSession(session)   — for each channel, instantiate hostInstrument
 *                                and fxChain in PhobosHost, stash slot IDs.
 *   • unmountSession()         — tear down all channels (channel 0 is the
 *                                host system chain — never touched here).
 *   • setHostInstrument(...)   — user op: load/replace/clear, then store.
 *   • appendFx / removeFx /
 *     reorderFx               — user op: host RPC first, then store on
 *                                success. RPC failure leaves schema intact.
 *
 * Failure model
 *   Host RPCs can fail (binary missing, plugin invalid, host crashed). The
 *   bridge does NOT swallow those failures: it returns Promise<void> that
 *   rejects, leaving the store unmutated. The UI catches and surfaces the
 *   error. This is the opposite of optimistic UI — for plugins, schema/host
 *   divergence is the worst possible outcome (we'd save a session pointing
 *   at a slot that never instantiated).
 *
 * Threading
 *   All bridge calls are async and run on the JS main thread. PhobosHost
 *   serializes ops on its message thread (Spec §10.3) so concurrent calls
 *   from the bridge are safe — but the bridge itself does NOT await between
 *   the RPC and the store mutation, so the activeSession reference must
 *   stay live across the await. Callers must not swap sessions concurrently
 *   with these ops; the EffluxPanel handlers serialize naturally via React
 *   state.
 *
 * Dirty teardown
 *   unmountSession swallows individual RPC errors — when the user closes a
 *   session, a stuck slot must not block the next session from loading. The
 *   host's unloadPlugin is itself idempotent at the session boundary (full
 *   process recycle on shutdown clears everything anyway).
 */

import {
  loadPlugin,
  unloadPlugin,
  reorderFx as apiReorderFx,
  setPluginActive,
  getHostStatus,
  startHost,
} from '@/components/audio/services/DawApi';
import { useSessionStore } from '@/store/daw/useSessionStore';
import { usePluginsStore } from '@/store/daw/usePluginsStore';
import type { PluginRef, Session } from '@/components/audio/engine/model/types/session';
import type { PluginEntry }        from '@/components/audio/services/DawApi';

// ── PluginEntry → PluginRef coercion ─────────────────────────────────────────
//
// Single conversion helper used by every UI that mints a fresh PluginRef from
// the catalog. Centralizes the bypassed default (false on add) so future UI
// surfaces don't drift on this contract.

export function pluginEntryToRef(p: PluginEntry): PluginRef {
  return { uid: p.id, path: p.path, name: p.name, bypassed: false };
}

// ── Runtime slot map (NOT persisted) ─────────────────────────────────────────
//
// Two parallel structures, both keyed by channelIdx:
//
//   instrumentSlots: channelIdx → slotId | undefined
//   fxSlots:         channelIdx → slotId[]   (positional; matches fxChain[])
//
// Pre-allocated lazily on first use per channel. Cleared on unmountSession.
// We use Map<number, ...> rather than a fixed array because channel count
// is dynamic per session. Map insertion is amortized O(1); per-mutation
// allocation cost is one pointer.

const instrumentSlots = new Map<number, number>();
const fxSlots         = new Map<number, number[]>();

function getOrCreateFxList(channelIdx: number): number[] {
  let list = fxSlots.get(channelIdx);
  if (!list) {
    list = [];
    fxSlots.set(channelIdx, list);
  }
  return list;
}

// ── Schema normalization ─────────────────────────────────────────────────────
//
// The session-level ChannelState gained `hostInstrument` and `fxChain`
// fields when the chain modal landed. Sessions that exist in memory from
// before that schema addition (legacy migrations, partial constructions)
// can have those fields undefined. Every bridge method that reads them
// defends against that by normalizing the channel at entry — once-per-call,
// in-place, no React notification needed (mutating a never-set field to
// a default isn't a "change" any subscriber cares about).
//
// This is the single safety net for "old session in memory" scenarios.
// Once a session is normalized, all subsequent reads inside the bridge
// are safe.

function normalizeChannel(channel: { hostInstrument?: PluginRef | null; fxChain?: PluginRef[] }): void {
  if (channel.hostInstrument === undefined) channel.hostInstrument = null;
  if (channel.fxChain        === undefined) channel.fxChain        = [];
}

// ── Host availability ────────────────────────────────────────────────────────
//
// The user can open the chain modal (and pick plugins) before AudioService
// has booted — the InstrumentChainModal lives behind a double-click on a
// channel header, which is reachable from the moment the DAW panel mounts.
// PhobosHost is lazy-started on first audio request (Spec §4.14); we
// piggyback on that by calling startHost() if status reports stopped.
//
// This is idempotent: getHostStatus is cheap, and startHost is a no-op
// (the route returns the existing status) when the process is already up.
//
// Failures (binary missing, port collision) propagate to the caller; the
// modal surfaces them as a toast, leaving the schema untouched.

let hostReadyPromise: Promise<void> | null = null;

async function ensureHostRunning(): Promise<void> {
  if (hostReadyPromise) return hostReadyPromise;
  hostReadyPromise = (async () => {
    const status = await getHostStatus();
    if (status.state !== 'running') {
      await startHost();
    }
  })();
  try {
    await hostReadyPromise;
  } finally {
    // Successful runs cache the resolved promise so subsequent calls return
    // immediately. A rejection clears the cache so the next call retries.
    if (hostReadyPromise) {
      hostReadyPromise.catch(() => { hostReadyPromise = null; });
    }
  }
}

// ── Plugin-path resolution ───────────────────────────────────────────────────
//
// PluginRef.uid is the canonical identity (`<source>:<basename>`, the
// permanent wire contract from Spec §10.2). Resolve to a live filesystem
// path via the plugins listing. Falls back to the saved PluginRef.path when
// the uid isn't in the catalog — covers two cases:
//   1. Cold-load before usePluginsStore.loadIfStale() has populated.
//   2. The plugin was uninstalled or the catalog is stale.
//
// In both cases we attempt the load with the saved path; if THAT fails the
// host returns an error and the bridge propagates it.

function resolvePluginPath(ref: PluginRef): string {
  const listing = usePluginsStore.getState();
  const all     = listing.phobos.concat(listing.system);
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === ref.uid) return all[i].path;
  }
  return ref.path;                                  // fallback — uid unresolved
}

// ── Session mount / unmount ──────────────────────────────────────────────────

/**
 * Walk a session's channels and instantiate every hostInstrument + fxChain
 * entry in PhobosHost. Populates the runtime slot map.
 *
 * Order matters: instrument first (it creates the channel), then fx in
 * ascending fxIndex (so positional ordering matches the schema). A failure
 * mid-channel does not roll back successfully-loaded earlier channels —
 * those stay live; the user sees a load error and can retry the failing
 * channel by reopening the file or clearing/re-setting the instrument.
 *
 * Channel 0 is skipped — that's the system chain, owned by PhobosHostManager.
 */
export async function mountSession(session: Session): Promise<void> {
  for (let c = 1; c < session.channels.length; c++) {
    const channel = session.channels[c];
    normalizeChannel(channel);

    if (channel.hostInstrument) {
      const path = resolvePluginPath(channel.hostInstrument);
      const { slotId } = await loadPlugin({
        channelIdx: c,
        pluginPath: path,
        kind:       'instrument',
      });
      instrumentSlots.set(c, slotId);
      if (channel.hostInstrument.bypassed) {
        try { await setPluginActive(slotId, false); }
        catch (err) { console.error('mountSession: setPluginActive failed for instrument', err); }
      }
    }

    if (channel.fxChain.length > 0) {
      const list = getOrCreateFxList(c);
      for (let i = 0; i < channel.fxChain.length; i++) {
        const fx = channel.fxChain[i];
        const path = resolvePluginPath(fx);
        const { slotId } = await loadPlugin({
          channelIdx: c,
          pluginPath: path,
          kind:       'fx',
          fxIndex:    i,
        });
        list.push(slotId);                          // index === i by construction
        if (fx.bypassed) {
          try { await setPluginActive(slotId, false); }
          catch (err) { console.error('mountSession: setPluginActive failed for fx', err); }
        }
      }
    }
  }
}

/**
 * Tear down every channel chain known to the bridge. Errors per slot are
 * logged via console.error (the host log is the source of truth) but do not
 * abort the sweep — the goal is to leave the bridge map empty so the next
 * mountSession starts clean.
 *
 * Channel 0's system chain is host-owned and not in our slot map, so it's
 * naturally skipped.
 */
export async function unmountSession(): Promise<void> {
  for (const slotId of instrumentSlots.values()) {
    try { await unloadPlugin(slotId); }
    catch (err) { console.error('unmountSession: unloadPlugin instrument failed', slotId, err); }
  }
  instrumentSlots.clear();

  for (const list of fxSlots.values()) {
    for (let i = 0; i < list.length; i++) {
      try { await unloadPlugin(list[i]); }
      catch (err) { console.error('unmountSession: unloadPlugin fx failed', list[i], err); }
    }
    list.length = 0;                                // mutate, do not reassign
  }
  fxSlots.clear();
}

// ── User-driven mutations ────────────────────────────────────────────────────

/**
 * Set or replace a channel's host instrument.
 *
 *   • ref === null and current is null   → no-op.
 *   • ref === null and current is loaded → unload host slot, clear schema.
 *   • ref set and current is null         → load host, set schema.
 *   • ref set and current already same   → no-op (uid match).
 *   • ref set and current differs         → unload old, load new, set schema.
 *
 * Throws on host failure — store is NOT mutated unless every host RPC in the
 * sequence succeeded. Channel 0 is rejected at the store layer (returns
 * false from setChannelHostInstrument) and at the host route layer.
 */
export async function setHostInstrument(channelIdx: number, ref: PluginRef | null): Promise<void> {
  const session = useSessionStore.getState().activeSession;
  if (!session) throw new Error('no active session');
  const channel = session.channels[channelIdx];
  if (!channel) throw new Error(`channel ${channelIdx} out of range`);
  normalizeChannel(channel);

  const current     = channel.hostInstrument;
  const currentSlot = instrumentSlots.get(channelIdx);

  // Idempotent shortcut — same uid (or both null) means nothing to do.
  if (current === null && ref === null) return;
  if (current !== null && ref !== null && current.uid === ref.uid) return;

  if (ref !== null) await ensureHostRunning();

  if (currentSlot !== undefined) {
    await unloadPlugin(currentSlot);
    instrumentSlots.delete(channelIdx);
  }

  if (ref !== null) {
    const path = resolvePluginPath(ref);
    const { slotId } = await loadPlugin({
      channelIdx,
      pluginPath: path,
      kind:       'instrument',
    });
    instrumentSlots.set(channelIdx, slotId);
  }

  useSessionStore.getState().setChannelHostInstrument(channelIdx, ref);
}

/**
 * Append an FX plugin to the tail of a channel's chain. Loads on host first,
 * then mutates the store. The new fxIndex is the schema array's new length-1
 * after append.
 */
export async function appendFx(channelIdx: number, ref: PluginRef): Promise<void> {
  const session = useSessionStore.getState().activeSession;
  if (!session) throw new Error('no active session');
  const channel = session.channels[channelIdx];
  if (!channel) throw new Error(`channel ${channelIdx} out of range`);
  normalizeChannel(channel);

  await ensureHostRunning();

  const fxIndex = channel.fxChain.length;           // appended position
  const path    = resolvePluginPath(ref);
  const { slotId } = await loadPlugin({
    channelIdx,
    pluginPath: path,
    kind:       'fx',
    fxIndex,
  });

  getOrCreateFxList(channelIdx).push(slotId);
  useSessionStore.getState().appendChannelFx(channelIdx, ref);
}

/**
 * Remove the FX at the given index from a channel's chain. Unloads on host
 * first, then mutates the store. Subsequent fx slots' positions shift down
 * by one in the host's view (the host's reorderFx is not invoked because
 * unloadPlugin renumbers in place).
 */
export async function removeFx(channelIdx: number, fxIndex: number): Promise<void> {
  const list = fxSlots.get(channelIdx);
  if (!list) throw new Error(`channel ${channelIdx} has no fx chain`);
  if (fxIndex < 0 || fxIndex >= list.length) {
    throw new Error(`fxIndex ${fxIndex} out of range (0..${list.length - 1})`);
  }

  const slotId = list[fxIndex];
  await unloadPlugin(slotId);

  list.splice(fxIndex, 1);                          // mutate
  useSessionStore.getState().removeChannelFx(channelIdx, fxIndex);
}

/**
 * Move an FX from one position to another within a channel's chain. The host
 * reorderFx call uses the slotId (stable identity) and the new fxIndex; we
 * mirror that into the runtime slot list and the schema fxChain array.
 */
export async function reorderFx(channelIdx: number, fromIdx: number, toIdx: number): Promise<void> {
  const list = fxSlots.get(channelIdx);
  if (!list) throw new Error(`channel ${channelIdx} has no fx chain`);
  if (fromIdx < 0 || fromIdx >= list.length) {
    throw new Error(`fromIdx ${fromIdx} out of range (0..${list.length - 1})`);
  }
  if (toIdx < 0 || toIdx >= list.length) {
    throw new Error(`toIdx ${toIdx} out of range (0..${list.length - 1})`);
  }
  if (fromIdx === toIdx) return;                    // no-op

  const slotId = list[fromIdx];
  await apiReorderFx(slotId, toIdx);

  // Mirror the host's positional rearrangement in the runtime list.
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);

  useSessionStore.getState().reorderChannelFx(channelIdx, fromIdx, toIdx);
}

/**
 * Insert an FX plugin at a specific position in the chain. Used when the
 * user drops a plugin from the browser between two existing FX squares
 * (or before the first one). The host's loadPlugin honors fxIndex; we just
 * mirror that into the runtime slot list and the schema.
 *
 * insertAt === fxChain.length is equivalent to appendFx — accepted as a
 * convenience so the modal's drop-handler doesn't need to special-case
 * end-of-chain drops.
 */
export async function insertFx(channelIdx: number, insertAt: number, ref: PluginRef): Promise<void> {
  const session = useSessionStore.getState().activeSession;
  if (!session) throw new Error('no active session');
  const channel = session.channels[channelIdx];
  if (!channel) throw new Error(`channel ${channelIdx} out of range`);
  normalizeChannel(channel);
  const len = channel.fxChain.length;
  if (insertAt < 0 || insertAt > len) {
    throw new Error(`insertAt ${insertAt} out of range (0..${len})`);
  }

  await ensureHostRunning();

  const path = resolvePluginPath(ref);
  const { slotId } = await loadPlugin({
    channelIdx,
    pluginPath: path,
    kind:       'fx',
    fxIndex:    insertAt,
  });

  // Mirror in runtime slot list and schema. Single store update (one
  // sessionVersion bump) so React renders once.
  const list = getOrCreateFxList(channelIdx);
  list.splice(insertAt, 0, slotId);
  useSessionStore.getState().insertChannelFx(channelIdx, insertAt, ref);
}

/**
 * Replace the FX at the given index. Used when the user drops a plugin from
 * the browser onto an existing FX square. Equivalent to remove + insert at
 * the same position — kept as a single bridge method so callers don't have
 * to chain awaits and so we present the host with a clean swap (the old
 * slot's processBlock is gone before the new slot's first call).
 */
export async function replaceFx(channelIdx: number, fxIndex: number, ref: PluginRef): Promise<void> {
  const list = fxSlots.get(channelIdx);
  if (!list) throw new Error(`channel ${channelIdx} has no fx chain`);
  if (fxIndex < 0 || fxIndex >= list.length) {
    throw new Error(`fxIndex ${fxIndex} out of range (0..${list.length - 1})`);
  }

  await ensureHostRunning();

  // Tear down the old slot first.
  const oldSlotId = list[fxIndex];
  await unloadPlugin(oldSlotId);
  list.splice(fxIndex, 1);
  useSessionStore.getState().removeChannelFx(channelIdx, fxIndex);

  // Instantiate the new one at the same position, mirror to slot list and
  // schema in single steps.
  const path = resolvePluginPath(ref);
  const { slotId } = await loadPlugin({
    channelIdx,
    pluginPath: path,
    kind:       'fx',
    fxIndex,
  });
  list.splice(fxIndex, 0, slotId);
  useSessionStore.getState().insertChannelFx(channelIdx, fxIndex, ref);
}

/**
 * Toggle the bypassed flag on a plugin in the chain. Mirrors host
 * setPluginActive(slotId, !bypassed) and persists via store. Target selects
 * the plugin: 'instrument' for hostInstrument, or a number for fxChain[N].
 *
 * Idempotent — calling with the current value is a no-op.
 */
export async function setBypassed(
  channelIdx: number,
  target: 'instrument' | number,
  bypassed: boolean,
): Promise<void> {
  const session = useSessionStore.getState().activeSession;
  if (!session) throw new Error('no active session');
  const channel = session.channels[channelIdx];
  if (!channel) throw new Error(`channel ${channelIdx} out of range`);
  normalizeChannel(channel);

  let slotId: number | undefined;
  let ref:    PluginRef | null;
  if (target === 'instrument') {
    ref    = channel.hostInstrument;
    slotId = instrumentSlots.get(channelIdx);
  } else {
    ref    = channel.fxChain[target] ?? null;
    slotId = fxSlots.get(channelIdx)?.[target];
  }

  if (!ref)               throw new Error(`no plugin at channel ${channelIdx} target ${target}`);
  if (slotId === undefined) throw new Error(`no host slot for channel ${channelIdx} target ${target}`);
  if (ref.bypassed === bypassed) return;            // no-op

  // setPluginActive is the inverse: active=true means NOT bypassed.
  await setPluginActive(slotId, !bypassed);
  useSessionStore.getState().setPluginBypassed(channelIdx, target, bypassed);
}

// ── Auto-mount subscription ──────────────────────────────────────────────────
//
// Wire the bridge to the session store so any setActiveSession call triggers
// unmount-of-old then mount-of-new. The store itself never calls the host —
// this subscription is the single integration point. Idempotent: repeat
// installs are a no-op (the unsubscribe lambda is module-local).

let unsubscribeSessionWatch: (() => void) | null = null;
let mountSeq = 0;                                   // monotonic; race guard

/**
 * Install the auto-mount listener. Safe to call multiple times — subsequent
 * calls are no-ops. Called once from initDawBridge() during AudioService boot.
 */
export function installHostBridgeWatcher(): void {
  if (unsubscribeSessionWatch !== null) return;

  let prevSession: Session | null = useSessionStore.getState().activeSession;

  unsubscribeSessionWatch = useSessionStore.subscribe((state) => {
    const next = state.activeSession;
    if (next === prevSession) return;               // unrelated bump (clip edit, etc.)
    prevSession = next;

    // Each session swap gets its own sequence number. If a second swap fires
    // before the first finishes mounting, the in-flight mount aborts before
    // touching the store.
    const mySeq = ++mountSeq;

    void (async () => {
      await unmountSession();
      if (mySeq !== mountSeq) return;               // superseded — bail
      if (next) {
        try {
          await mountSession(next);
        } catch (err) {
          console.error('mountSession failed', err);
        }
      }
    })();
  });
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve a channel's host instrument slot ID (or null when unmounted).
 * Used by UI surfaces that need to call host APIs keyed by slotId, e.g.
 * showPluginUi in the InstrumentChainModal's Edit handler.
 */
export function getInstrumentSlotId(channelIdx: number): number | null {
  return instrumentSlots.get(channelIdx) ?? null;
}

/**
 * Resolve a channel's FX slot ID at the given chain position (or null).
 * Mirror of getInstrumentSlotId for fx-chain entries.
 */
export function getFxSlotId(channelIdx: number, fxIndex: number): number | null {
  const list = fxSlots.get(channelIdx);
  if (!list || fxIndex < 0 || fxIndex >= list.length) return null;
  return list[fxIndex];
}

/**
 * Test-only: reset bridge state without running teardown RPCs. Used by unit
 * tests that don't have a live PhobosHost. Production code paths should use
 * unmountSession instead.
 */
export function _resetForTest(): void {
  instrumentSlots.clear();
  fxSlots.clear();
  mountSeq = 0;
  if (unsubscribeSessionWatch) {
    unsubscribeSessionWatch();
    unsubscribeSessionWatch = null;
  }
}

/** Test-only: peek at the runtime slot map. */
export function _slotsForTest(): { instrumentSlots: Map<number, number>; fxSlots: Map<number, number[]> } {
  return { instrumentSlots, fxSlots };
}
