/**
 * MeridianViewer.tsx — PHOBOS Meridian photo library viewer.
 *
 * Two views: All Photos (date-grouped virtualized grid) and Albums.
 * Opened from MediaHubPanel when Meridian is running.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Images, BookImage, Search, ScanLine, ChevronLeft, Info,
         Plus, FolderOpen, Loader2 } from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const MERIDIAN = `${ENGINE}/api/services/meridian/proxy`;

// ── Types ─────────────────────────────────────────────────────────────────────

type View = 'photos' | 'albums' | 'album-detail';

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
  scanPhase:   string;
  filesIndexed: number;
  thumbsQueued: number;
  thumbsDone:   number;
  totalFiles:   number;
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${MERIDIAN}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MERIDIAN}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function thumbUrl(fileId: string, size: 'xs' | 'sm' | 'md' | 'lg'): string {
  return `${MERIDIAN}/api/files/${fileId}/thumb/${size}`;
}

// ── CSS constants ─────────────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };

const CELL_SIZE = 180; // px — grid cell target size
const GAP       = 2;   // px

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

// ── PhotoCell ─────────────────────────────────────────────────────────────────

function PhotoCell({ file, onClick }: { file: MFile; onClick: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(false);

  return (
    <div
      onClick={onClick}
      style={{
        width: CELL_SIZE, height: CELL_SIZE, flexShrink: 0,
        background: 'hsl(var(--card))', cursor: 'pointer', position: 'relative',
        overflow: 'hidden', borderRadius: 2,
      }}
      onMouseEnter={e => { e.currentTarget.style.opacity = '0.85'; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
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
            opacity: loaded ? 1 : 0, transition: 'opacity .15s',
          }}
        />
      )}
      {!loaded && !error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Loader2 size={16} color="#2a3040" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'hsl(var(--secondary))', ...mono, fontSize: 9,
        }}>
          {file.ext.toUpperCase()}
        </div>
      )}
      {file.type === 'video' && (
        <div style={{
          position: 'absolute', bottom: 4, right: 4,
          background: 'rgba(0,0,0,.7)', borderRadius: 2,
          padding: '1px 4px', ...mono, fontSize: 8, color: 'hsl(var(--foreground))',
        }}>
          {file.durationMs ? `${Math.round(file.durationMs / 1000)}s` : 'VID'}
        </div>
      )}
    </div>
  );
}

// ── PhotoGrid ────────────────────────────────────────────────────────────────

function PhotoGrid({ groups, onPhotoClick }: {
  groups:        DateGroup[];
  onPhotoClick:  (file: MFile, allFiles: MFile[], index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setCols(Math.max(2, Math.floor((w + GAP) / (CELL_SIZE + GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allFiles = useMemo(() => groups.flatMap(g => g.files), [groups]);

  return (
    <div ref={containerRef} style={{ padding: '0 16px 24px' }}>
      {groups.map(group => (
        <div key={group.label}>
          <div style={{
            ...mono, fontSize: 11, fontWeight: 600, color: 'hsl(var(--muted-foreground))',
            padding: '20px 0 8px', letterSpacing: '.06em',
          }}>
            {group.label.toUpperCase()}
            <span style={{ color: 'hsl(var(--secondary))', fontWeight: 400, marginLeft: 8 }}>
              {group.files.length}
            </span>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${CELL_SIZE}px)`,
            gap: GAP,
          }}>
            {group.files.map(file => {
              const globalIdx = allFiles.indexOf(file);
              return (
                <PhotoCell
                  key={file.id}
                  file={file}
                  onClick={() => onPhotoClick(file, allFiles, globalIdx)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({ file, allFiles, index, onClose, onNav }: {
  file:     MFile;
  allFiles: MFile[];
  index:    number;
  onClose:  () => void;
  onNav:    (newIndex: number) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [exif, setExif] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')     { onClose(); return; }
      if (e.key === 'ArrowLeft'  && index > 0)               onNav(index - 1);
      if (e.key === 'ArrowRight' && index < allFiles.length - 1) onNav(index + 1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [index, allFiles.length, onClose, onNav]);

  useEffect(() => {
    if (!showInfo || exif) return;
    apiFetch<{ exif: Record<string, unknown> }>(`/api/files/${file.id}`)
      .then(d => setExif(d.exif ?? {}))
      .catch(() => setExif({}));
  }, [showInfo, file.id, exif]);

  const fmtBytes = (b: number | null) =>
    b == null ? '' : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) : '';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9600,
      background: 'rgba(0,0,0,.95)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={onClose}
    >
      {/* Nav prev */}
      {index > 0 && (
        <button
          onClick={e => { e.stopPropagation(); onNav(index - 1); }}
          style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            color: 'hsl(var(--foreground))', cursor: 'pointer', padding: '12px 10px', zIndex: 1 }}>
          <ChevronLeft size={20} />
        </button>
      )}

      {/* Nav next */}
      {index < allFiles.length - 1 && (
        <button
          onClick={e => { e.stopPropagation(); onNav(index + 1); }}
          style={{ position: 'absolute', right: showInfo ? 280 : 16, top: '50%',
            transform: 'translateY(-50%)',
            background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 4,
            color: 'hsl(var(--foreground))', cursor: 'pointer', padding: '12px 10px', zIndex: 1 }}>
          <ChevronLeft size={20} style={{ transform: 'rotate(180deg)' }} />
        </button>
      )}

      {/* Image */}
      <img
        src={thumbUrl(file.id, 'lg')}
        alt={file.filename}
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth:  showInfo ? 'calc(100vw - 296px)' : '100vw',
          maxHeight: '100vh',
          objectFit: 'contain',
          transition: 'max-width .2s',
        }}
      />

      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        background: 'linear-gradient(180deg,rgba(0,0,0,.7) 0%,transparent 100%)',
      }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ ...mono, fontSize: 12, color: 'hsl(var(--foreground))' }}>
          {file.filename}
          <span style={{ color: 'hsl(var(--muted-foreground))', marginLeft: 12, fontSize: 10 }}>
            {index + 1} / {allFiles.length}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowInfo(v => !v)}
            style={{ background: showInfo ? 'rgba(59,130,246,.2)' : 'rgba(255,255,255,.08)',
              border: showInfo ? '1px solid rgba(59,130,246,.4)' : '1px solid transparent',
              borderRadius: 4, color: 'hsl(var(--foreground))', cursor: 'pointer', padding: '6px 8px' }}>
            <Info size={14} />
          </button>
          <button onClick={onClose}
            style={{ background: 'rgba(255,255,255,.08)', border: 'none',
              borderRadius: 4, color: 'hsl(var(--foreground))', cursor: 'pointer', padding: '6px 8px' }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: showInfo ? 280 : 0,
        padding: '12px 16px',
        background: 'linear-gradient(0deg,rgba(0,0,0,.7) 0%,transparent 100%)',
        display: 'flex', gap: 16, alignItems: 'center',
      }}
        onClick={e => e.stopPropagation()}
      >
        {file.width && file.height && (
          <span style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
            {file.width}×{file.height}
          </span>
        )}
        {file.sizeBytes && (
          <span style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
            {fmtBytes(file.sizeBytes)}
          </span>
        )}
        {file.takenAt && (
          <span style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
            {fmtDate(file.takenAt)}
          </span>
        )}
      </div>

      {/* Info panel */}
      {showInfo && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 280,
          background: 'hsl(var(--background))', borderLeft: '1px solid #1e2430',
          overflowY: 'auto', padding: '52px 16px 16px',
        }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))', marginBottom: 12,
            letterSpacing: '.1em' }}>EXIF DATA</div>
          {!exif && (
            <Loader2 size={14} color="#3a3f4a" style={{ animation: 'spin 1s linear infinite' }} />
          )}
          {exif && Object.entries(exif).length === 0 && (
            <div style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>No EXIF data</div>
          )}
          {exif && Object.entries(exif).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 8 }}>
              <div style={{ ...mono, fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '.06em' }}>
                {k.replace(/([A-Z])/g, ' $1').trim().toUpperCase()}
              </div>
              <div style={{ ...mono, fontSize: 11, color: '#8a94a6', marginTop: 2 }}>
                {String(v)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AlbumsView ────────────────────────────────────────────────────────────────

function AlbumsView({ onOpenAlbum, onCreateAlbum }: {
  onOpenAlbum:   (album: MAlbum) => void;
  onCreateAlbum: () => void;
}) {
  const [albums, setAlbums] = useState<MAlbum[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ albums: MAlbum[] }>('/api/albums')
      .then(d => setAlbums(d.albums))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'hsl(var(--muted-foreground))' }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ ...mono, fontSize: 11 }}>Loading albums…</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '0 16px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px 0 12px' }}>
        <span style={{ ...mono, fontSize: 11, color: 'hsl(var(--muted-foreground))', letterSpacing: '.06em' }}>
          ALBUMS — {albums.length}
        </span>
        <button
          onClick={onCreateAlbum}
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none',
            border: '1px solid #1e2430', borderRadius: 3, color: 'hsl(var(--muted-foreground))',
            cursor: 'pointer', padding: '5px 10px', ...mono, fontSize: 10 }}>
          <Plus size={11} /> NEW ALBUM
        </button>
      </div>

      {albums.length === 0 && (
        <div style={{ ...mono, fontSize: 11, color: 'hsl(var(--muted-foreground))', paddingTop: 8 }}>
          No albums yet. Select photos to create one.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
        {albums.map(album => (
          <div
            key={album.id}
            onClick={() => onOpenAlbum(album)}
            style={{ cursor: 'pointer', borderRadius: 4, overflow: 'hidden',
              background: 'hsl(var(--card))', border: '1px solid #1e2430', transition: 'border-color .15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'hsl(var(--secondary))'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'hsl(var(--border))'; }}
          >
            <div style={{ width: '100%', aspectRatio: '1', background: 'hsl(var(--background))',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {album.coverFileId ? (
                <img
                  src={thumbUrl(album.coverFileId, 'sm')}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  alt={album.name}
                />
              ) : (
                <BookImage size={24} color="#2a3040" />
              )}
            </div>
            <div style={{ padding: '8px 10px 10px' }}>
              <div style={{ ...mono, fontSize: 11, color: 'hsl(var(--foreground))', fontWeight: 600 }}>
                {album.name}
              </div>
              {album.description && (
                <div style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))', marginTop: 2 }}>
                  {album.description}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AlbumDetailView ───────────────────────────────────────────────────────────

function AlbumDetailView({ album, onBack }: { album: MAlbum; onBack: () => void }) {
  const [files, setFiles]         = useState<MFile[]>([]);
  const [lightbox, setLightbox]   = useState<{ file: MFile; index: number } | null>(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    apiFetch<{ files: MFile[] }>(`/api/albums/${album.id}`)
      .then(d => setFiles(d.files))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [album.id]);

  const groups = useMemo(() => groupByMonth(files), [files]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px', borderBottom: '1px solid #1e2430' }}>
        <button onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'hsl(var(--muted-foreground))', display: 'flex', alignItems: 'center', gap: 4,
            ...mono, fontSize: 11 }}>
          <ChevronLeft size={14} /> Albums
        </button>
        <span style={{ color: 'hsl(var(--secondary))' }}>/</span>
        <span style={{ ...mono, fontSize: 12, color: 'hsl(var(--foreground))', fontWeight: 600 }}>
          {album.name}
        </span>
        <span style={{ ...mono, fontSize: 10, color: 'hsl(var(--muted-foreground))', marginLeft: 4 }}>
          {files.length} photos
        </span>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'hsl(var(--muted-foreground))' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ ...mono, fontSize: 11 }}>Loading…</span>
        </div>
      ) : files.length === 0 ? (
        <div style={{ ...mono, fontSize: 11, color: 'hsl(var(--muted-foreground))', padding: 24 }}>
          This album is empty.
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <PhotoGrid
            groups={groups}
            onPhotoClick={(file, allFiles, idx) => setLightbox({ file, index: idx })}
          />
        </div>
      )}

      {lightbox && (
        <Lightbox
          file={lightbox.file}
          allFiles={files}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNav={i => setLightbox({ file: files[i], index: i })}
        />
      )}
    </>
  );
}

// ── Main viewer ───────────────────────────────────────────────────────────────

interface Props {
  onClose:     () => void;
  libraryPath: string;
}

export function MeridianViewer({ onClose, libraryPath }: Props) {
  const [view, setView]               = useState<View>('photos');
  const [files, setFiles]             = useState<MFile[]>([]);
  const [loading, setLoading]         = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MFile[] | null>(null);
  const [scanStatus, setScanStatus]   = useState<ScanStatus | null>(null);
  const [lightbox, setLightbox]       = useState<{ file: MFile; index: number } | null>(null);
  const [activeAlbum, setActiveAlbum] = useState<MAlbum | null>(null);
  const [offset, setOffset]           = useState(0);
  const [hasMore, setHasMore]         = useState(true);
  const LIMIT = 200;

  const groups = useMemo(
    () => groupByMonth(searchResults ?? files),
    [searchResults, files]
  );

  // ── Load files ─────────────────────────────────────────────────────────────

  const loadFiles = useCallback(async (reset = false) => {
    const off = reset ? 0 : offset;
    try {
      const data = await apiFetch<{ files: MFile[]; total: number }>(
        `/api/files?limit=${LIMIT}&offset=${off}&orderBy=taken_at`
      );
      setFiles(prev => reset ? data.files : [...prev, ...data.files]);
      setHasMore(off + data.files.length < data.total);
      setOffset(off + data.files.length);
    } catch { /* offline */ }
    setLoading(false);
  }, [offset]);

  useEffect(() => { loadFiles(true); }, []);

  // ── Poll scan status ────────────────────────────────────────────────────────

  useEffect(() => {
    const poll = async () => {
      try {
        const s = await apiFetch<ScanStatus>('/api/status');
        setScanStatus(s);
        if (s.scanPhase === 'indexing' || s.scanPhase === 'walking') {
          setTimeout(poll, 3_000);
        }
      } catch { /* offline */ }
    };
    poll();
  }, []);

  // ── Search ─────────────────────────────────────────────────────────────────

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ files: MFile[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        setSearchResults(data.files);
      } catch { setSearchResults([]); }
    }, 300);
  }, []);

  // ── Load more on scroll ────────────────────────────────────────────────────

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (!hasMore || searchResults) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadFiles();
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [hasMore, searchResults, loadFiles]);

  const isScanning = scanStatus?.scanPhase === 'walking'
    || scanStatus?.scanPhase === 'indexing'
    || scanStatus?.scanPhase === 'thumbing';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9500,
      background: '#07080a',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid #1e2430',
        background: 'hsl(var(--background))', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => { setView('photos'); setActiveAlbum(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: 5,
              border: 'none', cursor: 'pointer', borderRadius: 3, padding: '6px 10px',
              ...mono, fontSize: 11,
              color:       view === 'photos' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              background:  view === 'photos' ? 'rgba(255,255,255,.05)' : 'transparent' } as React.CSSProperties}>
            <Images size={12} /> PHOTOS
            {scanStatus && <span style={{ color: 'hsl(var(--secondary))' }}>{scanStatus.totalFiles}</span>}
          </button>
          <button
            onClick={() => { setView('albums'); setActiveAlbum(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: 5,
              border: 'none', cursor: 'pointer', borderRadius: 3, padding: '6px 10px',
              ...mono, fontSize: 11,
              color:      view === 'albums' || view === 'album-detail' ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
              background: view === 'albums' || view === 'album-detail' ? 'rgba(255,255,255,.05)' : 'transparent' } as React.CSSProperties}>
            <BookImage size={12} /> ALBUMS
          </button>
        </div>

        {/* Search — only shown in photos view */}
        {view === 'photos' && (
          <div style={{ flex: 1, position: 'relative', maxWidth: 320 }}>
            <Search size={12} color="#3a3f4a"
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} />
            <input
              value={searchQuery}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search photos…"
              style={{
                width: '100%', background: 'hsl(var(--card))', border: '1px solid #1e2430',
                borderRadius: 3, padding: '6px 10px 6px 26px', color: 'hsl(var(--foreground))',
                ...mono, fontSize: 11, outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        )}

        {/* Scan indicator */}
        {isScanning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'hsl(var(--muted-foreground))',
            marginLeft: 'auto' }}>
            <ScanLine size={12} style={{ animation: 'pulse 1.5s ease-in-out infinite' }} />
            <span style={{ ...mono, fontSize: 9 }}>
              INDEXING {scanStatus?.filesIndexed}
            </span>
          </div>
        )}

        <button
          onClick={onClose}
          style={{ marginLeft: 'auto', background: 'none', border: 'none',
            cursor: 'pointer', color: 'hsl(var(--muted-foreground))', padding: 4, display: 'flex' }}>
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      {view === 'photos' && (
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'hsl(var(--muted-foreground))' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ ...mono, fontSize: 11 }}>Loading library…</span>
            </div>
          ) : groups.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <FolderOpen size={32} color="#2a3040" style={{ margin: '0 auto 12px' }} />
              <div style={{ ...mono, fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>
                {searchQuery ? 'No results found.' : 'No photos found in library.'}
              </div>
              {!searchQuery && (
                <div style={{ ...mono, fontSize: 10, color: 'hsl(var(--secondary))', marginTop: 6 }}>
                  {libraryPath}
                </div>
              )}
            </div>
          ) : (
            <PhotoGrid
              groups={groups}
              onPhotoClick={(file, allFiles, idx) => setLightbox({ file, index: idx })}
            />
          )}
        </div>
      )}

      {view === 'albums' && !activeAlbum && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <AlbumsView
            onOpenAlbum={album => { setActiveAlbum(album); setView('album-detail'); }}
            onCreateAlbum={() => {
              const name = prompt('Album name:');
              if (!name?.trim()) return;
              apiPost('/api/albums', { name: name.trim() }).catch(() => {});
            }}
          />
        </div>
      )}

      {view === 'album-detail' && activeAlbum && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <AlbumDetailView
            album={activeAlbum}
            onBack={() => { setView('albums'); setActiveAlbum(null); }}
          />
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <Lightbox
          file={lightbox.file}
          allFiles={searchResults ?? files}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onNav={i => {
            const arr = searchResults ?? files;
            setLightbox({ file: arr[i], index: i });
          }}
        />
      )}

      <style>{`
        @keyframes spin    { from { transform: rotate(0deg); }   to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
      `}</style>
    </div>
  );
}
