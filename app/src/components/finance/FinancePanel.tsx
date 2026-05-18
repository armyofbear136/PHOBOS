/**
 * FinancePanel.tsx — PHOBOS Markets Terminal
 *
 * Free-tier Finnhub only — /stock/candle is NOT used (403 on free tier).
 * Sparklines built from WebSocket tick accumulation stored in module-level
 * ring buffers — zero extra API calls.
 *
 * Cache TTLs (module-level, survive React unmount/remount):
 *   Overview quotes  — 60s
 *   Screener quotes  — 90s
 *   News             — 5min
 *   Calendar         — 10min
 *
 * Rate limit math at tab open:
 *   Overview:  10 /quote calls × 130ms stagger  =  ~1.3s, 10 calls
 *   Screener:  20 /quote calls × 130ms stagger  =  ~2.6s, 20 calls
 *   News:      1 call
 *   Calendar:  1 call
 *   Total worst-case: 32 calls — well under 60/min free tier limit.
 *   Tab-switching uses cache so subsequent visits cost 0 calls.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  X as XIcon, Key, ArrowRight, CheckCircle, AlertCircle,
  Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Wifi, WifiOff,
} from 'lucide-react';

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY  = 'phobos.finnhub.key';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const TTL_QUOTE    =  60_000;
const TTL_SCREENER =  90_000;
const TTL_NEWS     =   5 * 60_000;
const TTL_CALENDAR =  10 * 60_000;

// WebSocket tick ring buffer size per symbol
const TICK_RING = 120;

// ── Module-level singletons (survive React unmount) ────────────────────────────

// TTL cache
interface CacheEntry<T> { data: T; ts: number; }
const _cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string, ttl: number): T | null {
  const e = _cache.get(key) as CacheEntry<T> | undefined;
  if (!e || Date.now() - e.ts > ttl) return null;
  return e.data;
}
function cacheSet<T>(key: string, data: T): void {
  _cache.set(key, { data, ts: Date.now() });
}
function cacheAge(key: string): string {
  const e = _cache.get(key);
  if (!e) return '';
  const s = Math.floor((Date.now() - e.ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// WebSocket tick rings — module-level, persist across tab switches
const tickRings  = new Map<string, number[]>();
const tickLatest = new Map<string, number>();

function tickPush(symbol: string, price: number): void {
  if (!tickRings.has(symbol)) tickRings.set(symbol, []);
  const ring = tickRings.get(symbol)!;
  ring.push(price);
  if (ring.length > TICK_RING) ring.shift();
  tickLatest.set(symbol, price);
}

function getSparkData(symbol: string, fallback?: number): number[] {
  const ring = tickRings.get(symbol);
  if (ring && ring.length >= 3) return ring;
  if (fallback && fallback > 0) return [fallback * 0.999, fallback * 1.0005, fallback]; // subtle flat
  return [];
}

// Session chart history: symbol → time-value pairs for the SVG chart
const chartHist = new Map<string, { time: number; value: number }[]>();

function chartPush(symbol: string, price: number): void {
  if (price <= 0) return;
  if (!chartHist.has(symbol)) chartHist.set(symbol, []);
  const hist = chartHist.get(symbol)!;
  const now  = Math.floor(Date.now() / 1000);
  const last = hist[hist.length - 1];
  // Deduplicate by second — chart needs strictly ascending timestamps
  if (!last || now > last.time) {
    hist.push({ time: now, value: price });
    if (hist.length > 3600) hist.shift(); // 1hr at 1-tick/s max
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

type SymbolCategory = 'INDICES' | 'COMMODITIES' | 'FOREX' | 'CRYPTO';
type SymbolType     = 'index' | 'commodity' | 'forex' | 'crypto';

interface SymbolDef {
  symbol:   string;
  label:    string;
  sublabel: string;
  type:     SymbolType;
  category: SymbolCategory;
}

interface FinnhubQuote {
  c: number; d: number; dp: number; h: number; l: number; o: number; pc: number;
}
interface EarningsItem {
  date: string; symbol: string; hour: string;
  epsActual: number | null; epsEstimate: number | null;
  revenueActual: number | null; revenueEstimate: number | null;
}
interface NewsItem {
  id: number; headline: string; source: string;
  url: string; datetime: number; summary: string;
}

// ── Symbol catalogue ───────────────────────────────────────────────────────────

const OVERVIEW_SYMBOLS: SymbolDef[] = [
  { symbol: 'SPY',  label: 'S&P 500',  sublabel: 'US Large Cap',   type: 'index',     category: 'INDICES'     },
  { symbol: 'QQQ',  label: 'Nasdaq',   sublabel: 'Tech Heavy',      type: 'index',     category: 'INDICES'     },
  { symbol: 'DIA',  label: 'Dow',      sublabel: 'Industrial Avg',  type: 'index',     category: 'INDICES'     },
  { symbol: 'VIXY', label: 'VIX',      sublabel: 'Fear Index',      type: 'index',     category: 'INDICES'     },
  { symbol: 'GLD',  label: 'Gold',     sublabel: 'XAU Proxy',       type: 'commodity', category: 'COMMODITIES' },
  { symbol: 'USO',  label: 'WTI Oil',  sublabel: 'Crude Futures',   type: 'commodity', category: 'COMMODITIES' },
  { symbol: 'FXE',  label: 'EUR/USD',  sublabel: 'Euro vs Dollar',  type: 'forex',     category: 'FOREX'       },
  { symbol: 'FXB',  label: 'GBP/USD',  sublabel: 'Cable',           type: 'forex',     category: 'FOREX'       },
  { symbol: 'GBTC', label: 'BTC',      sublabel: 'Bitcoin Proxy',   type: 'crypto',    category: 'CRYPTO'      },
  { symbol: 'ETHE', label: 'ETH',      sublabel: 'Ethereum Proxy',  type: 'crypto',    category: 'CRYPTO'      },
];

const OVERVIEW_SYMBOL_STRINGS = OVERVIEW_SYMBOLS.map(s => s.symbol);

const SCREENER_SYMBOLS = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','JPM','V',
  'WMT','XOM','UNH','MA','JNJ','HD','PG','BAC','COST','ABBV',
];

const CATEGORIES: SymbolCategory[] = ['INDICES', 'COMMODITIES', 'FOREX', 'CRYPTO'];

const CAT_COLOR: Record<SymbolCategory, string> = {
  INDICES:     '#22c55e',
  COMMODITIES: '#f59e0b',
  FOREX:       '#3b82f6',
  CRYPTO:      '#a855f7',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function finn<T>(path: string, key: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FINNHUB_BASE}${path}${sep}token=${key}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function fmtPrice(c: number): string {
  if (!c || c === 0) return '—';
  if (c >= 1000) return `$${c.toFixed(2)}`;
  if (c >= 10)   return `$${c.toFixed(2)}`;
  return `$${c.toFixed(4)}`;
}

function fmtRev(n: number | null): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function newsAge(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── WebSocket hook ─────────────────────────────────────────────────────────────

function useFinanceWS(
  apiKey: string,
  onTick: (s: string, p: number) => void,
  onStatus: (c: boolean) => void,
) {
  const onTickRef   = useRef(onTick);
  const onStatusRef = useRef(onStatus);
  onTickRef.current   = onTick;
  onStatusRef.current = onStatus;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let dead = false;
    let retryMs = 3_000;

    const connect = () => {
      ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);

      ws.onopen = () => {
        if (dead) { ws?.close(); return; }
        retryMs = 3_000;
        OVERVIEW_SYMBOL_STRINGS.forEach(s => ws?.send(JSON.stringify({ type: 'subscribe', symbol: s })));
        onStatusRef.current(true);
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data as string) as { type: string; data?: { s: string; p: number }[] };
          if (msg.type === 'trade' && msg.data) {
            msg.data.forEach(({ s, p }) => { tickPush(s, p); chartPush(s, p); onTickRef.current(s, p); });
          }
        } catch { /* ignore malformed */ }
      };

      ws.onerror = () => { /* close follows */ };
      ws.onclose = () => {
        onStatusRef.current(false);
        if (!dead) { setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 1.5, 30_000); }
      };
    };

    connect();
    return () => {
      dead = true;
      if (ws?.readyState === WebSocket.OPEN) {
        OVERVIEW_SYMBOL_STRINGS.forEach(s => ws!.send(JSON.stringify({ type: 'unsubscribe', symbol: s })));
        ws.close();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);
}

// ── Smooth SVG Sparkline ───────────────────────────────────────────────────────

