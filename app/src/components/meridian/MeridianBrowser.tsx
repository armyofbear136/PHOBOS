/**
 * MeridianBrowser.tsx — PHOBOS Meridian floating photo library browser.
 *
 * Draggable floating widget. Two tabs: Photos (date-grouped grid) and Albums.
 * Clicking a photo opens the fullscreen MeridianViewer at that image.
 * Matches KavitaBrowser / JellyfinBrowser architecture.
 *
 * API (via ENGINE proxy → Meridian :16320):
 *   GET /api/services/meridian/proxy/api/files         — paginated file list
 *   GET /api/services/meridian/proxy/api/albums        — album list
 *   GET /api/services/meridian/proxy/api/status        — scan state + totalFiles
 *   GET /api/services/meridian/proxy/api/files/:id/thumb/:size
 *   POST /api/services/meridian/scan                   — trigger rescan
 */

import {
  useState, useEffect, useRef, useCallback, useMemo,
  type MouseEvent as RMouseEvent,
} from 'react';
import {
  Camera, X, Images, BookImage, ScanLine, RefreshCw,
  Loader2, FolderOpen, Search, ChevronLeft, Plus,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

// All calls go through Vite's /api proxy → localhost:3001 — never cross-origin.
const PROXY = '/api/services/meridian/proxy';

// ── Design tokens (shared with MediaHubPanel) ─────────────────────────────────

const bg      = 'hsl(var(--background))';
const bg2     = 'hsl(var(--card))';
const bg3     = 'hsl(var(--secondary))';
const border  = 'hsl(var(--border))';
const borderLo = '#161b24';
const teal    = '#14b8a6';
const green   = '#10b981';
const amber   = '#f59e0b';
const red     = '#ef4444';
const text    = 'hsl(var(--foreground))';
const muted   = 'hsl(var(--muted-foreground))';
const dim     = 'hsl(var(--muted-foreground))';
const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };

// ── Types ─────────────────────────────────────────────────────────────────────

interface MFile {
  id:         string;
  filename:   string;
  ext:        string;
  type:       'photo' | 'video' | 'raw' | 'unknown';
  width:      number | null;
  height:     number | null;
  durationMs: number | null;
  takenAt:    string | null;
  sizeBytes:  number | null;
  thumbReady: boolean;
  albumIds:   string[];
  libraryId:  string;
}

interface MAlbum {
  id:          string;
  name:        string;
  description: string | null;
  coverFileId: string | null;
  updatedAt:   string;
}

interface ScanStatus {
  scanPhase:    string;
  filesIndexed: number;
  thumbsQueued: number;
  thumbsDone:   number;
  totalFiles:   number;
  libraries:    Array<{ id: string; label: string; fileCount: number; path: string }>;
}

type Tab = 'photos' | 'albums';

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function thumbUrl(fileId: string, size: 'xs' | 'sm' | 'md'): string {
  return `${PROXY}/api/files/${fileId}/thumb/${size}`;
}

// ── Date grouping ─────────────────────────────────────────────────────────────

interface DateGroup { label: string; files: MFile[] }

function groupByMonth(files: MFile[]): DateGroup[] {
  const groups = new Map<string, MFile[]>();
  for (const f of files) {
    const d     = f.takenAt ? new Date(f.takenAt) : null;
    const label = d
      ? d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'Unknown Date';
    const arr = groups.get(label) ?? [];
    arr.push(f);
    groups.set(label, arr);
  }
  return [...groups.entries()].map(([label, files]) => ({ label, files }));
}

// ── PhotoThumb ────────────────────────────────────────────────────────────────

const CELL = 108;
const GAP  = 2;

function PhotoThumb({
  file, selected, onClick,
}: { file: MFile; selected: boolean; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);

  return (
    <div
      onClick={onClick}
      style={{
        width: CELL, height: CELL, flexShrink: 0, cursor: 'pointer',
        background: bg3, borderRadius: 2, overflow: 'hidden', position: 'relative',
        outline: selected ? `2px solid ${teal}` : 'none',
        outlineOffset: -2,
      }}
    >
      {!error && (
        <img
          src={thumbUrl(file.id, 'sm')}
          alt={file.filename}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover',
            opacity: loaded ? 1 : 0, transition: 'opacity .12s',
          }}
        />
      )}
      {!loaded && !error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Loader2 size={12} color={dim} style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          ...mono, fontSize: 8, color: dim,
        }}>
          {file.ext.toUpperCase()}
        </div>
      )}
      {file.type === 'video' && (
        <div style={{
          position: 'absolute', bottom: 2, right: 2,
          background: 'rgba(0,0,0,.75)', borderRadius: 1,
          padding: '1px 3px', ...mono, fontSize: 7, color: text,
        }}>
          {file.durationMs ? `${Math.round(file.durationMs / 1000)}s` : 'VID'}
        </div>
      )}
    </div>
  );
}

