/**
 * SecurityFindingsTable.tsx — sortable, expandable findings table.
 * Severity column uses colored badges matching PHOBOS STATUS_DOT pattern.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface SecurityFinding {
  id:         string;
  run_id:     string;
  scan_type:  string;
  severity:   'critical' | 'high' | 'medium' | 'low' | 'info';
  title:      string;
  detail:     string | null;
  target:     string | null;
  cve_id:     string | null;
  is_new:     boolean;
  created_at: string;
}

type SortKey = 'severity' | 'scan_type' | 'created_at' | 'is_new';
type SortDir = 'asc' | 'desc';

interface Props {
  findings: SecurityFinding[];
}

const SEV_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

const SEV_DOT: Record<string, string> = {
  critical: 'bg-destructive',
  high:     'bg-phobos-amber',
  medium:   'bg-warning',
  low:      'bg-muted-foreground/50',
  info:     'bg-phobos-green/40',
};

const SEV_LABEL: Record<string, string> = {
  critical: 'text-destructive',
  high:     'text-phobos-amber',
  medium:   'text-warning',
  low:      'text-muted-foreground/70',
  info:     'text-muted-foreground/40',
};

const SCAN_LABEL: Record<string, string> = {
  port_scan:        'Port Scan',
  web_scan:         'Web Scan',
  malware_scan:     'Malware',
  dependency_audit: 'Dependencies',
  code_audit:       'Code Audit',
  system_audit:     'System Audit',
  integrity_check:  'File Integrity',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SecurityFindingsTable({ findings }: Props) {
  const [sortKey,    setSortKey]    = useState<SortKey>('severity');
  const [sortDir,    setSortDir]    = useState<SortDir>('asc');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...findings].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'severity':
        cmp = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
        break;
      case 'scan_type':
        cmp = a.scan_type.localeCompare(b.scan_type);
        break;
      case 'created_at':
        cmp = a.created_at.localeCompare(b.created_at);
        break;
      case 'is_new':
        cmp = (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0);
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2">
        <span className="text-[10px] font-terminal text-muted-foreground/30 uppercase tracking-widest">
          No findings
        </span>
        <span className="text-[9px] font-mono text-muted-foreground/20">
          Run a scan to collect security findings.
        </span>
      </div>
    );
  }

  function SortBtn({ col, label }: { col: SortKey; label: string }) {
    const active = sortKey === col;
    return (
      <button
        onClick={() => handleSort(col)}
        className={`text-left text-[9px] font-terminal uppercase tracking-widest transition-colors ${
          active ? 'text-phobos-green/70' : 'text-muted-foreground/40 hover:text-muted-foreground/70'
        }`}
      >
        {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    );
  }

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b border-border/30">
          <th className="px-2 py-2 w-6" />
          <th className="px-2 py-2 text-left"><SortBtn col="severity"   label="Sev" /></th>
          <th className="px-2 py-2 text-left"><SortBtn col="scan_type"  label="Type" /></th>
          <th className="px-2 py-2 text-left text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 font-normal">
            Finding
          </th>
          <th className="px-2 py-2 text-left"><SortBtn col="is_new"     label="New" /></th>
          <th className="px-2 py-2 text-left"><SortBtn col="created_at" label="Date" /></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(f => {
          const expanded = expandedId === f.id;
          return (
            <>
              <tr
                key={f.id}
                className="border-b border-border/20 hover:bg-accent/20 transition-colors cursor-pointer"
                onClick={() => setExpandedId(expanded ? null : f.id)}
              >
                {/* Expand */}
                <td className="px-2 py-2 text-muted-foreground/30">
                  {expanded
                    ? <ChevronDown className="w-3 h-3" />
                    : <ChevronRight className="w-3 h-3" />}
                </td>

                {/* Severity */}
                <td className="px-2 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEV_DOT[f.severity] ?? 'bg-muted-foreground/30'}`} />
                    <span className={`text-[9px] font-terminal uppercase tracking-wider ${SEV_LABEL[f.severity] ?? ''}`}>
                      {f.severity}
                    </span>
                  </div>
                </td>

                {/* Type */}
                <td className="px-2 py-2">
                  <span className="text-[9px] font-mono text-muted-foreground/50">
                    {SCAN_LABEL[f.scan_type] ?? f.scan_type}
                  </span>
                </td>

                {/* Title */}
                <td className="px-2 py-2 max-w-[280px]">
                  <span className="text-[10px] text-foreground/70 truncate block">
                    {f.title}
                  </span>
                  {f.target && (
                    <span className="text-[9px] font-mono text-muted-foreground/35 truncate block">
                      {f.target}
                    </span>
                  )}
                </td>

                {/* New badge */}
                <td className="px-2 py-2">
                  {f.is_new && (
                    <span className="text-[8px] font-terminal uppercase tracking-widest text-phobos-amber/70 bg-phobos-amber/10 px-1 py-0.5 rounded-sm">
                      new
                    </span>
                  )}
                </td>

                {/* Date */}
                <td className="px-2 py-2 whitespace-nowrap">
                  <span className="text-[9px] font-mono text-muted-foreground/40">
                    {fmtDate(f.created_at)}
                  </span>
                </td>
              </tr>

              {/* Expanded detail row */}
              {expanded && (
                <tr key={`${f.id}-detail`} className="border-b border-border/10 bg-black/30">
                  <td colSpan={6} className="px-6 py-3">
                    <div className="space-y-2">
                      {f.cve_id && (
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-terminal text-muted-foreground/40 uppercase tracking-widest w-16">CVE</span>
                          <span className="text-[9px] font-mono text-phobos-amber/70">{f.cve_id}</span>
                        </div>
                      )}
                      {f.target && (
                        <div className="flex items-start gap-2">
                          <span className="text-[9px] font-terminal text-muted-foreground/40 uppercase tracking-widest w-16 shrink-0 mt-0.5">Target</span>
                          <span className="text-[9px] font-mono text-muted-foreground/60 break-all">{f.target}</span>
                        </div>
                      )}
                      {f.detail && (
                        <div className="flex items-start gap-2">
                          <span className="text-[9px] font-terminal text-muted-foreground/40 uppercase tracking-widest w-16 shrink-0 mt-0.5">Detail</span>
                          <pre className="text-[9px] font-mono text-muted-foreground/55 whitespace-pre-wrap break-all leading-relaxed">
                            {f.detail}
                          </pre>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          );
        })}
      </tbody>
    </table>
  );
}
