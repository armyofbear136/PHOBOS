import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Home, Wifi, WifiOff, Loader2, RefreshCw, Plug, PlugZap, Eye, ChevronDown, ChevronRight } from 'lucide-react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'error';
type WatchRunStatus  = 'running' | 'success' | 'error';
type WatchRunOrigin  = 'copilot' | 'scheduled';

interface HaStatus {
  state:             ConnectionState;
  error:             string | null;
  entityCount:       number;
  last_connected_at: string | null;
  ha_url:            string | null;
  enabled:           boolean;
  exposed_domains:   string[];
}

interface EntityLine { line: string; }

interface WatchRun {
  id:           string;
  origin:       WatchRunOrigin;
  prompt:       string;
  status:       WatchRunStatus;
  started_at:   string;
  completed_at: string | null;
  output:       string | null;
  error:        string | null;
  entity_count: number;
}

const ALL_DOMAINS = [
  'light', 'switch', 'climate', 'cover', 'lock',
  'sensor', 'binary_sensor', 'media_player', 'alarm_control_panel',
  'person', 'device_tracker', 'input_boolean', 'automation', 'scene',
];

function fmtTime(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString();
}

function stateDotClass(state: ConnectionState): string {
  switch (state) {
    case 'connected':      return 'bg-phobos-green animate-pulse-dot';
    case 'connecting':
    case 'authenticating': return 'bg-amber-400 animate-pulse';
    case 'error':          return 'bg-destructive';
    default:               return 'bg-muted-foreground/30';
  }
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':      return 'Connected';
    case 'connecting':     return 'Connecting...';
    case 'authenticating': return 'Authenticating...';
    case 'error':          return 'Error';
    default:               return 'Disconnected';
  }
}

interface Props { onClose: () => void; }

