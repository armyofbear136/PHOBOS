import {
  AldaNode,
  Note,
  Chord,
  Rest,
  OctaveChange,
  Attribute,
  InstrumentDecl,
  VoiceDecl,
} from './AldaParser.js';

// ── MIDI event output ─────────────────────────────────────────────────────────

export interface MidiEvent {
  instrument: string;       // 'piano', etc. — resolves to a GM program number
  midiNote:   number;       // 0–127
  velocity:   number;       // 0–127
  /** Absolute start time in ticks from the start of the score. */
  startTicks: number;
  /** Duration in ticks. */
  durationTicks: number;
  channel:    number;       // 0–15
}

export interface EmitResult {
  events:      MidiEvent[];
  ticksPerBeat: number;
  tempoBpm:    number;       // last-set tempo applicable to playback
}

// ── General MIDI program map (subset) ─────────────────────────────────────────

const GM_PROGRAMS: Record<string, number> = {
  piano:         0,
  electricpiano: 4,
  harpsichord:   6,
  celesta:       8,
  music_box:    10,
  vibraphone:   11,
  organ:        19,
  guitar:       24,
  bass:         32,
  violin:       40,
  viola:        41,
  cello:        42,
  contrabass:   43,
  harp:         46,
  strings:      48,
  trumpet:      56,
  trombone:     57,
  tuba:         58,
  french_horn:  60,
  saxophone:    65,
  oboe:         68,
  clarinet:     71,
  flute:        73,
  voice:        52,
  drums:        118,      // not strictly GM but works for synth-drum channels
};

// ── Timing constants ──────────────────────────────────────────────────────────

const TICKS_PER_BEAT = 480;          // Standard MIDI PPQ — high-resolution
const DEFAULT_TEMPO  = 120;
const DEFAULT_OCTAVE = 4;
const DEFAULT_VOLUME = 100;
const DEFAULT_DURATION_NUM = 4;      // quarter note when unspecified

// ── Emitter ───────────────────────────────────────────────────────────────────

interface InstrumentState {
  name:        string;
  alias:       string | null;
  channel:     number;
  octave:      number;
  velocity:    number;                // derived from last volume attribute (0–127)
  duration:    number;                // last note duration (denominator)
  dotted:      boolean;
  voices:      Map<number, VoiceState>;
  activeVoice: number;
  cursorTicks: number;                // used when no voice is active (voice 0)
}

interface VoiceState {
  cursorTicks: number;
}

export class AldaMidiEmitter {
  private events:    MidiEvent[] = [];
  private instruments = new Map<string, InstrumentState>();
  private active:    InstrumentState | null = null;
  private tempo      = DEFAULT_TEMPO;
  private nextChannel = 0;

  emit(nodes: AldaNode[]): EmitResult {
    for (const n of nodes) this.handle(n);
    return { events: this.events, ticksPerBeat: TICKS_PER_BEAT, tempoBpm: this.tempo };
  }

  private handle(node: AldaNode): void {
    switch (node.kind) {
      case 'instrument': return this.onInstrument(node);
      case 'voice':      return this.onVoice(node);
      case 'note':       return this.onNote(node);
      case 'chord':      return this.onChord(node);
      case 'rest':       return this.onRest(node);
      case 'octave':     return this.onOctave(node);
      case 'attribute':  return this.onAttribute(node);
    }
  }

  // ── Declarations ────────────────────────────────────────────────────────

  private onInstrument(d: InstrumentDecl): void {
    const key = d.alias ?? d.name;
    let inst  = this.instruments.get(key);
    if (!inst) {
      inst = {
        name:        d.name.toLowerCase(),
        alias:       d.alias,
        channel:     this.nextChannel++,
        octave:      DEFAULT_OCTAVE,
        velocity:    DEFAULT_VOLUME,
        duration:    DEFAULT_DURATION_NUM,
        dotted:      false,
        voices:      new Map(),
        activeVoice: 0,
        cursorTicks: 0,
      };
      this.instruments.set(key, inst);
    }
    this.active = inst;
  }

  private onVoice(v: VoiceDecl): void {
    if (!this.active) throw new Error(`Voice declaration without active instrument`);
    if (!this.active.voices.has(v.number)) {
      this.active.voices.set(v.number, { cursorTicks: 0 });
    }
    this.active.activeVoice = v.number;
  }

  // ── Notes / chords / rests ──────────────────────────────────────────────

