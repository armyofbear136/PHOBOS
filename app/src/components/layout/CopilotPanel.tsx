import { useAppStore, type Message } from '@/store/useAppStore';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ChatInput } from '@/components/chat/ChatInput';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX, Loader2, AlertTriangle, CheckCircle } from 'lucide-react';
import { useCopilotAudio } from '@/hooks/useCopilotAudio';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const uid = () => Math.random().toString(36).slice(2, 9);

type CopilotPersona = 'sayon' | 'seren';
type ActiveTab = CopilotPersona | 'clone';

interface CloneInfo {
  cloneId:        string;
  displayName:    string;
  voiceProfileId: string | null;
  slot:           CopilotPersona;
}

// Mirrors PersonaSystem.gd RELATIONSHIP_TIERS — index positions are permanent.
const RELATIONSHIP_TIERS = [
  { min: 0.00, max: 0.10, name: 'Strangers',      index: 0 },
  { min: 0.11, max: 0.25, name: 'Acquaintances',  index: 1 },
  { min: 0.26, max: 0.40, name: 'Familiar Faces', index: 2 },
  { min: 0.41, max: 0.55, name: 'Mutual Respect', index: 3 },
  { min: 0.56, max: 0.70, name: 'Real Friends',   index: 4 },
  { min: 0.71, max: 0.85, name: 'Close Bond',     index: 5 },
  { min: 0.86, max: 1.00, name: 'Deep Trust',     index: 6 },
] as const;

function getTier(level: number) {
  for (const tier of RELATIONSHIP_TIERS) {
    if (level <= tier.max) return tier;
  }
  return RELATIONSHIP_TIERS[6];
}

interface CopilotStats {
  bond_score: number;
  emotional_state: string;
  message_count: number;
  session_count: number;
  days_known: number;
  first_interaction_at: string | null;
}

const DEFAULT_STATS: CopilotStats = {
  bond_score: 0,
  emotional_state: 'calm',
  message_count: 0,
  session_count: 0,
  days_known: 0,
  first_interaction_at: null,
};

// ── Stat row used in expanded panel ─────────────────────────────────────────

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wider">{label}</span>
      <span className={`text-[11px] font-mono font-semibold ${accent ? 'text-phob-green/80' : 'text-muted-foreground/70'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Bond progress bar ────────────────────────────────────────────────────────

function BondBar({ score, persona }: { score: number; persona: CopilotPersona }) {
  const pct = Math.round(score * 100);
  const color = persona === 'sayon' ? 'bg-phob-teal/70' : 'bg-phob-yellow/70';
  return (
    <div className="mt-1">
      <div className="flex justify-between mb-0.5">
        <span className="text-[9px] font-mono text-muted-foreground/30 uppercase tracking-widest">BOND</span>
        <span className="text-[9px] font-mono text-muted-foreground/50">{pct} / 100</span>
      </div>
      <div className="h-1 w-full bg-phob-white/8 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%`, opacity: 0.75 }}
        />
      </div>
    </div>
  );
}

// ── Portrait hero — only shown in expanded mode ──────────────────────────────

