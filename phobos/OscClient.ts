import * as dgram from 'dgram';

// ── OscClient ─────────────────────────────────────────────────────────────────
// Minimal OSC 1.0 UDP client for the PhobosHost OSC MIDI surface on UDP/16331.
//
// Wire contract (locked — see PHOBOS-PhobosHost-Spec.md §3.4 and the
// Sessions 1–3 handoff):
//
//   /phobos/note_on   ,iiii   slotId, midiChannel, note, velocity
//   /phobos/note_off  ,iii    slotId, midiChannel, note
//   /phobos/cc        ,iiii   slotId, midiChannel, controller, value
//
// `slotId` is INFORMATIONAL — the host's MIDI dispatch goes to the audio
// player's MIDI collector with the OSC `midiChannel` field as the MIDI channel
// byte, and the per-channel MidiChannelFilter (configured at channelIdx + 1)
// filters by that. **Backend MUST set midiChannel = channelIdx + 1** (1-indexed)
// for the message to reach the right plugin.
//
// Hot-path guarantees:
//   - One pre-allocated send buffer (OSC_BUFFER_BYTES). Reused on every call.
//   - No Buffer.alloc, no Buffer.concat in the per-message path beyond a
//     single Buffer.allocUnsafe(cursor) on send (necessary because dgram.send
//     accepts the buffer asynchronously and we'd stomp on the storage with
//     back-to-back sends otherwise — see flush() comment).
//   - Cursor-based writes; no per-field allocations.
//
// OSC wire format (we implement only what PhobosHost needs):
//   [address string, null-terminated, padded to 4-byte boundary]
//   [type tag string ",<types>", null-terminated, padded to 4-byte boundary]
//   [argument values, big-endian, each padded to 4-byte boundary]
//
// Supported types:
//   i  int32      Big-endian signed int
//   f  float32    Big-endian IEEE-754  (kept for OscDecoder round-trip use)
//   s  string     Null-terminated, 4-byte padded  (kept for OscDecoder)
// ─────────────────────────────────────────────────────────────────────────────

const OSC_BUFFER_BYTES = 256;  // High-water mark. Largest message is /phobos/cc
                                // (4 ints + headers ≈ 50 bytes); 256 is generous.

const ADDR_NOTE_ON  = '/phobos/note_on';
const ADDR_NOTE_OFF = '/phobos/note_off';
const ADDR_CC       = '/phobos/cc';

const TYPE_IIII = ',iiii';
const TYPE_III  = ',iii';

export interface OscClientConfig {
  host: string;
  port: number;
}

export class OscClient {
  private readonly socket: dgram.Socket;
  private readonly buf:    Buffer;
  private readonly host:   string;
  private readonly port:   number;
  private closed = false;

  constructor(cfg: OscClientConfig) {
    this.socket = dgram.createSocket('udp4');
    this.buf    = Buffer.alloc(OSC_BUFFER_BYTES);
    this.host   = cfg.host;
    this.port   = cfg.port;
  }

  // ── Low-level writers (cursor returns new position) ──────────────────────

  /**
   * Transmit the prefix [0, cursor) of the pre-allocated buffer.
   *
   * We MUST copy before handing to socket.send: Node's dgram.send accepts
   * the Buffer reference asynchronously, so back-to-back sends with the
   * same underlying storage stomp on each other before the OS drains
   * them. The copy is ~40 bytes per message, at <100 Hz control rates —
   * negligible. The DAW's hot paths (sequencer tick, note events) emit at
   * note-rate, well below the threshold where the alloc would matter.
   */
  private flush(cursor: number): void {
    const frame = Buffer.allocUnsafe(cursor);
    this.buf.copy(frame, 0, 0, cursor);
    this.socket.send(frame, 0, cursor, this.port, this.host);
  }

