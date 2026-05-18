/**
 * MasterEq.tsx
 *
 * Floating 8-band parametric EQ panel.
 * Matches the PHOBOS dark aesthetic: deep navy/slate palette, teal accents,
 * Courier New labels — consistent with Crystal, PolarisPlayer, etc.
 *
 * Placement: mount in HeaderBar.tsx alongside PolarisPlayer (same pattern).
 * Trigger: EQ icon button in the Polaris player bar sets eqOpen in useAppStore
 * (or local state in the trigger component).
 *
 * REST surface used:
 *   GET  /api/audio/eq/state
 *   POST /api/audio/eq/band     { band, gainDb, q, enabled }
 *   POST /api/audio/eq/enabled  { enabled }
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface BandState {
  gainDb:  number;
  q:       number;
  enabled: boolean;
}

interface EqState {
  enabled: boolean;
  bands:   BandState[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BAND_FREQS   = [60, 120, 250, 500, 1000, 3000, 8000, 16000] as const;
const BAND_LABELS  = ['60', '120', '250', '500', '1k', '3k', '8k', '16k'] as const;
const BAND_TYPES   = ['LS', 'PK', 'PK', 'PK', 'PK', 'PK', 'PK', 'HS'] as const;
const NUM_BANDS    = 8;
const GAIN_MAX     = 18;          // ±18 dB
const SLIDER_H     = 140;         // px — gain slider track height
const CURVE_W      = 560;         // SVG curve width
const CURVE_H      = 100;         // SVG curve height
const SAMPLE_RATE  = 48000;

// ── Colours (matching PHOBOS palette) ─────────────────────────────────────────

const C = {
  bg:        '#080C14',
  panel:     '#0D1424',
  border:    '#1A2640',
  surface:   '#111827',
  teal:      '#2DD4BF',
  tealDim:   '#134E4A',
  tealGlow:  'rgba(45,212,191,0.15)',
  violet:    '#7C3AED',
  text:      '#94A3B8',
  textBright:'#CBD5E1',
  muted:     '#2A3F55',
  positive:  '#2DD4BF',
  negative:  '#F87171',
  gridLine:  'rgba(255,255,255,0.04)',
  zero:      'rgba(255,255,255,0.10)',
};

// ── DSP helpers — biquad magnitude response ───────────────────────────────────

function peakMagnitude(freq: number, fc: number, gainDb: number, q: number, sr: number): number {
  const A  = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);

  const b0 =  1 + alpha * A;
  const b1 = -2 * cosw0;
  const b2 =  1 - alpha * A;
  const a0 =  1 + alpha / A;
  const a1 = -2 * cosw0;
  const a2 =  1 - alpha / A;

  const w  = (2 * Math.PI * freq) / sr;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);

  const numR = b0 + b1 * cos1 + b2 * cos2;
  const numI =      b1 * sin1 + b2 * sin2;
  const denR = a0 + a1 * cos1 + a2 * cos2;
  const denI =      a1 * sin1 + a2 * sin2;

  const num2 = numR * numR + numI * numI;
  const den2 = denR * denR + denI * denI;
  return 20 * Math.log10(Math.sqrt(num2 / Math.max(den2, 1e-30)));
}

function shelfMagnitude(freq: number, fc: number, gainDb: number, q: number, sr: number, isHigh: boolean): number {
  const A  = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
  const cosw0 = Math.cos(w0);
  const sqA   = 2 * Math.sqrt(A) * alpha;

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (!isHigh) {
    b0 =  A * ((A + 1) - (A - 1) * cosw0 + sqA);
    b1 =  2 * A * ((A - 1) - (A + 1) * cosw0);
    b2 =  A * ((A + 1) - (A - 1) * cosw0 - sqA);
    a0 =       (A + 1) + (A - 1) * cosw0 + sqA;
    a1 = -2 *  ((A - 1) + (A + 1) * cosw0);
    a2 =       (A + 1) + (A - 1) * cosw0 - sqA;
  } else {
    b0 =  A * ((A + 1) + (A - 1) * cosw0 + sqA);
    b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
    b2 =  A * ((A + 1) + (A - 1) * cosw0 - sqA);
    a0 =       (A + 1) - (A - 1) * cosw0 + sqA;
    a1 =  2 *  ((A - 1) - (A + 1) * cosw0);
    a2 =       (A + 1) - (A - 1) * cosw0 - sqA;
  }

  const w    = (2 * Math.PI * freq) / sr;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);

  const numR = b0 + b1 * cos1 + b2 * cos2;
  const numI =      b1 * sin1 + b2 * sin2;
  const denR = a0 + a1 * cos1 + a2 * cos2;
  const denI =      a1 * sin1 + a2 * sin2;

  const num2 = numR * numR + numI * numI;
  const den2 = denR * denR + denI * denI;
  return 20 * Math.log10(Math.sqrt(num2 / Math.max(den2, 1e-30)));
}

function computeCurve(bands: BandState[], svgW: number, svgH: number): string {
  const fMin = 20, fMax = 22000;
  const points: [number, number][] = [];

  for (let px = 0; px <= svgW; px += 2) {
    const freq = fMin * Math.pow(fMax / fMin, px / svgW);
    let total = 0;
    bands.forEach((b, i) => {
      if (!b.enabled || b.gainDb === 0) return;
      const fc = BAND_FREQS[i];
      const mag = (i === 0)
        ? shelfMagnitude(freq, fc, b.gainDb, b.q, SAMPLE_RATE, false)
        : (i === NUM_BANDS - 1)
          ? shelfMagnitude(freq, fc, b.gainDb, b.q, SAMPLE_RATE, true)
          : peakMagnitude(freq, fc, b.gainDb, b.q, SAMPLE_RATE);
      total += mag;
    });
    const y = svgH / 2 - (total / GAIN_MAX) * (svgH / 2) * 0.9;
    points.push([px, Math.max(0, Math.min(svgH, y))]);
  }

  if (points.length === 0) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const [px]   = points[i - 1];
    const cpx    = (px + x) / 2;
    d += ` C ${cpx} ${points[i - 1][1]} ${cpx} ${y} ${x} ${y}`;
  }
  return d;
}

// ── REST helpers ─────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function postBand(band: number, params: BandState): void {
  apiFetch('/api/audio/eq/band', {
    method: 'POST',
    body: JSON.stringify({ band, ...params }),
  }).catch(console.error);
}

function postEnabled(enabled: boolean): void {
  apiFetch('/api/audio/eq/enabled', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  }).catch(console.error);
}

// ── Drag-to-move hook (same pattern as PolarisPlayer) ────────────────────────

function useDrag(initialPos: { x: number; y: number }) {
  const [pos, setPos] = useState(initialPos);
  const dragging = useRef(false);
  const origin   = useRef({ mx: 0, my: 0, wx: 0, wy: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    origin.current   = { mx: e.clientX, my: e.clientY, wx: pos.x, wy: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: origin.current.wx + e.clientX - origin.current.mx,
        y: origin.current.wy + e.clientY - origin.current.my,
      });
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  return { pos, onMouseDown };
}

// ── Gain slider ───────────────────────────────────────────────────────────────

interface GainSliderProps {
  gainDb:    number;
  enabled:   boolean;
  onChange:  (g: number) => void;
}

function GainSlider({ gainDb, enabled, onChange }: GainSliderProps) {
  const trackRef  = useRef<HTMLDivElement>(null);
  const dragging  = useRef(false);

  const gainToY = (g: number) =>
    SLIDER_H / 2 - (g / GAIN_MAX) * (SLIDER_H / 2) * 0.9;

  const yToGain = (y: number) => {
    const raw = ((SLIDER_H / 2 - y) / (SLIDER_H / 2 * 0.9)) * GAIN_MAX;
    return Math.max(-GAIN_MAX, Math.min(GAIN_MAX, raw));
  };

  const handlePointer = useCallback((clientY: number) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const y    = clientY - rect.top;
    onChange(Math.round(yToGain(y) * 10) / 10);
  }, [onChange]);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    handlePointer(e.clientY);
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (dragging.current) handlePointer(e.clientY); };
    const onUp   = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [handlePointer]);

  const thumbY   = gainToY(gainDb);
  const zeroY    = SLIDER_H / 2;
  const fillTop  = gainDb >= 0 ? thumbY : zeroY;
  const fillH    = Math.abs(gainToY(gainDb) - zeroY);
  const color    = enabled ? (gainDb >= 0 ? C.teal : C.negative) : C.muted;

  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position:   'relative',
        width:      '100%',
        height:     SLIDER_H,
        cursor:     'ns-resize',
        userSelect: 'none',
      }}
    >
      {/* Track */}
      <div style={{
        position:        'absolute',
        left:            '50%',
        transform:       'translateX(-50%)',
        width:           2,
        top:             0,
        bottom:          0,
        background:      C.border,
        borderRadius:    1,
      }} />

      {/* Zero line */}
      <div style={{
        position:   'absolute',
        left:       '10%',
        right:      '10%',
        top:        zeroY,
        height:     1,
        background: C.zero,
      }} />

      {/* Fill */}
      <div style={{
        position:     'absolute',
        left:         '50%',
        transform:    'translateX(-50%)',
        width:        2,
        top:          fillTop,
        height:       fillH,
        background:   color,
        borderRadius: 1,
        transition:   'background 0.15s',
      }} />

      {/* Thumb */}
      <div style={{
        position:     'absolute',
        left:         '50%',
        top:          thumbY,
        transform:    'translate(-50%, -50%)',
        width:        10,
        height:       10,
        borderRadius: '50%',
        background:   color,
        border:       `2px solid ${C.bg}`,
        boxShadow:    enabled ? `0 0 6px ${color}` : 'none',
        transition:   'background 0.15s, box-shadow 0.15s',
      }} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface MasterEqProps {
  onClose: () => void;
}

