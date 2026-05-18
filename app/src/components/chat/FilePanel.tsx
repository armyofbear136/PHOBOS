import { useState, useRef, useEffect } from 'react';
import hljs from 'highlight.js';
import { Copy, Check, Eye, RefreshCw, Check as CheckIcon, FilePlus, FolderInput } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { FileViewerWindow } from './FileViewerWindow';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Props {
  filename: string;
  language: string;
  code: string;
  /** Compact mode: narrow vertical card with controls only, no code preview. Used in multi-file grids. */
  compact?: boolean;
}

export function FilePanel({ filename, language, code, compact = false }: Props) {
  const [copied, setCopied]     = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied]   = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  // Capture isNewFile at apply-click time so the confirmation label is accurate
  // even after the workspace index refreshes and flips isNewFile to false.
  const [wasNewFile, setWasNewFile] = useState(false);

  const activeThreadId    = useAppStore((s) => s.activeThreadId);
  // IMPORTANT: do not use `?? []` inline — creates a new array reference every render,
  // causing Zustand's useSyncExternalStore to loop infinitely on empty threads.
  const workspaceFiles    = useAppStore((s) => s.workspaceIndex[s.activeThreadId]);
  const setWorkspaceIndex = useAppStore((s) => s.setWorkspaceIndex);

  // Reacts immediately when WorkspacePanel deletes the file (store write is synchronous).
  const isNewFile = !workspaceFiles?.some((f) => f.filename === filename);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleApply = async () => {
    if (!activeThreadId || applying) return;
    setWasNewFile(isNewFile); // snapshot before index refresh
    setApplying(true);
    try {
      const res = await fetch(
        `${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(filename)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: code }),
        }
      );
      if (res.ok) {
        setApplied(true);
        setTimeout(() => setApplied(false), 3000);
        // Refresh workspace index — flips "New File" → "Overwrite" on next render.
        try {
          const idxRes = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`);
          if (idxRes.ok) {
            const data = await idxRes.json();
            setWorkspaceIndex(activeThreadId, data.files ?? []);
          }
        } catch { /* non-fatal */ }
      }
    } catch {
      // silent fail — user can retry
    } finally {
      setApplying(false);
    }
  };

  const lineCount = code.split('\n').length;

    // ── Full card ─────────────────────────────────────────────────────────────

  const applyButton = (() => {
    if (applied) {
      return {
        icon: <CheckIcon className="w-3 h-3 text-green-400" />,
        label: wasNewFile ? 'File saved' : 'File overwritten',
        cls: 'flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded text-green-400/80 transition-colors disabled:opacity-40',
        title: 'Done',
      };
    }
    if (applying) {
      return {
        icon: <RefreshCw className="w-3 h-3 animate-spin" />,
        label: 'Saving…',
        cls: 'flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded text-muted-foreground transition-colors disabled:opacity-40',
        title: 'Writing file…',
      };
    }
    if (isNewFile) {
      return {
        icon: <FilePlus className="w-3 h-3" />,
        label: 'Save to workspace',
        cls: 'flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded hover:bg-primary/20 text-primary transition-colors disabled:opacity-40',
        title: `Create ${filename} in workspace`,
      };
    }
    return {
      icon: <FolderInput className="w-3 h-3" />,
      label: 'Overwrite file',
      cls: 'flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded hover:bg-amber-500/10 text-amber-400/80 hover:text-amber-400 transition-colors disabled:opacity-40',
      title: `Overwrite ${filename} in workspace`,
    };
  })();


  // ── Compact card — used in multi-file grid ───────────────────────────────
  if (compact) {
    return (
      <>
        <div className="border border-border rounded-md overflow-hidden flex flex-col bg-black/40 hover:border-border/70 transition-colors">
          {/* Filename — clickable to open viewer */}
          <button
            onClick={() => setViewerOpen(true)}
            className="flex flex-col items-start px-2 pt-2 pb-1 gap-0.5 text-left group flex-1 min-h-0"
            title={`View ${filename}`}
          >
            <span className="text-[10px] font-mono text-primary/70 group-hover:text-primary transition-colors leading-tight break-all line-clamp-3">
              {filename}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/30">{lineCount}L</span>
          </button>

          {/* Controls row */}
          <div className="flex items-center justify-between px-1.5 py-1 border-t border-border/50 bg-muted/20">
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Copy"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={handleApply}
              disabled={applying || !activeThreadId}
              className={applyButton.cls}
              title={applyButton.title}
            >
              {applyButton.icon}
            </button>
          </div>
        </div>

        {viewerOpen && (
          <FileViewerWindow
            filename={filename}
            language={language}
            code={code}
            isNewFile={isNewFile}
            onClose={() => setViewerOpen(false)}
            onApply={handleApply}
            applied={applied}
            applying={applying}
          />
        )}
      </>
    );
  }



  return (
    <>
      <div className="mt-2 border border-border rounded-md overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
          <button
            onClick={() => setViewerOpen(true)}
            className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-primary transition-colors group"
            title={`View ${filename}`}
          >
            <Eye className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="group-hover:underline underline-offset-2">{filename}</span>
            <span className="text-[10px] text-muted-foreground/40">{lineCount}L</span>
          </button>

          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Copy"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={handleApply}
              disabled={applying || !activeThreadId}
              className={applyButton.cls}
              title={applyButton.title}
            >
              {applyButton.icon}
              {applyButton.label}
            </button>
          </div>
        </div>

        <CodePreview code={code} language={language} onViewAll={() => setViewerOpen(true)} />
      </div>

      {viewerOpen && (
        <FileViewerWindow
          filename={filename}
          language={language}
          code={code}
          isNewFile={isNewFile}
          onClose={() => setViewerOpen(false)}
          onApply={handleApply}
          applied={applied}
          applying={applying}
        />
      )}
    </>
  );
}

function CodePreview({ code, language, onViewAll }: { code: string; language?: string; onViewAll: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const lines = code.split('\n');
  const PREVIEW_LINES = 20;
  const truncated = !expanded && lines.length > PREVIEW_LINES;
  const displayCode = truncated ? lines.slice(0, PREVIEW_LINES).join('\n') : code;

  useEffect(() => {
    if (!codeRef.current) return;
    // Reset so hljs doesn't skip already-highlighted nodes
    codeRef.current.removeAttribute('data-highlighted');
    if (language && hljs.getLanguage(language)) {
      codeRef.current.className = `hljs language-${language} text-[11px] leading-relaxed block p-3`;
    } else {
      codeRef.current.className = 'hljs text-[11px] leading-relaxed block p-3';
    }
    hljs.highlightElement(codeRef.current);
  }, [displayCode, language]);

  return (
    <div className="relative bg-black/60 overflow-x-auto scrollbar-thin">
      <pre className="p-0 m-0">
        <code ref={codeRef} className={`hljs ${language ? `language-${language}` : ''} text-[11px] leading-relaxed block p-3`}>
          {displayCode}
        </code>
      </pre>
      {truncated && (
        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-center pb-1">
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] font-mono text-primary hover:text-primary/80 transition-colors px-2 py-0.5 rounded bg-card/80 border border-border/50"
          >
            + {lines.length - PREVIEW_LINES} more lines — click to expand or{' '}
            <button onClick={(e) => { e.stopPropagation(); onViewAll(); }} className="underline underline-offset-1">
              open viewer
            </button>
          </button>
        </div>
      )}
    </div>
  );
}
