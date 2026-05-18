import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore, type WorkspaceFile, type MediaFile } from '@/store/useAppStore';
import { FolderOpen, RefreshCw, ChevronRight, Pencil, Download, Trash2, Upload, Image, Film, FileIcon, Music } from 'lucide-react';
import { FileEditorWindow } from '@/components/chat/FileEditorWindow';
import { FileViewerWindow } from '@/components/chat/FileViewerWindow';
import { WorkflowsMenu } from '@/components/chat/WorkflowsMenu';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// Stable empty arrays — prevents new reference on every render when thread has no files
const EMPTY_WORKSPACE: WorkspaceFile[] = [];
const EMPTY_MEDIA: MediaFile[] = [];

// Icon cell dimensions — 2 rows of these set the workspace open height
const CELL_W = 56;        // px — thumbnail/icon square width
const CELL_H = 56;        // px — thumbnail/icon square height
const LABEL_H = 18;       // px — filename label below icon
const GAP = 4;            // px — gap between rows
const PAD = 6;            // px — top+bottom padding inside zone
// Total inner height = 2 rows + 1 gap + padding both sides
const ZONE_INNER_H = CELL_H * 2 + LABEL_H * 2 + GAP + PAD * 2; // ~146px

const LANG_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  typescript:  { label: 'TS',   bg: 'bg-blue-500/20',    text: 'text-blue-400' },
  javascript:  { label: 'JS',   bg: 'bg-yellow-500/20',  text: 'text-yellow-400' },
  python:      { label: 'PY',   bg: 'bg-green-500/20',   text: 'text-green-400' },
  gdscript:    { label: 'GD',   bg: 'bg-teal-500/20',    text: 'text-teal-400' },
  rust:        { label: 'RS',   bg: 'bg-orange-500/20',  text: 'text-orange-400' },
  go:          { label: 'GO',   bg: 'bg-cyan-500/20',    text: 'text-cyan-400' },
  markdown:    { label: 'MD',   bg: 'bg-purple-500/20',  text: 'text-purple-400' },
  json:        { label: 'JSON', bg: 'bg-amber-500/20',   text: 'text-amber-400' },
  shell:       { label: 'SH',   bg: 'bg-lime-500/20',    text: 'text-lime-400' },
  csharp:      { label: 'C#',   bg: 'bg-violet-500/20',  text: 'text-violet-400' },
  text:        { label: 'TXT',  bg: 'bg-muted',          text: 'text-muted-foreground' },
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function writerLabel(by: string): string {
  if (by === 'engine') return 'engine';
  if (by === 'coordinator') return 'coord';
  return 'you';
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function getBadge(language: string) {
  return LANG_BADGE[language] ?? LANG_BADGE.text;
}

function isImageFile(filename: string): boolean {
  return /\.(png|jpg|jpeg|webp|gif)$/i.test(filename);
}

function isVideoFile(filename: string): boolean {
  return /\.(avi|mp4|mov|webm)$/i.test(filename);
}

function isAudioFile(filename: string): boolean {
  return /\.(wav|mp3|flac|ogg|m4a)$/i.test(filename);
}

function thumbnailUrl(threadId: string, filename: string, mtime?: string, dir: string = 'images'): string {
  const cacheBust = mtime ? `&t=${encodeURIComponent(mtime)}` : '';
  return `${ENGINE_URL}/api/workspace/file/${encodeURIComponent(threadId)}/${encodeURIComponent(filename)}?dir=${dir}${cacheBust}`;
}

async function openNative(absolutePath: string): Promise<void> {
  try {
    await fetch(`${ENGINE_URL}/api/workspace/open-native`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath }),
    });
  } catch { /* silent */ }
}

