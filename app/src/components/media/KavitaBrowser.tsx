/**
 * KavitaBrowser.tsx — PHOBOS Document & Reading Library Browser
 *
 * 780px wide floating widget. Three-pane architecture:
 *   Header bar (drag handle, status, controls)
 *   Breadcrumb nav (library → folder → ...)
 *   Content pane (libraries | series grid | file browser | in-progress)
 *
 * Series/file routing:
 *   manga/comics/images (format 0,1,4) → KavitaPlayer (Kavita reader)
 *   books/light novels  (format 3,5)   → KavitaPlayer (Kavita reader)
 *   PDF                                → native browser tab (inline viewer)
 *   .md / .txt / .json / code          → Monaco panel
 *   .docx / .doc / .html / .epub text  → Jodit panel
 *   raw folder (loose images)          → file browser → Kavita reader
 *
 * API:
 *   /api/kavita/libraries     GET  — library list
 *   /api/kavita/series/list   POST — series by libraryId
 *   /api/kavita/browse        GET  — filesystem listing inside library
 *   /api/kavita/file-content  GET  — read text file for editor routing
 *   /api/kavita/in-progress   GET  — on-deck series
 */

import {
  useState, useEffect, useRef, useCallback,
  type MouseEvent as RMouseEvent,
} from 'react';
import {
  BookMarked, ChevronRight, X, RefreshCw, Library, BookOpen,
  Loader2, Folder, FileText, FileCode, File, FileImage,
  ArrowLeft, ExternalLink, Grid, List,
} from 'lucide-react';
import KavitaPlayer from '@/components/media/KavitaPlayer';
import { useAppStore } from '@/store/useAppStore';

const ENGINE       = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const KAVITA_ORIGIN = 'http://localhost:18000';
const STIRLING_URL  = 'http://localhost:16346';

// ── Types ──────────────────────────────────────────────────────────────────────

interface KavitaLibrary {
  id:           number;
  name:         string;
  type:         number;
  folders:      string[];
  seriesCount?: number;
  series?:      number;
}

interface KavitaSeries {
  id:               number;
  name:             string;
  localizedName?:   string;
  libraryId:        number;
  pages:            number;
  pagesRead?:       number;
  format?:          number;
  hasBeenRead?:     boolean;
  latestChapterAdded?: string;
}

interface BrowseEntry {
  name:  string;
  isDir: boolean;
  path:  string;
  ext:   string;
}

interface KavitaInProgress {
  seriesId:   number;
  seriesName: string;
  libraryId:  number;
  pagesRead:  number;
  pages:      number;
  chapterId?: number;
}

interface CtxItem { label: string; action: () => void; danger?: boolean }
interface CtxMenu  { x: number; y: number; items: CtxItem[] }

type DrawerTab = 'libraries' | 'reading';
type ViewMode  = 'grid' | 'list';

// ── Design tokens ──────────────────────────────────────────────────────────────

const M: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const cyan    = '#22d3ee';
const amber   = '#f59e0b';
const green   = '#4ade80';
const rose    = '#f43f5e';
const dim     = 'hsl(var(--muted-foreground))';
const dimMid  = '#5a6a80';
const bg      = 'hsl(var(--background))';
const bg2     = 'hsl(var(--card))';
const bg3     = 'hsl(var(--secondary))';
const border  = 'hsl(var(--border))';
const border2 = '#222d40';
const text    = '#b8c4d4';
const textBrt = '#dde6f4';
const textDim = '#3a4558';

// ── File type classification ───────────────────────────────────────────────────

const MONACO_EXTS  = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.ts', '.js', '.py', '.xml', '.html', '.htm']);
const JODIT_EXTS   = new Set(['.docx', '.doc', '.rtf', '.odt']);
const PDF_EXTS     = new Set(['.pdf']);
const IMAGE_EXTS   = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);
const ARCHIVE_EXTS = new Set(['.cbz', '.cbr', '.zip', '.rar', '.epub']);

function classifyExt(ext: string): 'monaco' | 'jodit' | 'pdf' | 'image' | 'archive' | 'kavita' | 'unknown' {
  if (MONACO_EXTS.has(ext))  return 'monaco';
  if (JODIT_EXTS.has(ext))   return 'jodit';
  if (PDF_EXTS.has(ext))     return 'pdf';
  if (IMAGE_EXTS.has(ext))   return 'image';
  if (ARCHIVE_EXTS.has(ext)) return 'kavita';
  return 'unknown';
}

