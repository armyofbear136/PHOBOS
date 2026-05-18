import { useEffect, useRef, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';

/* ── Scroll-fade utility ── */
function FadeUp({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.08 });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} style={{ opacity: visible ? 1 : 0, transform: visible ? 'translateY(0)' : 'translateY(24px)', transition: `opacity 0.65s ease-out ${delay}ms, transform 0.65s ease-out ${delay}ms` }}>
      {children}
    </div>
  );
}

function Eyebrow({ children, color = 'rgba(78,184,224,0.6)' }: { children: string; color?: string }) {
  return (
    <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color, textTransform: 'uppercase', marginBottom: 20 }}>
      {children}
    </p>
  );
}

function SectionHead({ line1, line2, line2Color = '#4eb8e0' }: { line1: string; line2?: string; line2Color?: string }) {
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
  return <div style={{ width: '100%', height: 1, background: 'rgba(78,184,224,0.07)' }} />;
}

function StatChip({ value, label, accent = '#4eb8e0' }: { value: string; label: string; accent?: string }) {
  return (
    <div style={{ border: `1px solid ${accent}33`, padding: '20px 24px', borderRadius: 4, textAlign: 'center', minWidth: 160 }}>
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(18px, 2.5vw, 26px)', color: accent, letterSpacing: '0.04em' }}>{value}</div>
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em', textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
    </div>
  );
}

/* ── Pipeline diagram: Your Machine → Validation → Central Server → Model Output ── */
function PipelineDiagram() {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { threshold: 0.1 });
    obs.observe(el); return () => obs.disconnect();
  }, []);

  const nodes = [
    { label: 'YOUR MACHINE', sublabel: 'PHOBOS session\nlocal inference\ncurated output', color: '#00ff41', delay: 0 },
    { label: 'LOCAL REVIEW', sublabel: 'You flag quality\nsessions you choose\nto contribute', color: '#ffaa33', delay: 150 },
    { label: 'UPLOAD', sublabel: 'Encrypted transfer\nstripped of identity\nopen protocol', color: '#4eb8e0', delay: 300 },
    { label: 'WEIGHT APPLICATION', sublabel: 'Open-source code\napplies delta weights\ndata discarded immediately', color: '#4eb8e0', delay: 450 },
    { label: 'MODEL OUTPUT', sublabel: 'One .gguf file\nNothing else\nOpen to audit', color: '#00ff41', delay: 600 },
  ];

  return (
    <div ref={ref} style={{ margin: '48px 0', overflowX: 'auto' }}>
      {/* Desktop flow */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, minWidth: 700 }}>
        {nodes.map((node, i) => (
          <div key={node.label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            {/* Node box */}
            <div style={{
              flex: 1,
              opacity: visible ? 1 : 0,
              transform: visible ? 'translateY(0)' : 'translateY(16px)',
              transition: `opacity 0.5s ease-out ${node.delay}ms, transform 0.5s ease-out ${node.delay}ms`,
            }}>
              <div style={{
                border: `1px solid ${node.color}44`,
                padding: '16px 12px',
                textAlign: 'center',
                background: `${node.color}06`,
                borderRadius: 3,
              }}>
                <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: node.color, letterSpacing: '0.12em', marginBottom: 8 }}>
                  {node.label}
                </div>
                <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                  {node.sublabel}
                </div>
              </div>
            </div>
            {/* Arrow connector */}
            {i < nodes.length - 1 && (
              <div style={{
                width: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: visible ? 1 : 0,
                transition: `opacity 0.4s ease-out ${node.delay + 200}ms`,
                flexShrink: 0,
              }}>
                <svg width="24" height="12" viewBox="0 0 24 12" fill="none">
                  <line x1="0" y1="6" x2="18" y2="6" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                  <polyline points="14,2 20,6 14,10" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Data-discarded callout beneath weight application node */}
      <div style={{ display: 'flex', marginTop: 16 }}>
        {/* spacer for first 3 nodes + arrows */}
        <div style={{ flex: 3 + (3 * 32/700) }} />
        <div style={{
          flex: 1,
          opacity: visible ? 1 : 0,
          transition: 'opacity 0.5s ease-out 700ms',
          textAlign: 'center',
        }}>
          <div style={{ display: 'inline-block', border: '1px solid rgba(255,65,65,0.3)', padding: '6px 12px', borderRadius: 3 }}>
            <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 9, color: 'rgba(255,100,100,0.6)', letterSpacing: '0.15em' }}>
              ✕ SOURCE DATA DISCARDED
            </span>
          </div>
        </div>
        <div style={{ flex: 0.5 + (2 * 32/700) }} />
        <div style={{ flex: 1 }} />
      </div>

      {/* Open source badge */}
      <div style={{ textAlign: 'center', marginTop: 24 }}>
        <span style={{
          fontFamily: "'Share Tech Mono', monospace", fontSize: 10,
          color: 'rgba(0,255,65,0.5)', border: '1px solid rgba(0,255,65,0.2)',
          padding: '6px 16px', borderRadius: 3, letterSpacing: '0.15em',
        }}>
          ◈ VALIDATION + WEIGHT APPLICATION CODE IS FULLY OPEN SOURCE
        </span>
      </div>
    </div>
  );
}

