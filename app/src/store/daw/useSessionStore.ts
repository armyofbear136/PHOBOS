/**
 * useSessionStore.ts — Zustand store for the Phase 3 session model.
 *
 * Owns the active Session object. Mirrors useSongStore's discipline:
 *
 *   • All mutations are IN PLACE on the active Session's nested objects.
 *     Pattern channels, clip arrays, and ChannelState fields are mutated
 *     directly — no spread, no reconstruct.
 *   • Re-renders are driven by `sessionVersion`, a monotonic integer bumped
 *     after every mutation batch. Subscribers that need to react to clip
 *     edits include `sessionVersion` in their selector.
 *
 *     Example:
 *       const session        = useSessionStore(s => s.activeSession);
 *       const sessionVersion = useSessionStore(s => s.sessionVersion);
 *       // then read session.channels[c].clips[i].channel[step] directly
 *
 *   • Subscribers that only need a stable reference (e.g. for save) can
 *     omit sessionVersion from the selector.
 *
 * Runtime fields (armedClipIdx, playingClipIdx, playingCursor) live on
 * ChannelState. The audio scheduler writes them; the UI subscribes via
 * sessionVersion to re-render clip cell states (idle / armed / playing).
 *
 * Clip ID generation:
 *   Clip IDs are minted from a module-local counter (`clip-<base36>`),
 *   reset on setActiveSession. This keeps IDs deterministic within a
 *   session, avoids per-call crypto.randomUUID() allocation, and side-steps
 *   any temptation to use Date.now() in a UI loop.
 */

import { create } from 'zustand';
import type { Session, Quantization, PluginRef } from '@/components/audio/engine/model/types/session';
import type { Clip }                  from '@/components/audio/engine/model/types/clip';

// ── Clip ID counter ──────────────────────────────────────────────────────────

let clipIdCounter = 0;

function mintClipId(): string {
  return `clip-${(clipIdCounter++).toString(36)}`;
}

/**
 * After moving an array element from `fromIdx` to `toIdx` (via splice/splice
 * in place), return the new position of any unrelated index that pointed
 * into the array beforehand. Cases:
 *   • idx === fromIdx       → now at toIdx (it followed the moved item)
 *   • fromIdx < idx <= toIdx → shifts down by 1 (move pulled the array up
 *                              past this position)
 *   • toIdx <= idx < fromIdx → shifts up by 1 (move pushed the array down
 *                              past this position)
 *   • else                   → unchanged
 *
 * Caller is responsible for handling the "field is -1, ignore" case before
 * calling. Indices are assumed in-range; out-of-range is a programming
 * error and the function does not validate.
 */
function remapAfterMove(idx: number, fromIdx: number, toIdx: number): number {
  if (idx === fromIdx) return toIdx;
  if (fromIdx < toIdx && idx > fromIdx && idx <= toIdx) return idx - 1;
  if (toIdx < fromIdx && idx >= toIdx && idx < fromIdx) return idx + 1;
  return idx;
}

// ── Default clip-cell color rotation (Phase 3 Session 3 polish item, but the
// constant is needed at addClip time so we expose it here). Eight slots —
// matches the typical 8-channel session; channel-index modulo length picks
// the default. Hex-encoded Tailwind 500-stop equivalents.
const DEFAULT_CLIP_COLORS: readonly string[] = [
  '#22c55e', // green
  '#3b82f6', // blue
  '#f97316', // orange
  '#a855f7', // purple
  '#ec4899', // pink
  '#eab308', // yellow
  '#06b6d4', // cyan
  '#ef4444', // red
];

// ── Store ────────────────────────────────────────────────────────────────────

export interface SessionState {
  activeSession:  Session | null;
  /** Bump this on every in-place mutation of activeSession to drive re-renders. */
  sessionVersion: number;
  /** Dirty flag — set true on any mutation, cleared on successful save. */
  dirty:          boolean;

  // ── On-disk file bond ────────────────────────────────────────────────────
  // Tracks the relationship between the in-memory session and a file in
  // ~/.phobos/media/efflux/. Set on successful save/load; cleared when a
  // new session replaces the active one. The save handler also breaks the
  // bond at save-time when the current title diverges from `bondTitle` —
  // that's compared on save, not on every keystroke.
  bondFilename: string | null;
  bondTitle:    string | null;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  /**
   * Install (or clear) the active session. Optionally bond it to a filename
   * — used by the load handler so the next Save overwrites silently.
   * Single-arg calls (the common case from blank-session creation) clear
   * the bond.
   */
  setActiveSession:   (session: Session | null, fromFilename?: string) => void;
  bumpSessionVersion: () => void;
  markClean:          () => void;
  setBond:            (filename: string, title: string) => void;
  clearBond:          () => void;

