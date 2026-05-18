import { useState, useRef, useCallback, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { File, X, Save, RotateCcw } from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface Props {
  threadId?: string;
  filename: string;
  initialContent: string;
  language: string;
  onClose: () => void;
  onSaved?: () => void;
  onSaveContent?: (content: string) => void;
}

export function FileEditorWindow({ threadId, filename, initialContent, language, onClose, onSaved, onSaveContent }: Props) {
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Position & size
  const [pos, setPos] = useState({ x: Math.max(0, (window.innerWidth - 700) / 2), y: Math.max(0, (window.innerHeight - 500) / 2) });
  const [size, setSize] = useState({ w: 700, h: 500 });

  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = content !== savedContent;

  const lineCount = content.split('\n').length;
  const charCount = content.length;

  // Drag handlers
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.startPosX + (ev.clientX - dragRef.current.startX),
        y: Math.max(0, dragRef.current.startPosY + (ev.clientY - dragRef.current.startY)),
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

  // Resize handlers
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const maxW = window.innerWidth * 0.9;
      const maxH = window.innerHeight * 0.9;
      setSize({
        w: Math.max(300, Math.min(maxW, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX))),
        h: Math.max(200, Math.min(maxH, resizeRef.current.startH + (ev.clientY - resizeRef.current.startY))),
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

  // Tab key inserts spaces
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = content.substring(0, start) + '  ' + content.substring(end);
      setContent(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    // Cmd/Ctrl+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  };

  // Save
  const handleSave = async () => {
    setSaving(true);
    try {
      if (onSaveContent) {
        onSaveContent(content);
      } else if (threadId) {
        await fetch(
          `${ENGINE_URL}/api/threads/${threadId}/workspace/${encodeURIComponent(filename)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
          }
        );
      }
      setSavedContent(content);
      setSavedFlash(true);
      onSaved?.();
      setTimeout(() => setSavedFlash(false), 2000);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  // Close logic
  const handleClose = () => {
    if (isDirty) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  const isDirectives = /directive/i.test(filename);
  return createPortal(
    <div
      className={`fixed z-50 flex flex-col border border-border rounded-md bg-background shadow-2xl overflow-hidden ${isDirectives ? 'phobos-directives-panel' : ''}`}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Title bar — draggable */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border cursor-move select-none shrink-0"
        onMouseDown={onDragStart}
      >
        <File className="w-3 h-3 text-muted-foreground" />
        <span className="text-[11px] font-mono text-foreground truncate">{filename}</span>
        {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
        <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0 ml-auto mr-2">{language}</span>
        <button onClick={handleClose} className="p-0.5 hover:text-destructive transition-colors text-muted-foreground">
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 bg-card/50 border-b border-border/50 shrink-0">
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-30 transition-colors"
        >
          <Save className="w-3 h-3" />
          {savedFlash ? 'Saved ✓' : 'Save'}
        </button>
        <button
          onClick={() => setContent(savedContent)}
          disabled={!isDirty}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Revert
        </button>
        <span className="text-[10px] font-mono text-muted-foreground/40 ml-auto">
          {lineCount} lines · {charCount.toLocaleString()} chars
        </span>
      </div>

      {/* Confirm close banner */}
      {confirmClose && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-400/10 border-b border-amber-400/30 text-[11px] font-mono text-amber-300 shrink-0">
          Unsaved changes — close anyway?
          <button onClick={onClose} className="px-2 py-0.5 rounded bg-amber-400/20 hover:bg-amber-400/30 text-amber-300">Yes</button>
          <button onClick={() => setConfirmClose(false)} className="px-2 py-0.5 rounded bg-muted hover:bg-accent text-muted-foreground">Cancel</button>
        </div>
      )}

      {/* Editor */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 w-full bg-transparent text-[12px] font-mono text-foreground p-3 resize-none focus:outline-none leading-relaxed"
        spellCheck={false}
      />

      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
        onMouseDown={onResizeStart}
      >
        <svg className="w-3 h-3 text-muted-foreground/30 absolute bottom-0.5 right-0.5" viewBox="0 0 12 12">
          <path d="M11 1v10H1" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 5v6H5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    </div>,
    document.body
  );
}