  private onNote(n: Note): void {
    const inst = this.requireActive();
    const { durationTicks } = this.resolveDuration(n.durationNum, n.dotted, inst);
    const cursor = this.currentCursor(inst);
    const midi   = this.midiPitch(n, inst);

    this.events.push({
      instrument:    inst.name,
      midiNote:      midi,
      velocity:      inst.velocity,
      startTicks:    cursor,
      durationTicks,
      channel:       inst.channel,
    });

    this.advanceCursor(inst, durationTicks);
    // Remember duration for subsequent notes that omit it
    if (n.durationNum !== null) {
      inst.duration = n.durationNum;
      inst.dotted   = n.dotted;
    }
  }

  private onChord(c: Chord): void {
    const inst = this.requireActive();
    // Chord duration = the first note's duration (ALDA convention)
    const first = c.notes[0];
    const { durationTicks } = this.resolveDuration(first.durationNum, first.dotted, inst);
    const cursor = this.currentCursor(inst);

    for (const note of c.notes) {
      const midi = this.midiPitch(note, inst);
      this.events.push({
        instrument:    inst.name,
        midiNote:      midi,
        velocity:      inst.velocity,
        startTicks:    cursor,
        durationTicks,
        channel:       inst.channel,
      });
    }

    this.advanceCursor(inst, durationTicks);
    if (first.durationNum !== null) {
      inst.duration = first.durationNum;
      inst.dotted   = first.dotted;
    }
  }

  private onRest(r: Rest): void {
    const inst = this.requireActive();
    const { durationTicks } = this.resolveDuration(r.durationNum, r.dotted, inst);
    this.advanceCursor(inst, durationTicks);
    if (r.durationNum !== null) {
      inst.duration = r.durationNum;
      inst.dotted   = r.dotted;
    }
  }

  private onOctave(o: OctaveChange): void {
    const inst = this.requireActive();
    if (o.mode === 'set')       inst.octave = o.value ?? inst.octave;
    else if (o.mode === 'up')   inst.octave += 1;
    else /* down */             inst.octave -= 1;
  }

  private onAttribute(a: Attribute): void {
    if (a.name === 'tempo')  this.tempo = a.value;
    else if (a.name === 'volume') {
      const inst = this.requireActive();
      // ALDA 0–100; MIDI 0–127
      inst.velocity = Math.max(0, Math.min(127, Math.round(a.value * 1.27)));
    }
    // panning and others: currently recorded at the tempo level only.
    // Extending to per-channel pan events is a future concern.
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private requireActive(): InstrumentState {
    if (!this.active) throw new Error(`Music event before any instrument declaration`);
    return this.active;
  }

  private resolveDuration(
    durationNum: number | null,
    dotted:      boolean,
    inst:        InstrumentState,
  ): { durationTicks: number } {
    const num = durationNum ?? inst.duration;
    const d   = durationNum !== null ? dotted : inst.dotted;
    // Whole note = 4 beats. Duration value 'num' is the denominator.
    // dotted = 1.5x
    const ticks = (TICKS_PER_BEAT * 4) / num * (d ? 1.5 : 1);
    return { durationTicks: Math.round(ticks) };
  }

  private midiPitch(n: Note, inst: InstrumentState): number {
    const midi = (inst.octave + 1) * 12 + n.pitchClass + n.accidental;
    if (midi < 0 || midi > 127) {
      throw new Error(`MIDI pitch out of range: octave=${inst.octave}, pitchClass=${n.pitchClass}`);
    }
    return midi;
  }

  private currentCursor(inst: InstrumentState): number {
    if (inst.activeVoice === 0) return inst.cursorTicks;
    const vs = inst.voices.get(inst.activeVoice);
    return vs ? vs.cursorTicks : 0;
  }

  private advanceCursor(inst: InstrumentState, ticks: number): void {
    if (inst.activeVoice === 0) { inst.cursorTicks += ticks; return; }
    const vs = inst.voices.get(inst.activeVoice);
    if (vs) vs.cursorTicks += ticks;
  }
}

// ── Standard MIDI File writer ─────────────────────────────────────────────────

/**
 * Produce a type-1 Standard MIDI File byte array from an emit result. Each
 * instrument becomes one MTrk. Writes meta-event tempo in the first track.
 */
export function toStandardMidiFile(result: EmitResult): Uint8Array {
  // Group events by channel (one track per instrument)
  const byChannel = new Map<number, MidiEvent[]>();
  for (const ev of result.events) {
    let list = byChannel.get(ev.channel);
    if (!list) { list = []; byChannel.set(ev.channel, list); }
    list.push(ev);
  }
  const channels = Array.from(byChannel.keys()).sort((a, b) => a - b);

  // Header chunk: "MThd" + length=6 + format=1 + numTracks + division
  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64], 0);                     // "MThd"
  writeUInt32BE(header, 4, 6);                                   // chunk len
  writeUInt16BE(header, 8, 1);                                   // format 1
  writeUInt16BE(header, 10, channels.length);                    // num tracks
  writeUInt16BE(header, 12, result.ticksPerBeat);                // division

  // Build each track
  const trackChunks: Uint8Array[] = [];
  let firstTrack = true;
  for (const ch of channels) {
    const events = byChannel.get(ch)!;
    trackChunks.push(buildTrackChunk(events, ch, firstTrack ? result.tempoBpm : null));
    firstTrack = false;
  }

  const totalLen = header.length + trackChunks.reduce((a, t) => a + t.length, 0);
  const out = new Uint8Array(totalLen);
  out.set(header, 0);
  let offset = header.length;
  for (const t of trackChunks) { out.set(t, offset); offset += t.length; }
  return out;
}

