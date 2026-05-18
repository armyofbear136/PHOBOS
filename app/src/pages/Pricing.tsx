import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';

// ─── Payment flow config ─────────────────────────────────────────────────────
const PAYMENTS_LIVE   = true;
const PAYPAL_URL      = 'https://www.paypal.com/ncp/payment/5MBTEFSMKUR74';
const AUTARCH_API_BASE = '';  // same-origin

const SESSION_USERNAME_KEY = 'phobos_pending_username';

type FlowState = 'idle' | 'auto_activating' | 'needs_tx' | 'validating' | 'success' | 'error';

interface LicenseFlowProps {
  context: 'web';
  onSuccess?: () => void;
}

function LicenseFlow({ onSuccess }: LicenseFlowProps) {
  const [state, setState]               = useState<FlowState>('idle');
  const [username, setUsername]         = useState('');
  const [txId, setTxId]                 = useState('');
  const [errorMsg, setErrorMsg]         = useState('');
  const [licenseKey, setLicenseKey]     = useState('');
  const [activatedUsername, setActivatedUsername] = useState('');
  const autoFired = useRef(false);

  const mono: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };

  // On mount: check if PayPal has returned us with ?tx=...&st=COMPLETED
  useEffect(() => {
    if (autoFired.current) return;
    const params      = new URLSearchParams(window.location.search);
    const returnTx    = params.get('tx');
    const returnSt    = params.get('st');
    const returnAmt   = params.get('amt');
    const storedName  = sessionStorage.getItem(SESSION_USERNAME_KEY);

    if (returnTx && returnSt === 'COMPLETED' && storedName) {
      autoFired.current = true;
      // Clean the URL so a refresh doesn't re-fire
      window.history.replaceState({}, '', window.location.pathname);
      sessionStorage.removeItem(SESSION_USERNAME_KEY);
      setUsername(storedName);
      setTxId(returnTx);
      void activate(returnTx, storedName, returnAmt ?? undefined);
    } else if (returnTx && returnSt === 'COMPLETED' && !storedName) {
      // Returned from PayPal but username was lost (e.g. different browser) — show TX field pre-filled
      autoFired.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      setTxId(returnTx);
      setState('needs_tx');
    }
  }, []);

  const activate = async (tx: string, name: string, amt?: string) => {
    setState('auto_activating');
    setErrorMsg('');
    try {
      const res = await fetch(`${AUTARCH_API_BASE}/api/license/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: tx.trim(), username: name.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).reason ?? 'invalid');
      }
      const data = await res.json() as { valid: boolean; key?: string; username?: string };
      if (!data.valid || !data.key) throw new Error('invalid');
      setLicenseKey(data.key);
      setActivatedUsername(data.username || name.trim());
      setState('success');
      onSuccess?.();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      if (reason === 'insufficient_amount') {
        setErrorMsg('A minimum payment of $19.99 is required for a PHOBOS certificate. Thank you for your contribution.');
      } else if (reason === 'transaction_not_found' || reason === 'invalid') {
        setErrorMsg('Transaction not found. This may take a few minutes — try again shortly, or paste your TX ID below.');
      } else {
        setErrorMsg('Activation failed. Please paste your Transaction ID to try again.');
      }
      setState('needs_tx');
    }
  };

  const handlePayPalClick = () => {
    if (!username.trim()) return;
    sessionStorage.setItem(SESSION_USERNAME_KEY, username.trim());
    // Same-tab navigation so sessionStorage survives
    window.location.href = PAYPAL_URL;
  };

  const handleManualActivate = () => {
    if (!txId.trim() || !username.trim()) return;
    void activate(txId.trim(), username.trim());
  };

  const handleDownload = () => {
    const date = new Date().toISOString().split('T')[0];
    const content = [
      '# PHOBOS License Key',
      '# Place this file at: ~/.phobos/license.key',
      '# Do not share this file.',
      `# Generated: ${date}`,
      `# Transaction: ${txId.trim().toUpperCase()}`,
      `# Username: ${activatedUsername}`,
      '',
      licenseKey,
      '',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'license.key'; a.click();
    URL.revokeObjectURL(url);
  };

  // ── DISABLED ──────────────────────────────────────────────────────────────
  if (!PAYMENTS_LIVE) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ ...mono, display: 'inline-block', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', padding: '14px 32px', fontSize: 13, letterSpacing: '0.15em', color: 'rgba(255,255,255,0.25)', cursor: 'not-allowed' }}>
          COMING SOON
        </div>
        <p style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.12em', marginTop: 12 }}>
          // payment system launching soon — $19.99 one-time
        </p>
      </div>
    );
  }

  // ── AUTO-ACTIVATING (PayPal just returned) ────────────────────────────────
  if (state === 'auto_activating') {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <p style={{ ...mono, fontSize: 11, color: 'rgba(0,255,65,0.6)', letterSpacing: '0.2em', marginBottom: 16 }}>
          ◈ PAYMENT RECEIVED — ACTIVATING LICENSE...
        </p>
        <div style={{ width: 200, height: 1, background: 'linear-gradient(to right, transparent, rgba(0,255,65,0.5), transparent)', margin: '0 auto', animation: 'shimmer 1.5s ease-in-out infinite' }} />
        <style>{`@keyframes shimmer { 0%,100%{opacity:0.3} 50%{opacity:1} }`}</style>
      </div>
    );
  }

  // ── IDLE: username entry + pay button ─────────────────────────────────────
  if (state === 'idle') {
    const ready = username.trim().length > 0;
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', marginBottom: 6 }}>
            CHOOSE YOUR DISPLAY NAME
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value.slice(0, 64))}
            placeholder="e.g. TwinSunDev"
            style={{ width: '100%', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.2)', padding: '10px 14px', ...mono, fontSize: 13, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
            onFocus={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.5)')}
            onBlur={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.2)')}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) handlePayPalClick(); }}
          />
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', marginTop: 6 }}>
            // this name will appear in your PHOBOS header and the patron list
          </p>
        </div>
        <button
          onClick={handlePayPalClick}
          disabled={!ready}
          style={{ background: ready ? '#0070ba' : 'rgba(255,255,255,0.05)', color: ready ? '#fff' : 'rgba(255,255,255,0.2)', border: 'none', padding: '14px 36px', fontSize: 14, fontWeight: 700, cursor: ready ? 'pointer' : 'not-allowed', borderRadius: 4, letterSpacing: '0.05em', transition: 'background 150ms', width: '100%' }}
          onMouseEnter={(e) => { if (ready) e.currentTarget.style.background = '#005ea6'; }}
          onMouseLeave={(e) => { if (ready) e.currentTarget.style.background = '#0070ba'; }}
        >
          Pay $19.99 with PayPal
        </button>
        <p style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', marginTop: 12, textAlign: 'center' }}>
          // you will be redirected to paypal — license activates automatically on return
        </p>
      </div>
    );
  }

  // ── NEEDS_TX: fallback — username was lost or auto-activate failed ─────────
  if (state === 'needs_tx' || state === 'error') {
    const ready = txId.trim().length > 0 && username.trim().length > 0;
    return (
      <div>
        {errorMsg && (
          <p style={{ ...mono, fontSize: 11, color: 'rgba(255,180,0,0.7)', marginBottom: 16, letterSpacing: '0.08em' }}>
            ⚠ {errorMsg}
          </p>
        )}
        {!username.trim() && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', marginBottom: 6 }}>DISPLAY NAME</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.slice(0, 64))}
              placeholder="e.g. TwinSunDev"
              style={{ width: '100%', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.2)', padding: '10px 14px', ...mono, fontSize: 13, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.2)')}
            />
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', ...mono, fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', marginBottom: 6 }}>PAYPAL TRANSACTION ID</label>
          <input
            type="text"
            value={txId}
            onChange={(e) => setTxId(e.target.value)}
            placeholder="e.g. 6H534114S3231190B"
            style={{ width: '100%', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.2)', padding: '10px 14px', ...mono, fontSize: 13, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
            onFocus={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.5)')}
            onBlur={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.2)')}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready) handleManualActivate(); }}
          />
          <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', marginTop: 6 }}>
            // found in your paypal confirmation email
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleManualActivate}
            disabled={!ready}
            style={{ flex: 1, background: ready ? '#00ff41' : 'rgba(255,255,255,0.05)', color: ready ? '#000' : 'rgba(255,255,255,0.2)', border: 'none', padding: '12px', ...mono, fontSize: 12, letterSpacing: '0.15em', cursor: ready ? 'pointer' : 'not-allowed', transition: 'all 150ms' }}
            onMouseEnter={(e) => { if (ready) e.currentTarget.style.background = '#00cc33'; }}
            onMouseLeave={(e) => { if (ready) e.currentTarget.style.background = '#00ff41'; }}
          >
            ACTIVATE LICENSE
          </button>
          <button
            onClick={() => { setState('idle'); setErrorMsg(''); setTxId(''); }}
            style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.4)', padding: '12px 16px', ...mono, fontSize: 11, cursor: 'pointer' }}
          >
            BACK
          </button>
        </div>
      </div>
    );
  }

  // ── VALIDATING ────────────────────────────────────────────────────────────
  if (state === 'validating') {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <p style={{ ...mono, fontSize: 12, color: 'rgba(0,255,65,0.6)', letterSpacing: '0.2em' }}>◈ ACTIVATING...</p>
        <div style={{ marginTop: 16, width: 200, height: 1, background: 'linear-gradient(to right, transparent, rgba(0,255,65,0.5), transparent)', margin: '16px auto 0', animation: 'shimmer 1.5s ease-in-out infinite' }} />
        <style>{`@keyframes shimmer { 0%,100%{opacity:0.3} 50%{opacity:1} }`}</style>
      </div>
    );
  }

  // ── SUCCESS ───────────────────────────────────────────────────────────────
  if (state === 'success') {
    return (
      <div>
        <p style={{ ...mono, fontSize: 12, color: '#00ff41', letterSpacing: '0.15em', marginBottom: 16 }}>
          ✓ LICENSE ACTIVATED — WELCOME, {activatedUsername.toUpperCase()}
        </p>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.6)', marginBottom: 8, lineHeight: 1.7 }}>
          Your license key is ready. Download <strong style={{ color: '#fff' }}>license.key</strong> and place it in the <strong style={{ color: '#fff' }}>~/.phobos/</strong> folder. Your display name will appear in the PHOBOS header.
        </p>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.35)', marginBottom: 24, lineHeight: 1.6 }}>
          On Windows: <span style={{ ...mono, color: 'rgba(255,255,255,0.5)' }}>C:\Users\YourName\.phobos\license.key</span><br />
          On Mac/Linux: <span style={{ ...mono, color: 'rgba(255,255,255,0.5)' }}>~/.phobos/license.key</span>
        </p>
        <button
          onClick={handleDownload}
          style={{ background: '#00ff41', color: '#000', border: 'none', padding: '14px 36px', ...mono, fontSize: 13, letterSpacing: '0.15em', cursor: 'pointer', width: '100%', transition: 'background 150ms' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '#00ff41')}
        >
          ↓ DOWNLOAD license.key
        </button>
        <p style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', marginTop: 12, textAlign: 'center' }}>
          // restart phobos after placing the file
        </p>
      </div>
    );
  }

  return null;
}

