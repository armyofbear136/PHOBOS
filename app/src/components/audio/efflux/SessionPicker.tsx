/**
 * SessionPicker.tsx — Modal listing every .phobos-session file on disk.
 *
 * Mounted in EffluxPanel alongside the other modals (NoteEntryEditor,
 * InstrumentEditor, ClipPropsPopover). Opens via the toolbar Open button.
 *
 * Behaviour:
 *   • Fetches DawApi.listSessions() each time it opens — fresh data, no
 *     local cache. Sessions on disk can change between opens (the user
 *     can paste files into the folder via Open Folder).
 *   • Click-outside the inner panel closes. Esc closes. Click on a row
 *     calls onPick(filename); the parent decides what to do (load + bond).
 *   • Sorted by modified desc — most recent first.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { X, FolderOpen, Loader2, AlertTriangle } from 'lucide-react';
import { listSessions, type SessionListEntry } from '@/components/audio/services/DawApi';

interface SessionPickerProps {
  open:       boolean;
  onClose:    () => void;
  onPick:     (filename: string) => void;
}

function formatModified(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function SessionPickerImpl({ open, onClose, onPick }: SessionPickerProps) {
  // Three view states: loading, error, ready (where ready may have empty list).
  // Sessions array is replaced wholesale on each open — this is a one-shot
  // fetch, not a long-lived subscription.
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);

  // Re-fetch every time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSessions()
      .then((rows) => {
        if (cancelled) return;
        // Sort desc by modified — backend doesn't guarantee order.
        rows.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
        setSessions(rows);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  // Close on Escape — same idiom as ClipPropsPopover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onRowClick = useCallback((filename: string) => {
    onPick(filename);
  }, [onPick]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-w-[95vw] max-h-[70vh] bg-background border border-phobos-green/30 rounded-sm shadow-2xl flex flex-col"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/30 shrink-0">
          <FolderOpen className="w-4 h-4 text-phobos-green/60" />
          <span className="flex-1 text-sm font-terminal uppercase tracking-[0.12em] text-phobos-green/80">
            Open Session
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-xs font-terminal uppercase tracking-widest text-muted-foreground/60">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading sessions…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 px-4 py-6 text-xs font-mono text-destructive/80">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center px-6">
              <span className="text-xs font-terminal uppercase tracking-widest text-muted-foreground/40">
                No sessions yet
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/30">
                Saved sessions will appear here.
              </span>
            </div>
          )}

          {!loading && !error && sessions.length > 0 && (
            <ul>
              {sessions.map((row) => (
                <li key={row.filename}>
                  <button
                    onClick={() => onRowClick(row.filename)}
                    className="w-full flex items-baseline gap-3 px-4 py-2.5 text-left border-b border-border/15 hover:bg-phobos-green/5 hover:border-phobos-green/40 transition-colors"
                  >
                    <span className="flex-1 min-w-0 text-sm text-phobos-green/90 truncate">
                      {row.title}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/40 truncate max-w-[180px]">
                      {row.filename}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/30 shrink-0">
                      {formatModified(row.modified)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export const SessionPicker = memo(SessionPickerImpl);
