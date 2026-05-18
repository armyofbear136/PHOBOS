/**
 * IPTVPlayer.tsx — PHOBOS floating IPTV player widget.
 *
 * Architecture mirrors PolarisPlayer: draggable floating control bar +
 * expandable drawer. Video renders in an mpv OS window.
 *
 * API:
 *   /api/mpv/*                  — playback control (load, pause, seek, volume, quit)
 *   /api/iptv/categories        — category list
 *   /api/iptv/playlist?cat=...  — fetch + parse M3U playlist
 *   /api/iptv/check             — HEAD-check stream liveness (up to 50 per batch)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import {
  Tv2, Play, Pause, Square, Volume2, Maximize2,
  ChevronDown, ChevronUp, Wifi, WifiOff,
  Loader2, AlertTriangle, X, Search,
} from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const MPV    = `${ENGINE}/api/mpv`;
const IPTV   = `${ENGINE}/api/iptv`;

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface IptvChannel {
  name:      string;
  url:       string;
  logo:      string | null;
  group:     string | null;
  language:  string | null;
  country:   string | null;
  tvgId:     string | null;
  userAgent: string | null;
  referrer:  string | null;
}

interface IptvCategory {
  id:    string;
  label: string;
}

interface CheckedChannel extends IptvChannel {
  live: boolean | null; // null = unchecked
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function mpvPost(endpoint: string, body?: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await fetch(`${MPV}/${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({})) as { error?: string };
      return d.error ?? `HTTP ${r.status}`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
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

export default function IPTVPlayer() {
  // ── Drag state ─────────────────────────────────────────────────────────────
  const [pos, setPos]           = useState({ x: 40, y: 40 });
  const [dragging, setDragging] = useState(false);
  const dragOffset              = useRef({ x: 0, y: 0 });

  // ── UI state ───────────────────────────────────────────────────────────────
  const toggleIptvPlayer = useAppStore((s) => s.toggleIptvPlayer);
  const [open, setOpen] = useState(true);

  // ── mpv state ──────────────────────────────────────────────────────────────
  const [mpv, setMpv]             = useState<MpvStatus | null>(null);
  const [volume, setVolumeState]  = useState(100);
  const pollRef                   = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── IPTV state ─────────────────────────────────────────────────────────────
  const [categories, setCategories] = useState<IptvCategory[]>([]);
  const [activeCat, setActiveCat]   = useState('news');
  const [channels, setChannels]     = useState<CheckedChannel[]>([]);
  const [iptvLoading, setIptvLoading] = useState(false);
  const [iptvError, setIptvError]   = useState<string | null>(null);
  const [checking, setChecking]     = useState(false);
  const [catOpen, setCatOpen]       = useState(false);
  const [iptvSearch, setIptvSearch] = useState('');
  const [loadError, setLoadError]   = useState<string | null>(null);

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

  // ── IPTV category list ─────────────────────────────────────────────────────
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
    if (open) fetchPlaylist(activeCat);
  }, [activeCat, open, fetchPlaylist]);

  // ── Batch liveness check ───────────────────────────────────────────────────
  // Splits urlList into batches of 50, fires them sequentially, merges results
  // into state progressively so the UI updates as each batch completes.
  const batchCheck = useCallback(async (urlList: string[]) => {
    if (urlList.length === 0) return;
    setChecking(true);
    const BATCH = 50;
    for (let i = 0; i < urlList.length; i += BATCH) {
      const slice = urlList.slice(i, i + BATCH);
      try {
        const r = await fetch(`${IPTV}/check`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ urls: slice }),
        });
        if (!r.ok) continue;
        const d = await r.json() as { results: Array<{ url: string; live: boolean }> };
        const liveMap = new Map(d.results.map(x => [x.url, x.live]));
        setChannels(prev => prev.map(c => ({ ...c, live: liveMap.has(c.url) ? liveMap.get(c.url)! : c.live })));
      } catch { /* non-fatal — continue next batch */ }
    }
    setChecking(false);
  }, []);

  // ── Auto-check on fresh playlist load ─────────────────────────────────────
  const autoCheckedCatRef = useRef<string | null>(null);

  useEffect(() => {
    if (channels.length === 0) return;
    if (autoCheckedCatRef.current === activeCat) return;
    autoCheckedCatRef.current = activeCat;
    batchCheck(channels.map(c => c.url));
  }, [channels.length, activeCat, batchCheck]);

  // ── Manual check — all currently filtered channels ─────────────────────────
  const checkLiveness = useCallback(() => {
    const filtered = iptvSearch
      ? channels.filter(c =>
          c.name.toLowerCase().includes(iptvSearch.toLowerCase()) ||
          (c.group ?? '').toLowerCase().includes(iptvSearch.toLowerCase()) ||
          (c.country ?? '').toLowerCase().includes(iptvSearch.toLowerCase())
        )
      : channels;
    return batchCheck(filtered.map(c => c.url));
  }, [channels, iptvSearch, batchCheck]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const filteredChannels = (iptvSearch
    ? channels.filter(c =>
        c.name.toLowerCase().includes(iptvSearch.toLowerCase()) ||
        (c.group ?? '').toLowerCase().includes(iptvSearch.toLowerCase()) ||
        (c.country ?? '').toLowerCase().includes(iptvSearch.toLowerCase())
      )
    : channels
  ).slice().sort((a, b) => {
    // live=true first, live=null (unchecked) second, live=false last.
    const rank = (c: CheckedChannel) => c.live === true ? 0 : c.live === null ? 1 : 2;
    return rank(a) - rank(b);
  });

  // Sort filtered channels: by category then name within each live/offline bucket.
  const sortedChannels = filteredChannels.slice().sort((a, b) => {
    const aGroup = (a.group ?? 'Uncategorized').toLowerCase();
    const bGroup = (b.group ?? 'Uncategorized').toLowerCase();
    if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
    return a.name.localeCompare(b.name);
  });

  // Split into Live (true), Unchecked (null), Offline (false).
  const liveChannels     = sortedChannels.filter(c => c.live === true);
  const uncheckedChannels = sortedChannels.filter(c => c.live === null);
  const offlineChannels  = sortedChannels.filter(c => c.live === false);

  // Shown sections: once checking has started, merge unchecked into offline visually.
  const checkingStarted = channels.some(c => c.live !== null);
  const liveBucket      = liveChannels;
  const offlineBucket   = checkingStarted ? [...offlineChannels] : [...uncheckedChannels, ...offlineChannels];

  const isPlaying = mpv?.state === 'playing';
  const isPaused  = mpv?.state === 'paused';
  const hasMedia  = isPlaying || isPaused;
  const progress  = mpv?.duration && mpv?.position ? mpv.position / mpv.duration : 0;


  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 2000, userSelect: 'none', width: 440 }}>

      {/* ── Transport bar — always on top, drag handle ─────────────────────── */}
      <div
        onMouseDown={onMouseDown}
        style={{
          background:   'var(--color-surface, #1a1a2e)',
          border:       '1px solid var(--color-border, #2d2d4e)',
          borderRadius: open ? '12px 12px 0 0' : 12,
          padding:      '8px 12px',
          display:      'flex',
          flexDirection:'column',
          gap:           6,
          cursor:        dragging ? 'grabbing' : 'grab',
          boxShadow:    '0 4px 24px rgba(0,0,0,0.4)',
        }}
      >
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tv2 size={14} color="var(--color-accent, #3b82f6)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text, #e0e0f0)' }}>
            {mpv?.title ?? (hasMedia ? 'Playing…' : 'PHOBOS IPTV')}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {mpv && !mpv.available && (
              <span title="mpv binary not found — run scripts/fetch-mpv.js" style={{ display: 'flex', flexShrink: 0 }}>
                <AlertTriangle size={12} color="#f87171" />
              </span>
            )}
            <button
              onClick={() => setOpen(o => !o)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted, #888)', display: 'flex', alignItems: 'center', padding: 2 }}
              title={open ? 'Collapse' : 'Expand'}
            >
              {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {/* Progress bar — only shown for VOD streams that have a duration */}
        {hasMedia && mpv?.duration !== null && (
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

          <button
            onClick={() => mpvPost('fullscreen', { enable: true })}
            disabled={!hasMedia}
            style={btnStyle(!hasMedia)}
            title="Fullscreen"
          >
            <Maximize2 size={12} />
          </button>
          <button
            onClick={() => mpvPost('quit')}
            disabled={!hasMedia}
            style={{ ...btnStyle(!hasMedia), color: '#888' }}
            title="Quit mpv"
          >
            <Square size={12} style={{ opacity: 0.5 }} />
          </button>
          <button
            onClick={toggleIptvPlayer}
            style={{ ...btnStyle(false), color: '#888' }}
            title="Close IPTV player"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* ── Drawer — below transport bar ───────────────────────────────────── */}
      {open && (
        <div style={{
          background:   'var(--color-surface, #1a1a2e)',
          border:       '1px solid var(--color-border, #2d2d4e)',
          borderTop:    'none',
          borderRadius: '0 0 12px 12px',
          height:        480,
          display:      'flex',
          flexDirection:'column',
          overflow:     'hidden',
          boxShadow:    '0 8px 32px rgba(0,0,0,0.4)',
        }}>

          {/* Controls row: category picker + search + liveness check */}
          <div style={{ display: 'flex', gap: 8, padding: '8px 12px', flexShrink: 0, alignItems: 'center', borderBottom: '1px solid var(--color-border, #2d2d4e)' }}>

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
                        padding: '7px 14px',
                        background: cat.id === activeCat ? 'var(--color-surface-2, #252540)' : 'none',
                        border: 'none',
                        color: cat.id === activeCat ? 'var(--color-accent, #3b82f6)' : 'var(--color-text, #e0e0f0)',
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

            {/* Liveness check */}
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

          {/* Channel count + load error */}
          {!iptvLoading && channels.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', padding: '4px 14px', flexShrink: 0 }}>
              {filteredChannels.length} channel{filteredChannels.length !== 1 ? 's' : ''}
              {channels.some(c => c.live !== null) && (
                <span style={{ marginLeft: 8, color: '#4ade80' }}>
                  ✓ {channels.filter(c => c.live === true).length} live
                </span>
              )}
            </div>
          )}
          {loadError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', color: '#f87171', fontSize: 11, flexShrink: 0 }}>
              <AlertTriangle size={12} /> {loadError}
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

            {Array.from([
              { label: 'Live', channels: liveBucket, accent: '#4ade80' },
              { label: checking ? 'Checking…' : (checkingStarted ? 'Offline' : 'Channels'), channels: offlineBucket, accent: 'var(--color-text-muted, #888)' },
            ]).map(({ label, channels: bucket, accent }) => bucket.length === 0 ? null : (
              <div key={label}>
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: accent,
                  padding: '10px 12px 4px',
                }}>
                  {label} · {bucket.length}
                </div>
                {bucket.map(ch => (
                  <div
                    key={ch.url}
                    onDoubleClick={async () => {
                      setLoadError(null);
                      const err = await mpvPost('load', { url: ch.url, userAgent: ch.userAgent, referrer: ch.referrer });
                      if (err) setLoadError(`${ch.name}: ${err}`);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
                      borderRadius: 8, cursor: 'default',
                      color:   ch.live === false ? 'var(--color-text-muted, #888)' : 'var(--color-text, #e0e0f0)',
                      opacity: ch.live === false ? 0.5 : 1,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2, #252540)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {ch.logo ? (
                      <img
                        src={ch.logo}
                        alt=""
                        style={{ width: 22, height: 22, objectFit: 'contain', borderRadius: 4, flexShrink: 0, background: '#fff1' }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <Tv2 size={16} color="var(--color-text-muted, #888)" style={{ flexShrink: 0 }} />
                    )}

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ch.name}
                      </div>
                      {ch.group && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ch.group}
                        </div>
                      )}
                    </div>

                    {ch.live === true  && <span title="Live"                   style={{ flexShrink: 0, display: 'flex' }}><Wifi    size={12} color="#4ade80" /></span>}
                    {ch.live === false && <span title="Offline or geo-blocked" style={{ flexShrink: 0, display: 'flex' }}><WifiOff size={12} color="#888"    /></span>}
                    <button
                      title="Play"
                      onClick={async (e) => {
                        e.stopPropagation();
                        setLoadError(null);
                        const err = await mpvPost('load', { url: ch.url, userAgent: ch.userAgent, referrer: ch.referrer });
                        if (err) setLoadError(`${ch.name}: ${err}`);
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
                        display: 'flex', alignItems: 'center', flexShrink: 0,
                        color: ch.live === false ? '#888' : 'var(--color-accent, #3b82f6)',
                        opacity: ch.live === false ? 0.4 : 0.7,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = ch.live === false ? '0.4' : '0.7')}
                    >
                      <Play size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    background:   'none',
    border:       'none',
    borderRadius: 6,
    cursor:       disabled ? 'not-allowed' : 'pointer',
    opacity:      disabled ? 0.35 : 1,
    color:        'var(--color-text, #e0e0f0)',
    display:      'flex',
    alignItems:   'center',
    padding:      4,
  };
}
