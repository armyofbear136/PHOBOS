import { useEffect, useRef, useState, ReactNode } from 'react';
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

/* ── Scanline overlay ── */
function Scanlines() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2, pointerEvents: 'none',
      background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.015) 2px, rgba(0,255,65,0.015) 4px)',
    }} />
  );
}

/* ── Section container ── */
function Section({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <section id={id} style={{ maxWidth: 1100, margin: '0 auto', padding: '100px 24px 60px' }}>
      {children}
    </section>
  );
}

/* ── Glowing bordered container ── */
function GlowBox({ children, color = 'rgba(0,255,65,0.15)', style = {} }: { children: ReactNode; color?: string; style?: React.CSSProperties }) {
  return (
    <div style={{
      border: `1px solid ${color}`,
      background: 'rgba(0,0,0,0.6)',
      borderRadius: 2,
      padding: '28px 24px',
      position: 'relative',
      boxShadow: `0 0 20px ${color}, inset 0 0 30px rgba(0,0,0,0.5)`,
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ── JSON code block ── */
function JsonBlock({ data }: { data: Record<string, string> }) {
  return (
    <pre style={{
      fontFamily: "'Share Tech Mono', monospace",
      fontSize: 12,
      color: 'rgba(0,255,65,0.7)',
      background: 'rgba(0,0,0,0.8)',
      border: '1px solid rgba(0,255,65,0.1)',
      borderRadius: 2,
      padding: '14px 18px',
      margin: '14px 0 0',
      overflow: 'auto',
    }}>
{`{`}
{Object.entries(data).map(([k, v]) => `\n  "${k}": "${v}"`).join(',')}
{`\n}`}
    </pre>
  );
}

/* ── Data-flow animated line ── */
function DataFlowLine() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
      <div style={{
        width: 2, height: 36,
        background: 'linear-gradient(180deg, rgba(0,255,65,0.5), rgba(0,255,65,0.05))',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100%', height: 12,
          background: 'rgba(0,255,65,0.8)',
          animation: 'dataFlow 1.5s ease-in-out infinite',
        }} />
      </div>
    </div>
  );
}

/* ── Slider component ── */
function IndustrialSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: 'rgba(0,255,65,0.7)', letterSpacing: '0.1em' }}>{label}</span>
        <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: '#00ff41' }}>{value.toFixed(2)}</span>
      </div>
      <div style={{ position: 'relative', height: 8, background: 'rgba(0,255,65,0.08)', border: '1px solid rgba(0,255,65,0.15)', borderRadius: 1 }}>
        <div style={{ height: '100%', width: `${value * 100}%`, background: 'linear-gradient(90deg, rgba(0,255,65,0.3), #00ff41)', borderRadius: 1, transition: 'width 0.15s' }} />
        <input
          type="range" min="0" max="100" value={value * 100}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          style={{ position: 'absolute', inset: 0, width: '100%', opacity: 0, cursor: 'pointer' }}
        />
      </div>
    </div>
  );
}

/* ── Animated cycle ── */
function AnimatedCycle({ steps }: { steps: string[] }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive(p => (p + 1) % steps.length), 1800);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 13,
            padding: '6px 14px',
            border: `1px solid ${i === active ? '#00ff41' : 'rgba(0,255,65,0.15)'}`,
            color: i === active ? '#00ff41' : 'rgba(255,255,255,0.35)',
            background: i === active ? 'rgba(0,255,65,0.08)' : 'transparent',
            transition: 'all 0.3s',
            boxShadow: i === active ? '0 0 12px rgba(0,255,65,0.2)' : 'none',
          }}>
            {s}
          </span>
          {i < steps.length - 1 && <span style={{ color: 'rgba(0,255,65,0.3)', fontSize: 14 }}>→</span>}
        </span>
      ))}
    </div>
  );
}

