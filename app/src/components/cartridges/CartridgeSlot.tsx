/**
 * CartridgeSlot — shows the active AI cartridge for SAYON or SEREN.
 * Polls every 2s during server restart until 'loaded' flips true.
 */

import { useState, useEffect, useRef } from 'react';
import { Cpu, Loader2, X, ChevronRight } from 'lucide-react';
import type { CartridgeRecord, CartridgeCategory, ActiveSlotResponse } from './CartridgeTypes';
import { CATEGORY_LABELS } from './CartridgeTypes';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const CATEGORY_COLORS: Record<CartridgeCategory, string> = {
  expertise: 'text-phob-teal   border-phob-teal/30   bg-phob-teal/5',
  persona:   'text-phob-teal border-phob-teal/30 bg-phob-teal/5',
  style:     'text-sayon   border-sayon/30   bg-sayon/5',
  domain:    'text-phob-amber border-phob-amber/30 bg-phob-amber/5',
  task:      'text-phob-amber border-phob-amber/30 bg-phob-amber/5',
  weclone:   'text-seren border-seren/30 bg-seren/5',
};

interface CartridgeSlotProps {
  persona:       'sayon' | 'seren';
  onSwapRequest: () => void;
  onChanged?:    () => void;  // notify parent to refresh card list
}

export function CartridgeSlot({ persona, onSwapRequest, onChanged }: CartridgeSlotProps) {
  const isSayon      = persona === 'sayon';
  const accentBorder = isSayon ? 'border-phob-amber/30' : 'border-phob-teal/30';
  const accentText   = isSayon ? 'text-phob-amber'      : 'text-phob-teal';
  const accentGlow   = isSayon
    ? 'shadow-[0_0_8px_hsl(38_100%_50%/0.1)]'
    : 'shadow-[0_0_8px_hsl(210_100%_60%/0.1)]';

  const [slotData,    setSlotData]    = useState<ActiveSlotResponse | null>(null);
  const [restarting,  setRestarting]  = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSlot = async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/cartridges/${persona}/active`);
      if (!res.ok) return;
      const data = await res.json() as ActiveSlotResponse;
      setSlotData(data);
      if (restarting && data.loaded) {
        setRestarting(false);
        onChanged?.();
      }
    } catch { /* server may be mid-restart */ }
  };

  useEffect(() => { fetchSlot(); }, [persona]);

  useEffect(() => {
    if (restarting) {
      pollRef.current = setInterval(fetchSlot, 2000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [restarting]);

  const handleDeactivate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRestarting(true);
    try {
      await fetch(`${ENGINE_URL}/api/cartridges/${persona}/deactivate`, { method: 'POST' });
      await fetchSlot();
    } catch {
      setRestarting(false);
    }
  };

  // Expose a refresh method for parent after activation.
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[`__refreshSlot_${persona}`] = () => {
      setRestarting(true);
      fetchSlot();
    };
    return () => { delete (window as unknown as Record<string, unknown>)[`__refreshSlot_${persona}`]; };
  }, [persona]);

  const cartridge = slotData?.cartridge ?? null;

  return (
    <div className={`flex-1 border ${accentBorder}  bg-phob-white/4 p-3 ${accentGlow}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Cpu className={`w-3 h-3 ${accentText}`} />
          <span className={`text-[9px] font-terminal uppercase tracking-[0.15em] ${accentText}`}>
            {persona.toUpperCase()} SLOT
          </span>
        </div>
        {restarting && (
          <div className="flex items-center gap-1 text-phob-steel/45">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="text-[8px] font-terminal uppercase tracking-widest">Restarting…</span>
          </div>
        )}
      </div>

      {cartridge ? (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-terminal text-foreground leading-tight truncate">{cartridge.name}</p>
              <p className="text-[9px] text-phob-steel/45 truncate mt-0.5">by {cartridge.author} · v{cartridge.version}</p>
            </div>
            <button
              onClick={handleDeactivate}
              disabled={restarting}
              className="shrink-0 p-0.5 text-phob-steel/35 hover:text-phob-red transition-colors disabled:opacity-20"
              title="Remove cartridge from slot"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5  border ${CATEGORY_COLORS[cartridge.category]}`}>
              {CATEGORY_LABELS[cartridge.category]}
            </span>
            <span className="text-[8px] font-mono text-phob-steel/40 border border-phob-orange/20 px-1.5 py-0.5 ">
              {cartridge.base_model}
            </span>
            {slotData?.weight != null && (
              <span className={`text-[8px] font-mono ${accentText}/50`}>×{slotData.weight.toFixed(2)}</span>
            )}
            {!cartridge.is_protected && (
              <span className="text-[8px] font-terminal text-phob-steel/35 border border-phob-orange/15 px-1 py-0.5 ">unprotected</span>
            )}
          </div>
          {cartridge.trigger_context && (
            <p className="text-[8px] text-phob-steel/35 font-mono italic truncate">
              "{cartridge.trigger_context.slice(0, 64)}{cartridge.trigger_context.length > 64 ? '…' : ''}"
            </p>
          )}
        </div>
      ) : (
        <p className="text-[10px] text-phob-steel/35 font-terminal italic">Base model — no cartridge</p>
      )}

      <button
        onClick={onSwapRequest}
        disabled={restarting}
        className={`mt-3 w-full flex items-center justify-center gap-1 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border ${accentBorder} ${accentText}/60 hover:${accentText}  transition-all disabled:opacity-30`}
      >
        {cartridge ? 'Swap Cartridge' : 'Load Cartridge'}
        <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}
