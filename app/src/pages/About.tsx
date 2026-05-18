import { useEffect, useRef, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingLayout } from '@/components/marketing/MarketingLayout';

/* ── Reusable scroll-fade utility ── */
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

/* ── Section eyebrow label (Share Tech Mono, green) ── */
function Eyebrow({ children, color = 'rgba(0,255,65,0.55)' }: { children: string; color?: string }) {
  return (
    <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color, textTransform: 'uppercase', marginBottom: 20 }}>
      {children}
    </p>
  );
}

/* ── Section heading ── */
function SectionHead({ line1, line2, line2Color = '#00ff41' }: { line1: string; line2?: string; line2Color?: string }) {
  return (
    <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(30px, 5vw, 56px)', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em', color: '#fff', marginBottom: 28 }}>
      {line1}{line2 && <><br /><span style={{ color: line2Color }}>{line2}</span></>}
    </h2>
  );
}

/* ── Body paragraph ── */
function Body({ children, style = {} }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.55)', maxWidth: 680, ...style }}>
      {children}
    </p>
  );
}

/* ── Horizontal rule ── */
function Rule() {
  return <div style={{ width: '100%', height: 1, background: 'rgba(0,255,65,0.07)', margin: '0 auto' }} />;
}

/* ── Stat callout chip ── */
function StatChip({ value, label, accent = '#00ff41' }: { value: string; label: string; accent?: string }) {
  return (
    <div style={{ border: `1px solid ${accent}33`, padding: '20px 24px', borderRadius: 4, textAlign: 'center', minWidth: 160 }}>
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(20px, 3vw, 28px)', color: accent, letterSpacing: '0.04em' }}>{value}</div>
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em', textTransform: 'uppercase', marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function About() {
  return (
    <MarketingLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '120px 24px 96px' }}>

        {/* ── SECTION 1: WHO WE ARE ── */}
        <FadeUp>
          <section style={{ marginBottom: 96 }}>
            <Eyebrow>// autarch industries — who we are</Eyebrow>
            <SectionHead line1="We are not a" line2="tech company." line2Color="#4eb8e0" />
            <Body>
              Autarch Industries is an independent community driven operation — no venture capital, no data center, no board of directors making quiet decisions about what your AI is allowed to think about. We build tools that belong entirely to the people who use them. PHOBOS is the first of those tools: a dual-reasoning AI engine that runs entirely on hardware you already own, with no subscriptions, no telemetry, and no corporate agenda baked into the weights.
            </Body>
            <Body style={{ marginTop: 16 }}>
              This is not a startup pitch. This is a commitment — that the most powerful AI workflows of the next decade do not have to flow through a handful of California companies with financial incentives that are fundamentally misaligned with yours.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 2: THE ENERGY PROBLEM ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(255,100,100,0.6)">// the cost of cloud ai — follow the watts</Eyebrow>
            <SectionHead line1="Your laptop uses" line2="65 watts." line2Color="#ffaa33" />
            <Body>
              A modern AMD Ryzen AI HX 370 — the kind of chip shipping in consumer laptops right now — can run capable open-source language models at full inference for roughly <strong style={{ color: 'rgba(255,255,255,0.8)' }}>65 watts</strong>. That is approximately the power draw of a single incandescent light bulb. For that budget, PHOBOS can reason, plan, write, and execute — locally, privately, continuously.
            </Body>
            <Body style={{ marginTop: 16 }}>
              A single large-scale data center — the kind that serves your cloud AI queries — draws between <strong style={{ color: 'rgba(255,100,100,0.75)' }}>20 and 100+ megawatts</strong> of continuous power. That is the electricity consumption of a small city, running 24 hours a day, so that thousands of users can send prompts that train the next version of a model they do not own.
            </Body>
            <Body style={{ marginTop: 16 }}>
              And when a frontier model hallucinates, gets stuck in a reasoning loop, or has to retry a multi-thousand-token generation? Every wasted token in a data center is billed against real kilowatt-hours — drawn from grids that still run on fossil fuels, cooling systems that pump millions of gallons of water, and hardware cycles that produce e-waste at industrial scale. The inefficiency is not incidental. It is structural.
            </Body>

            {/* Energy stat chips */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 40 }}>
              <StatChip value="65W" label="PHOBOS on your laptop" accent="#00ff41" />
              <StatChip value="20–100MW" label="Typical data center draw" accent="rgba(255,100,100,0.8)" />
              <StatChip value="~0¢" label="Marginal cost per query" accent="#4eb8e0" />
              <StatChip value="∞" label="Queries. No metering." accent="#ffaa33" />
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 3: THE CREATOR PROBLEM ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(255,170,51,0.6)">// the creator economy — what was taken without asking</Eyebrow>
            <SectionHead line1="The models were built" line2="on borrowed work." line2Color="#ffaa33" />
            <Body>
              Every frontier model trained by a major AI company was trained on content written, drawn, coded, and composed by human beings who were never asked, never credited, and never compensated. Books. Articles. Source code. Art. Music lyrics. Forum posts. Stack Overflow answers. GitHub repositories. The creative output of decades of human effort — ingested at scale, stripped of attribution, and used to build commercial products that now compete directly with the people whose work made them possible.
            </Body>
            <Body style={{ marginTop: 16 }}>
              This is not a legal argument — it is an ethical one. The current generation of AI was built on a foundation that creators did not consent to provide. And the loop continues: every prompt you send to a cloud AI becomes potential training data for the next model. Your ideas, your phrasing, your workflows — quietly becoming part of a product you pay monthly to access.
            </Body>
            <Body style={{ marginTop: 16 }}>
              PHOBOS does not train on your inputs. It cannot. There is no pipeline. There is no server receiving your queries. What you think with PHOBOS stays with you — in a DuckDB file on your own machine, never transmitted, never processed anywhere but locally. This is not a privacy policy. It is a hardware constraint.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 4: HALCYON ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow color="rgba(78,184,224,0.6)">// project halcyon — the future we're building toward</Eyebrow>
            <SectionHead line1="What if people chose" line2="to contribute?" line2Color="#4eb8e0" />
            <Body>
              Halcyon is the next chapter of Autarch Industries — a voluntary, opt-in data contribution pipeline that lets PHOBOS users share curated, consented examples of their AI workflows to help train the next generation of open models. Not scraped. Not coerced. Chosen, reviewed, and attributed.
            </Body>
            <Body style={{ marginTop: 16 }}>
              The vision is simple: the best AI training data is not the entire internet vacuum-cleaned at petabyte scale. It is real people doing real work, choosing to show how they think, choosing to make the tools better for everyone. Human intelligence — contributed willingly, transparently, with full understanding of what it will be used for.
            </Body>
            <Body style={{ marginTop: 16 }}>
              When Halcyon launches, PHOBOS users will be able to flag their best sessions — the moments when the dual-pipeline got it exactly right, or when their own guidance produced something genuinely useful — and contribute those examples to a shared training corpus that belongs to the community, not to a company. The result will be models that are smarter because of human wisdom freely given, not human creativity quietly extracted.
            </Body>
            <Body style={{ marginTop: 16 }}>
              This is how AI gets better ethically. Not by taking. By building together.
            </Body>

            <div style={{ marginTop: 32, display: 'inline-flex', alignItems: 'center', gap: 12, border: '1px solid rgba(78,184,224,0.25)', padding: '12px 20px', borderRadius: 4 }}>
              <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: '#4eb8e0', letterSpacing: '0.2em' }}>HALCYON — COMING SOON</span>
              <Link to="/halcyon" style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: 'rgba(78,184,224,0.5)', letterSpacing: '0.15em', textDecoration: 'none' }}>LEARN MORE →</Link>
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 5: THE PRICING COMMITMENT ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the deal — $20. forever.</Eyebrow>
            <SectionHead line1="One payment." line2="Patron recognition." />
            <Body>
              PHOBOS costs $20. Once. Not per month. Not per seat. Not with a "free tier" that quietly locks the good features behind a paywall. Twenty dollars, and you own a perpetual patron certificate to PHOBOS — actively showing your contribution and visible to other users in the patrons menu.
            </Body>
            <Body style={{ marginTop: 16 }}>
              This is not a promotional price. It is the actual price, permanently. The reasoning is straightforward: we believe powerful AI tools should be accessible to anyone who wants them, not priced to extract maximum subscription revenue from people who have no real alternative. The cost of running PHOBOS is your own electricity — which, as we covered, is approximately the cost of leaving a light on.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Every dollar from PHOBOS patrons goes directly into making PHOBOS better — faster models, smarter pipelines, better tooling, and eventually Halcyon. No investors to satisfy. No quarterly growth targets. Just a sustainable, independent operation building things that are genuinely useful to the people using them.
            </Body>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 40 }}>
              <StatChip value="$20" label="Patron Status" accent="#00ff41" />
              <StatChip value="∞ updates" label="Forever, no renewals" accent="#00ff41" />
              <StatChip value="$0/mo" label="Subscription cost" accent="#00ff41" />
            </div>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 6: THE MISSION ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// the mission — what we're actually trying to do</Eyebrow>
            <SectionHead line1="Not to replace you." line2="To multiply you." />
            <Body>
              There is a narrative in AI right now that frames automation as an existential threat — that every efficiency gained by AI is a job lost, a skill devalued, a human made redundant. We reject that framing entirely. The goal of PHOBOS is not to replace what you do. It is to make what you do more effective, more ambitious, and more yours than it has ever been.
            </Body>
            <Body style={{ marginTop: 16 }}>
              When PHOBOS handles the scaffolding, the boilerplate, the research pass, the first draft, the syntax check — you are not doing less work. You are freed to do the work that actually requires you. The judgment calls. The creative leaps. The decisions that require context and values and lived experience that no model has. PHOBOS clears the path. You walk it.
            </Body>
            <Body style={{ marginTop: 16 }}>
              Every single thing we do with our time has a potential efficiency ceiling. PHOBOS exists to raise that ceiling — not to hit it for you. We believe the people who use AI as a true thinking partner, rather than an autocomplete engine or a search replacement, will build things the rest of the world has not imagined yet. And we believe they should be able to do that without paying a hundred dollars a month to a company whose values they may not share, whose training data they did not consent to, and whose servers are running on the other side of an internet connection they cannot control.
            </Body>
            <Body style={{ marginTop: 16 }}>
              You have the hardware. You have the intelligence. All you need is PHOBOS.
            </Body>
          </section>
        </FadeUp>

        <Rule />

        {/* ── SECTION 7: VALUES GRID ── */}
        <FadeUp delay={80}>
          <section style={{ margin: '96px 0' }}>
            <Eyebrow>// what we stand for</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2, marginTop: 40 }}>
              {[
                { label: 'Sovereignty', body: 'Your AI runs on your hardware and answers only to you. No remote kill switch. No policy update that changes its behavior overnight.', color: '#00ff41' },
                { label: 'Privacy', body: 'Not as a setting. As a hardware constraint. There is no server receiving your data because there is no server.', color: '#4eb8e0' },
                { label: 'Fairness', body: "Creators deserve to choose whether their work trains AI models. We won't build on what wasn't given freely.", color: '#ffaa33' },
                { label: 'Accessibility', body: "$20 once. Runs on a gaming PC or a mid-range laptop. AI this capable should not require a corporate budget.", color: '#00ff41' },
                { label: 'Sustainability', body: '65 watts versus 20 megawatts. The math is not complicated. Local inference is the only sustainable path forward.', color: '#4eb8e0' },
                { label: 'Transparency', body: "Open models. Open architecture. We will tell you what PHOBOS is doing and why. There are no silent updates that change how it thinks.", color: '#ffaa33' },
              ].map((v, i) => (
                <FadeUp key={v.label} delay={i * 80}>
                  <div
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', padding: '28px 24px', height: '100%', transition: 'border-color 200ms' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${v.color}33`)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
                  >
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: v.color, marginBottom: 12, letterSpacing: '0.05em' }}>{v.label}</div>
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, lineHeight: 1.75, color: 'rgba(255,255,255,0.45)' }}>{v.body}</p>
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
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, letterSpacing: '0.25em', color: 'rgba(0,255,65,0.5)', textTransform: 'uppercase', marginBottom: 24 }}>
              // ready to own your intelligence?
            </p>
            <h2 style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#fff', lineHeight: 1.05, marginBottom: 8 }}>
              The hardware is already
            </h2>
            <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 'clamp(28px, 5vw, 52px)', color: '#00ff41', lineHeight: 1.05, display: 'block', marginBottom: 40 }}>
              in your hands.
            </span>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
              <Link
                to="/phobos"
                style={{ background: '#00ff41', color: '#000', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', transition: 'background 150ms', display: 'inline-block' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#00cc33')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#00ff41')}
              >
                RUN PHOBOS →
              </Link>
              <Link
                to="/pricing"
                style={{ border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.7)', fontFamily: "'Share Tech Mono', monospace", fontSize: 13, letterSpacing: '0.15em', padding: '14px 36px', textDecoration: 'none', transition: 'border-color 150ms, color 150ms', display: 'inline-block' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
              >
                SEE PRICING →
              </Link>
            </div>
            <p style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: 'rgba(0,255,65,0.3)', letterSpacing: '0.12em', marginTop: 20 }}>
              // $20 once — patron status — show your support
            </p>
          </section>
        </FadeUp>

      </div>
    </MarketingLayout>
  );
}