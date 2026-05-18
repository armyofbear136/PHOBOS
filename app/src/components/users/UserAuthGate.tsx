/**
 * UserAuthGate.tsx — Password gate for the User Management panel.
 *
 * Renders a centred modal overlay. On first-run (no password set) it shows a
 * set-password form. On subsequent opens it shows a verify-password form.
 * On success it calls onAuth(token) with the session token.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Props {
  passwordSet: boolean;
  onAuth:      (token: string) => void;
}

export function UserAuthGate({ passwordSet, onAuth }: Props) {
  const [password,    setPassword]    = useState('');
  const [confirm,     setConfirm]     = useState('');
  const [current,     setCurrent]     = useState('');  // for change-password
  const [showPw,      setShowPw]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleVerify = useCallback(async () => {
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/admin/auth`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });
      if (res.ok) {
        const { token } = await res.json() as { token: string };
        onAuth(token);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error === 'no_password_set' ? 'No password set.' : 'Incorrect password.');
      }
    } catch {
      setError('Could not reach server.');
    } finally {
      setSubmitting(false);
    }
  }, [password, onAuth]);

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
        body:    JSON.stringify({ password, confirm }),
      });
      if (res.ok) {
        const { token } = await res.json() as { token: string };
        onAuth(token);
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? 'Setup failed.');
      }
    } catch {
      setError('Could not reach server.');
    } finally {
      setSubmitting(false);
    }
  }, [password, confirm, onAuth]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') passwordSet ? handleVerify() : handleSetup();
  };

  const inputCls = 'w-full bg-background border border-border rounded px-3 py-2 text-sm ' +
                   'text-foreground focus:outline-none focus:border-phobos-green/60 transition-colors';

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-sm mx-4 p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-md bg-phobos-green/10 text-phobos-green">
            <Lock className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground font-terminal tracking-wider">
              {passwordSet ? 'USER MANAGEMENT' : 'SET MANAGEMENT PASSWORD'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {passwordSet
                ? 'Enter your management password to continue.'
                : 'Create a password to protect user management.'}
            </p>
          </div>
        </div>

        {/* Fields */}
        <div className="space-y-3">
          {!passwordSet && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">New password</label>
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
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}

          {!passwordSet && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Confirm password</label>
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

          {passwordSet && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Password</label>
              <div className="relative">
                <input
                  ref={inputRef}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Management password"
                  className={inputCls + ' pr-9'}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}

          <button
            onClick={passwordSet ? handleVerify : handleSetup}
            disabled={submitting || !password || (!passwordSet && !confirm)}
            className="w-full mt-1 py-2 px-4 rounded text-xs font-terminal tracking-wider
                       bg-phobos-green/10 border border-phobos-green/30 text-phobos-green
                       hover:bg-phobos-green/20 hover:border-phobos-green/50
                       disabled:opacity-40 disabled:cursor-not-allowed transition-all
                       flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {passwordSet ? 'UNLOCK' : 'SET PASSWORD'}
          </button>
        </div>
      </div>
    </div>
  );
}
