import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore, type Message } from '@/store/useAppStore';
import { AgentStateIcon } from './AgentStateIcon';

interface Props {
  message: Message;
}

// Map activity label text to an AgentState for the icon
function labelToState(label: string): Parameters<typeof AgentStateIcon>[0]['state'] {
  const l = label.toLowerCase();
  if (l.includes('think')) return 'thinking';
  if (l.includes('plan') || l.includes('decompos')) return 'planning';
  if (l.includes('read') || l.includes('ingest') || l.includes('analys')) return 'reading';
  if (l.includes('execut') || l.includes('writ') || l.includes('creat') || l.includes('patch')) return 'executing';
  if (l.includes('review')) return 'reviewing';
  if (l.includes('build') || l.includes('compil')) return 'building';
  if (l.includes('deliver') || l.includes('summar') || l.includes('done') || l.includes('✓')) return 'delivering';
  if (l.includes('error') || l.includes('fail')) return 'error';
  return 'thinking';
}


export function ActivityBubble({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const thinkingTokenCount = useAppStore((s) => {
    const segs = s.segments[s.activeThreadId] ?? [];
    return segs.reduce((sum, seg) => sum + seg.tokenCount, 0);
  });
  const isActive = message.activityActive ?? false;
  const events = message.activityEvents ?? [];
  const currentLabel = message.content;

  // Show token count when thinking
  const isThinking = isActive && /thinking/i.test(currentLabel);
  const displayLabel = isThinking && thinkingTokenCount > 0
    ? `${currentLabel} · ${thinkingTokenCount.toLocaleString()} tokens`
    : currentLabel;

  return (
    <div className="flex justify-center py-1.5">
      <div className="max-w-[90%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className={`inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono rounded-md border transition-all ${
            isActive
              ? 'bg-primary/5 border-primary/20 text-primary animate-pulse'
              : 'bg-muted/50 border-border/50 text-muted-foreground'
          }`}
        >
          <AgentStateIcon state={isActive ? labelToState(currentLabel) : 'delivering'} tint={isActive ? '#00ff41' : '#6b7280'} size={12} />
          <span className="truncate">{displayLabel}</span>
          {events.length > 1 && (
            <>
              <span className="text-muted-foreground/40 ml-1">
                {events.length}
              </span>
              {expanded ? (
                <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
              ) : (
                <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />
              )}
            </>
          )}
        </button>

        {expanded && events.length > 0 && (
          <div className="mt-1 ml-2 border-l border-border/40 pl-2.5 space-y-0.5">
            {events.map((evt, i) => {
              const isLast = i === events.length - 1;
              return (
                <div
                  key={i}
                  className={`text-[10px] font-mono ${
                    isLast && isActive
                      ? 'text-primary'
                      : evt.includes('✓')
                      ? 'text-success'
                      : evt.toLowerCase().includes('fail') || evt.toLowerCase().includes('error')
                      ? 'text-destructive'
                      : 'text-muted-foreground/70'
                  }`}
                >
                  {evt}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface LiveActivityProps {
  activity: { label: string; log: string[] };
}

/** Stateless live activity gizmo — driven by liveActivity store state, always rendered last. */
export function LiveActivityGizmo({ activity }: LiveActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const thinkingTokenCount = useAppStore((s) => {
    const segs = s.segments[s.activeThreadId] ?? [];
    return segs.reduce((sum, seg) => sum + seg.tokenCount, 0);
  });
  const { label, log } = activity;

  const isDone = label === 'Done ✓';
  const isThinking = !isDone && /thinking/i.test(label);
  const displayLabel = isThinking && thinkingTokenCount > 0
    ? `${label} · ${thinkingTokenCount.toLocaleString()} tokens`
    : label;

  return (
    <div className="flex justify-center py-1.5">
      <div className="max-w-[90%]">
        <button
          onClick={() => setExpanded(!expanded)}
          className={`inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono rounded-md border transition-all ${
            isDone
              ? 'bg-success/10 border-success/30 text-success'
              : 'bg-primary/5 border-primary/20 text-primary animate-pulse'
          }`}
        >
          <AgentStateIcon state={isDone ? 'delivering' : labelToState(label)} tint={isDone ? '#22c55e' : '#00ff41'} size={12} />
          <span className="truncate">{displayLabel}</span>
          {log.length > 1 && (
            <>
              <span className="text-muted-foreground/40 ml-1">{log.length}</span>
              {expanded
                ? <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                : <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />}
            </>
          )}
        </button>

        {expanded && log.length > 0 && (
          <div className="mt-1 ml-2 border-l border-border/40 pl-2.5 space-y-0.5">
            {log.map((evt, i) => {
              const isLast = i === log.length - 1;
              return (
                <div
                  key={i}
                  className={`text-[10px] font-mono ${
                    isLast
                      ? 'text-primary'
                      : evt.includes('✓')
                      ? 'text-success'
                      : evt.toLowerCase().includes('fail') || evt.toLowerCase().includes('error')
                      ? 'text-destructive'
                      : 'text-muted-foreground/70'
                  }`}
                >
                  {evt}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
