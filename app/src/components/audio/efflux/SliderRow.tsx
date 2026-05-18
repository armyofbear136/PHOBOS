/**
 * SliderRow.tsx — Shared slider-with-label+readout component for DAW editors.
 *
 * Extracted from OscillatorEditor so ModuleEditor, SampleEditor, and any
 * future editor surface reuses the same visual idiom. Zero behavior change
 * from the original — just moved into a shared location.
 */

import { memo } from 'react';

export interface SliderRowProps {
  label:    string;
  min:      number;
  max:      number;
  step:     number;
  value:    number;
  unit?:    string;
  format?:  (v: number) => string;
  onChange: (v: number) => void;
  color?:   'green' | 'amber' | 'blue';
  /** Disable the row entirely (rendered dim, input disabled). */
  disabled?: boolean;
}

function SliderRowImpl({
  label, min, max, step, value, unit, format, onChange, color = 'green', disabled = false,
}: SliderRowProps) {
  const accent =
    color === 'green' ? 'accent-phobos-green' :
    color === 'amber' ? 'accent-phobos-amber' :
                        'accent-blue-500';
  const vColor =
    color === 'green' ? 'text-phobos-green/70' :
    color === 'amber' ? 'text-phobos-amber/70' :
                        'text-blue-400/80';

  return (
    <label className={`flex items-center gap-3 py-1.5 ${disabled ? 'opacity-40' : ''}`}>
      <span className="w-20 text-[9px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/70">
        {label}
      </span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`flex-1 ${accent}`}
      />
      <span className={`w-16 text-right text-[10px] font-mono ${vColor}`}>
        {format ? format(value) : `${value}${unit ?? ''}`}
      </span>
    </label>
  );
}

export const SliderRow = memo(SliderRowImpl);