function Sparkline({ data, positive, W = 80, H = 30 }: {
  data: number[]; positive: boolean; W?: number; H?: number;
}) {
  const id = useRef(`sp${Math.random().toString(36).slice(2, 7)}`).current;

  const paths = useMemo(() => {
    if (data.length < 2) return null;
    const min = Math.min(...data), max = Math.max(...data);
    const rng = max - min || 1;
    const PAD = 4;
    const pts = data.map((v, i) => ({
      x: (i / (data.length - 1)) * W,
      y: H - PAD - ((v - min) / rng) * (H - PAD * 2),
    }));

    // Catmull-Rom → cubic bezier for smoothness
    let line = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[Math.max(i - 2, 0)];
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const p3 = pts[Math.min(i + 1, pts.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      line += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }

    const lastPt = pts[pts.length - 1];
    const fill   = `${line} L ${lastPt.x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;
    const color  = positive ? '#22c55e' : '#ef4444';

    return { line, fill, color, lastPt };
  }, [data, positive, W, H]);

  if (!paths) return <div style={{ width: W, height: H }} />;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={paths.color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={paths.color} stopOpacity="0"   />
        </linearGradient>
      </defs>
      <path d={paths.fill} fill={`url(#${id})`} />
      <path d={paths.line} fill="none" stroke={paths.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Live pip */}
      <circle cx={paths.lastPt.x} cy={paths.lastPt.y} r="2" fill={paths.color} opacity="0.85">
        <animate attributeName="opacity" values="0.85;0.3;0.85" dur="2.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

// ── SVG Main Chart ─────────────────────────────────────────────────────────────
//
// Pure SVG — zero dependencies, zero network calls, renders immediately.
// Reads from chartHist (module-level Map), redraws via React state on a 5s
// interval and whenever the parent signals new data via _chartRevision.
//
// Features: smooth bezier line, gradient fill, price axis labels (5 ticks),
// time axis labels, crosshair on hover with price/time tooltip, animated
// draw-on entry, live blinking pip at the latest value.

// Module-level revision counter — increment to tell the chart to redraw.
// loadQuotes calls bumpChartRevision() after seeding data.
let _chartRevision = 0;
let _bumpListeners: (() => void)[] = [];
function bumpChartRevision(): void {
  _chartRevision++;
  _bumpListeners.forEach(fn => fn());
}

const CHART_PAD = { top: 20, right: 68, bottom: 28, left: 8 } as const;

function buildSVGPaths(
  data: { time: number; value: number }[],
  W: number,
  H: number,
): { line: string; fill: string; min: number; max: number; pts: { x: number; y: number }[] } | null {
  if (data.length < 2) return null;

  const inner = {
    w: W - CHART_PAD.left - CHART_PAD.right,
    h: H - CHART_PAD.top  - CHART_PAD.bottom,
  };
  if (inner.w <= 0 || inner.h <= 0) return null;

  const times  = data.map(d => d.time);
  const values = data.map(d => d.value);
  const minT   = times[0],  maxT = times[times.length - 1];
  const minV   = Math.min(...values);
  const maxV   = Math.max(...values);
  const rangeV = maxV - minV || maxV * 0.001 || 1;
  const rangeT = maxT - minT || 1;

  const toX = (t: number) => CHART_PAD.left + ((t - minT) / rangeT) * inner.w;
  const toY = (v: number) => CHART_PAD.top  + (1 - (v - minV) / rangeV) * inner.h;

  const pts = data.map(d => ({ x: toX(d.time), y: toY(d.value) }));

  // Catmull-Rom → cubic bezier for smooth curves
  let line = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[Math.max(i - 2, 0)];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[Math.min(i + 1, pts.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  const lastPt = pts[pts.length - 1];
  const baseY  = CHART_PAD.top + inner.h;
  const fill   = `${line} L ${lastPt.x.toFixed(2)} ${baseY} L ${CHART_PAD.left} ${baseY} Z`;

  return { line, fill, min: minV, max: maxV, pts };
}

function formatAxisPrice(v: number): string {
  if (v >= 1000) return `$${v.toFixed(0)}`;
  if (v >= 10)   return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

function formatAxisTime(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function MainChart({ symbol, positive }: { symbol: string; positive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size,       setSize]       = useState({ w: 0, h: 0 });
  const [revision,   setRevision]   = useState(0);
  const [crosshair,  setCrosshair]  = useState<{ x: number; y: number; price: number; time: number } | null>(null);

  const lineColor = positive ? '#22c55e' : '#ef4444';
  const gradId    = `cg-${symbol.replace(/[^a-z0-9]/gi, '')}`;

  // Register for external bump notifications
  useEffect(() => {
    const fn = () => setRevision(r => r + 1);
    _bumpListeners.push(fn);
    return () => { _bumpListeners = _bumpListeners.filter(f => f !== fn); };
  }, []);

  // Size observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const e = entries[0];
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    // Seed immediately
    setSize({ w: el.offsetWidth, h: el.offsetHeight });
    return () => ro.disconnect();
  }, []);

  // Auto-redraw every 5s and push latest tick into history
  useEffect(() => {
    const iv = setInterval(() => {
      const p = tickLatest.get(symbol);
      if (p) { chartPush(symbol, p); setRevision(r => r + 1); }
    }, 5_000);
    return () => clearInterval(iv);
  }, [symbol]);

  // Redraw when symbol changes
  useEffect(() => { setRevision(r => r + 1); }, [symbol]);

  // suppress revision in deps — it's only used to force re-render
  void revision;

  const data = chartHist.get(symbol) ?? [];
  const { w, h } = size;
  const paths = w > 0 && h > 0 ? buildSVGPaths(data, w, h) : null;

  const innerH = h - CHART_PAD.top - CHART_PAD.bottom;
  const innerW = w - CHART_PAD.left - CHART_PAD.right;

  // Price axis: 5 horizontal ticks
  const priceTicks = paths ? Array.from({ length: 5 }, (_, i) => {
    const frac  = i / 4;
    const price = paths.min + frac * (paths.max - paths.min);
    const y     = CHART_PAD.top + (1 - frac) * innerH;
    return { price, y };
  }) : [];

  // Time axis: up to 5 time labels
  const timeTicks = (paths && data.length >= 2) ? (() => {
    const step = Math.floor(data.length / 4);
    const indices = [0, step, step * 2, step * 3, data.length - 1];
    return [...new Set(indices)].map(i => {
      const d = data[Math.min(i, data.length - 1)];
      const pt = paths.pts[Math.min(i, paths.pts.length - 1)];
      return { time: d.time, x: pt.x };
    });
  })() : [];

  // Crosshair hit detection
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!paths || data.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    // Find closest data point by x
    let closest = 0, minDist = Infinity;
    paths.pts.forEach((pt, i) => {
      const d = Math.abs(pt.x - mx);
      if (d < minDist) { minDist = d; closest = i; }
    });
    const pt  = paths.pts[closest];
    const val = data[closest].value;
    const ts  = data[closest].time;
    setCrosshair({ x: pt.x, y: pt.y, price: val, time: ts });
    void my;
  };

  return (
    <div ref={containerRef} className="w-full h-full">
      {w > 0 && h > 0 && (
        <svg
          width={w} height={h}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCrosshair(null)}
          style={{ display: 'block', cursor: 'crosshair' }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={lineColor} stopOpacity="0.22" />
              <stop offset="70%"  stopColor={lineColor} stopOpacity="0.05" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0"    />
            </linearGradient>
            {/* Glow filter for the line */}
            <filter id={`glow-${gradId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Horizontal grid lines at price ticks */}
          {priceTicks.map(({ y }, i) => (
            <line key={i}
              x1={CHART_PAD.left} y1={y.toFixed(2)}
              x2={w - CHART_PAD.right} y2={y.toFixed(2)}
              stroke="rgba(255,255,255,0.04)" strokeWidth="1"
            />
          ))}

          {/* Chart area — only when we have data */}
          {paths && (<>
            {/* Gradient fill */}
            <path d={paths.fill} fill={`url(#${gradId})`} />

            {/* Main line with glow */}
            <path
              d={paths.line}
              fill="none"
              stroke={lineColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={`url(#glow-${gradId})`}
              style={{
                strokeDasharray: 3000,
                strokeDashoffset: 0,
                animation: 'chartDraw 1.4s ease-out forwards',
              }}
            />

            {/* Live pip at latest value */}
            <circle
              cx={paths.pts[paths.pts.length - 1].x}
              cy={paths.pts[paths.pts.length - 1].y}
              r="3.5"
              fill={lineColor}
              style={{ filter: `drop-shadow(0 0 4px ${lineColor})` }}
            >
              <animate attributeName="r" values="3.5;5;3.5" dur="2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite" />
            </circle>

            {/* Price line (dashed horizontal at last price) */}
            <line
              x1={CHART_PAD.left}
              y1={paths.pts[paths.pts.length - 1].y.toFixed(2)}
              x2={w - CHART_PAD.right}
              y2={paths.pts[paths.pts.length - 1].y.toFixed(2)}
              stroke={lineColor}
              strokeWidth="0.5"
              strokeDasharray="3 4"
              opacity="0.3"
            />
          </>)}

          {/* Price axis labels — right side */}
          {priceTicks.map(({ price, y }, i) => (
            <text key={i}
              x={w - CHART_PAD.right + 6} y={y + 3}
              fontSize="9" fontFamily="'Share Tech Mono',monospace"
              fill="rgba(255,255,255,0.28)" textAnchor="start"
            >
              {formatAxisPrice(price)}
            </text>
          ))}

          {/* Time axis labels — bottom */}
          {timeTicks.map(({ time, x }, i) => (
            <text key={i}
              x={x} y={h - 6}
              fontSize="9" fontFamily="'Share Tech Mono',monospace"
              fill="rgba(255,255,255,0.22)" textAnchor="middle"
            >
              {formatAxisTime(time)}
            </text>
          ))}

          {/* Crosshair */}
          {crosshair && paths && (<>
            {/* Vertical line */}
            <line
              x1={crosshair.x.toFixed(2)} y1={CHART_PAD.top}
              x2={crosshair.x.toFixed(2)} y2={h - CHART_PAD.bottom}
              stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="3 3"
            />
            {/* Horizontal line */}
            <line
              x1={CHART_PAD.left} y1={crosshair.y.toFixed(2)}
              x2={w - CHART_PAD.right} y2={crosshair.y.toFixed(2)}
              stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="3 3"
            />
            {/* Dot at intersection */}
            <circle cx={crosshair.x} cy={crosshair.y} r="3.5"
              fill="#0a0c10" stroke={lineColor} strokeWidth="1.5" />
            {/* Price label on axis */}
            <rect
              x={w - CHART_PAD.right + 3} y={crosshair.y - 9}
              width={CHART_PAD.right - 5} height="16" rx="2"
              fill="#0a0c10" stroke={lineColor} strokeWidth="0.5" opacity="0.9"
            />
            <text
              x={w - CHART_PAD.right + 5} y={crosshair.y + 3}
              fontSize="9" fontFamily="'Share Tech Mono',monospace"
              fill={lineColor} textAnchor="start"
            >
              {formatAxisPrice(crosshair.price)}
            </text>
            {/* Time label on axis */}
            <rect
              x={crosshair.x - 22} y={h - CHART_PAD.bottom + 3}
              width="44" height="16" rx="2"
              fill="#0a0c10" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5"
            />
            <text
              x={crosshair.x} y={h - CHART_PAD.bottom + 14}
              fontSize="9" fontFamily="'Share Tech Mono',monospace"
              fill="rgba(255,255,255,0.55)" textAnchor="middle"
            >
              {formatAxisTime(crosshair.time)}
            </text>
          </>)}

          {/* No-data state */}
          {!paths && (
            <text
              x={w / 2} y={h / 2}
              fontSize="10" fontFamily="'Share Tech Mono',monospace"
              fill="rgba(255,255,255,0.12)" textAnchor="middle"
            >
              awaiting data…
            </text>
          )}
        </svg>
      )}

      {/* CSS keyframe for draw animation — injected once */}
      <style>{`
        @keyframes chartDraw {
          from { stroke-dashoffset: 3000; }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────────────

function OverviewTab({ apiKey }: { apiKey: string }) {
  const [quotes,      setQuotes]      = useState<Record<string, FinnhubQuote>>({});
  const [loadingQ,    setLoadingQ]    = useState(false);
  const [focus,       setFocus]       = useState('SPY');
  const [wsOn,        setWsOn]        = useState(false);
  const [tickCount,   setTickCount]   = useState(0);
  // Trigger sparkline redraws as ticks accumulate
  const [sparkRev,    setSparkRev]    = useState(0);

  const priceRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const prevPrice = useRef<Record<string, number>>({});

  const loadQuotes = useCallback(async (force = false) => {
    const key = 'ov_quotes';
    if (!force) {
      const cached = cacheGet<Record<string, FinnhubQuote>>(key, TTL_QUOTE);
      if (cached) {
        setQuotes(cached);
        // Chart may be mounting fresh — signal a redraw with existing chartHist data
        setTimeout(() => bumpChartRevision(), 100);
        return;
      }
    }
    setLoadingQ(true);
    const out: Record<string, FinnhubQuote> = {};
    for (const s of OVERVIEW_SYMBOLS) {
      try {
        const q = await finn<FinnhubQuote>(`/quote?symbol=${s.symbol}`, apiKey);
        out[s.symbol] = q;
        // Seed two points so the SVG chart always has a line from first load:
        // pc (prev close) anchors t-2; current price at t-1.
        if (q.pc > 0 && !chartHist.has(s.symbol)) {
          const now = Math.floor(Date.now() / 1000);
          chartHist.set(s.symbol, [
            { time: now - 2, value: q.pc },
            { time: now - 1, value: q.c  },
          ]);
        } else {
          chartPush(s.symbol, q.c);
        }
        // Notify chart to redraw when each symbol is seeded
        bumpChartRevision();
        await sleep(130);
      } catch { /**/ }
    }
    setQuotes(out);
    cacheSet(key, out);
    setLoadingQ(false);
  }, [apiKey]);

  useEffect(() => { loadQuotes(); }, [loadQuotes]);

  // Auto-refresh when TTL expires
  useEffect(() => {
    const iv = setInterval(() => loadQuotes(true), TTL_QUOTE);
    return () => clearInterval(iv);
  }, [loadQuotes]);

  // Sparkline redraw every 4s as ring buffers fill
  useEffect(() => {
    const iv = setInterval(() => setSparkRev(r => r + 1), 4_000);
    return () => clearInterval(iv);
  }, []);

  const handleTick = useCallback((sym: string, price: number) => {
    const el = priceRefs.current[sym];
    if (el) {
      const prev = prevPrice.current[sym] ?? price;
      prevPrice.current[sym] = price;
      el.textContent = fmtPrice(price);
      const up = price > prev, dn = price < prev;
      if (up || dn) {
        el.style.backgroundColor = up ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)';
        el.style.color            = up ? '#4ade80'              : '#f87171';
        setTimeout(() => { el.style.backgroundColor = 'transparent'; el.style.color = 'rgba(255,255,255,0.82)'; }, 700);
      }
    }
    setTickCount(c => c + 1);
  }, []);

  useFinanceWS(apiKey, handleTick, setWsOn);

  const focusDef   = OVERVIEW_SYMBOLS.find(s => s.symbol === focus)!;
  const focusQuote = quotes[focus];
  const focusDp    = focusQuote?.dp ?? 0;
  const focusPos   = focusDp >= 0;

  // sparkRev triggers re-render so sparklines pick up new ring data — intentional
  void sparkRev;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Chart panel ─────────────────────────────────────────────────── */}
      <div className="shrink-0 relative" style={{ height: 260, background: 'linear-gradient(180deg,#060810 0%,#0a0c12 100%)' }}>

        {/* Scan-line CRT texture */}
        <div className="absolute inset-0 pointer-events-none z-10"
          style={{ backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.07) 2px,rgba(0,0,0,0.07) 4px)' }} />

        {/* SVG Chart */}
        <div className="absolute inset-0 z-0">
          <MainChart symbol={focus} positive={focusPos} />
        </div>

        {/* Top-left overlay: symbol + price */}
        <div className="absolute top-3 left-3 z-20 pointer-events-none select-none">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-terminal text-white/30 uppercase tracking-[0.22em]">{focusDef.label}</span>
            <span className="text-[9px] font-mono text-white/18">{focus}</span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-[32px] font-mono font-light tracking-tight leading-none" style={{ color: 'rgba(255,255,255,0.92)' }}>
              {focusQuote?.c ? fmtPrice(focusQuote.c) : '—'}
            </span>
            <span className={`text-[16px] font-mono font-light leading-none ${focusPos ? 'text-emerald-400/85' : 'text-red-400/75'}`}>
              {focusDp >= 0 ? '+' : ''}{focusDp.toFixed(2)}%
            </span>
          </div>
          <div className="text-[9px] font-mono text-white/22 mt-1 tracking-wide">{focusDef.sublabel}</div>
        </div>

        {/* Top-right overlay: WS status */}
        <div className="absolute top-3 right-3 z-20 flex items-center gap-2 pointer-events-none select-none">
          <span className="text-[7px] font-mono text-white/18 tabular-nums">{tickCount.toLocaleString()} ticks</span>
          {wsOn
            ? <Wifi    className="w-3 h-3 text-emerald-400/50" />
            : <WifiOff className="w-3 h-3 text-red-400/40 animate-pulse" />}
        </div>

        {/* Bottom-left: data note */}
        <div className="absolute bottom-2 left-3 z-20 pointer-events-none">
          <span className="text-[7px] font-mono text-white/12 tracking-wide">session data · live ws</span>
        </div>

        {/* Bottom-right: refresh */}
        <div className="absolute bottom-2 right-3 z-20">
          <button
            onClick={() => loadQuotes(true)}
            disabled={loadingQ}
            className="flex items-center gap-1 text-[8px] font-mono text-white/20 hover:text-white/50 transition-colors disabled:opacity-30"
          >
            <RefreshCw className={`w-2.5 h-2.5 ${loadingQ ? 'animate-spin' : ''}`} />
            {cacheAge('ov_quotes')}
          </button>
        </div>
      </div>

      {/* ── Symbol grid ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.07) transparent' }}>

          {CATEGORIES.map(cat => {
            const syms  = OVERVIEW_SYMBOLS.filter(s => s.category === cat);
            const color = CAT_COLOR[cat];
            return (
              <div key={cat}>
                {/* Category divider */}
                <div className="flex items-center gap-2 px-4 pt-4 pb-2">
                  <div className="w-0.5 h-4 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
                  <span className="text-[10px] font-terminal uppercase tracking-[0.25em]" style={{ color: `${color}60` }}>{cat}</span>
                  <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg,${color}22,transparent)` }} />
                </div>

                {/* Cards — equal columns per category */}
                <div className="grid px-3 pb-2 gap-2" style={{ gridTemplateColumns: `repeat(${syms.length},1fr)` }}>
                  {syms.map(s => {
                    const q     = quotes[s.symbol];
                    const dp    = q?.dp ?? 0;
                    const pos   = dp >= 0;
                    const spark = getSparkData(s.symbol, q?.c);
                    const sel   = focus === s.symbol;

                    return (
                      <button
                        key={s.symbol}
                        onClick={() => setFocus(s.symbol)}
                        className="relative group text-left transition-all duration-200 overflow-hidden"
                        style={{
                          padding: '16px 18px 14px',
                          borderRadius: '2px',
                          border: `1px solid ${sel ? (pos ? 'rgba(34,197,94,0.32)' : 'rgba(239,68,68,0.32)') : 'rgba(255,255,255,0.05)'}`,
                          background: sel
                            ? `linear-gradient(135deg,rgba(${pos ? '34,197,94' : '239,68,68'},0.06) 0%,rgba(0,0,0,0.25) 100%)`
                            : 'rgba(255,255,255,0.012)',
                        }}
                      >
                        {/* Top accent line */}
                        <div className="absolute top-0 left-0 right-0 h-px transition-opacity duration-300"
                          style={{ background: `linear-gradient(90deg,transparent,${color}50,transparent)`, opacity: sel ? 1 : 0 }} />

                        {/* Type badge */}
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1">
                            <div className="w-1 h-1 rounded-full shrink-0"
                              style={{ backgroundColor: color, boxShadow: `0 0 3px ${color}` }} />
                            <span className="text-[7px] font-terminal uppercase tracking-[0.18em]"
                              style={{ color: `${color}70` }}>{s.type}</span>
                          </div>
                          {sel && <div className="w-1 h-1 rounded-full" style={{ backgroundColor: '#22c55e', boxShadow: '0 0 4px #22c55e' }} />}
                        </div>

                        {/* Label */}
                        <div className="mb-2.5">
                          <div className="text-[13px] font-terminal text-white/75 uppercase tracking-widest leading-none">{s.label}</div>
                          <div className="text-[9px] font-mono text-white/22 leading-none mt-1">{s.sublabel}</div>
                        </div>

                        {/* Sparkline */}
                        <div className="mb-3">
                          <Sparkline data={spark} positive={pos} W={90} H={36} />
                        </div>

                        {/* Price span — written directly by WebSocket tick handler */}
                        <span
                          ref={el => { priceRefs.current[s.symbol] = el; }}
                          className="block text-[18px] font-mono leading-none"
                          style={{
                            color: q?.c ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.2)',
                            borderRadius: '2px', padding: '1px 2px', margin: '-1px -2px',
                            transition: 'background-color 0.7s ease, color 0.7s ease',
                          }}
                        >
                          {q?.c ? fmtPrice(q.c) : '—'}
                        </span>

                        {/* Change */}
                        <div className="flex items-center gap-1.5 mt-1.5">
                          {dp > 0 && <TrendingUp   className="w-3.5 h-3.5 text-emerald-400/60 shrink-0" />}
                          {dp < 0 && <TrendingDown  className="w-3.5 h-3.5 text-red-400/55 shrink-0" />}
                          {dp === 0 && <Minus       className="w-3.5 h-3.5 text-white/15 shrink-0" />}
                          <span className={`text-[12px] font-mono ${dp > 0 ? 'text-emerald-400/80' : dp < 0 ? 'text-red-400/70' : 'text-white/22'}`}>
                            {dp !== 0 ? `${dp > 0 ? '+' : ''}${dp.toFixed(2)}%` : '—'}
                          </span>
                        </div>

                        {/* Hover ambient glow */}
                        <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                          style={{ background: `radial-gradient(ellipse at 50% 100%,${color}07 0%,transparent 65%)` }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Bottom padding */}
          <div className="h-3" />
        </div>
      </div>
    </div>
  );
}

// ── Screener tab ───────────────────────────────────────────────────────────────
//
// Two-panel layout:
//   Top  — heatmap grid: 4×5 tiles, color-saturated by move magnitude
//   Bottom — sorted detail table with price/change/range columns

// Convert a percentage change to a saturated rgba background
// Neutral (0%) → nearly black. Max move → full green/red.
function heatColor(dp: number, maxAbs: number): { bg: string; border: string; text: string } {
  if (maxAbs === 0) return { bg: 'rgba(255,255,255,0.02)', border: 'rgba(255,255,255,0.06)', text: '#ffffff' };
  const intensity = Math.min(Math.abs(dp) / maxAbs, 1);
  // Sigmoid-ish curve — small moves register visually, large moves saturate
  const sat = Math.pow(intensity, 0.55);
  if (dp > 0) {
    // Green: from near-black (#060810) to rich green
    const r = Math.round(6  + sat * (22  - 6));
    const g = Math.round(8  + sat * (163 - 8));
    const b = Math.round(16 + sat * (50  - 16));
    const a = 0.08 + sat * 0.30;
    const ba = 0.15 + sat * 0.55;
    return {
      bg:     `rgba(${r},${g},${b},${a.toFixed(2)})`,
      border: `rgba(34,197,94,${(ba * 0.45).toFixed(2)})`,
      text:   sat > 0.5 ? '#4ade80' : sat > 0.2 ? '#86efac' : 'rgba(255,255,255,0.65)',
    };
  } else {
    const r = Math.round(6  + sat * (239 - 6));
    const g = Math.round(8  + sat * (30  - 8));
    const b = Math.round(16 + sat * (30  - 16));
    const a = 0.08 + sat * 0.28;
    const ba = 0.15 + sat * 0.55;
    return {
      bg:     `rgba(${r},${g},${b},${a.toFixed(2)})`,
      border: `rgba(239,68,68,${(ba * 0.45).toFixed(2)})`,
      text:   sat > 0.5 ? '#f87171' : sat > 0.2 ? '#fca5a5' : 'rgba(255,255,255,0.65)',
    };
  }
}

function ScreenerTab({ apiKey }: { apiKey: string }) {
  const [rows,    setRows]    = useState<{ symbol: string; q: FinnhubQuote | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const key = 'sc_quotes';
    if (!force) {
      const c = cacheGet<{ symbol: string; q: FinnhubQuote | null }[]>(key, TTL_SCREENER);
      if (c) { setRows(c); return; }
    }
    setLoading(true);
    const out: { symbol: string; q: FinnhubQuote | null }[] = [];
    for (const sym of SCREENER_SYMBOLS) {
      try { out.push({ symbol: sym, q: await finn<FinnhubQuote>(`/quote?symbol=${sym}`, apiKey) }); }
      catch { out.push({ symbol: sym, q: null }); }
      await sleep(130);
    }
    setRows(out);
    cacheSet(key, out);
    setLoading(false);
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  // Heatmap ordered by absolute move (biggest movers most prominent)
  const heatRows = useMemo(() =>
    [...rows].sort((a, b) => Math.abs(b.q?.dp ?? 0) - Math.abs(a.q?.dp ?? 0)),
  [rows]);

  // Detail table: same sort
  const tableRows = heatRows;

  const maxAbs = useMemo(() =>
    Math.max(...rows.map(r => Math.abs(r.q?.dp ?? 0)), 0.01),
  [rows]);

  const TABLE_COLS    = '90px 120px 110px 100px 110px 110px 100px';
  const TABLE_HEADERS = ['SYMBOL', 'PRICE', 'CHG', 'CHG %', 'OPEN', 'HIGH', 'LOW'];

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Heatmap panel ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'hsl(var(--background))' }}>
        {loading ? (
          <div className="flex items-center justify-center gap-3 text-sm font-mono text-white/22"
            style={{ height: 228 }}>
            <Loader2 className="w-5 h-5 animate-spin" />
            loading {SCREENER_SYMBOLS.length} symbols…
          </div>
        ) : (
          <div
            className="grid p-3 gap-1.5"
            style={{ gridTemplateColumns: 'repeat(5, 1fr)', gridTemplateRows: 'repeat(4, 1fr)', height: 228 }}
          >
            {heatRows.map(({ symbol, q }) => {
              const dp     = q?.dp ?? 0;
              const pos    = dp >= 0;
              const colors = heatColor(dp, maxAbs);
              const isFocused = focused === symbol;

              return (
                <button
                  key={symbol}
                  onClick={() => setFocused(f => f === symbol ? null : symbol)}
                  className="relative flex flex-col items-center justify-center overflow-hidden transition-all duration-200 group"
                  style={{
                    background:   colors.bg,
                    border:       `1px solid ${isFocused ? (pos ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)') : colors.border}`,
                    borderRadius: '3px',
                    boxShadow:    isFocused ? `0 0 12px ${pos ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}` : 'none',
                  }}
                >
                  {/* Ambient radial glow on hover */}
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                    style={{ background: `radial-gradient(ellipse at 50% 50%, ${pos ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'} 0%, transparent 70%)` }} />

                  {/* Symbol */}
                  <span className="text-[11px] font-terminal font-medium tracking-widest text-white/50 leading-none mb-1">
                    {symbol}
                  </span>

                  {/* % change — dominant number */}
                  <span
                    className="text-[18px] font-mono font-semibold leading-none"
                    style={{ color: colors.text, textShadow: Math.abs(dp) > 1 ? `0 0 12px ${colors.text}60` : 'none' }}
                  >
                    {dp >= 0 ? '+' : ''}{dp.toFixed(2)}%
                  </span>

                  {/* Price */}
                  {q?.c ? (
                    <span className="text-[10px] font-mono text-white/35 leading-none mt-1">
                      ${q.c.toFixed(2)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        {/* Heatmap legend */}
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="flex items-center gap-3">
            <span className="text-[8px] font-mono text-white/18 uppercase tracking-widest">intensity</span>
            <div className="flex items-center gap-px">
              {[0.05, 0.2, 0.45, 0.7, 1].map((s, i) => (
                <div key={i} className="w-5 h-1.5 rounded-sm"
                  style={{ background: `rgba(34,197,94,${0.06 + s * 0.32})` }} />
              ))}
              <span className="ml-1 text-[8px] font-mono text-white/18">+{maxAbs.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-px">
              {[1, 0.7, 0.45, 0.2, 0.05].map((s, i) => (
                <div key={i} className="w-5 h-1.5 rounded-sm"
                  style={{ background: `rgba(239,68,68,${0.06 + s * 0.28})` }} />
              ))}
              <span className="ml-1 text-[8px] font-mono text-white/18">−{maxAbs.toFixed(1)}%</span>
            </div>
          </div>
          <span className="text-[8px] font-mono text-white/18">{SCREENER_SYMBOLS.length} symbols · click to highlight</span>
        </div>
      </div>

      {/* ── Detail table ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.07) transparent' }}>

          {/* Sticky header */}
          <div className="sticky top-0 z-10 grid"
            style={{ gridTemplateColumns: TABLE_COLS, background: 'hsl(var(--background))', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            {TABLE_HEADERS.map(h => (
              <div key={h} className="px-4 py-2.5 text-[9px] font-terminal text-white/25 uppercase tracking-[0.18em]">{h}</div>
            ))}
          </div>

          {!loading && tableRows.map(({ symbol, q }) => {
            const dp       = q?.dp ?? 0;
            const pos      = dp >= 0;
            const isFocused = focused === symbol;
            const colors   = heatColor(dp, maxAbs);

            return (
              <div
                key={symbol}
                onClick={() => setFocused(f => f === symbol ? null : symbol)}
                className="grid cursor-pointer group relative border-b transition-all duration-150"
                style={{
                  gridTemplateColumns: TABLE_COLS,
                  borderColor: 'rgba(255,255,255,0.035)',
                  minHeight: '40px',
                  background: isFocused ? colors.bg : 'transparent',
                }}
              >
                {/* Left accent */}
                <div className="absolute left-0 top-0 bottom-0 w-[3px] transition-opacity duration-200"
                  style={{
                    backgroundColor: pos ? '#22c55e' : '#ef4444',
                    boxShadow: pos ? '0 0 8px #22c55e50' : '0 0 8px #ef444450',
                    opacity: isFocused ? 1 : 0,
                  }} />

                {/* Hover bg */}
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none"
                  style={{ background: 'rgba(255,255,255,0.018)' }} />

                <div className="px-4 flex items-center">
                  <span className="text-[13px] font-terminal font-medium" style={{ color: pos ? '#4ade80' : '#f87171' }}>
                    {symbol}
                  </span>
                </div>
                <div className="px-4 flex items-center text-[13px] font-mono text-white/62">
                  {q ? `$${q.c.toFixed(2)}` : '—'}
                </div>
                <div className={`px-4 flex items-center text-[13px] font-mono ${pos ? 'text-emerald-400/72' : 'text-red-400/65'}`}>
                  {q ? `${dp >= 0 ? '+' : ''}${q.d.toFixed(2)}` : '—'}
                </div>
                <div className={`px-4 flex items-center text-[14px] font-mono font-semibold ${pos ? 'text-emerald-400/88' : 'text-red-400/80'}`}>
                  {q ? `${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%` : '—'}
                </div>
                <div className="px-4 flex items-center text-[12px] font-mono text-white/32">
                  {q ? `$${q.o.toFixed(2)}` : '—'}
                </div>
                <div className="px-4 flex items-center text-[12px] font-mono text-white/32">
                  {q ? `$${q.h.toFixed(2)}` : '—'}
                </div>
                <div className="px-4 flex items-center text-[12px] font-mono text-white/32">
                  {q ? `$${q.l.toFixed(2)}` : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between px-4 py-1.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'hsl(var(--background))' }}>
        <span className="text-[8px] font-mono text-white/15">sorted by absolute move · {cacheAge('sc_quotes')}</span>
        <button onClick={() => load(true)} disabled={loading}
          className="flex items-center gap-1.5 text-[9px] font-mono text-white/20 hover:text-white/50 transition-colors disabled:opacity-30">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />refresh
        </button>
      </div>
    </div>
  );
}

// ── Calendar tab ───────────────────────────────────────────────────────────────
//
// 14-day grouped earnings timeline.
// Within each date group, items are sorted: actuals first, then by estimate
// presence, then alphabetical. Items with zero data are dimmed and placed last.

function CalendarTab({ apiKey }: { apiKey: string }) {
  const [items,   setItems]   = useState<EarningsItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    const key = 'cal_data';
    if (!force) {
      const c = cacheGet<EarningsItem[]>(key, TTL_CALENDAR);
      if (c) { setItems(c); return; }
    }
    setLoading(true);
    const fmt    = (d: Date) => d.toISOString().split('T')[0];
    const today  = new Date();
    const next14 = new Date(today);
    next14.setDate(today.getDate() + 14);
    try {
      const d = await finn<{ earningsCalendar: EarningsItem[] }>(
        `/calendar/earnings?from=${fmt(today)}&to=${fmt(next14)}`, apiKey
      );
      const data = (d.earningsCalendar ?? []).slice(0, 200);
      setItems(data);
      cacheSet(key, data);
    } catch { /**/ }
    setLoading(false);
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  // Score for sorting within a date group:
  // 3 = has actuals, 2 = has estimates, 1 = has symbol only
  const score = (item: EarningsItem): number => {
    if (item.epsActual != null || item.revenueActual != null) return 3;
    if (item.epsEstimate != null || item.revenueEstimate != null) return 2;
    return 1;
  };

  // Group by date, sort within each group
  const grouped = useMemo(() => {
    const map = new Map<string, EarningsItem[]>();
    items.forEach(item => {
      if (!map.has(item.date)) map.set(item.date, []);
      map.get(item.date)!.push(item);
    });
    // Sort each group: high score first, then alpha
    map.forEach((group, date) => {
      map.set(date, group.sort((a, b) => {
        const sd = score(b) - score(a);
        return sd !== 0 ? sd : a.symbol.localeCompare(b.symbol);
      }));
    });
    // Return dates in ascending order
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const totalWithData = useMemo(() =>
    items.filter(i => i.epsEstimate != null || i.revenueEstimate != null).length,
  [items]);

  // Human-readable date header: "TUE MAY 20"
  const fmtDateHeader = (dateStr: string): { dow: string; date: string } => {
    const d   = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids TZ edge
    const dow = ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getUTCDay()];
    const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
    return { dow, date: `${mon} ${d.getUTCDate()}` };
  };

  // Is today's date string?
  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0 relative">
        <div
          className="absolute inset-0 overflow-y-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.07) transparent' }}
        >
          {loading ? (
            <div className="flex items-center justify-center h-48 gap-3 text-sm font-mono text-white/22">
              <Loader2 className="w-5 h-5 animate-spin" />loading 14-day calendar…
            </div>
          ) : grouped.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-sm font-mono text-white/18">
              no earnings in the next 14 days
            </div>
          ) : grouped.map(([dateStr, group]) => {
            const { dow, date } = fmtDateHeader(dateStr);
            const isToday       = dateStr === todayStr;
            const hasData       = group.some(i => i.epsEstimate != null || i.revenueEstimate != null);

            return (
              <div key={dateStr}>
                {/* ── Date divider ─────────────────────────────────────── */}
                <div
                  className="flex items-center gap-4 px-5 pt-5 pb-3 sticky top-0 z-10"
                  style={{ background: 'hsl(var(--background))' }}
                >
                  {/* Day block */}
                  <div
                    className="flex flex-col items-center justify-center shrink-0 rounded-sm"
                    style={{
                      width: 52, height: 44,
                      background: isToday ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isToday ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.07)'}`,
                    }}
                  >
                    <span
                      className="text-[8px] font-terminal tracking-[0.2em]"
                      style={{ color: isToday ? '#4ade80' : 'rgba(255,255,255,0.3)' }}
                    >
                      {dow}
                    </span>
                    <span
                      className="text-[14px] font-mono font-semibold leading-tight"
                      style={{ color: isToday ? '#4ade80' : 'rgba(255,255,255,0.65)' }}
                    >
                      {date.split(' ')[1]}
                    </span>
                    <span
                      className="text-[7px] font-mono"
                      style={{ color: isToday ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.2)' }}
                    >
                      {date.split(' ')[0]}
                    </span>
                  </div>

                  {/* Rule + count */}
                  <div className="flex-1 flex items-center gap-3">
                    <div
                      className="flex-1 h-px"
                      style={{
                        background: isToday
                          ? 'linear-gradient(90deg, rgba(34,197,94,0.4), transparent)'
                          : 'linear-gradient(90deg, rgba(255,255,255,0.08), transparent)',
                      }}
                    />
                    <span className="text-[9px] font-mono text-white/20 shrink-0">
                      {group.length} reporting
                      {hasData ? ` · ${group.filter(i => i.epsEstimate != null).length} with estimates` : ''}
                    </span>
                  </div>
                </div>

                {/* ── Earnings cards grid ──────────────────────────────── */}
                <div className="px-4 pb-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {group.map((item, idx) => {
                    const s      = score(item);
                    const dimmed = s === 1; // no estimates, no actuals
                    const beat   = item.epsActual != null && item.epsEstimate != null && item.epsActual >= item.epsEstimate;
                    const missed = item.epsActual != null && item.epsEstimate != null && item.epsActual < item.epsEstimate;
                    const isPre  = item.hour === 'bmo';
                    const isPost = item.hour === 'amc';

                    // Border/background based on beat/miss/pending
                    const cardBorder = beat
                      ? 'rgba(34,197,94,0.25)'
                      : missed
                        ? 'rgba(239,68,68,0.22)'
                        : 'rgba(255,255,255,0.06)';
                    const cardBg = beat
                      ? 'rgba(34,197,94,0.04)'
                      : missed
                        ? 'rgba(239,68,68,0.04)'
                        : 'rgba(255,255,255,0.015)';

                    return (
                      <div
                        key={`${item.symbol}-${idx}`}
                        className="relative flex flex-col transition-all duration-200 group"
                        style={{
                          padding: '14px 16px 12px',
                          borderRadius: '3px',
                          border: `1px solid ${cardBorder}`,
                          background: cardBg,
                          opacity: dimmed ? 0.35 : 1,
                        }}
                      >
                        {/* Hover reveal for dimmed items */}
                        {dimmed && (
                          <div className="absolute inset-0 rounded-sm opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                            style={{ background: 'rgba(255,255,255,0.02)' }} />
                        )}

                        {/* Beat/miss top bar */}
                        {(beat || missed) && (
                          <div
                            className="absolute top-0 left-0 right-0 h-0.5 rounded-t-sm"
                            style={{ background: beat ? '#22c55e' : '#ef4444' }}
                          />
                        )}

                        {/* Symbol + timing row */}
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <span
                            className="text-[17px] font-terminal font-medium leading-none"
                            style={{ color: beat ? '#4ade80' : missed ? '#f87171' : 'rgba(255,255,255,0.82)' }}
                          >
                            {item.symbol}
                          </span>
                          {(isPre || isPost) && (
                            <span
                              className="text-[8px] font-terminal tracking-[0.15em] px-1.5 py-0.5 rounded-sm shrink-0"
                              style={{
                                background: isPre ? 'rgba(251,191,36,0.1)' : 'rgba(139,92,246,0.1)',
                                border: `1px solid ${isPre ? 'rgba(251,191,36,0.25)' : 'rgba(139,92,246,0.25)'}`,
                                color: isPre ? '#fbbf24' : '#a78bfa',
                              }}
                            >
                              {isPre ? '▲ PRE' : '▼ POST'}
                            </span>
                          )}
                        </div>

                        {/* EPS row */}
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[9px] font-mono text-white/25 uppercase tracking-widest">EPS</span>
                          <div className="flex items-center gap-2">
                            {item.epsEstimate != null && (
                              <span className="text-[11px] font-mono text-white/40">
                                est {item.epsEstimate >= 0 ? '' : ''}{item.epsEstimate.toFixed(2)}
                              </span>
                            )}
                            {item.epsActual != null ? (
                              <span
                                className="text-[13px] font-mono font-semibold"
                                style={{ color: beat ? '#4ade80' : missed ? '#f87171' : 'rgba(255,255,255,0.7)' }}
                              >
                                {item.epsActual >= 0 ? '+' : ''}{item.epsActual.toFixed(2)}
                              </span>
                            ) : item.epsEstimate == null ? (
                              <span className="text-[11px] font-mono text-white/18">—</span>
                            ) : null}
                          </div>
                        </div>

                        {/* Revenue row */}
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-mono text-white/25 uppercase tracking-widest">REV</span>
                          <div className="flex items-center gap-2">
                            {item.revenueEstimate != null && (
                              <span className="text-[11px] font-mono text-white/40">
                                est {fmtRev(item.revenueEstimate)}
                              </span>
                            )}
                            {item.revenueActual != null ? (
                              <span
                                className="text-[13px] font-mono font-semibold"
                                style={{
                                  color: item.revenueEstimate != null
                                    ? item.revenueActual >= item.revenueEstimate ? '#4ade80' : '#f87171'
                                    : 'rgba(255,255,255,0.7)',
                                }}
                              >
                                {fmtRev(item.revenueActual)}
                              </span>
                            ) : item.revenueEstimate == null ? (
                              <span className="text-[11px] font-mono text-white/18">—</span>
                            ) : null}
                          </div>
                        </div>

                        {/* Beat/miss badge */}
                        {(beat || missed) && (
                          <div
                            className="absolute bottom-2 right-3 text-[7px] font-terminal tracking-[0.2em] uppercase"
                            style={{ color: beat ? 'rgba(74,222,128,0.5)' : 'rgba(248,113,113,0.5)' }}
                          >
                            {beat ? 'BEAT' : 'MISS'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="h-4" />
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between px-5 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'hsl(var(--background))' }}>
        <span className="text-[8px] font-mono text-white/18">
          next 14 days · {totalWithData} with estimates · {cacheAge('cal_data')}
        </span>
        <button onClick={() => load(true)} disabled={loading}
          className="flex items-center gap-1.5 text-[9px] font-mono text-white/20 hover:text-white/50 transition-colors disabled:opacity-30">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />refresh
        </button>
      </div>
    </div>
  );
}

// ── News tab ───────────────────────────────────────────────────────────────────
//
// Features:
//   - Category filter bar: GENERAL / FOREX / CRYPTO / MERGER
//   - Per-category TTL cache (separate keys)
//   - Client-side sentiment scoring via keyword match → left border tint
//   - Featured top story (full-width, larger treatment)
//   - Headline deduplication (same headline from multiple sources → keep first)
//   - Source initial badge replacing numbered index

type NewsCategory = 'general' | 'forex' | 'crypto' | 'merger';

const NEWS_CATEGORIES: { id: NewsCategory; label: string }[] = [
  { id: 'general', label: 'GENERAL' },
  { id: 'forex',   label: 'FOREX'   },
  { id: 'crypto',  label: 'CRYPTO'  },
  { id: 'merger',  label: 'M&A'     },
];

const POSITIVE_WORDS = [
  'surge', 'surges', 'rally', 'rallies', 'beat', 'beats', 'record', 'soar', 'soars',
  'gain', 'gains', 'jump', 'jumps', 'rise', 'rises', 'upgrade', 'upgrades',
  'profit', 'growth', 'strong', 'bullish', 'recovery', 'outperform',
];
const NEGATIVE_WORDS = [
  'crash', 'crashes', 'plunge', 'plunges', 'miss', 'misses', 'warning', 'warns',
  'deficit', 'recession', 'tumble', 'tumbles', 'tank', 'tanks', 'fall', 'falls',
  'drop', 'drops', 'decline', 'declines', 'weak', 'bearish', 'cut', 'cuts',
  'loss', 'losses', 'default', 'bankrupt', 'layoff', 'layoffs', 'downgrade',
];

function scoreSentiment(headline: string, summary: string): 'positive' | 'negative' | 'neutral' {
  const text  = `${headline} ${summary}`.toLowerCase();
  const words = text.split(/\W+/);
  const pos   = words.filter(w => POSITIVE_WORDS.includes(w)).length;
  const neg   = words.filter(w => NEGATIVE_WORDS.includes(w)).length;
  if (pos > neg && pos > 0) return 'positive';
  if (neg > pos && neg > 0) return 'negative';
  return 'neutral';
}

function dedupeByHeadline(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    // Normalise: lowercase, strip punctuation, first 60 chars
    const key = item.headline.toLowerCase().replace(/[^\w\s]/g, '').slice(0, 60).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Source → short display name (Finnhub returns full URLs sometimes)
function fmtSource(src: string): string {
  return src
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('.')[0]
    .toUpperCase()
    .slice(0, 12);
}

// First letter of source for the badge
function sourceInitial(src: string): string {
  return fmtSource(src).charAt(0);
}

// Colour per source initial (deterministic)
function sourceBadgeColor(src: string): string {
  const COLORS = ['#22c55e','#3b82f6','#f59e0b','#a855f7','#06b6d4','#ec4899','#14b8a6'];
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) & 0xffff;
  return COLORS[h % COLORS.length];
}

function NewsTab({ apiKey }: { apiKey: string }) {
  const [category, setCategory] = useState<NewsCategory>('general');
  const [items,    setItems]    = useState<NewsItem[]>([]);
  const [loading,  setLoading]  = useState(false);

  const cacheKey = `news_${category}`;

  const load = useCallback(async (force = false) => {
    if (!force) {
      const c = cacheGet<NewsItem[]>(cacheKey, TTL_NEWS);
      if (c) { setItems(c); return; }
    }
    setLoading(true);
    try {
      const d    = await finn<NewsItem[]>(`/news?category=${category}&minId=0`, apiKey);
      const data = dedupeByHeadline(d).slice(0, 50);
      setItems(data);
      cacheSet(cacheKey, data);
    } catch { /**/ }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, category]);

  useEffect(() => { load(); }, [load]);

  const sentimentBorder = (s: ReturnType<typeof scoreSentiment>) =>
    s === 'positive' ? 'rgba(34,197,94,0.5)'
    : s === 'negative' ? 'rgba(239,68,68,0.45)'
    : 'rgba(255,255,255,0.06)';

  const sentimentBg = (s: ReturnType<typeof scoreSentiment>) =>
    s === 'positive' ? 'rgba(34,197,94,0.03)'
    : s === 'negative' ? 'rgba(239,68,68,0.03)'
    : 'transparent';

  const featured = items[0] ?? null;
  const rest     = items.slice(1);

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Category filter bar ──────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-2.5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'hsl(var(--background))' }}>
        {NEWS_CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategory(cat.id)}
            className="px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.14em] rounded-sm transition-all duration-200"
            style={{
              color:      category === cat.id ? '#4ade80'                   : 'rgba(255,255,255,0.28)',
              background: category === cat.id ? 'rgba(34,197,94,0.08)'      : 'transparent',
              border:     `1px solid ${category === cat.id ? 'rgba(34,197,94,0.28)' : 'transparent'}`,
              boxShadow:  category === cat.id ? '0 0 10px rgba(34,197,94,0.1)' : 'none',
            }}
          >
            {cat.label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[8px] font-mono text-white/18">{cacheAge(cacheKey)}</span>
      </div>

      {/* ── Scrollable content ───────────────────────────────────────────── */}
      {/* absolute inset-0 required — flex-1 without explicit ancestor height produces 0px */}
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.07) transparent' }}>

          {loading ? (
            <div className="flex items-center justify-center h-48 gap-3 text-sm font-mono text-white/22">
              <Loader2 className="w-5 h-5 animate-spin" />loading {category} news…
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-sm font-mono text-white/18">
              no {category} news available
            </div>
          ) : (<>

            {/* ── Featured story ─────────────────────────────────────────── */}
            {featured && (() => {
              const sent    = scoreSentiment(featured.headline, featured.summary ?? '');
              const srcCol  = sourceBadgeColor(featured.source);
              const srcInit = sourceInitial(featured.source);
              return (
                <a
                  href={featured.url} target="_blank" rel="noopener noreferrer"
                  className="block px-5 pt-5 pb-4 group transition-all relative"
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    borderLeft:   `3px solid ${sentimentBorder(sent)}`,
                    background:   sentimentBg(sent),
                  }}
                >
                  {/* Hover overlay */}
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    style={{ background: 'rgba(255,255,255,0.018)' }} />

                  {/* Meta row */}
                  <div className="flex items-center gap-3 mb-3">
                    {/* Source badge */}
                    <div
                      className="w-7 h-7 rounded-sm flex items-center justify-center text-[11px] font-terminal font-bold shrink-0"
                      style={{ background: `${srcCol}18`, border: `1px solid ${srcCol}35`, color: srcCol }}
                    >
                      {srcInit}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-terminal text-white/35 uppercase tracking-[0.18em] leading-none">
                        {fmtSource(featured.source)}
                      </span>
                      <span className="text-[9px] font-mono text-white/20 leading-none mt-0.5">
                        {newsAge(featured.datetime)}
                      </span>
                    </div>
                    {sent !== 'neutral' && (
                      <span
                        className="ml-auto text-[7px] font-terminal tracking-[0.2em] px-2 py-0.5 rounded-sm"
                        style={{
                          color:      sent === 'positive' ? '#4ade80' : '#f87171',
                          background: sent === 'positive' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                          border:     `1px solid ${sent === 'positive' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
                        }}
                      >
                        {sent === 'positive' ? '▲ BULLISH' : '▼ BEARISH'}
                      </span>
                    )}
                  </div>

                  {/* Headline */}
                  <p className="text-[18px] font-mono text-white/82 group-hover:text-white/95 transition-colors leading-snug mb-3">
                    {featured.headline}
                  </p>

                  {/* Summary */}
                  {featured.summary && featured.summary !== featured.headline && (
                    <p className="text-[13px] font-mono text-white/38 leading-relaxed line-clamp-3">
                      {featured.summary}
                    </p>
                  )}

                  <div className="flex items-center gap-1.5 mt-3 text-[9px] font-mono text-white/25 group-hover:text-white/50 transition-colors">
                    <span>Read full story</span>
                    <ArrowRight className="w-3 h-3" />
                  </div>
                </a>
              );
            })()}

            {/* ── Story list ─────────────────────────────────────────────── */}
            {rest.map((item, i) => {
              const sent    = scoreSentiment(item.headline, item.summary ?? '');
              const srcCol  = sourceBadgeColor(item.source);
              const srcInit = sourceInitial(item.source);

              return (
                <a
                  key={item.id}
                  href={item.url} target="_blank" rel="noopener noreferrer"
                  className="flex gap-4 px-5 py-4 group relative transition-all"
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.035)',
                    borderLeft:   `3px solid ${sentimentBorder(sent)}`,
                    background:   sentimentBg(sent),
                  }}
                >
                  {/* Hover overlay */}
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    style={{ background: 'rgba(255,255,255,0.018)' }} />

                  {/* Source badge */}
                  <div
                    className="w-8 h-8 rounded-sm flex items-center justify-center text-[12px] font-terminal font-bold shrink-0 mt-0.5"
                    style={{ background: `${srcCol}15`, border: `1px solid ${srcCol}28`, color: srcCol }}
                  >
                    {srcInit}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Source + age */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[9px] font-terminal text-white/30 uppercase tracking-[0.15em]">
                        {fmtSource(item.source)}
                      </span>
                      <span className="text-[9px] font-mono text-white/18">{newsAge(item.datetime)}</span>
                      {sent !== 'neutral' && (
                        <span
                          className="text-[7px] font-terminal tracking-widest px-1.5 py-px rounded-sm ml-auto"
                          style={{
                            color:      sent === 'positive' ? 'rgba(74,222,128,0.6)' : 'rgba(248,113,113,0.6)',
                            background: sent === 'positive' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                          }}
                        >
                          {sent === 'positive' ? '▲' : '▼'}
                        </span>
                      )}
                    </div>

                    {/* Headline */}
                    <p className="text-[14px] font-mono text-white/68 group-hover:text-white/88 transition-colors leading-snug">
                      {item.headline}
                    </p>

                    {/* Summary — only if meaningfully different */}
                    {item.summary && item.summary !== item.headline && item.summary.length > 20 && (
                      <p className="text-[11px] font-mono text-white/28 leading-relaxed mt-1.5 line-clamp-2">
                        {item.summary}
                      </p>
                    )}
                  </div>

                  <ArrowRight className="w-4 h-4 text-white/18 shrink-0 self-center opacity-0 group-hover:opacity-60 transition-opacity" />
                </a>
              );
            })}

            <div className="h-4" />
          </>)}
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-5 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'hsl(var(--background))' }}>
        <span className="text-[8px] font-mono text-white/18">
          {items.length} stories · deduplicated · sentiment scored
        </span>
        <button
          onClick={() => load(true)} disabled={loading}
          className="flex items-center gap-1.5 text-[9px] font-mono text-white/20 hover:text-white/50 transition-colors disabled:opacity-30"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />refresh
        </button>
      </div>
    </div>
  );
}

// ── Key wizard ─────────────────────────────────────────────────────────────────

function KeyWizard({ onKey }: { onKey: (k: string) => void }) {
  const [step,    setStep]    = useState<1 | 2 | 3>(1);
  const [input,   setInput]   = useState('');
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);

  const validate = useCallback(async () => {
    const key = input.trim();
    if (!key) { setError('Paste your API key above.'); return; }
    setLoading(true); setError('');
    try {
      await finn<FinnhubQuote>('/quote?symbol=AAPL', key);
      localStorage.setItem(STORAGE_KEY, key);
      onKey(key);
    } catch { setError('Key rejected. Double-check and try again.'); }
    finally { setLoading(false); }
  }, [input, onKey]);

  const STEP_LABELS = ['Create account', 'Get API key', 'Connect'];

  return (
    <div className="flex-1 flex items-center justify-center relative overflow-hidden" style={{ background: 'hsl(var(--background))' }}>

      {/* Ambient grid */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: `linear-gradient(rgba(34,197,94,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(34,197,94,0.012) 1px,transparent 1px)`,
        backgroundSize: '44px 44px',
      }} />
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 55%,rgba(34,197,94,0.035) 0%,transparent 60%)' }} />

      <div className="relative z-10 w-full max-w-md px-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-[7px] font-terminal text-phobos-green/35 uppercase tracking-[0.4em] mb-2">PHOBOS MARKETS TERMINAL</div>
          <div className="text-[11px] font-terminal text-white/28 uppercase tracking-[0.22em]">Connect Market Data</div>
        </div>

        {/* Step row */}
        <div className="flex items-center justify-center mb-8">
          {([1, 2, 3] as const).map((s, i) => (
            <div key={s} className="flex items-center">
              <div className="flex flex-col items-center gap-1 cursor-pointer" onClick={() => s < step && setStep(s)}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-mono transition-all duration-300"
                  style={{
                    border: `1px solid ${step === s ? '#22c55e' : step > s ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.1)'}`,
                    background: step === s ? 'rgba(34,197,94,0.12)' : step > s ? 'rgba(34,197,94,0.05)' : 'transparent',
                    color: step === s ? '#4ade80' : step > s ? 'rgba(34,197,94,0.45)' : 'rgba(255,255,255,0.2)',
                    boxShadow: step === s ? '0 0 14px rgba(34,197,94,0.22)' : 'none',
                  }}>
                  {step > s ? '✓' : s}
                </div>
                <span className="text-[6px] font-mono text-white/18 uppercase tracking-widest whitespace-nowrap">{STEP_LABELS[i]}</span>
              </div>
              {i < 2 && <div className="w-14 h-px mx-2 mb-4" style={{ background: step > s ? 'rgba(34,197,94,0.28)' : 'rgba(255,255,255,0.06)' }} />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="space-y-4">
          {step === 1 && (<>
            <div className="p-4 rounded-sm" style={{ border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.018)' }}>
              <p className="text-[10px] font-mono text-white/42 leading-relaxed">
                Finnhub provides real-time market data — stocks, forex, crypto, earnings, and news.
                Free tier: <span className="text-phobos-green/55">60 req/min</span> + <span className="text-phobos-green/55">live WebSocket</span>. No credit card.
              </p>
            </div>
            <a href="https://finnhub.io/register" target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-between w-full px-4 py-3 rounded-sm group text-xs font-mono transition-all"
              style={{ border: '1px solid rgba(34,197,94,0.18)', background: 'rgba(34,197,94,0.04)', color: 'rgba(34,197,94,0.6)' }}>
              <span>finnhub.io/register</span>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
            </a>
            <button onClick={() => setStep(2)} className="w-full text-center text-[9px] font-mono text-white/22 hover:text-white/45 transition-colors">
              already have an account →
            </button>
          </>)}

          {step === 2 && (<>
            <div className="p-4 rounded-sm" style={{ border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.018)' }}>
              <p className="text-[10px] font-mono text-white/42 leading-relaxed">
                After logging in, copy your API key from the dashboard — a long string like{' '}
                <code className="text-phobos-green/38 text-[9px]">cn7abc123xyz…</code>
              </p>
            </div>
            <a href="https://finnhub.io/dashboard" target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-between w-full px-4 py-3 rounded-sm group text-xs font-mono transition-all"
              style={{ border: '1px solid rgba(34,197,94,0.18)', background: 'rgba(34,197,94,0.04)', color: 'rgba(34,197,94,0.6)' }}>
              <span>finnhub.io/dashboard</span>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
            </a>
            <div className="flex gap-4">
              <button onClick={() => setStep(1)} className="text-[9px] font-mono text-white/18 hover:text-white/40 transition-colors">← back</button>
              <button onClick={() => setStep(3)} className="text-[9px] font-mono text-white/22 hover:text-white/48 transition-colors">got the key →</button>
            </div>
          </>)}

          {step === 3 && (<>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-sm"
              style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.28)' }}>
              <Key className="w-3.5 h-3.5 text-white/18 shrink-0" />
              <input type="text" placeholder="cn7abc123xyz…" value={input}
                onChange={e => { setInput(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && validate()}
                className="flex-1 bg-transparent text-xs font-mono text-white/68 placeholder:text-white/14 outline-none"
                autoFocus spellCheck={false} />
            </div>
            {error && (
              <div className="flex items-center gap-2 text-[9px] font-mono text-red-400/55">
                <AlertCircle className="w-3 h-3 shrink-0" />{error}
              </div>
            )}
            <button onClick={validate} disabled={loading || !input.trim()}
              className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-sm text-xs font-mono transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ border: '1px solid rgba(34,197,94,0.22)', background: 'rgba(34,197,94,0.07)', color: 'rgba(34,197,94,0.72)' }}>
              {loading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Validating…</> : <><CheckCircle className="w-3.5 h-3.5" />Connect</>}
            </button>
            <button onClick={() => setStep(2)} className="text-[9px] font-mono text-white/18 hover:text-white/40 transition-colors">← back</button>
          </>)}
        </div>

        <p className="text-[6px] font-mono text-white/12 text-center mt-6 leading-relaxed">
          Key stored locally on this device only. Sent directly to Finnhub — nowhere else.
        </p>
      </div>
    </div>
  );
}

// ── Root panel ─────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'screener' | 'calendar' | 'news';

interface FinancePanelProps { onClose: () => void; }

export function FinancePanel({ onClose }: FinancePanelProps) {
  const [apiKey,    setApiKey]    = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const disconnect = () => {
    localStorage.removeItem(STORAGE_KEY);
    _cache.clear();   // wipe stale cached data
    setApiKey(null);
  };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'OVERVIEW' },
    { id: 'screener', label: 'SCREENER' },
    { id: 'calendar', label: 'CALENDAR' },
    { id: 'news',     label: 'NEWS'     },
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: 'hsl(var(--background))' }}>

      {/* Global CRT scan-line overlay */}
      <div className="absolute inset-0 pointer-events-none z-50"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.055) 3px,rgba(0,0,0,0.055) 4px)' }} />

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <header className="relative z-10 h-10 flex items-center gap-0 px-3 shrink-0"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.055)',
          background: 'linear-gradient(180deg,rgba(255,255,255,0.022) 0%,transparent 100%)',
        }}>

        {/* Brand */}
        <div className="flex items-center gap-2 pr-4 mr-2 border-r border-white/[0.07]">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#22c55e', boxShadow: '0 0 7px #22c55e, 0 0 14px rgba(34,197,94,0.3)' }} />
          <span className="text-[9px] font-terminal text-phobos-green/55 uppercase tracking-[0.22em]">MARKETS</span>
        </div>

        {apiKey && (
          <div className="flex items-center gap-0.5">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className="px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.13em] rounded-sm transition-all duration-200"
                style={{
                  color: activeTab === t.id ? '#4ade80' : 'rgba(255,255,255,0.28)',
                  background: activeTab === t.id ? 'rgba(34,197,94,0.08)' : 'transparent',
                  border: `1px solid ${activeTab === t.id ? 'rgba(34,197,94,0.28)' : 'transparent'}`,
                  boxShadow: activeTab === t.id ? '0 0 10px rgba(34,197,94,0.1)' : 'none',
                }}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {apiKey && (
          <button onClick={disconnect}
            className="text-[7px] font-mono text-white/15 hover:text-white/38 uppercase tracking-widest transition-colors mr-3">
            disconnect
          </button>
        )}

        <button onClick={onClose} className="p-1.5 rounded-sm text-white/22 hover:text-white/60 hover:bg-white/[0.04] transition-all">
          <XIcon className="w-4 h-4" />
        </button>
      </header>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      {!apiKey ? (
        <KeyWizard onKey={setApiKey} />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative z-10">
          {activeTab === 'overview' && <OverviewTab  apiKey={apiKey} />}
          {activeTab === 'screener' && <ScreenerTab  apiKey={apiKey} />}
          {activeTab === 'calendar' && <CalendarTab  apiKey={apiKey} />}
          {activeTab === 'news'     && <NewsTab      apiKey={apiKey} />}
        </div>
      )}
    </div>
  );
}
