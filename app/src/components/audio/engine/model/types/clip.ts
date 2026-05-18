/**
 * clip.ts — A named, colored, fixed-length sequence of notes on a single channel.
 *
 * A Clip wraps an existing EffluxChannel (the upstream tracker channel encoding —
 * an array of EffluxAudioEvent | 0). Wrapping rather than replacing keeps the
 * lowest-level note format byte-identical to upstream Efflux and preserves the
 * XTK serialization contract (Audio Subsystem Spec v2.1 §10.2).
 *
 * Lifecycle:
 *   • Created by useSessionStore.addClip() — id minted there, channel pre-allocated
 *     to the requested step count, all entries 0.
 *   • Mutated in place — note writes go directly into clip.channel[stepIdx].
 *     Schedulers, editors, and serializers all read the same buffer. Bump
 *     useSessionStore.sessionVersion after mutation batches to drive re-renders.
 *   • Persisted in .phobos-session as a member of ChannelState.clips[]. The
 *     channel array is serialized with the same encoding XTK uses for pattern
 *     channels — no transformation needed.
 *
 * Note on `channelIndex`:
 *   Denormalized for convenience. Kept consistent by useSessionStore — when a
 *   clip is moved/copied between channels, the store rewrites this field in
 *   place. Code that reads it must trust the store's invariant; no validation
 *   in the hot path.
 */

import type { EffluxChannel } from '@/components/audio/engine/model/types/channel';

export interface Clip {
  /** Stable id within the session, used as map key in React lists. */
  id: string;

  /** Owning channel index. Denormalized — kept in sync by useSessionStore. */
  channelIndex: number;

  /** User-editable label shown in the clip cell. */
  name: string;

  /** Hex color (e.g. '#22c55e') or Tailwind-compatible color name. */
  color: string;

  /**
   * Step count for THIS clip. Independent of other clips — a 16-step clip and
   * a 32-step clip can coexist on different channels and wrap independently
   * (per Q2: cursors are per-clip, launches snap to the global bar boundary).
   */
  steps: number;

  /**
   * Note data. Same shape as EffluxSong.patterns[i].channels[c] today —
   * an array of EffluxAudioEvent | 0 of length `steps`.
   */
  channel: EffluxChannel;

  /**
   * Loop behavior at clip end (Q3):
   *   true  — restart at step 0 when the per-clip cursor reaches `steps`
   *   false — play once, then stop the channel (release held voice, set
   *           playingClipIdx = -1). No implicit follow-clip.
   */
  loop: boolean;
}
