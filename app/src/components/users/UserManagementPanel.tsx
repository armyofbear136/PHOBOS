/**
 * UserManagementPanel.tsx — PHOBOS User Management Panel.
 *
 * Floating draggable panel (same shell as SecurityPanel). Renders a password
 * gate on open; after auth it shows three tabs:
 *   Users    — table, add user, update role, delete
 *   Switch   — switch the active user (triggers restart)
 *   Settings — change management password
 *
 * Session token is held in component state — never in useAppStore or persisted.
 * Token expires after 30 min; the panel re-shows the gate on next open.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, X, Plus, Trash2, RefreshCw, Loader2, CheckCircle2,
  Lock, AlertTriangle, Copy, Key,
} from 'lucide-react';
import { useAppStore }   from '@/store/useAppStore';
import { UserAuthGate }  from './UserAuthGate';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ──────────────────────────────────────────────────────────────────────

type UserRole = 'admin' | 'full' | 'guest' | 'read';
type Tab      = 'users' | 'switch' | 'codes' | 'settings';

interface UserRecord {
  username:     string;
  display_name: string;
  role:         UserRole;
  created_at:   string;
  last_active:  string | null;
}

interface AdminStatus {
  activeUser:  string;
  userCount:   number;
  passwordSet: boolean;
}

interface AccessCode {
  code:             string;          // nonce (DB key, used for revoke)
  encoded_code:     string;          // full PH1.* string shown to user
  issuing_username: string;
  target_username:  string | null;
  code_type:        'guest' | 'self';
  consumed:         boolean;
  created_at:       string;
  expires_at:       string;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  full:  'Full',
  guest: 'Guest',
  read:  'Read-only',
};

const ROLE_OPTIONS: UserRole[] = ['admin', 'full', 'guest', 'read'];

const TABS: { id: Tab; label: string }[] = [
  { id: 'users',    label: 'Users'    },
  { id: 'switch',   label: 'Switch'   },
  { id: 'codes',    label: 'Codes'    },
  { id: 'settings', label: 'Settings' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  // Codes with ~10-year expiry are treated as permanent.
  if (d.getFullYear() >= new Date().getFullYear() + 9) return 'Never';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function UserManagementPanel() {
  const setUserMgmtOpen = useAppStore(s => s.setUserMgmtOpen);

  // ── Drag state ─────────────────────────────────────────────────────────────
  const [pos, setPos] = useState(() => ({
    x: Math.max(0, Math.round(window.innerWidth  / 2 - 400)),
    y: Math.max(0, Math.round(window.innerHeight / 2 - 300)),
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
      setPos({
        x: dragRef.current.px + e.clientX - dragRef.current.ox,
        y: dragRef.current.py + e.clientY - dragRef.current.oy,
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [token,        setToken]        = useState<string | null>(null);
  const [adminStatus,  setAdminStatus]  = useState<AdminStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  // Load public status once on mount to know if password is set
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/admin/status`)
      .then(r => r.json())
      .then((data: AdminStatus) => { setAdminStatus(data); setStatusLoaded(true); })
      .catch(() => setStatusLoaded(true));
  }, []);

  // ── Panel state ────────────────────────────────────────────────────────────
  const [tab,     setTab]     = useState<Tab>('users');
  const [users,   setUsers]   = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // ── Add-user form ──────────────────────────────────────────────────────────
  const [addOpen,        setAddOpen]        = useState(false);
  const [newUsername,    setNewUsername]     = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole,        setNewRole]        = useState<UserRole>('full');
  const [addError,       setAddError]       = useState<string | null>(null);
  const [addSubmitting,  setAddSubmitting]  = useState(false);

  // ── Switch-user state ──────────────────────────────────────────────────────
  const [switching,     setSwitching]     = useState(false);
  const [switchTarget,  setSwitchTarget]  = useState<string | null>(null);

  // ── Access codes state ─────────────────────────────────────────────────────
  const [codes,          setCodes]          = useState<AccessCode[]>([]);
  const [codesLoading,   setCodesLoading]   = useState(false);
  const [codesError,     setCodesError]     = useState<string | null>(null);
  const [codeGenType,    setCodeGenType]    = useState<'guest' | 'self'>('guest');
  const [codeGenExpiry,  setCodeGenExpiry]  = useState(72);
  const [codeGenBusy,    setCodeGenBusy]    = useState(false);
  const [copiedCode,     setCopiedCode]     = useState<string | null>(null);

  // ── Change-password form ───────────────────────────────────────────────────
  const [curPw,      setCurPw]      = useState('');
  const [newPw,      setNewPw]      = useState('');
  const [confirmPw,  setConfirmPw]  = useState('');
  const [pwError,    setPwError]    = useState<string | null>(null);
  const [pwOk,       setPwOk]       = useState(false);
  const [pwSaving,   setPwSaving]   = useState(false);

  // ── Load users after auth ──────────────────────────────────────────────────

  const loadUsers = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users`, {
        headers: { 'Authorization': `Bearer ${tok}` },
      });
      if (res.status === 401) { setToken(null); return; }
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json() as { users: UserRecord[] };
      setUsers(data.users);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) loadUsers(token);
  }, [token, loadUsers]);

  // ── Auth callback ──────────────────────────────────────────────────────────

  const handleAuth = useCallback((tok: string) => {
    setToken(tok);
    // Re-fetch status to get fresh activeUser
    fetch(`${ENGINE_URL}/api/admin/status`)
      .then(r => r.json())
      .then((data: AdminStatus) => setAdminStatus(data))
      .catch(() => {});
  }, []);

  // ── Add user ───────────────────────────────────────────────────────────────

  const handleAddUser = useCallback(async () => {
    if (!token || !newUsername || !newDisplayName) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ username: newUsername, display_name: newDisplayName, role: newRole }),
      });
      const data = await res.json() as { error?: string; user?: UserRecord };
      if (!res.ok) { setAddError(data.error ?? 'Failed to create user'); return; }
      setUsers(prev => [...prev, data.user!]);
      setAddOpen(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewRole('full');
    } catch {
      setAddError('Could not reach server.');
    } finally {
      setAddSubmitting(false);
    }
  }, [token, newUsername, newDisplayName, newRole]);

  // ── Update role ────────────────────────────────────────────────────────────

  const handleRoleChange = useCallback(async (username: string, role: UserRole) => {
    if (!token) return;
    // Optimistic update
    setUsers(prev => prev.map(u => u.username === username ? { ...u, role } : u));
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users/${username}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ role }),
      });
      if (!res.ok) {
        // Revert on failure
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Role update failed');
        if (token) loadUsers(token);
      }
    } catch {
      setError('Could not reach server.');
      if (token) loadUsers(token);
    }
  }, [token, loadUsers]);

  // ── Delete user ────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (username: string) => {
    if (!token) return;
    if (!window.confirm(`Delete user '${username}'? Their data directory will be preserved.`)) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users/${username}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        setUsers(prev => prev.filter(u => u.username !== username));
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error ?? 'Delete failed');
      }
    } catch {
      setError('Could not reach server.');
    }
  }, [token]);

  // ── Switch user ────────────────────────────────────────────────────────────

  const handleSwitch = useCallback(async (username: string) => {
    if (!token) return;
    setSwitching(true);
    setSwitchTarget(username);
    try {
      await fetch(`${ENGINE_URL}/api/admin/switch-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ username }),
      });
      // Server exits — app will reconnect automatically via the existing
      // ConnectionSplash / reconnect logic in the frontend.
    } catch {
      // Expected: server goes down during restart.
    }
  }, [token]);

  // ── Change password ────────────────────────────────────────────────────────

  const handleChangePw = useCallback(async () => {
    if (!token) return;
    if (!curPw || !newPw || !confirmPw) { setPwError('All fields required.'); return; }
    if (newPw !== confirmPw)            { setPwError('New passwords do not match.'); return; }
    if (newPw.length < 8)              { setPwError('Min. 8 characters.'); return; }
    setPwSaving(true);
    setPwError(null);
    setPwOk(false);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/auth/change`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ currentPassword: curPw, newPassword: newPw, confirm: confirmPw }),
      });
      if (res.ok) {
        setCurPw(''); setNewPw(''); setConfirmPw('');
        setPwOk(true);
        setTimeout(() => setPwOk(false), 3000);
      } else {
        const data = await res.json() as { error?: string };
        setPwError(data.error ?? 'Change failed.');
      }
    } catch {
      setPwError('Could not reach server.');
    } finally {
      setPwSaving(false);
    }
  }, [token, curPw, newPw, confirmPw]);

  // ── Access codes ───────────────────────────────────────────────────────────

  const loadCodes = useCallback(async (tok: string) => {
    setCodesLoading(true);
    setCodesError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/access-codes`, {
        headers: { 'Authorization': `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error('Failed to load codes');
      const data = await res.json() as { codes: AccessCode[] };
      setCodes(data.codes);
    } catch (err) {
      setCodesError((err as Error).message);
    } finally {
      setCodesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && tab === 'codes') loadCodes(token);
  }, [token, tab, loadCodes]);

  const handleGenerateCode = useCallback(async () => {
    if (!token) return;
    setCodeGenBusy(true);
    setCodesError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/access-codes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({
          code_type:        codeGenType,
          expires_in_hours: codeGenExpiry,
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setCodesError(d.error ?? 'Generate failed');
        return;
      }
      await loadCodes(token);
    } catch {
      setCodesError('Could not reach server.');
    } finally {
      setCodeGenBusy(false);
    }
  }, [token, codeGenType, codeGenExpiry, loadCodes]);

  const handleRevokeCode = useCallback(async (code: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/access-codes/${code}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        setCodes(prev => prev.map(c => c.code === code ? { ...c, consumed: true } : c));
      } else {
        const d = await res.json() as { error?: string };
        setCodesError(d.error ?? 'Revoke failed');
      }
    } catch {
      setCodesError('Could not reach server.');
    }
  }, [token]);

  const handleCopyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }, []);

  // ── Render: gate ───────────────────────────────────────────────────────────

  if (!statusLoaded) return null;

  if (!token) {
    return (
      <UserAuthGate
        passwordSet={adminStatus?.passwordSet ?? false}
        onAuth={handleAuth}
      />
    );
  }

  // ── Render: switching overlay ──────────────────────────────────────────────

  if (switching) {
    return (
      <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="bg-card border border-border rounded-lg p-8 flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-phobos-green animate-spin" />
          <p className="text-sm font-terminal tracking-wider text-phobos-green">
            SWITCHING TO {switchTarget?.toUpperCase()}…
          </p>
          <p className="text-xs text-muted-foreground">The app will reconnect automatically.</p>
        </div>
      </div>
    );
  }

  const activeUser = adminStatus?.activeUser ?? 'owner';

  const inputCls = 'w-full bg-background border border-border rounded px-3 py-2 text-sm ' +
                   'text-foreground focus:outline-none focus:border-phobos-green/60 transition-colors';
  const labelCls = 'block text-xs text-muted-foreground mb-1';

  // ── Render: panel ──────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 8950,
      width: 800, userSelect: 'none',
      filter: 'drop-shadow(0 12px 48px rgba(0,0,0,.85))',
    }}>
      <div style={{ width: 800, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
           className="phobos-panel bg-card border border-border rounded-sm overflow-hidden">

        {/* Header */}
        <div
          onMouseDown={onMouseDown}
          style={{ cursor: 'grab' }}
          className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0"
        >
          <div className="flex items-center gap-2" data-nodrag>
            <Users className="w-4 h-4 text-phobos-green/70" />
            <span className="text-sm font-terminal uppercase tracking-[0.15em] text-phobos-green">
              User Management
            </span>
            <span className="text-xs font-terminal text-muted-foreground/60 uppercase tracking-widest ml-1">
              {activeUser}
            </span>
          </div>
          <button
            onClick={() => setUserMgmtOpen(false)}
            className="p-1 hover:bg-accent rounded transition-colors"
            data-nodrag
          >
            <X className="w-4 h-4 text-foreground/60" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border/30 bg-black/30 shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-terminal uppercase tracking-widest transition-colors border-b-2 ${
                tab === t.id
                  ? 'text-phobos-green border-phobos-green bg-phobos-green/5'
                  : 'text-foreground/50 border-transparent hover:text-foreground/80'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4 min-h-0" data-nodrag>

          {/* Global error banner */}
          {error && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded bg-red-950/40 border border-red-800/40 text-red-400 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-auto hover:text-red-300">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* ── Users tab ─────────────────────────────────────────────────── */}
          {tab === 'users' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {users.length} user{users.length !== 1 ? 's' : ''} on this instance
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => token && loadUsers(token)}
                    disabled={loading}
                    className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-all"
                    title="Refresh"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={() => setAddOpen(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-terminal tracking-wider
                               bg-phobos-green/10 border border-phobos-green/30 text-phobos-green
                               hover:bg-phobos-green/20 hover:border-phobos-green/50 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add User
                  </button>
                </div>
              </div>

              {/* Add-user form */}
              {addOpen && (
                <div className="rounded border border-phobos-green/20 bg-phobos-green/5 p-4 space-y-3">
                  <p className="text-xs font-terminal tracking-wider text-phobos-green/80 uppercase">New User</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Username</label>
                      <input
                        type="text"
                        value={newUsername}
                        onChange={e => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                        placeholder="e.g. alice"
                        className={inputCls}
                      />
                      <p className="mt-0.5 text-[10px] text-muted-foreground/60">Lowercase, hyphens allowed</p>
                    </div>
                    <div>
                      <label className={labelCls}>Display name</label>
                      <input
                        type="text"
                        value={newDisplayName}
                        onChange={e => setNewDisplayName(e.target.value)}
                        placeholder="e.g. Alice"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div className="w-48">
                    <label className={labelCls}>Role</label>
                    <select
                      value={newRole}
                      onChange={e => setNewRole(e.target.value as UserRole)}
                      className={inputCls}
                    >
                      {ROLE_OPTIONS.map(r => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </div>
                  {addError && <p className="text-xs text-red-400">{addError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddUser}
                      disabled={addSubmitting || !newUsername || !newDisplayName}
                      className="px-4 py-1.5 rounded text-xs font-terminal tracking-wider
                                 bg-phobos-green/10 border border-phobos-green/30 text-phobos-green
                                 hover:bg-phobos-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                                 flex items-center gap-1.5"
                    >
                      {addSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                      Create
                    </button>
                    <button
                      onClick={() => { setAddOpen(false); setAddError(null); }}
                      className="px-4 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground border border-border hover:border-border/80 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* User table */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 text-phobos-green/50 animate-spin" />
                </div>
              ) : (
                <div className="rounded border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-black/40 text-muted-foreground font-terminal uppercase tracking-widest text-[10px]">
                        <th className="text-left px-3 py-2.5">Username</th>
                        <th className="text-left px-3 py-2.5">Display name</th>
                        <th className="text-left px-3 py-2.5">Role</th>
                        <th className="text-left px-3 py-2.5">Created</th>
                        <th className="text-left px-3 py-2.5">Last active</th>
                        <th className="px-3 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u, i) => (
                        <tr
                          key={u.username}
                          className={`border-t border-border/30 ${
                            u.username === activeUser ? 'bg-phobos-green/5' : i % 2 === 0 ? '' : 'bg-black/10'
                          }`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-terminal text-foreground/90">{u.username}</span>
                              {u.username === activeUser && (
                                <span className="text-[9px] font-terminal tracking-widest text-phobos-green bg-phobos-green/10 px-1 py-0.5 rounded-sm">
                                  ACTIVE
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-foreground/70">{u.display_name}</td>
                          <td className="px-3 py-2.5">
                            <select
                              value={u.role}
                              onChange={e => handleRoleChange(u.username, e.target.value as UserRole)}
                              disabled={u.username === 'owner' && users.filter(x => x.role === 'admin').length <= 1}
                              className="bg-background border border-border rounded px-2 py-1 text-xs text-foreground
                                         focus:outline-none focus:border-phobos-green/60 disabled:opacity-50
                                         disabled:cursor-not-allowed transition-colors"
                            >
                              {ROLE_OPTIONS.map(r => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(u.created_at)}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(u.last_active)}</td>
                          <td className="px-3 py-2.5">
                            {u.username !== 'owner' && (
                              <button
                                onClick={() => handleDelete(u.username)}
                                className="p-1 rounded text-muted-foreground/50 hover:text-red-400 hover:bg-red-950/30 transition-all"
                                title={`Delete ${u.username}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Role legend */}
              <div className="flex flex-wrap gap-4 pt-1">
                {ROLE_OPTIONS.map(r => (
                  <div key={r} className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                    <span className="font-terminal">{ROLE_LABELS[r]}:</span>
                    <span>
                      {r === 'admin'  && 'Full access + user management'}
                      {r === 'full'   && 'Full app, no management panel'}
                      {r === 'guest'  && 'Chat and game only'}
                      {r === 'read'   && 'Chat history read-only'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Switch tab ────────────────────────────────────────────────── */}
          {tab === 'switch' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Switching user writes the selection to disk and restarts the engine.
                The app reconnects automatically.
              </p>
              <div className="rounded border border-border overflow-hidden">
                {users.map((u, i) => (
                  <div
                    key={u.username}
                    className={`flex items-center justify-between px-4 py-3 border-b border-border/30 last:border-0 ${
                      u.username === activeUser ? 'bg-phobos-green/5' : i % 2 === 0 ? '' : 'bg-black/10'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${u.username === activeUser ? 'bg-phobos-green' : 'bg-border'}`} />
                      <div>
                        <p className="text-sm font-terminal text-foreground/90">{u.username}</p>
                        <p className="text-[10px] text-muted-foreground">{u.display_name} · {ROLE_LABELS[u.role]}</p>
                      </div>
                    </div>
                    {u.username !== activeUser ? (
                      <button
                        onClick={() => handleSwitch(u.username)}
                        className="px-3 py-1.5 rounded text-xs font-terminal tracking-wider
                                   border border-phobos-green/30 text-phobos-green/80
                                   hover:bg-phobos-green/10 hover:border-phobos-green/50 transition-all"
                      >
                        Switch
                      </button>
                    ) : (
                      <span className="text-[10px] font-terminal tracking-widest text-phobos-green">ACTIVE</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Codes tab ─────────────────────────────────────────────────── */}
          {tab === 'codes' && (() => {
            const activeCodes   = codes.filter(c => !c.consumed);
            const consumedCodes = codes.filter(c =>  c.consumed);
            return (
              <div className="space-y-4">
                {codesError && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded bg-red-950/40 border border-red-800/40 text-red-400 text-xs">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{codesError}</span>
                    <button onClick={() => setCodesError(null)} className="ml-auto hover:text-red-300">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* Generate form */}
                <div className="rounded border border-phobos-green/20 bg-phobos-green/5 p-4 space-y-3">
                  <p className="text-xs font-terminal tracking-wider text-phobos-green/80 uppercase">Generate Access Code</p>
                  <div className="flex flex-wrap gap-4 items-end">
                    <div>
                      <label className={labelCls}>Type</label>
                      <select
                        value={codeGenType}
                        onChange={e => setCodeGenType(e.target.value as 'guest' | 'self')}
                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-phobos-green/60 transition-colors"
                      >
                        <option value="guest">Guest — provisioned account</option>
                        <option value="self">Self — your own remote session</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Expires in</label>
                      <select
                        value={codeGenExpiry}
                        onChange={e => setCodeGenExpiry(Number(e.target.value))}
                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-phobos-green/60 transition-colors"
                      >
                        <option value={1}>1 hour</option>
                        <option value={24}>24 hours</option>
                        <option value={72}>3 days</option>
                        <option value={168}>7 days</option>
                        <option value={87600}>No expiry</option>
                      </select>
                    </div>
                    <button
                      onClick={handleGenerateCode}
                      disabled={codeGenBusy}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-terminal tracking-wider
                                 bg-phobos-green/10 border border-phobos-green/30 text-phobos-green
                                 hover:bg-phobos-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {codeGenBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                      Generate
                    </button>
                    <button
                      onClick={() => token && loadCodes(token)}
                      disabled={codesLoading}
                      className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground transition-all"
                      title="Refresh"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${codesLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60">
                    Share this code with the person connecting. They enter it in the PHOBOS mobile app.
                  </p>
                </div>

                {/* Active codes */}
                {codesLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-5 h-5 text-phobos-green/50 animate-spin" />
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-[10px] font-terminal tracking-widest text-muted-foreground/60 uppercase mb-2">
                        Active — {activeCodes.length}
                      </p>
                      {activeCodes.length === 0 ? (
                        <p className="text-xs text-muted-foreground/50 py-3">No active codes.</p>
                      ) : (
                        <div className="rounded border border-border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-black/40 text-muted-foreground font-terminal uppercase tracking-widest text-[10px]">
                                <th className="text-left px-3 py-2.5">Code</th>
                                <th className="text-left px-3 py-2.5">Type</th>
                                <th className="text-left px-3 py-2.5">Bound to</th>
                                <th className="text-left px-3 py-2.5">Expires</th>
                                <th className="px-3 py-2.5" />
                              </tr>
                            </thead>
                            <tbody>
                              {activeCodes.map((c, i) => (
                                <tr key={c.code} className={`border-t border-border/30 ${i % 2 === 0 ? '' : 'bg-black/10'}`}>
                                  <td className="px-3 py-2.5">
                                    <div className="flex items-center gap-2">
                                      <span className="font-terminal text-phobos-green tracking-[0.05em] text-[10px] break-all max-w-[220px]">
                                        {c.encoded_code ?? c.code}
                                      </span>
                                      <button
                                        onClick={() => handleCopyCode(c.encoded_code ?? c.code)}
                                        className="text-muted-foreground/50 hover:text-phobos-green transition-colors flex-shrink-0"
                                        title="Copy code"
                                      >
                                        {copiedCode === (c.encoded_code ?? c.code)
                                          ? <CheckCircle2 className="w-3 h-3 text-phobos-green" />
                                          : <Copy className="w-3 h-3" />}
                                      </button>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-muted-foreground capitalize">{c.code_type}</td>
                                  <td className="px-3 py-2.5 text-muted-foreground font-terminal">
                                    {c.target_username ?? <span className="text-muted-foreground/40">unbound</span>}
                                  </td>
                                  <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(c.expires_at)}</td>
                                  <td className="px-3 py-2.5">
                                    <button
                                      onClick={() => handleRevokeCode(c.code)}
                                      className="px-2 py-1 rounded text-[10px] font-terminal tracking-wider
                                                 text-muted-foreground/60 hover:text-red-400 hover:bg-red-950/30
                                                 border border-transparent hover:border-red-800/30 transition-all"
                                    >
                                      Revoke
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Consumed codes — collapsed summary */}
                    {consumedCodes.length > 0 && (
                      <p className="text-[10px] text-muted-foreground/40 font-terminal">
                        + {consumedCodes.length} consumed / expired code{consumedCodes.length !== 1 ? 's' : ''} (hidden)
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* ── Settings tab ──────────────────────────────────────────────── */}
          {tab === 'settings' && (
            <div className="space-y-5 max-w-sm">
              <div>
                <p className="text-xs font-terminal tracking-wider text-foreground/70 uppercase mb-3">
                  Change Management Password
                </p>
                <div className="space-y-3">
                  <div>
                    <label className={labelCls}>Current password</label>
                    <input
                      type="password"
                      value={curPw}
                      onChange={e => setCurPw(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>New password</label>
                    <input
                      type="password"
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      placeholder="Min. 8 characters"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Confirm new password</label>
                    <input
                      type="password"
                      value={confirmPw}
                      onChange={e => setConfirmPw(e.target.value)}
                      className={inputCls}
                    />
                  </div>

                  {pwError && <p className="text-xs text-red-400">{pwError}</p>}
                  {pwOk    && (
                    <div className="flex items-center gap-1.5 text-xs text-phobos-green">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Password changed.
                    </div>
                  )}

                  <button
                    onClick={handleChangePw}
                    disabled={pwSaving || !curPw || !newPw || !confirmPw}
                    className="px-4 py-2 rounded text-xs font-terminal tracking-wider
                               bg-phobos-green/10 border border-phobos-green/30 text-phobos-green
                               hover:bg-phobos-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                               flex items-center gap-1.5"
                  >
                    {pwSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                    Update Password
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-border/30">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
                  <Lock className="w-3 h-3" />
                  <span>Session expires after 30 minutes of inactivity.</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}