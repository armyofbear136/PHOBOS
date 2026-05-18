/**
 * MeridianPanel.tsx — Hub card and setup panel for PHOBOS Meridian.
 *
 * Drop-in replacement for the PhotoPrism card in MediaHubPanel.tsx.
 * Meridian is first-party — no binary download, just library path + enable.
 */

import { useState } from 'react';
import { Power, PowerOff, ScanLine, FolderOpen, Images } from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface ServiceStatus {
  name:        string;
  state:       'stopped' | 'starting' | 'running' | 'error';
  port:        number;
  error:       string | null;
  libraryPath: string | null;
  settings:    Record<string, unknown>;
  enabled:     boolean;
}

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const ACCENT = '#10b981';

export function MeridianPanel({ status, onClose, onRefresh }: {
  status:    ServiceStatus;
  onClose:   () => void;
  onRefresh: () => void;
}) {
  const [libraryPath, setLibPath] = useState(status.libraryPath ?? '');
  const [step, setStep]           = useState<'idle' | 'starting' | 'stopping' | 'saving'>('idle');
  const [error, setError]         = useState('');

  const isRunning  = status.state === 'running';
  const isStarting = status.state === 'starting';
  const isStopped  = status.state === 'stopped' || status.state === 'error';

  const saveConfig = async () => {
    setStep('saving'); setError('');
    try {
      await fetch(`${ENGINE}/api/services/meridian/config`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ libraryPath }),
      });
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setStep('idle');
  };

  const startService = async () => {
    if (!libraryPath.trim()) { setError('Set a library path first.'); return; }
    setStep('starting'); setError('');
    try {
      // Save config then enable
      await fetch(`${ENGINE}/api/services/meridian/config`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ libraryPath }),
      });
      await fetch(`${ENGINE}/api/services/meridian/enable`, { method: 'POST' });
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setStep('idle');
  };

  const stopService = async () => {
    setStep('stopping'); setError('');
    try {
      await fetch(`${ENGINE}/api/services/meridian/disable`, { method: 'POST' });
      onRefresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setStep('idle');
  };

  const triggerScan = async () => {
    try {
      await fetch(`${ENGINE}/api/services/meridian/scan`, { method: 'POST' });
    } catch { /* non-fatal */ }
  };

  const stateColor = isRunning  ? ACCENT
    : isStarting   ? '#f59e0b'
    : status.state === 'error' ? '#ef4444'
    : 'hsl(var(--secondary))';

  const stateLabel = isRunning  ? 'RUNNING'
    : isStarting   ? 'STARTING'
    : status.state === 'error' ? 'ERROR'
    : 'STOPPED';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9500,
      background: 'rgba(0,0,0,.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={onClose}
    >
      <div style={{
        width: 400, background: 'hsl(var(--background))', border: '1px solid #1e2430',
        borderRadius: 6, overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,.8)',
      }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '14px 16px', borderBottom: '1px solid #1e2430',
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 6,
            background: `${ACCENT}10`, border: `1px solid ${ACCENT}25`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Images size={14} style={{ color: ACCENT }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 12, fontWeight: 600, color: 'hsl(var(--foreground))' }}>
              Meridian
            </div>
            <div style={{ ...mono, fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 1 }}>
              PHOTO LIBRARY · PORT 16320
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%',
              background: stateColor,
              boxShadow: isRunning ? `0 0 5px ${stateColor}` : 'none' }} />
            <span style={{ ...mono, fontSize: 9, color: stateColor, letterSpacing: '.08em' }}>
              {stateLabel}
            </span>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '16px' }}>

          {/* Library path */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))', marginBottom: 5,
              letterSpacing: '.06em' }}>PHOBOS PHOTO LIBRARY PATH</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={libraryPath}
                onChange={e => setLibPath(e.target.value)}
                disabled={isRunning}
                placeholder="C:\Users\you\.phobos\media\photos"
                style={{
                  flex: 1, background: 'hsl(var(--card))',
                  border: `1px solid ${libraryPath ? 'hsl(var(--border))' : '#ef444440'}`,
                  borderRadius: 3, padding: '7px 10px',
                  color: isRunning ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))',
                  ...mono, fontSize: 11, outline: 'none',
                }}
              />
              <button
                disabled={isRunning}
                onClick={() => {
                  // Path picker — fires native dialog via PHOBOS backend
                  fetch(`${ENGINE}/api/services/meridian/browse`)
                    .then(r => r.json())
                    .then((d: { path?: string }) => { if (d.path) setLibPath(d.path); })
                    .catch(() => {});
                }}
                style={{
                  background: 'rgba(255,255,255,.04)', border: '1px solid #1e2430',
                  borderRadius: 3, color: 'hsl(var(--muted-foreground))', cursor: isRunning ? 'default' : 'pointer',
                  padding: '0 10px', display: 'flex', alignItems: 'center',
                  opacity: isRunning ? .4 : 1,
                }}>
                <FolderOpen size={13} />
              </button>
            </div>
            <div style={{ ...mono, fontSize: 9, color: 'hsl(var(--muted-foreground))', marginTop: 4 }}>
              This is the folder PHOBOS saves photos into. Other parts of PHOBOS write here automatically.
            </div>
          </div>

          {/* Status / error */}
          {(status.error || error) && (
            <div style={{
              background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.15)',
              borderRadius: 3, padding: '8px 10px', marginBottom: 12,
              ...mono, fontSize: 10, color: '#ef4444',
            }}>
              {error || status.error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {isStopped && (
              <button
                onClick={startService}
                disabled={step === 'starting'}
                style={{
                  flex: 1, background: `${ACCENT}18`,
                  color: ACCENT, border: `1px solid ${ACCENT}30`,
                  borderRadius: 3, padding: '8px 0', cursor: 'pointer',
                  ...mono, fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  opacity: step === 'starting' ? .5 : 1,
                }}>
                <Power size={12} />
                {step === 'starting' ? 'ENABLING…' : 'ENABLE'}
              </button>
            )}

            {isRunning && (
              <>
                <button
                  onClick={saveConfig}
                  disabled={step === 'saving'}
                  style={{
                    flex: 1, background: 'rgba(59,130,246,.08)',
                    color: '#3b82f6', border: '1px solid rgba(59,130,246,.2)',
                    borderRadius: 3, padding: '8px 0', cursor: 'pointer',
                    ...mono, fontSize: 11,
                    opacity: step === 'saving' ? .5 : 1,
                  }}>
                  {step === 'saving' ? 'SAVING…' : 'SAVE CONFIG'}
                </button>
                <button
                  onClick={triggerScan}
                  style={{
                    background: 'rgba(245,158,11,.06)', color: '#f59e0b',
                    border: '1px solid rgba(245,158,11,.15)', borderRadius: 3,
                    padding: '8px 12px', cursor: 'pointer',
                    ...mono, fontSize: 11,
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                  <ScanLine size={12} /> SCAN
                </button>
                <button
                  onClick={stopService}
                  disabled={step === 'stopping'}
                  style={{
                    background: 'rgba(239,68,68,.06)', color: '#ef4444',
                    border: '1px solid rgba(239,68,68,.15)', borderRadius: 3,
                    padding: '8px 12px', cursor: 'pointer',
                    ...mono, fontSize: 11,
                    display: 'flex', alignItems: 'center', gap: 5,
                    opacity: step === 'stopping' ? .5 : 1,
                  }}>
                  <PowerOff size={12} /> STOP
                </button>
              </>
            )}

            {isStarting && (
              <div style={{ ...mono, fontSize: 10, color: '#f59e0b',
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0' }}>
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>◌</span>
                Starting Meridian…
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
