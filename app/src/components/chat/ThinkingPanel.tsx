import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAppStore, type AgentState } from '@/store/useAppStore';
import { AgentStateIcon } from './AgentStateIcon';
import { Copy, Check } from 'lucide-react';

/* ─── Data types ─── */

export interface ThinkingSegment {
  id: string;
  phase: 'coordinator' | 'engine';
  content: string;
  startedAt: string;
  completedAt: string | null;
  tokenCount: number;
  live: boolean;
}

export interface ThinkingPanelProps {
  segments?: ThinkingSegment[];
  isStreaming?: boolean;
  coordHasThinking?: boolean;
  engineHasThinking?: boolean;
  coordModelLabel?: string;
  engineModelLabel?: string;
  taskProgress?: { taskIndex: number; taskTotal: number } | null;
  onClose?: () => void;
}

/* ─── Helpers ─── */

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

interface QueryGroup {
  segments: ThinkingSegment[];
  startedAt: string;
}

function groupSegments(segments: ThinkingSegment[]): QueryGroup[] {
  if (segments.length === 0) return [];
  const groups: QueryGroup[] = [];
  let current: ThinkingSegment[] = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const cur = segments[i];
    if (prev.completedAt && cur.startedAt !== prev.startedAt) {
      groups.push({ segments: current, startedAt: current[0].startedAt });
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  groups.push({ segments: current, startedAt: current[0].startedAt });
  return groups;
}

/* ─── Timestamp divider ─── */

function TimestampDivider({ iso }: { iso: string }) {
  return (
    <div className="flex items-center gap-1 my-1.5 select-none">
      <span className="text-[9px] font-mono text-muted-foreground/20">──</span>
      <span className="text-[9px] font-mono text-muted-foreground/20">{fmtTime(iso)}</span>
      <span className="text-[9px] font-mono text-muted-foreground/20 flex-1 overflow-hidden whitespace-nowrap">
        ──────────────────────────
      </span>
    </div>
  );
}

/* ─── Previous thoughts accordion ─── */

interface PreviousThoughtsProps {
  groups: QueryGroup[];
  tintClass: string;
}

function PreviousThoughts({ groups, tintClass }: PreviousThoughtsProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (groups.length === 0) return null;

  const lastCompleted = groups[groups.length - 1];
  const lastSeg = lastCompleted.segments[lastCompleted.segments.length - 1];
  const lastTime = lastSeg.completedAt ?? lastSeg.startedAt;

  if (!expanded) {
    return (
      <div
        className="cursor-pointer hover:bg-accent/10 transition-colors px-1 py-1.5 mb-2 border border-border/20"
        onClick={() => setExpanded(true)}
      >
        <div className="text-[9px] font-terminal text-muted-foreground/30 tracking-wider">
          PREVIOUS THOUGHTS
        </div>
        <div className="text-[9px] font-mono text-muted-foreground/20">
          {fmtTime(lastTime)}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2 border border-border/20">
      <div
        className="cursor-pointer hover:bg-accent/10 transition-colors px-1 py-1.5"
        onClick={() => setExpanded(false)}
      >
        <div className="text-[9px] font-terminal text-muted-foreground/30 tracking-wider">
          PREVIOUS THOUGHTS ▾
        </div>
      </div>
      <div className="px-1">
        {groups.map((g, i) => (
          <div key={i}>
            <div
              className="cursor-pointer hover:bg-accent/10 transition-colors py-1 flex items-center gap-2"
              onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
            >
              <span className="text-[9px] font-mono text-muted-foreground/30">
                {fmtTime(g.startedAt)}
              </span>
              <span className="text-[9px] font-mono text-muted-foreground/20">
                {expandedIdx === i ? '▾' : '▸'}
              </span>
            </div>
            {expandedIdx === i && (
              <div className="pb-2">
                {g.segments.map((seg) => (
                  <div key={seg.id}>
                    <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                      {seg.content}
                    </pre>
                    {seg.completedAt && <TimestampDivider iso={seg.completedAt} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Section panel ─── */

interface SectionProps {
  label: string;
  tintClass: string;
  modelLabel: string;
  hasThinking: boolean;
  segments: ThinkingSegment[];
  isStreaming: boolean;
  collapsed: boolean;
  onToggle: () => void;
  taskProgress?: { taskIndex: number; taskTotal: number } | null;
  agentState?: { state: AgentState; detail: string } | null;
}

function SectionPanel({
  label, tintClass, modelLabel, hasThinking, segments, isStreaming, collapsed, onToggle, taskProgress, agentState,
}: SectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef<Map<string, number>>(new Map());
  const [userScrolled, setUserScrolled] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setUserScrolled(el.scrollHeight - el.scrollTop - el.clientHeight > 30);
  }, []);

  useEffect(() => {
    if (!userScrolled && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  const totalTokens = segments.reduce((s, seg) => s + seg.tokenCount, 0);

  const groups = useMemo(() => groupSegments(segments), [segments]);
  const pastGroups = groups.length > 1 ? groups.slice(0, -1) : [];
  const currentGroup = groups.length > 0 ? groups[groups.length - 1] : null;

  const hasContent = segments.some((s) => s.content.length > 0);

  return (
    <div className={`group flex flex-col min-h-0 overflow-hidden ${collapsed ? 'shrink-0' : 'flex-1'}`}>
      {/* Section header — two rows */}
      <div
        className="flex items-start justify-between px-3 py-1.5 border-b border-border/30 shrink-0 cursor-pointer hover:bg-accent/10 transition-colors select-none"
        onClick={onToggle}
      >
        <div className="flex items-start gap-2">
          {agentState && agentState.state !== 'idle' && (
            <AgentStateIcon
              state={agentState.state}
              tint={tintClass === 'text-sayon' ? 'hsl(30, 100%, 50%)' : 'hsl(0, 85%, 55%)'}
              size={18}
            />
          )}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-terminal font-semibold tracking-[0.2em] ${tintClass}`}>
                {label}
              </span>
              {taskProgress ? (
                <span className={`text-[9px] font-mono ${tintClass} opacity-60`}>
                  {taskProgress.taskIndex}/{taskProgress.taskTotal}
                </span>
              ) : (
                <span className="text-[9px] font-mono text-muted-foreground/25">…</span>
              )}
              {!hasThinking && (
                <span className="text-[9px] font-mono text-muted-foreground/30 border border-muted-foreground/20 rounded px-1 tracking-wider">
                  NO-RSNG
                </span>
              )}
            </div>
            {agentState && agentState.state !== 'idle' && agentState.detail && (
              <span className="text-[8px] font-mono text-muted-foreground/35 truncate max-w-[180px]">
                {agentState.detail}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasContent && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const text = segments.map(s => s.content).join('\n\n');
                navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-muted-foreground/30 hover:text-muted-foreground"
              title="Copy reasoning"
            >
              {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
            </button>
          )}
          {totalTokens > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/50">
              {totalTokens.toLocaleString()} tk
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/30">
            {collapsed ? '▸' : '▾'}
          </span>
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto scrollbar-thin p-2"
        >
          {hasContent ? (
            <>
              <PreviousThoughts groups={pastGroups} tintClass={tintClass} />
              {currentGroup && currentGroup.segments.map((seg) => {
                const committed = committedRef.current.get(seg.id) ?? 0;
                const settled = seg.content.slice(0, committed);
                const fresh = seg.content.slice(committed);

                // Advance committed mark after paint
                if (seg.content.length > committed) {
                  queueMicrotask(() => committedRef.current.set(seg.id, seg.content.length));
                }

                return (
                  <div key={seg.id}>
                    <pre className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                      <span>{settled}</span>
                      {fresh && (
                        <span
                          key={`${seg.id}-${seg.content.length}`}
                          className="animate-ink inline"
                        >
                          {fresh}
                        </span>
                      )}
                      {seg.live && isStreaming && (
                        <span className={`inline-block w-1.5 h-3 ${tintClass === 'text-sayon' ? 'bg-sayon/60' : 'bg-seren/60'} animate-pulse ml-0.5 align-text-bottom`} />
                      )}
                    </pre>
                    {seg.completedAt && <TimestampDivider iso={seg.completedAt} />}
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-[10px] font-mono text-muted-foreground/20 italic py-4 text-center">
              {hasThinking ? 'No trace' : 'Model does not support reasoning'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main panel ─── */

export function ThinkingPanel({
  segments = mockSegments,
  isStreaming = true,
  coordHasThinking = true,
  engineHasThinking = true,
  coordModelLabel = 'Qwen3-3B',
  engineModelLabel = 'DeepSeek-R1',
  taskProgress = null,
  onClose = () => {},
}: ThinkingPanelProps) {
  const thinkingOpen = useAppStore((s) => s.thinkingOpen);
  const toggleThinking = useAppStore((s) => s.toggleThinking);
  const agentStates = useAppStore((s) => s.agentStates);

  const coordSegments = useMemo(() => segments.filter((s) => s.phase === 'coordinator'), [segments]);
  const engineSegments = useMemo(() => segments.filter((s) => s.phase === 'engine'), [segments]);

  const [sayonOverride, setSayonOverride] = useState<boolean | null>(null);
  const [serenOverride, setSerenOverride] = useState<boolean | null>(null);

  const prevCoordLabel = useRef('');
  const prevEngineLabel = useRef('');
  useEffect(() => {
    if (prevCoordLabel.current !== coordModelLabel) {
      prevCoordLabel.current = coordModelLabel;
      setSayonOverride(null);
    }
  }, [coordModelLabel]);
  useEffect(() => {
    if (prevEngineLabel.current !== engineModelLabel) {
      prevEngineLabel.current = engineModelLabel;
      setSerenOverride(null);
    }
  }, [engineModelLabel]);

  const sayonCollapsed = sayonOverride !== null ? sayonOverride : !coordHasThinking;
  const serenCollapsed = serenOverride !== null ? serenOverride : !engineHasThinking;

  if (!thinkingOpen) {
    return (
      <div
        className="phobos-thinking-collapsed w-8 shrink-0 border-l border-border/50 bg-background flex items-center justify-center cursor-pointer hover:bg-accent/20 transition-colors"
        onClick={toggleThinking}
      >
        <span className="text-[10px] font-terminal text-muted-foreground/50 tracking-widest [writing-mode:vertical-rl]">
          THINKING
        </span>
      </div>
    );
  }

  return (
    <div className="phobos-thinking-panel w-[280px] shrink-0 border-l border-border/50 bg-background/90 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-terminal font-semibold text-muted-foreground/60 tracking-[0.15em]">
            REASONING
          </span>
          {(() => {
            const totalTk = segments.reduce((sum, seg) => sum + seg.tokenCount, 0);
            return totalTk > 0 ? (
              <span className="text-[10px] font-mono text-phobos-green/60">
                {totalTk.toLocaleString()} tk
              </span>
            ) : null;
          })()}
        </div>
        <button
          onClick={() => { onClose(); toggleThinking(); }}
          className="text-[10px] font-mono text-muted-foreground/30 hover:text-muted-foreground transition-colors"
        >
          ×
        </button>
      </div>

      <SectionPanel
        label="SAYON"
        tintClass="text-sayon"
        modelLabel={coordModelLabel}
        hasThinking={coordHasThinking}
        segments={coordSegments}
        isStreaming={isStreaming}
        collapsed={sayonCollapsed}
        onToggle={() => setSayonOverride((v) => v === null ? !sayonCollapsed : !v)}
        agentState={agentStates?.sayon}
      />
      <div className="h-px bg-border/30 shrink-0" />
      <SectionPanel
        label="SEREN"
        tintClass="text-seren"
        modelLabel={engineModelLabel}
        hasThinking={engineHasThinking}
        segments={engineSegments}
        isStreaming={isStreaming}
        collapsed={serenCollapsed}
        onToggle={() => setSerenOverride((v) => v === null ? !serenCollapsed : !v)}
        taskProgress={taskProgress}
        agentState={agentStates?.seren}
      />
    </div>
  );
}

/* ─── Mock data ─── */

const base = new Date('2025-01-15T14:20:00Z');
const iso = (offsetSec: number) => new Date(base.getTime() + offsetSec * 1000).toISOString();

export const mockSegments: ThinkingSegment[] = [
  // Past query — coordinator
  {
    id: 'c1', phase: 'coordinator',
    content: 'The user is asking about file persistence. I need to check if the directives API exists and route accordingly. Let me classify the intent as "config_update" in the system domain.',
    startedAt: iso(0), completedAt: iso(12), tokenCount: 38, live: false,
  },
  {
    id: 'c2', phase: 'coordinator',
    content: 'Intent classified. Routing to engine for implementation. The scope is narrow — only two PUT endpoints need wiring. I will draft the task list and delegate.',
    startedAt: iso(13), completedAt: iso(22), tokenCount: 34, live: false,
  },
  {
    id: 'c3', phase: 'coordinator',
    content: 'Engine has returned a patch set. Validating against the original request… all acceptance criteria met. Delivering final response.',
    startedAt: iso(50), completedAt: iso(58), tokenCount: 28, live: false,
  },
  // Past query — engine
  {
    id: 'e1', phase: 'engine',
    content: 'I need to add fetch calls in useEffect for hydrating directives on mount. The endpoint pattern is GET /api/documents/:slug. I\'ll use a try/catch so 404s fall back to defaults.',
    startedAt: iso(23), completedAt: iso(35), tokenCount: 42, live: false,
  },
  {
    id: 'e2', phase: 'engine',
    content: 'Now wiring the save handler in FileEditorWindow. On save, determine which slug from the filename, call PUT with { content }. Update store on 200. The saving indicator is already in the component.',
    startedAt: iso(36), completedAt: iso(49), tokenCount: 40, live: false,
  },
  // Current query — live
  {
    id: 'c4', phase: 'coordinator',
    content: 'New request: the user wants the ThinkingPanel redesigned with query grouping and a "previous thoughts" accordion. This is a UI-only change scoped to one file. Classifying as ui_refactor in the frontend domain. Delegating to engine with detailed spec…',
    startedAt: iso(70), completedAt: null, tokenCount: 48, live: true,
  },
  {
    id: 'e3', phase: 'engine',
    content: 'Building the new ThinkingPanel. I\'ll start with the ThinkingSegment interface, then the grouping logic to split segments into query groups based on completedAt gaps. The PreviousThoughts accordion needs two layers of expand/collapse…',
    startedAt: iso(72), completedAt: null, tokenCount: 44, live: true,
  },
];