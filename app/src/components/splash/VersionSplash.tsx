import { Download } from 'lucide-react';
import { CLIENT_VERSION } from '@/version';
import type { Platform } from './ConnectionSplash';

const RELEASE_BASE = 'https://github.com/armyofbear136/PHOBOS-LAUNCHER-CROSS-PLATFORM/releases/download/PHOBOS-LAUNCHER-STABLE-RELEASES';

const PLATFORM_CONFIG: Record<Platform, { label: string; file: string }> = {
  windows:      { label: 'DOWNLOAD FOR WINDOWS (.exe)',           file: 'PHOBOS-Launcher-win-x64-Setup.exe' },
  macos:        { label: 'DOWNLOAD FOR MAC (.dmg)',               file: 'PHOBOS-Launcher-macOS-arm64.dmg' },
  linux:        { label: 'DOWNLOAD FOR LINUX x64 (.AppImage)',    file: 'PHOBOS-Launcher-linux-x64.AppImage' },
  'linux-arm64': { label: 'DOWNLOAD FOR LINUX ARM64 (.AppImage)', file: 'PHOBOS-Launcher-linux-arm64.AppImage' },
};

interface Props {
  platform: Platform;
  coreVersion: string;
}

export function VersionSplash({ platform, coreVersion }: Props) {
  const mono: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };

  const getDownloadUrl = (plat: Platform) =>
    `${RELEASE_BASE}/${PLATFORM_CONFIG[plat].file}`;

  const handleDownload = () => {
    window.open(getDownloadUrl(platform), '_blank', 'noopener,noreferrer');
  };

  const handleOtherPlatform = (plat: Platform) => {
    window.open(getDownloadUrl(plat), '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center"
      style={{
        background: '#0f0f0f',
        backgroundImage: `
          repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.012) 2px, rgba(255,255,255,0.012) 4px),
          repeating-linear-gradient(90deg, transparent, transparent 40px, rgba(255,255,255,0.008) 40px, rgba(255,255,255,0.008) 41px)
        `,
      }}
    >
      <style>{`
        @keyframes flicker {
          0%,100% { opacity: 1; }
          92% { opacity: 1; }
          93% { opacity: 0.4; }
          94% { opacity: 1; }
          96% { opacity: 0.6; }
          97% { opacity: 1; }
        }
      `}</style>

      <div className="absolute inset-0 phobos-noise opacity-[0.06] pointer-events-none" />

      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center', maxWidth: 520, padding: '0 32px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <h1
            style={{
              ...mono,
              fontSize: 'clamp(18px, 3.5vw, 28px)',
              letterSpacing: '0.3em',
              color: '#ffaa00',
              marginBottom: 0,
              animation: 'flicker 3s ease-in-out infinite',
            }}
          >
            INVALID VERSION — UPDATE REQUIRED
          </h1>
          <div style={{ height: 1, background: 'linear-gradient(to right, transparent, rgba(255,170,0,0.4), transparent)', marginTop: 10 }} />
        </div>

        {/* Explanation */}
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', padding: '24px 28px', marginBottom: 28, textAlign: 'left', width: '100%', boxSizing: 'border-box' }}>
          <p style={{ ...mono, fontSize: 10, color: 'rgba(255,170,0,0.5)', letterSpacing: '0.2em', marginBottom: 16 }}>
            // WHAT'S GOING ON
          </p>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: 'rgba(255,255,255,0.7)', lineHeight: 1.75, marginBottom: 12 }}>
            <strong style={{ color: '#fff' }}>phobos-core is running</strong>, but the version on your machine is <strong style={{ color: '#ffaa00' }}>out of date</strong> and isn't compatible with this interface.
          </p>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.5)', lineHeight: 1.75 }}>
            Download the latest version below, replace the old one, and restart it. This page will connect automatically once it's running.
          </p>
        </div>

        {/* Version info */}
        <div style={{ width: '100%', display: 'flex', gap: 8, marginBottom: 28, justifyContent: 'center' }}>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', padding: '12px 16px', textAlign: 'center' }}>
            <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em', marginBottom: 6 }}>YOUR VERSION</p>
            <p style={{ ...mono, fontSize: 16, color: '#ff4040' }}>{coreVersion}</p>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,255,65,0.15)', padding: '12px 16px', textAlign: 'center' }}>
            <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em', marginBottom: 6 }}>REQUIRED VERSION</p>
            <p style={{ ...mono, fontSize: 16, color: '#00ff41' }}>{CLIENT_VERSION}</p>
          </div>
        </div>

        {/* Download button */}
        <button
          onClick={handleDownload}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            background: '#ffaa00', color: '#000',
            ...mono, fontSize: 12, letterSpacing: '0.15em',
            padding: '13px 32px', border: 'none', cursor: 'pointer',
            marginBottom: 12,
            transition: 'all 150ms',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#cc8800')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#ffaa00')}
        >
          <Download size={14} />
          {PLATFORM_CONFIG[platform].label}
        </button>

        {/* Other versions */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          background: '#000', border: '1px solid rgba(255,170,0,0.15)',
          padding: 8, marginBottom: 16, width: '100%', boxSizing: 'border-box',
        }}>
          {(Object.keys(PLATFORM_CONFIG) as Platform[])
            .filter(p => p !== platform)
            .map((plat) => (
              <button
                key={plat}
                onClick={() => handleOtherPlatform(plat)}
                style={{
                  ...mono, fontSize: 10, color: 'rgba(255,255,255,0.4)',
                  letterSpacing: '0.1em', background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: '6px 8px',
                  textAlign: 'left', transition: 'all 150ms',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,170,0,0.08)';
                  e.currentTarget.style.color = 'rgba(255,170,0,0.8)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
                }}
              >
                {PLATFORM_CONFIG[plat].label}
              </button>
            ))}
        </div>

        <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.12em', marginTop: 8, lineHeight: 1.6 }}>
          After updating, restart phobos-core on{' '}
          <span style={{ color: 'rgba(255,255,255,0.35)' }}>localhost:3001</span>
          {' '}— this page will reconnect automatically.
        </p>

      </div>
    </div>
  );
}
