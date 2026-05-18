/**
 * MidiService.ts — Phase 2a stub.
 *
 * The upstream Efflux MIDI service uses the `zmidi` wrapper around WebMIDI to
 * receive live MIDI input, auto-pair controllers to synth parameters, and
 * record MIDI events into the sequencer. That port lands in Phase 2d along
 * with the MIDI export/import UI.
 *
 * For Phase 2a the panel does not accept MIDI input, so this stub only
 * exports the types and shapes that other engine files import at compile
 * time. The original file is preserved at MidiService.ts.orig as the
 * reference for the later port.
 */

/**
 * PairableParam describes a (module-param, instrument) pair that can be
 * bound to an incoming MIDI CC message. Still used as a type import by
 * module-automation.ts and the future pairings store, so the shape must
 * remain stable.
 */
export interface PairableParam {
  paramId:         string;
  instrumentIndex: number;
}

const MidiService = {
  init(): void {
    // no-op in Phase 2a; see header comment
  },
  isSupported(): boolean {
    return false;
  },
  connect(_portIndex: number): Promise<void> {
    return Promise.resolve();
  },
  disconnect(): void {
    // no-op in Phase 2a
  },
};

export default MidiService;