  /**
   * Mutate `session.meta.title` in place. Bumps version and marks dirty.
   * The bond is NOT cleared here — that comparison happens at save time
   * (see Batch H handoff: "title is identity, change title = fork at save").
   */
  setTitle:           (title: string) => void;

  // ── Clip CRUD (mutates the channel's clips array in place) ───────────────
  /**
   * Append a new clip to the given channel. Returns the new clip's id.
   * `steps` defaults to 16 (one bar at the conventional stepsPerBeat=4).
   * `name` defaults to "Clip N" where N is 1-indexed within the channel.
   */
  addClip:        (channelIdx: number, steps?: number, name?: string) => string | null;

  /**
   * Delete the clip at the given index. Adjusts activeClipIdx, armedClipIdx,
   * and playingClipIdx so they stay valid (or become -1 when appropriate).
   */
  deleteClip:     (channelIdx: number, clipIdx: number) => void;

  renameClip:     (channelIdx: number, clipIdx: number, name: string) => void;
  setClipColor:   (channelIdx: number, clipIdx: number, color: string) => void;
  setClipLoop:    (channelIdx: number, clipIdx: number, loop: boolean) => void;

  /**
   * Move a clip within its channel. fromIdx and toIdx are positions in
   * channel.clips before the move. activeClipIdx, armedClipIdx, and
   * playingClipIdx follow the moved clip / shift to remain valid.
   */
  reorderClip:        (channelIdx: number, fromIdx: number, toIdx: number) => void;

  /**
   * Copy a clip to a different channel. The target channel receives a new
   * clip with a freshly minted id and a deep-copied note buffer. The
   * source clip is unchanged. Returns the new clip's id, or null on
   * invalid args. Same-channel calls are rejected (use addClip + manual
   * note copy if duplicate-on-same-channel is ever wanted).
   */
  copyClipToChannel:  (srcChannelIdx: number, srcClipIdx: number, destChannelIdx: number) => string | null;

  // ── Selection & launch ──────────────────────────────────────────────────
  /**
   * Set which clip the tracker editor displays for a channel. Pure UI — does
   * not affect playback.
   */
  setActiveClip:  (channelIdx: number, clipIdx: number) => void;

  /**
   * Queue a clip for launch on the next quantization boundary. Pass -1 to
   * un-arm. The scheduler clears armedClipIdx itself when launch fires; this
   * action is for user-driven arm/un-arm.
   */
  armClip:        (channelIdx: number, clipIdx: number) => void;

  // ── Channel state ───────────────────────────────────────────────────────
  setChannelEnabled: (channelIdx: number, enabled: boolean) => void;

  // ── Per-channel host plugin chain ────────────────────────────────────────
  // Pure schema mutation. The store does NOT issue PhobosHost RPCs — that's
  // the lifecycle hook's job (see DawHostBridge in the Step 3 work). Returns
  // true when the schema actually changed, so the bridge can decide whether
  // to issue the corresponding loadPlugin / unloadPlugin / reorderFx call.

  /**
   * Set (or clear) the host instrument for a channel. Pass null to revert
   * the channel to WebAudio-driven mode. Replacing an existing instrument
   * with a different one is a single call — the bridge tears down the old
   * slot and instantiates the new one. Idempotent: setting the same uid
   * twice is a no-op and returns false.
   *
   * Channel 0 is reserved by the host system chain; rejected here as a
   * defensive guard (the route layer also rejects channelIdx===0 instrument
   * loads — see PhobosHostManager.loadPlugin).
   */
  setChannelHostInstrument: (channelIdx: number, ref: PluginRef | null) => boolean;

  /**
   * Append an FX plugin to the tail of a channel's host FX chain. Returns
   * the new fxIndex on success, -1 on invalid args. Multiple instances of
   * the same plugin uid in one chain are allowed (e.g. two Crystals in
   * series); identity is positional, not by uid.
   */
  appendChannelFx: (channelIdx: number, ref: PluginRef) => number;

  /**
   * Insert an FX at a specific position in the chain. Single store update
   * (one sessionVersion bump) regardless of position, so React renders
   * once. insertAt === fxChain.length is equivalent to appendChannelFx.
   * Returns true on success.
   */
  insertChannelFx: (channelIdx: number, insertAt: number, ref: PluginRef) => boolean;

  /** Remove the FX at the given index. Returns true if removed. */
  removeChannelFx: (channelIdx: number, fxIndex: number) => boolean;

