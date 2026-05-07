/**
 * coordinator/PipeServer.ts
 *
 * Named pipe server — runs in the Coordinator process.
 * Accepts a single connection from the Fastify process.
 * All messages are newline-delimited JSON.
 *
 * The server tolerates Fastify restarts: when the client disconnects it keeps
 * listening so the reconnecting Fastify can re-establish without a coordinator restart.
 */

import net  from 'node:net';
import fs   from 'node:fs';
import path from 'node:path';

export const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\phobos-coordinator'
  : '/tmp/phobos-coordinator.sock';

export interface CoordinatorInbound {
  type:     'ENQUEUE' | 'ABORT' | 'PRIORITY_BUMP' | 'STATUS';
  taskId?:  string;
  payload?: unknown;
}

/**
 * Outbound messages from Coordinator → Fastify.
 *
 * SSE_EVENT: raw SSE payload — Fastify writes `data: ${JSON.stringify(data)}\n\n` to the HTTP stream.
 * PERSIST_EVENT: Fastify calls eventStore.insert() with the given fields.
 * THINK_CHUNK: Fastify calls segmentStore.appendToken().
 * THINK_PHASE_COMPLETE: Fastify calls segmentStore.closeLatestSegment().
 * AGENT_STATE: Fastify calls eventStore.insert() for agent_state.
 * DISPATCH_LOG: Fastify calls PromptLogStore.insert().
 * IMAGE_STATUS: Fastify writes SSE + optionally persists image_complete.
 * EXECUTE_RESULT: Fastify writes SSE execute_result event.
 * TASK_QUEUED: Coordinator accepted the task, position in queue.
 * TASK_STARTED: Coordinator began executing the task.
 * TASK_COMPLETE: Task finished — carries AttemptResult[] and lastPlanningContext.
 * TASK_ERROR: Task threw — carries error message.
 * TASK_ABORTED: Task was removed from queue before executing.
 * STATUS_REPLY: Response to a STATUS ping.
 */
export type CoordinatorOutbound =
  | { type: 'SSE_EVENT';           taskId: string; data: Record<string, unknown> }
  | { type: 'PERSIST_EVENT';       taskId: string; messageId: string; eventType: string; payload: unknown }
  | { type: 'THINK_CHUNK';         taskId: string; messageId: string; content: string; source: 'coordinator' | 'engine' }
  | { type: 'THINK_PHASE_COMPLETE';taskId: string; messageId: string; source: 'coordinator' | 'engine' }
  | { type: 'AGENT_STATE';         taskId: string; messageId: string; event: unknown }
  | { type: 'DISPATCH_LOG';        taskId: string; messageId: string; info: unknown }
  | { type: 'IMAGE_STATUS';        taskId: string; status: unknown }
  | { type: 'EXECUTE_RESULT';      taskId: string; result: unknown }
  | { type: 'TASK_QUEUED';         taskId: string; position: number }
  | { type: 'TASK_STARTED';        taskId: string }
  | { type: 'TASK_COMPLETE';       taskId: string; attempts: unknown[]; lastPlanningContext: unknown; latencyMs: number }
  | { type: 'TASK_ERROR';          taskId: string; error: string }
  | { type: 'TASK_ABORTED';        taskId: string }
  | { type: 'STATUS_REPLY';        data: unknown };

type MessageHandler = (msg: CoordinatorInbound) => void;

export class PipeServer {
  private server:  net.Server | null  = null;
  private client:  net.Socket | null  = null;
  private handler: MessageHandler | null = null;
  private buf      = '';

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  send(msg: CoordinatorOutbound): void {
    if (!this.client || this.client.destroyed) return;
    this.client.write(JSON.stringify(msg) + '\n');
  }

  async listen(): Promise<void> {
    // Remove stale socket file on Unix before binding.
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(PIPE_PATH); } catch { /* not present — fine */ }
      fs.mkdirSync(path.dirname(PIPE_PATH), { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        console.log('[PipeServer] Fastify connected');
        this.client = socket;
        this.buf    = '';

        socket.setEncoding('utf8');

        socket.on('data', (chunk: string) => {
          this.buf += chunk;
          const lines = this.buf.split('\n');
          this.buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed) as CoordinatorInbound;
              this.handler?.(msg);
            } catch (err) {
              console.warn('[PipeServer] Malformed message:', trimmed, err);
            }
          }
        });

        socket.on('close', () => {
          console.log('[PipeServer] Fastify disconnected — waiting for reconnect');
          this.client = null;
          this.buf    = '';
        });

        socket.on('error', (err) => {
          console.warn('[PipeServer] Socket error:', err.message);
        });
      });

      this.server.once('error', reject);
      this.server.listen(PIPE_PATH, () => {
        console.log(`[PipeServer] Listening on ${PIPE_PATH}`);
        resolve();
      });
    });
  }

  close(): void {
    this.client?.destroy();
    this.server?.close();
    this.client = null;
    this.server = null;
  }
}
