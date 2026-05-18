/**
 * PolarisPlayer.tsx — PHOBOS Polaris Music Player
 *
 * Architecture:
 *   - Draggable floating widget (art + transport)
 *   - Expandable drawer: LIBRARY tab + NOW PLAYING tab
 *
 * Library modes: ARTISTS | ALBUMS | PLAYLISTS
 *   - ARTISTS: performers only (num_albums_as_performer > 0), click → albums, click → songs
 *   - ALBUMS:  all albums flat, click → songs
 *   - PLAYLISTS: saved playlists (Polaris API)
 *
 * Interactions per spec:
 *   - Single click: navigate into folder
 *   - Right click: go up a level (or delete playlist with confirm)
 *   - Double click: clear NP + add all recursively + play from top (or from song)
 *   - Hold left click + drag: scroll list
 *   - Hold left click (no drag): add recursively to end of NP, no playback change
 *
 * Now Playing:
 *   - Drag to reorder songs
 *   - Right click song: remove from NP  
 *   - Double click song: play from that song
 *   - Save playlist button
 *
 * API: /api/services/polaris/proxy/* (Bearer injected server-side)
 * Song fields: path, title, artists[], album_artists[], album, year,
 *              track_number, disc_number, duration, artwork
 */

import { useState, useEffect, useRef, useCallback, memo, type MouseEvent as RMouseEvent } from 'react';
import MasterEq from '@/components/audio/MasterEq';
import {
  usePolarisPlaybackStore,
  usePolarisStatusPolling,
  rehydratePolarisSession,
  type PolarisSong,
} from '@/store/usePolarisPlaybackStore';

// ── API ───────────────────────────────────────────────────────────────────────

// In dev, Vite proxies /api → localhost:3001 so a relative base works.
// In production (autarch.net), phobos-core is local — use the absolute URL.
const ENGINE_BASE = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/g, '');
const PROXY = ENGINE_BASE + '/api/services/polaris/proxy';
const V8    = { 'Accept-Version': '8' };

async function pget<T>(path: string): Promise<T> {
  const r = await fetch(`${PROXY}${path}`, { headers: V8 });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}
async function ppost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${PROXY}${path}`, {
    method: 'POST', headers: { ...V8, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}
async function pdel(path: string): Promise<void> {
  await fetch(`${PROXY}${path}`, { method: 'DELETE', headers: V8 });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Song {
  path:         string;
  title?:       string;
  artists?:     string[];
  album_artists?: string[];
  album?:       string;
  year?:        number;
  track_number?: number;
  disc_number?:  number;
  duration?:    number;
  artwork?:     string;
}

interface ApiArtist {
  name:                         string;
  num_albums_as_performer:      number;
  num_albums_as_additional_performer: number;
  num_songs:                    number;
}

interface ApiAlbum {
  name:         string;
  artwork?:     string;
  main_artists: string[];
  year?:        number;
}

interface ApiPlaylist {
  name: string;
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fmt(secs?: number): string {
  if (!secs) return '0:00';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function fmtTotal(secs: number): string {
  if (secs < 3600) return fmt(secs);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}
function songName(s: Song): string {
  return s.title || s.path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') || s.path;
}
function songArtist(s: Song): string {
  return (s.artists ?? s.album_artists ?? [])[0] ?? '';
}
function thumbUrl(p: string): string {
  return `${PROXY}/api/thumbnail/${encodeURIComponent(p)}?size=small`;
}
async function fetchSongs(paths: string[]): Promise<Song[]> {
  if (!paths.length) return [];
  // Polaris 0.16: POST /api/songs with { paths: string[] } body
  const chunks: Song[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const r = await fetch(`${PROXY}/api/songs`, {
      method: 'POST',
      headers: { ...V8, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: batch }),
    }).catch(() => null);
    if (!r?.ok) continue;
    const data = await r.json() as { songs: Song[] };
    chunks.push(...(data.songs ?? []));
  }
  return chunks;
}
async function flattenPath(path?: string): Promise<string[]> {
  // Encode each segment separately so path separators stay as literal '/',
  // not '%2F'. Polaris rejects %2F-encoded slashes in the path param.
  const qs = path
    ? '?path=' + path.split('/').map(encodeURIComponent).join('/')
    : '';
  const data = await pget<{ paths: string[] }>(`/api/flatten${qs}`);
  return data.paths ?? [];
}

// ── Mono CSS vars ─────────────────────────────────────────────────────────────
const M: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };
const amber  = '#f59e0b';
const blue   = '#3b82f6';
const dim    = 'hsl(var(--muted-foreground))';
const bg     = 'hsl(var(--background))';
const bg2    = 'hsl(var(--card))';
const border = 'hsl(var(--border))';

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxItem { label: string; action: () => void; danger?: boolean }
interface CtxMenu { x: number; y: number; items: CtxItem[] }

function ContextMenu({ menu, onClose }: { menu: CtxMenu; onClose: () => void }) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener('click', h, { once: true });
    window.addEventListener('contextmenu', h, { once: true });
    return () => { window.removeEventListener('click', h); window.removeEventListener('contextmenu', h); };
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 99999,
      background: bg2, border: `1px solid ${border}`, borderRadius: 4,
      boxShadow: '0 8px 32px rgba(0,0,0,.8)', minWidth: 160, ...M, fontSize: 11 }}>
      {menu.items.map((item, i) => (
        <div key={i} onClick={e => { e.stopPropagation(); item.action(); onClose(); }}
          style={{ padding: '7px 14px', cursor: 'pointer', borderBottom: i < menu.items.length - 1 ? `1px solid ${border}` : 'none',
            color: item.danger ? '#ef4444' : 'hsl(var(--foreground))', transition: 'background .1s' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#1a1f2a')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ── Save Playlist Dialog ──────────────────────────────────────────────────────

function SaveDialog({ existing, onSave, onClose }: {
  existing: string[];
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99990, background: 'rgba(0,0,0,.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: bg2, border: `1px solid ${border}`, borderRadius: 6,
        padding: '20px 24px', minWidth: 280, boxShadow: '0 16px 48px rgba(0,0,0,.9)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ ...M, fontSize: 11, color: amber, letterSpacing: '.1em', marginBottom: 12 }}>
          SAVE PLAYLIST
        </div>
        {existing.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ ...M, fontSize: 9, color: dim, marginBottom: 6 }}>OVERWRITE EXISTING</div>
            {existing.map(n => (
              <div key={n} onClick={() => { onSave(n); onClose(); }}
                style={{ padding: '5px 8px', cursor: 'pointer', ...M, fontSize: 11, color: 'hsl(var(--foreground))',
                  borderRadius: 3, transition: 'background .1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1a1f2a')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                {n}
              </div>
            ))}
            <div style={{ height: 1, background: border, margin: '8px 0' }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="New playlist name…"
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onSave(name.trim()); onClose(); } }}
            style={{ flex: 1, background: bg, border: `1px solid #2a2f3a`, borderRadius: 3,
              padding: '6px 8px', color: 'hsl(var(--foreground))', ...M, fontSize: 11, outline: 'none' }} />
          <button onClick={() => { if (name.trim()) { onSave(name.trim()); onClose(); } }}
            style={{ background: amber, color: '#07080a', border: 'none', borderRadius: 3,
              padding: '6px 12px', cursor: 'pointer', ...M, fontSize: 11, fontWeight: 700 }}>
            SAVE
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Library Panel ─────────────────────────────────────────────────────────────