function PersonaHero({
  persona,
  stats,
  online,
  modelName,
  onVoiceMode,
  voiceModeActive,
  voiceModeListening,
  voiceModeTranscribing,
  voiceModePlaying,
}: {
  persona: CopilotPersona;
  stats: CopilotStats;
  online: boolean;
  modelName: string;
  onVoiceMode: () => void;
  voiceModeActive: boolean;
  voiceModeListening: boolean;
  voiceModeTranscribing: boolean;
  voiceModePlaying: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const isSayon = persona === 'sayon';
  const accent = isSayon ? 'text-phob-teal' : 'text-phob-yellow';
  const accentBorder = isSayon ? 'border-phob-teal/30' : 'border-phob-yellow/30';
  const accentBg = isSayon ? 'bg-phob-teal/6' : 'bg-phob-yellow/6';
  const accentGlow = isSayon
    ? 'shadow-[0_0_24px_rgba(0,212,170,0.12)]'
    : 'shadow-[0_0_24px_rgba(207,255,4,0.10)]';

  const tier = getTier(stats.bond_score);

  return (
    <div className={`flex flex-col items-center px-4 pt-5 pb-4 border-b ${accentBorder} ${accentBg} ${accentGlow}`}>
      {/* Portrait */}
      <div className={`relative w-24 h-24 overflow-hidden border-2 ${accentBorder} mb-3`}
        style={{ boxShadow: isSayon ? '0 0 16px rgba(0,212,170,0.2)' : '0 0 16px rgba(207,255,4,0.18)' }}
      >
        {!imgError && (
          <img
            src={`/phobos/${persona}.png`}
            alt={persona.toUpperCase()}
            className="w-full h-full object-cover"
            style={{ filter: 'brightness(0.9) saturate(0.85)' }}
            onError={() => setImgError(true)}
          />
        )}
        {/* Fallback initial — only shown when portrait fails to load */}
        {imgError && (
          <div className={`absolute inset-0 flex items-center justify-center text-2xl font-terminal font-bold ${accent}`}>
            {persona[0].toUpperCase()}
          </div>
        )}
        {/* Scanline overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.12) 2px, rgba(0,0,0,0.12) 4px)',
          }}
        />
        {/* Online dot */}
        <span className={`absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border border-black ${
          online ? 'bg-phob-green phob-dot' : 'bg-phob-red/60'
        }`} />
      </div>

      {/* Name + tagline */}
      <span className={`text-[13px] font-display font-black uppercase tracking-[0.25em] ${accent}`}>
        {persona.toUpperCase()} PRIME
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/40 mt-0.5 text-center leading-snug">
        {isSayon ? 'Fast coordinator · system awareness' : 'Deep reasoner · architecture partner'}
      </span>

      {/* Model name */}
      {modelName && (
        <span className="mt-1 text-[9px] font-mono text-muted-foreground/25 tracking-wider">
          {modelName}
        </span>
      )}

      {/* Tier badge */}
      <div className={`mt-3 px-3 py-0.5 border ${accentBorder} ${accentBg}`}>
        <span className={`text-[10px] font-terminal tracking-[0.15em] ${accent}`}>
          {tier.name.toUpperCase()}
        </span>
      </div>

      {/* Bond bar */}
      <div className="w-full mt-3">
        <BondBar score={stats.bond_score} persona={persona} />
      </div>

      {/* ── Large voice conversation button ── */}
      <div className="flex flex-col items-center gap-2 mt-4 pb-2 w-full">
        <button
          onClick={onVoiceMode}
          disabled={voiceModeTranscribing}
          title={
            voiceModeListening  ? 'Click again to stop and send'
            : voiceModePlaying  ? 'AI is speaking — click to interrupt'
            : voiceModeActive   ? 'Voice conversation active'
            : 'Start voice conversation'
          }
          className={`relative flex items-center justify-center border-2 transition-all duration-200 outline-none focus:outline-none ${
            voiceModeListening
              ? `border-red-400/70 bg-red-400/10 shadow-[0_0_24px_hsl(0_100%_65%/0.3)] w-16 h-16`
              : voiceModePlaying
                ? isSayon
                  ? 'border-phob-teal/80 bg-phob-teal/15 shadow-[0_0_16px_rgba(0,212,170,0.3)] w-16 h-16'
                  : 'border-phob-yellow/80 bg-phob-yellow/15 shadow-[0_0_16px_rgba(207,255,4,0.25)] w-16 h-16'
                : voiceModeTranscribing
                  ? 'border-phob-amber/40 bg-phob-amber/5 w-16 h-16'
                  : isSayon
                    ? 'border-phob-teal/30 bg-phob-teal/5 hover:border-phob-teal/60 hover:bg-phob-teal/15 hover:shadow-[0_0_16px_rgba(0,212,170,0.3)] w-14 h-14 hover:w-16 hover:h-16'
                    : 'border-phob-yellow/30 bg-phob-yellow/5 hover:border-phob-yellow/60 hover:bg-phob-yellow/15 hover:shadow-[0_0_16px_rgba(207,255,4,0.25)] w-14 h-14 hover:w-16 hover:h-16'
          } disabled:opacity-40`}
        >
          {/* Ripple ring — shown while listening */}
          {voiceModeListening && (
            <span className="absolute inset-0 rounded-full border border-phob-red/30 animate-ping" />
          )}
          {voiceModePlaying && (
            <span className={`absolute inset-0 rounded-full border-2 animate-ping ${
              isSayon ? 'border-phob-teal/20' : 'border-phob-yellow/20'
            }`} />
          )}
          {/* Icon */}
          {voiceModeTranscribing
            ? <Loader2 className="w-6 h-6 text-phob-amber/60 animate-spin" />
            : voiceModeListening
              ? <MicOff className="w-6 h-6 text-red-400/90" />
              : voiceModePlaying
                ? <Volume2 className={`w-6 h-6 ${isSayon ? 'text-phob-teal/90' : 'text-phob-yellow/90'}`} />
                : <Mic className={`w-6 h-6 ${isSayon ? 'text-phob-teal/60' : 'text-phob-yellow/60'}`} />
          }
        </button>
        <span className={`text-[9px] font-terminal tracking-[0.15em] uppercase ${
          voiceModeListening   ? 'text-red-400/70'
          : voiceModeTranscribing ? 'text-phob-amber/60'
          : voiceModePlaying   ? (isSayon ? 'text-phob-teal/70' : 'text-phob-yellow/70')
          : 'text-muted-foreground/30'
        }`}>
          {voiceModeListening   ? 'Tap to send'
          : voiceModeTranscribing ? 'Transcribing…'
          : voiceModePlaying   ? 'Speaking…'
          : 'Voice'}
        </span>
      </div>
    </div>
  );
}

// ── Stats panel — below the hero in expanded mode ────────────────────────────

function StatsPanel({ stats, persona }: { stats: CopilotStats; persona: CopilotPersona }) {
  const isSayon = persona === 'sayon';
  const accentBorder = isSayon ? 'border-phob-teal/15' : 'border-phob-yellow/15';

  const emotionLabel = stats.emotional_state
    ? stats.emotional_state.charAt(0).toUpperCase() + stats.emotional_state.slice(1)
    : '—';

  const daysLabel = stats.days_known === 0
    ? 'Today'
    : stats.days_known === 1
      ? '1 day'
      : `${stats.days_known} days`;

  return (
    <div className={`px-4 py-3 border-b ${accentBorder} space-y-0.5`}>
      <StatRow label="Emotional State"  value={emotionLabel} />
      <StatRow label="Messages"         value={String(stats.message_count)} />
      <StatRow label="Sessions"         value={String(stats.session_count)} />
      <StatRow label="Known for"        value={daysLabel} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function CopilotPanelInner() {
  const copilotMode = useAppStore((s) => s.copilotMode);
  const { connectionStatus, modelNames } = useAppStore();
  const activeThreadId = useAppStore((s) => s.activeThreadId);

  const [activeCopilot, setActiveCopilot] = useState<CopilotPersona>('sayon');
  const [activeTab, setActiveTab]         = useState<ActiveTab>('sayon');
  const [sayonMessages, setSayonMessages] = useState<Message[]>([]);
  const [serenMessages, setSerenMessages] = useState<Message[]>([]);
  const [cloneMessages, setCloneMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingBuf, setThinkingBuf] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState({ sayon: false, seren: false, clone: false });

  // Clone tab state — always visible, populated by GET /api/weclone/active
  const [activeCloneInfo, setActiveCloneInfo]   = useState<CloneInfo | null>(null);
  const [cloneList, setCloneList]               = useState<Array<{ id: string; displayName: string; hasCartridge: boolean; slot: CopilotPersona }>>([]);
  const [selectedCloneId, setSelectedCloneId]   = useState<string>('');
  const [cloneActivating, setCloneActivating]   = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    domain:    string;
    service:   string;
    entity_id: string;
    label:     string;
    data:      Record<string, string>;
    persona:   CopilotPersona;
  } | null>(null);
  const [stats, setStats] = useState<Record<CopilotPersona, CopilotStats>>({
    sayon: { ...DEFAULT_STATS },
    seren: { ...DEFAULT_STATS },
  });

  const bottomRef          = useRef<HTMLDivElement>(null);
  const scrollContainerRef  = useRef<HTMLDivElement>(null);
  const scrollRafRef        = useRef<number | null>(null);
  const abortRef            = useRef<AbortController | null>(null);
  // Accumulates the full text of the assistant's current response for TTS.
  // Mutated in-place during streaming — reset to '' at the start of each send.
  const completedTextRef = useRef('');
  // Holds the active silence-detection interval + AudioContext so they can be
  // torn down on unmount or persona switch without leaking.
  const silenceCleanupRef = useRef<{ interval: ReturnType<typeof setInterval>; ctx: AudioContext } | null>(null);

  // One audio hook per persona — independent AudioContext + MediaRecorder state.
  const sayonAudio = useCopilotAudio();
  const serenAudio = useCopilotAudio();
  const activeAudio = activeCopilot === 'sayon' ? sayonAudio : serenAudio;

  // ── Voice conversation mode ───────────────────────────────────────────────
  // A single click starts listening with silence detection.
  // A second click (or silence timeout) stops listening and submits.
  // After the AI response completes, TTS plays automatically.
  // voiceMode stays true for the duration of the turn so the button reflects state.
  const [voiceMode, setVoiceMode] = useState(false);

  const sayonOnline = connectionStatus.coordinator === 'connected';
  const serenOnline = connectionStatus.engine === 'connected';
  const activeOnline = activeCopilot === 'sayon' ? sayonOnline : serenOnline;
  const messages    = activeTab === 'clone' ? cloneMessages
                    : activeTab === 'sayon' ? sayonMessages : serenMessages;
  const setMessages = activeTab === 'clone' ? setCloneMessages
                    : activeTab === 'sayon' ? setSayonMessages : setSerenMessages;

  const isVisible = copilotMode !== 'hidden';
  const isExpanded = copilotMode === 'expanded';

  // Scroll to bottom when new messages are added or persona switches (non-streaming).
  // Per-token scroll is handled inline in the token handler below (instant, no layout thrash).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, activeCopilot, isStreaming]);

  // Fetch active clone info and clone list — on mount and when panel becomes visible
  useEffect(() => {
    if (!isVisible) return;
    (async () => {
      try {
        const activeRes = await fetch(`${ENGINE_URL}/api/weclone/active`);
        if (activeRes.ok) {
          const { sayon, seren } = await activeRes.json() as { sayon: CloneInfo | null; seren: CloneInfo | null };
          setActiveCloneInfo(sayon ?? seren ?? null);
        }
        const listRes = await fetch(`${ENGINE_URL}/api/weclone/profiles`);
        if (listRes.ok) {
          const { profiles } = await listRes.json() as {
            profiles: Array<{ id: string; display_name: string; cartridge_id: string | null; slot: string }>;
          };
          setCloneList(profiles.map(p => ({
            id: p.id, displayName: p.display_name,
            hasCartridge: !!p.cartridge_id, slot: (p.slot ?? 'sayon') as CopilotPersona,
          })));
        }
      } catch { /* engine not running */ }
    })();
  }, [isVisible]);

  // Load persisted message history on first open per tab
  useEffect(() => {
    if (!isVisible) return;
    if (activeTab === 'clone') {
      if (!activeCloneInfo || historyLoaded.clone) return;
      (async () => {
        try {
          const res = await fetch(`${ENGINE_URL}/api/copilot/clone/${activeCloneInfo.cloneId}/messages`);
          if (!res.ok) return;
          const { messages: persisted } = await res.json() as {
            messages: Array<{ id: string; role: string; content: string; created_at: string }>;
          };
          setCloneMessages(persisted
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.created_at })));
          setHistoryLoaded(prev => ({ ...prev, clone: true }));
        } catch { /* engine not running */ }
      })();
      return;
    }
    if (historyLoaded[activeTab as CopilotPersona]) return;
    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/copilot/${activeTab}/messages`);
        if (!res.ok) return;
        const { messages: persisted } = await res.json() as {
          messages: Array<{ id: string; role: string; content: string; created_at: string }>;
        };
        const mapped: Message[] = persisted
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, timestamp: m.created_at }));
        if (activeTab === 'sayon') setSayonMessages(mapped);
        else setSerenMessages(mapped);
        setHistoryLoaded(prev => ({ ...prev, [activeTab]: true }));
      } catch { /* engine not running */ }
    })();
  }, [isVisible, activeTab, historyLoaded, activeCloneInfo]);

  // Fetch relationship stats — on open, on persona switch, after each message completes
  const fetchStats = useCallback(async (persona: CopilotPersona) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/copilot/${persona}/stats`);
      if (!res.ok) return;
      const data = await res.json() as CopilotStats;
      setStats(prev => ({ ...prev, [persona]: data }));
    } catch { /* engine not running — leave defaults */ }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (activeTab !== 'clone') fetchStats(activeCopilot);
  }, [isVisible, activeCopilot, activeTab, fetchStats]);

  // Tear down any active silence-detection interval + AudioContext on unmount.
  // Also fires when the panel is hidden — CopilotPanelInner returns null when
  // isVisible is false, which triggers this cleanup.
  useEffect(() => {
    return () => {
      if (silenceCleanupRef.current) {
        clearInterval(silenceCleanupRef.current.interval);
        silenceCleanupRef.current.ctx.close();
        silenceCleanupRef.current = null;
      }
    };
  }, []);

  // Local content cache for attachment chips — keyed by generated ID.
  // Copilot attachments don't persist across page reloads (copilot history
  // doesn't store queryFiles in the DB). Content is available for the session.
  const [attachmentCache, setAttachmentCache] = useState<Record<string, string>>({});

  const handleSend = useCallback(async (content: string, files?: File[]) => {
    const isClone = activeTab === 'clone';
    console.debug(`[SEND:7] handleSend called — tab: ${activeTab}, content: "${content.slice(0, 80)}"`);
    const persona = activeCopilot;
    const setter  = isClone ? setCloneMessages
                  : persona === 'sayon' ? setSayonMessages : setSerenMessages;

    const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','tiff','tif','avif']);
    const isImg = (f: File) =>
      f.type.startsWith('image/') ||
      IMAGE_EXTS.has(f.name.split('.').pop()?.toLowerCase() ?? '');

    let finalContent = content;
    const queryFiles: Array<{ id: string; name: string; isImage: boolean }> = [];
    const newCache: Record<string, string> = {};

    if (files && files.length > 0) {
      const parts: string[] = [];
      for (const file of files) {
        const localId = Math.random().toString(36).slice(2, 9);
        if (isImg(file)) {
          parts.push(`[image: ${file.name}]`);
          queryFiles.push({ id: localId, name: file.name, isImage: true });
        } else {
          const text = await file.text();
          parts.push(`${file.name}:\n${text}`);
          queryFiles.push({ id: localId, name: file.name, isImage: false });
          newCache[localId] = text;
        }
      }
      if (parts.length > 0) {
        finalContent = finalContent
          ? `${finalContent}\n\n${parts.join('\n\n')}`
          : parts.join('\n\n');
      }
    }

    if (Object.keys(newCache).length > 0) {
      setAttachmentCache(prev => ({ ...prev, ...newCache }));
    }

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: content,  // display text only — file contents not shown in bubble
      timestamp: new Date().toISOString(),
      queryFiles: queryFiles.length > 0 ? queryFiles : undefined,
    };
    setter(prev => [...prev, userMsg]);

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setIsStreaming(true);
    setThinkingBuf('');
    completedTextRef.current = '';
    // Interrupt any in-flight TTS and clear the sentence queue + token buffer
    // so the new response starts fresh.
    const audioForPersona = persona === 'sayon' ? sayonAudio : serenAudio;
    audioForPersona.interrupt();

    const msgId = uid();
    setter(prev => [...prev, {
      id: msgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    }]);

    try {
      const fetchUrl = isClone && activeCloneInfo
        ? `${ENGINE_URL}/api/copilot/clone/${activeCloneInfo.cloneId}`
        : `${ENGINE_URL}/api/copilot/${persona}`;
      console.debug(`[SEND:8] fetching ${fetchUrl}`);
      const res = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: finalContent }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Copilot returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice('data: '.length).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as {
              type:       string;
              token?:     string;
              message?:   string;
              output?:    string;
              runId?:     string | null;
              // action_pending fields
              domain?:    string;
              service?:   string;
              entity_id?: string;
              label?:     string;
              data?:      Record<string, string>;
            };
            if (event.type === 'token' && event.token) {
              completedTextRef.current += event.token;
              setter(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: m.content + event.token } : m
              ));
              // Scroll to bottom — throttled to one rAF per frame so we never
              // force synchronous layout (scrollHeight read) on every token.
              if (!scrollRafRef.current) {
                scrollRafRef.current = requestAnimationFrame(() => {
                  scrollRafRef.current = null;
                  const sc = scrollContainerRef.current;
                  if (sc) sc.scrollTop = sc.scrollHeight;
                });
              }
              // Feed token to TTS pipeline — fires synthesis on sentence boundaries
              // in parallel with continued streaming. activeThreadId is stable for
              // the life of this send (captured from store at render time).
              if (activeThreadId) {
                const audio = persona === 'sayon' ? sayonAudio : serenAudio;
                audio.speakChunk(event.token, activeThreadId);
              }
            } else if (event.type === 'watch_result') {
              // Watch duty completed — inject result as a new assistant message
              // so it reads as a self-contained report, distinct from the trigger response.
              const watchContent = event.output
                ? `**Watch Duty Report**\n\n${event.output}`
                : 'Watch duty completed — no output returned.';
              setter(prev => [
                ...prev,
                { id: `watch-${Date.now()}`, role: 'assistant' as const, content: watchContent, timestamp: new Date().toISOString() },
              ]);
            } else if (event.type === 'action_pending') {
              // AI emitted an HA_ACTION directive — show confirmation card.
              // The action does not fire until the user taps Confirm.
              setPendingAction({
                domain:    event.domain    as string,
                service:   event.service   as string,
                entity_id: event.entity_id as string,
                label:     event.label     as string,
                data:      event.data      as Record<string, string>,
                persona,
              });
            } else if (event.type === 'copilot_thinking' && event.token) {
              setThinkingBuf(prev => prev + event.token);
            } else if (event.type === 'error') {
              setter(prev => prev.map(m =>
                m.id === msgId ? { ...m, content: `Error: ${event.message ?? 'unknown'}` } : m
              ));
            }
          } catch { continue; }
        }
      }

      // Refresh stats after a completed exchange
      fetchStats(persona);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error(`[SEND:ERR] copilot fetch failed:`, (err as Error).message);
        setter(prev => prev.map(m =>
          m.id === msgId
            ? { ...m, content: `${persona.toUpperCase()} unavailable. Is the engine running?` }
            : m
        ));
      } else {
        console.debug('[SEND:8] fetch aborted (AbortError) — likely a new send superseded this one');
      }
    } finally {
      setIsStreaming(false);
      // Flush any trailing partial sentence that didn't end on a boundary.
      // Full sentences were already enqueued by speakChunk() during streaming.
      const audio = activeCopilot === 'sayon' ? sayonAudio : serenAudio;
      if (audio.ttsEnabled && completedTextRef.current.trim() && activeThreadId) {
        audio.flushSpeech(activeThreadId);
      }
    }
  }, [activeCopilot, activeTab, activeCloneInfo, fetchStats, sayonAudio, serenAudio]);

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const switchTo = useCallback((tab: ActiveTab) => {
    if (isStreaming) return;
    activeAudio.interrupt();
    setActiveTab(tab);
    if (tab !== 'clone') setActiveCopilot(tab);
    setThinkingBuf('');
    setShowThinking(false);
  }, [isStreaming, activeAudio]);

  const handleActivateClone = useCallback(async () => {
    if (!selectedCloneId || cloneActivating) return;
    setCloneActivating(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/weclone/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloneId: selectedCloneId }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Refresh active clone info
      const activeRes = await fetch(`${ENGINE_URL}/api/weclone/active`);
      if (activeRes.ok) {
        const { sayon, seren } = await activeRes.json() as { sayon: CloneInfo | null; seren: CloneInfo | null };
        setActiveCloneInfo(sayon ?? seren ?? null);
        setHistoryLoaded(prev => ({ ...prev, clone: false }));
      }
      setSelectedCloneId('');
    } catch (err) {
      console.error('[WeClone] Activate failed:', err);
    } finally {
      setCloneActivating(false);
    }
  }, [selectedCloneId, cloneActivating]);

  const handleDeactivateClone = useCallback(async () => {
    if (!activeCloneInfo || cloneActivating) return;
    setCloneActivating(true);
    try {
      await fetch(`${ENGINE_URL}/api/weclone/activate/${activeCloneInfo.slot}`, { method: 'DELETE' });
      setActiveCloneInfo(null);
      setCloneMessages([]);
      setHistoryLoaded(prev => ({ ...prev, clone: false }));
    } catch (err) {
      console.error('[WeClone] Deactivate failed:', err);
    } finally {
      setCloneActivating(false);
    }
  }, [activeCloneInfo, cloneActivating]);

  // Push-to-talk handlers — pointerdown starts, pointerup/leave stops + transcribes
  const handleMicPress = useCallback(() => {
    activeAudio.startListening();
  }, [activeAudio]);

  const handleMicRelease = useCallback(async () => {
    const transcript = await activeAudio.stopListening();
    if (transcript.trim()) {
      handleSendRef.current(transcript.trim());
    }
  }, [activeAudio]);

  const handleVoiceMode = useCallback(async () => {
    // If currently listening — second tap stops and submits immediately
    // Read from the stable ref — activeAudio.sttListening is a stale React state snapshot
    if (activeAudio.getListeningRef().current) {
      const transcript = await activeAudio.stopListening();
      console.debug(`[VOICE:5] stopListening resolved — transcript: "${transcript}"`);
      setVoiceMode(false);
      if (transcript.trim()) {
        // Ensure TTS fires after response — voice mode always enables TTS
        if (!activeAudio.ttsEnabled) activeAudio.setTtsEnabled(true);
        console.debug('[VOICE:6] calling handleSend from voice tap-stop');
        await handleSendRef.current(transcript.trim());
      } else {
        console.warn('[VOICE:5] transcript empty — handleSend not called');
      }
      return;
    }

    // If TTS is currently playing — tap interrupts it
    if (activeAudio.ttsPlaying) {
      activeAudio.interrupt();
      return;
    }

    // Start a new voice turn
    setVoiceMode(true);
    if (!activeAudio.ttsEnabled) activeAudio.setTtsEnabled(true);

    // startListening with silence detection — auto-submits after 1.8s of silence
    activeAudio.startListening();

    // Silence detection via AnalyserNode on the live stream
    // We poll RMS energy every 200ms and auto-stop after SILENCE_DURATION_MS
    // of continuous silence below SILENCE_THRESHOLD.
    const SILENCE_THRESHOLD   = 6;    // 0–255 RMS scale
    const SILENCE_DURATION_MS = 1800; // 1.8s of silence triggers auto-stop
    const CHECK_INTERVAL_MS   = 200;

    // Poll for stream — getUserMedia is async; 300ms fixed wait fails on first-use
    // (permission dialog). Retry up to 2s before falling back to manual-only.
    let stream: MediaStream | null = null;
    for (let i = 0; i < 20; i++) {
      stream = activeAudio.getStream();
      if (stream) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!stream) {
      // No stream available — fall back to manual-only mode (user taps to stop)
      return;
    }

    const audioCtx   = new AudioContext();
    const source     = audioCtx.createMediaStreamSource(stream);
    const analyser   = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const buffer      = new Uint8Array(analyser.frequencyBinCount);
    let silenceStart  = 0;
    let speechStarted = false; // don't auto-stop before the user has said anything

    const poll = setInterval(async () => {
      // Stop polling if user already tapped stop or component unmounted
      if (!activeAudio.getListeningRef().current) {
        clearInterval(poll);
        audioCtx.close();
        silenceCleanupRef.current = null;
        return;
      }

      analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i];
      const rms = sum / buffer.length;

      if (rms > SILENCE_THRESHOLD) {
        speechStarted = true;
        silenceStart  = 0;
      } else if (speechStarted) {
        if (silenceStart === 0) silenceStart = Date.now();
        const silenceDuration = Date.now() - silenceStart;
        if (silenceDuration >= SILENCE_DURATION_MS) {
          clearInterval(poll);
          audioCtx.close();
          silenceCleanupRef.current = null;
          // Auto-stop: silence detected — transcribe and send
          const transcript = await activeAudio.stopListening();
          console.debug(`[VOICE:5] silence auto-stop transcript: "${transcript}"`);
          setVoiceMode(false);
          if (transcript.trim()) {
            console.debug('[VOICE:6] calling handleSend from silence auto-stop');
            await handleSendRef.current(transcript.trim());
          } else {
            console.warn('[VOICE:5] silence auto-stop — transcript empty, handleSend not called');
          }
        }
      }
    }, CHECK_INTERVAL_MS);

    silenceCleanupRef.current = { interval: poll, ctx: audioCtx };

  }, [activeAudio]);

  if (!isVisible) return null;

  const isSayon = activeCopilot === 'sayon';
  const accentText = isSayon ? 'text-phob-teal' : 'text-phob-yellow';
  const accentBg = isSayon ? 'bg-phob-teal/8' : 'bg-phob-yellow/8';
  const accentBorder = isSayon ? 'border-phob-teal/30' : 'border-phob-yellow/30';
  const activeModelName = isSayon ? modelNames.coordinator : modelNames.engine;

  async function confirmHaAction() {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);

    const setter = action.persona === 'sayon' ? setSayonMessages : setSerenMessages;

    try {
      const res = await fetch('/api/ha/action', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          domain:  action.domain,
          service: action.service,
          data:    action.data,
        }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      const content = json.ok
        ? `✅ Done — command sent to Home Assistant.`
        : `❌ Action failed: ${json.error ?? 'unknown error'}`;
      setter(prev => [
        ...prev,
        { id: `action-${Date.now()}`, role: 'assistant' as const, content, timestamp: new Date().toISOString() },
      ]);
    } catch (err) {
      setter(prev => [
        ...prev,
        { id: `action-${Date.now()}`, role: 'assistant' as const, content: `❌ Action failed: ${(err as Error).message}`, timestamp: new Date().toISOString() },
      ]);
    }
  }

  function cancelHaAction() {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    const setter = action.persona === 'sayon' ? setSayonMessages : setSerenMessages;
    setter(prev => [
      ...prev,
      { id: `action-cancel-${Date.now()}`, role: 'assistant' as const, content: `Action cancelled — no changes were made.`, timestamp: new Date().toISOString() },
    ]);
  }

  return (
    <aside className={`phob-chrome-zone border-l border-phob-orange/20 bg-[#080808] flex shrink-0 h-full transition-all duration-300 overflow-hidden ${
      isExpanded ? 'flex-1' : 'w-[280px] flex-col'
    }`}>

      {/* ── Expanded: left sidebar (portrait + stats) ── */}
      {isExpanded && (
        <div className="w-[220px] shrink-0 flex flex-col border-r border-border/20 overflow-y-auto scrollbar-thin">
          <PersonaHero
            persona={activeCopilot}
            stats={stats[activeCopilot]}
            online={activeOnline}
            modelName={activeModelName}
            onVoiceMode={handleVoiceMode}
            voiceModeActive={voiceMode}
            voiceModeListening={activeAudio.sttListening}
            voiceModeTranscribing={activeAudio.transcribing}
            voiceModePlaying={activeAudio.ttsPlaying}
          />
          <StatsPanel stats={stats[activeCopilot]} persona={activeCopilot} />
        </div>
      )}

      {/* ── Right column (always): header + messages + input ── */}
      <div className="phobos-copilot-body flex flex-col flex-1 min-w-0 h-full bg-[#080808]">

      {/* ── Header with persona tabs ── */}
      <div className="px-3 py-1.5 border-b border-phob-orange/15">
        <div className="flex items-center gap-1">
          {(['sayon', 'seren'] as CopilotPersona[]).map(p => {
            const pOnline = p === 'sayon' ? sayonOnline : serenOnline;
            const isActive = activeTab === p;
            const pIsSayon = p === 'sayon';
            return (
              <button
                key={p}
                onClick={() => switchTo(p)}
                className={`flex-[2] flex items-center gap-1.5 px-2 py-1 text-[8px] font-terminal uppercase tracking-[0.2em] transition-colors ${
                  isActive
                    ? pIsSayon
                      ? 'text-phob-teal bg-phob-teal/8 border-b-2 border-phob-teal'
                      : 'text-phob-yellow bg-phob-yellow/8 border-b-2 border-phob-yellow'
                    : 'text-phob-steel/40 hover:text-phob-steel/70'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  pOnline ? 'bg-phob-green phob-dot-static' : 'bg-phob-red/60'
                }`} />
                {p.toUpperCase()} PRIME
              </button>
            );
          })}
          {/* CLONE tab — always present, half the width of Prime tabs */}
          <button
            onClick={() => switchTo('clone')}
            className={`flex-[1] flex items-center justify-center gap-1 px-1.5 py-1 text-[7px] font-terminal uppercase tracking-[0.15em] transition-colors ${
              activeTab === 'clone'
                ? 'text-phob-purple/90 bg-phob-purple/8 border-b-2 border-phob-purple'
                : 'text-phob-steel/30 hover:text-phob-steel/60'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              activeCloneInfo ? 'bg-phob-purple phob-dot-static' : 'bg-phob-steel/20'
            }`} />
            CLONE
          </button>
          <div className="flex-1" />
          {/* ── Audio controls ─────────────────────────────────────────────── */}
          {/* Mic — push-to-talk. pointerLeave fires if finger slides off button. */}
          <button
            onPointerDown={handleMicPress}
            onPointerUp={handleMicRelease}
            onPointerLeave={() => { if (activeAudio.sttListening) handleMicRelease(); }}
            disabled={isStreaming}
            title={activeAudio.transcribing ? 'Transcribing…' : activeAudio.sttListening ? 'Recording — release to transcribe' : 'Push to talk'}
            className={`p-1 rounded transition-colors disabled:opacity-30 ${
              activeAudio.sttListening
                ? 'text-phob-red/70 bg-phob-red/10 animate-pulse'
                : activeAudio.transcribing
                  ? 'text-phob-amber/70'
                  : 'text-muted-foreground/40 hover:text-muted-foreground/70'
            }`}
          >
            {activeAudio.transcribing
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : activeAudio.sttListening
                ? <MicOff className="w-3 h-3" />
                : <Mic className="w-3 h-3" />
            }
          </button>
          {/* Speaker toggle */}
          <button
            onClick={() => activeAudio.setTtsEnabled(!activeAudio.ttsEnabled)}
            title={activeAudio.ttsEnabled ? 'Disable voice responses' : 'Enable voice responses'}
            className={`p-1 rounded transition-colors ${
              activeAudio.ttsEnabled
                ? isSayon ? 'text-phob-teal/80' : 'text-phob-yellow/80'
                : 'text-muted-foreground/30 hover:text-muted-foreground/60'
            }`}
          >
            {activeAudio.ttsEnabled
              ? <Volume2 className="w-3 h-3" />
              : <VolumeX className="w-3 h-3" />
            }
          </button>
          {isStreaming && (
            <span className="text-[10px] text-muted-foreground/40 animate-pulse font-mono ml-1">thinking…</span>
          )}
        </div>
      </div>

      {/* ── TTS settings bar — only when TTS is on ── */}
      {activeAudio.ttsEnabled && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-phob-orange/10 bg-phob-white/4">
          {/* Engine toggle: Supertonic (default) | Kokoro */}
          <div className="flex items-center gap-0 rounded border border-border/25 overflow-hidden">
            {(['supertonic', 'kokoro'] as const).map(engine => (
              <button
                key={engine}
                onClick={() => activeAudio.setTtsBackend(engine)}
                className={`text-[8px] font-terminal tracking-[0.1em] px-2 py-0.5 transition-colors ${
                  activeAudio.ttsBackend === engine
                    ? 'bg-phob-orange/15 text-phob-orange/80 border-r border-phob-orange/20'
                    : 'text-phob-steel/30 hover:text-phob-steel/60 border-r border-phob-orange/10 last:border-r-0'
                }`}
                title={engine === 'supertonic' ? 'Supertonic 3 — default TTS engine (44.1kHz, 31 languages)' : 'Kokoro 82M — use for custom voice profiles'}
              >
                {engine === 'supertonic' ? 'SUPERTONIC' : 'KOKORO'}
              </button>
            ))}
          </div>

          {/* Voice selector — Supertonic voices when on Supertonic, Kokoro voices when on Kokoro */}
          {activeAudio.ttsBackend === 'supertonic' && activeAudio.availableSupertonicVoices.length > 0 && (
            <select
              value={activeAudio.selectedVoice}
              onChange={(e) => activeAudio.setSelectedVoice(e.target.value)}
              className="text-[9px] font-mono bg-transparent border border-border/25 rounded px-1.5 py-0.5 text-muted-foreground/50 hover:border-muted-foreground/40 focus:outline-none"
              title="Supertonic voice"
            >
              {activeAudio.availableSupertonicVoices.map(v => (
                <option key={v} value={v} className="bg-black">{v}</option>
              ))}
            </select>
          )}
          {activeAudio.ttsBackend === 'kokoro' && activeAudio.availableVoices.length > 0 && (
            <select
              value={activeAudio.selectedVoice}
              onChange={(e) => activeAudio.setSelectedVoice(e.target.value)}
              className="text-[9px] font-mono bg-transparent border border-border/25 rounded px-1.5 py-0.5 text-muted-foreground/50 hover:border-muted-foreground/40 focus:outline-none"
              title="Kokoro voice"
            >
              {activeAudio.availableVoices.map(v => (
                <option key={v} value={v} className="bg-black">{v}</option>
              ))}
            </select>
          )}

          <button
            onClick={() => activeAudio.setPlaybackMode(activeAudio.playbackMode === 'browser' ? 'host' : 'browser')}
            title={activeAudio.playbackMode === 'host' ? 'Audio plays via PhobosHost FX chain' : 'Audio plays in browser'}
            className={`text-[8px] font-terminal tracking-[0.1em] px-2 py-0.5 rounded border transition-colors ${
              activeAudio.playbackMode === 'host'
                ? 'border-phob-orange/30 text-phob-orange/60'
                : 'border-phob-orange/15 text-phob-steel/30 hover:text-phob-steel/60'
            }`}
          >
            {activeAudio.playbackMode === 'host' ? 'HOST' : 'BROWSER'}
          </button>
        </div>
      )}


      {/* ── Subheader (compact mode only) ── */}
      {!isExpanded && (
        <div className="px-3 py-1 border-b border-border/20">
          <span className="text-[10px] text-muted-foreground/40 font-mono">
            {isSayon ? 'Fast coordinator · system awareness' : 'Deep reasoner · architecture partner'}
          </span>
        </div>
      )}

      {/* ── Thinking indicator ── */}
      {isStreaming && thinkingBuf && (
        <div className="px-3 py-1.5 border-b flex items-center gap-2" style={{ borderColor: isSayon ? 'rgba(0,212,170,0.2)' : 'rgba(207,255,4,0.15)', backgroundColor: isSayon ? 'rgba(0,212,170,0.04)' : 'rgba(207,255,4,0.04)' }}>
          <span className="phob-dot shrink-0" style={{ color: isSayon ? '#00d4aa' : '#CFFF04' }} />
          <span className="text-[9px] font-terminal uppercase tracking-[0.2em]" style={{ color: isSayon ? 'rgba(0,212,170,0.8)' : 'rgba(207,255,4,0.8)' }}>
            {isSayon ? 'SAYON reasoning…' : 'SEREN reasoning…'}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setShowThinking(prev => !prev)}
            className="text-[9px] text-phob-steel/40 hover:text-phob-steel/70 font-mono transition-colors"
          >
            {showThinking ? 'hide' : 'show'}
          </button>
        </div>
      )}

      {/* ── Expanded thinking trace (local state only — never touches useAppStore.segments) ── */}
      {showThinking && thinkingBuf && (
        <div className="px-3 py-2 border-b max-h-40 overflow-y-auto scrollbar-thin" style={{ borderColor: 'rgba(0,212,170,0.1)', backgroundColor: 'rgba(0,212,170,0.03)' }}>
          <pre className="text-[10px] font-mono whitespace-pre-wrap leading-relaxed" style={{ color: isSayon ? 'rgba(0,212,170,0.5)' : 'rgba(207,255,4,0.5)' }}>
            {thinkingBuf}
          </pre>
        </div>
      )}

      {/* ── Post-stream thinking toggle ── */}
      {!isStreaming && thinkingBuf && activeTab !== 'clone' && (
        <div className="px-3 py-1 border-b border-border/20 flex items-center justify-end">
          <button
            onClick={() => setShowThinking(prev => !prev)}
            className="text-[10px] text-muted-foreground/30 hover:text-muted-foreground/60 font-mono transition-colors"
          >
            {showThinking ? 'hide reasoning' : 'show reasoning'}
          </button>
        </div>
      )}

      {/* ── Clone tab: selector or active conversation ── */}
      {activeTab === 'clone' && !activeCloneInfo && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
          <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-phob-steel/40">
            SELECT A CLONE TO ACTIVATE
          </p>
          <select
            value={selectedCloneId}
            onChange={e => setSelectedCloneId(e.target.value)}
            className="w-full max-w-xs bg-[#0d0d0d] border border-phob-purple/20 text-[10px] font-mono text-phob-steel/70 px-2 py-1.5 rounded focus:outline-none focus:border-phob-purple/50"
          >
            <option value="">— choose clone —</option>
            {cloneList.map(c => (
              <option key={c.id} value={c.id} disabled={!c.hasCartridge}>
                {c.displayName}{!c.hasCartridge ? ' (needs training)' : ''} · {c.slot.toUpperCase()}
              </option>
            ))}
          </select>
          {selectedCloneId && (
            <button
              onClick={handleActivateClone}
              disabled={cloneActivating}
              className="px-4 py-1.5 text-[9px] font-terminal uppercase tracking-[0.2em] bg-phob-purple/10 border border-phob-purple/30 text-phob-purple/80 hover:bg-phob-purple/20 disabled:opacity-40 transition-colors"
            >
              {cloneActivating ? 'ACTIVATING…' : 'ACTIVATE'}
            </button>
          )}
        </div>
      )}

      {/* ── Clone tab: active conversation ── */}
      {activeTab === 'clone' && activeCloneInfo && (
        <>
          {/* Clone header bar */}
          <div className="px-3 py-1 border-b border-phob-purple/15 flex items-center justify-between">
            <span className="text-[8px] font-terminal uppercase tracking-[0.2em] text-phob-purple/70">
              {activeCloneInfo.displayName} · {activeCloneInfo.slot.toUpperCase()} SLOT
            </span>
            <button
              onClick={handleDeactivateClone}
              disabled={cloneActivating}
              className="text-[7px] font-terminal uppercase tracking-[0.15em] text-phob-red/50 hover:text-phob-red/80 disabled:opacity-30 transition-colors"
            >
              {cloneActivating ? 'DEACTIVATING…' : 'DEACTIVATE'}
            </button>
          </div>
        </>
      )}

      {/* ── Messages (Prime tabs and active Clone tab) ── */}
      {(activeTab !== 'clone' || activeCloneInfo) && (
      <div ref={scrollContainerRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-thin px-3 py-3">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-[11px] text-muted-foreground/30 mt-8 px-4 leading-relaxed">
            {activeTab === 'clone' ? (
              <><span className="text-phob-purple/50 font-terminal uppercase tracking-[0.15em]">{activeCloneInfo?.displayName}</span> is ready.</>
            ) : isSayon ? (
              <>
                <span className="text-phob-teal/50 font-terminal uppercase tracking-[0.15em]">SAYON</span> sees everything.
                <br />Ask about your threads, files, workflow — or just talk.
              </>
            ) : (
              <>
                <span className="text-phob-yellow/50 font-terminal uppercase tracking-[0.15em]">SEREN</span> thinks deeply.
                <br />Bring your hardest problems, architecture decisions, and trade-offs.
              </>
            )}
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onResolveContent={async (id) => attachmentCache[id] ?? null}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      )}{/* end (activeTab !== 'clone' || activeCloneInfo) */}

      {/* ── HA Action Confirmation Card ── */}
      {pendingAction && (
        <div className="mx-3 mb-2 border border-phob-amber/40 bg-phob-amber/5 p-3">
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle size={15} className="text-phob-amber mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[9px] font-terminal uppercase tracking-[0.15em] text-phob-amber/80 leading-tight">Action pending approval</p>
              <p className="text-xs text-foreground/80 mt-0.5 leading-snug">{pendingAction.label}</p>
              <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                {pendingAction.domain}.{pendingAction.service} → {pendingAction.entity_id}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={confirmHaAction}
              className="flex-1 flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 transition-colors"
            >
              <CheckCircle size={12} />
              Confirm
            </button>
            <button
              onClick={cancelHaAction}
              className="flex-1 rounded px-2 py-1.5 text-xs font-medium bg-muted/30 border border-border/40 text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Input — hidden on clone tab when no clone is active ── */}
      {(activeTab !== 'clone' || activeCloneInfo) && (
      <ChatInput
        onSend={handleSend}
        placeholder={
          activeTab === 'clone'
            ? `Talk to ${activeCloneInfo?.displayName ?? 'clone'}…`
            : !activeOnline
              ? `${activeCopilot.toUpperCase()} offline…`
              : isSayon
                ? 'Ask Sayon…'
                : 'Ask Seren…'
        }
        disabled={
          isStreaming ||
          (activeTab !== 'clone' && !activeOnline) ||
          (activeTab === 'clone' && !activeCloneInfo)
        }
        hideStatus
      />
      )}
      </div>{/* end right column */}
    </aside>
  );
}

// Memoized — CopilotPanel owns MediaRecorder refs that must survive parent re-renders
export const CopilotPanel = React.memo(CopilotPanelInner);