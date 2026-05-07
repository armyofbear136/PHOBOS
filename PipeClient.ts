/**
 * PipeClient.ts  (repo root — Fastify side)
 *
 * Named pipe client that lives in the Fastify process.
 * Connects to the Coordinator's PipeServer.
 * Auto-reconnects with 500ms backoff on disconnect or error.
 * Queues outbound messages during disconnect and flushes on reconnect.
 */

import net from 'node:net';
import { PIPE_PATH } from './coordinator/PipeServer.js';
import type { CoordinatorInbound, CoordinatorOutbound } from './coordinator/PipeServer.js';

type ResponseHandler    = (msg: CoordinatorOutbound) => void;
type TaskHandler        = (msg: CoordinatorOutbound) => void;

class PipeClient {
  private socket:    net.Socket | null = null;
  private buf        = '';
  private queue:     string[] = [];
  private handler:   ResponseHandler | null = null;
  // Per-taskId handlers — registered by CoordinatorBridge, cleaned up on TASK_COMPLETE/ERROR/ABORTED
  private taskHandlers = new Map<string, TaskHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  get connected(): boolean { return this._connected; }

  onMessage(handler: ResponseHandler): void {
    this.handler = handler;
  }

  /** Register a handler for all messages belonging to a specific taskId. */
  onTask(taskId: string, handler: TaskHandler): void {
    this.taskHandlers.set(taskId, handler);
  }

  /** Remove the per-taskId handler (call after TASK_COMPLETE / TASK_ERROR / TASK_ABORTED). */
  offTask(taskId: string): void {
    this.taskHandlers.delete(taskId);
  }

  connect(): void {
    if (this.socket && !this.socket.destroyed) return;

    const socket = net.createConnection(PIPE_PATH);
    this.socket = socket;

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      this._connected = true;
      console.log('[PipeClient] Connected to Coordinator');
      for (const line of this.queue) socket.write(line);
      this.queue.length = 0;
    });

    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as CoordinatorOutbound;
          // Route to per-task handler first if taskId present
          const taskId = (msg as Record<string, unknown>).taskId as string | undefined;
          if (taskId && this.taskHandlers.has(taskId)) {
            this.taskHandlers.get(taskId)!(msg);
          } else {
            this.handler?.(msg);
          }
        } catch (err) {
          console.warn('[PipeClient] Malformed message:', trimmed, err);
        }
      }
    });

    socket.on('close', () => {
      this._connected = false;
      this.socket = null;
      this.buf = '';
      this._scheduleReconnect();
    });

    socket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        console.warn('[PipeClient] Socket error:', err.message);
      }
      this._connected = false;
      this.socket?.destroy();
      this.socket = null;
    });
  }

  send(msg: CoordinatorInbound): void {
    const line = JSON.stringify(msg) + '\n';
    if (this._connected && this.socket && !this.socket.destroyed) {
      this.socket.write(line);
    } else {
      if (this.queue.length < 256) this.queue.push(line);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 500);
  }
}

export const coordinatorPipe = new PipeClient();