  /**
   * Reorder an FX within a channel's chain. Idempotent (fromIdx===toIdx is
   * a no-op returning false). Returns true on success.
   */
  reorderChannelFx: (channelIdx: number, fromIdx: number, toIdx: number) => boolean;

  /**
   * Toggle the bypassed flag on a PluginRef in the chain. `target` selects
   * which ref: 'instrument' for hostInstrument, or a number for fxChain[N].
   * Returns true when the schema actually changed (idempotent on no-op).
   * The bridge mirrors this to the host via setPluginActive.
   */
  setPluginBypassed: (channelIdx: number, target: 'instrument' | number, bypassed: boolean) => boolean;

  // ── Session-level settings ───────────────────────────────────────────────
  setTempo:         (bpm: number) => void;
  setQuantization:  (q: Quantization) => void;

  // ── Scheduler write-back (called by audio-service) ───────────────────────
  /**
   * Scheduler calls this when a launch boundary fires for a channel. Moves
   * armedClipIdx → playingClipIdx, resets the per-clip cursor, and clears
   * the arm. Writes are in-place; one bumpSessionVersion at the end of the
   * scheduler's per-tick write batch covers all channels that transitioned.
   */
  schedulerLaunchClip:    (channelIdx: number) => void;

  /** Scheduler signals end-of-clip when loop=false and cursor wrapped. */
  schedulerStopChannel:   (channelIdx: number) => void;

  /** Scheduler advances the per-clip cursor each step. Hot-path. */
  schedulerAdvanceCursor: (channelIdx: number, cursor: number) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  activeSession:  null,
  sessionVersion: 0,
  dirty:          false,
  bondFilename:   null,
  bondTitle:      null,

  // ── Lifecycle ────────────────────────────────────────────────────────────

  setActiveSession: (session, fromFilename) => {
    clipIdCounter = 0;
    if (session !== null && typeof fromFilename === 'string') {
      set({
        activeSession:  session,
        sessionVersion: 0,
        dirty:          false,
        bondFilename:   fromFilename,
        bondTitle:      session.meta.title,
      });
    } else {
      set({
        activeSession:  session,
        sessionVersion: 0,
        dirty:          false,
        bondFilename:   null,
        bondTitle:      null,
      });
    }
  },

