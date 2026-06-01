import { useState } from 'react';
import { Copy, Check, FileText, Image } from 'lucide-react';
import { useAppStore, type Message } from '@/store/useAppStore';
import { StatusPill } from './StatusPill';
import { ActivityBubble } from './ActivityBubble';
import { ThinkingTrace } from './ThinkingTrace';
import { FilePanel } from './FilePanel';
import { FileViewerWindow } from './FileViewerWindow';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TaskStream } from './TaskStream';

function formatModelLabel(raw: string): string {
  if (raw.includes(':')) {
    const [name, variant] = raw.split(':');
    return `${name.charAt(0).toUpperCase()}${name.slice(1)}-${variant.toUpperCase()}`;
  }
  return raw;
}

function fmtTimestamp(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ── Clickable file chip shown on user messages ───────────────────────────────

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

function QueryFileChip({
  id,
  name,
  isImage,
  threadId,
  onResolveContent,
}: {
  id: string;
  name: string;
  isImage: boolean;
  threadId: string;
  onResolveContent?: (id: string) => Promise<string | null>;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (isImage) return;
    if (content !== null) { setViewerOpen(true); return; }
    setLoading(true);
    try {
      let resolved: string | null = null;
      if (onResolveContent) {
        // Copilot path — read from in-memory cache
        resolved = await onResolveContent(id);
      } else {
        // Main chat path — fetch from backend attachment store
        const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}/attachments/${id}/content`);
        if (res.ok) {
          const data = await res.json() as { content: string };
          resolved = data.content;
        }
      }
      if (resolved !== null) {
        setContent(resolved);
        setViewerOpen(true);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={handleClick}
        disabled={isImage || loading}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
          isImage
            ? 'border-phob-teal/30 bg-phob-teal/8 text-phob-teal cursor-default'
            : loading
              ? 'border-phob-orange/15 bg-phob-white/4 text-phob-steel/30 cursor-wait'
              : 'border-phob-orange/20 bg-phob-white/4 text-phob-steel/50 hover:text-phob-white hover:border-phob-orange/40 cursor-pointer'
        }`}
        title={isImage ? name : `View ${name}`}
      >
        {isImage
          ? <Image className="w-2.5 h-2.5 shrink-0" />
          : <FileText className="w-2.5 h-2.5 shrink-0" />
        }
        <span className="max-w-[120px] truncate">{name}</span>
      </button>
      {viewerOpen && content !== null && (
        <FileViewerWindow
          filename={name}
          language={name.split('.').pop() ?? 'text'}
          code={content}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

interface Props {
  message: Message;
  /** Optional content resolver for attachment chips — used by copilot (cache) vs main chat (fetch) */
  onResolveContent?: (id: string) => Promise<string | null>;
}

export function MessageBubble({ message, onResolveContent }: Props) {
  const modelNames = useAppStore((s) => s.modelNames);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const [copied, setCopied] = useState(false);

  if (!message.content || !message.content.trim()) {
    if (message.activityEvents === undefined && !message.queryFiles?.length) return null;
  }

  if (message.activityEvents !== undefined) {
    return <ActivityBubble message={message} />;
  }

  if (message.role === 'status') {
    return <StatusPill content={message.content} />;
  }

  const isUser        = message.role === 'user';
  const isAssistant   = message.role === 'assistant';
  const isCoordinator = message.role === 'coordinator';
  const isAllmindCoord = isCoordinator && message.coordSource === 'engine';

  const modelLabel = isCoordinator
    ? formatModelLabel(modelNames.coordinator)
    : formatModelLabel(modelNames.engine);

  const outputTokens = isAssistant ? Math.ceil(message.content.length / 4) : 0;
  const thinkTokens  = isAssistant && message.thinking ? Math.ceil(message.thinking.length / 4) : 0;
  const timestamp    = (message as any).createdAt || (message as any).timestamp || '';
  const hasMarkdown  = isAssistant && /[#`*_\[\]|~]/.test(message.content);

  const filePanels = message.filePanels ?? [];
  // Compact grid when ≥2 files; single file stays full-width
  const useGrid = filePanels.length >= 2;

  return (
    <div className={`group relative flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[80%] min-w-0 px-3 py-2 text-sm leading-relaxed break-words ${
          isUser
            ? 'phob-bubble-user bg-phob-orange/8 text-phob-white border border-phob-orange/25'
            : isCoordinator
            ? isAllmindCoord
              ? 'bg-phob-yellow/8 border border-phob-yellow/25 text-phob-yellow'
              : 'bg-phob-teal/6 border border-phob-teal/20 text-phob-teal'
            : 'bg-phob-white/4 text-phob-white/90 border border-phob-white/10'
        }`}
      >
        {isCoordinator && (
          <span className={`text-[10px] font-mono font-medium uppercase tracking-wider block mb-1 ${
            isAllmindCoord ? 'text-phob-yellow/70' : 'text-phob-teal/70'
          }`}>
            {isAllmindCoord ? 'SEREN' : 'SAYON'}
          </span>
        )}

        {/* Message text */}
        {message.content.trim() && (
          hasMarkdown
            ? <MarkdownRenderer content={message.content} />
            : <div className="whitespace-pre-wrap">{message.content}</div>
        )}

        {/* Attached file chips on user messages */}
        {isUser && message.queryFiles && message.queryFiles.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {message.queryFiles.map((f, i) => (
              <QueryFileChip
                key={`${f.id}-${i}`}
                id={f.id}
                name={f.name}
                isImage={f.isImage}
                threadId={activeThreadId}
                onResolveContent={onResolveContent}
              />
            ))}
          </div>
        )}

        {message.thinking && (
          <ThinkingTrace content={message.thinking} modelName={modelLabel} />
        )}

        {/* File panels — compact grid when multiple, full-width when single */}
        {filePanels.length > 0 && (
          useGrid ? (
            <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
              {filePanels.map((fp, i) => (
                <FilePanel
                  key={`${fp.filename}-${i}`}
                  filename={fp.filename}
                  language={fp.language}
                  code={fp.code}
                  compact
                />
              ))}
            </div>
          ) : (
            filePanels.map((fp, i) => (
              <FilePanel
                key={`${fp.filename}-${i}`}
                filename={fp.filename}
                language={fp.language}
                code={fp.code}
              />
            ))
          )
        )}

        {/* Execute / simulate result cards */}
        {isAssistant && message.executeResults && message.executeResults.length > 0 && (
          <TaskStream results={message.executeResults} />
        )}
      </div>

      {/* Copy button */}
      {(isAssistant || isCoordinator) && (
        <button
          onClick={() => {
            navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="absolute -top-5 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-1.5 py-0.5 border border-phob-orange/20 bg-[#080808] text-phob-orange/30 hover:text-phob-orange/60 hover:border-phob-orange/40 text-[9px] font-mono"
          title="Copy message"
        >
          {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
          {copied ? 'COPIED' : 'COPY'}
        </button>
      )}

      {/* Timestamp + token count */}
      <div className="absolute bottom-0.5 right-1 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 select-none">
        {timestamp && (
          <span className="text-[9px] font-mono text-muted-foreground/20">
            {fmtTimestamp(timestamp)}
          </span>
        )}
        {isAssistant && (
          <span className="text-[9px] font-mono text-muted-foreground/20">
            {thinkTokens > 0
              ? `~${thinkTokens}t think · ~${outputTokens}t out`
              : `~${outputTokens}t`
            }
          </span>
        )}
      </div>
    </div>
  );
}