const DEFAULT_BANDS: BandState[] = Array.from({ length: NUM_BANDS }, () => ({
  gainDb: 0, q: 0.707, enabled: true,
}));

export default function MasterEq({ onClose }: MasterEqProps) {
  const [eqEnabled, setEqEnabled] = useState(true);
  const [bands, setBands]         = useState<BandState[]>(DEFAULT_BANDS);
  const [loading, setLoading]     = useState(true);
  const { pos, onMouseDown }      = useDrag({ x: 120, y: 80 });

  // Load state on mount
  useEffect(() => {
    apiFetch<{ enabled: boolean; bands: BandState[] }>('/api/audio/eq/state')
      .then(s => {
        setEqEnabled(s.enabled);
        setBands(s.bands.length === NUM_BANDS ? s.bands : DEFAULT_BANDS);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const toggleMaster = () => {
    const next = !eqEnabled;
    setEqEnabled(next);
    postEnabled(next);
  };

  const updateBand = (i: number, patch: Partial<BandState>) => {
    setBands(prev => {
      const next = prev.map((b, idx) => idx === i ? { ...b, ...patch } : b);
      postBand(i, next[i]);
      return next;
    });
  };

  const resetAll = () => {
    const flat = DEFAULT_BANDS.map(b => ({ ...b }));
    setBands(flat);
    flat.forEach((b, i) => postBand(i, b));
  };

  const curvePath = computeCurve(bands, CURVE_W, CURVE_H);

  return (
    <div
      style={{
        position:  'fixed',
        left:      pos.x,
        top:       pos.y,
        zIndex:    9000,
        width:     640,
        background: C.bg,
        border:    `1px solid ${C.border}`,
        borderRadius: 8,
        boxShadow: `0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(45,212,191,0.08)`,
        fontFamily: '"Courier New", Courier, monospace',
        fontSize:  11,
        color:     C.text,
        userSelect: 'none',
      }}
    >
      {/* Title bar */}
      <div
        onMouseDown={onMouseDown}
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '8px 12px',
          borderBottom:   `1px solid ${C.border}`,
          cursor:         'move',
          background:     C.panel,
          borderRadius:   '8px 8px 0 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* EQ icon */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="6" width="2" height="7" fill={C.teal} rx="1"/>
            <rect x="4" y="3" width="2" height="10" fill={C.teal} rx="1"/>
            <rect x="7" y="1" width="2" height="12" fill={C.teal} rx="1"/>
            <rect x="10" y="4" width="2" height="9" fill={C.teal} rx="1"/>
          </svg>
          <span style={{ color: C.teal, letterSpacing: '0.12em', fontSize: 11 }}>
            MASTER EQ
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Master on/off */}
          <button
            onClick={toggleMaster}
            title={eqEnabled ? 'Bypass EQ' : 'Enable EQ'}
            style={{
              background:   eqEnabled ? C.tealDim : 'transparent',
              border:       `1px solid ${eqEnabled ? C.teal : C.muted}`,
              borderRadius: 3,
              color:        eqEnabled ? C.teal : C.muted,
              padding:      '2px 8px',
              cursor:       'pointer',
              fontSize:     10,
              letterSpacing:'0.08em',
              transition:   'all 0.15s',
            }}
          >
            {eqEnabled ? 'ON' : 'OFF'}
          </button>

          {/* Reset */}
          <button
            onClick={resetAll}
            title="Reset all bands to 0 dB"
            style={{
              background:   'transparent',
              border:       `1px solid ${C.border}`,
              borderRadius: 3,
              color:        C.text,
              padding:      '2px 8px',
              cursor:       'pointer',
              fontSize:     10,
              letterSpacing:'0.08em',
            }}
          >
            FLAT
          </button>

          {/* Close */}
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border:     'none',
              color:      C.muted,
              cursor:     'pointer',
              fontSize:   16,
              lineHeight: 1,
              padding:    0,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: C.muted }}>
          connecting…
        </div>
      ) : (
        <>
          {/* Frequency response curve */}
          <div style={{
            margin:       '10px 14px 6px',
            background:   C.surface,
            border:       `1px solid ${C.border}`,
            borderRadius: 4,
            overflow:     'hidden',
            opacity:      eqEnabled ? 1 : 0.35,
            transition:   'opacity 0.2s',
          }}>
            <svg
              width="100%"
              viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
              preserveAspectRatio="none"
              style={{ display: 'block' }}
            >
              {/* Grid lines — dB */}
              {[-12, -6, 0, 6, 12].map(db => {
                const y = CURVE_H / 2 - (db / GAIN_MAX) * (CURVE_H / 2) * 0.9;
                return (
                  <line key={db} x1="0" y1={y} x2={CURVE_W} y2={y}
                    stroke={db === 0 ? C.zero : C.gridLine} strokeWidth="1" />
                );
              })}

              {/* Curve fill */}
              <path
                d={curvePath + ` L ${CURVE_W} ${CURVE_H / 2} L 0 ${CURVE_H / 2} Z`}
                fill={C.tealGlow}
              />

              {/* Curve line */}
              <path
                d={curvePath}
                fill="none"
                stroke={eqEnabled ? C.teal : C.muted}
                strokeWidth="1.5"
                strokeLinejoin="round"
                style={{ transition: 'stroke 0.2s' }}
              />
            </svg>
          </div>

          {/* dB axis labels */}
          <div style={{
            display:        'flex',
            justifyContent: 'space-between',
            padding:        '0 14px',
            color:          C.muted,
            fontSize:       9,
            marginBottom:   4,
          }}>
            <span>+18</span><span>+9</span><span>0</span><span>-9</span><span>-18</span>
          </div>

          {/* Band columns */}
          <div style={{
            display:       'grid',
            gridTemplateColumns: `repeat(${NUM_BANDS}, 1fr)`,
            gap:           4,
            padding:       '0 14px 10px',
            opacity:       eqEnabled ? 1 : 0.4,
            transition:    'opacity 0.2s',
          }}>
            {bands.map((band, i) => {
              const active = eqEnabled && band.enabled;
              const color  = active ? (band.gainDb >= 0 ? C.teal : C.negative) : C.muted;

              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>

                  {/* Band type badge */}
                  <div style={{
                    fontSize:     8,
                    color:        C.muted,
                    letterSpacing:'0.06em',
                  }}>
                    {BAND_TYPES[i]}
                  </div>

                  {/* Gain slider */}
                  <GainSlider
                    gainDb={band.gainDb}
                    enabled={active}
                    onChange={g => updateBand(i, { gainDb: g })}
                  />

                  {/* dB readout */}
                  <div style={{
                    fontSize:  10,
                    color,
                    minWidth:  36,
                    textAlign: 'center',
                    transition:'color 0.15s',
                  }}>
                    {band.gainDb > 0 ? '+' : ''}{band.gainDb.toFixed(1)}
                  </div>

                  {/* Q control (hidden for shelf bands) */}
                  {i > 0 && i < NUM_BANDS - 1 ? (
                    <input
                      type="range"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={band.q}
                      onChange={e => updateBand(i, { q: parseFloat(e.target.value) })}
                      title={`Q: ${band.q.toFixed(2)}`}
                      style={{
                        width:      '100%',
                        accentColor: C.violet,
                        cursor:     'pointer',
                        margin:     0,
                      }}
                    />
                  ) : (
                    <div style={{ height: 16 }} />
                  )}

                  {/* Frequency label */}
                  <div style={{
                    fontSize:     9,
                    color:        C.muted,
                    letterSpacing:'0.06em',
                    textAlign:    'center',
                  }}>
                    {BAND_LABELS[i]}
                  </div>

                  {/* Band enable toggle */}
                  <button
                    onClick={() => updateBand(i, { enabled: !band.enabled })}
                    title={band.enabled ? 'Disable band' : 'Enable band'}
                    style={{
                      width:        20,
                      height:       20,
                      borderRadius: '50%',
                      background:   band.enabled ? color : 'transparent',
                      border:       `1px solid ${band.enabled ? color : C.border}`,
                      cursor:       'pointer',
                      padding:      0,
                      transition:   'all 0.15s',
                      boxShadow:    band.enabled && active ? `0 0 6px ${color}` : 'none',
                    }}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