// Kavita format codes: 0=Image, 1=Archive(CBZ/CBR), 2=UnknownArchive, 3=Book(EPUB/PDF), 4=Images, 5=Epub
function seriesOpensInKavita(format?: number): boolean {
  // All formats open in Kavita reader — routing happens at file level for loose docs
  return true;
}

const LIB_TYPE: Record<number, string> = {
  0: 'MANGA', 1: 'COMICS', 3: 'BOOKS', 4: 'IMAGES', 5: 'LIGHT NOVELS',
};

// ── API helpers ────────────────────────────────────────────────────────────────

async function kget<T>(path: string): Promise<T> {
  const r = await fetch(`${ENGINE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  const ct = r.headers.get('content-type') ?? '';
  if (r.status === 204 || !ct.includes('json')) return [] as unknown as T;
  return r.json() as Promise<T>;
}

async function kpost(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.status === 204 ? null : r.json();
}

// ── Context menu ───────────────────────────────────────────────────────────────

function ContextMenu({ menu, onClose }: { menu: CtxMenu; onClose: () => void }) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener('click', h, { once: true });
    window.addEventListener('contextmenu', h, { once: true });
    return () => {
      window.removeEventListener('click', h);
      window.removeEventListener('contextmenu', h);
    };
  }, [onClose]);

  return (
    <div style={{
      position: 'fixed', left: menu.x, top: menu.y, zIndex: 99999,
      background: bg2, border: `1px solid ${border2}`, borderRadius: 3,
      boxShadow: '0 12px 40px rgba(0,0,0,.9)', minWidth: 200, ...M, fontSize: 11,
    }}>
      {menu.items.map((item, i) => (
        <div key={i}
          onClick={e => { e.stopPropagation(); item.action(); onClose(); }}
          style={{
            padding: '8px 14px', cursor: 'pointer',
            borderBottom: i < menu.items.length - 1 ? `1px solid ${border}` : 'none',
            color: item.danger ? rose : text, transition: 'background .1s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = bg3)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ── Cover image ────────────────────────────────────────────────────────────────

function SeriesCover({ seriesId, size = 64 }: { seriesId: number; size?: number }) {
  const [err, setErr] = useState(false);
  const src = `${KAVITA_ORIGIN}/api/image/series-cover?seriesId=${seriesId}&apiKey=`;

  if (err) {
    return (
      <div style={{
        width: size, height: size * 1.4, flexShrink: 0, borderRadius: 2,
        background: bg3, border: `1px solid ${border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <BookOpen style={{ width: size * 0.4, height: size * 0.4, color: textDim }} />
      </div>
    );
  }
  return (
    <div style={{
      width: size, height: size * 1.4, flexShrink: 0, borderRadius: 2,
      overflow: 'hidden', border: `1px solid ${border}`, background: bg3,
    }}>
      <img src={src} alt="" onError={() => setErr(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  );
}

// ── File icon ─────────────────────────────────────────────────────────────────

function FileIcon({ ext, isDir, size = 14 }: { ext: string; isDir: boolean; size?: number }) {
  const s = { width: size, height: size, flexShrink: 0 };
  if (isDir)                    return <Folder style={{ ...s, color: amber + 'cc' }} />;
  const cls = classifyExt(ext);
  if (cls === 'monaco')         return <FileCode style={{ ...s, color: cyan + 'cc' }} />;
  if (cls === 'pdf')            return <FileText style={{ ...s, color: rose + 'cc' }} />;
  if (cls === 'jodit')          return <FileText style={{ ...s, color: green + 'cc' }} />;
  if (cls === 'image')          return <FileImage style={{ ...s, color: amber + '88' }} />;
  if (cls === 'kavita')         return <BookOpen style={{ ...s, color: cyan + '88' }} />;
  return <File style={{ ...s, color: dimMid }} />;
}

// ── Breadcrumb ─────────────────────────────────────────────────────────────────

interface BreadcrumbItem { label: string; onClick: () => void }

function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px',
      borderBottom: `1px solid ${border}`, flexShrink: 0,
      background: bg2, overflowX: 'auto', flexWrap: 'nowrap', minHeight: 44,
    }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {i > 0 && <ChevronRight style={{ width: 12, height: 12, color: textDim }} />}
          <span
            onClick={item.onClick}
            style={{
              ...M, fontSize: 12, color: i === items.length - 1 ? textBrt : dimMid,
              cursor: i < items.length - 1 ? 'pointer' : 'default',
              whiteSpace: 'nowrap', transition: 'color .1s',
            }}
            onMouseEnter={e => { if (i < items.length - 1) (e.currentTarget as HTMLElement).style.color = cyan; }}
            onMouseLeave={e => { if (i < items.length - 1) (e.currentTarget as HTMLElement).style.color = dimMid; }}>
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── File Browser (loose files in library folder) ───────────────────────────────

function FileBrowser({
  rootPath,
  onBack,
  onOpenReader,
}: {
  rootPath: string;
  onBack: () => void;
  onOpenReader: (url: string) => void;
}) {
  const [stack,   setStack]   = useState<string[]>([rootPath]);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [hov,     setHov]     = useState<string | null>(null);
  const [ctx,     setCtx]     = useState<CtxMenu | null>(null);

  const setMonacoOpenRequest = useAppStore(s => s.setMonacoOpenRequest);
  const setJoditOpenRequest  = useAppStore(s => s.setJoditOpenRequest);
  const toggleMonacoPanel    = useAppStore(s => s.toggleMonacoPanel);
  const toggleJoditPanel     = useAppStore(s => s.toggleJoditPanel);
  const monacoPanelOpen      = useAppStore(s => s.monacoPanelOpen);
  const joditPanelOpen       = useAppStore(s => s.joditPanelOpen);

  const currentDir = stack[stack.length - 1];

  useEffect(() => {
    setLoading(true);
    setError(null);
    kget<BrowseEntry[]>(`/api/kavita/browse?dir=${encodeURIComponent(currentDir)}`)
      .then(data => { setEntries(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(err => { setError((err as Error).message); setLoading(false); });
  }, [currentDir]);

  const openEntry = useCallback(async (entry: BrowseEntry) => {
    if (entry.isDir) {
      setStack(s => [...s, entry.path]);
      return;
    }
    const cls = classifyExt(entry.ext);
    if (cls === 'pdf') {
      // PDF → open natively in browser tab via raw stream endpoint
      const url = `${ENGINE}/api/kavita/file-raw?path=${encodeURIComponent(entry.path)}`;
      window.open(url, '_blank', 'noopener');
      return;
    }
    if (cls === 'monaco') {
      try {
        const res = await kget<{ content: string; filename: string; ext: string }>(
          `/api/kavita/file-content?path=${encodeURIComponent(entry.path)}`
        );
        setMonacoOpenRequest({ filename: res.filename, content: res.content });
        if (!monacoPanelOpen) toggleMonacoPanel();
      } catch { /* silent — file unreadable */ }
      return;
    }
    if (cls === 'jodit') {
      try {
        const res = await kget<{ html: string; filename: string }>(
          `/api/kavita/file-html?path=${encodeURIComponent(entry.path)}`
        );
        setJoditOpenRequest({ filename: res.filename, content: res.html });
        if (!joditPanelOpen) toggleJoditPanel();
      } catch (err) {
        console.error('[KavitaBrowser] failed to open doc:', err);
      }
      return;
    }
    if (cls === 'kavita' || cls === 'image') {
      // Archive or image — open Kavita home for now; series ID needed for deep link
      KavitaPlayer.openLibrary();
      return;
    }
  }, [monacoPanelOpen, joditPanelOpen,
      toggleMonacoPanel, toggleJoditPanel,
      setMonacoOpenRequest, setJoditOpenRequest]);

  const crumbs: BreadcrumbItem[] = [
    { label: '◄', onClick: onBack },
    ...stack.map((p, i) => ({
      label: i === 0 ? p.split(/[/\\]/).pop() ?? p : p.split(/[/\\]/).pop() ?? p,
      onClick: () => setStack(s => s.slice(0, i + 1)),
    })),
  ];

  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Breadcrumb items={crumbs} />
      <div style={{ flex: 1, overflowY: 'auto' }} className="kavita-scrollbar">
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 14px', ...M, fontSize: 10, color: dim }}>
            <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            SCANNING…
          </div>
        )}
        {error && (
          <div style={{ padding: '12px 14px', ...M, fontSize: 10, color: rose }}>{error}</div>
        )}
        {!loading && !error && sortedEntries.length === 0 && (
          <div style={{ padding: '20px 14px', ...M, fontSize: 10, color: textDim }}>EMPTY FOLDER</div>
        )}
        {!loading && sortedEntries.map(entry => {
          const cls = classifyExt(entry.ext);
          const badge = entry.isDir ? null
            : cls === 'pdf'    ? { label: 'PDF',   color: rose }
            : cls === 'monaco' ? { label: 'TEXT',  color: cyan }
            : cls === 'jodit'  ? { label: 'DOC',   color: green }
            : cls === 'kavita' ? { label: 'MANGA', color: amber }
            : null;

          return (
            <div key={entry.path}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px',
                cursor: 'pointer',
                background: hov === entry.path ? bg3 : 'transparent',
                borderBottom: `1px solid ${border}`,
                transition: 'background .1s',
              }}
              onMouseEnter={() => setHov(entry.path)}
              onMouseLeave={() => setHov(null)}
              onClick={() => openEntry(entry)}
              onContextMenu={e => {
                e.preventDefault();
                const items: CtxItem[] = entry.isDir
                  ? [{ label: 'Browse folder', action: () => openEntry(entry) }]
                  : [
                      { label: 'Open', action: () => openEntry(entry) },
                      { label: 'Open in Kavita', action: () => KavitaPlayer.openLibrary() },
                    ];
                setCtx({ x: e.clientX, y: e.clientY, items });
              }}>
              <FileIcon ext={entry.ext} isDir={entry.isDir} size={14} />
              <span style={{ ...M, fontSize: 11, color: entry.isDir ? amber : textBrt, flex: 1,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.name}
              </span>
              {badge && (
                <span style={{
                  ...M, fontSize: 8, color: badge.color, padding: '1px 5px',
                  border: `1px solid ${badge.color}40`, borderRadius: 2,
                  background: `${badge.color}10`, letterSpacing: '.08em', flexShrink: 0,
                }}>
                  {badge.label}
                </span>
              )}
              {entry.isDir && <ChevronRight style={{ width: 10, height: 10, color: textDim, flexShrink: 0 }} />}
            </div>
          );
        })}
      </div>
      {ctx && <ContextMenu menu={ctx} onClose={() => setCtx(null)} />}
    </div>
  );
}

