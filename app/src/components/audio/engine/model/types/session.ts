/**
 * session.ts — The top-level Phase 3 session model.
 *
 * Replaces the linear "song with patterns" mental model (still present in
 * useSongStore for migration) with an Ableton-style clip session: each
 * channel owns a stack of clips that the user launches independently with
 * quantized timing.
 *
 * Authoritative reference: PHOBOS-DAW-Phase-3-Session-Model.md §4.1.
 *
 * Mutation discipline (matches useSongStore — see useSessionStore.ts):
 *   • All fields mutated in place. Never replace, never spread.
 *   • Re-render driven by useSessionStore.sessionVersion counter.
 *   • Runtime-only fields (playingClipIdx, playingCursor) are written by the
 *     scheduler and read by the UI; they are NOT serialized to
 *     .phobos-session (you cannot reload into mid-playback — both reset to
 *     -1 / 0 on load).
 *   • armedClipIdx IS persisted (Q3.1 — "save the armed state, restore it
 *     on load"). New blank sessions have armedClipIdx = -1 on every channel.
 */

import type { Instrument } from '@/components/audio/engine/model/types/instrument';
import type { Clip }       from '@/components/audio/engine/model/types/clip';

/**
 * Launch quantization grid (Q1). Default '1bar' — clips snap to the next
 * downbeat. Configurable per-session via SessionTransport's quantization
 * dropdown (Phase 3 Session 3 deliverable).
 */
export type Quantization = '1bar' | '2bar' | 'half_bar' | '1beat';

/**
 * Persistent reference to a host-side VST3 plugin.
 *
 * Slot IDs are NOT in this type — they're host-assigned, monotonic, and not
 * stable across PhobosHost restarts (Audio Spec v2.2 §10.4). The session
 * stores the plugin's enumeration identity instead and rehydrates fresh slot
 * IDs on load by re-issuing loadPlugin against the resolved path.
 *
 *   • uid      — Plugin enumeration ID, format `<source>:<basename>`, e.g.
 *                `phobos:PhobosCrystal` or `system:Surge XT.vst3`. This is
 *                the same identity key used by /api/audio/plugins (permanent
 *                wire contract — Spec §10.2). Survives bundle moves;
 *                resolves against the live scan listing on session open.
 *   • path     — Last-known absolute filesystem path. Used as a fallback
 *                when uid resolution fails (e.g. user moved a system plugin
 *                and hasn't rescanned). Not authoritative — uid wins.
 *   • name     — Display name captured at chain-add time. Lets the UI
 *                render the chain without waiting for the plugin scanner to
 *                finish on cold-load. Purely informational.
 *   • bypassed — When true the plugin is loaded but its processBlock is
 *                skipped on the host (audio passes through unchanged for
 *                FX; produces silence for instruments). Mirrors the host's
 *                setPluginActive(slotId, !bypassed) state. Persisted
 *                (append-only at v1 — old files default this to false).
 */
export interface PluginRef {
  uid:      string;
  path:     string;
  name:     string;
  bypassed: boolean;
}

export interface ChannelState {
  /**
   * Owning instrument index — same indexing convention as upstream Efflux.
   * Channel N reads from session.instruments[channelState.instrumentIndex].
   * Plugin selection is per-channel (Phase 3 §4.8) and lives elsewhere; this
   * field is just the instrument pointer.
   */
  instrumentIndex: number;

  /** Clips owned by this channel, in user's display order. Mutated in place. */
  clips: Clip[];

  /**
   * Which clip the tracker grid edits and displays below the channel header.
   * Always a valid index into `clips` — guarded by the store on delete.
   * Q4: tracker grid view IS the active clip's editor; selecting a different
   * clip changes what the column shows.
   */
  activeClipIdx: number;

  /**
   * Which clip is queued to launch on the next quantization boundary.
   * -1 = nothing queued. Written by useSessionStore.armClip; cleared by
   * the scheduler when launch fires. Persisted across save/load (Q3.1).
   */
  armedClipIdx: number;

  /**
   * Runtime: which clip is currently sounding. -1 = silent. Written
   * exclusively by the scheduler as it transitions clips on bar boundaries.
   * NOT serialized.
   */
  playingClipIdx: number;

  /**
   * Runtime: position within the playing clip's per-clip cursor, in steps.
   * 0 when not playing. Written by the scheduler each step advance.
   * NOT serialized.
   */
  playingCursor: number;

  /**
   * Per-channel enable. When false the channel is silenced (Q3.5: BOTH
   * channel.enabled AND !instrument.muted are required for sound).
   * Disabling mid-playback lets the current clip finish its loop, then stops
   * — handled in the scheduler's bar-boundary check.
   */
  enabled: boolean;

  /**
   * Optional host-side VST3 instrument. When set, the channel is in
   * "host-routed" mode: scheduler events for this channel dispatch via
   * hostNote() to the host's instrument slot, and the WebAudio synth path
   * for this channel is silent (hard switch — Spec §4.1 "opt-in" model).
   * null = WebAudio synth (the default — channel is driven by
   * instruments[instrumentIndex]'s oscillators / ADSR / filter chain).
   *
   * Mutated in place by useSessionStore. Persisted (append-only at v1 —
   * old files default this to null on load).
   */
  hostInstrument: PluginRef | null;

  /**
   * Per-channel host FX chain, in signal-flow order (index 0 is first after
   * the instrument). Empty when no FX are mounted. Independent from the
   * channel-0 system FX chain (which is host-owned and not represented in
   * the session). Independent across channels — two channels pointing at
   * the same instrumentIndex still own distinct fxChain arrays.
   *
   * Mutated in place; reorder by splicing this array, not by creating a new
   * one. Persisted (append-only at v1 — old files default to []).
   */
  fxChain: PluginRef[];
}

export interface SessionMeta {
  title:    string;
  author:   string;
  /** ISO-8601 timestamp. */
  created:  string;
  /** ISO-8601 timestamp; updated by serializer on save. */
  modified: string;
}

export interface Session {
  /** File-format version. Bump on breaking changes to session-serializer.ts. */
  version: number;

  /** Global tempo in BPM. Drives the global clock and step duration. */
  tempo: number;

  /**
   * Time signature numerator (4 in 4/4). Denominator is implicit 4 — the
   * tracker idiom counts in quarter-note beats.
   */
  beatsPerBar: number;

  /**
   * Steps per beat. Conventionally 4 (16th notes). Combined with beatsPerBar,
   * a bar boundary occurs every (beatsPerBar * stepsPerBeat) steps of the
   * global clock.
   */
  stepsPerBeat: number;

  /** Default launch quantization for clip arms. */
  quantization: Quantization;

  /** All channels in the session. Length === instruments.length. */
  channels: ChannelState[];

  /**
   * All instruments in the session. Same Instrument type as upstream — the
   * instrument editors continue to operate on these references unchanged.
   */
  instruments: Instrument[];

  /** Session-level metadata (title, author, timestamps). */
  meta: SessionMeta;
}
