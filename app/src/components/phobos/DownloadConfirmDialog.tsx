import { useState } from 'react';
import { X, ExternalLink } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DownloadLicenseEntry {
  /** Unique key — use licenseUrl so identical licenses across files collapse. */
  id: string;
  /** Human-readable license name shown as the checkbox label prefix. */
  license: string;
  /** URL to the full license text. */
  licenseUrl: string;
  /** File / model names covered by this license entry. */
  labels: string[];
}

interface Props {
  /** Title shown in the dialog header. */
  title: string;
  /**
   * License entries to display.
   * Build with buildLicenseEntries() below.
   * If empty, the dialog renders nothing and callers should skip it.
   */
  entries: DownloadLicenseEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}

// ── Helper: build deduplicated license entries from a flat file list ──────────

export interface DownloadFileSpec {
  /** Any stable unique id for this file (modelId, aux file id, etc.) */
  id: string;
  /** Display name shown under the license entry. */
  label: string;
  /** SPDX license identifier, e.g. 'Apache-2.0'. */
  license: string;
  /** URL to the full license text — used as the deduplication key. */
  licenseUrl: string;
}

/**
 * Collapses a flat list of files into one DownloadLicenseEntry per unique
 * licenseUrl — e.g. three FLUX files under Apache 2.0 produce one checkbox.
 * Files with the same licenseUrl are listed under that entry's labels.
 */
export function buildLicenseEntries(files: DownloadFileSpec[]): DownloadLicenseEntry[] {
  const map = new Map<string, DownloadLicenseEntry>();
  for (const f of files) {
    if (!map.has(f.licenseUrl)) {
      map.set(f.licenseUrl, { id: f.licenseUrl, license: f.license, licenseUrl: f.licenseUrl, labels: [] });
    }
    map.get(f.licenseUrl)!.labels.push(f.label);
  }
  return [...map.values()];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DownloadConfirmDialog({ title, entries, onConfirm, onCancel }: Props) {
  const [agreed, setAgreed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setAgreed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allAgreed = entries.every((e) => agreed.has(e.id));

  return (
    <div
      className="fixed inset-0 z-[250] bg-black/90 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-[460px] bg-secondary border border-phobos-green/20 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.06)] font-mono">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/30">
          <span className="text-xs font-terminal tracking-[0.2em] text-phobos-green/70 uppercase">
            {title}
          </span>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* License list */}
        <div className="px-5 py-4 space-y-3 max-h-[50vh] overflow-y-auto scrollbar-phobos">
          <p className="text-[10px] text-muted-foreground/50 leading-relaxed">
            {entries.length === 1
              ? 'By downloading, you agree to the license terms below.'
              : 'This download includes files under multiple licences. Review and agree to each before proceeding.'}
          </p>

          {entries.map((entry) => (
            <label
              key={entry.id}
              className={`flex items-start gap-3 px-3 py-2.5 border rounded cursor-pointer transition-colors ${
                agreed.has(entry.id)
                  ? 'border-phobos-green/40 bg-phobos-green/[0.06]'
                  : 'border-border/40 bg-muted/30 hover:border-border/60 hover:bg-muted/50'
              }`}
            >
              {/* Custom checkbox */}
              <div
                className={`w-4 h-4 rounded border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                  agreed.has(entry.id)
                    ? 'border-phobos-green bg-phobos-green/20'
                    : 'border-foreground/40 bg-transparent'
                }`}
              >
                {agreed.has(entry.id) && (
                  <svg className="w-2.5 h-2.5 text-phobos-green" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <input
                type="checkbox"
                className="sr-only"
                checked={agreed.has(entry.id)}
                onChange={() => toggle(entry.id)}
              />

              {/* Label: license name + covered files */}
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-terminal tracking-[0.08em] text-foreground/80">
                  {entry.license}
                </div>
                {entry.labels.length > 0 && (
                  <div className="text-[10px] font-mono text-muted-foreground/40 mt-0.5 leading-relaxed">
                    {entry.labels.join(', ')}
                  </div>
                )}
              </div>

              {/* View license link */}
              <a
                href={entry.licenseUrl}
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

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border/20">
          <button
            disabled={!allAgreed}
            onClick={onConfirm}
            className="flex-1 py-2.5 border text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed border-phobos-green/40 text-phobos-green/80 hover:text-phobos-green hover:border-phobos-green/60 hover:bg-phobos-green/[0.06] disabled:border-border/20 disabled:text-foreground/30"
          >
            {allAgreed
              ? 'CONFIRM DOWNLOAD'
              : `AGREE TO ALL LICENCES (${agreed.size}/${entries.length})`}
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