export default function Halcyon() {
  return (
    <MarketingLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '120px 24px 96px' }}>

        {/* ── SECTION 1: WHAT IS HALCYON ── */}
        <FadeUp>
          <section style={{ marginBottom: 96 }}>
            <div style={{ display: 'inline-block', marginBottom: 24, border: '1px solid rgba(78,184,224,0.3)', padding: '6px 16px', borderRadius: 3 }}>
              <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: '#4eb8e0', letterSpacing: '0.2em' }}>
                ◈ COMING SOON — PROJECT HALCYON
              </span>
            </div>
            <SectionHead line1="The first AI model" line2="built by the people who use it." />
            <Body>
              Halcyon is not a product. It is an answer to a question that the AI industry has refused to ask honestly: what would a language model look like if it was trained on information that people <em style={{ color: 'rgba(255,255,255,0.75)', fontStyle: 'normal' }}>chose</em> to contribute — reviewed, consented, attributed, and given freely — instead of scraped from every corner of the internet without permission, credit, or compensation?
            </Body>
            <Body style={{ marginTop: 16 }}>
              The answer is Halcyon. A community-trained open model, built entirely from voluntary PHOBOS session data contributed by real users doing real work. No dark patterns. No passive data harvesting. No buried clause in a terms of service. Every contribution is an active choice, fully understood, and the code that processes it will be open for anyone to read.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 2: THE PROBLEM WITH HOW MODELS ARE TRAINED ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(255,100,100,0.6)">// how current models were built — what was taken</Eyebrow>
            <SectionHead line1="Stolen data produces" line2="a stolen model." line2Color="rgba(255,100,100,0.8)" />
            <Body>
              Every major frontier model was trained on content produced by human beings who were never asked. Code repositories. Published books. Scientific papers. Forum posts. Creative writing. Art descriptions. Decades of accumulated human knowledge and expression — ingested at petabyte scale, stripped of authorship, and used to build commercial products that now charge monthly subscriptions to the same people whose work made them possible.
            </Body>
            <Body style={{ marginTop: 16 }}>
              The consequences are not just ethical. They are technical. Training data scraped indiscriminately from the internet contains extraordinary volumes of misinformation, bias, propaganda, outdated information, contradictory claims, and low-quality noise. The models that emerge from that process are statistically shaped by whatever the internet happened to say most frequently — not by what was most accurate, most considered, or most true. "Confident and wrong" is not a quirk of these models. It is a direct consequence of how they were trained.
            </Body>
            <Body style={{ marginTop: 16 }}>
              You cannot build the most truthful, intelligent model in the world on a foundation of unverified bulk data. The math does not work in your favor — garbage scaled is still garbage. What you can do is build a smaller, more deliberate corpus of high-quality, verified, human-reviewed examples that teach a model what correct reasoning actually looks like. That is what Halcyon is built on.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 3: HOW IT WORKS ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// how halcyon works — the pipeline</Eyebrow>
            <SectionHead line1="Your machine produces the data." line2="One server applies the weights." />
            <Body>
              The Halcyon contribution pipeline is designed with a single governing principle: the source data never persists anywhere except on the machine that produced it, and only for as long as the contributor chooses. Here is exactly what happens, step by step — and because the code is open source, you can verify every word of this yourself.
            </Body>

            <PipelineDiagram />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 2, marginTop: 48 }}>
              {[
                {
                  step: '01', color: '#00ff41',
                  title: 'You use PHOBOS normally',
                  body: 'Every session where PHOBOS reasons well, produces correct output, or handles a complex task cleanly is a potential contribution. You generate this data just by working — there is no special contribution mode. PHOBOS does what it always does: thinks locally, on your hardware, for you.',
                },
                {
                  step: '02', color: '#ffaa33',
                  title: 'You choose what to flag',
                  body: 'When Halcyon launches, PHOBOS will include a simple session review interface. You can look at any conversation, evaluate the quality yourself, and decide whether it represents the kind of reasoning you want in a shared model. Nothing is flagged automatically. Every contribution requires a deliberate human review.',
                },
                {
                  step: '03', color: '#4eb8e0',
                  title: 'Encrypted, identity-stripped upload',
                  body: 'Flagged sessions are stripped of any identifying information — filenames, paths, user-specific context — then encrypted and transmitted over an open protocol to a single central server. The upload code is open source. There are no hidden fields. The server receives a package of reasoning examples, nothing else.',
                },
                {
                  step: '04', color: '#4eb8e0',
                  title: 'Weight application — then deletion',
                  body: 'The central server runs open-source weight application code that applies the contributed data as a training delta to the Halcyon model checkpoint. Once the weights are updated, the source data is deleted from the server permanently. The server is not a data warehouse. It is a processing step. When the step is complete, the data is gone.',
                },
                {
                  step: '05', color: '#00ff41',
                  title: 'One output: the model file',
                  body: 'The result of the entire pipeline is a single .gguf model file — the updated Halcyon checkpoint — which is published openly for anyone to download and run. No proprietary formats. No API-only access. The model belongs to the community that built it.',
                },
              ].map((item, i) => (
                <FadeUp key={item.step} delay={i * 80}>
                  <div
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', padding: '28px 24px', height: '100%', transition: 'border-color 200ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${item.color}33`)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
                  >
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: item.color, letterSpacing: '0.2em', marginBottom: 12 }}>STEP {item.step}</div>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 14, color: '#fff', marginBottom: 12 }}>{item.title}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.75, color: 'rgba(255,255,255,0.45)' }}>{item.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 4: WHY QUALITY BEATS SCALE ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the quality argument — why less is more</Eyebrow>
            <SectionHead line1="A thousand verified examples" line2="beat a billion scraped ones." line2Color="#00ff41" />
            <Body>
              The AI industry has spent years chasing scale — more parameters, more data, more compute. The assumption is that quantity of training data correlates with quality of reasoning. That assumption is wrong, and the evidence is in every frontier model that confabulates citations, produces plausible-sounding nonsense, or fails basic logical consistency checks despite having been trained on more human text than any single human will read in a thousand lifetimes.
            </Body>
            <Body style={{ marginTop: 16 }}>
              What actually shapes a model's reasoning quality is not the volume of data it was trained on — it is the <em style={{ color: 'rgba(255,255,255,0.75)', fontStyle: 'normal' }}>signal-to-noise ratio</em> of that data. A model trained on a carefully curated set of examples where the reasoning is explicitly correct, where the steps are shown, and where a human has reviewed and endorsed the output, will generalize better and hallucinate less than a model trained on ten thousand times more unverified text that happens to contain the same information buried in noise.
            </Body>
            <Body style={{ marginTop: 16 }}>
              PHOBOS already produces unusually high-quality reasoning output because the dual-pipeline forces verification before delivery. Every Halcyon contribution is a session that a real user decided was correct and useful. That is a quality filter that no web scraper can replicate. You cannot automate the judgment of someone who actually used the output to do real work and found it good.
            </Body>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 40 }}>
              <StatChip value="VERIFIED" label="Human-reviewed before contribution" accent="#00ff41" />
              <StatChip value="DELIBERATE" label="Active choice, not passive harvest" accent="#4eb8e0" />
              <StatChip value="ZERO NOISE" label="No scraped misinformation" accent="#ffaa33" />
              <StatChip value="OPEN AUDIT" label="Every step is verifiable" accent="#00ff41" />
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 5: THE ETHICS ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(255,170,51,0.6)">// the ethics — consent is not optional</Eyebrow>
            <SectionHead line1="The data was given." line2="Not taken." line2Color="#ffaa33" />
            <Body>
              Ethical AI training is not complicated. It requires one thing that most of the industry has consistently refused to provide: asking. Asking the people whose work you want to use. Asking them clearly, in plain language, with a genuine alternative if they say no. Not burying consent in a terms of service document that no one reads. Not claiming a "legitimate interest" in harvesting creative work because it was publicly accessible. Asking.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Halcyon contributions are opt-in. Completely. There is no setting that defaults to sharing. There is no gradual onboarding that ends with you unknowingly contributing data. The first time you open the contribution interface, the default state is off. If you turn it on, you will be shown exactly what will be shared, exactly how it will be processed, exactly what it will be used for, and exactly how to revoke your contributions if you change your mind.
            </Body>
            <Body style={{ marginTop: 16 }}>
              We believe this is the only way to build AI that the people using it can genuinely trust. Not because a privacy policy says they can — but because the architecture makes deception structurally impossible, and the code is open for anyone to verify that claim.
            </Body>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2, marginTop: 40 }}>
              {[
                { label: 'Explicit Opt-In', body: 'Default is always off. You choose to contribute. Nothing is assumed.', color: '#00ff41' },
                { label: 'Full Transparency', body: 'You see exactly what will be shared before it leaves your machine. No hidden fields.', color: '#4eb8e0' },
                { label: 'Right of Revocation', body: 'Contributed data is deleted from the server after weight application. There is nothing to revoke from — it is already gone.', color: '#ffaa33' },
                { label: 'Open Source Verification', body: 'The upload, processing, and weight application code is public. Anyone can audit it. We have nothing to hide because there is nothing hidden.', color: '#00ff41' },
                { label: 'No Identity', body: 'All identifying context is stripped locally before upload. The server receives reasoning examples, not your personal data.', color: '#4eb8e0' },
                { label: 'Community Ownership', body: 'The model that results belongs to everyone. It is published as an open .gguf file. No one licenses it back to you.', color: '#ffaa33' },
              ].map((v, i) => (
                <FadeUp key={v.label} delay={i * 60}>
                  <div
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', padding: '24px', height: '100%', transition: 'border-color 200ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${v.color}33`)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
                  >
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: v.color, marginBottom: 10 }}>{v.label}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.7, color: 'rgba(255,255,255,0.45)' }}>{v.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 6: THE GOAL ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the goal — what we're building toward</Eyebrow>
            <SectionHead line1="The most truthful model" line2="ever built." />
            <Body>
              The mission of Halcyon is specific and measurable: to produce the most truthful, logically consistent, and practically useful open language model in existence — built entirely on data that was correct when it was generated, verified by the person who generated it, and contributed by someone who wanted the model to be better.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Truthfulness is not a fine-tuning pass at the end of training. It is a property of the data the model learned from. Every Halcyon contribution is a PHOBOS session where the dual-pipeline reasoned carefully and a human confirmed the output was correct. The model that learns from those examples learns what correct reasoning looks like — not what the internet thinks correct reasoning looks like, but what actual humans doing actual work determined was accurate and useful.
            </Body>
            <Body style={{ marginTop: 16 }}>
              We are not trying to build the largest model. We are trying to build the best one. There is a difference — and the Halcyon architecture is designed entirely around that distinction. A model that is smaller, faster, and reliably correct is worth more than a model that is enormous, expensive to run, and confidently wrong at unpredictable intervals.
            </Body>
            <Body style={{ marginTop: 16 }}>
              When Halcyon launches, it will be available to every PHOBOS user to run locally — just like any other model. Free. Open. Entirely yours. Because you helped build it.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 7: TIMELINE PLACEHOLDER ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// development status</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 2 }}>
              {[
                { phase: 'Phase 1', label: 'PHOBOS Core', status: 'COMPLETE', statusColor: '#00ff41', body: 'Dual-pipeline inference engine. Local execution. DuckDB session persistence. Full tool calling and file operations.' },
                { phase: 'Phase 2', label: 'Autarch Platform', status: 'IN PROGRESS', statusColor: '#ffaa33', body: 'Licensing infrastructure. Public site. Community communications. Pricing and access.' },
                { phase: 'Phase 3', label: 'Halcyon Pipeline', status: 'DESIGNED', statusColor: '#4eb8e0', body: 'Contribution UI inside PHOBOS. Upload protocol. Open-source processing server. Initial checkpoint.' },
                { phase: 'Phase 4', label: 'Halcyon v1', status: 'FUTURE', statusColor: 'rgba(255,255,255,0.25)', body: 'First public Halcyon model release. Community-trained. Open weights. Free to every PHOBOS user.' },
              ].map((item, i) => (
                <FadeUp key={item.phase} delay={i * 80}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', padding: '28px 24px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em' }}>{item.phase}</span>
                      <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 9, color: item.statusColor, border: `1px solid ${item.statusColor}44`, padding: '3px 8px', letterSpacing: '0.1em' }}>{item.status}</span>
                    </div>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 14, color: '#fff', marginBottom: 10 }}>{item.label}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.7, color: 'rgba(255,255,255,0.4)' }}>{item.body}</p>
                  </div>
                </FadeUp>
              ))}
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── FINAL CTA ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0', textAlign: 'center' }}>
            <Eyebrow>// be part of what comes next</Eyebrow>
            <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#fff', lineHeight: 1.05, marginBottom: 8 }}>
              The best AI model ever built
            </h2>
            <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#4eb8e0', lineHeight: 1.05, display: 'block', marginBottom: 16 }}>
              will be built by you.
            </span>
            <Body style={{ maxWidth: 560, margin: '0 auto 40px', textAlign: 'center' }}>
              Start with PHOBOS. When Halcyon launches, every session you've run is a potential contribution to something larger than any one of us could build alone.
            </Body>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
              <Link
                to="/phobos"
                style={{ background: '#4eb8e0', color: '#000', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', display: 'inline-block', transition: 'background 150ms' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#3aa0c8')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#4eb8e0')}
              >
                START WITH PHOBOS →
              </Link>
              <Link
                to="/about"
                style={{ border: '1px solid rgba(78,184,224,0.25)', color: 'rgba(78,184,224,0.7)', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', display: 'inline-block', transition: 'all 150ms' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(78,184,224,0.5)'; e.currentTarget.style.color = '#4eb8e0'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(78,184,224,0.25)'; e.currentTarget.style.color = 'rgba(78,184,224,0.7)'; }}
              >
                READ THE MISSION →
              </Link>
            </div>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(78,184,224,0.3)', letterSpacing: '0.12em', marginTop: 20 }}>
              // open source — community trained — no data retained
            </p>
          </section>
        </FadeUp>

      </div>
    </MarketingLayout>
  );
}