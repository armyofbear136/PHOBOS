/**
 * AldaPlayer.ts — Plays compiled ALDA source on the Phobos synth.
 *
 * Bridges the ALDA → MIDI emitter (phobos/alda-parser) and the PhobosHost
 * scheduler (PhobosHostManager.playMidiSequence). Single instrument: the
 * always-mounted Phobos synth on host channel 0. Multi-instrument scores
 * (each ALDA `instrument: { ... }` block on its own channel) are deferred —
 * everything compiles down to channel 0 today.
 *
 * The path:
 *
 *   ALDA source
 *     │  aldaToMidi()
 *     ▼
 *   { events: MidiEvent[], ticksPerBeat, tempoBpm }
 *     │  shape conversion (drop emitter-side `instrument` and `channel`,
 *     │   keep only midiNote / velocity / startTicks / durationTicks)
 *     ▼
 *   playMidiSequence({ slotId: synthSlotId, events, ticksPerBeat, tempoBpm })
 *     │
 *     ▼
 *   { sequenceId }   ← caller retains for stopSequence
 *
 * The host owns tick → sample conversion at the device's actual sample rate;
 * we hand it tick-space events as-is.
 */

import { aldaToMidi } from './alda-parser/index.js';
import {
  ensureRunning,
  getPhobosSynthSlotId,
  playMidiSequence,
  stopSequence,
  type SequencerMidiEvent,
} from './PhobosHostManager.js';

/**
 * Compile ALDA source and queue it for playback on the Phobos synth.
 * Fire-and-forget: returns immediately with the sequenceId; audio plays
 * asynchronously. Use stopSequence(sequenceId) to cancel.
 *
 * Throws on:
 *   - ALDA syntax/semantic errors (from aldaToMidi)
 *   - host unreachable / synth not mounted
 *   - scheduler queue full
 */
export async function playSourceOnPhobosSynth(
  source: string,
): Promise<{ sequenceId: number; eventCount: number; tempoBpm: number }> {
  const compiled = aldaToMidi(source);
  if (compiled.events.length === 0) {
    throw new Error('ALDA source compiled to zero events');
  }

  await ensureRunning();
  const synthSlotId = getPhobosSynthSlotId();
  if (synthSlotId === null) {
    throw new Error('Phobos synth not mounted');
  }

  // The emitter's MidiEvent has more fields than the wire shape needs. The
  // scheduler only consumes (midiNote, velocity, startTicks, durationTicks);
  // `instrument` and `channel` are emitter-side bookkeeping and don't matter
  // for single-instrument playback on the synth.
  //
  // Sort by startTicks defensively. The emitter writes events in order today,
  // but the host validates ascending startSamples — sorting here keeps a
  // future emitter change from breaking the host contract.
  const events: SequencerMidiEvent[] = compiled.events
    .map((e) => ({
      midiNote:      e.midiNote,
      velocity:      e.velocity,
      startTicks:    e.startTicks,
      durationTicks: e.durationTicks,
    }))
    .sort((a, b) => a.startTicks - b.startTicks);

  const result = await playMidiSequence({
    slotId:       synthSlotId,
    events,
    ticksPerBeat: compiled.ticksPerBeat,
    tempoBpm:     compiled.tempoBpm,
  });

  return {
    sequenceId: result.sequenceId,
    eventCount: events.length,
    tempoBpm:   compiled.tempoBpm,
  };
}

/** Cancel a sequence started via playSourceOnPhobosSynth. Idempotent. */
export async function stopAldaSequence(sequenceId: number): Promise<void> {
  await stopSequence(sequenceId);
}
