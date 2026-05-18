import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '@/store/useAppStore';
import { CLIENT_VERSION } from '@/version';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export function useThreads() {
  const setThreads = useAppStore((s) => s.setThreads);
  const backendAlive = useAppStore((s) => s.backendAlive);
  return useQuery({
    queryKey: ['threads', backendAlive],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/threads`);
      if (!res.ok) throw new Error(`Failed to fetch threads: ${res.status}`);
      const data = await res.json();
      setThreads(data);
      // Auto-open most recent thread if none active
      const state = useAppStore.getState();
      if (!state.activeThreadId && data.length > 0) {
        const sorted = [...data].sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        useAppStore.setState({ activeThreadId: sorted[0].id });
      }
      return data;
    },
    enabled: backendAlive,
    retry: 5,          // retry on cold-start backend delay
    retryDelay: 1000,  // 1s between retries
    refetchOnWindowFocus: false,
  });
}

export function useThreadMessages(threadId: string) {
  const setMessages = useAppStore((s) => s.setMessages);
  const setSegments = useAppStore((s) => s.setSegments);
  return useQuery({
    queryKey: ['threads', threadId, 'messages'],
    staleTime: 0,
    refetchOnMount: 'always',     // always re-run queryFn on thread switch
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [msgRes, evtRes, thinkRes, mediaRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/threads/${threadId}/messages`),
        fetch(`${ENGINE_URL}/api/threads/${threadId}/events`),
        fetch(`${ENGINE_URL}/api/threads/${threadId}/thinking`),
        fetch(`${ENGINE_URL}/api/threads/${threadId}/workspace-media`),
      ]);
      if (!msgRes.ok) throw new Error(`Failed to fetch messages: ${msgRes.status}`);
      const messages: any[] = await msgRes.json();
      const events: Array<{ messageId: string | null; eventType: string; payload: any; seq: number }> =
        evtRes.ok ? await evtRes.json() : [];
      const rawThinkingSegments: import('@/store/useAppStore').ThinkingSegment[] =
        thinkRes.ok ? await thinkRes.json() : [];
      // If the segment store returned nothing, reconstruct segments from
      // thinking_complete events (which are always persisted as a fallback).
      // This covers the case where the server restarted and lost in-memory segment state.
      let thinkingSegments = rawThinkingSegments;

      // If segment store is empty, reconstruct from thinking_complete events
      if (thinkingSegments.length === 0 && events.length > 0) {
        const reconstructed: import('@/store/useAppStore').ThinkingSegment[] = [];
        let seq = 0;
        for (const e of events) {
          if (e.eventType === 'thinking_complete' && e.payload?.content) {
            const source = (e.payload.source as string) ?? 'engine';
            reconstructed.push({
              id: `reconstructed-${e.messageId ?? 'orphan'}-${++seq}`,
              phase: source === 'coordinator' ? 'coordinator' : 'engine',
              content: e.payload.content as string,
              tokenCount: Math.ceil(((e.payload.content as string)?.length ?? 0) / 4),
              startedAt: e.seq ? new Date().toISOString() : new Date().toISOString(),
              completedAt: new Date().toISOString(),
              live: false,
            });
          }
        }
        if (reconstructed.length > 0) thinkingSegments = reconstructed;
      }

      // Group events by messageId
      const eventsByMsg = new Map<string, Array<{ eventType: string; payload: any; seq: number }>>();
      for (const e of events) {
        const key = e.messageId ?? '__orphan__';
        if (!eventsByMsg.has(key)) eventsByMsg.set(key, []);
        eventsByMsg.get(key)!.push({ eventType: e.eventType, payload: e.payload, seq: e.seq });
      }

      // Rebuild message list — interleave coordinator bubbles and activity gizmos
      // in the correct position before their associated assistant message
      const enriched: any[] = [];

      for (const m of messages) {
        const msgEvents = eventsByMsg.get(m.id) ?? [];
        const filePanels: any[] = [];
        let thinking: string | undefined = m.thinking;

        for (const e of msgEvents) {
          if (e.eventType === 'file_panel') {
            filePanels.push({ filename: e.payload.filename, language: e.payload.language, code: e.payload.code });
          }
          if (e.eventType === 'thinking_complete' && !thinking) {
            thinking = e.payload.content as string;
          }
          // image_complete events are no longer replayed here — media files are
          // restored from disk via GET /api/threads/:id/workspace-media on load,
          // which is authoritative and handles manually-added files too.
          // Inject coordinator bubble as a synthetic message before the assistant message
          if (e.eventType === 'coordinator') {
            enriched.push({
              id: `coord-${m.id}-${e.seq}`,
              role: 'coordinator',
              content: e.payload.content as string,
              timestamp: m.timestamp,
              coordSource: (e.payload.source as 'coordinator' | 'engine') ?? 'coordinator',
            });
          }
        }

        enriched.push({
          ...m,
          ...(filePanels.length > 0 ? { filePanels } : {}),
          ...(thinking ? { thinking } : {}),
          // Restore attachment chips from the DB record — source of truth on reload
          ...(m.attachments?.length > 0 ? {
            queryFiles: m.attachments.map((a: { id: string; filename: string; is_image: boolean }) => ({
              id: a.id,
              name: a.filename,
              isImage: a.is_image,
            })),
          } : {}),
        });
      }

            // Only apply if this fetch is for the active thread.
      // If the user switched threads while the fetch was in-flight, discard the
      // message merge but still write segments (keyed by threadId, safe either way).
      const { activeThreadId } = useAppStore.getState();
      if (activeThreadId !== threadId) {
        setSegments(threadId, thinkingSegments);
        return enriched;
      }

      // Merge DB messages into existing live state rather than replacing wholesale.
      // After a stream, the live messages are the source of truth for order/content.
      // The DB version adds: thinking, filePanels. We apply those enrichments
      // by ID rather than swapping the whole array, so ordering is never disturbed.
      const existingMsgs = useAppStore.getState().messages[threadId] ?? [];
      if (existingMsgs.length > 0) {
        // Build a lookup of DB enrichments by ID
        const dbById = new Map(enriched.map((m) => [m.id, m]));
        // Build a secondary lookup for coordinator messages by content
        // (live coordinator IDs use a stream counter; DB uses event seq — they won't match)
        const dbCoordByContent = new Map(
          enriched
            .filter((m) => m.role === 'coordinator')
            .map((m) => [m.content as string, m])
        );
        const merged = existingMsgs.map((live) => {
          // ID match first, content match fallback for coordinator
          const db = dbById.get(live.id) ??
            (live.role === 'coordinator' ? dbCoordByContent.get(live.content) : undefined);
          if (!db) return live;
          return {
            ...live,
            // Apply DB-only fields that streaming doesn't provide
            ...(db.thinking && !live.thinking ? { thinking: db.thinking } : {}),
            ...(db.filePanels?.length && !live.filePanels?.length ? { filePanels: db.filePanels } : {}),
            // Apply coordSource from DB in case live message was created before backend tagged it
            ...((db as any).coordSource ? { coordSource: (db as any).coordSource } : {}),
          };
        });
        // Append any DB messages not present in live state
        // For coordinator: check by content to avoid duplicating messages with different IDs
        const liveCoordContents = new Set(
          existingMsgs.filter((m) => m.role === 'coordinator').map((m) => m.content)
        );
        const liveUserContents = new Set(
          existingMsgs.filter((m) => m.role === 'user').map((m) => m.content)
        );
        const liveHasAssistant = existingMsgs.some((m) => m.role === 'assistant');
        for (const dbMsg of enriched) {
          if (dbMsg.role === 'coordinator') {
            if (!liveCoordContents.has(dbMsg.content as string)) merged.push(dbMsg);
          } else if (dbMsg.role === 'user') {
            if (!liveUserContents.has(dbMsg.content as string)) merged.push(dbMsg);
          } else if (dbMsg.role === 'assistant') {
            if (!liveHasAssistant) merged.push(dbMsg);
          } else if (!existingMsgs.find((m) => m.id === dbMsg.id)) {
            merged.push(dbMsg);
          }
        }
        setMessages(threadId, merged);
      } else {
        // Fresh load — no live state, use DB as-is
        setMessages(threadId, enriched);
      }
      // Segments are keyed by threadId — safe to write regardless of streaming state.
      // The poll loop in useStream overwrites this key at 200ms intervals during a stream,
      // so a load-time write simply establishes the floor; live polls continue on top.
      // Guard: skip the write if currently not streaming AND length + last id match
      // existing state — avoids triggering a re-render that re-fires the query (render loop).
      const existingSegs = useAppStore.getState().segments[threadId] ?? [];
      const hasLive = thinkingSegments.some((seg) => seg.live);
      if (
        hasLive ||
        existingSegs.length !== thinkingSegments.length ||
        (thinkingSegments.length > 0 &&
          existingSegs[existingSegs.length - 1]?.id !== thinkingSegments[thinkingSegments.length - 1]?.id)
      ) {
        setSegments(threadId, thinkingSegments);
      }
      console.log(`[useThread:segments] thread=${threadId.slice(0,8)} count=${thinkingSegments.length} reconstructed=${thinkingSegments.some(s => s.id.startsWith('reconstructed'))}`);

      // Restore media files from disk — source of truth is the images/ folder,
      // not SSE event replay (which may be missing for older conversations or
      // files that were dropped in manually).
      if (mediaRes.ok) {
        const mediaData = await mediaRes.json();
        const mediaFiles = (mediaData.files ?? []).map((f: { filename: string; absolutePath: string; createdAt: string }) => ({
          filename: f.filename,
          absolutePath: f.absolutePath,
          threadId,
          createdAt: f.createdAt,
        }));
        // setMediaFiles replaces the whole list — gives a clean slate on every thread load
        useAppStore.getState().setMediaFiles(threadId, mediaFiles);
      }

      return enriched;
    },
    enabled: !!threadId,
  });
}

