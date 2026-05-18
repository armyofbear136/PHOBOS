/**
 * ArchivePanel.tsx — PHOBOS Archive (SYBIL Phase 2)
 *
 * Domain tabs · Source browser · Drag-drop ingest · Search panel · Status footer
 *
 * Placed at: src/components/archive/ArchivePanel.tsx
 */

import { useState, useEffect, useCallback } from 'react';
import {
  X, Database, Upload, Search, Trash2, Plus, FileText,
  Globe, Clipboard, Loader2, CheckCircle2, AlertTriangle,
  ChevronRight, FolderOpen,
} from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

type SourceType = 'file' | 'url' | 'paste';

interface DomainInfo {
  domain:      string;
  chunkCount:  number;
  sourceCount: number;
  lastIngest:  string | null;
  sizeBytes:   number;
}

interface SourceRecord {
  id:          string;
  sourcePath:  string;
  sourceTitle: string | null;
  sourceType:  SourceType;
  chunkCount:  number;
  ingestAt:    string;
}

interface SearchResult {
  id:          string;
  domain:      string;
  sourceTitle: string | null;
  sourcePath:  string;
  breadcrumb:  string | null;
  chunkText:   string;
  score:       number;
}

interface ArchiveStatus {
  sybilOnline: boolean;
  totalChunks: number;
  domains:     DomainInfo[];
}