  bumpSessionVersion: () =>
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true })),

  markClean: () => set({ dirty: false }),

  setBond:   (filename, title) => set({ bondFilename: filename, bondTitle: title }),
  clearBond: ()                => set({ bondFilename: null,    bondTitle:    null }),

  setTitle: (title) => {
    const session = get().activeSession;
    if (!session) return;
    if (session.meta.title === title) return;
    session.meta.title = title;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  // ── Clip CRUD ────────────────────────────────────────────────────────────

  addClip: (channelIdx, steps = 16, name) => {
    const session = get().activeSession;
    if (!session) return null;
    const channel = session.channels[channelIdx];
    if (!channel) return null;

    // Pre-allocate the channel buffer at the requested step count, all 0.
    // Same encoding as upstream Efflux pattern channels.
    const noteBuffer = new Array(steps).fill(0) as Clip['channel'];

    const clip: Clip = {
      id:           mintClipId(),
      channelIndex: channelIdx,
      name:         name ?? `Clip ${channel.clips.length + 1}`,
      color:        DEFAULT_CLIP_COLORS[channel.clips.length % DEFAULT_CLIP_COLORS.length],
      steps,
      channel:      noteBuffer,
      loop:         true,
    };

    channel.clips.push(clip);
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return clip.id;
  },

  deleteClip: (channelIdx, clipIdx) => {
    const session = get().activeSession;
    if (!session) return;
    const channel = session.channels[channelIdx];
    if (!channel) return;
    if (clipIdx < 0 || clipIdx >= channel.clips.length) return;

    channel.clips.splice(clipIdx, 1);

    // Fix indices so they remain valid. activeClipIdx must always reference an
    // existing clip when clips.length > 0; the runtime fields go to -1 when
    // their clip vanishes.
    if (channel.clips.length === 0) {
      channel.activeClipIdx  = 0;   // benign — no clip exists; UI guards on this
      channel.armedClipIdx   = -1;
      channel.playingClipIdx = -1;
      channel.playingCursor  = 0;
    } else {
      if (channel.activeClipIdx >= channel.clips.length) {
        channel.activeClipIdx = channel.clips.length - 1;
      } else if (channel.activeClipIdx > clipIdx) {
        channel.activeClipIdx -= 1;
      }
      if (channel.armedClipIdx === clipIdx) {
        channel.armedClipIdx = -1;
      } else if (channel.armedClipIdx > clipIdx) {
        channel.armedClipIdx -= 1;
      }
      if (channel.playingClipIdx === clipIdx) {
        channel.playingClipIdx = -1;
        channel.playingCursor  = 0;
      } else if (channel.playingClipIdx > clipIdx) {
        channel.playingClipIdx -= 1;
      }
    }

    // Rewrite denormalized channelIndex on remaining clips — splice doesn't
    // change ownership, but the assertion stays true after the shift.
    for (let i = 0; i < channel.clips.length; i++) {
      channel.clips[i].channelIndex = channelIdx;
    }

    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  renameClip: (channelIdx, clipIdx, name) => {
    const clip = get().activeSession?.channels[channelIdx]?.clips[clipIdx];
    if (!clip) return;
    clip.name = name;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  setClipColor: (channelIdx, clipIdx, color) => {
    const clip = get().activeSession?.channels[channelIdx]?.clips[clipIdx];
    if (!clip) return;
    clip.color = color;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  setClipLoop: (channelIdx, clipIdx, loop) => {
    const clip = get().activeSession?.channels[channelIdx]?.clips[clipIdx];
    if (!clip) return;
    clip.loop = loop;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  reorderClip: (channelIdx, fromIdx, toIdx) => {
    const session = get().activeSession;
    if (!session) return;
    const channel = session.channels[channelIdx];
    if (!channel) return;
    const len = channel.clips.length;
    if (fromIdx < 0 || fromIdx >= len) return;
    if (toIdx   < 0 || toIdx   >= len) return;
    if (fromIdx === toIdx) return;

    // Move within the array. splice once to remove, splice again to insert
    // at the target position. The clip object identity is preserved — its
    // id stays stable so React keys don't churn.
    const [moved] = channel.clips.splice(fromIdx, 1);
    channel.clips.splice(toIdx, 0, moved);

    // Index repair for the three runtime-pointing-to-clip-position fields.
    // Same logic for all three: if the field pointed at fromIdx, it now
    // points at toIdx (it followed the moved clip). Otherwise the field
    // shifts by ±1 if its position was crossed by the move.
    channel.activeClipIdx  = remapAfterMove(channel.activeClipIdx,  fromIdx, toIdx);
    channel.armedClipIdx   = channel.armedClipIdx  === -1 ? -1
      : remapAfterMove(channel.armedClipIdx,   fromIdx, toIdx);
    channel.playingClipIdx = channel.playingClipIdx === -1 ? -1
      : remapAfterMove(channel.playingClipIdx, fromIdx, toIdx);

    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  copyClipToChannel: (srcChannelIdx, srcClipIdx, destChannelIdx) => {
    const session = get().activeSession;
    if (!session) return null;
    if (srcChannelIdx === destChannelIdx) return null;          // same-channel rejected
    const srcChannel  = session.channels[srcChannelIdx];
    const destChannel = session.channels[destChannelIdx];
    if (!srcChannel || !destChannel) return null;
    const srcClip = srcChannel.clips[srcClipIdx];
    if (!srcClip) return null;

    // Deep-copy the note buffer. Events are objects (EffluxAudioEvent or 0),
    // so structuredClone covers the whole shape — events have no DOM refs,
    // class instances, or functions, so structuredClone is exactly right.
    // Pre-allocate at the right length first to avoid the array growing
    // entry by entry.
    const newBuffer = new Array(srcClip.steps) as Clip['channel'];
    for (let i = 0; i < srcClip.steps; i++) {
      const ev = srcClip.channel[i];
      newBuffer[i] = ev === 0 || ev === undefined ? 0 : structuredClone(ev);
    }

    const newClip: Clip = {
      id:           mintClipId(),
      channelIndex: destChannelIdx,
      name:         srcClip.name,
      color:        srcClip.color,
      steps:        srcClip.steps,
      channel:      newBuffer,
      loop:         srcClip.loop,
    };

    destChannel.clips.push(newClip);
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return newClip.id;
  },

  // ── Selection & launch ───────────────────────────────────────────────────

  setActiveClip: (channelIdx, clipIdx) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    if (clipIdx < 0 || clipIdx >= channel.clips.length) return;
    if (channel.activeClipIdx === clipIdx) return;
    channel.activeClipIdx = clipIdx;
    set((s) => ({ sessionVersion: s.sessionVersion + 1 }));   // NOT dirty — selection is UI state
  },

  armClip: (channelIdx, clipIdx) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    // -1 explicitly clears any pending arm. Otherwise must be a valid index.
    if (clipIdx !== -1 && (clipIdx < 0 || clipIdx >= channel.clips.length)) return;
    if (channel.armedClipIdx === clipIdx) return;
    channel.armedClipIdx = clipIdx;
    set((s) => ({ sessionVersion: s.sessionVersion + 1 }));   // arm is transient, not dirty
  },

  // ── Channel state ────────────────────────────────────────────────────────

  setChannelEnabled: (channelIdx, enabled) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    if (channel.enabled === enabled) return;
    channel.enabled = enabled;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  // ── Per-channel host plugin chain ────────────────────────────────────────
  //
  // These mutate the schema only. Wiring to the live PhobosHost (loadPlugin,
  // unloadPlugin, reorderFx) is performed in DawHostBridge — see Step 3.
  // The bridge calls these mutators after a successful host RPC; pure-UI
  // optimistic updates would risk schema/host divergence on RPC failure.

  setChannelHostInstrument: (channelIdx, ref) => {
    if (channelIdx === 0) return false;                        // reserved system chain
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return false;

    const current = channel.hostInstrument;
    if (current === null && ref === null) return false;
    if (current !== null && ref !== null && current.uid === ref.uid) return false;

    channel.hostInstrument = ref;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return true;
  },

  appendChannelFx: (channelIdx, ref) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return -1;
    channel.fxChain.push(ref);                                 // mutate in place
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return channel.fxChain.length - 1;
  },

  insertChannelFx: (channelIdx, insertAt, ref) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return false;
    if (insertAt < 0 || insertAt > channel.fxChain.length) return false;
    channel.fxChain.splice(insertAt, 0, ref);                  // mutate in place
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return true;
  },

  removeChannelFx: (channelIdx, fxIndex) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return false;
    if (fxIndex < 0 || fxIndex >= channel.fxChain.length) return false;
    channel.fxChain.splice(fxIndex, 1);                        // mutate in place
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return true;
  },

  reorderChannelFx: (channelIdx, fromIdx, toIdx) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return false;
    const len = channel.fxChain.length;
    if (fromIdx < 0 || fromIdx >= len) return false;
    if (toIdx   < 0 || toIdx   >= len) return false;
    if (fromIdx === toIdx) return false;
    const [moved] = channel.fxChain.splice(fromIdx, 1);        // mutate in place
    channel.fxChain.splice(toIdx, 0, moved);
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return true;
  },

  setPluginBypassed: (channelIdx, target, bypassed) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return false;

    let ref: PluginRef | null;
    if (target === 'instrument') {
      ref = channel.hostInstrument;
    } else {
      if (target < 0 || target >= channel.fxChain.length) return false;
      ref = channel.fxChain[target];
    }
    if (!ref) return false;
    if (ref.bypassed === bypassed) return false;
    ref.bypassed = bypassed;                                   // mutate in place
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
    return true;
  },

  // ── Session-level settings ───────────────────────────────────────────────

  setTempo: (bpm) => {
    const session = get().activeSession;
    if (!session) return;
    if (session.tempo === bpm) return;
    session.tempo = bpm;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  setQuantization: (q) => {
    const session = get().activeSession;
    if (!session) return;
    if (session.quantization === q) return;
    session.quantization = q;
    set((s) => ({ sessionVersion: s.sessionVersion + 1, dirty: true }));
  },

  // ── Scheduler write-back ─────────────────────────────────────────────────

  // The three scheduler-callback actions deliberately DO NOT bump
  // sessionVersion themselves — the scheduler tick batches all per-channel
  // writes and bumps the version once at the end. This keeps cursor advance
  // (which fires every step) from triggering N React re-renders per tick.
  // The scheduler is responsible for calling bumpSessionVersion exactly
  // once per tick after all per-channel mutations.

  schedulerLaunchClip: (channelIdx) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    if (channel.armedClipIdx < 0) return;
    channel.playingClipIdx = channel.armedClipIdx;
    channel.armedClipIdx   = -1;
    channel.playingCursor  = 0;
  },

  schedulerStopChannel: (channelIdx) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    channel.playingClipIdx = -1;
    channel.playingCursor  = 0;
  },

  schedulerAdvanceCursor: (channelIdx, cursor) => {
    const channel = get().activeSession?.channels[channelIdx];
    if (!channel) return;
    channel.playingCursor = cursor;
  },
}));

// Re-export the color palette for the eventual ClipPropsPopover color picker
// — keeps the default rotation and the user-selectable swatches in sync.
export { DEFAULT_CLIP_COLORS };
