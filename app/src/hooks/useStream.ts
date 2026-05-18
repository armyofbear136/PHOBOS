import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, type Message } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// How often to poll /thinking while a stream is active (ms).
// Short enough to feel responsive; long enough not to hammer the DB.
const THINKING_POLL_MS = 200;

type SSEEvent =
  | { type: 'status'; content: string }
  | { type: 'coordinator'; content: string; source?: 'coordinator' | 'engine' }
  | { type: 'think_token'; token: string; source?: 'coordinator' | 'engine' }
  | { type: 'output_token'; token: string }
  | { type: 'thinking_complete'; content: string }
  | { type: 'file_panel'; filename: string; language: string; code: string }
  | { type: 'patches_applied'; count: number; files: string[] }
  | { type: 'build_result'; success: boolean; errors?: string }
  | { type: 'review'; score: number; decision: string; guidance?: string }
  | { type: 'task_start'; taskIndex: number; total: number; title: string }
  | { type: 'task_complete'; taskIndex: number; total: number; title: string }
  | { type: 'task_failed'; taskIndex: number; total: number; title: string; reason: string }
  | { type: 'execute_result'; taskIndex: number; exitCode: number; durationMs: number; timedOut: boolean; stdoutPreview: string; mode: 'execute' | 'simulate' }
  | { type: 'complete'; approved: boolean; bestAttempt: number }
  | { type: 'error'; message: string }
  | { type: 'thinking_retry'; attempt: number }
  | { type: 'intent_classified'; intentType: string; domain: string; routing: string }
  | { type: 'validation_start' }
  | { type: 'validation_result'; decision: 'SATISFIED' | 'REWORK_TASKS' | 'PARALLEL_INGEST' }
  | { type: 'intermediate_delivery'; content: string }
  | { type: 'queue_update'; newTasks: number }
  | { type: 'agent_state'; state: string; detail: string; ts: number; taskIndex?: number; taskTotal?: number }
  | { type: 'image_status'; phase: string; message: string }
  | { type: 'image_complete'; outputPath: string; seed: number; elapsedMs: number }
  | { type: 'image_workflow_created'; workflowId: string; threadId: string; name: string; prompt: string; negativePrompt: string }
  | { type: 'ctx_computed'; count: number }
  | { type: 'done' };

const uid = () => Math.random().toString(36).slice(2, 9);