// ── Series list ────────────────────────────────────────────────────────────────

function SeriesList({
  library,
  onBack,
  viewMode,
}: {
  library: KavitaLibrary;
  onBack: () => void;
  viewMode: ViewMode;
}) {
  const [series,     setSeries]     = useState<KavitaSeries[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [hov,        setHov]        = useState<number | null>(null);
  const [ctx,        setCtx]        = useState<CtxMenu | null>(null);
  const [browseDir,  setBrowseDir]  = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    kpost('/api/kavita/series/list', { libraryId: library.id, pageSize: 200, pageNumber: 1 })
      .then(data => {
        const arr = (data as { result: KavitaSeries[] })?.result ?? (Array.isArray(data) ? data : []);
        setSeries(arr);
        setLoading(false);
      })
      .catch(err => { setError((err as Error).message); setLoading(false); });
  }, [library.id]);

  const openSeries = useCallback((s: KavitaSeries) => {
    KavitaPlayer.openSeries(s.libraryId, s.id);
  }, []);

  if (browseDir) {
    return (
      <FileBrowser
        rootPath={browseDir}
        onBack={() => setBrowseDir(null)}
        onOpenReader={url => KavitaPlayer.openLibrary()}
      />
    );
  }

  const crumbs: BreadcrumbItem[] = [
    { label: 'LIBRARIES', onClick: onBack },
    { label: library.name.toUpperCase(), onClick: () => {} },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Breadcrumb items={crumbs} />

      {/* Library folder browse shortcut */}
      {library.folders.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
          borderBottom: `1px solid ${border}`, background: bg2, flexShrink: 0,
        }}>
          <div style={{
            width: 40, height: 40, flexShrink: 0, borderRadius: 4,
            background: `${amber}10`, border: `1px solid ${amber}25`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Folder style={{ width: 18, height: 18, color: amber + 'cc' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...M, fontSize: 12, color: textBrt }}>Browse Files</div>
            <div style={{ ...M, fontSize: 9, color: dimMid, marginTop: 2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {library.folders[0]}
            </div>
          </div>
          <button
            onClick={() => setBrowseDir(library.folders[0])}
            style={{
              ...M, fontSize: 10, color: amber, background: `${amber}10`,
              border: `1px solid ${amber}40`, borderRadius: 3, padding: '6px 14px',
              cursor: 'pointer', flexShrink: 0, transition: 'all .15s', letterSpacing: '.06em',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${amber}22`; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = `${amber}10`; }}>
            BROWSE
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }} className="kavita-scrollbar">
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 14px', ...M, fontSize: 10, color: dim }}>
            <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            LOADING SERIES…
          </div>
        )}
        {error && (
          <div style={{ padding: '12px 14px', ...M, fontSize: 10, color: rose }}>{error}</div>
        )}
        {!loading && !error && series.length === 0 && (
          <div style={{ padding: '24px 14px', ...M, fontSize: 10, color: textDim }}>
            NO SERIES — trigger a scan or add files to the library folder
          </div>
        )}

        {/* Grid view */}
        {!loading && viewMode === 'grid' && series.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
            gap: 12, padding: 14,
          }}>
            {series.map(s => {
              const progress = s.pagesRead && s.pages ? Math.round((s.pagesRead / s.pages) * 100) : 0;
              return (
                <div key={s.id}
                  style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}
                  onClick={() => openSeries(s)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setCtx({ x: e.clientX, y: e.clientY, items: [
                      { label: 'Open in reader', action: () => openSeries(s) },
                      { label: 'Open Kavita home', action: () => KavitaPlayer.openLibrary() },
                      { label: 'Open in new tab', action: () => window.open(`${KAVITA_ORIGIN}/library/${s.libraryId}/series/${s.id}`, '_blank') },
                    ]});
                  }}>
                  <div style={{
                    position: 'relative', borderRadius: 3,
                    boxShadow: hov === s.id ? `0 0 0 2px ${cyan}` : `0 0 0 1px ${border}`,
                    transition: 'box-shadow .15s',
                  }}
                    onMouseEnter={() => setHov(s.id)}
                    onMouseLeave={() => setHov(null)}>
                    <SeriesCover seriesId={s.id} size={96} />
                    {progress > 0 && (
                      <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        height: 3, background: 'hsl(var(--background))',
                      }}>
                        <div style={{ height: '100%', width: `${progress}%`, background: cyan }} />
                      </div>
                    )}
                  </div>
                  <div style={{
                    ...M, fontSize: 9, color: s.hasBeenRead ? dim : textBrt,
                    textAlign: 'center', lineHeight: 1.3,
                    overflow: 'hidden', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>
                    {s.name}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* List view */}
        {!loading && viewMode === 'list' && series.map(s => {
          const progress = s.pagesRead && s.pages ? Math.round((s.pagesRead / s.pages) * 100) : 0;
          const fmtLabel = s.format !== undefined ? (LIB_TYPE[s.format] ?? `FMT${s.format}`) : '';
          return (
            <div key={s.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
                cursor: 'pointer', background: hov === s.id ? bg3 : 'transparent',
                borderBottom: `1px solid ${border}`, transition: 'background .1s',
              }}
              onMouseEnter={() => setHov(s.id)} onMouseLeave={() => setHov(null)}
              onClick={() => openSeries(s)}
              onContextMenu={e => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, items: [
                  { label: 'Open in reader', action: () => openSeries(s) },
                  { label: 'Open Kavita home', action: () => KavitaPlayer.openLibrary() },
                  { label: 'Open in new tab', action: () => window.open(`${KAVITA_ORIGIN}/library/${s.libraryId}/series/${s.id}`, '_blank') },
                ]});
              }}>
              <SeriesCover seriesId={s.id} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...M, fontSize: 12, color: s.hasBeenRead ? dim : textBrt,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                  {fmtLabel && (
                    <span style={{ ...M, fontSize: 8, color: dim, letterSpacing: '.08em' }}>
                      {fmtLabel}
                    </span>
                  )}
                  {progress > 0 && (
                    <>
                      <div style={{ width: 60, height: 2, background: 'hsl(var(--secondary))', borderRadius: 1, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${progress}%`, background: cyan }} />
                      </div>
                      <span style={{ ...M, fontSize: 9, color: dim }}>{progress}%</span>
                    </>
                  )}
                  <span style={{ ...M, fontSize: 9, color: textDim }}>{s.pages > 0 ? `${s.pages}p` : ''}</span>
                </div>
              </div>
              <ChevronRight style={{ width: 11, height: 11, color: textDim, flexShrink: 0 }} />
            </div>
          );
        })}
      </div>
      {ctx && <ContextMenu menu={ctx} onClose={() => setCtx(null)} />}
    </div>
  );
}