/* ── NES Cartridge ── */
function Cartridge({ name, path, trigger }: { name: string; path: string; trigger: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 160, minHeight: 200,
        background: hovered ? 'rgba(0,255,65,0.06)' : 'rgba(0,0,0,0.7)',
        border: `1px solid ${hovered ? 'rgba(0,255,65,0.5)' : 'rgba(0,255,65,0.12)'}`,
        borderRadius: 3,
        padding: '18px 14px',
        cursor: 'pointer',
        transition: 'all 0.25s',
        transform: hovered ? 'perspective(800px) rotateY(-4deg) scale(1.03)' : 'perspective(800px) rotateY(0deg)',
        boxShadow: hovered ? '0 0 24px rgba(0,255,65,0.15)' : 'none',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        position: 'relative',
      }}
    >
      {/* Cartridge notch */}
      <div style={{ width: '60%', height: 4, background: 'rgba(0,255,65,0.2)', margin: '0 auto 14px', borderRadius: 1 }} />
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#00ff41', letterSpacing: '0.15em', textAlign: 'center', marginBottom: 12 }}>
        {name}
      </div>
      <div style={{
        width: '70%', height: 40, margin: '0 auto 14px',
        background: 'rgba(0,255,65,0.05)',
        border: '1px solid rgba(0,255,65,0.1)',
        borderRadius: 2,
      }} />
      {hovered && (
        <div style={{
          position: 'absolute', bottom: -80, left: '50%', transform: 'translateX(-50%)',
          width: 240, padding: '10px 14px',
          background: 'rgba(0,0,0,0.95)',
          border: '1px solid rgba(0,255,65,0.3)',
          zIndex: 10,
          fontFamily: "'Share Tech Mono', monospace",
          fontSize: 10,
          lineHeight: 1.8,
          color: 'rgba(0,255,65,0.7)',
        }}>
          <div>PATH: {path}</div>
          <div>STATUS: <span style={{ color: '#00ff41' }}>ACTIVE</span></div>
          <div>TRIGGER: <span style={{ color: '#ff9f43' }}>{trigger}</span></div>
        </div>
      )}
    </div>
  );
}

