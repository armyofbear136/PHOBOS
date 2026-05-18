/**
 * VaultPanel.tsx — Floating draggable window for PHOBOS Vault.
 *
 * Three tabs: Entries | Groups | Settings
 * Shows Unlock / Create screen when vault is locked or absent.
 * Password reveal is per-entry on demand, auto-clears after 30s.
 * No secret values ever touch global store.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Key, Lock, Unlock, Eye, EyeOff, Plus, Pencil, Trash2,
  Search, ChevronRight, ChevronDown, Copy, Check, Loader2,
  FolderOpen, Settings, AlertCircle,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

type VaultState = 'locked' | 'unlocked' | 'no_database';

interface VaultStatus {
  state:         VaultState;
  entryCount:    number;
  groupCount:    number;
  lastOpenedAt:  string | null;
  dbPath:        string;
  lockTimeout:   number;
}

interface VaultEntry {
  uuid:      string;
  groupUuid: string;
  groupName: string;
  title:     string;
  username:  string;
  url:       string;
  notes:     string;
  tags:      string[];
  createdAt: string;
  updatedAt: string;
  expires:   string | null;
  hasTotp:   boolean;
}

interface VaultGroup {
  uuid:       string;
  name:       string;
  parentUuid: string | null;
  depth:      number;
  entryCount: number;
}

type Tab = 'entries' | 'groups' | 'settings';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── Entry row ─────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry:     VaultEntry;
  onEdit:    (entry: VaultEntry) => void;
  onDelete:  (uuid: string) => void;
}

function EntryRow({ entry, onEdit, onDelete }: EntryRowProps) {
  const [expanded,  setExpanded]  = useState(false);
  const [password,  setPassword]  = useState<string | null>(null);
  const [revealed,  setRevealed]  = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [copied,    setCopied]    = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSecret = useCallback(async () => {
    if (password !== null) { setRevealed(r => !r); return; }
    setLoading(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/vault/entries/${entry.uuid}/secret`);
      if (res.ok) {
        const data = await res.json() as { password: string };
        setPassword(data.password);
        setRevealed(true);
        // Auto-clear after 30s
        if (revealTimer.current) clearTimeout(revealTimer.current);
        revealTimer.current = setTimeout(() => {
          setPassword(null);
          setRevealed(false);
        }, 30_000);
      }
    } finally {
      setLoading(false);
    }
  }, [entry.uuid, password]);

  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);

  const copyPassword = async () => {
    const pw = password ?? await (async () => {
      const res = await fetch(`${ENGINE_URL}/api/vault/entries/${entry.uuid}/secret`);
      if (!res.ok) return null;
      const d = await res.json() as { password: string };
      return d.password;
    })();
    if (!pw) return;
    navigator.clipboard.writeText(pw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <div className="border border-border/30 rounded-sm overflow-hidden">
      {/* Row header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/30 transition-colors select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-muted-foreground/40 shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />}
        <div className="flex-1 min-w-0">
          <span className="text-xs font-mono text-foreground/90 truncate block">{entry.title || '(untitled)'}</span>
          {entry.username && (
            <span className="text-[10px] font-mono text-muted-foreground/50 truncate block">{entry.username}</span>
          )}
        </div>
        {entry.url && (
          <span className="text-[10px] font-mono text-muted-foreground/30 truncate max-w-[140px] shrink-0">
            {stripScheme(entry.url)}
          </span>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/20 bg-black/20 space-y-2">
          {/* Username */}
          {entry.username && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-muted-foreground/40 w-16 shrink-0">USER</span>
              <span className="text-xs font-mono text-foreground/70 flex-1 min-w-0 truncate">{entry.username}</span>
            </div>
          )}
          {/* URL */}
          {entry.url && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-muted-foreground/40 w-16 shrink-0">URL</span>
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-phobos-green/60 hover:text-phobos-green truncate flex-1 min-w-0"
                onClick={e => e.stopPropagation()}
              >
                {entry.url}
              </a>
            </div>
          )}
          {/* Password row */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground/40 w-16 shrink-0">PASS</span>
            <span className="text-xs font-mono text-foreground/70 flex-1 min-w-0 truncate">
              {revealed && password ? password : '••••••••••••'}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={e => { e.stopPropagation(); fetchSecret(); }}
                className="p-1 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors"
                title={revealed ? 'Hide' : 'Reveal'}
              >
                {loading
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : revealed
                    ? <EyeOff className="w-3 h-3" />
                    : <Eye className="w-3 h-3" />}
              </button>
              <button
                onClick={e => { e.stopPropagation(); copyPassword(); }}
                className="p-1 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors"
                title="Copy password"
              >
                {copied ? <Check className="w-3 h-3 text-phobos-green" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>
          {/* Notes */}
          {entry.notes && (
            <div className="flex items-start gap-2">
              <span className="text-[10px] font-mono text-muted-foreground/40 w-16 shrink-0 pt-0.5">NOTES</span>
              <span className="text-xs font-mono text-foreground/50 flex-1 min-w-0 whitespace-pre-wrap break-words">{entry.notes}</span>
            </div>
          )}
          {/* Tags */}
          {entry.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {entry.tags.map(tag => (
                <span key={tag} className="px-1.5 py-0.5 text-[9px] font-mono rounded-sm bg-phobos-green/5 border border-phobos-green/20 text-phobos-green/60">
                  {tag}
                </span>
              ))}
            </div>
          )}
          {/* Modified */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[9px] font-mono text-muted-foreground/25">modified {fmtDate(entry.updatedAt)}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={e => { e.stopPropagation(); onEdit(entry); }}
                className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors"
                title="Edit entry"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(entry.uuid); }}
                className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-destructive transition-colors"
                title="Delete entry"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Entry editor modal ────────────────────────────────────────────────────────

