import { useState, useEffect } from 'react';
import { X, Download, ExternalLink, Crown } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const PAYMENTS_LIVE = true;
const PAYPAL_URL = 'https://www.paypal.com/ncp/payment/5MBTEFSMKUR74';
const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Props {
  onClose: () => void;
  onLicensed?: () => void;
}

type FlowState = 'idle' | 'awaiting_tx' | 'submitting' | 'success' | 'error';
type Tab = 'purchase' | 'activate' | 'patrons' | 'credits';

interface Patron {
  username: string;
  amount: number;
}

export function LicenseDialog({ onClose, onLicensed }: Props) {
  const [tab, setTab] = useState<Tab>('purchase');
  const [state, setState] = useState<FlowState>('idle');
  const [txId, setTxId] = useState('');
  const [username, setUsername] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [wroteToCore, setWroteToCore] = useState(false);
  const [activatedUsername, setActivatedUsername] = useState('');
  const [patrons, setPatrons] = useState<Patron[]>([]);
  const [patronsLoading, setPatronsLoading] = useState(false);
  const setLicenseUsername = useAppStore((s) => s.setLicenseUsername);

  const mono: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };

  useEffect(() => {
    if (tab !== 'patrons') return;
    setPatronsLoading(true);
    fetch(`${ENGINE_URL}/api/patrons`)
      .then(r => r.ok ? r.json() : { patrons: [] })
      .then((data: { patrons: Patron[] }) => setPatrons(data.patrons ?? []))
      .catch(() => setPatrons([]))
      .finally(() => setPatronsLoading(false));
  }, [tab]);

  const handlePayPalClick = () => {
    window.open(PAYPAL_URL, '_blank', 'noopener,noreferrer');
    setTimeout(() => setTab('activate'), 600);
  };

  const handleActivate = async () => {
    if (!txId.trim() || !username.trim()) return;
    setState('submitting');
    setErrorMsg('');
    try {
      const res = await fetch(`${ENGINE_URL}/api/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: txId.trim(), username: username.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const reason = (body as any).reason ?? 'unknown';
        if (reason === 'insufficient_amount') {
          throw new Error('A minimum payment of $19.99 is required for a PHOBOS certificate. Thank you for your contribution.');
        }
        if (reason === 'license_system_not_configured') {
          throw new Error('The license system is not yet configured. Please check back soon.');
        }
        throw new Error('Transaction ID not recognized. Check your PayPal receipt and try again.');
      }
      const data = await res.json() as { valid: boolean; key?: string; username?: string };
      if (!data.valid || !data.key) {
        throw new Error('Transaction ID not recognized. Check your PayPal receipt and try again.');
      }
      const resolvedName = data.username || username.trim();
      const date = new Date().toISOString().split('T')[0];
      setKeyContent(
        `# PHOBOS License Key\n# Place at: ~/.phobos/license.key\n# Generated: ${date}\n# Transaction: ${txId.trim().toUpperCase()}\n# Username: ${resolvedName}\n\n${data.key}\n`
      );
      setActivatedUsername(resolvedName);
      setWroteToCore(true);
      setState('success');
      setLicenseUsername(resolvedName);
      localStorage.setItem('phobos_licensed', 'true');
      onLicensed?.();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      setState('error');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([keyContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'license.key'; a.click();
    URL.revokeObjectURL(url);
  };

  const canActivate = txId.trim().length > 0 && username.trim().length > 0;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'purchase', label: 'Purchase — $19.99' },
    { id: 'activate', label: 'Activate' },
    { id: 'patrons',  label: 'Patrons' },
    { id: 'credits',  label: 'Open Source' },
  ];

  return (
    <div
      className="fixed inset-0 z-[350] bg-black/90 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 480, maxWidth: '95vw', background: '#000', border: '1px solid rgba(0,255,65,0.2)', boxShadow: '0 0 40px rgba(0,255,65,0.06)', ...mono }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 10, color: 'rgba(0,255,65,0.7)', letterSpacing: '0.2em' }}>◈ PHOBOS PATRONS</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', padding: 4, display: 'flex', alignItems: 'center' }}>
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{ flex: 1, padding: '10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: tab === t.id ? '#00ff41' : 'rgba(255,255,255,0.25)', borderBottom: tab === t.id ? '1px solid rgba(0,255,65,0.4)' : '1px solid transparent', marginBottom: -1, ...mono, transition: 'color 150ms' }}
            >
              {t.id === 'patrons' && <Crown size={9} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle' }} />}
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '24px 20px' }}>

          {/* ── PURCHASE TAB ── */}
          {tab === 'purchase' && (
            !PAYMENTS_LIVE ? (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ display: 'inline-block', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', padding: '12px 28px', fontSize: 12, letterSpacing: '0.15em', color: 'rgba(255,255,255,0.2)', cursor: 'not-allowed' }}>
                  COMING SOON
                </div>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', marginTop: 12 }}>// payment system launching soon</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.65 }}>
                  One payment of <strong style={{ color: '#fff' }}>$19.99</strong> unlocks a perpetual PHOBOS license — every future update included, no renewal required.
                </p>
                <button
                  onClick={handlePayPalClick}
                  style={{ background: '#0070ba', color: '#fff', border: 'none', padding: '13px', fontSize: 14, fontWeight: 700, cursor: 'pointer', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#005ea6')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#0070ba')}
                >
                  <ExternalLink size={14} /> Pay $19.99 with PayPal
                </button>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', textAlign: 'center' }}>// opens paypal — return here and click activate</p>
              </div>
            )
          )}

          {/* ── ACTIVATE TAB ── */}
          {tab === 'activate' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(state === 'idle' || state === 'awaiting_tx' || state === 'error') && (
                <>
                  <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.65 }}>
                    Enter your PayPal Transaction ID and choose a display name. Your name appears in the PHOBOS header and the patron list.
                  </p>

                  <div>
                    <label style={{ display: 'block', fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', marginBottom: 6 }}>DISPLAY NAME</label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.slice(0, 64))}
                      placeholder="e.g. TwinSunDev"
                      style={{ width: '100%', background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(0,255,65,0.2)', padding: '9px 12px', ...mono, fontSize: 12, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
                      onFocus={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.5)')}
                      onBlur={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.2)')}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', marginBottom: 6 }}>PAYPAL TRANSACTION ID</label>
                    <input
                      type="text"
                      value={txId}
                      onChange={(e) => { setTxId(e.target.value); if (state === 'error') setState('awaiting_tx'); }}
                      placeholder="e.g. 5TY12345AB678901C"
                      style={{ width: '100%', background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(0,255,65,0.2)', padding: '9px 12px', ...mono, fontSize: 12, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
                      onFocus={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.5)')}
                      onBlur={(e) => (e.target.style.borderColor = 'rgba(0,255,65,0.2)')}
                      onKeyDown={(e) => { if (e.key === 'Enter' && canActivate) handleActivate(); }}
                    />
                  </div>

                  {state === 'error' && <p style={{ fontSize: 11, color: 'rgba(255,65,65,0.7)' }}>✕ {errorMsg}</p>}

                  <button
                    onClick={handleActivate}
                    disabled={!canActivate}
                    style={{ background: canActivate ? '#00ff41' : 'rgba(255,255,255,0.05)', color: canActivate ? '#000' : 'rgba(255,255,255,0.2)', border: 'none', padding: '11px', ...mono, fontSize: 11, letterSpacing: '0.15em', cursor: canActivate ? 'pointer' : 'not-allowed', transition: 'all 150ms' }}
                    onMouseEnter={(e) => { if (canActivate) e.currentTarget.style.background = '#00cc33'; }}
                    onMouseLeave={(e) => { if (canActivate) e.currentTarget.style.background = '#00ff41'; }}
                  >
                    ACTIVATE LICENSE →
                  </button>
                </>
              )}

              {state === 'submitting' && (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <p style={{ fontSize: 11, color: 'rgba(0,255,65,0.6)', letterSpacing: '0.2em', marginBottom: 12 }}>◈ ACTIVATING...</p>
                  <div style={{ height: 1, background: 'linear-gradient(to right, transparent, rgba(0,255,65,0.5), transparent)', animation: 'shimmer 1.2s ease-in-out infinite' }} />
                  <style>{`@keyframes shimmer{0%,100%{opacity:0.2}50%{opacity:1}}`}</style>
                </div>
              )}

              {state === 'success' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <p style={{ fontSize: 12, color: '#00ff41', letterSpacing: '0.15em' }}>✓ LICENSE ACTIVATED</p>
                  {wroteToCore ? (
                    <div style={{ background: 'rgba(0,255,65,0.05)', border: '1px solid rgba(0,255,65,0.15)', padding: '14px 16px' }}>
                      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.65 }}>
                        Welcome, <strong style={{ color: '#00ff41' }}>{activatedUsername}</strong>. License written to{' '}
                        <strong style={{ color: '#fff' }}>~/.phobos/license.key</strong>. Your name now appears in the PHOBOS header.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.65 }}>
                        Download and place <strong style={{ color: '#fff' }}>license.key</strong> in <strong style={{ color: '#fff' }}>~/.phobos/</strong>, then restart PHOBOS.
                      </p>
                      <button
                        onClick={handleDownload}
                        style={{ background: '#00ff41', color: '#000', border: 'none', padding: '12px', ...mono, fontSize: 11, letterSpacing: '0.15em', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'background 150ms' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = '#00ff41')}
                      >
                        <Download size={13} /> DOWNLOAD license.key
                      </button>
                    </>
                  )}
                  <button onClick={onClose} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.3)', padding: '10px', ...mono, fontSize: 10, letterSpacing: '0.1em', cursor: 'pointer' }}>
                    CLOSE
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── PATRONS TAB ── */}
          {tab === 'patrons' && (
            <div>
              <p style={{ fontSize: 9, color: 'rgba(0,255,65,0.4)', letterSpacing: '0.2em', marginBottom: 16, textTransform: 'uppercase' }}>
                Top Supporters — sorted by contribution
              </p>
              {patronsLoading && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', textAlign: 'center', padding: '24px 0' }}>◈ loading...</p>
              )}
              {!patronsLoading && patrons.length === 0 && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.15)', letterSpacing: '0.1em', textAlign: 'center', padding: '24px 0' }}>
                  // no patrons yet — be the first
                </p>
              )}
              {!patronsLoading && patrons.length > 0 && (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {patrons.map((p, i) => (
                    <div
                      key={`${p.username}-${i}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 9, color: i < 3 ? '#00ff41' : 'rgba(255,255,255,0.2)', width: 20, textAlign: 'right', flexShrink: 0 }}>
                          {i === 0 ? '◈' : i === 1 ? '◇' : i === 2 ? '○' : `${i + 1}.`}
                        </span>
                        <span style={{ fontSize: 12, color: i < 3 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)', ...mono }}>
                          {p.username}
                        </span>
                      </div>
                      {p.amount > 0 && (
                        <span style={{ fontSize: 10, color: 'rgba(0,255,65,0.4)', ...mono }}>
                          ${p.amount.toFixed(2)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', textAlign: 'center' }}>
                <button
                  onClick={() => setTab('purchase')}
                  style={{ background: 'transparent', border: '1px solid rgba(0,255,65,0.2)', color: 'rgba(0,255,65,0.5)', padding: '9px 20px', ...mono, fontSize: 10, letterSpacing: '0.15em', cursor: 'pointer', transition: 'all 150ms' }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(0,255,65,0.5)'; e.currentTarget.style.color = '#00ff41'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(0,255,65,0.2)'; e.currentTarget.style.color = 'rgba(0,255,65,0.5)'; }}
                >
                  BECOME A PATRON →
                </button>
              </div>
            </div>
          )}

          {/* ── CREDITS TAB ── */}
          {tab === 'credits' && (() => {
            type Project = { name: string; license: string; url: string; note?: string };
            type Group = { heading: string; color: string; projects: Project[] };

            const groups: Group[] = [
              {
                heading: 'DESIGN INSPIRATIONS',
                color: 'rgba(255,215,0,0.6)',
                projects: [
                  { name: 'MemPalace', license: 'MIT', url: 'https://github.com/MemPalace/mempalace', note: 'The Archive system — structured palace/wing/room/drawer memory architecture — is directly inspired by MemPalace. The PHOBOS Archive adapts this design to a native DuckDB-backed implementation.' },
                  { name: 'Alda (alda-lang)', license: 'EPL 2.0', url: 'https://github.com/alda-lang/alda', note: 'The PHOBOS ALDA parser implements a subset of the Alda music notation language spec, created by Dave Yarwood. The parser is a clean-room TypeScript implementation — no Alda source code is used or linked.' },
                  { name: 'Efflux Tracker', license: 'MIT', url: 'https://github.com/igorski/efflux-tracker', note: 'The Crystal Engine DAW UI is a React port of Efflux Tracker by Igor Zinken. Full attribution preserved per MIT terms.' },
                ],
              },
              {
                heading: 'UI FRAMEWORK',
                color: 'rgba(0,255,65,0.5)',
                projects: [
                  { name: 'React', license: 'MIT', url: 'https://github.com/facebook/react' },
                  { name: 'React DOM', license: 'MIT', url: 'https://github.com/facebook/react' },
                  { name: 'React Router', license: 'MIT', url: 'https://github.com/remix-run/react-router' },
                  { name: 'Vite', license: 'MIT', url: 'https://github.com/vitejs/vite' },
                  { name: 'TypeScript', license: 'Apache 2.0', url: 'https://github.com/microsoft/TypeScript' },
                ],
              },
              {
                heading: 'COMPONENT LIBRARY',
                color: 'rgba(0,200,255,0.5)',
                projects: [
                  { name: 'Radix UI (Primitives)', license: 'MIT', url: 'https://github.com/radix-ui/primitives' },
                  { name: 'shadcn/ui', license: 'MIT', url: 'https://github.com/shadcn-ui/ui' },
                  { name: 'Lucide React', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
                  { name: 'Tailwind CSS', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
                  { name: 'tailwind-merge', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
                  { name: 'class-variance-authority', license: 'Apache 2.0', url: 'https://github.com/joe-bell/cva' },
                  { name: 'clsx', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
                  { name: 'next-themes', license: 'MIT', url: 'https://github.com/pacocoursey/next-themes' },
                  { name: 'cmdk', license: 'MIT', url: 'https://github.com/pacocoursey/cmdk' },
                  { name: 'vaul', license: 'MIT', url: 'https://github.com/emilkowalski/vaul' },
                  { name: 'sonner', license: 'MIT', url: 'https://github.com/emilkowalski/sonner' },
                  { name: 'embla-carousel-react', license: 'MIT', url: 'https://github.com/davidjerleke/embla-carousel' },
                  { name: 'input-otp', license: 'MIT', url: 'https://github.com/guilhermerodz/input-otp' },
                  { name: 'react-resizable-panels', license: 'MIT', url: 'https://github.com/bvaughn/react-resizable-panels' },
                  { name: 'react-day-picker', license: 'MIT', url: 'https://github.com/gpbl/react-day-picker' },
                  { name: 'recharts', license: 'MIT', url: 'https://github.com/recharts/recharts' },
                ],
              },
              {
                heading: 'EDITOR & CONTENT',
                color: 'rgba(255,200,0,0.5)',
                projects: [
                  { name: 'Monaco Editor', license: 'MIT', url: 'https://github.com/microsoft/monaco-editor' },
                  { name: '@monaco-editor/react', license: 'MIT', url: 'https://github.com/suren-atoyan/monaco-react' },
                  { name: 'TipTap', license: 'MIT', url: 'https://github.com/ueberdosis/tiptap' },
                  { name: 'react-markdown', license: 'MIT', url: 'https://github.com/remarkjs/react-markdown' },
                  { name: 'remark-gfm', license: 'MIT', url: 'https://github.com/remarkjs/remark-gfm' },
                  { name: 'highlight.js', license: 'BSD 3-Clause', url: 'https://github.com/highlightjs/highlight.js' },
                ],
              },
              {
                heading: 'STATE & DATA',
                color: 'rgba(200,100,255,0.5)',
                projects: [
                  { name: 'Zustand', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
                  { name: '@tanstack/react-query', license: 'MIT', url: 'https://github.com/TanStack/query' },
                  { name: 'react-hook-form', license: 'MIT', url: 'https://github.com/react-hook-form/react-hook-form' },
                  { name: 'Zod', license: 'MIT', url: 'https://github.com/colinhacks/zod' },
                  { name: 'date-fns', license: 'MIT', url: 'https://github.com/date-fns/date-fns' },
                ],
              },
              {
                heading: 'AUDIO & MEDIA',
                color: 'rgba(255,100,100,0.5)',
                projects: [
                  { name: 'wa-overdrive', license: 'MIT', url: 'https://github.com/adelespinasse/wa-overdrive' },
                  { name: 'mpg123-decoder', license: 'LGPL 2.1', url: 'https://github.com/nicktindall/mpg123-decoder' },
                  { name: 'Phaser', license: 'MIT', url: 'https://github.com/phaserjs/phaser' },
                ],
              },
              {
                heading: 'BACKEND & RUNTIME',
                color: 'rgba(0,200,150,0.5)',
                projects: [
                  { name: 'Node.js', license: 'MIT', url: 'https://github.com/nodejs/node' },
                  { name: 'Fastify', license: 'MIT', url: 'https://github.com/fastify/fastify' },
                  { name: '@fastify/cors', license: 'MIT', url: 'https://github.com/fastify/fastify-cors' },
                  { name: '@fastify/static', license: 'MIT', url: 'https://github.com/fastify/fastify-static' },
                  { name: 'Express', license: 'MIT', url: 'https://github.com/expressjs/express' },
                  { name: 'DuckDB', license: 'MIT', url: 'https://github.com/duckdb/duckdb' },
                  { name: 'OpenAI Node SDK', license: 'Apache 2.0', url: 'https://github.com/openai/openai-node' },
                  { name: 'dotenv', license: 'BSD 2-Clause', url: 'https://github.com/motdotla/dotenv' },
                  { name: 'adm-zip', license: 'MIT', url: 'https://github.com/cthackers/adm-zip' },
                  { name: 'mammoth', license: 'BSD 2-Clause', url: 'https://github.com/mwilliamson/mammoth.js' },
                  { name: 'SheetJS (xlsx)', license: 'Apache 2.0', url: 'https://github.com/SheetJS/sheetjs' },
                  { name: 'pdfjs-dist', license: 'Apache 2.0', url: 'https://github.com/mozilla/pdf.js' },
                  { name: 'node-html-parser', license: 'MIT', url: 'https://github.com/taoqf/node-html-parser' },
                  { name: 'bcryptjs', license: 'MIT', url: 'https://github.com/dcodeIO/bcrypt.js' },
                  { name: 'wasm-pandoc', license: 'MIT', url: 'https://github.com/NikolaiT/wasm-pandoc' },
                  { name: 'sharp', license: 'Apache 2.0', url: 'https://github.com/lovell/sharp', note: 'Image thumbnailing and resize for Meridian' },
                  { name: 'exifr', license: 'MIT', url: 'https://github.com/MikeKovarik/exifr', note: 'EXIF metadata extraction for Meridian photo library' },
                  { name: 'fluent-ffmpeg', license: 'MIT', url: 'https://github.com/fluent-ffmpeg/node-fluent-ffmpeg', note: 'Video metadata via ffprobe for Meridian' },
                ],
              },
              {
                heading: 'ML & INFERENCE',
                color: 'rgba(255,150,0,0.5)',
                projects: [
                  { name: '@xenova/transformers', license: 'Apache 2.0', url: 'https://github.com/xenova/transformers.js' },
                  { name: '@imgly/background-removal-node', license: 'Apache 2.0', url: 'https://github.com/imgly/background-removal-node' },
                  { name: 'onnxruntime-node', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime' },
                  { name: 'tree-sitter', license: 'MIT', url: 'https://github.com/tree-sitter/tree-sitter' },
                  { name: 'tree-sitter-javascript', license: 'MIT', url: 'https://github.com/tree-sitter/tree-sitter-javascript' },
                  { name: 'tree-sitter-typescript', license: 'MIT', url: 'https://github.com/tree-sitter/tree-sitter-typescript' },
                ],
              },
              {
                heading: 'AI MODELS',
                color: 'rgba(180,180,255,0.5)',
                projects: [
                  { name: 'llama.cpp (Inference)', license: 'MIT', url: 'https://github.com/ggerganov/llama.cpp' },
                  { name: 'Whisper.cpp (STT)', license: 'MIT', url: 'https://github.com/ggerganov/whisper.cpp' },
                  { name: 'nomic-embed-text-v1.5 (Embeddings)', license: 'Apache 2.0', url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5' },
                  { name: 'stable-diffusion.cpp (Image Gen)', license: 'MIT', url: 'https://github.com/leejet/stable-diffusion.cpp' },
                  { name: 'Wan 2.2 (Video Generation)', license: 'Apache 2.0', url: 'https://github.com/Wan-Video/Wan2.1' },
                  { name: 'ACE-Step 1.5 XL (Music)', license: 'Apache 2.0', url: 'https://github.com/ace-step/ACE-Step' },
                  { name: 'VoxCPM2 (TTS)', license: 'Apache 2.0', url: 'https://github.com/VOICEVOX/voicevox_core' },
                  { name: 'Stable Audio Open (SFX)', license: 'Stability AI Community', url: 'https://huggingface.co/stabilityai/stable-audio-open-1.0', note: 'Non-commercial use only per Stability AI Community License' },
                  { name: 'Netflix VOID (Video Inpainting)', license: 'Apache 2.0', url: 'https://github.com/netflix/void' },
                ],
              },
              {
                heading: 'MEDIA SERVERS',
                color: 'rgba(0,180,255,0.5)',
                projects: [
                  { name: 'Jellyfin', license: 'LGPL 2.1', url: 'https://github.com/jellyfin/jellyfin', note: 'Video and TV library — runs as an independent subprocess' },
                  { name: 'Kavita', license: 'GPL 3.0', url: 'https://github.com/Kareadita/Kavita', note: 'Manga, comics, and book server — runs as an independent subprocess' },
                  { name: 'Polaris', license: 'MIT', url: 'https://github.com/agersant/polaris', note: 'Music library server — runs as an independent subprocess' },
                  { name: 'mpv', license: 'GPL 2.0+', url: 'https://github.com/mpv-player/mpv', note: 'Video and IPTV player — runs as an independent subprocess' },
                ],
              },
              {
                heading: '3D EDITORS',
                color: 'rgba(100,220,180,0.5)',
                projects: [
                  { name: 'Blockbench', license: 'GPL 3.0', url: 'https://github.com/JannisX11/blockbench', note: '3D mesh modeling and texturing — built from source, self-hosted as static assets' },
                  { name: 'SculptGL', license: 'MIT', url: 'https://github.com/stephaneginier/sculptgl', note: 'Organic clay sculpting — self-hosted as static assets' },
                  { name: 'Godot 4 Web Editor', license: 'MIT', url: 'https://github.com/godotengine/godot', note: 'Scene assembly and game engine — official web build, self-hosted as WASM assets' },
                ],
              },
              {
                heading: 'EXTERNAL TOOLS',
                color: 'rgba(150,150,150,0.5)',
                projects: [
                  { name: 'Helm Synthesizer', license: 'GPL 3.0', url: 'https://github.com/mtytel/helm', note: 'Runs as VST3 inside PhobosHost subprocess' },
                  { name: 'Surge XT', license: 'GPL 3.0', url: 'https://github.com/surge-synthesizer/surge', note: 'Runs as VST3 inside PhobosHost subprocess' },
                  { name: 'GIMP', license: 'GPL 3.0', url: 'https://gitlab.gnome.org/GNOME/gimp', note: 'Launched as an independent subprocess via Broadway (GTK3)' },
                  { name: 'GTK3 / Broadway', license: 'LGPL 2.1', url: 'https://gitlab.gnome.org/GNOME/gtk', note: 'Browser-based GTK rendering backend used for GIMP subprocess' },
                  { name: 'Pandoc', license: 'GPL 2.0', url: 'https://github.com/jgm/pandoc', note: 'Document conversion — runs as an independent subprocess' },
                  { name: 'ClamAV', license: 'GPL 2.0', url: 'https://github.com/Cisco-Talos/clamav', note: 'Malware scanning — optional, fetched on demand by the security subsystem' },
                  { name: 'Camofox Browser', license: 'MPL 2.0', url: 'https://github.com/nickvdyck/webbundle', note: 'Runs as an independent subprocess' },
                  { name: 'Stirling-PDF', license: 'MIT', url: 'https://github.com/Stirling-Tools/Stirling-PDF', note: 'Runs as an independent subprocess' },
                ],
              },
            ];

            const licenseColor = (l: string) => {
              if (l.startsWith('GPL')) return 'rgba(255,100,100,0.6)';
              if (l.startsWith('LGPL')) return 'rgba(255,160,80,0.6)';
              if (l === 'MIT' || l === 'ISC') return 'rgba(0,255,65,0.5)';
              if (l.startsWith('Apache')) return 'rgba(0,200,255,0.5)';
              if (l.startsWith('BSD')) return 'rgba(255,200,0,0.5)';
              if (l === 'MPL 2.0') return 'rgba(200,150,255,0.5)';
              if (l.startsWith('EPL')) return 'rgba(255,180,50,0.6)';
              return 'rgba(255,150,0,0.6)';
            };

            return (
              <div>
                <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.15em', marginBottom: 16, lineHeight: 1.6 }}>
                  PHOBOS is built on these open source projects. Click any name to visit its repository.
                </p>
                <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                  {groups.map((g) => (
                    <div key={g.heading} style={{ marginBottom: 20 }}>
                      <p style={{ fontSize: 8, color: g.color, letterSpacing: '0.25em', marginBottom: 8, textTransform: 'uppercase' }}>
                        — {g.heading}
                      </p>
                      {g.projects.map((p) => (
                        <div key={p.name} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', ...mono, textDecoration: 'none', display: 'block' }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
                              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.7)')}
                            >
                              {p.name}
                            </a>
                            {p.note && (
                              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', display: 'block', marginTop: 2, lineHeight: 1.4, fontFamily: "'Inter', sans-serif" }}>
                                {p.note}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: 9, color: licenseColor(p.license), letterSpacing: '0.08em', flexShrink: 0, paddingTop: 1, ...mono }}>
                            {p.license}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}



        </div>
      </div>
    </div>
  );
}