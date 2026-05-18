import { useState, useRef, useEffect } from 'react';
import { ChevronDown, CheckCircle2, Clock, Zap } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useModelConfig } from '@/hooks/useThread';

interface Provider    { id: string; label: string; defaultEndpoint: string; }
interface ModelOption { id: string; label: string; }

const PROVIDERS: Provider[] = [
  { id: 'fastflowllm', label: 'FastFlowLLM', defaultEndpoint: 'http://localhost:52625/v1' },
  { id: 'ollama',      label: 'Ollama',       defaultEndpoint: 'http://localhost:11434/v1' },
];

const MODELS_BY_PROVIDER: Record<string, ModelOption[]> = {
  fastflowllm: [
    { id: 'llama3.1:8b', label: 'Llama 3.1 8B' },
    { id: 'qwen3:8b',    label: 'Qwen3 8B' },
  ],
  ollama: [
    { id: 'qwen3:8b',        label: 'Qwen3 8B' },
    { id: 'qwen3:14b',       label: 'Qwen3 14B' },
    { id: 'qwen3:30b-a3b',   label: 'Qwen3 30B-A3B' },
    { id: 'qwen3:32b',       label: 'Qwen3 32B' },
    { id: 'llama3.1:8b',     label: 'Llama 3.1 8B' },
    { id: 'llama3.1:70b',    label: 'Llama 3.1 70B' },
    { id: 'deepseek-r1:32b', label: 'DeepSeek-R1 32B' },
    { id: 'deepseek-r1:70b', label: 'DeepSeek-R1 70B' },
  ],
};