interface IngestProgress {
  sourceId: string;
  current:  number;
  total:    number;
  pct:      number;
  status:   'running' | 'done' | 'error';
  error?:   string;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useArchiveStatus() {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE}/api/archive/status`);
      if (res.ok) setStatus(await res.json());
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { status, loading, refresh };
}

function useSources(domain: string | null) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!domain) { setSources([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`${ENGINE}/api/archive/domains/${domain}/sources`);
      if (res.ok) {
        const data = await res.json();
        setSources(data.sources ?? []);
      }
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [domain]);

  useEffect(() => { refresh(); }, [refresh]);
  return { sources, loading, refresh };
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function domainLabel(domain: string): string {
  return domain.replace(/^custom-/, '').replace(/-/g, ' ').toUpperCase();
}

// ── Style constants ───────────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", "Fira Code", monospace' };

const colors = {
  bg:        '#07090b',
  surface:   '#0d0f13',
  surfaceHi: '#111418',
  border:    '#1c2028',
  borderHi:  'hsl(var(--secondary))',
  text:      '#c8d4e0',
  muted:     'hsl(var(--muted-foreground))',
  green:     '#39ff6e',
  greenDim:  'rgba(57,255,110,0.15)',
  greenGlow: 'rgba(57,255,110,0.06)',
  amber:     '#f59e0b',
  red:       '#ef4444',
  blue:      '#60a5fa',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.18em',
      color: colors.muted, textTransform: 'uppercase', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function GreenBtn({ onClick, disabled, children, style }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
        padding: '6px 14px', borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: colors.green, color: '#07090b', border: 'none',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function GhostBtn({ onClick, disabled, children, style }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono, fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
        padding: '5px 12px', borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: 'transparent', color: colors.muted,
        border: `1px solid ${colors.border}`,
        ...style,
      }}
      onMouseEnter={e => !disabled && (e.currentTarget.style.color = colors.text)}
      onMouseLeave={e => (e.currentTarget.style.color = colors.muted)}
    >
      {children}
    </button>
  );
}

// ── Domain tab strip ──────────────────────────────────────────────────────────

function DomainTab({ domain, active, chunkCount, onClick }: {
  domain: string; active: boolean; chunkCount: number; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
        padding: '6px 12px', whiteSpace: 'nowrap', cursor: 'pointer',
        background: active ? colors.greenDim : 'transparent',
        color: active ? colors.green : colors.muted,
        border: 'none',
        borderBottom: active ? `2px solid ${colors.green}` : '2px solid transparent',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.color = colors.text)}
      onMouseLeave={e => !active && (e.currentTarget.style.color = colors.muted)}
    >
      {domainLabel(domain)}
      <span style={{ marginLeft: 6, opacity: 0.5, fontSize: 8 }}>{chunkCount}</span>
    </button>
  );
}

// ── Source row ────────────────────────────────────────────────────────────────

function SourceRow({ source, onDelete }: { source: SourceRecord; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const icon = source.sourceType === 'url' ? <Globe size={11} /> :
               source.sourceType === 'paste' ? <Clipboard size={11} /> :
               <FileText size={11} />;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 14px', borderBottom: `1px solid ${colors.border}`,
    }}
      onMouseEnter={e => (e.currentTarget.style.background = colors.surfaceHi)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: colors.muted, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...mono, fontSize: 11, color: colors.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {source.sourceTitle ?? source.sourcePath}
        </div>
        <div style={{ ...mono, fontSize: 9, color: colors.muted, marginTop: 2 }}>
          {source.chunkCount} chunks · {fmtDate(source.ingestAt)}
        </div>
      </div>
      {confirming ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onDelete}
            style={{ ...mono, fontSize: 9, color: colors.red, background: 'none',
              border: `1px solid ${colors.red}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer' }}>
            DELETE
          </button>
          <button onClick={() => setConfirming(false)}
            style={{ ...mono, fontSize: 9, color: colors.muted, background: 'none',
              border: `1px solid ${colors.border}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer' }}>
            CANCEL
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: colors.muted, padding: 4, borderRadius: 3, display: 'flex' }}
          onMouseEnter={e => (e.currentTarget.style.color = colors.red)}
          onMouseLeave={e => (e.currentTarget.style.color = colors.muted)}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ── Search result row ─────────────────────────────────────────────────────────

function SearchResultRow({ result }: { result: SearchResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${colors.border}` }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 14px', cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = colors.surfaceHi)}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <ChevronRight size={12} style={{
          color: colors.muted, flexShrink: 0, marginTop: 2,
          transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
              color: colors.green, background: colors.greenDim,
              border: `1px solid rgba(57,255,110,0.2)`, borderRadius: 2,
              padding: '1px 6px' }}>
              {result.domain.toUpperCase()}
            </span>
            <span style={{ ...mono, fontSize: 9, color: colors.muted }}>
              {(result.score * 100).toFixed(0)}% match
            </span>
          </div>
          <div style={{ ...mono, fontSize: 10, color: colors.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {result.sourceTitle ?? result.sourcePath}
          </div>
          {result.breadcrumb && (
            <div style={{ ...mono, fontSize: 9, color: colors.muted, marginTop: 2 }}>
              {result.breadcrumb}
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <div style={{ ...mono, fontSize: 11, color: colors.text, lineHeight: 1.6,
          padding: '0 14px 12px 36px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {result.chunkText.slice(0, 800)}{result.chunkText.length > 800 ? '…' : ''}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function ArchivePanel({ onClose }: { onClose: () => void }) {
  const { status, loading: statusLoading, refresh: refreshStatus } = useArchiveStatus();

  // Tab state — null means "show all" summary view
  const [activeTab, setActiveTab]   = useState<string | null>(null);
  const [view, setView]             = useState<'sources' | 'ingest' | 'search'>('sources');

  // Ingest state
  const [ingestTab, setIngestTab]   = useState<SourceType>('file');
  const [fileInput, setFileInput]   = useState('');
  const [urlInput, setUrlInput]     = useState('');
  const [pasteInput, setPasteInput] = useState('');
  const [ingestDomain, setIngestDomain] = useState('reference');
  const [progress, setProgress]     = useState<IngestProgress | null>(null);
  const [dragging, setDragging]     = useState(false);
  const [pickingFile, setPickingFile] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDomains, setSearchDomains] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);

  // New domain state
  const [newDomainInput, setNewDomainInput] = useState('');
  const [addingDomain, setAddingDomain]     = useState(false);

  const { sources, loading: sourcesLoading, refresh: refreshSources } = useSources(activeTab);

  // Set first domain as active when status loads
  useEffect(() => {
    if (status?.domains.length && activeTab === null) {
      setActiveTab(status.domains[0].domain);
    }
  }, [status, activeTab]);

  // ── Ingest ────────────────────────────────────────────────────────────────

  const runIngest = useCallback(async (input: string, sourceType: SourceType) => {
    if (!input.trim() || progress?.status === 'running') return;
    setProgress({ sourceId: '', current: 0, total: 0, pct: 0, status: 'running' });

    const res = await fetch(`${ENGINE}/api/archive/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: ingestDomain, input: input.trim(), sourceType }),
    });

    if (!res.ok) {
      setProgress({ sourceId: '', current: 0, total: 0, pct: 0, status: 'error' });
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt: IngestProgress = JSON.parse(line.slice(6));
          setProgress(evt);
          if (evt.status === 'done') {
            await refreshStatus();
            await refreshSources();
            setActiveTab(ingestDomain);
          }
        } catch { /* malformed event */ }
      }
    }

    // Flush any remaining buffered data after the stream closes.
    if (buf.startsWith('data: ')) {
      try {
        const evt: IngestProgress = JSON.parse(buf.slice(6));
        setProgress(evt);
        if (evt.status === 'done') {
          await refreshStatus();
          await refreshSources();
          setActiveTab(ingestDomain);
        }
      } catch { /* malformed final event */ }
    }
  }, [progress, ingestDomain, refreshStatus, refreshSources]);

  // Opens the native OS file dialog via the PHOBOS backend — returns an
  // absolute filesystem path, which is what the ingest API expects.
  const openNativeFilePicker = useCallback(async () => {
    if (pickingFile) return;
    setPickingFile(true);
    try {
      const res = await fetch(`${ENGINE}/api/archive/ingest/open-file-dialog`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.path) { setFileInput(data.path); setIngestTab('file'); }
      }
    } catch { /* non-fatal */ }
    finally { setPickingFile(false); }
  }, [pickingFile]);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // DataTransfer.files[0].path is available in Electron/Tauri — not in pure browser.
    // On PHOBOS (desktop app), window.__TAURI__ or window.require signal Electron context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = e.dataTransfer.files[0] as any;
    const nativePath: string | undefined = file?.path;
    if (nativePath) {
      setFileInput(nativePath);
      setIngestTab('file');
    } else {
      // Non-Electron context — fall back to native picker.
      openNativeFilePicker();
    }
  }, [openNativeFilePicker]);

  // ── Search ────────────────────────────────────────────────────────────────

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const domains = searchDomains.length > 0
        ? searchDomains
        : status?.domains.map(d => d.domain) ?? [];
      const params = new URLSearchParams({ q: searchQuery, domains: domains.join(',') });
      const res = await fetch(`${ENGINE}/api/archive/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.results ?? []);
      }
    } catch { /* non-fatal */ }
    finally { setSearching(false); }
  }, [searchQuery, searchDomains, status]);

  // ── Create domain ─────────────────────────────────────────────────────────

  const createDomain = useCallback(async () => {
    const name = newDomainInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!name) return;
    setAddingDomain(true);
    try {
      await fetch(`${ENGINE}/api/archive/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: `custom-${name}` }),
      });
      await refreshStatus();
      setActiveTab(`custom-${name}`);
      setNewDomainInput('');
    } catch { /* non-fatal */ }
    finally { setAddingDomain(false); }
  }, [newDomainInput, refreshStatus]);

  // ── Delete source ─────────────────────────────────────────────────────────

  const deleteSource = useCallback(async (domain: string, sourceId: string) => {
    await fetch(`${ENGINE}/api/archive/sources/${domain}/${sourceId}`, { method: 'DELETE' });
    await refreshStatus();
    await refreshSources();
  }, [refreshStatus, refreshSources]);

  // ── Render ────────────────────────────────────────────────────────────────

  const domains = status?.domains ?? [];

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9500,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div className="phobos-archive-panel" style={{
        width: 860, maxHeight: '88vh',
        background: colors.bg, border: `1px solid ${colors.border}`,
        borderRadius: 6, boxShadow: '0 32px 80px rgba(0,0,0,0.9)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderBottom: `1px solid ${colors.border}`,
          background: `linear-gradient(180deg, ${colors.surfaceHi} 0%, ${colors.bg} 100%)`,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 4,
              background: colors.greenDim, border: `1px solid rgba(57,255,110,0.25)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Database size={14} color={colors.green} />
            </div>
            <div>
              <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: colors.text }}>
                PHOBOS ARCHIVE
              </div>
              <div style={{ ...mono, fontSize: 9, color: colors.muted }}>
                SYBIL Phase 2 · Knowledge Base
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* View toggles */}
            {(['sources', 'ingest', 'search'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
                background: 'none', border: 'none', cursor: 'pointer',
                color: view === v ? colors.green : colors.muted,
                borderBottom: view === v ? `1px solid ${colors.green}` : '1px solid transparent',
                paddingBottom: 2,
              }}>
                {v === 'sources' ? 'LIBRARY' : v === 'ingest' ? 'INGEST' : 'SEARCH'}
              </button>
            ))}
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer',
                color: colors.muted, padding: 4, display: 'flex', marginLeft: 8 }}
              onMouseEnter={e => (e.currentTarget.style.color = colors.text)}
              onMouseLeave={e => (e.currentTarget.style.color = colors.muted)}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Domain tab strip ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          borderBottom: `1px solid ${colors.border}`, background: colors.surface,
          overflowX: 'auto', flexShrink: 0,
        }}>
          {statusLoading ? (
            <div style={{ padding: '8px 14px' }}>
              <Loader2 size={12} color={colors.muted} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          ) : (
            <>
              {domains.map(d => (
                <DomainTab
                  key={d.domain}
                  domain={d.domain}
                  active={activeTab === d.domain}
                  chunkCount={d.chunkCount}
                  onClick={() => setActiveTab(d.domain)}
                />
              ))}
              {/* Add domain inline */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', marginLeft: 4 }}>
                <input
                  value={newDomainInput}
                  onChange={e => setNewDomainInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createDomain()}
                  placeholder="new-domain"
                  style={{
                    ...mono, fontSize: 9, width: 90, padding: '3px 7px',
                    background: colors.surface, border: `1px solid ${colors.border}`,
                    borderRadius: 3, color: colors.text, outline: 'none',
                  }}
                />
                <button onClick={createDomain} disabled={addingDomain || !newDomainInput.trim()}
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: colors.muted, display: 'flex', padding: 2 }}
                  onMouseEnter={e => (e.currentTarget.style.color = colors.green)}
                  onMouseLeave={e => (e.currentTarget.style.color = colors.muted)}
                >
                  <Plus size={13} />
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

          {/* ── LIBRARY view ── */}
          {view === 'sources' && (
            <div>
              {sourcesLoading && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 40, gap: 10 }}>
                  <Loader2 size={14} color={colors.muted} style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ ...mono, fontSize: 11, color: colors.muted }}>Loading sources…</span>
                </div>
              )}
              {!sourcesLoading && sources.length === 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', padding: 60, gap: 14 }}>
                  <FolderOpen size={32} color={colors.muted} style={{ opacity: 0.4 }} />
                  <div style={{ ...mono, fontSize: 11, color: colors.muted, textAlign: 'center' }}>
                    No sources in this domain.<br />
                    Switch to INGEST to add documents.
                  </div>
                  <GhostBtn onClick={() => setView('ingest')}>INGEST DOCUMENTS</GhostBtn>
                </div>
              )}
              {!sourcesLoading && sources.map(s => (
                <SourceRow
                  key={s.id}
                  source={s}
                  onDelete={() => activeTab && deleteSource(activeTab, s.id)}
                />
              ))}
            </div>
          )}

          {/* ── INGEST view ── */}
          {view === 'ingest' && (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* Domain selector */}
              <div>
                <SectionHeader>Target Domain</SectionHeader>
                <select
                  value={ingestDomain}
                  onChange={e => setIngestDomain(e.target.value)}
                  style={{
                    ...mono, fontSize: 11, padding: '6px 10px', borderRadius: 3,
                    background: colors.surface, border: `1px solid ${colors.border}`,
                    color: colors.text, outline: 'none', cursor: 'pointer',
                  }}
                >
                  {domains.map(d => (
                    <option key={d.domain} value={d.domain}>{domainLabel(d.domain)}</option>
                  ))}
                </select>
              </div>

              {/* Source type tabs */}
              <div>
                <SectionHeader>Source Type</SectionHeader>
                <div style={{ display: 'flex', gap: 1, marginBottom: 14 }}>
                  {(['file', 'url', 'paste'] as const).map(t => (
                    <button key={t} onClick={() => setIngestTab(t)} style={{
                      ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                      padding: '5px 14px', cursor: 'pointer', border: 'none',
                      background: ingestTab === t ? colors.green : colors.surfaceHi,
                      color: ingestTab === t ? '#07090b' : colors.muted,
                      borderRadius: t === 'file' ? '3px 0 0 3px' : t === 'paste' ? '0 3px 3px 0' : '0',
                    }}>
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>

                {/* File picker — native OS dialog via PHOBOS backend */}
                {ingestTab === 'file' && (
                  <div>
                    <div
                      onDragOver={e => { e.preventDefault(); setDragging(true); }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={handleFileDrop}
                      style={{
                        border: `2px dashed ${dragging ? colors.green : colors.border}`,
                        borderRadius: 4, padding: '28px 20px', textAlign: 'center',
                        transition: 'border-color 0.15s',
                        background: dragging ? colors.greenGlow : 'transparent',
                      }}
                    >
                      <Upload size={24} color={dragging ? colors.green : colors.muted}
                        style={{ margin: '0 auto 10px' }} />
                      <div style={{ ...mono, fontSize: 11, color: colors.text, marginBottom: 8 }}>
                        Drag & drop a file here
                      </div>
                      <div style={{ ...mono, fontSize: 9, color: colors.muted, marginBottom: 12 }}>
                        .md · .txt · .pdf · .docx · .html · .py · .ts · .js · .json · .csv · .xlsx · .epub
                      </div>
                      <button
                        onClick={openNativeFilePicker}
                        disabled={pickingFile}
                        style={{
                          ...mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                          padding: '6px 16px', borderRadius: 3, cursor: pickingFile ? 'wait' : 'pointer',
                          background: 'transparent', color: colors.green,
                          border: `1px solid rgba(57,255,110,0.4)`,
                        }}
                      >
                        {pickingFile ? 'Opening…' : 'BROWSE FILES'}
                      </button>
                    </div>
                    {fileInput && (
                      <div style={{
                        ...mono, fontSize: 10, color: colors.text,
                        marginTop: 8, padding: '6px 10px',
                        background: colors.surface, border: `1px solid ${colors.border}`,
                        borderRadius: 3, display: 'flex', alignItems: 'center', gap: 8,
                      }}>
                        <FileText size={11} color={colors.muted} style={{ flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {fileInput}
                        </span>
                        <button
                          onClick={() => setFileInput('')}
                          style={{ background: 'none', border: 'none', cursor: 'pointer',
                            color: colors.muted, padding: 0, marginLeft: 'auto', display: 'flex' }}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* URL input */}
                {ingestTab === 'url' && (
                  <input
                    value={urlInput}
                    onChange={e => setUrlInput(e.target.value)}
                    placeholder="https://…"
                    style={{
                      ...mono, fontSize: 11, width: '100%', padding: '8px 12px',
                      background: colors.surface, border: `1px solid ${colors.border}`,
                      borderRadius: 3, color: colors.text, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = colors.green)}
                    onBlur={e => (e.currentTarget.style.borderColor = colors.border)}
                  />
                )}

                {/* Paste textarea */}
                {ingestTab === 'paste' && (
                  <textarea
                    value={pasteInput}
                    onChange={e => setPasteInput(e.target.value)}
                    placeholder="Paste text content here…"
                    rows={8}
                    style={{
                      ...mono, fontSize: 11, width: '100%', padding: '10px 12px',
                      background: colors.surface, border: `1px solid ${colors.border}`,
                      borderRadius: 3, color: colors.text, outline: 'none',
                      resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6,
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = colors.green)}
                    onBlur={e => (e.currentTarget.style.borderColor = colors.border)}
                  />
                )}
              </div>

              {/* Progress */}
              {progress && (
                <div style={{
                  background: colors.surface, border: `1px solid ${colors.border}`,
                  borderRadius: 4, padding: '12px 14px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    {progress.status === 'running' && (
                      <Loader2 size={13} color={colors.amber}
                        style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    )}
                    {progress.status === 'done' && <CheckCircle2 size={13} color={colors.green} />}
                    {progress.status === 'error' && <AlertTriangle size={13} color={colors.red} />}
                    <span style={{ ...mono, fontSize: 10, color: colors.text }}>
                      {progress.status === 'running'
                        ? `Embedding chunk ${progress.current} / ${progress.total}…`
                        : progress.status === 'done'
                        ? `Done — ${progress.total} chunks indexed`
                        : `Error: ${progress.error}`}
                    </span>
                  </div>
                  {progress.status === 'running' && (
                    <div style={{ height: 3, background: colors.border, borderRadius: 2 }}>
                      <div style={{
                        height: 3, borderRadius: 2,
                        width: `${progress.pct}%`, background: colors.amber,
                        transition: 'width 0.3s',
                      }} />
                    </div>
                  )}
                </div>
              )}

              <GreenBtn
                onClick={() => {
                  if (ingestTab === 'file')  runIngest(fileInput, 'file');
                  if (ingestTab === 'url')   runIngest(urlInput, 'url');
                  if (ingestTab === 'paste') runIngest(pasteInput, 'paste');
                }}
                disabled={progress?.status === 'running'}
                style={{ alignSelf: 'flex-start' }}
              >
                INGEST →
              </GreenBtn>
            </div>
          )}

          {/* ── SEARCH view ── */}
          {view === 'search' && (
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Query input */}
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <Search size={13} style={{
                    position: 'absolute', left: 10, top: '50%',
                    transform: 'translateY(-50%)', color: colors.muted, pointerEvents: 'none',
                  }} />
                  <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && runSearch()}
                    placeholder="Search your knowledge base…"
                    style={{
                      ...mono, fontSize: 11, width: '100%', padding: '8px 12px 8px 32px',
                      background: colors.surface, border: `1px solid ${colors.border}`,
                      borderRadius: 3, color: colors.text, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = colors.green)}
                    onBlur={e => (e.currentTarget.style.borderColor = colors.border)}
                  />
                </div>
                <GreenBtn onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                  {searching ? '…' : 'SEARCH'}
                </GreenBtn>
              </div>

              {/* Domain filter */}
              <div>
                <SectionHeader>Filter Domains (none = all)</SectionHeader>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {domains.map(d => {
                    const active = searchDomains.includes(d.domain);
                    return (
                      <button key={d.domain}
                        onClick={() => setSearchDomains(prev =>
                          active ? prev.filter(x => x !== d.domain) : [...prev, d.domain]
                        )}
                        style={{
                          ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                          padding: '3px 10px', borderRadius: 3, cursor: 'pointer',
                          background: active ? colors.greenDim : 'transparent',
                          color: active ? colors.green : colors.muted,
                          border: `1px solid ${active ? 'rgba(57,255,110,0.3)' : colors.border}`,
                        }}
                      >
                        {domainLabel(d.domain)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Results */}
              {searching && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Loader2 size={13} color={colors.muted}
                    style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ ...mono, fontSize: 11, color: colors.muted }}>Searching…</span>
                </div>
              )}
              {!searching && searchResults.length === 0 && searchQuery && (
                <div style={{ ...mono, fontSize: 11, color: colors.muted, padding: '20px 0' }}>
                  No results found.
                </div>
              )}
              <div style={{
                background: colors.surface, border: `1px solid ${colors.border}`,
                borderRadius: 4, overflow: 'hidden',
              }}>
                {searchResults.map(r => <SearchResultRow key={r.id} result={r} />)}
              </div>
            </div>
          )}
        </div>

        {/* ── Status footer ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 18px', borderTop: `1px solid ${colors.border}`,
          background: colors.surface, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: status?.sybilOnline ? colors.green : colors.red,
                boxShadow: status?.sybilOnline ? `0 0 6px ${colors.green}` : 'none',
              }} />
              <span style={{ ...mono, fontSize: 9, color: colors.muted }}>
                SYBIL {status?.sybilOnline ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
            <span style={{ ...mono, fontSize: 9, color: colors.muted }}>
              {status?.totalChunks.toLocaleString() ?? '—'} chunks · {status?.domains.length ?? 0} domains
            </span>
          </div>
          {!status?.sybilOnline && (
            <span style={{ ...mono, fontSize: 9, color: colors.red }}>
              ⚠ Archive search unavailable — SYBIL embedding server offline
            </span>
          )}
        </div>

      </div>

      {/* CSS keyframes for spinner */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