// ── MIDI track builder ────────────────────────────────────────────────────────

function buildTrackChunk(events: MidiEvent[], channel: number, tempoBpm: number | null): Uint8Array {
  // Convert note events into on/off pairs sorted by absolute tick.
  interface TrackEv {
    tick:   number;
    type:   'on' | 'off' | 'meta-tempo';
    note?:  number;
    vel?:   number;
    tempo?: number;
    order:  number;
  }
  const trackEvents: TrackEv[] = [];
  let order = 0;
  if (tempoBpm !== null) {
    trackEvents.push({ tick: 0, type: 'meta-tempo', tempo: tempoBpm, order: order++ });
  }
  for (const ev of events) {
    trackEvents.push({ tick: ev.startTicks,                         type: 'on',  note: ev.midiNote, vel: ev.velocity, order: order++ });
    trackEvents.push({ tick: ev.startTicks + ev.durationTicks,      type: 'off', note: ev.midiNote, vel: 0,           order: order++ });
  }
  trackEvents.sort((a, b) => a.tick === b.tick ? a.order - b.order : a.tick - b.tick);

  // Encode as MIDI delta-time events
  const bytes: number[] = [];
  let prevTick = 0;
  for (const te of trackEvents) {
    const delta = te.tick - prevTick;
    prevTick = te.tick;
    writeVarLen(bytes, delta);
    if (te.type === 'meta-tempo') {
      // FF 51 03 tttttt  (tempo = microseconds per quarter note)
      const mpqn = Math.round(60_000_000 / (te.tempo ?? DEFAULT_TEMPO));
      bytes.push(0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff);
    } else if (te.type === 'on') {
      bytes.push(0x90 | (channel & 0x0f), te.note! & 0x7f, te.vel! & 0x7f);
    } else {
      bytes.push(0x80 | (channel & 0x0f), te.note! & 0x7f, 0x00);
    }
  }
  // End of track meta
  writeVarLen(bytes, 0);
  bytes.push(0xff, 0x2f, 0x00);

  // MTrk header + payload
  const payloadLen = bytes.length;
  const chunk = new Uint8Array(8 + payloadLen);
  chunk.set([0x4d, 0x54, 0x72, 0x6b], 0);                        // "MTrk"
  writeUInt32BE(chunk, 4, payloadLen);
  for (let i = 0; i < payloadLen; i++) chunk[8 + i] = bytes[i];
  return chunk;
}

function writeVarLen(out: number[], value: number): void {
  if (value < 0) throw new Error('VarLen cannot encode negative value');
  let buffer = value & 0x7f;
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
}

function writeUInt16BE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset]     = (v >> 8) & 0xff;
  buf[offset + 1] =  v       & 0xff;
}

function writeUInt32BE(buf: Uint8Array, offset: number, v: number): void {
  buf[offset]     = (v >> 24) & 0xff;
  buf[offset + 1] = (v >> 16) & 0xff;
  buf[offset + 2] = (v >>  8) & 0xff;
  buf[offset + 3] =  v        & 0xff;
}

// GM program lookup — exported for callers that want to send a program-change
// message to PhobosHost alongside note events.
export function gmProgramFor(instrument: string): number {
  return GM_PROGRAMS[instrument.toLowerCase()] ?? 0;
}