// ─── Open Source Credits reel ─────────────────────────────────────────────────

type CreditEntry = { name: string; license: string; url: string; note?: string };
type CreditGroup = { heading: string; color: string; projects: CreditEntry[] };

const CREDIT_GROUPS: CreditGroup[] = [
  {
    heading: 'DESIGN INSPIRATIONS',
    color: 'rgba(255,215,0,0.7)',
    projects: [
      { name: 'MemPalace', license: 'MIT', url: 'https://github.com/MemPalace/mempalace', note: 'The Archive system\'s palace/wing/room/drawer memory architecture is directly inspired by MemPalace — the best-benchmarked local AI memory system in existence.' },
      { name: 'Alda (alda-lang)', license: 'EPL 2.0', url: 'https://github.com/alda-lang/alda', note: 'The PHOBOS ALDA parser implements the Alda music notation language spec by Dave Yarwood. Clean-room TypeScript implementation — no Alda source linked.' },
      { name: 'Efflux Tracker', license: 'MIT', url: 'https://github.com/igorski/efflux-tracker', note: 'The Crystal Engine DAW UI is a React port of Efflux Tracker by Igor Zinken. Full attribution preserved per MIT terms.' },
    ],
  },
  {
    heading: 'UI FRAMEWORK',
    color: 'rgba(0,255,65,0.6)',
    projects: [
      { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
      { name: 'React Router', license: 'MIT', url: 'https://github.com/remix-run/react-router' },
      { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
      { name: 'TypeScript', license: 'Apache 2.0', url: 'https://github.com/microsoft/TypeScript' },
    ],
  },
  {
    heading: 'COMPONENT LIBRARY',
    color: 'rgba(0,200,255,0.6)',
    projects: [
      { name: 'Radix UI', license: 'MIT', url: 'https://github.com/radix-ui/primitives' },
      { name: 'shadcn/ui', license: 'MIT', url: 'https://github.com/shadcn-ui/ui' },
      { name: 'Tailwind CSS', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
      { name: 'Lucide React', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
      { name: 'Monaco Editor', license: 'MIT', url: 'https://github.com/microsoft/monaco-editor' },
      { name: 'TipTap', license: 'MIT', url: 'https://github.com/ueberdosis/tiptap' },
      { name: 'Zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
      { name: 'TanStack Query', license: 'MIT', url: 'https://github.com/TanStack/query' },
      { name: 'Zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
      { name: 'Phaser', license: 'MIT', url: 'https://github.com/phaserjs/phaser' },
      { name: 'Recharts', license: 'MIT', url: 'https://github.com/recharts/recharts' },
      { name: 'react-hook-form', license: 'MIT', url: 'https://github.com/react-hook-form/react-hook-form' },
      { name: 'embla-carousel', license: 'MIT', url: 'https://github.com/davidjerleke/embla-carousel' },
      { name: 'cmdk', license: 'MIT', url: 'https://github.com/pacocoursey/cmdk' },
      { name: 'vaul', license: 'MIT', url: 'https://github.com/emilkowalski/vaul' },
      { name: 'sonner', license: 'MIT', url: 'https://github.com/emilkowalski/sonner' },
      { name: 'date-fns', license: 'MIT', url: 'https://github.com/date-fns/date-fns' },
    ],
  },
  {
    heading: 'EDITOR & CONTENT',
    color: 'rgba(255,200,0,0.6)',
    projects: [
      { name: 'react-markdown', license: 'MIT', url: 'https://github.com/remarkjs/react-markdown' },
      { name: 'remark-gfm', license: 'MIT', url: 'https://github.com/remarkjs/remark-gfm' },
      { name: 'highlight.js', license: 'BSD 3-Clause', url: 'https://github.com/highlightjs/highlight.js' },
      { name: 'wasm-pandoc', license: 'MIT', url: 'https://github.com/NikolaiT/wasm-pandoc' },
    ],
  },
  {
    heading: 'BACKEND & RUNTIME',
    color: 'rgba(0,200,150,0.6)',
    projects: [
      { name: 'Node.js', license: 'MIT', url: 'https://github.com/nodejs/node' },
      { name: 'Fastify', license: 'MIT', url: 'https://github.com/fastify/fastify' },
      { name: 'DuckDB', license: 'MIT', url: 'https://github.com/duckdb/duckdb' },
      { name: 'OpenAI Node SDK', license: 'Apache 2.0', url: 'https://github.com/openai/openai-node' },
      { name: 'sharp', license: 'Apache 2.0', url: 'https://github.com/lovell/sharp', note: 'Image thumbnailing for Meridian' },
      { name: 'exifr', license: 'MIT', url: 'https://github.com/MikeKovarik/exifr', note: 'EXIF metadata for Meridian' },
      { name: 'fluent-ffmpeg', license: 'MIT', url: 'https://github.com/fluent-ffmpeg/node-fluent-ffmpeg' },
      { name: 'mammoth', license: 'BSD 2-Clause', url: 'https://github.com/mwilliamson/mammoth.js' },
      { name: 'pdfjs-dist', license: 'Apache 2.0', url: 'https://github.com/mozilla/pdf.js' },
      { name: 'SheetJS', license: 'Apache 2.0', url: 'https://github.com/SheetJS/sheetjs' },
      { name: 'tree-sitter', license: 'MIT', url: 'https://github.com/tree-sitter/tree-sitter', note: 'AST parsing for code security scanner' },
      { name: 'adm-zip', license: 'MIT', url: 'https://github.com/cthackers/adm-zip' },
      { name: 'bcryptjs', license: 'MIT', url: 'https://github.com/dcodeIO/bcrypt.js' },
      { name: 'node-html-parser', license: 'MIT', url: 'https://github.com/taoqf/node-html-parser' },
    ],
  },
  {
    heading: 'ML & INFERENCE',
    color: 'rgba(255,150,0,0.6)',
    projects: [
      { name: 'llama.cpp', license: 'MIT', url: 'https://github.com/ggerganov/llama.cpp' },
      { name: 'stable-diffusion.cpp', license: 'MIT', url: 'https://github.com/leejet/stable-diffusion.cpp' },
      { name: 'Whisper.cpp', license: 'MIT', url: 'https://github.com/ggerganov/whisper.cpp' },
      { name: 'nomic-embed-text-v1.5', license: 'Apache 2.0', url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5' },
      { name: '@xenova/transformers', license: 'Apache 2.0', url: 'https://github.com/xenova/transformers.js' },
      { name: 'onnxruntime-node', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime' },
    ],
  },
  {
    heading: 'AI MODELS',
    color: 'rgba(180,180,255,0.7)',
    projects: [
      { name: 'Wan 2.2', license: 'Apache 2.0', url: 'https://github.com/Wan-Video/Wan2.1', note: 'Video generation' },
      { name: 'ACE-Step 1.5 XL', license: 'Apache 2.0', url: 'https://github.com/ace-step/ACE-Step', note: 'Music generation' },
      { name: 'VoxCPM2', license: 'Apache 2.0', url: 'https://github.com/VOICEVOX/voicevox_core', note: 'Text-to-speech' },
      { name: 'Stable Audio Open', license: 'Stability AI', url: 'https://huggingface.co/stabilityai/stable-audio-open-1.0', note: 'SFX — non-commercial per license' },
      { name: 'Netflix VOID', license: 'Apache 2.0', url: 'https://github.com/netflix/void', note: 'Video inpainting' },
    ],
  },
  {
    heading: 'MEDIA SERVERS',
    color: 'rgba(0,180,255,0.6)',
    projects: [
      { name: 'Jellyfin', license: 'LGPL 2.1', url: 'https://github.com/jellyfin/jellyfin', note: 'Video library — independent subprocess' },
      { name: 'Kavita', license: 'GPL 3.0', url: 'https://github.com/Kareadita/Kavita', note: 'Manga/books — independent subprocess' },
      { name: 'Polaris', license: 'MIT', url: 'https://github.com/agersant/polaris', note: 'Music server — independent subprocess' },
      { name: 'mpv', license: 'GPL 2.0+', url: 'https://github.com/mpv-player/mpv', note: 'IPTV/video player subprocess' },
    ],
  },
  {
    heading: '3D EDITORS',
    color: 'rgba(100,220,180,0.6)',
    projects: [
      { name: 'Blockbench', license: 'GPL 3.0', url: 'https://github.com/JannisX11/blockbench', note: '3D modeling — self-hosted static WASM' },
      { name: 'SculptGL', license: 'MIT', url: 'https://github.com/stephaneginier/sculptgl', note: 'Clay sculpting — self-hosted' },
      { name: 'Godot 4 Web Editor', license: 'MIT', url: 'https://github.com/godotengine/godot', note: 'Scene/game engine — official web build' },
    ],
  },
  {
    heading: 'EXTERNAL TOOLS',
    color: 'rgba(160,160,160,0.6)',
    projects: [
      { name: 'Helm Synthesizer', license: 'GPL 3.0', url: 'https://github.com/mtytel/helm', note: 'VST3 inside PhobosHost' },
      { name: 'Surge XT', license: 'GPL 3.0', url: 'https://github.com/surge-synthesizer/surge', note: 'VST3 inside PhobosHost' },
      { name: 'GIMP', license: 'GPL 3.0', url: 'https://gitlab.gnome.org/GNOME/gimp', note: 'Subprocess via Broadway/GTK3' },
      { name: 'GTK3 / Broadway', license: 'LGPL 2.1', url: 'https://gitlab.gnome.org/GNOME/gtk', note: 'Browser GTK rendering for GIMP' },
      { name: 'Pandoc', license: 'GPL 2.0', url: 'https://github.com/jgm/pandoc', note: 'Document conversion subprocess' },
      { name: 'ClamAV', license: 'GPL 2.0', url: 'https://github.com/Cisco-Talos/clamav', note: 'Optional malware scanning' },
      { name: 'Camofox Browser', license: 'MPL 2.0', url: 'https://github.com/nickvdyck/webbundle', note: 'Independent subprocess' },
      { name: 'Stirling-PDF', license: 'MIT', url: 'https://github.com/Stirling-Tools/Stirling-PDF', note: 'Independent subprocess' },
    ],
  },
];

const LICENSE_COLOR: Record<string, { bg: string; fg: string }> = {
  MIT:          { bg: 'rgba(0,255,65,0.12)',    fg: 'rgba(0,255,65,0.8)'    },
  ISC:          { bg: 'rgba(0,255,65,0.12)',    fg: 'rgba(0,255,65,0.8)'    },
  'Apache 2.0': { bg: 'rgba(78,184,224,0.12)',  fg: 'rgba(78,184,224,0.85)' },
  'BSD 2-Clause':{ bg: 'rgba(245,158,11,0.12)', fg: 'rgba(245,158,11,0.8)' },
  'BSD 3-Clause':{ bg: 'rgba(245,158,11,0.12)', fg: 'rgba(245,158,11,0.8)' },
  'GPL 2.0':    { bg: 'rgba(255,100,100,0.12)', fg: 'rgba(255,120,120,0.85)' },
  'GPL 2.0+':   { bg: 'rgba(255,100,100,0.12)', fg: 'rgba(255,120,120,0.85)' },
  'GPL 3.0':    { bg: 'rgba(255,100,100,0.12)', fg: 'rgba(255,120,120,0.85)' },
  'LGPL 2.1':   { bg: 'rgba(255,160,80,0.12)',  fg: 'rgba(255,175,100,0.85)' },
  'MPL 2.0':    { bg: 'rgba(180,100,255,0.12)', fg: 'rgba(195,130,255,0.85)' },
  'EPL 2.0':    { bg: 'rgba(255,150,50,0.12)',  fg: 'rgba(255,165,70,0.85)'  },
};

function licenseBadgeStyle(license: string): React.CSSProperties {
  const c = LICENSE_COLOR[license] ?? { bg: 'rgba(200,200,200,0.1)', fg: 'rgba(200,200,200,0.55)' };
  return {
    display: 'inline-block',
    background: c.bg,
    color: c.fg,
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 9,
    letterSpacing: '0.08em',
    padding: '2px 6px',
    borderRadius: 2,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  };
}

function OpenSourceCredits({ mono }: { mono: React.CSSProperties }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const animRef  = useRef<number>(0);
  const posRef   = useRef(0);
  const pausedRef = useRef(false);
  const SPEED = 0.6; // px per frame

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const step = () => {
      if (!pausedRef.current) {
        posRef.current += SPEED;
        // reset when first half scrolled through (duplicate creates seamless loop)
        const half = track.scrollHeight / 2;
        if (posRef.current >= half) posRef.current -= half;
        track.style.transform = `translateY(-${posRef.current}px)`;
      }
      animRef.current = requestAnimationFrame(step);
    };

    animRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  // Build flat rows from all groups — doubled for seamless loop
  const rows: React.ReactNode[] = [];
  const buildRows = (forLoop: boolean) => {
    CREDIT_GROUPS.forEach((group) => {
      // Group heading
      rows.push(
        <div key={`${group.heading}${forLoop ? '-b' : ''}`} style={{ padding: '14px 0 6px', borderTop: forLoop || rows.length > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
          <span style={{ ...mono, fontSize: 9, letterSpacing: '0.22em', color: group.color, textTransform: 'uppercase' as const }}>
            // {group.heading}
          </span>
        </div>
      );
      // Project rows
      group.projects.forEach((p) => {
        rows.push(
          <a
            key={`${p.name}${forLoop ? '-b' : ''}`}
            href={p.url}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 0', textDecoration: 'none', cursor: 'pointer' }}
            onMouseEnter={() => { pausedRef.current = true; }}
            onMouseLeave={() => { pausedRef.current = false; }}
          >
            <span style={{ ...mono, fontSize: 12, color: 'rgba(255,255,255,0.82)', flex: 1, minWidth: 0, lineHeight: 1.4 }}>
              {p.name}
              {p.note && (
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.28)', marginLeft: 8, fontStyle: 'italic' }}>
                  — {p.note}
                </span>
              )}
            </span>
            <span style={licenseBadgeStyle(p.license)}>{p.license}</span>
          </a>
        );
      });
    });
  };

  buildRows(false);
  buildRows(true); // duplicate for seamless loop

  return (
    <div style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.08)', padding: '36px 32px', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>

      {/* Top accent line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(to right, transparent, rgba(255,215,0,0.5), transparent)' }} />

      {/* Corner accents */}
      <div style={{ position: 'absolute', top: 0, right: 0, width: 20, height: 20, borderTop: '1px solid rgba(255,215,0,0.3)', borderRight: '1px solid rgba(255,215,0,0.3)' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, width: 20, height: 20, borderBottom: '1px solid rgba(255,215,0,0.3)', borderLeft: '1px solid rgba(255,215,0,0.3)' }} />

      {/* Header */}
      <div style={{ marginBottom: 24, flexShrink: 0 }}>
        <p style={{ ...mono, fontSize: 9, color: 'rgba(255,215,0,0.5)', letterSpacing: '0.22em', textTransform: 'uppercase', marginBottom: 10 }}>
          // open source credits
        </p>
        <p style={{ ...mono, fontSize: 16, color: '#fff', lineHeight: 1.25, marginBottom: 6 }}>
          Support the projects
        </p>
        <p style={{ ...mono, fontSize: 16, color: 'rgba(255,215,0,0.85)', lineHeight: 1.25, marginBottom: 14 }}>
          that make PHOBOS possible.
        </p>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: 'rgba(255,255,255,0.3)', lineHeight: 1.6 }}>
          Every project below is free and open source. If PHOBOS is useful to you, consider starring or sponsoring the work that made it real.
        </p>
      </div>

      {/* Fade masks top and bottom */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 130, height: 32, background: 'linear-gradient(to bottom, rgba(5,5,8,0.85), transparent)', zIndex: 2, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 64, background: 'linear-gradient(to top, rgba(5,5,8,0.95), transparent)', zIndex: 2, pointerEvents: 'none' }} />

      {/* Scrolling track */}
      <div style={{ flex: 1, overflow: 'hidden', height: 420, position: 'relative' }}>
        <div
          ref={trackRef}
          style={{ willChange: 'transform', padding: '0 4px' }}
          onMouseEnter={() => { pausedRef.current = true; }}
          onMouseLeave={() => { pausedRef.current = false; }}
        >
          {rows}
        </div>
      </div>

      {/* Footer hint */}
      <p style={{ ...mono, fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.12em', marginTop: 16, textAlign: 'center', flexShrink: 0, zIndex: 3, position: 'relative' }}>
        // hover to pause · click any project to visit
      </p>
    </div>
  );
}

// ─── Main Pricing page ────────────────────────────────────────────────────────
export default function Pricing() {
  const mono: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };

  return (
    <MarketingLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '120px 24px 96px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 80 }}>
          <p style={{ ...mono, fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', textTransform: 'uppercase', marginBottom: 20 }}>
            // autarch industries — become a supporter
          </p>
          <h1 style={{ ...mono, fontSize: 'clamp(36px, 6vw, 72px)', fontWeight: 700, lineHeight: 0.95, color: '#fff', marginBottom: 8 }}>
            One payment.
          </h1>
          <h1 style={{ ...mono, fontSize: 'clamp(36px, 6vw, 72px)', fontWeight: 700, lineHeight: 0.95, color: '#00ff41', marginBottom: 28 }}>
            Forever.
          </h1>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 17, color: 'rgba(255,255,255,0.5)', maxWidth: 560, margin: '0 auto', lineHeight: 1.7 }}>
            PHOBOS runs as trialware with no feature limitations. When you're ready to commit, a single $19.99 payment unlocks your PHOBOS Certificate — permanent supporter status.
          </p>
        </div>

        {/* Pricing grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 2, maxWidth: 800, margin: '0 auto 80px' }}>

          {/* Individual certificate card */}
          <div style={{ background: 'rgba(0,255,65,0.03)', border: '1px solid rgba(0,255,65,0.2)', padding: '40px 36px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: -1, left: 0, right: 0, height: 2, background: 'linear-gradient(to right, transparent, #00ff41, transparent)' }} />
            <p style={{ ...mono, fontSize: 10, color: 'rgba(0,255,65,0.5)', letterSpacing: '0.2em', marginBottom: 16 }}>PHOBOS CERTIFICATE</p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 32 }}>
              <span style={{ ...mono, fontSize: 52, color: '#00ff41', lineHeight: 1 }}>$19.99</span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'rgba(255,255,255,0.35)' }}>one-time</span>
            </div>
            {[
              'Custom username display in the PHOBOS application header',
              'Permanent inclusion in the application\'s Patrons List',
              'Cryptographic signature on Auvera.ink plugins — password-less editing',
              'All PHOBOS features — no restrictions',
              'Every future update included',
              'Perpetual certificate — no renewals',
              'Works fully offline',
              'Zero data ever sent anywhere',
            ].map((item) => (
              <div key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                <span style={{ ...mono, fontSize: 11, color: '#00ff41', marginTop: 2, flexShrink: 0 }}>✓</span>
                <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>{item}</span>
              </div>
            ))}
            <div style={{ marginTop: 36 }}>
              <LicenseFlow context="web" />
            </div>
          </div>

          {/* Open Source Credits reel */}
          <OpenSourceCredits mono={mono} />
        </div>

        {/* Fine print */}
        <div style={{ maxWidth: 600, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ height: 1, background: 'rgba(0,255,65,0.07)', marginBottom: 40 }} />
          {[
            'Certificate validation requires only a PayPal Transaction ID — no account, no email required.',
            'The certificate file is stored on your machine. No personal data is ever transmitted to our servers.',
            'Supporters receive a cryptographic signature for Auvera.ink plugins, enabling password-less editing and enhanced protection.',
          ].map((text, i) => (
            <p key={i} style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.25)', lineHeight: 1.7, marginBottom: 12 }}>
              {text}
            </p>
          ))}
          <p style={{ ...mono, fontSize: 10, color: 'rgba(0,255,65,0.2)', letterSpacing: '0.1em', marginTop: 24 }}>
            // questions? — <a href="mailto:support@autarchindustries.com" style={{ color: 'rgba(0,255,65,0.35)', textDecoration: 'none' }}>support@autarchindustries.com</a>
          </p>
        </div>

      </div>
    </MarketingLayout>
  );
}