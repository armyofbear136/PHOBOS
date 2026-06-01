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
      <div className="w-[460px] bg-[#0f0f0a] border border-phob-orange/30 phob-corners  shadow-[0_0_24px_rgba(232,66,10,0.08)] font-mono">
        <div className="flex items-center justify-between px-5 py-3 border-b border-phob-orange/20">
          <span className="text-xs font-terminal tracking-[0.2em] text-phob-orange/70 uppercase">
            LICENSE AGREEMENT — FLUX IMAGE MODELS
          </span>
          <button onClick={onCancel} className="p-1 hover:bg-phob-orange/8 text-phob-steel/50 hover:text-phob-white transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[50vh] overflow-y-auto scrollbar-phobos">
          <p className="text-[10px] text-phob-steel/45 leading-relaxed">
            This download includes files under multiple open-source licences. Review and agree to each before proceeding.
          </p>

          {licences.map(l => (
            <label
              key={l.id}
              className={`flex items-start gap-3 px-3 py-2.5 border rounded cursor-pointer transition-colors ${
                agreed.has(l.id)
                  ? 'border-phob-green/40 bg-phob-green/[0.06]'
                  : 'border-phob-orange/20 bg-phob-white/3 hover:border-phob-orange/35 hover:bg-phob-white/5'
              }`}
            >
              <div className={`w-4 h-4 rounded border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                agreed.has(l.id) ? 'border-phob-green bg-phob-green/20' : 'border-foreground/40 bg-transparent'
              }`}>
                {agreed.has(l.id) && (
                  <svg className="w-2.5 h-2.5 text-phob-orange" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <input type="checkbox" className="sr-only" checked={agreed.has(l.id)} onChange={() => toggle(l.id)} />
              <span className="text-[10px] text-phob-white/75 flex-1 font-mono leading-relaxed">{l.label}</span>
              <a
                href={l.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 text-[9px] text-phob-orange/50 hover:text-phob-orange/80 transition-colors shrink-0 mt-0.5"
              >
                View <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-phob-orange/15">
          <button
            disabled={!allAgreed}
            onClick={onConfirm}
            className="flex-1 py-2.5 border text-[10px] font-terminal uppercase tracking-[0.15em]  transition-all disabled:opacity-30 disabled:cursor-not-allowed border-phob-orange/40 text-phob-orange/80 hover:text-phob-orange hover:border-phob-orange/60 hover:bg-phob-orange/[0.06] disabled:border-phob-orange/12 disabled:text-phob-steel/30"
          >
            {allAgreed ? 'CONFIRM DOWNLOAD' : `AGREE TO ALL LICENCES (${agreed.size}/${licences.length})`}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 border border-phob-orange/12 text-phob-steel/35 text-[10px] uppercase tracking-[0.15em] hover:text-phob-white/60 hover:border-phob-orange/25 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}