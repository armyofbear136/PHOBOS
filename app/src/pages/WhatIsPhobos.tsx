import { useEffect, useRef, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';

/* ── Scroll-fade utility ── */
function FadeUp({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.06 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} style={{ opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(24px)', transition: `opacity 0.65s ease-out ${delay}ms, transform 0.65s ease-out ${delay}ms` }}>
      {children}
    </div>
  );
}

function FadeIn({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.04 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ opacity: visible ? 1 : 0, transition: `opacity 0.8s ease-out ${delay}ms` }}>
      {children}
    </div>
  );
}

function Eyebrow({ children, color = 'rgba(0,255,65,0.55)' }: { children: string; color?: string }) {
  return (
    <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color, textTransform: 'uppercase', marginBottom: 20 }}>
      {children}
    </p>
  );
}

function SectionHead({ line1, line2, line2Color = '#00ff41' }: { line1: string; line2?: string; line2Color?: string }) {
  return (
    <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(30px, 5vw, 56px)', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em', color: '#fff', marginBottom: 28 }}>
      {line1}{line2 && <><br /><span style={{ color: line2Color }}>{line2}</span></>}
    </h2>
  );
}

function Body({ children, style = {} }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.55)', maxWidth: 700, ...style }}>
      {children}
    </p>
  );
}

function Rule() {
  return <div style={{ width: '100%', height: 1, background: 'rgba(0,255,65,0.07)' }} />;
}