// ── Libraries panel ────────────────────────────────────────────────────────────

function LibrariesPanel({ viewMode }: { viewMode: ViewMode }) {
  const [libraries, setLibraries] = useState<KavitaLibrary[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [openLib,   setOpenLib]   = useState<KavitaLibrary | null>(null);
  const [hov,       setHov]       = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    kget<{ libraries: KavitaLibrary[] }>('/api/kavita/libraries')
      .then(data => { setLibraries(Array.isArray(data.libraries) ? data.libraries : []); setLoading(false); })
      .catch(err => { setError((err as Error).message); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  if (openLib) {
    return <SeriesList library={openLib} onBack={() => setOpenLib(null)} viewMode={viewMode} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 14px', borderBottom: `1px solid ${border}`, background: bg2, flexShrink: 0,
      }}>
        <span style={{ ...M, fontSize: 9, color: dim, letterSpacing: '.1em' }}>
          {libraries.length} LIBRAR{libraries.length !== 1 ? 'IES' : 'Y'}
        </span>
        <button onClick={load}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: dim, padding: 3,
            display: 'flex', alignItems: 'center', transition: 'color .15s' }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = cyan)}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = dim)}>
          <RefreshCw style={{ width: 11, height: 11 }} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }} className="kavita-scrollbar">
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 14px', ...M, fontSize: 10, color: dim }}>
            <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            LOADING…
          </div>
        )}
        {error && (
          <div style={{ padding: '12px 14px', ...M, fontSize: 10, color: rose }}>
            {error}
            <div style={{ marginTop: 6, cursor: 'pointer', color: cyan }} onClick={load}>RETRY</div>
          </div>
        )}
        {!loading && !error && libraries.length === 0 && (
          <div style={{ padding: '24px 14px', ...M, fontSize: 10, color: textDim, lineHeight: 1.8 }}>
            NO LIBRARIES — start Kavita or add one via Media Hub
          </div>
        )}
        {!loading && libraries.map(lib => {
          const count     = lib.seriesCount ?? lib.series ?? 0;
          const typeLabel = LIB_TYPE[lib.type] ?? `TYPE ${lib.type}`;
          return (
            <div key={lib.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                cursor: 'pointer', background: hov === lib.id ? bg3 : 'transparent',
                borderBottom: `1px solid ${border}`, transition: 'background .1s',
              }}
              onMouseEnter={() => setHov(lib.id)} onMouseLeave={() => setHov(null)}
              onClick={() => setOpenLib(lib)}>
              <div style={{
                width: 40, height: 40, flexShrink: 0, borderRadius: 4,
                background: bg3, border: `1px solid ${border2}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Library style={{ width: 18, height: 18, color: cyan + '80' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...M, fontSize: 12, color: textBrt,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {lib.name}
                </div>
                <div style={{ ...M, fontSize: 9, color: dim, marginTop: 2 }}>
                  {typeLabel} · {count} series
                </div>
                {lib.folders[0] && (
                  <div style={{ ...M, fontSize: 8, color: textDim, marginTop: 1,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {lib.folders[0]}
                  </div>
                )}
              </div>
              <ChevronRight style={{ width: 12, height: 12, color: textDim, flexShrink: 0 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── In Progress panel ──────────────────────────────────────────────────────────

function InProgressPanel() {
  const [items,   setItems]   = useState<KavitaInProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [hov,     setHov]     = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    kget<KavitaInProgress[]>('/api/kavita/in-progress')
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => { setItems([]); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 14px', ...M, fontSize: 10, color: dim }}>
        <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
        LOADING…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', ...M, fontSize: 10, color: textDim, lineHeight: 2 }}>
        <BookOpen style={{ width: 32, height: 32, margin: '0 auto 12px', display: 'block', color: border2 }} />
        NO IN-PROGRESS SERIES
        <div style={{ marginTop: 4, fontSize: 9, color: textDim }}>Start reading from the Libraries tab</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }} className="kavita-scrollbar">
      {items.map(item => {
        const progress = item.pages > 0 ? Math.round((item.pagesRead / item.pages) * 100) : 0;
        return (
          <div key={item.seriesId}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
              cursor: 'pointer', background: hov === item.seriesId ? bg3 : 'transparent',
              borderBottom: `1px solid ${border}`, transition: 'background .1s',
            }}
            onMouseEnter={() => setHov(item.seriesId)} onMouseLeave={() => setHov(null)}
            onClick={() => KavitaPlayer.openSeries(item.libraryId, item.seriesId)}>
            <SeriesCover seriesId={item.seriesId} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...M, fontSize: 12, color: textBrt,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.seriesName}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div style={{ flex: 1, height: 2, background: 'hsl(var(--secondary))', borderRadius: 1, overflow: 'hidden', maxWidth: 100 }}>
                  <div style={{ height: '100%', width: `${progress}%`, background: cyan }} />
                </div>
                <span style={{ ...M, fontSize: 9, color: dim }}>{progress}%</span>
              </div>
            </div>
            <ExternalLink style={{ width: 11, height: 11, color: textDim, flexShrink: 0 }} />
          </div>
        );
      })}
    </div>
  );
}

// ── Main KavitaBrowser widget ──────────────────────────────────────────────────

export default function KavitaBrowser() {
  const [pos,        setPos]        = useState({ x: 100, y: 56 });
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [activeTab,  setActiveTab]  = useState<DrawerTab>('libraries');
  const [viewMode,   setViewMode]   = useState<ViewMode>('list');
  const [readerOpen, setReaderOpen] = useState(false);

  const toggleKavitaBrowser = useAppStore(s => s.toggleKavitaBrowser);

  useEffect(() => {
    const id = setInterval(() => setReaderOpen(KavitaPlayer.isOpen()), 1000);
    return () => clearInterval(id);
  }, []);

  const onMouseDown = useCallback((e: RMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, a, [data-nodrag]')) return;
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.px + e.clientX - dragRef.current.ox,
        y: dragRef.current.py + e.clientY - dragRef.current.oy,
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const WIDGET_W = 780;
  const DRAWER_H = 520;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        .kavita-scrollbar::-webkit-scrollbar { width: 4px; }
        .kavita-scrollbar::-webkit-scrollbar-track { background: #0a0c10; }
        .kavita-scrollbar::-webkit-scrollbar-thumb { background: #1a2030; border-radius: 0; }
        .kavita-scrollbar::-webkit-scrollbar-thumb:hover { background: #22d3ee; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
      `}</style>

      <div className="phobos-kavita-panel" style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 8900,
        userSelect: 'none', filter: 'drop-shadow(0 12px 48px rgba(0,0,0,.85))',
      }}>
        {/* ── Header bar ── */}
        <div onMouseDown={onMouseDown} style={{
          width: WIDGET_W,
          background: bg,
          border: `1px solid ${border}`,
          borderBottom: drawerOpen ? `1px solid #080a0d` : `1px solid ${border}`,
          borderRadius: drawerOpen ? '4px 4px 0 0' : 4,
          cursor: 'grab',
        }}>
          {/* Title strip */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 12px', borderBottom: `1px solid ${border}`,
            background: `linear-gradient(180deg, ${bg2} 0%, ${bg} 100%)`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: cyan, boxShadow: `0 0 6px ${cyan}` }} />
              <span style={{ ...M, color: dim, fontSize: 9, letterSpacing: '.15em' }}>KAVITA</span>
              <span style={{ ...M, color: textDim, fontSize: 8, letterSpacing: '.1em' }}>· DOCUMENT & READING HUB</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} data-nodrag>
              {/* View mode toggle */}
              <button
                onClick={() => setViewMode(m => m === 'grid' ? 'list' : 'grid')}
                title={viewMode === 'grid' ? 'Switch to list' : 'Switch to grid'}
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  color: dim, display: 'flex', padding: 3, transition: 'color .15s' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = cyan)}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = dim)}>
                {viewMode === 'grid'
                  ? <List style={{ width: 12, height: 12 }} />
                  : <Grid style={{ width: 12, height: 12 }} />}
              </button>

              {/* READING pill */}
              {readerOpen && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px',
                  borderRadius: 2, background: `${cyan}12`, border: `1px solid ${cyan}30`,
                }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: cyan,
                    animation: 'pulse-dot 2s ease-in-out infinite' }} />
                  <span style={{ ...M, fontSize: 8, color: cyan + 'cc', letterSpacing: '.1em' }}>READING</span>
                  <button
                    onClick={() => { KavitaPlayer.close(); setReaderOpen(false); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: dim,
                      display: 'flex', padding: 0, marginLeft: 2, transition: 'color .15s' }}
                    onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = rose)}
                    onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = dim)}>
                    <X style={{ width: 9, height: 9 }} />
                  </button>
                </div>
              )}

              {/* Kavita home button */}
              <button onClick={() => KavitaPlayer.openLibrary()} title="Open Kavita home"
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  color: dim, display: 'flex', padding: 3, transition: 'color .15s' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = cyan)}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = dim)}>
                <ExternalLink style={{ width: 11, height: 11 }} />
              </button>

              {/* Close */}
              <button onClick={toggleKavitaBrowser} title="Close browser"
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  color: dim, display: 'flex', padding: 3, transition: 'color .15s' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = rose)}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = dim)}>
                <X style={{ width: 12, height: 12 }} />
              </button>
            </div>
          </div>

          {/* Widget body */}
          <div style={{ padding: '7px 12px', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 10 }} data-nodrag>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...M, fontSize: 10, color: readerOpen ? textBrt : dim }}>
                {readerOpen ? 'Reader window active' : 'Document & reading library'}
              </div>
              <div style={{ ...M, fontSize: 9, color: textDim, marginTop: 1 }}>
                {readerOpen
                  ? 'Click a series to navigate'
                  : 'KAVITA · [PDF] → browser · [TEXT] → editor · [DOC] → document · [MANGA] → reader'}
              </div>
            </div>
            <button
              onClick={() => setDrawerOpen(d => !d)}
              style={{
                background: drawerOpen ? `${cyan}12` : 'none',
                border: `1px solid ${drawerOpen ? cyan + '40' : border}`,
                borderRadius: 3, cursor: 'pointer', padding: '4px 10px',
                color: drawerOpen ? cyan : dim, ...M, fontSize: 9, letterSpacing: '.08em',
                transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 5,
              }}>
              <Library style={{ width: 11, height: 11 }} />
              {drawerOpen ? 'HIDE' : 'BROWSE'}
            </button>
          </div>
        </div>

        {/* ── Drawer ── */}
        {drawerOpen && (
          <div style={{
            width: WIDGET_W, height: DRAWER_H,
            background: bg,
            border: `1px solid ${border}`,
            borderTop: `1px solid #080a0d`,
            borderRadius: '0 0 4px 4px',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${border}`, flexShrink: 0, background: bg2 }}>
              {(['libraries', 'reading'] as DrawerTab[]).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{
                    padding: '9px 20px', background: 'none', border: 'none',
                    borderBottom: activeTab === tab ? `2px solid ${cyan}` : '2px solid transparent',
                    color: activeTab === tab ? cyan : dim,
                    cursor: 'pointer', ...M, fontSize: 10, letterSpacing: '.1em',
                    transition: 'color .15s',
                  }}>
                  {tab === 'libraries' ? 'LIBRARIES' : 'IN PROGRESS'}
                </button>
              ))}
            </div>

            <div className="kavita-scrollbar" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {activeTab === 'libraries'
                ? <LibrariesPanel viewMode={viewMode} />
                : <InProgressPanel />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
