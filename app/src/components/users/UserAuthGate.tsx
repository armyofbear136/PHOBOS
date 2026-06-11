/**
 * UserAuthGate.tsx — Password gate for the User Management panel.
 *
 * Renders a centred modal overlay. Shows a per-user verify-password form.
 * If the user has no credential row yet (no_password_set — pre-upgrade installs
 * or the first open after account creation), switches to a set-password form.
 * On success calls onAuth(token, role).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Props {
  username:    string;   // pre-filled from active user — never editable
  passwordSet: boolean;  // false triggers set-password form immediately
  onAuth:      (token: string, role: string) => void;
}

export function UserAuthGate({ username, passwordSet: initialPasswordSet, onAuth }: Props) {
  // needsSetup starts true when no credential row exists, flips false after set.
  const [needsSetup,  setNeedsSetup]  = useState(!initialPasswordSet);
  const [password,    setPassword]    = useState('');
  const [confirm,     setConfirm]     = useState('');
  const [showPw,      setShowPw]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [needsSetup]);

  const handleVerify = useCallback(async () => {
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/auth`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const { token, role } = await res.json() as { token: string; role: string };
        onAuth(token, role);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (data.error === 'no_password_set') {
          // User exists but has no credential row — show set-password form.
          setNeedsSetup(true);
          setPassword('');
          setError(null);
        } else {
          setError('Incorrect password.');
        }
      }
    } catch {
      setError('Could not reach server.');
    } finally {
      setSubmitting(false);
    }
  }, [username, password, onAuth]);

  const handleSetup = useCallback(async () => {
    if (!password || !confirm) return;
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8)  { setError('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/auth/setup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password, confirm }),
      });
      if (res.ok) {
        const { token, role } = await res.json() as { token: string; role: string };
        onAuth(token, role);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Setup failed.');
      }
    } catch {
      setError('Could not reach server.');
    } finally {
      setSubmitting(false);
    }
  }, [username, password, confirm, onAuth]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') needsSetup ? handleSetup() : handleVerify();
  };

  const inputCls = 'w-full bg-phob-white/4 border border-phob-orange/25 px-3 py-2 text-sm text-phob-white ' +
                   'text-foreground focus:outline-none focus:border-phob-green/60 transition-colors';

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-phob-white/6 backdrop-blur-sm">
      <div className="bg-[#0f0f0a] border border-phob-orange/30 shadow-[0_0_24px_rgba(232,66,10,0.10)] w-full max-w-sm mx-4 p-6 phob-corners">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 bg-phob-orange/10 text-phob-orange">
            <Lock className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground font-terminal tracking-wider">
              {needsSetup ? 'SET YOUR PASSWORD' : 'USER MANAGEMENT'}
            </h2>
            <p className="text-xs text-phob-steel/50 mt-0.5">
              {needsSetup
                ? `Create a password for ${username}.`
                : `Enter password to continue as ${username}.`}
            </p>
          </div>
        </div>

        {/* Fields */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-phob-steel/50 mb-1">
              {needsSetup ? 'New password' : 'Password'}
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Min. 8 characters"
                className={inputCls + ' pr-9'}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-phob-steel/50 hover:text-phob-white transition-colors"
                tabIndex={-1}
              >
                {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {needsSetup && (
            <div>
              <label className="block text-xs text-phob-steel/50 mb-1">Confirm password</label>
              <input
                type={showPw ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Repeat password"
                className={inputCls}
              />
            </div>
          )}

          {error && (
            <p className="text-xs text-phob-red mt-1">{error}</p>
          )}

          <button
            onClick={needsSetup ? handleSetup : handleVerify}
            disabled={submitting || !password || (needsSetup && !confirm)}
            className="w-full mt-1 py-2 px-4 rounded text-xs font-terminal tracking-wider
                       bg-phob-green/10 border border-phob-green/30 text-phob-green
                       hover:bg-phob-green/20 hover:border-phob-green/50
                       disabled:opacity-40 disabled:cursor-not-allowed transition-all
                       flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {needsSetup ? 'SET PASSWORD' : 'UNLOCK'}
          </button>
        </div>
      </div>
    </div>
  );
}