function Dropdown({ label, value, options, tint, onSelect }: {
  label: string; value: string; options: ModelOption[]; tint: 'sayon' | 'seren';
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find(o => o.id === value)?.label ?? value;
  const tintColor  = tint === 'sayon' ? '#4ade80' : '#f59e0b';
  const tintBg     = tint === 'sayon' ? 'rgba(74,222,128,0.06)'  : 'rgba(245,158,11,0.06)';
  const tintBorder = tint === 'sayon' ? 'rgba(74,222,128,0.25)'  : 'rgba(245,158,11,0.25)';
  const tintHover  = tint === 'sayon' ? 'rgba(74,222,128,0.1)'   : 'rgba(245,158,11,0.1)';

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>{label}</span>
      <div ref={ref} style={{ position: 'relative' }}>
        <button onClick={() => setOpen(!open)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '7px 10px', background: tintBg, border: `1px solid ${tintBorder}`, cursor: 'pointer', transition: 'all 150ms' }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = tintColor)}
          onMouseLeave={e => (e.currentTarget.style.borderColor = tintBorder)}>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: tintColor }}>{selectedLabel || '— select —'}</span>
          <ChevronDown size={11} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
        </button>
        {open && (
          <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, zIndex: 200, background: '#111', border: `1px solid ${tintBorder}`, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
            {options.map(opt => (
              <button key={opt.id} onClick={() => { onSelect(opt.id); setOpen(false); }}
                style={{ width: '100%', textAlign: 'left', padding: '7px 10px', fontFamily: 'monospace', fontSize: 11, color: opt.id === value ? tintColor : 'rgba(255,255,255,0.55)', background: opt.id === value ? tintHover : 'transparent', border: 'none', cursor: 'pointer', transition: 'all 100ms', display: 'flex', alignItems: 'center', gap: 6 }}
                onMouseEnter={e => { e.currentTarget.style.background = tintHover; e.currentTarget.style.color = tintColor; }}
                onMouseLeave={e => { e.currentTarget.style.background = opt.id === value ? tintHover : 'transparent'; e.currentTarget.style.color = opt.id === value ? tintColor : 'rgba(255,255,255,0.55)'; }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: opt.id === value ? tintColor : 'transparent', border: `1px solid ${tintBorder}`, flexShrink: 0 }} />
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({ agentName, tint, description, currentProvider, currentModel, connected, onSelectProvider, onSelectModel }: {
  agentName: 'SAYON' | 'SEREN'; tint: 'sayon' | 'seren'; description: string;
  currentProvider: string; currentModel: string; connected: boolean;
  onSelectProvider: (id: string, endpoint: string) => void;
  onSelectModel: (id: string) => void;
}) {
  const tintColor  = tint === 'sayon' ? '#4ade80' : '#f59e0b';
  const tintBorder = tint === 'sayon' ? 'rgba(74,222,128,0.2)'  : 'rgba(245,158,11,0.2)';
  const tintBg     = tint === 'sayon' ? 'rgba(74,222,128,0.03)' : 'rgba(245,158,11,0.03)';
  const models = MODELS_BY_PROVIDER[currentProvider] ?? [];

  return (
    <div style={{ border: `1px solid ${tintBorder}`, background: tintBg, padding: '16px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={agentName === 'SAYON' ? '/sayon.png' : '/seren.png'} alt={agentName} style={{ width: 26, height: 26, borderRadius: 4, objectFit: 'cover', opacity: 0.8 }} />
          <div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, letterSpacing: '0.2em', color: tintColor, fontWeight: 600 }}>{agentName}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>{description}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#00ff41' : 'rgba(255,255,255,0.12)', boxShadow: connected ? '0 0 5px rgba(0,255,65,0.5)' : 'none', display: 'inline-block', animation: connected ? 'setupPulse 2s ease-in-out infinite' : 'none' }} />
          <span style={{ fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.1em', color: connected ? 'rgba(0,255,65,0.65)' : 'rgba(255,255,255,0.2)' }}>
            {connected ? 'CONNECTED' : 'NOT CONNECTED'}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Dropdown label="Provider" value={currentProvider} options={PROVIDERS} tint={tint}
          onSelect={(id) => { const p = PROVIDERS.find(p => p.id === id); if (p) onSelectProvider(id, p.defaultEndpoint); }} />
        <Dropdown label="Model" value={currentModel} options={models} tint={tint} onSelect={onSelectModel} />
      </div>
    </div>
  );
}

export function SetupGuide() {
  const togglePhobosLLMPanel = useAppStore((s) => s.togglePhobosLLMPanel);
  const modelConfig      = useAppStore((s) => s.modelConfig);
  const modelNames       = useAppStore((s) => s.modelNames);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const { updateConfig } = useModelConfig();

  const [dotCount, setDotCount] = useState(1);
  const [byoOpen, setByoOpen]   = useState(false);

  useEffect(() => {
    const t = setInterval(() => setDotCount(d => (d % 3) + 1), 600);
    return () => clearInterval(t);
  }, []);

  const dots = '.'.repeat(dotCount);
  const sayonConnected = connectionStatus.coordinator === 'connected';
  const serenConnected = connectionStatus.engine      === 'connected';
  const bothConnected  = sayonConnected && serenConnected;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'radial-gradient(ellipse 140% 90% at 50% 10%, #050d12 0%, #060810 55%, #020408 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      overflowY: 'auto', padding: '32px 16px 48px',
    }}>
      <style>{`
        @keyframes setupPulse   { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes setupFlicker { 0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:0.5} 94%{opacity:1} 97%{opacity:0.7} 98%{opacity:1} }
        @keyframes setupSpin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes setupRise    { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        @keyframes byoSlide     { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* Nebula */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '-5%', left: '25%', width: '50%', height: '30%', background: 'radial-gradient(ellipse, rgba(0,60,120,0.1) 0%, transparent 70%)', filter: 'blur(50px)' }} />
      </div>

      <div style={{ position: 'relative', zIndex: 2, width: '100%', maxWidth: 580, animation: 'setupRise 0.5s ease both' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <img src={`${import.meta.env.BASE_URL}phobos.png`} alt="PHOBOS" style={{ width: 44, height: 44, objectFit: 'contain', opacity: 0.5, marginBottom: 10, filter: 'brightness(0.8) saturate(0.4)' }} />
          <h1 style={{ fontFamily: 'monospace', fontSize: 17, letterSpacing: '0.4em', color: 'rgba(0,200,255,0.8)', marginBottom: 6, animation: 'setupFlicker 5s ease-in-out infinite' }}>
            PHOBOS
          </h1>
          <div style={{ height: 1, background: 'linear-gradient(to right, transparent, rgba(0,200,255,0.2), transparent)', marginBottom: 8 }} />
          <p style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.2em' }}>
            LLM CONNECTION REQUIRED
          </p>
        </div>

        {/* Connection status bar */}
        <div style={{
          border: bothConnected ? '1px solid rgba(0,255,65,0.3)' : '1px solid rgba(0,200,255,0.15)',
          background: bothConnected ? 'rgba(0,255,65,0.04)' : 'rgba(0,200,255,0.03)',
          padding: '14px 18px', marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {bothConnected ? (
              <CheckCircle2 size={14} style={{ color: '#00ff41', flexShrink: 0 }} />
            ) : (
              <div style={{ width: 14, height: 14, border: '2px solid rgba(0,200,255,0.2)', borderTopColor: 'rgba(0,200,255,0.7)', borderRadius: '50%', flexShrink: 0, animation: 'setupSpin 1s linear infinite' }} />
            )}
            <span style={{ fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.18em', color: bothConnected ? 'rgba(0,255,65,0.85)' : 'rgba(0,200,255,0.65)' }}>
              LLM CONNECTION
            </span>
          </div>
          <span style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: '0.12em', color: bothConnected ? 'rgba(0,255,65,0.85)' : 'rgba(255,165,0,0.7)', fontWeight: 600 }}>
            {bothConnected ? '● ESTABLISHED' : `● WAITING${dots}`}
          </span>
        </div>

        {/* ── PHOBOS LLMs — PRIMARY CARD ── */}
        <div style={{
          border: '1px solid rgba(0,255,65,0.3)',
          background: 'rgba(0,255,65,0.04)',
          padding: '22px 24px 20px',
          marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 13, letterSpacing: '0.18em', color: 'rgba(0,255,65,0.95)', fontWeight: 700 }}>
                  STEP 1 — Download AI Models
                </span>
              </div>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, margin: 0 }}>
                PHOBOS needs AI language models installed on your computer to work.
                Click below to open the model manager and download them.
              </p>
            </div>
          </div>

          {/* Model slots preview */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[
              { name: 'SAYON', desc: 'Coordinator · ~3 GB', color: '#4ade80', border: 'rgba(74,222,128,0.2)', bg: 'rgba(74,222,128,0.04)' },
              { name: 'SEREN', desc: 'Engine · ~20 GB',     color: '#f59e0b', border: 'rgba(245,158,11,0.2)', bg: 'rgba(245,158,11,0.04)' },
            ].map(slot => (
              <div key={slot.name} style={{ flex: 1, border: `1px solid ${slot.border}`, background: slot.bg, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: '0.15em', color: slot.color, fontWeight: 600 }}>{slot.name}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{slot.desc}</span>
              </div>
            ))}
          </div>

          <button
            onClick={togglePhobosLLMPanel}
            style={{
              width: '100%', padding: '11px 16px', fontFamily: 'monospace', fontSize: 11,
              letterSpacing: '0.2em', textTransform: 'uppercase',
              background: 'rgba(0,255,65,0.12)', border: '1px solid rgba(0,255,65,0.45)',
              color: 'rgba(0,255,65,0.9)', cursor: 'pointer', transition: 'all 150ms',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,255,65,0.2)'; e.currentTarget.style.borderColor = 'rgba(0,255,65,0.7)'; e.currentTarget.style.color = '#00ff41'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,255,65,0.12)'; e.currentTarget.style.borderColor = 'rgba(0,255,65,0.45)'; e.currentTarget.style.color = 'rgba(0,255,65,0.9)'; }}
          >
            <span style={{ fontSize: 14 }}>⬡</span> Open PHOBOS LLM Manager ▸
          </button>

          <p style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.2)', textAlign: 'center', marginTop: 10, marginBottom: 0, letterSpacing: '0.08em' }}>
            After downloading, launch them from the manager — PHOBOS connects automatically.
          </p>
        </div>

        {/* ── BYO LLM — collapsible ── */}
        <div style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.015)', marginBottom: 16 }}>
          <button
            onClick={() => setByoOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '13px 18px', background: 'none', border: 'none', cursor: 'pointer',
              transition: 'background 150ms',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Zap size={11} style={{ color: 'rgba(245,158,11,0.5)', flexShrink: 0 }} />
              <span style={{ fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.15em', color: 'rgba(255,255,255,0.45)' }}>
                Already have Ollama or FastFlowLLM?
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em' }}>
                {byoOpen ? 'COLLAPSE' : 'CONFIGURE'}
              </span>
              <ChevronDown size={12} style={{ color: 'rgba(255,255,255,0.25)', transform: byoOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms', flexShrink: 0 }} />
            </div>
          </button>

          {byoOpen && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '16px 18px 18px', animation: 'byoSlide 200ms ease both' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '7px 10px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.12)' }}>
                <Clock size={10} style={{ color: 'rgba(245,158,11,0.45)', flexShrink: 0 }} />
                <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(245,158,11,0.5)', letterSpacing: '0.06em' }}>
                  Ensure your LLM server is running before configuring
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <AgentCard
                  agentName="SAYON" tint="sayon" description="Context assembly & coordination"
                  currentProvider={modelConfig?.coordinator?.provider ?? 'fastflowllm'}
                  currentModel={modelNames.coordinator}
                  connected={sayonConnected}
                  onSelectProvider={(id, endpoint) => updateConfig.mutate({ coordinator: { provider: id, endpoint } })}
                  onSelectModel={(model) => updateConfig.mutate({ coordinator: { model } })}
                />
                <AgentCard
                  agentName="SEREN" tint="seren" description="Execution engine & reasoning"
                  currentProvider={modelConfig?.engine?.provider ?? 'ollama'}
                  currentModel={modelNames.engine}
                  connected={serenConnected}
                  onSelectProvider={(id, endpoint) => updateConfig.mutate({ engine: { provider: id, endpoint } })}
                  onSelectModel={(model) => updateConfig.mutate({ engine: { model } })}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: bothConnected ? '#00ff41' : 'rgba(0,180,255,0.45)', display: 'inline-block', animation: 'setupPulse 1.5s ease-in-out infinite' }} />
          <span style={{ fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.12em', color: bothConnected ? 'rgba(0,255,65,0.5)' : 'rgba(0,180,255,0.3)' }}>
            {bothConnected ? 'All systems connected — loading interface' : `Waiting for LLM connection${dots}`}
          </span>
        </div>

      </div>
    </div>
  );
}
