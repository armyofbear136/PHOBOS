/**
 * SecurityPanel.tsx — full-height modal overlay for the PHOBOS Security menu.
 *
 * Four tabs: Scans | Findings | Reports | Config
 * Phase 2: all scanners are native TypeScript. ToolStatus only exposes clamav.
 * SCAN_CARDS updated to reflect native descriptions. Config adds clamav_update_cron.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Shield, Play, RefreshCw, RotateCcw,
  CheckCircle2, XCircle, Clock, Loader2,
} from 'lucide-react';
import { SecurityFindingsTable, type SecurityFinding } from './SecurityFindingsTable';
import { SecurityReportView }                           from './SecurityReportView';
import { SecurityToolStatus, type ToolStatus }          from './SecurityToolStatus';
import { useAppStore }                                  from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanType =
  | 'port_scan' | 'web_scan' | 'malware_scan'
  | 'dependency_audit' | 'system_audit' | 'integrity_check';

type ScanStatus = 'running' | 'analyzing' | 'success' | 'error' | 'tool_missing';

interface ScanRun {
  id:                string;
  scan_type:         ScanType;
  status:            ScanStatus;
  started_at:        string;
  completed_at:      string | null;
  finding_count:     number;
  new_finding_count: number;
  error_message:     string | null;
  seren_digest:      string | null;
}

interface SecurityConfig {
  port_scan_cron:        string;
  web_scan_cron:         string;
  malware_scan_cron:     string;
  dependency_audit_cron: string;
  system_audit_cron:     string;
  integrity_check_cron:  string;
  clamav_update_cron:    string;
  malware_scan_paths:    string;
  semgrep_enabled:       string;
  integrity_enabled:     string;
}

interface StatusPayload {
  tools:    ToolStatus;
  lastRuns: Partial<Record<ScanType, ScanRun>>;
  config:   SecurityConfig;
  homedir:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

type Tab = 'scans' | 'findings' | 'reports' | 'config';

const TABS: { id: Tab; label: string }[] = [
  { id: 'scans',    label: 'Scans' },
  { id: 'findings', label: 'Findings' },
  { id: 'reports',  label: 'Reports' },
  { id: 'config',   label: 'Config' },
];

const SCAN_CARDS: { type: ScanType; label: string; desc: string; descMissing?: string; clamavRequired?: true }[] = [
  { type: 'system_audit',     label: 'System Audit',     desc: 'OS hardening — firewall, encryption, SSH config (native)' },
  { type: 'integrity_check',  label: 'File Integrity',   desc: 'SHA-256 hash check on critical system binaries (native)' },
  { type: 'port_scan',        label: 'Port Scan',        desc: 'TCP connect scan — open ports on localhost (native)' },
  { type: 'web_scan',         label: 'Web Audit',        desc: 'HTTP security headers, methods, exposed paths (native)' },
  { type: 'dependency_audit', label: 'Dependency Audit', desc: 'npm advisory registry — CVE check on package-lock.json (native)' },
  { type: 'malware_scan',     label: 'Malware Scan',     desc: 'ClamAV — targeted directory scan', descMissing: 'ClamAV — targeted directory scan (requires ClamAV install)', clamavRequired: true },
];

const STATUS_DOT: Record<ScanStatus, string> = {
  success:      'bg-phobos-green',
  error:        'bg-destructive',
  running:      'bg-phobos-amber animate-pulse',
  analyzing:    'bg-phobos-amber animate-pulse',
  tool_missing: 'bg-muted-foreground/20',
};

const CONFIG_CRON_KEYS: { key: keyof SecurityConfig; label: string }[] = [
  { key: 'port_scan_cron',        label: 'Port Scan' },
  { key: 'web_scan_cron',         label: 'Web Audit' },
  { key: 'malware_scan_cron',     label: 'Malware Scan' },
  { key: 'dependency_audit_cron', label: 'Dependency Audit' },
  { key: 'system_audit_cron',     label: 'System Audit' },
  { key: 'integrity_check_cron',  label: 'File Integrity' },
  { key: 'clamav_update_cron',    label: 'ClamAV Def Update' },
];

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SecurityPanel() {
  const setSecurityOpen = useAppStore(s => s.setSecurityOpen);

  // Drag state
  const [pos, setPos] = useState(() => ({
    x: Math.max(0, Math.round(window.innerWidth  / 2 - 400)),
    y: Math.max(0, Math.round(window.innerHeight / 2 - 416)),
  }));
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, a, textarea, [data-nodrag]')) return;
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.px + e.clientX - dragRef.current.ox,
        y: dragRef.current.py + e.clientY - dragRef.current.oy,
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);
  const [tab,        setTab]       = useState<Tab>('scans');
  const [status,     setStatus]    = useState<StatusPayload | null>(null);
  const [findings,   setFindings]  = useState<SecurityFinding[]>([]);
  const [running,    setRunning]   = useState<Set<ScanType>>(new Set());
  const [config,     setConfig]    = useState<Partial<SecurityConfig>>({});
  const [scanPaths,  setScanPaths] = useState<string[]>([]);
  const [homedir,    setHomedir]   = useState<string>('');
  const [pathsReady, setPathsReady] = useState(false);
  const [savingCfg,  setSavingCfg] = useState(false);
  const [resetting,  setResetting] = useState(false);
  const [loading,    setLoading]   = useState(true);

  const loadStatus = useCallback(async (): Promise<StatusPayload | null> => {
    try {
      const [statusRes, findingsRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/security/status`),
        fetch(`${ENGINE_URL}/api/security/findings`),
      ]);
      if (statusRes.ok) {
        const data: StatusPayload = await statusRes.json();
        setStatus(data);
        setConfig(data.config);
        if (data.homedir) setHomedir(data.homedir);
        // Only initialize scanPaths once — never overwrite user edits from polls
        setPathsReady(prev => {
          if (!prev) {
            try { setScanPaths(JSON.parse(data.config.malware_scan_paths ?? '[]')); } catch { setScanPaths([]); }
            return true;
          }
          return prev;
        });
        if (findingsRes.ok) setFindings(await findingsRes.json());
        setLoading(false);
        return data;
      }
    } catch { /* non-fatal */ }
    setLoading(false);
    return null;
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll while any scan is running
  useEffect(() => {
    if (running.size === 0) return;
    const interval = setInterval(() => loadStatus(), 4_000);
    return () => clearInterval(interval);
  }, [running.size, loadStatus]);

  async function triggerScan(type: ScanType) {
    if (type === 'malware_scan') await savePaths(scanPaths);
    setRunning(prev => new Set(prev).add(type));
    try {
      await fetch(`${ENGINE_URL}/api/security/scans/${type}/run`, { method: 'POST' });
      const poll = setInterval(async () => {
        const fresh = await loadStatus();
        const run = fresh?.lastRuns[type];
        if (run && run.status !== 'running' && run.status !== 'analyzing') {
          clearInterval(poll);
          setRunning(prev => { const s = new Set(prev); s.delete(type); return s; });
          loadStatus();
        }
      }, 3_000);
    } catch {
      setRunning(prev => { const s = new Set(prev); s.delete(type); return s; });
    }
  }

  async function savePaths(paths: string[]) {
    try {
      await fetch(`${ENGINE_URL}/api/security/config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...config, malware_scan_paths: JSON.stringify(paths) }),
      });
    } catch { /* non-fatal */ }
  }

  async function saveConfig() {
    setSavingCfg(true);
    await savePaths(scanPaths);
    await loadStatus();
    setSavingCfg(false);
  }

  async function resetBaseline() {
    if (!confirm('This will re-hash all monitored files and replace the baseline. Continue?')) return;
    setResetting(true);
    try {
      await fetch(`${ENGINE_URL}/api/security/baseline/reset`, { method: 'POST' });
    } catch { /* non-fatal */ }
    setResetting(false);
  }

  const newFindingCount = findings.filter(f => f.is_new).length;
  const tools           = status?.tools ?? { clamav: null };

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 8950,
      width: 800, userSelect: 'none',
      filter: 'drop-shadow(0 12px 48px rgba(0,0,0,.85))',
    }}>
      <div style={{ width: 800, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
           className="phobos-panel bg-card border border-border rounded-sm overflow-hidden">

        {/* Header — drag handle */}
        <div
          onMouseDown={onMouseDown}
          style={{ cursor: 'grab' }}
          className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0"
        >
          <div className="flex items-center gap-2" data-nodrag>
            <Shield className="w-4 h-4 text-phobos-green/70" />
            <span className="text-sm font-terminal uppercase tracking-[0.15em] text-phobos-green">
              Security
            </span>
            {newFindingCount > 0 && (
              <span className="text-xs font-terminal uppercase tracking-widest text-phobos-amber bg-phobos-amber/10 px-1.5 py-0.5 rounded-sm">
                {newFindingCount} new
              </span>
            )}
          </div>
          <button onClick={() => setSecurityOpen(false)} className="p-1 hover:bg-accent rounded transition-colors" data-nodrag>
            <X className="w-4 h-4 text-foreground/60" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-border/30 bg-black/30 shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-terminal uppercase tracking-widest transition-colors border-b-2 ${
                tab === t.id
                  ? 'text-phobos-green border-phobos-green bg-phobos-green/5'
                  : 'text-foreground/50 border-transparent hover:text-foreground/80'
              }`}
            >
              {t.label}
              {t.id === 'findings' && findings.length > 0 && (
                <span className="ml-1.5 text-foreground/40">({findings.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4" style={{ height: 732 }}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-sm font-terminal text-foreground/40 uppercase tracking-widest">Loading…</span>
            </div>
          ) : (
            <>
              {/* ── Scans tab ───────────────────────────────────────────── */}
              {tab === 'scans' && (
                <div className="space-y-2">
                  {SCAN_CARDS.map(card => {
                    const lastRun    = status?.lastRuns[card.type] ?? null;
                    const isRunning  = running.has(card.type) || lastRun?.status === 'running' || lastRun?.status === 'analyzing';
                    const clamavMissing = card.clamavRequired && tools.clamav === null;

                    return (
                      <div
                        key={card.type}
                        className="flex flex-col bg-black/30 border border-border/20 rounded-sm"
                      >
                        <div className="flex items-center gap-4 px-4 py-3">
                          {/* Status dot */}
                          <div className="shrink-0 w-3 flex items-center justify-center">
                            {isRunning ? (
                              <Loader2 className="w-3.5 h-3.5 text-phobos-amber animate-spin" />
                            ) : lastRun ? (
                              <span className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[lastRun.status]}`} />
                            ) : (
                              <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground/25" />
                            )}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-terminal text-phobos-green">
                                {card.label}
                              </span>
                              {clamavMissing && (
                                <span className="text-xs font-mono text-foreground/40 uppercase tracking-widest">
                                  clamav not installed
                                </span>
                              )}
                            </div>
                            <p className="text-sm font-mono text-foreground/70 mt-0.5">
                              {clamavMissing && card.descMissing ? card.descMissing : card.desc}
                            </p>
                            {lastRun && (
                              <p className="text-sm font-mono text-foreground/55 mt-0.5">
                                Last: {fmtTime(lastRun.started_at)} — {lastRun.finding_count} finding{lastRun.finding_count !== 1 ? 's' : ''}
                                {lastRun.new_finding_count > 0 && (
                                  <span className="ml-2 text-phobos-amber">{lastRun.new_finding_count} new</span>
                                )}
                              </p>
                            )}
                            {lastRun?.status === 'error' && lastRun.error_message && (
                              <p className="text-sm font-mono text-destructive/80 mt-0.5 truncate">
                                {lastRun.error_message}
                              </p>
                            )}
                          </div>

                          {/* Run button */}
                          {(() => {
                            const noPaths = card.type === 'malware_scan' && scanPaths.length === 0;
                            return (
                              <button
                                onClick={() => triggerScan(card.type)}
                                disabled={isRunning || (clamavMissing ?? false) || noPaths}
                                title={
                                  clamavMissing ? 'Install ClamAV from the Config tab first'
                                  : noPaths     ? 'Add at least one scan path below'
                                  : undefined
                                }
                                className="flex items-center gap-1.5 px-3 py-2 text-sm font-terminal uppercase tracking-widest border border-phobos-green/40 text-phobos-green/80 hover:bg-phobos-green/10 hover:border-phobos-green hover:text-phobos-green disabled:opacity-30 disabled:cursor-not-allowed rounded-sm transition-colors shrink-0"
                              >
                                {lastRun?.status === 'analyzing'
                                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing</>
                                  : isRunning
                                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running</>
                                  : <><Play className="w-3.5 h-3.5" /> Run</>}
                              </button>
                            );
                          })()}
                        </div>

                        {/* Inline path manager — malware_scan only */}
                        {card.type === 'malware_scan' && !clamavMissing && (() => {
                          const addFolder = async () => {
                            try {
                              const res  = await fetch(`${ENGINE_URL}/api/phobos/models/open-folder-dialog`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ initialPath: homedir }),
                              });
                              const { path: picked } = await res.json() as { path: string | null };
                              if (!picked) return;
                              const next = [...scanPaths, picked];
                              setScanPaths(next);
                              await savePaths(next);
                            } catch { /* cancelled or dialog closed */ }
                          };

                          return (
                            <div className="border-t border-border/15 px-3 pt-2 pb-3 flex flex-col gap-1">
                              <p className="text-xs font-terminal uppercase tracking-widest text-phobos-green/60 mb-2">
                                Scan Paths
                              </p>
                              {scanPaths.length === 0 && (
                                <p className="text-sm font-mono text-phobos-amber/80 py-0.5">
                                  No paths configured — add at least one directory to enable scanning.
                                </p>
                              )}
                              {scanPaths.map((p, i) => (
                                <div key={i} className="flex items-center gap-1.5">
                                  <input
                                    value={p}
                                    onChange={e => {
                                      const next = [...scanPaths];
                                      next[i] = e.target.value;
                                      setScanPaths(next);
                                    }}
                                    className="flex-1 bg-black/40 border border-border/40 rounded-sm px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-phobos-green/70"
                                    spellCheck={false}
                                    placeholder="/path/to/scan"
                                    onBlur={() => savePaths(scanPaths)}
                                  />
                                  <button
                                    onClick={() => setScanPaths(scanPaths.filter((_, j) => j !== i))}
                                    className="text-foreground/40 hover:text-red-400 transition-colors px-1"
                                    title="Remove"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                              <div className="flex items-center gap-3 mt-1">
                                <button
                                  onClick={() => setScanPaths(prev => [...prev, ''])}
                                  className="text-xs font-terminal uppercase tracking-widest text-phobos-green/60 hover:text-phobos-green transition-colors"
                                >
                                  + Add Path
                                </button>
                                <button
                                  onClick={addFolder}
                                  className="text-xs font-terminal uppercase tracking-widest text-phobos-green/60 hover:text-phobos-green transition-colors"
                                >
                                  + Browse Folder
                                </button>
                                <button
                                  onClick={saveConfig}
                                  disabled={savingCfg}
                                  className="ml-auto flex items-center gap-1 text-xs font-terminal uppercase tracking-widest text-phobos-green/60 hover:text-phobos-green disabled:opacity-30 transition-colors"
                                >
                                  {savingCfg ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                  Save
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Findings tab ────────────────────────────────────────── */}
              {tab === 'findings' && (
                <SecurityFindingsTable findings={findings} />
              )}

              {/* ── Reports tab ─────────────────────────────────────────── */}
              {tab === 'reports' && (
                <SecurityReportView />
              )}

              {/* ── Config tab ──────────────────────────────────────────── */}
              {tab === 'config' && (
                <div className="space-y-5">
                  {/* Cron schedules */}
                  <div>
                    <h3 className="text-xs font-terminal uppercase tracking-widest text-phobos-green/70 mb-2">
                      Scan Schedules (cron)
                    </h3>
                    <div className="space-y-2">
                      {CONFIG_CRON_KEYS.map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-3">
                          <label className="text-sm font-mono text-foreground/80 w-40 shrink-0">
                            {label}
                          </label>
                          <input
                            type="text"
                            value={config[key] ?? ''}
                            onChange={e => setConfig(prev => ({ ...prev, [key]: e.target.value }))}
                            className="flex-1 bg-black/40 border border-border/40 rounded-sm px-2 py-1.5 text-sm font-mono text-foreground focus:outline-none focus:border-phobos-green/70"
                            placeholder="cron expression"
                            spellCheck={false}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Malware scan paths */}
                  {/* Save button */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={saveConfig}
                      disabled={savingCfg}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-terminal uppercase tracking-widest border border-phobos-green/50 text-phobos-green hover:bg-phobos-green/10 hover:border-phobos-green disabled:opacity-40 rounded-sm transition-colors"
                    >
                      {savingCfg ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      Save & Sync Scheduler
                    </button>
                  </div>

                  {/* Baseline */}
                  <div className="border-t border-border/20 pt-4">
                    <h3 className="text-xs font-terminal uppercase tracking-widest text-phobos-green/70 mb-2">
                      File Integrity Baseline
                    </h3>
                    <p className="text-xs font-mono text-foreground/65 mb-3">
                      Re-run after deliberate system updates to reset the known-good state.
                    </p>
                    <button
                      onClick={resetBaseline}
                      disabled={resetting}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-terminal uppercase tracking-widest border border-border/50 text-foreground/60 hover:border-destructive/60 hover:text-destructive/90 disabled:opacity-40 rounded-sm transition-colors"
                    >
                      {resetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                      Reset Baseline
                    </button>
                  </div>

                  {/* Tool status */}
                  <div className="border-t border-border/20 pt-4">
                    <h3 className="text-xs font-terminal uppercase tracking-widest text-muted-foreground/50 mb-2">
                      Tool Status
                    </h3>
                    <SecurityToolStatus tools={tools} onStatusChanged={loadStatus} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="h-9 flex items-center px-3 border-t border-border/30 bg-black/20 shrink-0">
          <span className="text-xs font-terminal text-foreground/50 uppercase tracking-widest">
            {findings.length} finding{findings.length !== 1 ? 's' : ''} total
            {newFindingCount > 0 ? ` — ${newFindingCount} new since last scan` : ' — no new findings'}
          </span>
        </div>
      </div>
    </div>
  );
}