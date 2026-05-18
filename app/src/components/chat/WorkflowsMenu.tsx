import { useState, useEffect, useCallback } from 'react';
import { Images, Plus, Clock, Trash2, Film, Music2 } from 'lucide-react';
import { useWorkflowStore, type WorkflowIndexEntry, type WorkflowSession } from '@/store/useWorkflowStore';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface WorkflowsMenuProps {
  threadId: string;
}

const EMPTY_ENTRIES: WorkflowIndexEntry[] = [];

export function WorkflowsMenu({ threadId }: WorkflowsMenuProps) {
  const entries       = useWorkflowStore((s) => s.index[threadId] ?? EMPTY_ENTRIES);
  const generating    = useWorkflowStore((s) => s.generating);
  const setIndex      = useWorkflowStore((s) => s.setIndex);
  const openPanel     = useWorkflowStore((s) => s.openPanel);
  const activeSession = useWorkflowStore((s) => s.activeSession);
  // Timestamp updated every poll cycle — used as cache-buster for actively generating entries
  const [pollTs, setPollTs] = useState(() => Date.now());

  const loadIndex = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/workflows`);
      if (res.ok) {
        const data = await res.json();
        setIndex(threadId, data.workflows ?? []);
        setPollTs(Date.now()); // advance poll timestamp so generating entries re-fetch
      }
    } catch { /* silent */ }
  }, [threadId, setIndex]);

  // Poll every 3s — same cadence as workspace media sync.
  // No revision dependency: avoids re-render loops.
  useEffect(() => {
    loadIndex();
    const id = setInterval(loadIndex, 3000);
    return () => clearInterval(id);
  }, [loadIndex]);

  const openWorkflow = async (entry: WorkflowIndexEntry) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/workflows/${entry.workflowId}`);
      if (res.ok) {
        const data = await res.json();
        openPanel(data.session as WorkflowSession);
      }
    } catch { /* silent */ }
  };

  const createWorkflow = async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        openPanel(data.session as WorkflowSession);
        loadIndex();
      }
    } catch { /* silent */ }
  };

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const closePanel = useWorkflowStore((s) => s.closePanel);

  const deleteWorkflow = async (workflowId: string) => {
    try {
      await fetch(`${ENGINE_URL}/api/threads/${threadId}/workflows/${workflowId}`, { method: 'DELETE' });
      if (activeSession?.workflowId === workflowId) closePanel();
      setDeletingId(null);
      loadIndex();
    } catch { /* silent */ }
  };

  if (entries.length === 0) return null;

  return (
    <div className="border-l border-border/30 flex flex-col shrink-0" style={{ width: 140 }}>
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/20">
        <Images className="w-3 h-3 text-ui-glow" />
        <span className="text-[9px] font-mono text-ui-glow uppercase tracking-wider flex-1">Workflows</span>
        <button
          onClick={createWorkflow}
          className="p-0.5 text-ui-glow hover:text-phobos-green/60 transition-colors"
          title="New workflow"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {entries.slice().reverse().map((entry) => {
          const isActive = activeSession?.workflowId === entry.workflowId;
          const isDeleting = deletingId === entry.workflowId;
          // Cache-bust strategy:
          // - Actively generating: use pollTs (changes every 3s poll) so the browser
          //   re-fetches the thumbnail as each step completes. The endpoint falls back
          //   to the last node outputPath when thumbPath is null.
          // - Completed: use thumbPath (only changes when a new image is saved) so the
          //   URL is stable and the browser serves from cache without flicker.
          const isGenerating = !!generating[entry.workflowId];
          const cacheBust = isGenerating ? pollTs : (entry.thumbPath ? encodeURIComponent(entry.thumbPath) : 'none');
          const thumbUrl = `${ENGINE_URL}/api/threads/${threadId}/workflows/${entry.workflowId}/thumbnail?r=${cacheBust}`;
          return (
            <div
              key={entry.workflowId}
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-all border-b border-border/10 group ${
                isActive ? 'bg-phobos-green/8' : 'hover:bg-muted/20'
              }`}
            >
              <div
                onClick={() => openWorkflow(entry)}
                className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
              >
                {/* Thumb */}
                <div className={`w-8 h-8 rounded border overflow-hidden shrink-0 flex items-center justify-center ${
                  entry.workflowType === 'video' ? 'border-phobos-amber/20 bg-phobos-amber/5'
                  : entry.workflowType === 'audio' ? 'border-phobos-green/20 bg-phobos-green/5'
                  : 'border-border/20 bg-muted/20'
                }`}>
                  {entry.workflowType === 'video' ? (
                    <Film className="w-3.5 h-3.5 text-phobos-amber/50" />
                  ) : entry.workflowType === 'audio' ? (
                    <Music2 className="w-3.5 h-3.5 text-phobos-green/50" />
                  ) : (
                    <img
                      key={entry.workflowId}
                      src={thumbUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      onLoad={(e) => { (e.target as HTMLImageElement).style.display = ''; }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[10px] font-mono truncate ${isActive ? 'text-phobos-green/80' : 'text-foreground/80'}`}>
                    {entry.name}
                  </div>
                  <div className="flex items-center gap-1 text-[9px] font-mono text-sayon/55">
                    <Clock className="w-2 h-2" />
                    {relTime(entry.createdAt)}
                  </div>
                </div>
              </div>
              {/* Delete */}
              {isDeleting ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => deleteWorkflow(entry.workflowId)}
                    className="text-[8px] font-mono text-destructive/80 hover:text-destructive"
                  >
                    yes
                  </button>
                  <button
                    onClick={() => setDeletingId(null)}
                    className="text-[8px] font-mono text-muted-foreground/40 hover:text-muted-foreground"
                  >
                    no
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setDeletingId(entry.workflowId); }}
                  className="p-0.5 text-muted-foreground/0 group-hover:text-muted-foreground/30 hover:!text-destructive/60 transition-colors shrink-0"
                  title="Delete workflow"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}