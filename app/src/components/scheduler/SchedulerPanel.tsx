import { useState, useEffect, useCallback, Fragment } from 'react';
import { X, Clock, Plus, Trash2, Play, ToggleLeft, ToggleRight, ChevronDown, ChevronRight } from 'lucide-react';
import { TaskBuilderDialog, type TaskFormData } from './TaskBuilderDialog';
import { humanCron, computeNextRunTs } from './cronUtils';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface ScheduledTask {
  id:              string;
  name:            string;
  description:     string | null;
  cron_expression: string;
  prompt:          string;
  enabled:         boolean;
  last_run_at:     string | null;
  last_run_status: 'success' | 'error' | 'pending' | null;
  last_run_error:  string | null;
  next_run_at:     string | null;
  created_at:           string;
  updated_at:           string;
  task_type:            'conversation' | 'background' | 'security' | 'ha';
  task_parameters:      string[] | null;
  pinned_sayon_model:   string | null;
  pinned_seren_model:   string | null;
  pinned_cartridge_id:  string | null;
}

interface TaskRun {
  id:             string;
  task_id:        string;
  started_at:     string;
  completed_at:   string | null;
  status:         'running' | 'success' | 'error';
  output_summary: string | null;
  error_message:  string | null;
  thread_id:      string | null;
}

interface Props { onClose: () => void; }

const STATUS_DOT: Record<string, string> = {
  success: 'bg-phobos-green',
  error:   'bg-destructive',
  pending: 'bg-phobos-amber',
  running: 'bg-phobos-amber animate-pulse',
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtNextRun(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 60_000) return 'in <1 min';
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString();
}

