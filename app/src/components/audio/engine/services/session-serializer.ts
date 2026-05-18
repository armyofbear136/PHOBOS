/**
 * session-serializer.ts — .phobos-session read/write + XTK→session migration.
 *
 * Two responsibilities:
 *
 *   1. Serialize / deserialize a Session to/from .phobos-session (a plain,
 *      human-readable JSON format defined in PHOBOS-DAW-Phase-3-Session-Model.md
 *      §4.6). NOT abbreviated — XTK uses short keys for compactness; this format
 *      uses readable keys because users will inevitably open one in a text
 *      editor at some point.
 *
 *   2. Migrate an EffluxSong (the legacy XTK model still owned by useSongStore)
 *      into a Session: each channel becomes one channel with one clip, the
 *      clip wraps the corresponding pattern's channel array. The first pattern
 *      is the source of truth — patterns 2+ from XTK are NOT preserved (this
 *      is the documented Phase 3 migration policy: XTK songs become "1 pattern
 *      per channel" sessions, see §4.7). Pattern-order is irrelevant in the
 *      session model.
 *
 * Persisted vs runtime fields (per Q3.1):
 *
 *   • PERSISTED: clip data, channel.activeClipIdx, channel.armedClipIdx,
 *     channel.enabled, session metadata, instruments, settings.
 *
 *     Q3.1 specified "save the armed state, restore it on load." The serializer
 *     is the place that enforces this — armedClipIdx is part of the file.
 *
 *   • NOT PERSISTED: channel.playingClipIdx, channel.playingCursor.
 *
 *     You cannot reload into mid-playback. Both are set to -1 / 0 on load
 *     and are written only by the audio scheduler at runtime.
 *
 * Format versioning:
 *
 *   PHOBOS_SESSION_VERSION is the file-format version. Bumped on breaking
 *   schema changes. v1 is the initial schema; samples are reserved as an
 *   empty array but not populated (they remain session-only in v1, matching
 *   the existing XTK behavior — see Audio Subsystem Spec §10.7). v2 will
 *   inline sample data when the sample-in-session encoding is finalized.
 *
 *   deserialize() accepts any version <= PHOBOS_SESSION_VERSION; older
 *   versions go through the version-migration switch (currently a no-op
 *   since v1 is the only version). Newer versions are rejected.
 *
 * Wire contract:
 *
 *   The schema below is part of the .phobos-session file-format contract.
 *   New fields may be appended (with deserialize() defaulting them when
 *   absent) without bumping the version. Removing or renaming fields
 *   requires a version bump and migration code.
 */

import type { EffluxSong }    from '@engine/model/types/song';
import type { EffluxChannel } from '@engine/model/types/channel';
import type { Instrument }    from '@engine/model/types/instrument';
import type {
  Session,
  ChannelState,
  Quantization,
  SessionMeta,
} from '@engine/model/types/session';
import type { Clip } from '@engine/model/types/clip';

// ── File-format constants ────────────────────────────────────────────────────

/**
 * Current .phobos-session file-format version. Bump on breaking schema
 * changes. Compatible older versions are accepted and migrated by
 * deserialize(); newer versions are rejected with an explicit error.
 */
export const PHOBOS_SESSION_VERSION = 1;

/** File extension (without the dot). */
export const PHOBOS_SESSION_EXTENSION = 'phobos-session';

const QUANTIZATION_VALUES: readonly Quantization[] = ['1bar', '2bar', 'half_bar', '1beat'];

// ── Serialization (Session → JSON object) ────────────────────────────────────

/**
 * Serialize a Session into a plain JSON-ready object. Caller is responsible
 * for JSON.stringify (so it can choose pretty-printing / minification).
 *
 * Pure function — does not mutate the input. Allocations are unavoidable
 * here (we're producing a JSON document) but this is NOT a hot path; it
 * runs once per save/load.
 */