export function useStatus() {
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setModelNames = useAppStore((s) => s.setModelNames);
  const setBackendAlive = useAppStore((s) => s.setBackendAlive);
  const setVersionMismatch = useAppStore((s) => s.setVersionMismatch);
  const setConfigOptimal = useAppStore((s) => s.setConfigOptimal);
  const setVisionCapability = useAppStore((s) => s.setVisionCapability);
  return useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/status`);
        if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
        const data = await res.json();
        setBackendAlive(true);
        // When relocating models, servers are intentionally stopped — don't report
        // as disconnected or the full-page disconnect screen will mount and tear
        // down the relocate dialog (aborting its SSE stream).
        const relocating = !!data.isRelocating;
        setConnectionStatus({
          coordinator: relocating ? 'connected' : (data.coordinator ?? 'disconnected'),
          engine: relocating ? 'connected' : (data.engineStarting ? 'disconnected' : (data.engine ?? 'disconnected')),
        });
        // Sync backend image generation state — prevents the "SEREN offline"
        // kickback when LLM servers are intentionally stopped for VRAM.
        if (data.isGenerating !== undefined) {
          const store = useAppStore.getState();
          if (data.isGenerating) {
            if (!store.imageGenerating) {
              store.setImageGenerating(true, 'Generating image…');
            }
          } else if (store.imageGenerating) {
            // Backend says generation is done. Only clear imageGenerating if the
            // engine is also back online. If the engine is still disconnected,
            // the LLM servers haven't finished reconnecting yet — keep the flag
            // true so the ConnectionStatus screen doesn't flash between gen end
            // and LLM restart.
            const engineBack = (data.engine ?? 'disconnected') === 'connected';
            if (engineBack) {
              store.setImageGenerating(false, '');
            }
          }
        }
        if (data.coordinatorModel || data.engineModel) {
          setModelNames({
            coordinator: data.coordinatorModel ?? 'NPU',
            engine: data.engineModel ?? 'Engine',
            coordinatorProvider: data.coordinatorProvider ?? '',
            engineProvider: data.engineProvider ?? '',
            coordinatorHasThinking: data.coordinatorHasThinking ?? false,
            engineHasThinking: data.engineHasThinking ?? false,
          });
        }
        // Sync config optimality for header badge
        setConfigOptimal(data.configOptimal ?? null);
        // Sync vision capability for attachment pre-flight guard
        setVisionCapability(data.visionCapability ?? null);
        // Version check — runs after confirming backend is alive
        try {
          const vRes = await fetch(`${ENGINE_URL}/api/version`);
          const vData = await vRes.json();
          const mismatch = vData.version !== CLIENT_VERSION;
          setVersionMismatch(mismatch, vData.version as string);
        } catch {
          // /api/version missing means old core build — always a mismatch
          setVersionMismatch(true, 'unknown');
        }
        return data;
      } catch (err) {
        setBackendAlive(false);
        setConnectionStatus({ coordinator: 'disconnected', engine: 'disconnected' });
        throw err;
      }
    },
    refetchInterval: 5000,
    retry: 0,
  });
}

export function useModelConfig() {
  const setModelConfig = useAppStore((s) => s.setModelConfig);
  const setModelNames  = useAppStore((s) => s.setModelNames);
  const queryClient    = useQueryClient();

  const query = useQuery({
    queryKey: ['config', 'models'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/config/models`);
      if (!res.ok) throw new Error(`Failed to fetch model config: ${res.status}`);
      const data = await res.json();
      setModelConfig(data);
      setModelNames({
        coordinator: data.coordinator.model,
        engine: data.engine.model,
        coordinatorProvider: data.coordinator.provider,
        engineProvider: data.engine.provider,
      });
      return data;
    },
    staleTime: Infinity, // only refetch when we mutate
  });

  const updateConfig = useMutation({
    mutationFn: async (body: {
      coordinator?: { provider?: string; endpoint?: string; model?: string; apiKey?: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
      engine?:      { provider?: string; endpoint?: string; model?: string; apiKey?: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
    }) => {
      const res = await fetch(`${ENGINE_URL}/api/config/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Failed to update model config: ${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      setModelConfig(data);
      setModelNames({
        coordinator: data.coordinator.model,
        engine: data.engine.model,
        coordinatorProvider: data.coordinator.provider,
        engineProvider: data.engine.provider,
      });
      queryClient.invalidateQueries({ queryKey: ['config', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });

  return { ...query, updateConfig };
}