/* ── Animated terminal typewriter block ── */
function TerminalBlock({ lines, label = 'PHOBOS SESSION' }: { lines: { role: 'user' | 'sayon' | 'seren' | 'system'; text: string }[]; label?: string }) {
  const [shown, setShown] = useState(0);
  const [visible, setVisible] = useState(false);
  const [borderFlash, setBorderFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.2 });
    obs.observe(el); return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (shown >= lines.length) return;
    const t = setTimeout(() => setShown(s => s + 1), shown === 0 ? 400 : 900);
    return () => clearTimeout(t);
  }, [visible, shown, lines.length]);

  useEffect(() => {
    if (!visible || shown === 0) return;
    setBorderFlash(true);
    const t = setTimeout(() => setBorderFlash(false), 300);
    return () => clearTimeout(t);
  }, [shown, visible]);

  const roleStyle: Record<string, React.CSSProperties> = {
    user:   { color: '#ffffff', fontFamily: "'Share Tech Mono', monospace" },
    sayon:  { color: '#4eb8e0', fontFamily: "'Share Tech Mono', monospace" },
    seren:{ color: '#ffaa33', fontFamily: "'Share Tech Mono', monospace" },
    system: { color: 'rgba(0,255,65,0.5)', fontFamily: "'Share Tech Mono', monospace" },
  };
  const rolePrefix: Record<string, string> = {
    user: '> YOU',
    sayon: '◈ SAYON',
    seren: '◈ SEREN',
    system: '// SYSTEM',
  };

  return (
    <div ref={ref} style={{
      background: '#000',
      border: `1px solid ${borderFlash ? 'rgba(0,255,65,0.4)' : 'rgba(0,255,65,0.2)'}`,
      borderRadius: 4,
      overflow: 'hidden',
      fontFamily: "'Share Tech Mono', monospace",
      transition: 'border-color 260ms ease',
    }}>
      {/* Terminal titlebar */}
      <div style={{ background: 'rgba(0,255,65,0.06)', borderBottom: '1px solid rgba(0,255,65,0.12)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['rgba(255,65,65,0.6)', 'rgba(255,200,0,0.6)', 'rgba(0,255,65,0.6)'].map((c, i) => (
            <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
          ))}
        </div>
        <span style={{ fontSize: 10, color: 'rgba(0,255,65,0.45)', letterSpacing: '0.15em', marginLeft: 8 }}>{label}</span>
      </div>
      {/* Lines */}
      <div style={{ padding: '20px 20px', minHeight: 120 }}>
        {lines.slice(0, shown).map((line, i) => (
          <div key={i} style={{ marginBottom: 14, opacity: 1, animation: 'none' }}>
            <span style={{ ...roleStyle[line.role], fontSize: 10, letterSpacing: '0.12em', display: 'block', marginBottom: 4, opacity: 0.7 }}>
              {rolePrefix[line.role]}
            </span>
            <span style={{ ...roleStyle[line.role], fontSize: 13, lineHeight: 1.65, display: 'block' }}>
              {line.text}
            </span>
          </div>
        ))}
        {shown < lines.length && visible && (
          <span style={{ display: 'inline-block', width: 8, height: 14, background: '#00ff41', animation: 'blink 1s step-end infinite', verticalAlign: 'middle' }} />
        )}
      </div>
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} } @keyframes softpulse { 0%,100%{box-shadow:0 0 0 0 rgba(0,255,65,0.4)} 50%{box-shadow:0 0 0 8px rgba(0,255,65,0)} }`}</style>
    </div>
  );
}

/* ── Workflow arrow diagram ── */
function WorkflowDiagram({ steps }: { steps: { icon: string; label: string; sublabel: string; color: string }[] }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.1 });
    obs.observe(el); return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ margin: '40px 0', overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', minWidth: 600, gap: 0 }}>
        {steps.map((step, i) => (
          <div key={step.label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{
              flex: 1,
              opacity: visible ? 1 : 0,
              transform: visible ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.95)',
              transition: `all 0.5s ease-out ${i * 120}ms`,
            }}>
              <div style={{
                border: i === 0 ? '1px solid rgba(0,255,65,0.35)' : `1px solid ${step.color}44`,
                background: `${step.color}07`,
                padding: '18px 12px',
                textAlign: 'center',
                borderRadius: 3,
                position: 'relative',
                animation: i === 0 ? 'softpulse 2s ease-in-out infinite' : undefined,
              }}>
                {i === 0 && <div style={{ position: 'absolute', top: 10, right: 10, width: 8, height: 8, borderRadius: '50%', background: '#00ff41', animation: 'softpulse 2s ease-in-out infinite' }} />}
                <div style={{ fontSize: 22, marginBottom: 8 }}>{step.icon}</div>
                <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: step.color, letterSpacing: '0.1em', marginBottom: 6 }}>{step.label}</div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>{step.sublabel}</div>
              </div>
            </div>
            {i < steps.length - 1 && (
              <div style={{ width: 28, flexShrink: 0, display: 'flex', justifyContent: 'center', opacity: visible ? 1 : 0, transition: `opacity 0.4s ease-out ${i * 120 + 200}ms` }}>
                <svg width="20" height="10" viewBox="0 0 20 10"><line x1="0" y1="5" x2="14" y2="5" stroke="rgba(255,255,255,0.2)" strokeWidth="1"/><polyline points="10,1 16,5 10,9" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1"/></svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Capability card ── */
function CapCard({ icon, title, body, color, status, delay = 0 }: { icon: string; title: string; body: string; color: string; status?: string; delay?: number }) {
  const isUpcoming = status === 'COMING SOON' || status === 'ON ROADMAP';

  return (
    <FadeUp delay={delay}>
      <div
        style={{
          background: 'rgba(255,255,255,0.02)',
          backgroundImage: isUpcoming
            ? 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 8px)'
            : undefined,
          border: '1px solid rgba(255,255,255,0.07)',
          padding: '28px 24px',
          height: '100%',
          position: 'relative',
          transition: 'border-color 200ms',
          overflow: 'hidden',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${color}44`)}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
      >
        {status && (
          <div style={{ position: 'absolute', top: 12, right: 12, fontFamily: "'Share Tech Mono', monospace", fontSize: 9, color: status === 'LIVE' ? '#00ff41' : 'rgba(255,255,255,0.25)', border: `1px solid ${status === 'LIVE' ? 'rgba(0,255,65,0.3)' : 'rgba(255,255,255,0.1)'}`, padding: '2px 8px', letterSpacing: '0.1em' }}>
            {status}
          </div>
        )}
        <div style={{ fontSize: 28, marginBottom: 14 }}>{icon}</div>
        <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 14, color, marginBottom: 10 }}>{title}</div>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.75, color: 'rgba(255,255,255,0.45)' }}>{body}</p>
      </div>
    </FadeUp>
  );
}

/* ── Scanline overlay ── */
const scanlineStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, pointerEvents: 'none',
  background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.012) 2px, rgba(0,255,65,0.012) 4px)',
};