type LibMode = 'artists' | 'albums' | 'playlists';

interface LibState {
  mode:      LibMode;
  // ARTISTS drill-down
  artist:    ApiArtist | null;      // null = root, set = viewing albums for this artist
  artistAlbum: { album: ApiAlbum; songs: Song[] } | null; // set = viewing songs
  // ALBUMS drill-down
  openAlbum: { album: ApiAlbum; songs: Song[] } | null;
  // PLAYLISTS drill-down
  openPl:    { name: string; songs: Song[] } | null;
}

function LibraryPanel({
  onPlayNow, onAddToNP, playlists, refreshPlaylists,
}: {
  onPlayNow:        (songs: Song[], idx: number) => void;
  onAddToNP:        (songs: Song[]) => void;
  playlists:        ApiPlaylist[];
  refreshPlaylists: () => void;
}) {
  const [artists,  setArtists]  = useState<ApiArtist[]>([]);
  const [albums,   setAlbums]   = useState<ApiAlbum[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [ctx,      setCtx]      = useState<CtxMenu | null>(null);
  const [state,    setState]    = useState<LibState>({
    mode: 'artists', artist: null, artistAlbum: null, openAlbum: null, openPl: null,
  });

  // Cache of all library paths (full flatten, no filter). Populated once on first
  // use and reused for all album/artist lookups — avoids repeated full-library calls
  // and sidesteps Polaris's broken ?path= filtering on the flatten endpoint.
  const allPathsRef = useRef<string[] | null>(null);
  const getAllPaths = useCallback(async (): Promise<string[]> => {
    if (allPathsRef.current) return allPathsRef.current;
    const paths = await flattenPath();          // no arg = whole library
    allPathsRef.current = paths;
    return paths;
  }, []);

  // ── Load root data ──────────────────────────────────────────────────────────
  const loadArtists = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await pget<ApiArtist[]>('/api/artists?offset=0&count=9999');
      // Only performers (num_albums_as_performer > 0)
      setArtists(raw.filter(a => a.num_albums_as_performer > 0).sort((a, b) => a.name.localeCompare(b.name)));
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  const loadAlbums = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await pget<ApiAlbum[]>('/api/albums?random=false&offset=0&count=9999');
      setAlbums(raw.sort((a, b) => a.name.localeCompare(b.name)));
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (state.mode === 'artists' && artists.length === 0 && !loading) loadArtists();
    if (state.mode === 'albums'  && albums.length  === 0 && !loading) loadAlbums();
  }, [state.mode]);

  // ── Load songs for an album ─────────────────────────────────────────────────
  const loadAlbumSongs = useCallback(async (album: ApiAlbum): Promise<Song[]> => {
    const sort = (songs: Song[]) => songs.sort((a, b) => {
      if ((a.disc_number ?? 1) !== (b.disc_number ?? 1)) return (a.disc_number ?? 1) - (b.disc_number ?? 1);
      return (a.track_number ?? 0) - (b.track_number ?? 0);
    });

    const allPaths = await getAllPaths();
    const norm     = (p: string) => p.replace(/\\/g, '/');

    // ── Strategy 1: derive album dir from artwork path (fast, works when Polaris
    //   returns artwork). Pop the filename, keep the directory prefix.
    if (album.artwork) {
      try {
        const parts    = norm(album.artwork).split('/');
        parts.pop();
        const albumDir = parts.join('/') + '/';
        const paths    = allPaths.filter(p => norm(p).startsWith(albumDir));
        if (paths.length > 0) {
          const songs = await fetchSongs(paths);
          return sort(songs);
        }
      } catch(e) { console.error('[loadAlbumSongs] artwork strategy failed', e); }
    }

    // ── Strategy 2: match songs by album + artist metadata. Used when artwork
    //   is missing (broken UTF-8 tags, cover.jpg absent) or the artwork path
    //   doesn\'t share a directory with the tracks. Fetch all songs whose
    //   \'album\' field matches and whose artist is in main_artists.
    try {
      const albumNameLower   = album.name.toLowerCase();
      const mainArtistsLower = album.main_artists.map(a => a.toLowerCase());

      const matched = allPaths.filter(p => {
        const pNorm = norm(p).toLowerCase();
        // Quick pre-filter on path segments before paying for a full fetchSongs call.
        return albumNameLower.split(' ').some(word => word.length > 3 && pNorm.includes(word));
      });

      if (matched.length > 0) {
        const songs = await fetchSongs(matched);
        const filtered = songs.filter(s => {
          const sAlbum   = (s.album ?? '').toLowerCase();
          const sArtists = [...(s.artists ?? []), ...(s.album_artists ?? [])].map(a => a.toLowerCase());
          const albumMatch  = sAlbum === albumNameLower;
          const artistMatch = mainArtistsLower.length === 0 ||
            mainArtistsLower.some(a => sArtists.some(sa => sa.includes(a) || a.includes(sa)));
          return albumMatch && artistMatch;
        });
        if (filtered.length > 0) return sort(filtered);
      }
    } catch(e) { console.error('[loadAlbumSongs] metadata strategy failed', e); }

    return [];
  }, [getAllPaths]);

  // ── Load albums for an artist ───────────────────────────────────────────────
  const [artistAlbums, setArtistAlbums] = useState<ApiAlbum[]>([]);
  const loadArtistAlbums = useCallback(async (artist: ApiArtist) => {
    setLoading(true);
    try {
      // Get all albums and filter by this artist's name in main_artists
      const all = await pget<ApiAlbum[]>('/api/albums?random=false&offset=0&count=9999');
      const filtered = all.filter(a =>
        a.main_artists.some(m => m.toLowerCase() === artist.name.toLowerCase())
      ).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      setArtistAlbums(filtered);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, []);

  // ── Navigate ────────────────────────────────────────────────────────────────
  const goBack = useCallback(() => {
    setState(s => {
      if (s.artistAlbum) return { ...s, artistAlbum: null };
      if (s.artist)      return { ...s, artist: null };
      if (s.openAlbum)   return { ...s, openAlbum: null };
      if (s.openPl)      return { ...s, openPl: null };
      return s;
    });
  }, []);

  const clickArtist = useCallback((artist: ApiArtist) => {
    setState(s => ({ ...s, artist }));
    loadArtistAlbums(artist);
  }, [loadArtistAlbums]);

  const clickAlbum = useCallback(async (album: ApiAlbum) => {
    setLoading(true);
    const songs = await loadAlbumSongs(album);
    setState(s => ({ ...s, artistAlbum: { album, songs }, openAlbum: { album, songs } }));
    setLoading(false);
  }, [loadAlbumSongs]);

  const dblClickArtist = useCallback(async (artist: ApiArtist) => {
    setLoading(true);
    try {
      const needle   = artist.name.toLowerCase();
      const allPaths = await getAllPaths();
      const songs    = await fetchSongs(
        allPaths.filter(p => p.replace(/\\/g, '/').toLowerCase().includes(needle))
      );
      songs.sort((a, b) => {
        const aAlb = a.album ?? '';
        const bAlb = b.album ?? '';
        if (aAlb !== bAlb) return aAlb.localeCompare(bAlb);
        if ((a.disc_number ?? 1) !== (b.disc_number ?? 1)) return (a.disc_number ?? 1) - (b.disc_number ?? 1);
        return (a.track_number ?? 0) - (b.track_number ?? 0);
      });
      onPlayNow(songs, 0);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, [getAllPaths, onPlayNow]);

  const dblClickAlbum = useCallback(async (album: ApiAlbum) => {
    const songs = await loadAlbumSongs(album);
    onPlayNow(songs, 0);
  }, [loadAlbumSongs, onPlayNow]);

  const holdClickAlbum = useCallback(async (album: ApiAlbum) => {
    const songs = await loadAlbumSongs(album);
    onAddToNP(songs);
  }, [loadAlbumSongs, onAddToNP]);

  const deletePlaylist = useCallback(async (name: string) => {
    await pdel(`/api/playlist/${encodeURIComponent(name)}`);
    refreshPlaylists();
  }, [refreshPlaylists]);

  // ── Row ─────────────────────────────────────────────────────────────────────
  const [hov, setHov] = useState<string | null>(null);
  const rowStyle = (id: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
    cursor: 'pointer', background: hov === id ? '#1a1f2a' : 'transparent', transition: 'background .1s',
  });

  // ── Hold-click detection (>400ms = hold, <400ms = click) ─────────────────
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didHold   = useRef(false);
  const onPressStart = useCallback((onHold: () => void) => (e: RMouseEvent) => {
    if (e.button !== 0) return;
    didHold.current = false;
    holdTimer.current = setTimeout(() => {
      didHold.current = true;
      onHold();
    }, 400);
  }, []);
  const onPressEnd = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);

  // ── Render helpers ──────────────────────────────────────────────────────────
  const breadcrumb = (): string => {
    if (state.mode === 'artists') {
      if (state.artistAlbum) return `${state.artist?.name} / ${state.artistAlbum.album.name}`;
      if (state.artist)      return state.artist.name;
      return 'ARTISTS';
    }
    if (state.mode === 'albums') {
      if (state.openAlbum) return state.openAlbum.album.name;
      return 'ALBUMS';
    }
    if (state.mode === 'playlists') {
      if (state.openPl) return state.openPl.name;
      return 'PLAYLISTS';
    }
    return '';
  };

  const canGoBack = state.artist || state.artistAlbum || state.openAlbum || state.openPl;

  // ── Album row ───────────────────────────────────────────────────────────────
  const AlbumRow = ({ album, id }: { album: ApiAlbum; id: string }) => {
    const totalDur = 0; // unknown without loading songs
    return (
      <div id={id} style={rowStyle(id)} onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov(null)}
        onMouseDown={onPressStart(() => holdClickAlbum(album))}
        onMouseUp={onPressEnd}
        onClick={() => { if (!didHold.current) clickAlbum(album); }}
        onDoubleClick={() => dblClickAlbum(album)}
        onContextMenu={e => { e.preventDefault(); goBack(); }}>
        <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 2, overflow: 'hidden',
          background: 'hsl(var(--border))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {album.artwork
            ? <img src={thumbUrl(album.artwork)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
            : <span style={{ fontSize: 16, color: 'hsl(var(--secondary))' }}>♪</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...M, fontSize: 11, color: 'hsl(var(--foreground))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {album.name}
          </div>
          <div style={{ ...M, fontSize: 10, color: dim }}>
            {album.year ?? '—'}
          </div>
        </div>
      </div>
    );
  };

  // ── Song row ────────────────────────────────────────────────────────────────
  const SongRow = ({ song, idx, songs, id }: { song: Song; idx: number; songs: Song[]; id: string }) => (
    <div id={id} style={rowStyle(id)} onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov(null)}
      onDoubleClick={() => onPlayNow(songs, idx)}
      onMouseDown={onPressStart(() => onAddToNP([song]))}
      onMouseUp={onPressEnd}
      onContextMenu={e => { e.preventDefault(); goBack(); }}>
      <div style={{ width: 22, textAlign: 'right', flexShrink: 0, ...M, fontSize: 10, color: 'hsl(var(--secondary))' }}>
        {song.track_number ?? idx + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...M, fontSize: 11, color: 'hsl(var(--foreground))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {songName(song)}
        </div>
      </div>
      <div style={{ ...M, fontSize: 10, color: dim, flexShrink: 0 }}>{fmt(song.duration)}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Mode tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
        {(['artists', 'albums', 'playlists'] as LibMode[]).map(m => (
          <button key={m} onClick={() => setState({ mode: m, artist: null, artistAlbum: null, openAlbum: null, openPl: null })}
            style={{ flex: 1, padding: '7px 0', background: 'none', border: 'none',
              borderBottom: state.mode === m ? `2px solid ${amber}` : '2px solid transparent',
              color: state.mode === m ? amber : dim,
              cursor: 'pointer', ...M, fontSize: 10, letterSpacing: '.1em', transition: 'color .15s' }}>
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Breadcrumb back button */}
      {canGoBack && (
        <div onClick={goBack} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
          borderBottom: `1px solid ${border}`, cursor: 'pointer', flexShrink: 0,
          color: blue, ...M, fontSize: 10 }}
          onContextMenu={e => { e.preventDefault(); setState(s => ({ ...s, artist: null, artistAlbum: null, openAlbum: null, openPl: null })); }}>
          <span>◄</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{breadcrumb()}</span>
        </div>
      )}

      {/* Content */}
      <div className="polaris-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: 16, ...M, fontSize: 10, color: dim }}>LOADING…</div>
        )}

        {/* ARTISTS ROOT */}
        {!loading && state.mode === 'artists' && !state.artist && (
          artists.map(artist => (
            <div key={artist.name} style={rowStyle(artist.name)}
              onMouseEnter={() => setHov(artist.name)} onMouseLeave={() => setHov(null)}
              onClick={() => clickArtist(artist)}
              onDoubleClick={() => dblClickArtist(artist)}
              onContextMenu={e => { e.preventDefault(); /* already at root */ }}>
              <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%',
                background: 'hsl(var(--border))', display: 'flex', alignItems: 'center', justifyContent: 'center',
                ...M, fontSize: 11, color: dim }}>
                {artist.name.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...M, fontSize: 11, color: 'hsl(var(--foreground))', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {artist.name}
                </div>
                <div style={{ ...M, fontSize: 10, color: dim }}>
                  {artist.num_albums_as_performer} album{artist.num_albums_as_performer !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
          ))
        )}

        {/* ARTISTS → ALBUMS */}
        {!loading && state.mode === 'artists' && state.artist && !state.artistAlbum && (
          artistAlbums.map(album => (
            <AlbumRow key={album.name} album={album} id={`a-${album.name}`} />
          ))
        )}

        {/* ARTISTS → ALBUM → SONGS */}
        {!loading && state.mode === 'artists' && state.artistAlbum && (
          state.artistAlbum.songs.map((song, idx) => (
            <SongRow key={song.path} song={song} idx={idx}
              songs={state.artistAlbum!.songs} id={`s-${song.path}`} />
          ))
        )}

        {/* ALBUMS ROOT */}
        {!loading && state.mode === 'albums' && !state.openAlbum && (
          albums.map(album => (
            <AlbumRow key={album.name} album={album} id={`al-${album.name}`} />
          ))
        )}

        {/* ALBUMS → SONGS */}
        {!loading && state.mode === 'albums' && state.openAlbum && (
          state.openAlbum.songs.map((song, idx) => (
            <SongRow key={song.path} song={song} idx={idx}
              songs={state.openAlbum!.songs} id={`as-${song.path}`} />
          ))
        )}

        {/* PLAYLISTS ROOT */}
        {!loading && state.mode === 'playlists' && !state.openPl && (
          playlists.length === 0
            ? <div style={{ padding: '16px 10px', ...M, fontSize: 10, color: 'hsl(var(--secondary))' }}>NO PLAYLISTS</div>
            : playlists.map(pl => (
              <div key={pl.name} style={rowStyle(`pl-${pl.name}`)}
                onMouseEnter={() => setHov(`pl-${pl.name}`)} onMouseLeave={() => setHov(null)}
                onClick={async () => {
                  setLoading(true);
                  try {
                    const data = await pget<{ songs: Song[] }>(`/api/playlist/${encodeURIComponent(pl.name)}`);
                    setState(s => ({ ...s, openPl: { name: pl.name, songs: data.songs ?? [] } }));
                  } catch(e) { console.error(e); }
                  setLoading(false);
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  setCtx({ x: e.clientX, y: e.clientY, items: [
                    { label: `Delete "${pl.name}"`, danger: true, action: () => {
                      if (confirm(`Delete playlist "${pl.name}"?`)) deletePlaylist(pl.name);
                    }},
                  ]});
                }}>
                <span style={{ fontSize: 14, color: blue }}>☰</span>
                <div style={{ flex: 1, ...M, fontSize: 11, color: 'hsl(var(--foreground))',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pl.name}</div>
              </div>
            ))
        )}

        {/* PLAYLISTS → SONGS */}
        {!loading && state.mode === 'playlists' && state.openPl && (
          state.openPl.songs.map((song, idx) => (
            <SongRow key={song.path} song={song} idx={idx}
              songs={state.openPl!.songs} id={`ps-${song.path}`} />
          ))
        )}
      </div>

      {ctx && <ContextMenu menu={ctx} onClose={() => setCtx(null)} />}
    </div>
  );
}

