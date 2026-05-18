import { useEffect, useRef, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';

/* ─── Color tokens ─── */
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

function FadeUp({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.08 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} style={{
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(20px)',
      transition: `opacity 700ms ease-out ${delay}ms, transform 700ms ease-out ${delay}ms`,
    }}>
      {children}
    </div>
  );
}

function Eyebrow({ children, color = C.greenDim }: { children: ReactNode; color?: string }) {
  return (
    <p style={{ ...MONO, fontSize: 11, letterSpacing: '0.25em', color, textTransform: 'uppercase', marginBottom: 18 }}>
      {children}
    </p>
  );
}

function SectionHead({ line1, line2, line2Color = C.green }: { line1: string; line2?: string; line2Color?: string }) {
  return (
    <h2 style={{ ...MONO, fontSize: 'clamp(30px,5vw,56px)', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em', color: '#fff', marginBottom: 28 }}>
      {line1}{line2 && <><br /><span style={{ color: line2Color }}>{line2}</span></>}
    </h2>
  );
}

function Body({ children, style = {} }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ ...SANS, fontSize: 16, lineHeight: 1.8, color: C.textMid, maxWidth: 680, ...style }}>{children}</p>
  );
}

function Rule() {
  return <div style={{ height: 1, background: C.hairline, width: '100%' }} />;
}

function StatChip({ value, label, accent = C.green }: { value: string; label: string; accent?: string }) {
  return (
    <div style={{ border: `1px solid ${accent}33`, padding: '20px 24px', borderRadius: 4, textAlign: 'center', minWidth: 160 }}>
      <div style={{ ...MONO, fontSize: 'clamp(20px,3vw,28px)', color: accent, letterSpacing: '0.04em' }}>{value}</div>
      <div style={{ ...MONO, fontSize: 10, color: C.textLow, letterSpacing: '0.15em', textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
    </div>
  );
}

/* ── Terminal block ── */
function TerminalBlock({ lines }: { lines: { role: string; color: string; text: string }[] }) {
  return (
    <div style={{
      marginTop: 36,
      background: '#06080a',
      border: `1px solid ${C.hairline}`,
      borderLeft: `2px solid ${C.green}`,
      borderRadius: 3,
      padding: '22px 24px',
      ...MONO,
      fontSize: 13,
      lineHeight: 1.75,
      overflowX: 'auto',
    }}>
      <div style={{ color: C.textLow, fontSize: 10, letterSpacing: '0.25em', marginBottom: 14 }}>
        // SESSION_LOG :: phobos.local :: 03:42:17
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ marginBottom: 8, display: 'flex', gap: 12 }}>
          <span style={{ color: l.color, minWidth: 70, flexShrink: 0 }}>[{l.role}]</span>
          <span style={{ color: C.text }}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ── License badge ── */
const LICENSE_COLORS: Record<string, { bg: string; fg: string }> = {
  MIT: { bg: 'rgba(0,255,65,0.15)', fg: 'rgba(0,255,65,0.7)' },
  ISC: { bg: 'rgba(0,255,65,0.15)', fg: 'rgba(0,255,65,0.7)' },
  'Apache 2.0': { bg: 'rgba(78,184,224,0.15)', fg: 'rgba(78,184,224,0.7)' },
  'BSD 2-Clause': { bg: 'rgba(245,158,11,0.15)', fg: 'rgba(245,158,11,0.7)' },
  BSD: { bg: 'rgba(245,158,11,0.15)', fg: 'rgba(245,158,11,0.7)' },
  'GPL 3.0': { bg: 'rgba(255,100,100,0.15)', fg: 'rgba(255,100,100,0.7)' },
  'GPL 2.0': { bg: 'rgba(255,100,100,0.15)', fg: 'rgba(255,100,100,0.7)' },
  'GPL 2.0+': { bg: 'rgba(255,100,100,0.15)', fg: 'rgba(255,100,100,0.7)' },
  'LGPL 2.1': { bg: 'rgba(255,100,100,0.15)', fg: 'rgba(255,100,100,0.7)' },
  'EPL 2.0': { bg: 'rgba(255,150,50,0.15)', fg: 'rgba(255,150,50,0.7)' },
  'MPL 2.0': { bg: 'rgba(180,100,255,0.15)', fg: 'rgba(180,100,255,0.7)' },
  'Stability AI Community': { bg: 'rgba(200,200,200,0.15)', fg: 'rgba(200,200,200,0.5)' },
};

function LicenseBadge({ license }: { license: string }) {
  const c = LICENSE_COLORS[license] || { bg: 'rgba(200,200,200,0.15)', fg: 'rgba(200,200,200,0.5)' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2, fontSize: 8,
      ...MONO, letterSpacing: '0.1em', background: c.bg, color: c.fg, textTransform: 'uppercase',
    }}>
      {license}
    </span>
  );
}