export function serialize(session: Session): SerializedSession {
  return {
    version:      PHOBOS_SESSION_VERSION,
    tempo:        session.tempo,
    beatsPerBar:  session.beatsPerBar,
    stepsPerBeat: session.stepsPerBeat,
    quantization: session.quantization,
    meta: {
      title:    session.meta.title,
      author:   session.meta.author,
      created:  session.meta.created,
      modified: new Date().toISOString(),    // touch on save
    },
    instruments: session.instruments,        // structurally JSON-safe today
    samples:     [],                          // reserved for v2; see §10.7
    channels: session.channels.map((c) => ({
      instrumentIndex: c.instrumentIndex,
      activeClipIdx:   c.activeClipIdx,
      armedClipIdx:    c.armedClipIdx,        // Q3.1: arm state IS persisted
      enabled:         c.enabled,
      clips: c.clips.map((clip) => ({
        id:           clip.id,
        channelIndex: clip.channelIndex,
        name:         clip.name,
        color:        clip.color,
        steps:        clip.steps,
        loop:         clip.loop,
        channel:      clip.channel,           // EffluxChannel — JSON-safe
      })),
    })),
  };
}

// ── Deserialization (JSON object → Session) ──────────────────────────────────

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFormatError';
  }
}

/**
 * Deserialize a JSON-parsed object into a Session. Validates structure,
 * applies version migrations, and returns a Session that's ready to hand
 * to useSessionStore.setActiveSession().
 *
 * playingClipIdx and playingCursor are forced to -1 / 0 — runtime fields
 * are never populated from disk.
 *
 * Throws SessionFormatError on schema violations or unsupported versions.
 */
export function deserialize(raw: unknown): Session {
  if (!isObject(raw))         throw new SessionFormatError('not an object');

  const version = numField(raw, 'version', 'integer');
  if (version > PHOBOS_SESSION_VERSION) {
    throw new SessionFormatError(
      `session version ${version} is newer than supported (${PHOBOS_SESSION_VERSION})`,
    );
  }
  // Future migrations: if (version < 2) migrateV1toV2(raw); etc.

  const tempo        = numField(raw, 'tempo');
  const beatsPerBar  = numField(raw, 'beatsPerBar', 'integer');
  const stepsPerBeat = numField(raw, 'stepsPerBeat', 'integer');
  const quantization = enumField(raw, 'quantization', QUANTIZATION_VALUES);

  const meta = parseMeta(raw.meta);

  if (!Array.isArray(raw.instruments)) {
    throw new SessionFormatError('instruments must be an array');
  }
  if (!Array.isArray(raw.channels)) {
    throw new SessionFormatError('channels must be an array');
  }

  const instruments = raw.instruments as Instrument[];

  const channels: ChannelState[] = (raw.channels as unknown[]).map((c, idx) =>
    parseChannelState(c, idx, instruments.length),
  );

  return {
    version,
    tempo,
    beatsPerBar,
    stepsPerBeat,
    quantization,
    meta,
    instruments,
    channels,
  };
}

// ── Migration: EffluxSong → Session ──────────────────────────────────────────

/**
 * Convert an EffluxSong (legacy XTK model) into a Session per the migration
 * policy in PHOBOS-DAW-Phase-3-Session-Model.md §4.7:
 *
 *   • Each instrument becomes a channel.
 *   • Each channel gets ONE clip, derived from patterns[0].channels[i].
 *     (Songs with multiple patterns: only patterns[0] migrates. The user
 *     can author additional clips after migration.)
 *   • Channel buffer is referenced, not copied — same notes, no allocation.
 *     The Session takes ownership of the channel arrays from the source
 *     song; the source song should be considered consumed after migration.
 *   • activeClipIdx = 0, armedClipIdx = -1, enabled = true (per Q3.1: new
 *     blank session = nothing armed; a migrated song is a fresh session).
 *
 * Clip IDs use a deterministic counter form so a migrated test session is
 * byte-stable across runs (useful for CI snapshot tests). The store's
 * own minter takes over for clips added after migration.
 */
