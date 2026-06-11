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
import { useQueryClient } from '@tanstack/react-query';
import {
  Users, X, Plus, Trash2, RefreshCw, Loader2, CheckCircle2,
  Lock, AlertTriangle, Copy, Key, QrCode, FolderOpen,
} from 'lucide-react';
import { useAppStore }   from '@/store/useAppStore';
import { UserAuthGate }  from './UserAuthGate';
import { QRCode }        from './QRCode';

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

// admin is intentionally excluded — cannot be assigned from the panel.
const ROLE_OPTIONS: UserRole[] = ['full', 'guest', 'read'];

// TABS is built dynamically inside the component based on currentRole.

// ── Deprovision types ─────────────────────────────────────────────────────────

interface DeprovisionInventory {
  plugins:    Array<{ pluginId: string; name: string }>;
  cartridges: Array<{ cartridgeId: string; name: string }>;
  hasWeclone: boolean;
  hasAssets:  boolean;
}

interface DeprovisionDialog {
  username:    string;
  inventory:   DeprovisionInventory;
  loading:     false;
}

interface DeprovisionDialogLoading {
  username:  string;
  loading:   true;
}

type DeprovisionState = DeprovisionDialog | DeprovisionDialogLoading | null;

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
  const currentRole     = useAppStore(s => s.activeUserRole);
  const queryClient     = useQueryClient();

  const isAdmin = currentRole === 'admin';
  const isFull  = currentRole === 'full';
  const isGuest = currentRole === 'guest' || currentRole === 'read';

  const TABS: { id: Tab; label: string }[] = [
    ...(isAdmin || isFull ? [{ id: 'users'    as Tab, label: 'Users'    }] : []),
    ...(isAdmin            ? [{ id: 'switch'   as Tab, label: 'Switch'   }] : []),
    { id: 'codes' as Tab, label: 'Codes' },
    ...(isAdmin || isFull ? [{ id: 'settings' as Tab, label: 'Settings' }] : []),
  ];

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
  const [tab, setTab] = useState<Tab>(() =>
    (currentRole === 'guest' || currentRole === 'read') ? 'codes' : 'users'
  );
  const [users,   setUsers]   = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // ── Add-user form ──────────────────────────────────────────────────────────
  const [addOpen,        setAddOpen]        = useState(false);
  const [newUsername,    setNewUsername]     = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole,        setNewRole]        = useState<UserRole>('full');
  const [newPassword,    setNewPassword]    = useState('');
  const [newConfirmPw,   setNewConfirmPw]   = useState('');
  const [addError,       setAddError]       = useState<string | null>(null);
  const [addSubmitting,  setAddSubmitting]  = useState(false);

  // ── Switch-user state ──────────────────────────────────────────────────────
  const [switching,     setSwitching]     = useState(false);
  const [switchTarget,  setSwitchTarget]  = useState<string | null>(null);

  // ── Deprovision dialog state ───────────────────────────────────────────────
  const [deprovision,    setDeprovision]    = useState<DeprovisionState>(null);
  const [lostAndFound,   setLostAndFound]   = useState<{ path: string; username: string } | null>(null);

  // ── Access codes state ─────────────────────────────────────────────────────
  const [codes,          setCodes]          = useState<AccessCode[]>([]);
  const [codesLoading,   setCodesLoading]   = useState(false);
  const [codesError,     setCodesError]     = useState<string | null>(null);
  const [codeGenType,    setCodeGenType]    = useState<'guest' | 'self'>('guest');
  const [codeGenExpiry,  setCodeGenExpiry]  = useState(72);
  const [codeGenBusy,    setCodeGenBusy]    = useState(false);
  const [copiedCode,     setCopiedCode]     = useState<string | null>(null);
  const [qrCode,         setQrCode]         = useState<string | null>(null);

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

  const handleAuth = useCallback((tok: string, _role: string) => {
    setToken(tok);
    // Re-fetch status to get fresh activeUser
    fetch(`${ENGINE_URL}/api/admin/status`)
      .then(r => r.json())
      .then((data: AdminStatus) => setAdminStatus(data))
      .catch(() => {});
  }, []);

  // ── Add user ───────────────────────────────────────────────────────────────

  const handleAddUser = useCallback(async () => {
    if (!token || !newUsername || !newDisplayName || !newPassword) return;
    if (newPassword.length < 8) { setAddError('Password must be at least 8 characters.'); return; }
    if (newPassword !== newConfirmPw) { setAddError('Passwords do not match.'); return; }
    setAddSubmitting(true);
    setAddError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({
          username:     newUsername,
          display_name: newDisplayName,
          role:         newRole,
          password:     newPassword,
        }),
      });
      const data = await res.json() as { error?: string; user?: UserRecord };
      if (!res.ok) { setAddError(data.error ?? 'Failed to create user'); return; }
      setUsers(prev => [...prev, data.user!]);
      setAddOpen(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewRole('full');
      setNewPassword('');
      setNewConfirmPw('');
    } catch {
      setAddError('Could not reach server.');
    } finally {
      setAddSubmitting(false);
    }
  }, [token, newUsername, newDisplayName, newRole, newPassword, newConfirmPw]);

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

  // ── Delete user — phase 1: load inventory ─────────────────────────────────

  const handleDeleteClick = useCallback(async (username: string) => {
    if (!token) return;
    // Show loading state immediately so the button gives feedback.
    setDeprovision({ username, loading: true });
    try {
      const res = await fetch(
        `${ENGINE_URL}/api/admin/users/${username}/deprovision-inventory`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setDeprovision(null);
        setError(data.error ?? 'Could not load user inventory');
        return;
      }
      const data = await res.json() as { inventory: DeprovisionInventory };
      setDeprovision({ username, inventory: data.inventory, loading: false });
    } catch {
      setDeprovision(null);
      setError('Could not reach server.');
    }
  }, [token]);

  // ── Delete user — phase 2: confirm and execute ─────────────────────────────

  const handleDeleteConfirm = useCallback(async (preserveAll: boolean) => {
    if (!token || !deprovision || deprovision.loading) return;
    const { username } = deprovision;
    setDeprovision(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/users/${username}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ preserveAll }),
      });
      const data = await res.json() as {
        ok?: boolean;
        error?: string;
        lostAndFoundPath?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(data.error ?? 'Delete failed');
        return;
      }
      setUsers(prev => prev.filter(u => u.username !== username));
      if (data.lostAndFoundPath) {
        setLostAndFound({ path: data.lostAndFoundPath, username });
      }
    } catch {
      setError('Could not reach server.');
    }
  }, [token, deprovision]);

  // ── Switch user ────────────────────────────────────────────────────────────

  const handleSwitch = useCallback(async (username: string) => {
    if (!token) return;
    setSwitching(true);
    setSwitchTarget(username);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/switch-user`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ username }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setError(d.error ?? 'Switch failed');
        setSwitching(false);
        setSwitchTarget(null);
        return;
      }
      // Poll /api/admin/status until activeUser matches, then close the overlay.
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${ENGINE_URL}/api/admin/status`).then(r => r.json()) as AdminStatus;
          if (s.activeUser === username) {
            clearInterval(poll);
            setAdminStatus(s);

            // Flush all React Query caches — threads, messages, status, config
            // etc. were fetched for the previous user. Invalidating causes every
            // mounted query to refetch against the new active user's DB.
            queryClient.invalidateQueries();

            // Reset user-scoped store slices so stale data never bleeds through
            // while the refetch is in flight.
            useAppStore.setState({
              threads:        [],
              activeThreadId: '',
              messages:       {},
              segments:       {},
              workspaceIndex: {},
              mediaFiles:     {},
              taskProgress:   null,
              liveActivity:   null,
            });

            setSwitching(false);
            setSwitchTarget(null);
            setUserMgmtOpen(false); // close panel — switch complete, no re-auth needed
          }
        } catch { /* keep polling */ }
      }, 500);
      // Safety timeout — stop polling after 10s regardless.
      setTimeout(() => {
        clearInterval(poll);
        setSwitching(false);
        setSwitchTarget(null);
      }, 10_000);
    } catch {
      setError('Could not reach server.');
      setSwitching(false);
      setSwitchTarget(null);
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
    setCodeGenBusy(true);
    setCodesError(null);
    try {
      // Guests and full users use the tokenless /api/user/invite endpoint.
      // Admin uses the panel-authenticated /api/admin/access-codes endpoint.
      const endpoint = isAdmin
        ? `${ENGINE_URL}/api/admin/access-codes`
        : `${ENGINE_URL}/api/user/invite`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isAdmin && token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(endpoint, {
        method:  'POST',
        headers,
        body:    JSON.stringify({
          code_type:        isGuest ? 'self' : codeGenType,
          expires_in_hours: codeGenExpiry,
        }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setCodesError(d.error ?? 'Generate failed');
        return;
      }
      const d = await res.json() as { code: AccessCode };
      setCodes(prev => [d.code, ...prev]);
    } catch {
      setCodesError('Could not reach server.');
    } finally {
      setCodeGenBusy(false);
    }
  }, [token, isAdmin, isGuest, codeGenType, codeGenExpiry]);

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

  // Guests and read-only users bypass the admin password gate — they only
  // access the Codes tab which uses the tokenless POST /api/user/invite endpoint.
  if (!token && !isGuest) {
    const activeUser = adminStatus?.activeUser ?? 'owner';
    return (
      <UserAuthGate
        username={activeUser}
        passwordSet={adminStatus?.passwordSet ?? false}
        onAuth={handleAuth}
      />
    );
  }

  // ── Render: switching overlay ──────────────────────────────────────────────

  if (switching) {
    return (
      <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-phob-void/92 backdrop-blur-sm">
        <div className="bg-[#0f0f0a] border border-phob-teal/30 phob-corners phob-corners-full  p-8 flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-phob-teal animate-spin" />
          <p className="text-sm font-terminal tracking-wider text-phob-teal">
            SWITCHING TO {switchTarget?.toUpperCase()}…
          </p>
          <p className="text-xs text-phob-steel/60">The app will reconnect automatically.</p>
        </div>
      </div>
    );
  }

  const activeUser = adminStatus?.activeUser ?? 'owner';

  const inputCls = 'w-full bg-phob-white/4 border border-phob-teal/20 px-3 py-2 text-sm text-phob-white ' +
                   'text-foreground focus:outline-none focus:border-phob-teal/60 transition-colors';
  const labelCls = 'block text-[9px] font-terminal text-phob-teal/50 uppercase tracking-[0.12em] mb-1';

  // ── Render: panel ──────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 8950,
      width: 800, userSelect: 'none',
      filter: 'drop-shadow(0 12px 48px rgba(0,0,0,.85))',
    }}>
      <div style={{ width: 800, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
           className="phobos-panel bg-[#0f0f0a] border border-phob-teal/30 phob-corners phob-corners-full  overflow-hidden">

        {/* Header */}
        <div
          onMouseDown={onMouseDown}
          style={{ cursor: 'grab' }}
          className="phob-chrome-zone phob-header h-10 flex items-center justify-between px-3 border-b border-phob-teal/25 bg-[#080808] shrink-0"
        >
          <div className="flex items-center gap-2" data-nodrag>
            <Users className="w-4 h-4 text-phob-teal/70" />
            <span className="text-sm font-terminal uppercase tracking-[0.15em] text-phob-teal">
              User Management
            </span>
            <span className="text-xs font-terminal text-phob-steel/50 uppercase tracking-widest ml-1">
              {activeUser}
            </span>
          </div>
          <button
            onClick={() => setUserMgmtOpen(false)}
            className="p-1 hover:bg-phob-teal/8 transition-colors"
            data-nodrag
          >
            <X className="w-4 h-4 text-phob-steel/50" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-phob-teal/20 bg-phob-white/4 shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-terminal uppercase tracking-widest transition-colors border-b-2 ${
                tab === t.id
                  ? 'text-phob-teal border-phob-teal bg-phob-teal/5'
                  : 'text-phob-steel/50 border-transparent hover:text-phob-white/80'
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
            <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded bg-phob-red/8 border border-phob-red/30 text-phob-red text-xs">
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
                <p className="text-xs text-phob-steel/50">
                  {users.length} user{users.length !== 1 ? 's' : ''} on this instance
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => token && loadUsers(token)}
                    disabled={loading}
                    className="p-1.5 border border-phob-teal/20 text-phob-steel/50 hover:text-phob-white hover:border-phob-teal/35 transition-all"
                    title="Refresh"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={() => setAddOpen(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-terminal tracking-wider
                               bg-phob-teal/10 border border-phob-teal/30 text-phob-teal
                               hover:bg-phob-teal/20 hover:border-phob-teal/50 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add User
                  </button>
                </div>
              </div>

              {/* Add-user form */}
              {addOpen && (
                <div className="rounded border border-phob-teal/20 bg-phob-teal/5 p-4 space-y-3">
                  <p className="text-xs font-terminal tracking-wider text-phob-teal/80 uppercase">New User</p>
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
                      <p className="mt-0.5 text-[10px] text-phob-steel/50">Lowercase, hyphens allowed</p>
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
                  {addError && <p className="text-xs text-phob-red">{addError}</p>}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Password</label>
                      <input
                        type="password"
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        className={inputCls}
                      />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Confirm password</label>
                      <input
                        type="password"
                        value={newConfirmPw}
                        onChange={e => setNewConfirmPw(e.target.value)}
                        placeholder="Repeat password"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddUser}
                      disabled={addSubmitting || !newUsername || !newDisplayName || !newPassword || !newConfirmPw}
                      className="px-4 py-1.5 rounded text-xs font-terminal tracking-wider
                                 bg-phob-teal/10 border border-phob-teal/30 text-phob-teal
                                 hover:bg-phob-teal/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                                 flex items-center gap-1.5"
                    >
                      {addSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                      Create
                    </button>
                    <button
                      onClick={() => { setAddOpen(false); setAddError(null); }}
                      className="px-4 py-1.5 text-xs text-phob-steel/50 hover:text-phob-white border border-phob-teal/15 hover:border-phob-teal/30 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* User table */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 text-phob-teal/50 animate-spin" />
                </div>
              ) : (
                <div className="rounded border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-phob-white/4 text-phob-teal/50 font-terminal uppercase tracking-widest text-[10px]">
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
                          className={`border-t border-phob-teal/20 ${
                            u.username === activeUser ? 'bg-phob-teal/5' : i % 2 === 0 ? '' : 'bg-black/10'
                          }`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-terminal text-phob-white/90">{u.username}</span>
                              {u.username === activeUser && (
                                <span className="text-[9px] font-terminal tracking-widest text-phob-teal bg-phob-teal/10 px-1 py-0.5 ">
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
                                         focus:outline-none focus:border-phob-teal/60 disabled:opacity-50
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
                            {(isAdmin || (isFull && (u.role === 'guest' || u.role === 'read'))) && u.username !== 'owner' && (
                              <button
                                onClick={() => handleDeleteClick(u.username)}
                                className="p-1 rounded text-muted-foreground/50 hover:text-phob-red hover:bg-red-950/30 transition-all"
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
              <p className="text-xs text-phob-steel/50">
                Switching user reinitialises the active session in-process.
                The app will reflect the new user immediately.
              </p>
              <div className="rounded border border-border overflow-hidden">
                {users.map((u, i) => (
                  <div
                    key={u.username}
                    className={`flex items-center justify-between px-4 py-3 border-b border-phob-teal/20 last:border-0 ${
                      u.username === activeUser ? 'bg-phob-teal/5' : i % 2 === 0 ? '' : 'bg-black/10'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${u.username === activeUser ? 'bg-phob-teal' : 'bg-border'}`} />
                      <div>
                        <p className="text-sm font-terminal text-phob-white/90">{u.username}</p>
                        <p className="text-[10px] text-muted-foreground">{u.display_name} · {ROLE_LABELS[u.role]}</p>
                      </div>
                    </div>
                    {u.username !== activeUser ? (
                      <button
                        onClick={() => handleSwitch(u.username)}
                        className="px-3 py-1.5 rounded text-xs font-terminal tracking-wider
                                   border border-phob-teal/30 text-phob-teal/80
                                   hover:bg-phob-teal/10 hover:border-phob-teal/50 transition-all"
                      >
                        Switch
                      </button>
                    ) : (
                      <span className="text-[10px] font-terminal tracking-widest text-phob-teal">ACTIVE</span>
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
                  <div className="flex items-center gap-2 px-3 py-2 rounded bg-phob-red/8 border border-phob-red/30 text-phob-red text-xs">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{codesError}</span>
                    <button onClick={() => setCodesError(null)} className="ml-auto hover:text-red-300">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* Generate form */}
                <div className="rounded border border-phob-teal/20 bg-phob-teal/5 p-4 space-y-3">
                  <p className="text-xs font-terminal tracking-wider text-phob-teal/80 uppercase">Generate Access Code</p>
                  <div className="flex flex-wrap gap-4 items-end">
                    {/* Type selector — guests are locked to self; full users can only do guest */}
                    {!isGuest && (
                      <div>
                        <label className={labelCls}>Type</label>
                        <select
                          value={isGuest ? 'self' : codeGenType}
                          onChange={e => setCodeGenType(e.target.value as 'guest' | 'self')}
                          disabled={isGuest}
                          className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-phob-teal/60 transition-colors"
                        >
                          {isAdmin && <option value="guest">Guest — provisioned account</option>}
                          {isAdmin && <option value="self">Self — your own remote session</option>}
                          {isFull  && <option value="guest">Guest — provisioned account</option>}
                        </select>
                      </div>
                    )}
                    {isGuest && (
                      <div>
                        <label className={labelCls}>Type</label>
                        <p className="text-xs text-phob-white/60 py-1.5">Self — remote session</p>
                      </div>
                    )}
                    <div>
                      <label className={labelCls}>Expires in</label>
                      <select
                        value={codeGenExpiry}
                        onChange={e => setCodeGenExpiry(Number(e.target.value))}
                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-phob-teal/60 transition-colors"
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
                                 bg-phob-teal/10 border border-phob-teal/30 text-phob-teal
                                 hover:bg-phob-teal/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {codeGenBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                      Generate
                    </button>
                    {!isGuest && token && (
                      <button
                        onClick={() => token && loadCodes(token)}
                        disabled={codesLoading}
                        className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground transition-all"
                        title="Refresh"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${codesLoading ? 'animate-spin' : ''}`} />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-phob-steel/50">
                    {isGuest
                      ? 'Generate a code to connect to your own account from another device.'
                      : 'Share this code with the person connecting. They enter it in the PHOBOS mobile app.'}
                  </p>
                </div>

                {/* Active codes */}
                {codesLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-5 h-5 text-phob-teal/50 animate-spin" />
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-[10px] font-terminal tracking-widest text-phob-steel/50 uppercase mb-2">
                        Active — {activeCodes.length}
                      </p>
                      {activeCodes.length === 0 ? (
                        <p className="text-xs text-muted-foreground/50 py-3">No active codes.</p>
                      ) : (
                        <div className="rounded border border-border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-phob-white/4 text-phob-teal/50 font-terminal uppercase tracking-widest text-[10px]">
                                <th className="text-left px-3 py-2.5">Code</th>
                                <th className="text-left px-3 py-2.5">Type</th>
                                <th className="text-left px-3 py-2.5">Bound to</th>
                                <th className="text-left px-3 py-2.5">Expires</th>
                                <th className="px-3 py-2.5" />
                              </tr>
                            </thead>
                            <tbody>
                              {activeCodes.map((c, i) => (
                                <tr key={c.code} className={`border-t border-phob-teal/20 ${i % 2 === 0 ? '' : 'bg-black/10'}`}>
                                  <td className="px-3 py-2.5">
                                    <div className="flex items-center gap-2">
                                      <span className="font-terminal text-phob-teal tracking-[0.05em] text-[10px] break-all max-w-[180px]">
                                        {c.encoded_code ?? c.code}
                                      </span>
                                      <button
                                        onClick={() => handleCopyCode(c.encoded_code ?? c.code)}
                                        className="text-muted-foreground/50 hover:text-phob-teal transition-colors flex-shrink-0"
                                        title="Copy code"
                                      >
                                        {copiedCode === (c.encoded_code ?? c.code)
                                          ? <CheckCircle2 className="w-3 h-3 text-phob-teal" />
                                          : <Copy className="w-3 h-3" />}
                                      </button>
                                      <button
                                        onClick={() => setQrCode(q => q === (c.encoded_code ?? c.code) ? null : (c.encoded_code ?? c.code))}
                                        className="text-muted-foreground/50 hover:text-phob-teal transition-colors flex-shrink-0"
                                        title="Show QR code"
                                      >
                                        <QrCode className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5 text-muted-foreground capitalize">{c.code_type}</td>
                                  <td className="px-3 py-2.5 text-muted-foreground font-terminal">
                                    {c.target_username ?? <span className="text-phob-steel/40">unbound</span>}
                                  </td>
                                  <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(c.expires_at)}</td>
                                  <td className="px-3 py-2.5">
                                    <button
                                      onClick={() => handleRevokeCode(c.code)}
                                      className="px-2 py-1 rounded text-[10px] font-terminal tracking-wider
                                                 text-phob-steel/50 hover:text-phob-red hover:bg-red-950/30
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
                      <p className="text-[10px] text-phob-steel/40 font-terminal">
                        + {consumedCodes.length} consumed / expired code{consumedCodes.length !== 1 ? 's' : ''} (hidden)
                      </p>
                    )}
                  </>
                )}

                {/* QR code panel — inline below the table */}
                {qrCode && (
                  <div className="rounded border border-phob-teal/30 bg-phob-white/6 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[10px] font-terminal tracking-widest text-phob-teal/80 uppercase">
                        Scan to connect · PHOBOS Mobile
                      </p>
                      <button
                        onClick={() => setQrCode(null)}
                        className="text-muted-foreground/50 hover:text-foreground transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-col items-center gap-3">
                      <div className="p-3 bg-white rounded">
                        <QRCode
                          value={qrCode}
                          size={220}
                          fgColor="#000000"
                          bgColor="#ffffff"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/50 text-center max-w-[260px] leading-relaxed">
                        Open PHOBOS Mobile → Add Server → point the camera here, or paste the code manually.
                      </p>
                    </div>
                  </div>
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

                  {pwError && <p className="text-xs text-phob-red">{pwError}</p>}
                  {pwOk    && (
                    <div className="flex items-center gap-1.5 text-xs text-phob-teal">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Password changed.
                    </div>
                  )}

                  <button
                    onClick={handleChangePw}
                    disabled={pwSaving || !curPw || !newPw || !confirmPw}
                    className="px-4 py-2 rounded text-xs font-terminal tracking-wider
                               bg-phob-teal/10 border border-phob-teal/30 text-phob-teal
                               hover:bg-phob-teal/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all
                               flex items-center gap-1.5"
                  >
                    {pwSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                    Update Password
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-phob-teal/20">
                <div className="flex items-center gap-2 text-[10px] text-phob-steel/50">
                  <Lock className="w-3 h-3" />
                  <span>Session expires after 30 minutes of inactivity.</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Deprovision dialog ─────────────────────────────────────────────── */}
      {deprovision && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-phob-void/80 backdrop-blur-sm">
          <div className="w-[440px] bg-card border border-phob-red/30 shadow-2xl p-5 space-y-4">

            {deprovision.loading ? (
              <div className="flex items-center gap-3 py-4">
                <Loader2 className="w-4 h-4 text-phob-steel/40 animate-spin" />
                <span className="text-[11px] font-mono text-phob-steel/50">Loading user inventory…</span>
              </div>
            ) : (() => {
              const loaded = deprovision as { username: string; inventory: DeprovisionInventory; loading: false };
              return (
                <>
                  <div>
                    <p className="text-xs font-terminal text-phob-red/80 mb-1">
                      Delete user <span className="text-phob-red">'{loaded.username}'</span>?
                    </p>
                    <p className="text-[10px] font-mono text-phob-steel/50 leading-relaxed">
                      Their account, service access, and media directories will be removed.
                    </p>
                  </div>

                  {/* Inventory summary */}
                  {loaded.inventory.hasAssets && (
                    <div className="bg-phob-amber/5 border border-phob-amber/20 p-3 space-y-1.5">
                      <p className="text-[9px] font-terminal uppercase tracking-widest text-phob-amber/60 mb-2">
                        Protected assets — always moved to Lost &amp; Found
                      </p>
                      {loaded.inventory.plugins.length > 0 && (
                        <p className="text-[10px] font-mono text-phob-steel/60">
                          {loaded.inventory.plugins.length} plugin{loaded.inventory.plugins.length > 1 ? 's' : ''}{' '}
                          <span className="text-phob-steel/35">({loaded.inventory.plugins.map(p => p.name).join(', ')})</span>
                        </p>
                      )}
                      {loaded.inventory.cartridges.length > 0 && (
                        <p className="text-[10px] font-mono text-phob-steel/60">
                          {loaded.inventory.cartridges.length} cartridge{loaded.inventory.cartridges.length > 1 ? 's' : ''}{' '}
                          <span className="text-phob-steel/35">({loaded.inventory.cartridges.map(c => c.name).join(', ')})</span>
                        </p>
                      )}
                      {loaded.inventory.hasWeclone && (
                        <p className="text-[10px] font-mono text-phob-steel/60">Weclone profile + voice data</p>
                      )}
                    </div>
                  )}

                  {/* Preservation choice */}
                  <div className="space-y-2">
                    <p className="text-[9px] font-terminal uppercase tracking-widest text-phob-steel/40">
                      Personal data (workspaces, media library)
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => handleDeleteConfirm(true)}
                        className="flex flex-col items-start px-3 py-2.5 border border-phob-amber/25 bg-phob-amber/5 hover:border-phob-amber/50 transition-all text-left"
                      >
                        <span className="text-[9px] font-terminal text-phob-amber/80 uppercase tracking-widest">Preserve all</span>
                        <span className="text-[9px] font-mono text-phob-steel/40 mt-0.5 leading-relaxed">
                          Move workspaces &amp; library to Lost &amp; Found
                        </span>
                      </button>
                      <button
                        onClick={() => handleDeleteConfirm(false)}
                        className="flex flex-col items-start px-3 py-2.5 border border-phob-red/20 hover:border-phob-red/40 transition-all text-left"
                      >
                        <span className="text-[9px] font-terminal text-phob-red/70 uppercase tracking-widest">Delete data</span>
                        <span className="text-[9px] font-mono text-phob-steel/40 mt-0.5 leading-relaxed">
                          Permanently delete workspaces &amp; library
                        </span>
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => setDeprovision(null)}
                    className="text-[9px] font-terminal uppercase tracking-widest text-phob-steel/35 hover:text-phob-steel/60 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Lost & Found banner ────────────────────────────────────────────── */}
      {lostAndFound && (
        <div className="fixed bottom-4 right-4 z-[60] w-[380px] bg-card border border-phob-amber/30 shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <FolderOpen className="w-4 h-4 text-phob-amber/60 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-terminal text-phob-amber/80 mb-0.5">
                Protected data preserved
              </p>
              <p className="text-[9px] font-mono text-phob-steel/50 leading-relaxed mb-2">
                Collect your protected user data here:
              </p>
              <p className="text-[9px] font-mono text-phob-amber/50 break-all leading-relaxed">
                {lostAndFound.path}
              </p>
            </div>
            <button
              onClick={() => setLostAndFound(null)}
              className="shrink-0 p-0.5 text-phob-steel/30 hover:text-phob-steel/60 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}