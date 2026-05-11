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
 * a plain-text file. All items (prompts, events, thinking) are interleaved
 * by timestamp so you can read top-to-bottom and see exactly what happened
 * in the order it happened.
 */
export async function exportRoute(fastify: FastifyInstance): Promise<void> {
  const db             = DatabaseManager.getUserDb();
  const messageStore   = new MessageStore(db);
  const eventStore     = new MessageEventStore(db);
  const segmentStore   = new ThinkingSegmentStore(db);
  const threadStore    = new ThreadStore(db);
  const promptLogStore = new PromptLogStore(db);

  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/export',
    async (req, reply) => {
      const { id: threadId } = req.params;

      const thread = await threadStore.getById(threadId);
      if (!thread) return reply.status(404).send({ error: 'Thread not found' });

      // ── Load all raw data ──────────────────────────────────────────────────
      const [messages, events, promptLogs] = await Promise.all([
        messageStore.getByThread(threadId, /* includeThinking */ true),
        eventStore.getByThread(threadId),
        promptLogStore.getByThread(threadId),
      ]);

      // Dispatch logs
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

      // Re-fetch segments with message_id
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

      // ── Index all data by message_id ──────────────────────────────────────
      const segsByMsg    = new Map<string, typeof rawSegments>();
      const eventsByMsg  = new Map<string, typeof events>();
      const threadEvents: typeof events = [];
      const dispatchByMsg = new Map<string, typeof dispatchRows>();
      const promptsByMsg = new Map<string, typeof promptLogs>();
      const untaggedPrompts: typeof promptLogs = [];

      for (const seg of rawSegments) {
        const list = segsByMsg.get(seg.message_id) ?? [];
        list.push(seg);
        segsByMsg.set(seg.message_id, list);
      }
      for (const ev of events) {
        if (!ev.message_id) { threadEvents.push(ev); continue; }
        const list = eventsByMsg.get(ev.message_id) ?? [];
        list.push(ev);
        eventsByMsg.set(ev.message_id, list);
      }
      for (const d of dispatchRows) {
        if (!d.message_id) continue;
        const list = dispatchByMsg.get(d.message_id) ?? [];
        list.push(d);
        dispatchByMsg.set(d.message_id, list);
      }
      for (const p of promptLogs) {
        if (!p.message_id) { untaggedPrompts.push(p); continue; }
        const list = promptsByMsg.get(p.message_id) ?? [];
        list.push(p);
        promptsByMsg.set(p.message_id, list);
      }

      // ── Format helpers ────────────────────────────────────────────────────
      const rule  = (char = '─', len = 80) => char.repeat(len);
      const heavy = () => rule('═');
      const mid   = () => rule('─');
      const thin  = () => rule('·');
      const dot   = () => rule('·', 40);

      const fmt = (iso: string) => {
        try { return new Date(iso).toLocaleString('en-US', { hour12: false }); }
        catch { return iso; }
      };

      const tsMs = (iso: string) => {
        try { return new Date(iso).getTime(); }
        catch { return 0; }
      };

      // ── Build transcript ──────────────────────────────────────────────────
      const lines: string[] = [];

      lines.push(heavy());
      lines.push(`  PHOBOS CONVERSATION EXPORT`);
      lines.push(`  Thread : ${thread.title}`);
      lines.push(`  ID     : ${threadId}`);
      lines.push(`  Exported: ${new Date().toLocaleString('en-US', { hour12: false })}`);
      lines.push(`  Messages: ${messages.length}  |  Events: ${events.length}  |  Thinking segments: ${rawSegments.length}`);
      lines.push(heavy());
      lines.push('');

      for (const msg of messages) {
        const msgSegs     = segsByMsg.get(msg.id) ?? [];
        const msgEvents   = eventsByMsg.get(msg.id) ?? [];
        const msgDispatch = dispatchByMsg.get(msg.id) ?? [];
        const msgPrompts  = promptsByMsg.get(msg.id) ?? [];

        // ── Message header ─────────────────────────────────────────────────
        const roleLabel =
          msg.role === 'user'        ? '👤 USER' :
          msg.role === 'assistant'   ? '🤖 ASSISTANT' :
          msg.role === 'coordinator' ? '🔵 SAYON (coordinator)' :
          `[${msg.role.toUpperCase()}]`;

        lines.push(heavy());
        lines.push(`${roleLabel}  ·  ${fmt(msg.created_at)}`);
        lines.push(`Message ID: ${msg.id}`);
        lines.push(mid());

        if (msg.content?.trim()) {
          lines.push(msg.content.trim());
        } else {
          lines.push('[no content]');
        }

        // ── Dispatch metadata (compact summary, before timeline) ────────────
        if (msgDispatch.length > 0) {
          lines.push('');
          lines.push(thin());
          lines.push('  DISPATCH METADATA');
          lines.push(thin());
          for (const d of msgDispatch) {
            lines.push(`  [${fmt(d.created_at)}]  ${d.model}  ${d.input_tokens}in/${d.think_tokens}think/${d.output_tokens}out  ${d.latency_ms}ms  → ${d.result}`);
          }
        }

        // ── Build unified timeline for this message ───────────────────────
        // Everything gets a timestamp and type tag, then sorted ascending.
        type TimelineItem =
          | { ts: number; kind: 'prompt';  data: (typeof promptLogs)[number] }
          | { ts: number; kind: 'event';   data: (typeof events)[number] }
          | { ts: number; kind: 'segment'; data: (typeof rawSegments)[number] };

        const timeline: TimelineItem[] = [];

        for (const p of msgPrompts) {
          timeline.push({ ts: tsMs(p.created_at), kind: 'prompt', data: p });
        }
        for (const ev of msgEvents) {
          // Skip ephemeral and low-value events
          if (ev.event_type === 'think_chunk' || ev.event_type === 'output_chunk') continue;
          if (ev.event_type === 'activity') continue;
          timeline.push({ ts: tsMs(ev.created_at), kind: 'event', data: ev });
        }
        for (const seg of msgSegs) {
          if (!seg.content?.trim()) continue;
          timeline.push({ ts: tsMs(seg.started_at), kind: 'segment', data: seg });
        }

        // Sort by timestamp ascending — items at same ms keep insertion order
        timeline.sort((a, b) => a.ts - b.ts);

        // ── Render timeline ────────────────────────────────────────────────
        for (const item of timeline) {
          lines.push('');

          if (item.kind === 'prompt') {
            const p = item.data;
            const who   = p.role === 'sayon' ? '🔵 SAYON' : '🟠 SEREN';
            const stage = p.stage.toUpperCase();
            lines.push(mid());
            lines.push(`  ${who} PROMPT  ·  stage: ${stage}  ·  ${fmt(p.created_at)}  ·  ${p.latency_ms}ms`);
            lines.push(mid());
            lines.push(p.prompt.trim());
            lines.push('');
            lines.push(thin());
            lines.push(`  ${who} RESPONSE  ·  stage: ${stage}`);
            lines.push(thin());
            lines.push(p.response.trim());

          } else if (item.kind === 'segment') {
            const seg = item.data;
            const label = seg.phase === 'coordinator' ? '◆ SAYON REASONING' : '◆ SEREN REASONING';
            const dur = seg.completed_at
              ? `${Math.round((new Date(seg.completed_at).getTime() - new Date(seg.started_at).getTime()) / 1000)}s`
              : 'incomplete';
            lines.push(mid());
            lines.push(`  ${label}  ·  ${fmt(seg.started_at)}  ·  ${seg.token_count} tokens  ·  ${dur}`);
            lines.push(mid());
            lines.push(seg.content.trim());

          } else if (item.kind === 'event') {
            const ev = item.data;
            lines.push(thin());
            try {
              const payload = JSON.parse(ev.payload) as Record<string, unknown>;

              if (ev.event_type === 'coordinator') {
                lines.push(`  COORDINATOR BUBBLE  [${fmt(ev.created_at)}]`);
                lines.push(thin());
                lines.push(String(payload.content ?? ''));

              } else if (ev.event_type === 'file_panel') {
                const code = String(payload.code ?? '');
                lines.push(`  FILE WRITTEN: ${payload.filename}  [${fmt(ev.created_at)}]`);
                lines.push(thin());
                if (code.length > 8000) {
                  lines.push(code.slice(0, 8000));
                  lines.push(`  ... [truncated — ${code.length} chars total]`);
                } else {
                  lines.push(code);
                }

              } else if (ev.event_type === 'patches_applied') {
                const files = (payload.files as string[]) ?? [];
                lines.push(`  PATCHES APPLIED: ${payload.count} patch(es) → ${files.join(', ')}  [${fmt(ev.created_at)}]`);

              } else if (ev.event_type === 'thinking_complete') {
                // Thinking segments are rendered from the segment records (richer data).
                // thinking_complete events are duplicates — skip to avoid double-printing.
                continue;

              } else if (ev.event_type === 'agent_state') {
                const state  = String((payload as Record<string, unknown>).state  ?? payload.type   ?? 'unknown');
                const detail = String((payload as Record<string, unknown>).detail ?? '');
                const task   = (payload as Record<string, unknown>).taskIndex != null
                  ? ` [${(payload as Record<string, unknown>).taskIndex}/${(payload as Record<string, unknown>).total}]`
                  : '';
                lines.push(`  AGENT STATE: ${state}${detail ? ` — ${detail}` : ''}${task}  [${fmt(ev.created_at)}]`);

              } else {
                // Cast to string so TypeScript doesn't complain about union exhaustiveness
                // for event types added after the schema was defined.
                const evType = ev.event_type as string;
                if (evType === 'task_start') {
                  lines.push(`  ▶ TASK ${payload.taskIndex}/${payload.total}: ${payload.title}  [${fmt(ev.created_at)}]`);

                } else if (evType === 'task_complete') {
                  lines.push(`  ✓ TASK ${payload.taskIndex}/${payload.total}: ${payload.title}  [${fmt(ev.created_at)}]`);

                } else if (evType === 'task_failed') {
                  lines.push(`  ✗ TASK ${payload.taskIndex}/${payload.total}: ${payload.title}  [${fmt(ev.created_at)}]`);
                  if (payload.reason) lines.push(`    Reason: ${payload.reason}`);

                } else if (evType === 'review') {
                  const dec = String(payload.decision ?? '');
                  const score = payload.score != null ? ` (${payload.score})` : '';
                  lines.push(`  REVIEW: ${dec}${score}  [${fmt(ev.created_at)}]`);
                  if (payload.guidance) lines.push(`    Guidance: ${String(payload.guidance).slice(0, 200)}`);

                } else if (evType === 'build_result') {
                  const ok = payload.success ? '✓ BUILD PASSED' : '✗ BUILD FAILED';
                  lines.push(`  ${ok}  [${fmt(ev.created_at)}]`);
                  if (!payload.success && payload.errors) {
                    lines.push(`    ${String(payload.errors).slice(0, 400)}`);
                  }

                } else if (evType === 'image_workflow_created') {
                  lines.push(`  IMAGE WORKFLOW CREATED: ${payload.name ?? payload.workflowId}  [${fmt(ev.created_at)}]`);
                  if (payload.prompt) lines.push(`    Prompt: ${String(payload.prompt).slice(0, 120)}`);

                } else {
                  // Unknown event — show raw
                  lines.push(`  [${ev.event_type}]  [${fmt(ev.created_at)}]`);
                  lines.push(`    ${JSON.stringify(payload).slice(0, 200)}`);
                }
              } // end evType switch
            } catch {
              lines.push(`  [EVENT: ${ev.event_type} — unparseable payload]  [${fmt(ev.created_at)}]`);
            }
          }
        }

        lines.push('');
      }

      // ── Untagged prompt logs ──────────────────────────────────────────────
      if (untaggedPrompts.length > 0) {
        lines.push(heavy());
        lines.push('  UNTAGGED PROMPTS (fired before message ID was assigned)');
        lines.push(heavy());
        for (const p of untaggedPrompts) {
          const who = p.role === 'sayon' ? '🔵 SAYON' : '🟠 SEREN';
          lines.push(`${who}  ·  ${fmt(p.created_at)}  ·  ${p.latency_ms}ms`);
          lines.push(mid());
          lines.push(p.prompt.trim());
          lines.push('');
          lines.push(thin());
          lines.push('  RESPONSE');
          lines.push(thin());
          lines.push(p.response.trim());
          lines.push('');
        }
      }

      // ── Thread-level events ───────────────────────────────────────────────
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

      const filename = `phobos-export-${threadId.slice(0, 8)}-${Date.now()}.txt`;
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(lines.join('\n'));
    }
  );
}