export function useStream() {
  const addMessage = useAppStore((s) => s.addMessage);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const contextHistoryDepth = useAppStore((s) => s.contextHistoryDepth);
  const ctxOverrideActive = useAppStore((s) => s.ctxOverrideActive);
  // Per-thread state. Each entry is one in-flight stream so multiple threads
  // can stream concurrently without interfering. C2 dispatches per-task on
  // the server; this is the matching client-side bookkeeping.
  const abortsRef = useRef<Map<string, AbortController>>(new Map());
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const queryClient = useQueryClient();
  // Expose queryClient globally for event handlers that need it (e.g. patches_applied)
  (globalThis as any).__phobosQueryClient = queryClient;

  const stopStream = useCallback((threadId?: string) => {
    const targetId = threadId ?? useAppStore.getState().activeThreadId;
    if (!targetId) return;
    const ctrl = abortsRef.current.get(targetId);
    if (ctrl) { ctrl.abort(); abortsRef.current.delete(targetId); }
    const timer = pollTimersRef.current.get(targetId);
    if (timer) { clearTimeout(timer); pollTimersRef.current.delete(targetId); }
    useAppStore.getState().setThreadStreaming(targetId, false);
  }, []);

  const sendMessage = useCallback(
    async (content: string, files?: File[]) => {
      const threadId = activeThreadId;
      if (!threadId) return;

      // Reset AUTO ctx count — will be updated by ctx_computed SSE from this turn.
      useAppStore.getState().setCtxComputedCount(null);

      // ── Upload attached files before sending ──────────────────────────────
      // Each file is written to disk server-side under attachments/ and gets a UUID.
      // The IDs travel in the message body; the backend links them to the created
      // message and reads file content from disk to build fullUserMessage for the engine.
      // File contents never travel through the messages DB column.
      const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','tiff','tif','avif']);
      const isImage = (f: File) =>
        f.type.startsWith('image/') ||
        IMAGE_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? '');

      // Pre-flight vision capability check — reject image attachments early if
      // neither model supports vision, before uploading anything.
      if (files && files.length > 0 && files.some(isImage)) {
        const { visionCapability } = useAppStore.getState();
        const coordVision = visionCapability?.coordinatorSupportsVision ?? false;
        const engineVision = visionCapability?.engineSupportsVision ?? false;
        if (!coordVision && !engineVision) {
          // Surface the error as a fake assistant message so the user sees it inline.
          addMessage(threadId, {
            id: uid(),
            role: 'assistant',
            content: '⚠ Neither model supports images. Remove the image attachment or switch to a vision-capable model in settings.',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      const attachmentIds: string[] = [];
      const queryFiles: Array<{ id: string; name: string; isImage: boolean }> = [];

      if (files && files.length > 0) {
        for (const file of files) {
          const isImg = isImage(file);
          let uploadContent: string;
          if (isImg) {
            // Read as base64 so the backend can write raw bytes to disk via Buffer.from(content, 'base64').
            // The attachment store detects is_image and the pipeline reads disk bytes for content arrays.
            const arrayBuf = await file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 65535) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 65535));
            }
            uploadContent = btoa(binary);
          } else {
            uploadContent = await file.text();
          }
          try {
            const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/attachments`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: file.name,
                content: uploadContent,
                mime_type: file.type || (isImg ? 'image/png' : 'text/plain'),
                message_id: '',  // linked server-side after message is created
              }),
            });
            if (res.ok) {
              const att = await res.json() as { id: string; filename: string; is_image: boolean };
              attachmentIds.push(att.id);
              queryFiles.push({ id: att.id, name: att.filename, isImage: att.is_image });
            }
          } catch { /* silent — chip won't appear but message still sends */ }
        }
      }

      // Store user message in local state — typed text only, file contents never shown.
      // queryFiles drives the attachment chips; the IDs allow content fetch on demand.
      addMessage(threadId, {
        id: uid(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        queryFiles: queryFiles.length > 0 ? queryFiles : undefined,
      });

      useAppStore.getState().setLiveActivity('Starting…');
      const activityId = 'live';

      // Abort any prior in-flight stream for this same thread (re-send before complete).
      // Other threads keep streaming — their controllers live in the map.
      const prior = abortsRef.current.get(threadId);
      if (prior) prior.abort();
      const abort = new AbortController();
      abortsRef.current.set(threadId, abort);

      useAppStore.getState().setThreadStreaming(threadId, true);
      useAppStore.setState({ agentStates: { sayon: null, seren: null } });

      const streamingMsgIdRef = { current: null as string | null };
      const coordSeqRef = { current: 0 };

      // ── Thinking poll loop ──────────────────────────────────────────────────
      // While streaming, fetch /thinking every THINKING_POLL_MS and write
      // directly to segments[threadId]. No client-side reconstruction needed —
      // the DB is the source of truth, already current from per-token appends.
      const pollThinking = async () => {
        try {
          const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/thinking`);
          if (res.ok) {
            const segs = await res.json();
            useAppStore.getState().setSegments(threadId, segs);
          }
        } catch {
          // non-fatal — display just shows last good state
        }
        // Re-schedule only if this thread is still streaming
        if (useAppStore.getState().isThreadStreaming(threadId)) {
          const t = setTimeout(pollThinking, THINKING_POLL_MS);
          pollTimersRef.current.set(threadId, t);
        }
      };
      const initialTimer = setTimeout(pollThinking, THINKING_POLL_MS);
      pollTimersRef.current.set(threadId, initialTimer);

      try {
        const response = await fetch(
          `${ENGINE_URL}/api/threads/${threadId}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
              // Only send context_history_depth when user has explicitly overridden AUTO mode.
              // When absent, the server computes the optimal count and emits ctx_computed.
              ...(ctxOverrideActive ? { context_history_depth: contextHistoryDepth } : {}),
            }),
            signal: abort.signal,
          }
        );

        if (!response.ok || !response.body) {
          throw new Error(`Engine returned ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice('data: '.length).trim();
            if (!raw) continue;

            let event: SSEEvent;
            try {
              event = JSON.parse(raw) as SSEEvent;
            } catch {
              continue;
            }

            handleEvent(threadId, event, addMessage, streamingMsgIdRef, activityId, coordSeqRef);

            if (event.type === 'complete') {
              useAppStore.getState().setThreadStreaming(threadId, false);
              // Stop the poll loop, then do one final fetch to get the sealed segments.
              const t = pollTimersRef.current.get(threadId);
              if (t) { clearTimeout(t); pollTimersRef.current.delete(threadId); }
              fetch(`${ENGINE_URL}/api/threads/${threadId}/thinking`)
                .then((r) => r.ok ? r.json() : null)
                .then((segs) => { if (segs) useAppStore.getState().setSegments(threadId, segs); })
                .catch(() => {});
              // Delay message refetch so DB commit completes before we read it back
              setTimeout(() => {
                queryClient.refetchQueries({ queryKey: ['threads', threadId, 'messages'] });
              }, 600);
            }

            // Auto-rename thread
            if (event.type === 'complete') {
              const threads = useAppStore.getState().threads;
              const thread = threads.find((t) => t.id === threadId);
              if (thread && thread.title === 'New conversation') {
                const newTitle = content.slice(0, 40);
                try {
                  await fetch(`${ENGINE_URL}/api/threads/${threadId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle }),
                  });
                  useAppStore.setState((s) => ({
                    threads: s.threads.map((t) =>
                      t.id === threadId ? { ...t, title: newTitle } : t
                    ),
                  }));
                } catch {
                  // silent fail on rename
                }
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          addMessage(threadId, {
            id: uid(),
            role: 'status',
            content: 'Stopped.',
            timestamp: new Date().toISOString(),
          });
        } else {
          console.error('[useStream] Error:', err);
          addMessage(threadId, {
            id: uid(),
            role: 'status',
            content: `Error: ${err instanceof Error ? err.message : 'Connection failed'}`,
            timestamp: new Date().toISOString(),
          });
        }
      } finally {
        const t = pollTimersRef.current.get(threadId);
        if (t) { clearTimeout(t); pollTimersRef.current.delete(threadId); }
        abortsRef.current.delete(threadId);
        useAppStore.getState().setThreadStreaming(threadId, false);
        const currentLabel = useAppStore.getState().liveActivity?.label;
        if (currentLabel !== 'Done ✓') {
          useAppStore.getState().clearLiveActivity();
        }
      }
    },
    [activeThreadId, addMessage]
  );

  return { sendMessage, stopStream };
}

function updateActivityBubble(_threadId: string, _activityId: string, eventContent: string) {
  useAppStore.getState().setLiveActivity(eventContent);
}

function handleEvent(
  threadId: string,
  event: SSEEvent,
  addMessage: (threadId: string, message: Message) => void,
  streamingMsgIdRef: React.MutableRefObject<string | null>,
  activityId: string,
  coordSeqRef: React.MutableRefObject<number>
): void {
  switch (event.type) {
    case 'status': {
      updateActivityBubble(threadId, activityId, event.content);
      break;
    }

    case 'coordinator': {
      const coordMsgId = streamingMsgIdRef.current ?? activityId;
      const coordId = `coord-${coordMsgId}-${++coordSeqRef.current}`;
      addMessage(threadId, {
        id: coordId,
        role: 'coordinator',
        coordSource: event.source ?? 'coordinator',
        content: event.content,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'think_token': {
      // Token arrives — DB is already being written by the server.
      // The poll loop reads it back on schedule. Nothing to do here for display.
      // Reserve the message ID so thinking is associated with the right message.
      if (!streamingMsgIdRef.current) {
        streamingMsgIdRef.current = uid();
      }
      break;
    }

    case 'output_token': {
      if (!streamingMsgIdRef.current) {
        streamingMsgIdRef.current = uid();
      }
      const msgId = streamingMsgIdRef.current;

      useAppStore.setState((s) => {
        const msgs = s.messages[threadId] ?? [];
        const existing = msgs.find((m) => m.id === msgId);

        const updated: Message = existing
          ? { ...existing, content: existing.content + event.token }
          : {
              id: msgId,
              role: 'assistant',
              content: event.token,
              timestamp: new Date().toISOString(),
            };

        return {
          messages: {
            ...s.messages,
            [threadId]: existing
              ? msgs.map((m) => (m.id === msgId ? updated : m))
              : [...msgs, updated],
          },
        };
      });
      break;
    }

    case 'thinking_complete': {
      // Attach thinking trace to the message record.
      // Segment display is handled by the poll loop — no segment state touched here.
      if (streamingMsgIdRef.current) {
        const msgId = streamingMsgIdRef.current;
        useAppStore.setState((s) => ({
          messages: {
            ...s.messages,
            [threadId]: (s.messages[threadId] ?? []).map((m) =>
              m.id === msgId ? { ...m, thinking: event.content } : m
            ),
          },
        }));
      }
      break;
    }

    case 'file_panel': {
      if (streamingMsgIdRef.current) {
        const msgId = streamingMsgIdRef.current;
        const panel = { filename: event.filename, language: event.language, code: event.code };
        useAppStore.setState((s) => ({
          messages: {
            ...s.messages,
            [threadId]: (s.messages[threadId] ?? []).map((m) =>
              m.id === msgId
                ? { ...m, filePanels: [...(m.filePanels ?? []), panel] }
                : m
            ),
          },
        }));
      }
      break;
    }

    case 'build_result': {
      const label = event.success
        ? 'Build passed ✓'
        : `Build failed: ${event.errors?.slice(0, 80) ?? 'unknown error'}`;
      updateActivityBubble(threadId, activityId, label);
      break;
    }

    case 'patches_applied': {
      updateActivityBubble(threadId, activityId, `Applying ${event.count} patch(es)…`);
      const qc = (globalThis as any).__phobosQueryClient;
      if (qc) qc.invalidateQueries({ queryKey: ['workspace', threadId] });
      break;
    }

    case 'task_start': {
      updateActivityBubble(threadId, activityId, `[${event.taskIndex}/${event.total}] ${event.title}…`);
      break;
    }

    case 'task_complete': {
      updateActivityBubble(threadId, activityId, `[${event.taskIndex}/${event.total}] ✓ ${event.title}`);
      break;
    }

    case 'task_failed': {
      updateActivityBubble(threadId, activityId, `[${event.taskIndex}/${event.total}] ✗ ${event.title}`);
      break;
    }

    case 'execute_result': {
      // Attach the result card to the streaming assistant message
      if (streamingMsgIdRef.current) {
        const msgId = streamingMsgIdRef.current;
        const result = {
          taskIndex: event.taskIndex,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          timedOut: event.timedOut,
          stdoutPreview: event.stdoutPreview,
          mode: event.mode,
        };
        useAppStore.setState((s) => ({
          messages: {
            ...s.messages,
            [threadId]: (s.messages[threadId] ?? []).map((m) =>
              m.id === msgId
                ? { ...m, executeResults: [...(m.executeResults ?? []), result] }
                : m
            ),
          },
        }));
      }
      const label = event.mode === 'simulate'
        ? `Simulation ${event.exitCode === 0 ? '✓' : '✗'} (${(event.durationMs / 1000).toFixed(1)}s)`
        : `Execute ${event.exitCode === 0 ? '✓' : `✗ exit ${event.exitCode}`} (${(event.durationMs / 1000).toFixed(1)}s)`;
      updateActivityBubble(threadId, activityId, label);
      break;
    }

    case 'review': {
      if (event.decision !== 'APPROVE') {
        updateActivityBubble(threadId, activityId, `Review: ${event.decision} (score ${(event.score * 100).toFixed(0)}%)`);
      }
      break;
    }

    case 'error': {
      addMessage(threadId, {
        id: uid(),
        role: 'status',
        content: `Error: ${event.message}`,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'complete': {
      useAppStore.getState().setLiveActivity('Done ✓');
      useAppStore.getState().setTaskProgress?.(null);
      useAppStore.getState().clearAgentStates();
      streamingMsgIdRef.current = null;
      const state = useAppStore.getState();
      const thread = state.threads.find((t) => t.id === threadId);
      if (thread?.title === 'New conversation') {
        const userMsgs = state.messages[threadId]?.filter((m) => m.role === 'user');
        const firstMsg = userMsgs?.[0]?.content ?? '';
        if (firstMsg) {
          const newTitle = firstMsg.slice(0, 40);
          fetch(`${ENGINE_URL}/api/threads/${threadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle }),
          }).then(() => {
            useAppStore.setState((s) => ({
              threads: s.threads.map((t) =>
                t.id === threadId ? { ...t, title: newTitle } : t
              ),
            }));
          });
        }
      }
      break;
    }

    case 'thinking_retry': {
      // No segment state to manage — poll loop will pick up the new segment naturally.
      break;
    }

    case 'intent_classified': {
      updateActivityBubble(threadId, activityId, `Intent: ${event.intentType} · ${event.domain}`);
      break;
    }

    case 'validation_start': {
      updateActivityBubble(threadId, activityId, 'Final validation…');
      break;
    }

    case 'validation_result': {
      const label = event.decision === 'SATISFIED' ? 'Validation: SATISFIED ✓' : `Replanning: ${event.decision}`;
      updateActivityBubble(threadId, activityId, label);
      break;
    }

    case 'intermediate_delivery': {
      const deliverMsgId = streamingMsgIdRef.current ?? activityId;
      const deliverId = `coord-${deliverMsgId}-${++coordSeqRef.current}`;
      addMessage(threadId, {
        id: deliverId,
        role: 'coordinator',
        coordSource: 'coordinator',
        content: event.content,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'queue_update': {
      updateActivityBubble(threadId, activityId, `Queue: ${event.newTasks} new task(s)`);
      break;
    }

    case 'agent_state': {
      const coordinatorStates = new Set(['reading', 'delivering']);
      const engineStates = new Set(['planning', 'thinking', 'executing', 'building', 'reviewing']);

      if (event.state === 'idle') {
        const { agentStates } = useAppStore.getState();
        if (agentStates.sayon && agentStates.sayon.state !== 'idle') {
          useAppStore.getState().setAgentState('sayon', 'idle', '');
        }
        if (agentStates.seren && agentStates.seren.state !== 'idle') {
          useAppStore.getState().setAgentState('seren', 'idle', '');
        }
      } else if (event.state === 'error') {
        useAppStore.getState().setAgentState('sayon', 'error', event.detail);
        useAppStore.getState().setAgentState('seren', 'error', event.detail);
      } else if (coordinatorStates.has(event.state)) {
        useAppStore.getState().setAgentState('sayon', event.state as any, event.detail);
        useAppStore.getState().setAgentState('seren', 'idle', '');
      } else if (engineStates.has(event.state)) {
        useAppStore.getState().setAgentState('seren', event.state as any, event.detail);
        useAppStore.getState().setAgentState('sayon', 'idle', '');
      }

      if (event.taskIndex !== undefined && event.taskTotal !== undefined) {
        useAppStore.getState().setTaskProgress?.({ taskIndex: event.taskIndex, taskTotal: event.taskTotal });
      } else if (event.state === 'idle' || event.state === 'delivering') {
        useAppStore.getState().setTaskProgress?.(null);
      }
      break;
    }

    case 'image_status': {
      // phase tells us what's happening; message has the human-readable text with correct role name
      // (e.g. "Pausing SAYON…" or "Generating on CUDA · …")
      const displayMsg = event.message || event.phase;

      // Map phase to which agent badge should show as active in ThinkingPanel
      if (event.phase === 'stopping_seren' || event.phase === 'restarting_seren') {
        // The server being paused/restarted could be sayon OR seren — the message says which.
        // We don't have the role directly, but we can infer: if message contains 'SAYON', it's sayon
        const stoppedRole = displayMsg.toUpperCase().includes('SAYON') ? 'sayon' : 'seren';
        const otherRole   = stoppedRole === 'sayon' ? 'seren' : 'sayon';
        useAppStore.getState().setAgentState(stoppedRole, 'executing' as any, displayMsg);
        useAppStore.getState().setAgentState(otherRole, 'idle', '');
      } else if (event.phase === 'generating') {
        // During generation, show the paused server as 'executing' so its badge is active
        // The backend already stopped the correct server — keep both badges reflecting that
      }

      useAppStore.getState().setImageGenerating(true, displayMsg);
      updateActivityBubble(threadId, activityId, displayMsg);
      break;
    }

    case 'image_complete': {
      const rawPath = event.outputPath.replace(/\\/g, '/');
      const filename = rawPath.split('/').pop() ?? 'image.png';
      useAppStore.getState().addMediaFile(threadId, {
        filename,
        absolutePath: event.outputPath,
        threadId,
        createdAt: new Date().toISOString(),
      });
      useAppStore.getState().setImageGenerating(false, '');
      useAppStore.getState().setAgentState('sayon', 'idle', '');
      useAppStore.getState().setAgentState('seren', 'idle', '');
      updateActivityBubble(threadId, activityId, `Image ready · ${filename}`);
      break;
    }

    case 'image_workflow_created': {
      // Auto-open the workflow panel and start generation tracking
      const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
      (async () => {
        try {
          const res = await fetch(`${ENGINE_URL}/api/threads/${event.threadId}/workflows/${event.workflowId}`);
          if (!res.ok) return;
          const data = await res.json();
          const { useWorkflowStore } = await import('@/store/useWorkflowStore');
          const store = useWorkflowStore.getState();
          store.openPanel(data.session);
          store.setGenerating(event.workflowId, true);
          store.clearRenderPhases(event.workflowId);

          // Immediately add to the index so WorkflowsMenu renders the new entry
          // without waiting for a revision-triggered refetch.
          store.addIndexEntry(event.threadId, {
            workflowId: event.workflowId,
            name: event.name,
            createdAt: new Date().toISOString(),
            modelId: data.session.modelId ?? 'unknown',
            thumbPath: null,
            workflowType: data.session.workflowType ?? 'image',
          });

          // Poll run-status until generation completes (same pattern as runGenerate)
          const pollInterval = 1500;
          while (true) {
            await new Promise(r => setTimeout(r, pollInterval));
            try {
              const statusRes = await fetch(
                `${ENGINE_URL}/api/threads/${event.threadId}/workflows/${event.workflowId}/run-status`
              );
              if (!statusRes.ok) continue;
              const status = await statusRes.json();

              if (status.progress) {
                store.setProgress(event.workflowId, status.progress);
              }
              if (status.phases?.length > 0) {
                store.clearRenderPhases(event.workflowId);
                for (const p of status.phases) {
                  store.pushRenderPhase(event.workflowId, p.renderPhase, p.detail);
                }
              }
              if (status.activeNode !== undefined) {
                store.setActiveNodeIndex(status.activeNode);
              }
              if (!status.generating) {
                // If the response is the empty default (no phases, no error, no completedAt),
                // /run hasn't been processed yet — keep polling instead of treating as done.
                const isEmptyDefault = !status.completedAt && !status.error
                  && (!status.phases || status.phases.length === 0);
                if (isEmptyDefault) continue;

                store.setGenerating(event.workflowId, false);
                store.setProgress(event.workflowId, null);
                store.clearRenderPhases(event.workflowId);
                // Reload session to get final output paths
                const finalRes = await fetch(`${ENGINE_URL}/api/threads/${event.threadId}/workflows/${event.workflowId}`);
                if (finalRes.ok) {
                  const finalData = await finalRes.json();
                  store.setSession(finalData.session);
                }
                // Reload the full index to pick up the thumbnail path
                try {
                  const idxRes = await fetch(`${ENGINE_URL}/api/threads/${event.threadId}/workflows`);
                  if (idxRes.ok) {
                    const idxData = await idxRes.json();
                    store.setIndex(event.threadId, idxData.workflows ?? []);
                  }
                } catch { /* non-fatal */ }
                break;
              }
            } catch { /* poll failed, retry */ }
          }
        } catch { /* silent */ }
      })();
      break;
    }

    case 'ctx_computed': {
      useAppStore.getState().setCtxComputedCount(event.count);
      break;
    }

    case 'done':
      break;
  }
}