/* ── Timeline ── */
const MILESTONES = [
  { day: 'Day 1', text: 'Architecture and first LLM inference loop' },
  { day: 'Day 5', text: 'SAYON/SEREN dual-pipeline operational' },
  { day: 'Day 12', text: 'Archive system (MemPalace-inspired) and SYBIL embedding' },
  { day: 'Day 18', text: 'Image generation via sd-cli, FLUX model support' },
  { day: 'Day 23', text: 'Crystal Engine DAW, Efflux port, Carla/PhobosHost VST3 stack' },
  { day: 'Day 28', text: 'Jellyfin, Kavita, Polaris, mpv — Broadway Media Center' },
  { day: 'Day 33', text: 'Security scanner (7 modules, tree-sitter code audit)' },
  { day: 'Day 38', text: '3D editors: Blockbench, SculptGL, Godot 4 web' },
  { day: 'Day 42', text: 'Scheduler, game engine, task planning' },
  { day: 'Day 48', text: 'Patron certificate system, cross-platform SEA build' },
  { day: 'Day 55', text: 'v1.0 release' },
];

/* ── Doctrine ── */
const DOCTRINE = [
  {
    title: 'Start with understanding, not generation',
    accent: C.green,
    body: "The prompt that produces useful software is not 'build me X.' It is 'I want to understand how X works so we can build it together.' Ask your AI to explain the architecture before the first line is written. Ask what breaks. Ask why a different approach might be better. Your job is to understand — not to have it generated for you. You are the developer. The AI is the fastest, most patient senior engineer you will ever have access to.",
  },
  {
    title: 'Documentation before code',
    accent: C.amber,
    body: 'Every system in PHOBOS has a design document that was written before implementation began. That document is the context you feed into the next AI session. It is how you survive a context window ending. It is how you onboard yourself three weeks later when you have forgotten why a thing works the way it does. The documentation is not the output. It is the brain of the project. Build it first.',
  },
  {
    title: 'Understand every error before you fix it',
    accent: C.blue,
    body: "When something breaks, do not paste the error and accept the fix. Read the error. Form a hypothesis. Ask the AI to explain what the error means and why it might have happened before you ask for a solution. An error you don't understand is a debt — it will come back in a different form at a worse time. An error you understand is something you now know that you didn't know before. Every bug is a free lesson. Take the lesson.",
  },
  {
    title: 'Never carry debt forward',
    accent: C.amber,
    body: 'The current piece of the system should be completely understood and stable before the next piece is started. Not working — understood. There should be no open questions about what it does, why it does it, and how it connects to the rest. This discipline is what separates a project that grows coherently from one that accumulates mystery. On day 55 of PHOBOS, every system made sense because every previous day had been closed cleanly.',
  },
  {
    title: 'The model is not the brain',
    accent: C.green,
    body: 'The single most important thing to understand about building AI systems: the capability comes from what you build around the model, not from the model itself. Invest heavily in context management, memory architecture, and skill injection. A well-orchestrated small model will outperform a poorly-orchestrated large one for your specific use case, every time. Build the brain. The model is just the engine.',
  },
];

