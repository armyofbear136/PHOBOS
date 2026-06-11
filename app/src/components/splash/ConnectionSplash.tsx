import { useState, useEffect, useRef } from 'react';
import { Download } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { CLIENT_VERSION } from '@/version';
import { useAppStore } from '@/store/useAppStore';

export type Platform = 'windows' | 'macos' | 'linux' | 'linux-arm64';

export async function detectPlatform(): Promise<Platform> {
  const ua = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();
  if (ua.includes('win') || platform.includes('win')) return 'windows';
  if (ua.includes('mac') || platform.includes('mac') || ua.includes('darwin')) return 'macos';
  try {
    type UADataAPI = { getHighEntropyValues: (hints: string[]) => Promise<{ architecture?: string }> };
    const uaData = (navigator as Navigator & { userAgentData?: UADataAPI }).userAgentData;
    if (uaData) {
      const { architecture } = await uaData.getHighEntropyValues(['architecture']);
      if (architecture === 'arm' || architecture === 'arm64') return 'linux-arm64';
    }
  } catch { /* UA-CH not supported */ }
  if (ua.includes('aarch64') || ua.includes('armv')) return 'linux-arm64';
  return 'linux';
}

const RELEASE_BASE = 'https://github.com/armyofbear136/PHOBOS-LAUNCHER-CROSS-PLATFORM/releases/download/PHOBOS-LAUNCHER-STABLE-RELEASES';
const ENGINE_URL   = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const PLATFORM_CONFIG: Record<Platform, { label: string; file: string }> = {
  windows:       { label: 'Download for Windows',    file: 'PHOBOS-Launcher-win-x64-Setup.exe' },
  macos:         { label: 'Download for macOS',       file: 'PHOBOS-Launcher-macOS-arm64.dmg' },
  linux:         { label: 'Download for Linux x64',   file: 'PHOBOS-Launcher-linux-x64.AppImage' },
  'linux-arm64': { label: 'Download for Linux ARM64', file: 'PHOBOS-Launcher-linux-arm64.AppImage' },
};

// ── Boot state from /api/boot/events ─────────────────────────────────────────

type BootPhase = 'awaiting_setup' | 'prep_deps' | 'db_init' | 'core_init' | 'services_wait' | 'ready';

type ServiceReadyState = 'waiting' | 'ready' | 'failed';

interface ServiceStatus {
  name:  string;
  state: ServiceReadyState;
}

interface BootState {
  phase:    BootPhase;
  error:    string | null;
  progress: {
    dep?:          string;
    file?:         string;
    bytes?:        number;
    total?:        number;
    pct?:          number;
    depsTotal?:    number;
    depsDone?:     number;
    services?:     ServiceStatus[];
    waitDeadline?: number;
  };
}

// ── Phase label map ───────────────────────────────────────────────────────────

const PHASE_LABEL: Record<BootPhase, string> = {
  awaiting_setup: 'First-run setup',
  prep_deps:      'Downloading dependencies',
  db_init:        'Initializing database',
  core_init:      'Starting core systems',
  services_wait:  'Starting services',
  ready:          'Ready',
};

