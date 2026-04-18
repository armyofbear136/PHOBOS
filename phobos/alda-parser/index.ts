import { AldaParser } from './AldaParser.js';
import { AldaMidiEmitter, toStandardMidiFile, gmProgramFor } from './AldaMidiEmitter.js';
import type { EmitResult, MidiEvent } from './AldaMidiEmitter.js';

export { toStandardMidiFile, gmProgramFor };
export type { MidiEvent, EmitResult };

/**
 * Compile ALDA source text into an array of MIDI events. Throws on syntax
 * or semantic errors. Pure function — no IO, no subprocess.
 *
 * Example:
 *   const result = aldaToMidi("piano: o4 c8 d e f g a b > c");
 *   // result.events = [{ instrument: 'piano', midiNote: 60, ... }, ...]
 */
export function aldaToMidi(source: string): EmitResult {
  const parser = new AldaParser(source);
  const ast    = parser.parse();
  const emitter = new AldaMidiEmitter();
  return emitter.emit(ast);
}

/**
 * Compile ALDA source directly to a Standard MIDI File byte array.
 */
export function aldaToMidiFile(source: string): Uint8Array {
  return toStandardMidiFile(aldaToMidi(source));
}
