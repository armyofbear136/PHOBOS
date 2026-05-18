import { useState } from 'react';
import { X, ExternalLink } from 'lucide-react';

interface FluxFileEntry {
  id: string;
  label: string;
  license: string;
  licenseUrl: string;
}

interface Props {
  files: FluxFileEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}

// Deduplicates by licenseUrl — one checkbox per unique licence, not per file.
// e.g. FLUX weights + VAE + T5 all share Apache 2.0 → one checkbox.
// CLIP-L is MIT → separate checkbox.
export function OptionalModelDownloadConfirmDialog({ files, onConfirm, onCancel }: Props) {
  const licenceMap = new Map<string, { license: string; labels: string[] }>();
  for (const f of files) {
    if (!licenceMap.has(f.licenseUrl)) licenceMap.set(f.licenseUrl, { license: f.license, labels: [] });
    licenceMap.get(f.licenseUrl)!.labels.push(f.label);
  }

  const licences = [...licenceMap.entries()].map(([url, v]) => ({
    id:         url,
    label:      `${v.license} — ${v.labels.join(', ')}`,
    licenseUrl: url,
  }));

  const [agreed, setAgreed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setAgreed(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allAgreed = licences.every(l => agreed.has(l.id));

  return (
    <div
      className="fixed inset-0 z-[250] bg-black/90 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[460px] bg-secondary border border-phobos-green/20 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.06)] font-mono">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/30">
          <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/70 uppercase">
            LICENSE AGREEMENT — FLUX IMAGE MODELS
          </span>
          <button onClick={onCancel} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[50vh] overflow-y-auto scrollbar-phobos">
          <p className="text-[10px] text-muted-foreground/50 leading-relaxed">
            This download includes files under multiple open-source licences. Review and agree to each before proceeding.
          </p>

          {licences.map(l => (
            <label
              key={l.id}
              className={`flex items-start gap-3 px-3 py-2.5 border rounded cursor-pointer transition-colors ${
                agreed.has(l.id)
                  ? 'border-phobos-green/40 bg-phobos-green/[0.06]'
                  : 'border-border/40 bg-white/[0.03] hover:border-border/60 hover:bg-white/[0.05]'
              }`}
            >
              <div className={`w-4 h-4 rounded border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                agreed.has(l.id) ? 'border-phobos-green bg-phobos-green/20' : 'border-foreground/40 bg-transparent'
              }`}>
                {agreed.has(l.id) && (
                  <svg className="w-2.5 h-2.5 text-phobos-green" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <input type="checkbox" className="sr-only" checked={agreed.has(l.id)} onChange={() => toggle(l.id)} />
              <span className="text-[10px] text-foreground/80 flex-1 font-mono leading-relaxed">{l.label}</span>
              <a
                href={l.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-[9px] text-phobos-green/50 hover:text-phobos-green/80 transition-colors shrink-0 mt-0.5"
              >
                View <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-border/20">
          <button
            disabled={!allAgreed}
            onClick={onConfirm}
            className="flex-1 py-2.5 border text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed border-phobos-green/40 text-phobos-green/80 hover:text-phobos-green hover:border-phobos-green/60 hover:bg-phobos-green/[0.06] disabled:border-border/20 disabled:text-foreground/30"
          >
            {allAgreed ? 'CONFIRM DOWNLOAD' : `AGREE TO ALL LICENCES (${agreed.size}/${licences.length})`}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 border border-border/15 text-muted-foreground/35 text-[10px] uppercase tracking-[0.15em] rounded-sm hover:text-muted-foreground hover:border-border/30 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}