/**
 * SecurityToolStatus.tsx — tool installation status.
 *
 * Phase 2: port scan, web audit, dependency audit, and code audit are now
 * native TypeScript — no external binaries required. Only ClamAV is optional.
 * Shows ClamAV status with an inline Download button and a progress bar during
 * the fetch/install lifecycle.
 */

import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, XCircle, Download, RefreshCw, Loader2 } from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolStatus {
  clamav: string | null;
}

type FetchPhase =
  | 'idle' | 'resolving' | 'downloading' | 'extracting'
  | 'updating-defs' | 'done' | 'error';

interface FetchProgress {
  phase:           FetchPhase;
  message:         string;
  bytesDownloaded: number;
  totalBytes:      number;
}

interface Props {
  tools:        ToolStatus;
  onStatusChanged: () => void;   // parent re-fetches status after install completes
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PHASE_LABELS: Partial<Record<FetchPhase, string>> = {
  resolving:      'Resolving release…',
  downloading:    'Downloading…',
  extracting:     'Extracting…',
  'updating-defs': 'Updating definitions…',
  done:           'Installation complete.',
  error:          'Install failed.',
};

function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SecurityToolStatus({ tools, onStatusChanged }: Props) {
  const clamavInstalled = tools.clamav !== null;

  const [fetching,     setFetching]     = useState(false);
  const [progress,     setProgress]     = useState<FetchProgress | null>(null);
  const [updateMsg,    setUpdateMsg]    = useState<string | null>(null);
  const [updatingDefs, setUpdatingDefs] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling when done or error
  useEffect(() => {
    if (!fetching) return;

    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${ENGINE_URL}/api/security/tools/clamav/progress`);
        if (!resp.ok) return;
        const reader = resp.body?.getReader();
        if (!reader) return;
        const { value } = await reader.read();
        reader.cancel();
        const text  = new TextDecoder().decode(value ?? new Uint8Array());
        const match = text.match(/^data:\s*(.+)$/m);
        if (!match) return;
        const p: FetchProgress = JSON.parse(match[1]);
        setProgress(p);
        if (p.phase === 'done' || p.phase === 'error') {
          clearInterval(pollRef.current!);
          setFetching(false);
          if (p.phase === 'done') onStatusChanged();
        }
      } catch { /* poll failure — non-fatal */ }
    }, 1_500);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetching, onStatusChanged]);

  async function startFetch() {
    setFetching(true);
    setProgress({ phase: 'resolving', message: 'Starting…', bytesDownloaded: 0, totalBytes: 0 });
    try {
      const resp = await fetch(`${ENGINE_URL}/api/security/tools/clamav/fetch`, { method: 'POST' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        setProgress(prev => prev && ({
          ...prev,
          phase:   'error',
          message: body.error ?? 'Request failed',
        }));
        setFetching(false);
      }
    } catch (err) {
      setProgress(prev => prev && ({
        ...prev,
        phase:   'error',
        message: (err as Error).message,
      }));
      setFetching(false);
    }
  }

  async function startUpdateDefs() {
    setUpdatingDefs(true);
    setUpdateMsg(null);
    try {
      const resp = await fetch(`${ENGINE_URL}/api/security/tools/clamav/update-defs`, { method: 'POST' });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        setUpdateMsg(body.error ?? 'Update request failed.');
        setUpdatingDefs(false);
        return;
      }
      // 202 accepted — poll progress until done or error
      setUpdateMsg('Updating definitions — this runs in the background and takes 2–5 minutes…');
      const poll = setInterval(async () => {
        try {
          const pr = await fetch(`${ENGINE_URL}/api/security/tools/clamav/progress`);
          if (!pr.ok) return;
          const reader = pr.body?.getReader();
          if (!reader) return;
          const { value } = await reader.read();
          reader.cancel();
          const text  = new TextDecoder().decode(value ?? new Uint8Array());
          const match = text.match(/^data:\s*(.+)$/m);
          if (!match) return;
          const p: FetchProgress = JSON.parse(match[1]);
          if (p.phase === 'done') {
            clearInterval(poll);
            setUpdatingDefs(false);
            setUpdateMsg('Definitions updated. Ready for next scan.');
          } else if (p.phase === 'error') {
            clearInterval(poll);
            setUpdatingDefs(false);
            setUpdateMsg(`Update failed: ${p.message}`);
          }
        } catch { /* poll failure — non-fatal */ }
      }, 2_000);
    } catch (err) {
      setUpdateMsg((err as Error).message);
      setUpdatingDefs(false);
    }
  }

  const progressPct = progress?.totalBytes
    ? Math.min(100, Math.round((progress.bytesDownloaded / progress.totalBytes) * 100))
    : null;

  return (
    <div className="space-y-2">
      {/* Native tools summary */}
      <div className="px-3 py-2.5 rounded-sm bg-black/30 border border-border/20">
        <div className="flex items-center gap-2 mb-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-phobos-green shrink-0" />
          <span className="text-sm font-terminal text-phobos-green">
            Native Scanners
          </span>
          <span className="text-xs font-mono text-phobos-green uppercase tracking-wider">
            active
          </span>
        </div>
        <p className="text-xs font-mono text-foreground/70 leading-relaxed">
          Port scan, HTTP audit, dependency audit, and code audit run natively — no external binaries required.
        </p>
      </div>

      {/* ClamAV */}
      <div className="px-3 py-2.5 rounded-sm bg-black/30 border border-border/20">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            {clamavInstalled ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-phobos-green" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-muted-foreground/40" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-terminal ${clamavInstalled ? 'text-phobos-green' : 'text-foreground/40'}`}>
                ClamAV
              </span>
              {clamavInstalled ? (
                <span className="text-[9px] font-mono text-phobos-green/60 uppercase tracking-wider">
                  installed
                </span>
              ) : (
                <span className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
                  not installed
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-foreground/70 mt-0.5 leading-relaxed">
              Antivirus engine — malware scan on targeted directories.
              {clamavInstalled && (
                <span className="block text-xs text-phobos-green/50 mt-0.5 truncate">
                  {tools.clamav}
                </span>
              )}
            </p>

            {/* Action buttons */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {!clamavInstalled && !fetching && (
                <button
                  onClick={startFetch}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-terminal uppercase tracking-widest border border-phobos-green/50 text-phobos-green hover:bg-phobos-green/10 hover:border-phobos-green rounded-sm transition-colors"
                >
                  <Download className="w-2.5 h-2.5" />
                  Download ClamAV
                </button>
              )}

              {clamavInstalled && !updatingDefs && (
                <button
                  onClick={startUpdateDefs}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-terminal uppercase tracking-widest border border-border/50 text-foreground/60 hover:border-phobos-green/60 hover:text-phobos-green rounded-sm transition-colors"
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  Update Definitions
                </button>
              )}

              {updatingDefs && (
                <div className="flex items-center gap-1.5 text-xs font-mono text-foreground/70">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  Requesting update…
                </div>
              )}
            </div>

            {/* Update message */}
            {updateMsg && (
              <p className="text-xs font-mono text-foreground/70 mt-1.5 leading-relaxed">
                {updateMsg}
              </p>
            )}

            {/* Progress block */}
            {fetching && progress && (
              <div className="mt-2 space-y-1.5">
                {/* Phase label */}
                <p className="text-xs font-mono text-foreground/70">
                  {PHASE_LABELS[progress.phase] ?? progress.message}
                </p>

                {/* Progress bar — only visible during download */}
                {progress.phase === 'downloading' && (
                  <div className="w-full h-1 bg-black/40 rounded-full overflow-hidden border border-border/20">
                    <div
                      className="h-full bg-phobos-green/50 rounded-full transition-all duration-300"
                      style={{ width: `${progressPct ?? 0}%` }}
                    />
                  </div>
                )}

                {/* Byte counter */}
                {progress.phase === 'downloading' && progress.totalBytes > 0 && (
                  <p className="text-xs font-mono text-foreground/55">
                    {formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
                    {progressPct !== null && ` (${progressPct}%)`}
                  </p>
                )}

                {/* Spinner for non-download phases */}
                {progress.phase !== 'downloading' && progress.phase !== 'done' && progress.phase !== 'error' && (
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="w-2.5 h-2.5 text-muted-foreground/30 animate-spin" />
                    <span className="text-[9px] font-mono text-muted-foreground/30">
                      {progress.message}
                    </span>
                  </div>
                )}

                {/* Error message */}
                {progress.phase === 'error' && (
                  <p className="text-xs font-mono text-destructive/90">
                    {progress.message}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pt-1">
        <p className="text-xs font-mono text-foreground/50 px-1">
          System audit and file integrity run natively and require no external tools.
        </p>
      </div>
    </div>
  );
}