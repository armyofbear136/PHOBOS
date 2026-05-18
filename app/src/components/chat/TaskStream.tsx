import { useState } from 'react';
import { CheckCircle2, XCircle, Clock, Terminal, FlaskConical, ChevronDown, ChevronRight } from 'lucide-react';
import type { ExecuteResult } from '@/store/useAppStore';

interface Props {
  results: ExecuteResult[];
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ResultCard({ result }: { result: ExecuteResult }) {
  const [expanded, setExpanded] = useState(false);

  const isSimulate = result.mode === 'simulate';
  const success    = !result.timedOut && result.exitCode === 0;
  const timedOut   = result.timedOut;

  const statusColor = success
    ? 'text-phobos-green border-phobos-green/30 bg-phobos-green/[0.06]'
    : timedOut
    ? 'text-phobos-amber border-phobos-amber/30 bg-phobos-amber/[0.06]'
    : 'text-destructive border-destructive/30 bg-destructive/[0.06]';

  const Icon = isSimulate ? FlaskConical : Terminal;

  const statusIcon = success
    ? <CheckCircle2 className="w-3 h-3 shrink-0" />
    : timedOut
    ? <Clock className="w-3 h-3 shrink-0" />
    : <XCircle className="w-3 h-3 shrink-0" />;

  const headline = isSimulate
    ? (success ? 'Simulation complete' : timedOut ? 'Simulation timed out' : 'Simulation error')
    : (success ? 'Execution passed' : timedOut ? 'Execution timed out' : `Execution failed — exit ${result.exitCode}`);

  return (
    <div className={`mt-2 rounded border text-[10px] font-mono ${statusColor}`}>
      {/* Header row */}
      <button
        onClick={() => result.stdoutPreview ? setExpanded(!expanded) : undefined}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left ${result.stdoutPreview ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {/* Mode icon */}
        <Icon className="w-3 h-3 shrink-0 opacity-60" />

        {/* Status icon */}
        {statusIcon}

        {/* Label */}
        <span className="flex-1 truncate opacity-90">{headline}</span>

        {/* Duration */}
        <span className="opacity-40 shrink-0">{fmtDuration(result.durationMs)}</span>

        {/* Expand toggle — only when there's preview content */}
        {result.stdoutPreview && (
          expanded
            ? <ChevronDown className="w-3 h-3 shrink-0 opacity-40" />
            : <ChevronRight className="w-3 h-3 shrink-0 opacity-40" />
        )}
      </button>

      {/* Preview row — first line of stdout, collapsed by default */}
      {result.stdoutPreview && !expanded && (
        <div className="px-2.5 pb-1.5 opacity-50 truncate">
          {result.stdoutPreview}
        </div>
      )}

      {/* Expanded: show full preview (capped at what the backend sent) */}
      {result.stdoutPreview && expanded && (
        <div className="px-2.5 pb-1.5 opacity-70 whitespace-pre-wrap break-all">
          {result.stdoutPreview}
        </div>
      )}
    </div>
  );
}

/**
 * TaskStream renders the ordered list of execute/simulate result cards
 * attached to an assistant message. Placed below file panels in MessageBubble.
 */
export function TaskStream({ results }: Props) {
  if (!results.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {results.map((r, i) => (
        <ResultCard key={`${r.taskIndex}-${i}`} result={r} />
      ))}
    </div>
  );
}
