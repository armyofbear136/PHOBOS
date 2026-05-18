/**
 * WaveformDisplay.tsx — Live analyser canvas.
 *
 * Reads `AnalyserNode.getFloatTimeDomainData()` on rAF and draws the waveform
 * on a `<canvas>`. Reads from `getAnalysers()` — index 0 is the master bus;
 * index N+1 is instrument N's per-channel analyser.
 *
 * Zero-allocation: one Float32Array scratch buffer of fftSize (2048 samples).
 * The buffer is constructed via an explicit ArrayBuffer to satisfy TS 5.7+'s
 * stricter Float32Array<ArrayBuffer> typing on getFloatTimeDomainData —
 * Float32Array without a constructor arg widens to Float32Array<ArrayBufferLike>
 * which the DOM lib refuses.
 */

import { memo, useEffect, useRef } from 'react';
import { getAnalysers } from '@/components/audio/engine/services/audio-service';

export interface WaveformDisplayProps {
  /** Which analyser to read — 0 = master, or 1..N for per-instrument. Defaults to 0. */
  analyserIndex?: number;
  /** CSS-resolved width; the canvas is drawn to this at DPR. */
  width:  number;
  /** CSS-resolved height. */
  height: number;
  /** Stroke color. Default: phobos-green. */
  color?: string;
  /** Background fill. Default: transparent. */
  background?: string;
  /** Line thickness in CSS pixels. Default: 1. */
  lineWidth?: number;
  className?: string;
}

function WaveformDisplayImpl({
  analyserIndex = 0,
  width, height,
  color      = '#22c55e',
  background = 'transparent',
  lineWidth  = 1,
  className,
}: WaveformDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const rafRef    = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Resolution: draw at devicePixelRatio for crisp lines.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.floor(width  * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.scale(dpr, dpr);
    ctx2d.lineCap  = 'round';
    ctx2d.lineJoin = 'round';

    const draw = (): void => {
      const analysers = getAnalysers();
      const analyser  = analysers[analyserIndex];

      // Clear / background.
      if (background === 'transparent') {
        ctx2d.clearRect(0, 0, width, height);
      } else {
        ctx2d.fillStyle = background;
        ctx2d.fillRect(0, 0, width, height);
      }

      if (!analyser) {
        // Draw a flat centre line when the engine isn't ready yet.
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth   = lineWidth;
        ctx2d.globalAlpha = 0.3;
        ctx2d.beginPath();
        ctx2d.moveTo(0, height / 2);
        ctx2d.lineTo(width, height / 2);
        ctx2d.stroke();
        ctx2d.globalAlpha = 1;
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Allocate (or reuse) the scratch buffer matched to fftSize.
      // Explicit ArrayBuffer satisfies TS 5.7+'s Float32Array<ArrayBuffer>
      // constraint on getFloatTimeDomainData.
      if (!bufferRef.current || bufferRef.current.length !== analyser.fftSize) {
        bufferRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      }
      const data = bufferRef.current;
      analyser.getFloatTimeDomainData(data);

      // Draw the time-domain waveform.
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth   = lineWidth;
      ctx2d.beginPath();

      const stepX = width / data.length;
      const midY  = height / 2;
      const ampY  = height / 2;

      // First point.
      ctx2d.moveTo(0, midY - data[0] * ampY);
      for (let i = 1; i < data.length; i++) {
        ctx2d.lineTo(i * stepX, midY - data[i] * ampY);
      }
      ctx2d.stroke();

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [analyserIndex, width, height, color, background, lineWidth]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height, display: 'block' }}
    />
  );
}

export const WaveformDisplay = memo(WaveformDisplayImpl);