export function HomeAssistantPanel({ onClose }: Props) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(0, Math.round(window.innerWidth  / 2 - 420)),
    y: Math.max(0, Math.round(window.innerHeight / 2 - 360)),
  }));
  const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button,input,a,textarea,select,[data-nodrag]')) return;
    dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: dragRef.current.px + e.clientX - dragRef.current.ox, y: dragRef.current.py + e.clientY - dragRef.current.oy });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const [status,           setStatus]           = useState<HaStatus | null>(null);
  const [entities,         setEntities]         = useState<EntityLine[]>([]);
  const [watchRuns,        setWatchRuns]        = useState<WatchRun[]>([]);
  const [expandedRun,      setExpandedRun]      = useState<string | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [entitiesLoading,  setEntitiesLoading]  = useState(false);
  const [saving,           setSaving]           = useState(false);
  const [disconnecting,    setDisconnecting]    = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [haUrl,            setHaUrl]            = useState('');
  const [haToken,          setHaToken]          = useState('');
  const [tokenVisible,     setTokenVisible]     = useState(false);

  const fetchWatchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/ha/watch/runs`);
      if (!res.ok) return;
      const runs: WatchRun[] = await res.json();
      setWatchRuns(runs);
    } catch { /* non-fatal */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/ha/status`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data: HaStatus = await res.json();
      setStatus(data);
      if (data.ha_url) setHaUrl(data.ha_url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEntities = useCallback(async () => {
    setEntitiesLoading(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/ha/states`);
      if (!res.ok) return;
      const data: { connected: boolean; entities: EntityLine[] } = await res.json();
      setEntities(data.entities);
    } catch { /* non-fatal */ }
    finally { setEntitiesLoading(false); }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
      if (status?.state === 'connected') {
        fetchEntities();
        fetchWatchRuns();
      }
    }, status?.state === 'connected' ? 30_000 : 5_000);
    return () => clearInterval(interval);
  }, [status?.state, fetchStatus, fetchEntities, fetchWatchRuns]);

  useEffect(() => {
    if (status?.state === 'connected') {
      fetchEntities();
      fetchWatchRuns();
    }
  }, [status?.state, fetchEntities, fetchWatchRuns]);

  const handleConnect = async () => {
    const url   = haUrl.trim().replace(/\/$/, '');
    const token = haToken.trim();
    if (!url || !token) { setError('HA URL and token are required.'); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/ha/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ha_url: url, ha_token: token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setHaToken('');
      await fetchStatus();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true); setError(null);
    try {
      await fetch(`${ENGINE_URL}/api/ha/disconnect`, { method: 'POST' });
      setEntities([]);
      await fetchStatus();
    } catch (e) { setError((e as Error).message); }
    finally { setDisconnecting(false); }
  };

  const handleToggleDomain = async (domain: string) => {
    if (!status) return;
    const current = status.exposed_domains ?? ALL_DOMAINS;
    const next    = current.includes(domain) ? current.filter(d => d !== domain) : [...current, domain];
    try {
      await fetch(`${ENGINE_URL}/api/ha/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exposed_domains: next }),
      });
      setStatus(s => s ? { ...s, exposed_domains: next } : s);
    } catch { /* non-fatal */ }
  };

  const isConnected    = status?.state === 'connected';
  const isConnecting   = status?.state === 'connecting' || status?.state === 'authenticating';
  const exposedDomains = status?.exposed_domains ?? ALL_DOMAINS;

  const INPUT = 'w-full bg-transparent border border-border/40 focus:border-phobos-green/50 rounded-sm px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/30 focus:outline-none transition-colors';
  const LABEL = 'block text-xs font-terminal uppercase tracking-widest text-muted-foreground/60 mb-1.5';

  return (
    <div
      className="phobos-ha-panel fixed z-50 w-[780px] bg-background border border-phobos-green/20 rounded-sm shadow-[0_0_40px_rgba(0,255,65,0.06)] flex flex-col select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-5 py-3 border-b border-border/40 cursor-move"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-3">
          <Home className="w-5 h-5 text-phobos-green/60" />
          <span className="text-base font-terminal text-phobos-green/80 tracking-wider uppercase">
            Home Assistant
          </span>
          {status && (
            <div className="flex items-center gap-2 ml-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${stateDotClass(status.state)}`} />
              <span className="text-xs font-mono text-muted-foreground/60">
                {stateLabel(status.state)}
              </span>
            </div>
          )}
        </div>
        <button onClick={onClose} className="p-1.5 text-muted-foreground/40 hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-col overflow-hidden" style={{ maxHeight: 'calc(100vh - 120px)' }}>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-phobos-green/40 animate-spin" />
          </div>
        ) : (
          <>
            {/* Connection form */}
            <div className="px-5 py-4 border-b border-border/30 space-y-4">
              <div>
                <label className={LABEL}>HA URL</label>
                <input
                  type="url"
                  value={haUrl}
                  onChange={e => setHaUrl(e.target.value)}
                  placeholder="http://homeassistant.local:8123"
                  className={INPUT}
                />
              </div>

              <div>
                <label className={LABEL}>Long-Lived Access Token</label>
                <div className="flex gap-3">
                  <div className="relative flex-1">
                    <input
                      type={tokenVisible ? 'text' : 'password'}
                      value={haToken}
                      onChange={e => setHaToken(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
                      placeholder={isConnected ? '(token saved — enter new to rotate)' : 'Paste token from HA Profile page'}
                      className={`${INPUT} pr-16`}
                    />
                    <button
                      onClick={() => setTokenVisible(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                    >
                      {tokenVisible ? 'HIDE' : 'SHOW'}
                    </button>
                  </div>
                  <button
                    onClick={handleConnect}
                    disabled={saving || isConnecting}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-terminal uppercase tracking-widest rounded-sm border border-phobos-green/40 text-phobos-green/80 hover:text-phobos-green hover:border-phobos-green/60 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
                    {isConnected ? 'Reconnect' : 'Connect'}
                  </button>
                  {isConnected && (
                    <button
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-terminal uppercase tracking-widest rounded-sm border border-destructive/30 text-destructive/60 hover:text-destructive hover:border-destructive/50 transition-all disabled:opacity-40"
                    >
                      {disconnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                      Disconnect
                    </button>
                  )}
                </div>
                <p className="text-xs font-mono text-muted-foreground/35 mt-2 leading-relaxed">
                  Generate a Long-Lived Token under{' '}
                  <span className="text-muted-foreground/55">Profile &rarr; Security &rarr; Long-Lived Access Tokens</span>.
                  Stored locally, never transmitted outside your network.
                </p>
              </div>

              {error && (
                <div className="text-sm font-mono text-destructive/90 bg-destructive/5 border border-destructive/20 rounded-sm px-3 py-2">
                  {error}
                </div>
              )}
            </div>

            {/* Status bar */}
            {status && (
              <div className="flex items-center gap-5 px-5 py-2.5 border-b border-border/20 text-xs font-mono text-muted-foreground/50">
                <span>
                  {isConnected
                    ? <><Wifi className="w-3.5 h-3.5 inline mr-1.5 text-phobos-green/60" />{status.entityCount} entities</>
                    : <><WifiOff className="w-3.5 h-3.5 inline mr-1.5" />No connection</>}
                </span>
                {status.ha_url && <span className="truncate text-muted-foreground/30">{status.ha_url}</span>}
                <span className="ml-auto shrink-0">Last connected: {fmtTime(status.last_connected_at)}</span>
              </div>
            )}

            {/* Domain filter chips */}
            <div className="px-5 py-4 border-b border-border/20">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-widest">
                  AI Context Domains
                </span>
                <span className="text-xs font-mono text-muted-foreground/30">
                  — injected into copilot context when connected
                </span>
              </div>
              <div className="flex flex-wrap gap-2" data-nodrag>
                {ALL_DOMAINS.map(domain => {
                  const active = exposedDomains.includes(domain);
                  return (
                    <button
                      key={domain}
                      onClick={() => handleToggleDomain(domain)}
                      className={`px-3 py-1 text-xs font-mono rounded-sm border transition-all ${
                        active
                          ? 'border-phobos-green/40 text-phobos-green/80 bg-phobos-green/5 hover:border-phobos-green/60'
                          : 'border-border/25 text-muted-foreground/35 hover:border-border/50 hover:text-muted-foreground/55'
                      }`}
                    >
                      {domain}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Live entity list */}
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between px-5 py-2.5 border-b border-border/20">
                <span className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-widest">
                  Live State
                </span>
                <button
                  onClick={fetchEntities}
                  disabled={entitiesLoading || !isConnected}
                  className="p-1 text-muted-foreground/30 hover:text-muted-foreground/70 disabled:opacity-30 transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${entitiesLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-3 scrollbar-thin" style={{ maxHeight: 280 }} data-nodrag>
                {!isConnected && (
                  <div className="py-10 text-center text-sm font-mono text-muted-foreground/25">
                    Connect to view live entity state
                  </div>
                )}
                {isConnected && entities.length === 0 && !entitiesLoading && (
                  <div className="py-10 text-center text-sm font-mono text-muted-foreground/25">
                    No entities in selected domains
                  </div>
                )}
                {isConnected && entities.map((e, i) => (
                  <div key={i} className="text-xs font-mono text-muted-foreground/60 py-1 border-b border-border/10 last:border-0 truncate hover:text-muted-foreground/80 transition-colors">
                    {e.line}
                  </div>
                ))}
              </div>
            </div>

            {/* Watch Results */}
            <div className="flex flex-col border-t border-border/20">
              <div className="flex items-center justify-between px-5 py-2.5 border-b border-border/20">
                <div className="flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5 text-muted-foreground/40" />
                  <span className="text-xs font-terminal text-muted-foreground/50 uppercase tracking-widest">
                    Watch Duty
                  </span>
                  <span className="text-xs font-mono text-muted-foreground/30">
                    — recent runs
                  </span>
                </div>
                <button
                  onClick={fetchWatchRuns}
                  disabled={!isConnected}
                  className="p-1 text-muted-foreground/30 hover:text-muted-foreground/70 disabled:opacity-30 transition-colors"
                  title="Refresh watch runs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="overflow-y-auto px-5 py-2 scrollbar-thin" style={{ maxHeight: 220 }} data-nodrag>
                {watchRuns.length === 0 && (
                  <div className="py-6 text-center text-xs font-mono text-muted-foreground/25">
                    No watch duty runs yet
                  </div>
                )}
                {watchRuns.map(run => (
                  <div key={run.id} className="border-b border-border/10 last:border-0">
                    <button
                      onClick={() => setExpandedRun(prev => prev === run.id ? null : run.id)}
                      className="w-full flex items-start gap-3 py-2 text-left hover:bg-white/[0.01] transition-colors"
                    >
                      {expandedRun === run.id
                        ? <ChevronDown className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/30" />
                        : <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/30" />
                      }
                      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                        run.status === 'success' ? 'bg-phobos-green/60' :
                        run.status === 'running' ? 'bg-amber-400 animate-pulse' :
                        'bg-destructive/60'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-muted-foreground/60 truncate">
                            {run.prompt.length > 60 ? run.prompt.slice(0, 60) + '…' : run.prompt}
                          </span>
                          <span className={`text-[10px] font-terminal uppercase tracking-widest shrink-0 px-1.5 py-0.5 rounded-sm border ${
                            run.origin === 'copilot'
                              ? 'border-phobos-green/20 text-phobos-green/40'
                              : 'border-border/30 text-muted-foreground/35'
                          }`}>
                            {run.origin}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground/30 mt-0.5">
                          {fmtTime(run.started_at)}
                          {run.entity_count > 0 && ` · ${run.entity_count} entities`}
                        </div>
                      </div>
                    </button>
                    {expandedRun === run.id && (
                      <div className="ml-6 mb-2 px-3 py-2 bg-white/[0.02] border border-border/20 rounded-sm">
                        {run.status === 'running' && (
                          <div className="flex items-center gap-2 text-xs font-mono text-amber-400/70">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Running…
                          </div>
                        )}
                        {run.status === 'error' && (
                          <p className="text-xs font-mono text-destructive/70 whitespace-pre-wrap">
                            {run.error ?? 'Unknown error'}
                          </p>
                        )}
                        {run.status === 'success' && (
                          <p className="text-xs font-mono text-muted-foreground/70 whitespace-pre-wrap leading-relaxed">
                            {run.output ?? '(no output)'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}