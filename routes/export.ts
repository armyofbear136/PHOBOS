import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { MessageStore } from '../db/MessageStore.js';
import { MessageEventStore } from '../db/MessageEventStore.js';
import { ThinkingSegmentStore } from '../db/ThinkingSegmentStore.js';
import { ThreadStore } from '../db/ThreadStore.js';
import { PromptLogStore } from '../db/PromptLogStore.js';

/**
 * GET /api/threads/:id/export
 *
 * Builds a complete chronological transcript of a thread and returns it as
 * a plain-text file. Covers everything that happened, in order:
 *
 *   - Every user message and assistant reply
 *   - Every coordinator bubble (SAYON summaries, clarification questions)
 *   - Every internal prompt sent to SAYON and SEREN (thinking traces)
 *   - Every file written to the workspace (write_file tool calls)
 *   - Patches applied, build results, review scores
 *   - Dispatch metadata: model, tokens, latency, result
 *
 * The goal is a single file you can read top-to-bottom to see exactly what
 * every model was thinking at every stage — the prompts going in, the
 * reasoning happening, and the outputs coming out.
 *
 * Format: plain text with clear section dividers and ISO timestamps.
 * Intended for manual debugging — no JSON, no markdown tables.
 */
export async function exportRoute(fastify: FastifyInstance): Promise<void> {
  const db            = DatabaseManager.getInstance();
  const messageStore  = new MessageStore(db);
  const eventStore    = new MessageEventStore(db);
  const segmentStore  = new ThinkingSegmentStore(db);
  const threadStore   = new ThreadStore(db);
  const promptLogStore = new PromptLogStore(db);

  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/export',
    async (req, reply) => {
      const { id: threadId } = req.params;

      const thread = await threadStore.getById(threadId);
      if (!thread) return reply.status(404).send({ error: 'Thread not found' });

      // ── Load all raw data ──────────────────────────────────────────────────
      const [messages, events, segments, promptLogs] = await Promise.all([
        messageStore.getByThread(threadId, /* includeThinking */ true),
        eventStore.getByThread(threadId),
        segmentStore.getByThread(threadId),
        promptLogStore.getByThread(threadId),
      ]);

      // Dispatch logs joined per message
      const dispatchRows = await db.query<{
        id: string;
        message_id: string | null;
        model: string;
        input_tokens: number;
        think_tokens: number;
        output_tokens: number;
        latency_ms: number;
        task_type: string | null;
        result: string;
        created_at: string;
      }>(`SELECT * FROM dispatch_log WHERE message_id IN (
            SELECT id FROM messages WHERE thread_id = ?
          ) ORDER BY created_at ASC`, [threadId]);

      // Index structures for fast lookup
      const segmentsByMessage = new Map<string, typeof segments>();
      for (const seg of segments) {
        if (!segmentsByMessage.has(seg.id.split('_')[0])) {
          // segments don't carry message_id directly in the view — re-query
        }
      }

      // Re-fetch segments with message_id included (ThinkingSegmentStore view strips it)
      const rawSegments = await db.query<{
        id: string;
        message_id: string;
        phase: 'coordinator' | 'engine';
        content: string;
        token_count: number;
        seq: number;
        started_at: string;
        completed_at: string | null;
      }>(`SELECT * FROM thinking_segments WHERE thread_id = ? ORDER BY started_at ASC, seq ASC`, [threadId]);

      const segsByMsg = new Map<string, typeof rawSegments>();
      for (const seg of rawSegments) {
        const list = segsByMsg.get(seg.message_id) ?? [];
        list.push(seg);
        segsByMsg.set(seg.message_id, list);
      }

      const eventsByMsg = new Map<string, typeof events>();
      const threadEvents: typeof events = []; // events with no message_id
      for (const ev of events) {
        if (!ev.message_id) { threadEvents.push(ev); continue; }
        const list = eventsByMsg.get(ev.message_id) ?? [];
        list.push(ev);
        eventsByMsg.set(ev.message_id, list);
      }

      const dispatchByMsg = new Map<string, typeof dispatchRows>();
      for (const d of dispatchRows) {
        if (!d.message_id) continue;
        const list = dispatchByMsg.get(d.message_id) ?? [];
        list.push(d);
        dispatchByMsg.set(d.message_id, list);
      }

      // Prompt logs — indexed by message_id, with overflow bucket for untagged entries
      const promptsByMsg = new Map<string, typeof promptLogs>();
      const untaggedPrompts: typeof promptLogs = [];
      for (const p of promptLogs) {
        if (!p.message_id) { untaggedPrompts.push(p); continue; }
        const list = promptsByMsg.get(p.message_id) ?? [];
        list.push(p);
        promptsByMsg.set(p.message_id, list);
      }

      // ── Build the transcript ───────────────────────────────────────────────
      const lines: string[] = [];

      const rule  = (char = '─', len = 80) => char.repeat(len);
      const heavy = () => rule('═');
      const mid   = () => rule('─');
      const thin  = () => rule('·');

      const fmt = (iso: string) => {
        try { return new Date(iso).toLocaleString('en-US', { hour12: false }); }
        catch { return iso; }
      };

      lines.push(heavy());
      lines.push(`  PHOBOS CONVERSATION EXPORT`);
      lines.push(`  Thread : ${thread.title}`);
      lines.push(`  ID     : ${threadId}`);
      lines.push(`  Exported: ${new Date().toLocaleString('en-US', { hour12: false })}`);
      lines.push(`  Messages: ${messages.length}  |  Events: ${events.length}  |  Thinking segments: ${rawSegments.length}`);
      lines.push(heavy());
      lines.push('');

      // ── Per-message blocks ─────────────────────────────────────────────────
      for (const msg of messages) {
        const msgSegs     = segsByMsg.get(msg.id) ?? [];
        const msgEvents   = eventsByMsg.get(msg.id) ?? [];
        const msgDispatch = dispatchByMsg.get(msg.id) ?? [];

        // ── Message header ─────────────────────────────────────────────────
        const roleLabel =
          msg.role === 'user'      ? '👤 USER' :
          msg.role === 'assistant' ? '🤖 ASSISTANT' :
          msg.role === 'coordinator' ? '🔵 SAYON (coordinator)' :
          `[${msg.role.toUpperCase()}]`;

        lines.push(heavy());
        lines.push(`${roleLabel}  ·  ${fmt(msg.created_at)}`);
        lines.push(`Message ID: ${msg.id}`);
        lines.push(mid());

        if (msg.content && msg.content.trim()) {
          lines.push(msg.content.trim());
        } else {
          lines.push('[no content]');
        }

        // ── Dispatch metadata ──────────────────────────────────────────────
        if (msgDispatch.length > 0) {
          lines.push('');
          lines.push(thin());
          lines.push('  DISPATCH METADATA');
          lines.push(thin());
          for (const d of msgDispatch) {
            lines.push(`  Model     : ${d.model}`);
            lines.push(`  Task type : ${d.task_type ?? 'n/a'}`);
            lines.push(`  Result    : ${d.result}`);
            lines.push(`  Tokens    : ${d.input_tokens} in / ${d.think_tokens} think / ${d.output_tokens} out`);
            lines.push(`  Latency   : ${d.latency_ms}ms`);
            lines.push(`  Time      : ${fmt(d.created_at)}`);
          }
        }

        // ── Prompt log: every internal AI call for this message ───────────
        const msgPrompts = promptsByMsg.get(msg.id) ?? [];
        for (const p of msgPrompts) {
          const roleLabel = p.role === 'sayon' ? '🔵 SAYON' : '🟠 SEREN';
          const stageLabel = p.stage.toUpperCase();
          lines.push('');
          lines.push(mid());
          lines.push(`  ${roleLabel} PROMPT  ·  stage: ${stageLabel}  ·  ${fmt(p.created_at)}  ·  ${p.latency_ms}ms`);
          lines.push(mid());
          lines.push(p.prompt.trim());
          lines.push('');
          lines.push(thin());
          lines.push(`  ${roleLabel} RESPONSE  ·  stage: ${stageLabel}`);
          lines.push(thin());
          lines.push(p.response.trim());
        }

        // ── Events attached to this message ───────────────────────────────
        for (const ev of msgEvents) {
          if (ev.event_type === 'think_chunk' || ev.event_type === 'output_chunk') continue; // ephemeral
          if (ev.event_type === 'activity') continue; // covered by status blocks inline

          lines.push('');
          lines.push(thin());

          try {
            const payload = JSON.parse(ev.payload) as Record<string, unknown>;

            if (ev.event_type === 'coordinator') {
              lines.push(`  COORDINATOR BUBBLE  [${fmt(ev.created_at)}]`);
              lines.push(thin());
              lines.push(String(payload.content ?? ''));

            } else if (ev.event_type === 'file_panel') {
              lines.push(`  FILE WRITTEN: ${payload.filename}  [${fmt(ev.created_at)}]`);
              lines.push(thin());
              const code = String(payload.code ?? '');
              // Truncate very large files in the export — full content visible in workspace
              if (code.length > 8000) {
                lines.push(code.slice(0, 8000));
                lines.push(`  ... [truncated — ${code.length} chars total; open in workspace for full content]`);
              } else {
                lines.push(code);
              }

            } else if (ev.event_type === 'patches_applied') {
              const files = (payload.files as string[]) ?? [];
              lines.push(`  PATCHES APPLIED: ${payload.count} patch(es) to: ${files.join(', ')}  [${fmt(ev.created_at)}]`);

            } else if (ev.event_type === 'thinking_complete') {
              const source = String(payload.source ?? 'unknown');
              const label  = source === 'coordinator' ? 'SAYON THINKING' : 'SEREN THINKING';
              const content = String(payload.content ?? '');
              lines.push(`  ${label} (via event)  [${fmt(ev.created_at)}]`);
              lines.push(thin());
              lines.push(content.trim());

            } else if (ev.event_type === 'agent_state') {
              const state = String((payload as any).state ?? payload.type ?? 'unknown');
              const detail = String((payload as any).detail ?? '');
              lines.push(`  AGENT STATE: ${state}${detail ? ` — ${detail}` : ''}  [${fmt(ev.created_at)}]`);
            }
          } catch {
            lines.push(`  [EVENT: ${ev.event_type} — unparseable payload]`);
          }
        }

        // ── Thinking segments (full reasoning traces) ─────────────────────
        if (msgSegs.length > 0) {
          for (const seg of msgSegs) {
            if (!seg.content?.trim()) continue;
            const label = seg.phase === 'coordinator' ? 'SAYON REASONING' : 'SEREN REASONING';
            const dur = seg.completed_at
              ? `${Math.round((new Date(seg.completed_at).getTime() - new Date(seg.started_at).getTime()) / 1000)}s`
              : 'incomplete';

            lines.push('');
            lines.push(mid());
            lines.push(`  ◆ ${label}  ·  ${fmt(seg.started_at)}  ·  ${seg.token_count} tokens  ·  ${dur}`);
            lines.push(mid());
            lines.push(seg.content.trim());
          }
        }

        lines.push('');
      }

      // ── Untagged prompt logs (no message_id — turn context not set yet) ────
      if (untaggedPrompts.length > 0) {
        lines.push(heavy());
        lines.push('  UNTAGGED PROMPT LOGS (fired before message ID was assigned)');
        lines.push(heavy());
        for (const p of untaggedPrompts) {
          const roleLabel = p.role === 'sayon' ? '🔵 SAYON' : '🟠 SEREN';
          lines.push(`${roleLabel}  ·  stage: ${p.stage.toUpperCase()}  ·  ${fmt(p.created_at)}  ·  ${p.latency_ms}ms`);
          lines.push(mid());
          lines.push(p.prompt.trim());
          lines.push('');
          lines.push(thin());
          lines.push(`  RESPONSE`);
          lines.push(thin());
          lines.push(p.response.trim());
          lines.push('');
        }
      }

      // ── Thread-level events (no message_id) ───────────────────────────────
      if (threadEvents.length > 0) {
        lines.push(heavy());
        lines.push('  THREAD-LEVEL EVENTS (not attached to a specific message)');
        lines.push(heavy());
        for (const ev of threadEvents) {
          try {
            const payload = JSON.parse(ev.payload) as Record<string, unknown>;
            lines.push(`[${ev.event_type}]  ${fmt(ev.created_at)}`);
            lines.push(JSON.stringify(payload, null, 2));
            lines.push('');
          } catch {
            lines.push(`[${ev.event_type}]  ${fmt(ev.created_at)}  —  unparseable`);
          }
        }
      }

      lines.push(heavy());
      lines.push(`  END OF EXPORT  ·  ${messages.length} messages  ·  ${rawSegments.length} thinking segments  ·  ${promptLogs.length} prompt log entries`);
      lines.push(heavy());

      // ── Send as downloadable text file ─────────────────────────────────────
      const filename = `phobos-export-${threadId.slice(0, 8)}-${Date.now()}.txt`;
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(lines.join('\n'));
    }
  );
}
