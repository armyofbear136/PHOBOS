import { useAppStore, type Message } from '@/store/useAppStore';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ChatInput } from '@/components/chat/ChatInput';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX, Loader2, AlertTriangle, CheckCircle } from 'lucide-react';
import { useCopilotAudio } from '@/hooks/useCopilotAudio';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const uid = () => Math.random().toString(36).slice(2, 9);

type CopilotPersona = 'sayon' | 'seren';

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
      <span className={`text-[11px] font-mono font-semibold ${accent ? 'text-phobos-green/80' : 'text-muted-foreground/70'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Bond progress bar ────────────────────────────────────────────────────────

function BondBar({ score, persona }: { score: number; persona: CopilotPersona }) {
  const pct = Math.round(score * 100);
  const color = persona === 'sayon' ? 'bg-phobos-amber' : 'bg-blue-400';
  return (
    <div className="mt-1">
      <div className="flex justify-between mb-0.5">
        <span className="text-[9px] font-mono text-muted-foreground/30 uppercase tracking-widest">BOND</span>
        <span className="text-[9px] font-mono text-muted-foreground/50">{pct} / 100</span>
      </div>
      <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
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
  const accent = isSayon ? 'text-phobos-amber' : 'text-blue-400';
  const accentBorder = isSayon ? 'border-phobos-amber/20' : 'border-blue-400/20';
  const accentBg = isSayon ? 'bg-phobos-amber/5' : 'bg-blue-400/5';
  const accentGlow = isSayon
    ? 'shadow-[0_0_40px_hsl(38_100%_50%/0.08)]'
    : 'shadow-[0_0_40px_hsl(213_94%_68%/0.08)]';

  const tier = getTier(stats.bond_score);

  return (
    <div className={`flex flex-col items-center px-4 pt-5 pb-4 border-b ${accentBorder} ${accentBg} ${accentGlow}`}>
      {/* Portrait */}
      <div className={`relative w-24 h-24 rounded-full overflow-hidden border-2 ${accentBorder} mb-3`}
        style={{ boxShadow: isSayon ? '0 0 24px hsl(38 100% 50% / 0.15)' : '0 0 24px hsl(213 94% 68% / 0.15)' }}
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
          online ? 'bg-phobos-green animate-pulse-dot' : 'bg-destructive/60'
        }`} />
      </div>

      {/* Name + tagline */}
      <span className={`text-base font-terminal font-semibold tracking-[0.2em] ${accent}`}>
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
      <div className={`mt-3 px-3 py-0.5 rounded-sm border ${accentBorder} ${accentBg}`}>
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
          className={`relative flex items-center justify-center rounded-full border-2 transition-all duration-200 outline-none focus:outline-none ${
            voiceModeListening
              ? `border-red-400/70 bg-red-400/10 shadow-[0_0_24px_hsl(0_100%_65%/0.3)] w-16 h-16`
              : voiceModePlaying
                ? isSayon
                  ? 'border-phobos-amber/70 bg-phobos-amber/10 shadow-[0_0_24px_hsl(38_100%_50%/0.25)] w-16 h-16'
                  : 'border-blue-400/70 bg-blue-400/10 shadow-[0_0_24px_hsl(213_94%_68%/0.25)] w-16 h-16'
                : voiceModeTranscribing
                  ? 'border-yellow-400/40 bg-yellow-400/5 w-16 h-16'
                  : isSayon
                    ? 'border-phobos-amber/30 bg-phobos-amber/5 hover:border-phobos-amber/60 hover:bg-phobos-amber/10 hover:shadow-[0_0_20px_hsl(38_100%_50%/0.2)] w-14 h-14 hover:w-16 hover:h-16'
                    : 'border-blue-400/30 bg-blue-400/5 hover:border-blue-400/60 hover:bg-blue-400/10 hover:shadow-[0_0_20px_hsl(213_94%_68%/0.2)] w-14 h-14 hover:w-16 hover:h-16'
          } disabled:opacity-40`}
        >
          {/* Ripple ring — shown while listening */}
          {voiceModeListening && (
            <span className="absolute inset-0 rounded-full border-2 border-red-400/30 animate-ping" />
          )}
          {voiceModePlaying && (
            <span className={`absolute inset-0 rounded-full border-2 animate-ping ${
              isSayon ? 'border-phobos-amber/20' : 'border-blue-400/20'
            }`} />
          )}
          {/* Icon */}
          {voiceModeTranscribing
            ? <Loader2 className="w-6 h-6 text-yellow-400/60 animate-spin" />
            : voiceModeListening
              ? <MicOff className="w-6 h-6 text-red-400/90" />
              : voiceModePlaying
                ? <Volume2 className={`w-6 h-6 ${isSayon ? 'text-phobos-amber/90' : 'text-blue-400/90'}`} />
                : <Mic className={`w-6 h-6 ${isSayon ? 'text-phobos-amber/60' : 'text-blue-400/60'}`} />
          }
        </button>
        <span className={`text-[9px] font-terminal tracking-[0.15em] uppercase ${
          voiceModeListening   ? 'text-red-400/70'
          : voiceModeTranscribing ? 'text-yellow-400/50'
          : voiceModePlaying   ? (isSayon ? 'text-phobos-amber/60' : 'text-blue-400/60')
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
  const accentBorder = isSayon ? 'border-phobos-amber/10' : 'border-blue-400/10';

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
  const [sayonMessages, setSayonMessages] = useState<Message[]>([]);
  const [serenMessages, setSerenMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingBuf, setThinkingBuf] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState({ sayon: false, seren: false });
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
  const messages = activeCopilot === 'sayon' ? sayonMessages : serenMessages;
  const setMessages = activeCopilot === 'sayon' ? setSayonMessages : setSerenMessages;

  const isVisible = copilotMode !== 'hidden';
  const isExpanded = copilotMode === 'expanded';

  // Scroll to bottom when new messages are added or persona switches (non-streaming).
  // Per-token scroll is handled inline in the token handler below (instant, no layout thrash).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, activeCopilot, isStreaming]);

  // Load persisted message history on first open per persona
  useEffect(() => {
    if (!isVisible) return;
    if (historyLoaded[activeCopilot]) return;

    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/copilot/${activeCopilot}/messages`);
        if (!res.ok) return;
        const { messages: persisted } = await res.json() as {
          messages: Array<{ id: string; role: string; content: string; created_at: string }>;
        };
        const mapped: Message[] = persisted
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            timestamp: m.created_at,
          }));
        if (activeCopilot === 'sayon') setSayonMessages(mapped);
        else setSerenMessages(mapped);
        setHistoryLoaded(prev => ({ ...prev, [activeCopilot]: true }));
      } catch { /* engine not running */ }
    })();
  }, [isVisible, activeCopilot, historyLoaded]);

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
    fetchStats(activeCopilot);
  }, [isVisible, activeCopilot, fetchStats]);

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
    console.debug(`[SEND:7] handleSend called — persona: ${activeCopilot}, content: "${content.slice(0, 80)}"`);
    const persona = activeCopilot;
    const setter = persona === 'sayon' ? setSayonMessages : setSerenMessages;

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
      console.debug(`[SEND:8] fetching ${ENGINE_URL}/api/copilot/${persona}`);
      const res = await fetch(`${ENGINE_URL}/api/copilot/${persona}`, {
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
  }, [activeCopilot, fetchStats, sayonAudio, serenAudio]);

  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const switchTo = useCallback((persona: CopilotPersona) => {
    if (isStreaming) return;
    // Interrupt active TTS when switching personas — each has its own audio context
    activeAudio.interrupt();
    setActiveCopilot(persona);
    setThinkingBuf('');
    setShowThinking(false);
  }, [isStreaming, activeAudio]);

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
  const accentText = isSayon ? 'text-phobos-amber' : 'text-blue-400';
  const accentBg = isSayon ? 'bg-phobos-amber/10' : 'bg-blue-400/10';
  const accentBorder = isSayon ? 'border-phobos-amber/30' : 'border-blue-400/30';
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
    <aside className={`border-l border-border/50 bg-background flex shrink-0 h-full transition-all duration-300 overflow-hidden ${
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
      <div className="phobos-copilot-body flex flex-col flex-1 min-w-0 h-full">

      {/* ── Header with persona tabs ── */}
      <div className="px-3 py-2 border-b border-border/30">
        <div className="flex items-center gap-1">
          {(['sayon', 'seren'] as CopilotPersona[]).map(p => {
            const pOnline = p === 'sayon' ? sayonOnline : serenOnline;
            const isActive = activeCopilot === p;
            const pIsSayon = p === 'sayon';
            return (
              <button
                key={p}
                onClick={() => switchTo(p)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-terminal font-semibold tracking-[0.1em] transition-colors ${
                  isActive
                    ? pIsSayon
                      ? 'text-phobos-amber bg-phobos-amber/10 border border-phobos-amber/30'
                      : 'text-blue-400 bg-blue-400/10 border border-blue-400/30'
                    : 'text-muted-foreground/40 hover:text-muted-foreground/70'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  pOnline ? 'bg-phobos-green animate-pulse-dot' : 'bg-destructive/60'
                }`} />
                {p.toUpperCase()} PRIME
              </button>
            );
          })}
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
                ? 'text-red-400 bg-red-400/15 animate-pulse'
                : activeAudio.transcribing
                  ? 'text-yellow-400/70'
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
                ? isSayon ? 'text-phobos-amber/80' : 'text-blue-400/80'
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
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border/15 bg-black/40">
          {activeAudio.availableVoices.length > 0 && (
            <select
              value={activeAudio.selectedVoice}
              onChange={(e) => activeAudio.setSelectedVoice(e.target.value)}
              className="text-[9px] font-mono bg-transparent border border-border/25 rounded px-1.5 py-0.5 text-muted-foreground/50 hover:border-muted-foreground/40 focus:outline-none"
              title="TTS voice"
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
                ? 'border-phobos-amber/30 text-phobos-amber/60'
                : 'border-border/20 text-muted-foreground/30 hover:text-muted-foreground/60'
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
        <div className="px-3 py-1.5 border-b border-blue-400/20 bg-blue-400/5 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
          <span className="text-[11px] text-blue-400/80 font-mono font-semibold tracking-wide">
            {isSayon ? 'SAYON reasoning…' : 'SEREN reasoning…'}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setShowThinking(prev => !prev)}
            className="text-[10px] text-blue-400/50 hover:text-blue-400/80 font-mono transition-colors"
          >
            {showThinking ? 'hide' : 'show'}
          </button>
        </div>
      )}

      {/* ── Expanded thinking trace (local state only — never touches useAppStore.segments) ── */}
      {showThinking && thinkingBuf && (
        <div className="px-3 py-2 border-b border-blue-400/10 bg-blue-950/20 max-h-40 overflow-y-auto scrollbar-thin">
          <pre className="text-[10px] text-blue-300/40 font-mono whitespace-pre-wrap leading-relaxed">
            {thinkingBuf}
          </pre>
        </div>
      )}

      {/* ── Post-stream thinking toggle ── */}
      {!isStreaming && thinkingBuf && (
        <div className="px-3 py-1 border-b border-border/20 flex items-center justify-end">
          <button
            onClick={() => setShowThinking(prev => !prev)}
            className="text-[10px] text-muted-foreground/30 hover:text-muted-foreground/60 font-mono transition-colors"
          >
            {showThinking ? 'hide reasoning' : 'show reasoning'}
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div ref={scrollContainerRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-thin px-3 py-3">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-[11px] text-muted-foreground/30 mt-8 px-4 leading-relaxed">
            {isSayon ? (
              <>
                <span className="text-phobos-amber/50 font-semibold">SAYON</span> sees everything.
                <br />Ask about your threads, files, workflow — or just talk.
              </>
            ) : (
              <>
                <span className="text-blue-400/50 font-semibold">SEREN</span> thinks deeply.
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

      {/* ── HA Action Confirmation Card ── */}
      {pendingAction && (
        <div className="mx-3 mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-amber-300 leading-tight">Action pending approval</p>
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

      {/* ── Input ── */}
      <ChatInput
        onSend={handleSend}
        placeholder={
          !activeOnline
            ? `${activeCopilot.toUpperCase()} offline…`
            : isSayon
              ? 'Ask Sayon…'
              : 'Ask Seren…'
        }
        disabled={!activeOnline || isStreaming}
        hideStatus
      />
      </div>{/* end right column */}
    </aside>
  );
}

// Memoized — CopilotPanel owns MediaRecorder refs that must survive parent re-renders
export const CopilotPanel = React.memo(CopilotPanelInner);