/* ── Featured credits ── */
const FEATURED_CREDITS = [
  {
    name: 'MemPalace',
    license: 'MIT',
    border: 'rgba(0,255,65,0.6)',
    link: 'https://github.com/MemPalace/mempalace',
    text: 'The PHOBOS Archive system — the memory layer that lets SYBIL organize knowledge into domains, retrieve it semantically, and keep it local — is directly inspired by MemPalace. MemPalace is the best-benchmarked open-source AI memory system in existence, achieving 96.6% recall on LongMemEval with no API calls and no cloud. Its insight about structured memory — palace, wing, room, drawer — is the architectural foundation for how PHOBOS thinks about knowledge. Go star it.',
  },
  {
    name: 'Alda — by Dave Yarwood',
    license: 'EPL 2.0',
    border: 'rgba(245,158,11,0.6)',
    link: 'https://github.com/alda-lang/alda',
    text: 'The Crystal Engine uses a clean-room TypeScript implementation of the Alda music notation language — a text-based format for composing music that Dave Yarwood has been building since 2012. The PHOBOS ALDA parser covers the notation subset used for AI-to-MIDI generation: notes, durations, octaves, chords, rests, and instrument assignment. No Alda source code is linked or bundled, but the language design is entirely his work.',
  },
  {
    name: 'Efflux Tracker — by Igor Zinken',
    license: 'MIT',
    border: 'rgba(78,184,224,0.6)',
    link: 'https://github.com/igorski/efflux-tracker',
    text: "The Crystal Engine DAW UI is a React port of Efflux Tracker — Igor Zinken's browser-based music tracker and sequencer. The visual and interaction design of the pattern editor, the channel layout, the transport controls — all of it is Efflux's work, ported to React and integrated into the PHOBOS audio pipeline. Full attribution preserved per MIT terms.",
  },
];

/* ── Compact credits ── */
const CREDIT_GROUPS: { category: string; entries: { name: string; license: string }[] }[] = [
  {
    category: 'UI Framework',
    entries: [
      { name: 'React', license: 'MIT' },
      { name: 'React Router', license: 'MIT' },
      { name: 'Vite', license: 'MIT' },
      { name: 'TypeScript', license: 'Apache 2.0' },
    ],
  },
  {
    category: 'Component Library',
    entries: [
      { name: 'Radix UI', license: 'MIT' },
      { name: 'shadcn/ui', license: 'MIT' },
      { name: 'Tailwind CSS', license: 'MIT' },
      { name: 'Lucide React', license: 'ISC' },
      { name: 'Monaco Editor', license: 'MIT' },
      { name: 'TipTap', license: 'MIT' },
      { name: 'Zustand', license: 'MIT' },
      { name: 'TanStack Query', license: 'MIT' },
      { name: 'Zod', license: 'MIT' },
      { name: 'Phaser', license: 'MIT' },
      { name: 'Recharts', license: 'MIT' },
    ],
  },
  {
    category: 'Backend & Runtime',
    entries: [
      { name: 'Node.js', license: 'MIT' },
      { name: 'Fastify', license: 'MIT' },
      { name: 'DuckDB', license: 'MIT' },
      { name: 'OpenAI Node SDK', license: 'Apache 2.0' },
      { name: 'sharp', license: 'Apache 2.0' },
      { name: 'exifr', license: 'MIT' },
      { name: 'fluent-ffmpeg', license: 'MIT' },
      { name: 'mammoth', license: 'BSD 2-Clause' },
      { name: 'pdfjs-dist', license: 'Apache 2.0' },
      { name: 'SheetJS', license: 'Apache 2.0' },
      { name: 'tree-sitter', license: 'MIT' },
      { name: 'wasm-pandoc', license: 'MIT' },
    ],
  },
  {
    category: 'ML & Inference',
    entries: [
      { name: 'llama.cpp', license: 'MIT' },
      { name: 'stable-diffusion.cpp', license: 'MIT' },
      { name: 'Whisper.cpp', license: 'MIT' },
      { name: 'nomic-embed-text-v1.5', license: 'Apache 2.0' },
      { name: '@xenova/transformers', license: 'Apache 2.0' },
      { name: 'onnxruntime-node', license: 'MIT' },
    ],
  },
  {
    category: 'AI Models',
    entries: [
      { name: 'Wan 2.2', license: 'Apache 2.0' },
      { name: 'ACE-Step 1.5 XL', license: 'Apache 2.0' },
      { name: 'VoxCPM2', license: 'Apache 2.0' },
      { name: 'Stable Audio Open', license: 'Stability AI Community' },
      { name: 'Netflix VOID', license: 'Apache 2.0' },
    ],
  },
  {
    category: 'Media Servers',
    entries: [
      { name: 'Jellyfin', license: 'LGPL 2.1' },
      { name: 'Kavita', license: 'GPL 3.0' },
      { name: 'Polaris', license: 'MIT' },
      { name: 'mpv', license: 'GPL 2.0+' },
    ],
  },
  {
    category: '3D Editors',
    entries: [
      { name: 'Blockbench', license: 'GPL 3.0' },
      { name: 'SculptGL', license: 'MIT' },
      { name: 'Godot 4 Web Editor', license: 'MIT' },
    ],
  },
  {
    category: 'External Tools',
    entries: [
      { name: 'Helm', license: 'GPL 3.0' },
      { name: 'Surge XT', license: 'GPL 3.0' },
      { name: 'GIMP', license: 'GPL 3.0' },
      { name: 'GTK3/Broadway', license: 'LGPL 2.1' },
      { name: 'Pandoc', license: 'GPL 2.0' },
      { name: 'ClamAV', license: 'GPL 2.0' },
      { name: 'Camofox', license: 'MPL 2.0' },
      { name: 'Stirling-PDF', license: 'MIT' },
    ],
  },
];