export function WorkspacePanel() {
  const activeThreadId    = useAppStore((s) => s.activeThreadId);
  const isStreaming       = useAppStore((s) => s.streamingThreads.size > 0);
  const imageGenerating   = useAppStore((s) => s.imageGenerating);
  const imageGenStatus    = useAppStore((s) => s.imageGenStatus);
  const setWorkspaceIndex = useAppStore((s) => s.setWorkspaceIndex);
  const setMediaFiles     = useAppStore((s) => s.setMediaFiles);
  const workspaceFiles    = useAppStore((s) => s.workspaceIndex[s.activeThreadId] ?? EMPTY_WORKSPACE);
  const mediaFiles        = useAppStore((s) => s.mediaFiles[s.activeThreadId] ?? EMPTY_MEDIA);

  const [loading, setLoading]             = useState(false);
  const [syncing, setSyncing]             = useState(false);
  const [open, setOpen]                   = useState(true);
  const [deletingFile, setDeletingFile]   = useState<string | null>(null);
  const [deletingMedia, setDeletingMedia] = useState<string | null>(null);
  const [filter, setFilter]               = useState('');
  const [panelDragOver, setPanelDragOver] = useState(false);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const mediaGridRef   = useRef<HTMLDivElement>(null);
  const [mediaColCount, setMediaColCount] = useState(3);

  const [editorState, setEditorState] = useState<{ filename: string; content: string; language: string } | null>(null);
  const [viewerState, setViewerState] = useState<{ filename: string; content: string; language: string } | null>(null);

  // Measure available columns for media grid
  useEffect(() => {
    const el = mediaGridRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const cols = Math.max(1, Math.floor((w - PAD * 2) / (CELL_W + GAP)));
        setMediaColCount(cols);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [open]);

  const fetchIndex = useCallback(async () => {
    if (!activeThreadId) return;
    setLoading(true);
    setSyncing(true);
    try {
      const [wsRes, mediaRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`),
        fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace-media`),
      ]);
      if (wsRes.ok) {
        const data = await wsRes.json();
        setWorkspaceIndex(activeThreadId, data.files ?? []);
      }
      if (mediaRes.ok) {
        const data = await mediaRes.json();
        const files = (data.files ?? []).map((f: { filename: string; absolutePath: string; createdAt: string; mediaType?: string; dir?: string }) => ({
          ...f,
          threadId: activeThreadId,
          mediaType: (f.mediaType ?? 'image') as 'image' | 'video' | 'audio',
          dir: f.dir ?? 'images',
        }));
        setMediaFiles(activeThreadId, files);
      }
    } catch { /* backend not ready */ }
    finally {
      setLoading(false);
      // Keep syncing dot lit for 1s then fade — gives a visible pulse on every poll
      setTimeout(() => setSyncing(false), 1000);
    }
  }, [activeThreadId, setWorkspaceIndex, setMediaFiles]);

  const uploadFiles = useCallback(async (fileList: FileList) => {
    if (!activeThreadId || !fileList.length) return;
    for (const f of Array.from(fileList)) {
      if (isImageFile(f.name)) {
        // Upload image to the images subdirectory via the upload-media route
        try {
          const arrayBuf = await f.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          // btoa(String.fromCharCode(...bytes)) stack-overflows on files > ~500KB.
          // Chunk it instead.
          let binary = '';
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          const base64 = btoa(binary);
          const res = await fetch(`${ENGINE_URL}/api/workspace/upload-media/${activeThreadId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: f.name, data: base64 }),
          });
          if (res.ok) {
            const { absolutePath } = await res.json();
            useAppStore.getState().addMediaFile(activeThreadId, {
              filename: f.name,
              absolutePath,
              threadId: activeThreadId,
              createdAt: new Date().toISOString(),
            });
          }
        } catch { /* skip */ }
      } else {
        // Text/code file — write to workspace text index
        try {
          const content = await f.text();
          await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: f.name, content }),
          });
        } catch { /* skip */ }
      }
    }
    fetchIndex();
  }, [activeThreadId, fetchIndex]);

  useEffect(() => { fetchIndex(); setFilter(''); }, [activeThreadId, fetchIndex]);

  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(fetchIndex, 800);
      return () => clearTimeout(t);
    }
  }, [isStreaming, fetchIndex]);

  // Live poll — pick up manual file changes (add/delete in Explorer) within ~3s
  useEffect(() => {
    if (!open || isStreaming || imageGenerating) return;
    const id = setInterval(fetchIndex, 3000);
    return () => clearInterval(id);
  }, [open, isStreaming, imageGenerating, fetchIndex]);

  const closeCreatePanels       = useAppStore((s) => s.closeCreatePanels);
  const toggleMonacoPanel       = useAppStore((s) => s.toggleMonacoPanel);
  const toggleJoditPanel   = useAppStore((s) => s.toggleJoditPanel);
  const toggleStirlingPanel     = useAppStore((s) => s.toggleStirlingPanel);
  const setMonacoOpenRequest    = useAppStore((s) => s.setMonacoOpenRequest);
  const setJoditOpenRequest = useAppStore((s) => s.setJoditOpenRequest);

  // Extension → panel routing
  function routeFileToPanel(filename: string): 'monaco' | 'jodit' | 'stirling' | 'viewer' {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    // Code and plain-text files → Monaco
    if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'md', 'json', 'css',
         'sh', 'gd', 'cs', 'lua', 'yaml', 'yml', 'toml', 'txt'].includes(ext)) return 'monaco';
    // Document formats → Jodit + pandoc-wasm
    // .html is included here — it's used as the workspace sidecar format for Jodit saves
    if (['docx', 'doc', 'odt', 'rtf', 'html', 'htm',
         'pptx', 'ppt', 'odp', 'xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'jodit';
    // PDF → Stirling PDF
    if (ext === 'pdf') return 'stirling';
    return 'viewer';
  }

  const openViewer = async (f: WorkspaceFile) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(f.filename)}`);
      if (!res.ok) return;
      const { content } = await res.json();
      const target = routeFileToPanel(f.filename);
      closeCreatePanels();
      if (target === 'monaco') {
        setMonacoOpenRequest({ filename: f.filename, content, language: f.language });
        toggleMonacoPanel();
      } else if (target === 'jodit') {
        setJoditOpenRequest({ filename: f.filename, content });
        toggleJoditPanel();
      } else if (target === 'stirling') {
        // Stirling is a web UI — just open the panel; the PDF upload is handled by the user inside Stirling
        toggleStirlingPanel();
      } else {
        setViewerState({ filename: f.filename, content, language: f.language });
      }
    } catch { /* silent */ }
  };

  const openEditor = async (f: WorkspaceFile) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(f.filename)}`);
      if (res.ok) { const { content } = await res.json(); setEditorState({ filename: f.filename, content, language: f.language }); }
    } catch { /* silent */ }
  };

  const downloadFile = async (f: WorkspaceFile) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(f.filename)}`);
      if (res.ok) {
        const { content } = await res.json();
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = f.filename; a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* silent */ }
  };

  const deleteTextFile = async (filename: string) => {
    try {
      await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      setWorkspaceIndex(activeThreadId, (workspaceFiles).filter((f) => f.filename !== filename));
      setDeletingFile(null);
    } catch { /* silent */ }
  };

  const deleteMediaFile = async (file: MediaFile) => {
    try {
      const mediaSubdir = file.dir ?? (
        isAudioFile(file.filename) ? 'audio/tts'
        : isVideoFile(file.filename) ? 'videos'
        : 'images'
      );
      await fetch(
        `${ENGINE_URL}/api/threads/${activeThreadId}/workspace/${encodeURIComponent(mediaSubdir + '/' + file.filename)}`,
        { method: 'DELETE' }
      );
      useAppStore.setState((s) => ({
        mediaFiles: {
          ...s.mediaFiles,
          [activeThreadId]: (s.mediaFiles[activeThreadId] ?? EMPTY_MEDIA).filter((f) => f.filename !== file.filename),
        },
      }));
      setDeletingMedia(null);
    } catch { /* silent */ }
  };

  if (!activeThreadId) return null;

  const files        = workspaceFiles;
  const visibleFiles = filter.trim() ? files.filter((f) => f.filename.toLowerCase().includes(filter.toLowerCase())) : files;

  return (
    <>
      <div className="border-t border-border bg-background/80"
        onDragOver={(e) => { e.preventDefault(); setPanelDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPanelDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setPanelDragOver(false); if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files); }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 hover:text-foreground transition-colors"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
            <FolderOpen className="w-3 h-3" />
            <span className="font-semibold tracking-wide">WORKSPACE</span>
            {(files.length > 0 || mediaFiles.length > 0) && (
              <span className="ml-1 bg-muted rounded px-1.5 py-0.5 text-[10px]">
                {files.length + mediaFiles.length}
              </span>
            )}
            {/* Sync pulse dot — glows for 1s on every poll cycle */}
            <span
              className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${
                syncing
                  ? 'bg-phobos-green/80 shadow-[0_0_6px_2px_rgba(74,222,128,0.5)]'
                  : 'bg-phobos-green/10'
              }`}
            />
          </button>
          {files.length > 4 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              className="flex-1 bg-transparent text-[10px] font-mono text-foreground/60 placeholder:text-muted-foreground/20 focus:outline-none border-b border-border/20 focus:border-phobos-green/30 pb-0.5 mx-2 transition-all"
            />
          )}
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => fileInputRef.current?.click()} className="p-0.5 hover:text-foreground transition-colors" title="Upload text files">
              <Upload className="w-3 h-3" />
            </button>
            <button onClick={fetchIndex} className="p-0.5 hover:text-foreground transition-colors" title="Refresh">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden"
            onChange={(e) => { if (e.target.files) { uploadFiles(e.target.files); e.target.value = ''; } }} />
        </div>

        {/* Three-zone horizontal split — fixed height, single unified drop target */}
        {open && (
          <div className="relative border-t border-border/50">
            {/* Unified drag overlay — appears over both zones simultaneously */}
            {panelDragOver && (
              <div className="absolute inset-0 z-20 pointer-events-none border-2 border-phobos-green/40 bg-phobos-green/5 rounded-sm flex items-center justify-center gap-3">
                <FolderOpen className="w-4 h-4 text-phobos-green/60" />
                <span className="text-[10px] font-mono text-phobos-green/60 tracking-wider">DROP TO SORT</span>
                <Image className="w-4 h-4 text-phobos-green/60" />
              </div>
            )}
            <div className="flex" style={{ height: ZONE_INNER_H }}>

            {/* TEXT zone */}
            <div
              className="flex-1 min-w-0 overflow-y-auto scrollbar-thin border-r border-border/30"
            >
              {!loading && files.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-1 select-none">
                  <FolderOpen className="w-4 h-4 text-muted-foreground/15" />
                  <span className="text-[9px] font-mono text-muted-foreground/20">No docs yet</span>
                </div>
              )}
              <div>
                {visibleFiles.map((f) => {
                  const badge = getBadge(f.language);
                  return (
                    <div key={f.filename} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors">
                      <span className={`mt-0.5 shrink-0 text-[9px] font-mono font-semibold px-1 py-0.5 rounded ${badge.bg} ${badge.text}`}>{badge.label}</span>
                      <div className="flex-1 min-w-0">
                        <button onClick={() => openViewer(f)} className="text-[11px] font-mono text-foreground truncate hover:text-primary transition-colors hover:underline underline-offset-2 text-left block w-full" title={`View ${f.filename}`}>
                          {f.filename}
                        </button>
                        {f.note && <div className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">{f.note}</div>}
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/60 font-mono">
                          <span>{sizeLabel(f.size_bytes)}</span><span>·</span>
                          <span>{writerLabel(f.last_written_by)}</span><span>·</span>
                          <span>{relTime(f.updated_at)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                        {deletingFile === f.filename ? (
                          <div className="flex items-center gap-1 text-[10px] font-mono">
                            <span className="text-destructive">Delete?</span>
                            <button onClick={() => deleteTextFile(f.filename)} className="px-1.5 py-0.5 rounded bg-destructive/20 text-destructive hover:bg-destructive/30">Yes</button>
                            <button onClick={() => setDeletingFile(null)} className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground">No</button>
                          </div>
                        ) : (
                          <>
                            <button onClick={() => openEditor(f)} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Edit"><Pencil className="w-3 h-3" /></button>
                            <button onClick={() => downloadFile(f)} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Download"><Download className="w-3 h-3" /></button>
                            <button onClick={() => setDeletingFile(f.filename)} className="p-0.5 text-muted-foreground hover:text-destructive transition-colors" title="Delete"><Trash2 className="w-3 h-3" /></button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Workflows picker — replaces old render preview zone */}
            {activeThreadId && (
              <WorkflowsMenu threadId={activeThreadId} />
            )}

            {/* MEDIA files icon grid */}
            <div
              ref={mediaGridRef}
              className="flex-1 min-w-0 overflow-y-auto scrollbar-thin"
            >
              {mediaFiles.length === 0 && !imageGenerating ? (
                <div className="flex flex-col items-center justify-center h-full gap-1 select-none">
                  <Image className="w-4 h-4 text-muted-foreground/15" />
                  <span className="text-[9px] font-mono text-muted-foreground/20">No media yet</span>
                </div>
              ) : (
                <div
                  className="grid"
                  style={{
                    padding: PAD,
                    gap: GAP,
                    gridTemplateColumns: `repeat(${mediaColCount}, ${CELL_W}px)`,
                  }}
                >
                  {mediaFiles.map((mf) => (
                    <MediaCell
                      key={mf.filename}
                      file={mf}
                      threadId={activeThreadId}
                      isDeleting={deletingMedia === mf.filename}
                      onDelete={() => setDeletingMedia(mf.filename)}
                      onDeleteConfirm={() => deleteMediaFile(mf)}
                      onDeleteCancel={() => setDeletingMedia(null)}
                      onOpen={() => openNative(mf.absolutePath)}
                    />
                  ))}
                </div>
              )}
            </div>

          </div>
          </div>
        )}
      </div>

      {viewerState && (
        <FileViewerWindow filename={viewerState.filename} language={viewerState.language} code={viewerState.content} onClose={() => setViewerState(null)} />
      )}
      {editorState && (
        <FileEditorWindow threadId={activeThreadId} filename={editorState.filename} initialContent={editorState.content} language={editorState.language} onClose={() => setEditorState(null)} onSaved={fetchIndex} />
      )}
    </>
  );
}

// ── MediaCell ──────────────────────────────────────────────────────────────
interface MediaCellProps {
  file: MediaFile;
  threadId: string;
  isDeleting: boolean;
  onDelete: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  onOpen: () => void;
}

function MediaCell({ file, threadId, isDeleting, onDelete, onDeleteConfirm, onDeleteCancel, onOpen }: MediaCellProps) {
  const isImg = isImageFile(file.filename);
  const isVid = isVideoFile(file.filename);
  const isAud = isAudioFile(file.filename);
  const dir   = file.dir ?? (isVid ? 'videos' : isAud ? 'audio/tts' : 'images');
  return (
    <div className="group relative flex flex-col items-center" style={{ width: CELL_W }}>
      <div
        className={`rounded border overflow-hidden flex items-center justify-center hover:border-phobos-green/30 transition-colors cursor-pointer ${
          isVid ? 'border-phobos-amber/20 bg-phobos-amber/5'
          : isAud ? 'border-cyan-400/20 bg-cyan-400/5'
          : 'border-border/20 bg-muted/20'
        }`}
        style={{ width: CELL_W, height: CELL_H }}
        onClick={!isDeleting ? onOpen : undefined}
        title={file.filename}
      >
        {isImg ? (
          <img src={thumbnailUrl(threadId, file.filename, file.createdAt, dir)} alt={file.filename} className="w-full h-full object-cover" loading="lazy" />
        ) : isVid ? (
          <Film className="w-5 h-5 text-phobos-amber/50" />
        ) : isAud ? (
          <Music className="w-5 h-5 text-cyan-400/50" />
        ) : (
          <FileIcon className="w-5 h-5 text-muted-foreground/40" />
        )}
      </div>
      <span
        className="text-[8px] font-mono text-muted-foreground/50 truncate w-full text-center mt-0.5 leading-tight px-0.5"
        style={{ maxWidth: CELL_W }}
      >
        {file.filename}
      </span>

      {isDeleting ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/90 rounded gap-1 z-10">
          <span className="text-[8px] font-mono text-destructive">Delete?</span>
          <div className="flex gap-1">
            <button onClick={(e) => { e.stopPropagation(); onDeleteConfirm(); }} className="px-1.5 py-0.5 rounded bg-destructive/20 text-destructive text-[8px] font-mono hover:bg-destructive/30">Yes</button>
            <button onClick={(e) => { e.stopPropagation(); onDeleteCancel(); }} className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[8px] font-mono hover:text-foreground">No</button>
          </div>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded bg-destructive/70 text-white hover:bg-destructive"
          title="Delete"
        >
          <Trash2 className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}