interface EntryEditorProps {
  entry:    Partial<VaultEntry & { password: string }> | null;
  groups:   VaultGroup[];
  onSave:   (fields: { groupUuid: string; title: string; username: string; password: string; url: string; notes: string; tags: string[] }) => Promise<void>;
  onClose:  () => void;
}

function EntryEditor({ entry, groups, onSave, onClose }: EntryEditorProps) {
  const [title,     setTitle]     = useState(entry?.title    ?? '');
  const [username,  setUsername]  = useState(entry?.username ?? '');
  const [password,  setPassword]  = useState('');
  const [url,       setUrl]       = useState(entry?.url      ?? '');
  const [notes,     setNotes]     = useState(entry?.notes    ?? '');
  const [groupUuid, setGroupUuid] = useState(entry?.groupUuid ?? '');
  const [tagStr,    setTagStr]    = useState((entry?.tags ?? []).join(', '));
  const [showPw,    setShowPw]    = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave({
        groupUuid,
        title:    title.trim(),
        username: username.trim(),
        password,
        url:      url.trim(),
        notes:    notes.trim(),
        tags:     tagStr.split(',').map(t => t.trim()).filter(Boolean),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[440px] bg-background border border-border/50 rounded-sm shadow-2xl p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-terminal text-phobos-green/70 uppercase tracking-wider">
            {entry?.uuid ? 'Edit Entry' : 'New Entry'}
          </span>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground/50 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-2 py-1.5 bg-destructive/10 border border-destructive/30 rounded-sm">
            <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
            <span className="text-xs font-mono text-destructive">{error}</span>
          </div>
        )}

        {/* Group */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">Group</label>
          <select
            value={groupUuid}
            onChange={e => setGroupUuid(e.target.value)}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
          >
            <option value="">Default</option>
            {groups.map(g => (
              <option key={g.uuid} value={g.uuid}>{'  '.repeat(g.depth)}{g.name}</option>
            ))}
          </select>
        </div>

        {/* Title */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">Title *</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            placeholder="e.g. GitHub"
            autoFocus
          />
        </div>

        {/* Username */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">Username</label>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            placeholder="user@example.com"
          />
        </div>

        {/* Password */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">
            Password {entry?.uuid ? '(leave blank to keep current)' : ''}
          </label>
          <div className="relative">
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-2 py-1.5 pr-8 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            />
            <button
              type="button"
              onClick={() => setShowPw(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              {showPw ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* URL */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">URL</label>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            placeholder="https://example.com"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40 resize-none"
          />
        </div>

        {/* Tags */}
        <div>
          <label className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider block mb-1">Tags (comma separated)</label>
          <input
            value={tagStr}
            onChange={e => setTagStr(e.target.value)}
            className="w-full px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            placeholder="work, personal"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-border/30 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 transition-colors disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function VaultPanel() {
  const setVaultOpen = useAppStore(s => s.setVaultOpen);

  // Drag
  const [pos, setPos] = useState(() => ({
    x: Math.max(0, Math.round(window.innerWidth  / 2 - 430)),
    y: Math.max(0, Math.round(window.innerHeight / 2 - 390)),
  }));
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, a, textarea, select, [data-nodrag]')) return;
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: dragRef.current.px + e.clientX - dragRef.current.ox, y: dragRef.current.py + e.clientY - dragRef.current.oy });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // Vault state
  const [status,       setStatus]       = useState<VaultStatus | null>(null);
  const [entries,      setEntries]      = useState<VaultEntry[]>([]);
  const [groups,       setGroups]       = useState<VaultGroup[]>([]);
  const [tab,          setTab]          = useState<Tab>('entries');
  const [search,       setSearch]       = useState('');
  const [groupFilter,  setGroupFilter]  = useState<string | null>(null);
  const [masterPw,     setMasterPw]     = useState('');
  const [confirmPw,    setConfirmPw]    = useState('');
  const [showPw,       setShowPw]       = useState(false);
  const [authError,    setAuthError]    = useState('');
  const [authLoading,  setAuthLoading]  = useState(false);
  const [editingEntry, setEditingEntry] = useState<VaultEntry | null>(null);
  const [newEntry,     setNewEntry]     = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  // Settings tab
  const [newPw,        setNewPw]        = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [pwError,      setPwError]      = useState('');
  const [pwSuccess,    setPwSuccess]    = useState(false);
  const [lockTimeout,  setLockTimeout]  = useState(900);
  const [cfgSaving,    setCfgSaving]    = useState(false);

  // Status polling (60s while panel open — detects auto-lock)
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/vault/status`);
      if (res.ok) {
        const data = await res.json() as VaultStatus;
        setStatus(data);
        setLockTimeout(data.lockTimeout);
        return data;
      }
    } catch { /* non-fatal */ }
    return null;
  }, []);

  const loadEntries = useCallback(async (q?: string, group?: string) => {
    const params = new URLSearchParams();
    if (q)     params.set('q', q);
    if (group) params.set('group', group);
    const res = await fetch(`${ENGINE_URL}/api/vault/entries?${params}`);
    if (res.ok) {
      const data = await res.json() as { entries: VaultEntry[] };
      setEntries(data.entries);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    const res = await fetch(`${ENGINE_URL}/api/vault/groups`);
    if (res.ok) {
      const data = await res.json() as { groups: VaultGroup[] };
      setGroups(data.groups);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Auto-lock detection poll
  useEffect(() => {
    const interval = setInterval(async () => {
      const s = await loadStatus();
      if (s?.state === 'unlocked') {
        loadEntries(search || undefined, groupFilter ?? undefined);
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadStatus, loadEntries, search, groupFilter]);

  // Load entries/groups on unlock
  useEffect(() => {
    if (status?.state === 'unlocked') {
      loadEntries();
      loadGroups();
    }
  }, [status?.state, loadEntries, loadGroups]);

  // Search with debounce
  useEffect(() => {
    if (status?.state !== 'unlocked') return;
    const t = setTimeout(() => loadEntries(search || undefined, groupFilter ?? undefined), 250);
    return () => clearTimeout(t);
  }, [search, groupFilter, status?.state, loadEntries]);

  const handleUnlock = async () => {
    if (!masterPw) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch(`${ENGINE_URL}/api/vault/unlock`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: masterPw }),
      });
      if (res.ok) {
        setMasterPw('');
        await loadStatus();
      } else {
        setAuthError('Invalid master password');
      }
    } catch {
      setAuthError('Connection error');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!masterPw || masterPw !== confirmPw) {
      setAuthError(masterPw !== confirmPw ? 'Passwords do not match' : 'Password is required');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch(`${ENGINE_URL}/api/vault/create`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password: masterPw }),
      });
      if (res.ok) {
        setMasterPw('');
        setConfirmPw('');
        await loadStatus();
      } else {
        const d = await res.json() as { error?: string };
        setAuthError(d.error ?? 'Failed to create vault');
      }
    } catch {
      setAuthError('Connection error');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLock = async () => {
    await fetch(`${ENGINE_URL}/api/vault/lock`, { method: 'POST' });
    setEntries([]);
    setGroups([]);
    await loadStatus();
  };

  const handleSaveEntry = async (fields: Parameters<EntryEditorProps['onSave']>[0]) => {
    if (editingEntry) {
      const res = await fetch(`${ENGINE_URL}/api/vault/entries/${editingEntry.uuid}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      });
      if (!res.ok) throw new Error('Failed to save entry');
    } else {
      const res = await fetch(`${ENGINE_URL}/api/vault/entries`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      });
      if (!res.ok) throw new Error('Failed to create entry');
    }
    await loadEntries(search || undefined, groupFilter ?? undefined);
    await loadStatus();
  };

  const handleDeleteEntry = async (uuid: string) => {
    await fetch(`${ENGINE_URL}/api/vault/entries/${uuid}`, { method: 'DELETE' });
    setDeleteConfirm(null);
    await loadEntries(search || undefined, groupFilter ?? undefined);
    await loadStatus();
  };

  const handleChangePw = async () => {
    if (!newPw || newPw !== confirmNewPw) {
      setPwError(newPw !== confirmNewPw ? 'Passwords do not match' : 'Password is required');
      return;
    }
    setCfgSaving(true);
    setPwError('');
    try {
      const res = await fetch(`${ENGINE_URL}/api/vault/change-password`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ newPassword: newPw }),
      });
      if (res.ok) {
        setNewPw('');
        setConfirmNewPw('');
        setPwSuccess(true);
        setTimeout(() => setPwSuccess(false), 3_000);
      } else {
        setPwError('Failed to change password');
      }
    } finally {
      setCfgSaving(false);
    }
  };

  const handleSaveTimeout = async () => {
    setCfgSaving(true);
    try {
      await fetch(`${ENGINE_URL}/api/vault/config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lock_timeout_seconds: lockTimeout }),
      });
    } finally {
      setCfgSaving(false);
    }
  };

  const isUnlocked = status?.state === 'unlocked';
  const isLocked   = status?.state === 'locked';
  const isNew      = status?.state === 'no_database';

  const filteredEntries = entries;

  return (
    <>
      <div
        className="phobos-panel fixed z-[100] w-[860px] bg-background border border-border/50 rounded-sm shadow-2xl flex flex-col overflow-hidden"
        style={{ left: pos.x, top: pos.y, height: 700 }}
      >
        {/* Title bar */}
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-border/30 bg-black/60 cursor-move shrink-0"
          onMouseDown={onMouseDown}
        >
          <div className="flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-phobos-green/60" />
            <span className="text-[10px] font-terminal text-phobos-green/70 uppercase tracking-[0.15em]">
              VAULT
            </span>
            {isUnlocked && (
              <span className="flex items-center gap-1 text-[9px] font-mono text-phobos-green/40">
                <span className="w-1.5 h-1.5 rounded-full bg-phobos-green/60 animate-pulse-dot" />
                UNLOCKED · {status.entryCount} entries
              </span>
            )}
            {isLocked && (
              <span className="text-[9px] font-mono text-muted-foreground/30">LOCKED</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {isUnlocked && (
              <button
                onClick={handleLock}
                className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono rounded-sm border border-border/20 text-muted-foreground/40 hover:text-muted-foreground hover:border-border/40 transition-colors"
                title="Lock vault"
              >
                <Lock className="w-2.5 h-2.5" /> LOCK
              </button>
            )}
            <button
              onClick={() => setVaultOpen(false)}
              className="p-1 rounded hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Unlock / Create screen ── */}
        {(isLocked || isNew || !status) && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="w-full max-w-sm space-y-4">
              <div className="text-center space-y-1">
                <Key className="w-8 h-8 text-phobos-green/30 mx-auto" />
                <p className="text-xs font-terminal text-phobos-green/60 uppercase tracking-wider">
                  {isNew ? 'Create New Vault' : 'Unlock Vault'}
                </p>
                <p className="text-[10px] font-mono text-muted-foreground/30">
                  {isNew
                    ? 'Your credentials will be stored in an encrypted KDBX4 file.'
                    : 'Enter your master password to unlock.'}
                </p>
              </div>

              {authError && (
                <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-sm">
                  <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                  <span className="text-xs font-mono text-destructive">{authError}</span>
                </div>
              )}

              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={masterPw}
                  onChange={e => setMasterPw(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !isNew && handleUnlock()}
                  placeholder="Master password"
                  className="w-full px-3 py-2 pr-9 bg-background border border-border/40 rounded-sm text-sm font-mono text-foreground/80 placeholder:text-muted-foreground/20 focus:outline-none focus:border-phobos-green/40"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
                >
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>

              {isNew && (
                <input
                  type={showPw ? 'text' : 'password'}
                  value={confirmPw}
                  onChange={e => setConfirmPw(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  placeholder="Confirm password"
                  className="w-full px-3 py-2 bg-background border border-border/40 rounded-sm text-sm font-mono text-foreground/80 placeholder:text-muted-foreground/20 focus:outline-none focus:border-phobos-green/40"
                />
              )}

              <button
                onClick={isNew ? handleCreate : handleUnlock}
                disabled={authLoading || !masterPw}
                className="w-full py-2 text-[11px] font-terminal uppercase tracking-[0.15em] rounded-sm border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 hover:shadow-[0_0_10px_hsl(120_100%_50%/0.08)] transition-all disabled:opacity-30"
              >
                {authLoading
                  ? <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  : isNew
                    ? <><Plus className="w-3.5 h-3.5 inline mr-1.5" />CREATE VAULT</>
                    : <><Unlock className="w-3.5 h-3.5 inline mr-1.5" />UNLOCK</>}
              </button>
            </div>
          </div>
        )}

        {/* ── Unlocked content ── */}
        {isUnlocked && (
          <>
            {/* Tabs */}
            <div className="flex items-center gap-0 border-b border-border/30 px-3 shrink-0">
              {(['entries', 'groups', 'settings'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 text-[10px] font-terminal uppercase tracking-wider transition-colors border-b-2 -mb-px ${
                    tab === t
                      ? 'border-phobos-green/60 text-phobos-green/80'
                      : 'border-transparent text-muted-foreground/40 hover:text-muted-foreground/70'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* ── Entries tab ── */}
            {tab === 'entries' && (
              <div className="flex flex-1 min-h-0">
                {/* Group sidebar */}
                <div className="w-44 border-r border-border/20 flex flex-col shrink-0">
                  <div className="px-2 py-2 border-b border-border/20">
                    <span className="text-[9px] font-mono text-muted-foreground/30 uppercase tracking-wider">Groups</span>
                  </div>
                  <div className="flex-1 overflow-y-auto py-1">
                    <button
                      onClick={() => setGroupFilter(null)}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                        groupFilter === null
                          ? 'text-phobos-green/80 bg-phobos-green/5'
                          : 'text-muted-foreground/50 hover:text-muted-foreground/80'
                      }`}
                    >
                      All Entries
                      <span className="float-right text-[10px] text-muted-foreground/30">{status.entryCount}</span>
                    </button>
                    {groups.map(g => (
                      <button
                        key={g.uuid}
                        onClick={() => setGroupFilter(g.uuid)}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
                          groupFilter === g.uuid
                            ? 'text-phobos-green/80 bg-phobos-green/5'
                            : 'text-muted-foreground/50 hover:text-muted-foreground/80'
                        }`}
                        style={{ paddingLeft: `${12 + g.depth * 12}px` }}
                      >
                        <FolderOpen className="w-3 h-3 inline mr-1.5 opacity-40" />
                        {g.name}
                        <span className="float-right text-[10px] text-muted-foreground/30">{g.entryCount}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Entry list */}
                <div className="flex-1 flex flex-col min-w-0">
                  {/* Search + add */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 shrink-0">
                    <div className="flex-1 relative">
                      <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/30" />
                      <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search entries..."
                        className="w-full pl-7 pr-2 py-1 bg-background border border-border/30 rounded-sm text-xs font-mono text-foreground/70 placeholder:text-muted-foreground/20 focus:outline-none focus:border-phobos-green/30"
                      />
                    </div>
                    <button
                      onClick={() => { setEditingEntry(null); setNewEntry(true); }}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 transition-colors"
                    >
                      <Plus className="w-3 h-3" /> New
                    </button>
                  </div>

                  {/* List */}
                  <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                    {filteredEntries.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground/25">
                        <Key className="w-6 h-6 mb-2 opacity-20" />
                        <span className="text-xs font-mono">
                          {search ? 'No entries match your search' : 'No entries yet'}
                        </span>
                      </div>
                    )}
                    {filteredEntries.map(entry => (
                      deleteConfirm === entry.uuid ? (
                        <div key={entry.uuid} className="flex items-center gap-2 px-3 py-2 border border-destructive/30 rounded-sm bg-destructive/5">
                          <span className="text-xs font-mono text-destructive/80 flex-1">Delete "{entry.title}"?</span>
                          <button onClick={() => handleDeleteEntry(entry.uuid)} className="px-2 py-0.5 text-[10px] font-terminal uppercase border border-destructive/40 text-destructive/70 hover:text-destructive rounded-sm transition-colors">Delete</button>
                          <button onClick={() => setDeleteConfirm(null)} className="px-2 py-0.5 text-[10px] font-terminal uppercase border border-border/30 text-muted-foreground/50 rounded-sm transition-colors">Cancel</button>
                        </div>
                      ) : (
                        <EntryRow
                          key={entry.uuid}
                          entry={entry}
                          onEdit={e => { setEditingEntry(e); setNewEntry(false); }}
                          onDelete={uuid => setDeleteConfirm(uuid)}
                        />
                      )
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── Groups tab ── */}
            {tab === 'groups' && (
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wider">
                    {groups.length} group{groups.length !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={async () => {
                      const name = prompt('Group name:');
                      if (!name) return;
                      await fetch(`${ENGINE_URL}/api/vault/groups`, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ name }),
                      });
                      await loadGroups();
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> New Group
                  </button>
                </div>
                {groups.length === 0 && (
                  <p className="text-xs font-mono text-muted-foreground/25 text-center py-8">No custom groups</p>
                )}
                {groups.map(g => (
                  <div key={g.uuid} className="flex items-center gap-2 px-3 py-2 border border-border/20 rounded-sm" style={{ marginLeft: g.depth * 16 }}>
                    <FolderOpen className="w-3.5 h-3.5 text-muted-foreground/30 shrink-0" />
                    <span className="text-xs font-mono text-foreground/70 flex-1">{g.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground/30">{g.entryCount} entries</span>
                    <button
                      onClick={async () => {
                        const name = prompt('New name:', g.name);
                        if (!name) return;
                        await fetch(`${ENGINE_URL}/api/vault/groups/${g.uuid}`, {
                          method:  'PUT',
                          headers: { 'Content-Type': 'application/json' },
                          body:    JSON.stringify({ name }),
                        });
                        await loadGroups();
                      }}
                      className="p-1 rounded hover:bg-accent text-muted-foreground/30 hover:text-foreground transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete group "${g.name}" and move its entries to trash?`)) return;
                        await fetch(`${ENGINE_URL}/api/vault/groups/${g.uuid}`, { method: 'DELETE' });
                        await loadGroups();
                        await loadEntries();
                      }}
                      className="p-1 rounded hover:bg-accent text-muted-foreground/30 hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ── Settings tab ── */}
            {tab === 'settings' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                {/* Vault info */}
                <div className="space-y-2">
                  <p className="text-[10px] font-terminal text-phobos-green/50 uppercase tracking-wider border-b border-border/20 pb-1">Vault Info</p>
                  <div className="space-y-1">
                    <div className="flex gap-3">
                      <span className="text-[10px] font-mono text-muted-foreground/40 w-24 shrink-0">File</span>
                      <span className="text-[10px] font-mono text-foreground/50 break-all">{status.dbPath}</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="text-[10px] font-mono text-muted-foreground/40 w-24 shrink-0">Last opened</span>
                      <span className="text-[10px] font-mono text-foreground/50">{fmtDate(status.lastOpenedAt)}</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="text-[10px] font-mono text-muted-foreground/40 w-24 shrink-0">Entries</span>
                      <span className="text-[10px] font-mono text-foreground/50">{status.entryCount}</span>
                    </div>
                  </div>
                </div>

                {/* Auto-lock */}
                <div className="space-y-2">
                  <p className="text-[10px] font-terminal text-phobos-green/50 uppercase tracking-wider border-b border-border/20 pb-1">Auto-Lock</p>
                  <div className="flex items-center gap-3">
                    <select
                      value={lockTimeout}
                      onChange={e => setLockTimeout(Number(e.target.value))}
                      className="px-2 py-1.5 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/70 focus:outline-none focus:border-phobos-green/40"
                    >
                      <option value={0}>Never</option>
                      <option value={300}>5 minutes</option>
                      <option value={900}>15 minutes</option>
                      <option value={1800}>30 minutes</option>
                      <option value={3600}>1 hour</option>
                    </select>
                    <button
                      onClick={handleSaveTimeout}
                      disabled={cfgSaving}
                      className="px-3 py-1.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 transition-colors disabled:opacity-30"
                    >
                      {cfgSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Change master password */}
                <div className="space-y-2">
                  <p className="text-[10px] font-terminal text-phobos-green/50 uppercase tracking-wider border-b border-border/20 pb-1">Change Master Password</p>
                  {pwError && (
                    <div className="flex items-center gap-2 px-2 py-1.5 bg-destructive/10 border border-destructive/30 rounded-sm">
                      <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                      <span className="text-xs font-mono text-destructive">{pwError}</span>
                    </div>
                  )}
                  {pwSuccess && (
                    <div className="flex items-center gap-2 px-2 py-1.5 bg-phobos-green/5 border border-phobos-green/20 rounded-sm">
                      <Check className="w-3 h-3 text-phobos-green shrink-0" />
                      <span className="text-xs font-mono text-phobos-green/70">Password changed successfully</span>
                    </div>
                  )}
                  <input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    placeholder="New password"
                    className="w-full px-3 py-2 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/20 focus:outline-none focus:border-phobos-green/40"
                  />
                  <input
                    type="password"
                    value={confirmNewPw}
                    onChange={e => setConfirmNewPw(e.target.value)}
                    placeholder="Confirm new password"
                    className="w-full px-3 py-2 bg-background border border-border/40 rounded-sm text-xs font-mono text-foreground/80 placeholder:text-muted-foreground/20 focus:outline-none focus:border-phobos-green/40"
                  />
                  <button
                    onClick={handleChangePw}
                    disabled={cfgSaving || !newPw}
                    className="px-4 py-1.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 transition-colors disabled:opacity-30"
                  >
                    {cfgSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Change Password'}
                  </button>
                </div>

                {/* Lock now */}
                <div className="space-y-2">
                  <p className="text-[10px] font-terminal text-phobos-green/50 uppercase tracking-wider border-b border-border/20 pb-1">Session</p>
                  <button
                    onClick={handleLock}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-terminal uppercase tracking-wider rounded-sm border border-border/30 text-muted-foreground/50 hover:text-destructive hover:border-destructive/40 transition-colors"
                  >
                    <Lock className="w-3 h-3" /> Lock Now
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Entry editor modal */}
      {(newEntry || editingEntry) && (
        <EntryEditor
          entry={editingEntry}
          groups={groups}
          onSave={handleSaveEntry}
          onClose={() => { setEditingEntry(null); setNewEntry(false); }}
        />
      )}
    </>
  );
}
