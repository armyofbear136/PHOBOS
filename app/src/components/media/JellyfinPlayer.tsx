/**
 * JellyfinPlayer.tsx — PHOBOS floating video player widget.
 *
 * Architecture mirrors PolarisPlayer: draggable floating control bar +
 * expandable drawer. The actual video renders in an mpv OS window —
 * not confined to the browser.
 *
 * Tabs:
 *   LIBRARY  — Jellyfin media browser (movies / series)
 *   IPTV     — live stream browser from iptv-org, with live-check and categories
 *
 * API:
 *   /api/mpv/*           — playback control (load, pause, seek, volume, etc.)
 *   /api/services/jellyfin/proxy/Items  — library browse
 *   /api/iptv/categories               — IPTV category list
 *   /api/iptv/playlist?cat=...         — fetch + parse M3U playlist
 *   /api/iptv/check                    — HEAD-check stream liveness
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Film, Tv2, Radio, Play, Pause, Square, Volume2, Maximize2, Minimize2,
  ChevronDown, ChevronUp, ChevronRight, RefreshCw, Wifi, WifiOff,
  Loader2, AlertTriangle, X, Search,
} from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const MPV    = `${ENGINE}/api/mpv`;
const PROXY  = `${ENGINE}/api/services/jellyfin/proxy`;
const IPTV   = `${ENGINE}/api/iptv`;

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'library' | 'iptv';
type LibraryView = 'movies' | 'series';
type MpvState = 'stopped' | 'starting' | 'idle' | 'playing' | 'paused' | 'error';

interface MpvStatus {
  state:     MpvState;
  available: boolean;
  title:     string | null;
  duration:  number | null;
  position:  number | null;
  volume:    number | null;
  paused:    boolean;
}

interface JellyfinItem {
  Id:             string;
  Name:           string;
  Type:           string;
  RunTimeTicks?:  number;
  ProductionYear?: number;
  ImageTags?:     Record<string, string>;
}

interface IptvChannel {
  name:     string;
  url:      string;
  logo:     string | null;
  group:    string | null;
  language: string | null;
  country:  string | null;
  tvgId:    string | null;
}

interface IptvCategory {
  id:    string;
  label: string;
}

interface CheckedChannel extends IptvChannel {
  live: boolean | null; // null = not checked yet
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function mpvPost(endpoint: string, body?: Record<string, unknown>): Promise<void> {
  await fetch(`${MPV}/${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    body ? JSON.stringify(body) : undefined,
  });
}

function formatTime(seconds: number | null): string {
  if (seconds === null || isNaN(seconds)) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function JellyfinPlayer() {
  // ── Drag state ─────────────────────────────────────────────────────────────
  const [pos, setPos]         = useState({ x: 40, y: window.innerHeight - 180 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // ── UI state ───────────────────────────────────────────────────────────────
  const [open, setOpen]         = useState(false);
  const [tab, setTab]           = useState<Tab>('library');
  const [libView, setLibView]   = useState<LibraryView>('movies');

  // ── mpv state ──────────────────────────────────────────────────────────────
  const [mpv, setMpv]           = useState<MpvStatus | null>(null);
  const [volume, setVolumeState] = useState(100);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Library state ──────────────────────────────────────────────────────────
  const [items, setItems]       = useState<JellyfinItem[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const [libSearch, setLibSearch] = useState('');

  // ── IPTV state ─────────────────────────────────────────────────────────────
  const [categories, setCategories]   = useState<IptvCategory[]>([]);
  const [activeCat, setActiveCat]     = useState('news');
  const [channels, setChannels]       = useState<CheckedChannel[]>([]);
  const [iptvLoading, setIptvLoading] = useState(false);
  const [iptvError, setIptvError]     = useState<string | null>(null);
  const [checking, setChecking]       = useState(false);
  const [catOpen, setCatOpen]         = useState(false);
  const [iptvSearch, setIptvSearch]   = useState('');

  // ── mpv status poll ────────────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch(`${MPV}/status`);
        if (r.ok) {
          const s = await r.json() as MpvStatus;
          setMpv(s);
          if (s.volume !== null) setVolumeState(Math.round(s.volume));
        }
      } catch { /* offline */ }
    };
    poll();
    pollRef.current = setInterval(poll, 1_500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    setDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - 440, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 60,  e.clientY - dragOffset.current.y)),
      });
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  // ── Library fetch ──────────────────────────────────────────────────────────
  const fetchLibrary = useCallback(async () => {
    setLibLoading(true);
    setLibError(null);
    const type = libView === 'movies' ? 'Movie' : 'Series';
    const q    = libSearch ? `&SearchTerm=${encodeURIComponent(libSearch)}` : '';
    try {
      const r = await fetch(`${PROXY}/Items?IncludeItemTypes=${type}&Recursive=true&Limit=50${q}&Fields=BasicSyncInfo`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { Items: JellyfinItem[] };
      setItems(d.Items ?? []);
    } catch (err) {
      setLibError((err as Error).message);
      setItems([]);
    }
    setLibLoading(false);
  }, [libView, libSearch]);

  useEffect(() => {
    if (tab === 'library' && open) fetchLibrary();
  }, [tab, libView, open, fetchLibrary]);

  // ── IPTV category list ────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${IPTV}/categories`)
      .then(r => r.json())
      .then(d => setCategories((d as { categories: IptvCategory[] }).categories))
      .catch(() => {});
  }, []);

  // ── IPTV playlist fetch ────────────────────────────────────────────────────
  const fetchPlaylist = useCallback(async (cat: string) => {
    setIptvLoading(true);
    setIptvError(null);
    setChannels([]);
    try {
      const r = await fetch(`${IPTV}/playlist?cat=${encodeURIComponent(cat)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { channels: IptvChannel[] };
      setChannels(d.channels.map(c => ({ ...c, live: null })));
    } catch (err) {
      setIptvError((err as Error).message);
    }
    setIptvLoading(false);
  }, []);

  useEffect(() => {
    if (tab === 'iptv' && open) fetchPlaylist(activeCat);
  }, [tab, activeCat, open, fetchPlaylist]);

  // ── Stream live check ─────────────────────────────────────────────────────
  const checkLiveness = useCallback(async () => {
    const visible = filteredChannels.slice(0, 20);
    if (visible.length === 0) return;
    setChecking(true);
    try {
      const r = await fetch(`${IPTV}/check`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ urls: visible.map(c => c.url) }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { results: Array<{ url: string; live: boolean }> };
      const liveMap = new Map(d.results.map(x => [x.url, x.live]));
      setChannels(prev => prev.map(c => ({ ...c, live: liveMap.has(c.url) ? liveMap.get(c.url)! : c.live })));
    } catch { /* non-fatal */ }
    setChecking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, iptvSearch]);

  // ── Filtered channels ─────────────────────────────────────────────────────
  const filteredChannels = iptvSearch
    ? channels.filter(c =>
        c.name.toLowerCase().includes(iptvSearch.toLowerCase()) ||
        (c.group ?? '').toLowerCase().includes(iptvSearch.toLowerCase()) ||
        (c.country ?? '').toLowerCase().includes(iptvSearch.toLowerCase())
      )
    : channels;

  // Group channels by group-title for display.
  const grouped = filteredChannels.reduce<Map<string, CheckedChannel[]>>((acc, c) => {
    const key = c.group ?? 'Uncategorized';
    const arr = acc.get(key);
    if (arr) arr.push(c);
    else acc.set(key, [c]);
    return acc;
  }, new Map());

  // ── Transport actions ─────────────────────────────────────────────────────
  const playItem = async (item: JellyfinItem) => {
    // Jellyfin stream URL — token injected server-side by the proxy.
    const url = `${PROXY}/Videos/${item.Id}/stream?static=true&mediaSourceId=${item.Id}`;
    await mpvPost('load', { url });
  };

  const playChannel = async (ch: IptvChannel) => {
    await mpvPost('load', { url: ch.url });
  };

  const isPlaying  = mpv?.state === 'playing';
  const isPaused   = mpv?.state === 'paused';
  const hasMedia   = isPlaying || isPaused;
  const progress   = mpv?.duration && mpv?.position ? mpv.position / mpv.duration : 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 2000, userSelect: 'none', width: 440 }}
    >
      {/* ── Drawer ──────────────────────────────────────────────────────── */}
      {open && (
        <div style={{
          background: 'var(--color-surface, #1a1a2e)',
          border:     '1px solid var(--color-border, #2d2d4e)',
          borderRadius: '12px 12px 0 0',
          height:     480,
          display:    'flex',
          flexDirection: 'column',
          overflow:   'hidden',
          boxShadow:  '0 -4px 32px rgba(0,0,0,0.4)',
        }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border, #2d2d4e)', flexShrink: 0 }}>
            {(['library', 'iptv'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  flex: 1, padding: '10px 0', background: 'none', border: 'none',
                  color: tab === t ? 'var(--color-accent, #3b82f6)' : 'var(--color-text-muted, #888)',
                  borderBottom: tab === t ? '2px solid var(--color-accent, #3b82f6)' : '2px solid transparent',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                {t === 'library' ? '📽  Library' : '📡  IPTV Live'}
              </button>
            ))}
          </div>

          {/* ── Library tab ─────────────────────────────────────────────── */}
          {tab === 'library' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Sub-nav */}
              <div style={{ display: 'flex', gap: 8, padding: '8px 12px', flexShrink: 0 }}>
                {(['movies', 'series'] as LibraryView[]).map(v => (
                  <button
                    key={v}
                    onClick={() => setLibView(v)}
                    style={{
                      padding: '4px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                      border: 'none', fontWeight: 600,
                      background: libView === v ? 'var(--color-accent, #3b82f6)' : 'var(--color-surface-2, #252540)',
                      color: libView === v ? '#fff' : 'var(--color-text-muted, #888)',
                    }}
                  >
                    {v === 'movies' ? '🎬 Movies' : '📺 Series'}
                  </button>
                ))}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--color-surface-2, #252540)', borderRadius: 8, padding: '0 8px', gap: 4 }}>
                  <Search size={12} color="var(--color-text-muted, #888)" />
                  <input
                    value={libSearch}
                    onChange={e => setLibSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') fetchLibrary(); }}
                    placeholder="Search…"
                    style={{ background: 'none', border: 'none', outline: 'none', color: 'inherit', fontSize: 12, width: '100%' }}
                  />
                </div>
              </div>

              {/* Items list */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px' }}>
                {libLoading && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                    <Loader2 size={20} className="animate-spin" color="var(--color-accent, #3b82f6)" />
                  </div>
                )}
                {libError && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: '#f87171', fontSize: 13 }}>
                    <AlertTriangle size={14} /> {libError}
                  </div>
                )}
                {!libLoading && !libError && items.length === 0 && (
                  <div style={{ color: 'var(--color-text-muted, #888)', fontSize: 13, padding: '20px 16px', textAlign: 'center' }}>
                    No {libView} found.<br />
                    <span style={{ fontSize: 11 }}>Jellyfin must be running with a library configured.</span>
                  </div>
                )}
                {items.map(item => (
                  <div
                    key={item.Id}
                    onDoubleClick={() => playItem(item)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
                      borderRadius: 8, cursor: 'pointer',
                      color: 'var(--color-text, #e0e0f0)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2, #252540)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Film size={14} color="var(--color-text-muted, #888)" style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.Name}
                      </div>
                      {item.ProductionYear && (
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)' }}>{item.ProductionYear}</div>
                      )}
                    </div>
                    <Play size={12} color="var(--color-accent, #3b82f6)" style={{ flexShrink: 0, opacity: 0.7 }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── IPTV tab ─────────────────────────────────────────────────── */}
          {tab === 'iptv' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Controls row */}
              <div style={{ display: 'flex', gap: 8, padding: '8px 12px', flexShrink: 0, alignItems: 'center' }}>
                {/* Category picker */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setCatOpen(!catOpen)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                      background: 'var(--color-surface-2, #252540)', border: 'none', borderRadius: 8,
                      color: 'var(--color-text, #e0e0f0)', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    {categories.find(c => c.id === activeCat)?.label ?? activeCat}
                    <ChevronDown size={12} />
                  </button>
                  {catOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, zIndex: 100,
                      background: 'var(--color-surface, #1a1a2e)',
                      border: '1px solid var(--color-border, #2d2d4e)',
                      borderRadius: 8, boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
                      maxHeight: 240, overflowY: 'auto', minWidth: 140,
                    }}>
                      {categories.map(cat => (
                        <button
                          key={cat.id}
                          onClick={() => { setActiveCat(cat.id); setCatOpen(false); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left',
                            padding: '7px 14px', background: cat.id === activeCat ? 'var(--color-surface-2, #252540)' : 'none',
                            border: 'none', color: cat.id === activeCat ? 'var(--color-accent, #3b82f6)' : 'var(--color-text, #e0e0f0)',
                            fontSize: 12, cursor: 'pointer', fontWeight: cat.id === activeCat ? 600 : 400,
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2, #252540)')}
                          onMouseLeave={e => (e.currentTarget.style.background = cat.id === activeCat ? 'var(--color-surface-2, #252540)' : 'none')}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Search */}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--color-surface-2, #252540)', borderRadius: 8, padding: '0 8px', gap: 4 }}>
                  <Search size={12} color="var(--color-text-muted, #888)" />
                  <input
                    value={iptvSearch}
                    onChange={e => setIptvSearch(e.target.value)}
                    placeholder="Search channels…"
                    style={{ background: 'none', border: 'none', outline: 'none', color: 'inherit', fontSize: 12, width: '100%' }}
                  />
                </div>

                {/* Live check button */}
                <button
                  onClick={checkLiveness}
                  disabled={checking || filteredChannels.length === 0}
                  title="Check stream liveness (first 20 visible)"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px',
                    background: 'var(--color-surface-2, #252540)', border: 'none', borderRadius: 8,
                    color: checking ? 'var(--color-text-muted, #888)' : '#4ade80',
                    cursor: checking ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
                  }}
                >
                  {checking ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                  {checking ? 'Checking…' : 'Check'}
                </button>
              </div>

              {/* Channel count */}
              {!iptvLoading && channels.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', padding: '0 14px 4px', flexShrink: 0 }}>
                  {filteredChannels.length} channel{filteredChannels.length !== 1 ? 's' : ''}
                  {channels.some(c => c.live !== null) && (
                    <span style={{ marginLeft: 8, color: '#4ade80' }}>
                      ✓ {channels.filter(c => c.live === true).length} live
                    </span>
                  )}
                </div>
              )}

              {/* Channel list */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px' }}>
                {iptvLoading && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                    <Loader2 size={20} className="animate-spin" color="var(--color-accent, #3b82f6)" />
                  </div>
                )}
                {iptvError && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: '#f87171', fontSize: 13 }}>
                    <AlertTriangle size={14} /> {iptvError}
                  </div>
                )}
                {!iptvLoading && !iptvError && channels.length === 0 && (
                  <div style={{ color: 'var(--color-text-muted, #888)', fontSize: 13, padding: '20px 16px', textAlign: 'center' }}>
                    No channels loaded.
                  </div>
                )}

                {/* Grouped by category */}
                {Array.from(grouped.entries()).map(([groupName, groupChannels]) => (
                  <div key={groupName}>
                    {grouped.size > 1 && (
                      <div style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                        textTransform: 'uppercase', color: 'var(--color-text-muted, #888)',
                        padding: '10px 12px 4px',
                      }}>
                        {groupName}
                      </div>
                    )}
                    {groupChannels.map(ch => (
                      <div
                        key={ch.url}
                        onDoubleClick={() => playChannel(ch)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
                          borderRadius: 8, cursor: 'pointer',
                          color: ch.live === false ? 'var(--color-text-muted, #888)' : 'var(--color-text, #e0e0f0)',
                          opacity: ch.live === false ? 0.5 : 1,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2, #252540)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        {/* Channel logo or fallback icon */}
                        {ch.logo ? (
                          <img
                            src={ch.logo}
                            alt=""
                            style={{ width: 22, height: 22, objectFit: 'contain', borderRadius: 4, flexShrink: 0, background: '#fff1' }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <Tv2 size={16} color="var(--color-text-muted, #888)" style={{ flexShrink: 0 }} />
                        )}

                        {/* Name + metadata */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ch.name}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', display: 'flex', gap: 6 }}>
                            {ch.language && <span>{ch.language}</span>}
                            {ch.country && <span>{ch.country.toUpperCase()}</span>}
                          </div>
                        </div>

                        {/* Live status indicator */}
                        {ch.live === true  && <span title="Live"               style={{ flexShrink: 0, display: 'flex' }}><Wifi    size={12} color="#4ade80" /></span>}
                        {ch.live === false && <span title="Offline or geo-blocked" style={{ flexShrink: 0, display: 'flex' }}><WifiOff size={12} color="#888" /></span>}
                        {ch.live === null  && <Play    size={11} color="var(--color-accent, #3b82f6)" style={{ flexShrink: 0, opacity: 0.6 }} />}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Transport bar ────────────────────────────────────────────────────── */}
      <div
        onMouseDown={onMouseDown}
        style={{
          background:   'var(--color-surface, #1a1a2e)',
          border:       '1px solid var(--color-border, #2d2d4e)',
          borderRadius: open ? '0 0 12px 12px' : 12,
          padding:      '8px 12px',
          display:      'flex',
          flexDirection:'column',
          gap:          6,
          cursor:       dragging ? 'grabbing' : 'grab',
          boxShadow:    '0 4px 24px rgba(0,0,0,0.4)',
          borderTop:    open ? '1px solid var(--color-border, #2d2d4e)' : undefined,
        }}
      >
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Film size={14} color="var(--color-accent, #3b82f6)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text, #e0e0f0)' }}>
            {mpv?.title ?? (hasMedia ? 'Playing…' : 'PHOBOS Video Player')}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {mpv && !mpv.available && (
              <span title="mpv not installed" style={{ fontSize: 10, color: '#f87171', flexShrink: 0 }}>
                <AlertTriangle size={12} />
              </span>
            )}
            <button
              onClick={() => setOpen(o => !o)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted, #888)', display: 'flex', alignItems: 'center', padding: 2 }}
              title={open ? 'Collapse' : 'Expand'}
            >
              {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        {hasMedia && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', flexShrink: 0, minWidth: 36 }}>
              {formatTime(mpv?.position ?? null)}
            </span>
            <div
              style={{ flex: 1, height: 3, background: 'var(--color-surface-2, #252540)', borderRadius: 2, cursor: 'pointer' }}
              onClick={e => {
                if (!mpv?.duration) return;
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const pct  = (e.clientX - rect.left) / rect.width;
                mpvPost('seek', { seconds: pct * mpv.duration });
              }}
            >
              <div style={{ width: `${progress * 100}%`, height: '100%', background: 'var(--color-accent, #3b82f6)', borderRadius: 2, transition: 'width 1s linear' }} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', flexShrink: 0, minWidth: 36, textAlign: 'right' }}>
              {formatTime(mpv?.duration ?? null)}
            </span>
          </div>
        )}

        {/* Controls row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Playback */}
          <button onClick={() => mpvPost('stop')} disabled={!hasMedia} style={btnStyle(!hasMedia)}>
            <Square size={12} />
          </button>
          <button
            onClick={() => mpvPost('toggle-pause')}
            disabled={!hasMedia}
            style={{ ...btnStyle(!hasMedia), color: 'var(--color-accent, #3b82f6)' }}
          >
            {isPaused ? <Play size={14} /> : <Pause size={14} />}
          </button>

          {/* Volume */}
          <Volume2 size={12} color="var(--color-text-muted, #888)" />
          <input
            type="range" min={0} max={130} value={volume}
            onChange={e => {
              const v = Number(e.target.value);
              setVolumeState(v);
              mpvPost('volume', { level: v });
            }}
            style={{ width: 72, accentColor: 'var(--color-accent, #3b82f6)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', minWidth: 28 }}>{volume}%</span>

          <div style={{ flex: 1 }} />

          {/* Fullscreen */}
          <button
            onClick={() => mpvPost('fullscreen', { enable: true })}
            disabled={!hasMedia}
            style={btnStyle(!hasMedia)}
            title="Fullscreen"
          >
            <Maximize2 size={12} />
          </button>

          {/* Quit mpv */}
          <button
            onClick={() => mpvPost('quit')}
            style={{ ...btnStyle(false), color: '#888' }}
            title="Quit mpv"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    background:  'none',
    border:      'none',
    borderRadius: 6,
    cursor:      disabled ? 'not-allowed' : 'pointer',
    opacity:     disabled ? 0.35 : 1,
    color:       'var(--color-text, #e0e0f0)',
    display:     'flex',
    alignItems:  'center',
    padding:     4,
  };
}