/* ── System Log ── */
function SystemLog() {
  const lines = [
    { level: 'OK', msg: 'Scanned user/skills/ directory: 12 skills mounted.' },
    { level: 'INFO', msg: 'Scheduler initialized. Next task: "Daily Code Audit" at 09:00.' },
    { level: 'OK', msg: 'DuckDB connected: history_db active.' },
    { level: 'INFO', msg: 'Directive stack loaded: 3 layers verified.' },
    { level: 'OK', msg: 'TWIN SUN engine: dual-inference loop nominal.' },
    { level: 'INFO', msg: 'LoRA registry: 4 adapters indexed, 2 active.' },
  ];
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setOffset(p => (p + 1) % lines.length), 2400);
    return () => clearInterval(t);
  }, [lines.length]);

  return (
    <div style={{
      background: 'rgba(0,0,0,0.9)',
      border: '1px solid rgba(0,255,65,0.12)',
      padding: '16px 20px',
      fontFamily: "'Share Tech Mono', monospace",
      fontSize: 11,
      lineHeight: 2,
      overflow: 'hidden',
      maxHeight: 120,
    }}>
      {[...lines, ...lines].slice(offset, offset + 4).map((l, i) => (
        <div key={i} style={{ color: 'rgba(255,255,255,0.35)' }}>
          <span style={{ color: l.level === 'OK' ? '#00ff41' : '#ff9f43' }}>[{l.level}]</span> {l.msg}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */
/* ── MAIN PAGE ── */
/* ────────────────────────────────────────────────────────── */
export default function Control() {
  const [loraWeights, setLoraWeights] = useState({ texture: 0.72, palette: 0.55, geometry: 0.38 });

  return (
    <MarketingLayout>
      <Scanlines />
      <style>{`
        @keyframes dataFlow {
          0% { transform: translateY(-12px); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: translateY(36px); opacity: 0; }
        }
        @keyframes pulse-green {
          0%, 100% { box-shadow: 0 0 8px rgba(0,255,65,0.2); }
          50% { box-shadow: 0 0 20px rgba(0,255,65,0.4); }
        }
      `}</style>

      {/* ── HERO ── */}
      <Section>
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', textTransform: 'uppercase', marginBottom: 20 }}>
            PHOBOS // CONTROL CENTER
          </p>
          <h1 style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 'clamp(28px, 5vw, 54px)',
            fontWeight: 700,
            lineHeight: 1.05,
            color: '#fff',
            marginBottom: 16,
          }}>
            SYSTEM CONTROL CENTER
          </h1>
          <p style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 'clamp(16px, 2.5vw, 22px)',
            color: '#00ff41',
            marginBottom: 24,
          }}>
            [ SYSTEM_ROOT: /USER/CONTROL ]
          </p>
          <p style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 16,
            lineHeight: 1.8,
            color: 'rgba(255,255,255,0.5)',
            maxWidth: 600,
          }}>
            Architecting the logic of the TWIN SUN engine. Every directive, every skill, every scheduled task—controlled from here.
          </p>
        </FadeUp>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* SECTION 1: DIRECTIVE HIERARCHY */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section id="directives">
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 20 }}>
            § 01 — INTENT GROUNDING
          </p>
          <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            THE DIRECTIVE<br /><span style={{ color: '#00ff41' }}>HIERARCHY</span>
          </h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.5)', maxWidth: 650, marginBottom: 50 }}>
            Every thought PHOBOS generates is filtered through a three-layer directive stack. Higher-priority layers override lower ones. Your intent is never ambiguous.
          </p>
        </FadeUp>

        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <FadeUp delay={100}>
            <GlowBox color="rgba(0,255,65,0.12)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.15em', color: '#00ff41', background: 'rgba(0,255,65,0.1)', padding: '3px 10px', border: '1px solid rgba(0,255,65,0.2)' }}>LAYER 1</span>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#fff' }}>User Directives (Global)</span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                Stored in <code style={{ color: '#00ff41', fontSize: 12 }}>~/.phobos/user/settings.json</code>. Permanent behavioral rules, coding standards, and personal identity. Applied to every session.
              </p>
              <JsonBlock data={{ directive_type: "USER_GLOBAL", priority: "BASE", scope: "ALL_SESSIONS" }} />
            </GlowBox>
          </FadeUp>

          <DataFlowLine />

          <FadeUp delay={200}>
            <GlowBox color="rgba(0,180,255,0.12)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.15em', color: '#00b4ff', background: 'rgba(0,180,255,0.1)', padding: '3px 10px', border: '1px solid rgba(0,180,255,0.2)' }}>LAYER 2</span>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#fff' }}>Project Directives (Workspace)</span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                Context-specific rules for the current folder. e.g., "This project is Ilithria: Godot 4.6." Activates automatically when PHOBOS opens a workspace.
              </p>
              <JsonBlock data={{ directive_type: "PROJECT_WORKSPACE", priority: "HIGH", scope: "CURRENT_FOLDER" }} />
            </GlowBox>
          </FadeUp>

          <DataFlowLine />

          <FadeUp delay={300}>
            <GlowBox color="rgba(255,159,67,0.12)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.15em', color: '#ff9f43', background: 'rgba(255,159,67,0.1)', padding: '3px 10px', border: '1px solid rgba(255,159,67,0.2)' }}>LAYER 3</span>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#fff' }}>Chat Directives (Session)</span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                High-priority, transient overrides for the active thread. These take precedence over all other layers and expire when the chat closes.
              </p>
              <JsonBlock data={{ directive_type: "SESSION_OVERRIDE", priority: "CRITICAL", scope: "ACTIVE_THREAD" }} />
            </GlowBox>
          </FadeUp>
        </div>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* SECTION 2: SKILL LIBRARY (NES CARTRIDGE RACK) */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section id="skills">
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 20 }}>
            § 02 — PORTABLE SKILL LIBRARY
          </p>
          <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            THE CARTRIDGE<br /><span style={{ color: '#00ff41' }}>RACK</span>
          </h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.5)', maxWidth: 650, marginBottom: 20 }}>
            Skills are portable folders—<code style={{ color: '#00ff41', fontSize: 14 }}>SKILL.md</code> + <code style={{ color: '#00ff41', fontSize: 14 }}>manifest.json</code>—that plug and play when dropped into <code style={{ color: '#00ff41', fontSize: 14 }}>~/.phobos/user/skills/</code>. No database. No configuration wizard. Just files.
          </p>
        </FadeUp>

        <FadeUp delay={150}>
          <div style={{
            display: 'flex', gap: 20, flexWrap: 'wrap', justifyContent: 'center',
            padding: '40px 0 60px',
            perspective: '1000px',
          }}>
            <Cartridge name="GODOT_4" path="~/.phobos/user/skills/godot_4" trigger="DETECTED_VIA_SAYON" />
            <Cartridge name="REACT_TS" path="~/.phobos/user/skills/react_ts" trigger="FILE_PATTERN: *.tsx" />
            <Cartridge name="RUST_SYS" path="~/.phobos/user/skills/rust_sys" trigger="CARGO.TOML DETECTED" />
            <Cartridge name="UNITY_CS" path="~/.phobos/user/skills/unity_cs" trigger="ASSEMBLY_DEF FOUND" />
            <Cartridge name="LORA_ART" path="~/.phobos/user/skills/lora_art" trigger="WORKFLOW_PANEL" />
            <Cartridge name="VIDEO_GEN" path="~/.phobos/user/skills/video_gen" trigger="WAN_2.2_LOADED" />
          </div>
        </FadeUp>

        <FadeUp delay={250}>
          <GlowBox style={{ maxWidth: 500, margin: '0 auto' }}>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#ff9f43', letterSpacing: '0.15em', marginBottom: 10 }}>NO-DATABASE ARCHITECTURE</p>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
              Skills are self-contained directories. Copy them between machines, share them via USB, or version-control them with Git. PHOBOS scans the skills folder on launch and mounts every valid cartridge automatically.
            </p>
          </GlowBox>
        </FadeUp>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* SECTION 3: AUTOMATION QUEUE */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section id="automation">
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 20 }}>
            § 03 — SCHEDULING SYSTEM
          </p>
          <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            AUTOMATION<br /><span style={{ color: '#00ff41' }}>QUEUE</span>
          </h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.5)', maxWidth: 650, marginBottom: 50 }}>
            Cron-based scheduling with full run history. Scheduled tasks fire identical requests to manual prompts—ensuring consistent behavior between automation and chat.
          </p>
        </FadeUp>

        <FadeUp delay={150}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20 }}>
            {/* Left: Task Builder */}
            <GlowBox>
              <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#00ff41', letterSpacing: '0.15em', marginBottom: 16 }}>TASK BUILDER</p>
              <div style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.1)', padding: '14px 18px', marginBottom: 14 }}>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>CRON EXPRESSION</p>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 18, color: '#00ff41' }}>0 9 * * 1</p>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.1)', padding: '14px 18px', marginBottom: 14 }}>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>NEXT RUN PREVIEW</p>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#ff9f43' }}>Monday, 09:00 AM (LOCAL)</p>
              </div>
              <div style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,65,0.1)', padding: '14px 18px' }}>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 6 }}>TASK PROMPT</p>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>"Run a full code audit on the current workspace and generate a diff report."</p>
              </div>
            </GlowBox>

            {/* Right: Run History */}
            <GlowBox>
              <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#00ff41', letterSpacing: '0.15em', marginBottom: 16 }}>RUN HISTORY — DuckDB</p>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, lineHeight: 2.2 }}>
                {[
                  { id: 'RUN-0041', status: 'SUCCESS', time: '4.2s' },
                  { id: 'RUN-0040', status: 'SUCCESS', time: '3.8s' },
                  { id: 'RUN-0039', status: 'FAIL', time: '12.1s' },
                  { id: 'RUN-0038', status: 'SUCCESS', time: '5.0s' },
                  { id: 'RUN-0037', status: 'SUCCESS', time: '3.4s' },
                  { id: 'RUN-0036', status: 'SUCCESS', time: '4.7s' },
                ].map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(0,255,65,0.06)', padding: '2px 0' }}>
                    <span style={{ color: 'rgba(255,255,255,0.4)' }}>{r.id}</span>
                    <span style={{ color: r.status === 'SUCCESS' ? '#00ff41' : '#ff4444' }}>{r.status}</span>
                    <span style={{ color: 'rgba(255,255,255,0.25)' }}>{r.time}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(0,180,255,0.05)', border: '1px solid rgba(0,180,255,0.15)' }}>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: '#00b4ff', letterSpacing: '0.1em' }}>
                  INTERNAL HTTP PIPELINE — scheduled tasks fire identical requests to manual user prompts
                </p>
              </div>
            </GlowBox>
          </div>
        </FadeUp>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* SECTION 4: ARTIST PLUGIN WORKSHOP */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section id="lora">
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 20 }}>
            § 04 — LoRA SYNTHESIS
          </p>
          <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            ARTIST PLUGIN<br /><span style={{ color: '#ff9f43' }}>WORKSHOP</span>
          </h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.5)', maxWidth: 650, marginBottom: 50 }}>
            The training and blending pipeline for custom styles. From dataset curation to inference-ready .phobos containers.
          </p>
        </FadeUp>

        {/* Training Pipeline */}
        <FadeUp delay={100}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 40 }}>
            {[
              { stage: 'STAGE 1', title: 'DATASET', desc: 'Auto-captioning via Florence-2. Curate, tag, and validate training images.', color: '#00ff41' },
              { stage: 'STAGE 2', title: 'TRAINING', desc: 'Hardware-gated: 10GB+ VRAM required. Full LoRA fine-tuning with rank selection.', color: '#ff9f43' },
              { stage: 'STAGE 3', title: 'INFERENCE', desc: 'Export to .phobos container format. Drop into the workflow panel and blend.', color: '#00b4ff' },
            ].map((s) => (
              <GlowBox key={s.stage} color={s.color === '#00ff41' ? 'rgba(0,255,65,0.12)' : s.color === '#ff9f43' ? 'rgba(255,159,67,0.12)' : 'rgba(0,180,255,0.12)'}>
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, letterSpacing: '0.15em', color: s.color }}>{s.stage}</span>
                <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 16, color: '#fff', margin: '10px 0 8px' }}>{s.title}</p>
                <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>{s.desc}</p>
              </GlowBox>
            ))}
          </div>
        </FadeUp>

        {/* Blending Console */}
        <FadeUp delay={250}>
          <GlowBox color="rgba(255,159,67,0.12)" style={{ maxWidth: 500, margin: '0 auto' }}>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#ff9f43', letterSpacing: '0.15em', marginBottom: 20 }}>BLENDING CONSOLE</p>
            <IndustrialSlider label="TEXTURE" value={loraWeights.texture} onChange={(v) => setLoraWeights(p => ({ ...p, texture: v }))} />
            <IndustrialSlider label="PALETTE" value={loraWeights.palette} onChange={(v) => setLoraWeights(p => ({ ...p, palette: v }))} />
            <IndustrialSlider label="GEOMETRY" value={loraWeights.geometry} onChange={(v) => setLoraWeights(p => ({ ...p, geometry: v }))} />
            <div style={{ marginTop: 14, padding: '8px 12px', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(0,255,65,0.08)', fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(0,255,65,0.5)' }}>
              COMPOSITE WEIGHT: {(loraWeights.texture + loraWeights.palette + loraWeights.geometry).toFixed(2)} / 3.00
            </div>
          </GlowBox>
        </FadeUp>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* SECTION 5: HARDWARE ORCHESTRATION */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section id="hardware">
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 20 }}>
            § 05 — HARDWARE-AWARE ORCHESTRATION
          </p>
          <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            THE<br /><span style={{ color: '#00b4ff' }}>SCHEDULER</span>
          </h2>
          <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.5)', maxWidth: 650, marginBottom: 50 }}>
            Real-time resource allocation across the TWIN SUN engine. SAYON claims compute for intent triage. SEREN claims VRAM for deep reasoning. No conflicts. No bottlenecks.
          </p>
        </FadeUp>

        <FadeUp delay={150}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, marginBottom: 40 }}>
            {/* SAYON Monitor */}
            <GlowBox color="rgba(0,180,255,0.15)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00b4ff', animation: 'pulse-green 2s infinite' }} />
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#00b4ff', letterSpacing: '0.1em' }}>SAYON MONITOR</span>
              </div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, lineHeight: 2.2, color: 'rgba(255,255,255,0.4)' }}>
                <div>MODE: <span style={{ color: '#00b4ff' }}>COMPUTE-PRIMARY</span></div>
                <div>ROLE: Intent Triage & Ingest</div>
                <div>MULTIMODAL: Vision Passthrough Active</div>
                <div>RAG: DuckDB VSS — Connected</div>
                <div>CPU ALLOC: <span style={{ color: '#00ff41' }}>60%</span></div>
              </div>
            </GlowBox>

            {/* SEREN Monitor */}
            <GlowBox color="rgba(255,159,67,0.15)">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff9f43', animation: 'pulse-green 2s infinite' }} />
                <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: '#ff9f43', letterSpacing: '0.1em' }}>SEREN MONITOR</span>
              </div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, lineHeight: 2.2, color: 'rgba(255,255,255,0.4)' }}>
                <div>MODE: <span style={{ color: '#ff9f43' }}>VRAM-PRIMARY</span></div>
                <div>ROLE: Deep Reasoning & Planning</div>
                <div>CHAIN: Verification Loop Active</div>
                <div>VRAM ALLOC: <span style={{ color: '#00ff41' }}>48GB UMA PARTITION</span></div>
                <div>GPU UTIL: <span style={{ color: '#00ff41' }}>82%</span></div>
              </div>
            </GlowBox>
          </div>
        </FadeUp>

        {/* The Loop */}
        <FadeUp delay={300}>
          <GlowBox style={{ textAlign: 'center', padding: '30px 24px' }}>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: '#00ff41', letterSpacing: '0.2em', marginBottom: 20 }}>ORCHESTRATION CYCLE</p>
            <AnimatedCycle steps={['INGEST', 'HANDOFF', 'PLANNING', 'EXECUTION']} />
          </GlowBox>
        </FadeUp>
      </Section>

      {/* ═══════════════════════════════════════════════════ */}
      {/* TECHNICAL FOOTER / SYSTEM LOG */}
      {/* ═══════════════════════════════════════════════════ */}
      <Section>
        <FadeUp>
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.55)', marginBottom: 16 }}>
            SYSTEM // LOG OUTPUT
          </p>
          <SystemLog />
          <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 30, textAlign: 'center', letterSpacing: '0.1em' }}>
            SYSTEM // CORE: [SUCCESS] Verified Execution Loop complete. Delivery ready.
          </p>
        </FadeUp>
      </Section>
    </MarketingLayout>
  );
}