export default function WhatIsPhobos() {
  return (
    <MarketingLayout>

      {/* ═══════════════════════════════════════════════ */}
      {/* HERO — full-width dark, scanlines, PHOBOS green */}
      {/* ═══════════════════════════════════════════════ */}
      <section style={{ position: 'relative', padding: '140px 24px 100px', textAlign: 'center', overflow: 'hidden' }}>
        <div style={scanlineStyle} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(0,255,65,0.08) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 1 }} />
        <div style={{ position: 'relative', zIndex: 2, maxWidth: 900, margin: '0 auto' }}>
          <FadeUp>
            <div style={{ display: 'inline-block', border: '1px solid rgba(0,255,65,0.3)', padding: '6px 16px', borderRadius: 3, marginBottom: 32 }}>
              <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(0,255,65,0.7)', letterSpacing: '0.2em' }}>
                // DUAL-PIPELINE LOCAL AI ENGINE — v1
              </span>
            </div>
          </FadeUp>
          <FadeUp delay={100}>
            <h1 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(44px, 8vw, 96px)', fontWeight: 700, lineHeight: 0.95, letterSpacing: '-0.02em', color: '#fff', marginBottom: 8 }}>
              WHAT IS
            </h1>
            <h1 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(44px, 8vw, 96px)', fontWeight: 700, lineHeight: 0.95, letterSpacing: '-0.02em', color: '#00ff41', marginBottom: 40 }}>
              PHOBOS?
            </h1>
          </FadeUp>
          <FadeUp delay={200}>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.7, color: 'rgba(255,255,255,0.6)', maxWidth: 680, margin: '0 auto 48px' }}>
              Everything Claude or Gemini can do — running entirely on your own hardware, with no cloud, no subscription, no data collection, and two AI minds working in tandem to make sure the answer is actually correct.
            </p>
          </FadeUp>
          <FadeUp delay={300}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
              <Link to="/phobos" style={{ background: '#00ff41', color: '#000', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', transition: 'background 150ms', display: 'inline-block' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#00ff41')}
              >
                LAUNCH PHOBOS →
              </Link>
              <Link to="/pricing" style={{ border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.6)', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', transition: 'all 150ms', display: 'inline-block' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
              >
              BECOME A SUPPORTER — $20 →
            </Link>
          </div>
          </FadeUp>
        </div>
      </section>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 96px' }}>

        <Rule />

        {/* ═══════════════════════════════════ */}
        {/* SECTION 1: THE LIVE TERMINAL DEMO  */}
        {/* ═══════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// see it think</Eyebrow>
            <SectionHead line1="Ask anything." line2="Watch both minds work." />
            <Body>
              PHOBOS doesn't answer in a straight line. SAYON — the coordinator — reads your request, maps the problem, and hands a precise brief to SEREN. SEREN reasons through the solution with a full internal thinking pass, then returns a reviewed answer. You watch the whole process in the reasoning panel in real time.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Below is a simplified view of what a session looks like when you ask PHOBOS to build something from scratch:
            </Body>
            <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
              <TerminalBlock label="WORKFLOW: BUILD A FEATURE" lines={[
                { role: 'user',    text: 'Build me a REST API endpoint that accepts a CSV upload, validates the headers, and returns a JSON summary.' },
                { role: 'sayon',   text: 'Planning: parse CSV in memory, validate against schema, aggregate row stats, return as JSON. SEREN: create api/upload.ts with multer + papaparse.' },
                { role: 'seren', text: 'Thinking through edge cases: empty file, malformed UTF-8, header mismatch... writing file now.' },
                { role: 'system',  text: 'FILE CREATED: api/upload.ts — 94 lines. Endpoint POST /upload validated.' },
                { role: 'sayon',   text: 'Done. The endpoint handles 6 validation cases, returns structured errors, and streams large files. Ready to test.' },
              ]} />
              <TerminalBlock label="WORKFLOW: RESEARCH + DOCUMENT" lines={[
                { role: 'user',    text: 'I need a complete technical spec for a real-time multiplayer game state sync system.' },
                { role: 'sayon',   text: 'Scope: architecture overview, protocol choice (WebSocket vs WebRTC), state reconciliation, lag compensation, conflict resolution. SEREN: produce full spec document.' },
                { role: 'seren', text: 'Reasoning through consistency models... CRDT vs authoritative server... writing spec.' },
                { role: 'system',  text: 'FILE CREATED: game-sync-spec.md — 2,400 words. 8 sections. Architecture diagrams included as ASCII.' },
                { role: 'sayon',   text: 'Spec complete. Covers every system component with implementation notes and tradeoff analysis.' },
              ]} />
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════ */}
        {/* SECTION 2: CAPABILITY GRID                */}
        {/* ══════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// what phobos can do right now</Eyebrow>
            <SectionHead line1="Every capability you expect." line2="None of the cloud." />
            <Body>
              PHOBOS is a full local-first development and creativity OS. If you can describe it, PHOBOS can think about it, plan it, and produce an output. Verified working across Windows (x64), macOS (ARM), and Linux (x64) via the PHOBOS Launcher.
            </Body>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 2, marginTop: 48 }}>
              <CapCard delay={0}   icon="🔄" color="#00ff41" status="LIVE" title="Advanced Task Loop" body="Plan → Write → Execute → Fix → Deliver. A 5-stage verification loop where SEREN runs the code it writes in a local sandbox, catches errors, and self-corrects before you ever see it." />
              <CapCard delay={60}  icon="💎" color="#ffaa33" status="LIVE" title="Dynamic Relationship Engine" body="SAYON and SEREN leverage an engagement-depth system derived from Primal Online. They track your collaborative history, shifting from formal assistants to intuitive partners as your 'Relationship Level' grows through successful tasks." />
              <CapCard delay={120} icon="🖼️" color="#00ff41" status="LIVE" title="Unmatched Image Generation" body="Chain multiple models and layer LoRAs with the new Workflow Panel. Leverage both SD-CLI and PyTorch for maximum creativity, featuring full LoRA training and .phobos plugin support." />
              <CapCard delay={180} icon="🎬" color="#00ff41" status="LIVE" title="WAN Video Gen" body="State-of-the-art local video generation. Create cinematic motion directly from the PHOBOS workflow engine with 2.1/2.2 architecture support." />
              <CapCard delay={240} icon="🎮" color="#4eb8e0" status="LIVE" title="PHOBOS-Lite" body="Embedded integration for Primal Online. The engine now powers the world of Ilithria, running locally as a background service for NPCs, Companions, and Animals." />
              <CapCard delay={300} icon="⚡" color="#00ff41" status="LIVE" title="Verified Hardware Support" body="Native optimizations for the latest NVIDIA GEFORCE, AMD RADEON, and Intel ARC. LLMs and Image Generation integrates with every CPU and GPU architecture physically capable. No cloud, no telemetry — just raw hardware utilization." />
              <CapCard delay={360} icon="📄" color="#00ff41" status="LIVE" title="Write & Edit Files" body="Create, read, modify any text file format — source code, markdown, JSON, YAML, configs, documentation. PHOBOS writes directly to your local filesystem." />
              <CapCard delay={420} icon="🧠" color="#00ff41" status="LIVE" title="Deep Reasoning" body="SEREN's extended thinking chain works through multi-step logic, catches its own errors, and produces answers that have been internally reviewed before you see them." />
              <CapCard delay={480} icon="🔧" color="#00ff41" status="LIVE" title="Tool Calling" body="PHOBOS uses structured tool calls to create files, read directories, manage your workspace, and execute operations — not just suggest them. It acts, not advises." />
              <CapCard delay={540} icon="💬" color="#00ff41" status="LIVE" title="Long Context Sessions" body="Full conversation memory within a session. SAYON holds your entire project context so SEREN never loses the thread — no '3-message memory' limitations." />
              <CapCard delay={600} icon="🔌" color="#4eb8e0" status="LIVE" title="Skills System" body="Define custom skills that teach PHOBOS how to interact with your own services, APIs, and tools. Any workflow you can describe, PHOBOS can learn and repeat. 700+ compatible skills." />
              <CapCard delay={660} icon="⚙️" color="#4eb8e0" status="LIVE" title="Expandable by Design" body="The skills system means PHOBOS is never feature-frozen. If you can describe how to talk to a system, you can give PHOBOS that skill. Custom integrations, your own APIs, internal tools." />
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════════ */}
        {/* SECTION 3: WORKFLOW — IDEA TO COMPLETE SYSTEM */}
        {/* ══════════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the workflow multiplier</Eyebrow>
            <SectionHead line1="One idea." line2="Complete documentation in minutes." />
            <Body>
              The most powerful thing PHOBOS does is not answer questions — it is expand them. Give PHOBOS a single idea and it will follow every thread, cover every angle, and produce a complete system of documents you can use, share, and build on. Here is what that looks like in practice.
            </Body>

            <WorkflowDiagram steps={[
              { icon: '💡', label: 'YOUR IDEA', sublabel: '"Build a subscription billing system"', color: '#ffffff' },
              { icon: '🗺️', label: 'SAYON MAPS IT', sublabel: 'Identifies all components, edge cases, dependencies', color: '#4eb8e0' },
              { icon: '🧠', label: 'SEREN EXPANDS', sublabel: 'Deep reasoning on each component and tradeoff', color: '#ffaa33' },
              { icon: '📁', label: 'FILES CREATED', sublabel: 'Spec, architecture, API docs, data models, ERD', color: '#00ff41' },
              { icon: '🚀', label: 'YOU BUILD', sublabel: 'Real artifacts ready to use or share immediately', color: '#00ff41' },
            ]} />

            {/* Example output manifest */}
            <FadeIn delay={200}>
              <div style={{ border: '1px solid rgba(0,255,65,0.15)', borderRadius: 4, overflow: 'hidden', marginTop: 40 }}>
                <div style={{ background: 'rgba(0,255,65,0.05)', borderBottom: '1px solid rgba(0,255,65,0.12)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['rgba(255,65,65,0.6)', 'rgba(255,200,0,0.6)', 'rgba(0,255,65,0.6)'].map((c, i) => (
                      <div key={i} style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
                    ))}
                  </div>
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(0,255,65,0.45)', letterSpacing: '0.15em' }}>WORKSPACE — 8 FILES CREATED IN 4 MINUTES</span>
                </div>
                <div style={{ padding: '20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
                  {[
                    { file: 'architecture.md', desc: 'System overview + component diagram', color: '#4eb8e0' },
                    { file: 'api-spec.md', desc: 'Every endpoint, payload, response', color: '#00ff41' },
                    { file: 'data-models.md', desc: 'Schema + relationships + migrations', color: '#00ff41' },
                    { file: 'billing-logic.md', desc: 'Proration, retries, dunning flow', color: '#ffaa33' },
                    { file: 'security-review.md', desc: 'Threat model + PCI compliance notes', color: '#ffaa33' },
                    { file: 'webhook-spec.md', desc: 'Stripe events + idempotency handling', color: '#4eb8e0' },
                    { file: 'testing-plan.md', desc: 'Unit + integration + edge case coverage', color: '#00ff41' },
                    { file: 'implementation-order.md', desc: 'Phased rollout plan with risk assessment', color: '#4eb8e0' },
                  ].map((f) => (
                    <div key={f.file} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: f.color, marginTop: 2 }}>▸</span>
                      <div>
                        <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{f.file}</div>
                        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{f.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </FadeIn>

            <Body style={{ marginTop: 32 }}>
              Every one of those files is a real document on your local filesystem — ready to share with a team, paste into a meeting, hand to a contractor, or feed back into PHOBOS for the next phase of development. No copy-paste from a chat interface. No reformatting. Just a workspace full of work, produced in minutes, reviewed by two AI minds before you ever saw it.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════ */}
        {/* SECTION 4: THE SKILLS SYSTEM              */}
        {/* ══════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(78,184,224,0.6)">// the skills system — make phobos yours</Eyebrow>
            <SectionHead line1="Teach PHOBOS your world." line2="It learns how you work." line2Color="#4eb8e0" />
            <Body>
              PHOBOS ships with a built-in skills system — a way to give PHOBOS structured knowledge about any external system, service, or workflow you want it to interact with. A skill is a plain text file that tells PHOBOS how to talk to something: your internal API, a third-party service, a custom database schema, a specific output format your team uses.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Once a skill is loaded, PHOBOS can use that knowledge in any session. You do not have to re-explain your stack every time you open a new conversation. PHOBOS already knows. Skills are how PHOBOS goes from a general reasoning engine to an AI that understands your specific environment and can operate inside it precisely.
            </Body>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2, marginTop: 48 }}>
              {[
                { label: 'Custom API Integrations', body: 'Write a skill that describes your internal service endpoints, authentication patterns, and expected response shapes. PHOBOS will call them correctly on the first try.', color: '#4eb8e0', delay: 0 },
                { label: 'Output Format Templates', body: 'Tell PHOBOS exactly how your team formats documents, what fields a ticket requires, what structure a report should follow. It will match that format every time.', color: '#4eb8e0', delay: 80 },
                { label: 'Domain Knowledge', body: 'Give PHOBOS the context it needs for your industry, codebase, or project. Skills are how you encode institutional knowledge that a general model cannot have.', color: '#4eb8e0', delay: 160 },
                { label: 'Workflow Procedures', body: 'Encode multi-step procedures — deploy flows, review checklists, onboarding sequences. PHOBOS follows them with the same dual-pipeline reasoning it applies to everything else.', color: '#4eb8e0', delay: 240 },
              ].map((item) => (
                <FadeUp key={item.label} delay={item.delay}>
                  <div
                    style={{ background: 'rgba(78,184,224,0.03)', border: '1px solid rgba(78,184,224,0.12)', padding: '28px 24px', height: '100%', transition: 'border-color 200ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(78,184,224,0.3)')}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(78,184,224,0.12)')}
                  >
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#4eb8e0', marginBottom: 12 }}>{item.label}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.75, color: 'rgba(255,255,255,0.45)' }}>{item.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════════ */}
        {/* SECTION 5: THE HUMAN MULTIPLIER              */}
        {/* ══════════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// what this means for you</Eyebrow>
            <SectionHead line1="Supercharge yourself." line2="Execute without friction." />
            <Body>
              The best way to understand what PHOBOS changes is not to think about what it does — it's to think about what it removes. It removes the fifteen-minute research pass before you start a task. It removes the hour spent writing boilerplate you already understand. It removes the context-switching cost of looking things up, the cognitive load of holding an entire project spec in working memory, the wasted cycles on formatting output into the format someone else needs.
            </Body>
            <Body style={{ marginTop: 16 }}>
              What remains is you, working on the parts that actually require you. The judgment. The taste. The domain expertise. The decisions that depend on context only you have. PHOBOS handles everything that can be handled — so you can push harder on everything that cannot.
            </Body>
            <Body style={{ marginTop: 16 }}>
              This is not about doing less. It is about doing more of the work that matters — at higher quality, with less wasted effort, faster than you could manage alone. Every person who genuinely uses PHOBOS as a thinking partner becomes functionally more capable than they were before.
            </Body>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2, marginTop: 48 }}>
              {[
                { icon: '⚡', title: 'Cut Research Time', body: 'Ask PHOBOS to find the best approach to any problem and get a reasoned recommendation with tradeoffs laid out — in seconds, not hours.', color: '#00ff41', delay: 0 },
                { icon: '📐', title: 'Master Any Skill', body: 'Tell PHOBOS what you want to learn. It will structure a curriculum, explain concepts at your level, answer questions mid-lesson, and build exercises for you.', color: '#ffaa33', delay: 80 },
                { icon: '🔁', title: 'Reuse Your Work', body: 'Every document PHOBOS produces can be fed back into a new session. Plans become prompts. Specs become starters. Your output compounds instead of aging.', color: '#4eb8e0', delay: 160 },
                { icon: '🎯', title: 'Solve the Hard Ones', body: "Describe the actual problem — messy, incomplete, half-understood. PHOBOS will clarify it, identify what's actually being asked, and produce a genuine solution.", color: '#00ff41', delay: 240 },
                { icon: '🤝', title: 'Communicate Better', body: 'Turn your rough thoughts into clean, precise documents for other people. PHOBOS knows how to translate technical work into language any audience can act on.', color: '#ffaa33', delay: 320 },
                { icon: '🧬', title: 'Never Lose Context', body: "SAYON holds the full picture of your session. SEREN never starts cold. You don't have to re-explain your codebase, your preferences, or your constraints every time.", color: '#4eb8e0', delay: 400 },
              ].map((item) => (
                <FadeUp key={item.title} delay={item.delay}>
                  <div
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', padding: '24px', height: '100%', transition: 'border-color 200ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${item.color}33`)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
                  >
                    <div style={{ fontSize: 24, marginBottom: 12 }}>{item.icon}</div>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: item.color, marginBottom: 10 }}>{item.title}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.7, color: 'rgba(255,255,255,0.45)' }}>{item.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════════ */}
        {/* SECTION 6: VS CLOUD COMPARISON               */}
        {/* ══════════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// phobos vs cloud ai</Eyebrow>
            <SectionHead line1="Everything they offer." line2="Nothing they take." />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, marginTop: 40 }}>
              {/* Cloud AI column */}
              <div style={{ background: 'rgba(255,65,65,0.03)', border: '1px solid rgba(255,65,65,0.12)', padding: '32px 28px' }}>
                <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(255,65,65,0.6)', letterSpacing: '0.2em', marginBottom: 20 }}>CLOUD AI</div>
                {[
                  'Capable AI reasoning',
                  'File generation',
                  'Code writing',
                  'Document creation',
                  'Long context windows',
                  '$20–$200 / month',
                  'Your data trains their model',
                  'Offline: completely unavailable',
                  'One outage = no work',
                  'Policy updates change behavior',
                  'They own the model',
                  'You are the product',
                ].map((item, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                    <span style={{ color: i < 5 ? 'rgba(0,255,65,0.5)' : 'rgba(255,65,65,0.6)', fontFamily: "'Share Tech Mono', monospace", fontSize: 12, marginTop: 1, flexShrink: 0 }}>
                      {i < 5 ? '✓' : '×'}
                    </span>
                    <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: i < 5 ? 'rgba(255,255,255,0.5)' : 'rgba(255,100,100,0.5)', lineHeight: 1.5 }}>{item}</span>
                  </div>
                ))}
              </div>
              {/* PHOBOS column */}
              <div style={{ background: 'rgba(0,255,65,0.03)', border: '1px solid rgba(0,255,65,0.2)', padding: '32px 28px', position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.012) 2px, rgba(0,255,65,0.012) 4px)' }} />
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(0,255,65,0.6)', letterSpacing: '0.2em', marginBottom: 20 }}>◈ PHOBOS</div>
                  {[
                    'Dual-pipeline reasoning — verified output',
                    'Files written directly to your filesystem',
                    'Code, configs, full projects',
                    'Complete documentation suites',
                    'Full session context, no limits',
                    '$20 once. Patron Status.',
                    'Zero data ever leaves your machine',
                    'Offline: fully operational',
                    'No dependency on any external service',
                    'You control the model and its behavior',
                    'You own the weights you run',
                    'You are the only one it answers to',
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                      <span style={{ color: '#00ff41', fontFamily: "'Share Tech Mono', monospace", fontSize: 12, marginTop: 1, flexShrink: 0 }}>✓</span>
                      <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ══════════════════════════════════════════════ */}
        {/* FINAL CTA                                     */}
        {/* ══════════════════════════════════════════════ */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0', textAlign: 'center' }}>
            <Eyebrow>// ready to run it</Eyebrow>
            <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#fff', lineHeight: 1.05, marginBottom: 8 }}>
              Stop asking the cloud
            </h2>
            <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#00ff41', lineHeight: 1.05, display: 'block', marginBottom: 16 }}>
              for permission to think.
            </span>
            <Body style={{ maxWidth: 560, margin: '0 auto 40px', textAlign: 'center' }}>
              PHOBOS is ready to run on the hardware you already have. No subscriptions. No data centers. Two minds working for you alone.
            </Body>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
              <Link to="/phobos"
                style={{ background: '#00ff41', color: '#000', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', display: 'inline-block', transition: 'background 150ms' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#00ff41')}
              >
                LAUNCH PHOBOS →
              </Link>
              <Link to="/pricing"
                style={{ border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.6)', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', display: 'inline-block', transition: 'all 150ms' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
              >
              BECOME A SUPPORTER →
            </Link>
            </div>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(0,255,65,0.3)', letterSpacing: '0.12em', marginTop: 20 }}>
              // $20 once — runs offline — no data collected — dual-pipeline reasoning
            </p>
          </section>
        </FadeUp>

      </div>
    </MarketingLayout>
  );
}