  /** Write null-terminated string with 4-byte padding. Returns new cursor. */
  private writeStringPadded(cursor: number, s: string): number {
    const bytes = Buffer.byteLength(s, 'utf8');
    this.buf.write(s, cursor, 'utf8');
    cursor += bytes;
    this.buf[cursor++] = 0;                            // null terminator
    // Pad to next 4-byte boundary (the null is one byte; remaining padding
    // brings the total including null up to a multiple of 4).
    const afterNull = cursor;
    const padded    = (afterNull + 3) & ~3;
    for (let i = afterNull; i < padded; i++) this.buf[i] = 0;
    return padded;
  }

  private writeInt32(cursor: number, v: number): number {
    this.buf.writeInt32BE(v | 0, cursor);
    return cursor + 4;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Send a note-on. /phobos/note_on ,iiii slotId, midiChannel, note, velocity
   *
   * The host's MIDI dispatch routes by `midiChannel` (1-indexed). Backend must
   * pass `channelIdx + 1` as `midiChannel` for the message to reach the right
   * plugin. `slotId` is preserved on the wire but not used for routing yet.
   */
  noteOn(slotId: number, midiChannel: number, note: number, velocity: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, ADDR_NOTE_ON);
    cursor = this.writeStringPadded(cursor, TYPE_IIII);
    cursor = this.writeInt32(cursor, slotId);
    cursor = this.writeInt32(cursor, midiChannel);
    cursor = this.writeInt32(cursor, note);
    cursor = this.writeInt32(cursor, velocity);
    this.flush(cursor);
  }

  /**
   * Send a note-off. /phobos/note_off ,iii slotId, midiChannel, note
   */
  noteOff(slotId: number, midiChannel: number, note: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, ADDR_NOTE_OFF);
    cursor = this.writeStringPadded(cursor, TYPE_III);
    cursor = this.writeInt32(cursor, slotId);
    cursor = this.writeInt32(cursor, midiChannel);
    cursor = this.writeInt32(cursor, note);
    this.flush(cursor);
  }

  /**
   * Send a control-change. /phobos/cc ,iiii slotId, midiChannel, controller, value
   */
  cc(slotId: number, midiChannel: number, controller: number, value: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, ADDR_CC);
    cursor = this.writeStringPadded(cursor, TYPE_IIII);
    cursor = this.writeInt32(cursor, slotId);
    cursor = this.writeInt32(cursor, midiChannel);
    cursor = this.writeInt32(cursor, controller);
    cursor = this.writeInt32(cursor, value);
    this.flush(cursor);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

// ── OscDecoder ────────────────────────────────────────────────────────────────
// Minimal decoder used only by the test harness to verify encode round-trips.
// Not a hot-path component — allocates strings freely.

export interface OscMessage {
  address: string;
  types:   string;        // without leading ','
  args:    Array<number | string>;
}

export class OscDecoder {
  decode(buf: Buffer, length: number): OscMessage {
    let cursor = 0;
    const address = this.readStringPadded(buf, cursor);
    cursor = address.nextCursor;

    const typesRaw = this.readStringPadded(buf, cursor);
    cursor = typesRaw.nextCursor;

    if (!typesRaw.value.startsWith(',')) {
      throw new Error(`OSC type tag must start with ',': got "${typesRaw.value}"`);
    }
    const types = typesRaw.value.slice(1);

    const args: Array<number | string> = [];
    for (const t of types) {
      if (t === 'i') {
        args.push(buf.readInt32BE(cursor));
        cursor += 4;
      } else if (t === 'f') {
        args.push(buf.readFloatBE(cursor));
        cursor += 4;
      } else if (t === 's') {
        const s = this.readStringPadded(buf, cursor);
        args.push(s.value);
        cursor = s.nextCursor;
      } else {
        throw new Error(`Unsupported OSC type tag: ${t}`);
      }
      if (cursor > length) throw new Error(`Decode overran buffer: cursor=${cursor} length=${length}`);
    }

    return { address: address.value, types, args };
  }

  private readStringPadded(buf: Buffer, cursor: number): { value: string; nextCursor: number } {
    let end = cursor;
    while (end < buf.length && buf[end] !== 0) end++;
    const value = buf.toString('utf8', cursor, end);
    const nextCursor = (end + 4) & ~3;       // step over null + pad to 4-byte boundary
    return { value, nextCursor };
  }
}
