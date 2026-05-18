import { useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, X, Copy, Check, RefreshCw, Check as CheckIcon, FilePlus, FolderInput } from 'lucide-react';

interface Props {
  filename: string;
  language: string;
  code: string;
  onClose: () => void;
  onApply?: () => Promise<void>;
  applied?: boolean;
  applying?: boolean;
  isNewFile?: boolean;
}

/**
 * Read-only floating file viewer.
 * Shows staged engine output with line numbers and an Apply button.
 * Also used by WorkspacePanel for viewing live workspace files.
 */
export function FileViewerWindow({
  filename, language, code, onClose, onApply, applied, applying, isNewFile = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState({
    x: Math.max(0, (window.innerWidth - 720) / 2),
    y: Math.max(0, (window.innerHeight - 520) / 2),
  });
  const [size, setSize] = useState({ w: 720, h: 520 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null);

  const lineCount = code.split('\n').length;
  const charCount = code.length;

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.px + (ev.clientX - dragRef.current.sx),
        y: Math.max(0, dragRef.current.py + (ev.clientY - dragRef.current.sy)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      setSize({
        w: Math.max(320, Math.min(window.innerWidth * 0.95, resizeRef.current.sw + (ev.clientX - resizeRef.current.sx))),
        h: Math.max(200, Math.min(window.innerHeight * 0.95, resizeRef.current.sh + (ev.clientY - resizeRef.current.sy))),
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [size]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Line-numbered display
  const lines = code.split('\n');
  const lineNumWidth = String(lineCount).length;

  return createPortal(
    <div
      className="fixed z-50 flex flex-col border border-border rounded-md bg-background shadow-2xl overflow-hidden"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border cursor-move select-none shrink-0"
        onMouseDown={onDragStart}
      >
        <File className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-mono text-foreground truncate flex-1">{filename}</span>
        <span className="text-[10px] font-mono text-muted-foreground/40 shrink-0">{language}</span>
        <button onClick={onClose} className="p-0.5 hover:text-destructive transition-colors text-muted-foreground ml-1">
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 bg-card/50 border-b border-border/50 shrink-0">
        <span className="text-[10px] font-mono text-muted-foreground/50 bg-warning/10 border border-warning/20 text-warning/70 px-1.5 py-0.5 rounded">
          read-only
        </span>

        {onApply && (
          <button
            onClick={onApply}
            disabled={applying}
            className={
              applied   ? 'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded text-green-400/80 disabled:opacity-40 transition-colors' :
              applying  ? 'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded text-muted-foreground disabled:opacity-40 transition-colors' :
              isNewFile ? 'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-40 transition-colors'
                        : 'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-amber-500/10 text-amber-400/80 hover:bg-amber-500/20 hover:text-amber-400 disabled:opacity-40 transition-colors'
            }
          >
            {applied
              ? <><CheckIcon className="w-3 h-3" /> {isNewFile ? 'Saved to workspace' : 'File overwritten'}</>
              : applying
              ? <><RefreshCw className="w-3 h-3 animate-spin" /> Saving…</>
              : isNewFile
              ? <><FilePlus className="w-3 h-3" /> Save to workspace</>
              : <><FolderInput className="w-3 h-3" /> Overwrite file</>
            }
          </button>
        )}

        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-muted text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          {copied ? <><Check className="w-3 h-3 text-success" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
        </button>

        <span className="text-[10px] font-mono text-muted-foreground/40">
          {lineCount}L · {charCount.toLocaleString()}ch
        </span>
      </div>

      {/* Content — line-numbered, read-only */}
      <div className="flex-1 overflow-auto scrollbar-thin bg-card">
        <table className="w-full border-collapse text-[11px] font-mono leading-relaxed">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-muted/30 transition-colors">
                <td
                  className="select-none text-right pr-3 pl-2 py-0 text-muted-foreground/30 border-r border-border/30 w-px whitespace-nowrap"
                  style={{ minWidth: `${lineNumWidth + 2}ch` }}
                >
                  {i + 1}
                </td>
                <td className="pl-3 pr-2 py-0 text-foreground/90 whitespace-pre">
                  {line || '\u00A0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-30 hover:opacity-70"
        onMouseDown={onResizeStart}
      >
        <svg className="w-3 h-3 absolute bottom-0.5 right-0.5" viewBox="0 0 12 12">
          <path d="M11 1v10H1" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 5v6H5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    </div>,
    document.body
  );
}