function fmt(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ConnectionSplash() {
  const [dotCount, setDotCount]                   = useState(1);
  const [platform, setPlatform]                   = useState<Platform>('linux');
  const [showOtherVersions, setShowOtherVersions] = useState(false);
  const [showConfirm, setShowConfirm]             = useState(false);

  // Boot awareness — null = core not reachable at all (show install guide)
  const [bootState, setBootState]       = useState<BootState | null>(null);
  const [coreReachable, setCoreReachable] = useState(false);

  // First-run setup form
  const [setupUsername,    setSetupUsername]    = useState('');
  const [setupDisplayName, setSetupDisplayName] = useState('');
  const [setupPassword,    setSetupPassword]    = useState('');
  const [setupConfirmPw,   setSetupConfirmPw]   = useState('');
  const [setupError,       setSetupError]       = useState('');
  const [setupSubmitting,  setSetupSubmitting]  = useState(false);

  const setBootPhase  = useAppStore((s) => s.setBootPhase);
  const queryClient   = useQueryClient();

  // Login phase — shown after boot reaches ready on multi-user installs.
  // null = not yet determined, false = needs login, true = logged in.
  const [loginComplete,  setLoginComplete]  = useState<boolean | null>(null);
  const [loginUsers,     setLoginUsers]     = useState<{ username: string; display_name: string }[]>([]);
  const [loginSelected,  setLoginSelected]  = useState<string>('');
  const [loginPassword,  setLoginPassword]  = useState('');
  const [loginError,     setLoginError]     = useState<string | null>(null);
  const [loginSubmitting,setLoginSubmitting] = useState(false);

  // Password-setup sub-screen — shown when the selected user has no password yet.
  // Replaces the single password field with a set-new-password + confirm pair.
  const [needsPasswordSetup,  setNeedsPasswordSetup]  = useState(false);
  const [setupNewPassword,    setSetupNewPassword]    = useState('');
  const [setupNewConfirm,     setSetupNewConfirm]     = useState('');
  const [setupNewError,       setSetupNewError]       = useState<string | null>(null);
  const [setupNewSubmitting,  setSetupNewSubmitting]  = useState(false);

  const esRef    = useRef<EventSource | null>(null);
  const reloaded = useRef(false);

  const [stars] = useState(() =>
    Array.from({ length: 60 }, (_, i) => ({
      x: Math.random() * 100, y: Math.random() * 100,
      size: Math.random() * 1.5 + 0.5,
      delay: Math.random() * 4, dur: Math.random() * 3 + 2,
      key: i,
    }))
  );

  // Animated dots
  useEffect(() => {
    const t = setInterval(() => setDotCount(d => (d % 3) + 1), 600);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { detectPlatform().then(setPlatform); }, []);

  // ── SSE subscription ────────────────────────────────────────────────────────
  // Only perform a boot-reload once per boot sequence. We track this with
  // sessionStorage so the flag survives the reload but is cleared immediately
  // on mount — preventing the infinite reload loop.
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // If we already reloaded from a boot sequence this session, skip the SSE.
    if (sessionStorage.getItem('phobos_boot_reloaded') === '1') {
      sessionStorage.removeItem('phobos_boot_reloaded');
      return;
    }

    function connect() {
      if (reloaded.current) return;

      const es = new EventSource(`${ENGINE_URL}/api/boot/events`);
      esRef.current = es;

      es.onopen = () => { setCoreReachable(true); };

      es.onmessage = (e) => {
        let state: BootState;
        try { state = JSON.parse(e.data); } catch { return; }

        setCoreReachable(true);
        setBootPhase(state.phase);

        // If the very first message is already 'ready', the server finished
        // booting before we connected — post-reload path. Always check session
        // status to decide whether to show the login screen. This fires on every
        // page load/refresh so the app never auto-mounts without a valid session.
        if (state.phase === 'ready' && bootState === null) {
          es.close();
          esRef.current = null;

          // Fetch session status and user list in parallel.
          Promise.all([
            fetch(`${ENGINE_URL}/api/session/status`).then(r => r.json()) as Promise<{
              loggedIn: boolean; lastUser: string;
            }>,
            fetch(`${ENGINE_URL}/api/users/list`).then(r => r.json()) as Promise<{
              users: { username: string; display_name: string }[];
            }>,
          ])
            .then(([status, userList]) => {
              const users = userList.users ?? [];
              setLoginUsers(users);

              if (status.loggedIn) {
                // Valid session already in sessionStorage — go straight through.
                setLoginComplete(true);
                setBootPhase('ready');
              } else {
                // No valid session — show login screen.
                // Pre-select lastUser from active-user.json if they're in the list,
                // otherwise default to the first user.
                const preSelect = users.find(u => u.username === status.lastUser)
                  ?? users[0];
                if (preSelect) setLoginSelected(preSelect.username);
                setLoginComplete(false);
              }
            })
            .catch(() => {
              // Can't determine state — fail open and boot through.
              setLoginComplete(true);
              setBootPhase('ready');
            });
          return;
        }

        setBootState(state);

        if (state.phase === 'ready' && !reloaded.current) {
          reloaded.current = true;
          es.close();
          // Set the flag before reloading so the remounted component skips
          // the SSE on the fresh page, avoiding an infinite reload loop.
          sessionStorage.setItem('phobos_boot_reloaded', '1');
          // Full reload — ensures sprites, service proxies, and any
          // dynamically registered routes are loaded against the warm server.
          setTimeout(() => window.location.reload(), 500);
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        retryTimer = setTimeout(connect, 3_000);
      };
    }

    connect();

    return () => {
      reloaded.current = true;
      esRef.current?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  const dots = '.'.repeat(dotCount);
  const mono: React.CSSProperties = { fontFamily: "'Space Mono', 'Share Tech Mono', monospace" };

  const getDownloadUrl = (plat: Platform) =>
    `${RELEASE_BASE}/${PLATFORM_CONFIG[plat].file}`;

  const handlePrimaryClick = () => { setShowConfirm(true); setShowOtherVersions(false); };
  const handleConfirm = () => { window.open(getDownloadUrl(platform), '_blank', 'noopener,noreferrer'); setShowConfirm(false); };
  const handleCancel  = () => setShowConfirm(false);
  const handleOtherPlatform = (plat: Platform) => window.open(getDownloadUrl(plat), '_blank', 'noopener,noreferrer');

  // ── First-run setup form ──────────────────────────────────────────────────
  const handleSetupSubmit = async () => {
    const u = setupUsername.trim().toLowerCase();
    if (!/^[a-z0-9_\-]{2,32}$/.test(u)) {
      setSetupError('2–32 characters: lowercase letters, numbers, _ or -');
      return;
    }
    if (setupPassword.length < 8) {
      setSetupError('Password must be at least 8 characters.');
      return;
    }
    if (setupPassword !== setupConfirmPw) {
      setSetupError('Passwords do not match.');
      return;
    }
    setSetupError('');
    setSetupSubmitting(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/setup/init`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username:    u,
          displayName: setupDisplayName.trim() || u,
          password:    setupPassword,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setSetupError(data.error ?? `Server error ${res.status}`);
        setSetupSubmitting(false);
      }
      // On success the server resumes boot — SSE stream carries us through to ready.
    } catch (err) {
      setSetupError(String(err));
      setSetupSubmitting(false);
    }
  };

  // ── Local login screen ─────────────────────────────────────────────────────
  const handleLoginSubmit = async () => {
    if (!loginSelected || !loginPassword) return;
    setLoginSubmitting(true);
    setLoginError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/session/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: loginSelected, password: loginPassword }),
      });
      if (res.ok) {
        const data = await res.json() as { sessionToken: string };
        sessionStorage.setItem('phobos_session', data.sessionToken);
        // Immediately re-poll /api/status with the new token so backendAlive
        // flips to true before Index.tsx recalculates splashVisible. Without
        // this, the 5 s interval fires first with a stale 401, backendAlive
        // stays false, and the main UI never mounts.
        void queryClient.invalidateQueries({ queryKey: ['status'] });
        setLoginComplete(true);
        setBootPhase('ready');
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (data.error === 'no_password_set') {
          // User exists but has no credential row yet (pre-upgrade or new
          // secondary user). Switch to the set-password sub-screen.
          setLoginPassword('');
          setLoginError(null);
          setNeedsPasswordSetup(true);
        } else {
          setLoginError('Incorrect password.');
        }
      }
    } catch {
      setLoginError('Could not reach server.');
    } finally {
      setLoginSubmitting(false);
    }
  };

  // ── Password setup for existing users with no credential row ─────────────
  // Called from the set-password sub-screen inside renderLoginScreen.
  // POSTs to /api/admin/auth/setup, then immediately logs in on success.
  const handlePasswordSetupSubmit = async () => {
    if (setupNewPassword.length < 8) {
      setSetupNewError('Password must be at least 8 characters.');
      return;
    }
    if (setupNewPassword !== setupNewConfirm) {
      setSetupNewError('Passwords do not match.');
      return;
    }
    setSetupNewError(null);
    setSetupNewSubmitting(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/auth/setup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username: loginSelected,
          password: setupNewPassword,
          confirm:  setupNewConfirm,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setSetupNewError(data.error ?? `Server error ${res.status}`);
        return;
      }
      // Password set — now log in automatically with the new password.
      const loginRes = await fetch(`${ENGINE_URL}/api/session/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: loginSelected, password: setupNewPassword }),
      });
      if (loginRes.ok) {
        const data = await loginRes.json() as { sessionToken: string };
        sessionStorage.setItem('phobos_session', data.sessionToken);
        void queryClient.invalidateQueries({ queryKey: ['status'] });
        setLoginComplete(true);
        setBootPhase('ready');
      } else {
        // Password was set but login failed — fall back to normal login screen.
        setNeedsPasswordSetup(false);
        setSetupNewPassword('');
        setSetupNewConfirm('');
        setLoginError('Password set — please sign in.');
      }
    } catch {
      setSetupNewError('Could not reach server.');
    } finally {
      setSetupNewSubmitting(false);
    }
  };

  const renderLoginScreen = () => (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0a06',
      zIndex: 9999,
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: 'rgba(232,66,10,0.04)',
        border: '1px solid rgba(232,66,10,0.2)',
        padding: '28px 28px 24px',
        boxSizing: 'border-box',
      }}>
        <div style={{ marginBottom: 20 }}>
          <span style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.7)', letterSpacing: '0.2em' }}>
            // SELECT USER
          </span>
        </div>

        {/* User cards */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {loginUsers.map(u => (
            <button
              key={u.username}
              onClick={() => {
                setLoginSelected(u.username);
                setLoginPassword('');
                setLoginError(null);
                setNeedsPasswordSetup(false);
                setSetupNewPassword('');
                setSetupNewConfirm('');
                setSetupNewError(null);
              }}
              style={{
                textAlign: 'left', padding: '9px 12px',
                background: loginSelected === u.username ? 'rgba(232,66,10,0.12)' : 'rgba(0,0,0,0.3)',
                border: `1px solid ${loginSelected === u.username ? 'rgba(232,66,10,0.5)' : 'rgba(232,66,10,0.15)'}`,
                color: loginSelected === u.username ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)',
                cursor: 'pointer', transition: 'all 150ms',
              }}
            >
              <span style={{ ...mono, fontSize: 12 }}>{u.display_name || u.username}</span>
              {u.display_name && u.display_name !== u.username && (
                <span style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.5)', marginLeft: 8 }}>
                  {u.username}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Password input — normal login OR forced set-password flow */}
        {needsPasswordSetup ? (
          <>
            <div style={{ marginBottom: 8 }}>
              <p style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.7)', letterSpacing: '0.15em', margin: '0 0 10px' }}>
                // SET PASSWORD FOR {loginSelected.toUpperCase()}
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6, margin: '0 0 14px' }}>
                No password has been set for this account. Set one to continue.
              </p>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
                NEW PASSWORD
              </label>
              <input
                type="password"
                value={setupNewPassword}
                onChange={e => setSetupNewPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handlePasswordSetupSubmit()}
                placeholder="Min. 8 characters"
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
                  color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
                  padding: '10px 12px', outline: 'none', transition: 'border-color 150ms',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
                onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
              />
            </div>

            <div style={{ marginBottom: setupNewError ? 10 : 18 }}>
              <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
                CONFIRM PASSWORD
              </label>
              <input
                type="password"
                value={setupNewConfirm}
                onChange={e => setSetupNewConfirm(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handlePasswordSetupSubmit()}
                placeholder="Repeat password"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
                  color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
                  padding: '10px 12px', outline: 'none', transition: 'border-color 150ms',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
                onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
              />
            </div>

            {setupNewError && (
              <p style={{ ...mono, fontSize: 10, color: 'rgba(255,100,60,0.85)', margin: '0 0 14px', letterSpacing: '0.05em' }}>
                {setupNewError}
              </p>
            )}

            <button
              onClick={handlePasswordSetupSubmit}
              disabled={setupNewSubmitting || !setupNewPassword || !setupNewConfirm}
              style={{
                width: '100%', padding: '11px 0',
                background: setupNewSubmitting ? 'rgba(232,66,10,0.08)' : 'rgba(232,66,10,0.15)',
                border: '1px solid rgba(232,66,10,0.4)',
                color: setupNewSubmitting ? 'rgba(232,66,10,0.4)' : 'rgba(240,80,20,0.9)',
                ...mono, fontSize: 11, letterSpacing: '0.2em',
                cursor: setupNewSubmitting ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => { if (!setupNewSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.25)'; }}
              onMouseLeave={e => { if (!setupNewSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.15)'; }}
            >
              {setupNewSubmitting ? 'SETTING PASSWORD...' : 'SET PASSWORD & SIGN IN'}
            </button>
          </>
        ) : (
          <>
            <div style={{ marginBottom: loginError ? 10 : 18 }}>
              <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
                PASSWORD
              </label>
              <input
                type="password"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLoginSubmit()}
                placeholder="Enter password"
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
                  color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
                  padding: '10px 12px', outline: 'none',
                  transition: 'border-color 150ms',
                }}
                onFocus={e  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
                onBlur={e   => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
              />
            </div>

            {loginError && (
              <p style={{ ...mono, fontSize: 10, color: 'rgba(255,100,60,0.85)', margin: '0 0 14px', letterSpacing: '0.05em' }}>
                {loginError}
              </p>
            )}

            <button
              onClick={handleLoginSubmit}
              disabled={loginSubmitting || !loginSelected || !loginPassword}
              style={{
                width: '100%', padding: '11px 0',
                background: loginSubmitting ? 'rgba(232,66,10,0.08)' : 'rgba(232,66,10,0.15)',
                border: '1px solid rgba(232,66,10,0.4)',
                color: loginSubmitting ? 'rgba(232,66,10,0.4)' : 'rgba(240,80,20,0.9)',
                ...mono, fontSize: 11, letterSpacing: '0.2em',
                cursor: loginSubmitting ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => { if (!loginSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.25)'; }}
              onMouseLeave={e => { if (!loginSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.15)'; }}
            >
              {loginSubmitting ? 'SIGNING IN...' : 'SIGN IN'}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const renderSetupForm = () => (
    <div style={{
      width: '100%',
      background: 'rgba(232,66,10,0.04)',
      border: '1px solid rgba(232,66,10,0.2)',
      padding: '24px 22px',
      marginBottom: 24,
      boxSizing: 'border-box',
    }}>
      <div style={{ marginBottom: 18 }}>
        <span style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.7)', letterSpacing: '0.2em' }}>
          // CREATE OWNER ACCOUNT
        </span>
      </div>

      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.7, margin: '0 0 20px' }}>
        No accounts exist yet. Create the owner account to continue.
      </p>

      {/* Username */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
          USERNAME
        </label>
        <input
          type="text"
          value={setupUsername}
          onChange={(e) => setSetupUsername(e.target.value.toLowerCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleSetupSubmit()}
          placeholder="e.g. commander"
          maxLength={32}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
            color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
            padding: '10px 12px', outline: 'none',
            transition: 'border-color 150ms',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
        />
      </div>

      {/* Display name */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
          DISPLAY NAME <span style={{ color: 'rgba(255,255,255,0.2)' }}>(optional)</span>
        </label>
        <input
          type="text"
          value={setupDisplayName}
          onChange={(e) => setSetupDisplayName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSetupSubmit()}
          placeholder="e.g. Commander Shepard"
          maxLength={64}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
            color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
            padding: '10px 12px', outline: 'none',
            transition: 'border-color 150ms',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
        />
      </div>

      {/* Password */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
          PASSWORD
        </label>
        <input
          type="password"
          value={setupPassword}
          onChange={(e) => setSetupPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSetupSubmit()}
          placeholder="Min. 8 characters"
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
            color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
            padding: '10px 12px', outline: 'none',
            transition: 'border-color 150ms',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
        />
      </div>

      {/* Confirm password */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ ...mono, fontSize: 9, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.18em', display: 'block', marginBottom: 6 }}>
          CONFIRM PASSWORD
        </label>
        <input
          type="password"
          value={setupConfirmPw}
          onChange={(e) => setSetupConfirmPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSetupSubmit()}
          placeholder="Repeat password"
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(232,66,10,0.25)',
            color: 'rgba(255,255,255,0.85)', ...mono, fontSize: 13,
            padding: '10px 12px', outline: 'none',
            transition: 'border-color 150ms',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.6)'; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = 'rgba(232,66,10,0.25)'; }}
        />
      </div>

      {setupError && (
        <p style={{ ...mono, fontSize: 10, color: 'rgba(255,100,60,0.85)', margin: '0 0 14px', letterSpacing: '0.05em' }}>
          {setupError}
        </p>
      )}

      <button
        onClick={handleSetupSubmit}
        disabled={setupSubmitting || !setupUsername.trim() || !setupPassword || !setupConfirmPw}
        style={{
          width: '100%', padding: '11px 0',
          background: setupSubmitting ? 'rgba(232,66,10,0.08)' : 'rgba(232,66,10,0.15)',
          border: '1px solid rgba(232,66,10,0.4)',
          color: setupSubmitting ? 'rgba(232,66,10,0.4)' : 'rgba(240,80,20,0.9)',
          ...mono, fontSize: 11, letterSpacing: '0.2em',
          cursor: setupSubmitting ? 'not-allowed' : 'pointer',
          transition: 'all 150ms',
        }}
        onMouseEnter={(e) => { if (!setupSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.25)'; }}
        onMouseLeave={(e) => { if (!setupSubmitting) e.currentTarget.style.background = 'rgba(232,66,10,0.15)'; }}
      >
        {setupSubmitting ? 'CREATING ACCOUNT...' : 'CREATE ACCOUNT'}
      </button>
    </div>
  );

  // ── Boot progress panel (prep_deps / db_init / core_init) ─────────────────
  const renderBootProgress = () => {
    if (!bootState) return null;
    const { phase, progress } = bootState;

    const phaseLabel  = PHASE_LABEL[phase] ?? phase;
    const hasDepBar   = phase === 'prep_deps' && progress.bytes !== undefined && (progress.total ?? 0) > 0;
    const depPct      = hasDepBar ? Math.min(100, Math.floor((progress.bytes! / progress.total!) * 100)) : null;
    const overallPct  = (progress.depsTotal ?? 0) > 0
      ? Math.floor((progress.depsDone ?? 0) / progress.depsTotal! * 100)
      : null;

    return (
      <div style={{
        width: '100%',
        background: 'rgba(232,66,10,0.04)',
        border: '1px solid rgba(232,66,10,0.15)',
        padding: '20px 22px',
        marginBottom: 24,
        boxSizing: 'border-box',
      }}>
        {/* Phase header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.7)', letterSpacing: '0.2em' }}>
            // {phaseLabel.toUpperCase()}
          </span>
          {overallPct !== null && (
            <span style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em' }}>
              {progress.depsDone ?? 0} / {progress.depsTotal ?? 0} deps
            </span>
          )}
        </div>

        {/* Overall progress bar */}
        {overallPct !== null && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 1, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${overallPct}%`,
                background: 'linear-gradient(to right, rgba(232,66,10,0.5), rgba(232,66,10,0.8))',
                transition: 'width 300ms ease',
              }} />
            </div>
          </div>
        )}

        {/* Current dep */}
        {progress.dep && (
          <div style={{ marginBottom: 8 }}>
            <p style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,0.6)', margin: '0 0 6px', letterSpacing: '0.05em' }}>
              {progress.dep}
            </p>
            {progress.file && (
              <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', margin: '0 0 8px', letterSpacing: '0.05em', wordBreak: 'break-all' }}>
                {progress.file}
              </p>
            )}

            {/* Per-file download bar */}
            {hasDepBar && depPct !== null && (
              <>
                <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, overflow: 'hidden', marginBottom: 4 }}>
                  <div style={{
                    height: '100%', width: `${depPct}%`,
                    background: 'rgba(0,255,157,0.5)',
                    transition: 'width 200ms linear',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ ...mono, fontSize: 9, color: 'rgba(0,255,157,0.5)', letterSpacing: '0.08em' }}>
                    {depPct}%
                  </span>
                  <span style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.08em' }}>
                    {fmt(progress.bytes!)} / {fmt(progress.total!)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Phase-specific note */}
        {phase === 'db_init' && (
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', margin: 0, letterSpacing: '0.08em' }}>
            Preparing database...
          </p>
        )}
        {phase === 'core_init' && (
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', margin: 0, letterSpacing: '0.08em' }}>
            Starting AI systems and services...
          </p>
        )}
      </div>
    );
  };

  // ── Services wait panel ────────────────────────────────────────────────────
  const renderServicesWait = () => {
    if (!bootState) return null;
    const services    = bootState.progress.services ?? [];
    const deadline    = bootState.progress.waitDeadline ?? 0;
    const msRemaining = Math.max(0, deadline - Date.now());
    const secRemaining = Math.ceil(msRemaining / 1000);
    const allSettled  = services.length > 0 && services.every(s => s.state !== 'waiting');
    const anyFailed   = services.some(s => s.state === 'failed');

    return (
      <div style={{
        width: '100%',
        background: 'rgba(232,66,10,0.04)',
        border: '1px solid rgba(232,66,10,0.15)',
        padding: '20px 22px',
        marginBottom: 24,
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.7)', letterSpacing: '0.2em' }}>
            // SERVICES INITIALIZING
          </span>
          {!allSettled && (
            <span style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em' }}>
              {secRemaining}s
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {services.map((svc) => {
            const color =
              svc.state === 'ready'  ? 'rgba(0,255,157,0.75)' :
              svc.state === 'failed' ? 'rgba(255,100,80,0.75)' :
              'rgba(255,255,255,0.35)';
            const icon =
              svc.state === 'ready'  ? '✓' :
              svc.state === 'failed' ? '✗' :
              dots;
            return (
              <div key={svc.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.05em' }}>
                  {svc.name}
                </span>
                <span style={{ ...mono, fontSize: 10, color, letterSpacing: '0.1em', minWidth: 18, textAlign: 'right' }}>
                  {icon}
                </span>
              </div>
            );
          })}
        </div>

        {anyFailed && (
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,160,80,0.6)', margin: '14px 0 0', letterSpacing: '0.08em', lineHeight: 1.7 }}>
            Some services are still starting or may have failed to start. You can still use PHOBOS — affected features may be unavailable.
          </p>
        )}
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  // Login phase: server is ready but user selection is pending.
  if (loginComplete === false) {
    return renderLoginScreen();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-y-auto"
      style={{
        background: 'radial-gradient(ellipse 120% 80% at 50% 10%, #0a0500 0%, #080808 50%, #040404 100%)',
      }}
    >
      <style>{`
        @keyframes cs-flicker { 0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:.45} 94%{opacity:1} 97%{opacity:.7} 98%{opacity:1} }
        @keyframes cs-twinkle { 0%,100%{opacity:.15} 50%{opacity:.7} }
        @keyframes cs-orbit   { from{transform:rotate(0deg) translateX(38px) rotate(0deg)} to{transform:rotate(360deg) translateX(38px) rotate(-360deg)} }
        @keyframes cs-orbit2  { from{transform:rotate(120deg) translateX(52px) rotate(-120deg)} to{transform:rotate(480deg) translateX(52px) rotate(-480deg)} }
        @keyframes cs-orbit3  { from{transform:rotate(240deg) translateX(28px) rotate(-240deg)} to{transform:rotate(600deg) translateX(28px) rotate(-600deg)} }
        @keyframes cs-glow    { 0%,100%{box-shadow:0 0 20px rgba(232,66,10,0.15)} 50%{box-shadow:0 0 40px rgba(232,66,10,0.3)} }
        @keyframes cs-rise    { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* Stars */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} aria-hidden>
        {stars.map(s => (
          <circle
            key={s.key} cx={`${s.x}%`} cy={`${s.y}%`} r={s.size}
            fill="white"
            style={{ animation: `cs-twinkle ${s.dur}s ${s.delay}s ease-in-out infinite` }}
          />
        ))}
      </svg>

      {/* Nebula */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '-10%', left: '30%', width: '40%', height: '35%', background: 'radial-gradient(ellipse, rgba(0,80,180,0.12) 0%, transparent 70%)', filter: 'blur(40px)' }} />
        <div style={{ position: 'absolute', bottom: '10%', right: '20%', width: '30%', height: '25%', background: 'radial-gradient(ellipse, rgba(0,180,120,0.08) 0%, transparent 70%)', filter: 'blur(50px)' }} />
      </div>

      <div style={{ position: 'relative', zIndex: 2, width: '100%', maxWidth: 520, padding: '40px 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', animation: 'cs-rise .6s ease both' }}>

        {/* Orrery */}
        <div style={{ position: 'relative', width: 120, height: 120, marginBottom: 32, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src={`${import.meta.env.BASE_URL}phobos.png`} alt="" style={{ width: 36, height: 36, objectFit: 'contain', opacity: 0.7, filter: 'brightness(0.9) saturate(0.5)' }} />
          </div>
          {[38, 52, 28].map((r, i) => (
            <div key={i} style={{
              position: 'absolute', inset: `${60 - r}px`,
              border: `1px solid rgba(232,66,10,${0.08 + i * 0.03})`,
            }} />
          ))}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: 0, height: 0 }}>
              <div style={{ position: 'absolute', width: 5, height: 5, borderRadius: '50%', background: '#e8420a', boxShadow: '0 0 6px rgba(232,66,10,0.8)', animation: 'cs-orbit 4s linear infinite', marginTop: -2.5, marginLeft: -2.5 }} />
              <div style={{ position: 'absolute', width: 3.5, height: 3.5, borderRadius: '50%', background: '#00ff9d', boxShadow: '0 0 5px rgba(0,255,157,0.7)', animation: 'cs-orbit2 7s linear infinite', marginTop: -1.75, marginLeft: -1.75 }} />
              <div style={{ position: 'absolute', width: 3, height: 3, borderRadius: '50%', background: '#7b6fff', boxShadow: '0 0 5px rgba(123,111,255,0.7)', animation: 'cs-orbit3 5.5s linear infinite', marginTop: -1.5, marginLeft: -1.5 }} />
            </div>
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ ...mono, fontSize: 'clamp(22px,4vw,30px)', letterSpacing: '0.45em', color: 'rgba(232,66,10,0.9)', margin: '0 0 6px', animation: 'cs-flicker 5s ease-in-out infinite' }}>
            PHOBOS
          </h1>
          <div style={{ height: 1, background: 'linear-gradient(to right, transparent, rgba(232,66,10,0.25), transparent)', marginBottom: 10 }} />
          <p style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.25em', margin: 0 }}>
            {coreReachable
              ? 'TRI-BRAINED AI SYSTEM — INITIALIZING'
              : 'TRI-BRAINED AI SYSTEM — CORE NOT RUNNING'}
          </p>
        </div>

        {/* Boot progress panel — shown when core is reachable but not yet ready */}
        {coreReachable && bootState && bootState.phase !== 'ready' && (
          bootState.phase === 'awaiting_setup'
            ? renderSetupForm()
            : bootState.phase === 'services_wait'
              ? renderServicesWait()
              : renderBootProgress()
        )}

        {/* Install guide — shown when core is not reachable at all */}
        {!coreReachable && (
          <>
            <div style={{ width: '100%', background: 'rgba(232,66,10,0.03)', border: '1px solid rgba(232,66,10,0.15)', padding: '24px 26px', marginBottom: 24, boxSizing: 'border-box' }}>
              <p style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.6)', letterSpacing: '0.2em', marginBottom: 14 }}>
                // QUICK SETUP
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7, marginBottom: 10 }}>
                <strong style={{ color: '#fff' }}>PHOBOS runs AI on your computer</strong>, not the cloud. You need <strong style={{ color: 'rgba(232,66,10,0.85)' }}>phobos-core</strong> running locally first.
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.75, margin: 0 }}>
                Download the launcher, and run <code style={{ color: 'rgba(232,66,10,0.7)', background: 'rgba(232,66,10,0.07)', padding: '1px 5px' }}>phobos-core</code>. Then come back here — PHOBOS connects automatically.
              </p>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
              {[
                { n: '1', text: 'Download phobos-core below' },
                { n: '2', text: 'Install the Launcher' },
                { n: '3', text: 'Return here — connection is automatic' },
              ].map(step => (
                <div key={step.n} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ ...mono, fontSize: 10, color: 'rgba(232,66,10,0.7)', border: '1px solid rgba(232,66,10,0.2)', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderRadius: 2 }}>
                    {step.n}
                  </div>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, margin: 0 }}>
                    {step.text}
                  </p>
                </div>
              ))}
            </div>

            {!showConfirm ? (
              <button
                onClick={handlePrimaryClick}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 10,
                  background: 'linear-gradient(135deg, rgba(232,66,10,0.18) 0%, rgba(200,50,8,0.12) 100%)',
                  border: '1px solid rgba(232,66,10,0.5)',
                  color: 'rgba(240,80,20,0.95)',
                  ...mono, fontSize: 12, letterSpacing: '0.18em',
                  padding: '13px 32px', cursor: 'pointer',
                  marginBottom: 10, width: '100%', justifyContent: 'center',
                  transition: 'all 180ms',
                  animation: 'cs-glow 3s ease-in-out infinite',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(232,66,10,0.2)'; e.currentTarget.style.borderColor = 'rgba(240,80,20,0.8)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(232,66,10,0.18) 0%, rgba(200,50,8,0.12) 100%)'; e.currentTarget.style.borderColor = 'rgba(232,66,10,0.5)'; }}
              >
                <Download size={14} />
                {PLATFORM_CONFIG[platform].label}
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', background: 'rgba(232,66,10,0.04)', border: '1px solid rgba(232,66,10,0.2)', padding: '16px 24px', marginBottom: 10, width: '100%', boxSizing: 'border-box' }}>
                <p style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.1em', margin: 0 }}>
                  Download phobos-core for {platform.charAt(0).toUpperCase() + platform.slice(1)}?
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={handleConfirm} style={{ ...mono, fontSize: 11, letterSpacing: '0.12em', padding: '8px 20px', background: 'rgba(232,66,10,0.15)', border: '1px solid rgba(232,66,10,0.4)', color: 'rgba(240,80,20,0.9)', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(232,66,10,0.25)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(232,66,10,0.15)'; }}>
                    CONFIRM
                  </button>
                  <button onClick={handleCancel} style={{ ...mono, fontSize: 11, letterSpacing: '0.12em', padding: '8px 20px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}>
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {!showConfirm && (
              <button onClick={() => setShowOtherVersions(!showOtherVersions)}
                style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 6, transition: 'color 150ms', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.28)')}>
                ▾ Other platforms
              </button>
            )}

            {showOtherVersions && !showConfirm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, background: 'rgba(8,8,8,0.8)', border: '1px solid rgba(232,66,10,0.15)', padding: 6, marginBottom: 14, width: '100%', boxSizing: 'border-box' }}>
                {(Object.keys(PLATFORM_CONFIG) as Platform[]).map((plat) => (
                  <button key={plat} onClick={() => handleOtherPlatform(plat)}
                    style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.1em', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 8px', textAlign: 'left', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(232,66,10,0.08)'; e.currentTarget.style.color = 'rgba(240,80,20,0.75)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}>
                    {PLATFORM_CONFIG[plat].label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Status indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: coreReachable ? 'rgba(0,255,65,0.6)' : 'rgba(232,66,10,0.5)',
            display: 'inline-block',
            animation: 'cs-flicker 2s ease-in-out infinite',
          }} />
          <span style={{ ...mono, fontSize: 9, color: coreReachable ? 'rgba(0,255,65,0.45)' : 'rgba(232,66,10,0.40)', letterSpacing: '0.15em' }}>
            {coreReachable
              ? `${PHASE_LABEL[bootState?.phase ?? 'db_init']}${dots}`
              : `Connecting to localhost:3001${dots}`}
          </span>
        </div>

        {!coreReachable && (
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.1em', marginTop: 14, lineHeight: 1.7, textAlign: 'center' }}>
            Already running phobos-core?{' '}
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>Check it's on localhost:3001</span>
            {' '}and your firewall isn't blocking it.
          </p>
        )}

      </div>
    </div>
  );
}