import { useState } from 'react';
import { X } from 'lucide-react';

export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const updateAvailable = typeof window !== 'undefined' && (window as any).__PHOBOS_UPDATE_AVAILABLE__;

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-phobos-amber/10 border-b border-phobos-amber/20 shrink-0">
      <span className="text-[10px] font-mono text-phobos-amber/70">
        A new version of PHOBOS is available.
      </span>
      <div className="flex items-center gap-2">
        <button className="text-[10px] font-terminal text-phobos-amber hover:text-phobos-amber/80 transition-colors tracking-wider">
          UPDATE NOW
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-0.5 text-phobos-amber/40 hover:text-phobos-amber/70 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