export default function HowPhobosWasBuilt() {
  return (
    <MarketingLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '120px 24px 96px' }}>

        {/* ── SECTION 0: HERO ── */}
        <FadeUp>
          <section style={{ marginBottom: 96, textAlign: 'center' }}>
            <Eyebrow>// 55 days. 8 free claudes. zero compromises.</Eyebrow>
            <h1 style={{ ...MONO, fontSize: 'clamp(36px,6vw,72px)', fontWeight: 700, lineHeight: 1.02, color: '#fff', marginBottom: 8 }}>
              This is what you can build
            </h1>
            <h1 style={{ ...MONO, fontSize: 'clamp(36px,6vw,72px)', fontWeight: 700, lineHeight: 1.02, color: C.green, marginBottom: 48 }}>
              when you build it right.
            </h1>

            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 48 }}>
              <StatChip value="55" label="days to build" accent={C.green} />
              <StatChip value="7x Free Claude Accounts" label="1x $20 Plan for Opus 4.7" accent={C.amber} />
              <StatChip value="∞" label="hardware you already own" accent={C.blue} />
              <StatChip value="$0/mo" label="to run forever" accent={C.green} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Body style={{ textAlign: 'left' }}>
                PHOBOS is a full AI operating system — LLM inference, image generation, a DAW, a media center, a security scanner, a 3D editor suite, a semantic archive, and a built-in game engine — built by one person in 55 days using Claude's free tier. Not as a prototype. As a working system. This page is the story of how, and the argument for why you should build yours.
              </Body>
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 1: WHAT AI ACTUALLY IS ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the thing most people are using ai wrong</Eyebrow>
            <SectionHead line1="The model is not" line2="the brain." line2Color={C.amber} />
            <Body>Every AI product you have ever been sold is, at its core, a language model responding to a context window. What makes those products different from each other — what makes one capable and one useless for your specific needs — is not the model. It is everything built around the model.</Body>
            <Body style={{ marginTop: 16 }}>The system prompt. The memory retrieval. The skill injection. The context management that decides what gets included and what gets compressed. The loop controller that determines when the AI asks for more information versus when it acts. The tool layer that connects it to real data. Change any of these and you change the AI fundamentally — even with the same weights.</Body>
            <Body style={{ marginTop: 16 }}>This is the insight that PHOBOS is built on. SAYON, SEREN, and SYBIL are not three different models. They are three different orchestration configurations on top of the same inference engine. SAYON reasons about tasks and drives the loop. SEREN executes with depth and generates content. SYBIL embeds and retrieves. Same hardware. Same binaries. Different architecture.</Body>
            <Body style={{ marginTop: 16 }}>When you understand this, you stop asking 'which AI should I use' and start asking 'what do I need to build around the model I already have.' That is the right question. PHOBOS is one answer to it. Your answer will be different — and it should be.</Body>

            <TerminalBlock lines={[
              { role: 'USER', color: C.textLow, text: 'Find the doc where I described the loop controller failure modes, then propose a fix for the retry loop.' },
              { role: 'SAYON', color: C.green, text: 'Plan: 1) query SYBIL for relevant archive entry. 2) hand summary + current loop.ts to SEREN for code analysis. 3) return diff.' },
              { role: 'SYBIL', color: C.blue, text: 'Match: archive/design/loop-controller.md  ::  similarity 0.91  ::  domain=architecture' },
              { role: 'SAYON', color: C.green, text: 'Handoff → SEREN with archive excerpt + loop.ts (118 lines) + 3 prior commit notes.' },
              { role: 'SEREN', color: C.amber, text: 'Identified retry loop unbounded on tool-error. Proposed exponential backoff w/ ceiling at 5 attempts. Generated patch.' },
              { role: 'SAYON', color: C.green, text: 'Returning patch + rationale. Ready for review.' },
            ]} />
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 2: POCKET CLAUDE ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// qwen distilled by opus — your local reasoning engine</Eyebrow>
            <SectionHead line1="A true reasoning model." line2="In your pocket." line2Color={C.blue} />
            <Body>PHOBOS ships with support for the latest Qwen models distilled by Claude Opus. These are not toy models. They reason. They follow multi-step instructions. They push back when something is wrong. They run on a gaming laptop at speeds that feel real-time.</Body>
            <Body style={{ marginTop: 16 }}>The distillation process means Opus's reasoning patterns — the habits of thought that make it useful — have been transferred into weights small enough to run locally. You get a pocket Claude. Not a simulation of one. Not an approximation. The actual behavioral patterns, running on hardware you own, answering only to you.</Body>
            <Body style={{ marginTop: 16 }}>This is what 'local AI' means at its best. Not a compromised version of the cloud. A capable, sovereign, purpose-built reasoning system that runs on 65 watts instead of 20 megawatts.</Body>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 40 }}>
              <div style={{ background: 'rgba(255,100,100,0.05)', border: '1px solid rgba(255,100,100,0.2)', padding: '28px 24px', borderRadius: 3 }}>
                <div style={{ ...MONO, fontSize: 14, color: 'rgba(255,100,100,0.85)', marginBottom: 18, letterSpacing: '0.08em' }}>Cloud AI</div>
                <ul style={{ ...SANS, fontSize: 13, lineHeight: 1.9, color: C.textMid, paddingLeft: 18, margin: 0 }}>
                  <li>Your queries train the next model</li>
                  <li>Data leaves your machine</li>
                  <li>Subscription required</li>
                  <li>Outage = no AI</li>
                  <li>Model updated without your consent</li>
                  <li>Context window sold as a feature</li>
                </ul>
              </div>
              <div style={{ background: 'rgba(0,255,65,0.05)', border: `1px solid ${C.hairlineGreen}`, padding: '28px 24px', borderRadius: 3 }}>
                <div style={{ ...MONO, fontSize: 14, color: C.green, marginBottom: 18, letterSpacing: '0.08em' }}>PHOBOS Local</div>
                <ul style={{ ...SANS, fontSize: 13, lineHeight: 1.9, color: C.textMid, paddingLeft: 18, margin: 0 }}>
                  <li>Zero telemetry — hardware constraint, not policy</li>
                  <li>Nothing leaves localhost</li>
                  <li>One-time download, runs forever</li>
                  <li>Offline capable</li>
                  <li>You choose which model runs</li>
                  <li>Context managed by your orchestration</li>
                </ul>
              </div>
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 3: THE 55 DAYS ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the build — how it actually happened</Eyebrow>
            <SectionHead line1="One person." line2="55 days." line2Color={C.amber} />
            <Body>Day 1 was a conversation about architecture. Not 'build me an app' — 'help me understand how a local LLM inference server works, what the failure modes are, and what I need to build around it to make it useful.' That conversation became the foundation. Everything else built on top of it.</Body>
            <Body style={{ marginTop: 16 }}>The rule was simple: never move forward until the current piece was completely understood. Not just working — understood. Every function, every data flow, every error message explained before the next one was written. This is slower than pasting errors into Claude and accepting whatever fix comes back. It is also how you build something that works 55 days later instead of having 55 days of technical debt you cannot explain.</Body>
            <Body style={{ marginTop: 16 }}>The documentation was written first. Every major system — the loop controller, the archive architecture, the audio pipeline, the boot sequence — existed as a design document before a single line of code. That document became the context for every AI session that followed. It is why the project is coherent. A project without documentation is a project that only exists inside your head, and context windows end.</Body>
            <Body style={{ marginTop: 16 }}>At the end of 55 days: dual-pipeline LLM orchestration, image and video generation via FLUX and Wan, a browser-based DAW with VST3 support, Jellyfin and Kavita and Polaris integration, a MemPalace-inspired semantic archive, a security scanner with seven modules, a full IPTV player, three self-hosted 3D editors, and a 2D game engine. All in a single Node.js executable. All running on hardware you already own.</Body>

            {/* Timeline */}
            <div style={{ position: 'relative', marginTop: 56, paddingLeft: 32 }}>
              <div style={{ position: 'absolute', left: 8, top: 6, bottom: 6, width: 1, background: 'rgba(0,255,65,0.2)' }} />
              {MILESTONES.map((m, i) => (
                <FadeUp key={m.day} delay={i * 60}>
                  <div style={{ position: 'relative', marginBottom: 22 }}>
                    <div style={{ position: 'absolute', left: -28, top: 6, width: 8, height: 8, background: C.green, boxShadow: `0 0 8px ${C.green}` }} />
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
                      <span style={{ ...MONO, fontSize: 12, color: C.green, letterSpacing: '0.1em', minWidth: 60 }}>{m.day}</span>
                      <span style={{ ...SANS, fontSize: 14, color: C.textMid, lineHeight: 1.6 }}>{m.text}</span>
                    </div>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 4: THE DOCTRINE ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// how to build — the actual method</Eyebrow>
            <SectionHead line1="This is how you" line2="learn to build AI." line2Color={C.green} />
            <Body>The following is not theory. It is the exact approach used to build PHOBOS, and the reason it worked. Each principle is a thing that slows you down in a way that makes you go faster.</Body>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 2, marginTop: 40 }}>
              {DOCTRINE.map((d, i) => (
                <FadeUp key={d.title} delay={i * 70}>
                  <div style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderLeft: `3px solid ${d.accent}`,
                    padding: '28px 26px',
                    height: '100%',
                  }}>
                    <h3 style={{ ...MONO, fontSize: 14, color: d.accent, marginBottom: 14, letterSpacing: '0.06em' }}>{d.title}</h3>
                    <p style={{ ...SANS, fontSize: 13.5, lineHeight: 1.78, color: C.textMid, margin: 0 }}>{d.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 5: OPEN SOURCE FOUNDATION ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// built on the shoulders of giants</Eyebrow>
            <SectionHead line1="We did not build" line2="this alone." line2Color={C.green} />
            <Body>PHOBOS is built on, inspired by, and made possible by a constellation of open source projects. Every one of them is credited in the in-app Open Source tab. Three deserve special mention here — not as dependencies, but as intellectual foundations.</Body>

            {/* Featured */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 40 }}>
              {FEATURED_CREDITS.map((c, i) => (
                <FadeUp key={c.name} delay={i * 80}>
                  <div style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderLeft: `4px solid ${c.border}`,
                    padding: '28px 32px',
                  }}>
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                      <h3 style={{ ...MONO, fontSize: 22, color: '#fff', margin: 0, letterSpacing: '0.02em' }}>{c.name}</h3>
                      <LicenseBadge license={c.license} />
                      <a href={c.link} target="_blank" rel="noreferrer" style={{ ...MONO, fontSize: 10, color: C.greenDim, letterSpacing: '0.15em', textDecoration: 'none', marginLeft: 'auto' }}>
                        VIEW REPO →
                      </a>
                    </div>
                    <p style={{ ...SANS, fontSize: 14, lineHeight: 1.78, color: C.textMid, margin: 0 }}>{c.text}</p>
                  </div>
                </FadeUp>
              ))}
            </div>

            {/* Compact grid */}
            <div style={{ marginTop: 56 }}>
              <div style={{ ...MONO, fontSize: 11, color: C.textLow, letterSpacing: '0.2em', marginBottom: 24, textTransform: 'uppercase' }}>
                // full open source manifest
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 24 }}>
                {CREDIT_GROUPS.map((g) => (
                  <div key={g.category} style={{ border: '1px solid rgba(255,255,255,0.06)', padding: '16px 16px 14px', background: 'rgba(255,255,255,0.015)' }}>
                    <div style={{ ...MONO, fontSize: 10, color: C.greenDim, letterSpacing: '0.2em', marginBottom: 12, textTransform: 'uppercase' }}>{g.category}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {g.entries.map((e) => (
                        <div key={e.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ ...MONO, fontSize: 11, color: C.text, letterSpacing: '0.02em' }}>{e.name}</span>
                          <LicenseBadge license={e.license} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </FadeUp>

        {/* ── SECTION 6: CTA (no Rule before) ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0 0' }}>
            <Eyebrow>// your turn</Eyebrow>
            <SectionHead line1="Now go build" line2="something we haven't." line2Color={C.green} />
            <Body>PHOBOS is not the destination. It is one proof of concept among the many that need to exist. Every person reading this has a domain, a workflow, a set of problems that no general-purpose AI product has been designed to solve. The AI that serves you best is the one built for exactly that.</Body>
            <Body style={{ marginTop: 16 }}>You do not need to start where PHOBOS started. You can start by asking PHOBOS itself — or Claude, or any capable local model — to explain how PHOBOS works. Ask it to walk you through the orchestration layer. Ask it why SYBIL uses DuckDB instead of a vector database. Ask it what would need to change to make PHOBOS work for your use case. The answer to that last question is your project.</Body>
            <Body style={{ marginTop: 16 }}>The tools are free. The models are open. The hardware is already in your hands. The only thing that makes this hard is starting without understanding — and that is what an AI is for.</Body>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 48 }}>
              <Link
                to="/phobos"
                style={{
                  background: C.green, color: '#000', ...MONO, fontSize: 13, letterSpacing: '0.18em',
                  padding: '15px 32px', textDecoration: 'none', borderRadius: 2,
                  transition: 'background 150ms', display: 'inline-block',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
                onMouseLeave={(e) => (e.currentTarget.style.background = C.green)}
              >
                ↓ DOWNLOAD PHOBOS
              </Link>
              <Link
                to="/phobos"
                style={{
                  border: `1px solid ${C.blue}`, color: C.blue, ...MONO, fontSize: 13, letterSpacing: '0.18em',
                  padding: '14px 32px', textDecoration: 'none', borderRadius: 2,
                  transition: 'all 150ms', display: 'inline-block', background: 'transparent',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(78,184,224,0.1)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                ◈ ASK PHOBOS HOW IT WORKS
              </Link>
              <a
                href="https://github.com/armyofbear136/PHOBOS"
                target="_blank"
                rel="noreferrer"
                style={{
                  border: `1px solid ${C.hairline}`, color: C.textMid, ...MONO, fontSize: 13, letterSpacing: '0.18em',
                  padding: '14px 32px', textDecoration: 'none', borderRadius: 2,
                  transition: 'all 150ms', display: 'inline-block',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.hairline; e.currentTarget.style.color = C.textMid; }}
              >
                VIEW ON GITHUB →
              </a>
            </div>

            <p style={{ ...MONO, fontSize: 10, color: C.greenDim, letterSpacing: '0.2em', marginTop: 28 }}>
              // ask your favorite ai · ask phobos · read the source · build something new
            </p>
          </section>
        </FadeUp>

      </div>
    </MarketingLayout>
  );
}
