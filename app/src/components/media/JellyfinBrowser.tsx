/**
 * JellyfinBrowser.tsx — PHOBOS Video Library Browser
 *
 * Floating 620px widget. Two-pane architecture:
 *   Header bar  (drag handle, status, "Open Jellyfin" button, close)
 *   Content pane (library list → item grid | folder tree)
 *
 * Views:
 *   LIBRARIES  — Movies / Series sub-nav, fetched from Jellyfin API
 *   FOLDER     — Raw filesystem tree rooted at phobosVideos (via scan-folder)
 *
 * Item routing — everything goes to the native Jellyfin web UI:
 *   Known item (has Jellyfin Id) → http://localhost:18096/web/index.html#!/details?id={Id}
 *   Folder tree file             → http://localhost:18096/web/index.html (home, best effort)
 *
 * NOTE: --nowebclient must be removed from JellyfinManager.ts spawnJellyfin()
 * for the native UI to be reachable. Replace it with nothing (web UI serves by
 * default) or pass --webdir pointing at the bundled jellyfin-web/ directory.
 *
 * API:
 *   /api/services/jellyfin/proxy/Items       GET  — library browse
 *   /api/services/jellyfin/proxy/Items/Counts GET  — item counts by type
 *   /api/services/status                      GET  — service status (libraryPath)
 *   /api/jellyfin/ingest/scan-folder          POST — recursive folder walk
 */

import {
  useState, useEffect, useRef, useCallback,
  type MouseEvent as RMouseEvent,
} from 'react';
import {
  Film, Tv2, Folder, FolderOpen, FileVideo, ExternalLink,
  ChevronRight, RefreshCw, Loader2, AlertTriangle, X,
  Search, ArrowLeft, Library,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE         = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const JELLYFIN_ORIGIN = 'http://localhost:18096';
const WINDOW_NAME    = 'jellyfin-ui';

// ── Types ─────────────────────────────────────────────────────────────────────

type View = 'libraries' | 'folder';
type LibView = 'movies' | 'series';

interface JellyfinItem {
  Id:              string;
  Name:            string;
  Type:            string;
  RunTimeTicks?:   number;
  ProductionYear?: number;
  SeasonCount?:    number;
  EpisodeCount?:   number;
}

interface ItemCounts {
  MovieCount:   number;
  SeriesCount:  number;
  EpisodeCount: number;
}

interface FolderEntry {
  name:  string;
  isDir: boolean;
  path:  string;
  ext:   string;
}

// ── Jellyfin web UI helpers ───────────────────────────────────────────────────

let _win: Window | null = null;

function buildWinFeatures(): string {
  return [
    `width=${Math.min(window.screen.availWidth,  1400)}`,
    `height=${Math.min(window.screen.availHeight, 900)}`,
    'left=60',
    'top=40',
    'scrollbars=yes',
    'resizable=yes',
  ].join(',');
}

function openJellyfinUI(deepPath = ''): void {
  // auth-inject.html is served at /web/ because jellyfin-web/ maps to /web/ in Kestrel
  const qs  = deepPath ? `?deep=${encodeURIComponent(deepPath.replace(/^#/, ''))}` : '';
  const url = `${JELLYFIN_ORIGIN}/web/auth-inject.html${qs}`;
  if (_win && !_win.closed) {
    _win.location.href = url;
    _win.focus();
  } else {
    _win = window.open(url, WINDOW_NAME, buildWinFeatures());
  }
}

function openItem(item: JellyfinItem): void {
  openJellyfinUI(`#!/details?id=${item.Id}`);
}

// ── Video file extensions ─────────────────────────────────────────────────────

const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v',
  'mpg', 'mpeg', 'ts', 'm2ts', 'vob', 'divx', 'xvid',
]);

function isVideoFile(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase().replace(/^\./, ''));
}

