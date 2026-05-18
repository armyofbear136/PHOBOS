import { useEffect, useRef, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';
import { CLIENT_VERSION } from '@/version';

/* ─── Color tokens (green primary + amber secondary) ─── */
const C = {
  green: '#00ff41',
  greenDim: 'rgba(0,255,65,0.55)',
  amber: '#f59e0b',
  amberDim: 'rgba(245,158,11,0.7)',
  blue: '#4eb8e0',
  text: 'rgba(255,255,255,0.85)',
  textMid: 'rgba(255,255,255,0.55)',
  textLow: 'rgba(255,255,255,0.35)',
  hairline: 'rgba(255,255,255,0.08)',
  hairlineGreen: 'rgba(0,255,65,0.15)',
};

const MONO: React.CSSProperties = { fontFamily: "'Share Tech Mono', monospace" };
const SANS: React.CSSProperties = { fontFamily: "'Inter', system-ui, sans-serif" };

/* ─── Scroll reveal ─── */
function FadeUp({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.08 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(20px)',
        transition: `opacity 700ms ease-out ${delay}ms, transform 700ms ease-out ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Eyebrow ─── */
function Eyebrow({ children, color = C.greenDim }: { children: ReactNode; color?: string }) {
  return (
    <p style={{ ...MONO, fontSize: 11, letterSpacing: '0.25em', color, textTransform: 'uppercase', marginBottom: 18 }}>
      {children}
    </p>
  );
}

/* ─── Section divider hairline ─── */
function Rule() {
  return <div style={{ height: 1, background: C.hairline, width: '100%' }} />;
}

/* ═══════════════════════════════════════════════════════ */
/* HERO                                                    */
/* ═══════════════════════════════════════════════════════ */
function Hero() {
  return (
    <section
      style={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '140px 24px 80px',
        overflow: 'hidden',
      }}
    >
      {/* faint scan lines */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
          background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,255,65,0.012) 3px, rgba(0,255,65,0.012) 4px)',
        }}
      />
      {/* faint grid */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, #000 10%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 50%, #000 10%, transparent 80%)',
        }}
      />
      {/* central glow */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
          background: 'radial-gradient(ellipse 50% 35% at 50% 50%, rgba(0,255,65,0.06) 0%, transparent 70%)',
        }}
      />

      <div style={{ position: 'relative', zIndex: 2, maxWidth: 980, margin: '0 auto', textAlign: 'center' }}>
        <FadeUp>
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              border: `1px solid ${C.hairlineGreen}`, padding: '7px 16px', borderRadius: 2, marginBottom: 36,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, boxShadow: `0 0 8px ${C.green}` }} />
            <span style={{ ...MONO, fontSize: 10, color: C.greenDim, letterSpacing: '0.2em' }}>
              v{CLIENT_VERSION} // SHIPPING NOW
            </span>
          </div>
        </FadeUp>

        <FadeUp delay={80}>
          <h1
            style={{
              ...MONO,
              fontSize: 'clamp(40px, 7vw, 88px)',
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: '-0.02em',
              color: '#fff',
              marginBottom: 8,
            }}
          >
            Your Machine.
          </h1>
          <h1
            style={{
              ...MONO,
              fontSize: 'clamp(40px, 7vw, 88px)',
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: '-0.02em',
              color: '#fff',
              marginBottom: 8,
            }}
          >
            Your Models.
          </h1>
          <h1
            style={{
              ...MONO,
              fontSize: 'clamp(40px, 7vw, 88px)',
              fontWeight: 700,
              lineHeight: 0.98,
              letterSpacing: '-0.02em',
              color: C.green,
              marginBottom: 36,
            }}
          >
            Your Rules.
          </h1>
        </FadeUp>

        <FadeUp delay={180}>
          <p
            style={{
              ...SANS,
              fontSize: 'clamp(15px, 1.6vw, 18px)',
              lineHeight: 1.7,
              color: C.textMid,
              maxWidth: 640,
              margin: '0 auto 44px',
            }}
          >
            PHOBOS is a local-first AI operating system. It runs your LLMs, generates your images,
            browses the web, and executes tasks — entirely on your machine. No cloud. No subscriptions.
            No data leaving.
          </p>
        </FadeUp>

        <FadeUp delay={260}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <Link
              to="/phobos"
              style={{
                background: C.green, color: '#000', ...MONO, fontSize: 12, letterSpacing: '0.18em',
                padding: '14px 28px', textDecoration: 'none', borderRadius: 2,
                transition: 'background 150ms, transform 150ms',
                display: 'inline-block',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
              onMouseLeave={(e) => (e.currentTarget.style.background = C.green)}
            >
              ↓ DOWNLOAD v{CLIENT_VERSION}
            </Link>
            <Link
              to="/built"
              style={{
                border: `1px solid ${C.blue}`,
                color: C.blue,
                ...MONO, fontSize: 12, letterSpacing: '0.18em',
                padding: '13px 28px', textDecoration: 'none', borderRadius: 2,
                transition: 'all 150ms',
                display: 'inline-block',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(78,184,224,0.1)'; e.currentTarget.style.borderColor = C.blue; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = C.blue; }}
            >
              HOW THIS WAS BUILT →
            </Link>
            <a
              href="https://github.com/armyofbear136/PHOBOS"
              target="_blank"
              rel="noreferrer"
              style={{
                border: `1px solid ${C.hairline}`, color: C.textMid, ...MONO, fontSize: 12, letterSpacing: '0.18em',
                padding: '13px 28px', textDecoration: 'none', borderRadius: 2,
                transition: 'all 150ms',
                display: 'inline-block',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'; e.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.hairline; e.currentTarget.style.color = C.textMid; }}
            >
              VIEW ON GITHUB
            </a>
          </div>
        </FadeUp>

        <FadeUp delay={340}>
          <p style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.15em' }}>
            // no signup · no telemetry · no data collected ·{' '}
            <Link to="/built" style={{ color: C.textLow, textDecoration: 'none', borderBottom: `1px dotted ${C.textLow}` }}>
              read how this was built
            </Link>
          </p>
        </FadeUp>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* PLATFORM MATRIX                                         */
/* ═══════════════════════════════════════════════════════ */
function PlatformMatrix() {
  const platforms = [
    { label: 'Windows', detail: 'x64' },
    { label: 'macOS', detail: 'Apple Silicon' },
    { label: 'macOS', detail: 'Intel' },
    { label: 'Linux', detail: 'x64' },
    { label: 'Linux', detail: 'ARM64' },
  ];
  return (
    <section style={{ borderTop: `1px solid ${C.hairline}`, borderBottom: `1px solid ${C.hairline}`, padding: '28px 24px', background: 'rgba(0,0,0,0.4)' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24 }}>
        <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
          // pre-built binaries — every platform
        </span>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {platforms.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ ...MONO, fontSize: 12, color: '#fff', letterSpacing: '0.08em' }}>{p.label}</span>
              <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.1em' }}>{p.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* CORE SYSTEMS — 6 cards                                  */
/* ═══════════════════════════════════════════════════════ */
const SYSTEMS = [
  {
    name: 'LLM Inference',
    body: 'Runs llama.cpp locally. Auto-detects your GPU — NVIDIA, AMD, Apple Silicon, CPU. No API key needed.',
    accent: C.green,
  },
  {
    name: 'Image Generation',
    body: 'FLUX, Chroma, SDXL, and video diffusion. Native sd-cli for zero-Python-startup speed, PyTorch for the absolute cutting edge technology.',
    accent: C.amber,
  },
  {
    name: 'Web Browsing',
    body: 'Camoufox: a Firefox fork with C++-level fingerprint spoofing. Agents browse the live web, bypass bot detection, and extract YouTube transcripts — no API key required.',
    accent: C.green,
  },
  {
    name: 'Task Scheduler',
    body: 'Millisecond-precision cron executor. Schedule AI conversations or background jobs. No polling, no drift.',
    accent: C.amber,
  },
  {
    name: 'Security Scanner',
    body: 'Seven scanners: system audit, file integrity, port scan, web audit, dependency audit, code audit (tree-sitter AST), and ClamAV malware. Every run gets an AI-generated digest.',
    accent: C.green,
  },
  {
    name: 'Audio & Media',
    body: 'Built-in DAW with MIDI, Custom PHOBOS rack/VST-LV2, Alda score parsing, and OSC bridging. Plus Jellyfin, IPTV, manga reader, and music server.',
    accent: C.amber,
  },
];

function CoreSystems() {
  return (
    <section style={{ padding: '120px 24px', position: 'relative' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <FadeUp>
          <Eyebrow>// system / core</Eyebrow>
          <h2 style={{ ...MONO, fontSize: 'clamp(30px, 4.5vw, 52px)', fontWeight: 700, lineHeight: 1.05, color: '#fff', marginBottom: 20 }}>
            Six systems. <span style={{ color: C.green }}>One executable.</span>
          </h2>
          <p style={{ ...SANS, fontSize: 16, color: C.textMid, lineHeight: 1.7, maxWidth: 640, marginBottom: 64 }}>
            PHOBOS is not a chat wrapper. It is a runtime — every subsystem ships in the binary,
            initialized on first launch, and operates entirely on the local machine.
          </p>
        </FadeUp>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 1,
            background: C.hairline,
            border: `1px solid ${C.hairline}`,
          }}
        >
          {SYSTEMS.map((sys, i) => (
            <FadeUp key={sys.name} delay={i * 60}>
              <div
                style={{
                  background: '#0a0a0b',
                  padding: '40px 32px',
                  height: '100%',
                  position: 'relative',
                  transition: 'background 180ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#0e0e10')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#0a0a0b')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <span style={{ width: 6, height: 6, background: sys.accent, boxShadow: `0 0 6px ${sys.accent}` }} />
                  <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.2em' }}>
                    SYS_{String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 style={{ ...MONO, fontSize: 18, color: sys.accent, marginBottom: 12, letterSpacing: '0.02em' }}>
                  {sys.name}
                </h3>
                <p style={{ ...SANS, fontSize: 14, lineHeight: 1.7, color: C.textMid }}>
                  {sys.body}
                </p>
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* HOW IT WORKS — 3 steps                                  */
/* ═══════════════════════════════════════════════════════ */
const STEPS = [
  {
    n: '01',
    title: 'Install',
    body: 'Download the pre-built binary for your platform. One executable. No Python environment, no Docker, no configuration files required to start.',
  },
  {
    n: '02',
    title: 'Load Your Models',
    body: 'Point PHOBOS at your GGUF model files. Hardware is auto-detected. GPU layers, context size, and binary selection are computed automatically.',
  },
  {
    n: '03',
    title: 'Run',
    body: 'SAYON coordinates. SEREN executes. SYBIL remembers. Your machine handles it all.',
  },
];

function HowItWorks() {
  return (
    <section style={{ padding: '120px 24px', borderTop: `1px solid ${C.hairline}`, position: 'relative' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <FadeUp>
          <Eyebrow>// procedure / boot</Eyebrow>
          <h2 style={{ ...MONO, fontSize: 'clamp(30px, 4.5vw, 52px)', fontWeight: 700, lineHeight: 1.05, color: '#fff', marginBottom: 64 }}>
            From zero to <span style={{ color: C.amber }}>running.</span>
          </h2>
        </FadeUp>

        <div style={{ position: 'relative' }}>
          {/* horizontal connector line */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: 32, left: '8%', right: '8%', height: 1,
              background: `linear-gradient(to right, transparent, ${C.hairlineGreen}, ${C.hairlineGreen}, transparent)`,
              display: 'none',
            }}
            className="howitworks-line"
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 32 }}>
            {STEPS.map((step, i) => (
              <FadeUp key={step.n} delay={i * 100}>
                <div style={{ position: 'relative' }}>
                  <div
                    style={{
                      width: 64, height: 64, border: `1px solid ${C.hairlineGreen}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      ...MONO, fontSize: 18, color: C.green, marginBottom: 24,
                      background: '#0a0a0b', borderRadius: 2,
                      letterSpacing: '0.05em',
                    }}
                  >
                    {step.n}
                  </div>
                  <h3 style={{ ...MONO, fontSize: 22, color: '#fff', marginBottom: 12, letterSpacing: '0.02em' }}>
                    {step.title}
                  </h3>
                  <p style={{ ...SANS, fontSize: 14, lineHeight: 1.75, color: C.textMid }}>
                    {step.body}
                  </p>
                </div>
              </FadeUp>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* PERSONAS — SAYON / SEREN / SYBIL                        */
/* ═══════════════════════════════════════════════════════ */
const PERSONAS = [
  {
    name: 'SAYON',
    role: 'Task coordinator',
    body: 'Plans multi-step work, calls tools, drives the agent loop.',
    img: 'sayon.png',
    tint: '#4eb8e0',
  },
  {
    name: 'SEREN',
    role: 'The engine',
    body: 'Executes tasks, generates content, performs analysis.',
    img: 'seren.png',
    tint: C.amber,
  },
  {
    name: 'SYBIL',
    role: 'Semantic memory',
    body: 'Runs nomic-embed locally for RAG and archive search.',
    img: 'sybil.png',
    tint: C.green,
  },
];

function Personas() {
  return (
    <section style={{ padding: '120px 24px', borderTop: `1px solid ${C.hairline}`, position: 'relative' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <FadeUp>
          <Eyebrow>// agents / runtime</Eyebrow>
          <h2 style={{ ...MONO, fontSize: 'clamp(30px, 4.5vw, 52px)', fontWeight: 700, lineHeight: 1.05, color: '#fff', marginBottom: 64 }}>
            Three personas. <span style={{ color: C.green }}>One stack.</span>
          </h2>
        </FadeUp>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 1, background: C.hairline, border: `1px solid ${C.hairline}` }}>
          {PERSONAS.map((p, i) => (
            <FadeUp key={p.name} delay={i * 80}>
              <div style={{ background: '#0a0a0b', padding: '40px 32px', height: '100%' }}>
                <div style={{ width: 72, height: 72, marginBottom: 24, border: `1px solid ${p.tint}33`, padding: 4, background: '#000' }}>
                  <img
                    src={`${import.meta.env.BASE_URL}${p.img}`}
                    alt={p.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'grayscale(0.2)' }}
                  />
                </div>
                <div style={{ ...MONO, fontSize: 11, color: p.tint, letterSpacing: '0.2em', marginBottom: 8 }}>
                  ◈ {p.name}
                </div>
                <div style={{ ...MONO, fontSize: 13, color: '#fff', marginBottom: 14, letterSpacing: '0.05em' }}>
                  {p.role}
                </div>
                <p style={{ ...SANS, fontSize: 14, lineHeight: 1.7, color: C.textMid }}>
                  {p.body}
                </p>
              </div>
            </FadeUp>
          ))}
        </div>

        <FadeUp delay={300}>
          <p style={{ ...MONO, fontSize: 11, color: C.textLow, letterSpacing: '0.18em', marginTop: 32, textAlign: 'center' }}>
            // three personas — one local inference stack — zero cloud calls
          </p>
        </FadeUp>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* HARDWARE                                                */
/* ═══════════════════════════════════════════════════════ */
const HARDWARE = [
  { device: 'NVIDIA RTX 3080', backend: 'CUDA + Vulkan', tier: C.green },
  { device: 'AMD Radeon 890M (48 GB UMA)', backend: 'Vulkan + ROCm', tier: C.amber },
  { device: 'Apple Silicon M-series', backend: 'Metal', tier: C.green },
  { device: 'CPU-only', backend: 'All platforms', tier: C.blue },
];

function Hardware() {
  return (
    <section style={{ padding: '120px 24px', borderTop: `1px solid ${C.hairline}`, position: 'relative' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <FadeUp>
          <Eyebrow>// hardware / detection</Eyebrow>
          <h2 style={{ ...MONO, fontSize: 'clamp(30px, 4.5vw, 52px)', fontWeight: 700, lineHeight: 1.05, color: '#fff', marginBottom: 20 }}>
            Runs on your hardware.<br /><span style={{ color: C.amber }}>Whatever that is.</span>
          </h2>
          <p style={{ ...SANS, fontSize: 16, color: C.textMid, lineHeight: 1.7, maxWidth: 600, marginBottom: 56 }}>
            Tested configurations. Auto-detected at boot. No configuration required.
          </p>
        </FadeUp>

        <div style={{ border: `1px solid ${C.hairline}`, background: '#0a0a0b' }}>
          {/* table header */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', padding: '14px 24px', borderBottom: `1px solid ${C.hairline}`, background: 'rgba(255,255,255,0.02)' }}>
            <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.2em' }}>DEVICE</span>
            <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.2em' }}>BACKEND</span>
            <span style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.2em', textAlign: 'right' }}>STATUS</span>
          </div>
          {HARDWARE.map((h, i) => (
            <FadeUp key={h.device} delay={i * 50}>
              <div
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 80px',
                  padding: '18px 24px',
                  borderBottom: i < HARDWARE.length - 1 ? `1px solid ${C.hairline}` : 'none',
                  alignItems: 'center',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0,255,65,0.02)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ ...MONO, fontSize: 13, color: '#fff' }}>{h.device}</span>
                <span style={{ ...MONO, fontSize: 13, color: C.textMid }}>{h.backend}</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, background: h.tier, boxShadow: `0 0 6px ${h.tier}` }} />
                  <span style={{ ...MONO, fontSize: 10, color: h.tier, letterSpacing: '0.15em' }}>OK</span>
                </span>
              </div>
            </FadeUp>
          ))}
        </div>

        <FadeUp delay={300}>
          <p style={{ ...MONO, fontSize: 11, color: C.textLow, letterSpacing: '0.15em', marginTop: 24 }}>
            // auto-detected at boot — no configuration required
          </p>
        </FadeUp>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* PATRON CTA                                              */
/* ═══════════════════════════════════════════════════════ */
function PatronCTA() {
  return (
    <section style={{ padding: '120px 24px', borderTop: `1px solid ${C.hairline}` }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <FadeUp>
          <div
            style={{
              background: '#070708',
              border: `1px solid ${C.hairline}`,
              padding: 'clamp(36px, 6vw, 64px)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* corner accents */}
            <div style={{ position: 'absolute', top: 0, left: 0, width: 28, height: 28, borderTop: `1px solid ${C.amberDim}`, borderLeft: `1px solid ${C.amberDim}` }} />
            <div style={{ position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderBottom: `1px solid ${C.amberDim}`, borderRight: `1px solid ${C.amberDim}` }} />

            <Eyebrow color={C.amberDim}>// support the build</Eyebrow>
            <h2 style={{ ...MONO, fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 700, lineHeight: 1.1, color: '#fff', marginBottom: 20 }}>
              Free, open source, <span style={{ color: C.amber }}>and yours.</span>
            </h2>
            <p style={{ ...SANS, fontSize: 15, color: C.textMid, lineHeight: 1.75, marginBottom: 28, maxWidth: 620 }}>
              PHOBOS is free and open source. A Patron Certificate ($19.99+) gives you a permanent
              cryptographic license, a custom username displayed in your PHOBOS header, and a
              permanent entry in the Patrons leaderboard. No feature gates. Just flair and gratitude.
            </p>
            <Link
              to="/pricing"
              style={{
                display: 'inline-block',
                background: 'transparent',
                border: `1px solid ${C.amber}`,
                color: C.amber,
                ...MONO, fontSize: 12, letterSpacing: '0.18em',
                padding: '14px 28px', textDecoration: 'none', borderRadius: 2,
                transition: 'all 150ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.amber; e.currentTarget.style.color = '#000'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.amber; }}
            >
              BECOME A PATRON →
            </Link>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════ */
/* PAGE                                                    */
/* ═══════════════════════════════════════════════════════ */
export default function Landing() {
  return (
    <MarketingLayout>
      <Hero />
      <PlatformMatrix />
      <CoreSystems />
      <HowItWorks />
      <Personas />
      <Hardware />
      <PatronCTA />
    </MarketingLayout>
  );
}
