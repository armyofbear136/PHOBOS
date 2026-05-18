import { useAppStore } from '@/store/useAppStore';
import { AgentStateIcon } from './AgentStateIcon';

const CAPABILITIES = [
  { icon: '🧠', label: 'Deep Reasoning',     body: 'SEREN thinks through multi-step logic, catches its own errors, and reviews answers before you see them.' },
  { icon: '🔧', label: 'Tool Calling',        body: 'Creates files, reads directories, manages your workspace. It acts — not advises.' },
  { icon: '💬', label: 'Long Context',        body: 'Full conversation memory per session. SAYON holds your entire project context so SEREN never loses the thread.' },
  { icon: '🔌', label: 'Skills System',       body: 'Define custom skills that teach PHOBOS your own services, APIs, and workflows.' },
  { icon: '🔍', label: 'Web Search',          body: 'Coming soon — real-time lookup grounded in current information, still local, still private.', upcoming: true },
  { icon: '🌐', label: 'Browser Automation',  body: 'Coming soon — PHOBOS directing a local browser with full reasoning about every action.', upcoming: true },
];

function AgentStatusBadge({ role, label, model, state }: { role: 'coordinator' | 'engine'; label: string; model: string; state: 'connected' | 'disconnected' }) {
  const tint = role === 'coordinator' ? '#4eb8e0' : '#ffaa33';
  const connected = state === 'connected';
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors ${
      connected
        ? role === 'coordinator' ? 'border-sayon/20 bg-sayon/5' : 'border-seren/20 bg-seren/5'
        : 'border-border/20 bg-muted/10 opacity-50'
    }`}>
      <AgentStateIcon state={connected ? 'idle' : 'error'} tint={tint} size={14} />
      <span className="text-[10px] font-terminal tracking-wider" style={{ color: tint }}>
        {label}
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/50 truncate max-w-[80px]">
        {model || 'not set'}
      </span>
    </div>
  );
}

export function WelcomeScreen() {
  const modelNames = useAppStore((s) => s.modelNames);
  const connectionStatus = useAppStore((s) => s.connectionStatus);

  return (
    <div className="flex-1 flex flex-col items-center justify-start bg-background relative overflow-hidden overflow-y-auto phobos-scanlines">
      <div className="absolute inset-0 phobos-grid pointer-events-none" />

      <div className="relative z-10 w-full max-w-2xl px-6 py-10 flex flex-col items-center">

        <img
          src={`${import.meta.env.BASE_URL}phobos.png`}
          alt="PHOBOS"
          className="w-28 h-28 object-contain opacity-80"
          style={{ filter: 'drop-shadow(0 0 24px hsl(120 100% 50% / 0.12))' }}
        />
        <h1 className="mt-4 text-3xl font-terminal tracking-[0.3em] text-phobos-green/70 text-glow select-none">
          PHOBOS
        </h1>
        <p className="mt-1 text-[11px] font-mono text-muted-foreground/30 tracking-widest uppercase">
          Tri-brained local AI — everything on your hardware
        </p>

        <div className="mt-6 flex items-center gap-3 flex-wrap justify-center">
          <AgentStatusBadge role="coordinator" label="SAYON" model={modelNames.coordinator} state={connectionStatus.coordinator as any} />
          <div className="text-muted-foreground/20 font-mono text-xs select-none">&#8596;</div>
          <AgentStatusBadge role="engine" label="SEREN" model={modelNames.engine} state={connectionStatus.engine as any} />
        </div>

        <div className="mt-8 w-full border-t border-phobos-green/8" />

        <div className="mt-8 w-full">
          <p className="text-[10px] font-mono text-phobos-green/30 tracking-widest uppercase mb-3">// how it works</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-sayon/15 bg-sayon/5 px-4 py-3">
              <p className="text-[10px] font-terminal tracking-widest text-sayon/60 uppercase mb-1.5">SAYON — Coordinator</p>
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                Reads your request, maps the problem, extracts workspace context, and hands a precise brief to SEREN. Writes the final delivery summary you read.
              </p>
            </div>
            <div className="rounded-md border border-seren/15 bg-seren/5 px-4 py-3">
              <p className="text-[10px] font-terminal tracking-widest text-seren/60 uppercase mb-1.5">SEREN — Engine</p>
              <p className="text-[11px] text-muted-foreground/50 leading-relaxed">
                Decomposes tasks, thinks deeply through every step with a full internal reasoning pass, writes and patches code, and reviews its own output before returning.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 w-full">
          <p className="text-[10px] font-mono text-phobos-green/30 tracking-widest uppercase mb-3">// capabilities</p>
          <div className="grid grid-cols-2 gap-2">
            {CAPABILITIES.map((cap) => (
              <div
                key={cap.label}
                className={`rounded-md border px-3 py-2.5 ${
                  cap.upcoming
                    ? 'border-border/15 bg-transparent opacity-40'
                    : 'border-phobos-green/10 hover:border-phobos-green/20 transition-colors'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm leading-none">{cap.icon}</span>
                  <span className="text-[11px] font-terminal text-foreground/70 tracking-wide">{cap.label}</span>
                  {cap.upcoming && (
                    <span className="ml-auto text-[9px] font-mono text-muted-foreground/30 uppercase tracking-wider">soon</span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground/40 leading-relaxed">{cap.body}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-8 mb-4 text-[10px] font-mono text-muted-foreground/15 tracking-wider">
          send a message to start
        </p>

      </div>
    </div>
  );
}
