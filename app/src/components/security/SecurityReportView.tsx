/**
 * SecurityReportView.tsx — shows the SEREN digest for a selected scan run,
 * with a new-vs-prior diff highlight and collapsible raw output.
 */

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SecurityFinding } from './SecurityFindingsTable';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface ScanRun {
  id:                string;
  scan_type:         string;
  status:            string;
  started_at:        string;
  completed_at:      string | null;
  finding_count:     number;
  new_finding_count: number;
  error_message:     string | null;
  raw_output:        string | null;
  seren_digest:      string | null;
}

const SCAN_LABEL: Record<string, string> = {
  port_scan:        'Port Scan',
  web_scan:         'Web Scan',
  malware_scan:     'Malware Scan',
  dependency_audit: 'Dependency Audit',
  code_audit:       'Code Audit',
  system_audit:     'System Audit',
  integrity_check:  'File Integrity',
};

const STATUS_DOT: Record<string, string> = {
  success:      'bg-phobos-green',
  error:        'bg-destructive',
  running:      'bg-phobos-amber animate-pulse',
  tool_missing: 'bg-muted-foreground/30',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SecurityReportView() {
  const [runs,         setRuns]         = useState<ScanRun[]>([]);
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [detail,       setDetail]       = useState<{ run: ScanRun; findings: SecurityFinding[] } | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [rawExpanded,  setRawExpanded]  = useState(false);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/security/runs`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ScanRun[]) => {
        setRuns(data);
        if (data.length > 0) setSelectedId(data[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetail(null);
    fetch(`${ENGINE_URL}/api/security/runs/${selectedId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setDetail(data); })
      .catch(() => {});
  }, [selectedId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-[10px] font-terminal text-muted-foreground/30 uppercase tracking-widest">
          Loading…
        </span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2">
        <span className="text-[10px] font-terminal text-muted-foreground/30 uppercase tracking-widest">
          No scan history
        </span>
        <span className="text-[9px] font-mono text-muted-foreground/20">
          Run a scan from the Scans tab to generate a report.
        </span>
      </div>
    );
  }

  const run = detail?.run ?? null;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Run selector */}
      <div className="shrink-0">
        <label className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 mb-1 block">
          Scan Run
        </label>
        <select
          value={selectedId ?? ''}
          onChange={e => setSelectedId(e.target.value)}
          className="w-full bg-black/40 border border-border/30 rounded-sm px-2 py-1.5 text-[10px] font-mono text-foreground/70 focus:outline-none focus:border-phobos-green/40"
        >
          {runs.map(r => (
            <option key={r.id} value={r.id}>
              {SCAN_LABEL[r.scan_type] ?? r.scan_type} — {fmtDate(r.started_at)}
              {r.new_finding_count > 0 ? ` [${r.new_finding_count} new]` : ''}
            </option>
          ))}
        </select>
      </div>

      {!detail && (
        <div className="flex items-center justify-center h-24">
          <span className="text-[9px] font-terminal text-muted-foreground/30 uppercase tracking-widest">Loading report…</span>
        </div>
      )}

      {run && detail && (
        <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
          {/* Run summary bar */}
          <div className="flex items-center gap-3 px-3 py-2 bg-black/40 border border-border/20 rounded-sm">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[run.status] ?? 'bg-muted-foreground/30'}`} />
            <span className="text-[9px] font-terminal uppercase tracking-wider text-muted-foreground/60">
              {run.status}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/40">
              {fmtDate(run.started_at)}
            </span>
            <span className="ml-auto text-[9px] font-mono text-muted-foreground/50">
              {run.finding_count} finding{run.finding_count !== 1 ? 's' : ''}
              {run.new_finding_count > 0 && (
                <span className="ml-2 text-phobos-amber/70">
                  {run.new_finding_count} new
                </span>
              )}
            </span>
          </div>

          {/* Error message */}
          {run.error_message && (
            <div className="px-3 py-2 bg-destructive/10 border border-destructive/20 rounded-sm">
              <span className="text-[9px] font-terminal text-destructive/70 uppercase tracking-widest block mb-1">Error</span>
              <span className="text-[10px] font-mono text-destructive/60">{run.error_message}</span>
            </div>
          )}

          {/* SEREN digest */}
          <div className="px-3 py-2.5 bg-black/30 border border-border/20 rounded-sm">
            <span className="text-[9px] font-terminal text-phobos-green/50 uppercase tracking-widest block mb-2">
              SEREN Analysis
            </span>
            {run.seren_digest ? (
              <p className="text-[10px] font-mono text-foreground/65 leading-relaxed whitespace-pre-wrap">
                {run.seren_digest}
              </p>
            ) : (
              <p className="text-[9px] font-mono text-muted-foreground/30 italic">
                No digest available.
              </p>
            )}
          </div>

          {/* New findings highlight */}
          {detail.findings.filter(f => f.is_new).length > 0 && (
            <div className="px-3 py-2.5 bg-phobos-amber/5 border border-phobos-amber/20 rounded-sm">
              <span className="text-[9px] font-terminal text-phobos-amber/60 uppercase tracking-widest block mb-2">
                New Since Last Run
              </span>
              <div className="space-y-1">
                {detail.findings.filter(f => f.is_new).map(f => (
                  <div key={f.id} className="flex items-center gap-2">
                    <span className="text-[9px] font-terminal text-phobos-amber/50 uppercase w-14 shrink-0">
                      {f.severity}
                    </span>
                    <span className="text-[9px] font-mono text-foreground/55 truncate">
                      {f.title}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw output collapsible */}
          {run.raw_output && (
            <div className="border border-border/20 rounded-sm overflow-hidden">
              <button
                onClick={() => setRawExpanded(e => !e)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-black/20 hover:bg-black/40 transition-colors text-left"
              >
                {rawExpanded
                  ? <ChevronDown className="w-3 h-3 text-muted-foreground/30" />
                  : <ChevronRight className="w-3 h-3 text-muted-foreground/30" />}
                <span className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40">
                  Raw Output
                </span>
              </button>
              {rawExpanded && (
                <pre className="px-3 py-2 text-[9px] font-mono text-muted-foreground/40 overflow-x-auto leading-relaxed bg-black/30 max-h-48 overflow-y-auto">
                  {run.raw_output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
