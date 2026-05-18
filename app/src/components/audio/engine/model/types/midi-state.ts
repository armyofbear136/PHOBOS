/**
 * MIDIState — shape extracted from upstream src/store/modules/midi-module.ts.
 * The full MIDI runtime (zmidi listener, pairing persistence, preset loading)
 * is not ported in Phase 2a — it lands in Phase 2d. The type is declared here
 * so MidiService.ts compiles; the actual Zustand store backing this shape
 * is added in the later sub-phase.
 */

import type { PairableParam } from "../../services/midi-service";

export interface MIDIDevice {
  title: string;
  port:  number;
}

export interface MIDIState {
  midiSupported:   boolean;
  midiConnected:   boolean;
  midiPortNumber:  number;
  midiDeviceList:  MIDIDevice[];
  midiAssignMode:  boolean;
  pairingProps:    Partial<PairableParam> | null;
  pairings:        Map<string, PairableParam>;
}

export type MIDIPairingPreset = {
  id:       string;
  title:    string;
  pairings: { ccid: string; param: PairableParam }[];
};

export const createMidiState = (props?: Partial<MIDIState>): MIDIState => ({
  midiSupported:  false,  // set at runtime by MidiService once it probes WebMIDI
  midiConnected:  false,
  midiPortNumber: -1,
  midiDeviceList: [],
  midiAssignMode: false,
  pairingProps:   null,
  pairings:       new Map(),
  ...props,
});