// ── PhotosTab ─────────────────────────────────────────────────────────────────

function PhotosTab({
  onOpenViewer,
}: { onOpenViewer: (files: MFile[], index: number) => void }) {
  const [files,         setFiles]         = useState<MFile[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [hasMore,       setHasMore]       = useState(true);
  const offsetRef    = useRef(0);
  const loadingRef   = useRef(false);
  const mountedRef   = useRef(true);
  const [scanStatus,    setScanStatus]    = useState<ScanStatus | null>(null);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<MFile[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 300;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadFiles = useCallback(async (reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const off = reset ? 0 : offsetRef.current;
    if (reset) offsetRef.current = 0;
    try {
      const data = await apiFetch<{ files: MFile[]; total: number }>(
        `/api/files?limit=${LIMIT}&offset=${off}&orderBy=taken_at`,
      );
      if (!mountedRef.current) { loadingRef.current = false; return; }
      setFiles(prev => reset ? data.files : [...prev, ...data.files]);
      setHasMore(off + data.files.length < data.total);
      offsetRef.current = off + data.files.length;
    } catch { /* offline / not running */ }
    loadingRef.current = false;
    if (mountedRef.current) setLoading(false);
  }, []);

  useEffect(() => { loadFiles(true); }, []);

  useEffect(() => {
    let scanWasActive = false;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await apiFetch<ScanStatus>('/api/status');
        if (cancelled) return;
        setScanStatus(s);
        const active = s.scanPhase === 'indexing' || s.scanPhase === 'walking';
        if (active) {
          scanWasActive = true;
          setTimeout(poll, 3_000);
        } else if (scanWasActive && (s.scanPhase === 'done' || s.scanPhase === 'thumbing')) {
          // A scan just finished — reload the grid
          scanWasActive = false;
          loadFiles(true);
        }
      } catch { /* offline */ }
    };
    poll();
    return () => { cancelled = true; };
  }, [loadFiles]);

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ files: MFile[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=200`);
        setSearchResults(data.files);
      } catch { setSearchResults([]); }
    }, 300);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || searchResults) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) loadFiles();
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasMore, searchResults, loadFiles]);

  const displayFiles = searchResults ?? files;
  const groups       = useMemo(() => groupByMonth(displayFiles), [displayFiles]);
  const isScanning   = scanStatus?.scanPhase === 'walking'
    || scanStatus?.scanPhase === 'indexing'
    || scanStatus?.scanPhase === 'thumbing';

  // Compute cols from container width — 5 cols at CELL+GAP each
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(5);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width - 24; // padding
      setCols(Math.max(2, Math.floor((w + GAP) / (CELL + GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Search bar */}
      <div style={{ padding: '6px 12px', borderBottom: `1px solid ${borderLo}`, flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <Search size={10} color={dim} style={{
            position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)',
          }} />
          <input
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search photos…"
            style={{
              width: '100%', background: bg3, border: `1px solid ${border}`,
              borderRadius: 3, padding: '5px 8px 5px 22px', color: text,
              ...mono, fontSize: 10, outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Scan indicator */}
      {isScanning && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', background: `${amber}08`,
          borderBottom: `1px solid ${amber}20`, flexShrink: 0,
        }}>
          <ScanLine size={10} style={{ color: amber, animation: 'pulse-dot 1.5s ease-in-out infinite' }} />
          <span style={{ ...mono, fontSize: 9, color: amber }}>
            SCANNING · {scanStatus?.filesIndexed ?? 0} indexed
          </span>
        </div>
      )}

      {/* Grid */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {loading ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: 24, color: dim,
          }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ ...mono, fontSize: 10 }}>Loading library…</span>
          </div>
        ) : groups.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <FolderOpen size={24} color={dim} style={{ margin: '0 auto 8px' }} />
            <div style={{ ...mono, fontSize: 10, color: dim }}>
              {searchQuery ? 'No results found.' : 'No photos found in library.'}
            </div>
            {!searchQuery && scanStatus && (
              <div style={{ ...mono, fontSize: 9, color: border, marginTop: 4 }}>
                {scanStatus.libraries?.[0]?.path ?? ''}
              </div>
            )}
          </div>
        ) : (
          <div ref={containerRef}>
            {groups.map(group => {
              // Build a flat index into displayFiles for lightbox navigation
              const groupStartIdx = displayFiles.indexOf(group.files[0]);
              return (
                <div key={group.label}>
                  <div style={{
                    ...mono, fontSize: 9, fontWeight: 700, color: muted,
                    padding: '12px 0 6px', letterSpacing: '.08em',
                  }}>
                    {group.label.toUpperCase()}
                    <span style={{ color: dim, fontWeight: 400, marginLeft: 6 }}>
                      {group.files.length}
                    </span>
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${cols}, ${CELL}px)`,
                    gap: GAP,
                  }}>
                    {group.files.map((file, i) => (
                      <PhotoThumb
                        key={file.id}
                        file={file}
                        selected={false}
                        onClick={() => onOpenViewer(displayFiles, groupStartIdx + i)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AlbumDetail ───────────────────────────────────────────────────────────────

function AlbumDetail({ album, onBack, onOpenViewer }: {
  album:        MAlbum;
  onBack:       () => void;
  onOpenViewer: (files: MFile[], index: number) => void;
}) {
  const [albumFiles,   setAlbumFiles]   = useState<MFile[]>([]);
  const [albumLoading, setAlbumLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(5);

  useEffect(() => {
    apiFetch<{ files: MFile[] }>(`/api/albums/${album.id}`)
      .then(d => setAlbumFiles(d.files))
      .catch(() => setAlbumFiles([]))
      .finally(() => setAlbumLoading(false));
  }, [album.id]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width - 24;
      setCols(Math.max(2, Math.floor((w + GAP) / (CELL + GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups = useMemo(() => groupByMonth(albumFiles), [albumFiles]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 12px', borderBottom: `1px solid ${borderLo}`, flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: muted, display: 'flex', alignItems: 'center', gap: 3,
            ...mono, fontSize: 9,
          }}
        >
          <ChevronLeft size={11} /> Albums
        </button>
        <span style={{ color: dim }}>/</span>
        <span style={{ ...mono, fontSize: 10, color: text, fontWeight: 600 }}>
          {album.name}
        </span>
        <span style={{ ...mono, fontSize: 9, color: dim }}>
          {albumFiles.length}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
        {albumLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: dim }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        ) : albumFiles.length === 0 ? (
          <div style={{ ...mono, fontSize: 10, color: dim, padding: '24px 0' }}>
            This album is empty.
          </div>
        ) : (
          groups.map(group => (
            <div key={group.label}>
              <div style={{
                ...mono, fontSize: 9, fontWeight: 700, color: muted,
                padding: '12px 0 6px', letterSpacing: '.08em',
              }}>
                {group.label.toUpperCase()}
                <span style={{ color: dim, fontWeight: 400, marginLeft: 6 }}>{group.files.length}</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, ${CELL}px)`,
                gap: GAP,
              }}>
                {group.files.map((file, i) => (
                  <PhotoThumb
                    key={file.id}
                    file={file}
                    selected={false}
                    onClick={() => onOpenViewer(albumFiles, i)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── AlbumsTab ─────────────────────────────────────────────────────────────────

function AlbumsTab({ onOpenViewer }: {
  onOpenViewer: (files: MFile[], index: number) => void;
}) {
  const [albums,      setAlbums]      = useState<MAlbum[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [activeAlbum, setActiveAlbum] = useState<MAlbum | null>(null);

  useEffect(() => {
    apiFetch<{ albums: MAlbum[] }>('/api/albums')
      .then(d => setAlbums(d.albums))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const createAlbum = async () => {
    const name = prompt('Album name:');
    if (!name?.trim()) return;
    try {
      await fetch(`${PROXY}/api/albums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await apiFetch<{ albums: MAlbum[] }>('/api/albums');
      setAlbums(d.albums);
    } catch { /* ignore */ }
  };

  if (activeAlbum) {
    return (
      <AlbumDetail
        album={activeAlbum}
        onBack={() => setActiveAlbum(null)}
        onOpenViewer={onOpenViewer}
      />
    );
  }

  // ── Album list ────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 0 8px',
      }}>
        <span style={{ ...mono, fontSize: 9, color: muted, letterSpacing: '.08em' }}>
          ALBUMS — {albums.length}
        </span>
        <button
          onClick={createAlbum}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'none', border: `1px solid ${border}`, borderRadius: 3,
            color: muted, cursor: 'pointer', padding: '3px 8px',
            ...mono, fontSize: 9,
          }}
        >
          <Plus size={9} /> NEW
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: dim }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ ...mono, fontSize: 10 }}>Loading albums…</span>
        </div>
      ) : albums.length === 0 ? (
        <div style={{ ...mono, fontSize: 10, color: dim, paddingTop: 8 }}>
          No albums yet.
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          gap: 6,
        }}>
          {albums.map(album => (
            <div
              key={album.id}
              onClick={() => setActiveAlbum(album)}
              style={{
                cursor: 'pointer', borderRadius: 3, overflow: 'hidden',
                background: bg2, border: `1px solid ${border}`,
              }}
            >
              <div style={{
                width: '100%', aspectRatio: '1', background: bg3,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}>
                {album.coverFileId ? (
                  <img
                    src={thumbUrl(album.coverFileId, 'sm')}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    alt={album.name}
                  />
                ) : (
                  <BookImage size={20} color={dim} />
                )}
              </div>
              <div style={{ padding: '5px 7px 6px' }}>
                <div style={{ ...mono, fontSize: 9, color: text, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {album.name}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inline Lightbox ───────────────────────────────────────────────────────────

function Lightbox({ files, index, onClose, onNav }: {
  files:   MFile[];
  index:   number;
  onClose: () => void;
  onNav:   (i: number) => void;
}) {
  const file = files[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')       { onClose(); return; }
      if (e.key === 'ArrowLeft'  && index > 0)               onNav(index - 1);
      if (e.key === 'ArrowRight' && index < files.length - 1) onNav(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, files.length, onClose, onNav]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9700,
        background: 'rgba(0,0,0,.95)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Nav prev */}
      {index > 0 && (
        <button
          onClick={e => { e.stopPropagation(); onNav(index - 1); }}
          style={{
            position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            color: text, cursor: 'pointer', padding: '12px 10px', zIndex: 1,
          }}
        >
          <ChevronLeft size={20} />
        </button>
      )}

      {/* Nav next */}
      {index < files.length - 1 && (
        <button
          onClick={e => { e.stopPropagation(); onNav(index + 1); }}
          style={{
            position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            color: text, cursor: 'pointer', padding: '12px 10px', zIndex: 1,
          }}
        >
          <ChevronLeft size={20} style={{ transform: 'rotate(180deg)' }} />
        </button>
      )}

      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          width: '90vw',
          height: '90vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <img
          src={`${PROXY}/api/files/${file.id}/raw?v=2`}
          alt={file.filename}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      </div>

      {/* Top bar */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px',
          background: 'linear-gradient(180deg,rgba(0,0,0,.7) 0%,transparent 100%)',
        }}
      >
        <span style={{ ...mono, fontSize: 11, color: text }}>
          {file.filename}
          <span style={{ color: muted, fontSize: 9, marginLeft: 10 }}>
            {index + 1} / {files.length}
          </span>
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'rgba(255,255,255,.08)', border: 'none',
            borderRadius: 4, color: text, cursor: 'pointer', padding: '6px 8px',
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Bottom meta */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          padding: '12px 16px', display: 'flex', gap: 14, alignItems: 'center',
          background: 'linear-gradient(0deg,rgba(0,0,0,.7) 0%,transparent 100%)',
        }}
      >
        {file.width && file.height && (
          <span style={{ ...mono, fontSize: 9, color: muted }}>
            {file.width}×{file.height}
          </span>
        )}
        {file.takenAt && (
          <span style={{ ...mono, fontSize: 9, color: muted }}>
            {new Date(file.takenAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main MeridianBrowser widget ───────────────────────────────────────────────

const WIDGET_W = 720;
const DRAWER_H = 500;

export default function MeridianBrowser() {
  const [pos,     setPos]     = useState({ x: 120, y: 56 });
  const dragRef   = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);
  const [tab,     setTab]     = useState<Tab>('photos');
  const [drawer,  setDrawer]  = useState(true);
  const [scanning, setScanning] = useState(false);

  // Lightbox state — null when closed
  const [lightbox, setLightbox] = useState<{ files: MFile[]; index: number } | null>(null);

  const toggleMeridianBrowser = useAppStore(s => s.toggleMeridianBrowser);

  // ── Drag ──────────────────────────────────────────────────────────────────
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
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup',   up);
    };
  }, []);

  const triggerScan = async () => {
    setScanning(true);
    try { await fetch('/api/services/meridian/scan', { method: 'POST' }); } catch { /* ignore */ }
    setTimeout(() => setScanning(false), 1500);
  };

  const openViewer = (files: MFile[], index: number) => {
    setLightbox({ files, index });
  };

  return (
    <>
      <style>{`
        @keyframes spin      { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
        .m-scroll::-webkit-scrollbar { width: 3px; }
        .m-scroll::-webkit-scrollbar-track { background: transparent; }
        .m-scroll::-webkit-scrollbar-thumb { background: ${dim}; border-radius: 0; }
      `}</style>

      <div style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 8950,
        userSelect: 'none',
        filter: 'drop-shadow(0 12px 48px rgba(0,0,0,.85))',
      }}>
        {/* ── Header bar ── */}
        <div
          onMouseDown={onMouseDown}
          style={{
            width: WIDGET_W,
            background: bg,
            border: `1px solid ${border}`,
            borderBottom: drawer ? `1px solid #080a0d` : `1px solid ${border}`,
            borderRadius: drawer ? '4px 4px 0 0' : 4,
            cursor: 'grab',
          }}
        >
          {/* Title strip */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 12px', borderBottom: `1px solid ${border}`,
            background: `linear-gradient(180deg, ${bg2} 0%, ${bg} 100%)`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Camera size={12} style={{ color: teal }} />
              <span style={{ ...mono, fontSize: 11, fontWeight: 700, color: text }}>
                Meridian
              </span>
              <span style={{ ...mono, fontSize: 9, color: dim, letterSpacing: '.08em' }}>
                PHOTOS
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }} data-nodrag>
              <button
                onClick={triggerScan}
                disabled={scanning}
                title="Rescan library"
                style={{
                  background: 'none', border: 'none', cursor: scanning ? 'default' : 'pointer',
                  color: scanning ? dim : muted, padding: 3, display: 'flex',
                  opacity: scanning ? .5 : 1,
                }}
              >
                <RefreshCw size={11} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
              </button>
              <button
                onClick={() => setDrawer(v => !v)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: muted, padding: 3, display: 'flex',
                  ...mono, fontSize: 9, letterSpacing: '.06em',
                }}
              >
                {drawer ? '▼' : '▶'}
              </button>
              <button
                onClick={toggleMeridianBrowser}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: muted, padding: 3, display: 'flex',
                }}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Tabs */}
          {drawer && (
            <div style={{
              display: 'flex', gap: 0,
              padding: '4px 12px 0',
              borderBottom: `1px solid ${borderLo}`,
            }} data-nodrag>
              {(['photos', 'albums'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    background: 'none', cursor: 'pointer',
                    border: 'none', borderBottom: tab === t ? `2px solid ${teal}` : '2px solid transparent',
                    padding: '5px 10px',
                    display: 'flex', alignItems: 'center', gap: 4,
                    ...mono, fontSize: 9, fontWeight: tab === t ? 700 : 400,
                    color: tab === t ? teal : muted,
                    letterSpacing: '.06em',
                    marginBottom: -1,
                  }}
                >
                  {t === 'photos' ? <Images size={10} /> : <BookImage size={10} />}
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Drawer body ── */}
        {drawer && (
          <div
            className="m-scroll"
            data-nodrag
            style={{
              width: WIDGET_W, height: DRAWER_H,
              background: bg,
              border: `1px solid ${border}`,
              borderTop: 'none',
              borderRadius: '0 0 4px 4px',
              overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {tab === 'photos' && (
              <PhotosTab onOpenViewer={openViewer} />
            )}
            {tab === 'albums' && (
              <AlbumsTab onOpenViewer={openViewer} />
            )}
          </div>
        )}
      </div>

      {/* Inline lightbox */}
      {lightbox && (
        <Lightbox
          files={lightbox.files}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNav={i => setLightbox(prev => prev ? { ...prev, index: i } : null)}
        />
      )}
    </>
  );
}