export function SchedulerPanel({ onClose }: Props) {
  const [tasks,       setTasks]       = useState<ScheduledTask[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [building,    setBuilding]    = useState(false);  // dialog open for new
  const [editing,     setEditing]     = useState<ScheduledTask | null>(null);
  const [saving,      setSaving]      = useState(false);
  const [expandedId,  setExpandedId]  = useState<string | null>(null);
  const [runs,        setRuns]        = useState<Record<string, TaskRun[]>>({});

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/scheduler/tasks`);
      if (res.ok) setTasks(await res.json());
    } catch { /* non-fatal */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  async function loadRuns(taskId: string) {
    if (runs[taskId]) return; // already loaded
    try {
      const res = await fetch(`${ENGINE_URL}/api/scheduler/tasks/${taskId}/runs`);
      if (res.ok) {
        const data = await res.json();
        setRuns(prev => ({ ...prev, [taskId]: data }));
      }
    } catch { /* non-fatal */ }
  }

  function toggleExpand(taskId: string) {
    if (expandedId === taskId) {
      setExpandedId(null);
    } else {
      setExpandedId(taskId);
      loadRuns(taskId);
    }
  }

  async function handleSave(data: TaskFormData) {
    setSaving(true);
    try {
      if (editing) {
        await fetch(`${ENGINE_URL}/api/scheduler/tasks/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        setEditing(null);
      } else {
        await fetch(`${ENGINE_URL}/api/scheduler/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        setBuilding(false);
      }
      await loadTasks();
    } catch { /* non-fatal */ }
    setSaving(false);
  }

  async function handleDelete(task: ScheduledTask) {
    if (!confirm(`Delete "${task.name}"?`)) return;
    await fetch(`${ENGINE_URL}/api/scheduler/tasks/${task.id}`, { method: 'DELETE' });
    setTasks(prev => prev.filter(t => t.id !== task.id));
  }

  async function handleToggle(task: ScheduledTask) {
    const res = await fetch(`${ENGINE_URL}/api/scheduler/tasks/${task.id}/toggle`, { method: 'PATCH' });
    if (res.ok) {
      const updated: ScheduledTask = await res.json();
      setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
    }
  }

  async function handleRunNow(task: ScheduledTask) {
    await fetch(`${ENGINE_URL}/api/scheduler/tasks/${task.id}/run`, { method: 'POST' });
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
        <div className="phobos-panel w-[760px] max-w-[96vw] h-[600px] max-h-[88vh] bg-card border border-border rounded-sm flex flex-col overflow-hidden shadow-2xl">

          {/* Header */}
          <div className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-phobos-green/50" />
              <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-phobos-green/70">
                Scheduler
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBuilding(true)}
                className="flex items-center gap-1 px-2.5 py-1 text-[9px] font-terminal uppercase tracking-widest border border-phobos-green/30 text-phobos-green/70 hover:bg-phobos-green/5 hover:border-phobos-green/50 rounded-sm transition-colors"
              >
                <Plus className="w-3 h-3" />
                New Task
              </button>
              <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <span className="text-[10px] font-terminal text-muted-foreground/40 uppercase tracking-widest">Loading…</span>
              </div>
            ) : tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Clock className="w-8 h-8 text-muted-foreground/20" />
                <span className="text-xs text-muted-foreground/40">No scheduled tasks</span>
                <button onClick={() => setBuilding(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-terminal uppercase tracking-widest border border-phobos-green/30 text-phobos-green/70 hover:bg-phobos-green/5 rounded-sm transition-colors">
                  <Plus className="w-3 h-3" />
                  Create first task
                </button>
              </div>
            ) : (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border/30">
                    {['', 'Name', 'Schedule', 'Last Run', 'Next Run', 'Status', ''].map((h, i) => (
                      <th key={i} className="text-left text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 px-3 py-2 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(task => (
                    <Fragment key={task.id}>
                      <tr
                        className={`border-b border-border/20 hover:bg-accent/30 transition-colors ${!task.enabled ? 'opacity-50' : ''}`}
                      >
                        {/* Expand toggle */}
                        <td className="px-2 py-2 w-6">
                          <button onClick={() => toggleExpand(task.id)} className="text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors">
                            {expandedId === task.id
                              ? <ChevronDown className="w-3 h-3" />
                              : <ChevronRight className="w-3 h-3" />}
                          </button>
                        </td>
                        {/* Name */}
                        <td className="px-2 py-2">
                          <div className="text-[11px] font-medium text-foreground/80">{task.name}</div>
                          {task.description && (
                            <div className="text-[9px] text-muted-foreground/50 mt-0.5">{task.description}</div>
                          )}
                          {task.task_type && task.task_type !== 'conversation' && (
                            <div className="text-[8px] font-mono text-muted-foreground/30 mt-0.5 uppercase tracking-widest">{task.task_type}</div>
                          )}
                          {(task.pinned_sayon_model || task.pinned_seren_model || task.pinned_cartridge_id) && (
                            <div className="text-[8px] font-mono text-phobos-green/40 mt-0.5">model override active</div>
                          )}
                        </td>
                        {/* Schedule */}
                        <td className="px-2 py-2 text-[10px] font-mono text-muted-foreground/60 whitespace-nowrap">
                          {humanCron(task.cron_expression)}
                        </td>
                        {/* Last run */}
                        <td className="px-2 py-2 text-[10px] text-muted-foreground/50 whitespace-nowrap">
                          {fmtTime(task.last_run_at)}
                        </td>
                        {/* Next run */}
                        <td className="px-2 py-2 text-[10px] text-muted-foreground/50 whitespace-nowrap">
                          {task.enabled ? fmtNextRun(task.next_run_at) : '—'}
                        </td>
                        {/* Status dot */}
                        <td className="px-2 py-2">
                          {task.last_run_status && (
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[task.last_run_status] ?? 'bg-muted-foreground/30'}`} />
                          )}
                        </td>
                        {/* Actions */}
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1 justify-end">
                            <button title="Run now" onClick={() => handleRunNow(task)}
                              className="p-1 text-muted-foreground/40 hover:text-phobos-green/70 transition-colors">
                              <Play className="w-3 h-3" />
                            </button>
                            <button title={task.enabled ? 'Disable' : 'Enable'} onClick={() => handleToggle(task)}
                              className="p-1 text-muted-foreground/40 hover:text-phobos-green/70 transition-colors">
                              {task.enabled
                                ? <ToggleRight className="w-3.5 h-3.5 text-phobos-green/60" />
                                : <ToggleLeft className="w-3.5 h-3.5" />}
                            </button>
                            <button title="Edit" onClick={() => setEditing(task)}
                              className="p-1 text-[9px] font-terminal text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors">
                              EDIT
                            </button>
                            <button title="Delete" onClick={() => handleDelete(task)}
                              className="p-1 text-muted-foreground/40 hover:text-destructive/70 transition-colors">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Run history expand */}
                      {expandedId === task.id && (
                        <tr key={`${task.id}-runs`} className="border-b border-border/10 bg-black/20">
                          <td colSpan={7} className="px-6 py-2">
                            {!runs[task.id] ? (
                              <span className="text-[9px] text-muted-foreground/40">Loading history…</span>
                            ) : runs[task.id].length === 0 ? (
                              <span className="text-[9px] text-muted-foreground/40">No runs yet</span>
                            ) : (
                              <div className="space-y-1">
                                {runs[task.id].slice(0, 10).map(run => (
                                  <div key={run.id} className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground/50">
                                    <span className={`w-1 h-1 rounded-full shrink-0 ${STATUS_DOT[run.status] ?? 'bg-muted-foreground/30'}`} />
                                    <span className="text-muted-foreground/70">{fmtTime(run.started_at)}</span>
                                    <span className="text-muted-foreground/40 uppercase">{run.status}</span>
                                    {run.output_summary && (
                                      <span className="truncate max-w-[400px] text-muted-foreground/40">{run.output_summary}</span>
                                    )}
                                    {run.error_message && (
                                      <span className="truncate max-w-[400px] text-destructive/60">{run.error_message}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer */}
          <div className="h-8 flex items-center px-3 border-t border-border/30 bg-black/20 shrink-0">
            <span className="text-[9px] font-terminal text-muted-foreground/30 uppercase tracking-widest">
              {tasks.length} task{tasks.length !== 1 ? 's' : ''} — tasks fire when PHOBOS is running
            </span>
          </div>

        </div>
      </div>

      {/* Dialogs */}
      {building && (
        <TaskBuilderDialog
          onSave={handleSave}
          onClose={() => setBuilding(false)}
          saving={saving}
        />
      )}
      {editing && (
        <TaskBuilderDialog
          initial={{
            name:                editing.name,
            description:         editing.description ?? '',
            cron_expression:     editing.cron_expression,
            prompt:              editing.prompt,
            enabled:             editing.enabled,
            task_type:           editing.task_type,
            task_parameters:     editing.task_parameters,
            pinned_sayon_model:  editing.pinned_sayon_model,
            pinned_seren_model:  editing.pinned_seren_model,
            pinned_cartridge_id: editing.pinned_cartridge_id,
          }}
          onSave={handleSave}
          onClose={() => setEditing(null)}
          saving={saving}
        />
      )}
    </>
  );
}