// ── Now Playing Panel ─────────────────────────────────────────────────────────

function NowPlayingPanel({
  queue, queueIdx, playing, duration,
  onPlayIdx, onRemove, onReorder, playlists, onSavePlaylist,
}: {
  queue:          Song[];
  queueIdx:       number;
  playing:        boolean;
  duration:       number;
  onPlayIdx:      (idx: number) => void;
  onRemove:       (idx: number) => void;
  onReorder:      (from: number, to: number) => void;
  playlists:      ApiPlaylist[];
  onSavePlaylist: (name: string) => void;
}) {
  // Isolated subscription — position ticks every 100ms but only re-renders this panel.
  const progress = usePolarisPlaybackStore((s) => s.positionSec);
  const [ctx,       setCtx]       = useState<CtxMenu | null>(null);
  const [saveOpen,  setSaveOpen]  = useState(false);
  const [hov,       setHov]       = useState<number | null>(null);
  const dragFrom    = useRef<number | null>(null);

  const totalDur = queue.reduce((s, q) => s + (q.duration ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px', borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
        <div style={{ ...M, fontSize: 10, color: dim }}>
          {queue.length} TRACKS · {fmtTotal(totalDur)}
        </div>
        <button onClick={() => setSaveOpen(true)} title="Save playlist"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: dim, fontSize: 14,
            transition: 'color .1s', padding: 2 }}
          onMouseEnter={e => (e.currentTarget.style.color = amber)}
          onMouseLeave={e => (e.currentTarget.style.color = dim)}>
          💾
        </button>
      </div>

      {/* Song list */}
      <div className="polaris-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
        {queue.length === 0 && (
          <div style={{ padding: '16px 10px', ...M, fontSize: 10, color: 'hsl(var(--secondary))' }}>
            QUEUE IS EMPTY
          </div>
        )}
        {queue.map((song, idx) => {
          const isCurrent = idx === queueIdx;
          const artSrc = song.artwork ? thumbUrl(song.artwork) : null;
          return (
            <div key={`${song.path}-${idx}`}
              draggable
              onDragStart={() => { dragFrom.current = idx; }}
              onDragOver={e => e.preventDefault()}
              onDrop={() => { if (dragFrom.current !== null && dragFrom.current !== idx) {
                onReorder(dragFrom.current, idx); dragFrom.current = null;
              }}}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
                cursor: 'pointer', background: isCurrent ? 'rgba(59,130,246,.08)' : hov === idx ? '#1a1f2a' : 'transparent',
                transition: 'background .1s', borderLeft: isCurrent ? `2px solid ${blue}` : '2px solid transparent' }}
              onMouseEnter={() => setHov(idx)} onMouseLeave={() => setHov(null)}
              onDoubleClick={() => onPlayIdx(idx)}
              onContextMenu={e => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, items: [
                  { label: 'Remove from queue', action: () => onRemove(idx) },
                ]});
              }}>
              {/* Art / playing indicator */}
              <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 2, overflow: 'hidden',
                background: 'hsl(var(--border))', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                {artSrc && <img src={artSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />}
                {isCurrent && (
                  <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: playing ? blue : amber }}>
                    {playing ? '▶' : '⏸'}
                  </div>
                )}
                {!artSrc && !isCurrent && <span style={{ fontSize: 12, color: 'hsl(var(--secondary))' }}>♪</span>}
              </div>
              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ ...M, fontSize: 10, color: dim, flexShrink: 0 }}>{fmt(song.duration)}</span>
                  <span style={{ ...M, fontSize: 11, color: isCurrent ? '#e8edf5' : 'hsl(var(--foreground))',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    fontWeight: isCurrent ? 700 : 400 }}>
                    {songName(song)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ ...M, fontSize: 10, color: 'hsl(var(--secondary))', flexShrink: 0 }}>
                    {song.track_number && song.album ? `${song.track_number}` : ''}
                  </span>
                  <span style={{ ...M, fontSize: 10, color: dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {songArtist(song)}
                  </span>
                </div>
              </div>
              {/* Progress bar for current */}
              {isCurrent && duration > 0 && (
                <div style={{ width: 3, height: 28, flexShrink: 0, background: 'hsl(var(--secondary))', borderRadius: 1, overflow: 'hidden' }}>
                  <div style={{ width: '100%', height: `${(progress / duration) * 100}%`,
                    background: `linear-gradient(180deg, ${blue}, ${amber})`, transition: 'height .25s linear' }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ctx && <ContextMenu menu={ctx} onClose={() => setCtx(null)} />}
      {saveOpen && (
        <SaveDialog
          existing={playlists.map(p => p.name)}
          onSave={onSavePlaylist}
          onClose={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

// ── Transport button ──────────────────────────────────────────────────────────

function TBtn({ label, onClick, active, title }: { label: string; onClick: () => void; active?: boolean; title?: string }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px',
        color: active ? amber : hov ? 'hsl(var(--foreground))' : dim, fontSize: 14, lineHeight: 1,
        transition: 'color .1s', userSelect: 'none' as const }}>
      {label}
    </button>
  );
}

// ── Main Player ───────────────────────────────────────────────────────────────

// ── Transport sub-components (memoized) ────────────────────────────────────
//
// These subscribe to positionSec / durationSec / volume from the store
// directly so the 100ms polling updates only re-render these tiny components,
// never the library panel or album rows.

const TransportProgress = memo(({ fmt }: { fmt: (s: number) => string }) => {
  const positionSec = usePolarisPlaybackStore((s) => s.positionSec);
  const durationSec = usePolarisPlaybackStore((s) => s.durationSec);
  return (
    <div style={{ fontFamily: 'monospace', fontSize: 9, color: 'hsl(var(--secondary))' }}>
      {fmt(positionSec)} / {fmt(durationSec)}
    </div>
  );
});
TransportProgress.displayName = 'TransportProgress';

const TransportSeekbar = memo(({ onSeek, amber }: {
  onSeek: (e: React.MouseEvent<HTMLDivElement>) => void;
  amber:  string;
}) => {
  const positionSec = usePolarisPlaybackStore((s) => s.positionSec);
  const durationSec = usePolarisPlaybackStore((s) => s.durationSec);
  const blue = '#3b82f6';
  const pct  = durationSec ? (positionSec / durationSec) * 100 : 0;
  return (
    <div onClick={onSeek} style={{ margin: '0 10px 6px', height: 3,
      background: 'hsl(var(--secondary))', cursor: 'pointer', borderRadius: 0, position: 'relative' }}>
      <div style={{ height: '100%', width: `${pct}%`,
        background: `linear-gradient(90deg, ${blue}, ${amber})`,
        transition: 'width .25s linear' }} />
    </div>
  );
});
TransportSeekbar.displayName = 'TransportSeekbar';

const TransportVolume = memo(({ amber, dim, onSetVolume }: {
  amber:       string;
  dim:         string;
  onSetVolume: (g: number) => Promise<void>;
}) => {
  const volume = usePolarisPlaybackStore((s) => s.volume);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 10px 4px' }}>
      <span style={{ fontSize: 9, color: dim, fontFamily: 'monospace', userSelect: 'none' }}>VOL</span>
      <input
        type="range" min={0} max={1} step={0.02} value={volume}
        onChange={(e) => { void onSetVolume(parseFloat(e.target.value)); }}
        style={{ flex: 1, accentColor: amber, height: 2, cursor: 'pointer' }}
        aria-label="Volume"
      />
      <span style={{ fontSize: 9, color: dim, fontFamily: 'monospace',
        minWidth: 24, textAlign: 'right', userSelect: 'none' }}>
        {Math.round(volume * 100)}%
      </span>
    </div>
  );
});
TransportVolume.displayName = 'TransportVolume';


export default function PolarisPlayer() {
  // Position / drag
  const [pos, setPos] = useState({ x: 80, y: 56 });
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  // ── Playback (driven by usePolarisPlaybackStore — host-side audio) ─────
  //
  // Local state is gone. The store mirrors what the host's FilePlayerNode
  // is doing; both this surface and the docked sidebar player read from it,
  // so toggling between them is a no-op for actual playback.
  const queue       = usePolarisPlaybackStore((s) => s.queue);
  const queueIdx    = usePolarisPlaybackStore((s) => s.queueIdx);
  const playing     = usePolarisPlaybackStore((s) => s.playing);
  const durationSec = usePolarisPlaybackStore((s) => s.durationSec);
  const shuffle     = usePolarisPlaybackStore((s) => s.shuffle);
  const repeat      = usePolarisPlaybackStore((s) => s.repeat);
  const view        = usePolarisPlaybackStore((s) => s.view);

  const playQueue       = usePolarisPlaybackStore((s) => s.playQueue);
  const enqueueStore    = usePolarisPlaybackStore((s) => s.enqueue);
  const removeFromQueueStore = usePolarisPlaybackStore((s) => s.removeFromQueue);
  const reorderQueueStore    = usePolarisPlaybackStore((s) => s.reorderQueue);
  const togglePlay      = usePolarisPlaybackStore((s) => s.togglePlay);
  const skipStore       = usePolarisPlaybackStore((s) => s.skip);
  const seekStore       = usePolarisPlaybackStore((s) => s.seek);
  const setShuffleStore = usePolarisPlaybackStore((s) => s.setShuffle);
  const setRepeatStore  = usePolarisPlaybackStore((s) => s.setRepeat);
  const toggleDockFloat = usePolarisPlaybackStore((s) => s.toggleDockFloat);
  const volume          = usePolarisPlaybackStore((s) => s.volume);
  const setVolumeStore  = usePolarisPlaybackStore((s) => s.setVolume);

  // The dock and the floating window each call this. Both safe to mount —
  // the polling hook is keyed on audioId, so duplicates are harmless. Only
  // one surface renders at a time anyway because of the `view` mutex.
  usePolarisStatusPolling(100);

  // Rehydrate from backend once on mount so a page refresh during playback
  // restores the queue and reconnects to the in-flight audioId.
  useEffect(() => { void rehydratePolarisSession(); }, []);

  const [artError, setArtError] = useState(false);
  const [eqOpen,   setEqOpen]   = useState(false);

  // UI
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab,  setActiveTab]  = useState<'library' | 'nowplaying'>('library');
  const [playlists,  setPlaylists]  = useState<ApiPlaylist[]>([]);

  const current = queue[queueIdx];

  // Reset artwork-error flag when the active song changes.
  useEffect(() => { setArtError(false); }, [current?.path]);

  // Load playlists
  const loadPlaylists = useCallback(async () => {
    try {
      const data = await pget<ApiPlaylist[]>('/api/playlists');
      setPlaylists(Array.isArray(data) ? data : []);
    } catch { setPlaylists([]); }
  }, []);
  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

  // ── Transport handlers ─────────────────────────────────────────────────

  const playPause = useCallback(() => { void togglePlay(); }, [togglePlay]);

  const seek = useCallback((e: RMouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    void seekStore(frac * durationSec * 1000);
  }, [durationSec, seekStore]);

  const advance = useCallback((dir: 1 | -1) => { void skipStore(dir); }, [skipStore]);

  // Queue management — delegates to the store. Local UI handlers keep their
  // signatures so the existing JSX for library/now-playing tabs doesn't have
  // to change.
  const playNow = useCallback((songs: Song[], idx: number) => {
    void playQueue(songs as PolarisSong[], idx);
    setDrawerOpen(false);
  }, [playQueue]);

  const addToNP = useCallback((songs: Song[]) => {
    enqueueStore(songs as PolarisSong[]);
  }, [enqueueStore]);

  const removeFromNP = useCallback((idx: number) => {
    removeFromQueueStore(idx);
  }, [removeFromQueueStore]);

  const setShuffle = useCallback((s: boolean) => setShuffleStore(s), [setShuffleStore]);
  const setRepeat  = useCallback((r: 'none' | 'one' | 'all') => setRepeatStore(r), [setRepeatStore]);

  // Compatibility shims: the existing JSX references these names. Map them
  // onto the store-derived values without renaming a hundred call sites.

  const reorderNP = useCallback((from: number, to: number) => {
    reorderQueueStore(from, to);
  }, [reorderQueueStore]);

  const savePlaylist = useCallback(async (name: string) => {
    try {
      // Check if exists — if so, use PUT, else POST
      const existing = playlists.find(p => p.name === name);
      if (existing) {
        await ppost(`/api/playlist/${encodeURIComponent(name)}`, { songs: queue.map(s => s.path) });
      } else {
        await ppost('/api/playlists', { name, songs: queue.map(s => s.path) });
      }
      loadPlaylists();
    } catch(e) { console.error(e); }
  }, [queue, playlists, loadPlaylists]);

  // Drag logic
  const onMouseDown = useCallback((e: RMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: dragRef.current.px + e.clientX - dragRef.current.ox,
               y: dragRef.current.py + e.clientY - dragRef.current.oy });
    };
    const up = (e: globalThis.MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;

      // Drop-to-dock: if the mouse-up point lands inside the sidebar's
      // dock area, collapse the floating window into the dock. Reads the
      // dock's bounding rect via DOM id rather than passing it through a
      // store — the dock either exists in the layout or it doesn't, and
      // querying once on drop is cheaper than re-rendering when its rect
      // changes.
      const dockEl = document.getElementById('polaris-dock');
      if (dockEl) {
        const r = dockEl.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right
         && e.clientY >= r.top  && e.clientY <= r.bottom) {
          toggleDockFloat();
        }
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [toggleDockFloat]);

  const artSrc = current?.artwork ? thumbUrl(current.artwork) : null;

  // Hidden via CSS rather than unmount so drag position + drawer state
  // survive dock↔float toggles. The dock takes over rendering when this is
  // hidden; both surfaces share the playback store so audio is unaffected.
  const hidden = view !== 'floating';

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        .polaris-scrollbar::-webkit-scrollbar { width: 4px; }
        .polaris-scrollbar::-webkit-scrollbar-track { background: #0d0f12; }
        .polaris-scrollbar::-webkit-scrollbar-thumb { background: #2a3040; border-radius: 0; }
        .polaris-scrollbar::-webkit-scrollbar-thumb:hover { background: #3b82f6; }
      `}</style>

      <div style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9000,
        userSelect: 'none', filter: 'drop-shadow(0 8px 32px rgba(0,0,0,.8))',
        display: hidden ? 'none' : 'block' }}>

        {/* ── Main widget ── */}
        <div onMouseDown={onMouseDown} style={{
          width: 320, background: bg, border: `1px solid ${border}`,
          borderBottom: drawerOpen ? 'none' : `1px solid ${border}`,
          borderRadius: drawerOpen ? '4px 4px 0 0' : 4,
          cursor: dragRef.current ? 'grabbing' : 'grab',
        }}>
          {/* Title bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '5px 10px', borderBottom: `1px solid #1a1f28`,
            background: `linear-gradient(180deg, ${bg2} 0%, ${bg} 100%)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: amber, boxShadow: `0 0 6px ${amber}` }} />
              <span style={{ ...M, color: dim, fontSize: 9, letterSpacing: '.15em' }}>POLARIS</span>
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {(['none', 'one', 'all'] as const).map(r => (
                <button key={r} onClick={() => setRepeat(r)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px',
                    color: repeat === r ? amber : 'hsl(var(--secondary))', fontSize: 9, ...M,
                    letterSpacing: '.05em', transition: 'color .1s' }}>
                  {r === 'none' ? '—' : r === 'one' ? 'R1' : 'R∞'}
                </button>
              ))}
              {/* Dock button — collapses the floating window to the sidebar dock. */}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setEqOpen(o => !o)}
                title="Master EQ"
                style={{ background: eqOpen ? 'rgba(245,158,11,.15)' : 'none',
                  border: 'none', cursor: 'pointer', padding: '1px 4px',
                  color: eqOpen ? amber : '#5a6478', fontSize: 10, ...M,
                  marginLeft: 2, transition: 'color .1s' }}
                onMouseEnter={e => (e.currentTarget.style.color = amber)}
                onMouseLeave={e => (e.currentTarget.style.color = eqOpen ? amber : '#5a6478')}
              >EQ</button>
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => toggleDockFloat()}
                title="Dock to sidebar"
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  padding: '1px 4px', color: '#5a6478', fontSize: 11, ...M,
                  marginLeft: 4, transition: 'color .1s' }}
                onMouseEnter={e => (e.currentTarget.style.color = amber)}
                onMouseLeave={e => (e.currentTarget.style.color = '#5a6478')}
              >▾</button>
            </div>
          </div>

          {/* Art + metadata */}
          <div style={{ display: 'flex', gap: 10, padding: '10px 10px 6px' }}>
            <div style={{ width: 64, height: 64, flexShrink: 0, background: bg2,
              border: `1px solid ${border}`, borderRadius: 2, overflow: 'hidden',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {artSrc && !artError
                ? <img src={artSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt=""
                    onError={() => setArtError(true)} />
                : <span style={{ fontSize: 24, color: 'hsl(var(--border))' }}>♪</span>}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
              <div style={{ ...M, fontWeight: 700, fontSize: 12, color: '#e8edf5',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {current ? songName(current) : '—'}
              </div>
              <div style={{ ...M, fontSize: 10, color: amber,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {current ? songArtist(current) : ''}
              </div>
              <div style={{ ...M, fontSize: 10, color: dim,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {current?.album ?? ''}
              </div>
              <TransportProgress fmt={fmt} />
            </div>
          </div>

          <TransportSeekbar onSeek={seek} amber={amber} />

          <TransportVolume amber={amber} dim={dim} onSetVolume={setVolumeStore} />

          {/* Transport */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '2px 6px 8px', gap: 0 }}>
            <TBtn label="⇥" onClick={() => setShuffle(!shuffle)} active={shuffle} title="Shuffle" />
            <TBtn label="⏮" onClick={() => advance(-1)} title="Previous" />
            <button onClick={playPause}
              style={{ background: playing ? 'rgba(59,130,246,.15)' : 'rgba(245,158,11,.1)',
                border: `1px solid ${playing ? blue : amber}`, borderRadius: 3,
                color: playing ? blue : amber, cursor: 'pointer',
                width: 36, height: 28, fontSize: 13,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all .15s', margin: '0 4px' }}>
              {playing ? '⏸' : '▶'}
            </button>
            <TBtn label="⏭" onClick={() => advance(1)} title="Next" />
            <TBtn label="☰" onClick={() => setDrawerOpen(d => !d)} active={drawerOpen} title="Library" />
          </div>
        </div>

        {/* ── Drawer ── */}
        {drawerOpen && (
          <div className="polaris-scrollbar" style={{
            width: 320, height: 340, background: bg,
            border: `1px solid ${border}`, borderTop: `1px solid #0a0c0f`,
            borderRadius: '0 0 4px 4px',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Drawer tabs */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
              {(['library', 'nowplaying'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{ flex: 1, padding: '8px 0', background: 'none', border: 'none',
                    borderBottom: activeTab === tab ? `2px solid ${blue}` : '2px solid transparent',
                    color: activeTab === tab ? blue : dim,
                    cursor: 'pointer', ...M, fontSize: 10, letterSpacing: '.1em', transition: 'color .15s' }}>
                  {tab === 'library' ? 'LIBRARY' : `NOW PLAYING${queue.length > 0 ? ` (${queue.length})` : ''}`}
                </button>
              ))}
            </div>

            <div className="polaris-scrollbar" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {activeTab === 'library'
                ? <LibraryPanel
                    onPlayNow={playNow}
                    onAddToNP={addToNP}
                    playlists={playlists}
                    refreshPlaylists={loadPlaylists}
                  />
                : <NowPlayingPanel
                    queue={queue}
                    queueIdx={queueIdx}
                    playing={playing}
                    duration={durationSec}
                    onPlayIdx={idx => { void playQueue(queue, idx); }}
                    onRemove={removeFromNP}
                    onReorder={reorderNP}
                    playlists={playlists}
                    onSavePlaylist={savePlaylist}
                  />}
            </div>
          </div>
        )}
      </div>

      {eqOpen && <MasterEq onClose={() => setEqOpen(false)} />}
    </>
  );
}