export function fromEffluxSong(song: EffluxSong): Session {
  const sourcePattern = song.patterns[0];
  const sourceSteps   = sourcePattern?.steps ?? 16;
  const channelCount  = song.instruments.length;
  const nowIso        = new Date().toISOString();

  const channels: ChannelState[] = new Array(channelCount);

  for (let c = 0; c < channelCount; c++) {
    // Reference the existing channel array if present; else allocate empty
    // at the source step count. Either way the clip OWNS the buffer
    // hereafter — don't mutate the source song after migration.
    const noteBuffer: EffluxChannel =
      sourcePattern?.channels[c] ?? new Array(sourceSteps).fill(0);

    const clip: Clip = {
      id:           `mig-${c}`,
      channelIndex: c,
      name:         'Clip 1',
      color:        DEFAULT_CLIP_COLORS[c % DEFAULT_CLIP_COLORS.length],
      steps:        sourceSteps,
      channel:      noteBuffer,
      loop:         true,
    };

    channels[c] = {
      instrumentIndex: c,
      clips:           [clip],
      activeClipIdx:   0,
      armedClipIdx:    -1,
      playingClipIdx:  -1,
      playingCursor:   0,
      enabled:         true,
    };
  }

  return {
    version:      PHOBOS_SESSION_VERSION,
    tempo:        song.meta.timing.tempo,
    beatsPerBar:  song.meta.timing.timeSigNumerator,
    stepsPerBeat: 4,                        // tracker idiom (see Spec §10.4)
    quantization: '1bar',                   // Q1 default
    channels,
    instruments:  song.instruments,
    meta: {
      title:    song.meta.title,
      author:   song.meta.author,
      created:  toIso(song.meta.created)  ?? nowIso,
      modified: toIso(song.meta.modified) ?? nowIso,
    },
  };
}

// ── Blank-session factory ────────────────────────────────────────────────────

/**
 * Build a fresh blank session with `instrumentCount` empty channels (one
 * 16-step empty clip per channel — gives the user a place to start writing
 * notes immediately).
 *
 * Per Q3.1: nothing armed on a blank session.
 */
export function createBlankSession(
  instruments: Instrument[],
  tempo = 120,
): Session {
  const nowIso = new Date().toISOString();
  const channels: ChannelState[] = new Array(instruments.length);

  for (let c = 0; c < instruments.length; c++) {
    const noteBuffer: EffluxChannel = new Array(16).fill(0);
    const clip: Clip = {
      id:           `blank-${c}`,
      channelIndex: c,
      name:         'Clip 1',
      color:        DEFAULT_CLIP_COLORS[c % DEFAULT_CLIP_COLORS.length],
      steps:        16,
      channel:      noteBuffer,
      loop:         true,
    };
    channels[c] = {
      instrumentIndex: c,
      clips:           [clip],
      activeClipIdx:   0,
      armedClipIdx:    -1,
      playingClipIdx:  -1,
      playingCursor:   0,
      enabled:         true,
    };
  }

  return {
    version:      PHOBOS_SESSION_VERSION,
    tempo,
    beatsPerBar:  4,
    stepsPerBeat: 4,
    quantization: '1bar',
    channels,
    instruments,
    meta: {
      title:    '',
      author:   '',
      created:  nowIso,
      modified: nowIso,
    },
  };
}

// ── Internal: schema types for the wire format ───────────────────────────────

/**
 * Wire-format object as it appears on disk. Kept distinct from Session
 * (the runtime type) so the runtime fields playingClipIdx / playingCursor
 * cannot accidentally leak into the file. New fields in the wire format
 * must be added here AND in serialize/deserialize.
 */
interface SerializedSession {
  version:      number;
  tempo:        number;
  beatsPerBar:  number;
  stepsPerBeat: number;
  quantization: Quantization;
  meta:         SessionMeta;
  instruments:  Instrument[];
  samples:      unknown[];                  // reserved for v2
  channels:     SerializedChannelState[];
}

interface SerializedChannelState {
  instrumentIndex: number;
  activeClipIdx:   number;
  armedClipIdx:    number;
  enabled:         boolean;
  clips:           SerializedClip[];
}

interface SerializedClip {
  id:           string;
  channelIndex: number;
  name:         string;
  color:        string;
  steps:        number;
  loop:         boolean;
  channel:      EffluxChannel;
}

// ── Internal: parsing helpers (validation with explicit errors) ──────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numField(
  obj: Record<string, unknown>,
  key: string,
  kind: 'integer' | 'finite' = 'finite',
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SessionFormatError(`${key} must be a finite number`);
  }
  if (kind === 'integer' && !Number.isInteger(v)) {
    throw new SessionFormatError(`${key} must be an integer`);
  }
  return v;
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw new SessionFormatError(`${key} must be a string`);
  return v;
}

function boolField(obj: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const v = obj[key];
  if (typeof v === 'boolean') return v;
  if (v === undefined && fallback !== undefined) return fallback;
  throw new SessionFormatError(`${key} must be a boolean`);
}

