/**
 * PhobosHostControl.ts — TCP/JSON RPC client for the PhobosHost binary.
 *
 * Speaks the wire contract documented in PHOBOS-PhobosHost-Spec.md §3.2 and
 * the Sessions 1–3 handoff:
 *
 *   Frame:     [4-byte uint32 BE body length][body — UTF-8 JSON, exactly N bytes]
 *   Request:   { id: <int>, op: "<name>", args: {...} }
 *   Response:  { id: <int>, ok: true,  result: {...} }
 *              { id: <int>, ok: false, error: "..." }
 *   Event:     { evt: "<name>", ... }    — no id, server-initiated
 *
 * The client owns one persistent TCP socket. New connections supersede old ones
 * on the host side, so reconnect is a clean replace, not a multiplex. The
 * manager (PhobosHostManager) decides when to (re)connect; this class is purely
 * the framing/correlation layer.
 *
 * Hot-path discipline:
 *   - Pre-allocated 4-byte length header buffer reused on every send (the body
 *     itself is variable-length; one Buffer.from per request is unavoidable).
 *   - Inbound parse uses a single rolling Buffer; we slice off frames in place
 *     rather than allocating per-message intermediates.
 *   - The pending-id map is a plain Map; entries are deleted on resolve/reject
 *     so it can't leak.
 */

import * as net from 'net';

// ── Wire envelope shapes ──────────────────────────────────────────────────────

export interface OpRequest {
  id:   number;
  op:   string;
  args: Record<string, unknown>;
}

export interface OpResponseOk {
  id:     number;
  ok:     true;
  result: Record<string, unknown>;
}

export interface OpResponseErr {
  id:    number;
  ok:    false;
  error: string;
}

export type OpResponse = OpResponseOk | OpResponseErr;

export interface ServerEvent {
  evt: string;
  [k: string]: unknown;
}

/** Sink for server-initiated events. Called on the message thread (Node main). */
export type EventListener = (event: ServerEvent) => void;

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_OP_TIMEOUT_MS = 30_000;   // generous — plugin scan/load can be slow

// ── Client ────────────────────────────────────────────────────────────────────

interface Pending {
  resolve: (env: OpResponse) => void;
  reject:  (err: Error) => void;
  timer:   NodeJS.Timeout;
}

export class PhobosHostControl {
  private socket:    net.Socket | null = null;
  private readBuf:   Buffer = Buffer.alloc(0);
  private pending:   Map<number, Pending> = new Map();
  private listeners: Set<EventListener> = new Set();
  private nextId:    number = 1;
  private host:      string;
  private port:      number;

