import * as dgram from 'dgram';

// ── OscClient ─────────────────────────────────────────────────────────────────
// Minimal OSC 1.0 UDP client for the Carla OSC control surface on port 16331.
//
// Hot-path guarantees:
//   • One pre-allocated send buffer (OSC_BUFFER_BYTES). Reused on every call.
//   • No Buffer.alloc, no Buffer.concat, no string allocation beyond the
//     address path itself (one Buffer.from per send — minimum required since
//     the address is caller-provided and variable-length).
//   • Cursor-based writes; no per-field allocations.
//
// OSC wire format (we implement only what Carla needs):
//   [address string, null-terminated, padded to 4-byte boundary]
//   [type tag string ",<types>", null-terminated, padded to 4-byte boundary]
//   [argument values, big-endian, each padded to 4-byte boundary]
//
// Supported types:
//   i  int32      Big-endian signed int
//   f  float32    Big-endian IEEE-754
//   s  string     Null-terminated, 4-byte padded
//
// Carla OSC surface we send to (documented at hoisted layer in CarlaManager):
//   /Carla/0/<pluginIdx>/set_parameter_value    i f     → int paramId, float value
//   /Carla/0/<pluginIdx>/set_program            i       → int programIdx
//   /Carla/0/<pluginIdx>/note_on                i i i   → channel, note, velocity
//   /Carla/0/<pluginIdx>/note_off               i i     → channel, note
//   /Carla/0/load_project                       s       → string path
// ─────────────────────────────────────────────────────────────────────────────

const OSC_BUFFER_BYTES = 512;  // High-water mark. Largest message is load_project
                                // with a fully-qualified path (~256 chars + header).

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
   * negligible. The engine's actual hot paths (sequencer tick, note
   * events) still avoid allocation; OSC control messages are not hot.
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
    // Pad to next 4-byte boundary (at least one pad byte required — the null
    // is only one byte, remaining padding brings total including null up to
    // a multiple of 4).
    const afterNull = cursor;
    const padded    = (afterNull + 3) & ~3;
    for (let i = afterNull; i < padded; i++) this.buf[i] = 0;
    return padded;
  }

  private writeInt32(cursor: number, v: number): number {
    this.buf.writeInt32BE(v | 0, cursor);
    return cursor + 4;
  }

  private writeFloat32(cursor: number, v: number): number {
    this.buf.writeFloatBE(v, cursor);
    return cursor + 4;
  }

  // ── Public API — message builders + send ─────────────────────────────────

  /**
   * Send a parameter set: /Carla/0/<pluginIdx>/set_parameter_value i f
   */
  setParam(pluginIdx: number, paramId: number, value: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/set_parameter_value`);
    cursor = this.writeStringPadded(cursor, ',if');
    cursor = this.writeInt32(cursor, paramId);
    cursor = this.writeFloat32(cursor, value);
    this.flush(cursor);
  }

  /**
   * Send a program change: /Carla/0/<pluginIdx>/set_program i
   */
  setProgram(pluginIdx: number, programIdx: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/set_program`);
    cursor = this.writeStringPadded(cursor, ',i');
    cursor = this.writeInt32(cursor, programIdx);
    this.flush(cursor);
  }

  /**
   * Note on: /Carla/0/<pluginIdx>/note_on i i i
   */
  noteOn(pluginIdx: number, channel: number, note: number, velocity: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/note_on`);
    cursor = this.writeStringPadded(cursor, ',iii');
    cursor = this.writeInt32(cursor, channel);
    cursor = this.writeInt32(cursor, note);
    cursor = this.writeInt32(cursor, velocity);
    this.flush(cursor);
  }

  /**
   * Note off: /Carla/0/<pluginIdx>/note_off i i
   */
  noteOff(pluginIdx: number, channel: number, note: number): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/note_off`);
    cursor = this.writeStringPadded(cursor, ',ii');
    cursor = this.writeInt32(cursor, channel);
    cursor = this.writeInt32(cursor, note);
    this.flush(cursor);
  }

  /**
   * Show/hide the plugin's native (custom) UI:
   * /Carla/0/<pluginIdx>/show_custom_ui i (1 = show, 0 = hide)
   */
  showCustomUi(pluginIdx: number, show: boolean): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/show_custom_ui`);
    cursor = this.writeStringPadded(cursor, ',i');
    cursor = this.writeInt32(cursor, show ? 1 : 0);
    this.flush(cursor);
  }

  /**
   * Activate/bypass a plugin:
   * /Carla/0/<pluginIdx>/set_active i (1 = active, 0 = bypassed)
   */
  setActive(pluginIdx: number, active: boolean): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/${pluginIdx}/set_active`);
    cursor = this.writeStringPadded(cursor, ',i');
    cursor = this.writeInt32(cursor, active ? 1 : 0);
    this.flush(cursor);
  }

  /**
   * Load project: /Carla/0/load_project s
   */
  loadProject(path: string): void {
    if (this.closed) return;
    let cursor = 0;
    cursor = this.writeStringPadded(cursor, `/Carla/0/load_project`);
    cursor = this.writeStringPadded(cursor, ',s');
    cursor = this.writeStringPadded(cursor, path);
    this.flush(cursor);
  }

  /**
   * Encode a message into a provided output buffer. Used by tests for
   * round-trip verification against OscDecoder. Returns bytes written.
   */
  encodeSetParam(outBuf: Buffer, pluginIdx: number, paramId: number, value: number): number {
    let cursor = 0;
    const s1 = `/Carla/0/${pluginIdx}/set_parameter_value`;
    const s2 = ',if';
    cursor = writeStringPaddedInto(outBuf, cursor, s1);
    cursor = writeStringPaddedInto(outBuf, cursor, s2);
    outBuf.writeInt32BE(paramId | 0, cursor); cursor += 4;
    outBuf.writeFloatBE(value, cursor);       cursor += 4;
    return cursor;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

// Standalone helpers for tests that don't want a live socket.

function writeStringPaddedInto(buf: Buffer, cursor: number, s: string): number {
  const bytes = Buffer.byteLength(s, 'utf8');
  buf.write(s, cursor, 'utf8');
  cursor += bytes;
  buf[cursor++] = 0;
  const padded = (cursor + 3) & ~3;
  for (let i = cursor; i < padded; i++) buf[i] = 0;
  return padded;
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