function enumField<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const v = obj[key];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new SessionFormatError(`${key} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

function parseMeta(raw: unknown): SessionMeta {
  if (!isObject(raw)) throw new SessionFormatError('meta must be an object');
  return {
    title:    strField(raw, 'title'),
    author:   strField(raw, 'author'),
    created:  strField(raw, 'created'),
    modified: strField(raw, 'modified'),
  };
}

function parseChannelState(
  raw: unknown,
  channelIdx: number,
  instrumentCount: number,
): ChannelState {
  if (!isObject(raw)) throw new SessionFormatError(`channels[${channelIdx}] must be an object`);

  const instrumentIndex = numField(raw, 'instrumentIndex', 'integer');
  if (instrumentIndex < 0 || instrumentIndex >= instrumentCount) {
    throw new SessionFormatError(
      `channels[${channelIdx}].instrumentIndex out of range`,
    );
  }

  if (!Array.isArray(raw.clips)) {
    throw new SessionFormatError(`channels[${channelIdx}].clips must be an array`);
  }
  const clips: Clip[] = (raw.clips as unknown[]).map((c, ci) =>
    parseClip(c, channelIdx, ci),
  );

  const activeClipIdx = numField(raw, 'activeClipIdx', 'integer');
  const armedClipIdx  = numField(raw, 'armedClipIdx',  'integer');
  const enabled       = boolField(raw, 'enabled', true);

  // Range-check the runtime indices that came off disk; clamp out-of-range
  // values to safe defaults rather than crashing on a slightly-malformed file.
  const safeActive = (clips.length === 0 || activeClipIdx < 0 || activeClipIdx >= clips.length)
    ? 0
    : activeClipIdx;
  const safeArmed  = (armedClipIdx === -1 || (armedClipIdx >= 0 && armedClipIdx < clips.length))
    ? armedClipIdx
    : -1;

  return {
    instrumentIndex,
    clips,
    activeClipIdx:  safeActive,
    armedClipIdx:   safeArmed,
    playingClipIdx: -1,                  // runtime — never persisted
    playingCursor:  0,                    // runtime — never persisted
    enabled,
  };
}

function parseClip(raw: unknown, channelIdx: number, clipIdx: number): Clip {
  if (!isObject(raw)) {
    throw new SessionFormatError(`channels[${channelIdx}].clips[${clipIdx}] must be an object`);
  }
  const id           = strField(raw, 'id');
  const channelIndex = numField(raw, 'channelIndex', 'integer');
  const name         = strField(raw, 'name');
  const color        = strField(raw, 'color');
  const steps        = numField(raw, 'steps', 'integer');
  const loop         = boolField(raw, 'loop', true);

  if (steps <= 0)        throw new SessionFormatError(`clip steps must be positive`);
  if (!Array.isArray(raw.channel)) {
    throw new SessionFormatError(`clips[${clipIdx}].channel must be an array`);
  }
  const channel = raw.channel as EffluxChannel;
  if (channel.length !== steps) {
    throw new SessionFormatError(
      `clips[${clipIdx}].channel length (${channel.length}) does not match steps (${steps})`,
    );
  }

  return { id, channelIndex, name, color, steps, channel, loop };
}

// ── Internal: misc ───────────────────────────────────────────────────────────

/**
 * EffluxSong stores created/modified as Unix-ms numbers; .phobos-session
 * stores them as ISO strings for human readability. This converts safely
 * (returns null on garbage so callers can fall back to "now").
 */
function toIso(unixMs: number): string | null {
  if (typeof unixMs !== 'number' || !Number.isFinite(unixMs)) return null;
  const d = new Date(unixMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Default clip-color rotation. Mirrors useSessionStore's DEFAULT_CLIP_COLORS
 * — duplicated here (rather than imported) because the serializer is part
 * of the engine layer and must not depend on the store layer (engine →
 * store would be the wrong arrow). The two arrays must stay aligned; if
 * one is changed, change the other.
 */
const DEFAULT_CLIP_COLORS: readonly string[] = [
  '#22c55e', '#3b82f6', '#f97316', '#a855f7',
  '#ec4899', '#eab308', '#06b6d4', '#ef4444',
];
