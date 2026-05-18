import { useState, useEffect, useRef } from 'react';
import { Download } from 'lucide-react';
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

type BootPhase = 'prep_deps' | 'db_init' | 'core_init' | 'services_wait' | 'ready';

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
  prep_deps:     'Downloading dependencies',
  db_init:       'Initializing database',
  core_init:     'Starting core systems',
  services_wait: 'Starting services',
  ready:         'Ready',
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

  const setBootPhase = useAppStore((s) => s.setBootPhase);

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
        // booting before we connected — normal disconnect reason. Do NOT reload,
        // just close the SSE and let the status poll drive re-connection.
        if (state.phase === 'ready' && bootState === null) {
          es.close();
          esRef.current = null;
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
  const mono: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };

  const getDownloadUrl = (plat: Platform) =>
    `${RELEASE_BASE}/${PLATFORM_CONFIG[plat].file}`;

  const handlePrimaryClick = () => { setShowConfirm(true); setShowOtherVersions(false); };
  const handleConfirm = () => { window.open(getDownloadUrl(platform), '_blank', 'noopener,noreferrer'); setShowConfirm(false); };
  const handleCancel  = () => setShowConfirm(false);
  const handleOtherPlatform = (plat: Platform) => window.open(getDownloadUrl(plat), '_blank', 'noopener,noreferrer');

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
        background: 'rgba(0,200,255,0.04)',
        border: '1px solid rgba(0,200,255,0.15)',
        padding: '20px 22px',
        marginBottom: 24,
        boxSizing: 'border-box',
      }}>
        {/* Phase header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ ...mono, fontSize: 10, color: 'rgba(0,200,255,0.6)', letterSpacing: '0.2em' }}>
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
                background: 'linear-gradient(to right, rgba(0,200,255,0.5), rgba(0,200,255,0.8))',
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
        background: 'rgba(0,200,255,0.04)',
        border: '1px solid rgba(0,200,255,0.15)',
        padding: '20px 22px',
        marginBottom: 24,
        boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ ...mono, fontSize: 10, color: 'rgba(0,200,255,0.6)', letterSpacing: '0.2em' }}>
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
            Some services failed to start. You can still use PHOBOS — affected features may be unavailable.
          </p>
        )}
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-y-auto"
      style={{
        background: 'radial-gradient(ellipse 120% 80% at 50% 20%, #050d1a 0%, #060810 50%, #020408 100%)',
      }}
    >
      <style>{`
        @keyframes cs-flicker { 0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:.45} 94%{opacity:1} 97%{opacity:.7} 98%{opacity:1} }
        @keyframes cs-twinkle { 0%,100%{opacity:.15} 50%{opacity:.7} }
        @keyframes cs-orbit   { from{transform:rotate(0deg) translateX(38px) rotate(0deg)} to{transform:rotate(360deg) translateX(38px) rotate(-360deg)} }
        @keyframes cs-orbit2  { from{transform:rotate(120deg) translateX(52px) rotate(-120deg)} to{transform:rotate(480deg) translateX(52px) rotate(-480deg)} }
        @keyframes cs-orbit3  { from{transform:rotate(240deg) translateX(28px) rotate(-240deg)} to{transform:rotate(600deg) translateX(28px) rotate(-600deg)} }
        @keyframes cs-glow    { 0%,100%{box-shadow:0 0 20px rgba(0,200,255,0.15)} 50%{box-shadow:0 0 40px rgba(0,200,255,0.3)} }
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
              borderRadius: '50%', border: `1px solid rgba(0,180,255,${0.08 + i * 0.03})`,
            }} />
          ))}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ position: 'relative', width: 0, height: 0 }}>
              <div style={{ position: 'absolute', width: 5, height: 5, borderRadius: '50%', background: '#00c8ff', boxShadow: '0 0 6px rgba(0,200,255,0.8)', animation: 'cs-orbit 4s linear infinite', marginTop: -2.5, marginLeft: -2.5 }} />
              <div style={{ position: 'absolute', width: 3.5, height: 3.5, borderRadius: '50%', background: '#00ff9d', boxShadow: '0 0 5px rgba(0,255,157,0.7)', animation: 'cs-orbit2 7s linear infinite', marginTop: -1.75, marginLeft: -1.75 }} />
              <div style={{ position: 'absolute', width: 3, height: 3, borderRadius: '50%', background: '#7b6fff', boxShadow: '0 0 5px rgba(123,111,255,0.7)', animation: 'cs-orbit3 5.5s linear infinite', marginTop: -1.5, marginLeft: -1.5 }} />
            </div>
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ ...mono, fontSize: 'clamp(22px,4vw,30px)', letterSpacing: '0.45em', color: 'rgba(0,200,255,0.9)', margin: '0 0 6px', animation: 'cs-flicker 5s ease-in-out infinite' }}>
            PHOBOS
          </h1>
          <div style={{ height: 1, background: 'linear-gradient(to right, transparent, rgba(0,200,255,0.25), transparent)', marginBottom: 10 }} />
          <p style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.25em', margin: 0 }}>
            {coreReachable
              ? 'TRI-BRAINED AI SYSTEM — INITIALIZING'
              : 'TRI-BRAINED AI SYSTEM — CORE NOT RUNNING'}
          </p>
        </div>

        {/* Boot progress panel — shown when core is reachable but not yet ready */}
        {coreReachable && bootState && bootState.phase !== 'ready' && (
          bootState.phase === 'services_wait'
            ? renderServicesWait()
            : renderBootProgress()
        )}

        {/* Install guide — shown when core is not reachable at all */}
        {!coreReachable && (
          <>
            <div style={{ width: '100%', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(0,200,255,0.12)', padding: '24px 26px', marginBottom: 24, boxSizing: 'border-box' }}>
              <p style={{ ...mono, fontSize: 10, color: 'rgba(0,200,255,0.45)', letterSpacing: '0.2em', marginBottom: 14 }}>
                // QUICK SETUP
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7, marginBottom: 10 }}>
                <strong style={{ color: '#fff' }}>PHOBOS runs AI on your computer</strong>, not the cloud. You need <strong style={{ color: 'rgba(0,200,255,0.85)' }}>phobos-core</strong> running locally first.
              </p>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.75, margin: 0 }}>
                Download the launcher, and run <code style={{ color: 'rgba(0,200,255,0.7)', background: 'rgba(0,200,255,0.07)', padding: '1px 5px' }}>phobos-core</code>. Then come back here — PHOBOS connects automatically.
              </p>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
              {[
                { n: '1', text: 'Download phobos-core below' },
                { n: '2', text: 'Install the Launcher' },
                { n: '3', text: 'Return here — connection is automatic' },
              ].map(step => (
                <div key={step.n} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ ...mono, fontSize: 10, color: 'rgba(0,200,255,0.7)', border: '1px solid rgba(0,200,255,0.2)', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderRadius: 2 }}>
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
                  background: 'linear-gradient(135deg, rgba(0,200,255,0.18) 0%, rgba(0,140,255,0.12) 100%)',
                  border: '1px solid rgba(0,200,255,0.5)',
                  color: 'rgba(0,220,255,0.95)',
                  ...mono, fontSize: 12, letterSpacing: '0.18em',
                  padding: '13px 32px', cursor: 'pointer',
                  marginBottom: 10, width: '100%', justifyContent: 'center',
                  transition: 'all 180ms',
                  animation: 'cs-glow 3s ease-in-out infinite',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,200,255,0.2)'; e.currentTarget.style.borderColor = 'rgba(0,220,255,0.8)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,200,255,0.18) 0%, rgba(0,140,255,0.12) 100%)'; e.currentTarget.style.borderColor = 'rgba(0,200,255,0.5)'; }}
              >
                <Download size={14} />
                {PLATFORM_CONFIG[platform].label}
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', background: 'rgba(0,200,255,0.04)', border: '1px solid rgba(0,200,255,0.2)', padding: '16px 24px', marginBottom: 10, width: '100%', boxSizing: 'border-box' }}>
                <p style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.1em', margin: 0 }}>
                  Download phobos-core for {platform.charAt(0).toUpperCase() + platform.slice(1)}?
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={handleConfirm} style={{ ...mono, fontSize: 11, letterSpacing: '0.12em', padding: '8px 20px', background: 'rgba(0,200,255,0.15)', border: '1px solid rgba(0,200,255,0.4)', color: 'rgba(0,220,255,0.9)', cursor: 'pointer', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,200,255,0.25)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,200,255,0.15)'; }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,200,255,0.12)', padding: 6, marginBottom: 14, width: '100%', boxSizing: 'border-box' }}>
                {(Object.keys(PLATFORM_CONFIG) as Platform[]).map((plat) => (
                  <button key={plat} onClick={() => handleOtherPlatform(plat)}
                    style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.1em', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 8px', textAlign: 'left', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,200,255,0.08)'; e.currentTarget.style.color = 'rgba(0,200,255,0.75)'; }}
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
            background: coreReachable ? 'rgba(0,255,157,0.6)' : 'rgba(0,180,255,0.5)',
            display: 'inline-block',
            animation: 'cs-flicker 2s ease-in-out infinite',
          }} />
          <span style={{ ...mono, fontSize: 9, color: coreReachable ? 'rgba(0,255,157,0.45)' : 'rgba(0,180,255,0.35)', letterSpacing: '0.15em' }}>
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
