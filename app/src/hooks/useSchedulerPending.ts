import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const POLL_MS    = 15_000;

export interface PendingFire {
  taskId:   string;
  taskName: string;
  prompt:   string;
  firedAt:  string;
}

const SCHEDULED_PREFIX =
  '[SCHEDULED RUN — No user is present. Do not ask clarification questions. ' +
  'Proceed immediately with the most reasonable interpretation of the following task.]\n\n';

export function useSchedulerPending() {
  const [pending, setPending] = useState<PendingFire | null>(null);
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firingRef = useRef(false);

  const addThread       = useAppStore(s => s.addThread);
  const setActiveThread = useAppStore(s => s.setActiveThread);
  const isStreaming     = useAppStore(s => s.streamingThreads.size > 0);
  const imageGenerating = useAppStore(s => s.imageGenerating);
  const isBusy          = isStreaming || imageGenerating;

  const cancelPending = useCallback(async () => {
    setPending(null);
    firingRef.current = false;
    try {
      await fetch(`${ENGINE_URL}/api/scheduler/pending/cancel`, { method: 'POST' });
    } catch { /* non-fatal */ }
  }, []);

  const dispatchTask = useCallback(async (fire: PendingFire) => {
    if (firingRef.current) return;
    firingRef.current = true;
    setPending(null);

    // Create thread on the backend — ID is server-assigned via ThreadStore.create
    let threadId: string;
    const title = `[Scheduled] ${fire.taskName}`;
    const now   = new Date().toISOString();
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      threadId = data.id;
    } catch (err) {
      console.error('[Scheduler] Failed to create thread:', err);
      firingRef.current = false;
      return;
    }

    // Add to store and switch — must happen before sendMessage reads activeThreadId
    addThread({ id: threadId, title, projectName: null, createdAt: now });
    setActiveThread(threadId);

    // Confirm to backend: records the run and advances next_run_at
    try {
      await fetch(`${ENGINE_URL}/api/scheduler/pending/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: fire.taskId, threadId }),
      });
    } catch { /* non-fatal — task still fires */ }

    // Small delay lets React flush activeThreadId state before sendMessage reads it.
    // Uses the globally-registered sendMessage from Index.tsx so the full SSE
    // stream path runs — live display, thinking poll, title update all included.
    setTimeout(() => {
      const send = (globalThis as any).__phobosSendMessage as
        ((content: string, files?: File[]) => Promise<void>) | undefined;
      if (send) {
        send(SCHEDULED_PREFIX + fire.prompt).catch(console.error);
      }
      firingRef.current = false;
    }, 100);
  }, [addThread, setActiveThread]);

  // When we were busy and just became free, fire any held pending task
  useEffect(() => {
    if (!isBusy && pending && !firingRef.current) {
      dispatchTask(pending);
    }
  }, [isBusy, pending, dispatchTask]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/scheduler/pending`);
      if (!res.ok) return;
      const { pending: fire } = await res.json() as { pending: PendingFire | null };

      if (!fire) {
        if (!firingRef.current) setPending(null);
        return;
      }

      // Already holding this same fire event — don't re-trigger state update
      setPending(prev =>
        prev?.taskId === fire.taskId && prev?.firedAt === fire.firedAt ? prev : fire
      );

      const busy = useAppStore.getState().streamingThreads.size > 0 || useAppStore.getState().imageGenerating;
      if (!busy && !firingRef.current) {
        await dispatchTask(fire);
      }
    } catch { /* backend may be starting up */ }
  }, [dispatchTask]);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  return { pending, cancelPending };
}