function formatRuntime(ticks: number): string {
  const mins = Math.round(ticks / 600_000_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function JellyfinBrowser() {
  const toggleJellyfinBrowser = useAppStore((s) => s.toggleJellyfinBrowser);

  // ── Drag state ─────────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 80, y: 60 });
  const [dragging, setDragging] = useState(false);
  const dragOffset              = useRef({ x: 0, y: 0 });

  // ── View state ─────────────────────────────────────────────────────────────
  const [view, setView]         = useState<View>('libraries');
  const [libView, setLibView]   = useState<LibView>('movies');
  const [search, setSearch]     = useState('');

  // ── Library state ──────────────────────────────────────────────────────────
  const [items, setItems]         = useState<JellyfinItem[]>([]);
  const [counts, setCounts]       = useState<ItemCounts | null>(null);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError]   = useState<string | null>(null);

  // ── Service state ──────────────────────────────────────────────────────────
  const [jellyfinRunning, setJellyfinRunning] = useState(false);
  const [libraryPath, setLibraryPath]         = useState<string>('');

  // ── Folder tree state ──────────────────────────────────────────────────────
  const [folderStack, setFolderStack]   = useState<string[]>([]);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError]   = useState<string | null>(null);

  // ── Fetch service status (libraryPath + running state) ────────────────────
  useEffect(() => {
    fetch(`${ENGINE}/api/services/all`)
      .then(r => r.ok ? r.json() : null)
      .then((d: Record<string, { state?: string; libraryPath?: string }> | null) => {
        if (!d) return;
        const j = d['jellyfin'];
        if (!j) return;
        setJellyfinRunning(j.state === 'running');
        setLibraryPath(j.libraryPath ?? '');
      })
      .catch(() => {});
  }, []);

  // ── Fetch item counts ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!jellyfinRunning) return;
    fetch(`${ENGINE}/api/jellyfin/stats`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { movieCount?: number; seriesCount?: number; episodeCount?: number } | null) => {
        if (!d) return;
        setCounts({ MovieCount: d.movieCount ?? 0, SeriesCount: d.seriesCount ?? 0, EpisodeCount: d.episodeCount ?? 0 });
      })
      .catch(() => {});
  }, [jellyfinRunning]);

  // ── Library fetch ──────────────────────────────────────────────────────────
  const fetchLibrary = useCallback(async () => {
    setLibLoading(true);
    setLibError(null);
    const type = libView === 'movies' ? 'Movie' : 'Series';
    const qs   = new URLSearchParams({ type, limit: '100' });
    if (search) qs.set('search', search);
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/items?${qs.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { Items: JellyfinItem[] };
      setItems(d.Items ?? []);
    } catch (err) {
      setLibError((err as Error).message);
      setItems([]);
    }
    setLibLoading(false);
  }, [libView, search]);

  useEffect(() => {
    if (view === 'libraries' && jellyfinRunning) fetchLibrary();
  }, [view, libView, jellyfinRunning, fetchLibrary]);

  // ── Folder tree fetch ──────────────────────────────────────────────────────
  const fetchFolder = useCallback(async (dir: string) => {
    if (!dir) return;
    setFolderLoading(true);
    setFolderError(null);
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/browse?dir=${encodeURIComponent(dir)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const entries = await r.json() as FolderEntry[];
      // Sort: directories first, then files, both alphabetical
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFolderEntries(entries);
    } catch (err) {
      setFolderError((err as Error).message);
      setFolderEntries([]);
    }
    setFolderLoading(false);
  }, []);

  const enterFolder = useCallback((entry: FolderEntry) => {
    if (!entry.isDir) return;
    setFolderStack(s => [...s, entry.path]);
  }, []);

  const folderBack = useCallback(() => {
    setFolderStack(s => s.slice(0, -1));
  }, []);

  const currentFolderDir = folderStack.length > 0
    ? folderStack[folderStack.length - 1]
    : libraryPath;

  useEffect(() => {
    if (view === 'folder' && currentFolderDir) fetchFolder(currentFolderDir);
  }, [view, currentFolderDir, fetchFolder]);

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: RMouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    setDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => setPos({
      x: Math.max(0, Math.min(window.innerWidth  - 620, e.clientX - dragOffset.current.x)),
      y: Math.max(0, Math.min(window.innerHeight - 60,  e.clientY - dragOffset.current.y)),
    });
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [dragging]);

  // ── Colours (match MediaHubPanel palette) ─────────────────────────────────
  const surface   = 'var(--color-surface,   #0f0f1a)';
  const surface2  = 'var(--color-surface-2, #1a1a2e)';
  const border    = 'var(--color-border,    #2d2d4e)';
  const textMain  = '#e2e8f0';
  const textMuted = '#94a3b8';
  const accent    = '#4ade80';   // phobos green

  // ── Status dot ────────────────────────────────────────────────────────────
  const dotColor = jellyfinRunning ? accent : '#f87171';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 1900,
        width: 620, userSelect: 'none',
        display: 'flex', flexDirection: 'column',
        background: surface,
        border: `1px solid ${border}`,
        borderRadius: 12,
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}
    >
      {/* ── Header bar ───────────────────────────────────────────────────── */}
      <div
        onMouseDown={onMouseDown}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: surface2,
          borderBottom: `1px solid ${border}`,
          cursor: dragging ? 'grabbing' : 'grab',
          flexShrink: 0,
        }}
      >
        {/* Status dot */}
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
          boxShadow: jellyfinRunning ? `0 0 6px ${accent}` : undefined,
        }} />

        {/* Title */}
        <Film size={14} color={accent} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: textMain, letterSpacing: '0.05em' }}>
          JELLYFIN BROWSER
        </span>

        {/* Counts badge */}
        {counts && (
          <span style={{
            fontSize: 11, color: textMuted,
            background: surface, borderRadius: 6,
            padding: '2px 8px', marginLeft: 4,
          }}>
            {counts.MovieCount} movies · {counts.SeriesCount} series
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* View toggle */}
        <button
          onClick={() => { setView('libraries'); setFolderStack([]); }}
          title="Library view"
          style={{
            background: view === 'libraries' ? surface : 'none',
            border: `1px solid ${view === 'libraries' ? border : 'transparent'}`,
            borderRadius: 6, cursor: 'pointer', padding: '3px 8px',
            color: view === 'libraries' ? accent : textMuted,
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
          }}
        >
          <Library size={11} /> Library
        </button>
        <button
          onClick={() => { setView('folder'); setFolderStack([]); }}
          title="Folder tree"
          style={{
            background: view === 'folder' ? surface : 'none',
            border: `1px solid ${view === 'folder' ? border : 'transparent'}`,
            borderRadius: 6, cursor: 'pointer', padding: '3px 8px',
            color: view === 'folder' ? accent : textMuted,
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
          }}
        >
          <Folder size={11} /> Files
        </button>

        {/* Open Jellyfin UI */}
        <button
          onClick={() => openJellyfinUI()}
          title="Open Jellyfin web UI"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', borderRadius: 6,
            background: 'none', border: `1px solid ${border}`,
            color: textMuted, cursor: 'pointer', fontSize: 11, fontWeight: 600,
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.color = accent;
            (e.currentTarget as HTMLElement).style.borderColor = accent;
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.color = textMuted;
            (e.currentTarget as HTMLElement).style.borderColor = border;
          }}
        >
          <ExternalLink size={11} />
          Open Jellyfin
        </button>

        {/* Close */}
        <button
          onClick={toggleJellyfinBrowser}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: textMuted, display: 'flex', alignItems: 'center', padding: 3,
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 480 }}>

        {/* ── LIBRARIES VIEW ─────────────────────────────────────────────── */}
        {view === 'libraries' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* Sub-nav + search */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', flexShrink: 0,
              borderBottom: `1px solid ${border}`,
            }}>
              {(['movies', 'series'] as LibView[]).map(v => (
                <button
                  key={v}
                  onClick={() => { setLibView(v); setSearch(''); }}
                  style={{
                    padding: '4px 14px', borderRadius: 20, fontSize: 12,
                    cursor: 'pointer', border: 'none', fontWeight: 600,
                    background: libView === v ? accent : surface2,
                    color:      libView === v ? '#000' : textMuted,
                  }}
                >
                  {v === 'movies' ? '🎬 Movies' : '📺 Series'}
                </button>
              ))}

              <div style={{
                flex: 1, display: 'flex', alignItems: 'center',
                background: surface2, borderRadius: 8, padding: '0 10px', gap: 6,
              }}>
                <Search size={12} color={textMuted} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') fetchLibrary(); }}
                  placeholder="Search…"
                  style={{
                    background: 'none', border: 'none', outline: 'none',
                    color: textMain, fontSize: 12, width: '100%',
                  }}
                />
              </div>

              <button
                onClick={fetchLibrary}
                title="Refresh"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: textMuted, display: 'flex', alignItems: 'center', padding: 4,
                }}
              >
                <RefreshCw size={13} />
              </button>
            </div>

            {/* Item list */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!jellyfinRunning && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '24px 16px', color: '#f87171', fontSize: 13,
                  justifyContent: 'center',
                }}>
                  <AlertTriangle size={14} />
                  Jellyfin is not running
                </div>
              )}
              {jellyfinRunning && libLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                  <Loader2 size={20} color={accent} className="animate-spin" />
                </div>
              )}
              {jellyfinRunning && libError && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: 16, color: '#f87171', fontSize: 13,
                }}>
                  <AlertTriangle size={14} /> {libError}
                </div>
              )}
              {jellyfinRunning && !libLoading && !libError && items.length === 0 && (
                <div style={{
                  color: textMuted, fontSize: 13,
                  padding: '32px 16px', textAlign: 'center',
                }}>
                  No {libView} found in phobosVideos.<br />
                  <span style={{ fontSize: 11 }}>Ingest files via the Media Hub panel.</span>
                </div>
              )}
              {items.map(item => (
                <LibraryRow
                  key={item.Id}
                  item={item}
                  libView={libView}
                  textMain={textMain}
                  textMuted={textMuted}
                  surface2={surface2}
                  accent={accent}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── FOLDER VIEW ────────────────────────────────────────────────── */}
        {view === 'folder' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* Breadcrumb */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', flexShrink: 0,
              borderBottom: `1px solid ${border}`,
              background: surface2,
            }}>
              {folderStack.length > 0 && (
                <button
                  onClick={folderBack}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: textMuted, display: 'flex', alignItems: 'center', padding: 2,
                  }}
                >
                  <ArrowLeft size={14} />
                </button>
              )}
              <FolderOpen size={12} color={accent} style={{ flexShrink: 0 }} />
              <span style={{
                fontSize: 11, color: textMuted,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1,
              }}>
                {currentFolderDir || 'No library path configured'}
              </span>
              <button
                onClick={() => fetchFolder(currentFolderDir)}
                title="Refresh"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: textMuted, display: 'flex', alignItems: 'center', padding: 2,
                }}
              >
                <RefreshCw size={12} />
              </button>
            </div>

            {/* Entries */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {!libraryPath && !folderLoading && (
                <div style={{ color: textMuted, fontSize: 13, padding: '32px 16px', textAlign: 'center' }}>
                  No library path configured. Set one in Media Hub.
                </div>
              )}
              {folderLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                  <Loader2 size={20} color={accent} className="animate-spin" />
                </div>
              )}
              {folderError && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: 16, color: '#f87171', fontSize: 13,
                }}>
                  <AlertTriangle size={14} /> {folderError}
                </div>
              )}
              {!folderLoading && !folderError && folderEntries.length === 0 && libraryPath && (
                <div style={{ color: textMuted, fontSize: 13, padding: '32px 16px', textAlign: 'center' }}>
                  Empty folder.
                </div>
              )}
              {folderEntries.map(entry => (
                <FolderRow
                  key={entry.path}
                  entry={entry}
                  onEnter={enterFolder}
                  textMain={textMain}
                  textMuted={textMuted}
                  surface2={surface2}
                  accent={accent}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px',
        background: surface2,
        borderTop: `1px solid ${border}`,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: textMuted, fontWeight: 700, letterSpacing: '0.06em' }}>
          JELLYFIN
        </span>
        <span style={{ fontSize: 11, color: textMuted }}>· port 18096 ·</span>
        <span style={{
          fontSize: 11, color: textMuted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {libraryPath || 'phobosVideos'}
        </span>
      </div>
    </div>
  );
}

// ── LibraryRow ────────────────────────────────────────────────────────────────

interface LibraryRowProps {
  item:      JellyfinItem;
  libView:   LibView;
  textMain:  string;
  textMuted: string;
  surface2:  string;
  accent:    string;
}

function LibraryRow({ item, libView, textMain, textMuted, surface2, accent }: LibraryRowProps) {
  const Icon = libView === 'movies' ? Film : Tv2;

  return (
    <div
      onDoubleClick={() => openItem(item)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 14px', cursor: 'pointer',
        color: textMain, borderRadius: 0,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = surface2; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <Icon size={14} color={textMuted} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.Name}
        </div>
        <div style={{ fontSize: 11, color: textMuted, display: 'flex', gap: 8 }}>
          {item.ProductionYear && <span>{item.ProductionYear}</span>}
          {item.RunTimeTicks   && <span>{formatRuntime(item.RunTimeTicks)}</span>}
          {item.SeasonCount    && <span>{item.SeasonCount} season{item.SeasonCount !== 1 ? 's' : ''}</span>}
          {item.EpisodeCount   && <span>{item.EpisodeCount} ep</span>}
        </div>
      </div>
      <ExternalLink size={11} color={accent} style={{ flexShrink: 0, opacity: 0.7 }} />
    </div>
  );
}

// ── FolderRow ─────────────────────────────────────────────────────────────────

interface FolderRowProps {
  entry:     FolderEntry;
  onEnter:   (e: FolderEntry) => void;
  textMain:  string;
  textMuted: string;
  surface2:  string;
  accent:    string;
}

function FolderRow({ entry, onEnter, textMain, textMuted, surface2, accent }: FolderRowProps) {
  const isVideo = !entry.isDir && isVideoFile(entry.ext);

  const Icon = entry.isDir
    ? Folder
    : isVideo
      ? FileVideo
      : Film;

  const iconColor = entry.isDir
    ? accent
    : isVideo
      ? '#60a5fa'
      : textMuted;

  function handleDoubleClick() {
    if (entry.isDir) {
      onEnter(entry);
    } else {
      // Open Jellyfin home — no item-level deep link available for filesystem files
      // that haven't been indexed. Best effort.
      openJellyfinUI();
    }
  }

  return (
    <div
      onDoubleClick={handleDoubleClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 14px', cursor: 'pointer',
        color: textMain,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = surface2; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <Icon size={14} color={iconColor} style={{ flexShrink: 0 }} />
      <span style={{
        flex: 1, fontSize: 13,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: entry.isDir ? textMain : isVideo ? textMain : textMuted,
      }}>
        {entry.name}
      </span>
      {entry.isDir
        ? <ChevronRight size={12} color={textMuted} style={{ flexShrink: 0 }} />
        : isVideo
          ? <ExternalLink size={11} color={accent} style={{ flexShrink: 0, opacity: 0.7 }} />
          : null
      }
    </div>
  );
}