  /** Pre-allocated length-prefix header. Reused on every send. */
  private readonly headBuf: Buffer = Buffer.alloc(4);

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Open the TCP connection. Resolves once connected. Rejects on socket error.
   *
   * Replacing a previous connection is the caller's responsibility — call
   * close() first if needed. Each connect() makes a fresh socket.
   */
  connect(): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error('PhobosHostControl already connected'));
    }
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port }, () => {
        // Disable Nagle — JSON frames are small and latency-sensitive.
        sock.setNoDelay(true);
        resolve();
      });
      sock.once('error', reject);
      sock.on('data',  (chunk) => this.onData(chunk));
      sock.on('close', ()      => this.onClose());
      this.socket = sock;
    });
  }

  /**
   * Close the socket. Pending requests reject with a clear error. Reset state
   * so connect() can be called again.
   */
  close(): void {
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.destroy();
    }
    this.failAllPending(new Error('PhobosHostControl closed'));
    this.readBuf = Buffer.alloc(0);
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  // ── Event subscription ─────────────────────────────────────────────────────

  addEventListener(fn: EventListener): void {
    this.listeners.add(fn);
  }

  removeEventListener(fn: EventListener): void {
    this.listeners.delete(fn);
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  /**
   * Send an op and await its response. Rejects on op timeout, on socket
   * disconnect mid-flight, or on framing error. The response envelope is
   * returned verbatim — the caller decides whether ok=false should throw.
   */
  send(op: string, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_OP_TIMEOUT_MS): Promise<OpResponse> {
    const sock = this.socket;
    if (!sock) return Promise.reject(new Error('PhobosHostControl not connected'));

    const id   = this.nextId++;
    const body = Buffer.from(JSON.stringify({ id, op, args }), 'utf8');
    this.headBuf.writeUInt32BE(body.length, 0);

    return new Promise<OpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`op '${op}' timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      // Two writes are coalesced by the kernel; cheaper than a Buffer.concat.
      sock.write(this.headBuf);
      sock.write(body);
    });
  }

  /**
   * Convenience: send and unwrap a successful result. Throws on ok=false or
   * any wire/timeout error. Returns the `result` field directly.
   */
  async call<T extends Record<string, unknown>>(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_OP_TIMEOUT_MS,
  ): Promise<T> {
    const env = await this.send(op, args, timeoutMs);
    if (env.ok) return env.result as T;
    throw new Error(`op '${op}' failed: ${env.error}`);
  }

  // ── Inbound framing ────────────────────────────────────────────────────────

  /**
   * Append incoming bytes and drain every complete frame. JSON parse failures
   * close the socket — they indicate a wire-protocol bug or a corrupt host.
   *
   * IMPORTANT: Node's TCP `data` event delivers buffers backed by a shared
   * internal slab that may be reused for subsequent reads. We MUST NOT alias
   * `chunk` across handler invocations — any tail we keep must be a copy
   * we own. Buffer.concat allocates a fresh buffer, which gives us that
   * ownership; subarray of *our* buffer is then safe because the storage is
   * ours too. The cost is one Buffer.concat per data event; for small JSON
   * frames at <100 Hz control rates this is negligible.
   */
  private onData(chunk: Buffer): void {
    this.readBuf = this.readBuf.length === 0
      ? Buffer.from(chunk)                   // copy — never alias
      : Buffer.concat([this.readBuf, chunk]);

    while (this.readBuf.length >= 4) {
      const bodyLen = this.readBuf.readUInt32BE(0);
      if (this.readBuf.length < 4 + bodyLen) break;

      const bodyBytes = this.readBuf.subarray(4, 4 + bodyLen);
      // Slice off the consumed frame — keep tail for the next iteration.
      // subarray here is safe: readBuf is our own copy, not a slab alias.
      this.readBuf = this.readBuf.subarray(4 + bodyLen);

      let env: OpResponse | ServerEvent;
      try {
        env = JSON.parse(bodyBytes.toString('utf8')) as OpResponse | ServerEvent;
      } catch (err) {
        console.error(`[PhobosHostControl] bad frame: ${(err as Error).message}`);
        this.close();
        return;
      }

      const evtField = (env as { evt?: unknown }).evt;
      const idField  = (env as { id?:  unknown }).id;
      if (typeof evtField === 'string') {
        this.dispatchEvent(env as ServerEvent);
      } else if (typeof idField === 'number') {
        this.dispatchResponse(env as OpResponse);
      } else {
        console.warn(`[PhobosHostControl] frame missing id and evt`);
      }
    }
  }

  private dispatchResponse(env: OpResponse): void {
    const pending = this.pending.get(env.id);
    if (!pending) {
      // Late response — id already timed out. Drop silently.
      return;
    }
    this.pending.delete(env.id);
    clearTimeout(pending.timer);
    pending.resolve(env);
  }

  private dispatchEvent(env: ServerEvent): void {
    for (const fn of this.listeners) {
      try { fn(env); }
      catch (err) {
        console.error(`[PhobosHostControl] event listener threw: ${(err as Error).message}`);
      }
    }
  }

  private onClose(): void {
    if (this.socket) {
      // Socket closed remotely (host crash, restart). Mark disconnected so
      // future send() rejects cleanly. Do not call close() — that would
      // recurse through the close handler we already removed.
      this.socket = null;
    }
    this.failAllPending(new Error('PhobosHostControl socket closed'));
    this.readBuf = Buffer.alloc(0);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
