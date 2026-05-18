/**
 * MediaHubPanel.tsx — PHOBOS Media Hub
 * Shows all four media services. Setup flows for Polaris and Kavita.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { X, Music2, Film, BookOpen, Camera, ChevronRight, Loader2,
         Power, PowerOff, Trash2, FolderOpen, Plus, Images,
         MoveRight, RefreshCw, FileText, CheckCircle2, ScanLine } from 'lucide-react';

const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types ─────────────────────────────────────────────────────────────────────

type ServiceName  = 'polaris' | 'jellyfin' | 'kavita' | 'meridian';
type ServiceState = 'stopped' | 'starting' | 'running' | 'error';

interface ServiceStatus {
  name:          ServiceName;
  state:         ServiceState;
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  libraryPath:   string | null;
  settings:      Record<string, unknown>;
  enabled:       boolean;
}

interface AllServicesStatus {
  polaris:  ServiceStatus;
  jellyfin: ServiceStatus;
  kavita:   ServiceStatus;
  meridian: ServiceStatus;
}

// Kavita library from GET /api/kavita/libraries
interface KavitaLibrary {
  id:      number;
  name:    string;
  type:    number;          // 1=manga 2=comics 3=books 4=images 5=lightnovels
  folders: string[];
  series:  number;
  seriesCount: number;
}

// Item returned from the SSE classify stream
interface IngestQueueItem {
  sourcePath:    string;
  filename:      string;
  suggestion:    KavitaLibType | 'phobosdocs';
  reason:        string;
  llmClassified: boolean;
  sample:        string;
}

type KavitaLibType = 'manga' | 'comics' | 'books' | 'lightnovels';
type IngestDest = KavitaLibType | 'phobosdocs';

const LIB_TYPE_LABELS: Record<KavitaLibType, string> = {
  manga:       'Manga',
  comics:      'Comics',
  books:       'Books',
  lightnovels: 'Light Novels',
};

const INGEST_DEST_LABELS: Record<IngestDest, string> = {
  manga:       'Manga',
  comics:      'Comics',
  books:       'Books',
  lightnovels: 'Light Novels',
  phobosdocs:  'phobosDocs',
};

const LIB_TYPE_CODES: Record<KavitaLibType, number> = {
  manga: 0, comics: 1, books: 3, lightnovels: 5,
};

// ── Service metadata ──────────────────────────────────────────────────────────

const SERVICE_META: Record<ServiceName, {
  label:       string;
  description: string;
  icon:        React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  accent:      string;
  implemented: boolean;
}> = {
  polaris: {
    label:       'Polaris Music',
    description: 'Self-hosted music streaming. FLAC, MP3, OGG and more.',
    icon:        Music2,
    accent:      '#f59e0b',
    implemented: true,
  },
  jellyfin: {
    label:       'Jellyfin',
    description: 'Video, TV and movie library server.',
    icon:        Film,
    accent:      '#3b82f6',
    implemented: true,
  },
  kavita: {
    label:       'Kavita',
    description: 'Comics, manga and ebook server.',
    icon:        BookOpen,
    accent:      '#8b5cf6',
    implemented: true,
  },
  meridian: {
    label:       'Meridian',
    description: 'Native photo library. Directory-first, zero cloud.',
    icon:        Camera,
    accent:      '#10b981',
    implemented: true,
  },
};

const SERVICE_ORDER: ServiceName[] = ['polaris', 'jellyfin', 'kavita', 'meridian'];

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useAllServices() {
  const [data, setData]       = useState<AllServicesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch(`${ENGINE}/api/services/all`);
      if (r.ok) setData(await r.json());
    } catch { /* offline */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch_();
    pollRef.current = setInterval(fetch_, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetch_]);

  return { data, loading, refresh: fetch_ };
}

// ── Shared style tokens ───────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: '"JetBrains Mono", monospace' };

const colors = {
  bg:        'hsl(var(--background))',
  surface:   'hsl(var(--card))',
  surfaceHi: 'hsl(var(--secondary))',
  border:    'hsl(var(--border))',
  borderLo:  'hsl(var(--secondary))',
  text:      '#4ade80',   // phobos green — primary labels
  muted:     '#e2e8f0',   // bright white — secondary labels (was invisible grey)
  dim:       '#94a3b8',   // visible slate — path text (was near-black)
  purple:    '#8b5cf6',
  green:     '#10b981',
  amber:     '#f59e0b',
  red:       '#ef4444',
};

function Btn({ onClick, disabled, children, style }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...mono, fontSize: 20, fontWeight: 600, letterSpacing: '.06em',
      padding: '10px 24px', borderRadius: 6, border: `1px solid ${colors.border}`,
      background: colors.surfaceHi, color: disabled ? colors.muted : colors.text,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .5 : 1,
      ...style,
    }}>{children}</button>
  );
}

function Input({ value, onChange, placeholder, style }: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; style?: React.CSSProperties;
}) {
  return (
    <input value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...mono, fontSize: 18, width: '100%', padding: '20px 28px',
        background: colors.surface, border: `1px solid ${colors.border}`,
        borderRadius: 6, color: colors.text, outline: 'none', boxSizing: 'border-box',
        ...style,
      }} />
  );
}

// ── PolarisPanel ─────────────────────────────────────────────────────────────

const POLARIS_AMBER = '#f59e0b';

type PolarisView = 'libraries' | 'add-library' | 'ingest';

function PolarisPanel({ status, onClose, onRefresh }: {
  status: ServiceStatus;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isRunning  = status.state === 'running';
  const isStarting = status.state === 'starting';
  const [view, setView]     = useState<PolarisView>('libraries');
  const [scanning, setScanning] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pickerBusy, setPickerBusy]     = useState(false);
  const [dropActive, setDropActive]     = useState(false);
  const [ingestNote, setIngestNote]     = useState('');

  // ── Add library (config only — Polaris has one path, set via config) ──────
  const libraryFolder = status.libraryPath ?? '';
  const mountName     = (status.settings?.mountName as string) ?? 'Music';

  const [newLibFolder, setNewLibFolder]   = useState('');
  const [newMountName, setNewMountName]   = useState('');
  const [newMoveContent, setNewMoveContent] = useState(false);
  const [addLibErr, setAddLibErr]         = useState('');
  const [addLibBusy, setAddLibBusy]       = useState(false);

  const saveLibrary = async () => {
    if (!newLibFolder.trim()) { setAddLibErr('Folder path is required.'); return; }
    setAddLibErr(''); setAddLibBusy(true);
    try {
      await fetch(`${ENGINE}/api/services/polaris/config`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          libraryPath: newLibFolder.trim(),
          settings: { mountName: newMountName.trim() || 'Music' },
        }),
      });
      onRefresh();
      setNewLibFolder(''); setNewMountName('');
      setView('libraries');
    } catch (e) { setAddLibErr((e as Error).message); }
    setAddLibBusy(false);
  };

  const triggerScan = async () => {
    setScanning(true);
    try { await fetch(`${ENGINE}/api/services/polaris/scan`, { method: 'POST' }); } catch { /* ignore */ }
    setScanning(false);
  };

  const openFolder = async (folderPath: string) => {
    await fetch(`${ENGINE}/api/services/polaris/open-folder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
  };

  const openFilePicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-file-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'any' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) setPendingPaths(prev => Array.from(new Set([...prev, d.path!.trim()])));
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const openFolderPicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select music folder' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) {
        const r2 = await fetch(`${ENGINE}/api/polaris/ingest/scan-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: d.path.trim() }),
        });
        const d2 = await r2.json() as { files?: string[] };
        if (d2.files) setPendingPaths(prev => Array.from(new Set([...prev, ...d2.files!])));
      }
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const commitIngest = async () => {
    if (pendingPaths.length === 0) return;
    setIngestNote('Copying files to phobosMusic…');
    try {
      const r = await fetch(`${ENGINE}/api/polaris/ingest/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: pendingPaths, targetFolder: status.libraryPath }),
      });
      const d = await r.json() as { ok?: boolean; copied?: number; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'Commit failed');
      setIngestNote(`Done — ${d.copied ?? pendingPaths.length} file(s) copied. Polaris scanning.`);
      setPendingPaths([]);
    } catch (e) { setIngestNote(`Error: ${(e as Error).message}`); }
  };

  const panelHeader = (title: string, subtitle: string, back?: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '20px 28px', borderBottom: `1px solid ${colors.border}`,
      background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Music2 size={24} style={{ color: POLARIS_AMBER }} />
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: colors.text }}>{title}</span>
          {subtitle && <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 1 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {back && <button onClick={back} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16, padding: '3px 6px' }}>← BACK</button>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4 }}><X size={24} /></button>
      </div>
    </div>
  );

  if (view === 'add-library') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 920, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Move: phobosMusic', 'Change library folder location', () => setView('libraries'))}
          <div style={{ padding: 28 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>CURRENT LOCATION</label>
            <div style={{ ...mono, fontSize: 18, color: colors.dim, padding: '12px 16px',
              background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 6, marginBottom: 20 }}>
              {libraryFolder || '(no path configured)'}
            </div>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>NEW LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><Input value={newLibFolder} onChange={setNewLibFolder} placeholder="C:\Users\you\.phobos\media\polaris\phobosMusic" /></div>
              <button onClick={async () => { try { const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select new library location', initialPath: libraryFolder }) }); const d = await r.json(); if (d.path) setNewLibFolder(d.path); } catch { /* ignore */ } }} title="Browse for folder" style={{ background: colors.surfaceHi, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: colors.muted, padding: '0 14px', display: 'flex', alignItems: 'center' }}><FolderOpen size={22} /></button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, cursor: 'pointer' }}>
              <input type="checkbox" checked={newMoveContent} onChange={e => setNewMoveContent(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: POLARIS_AMBER }} />
              <span style={{ ...mono, fontSize: 18, color: colors.text }}>Move existing content to new location</span>
            </label>
            <div style={{ ...mono, fontSize: 16, color: colors.dim, marginTop: 6, marginLeft: 26 }}>
              Files will be copied to the new folder, originals removed. Only top-level files are moved.
            </div>
            {addLibErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 12 }}>{addLibErr}</div>}
            <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
              <Btn onClick={saveLibrary} disabled={addLibBusy}
                style={{ background: POLARIS_AMBER + '18', borderColor: POLARIS_AMBER + '40', color: POLARIS_AMBER }}>
                {addLibBusy
                  ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 6 }} />Moving…</>
                  : <><MoveRight size={18} style={{ display: 'inline', marginRight: 6 }} />Move Library</>}
              </Btn>
              <Btn onClick={() => setView('libraries')}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'ingest') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 1000, maxHeight: '80vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Ingest Music', 'Copy audio files into phobosMusic', () => { setView('libraries'); setPendingPaths([]); setIngestNote(''); })}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 12 }}>
              Files are copied into phobosMusic and Polaris rescans automatically.
            </div>
            <div
              onDragOver={e => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={async e => {
                e.preventDefault(); setDropActive(false);
                const paths: string[] = [];
                for (const file of Array.from(e.dataTransfer.files)) {
                  const p = (file as any).path as string | undefined;
                  if (p) paths.push(p);
                }
                setPendingPaths(prev => Array.from(new Set([...prev, ...paths])));
              }}
              style={{ border: `2px dashed ${dropActive ? POLARIS_AMBER : colors.border}`, borderRadius: 6, padding: '32px 28px', textAlign: 'center', background: dropActive ? POLARIS_AMBER + '0c' : colors.surface, transition: 'border-color .15s, background .15s', marginBottom: 12 }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted, marginBottom: 10 }}>Drop audio files or folders here</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <Btn onClick={openFilePicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FileText size={18} style={{ display: 'inline' }} /> Add File</Btn>
                <Btn onClick={openFolderPicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FolderOpen size={18} style={{ display: 'inline' }} /> Add Folder</Btn>
              </div>
            </div>
            {pendingPaths.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 6 }}>{pendingPaths.length} FILE{pendingPaths.length !== 1 ? 'S' : ''} QUEUED</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                  {pendingPaths.map((p, i) => (
                    <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: colors.surface, border: `1px solid ${colors.borderLo}`, borderRadius: 4 }}>
                      <Music2 size={28} style={{ color: colors.muted, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ ...mono, fontSize: 18, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.split(/[\/]/).pop()}</div>
                        <div style={{ ...mono, fontSize: 14, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>
                      </div>
                      <button onClick={() => setPendingPaths(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 2, lineHeight: 1 }}><X size={18} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {ingestNote && <div style={{ ...mono, fontSize: 18, color: ingestNote.startsWith('Error') ? colors.red : colors.green, marginBottom: 8 }}>{ingestNote}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={commitIngest} disabled={pendingPaths.length === 0} style={{ background: POLARIS_AMBER + '18', borderColor: POLARIS_AMBER + '40', color: POLARIS_AMBER }}>
                Copy {pendingPaths.length > 0 ? `${pendingPaths.length} ` : ''}file{pendingPaths.length !== 1 ? 's' : ''} to phobosMusic
              </Btn>
              {pendingPaths.length > 0 && <button onClick={() => setPendingPaths([])} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16 }}>Clear all</button>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Libraries view (default) ───────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 960, maxHeight: '80vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        {panelHeader('Polaris Music', isRunning ? `Running · port ${status.port}` : status.state.toUpperCase())}
        <div style={{ padding: '14px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? colors.green : isStarting ? colors.amber : colors.dim, boxShadow: isRunning ? `0 0 5px ${colors.green}` : 'none' }} />
            <span style={{ ...mono, fontSize: 16, color: isRunning ? colors.green : colors.muted, letterSpacing: '.08em' }}>
              {isRunning ? 'RUNNING' : isStarting ? 'STARTING' : status.state.toUpperCase()}
            </span>
          </div>
          {status.error && <span style={{ ...mono, fontSize: 16, color: colors.red }}>{status.error}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {isRunning && (
              <>
                <Btn onClick={() => setView('ingest')} style={{ background: POLARIS_AMBER + '18', borderColor: POLARIS_AMBER + '40', color: POLARIS_AMBER }}>
                  <FileText size={18} style={{ display: 'inline', marginRight: 4 }} />Ingest
                </Btn>

                <Btn onClick={triggerScan} disabled={scanning}>
                  <RefreshCw size={18} style={{ display: 'inline', marginRight: 4, animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
                  {scanning ? 'Scanning…' : 'Scan'}
                </Btn>
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!isRunning && !isStarting && (
            <div style={{ padding: '32px 28px' }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted }}>Polaris is not running. Check the binary or server logs.</div>
            </div>
          )}
          {(isRunning || isStarting) && (
            <div style={{ padding: '20px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ ...mono, fontSize: 20, fontWeight: 600, color: colors.text }}>{mountName}</span>
                  <span style={{ ...mono, fontSize: 14, color: POLARIS_AMBER, background: POLARIS_AMBER + '15', border: `1px solid ${POLARIS_AMBER + '30'}`, borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>PHOBOS DEFAULT</span>
                  <span style={{ ...mono, fontSize: 16, color: colors.muted }}>Music</span>
                </div>
                <div style={{ ...mono, fontSize: 16, color: colors.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{libraryFolder || '(no path configured)'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                {libraryFolder && (
                  <button onClick={() => openFolder(libraryFolder)} title="Open in file explorer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}>
                    <FolderOpen size={22} />
                  </button>
                )}
                <button onClick={() => { setNewLibFolder(libraryFolder); setNewMountName(mountName); setView('add-library'); }} title="Move library folder" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}>
                  <MoveRight size={22} />
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '14px 28px', borderTop: `1px solid ${colors.borderLo}` }}>
          <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.08em' }}>
            POLARIS · PORT {status.port} · phobosMusic IS DEFAULT LOCAL STORAGE
          </span>
        </div>
      </div>
    </div>
  );
}

// ── KavitaPanel ───────────────────────────────────────────────────────────────

type KavitaView = 'libraries' | 'ingest' | 'add-library' | 'move-library';

interface MoveTarget { lib: KavitaLibrary; newPath: string; moveContent: boolean; }
interface ClassifyProgress { index: number; total: number; pct: number; item: IngestQueueItem; }

function KavitaPanel({ status, onClose, onRefresh }: {
  status: ServiceStatus;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isRunning      = status.state === 'running';
  const isStarting     = status.state === 'starting';

  // ── View state ────────────────────────────────────────────────────────────
  const [view, setView]       = useState<KavitaView>('libraries');
  // ── Libraries ─────────────────────────────────────────────────────────────
  const [libraries, setLibraries] = useState<KavitaLibrary[]>([]);
  const [libsLoading, setLibsLoading] = useState(false);

  const loadLibraries = useCallback(async () => {
    if (!isRunning) return;
    setLibsLoading(true);
    try {
      const r = await fetch(`${ENGINE}/api/kavita/libraries`);
      if (r.ok) { const d = await r.json(); setLibraries(d.libraries ?? []); }
    } catch { /* ignore */ }
    setLibsLoading(false);
  }, [isRunning]);

  useEffect(() => { if (view === 'libraries') loadLibraries(); }, [view, loadLibraries]);

  // ── Fetch binary ──────────────────────────────────────────────────────────
  // ── Scan ──────────────────────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const triggerScan = async () => {
    setScanning(true);
    try { await fetch(`${ENGINE}/api/kavita/scan`, { method: 'POST' }); } catch { /* ignore */ }
    setScanning(false);
  };

  // ── Open folder ───────────────────────────────────────────────────────────
  const openFolder = async (folderPath: string) => {
    await fetch(`${ENGINE}/api/kavita/open-folder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
  };

  // ── Add library ───────────────────────────────────────────────────────────
  const [newLibName, setNewLibName]     = useState('');
  const [newLibType, setNewLibType]     = useState<KavitaLibType>('books');
  const [newLibFolder, setNewLibFolder] = useState('');
  const [addLibErr, setAddLibErr]       = useState('');
  const [addLibBusy, setAddLibBusy]     = useState(false);

  const addLibrary = async () => {
    if (!newLibName.trim() || !newLibFolder.trim()) { setAddLibErr('Name and folder are required.'); return; }
    setAddLibErr(''); setAddLibBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/kavita/libraries`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newLibName.trim(), type: LIB_TYPE_CODES[newLibType], folders: [newLibFolder.trim()] }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? 'Failed'); }
      setNewLibName(''); setNewLibFolder('');
      setView('libraries');
    } catch (e) { setAddLibErr((e as Error).message); }
    setAddLibBusy(false);
  };

  // ── Move library ──────────────────────────────────────────────────────────
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [moveBusy, setMoveBusy]     = useState(false);
  const [moveErr, setMoveErr]       = useState('');

  const startMove = (lib: KavitaLibrary) => {
    setMoveTarget({ lib, newPath: lib.folders[0] ?? '', moveContent: false });
    setMoveErr('');
    setView('move-library');
  };

  const commitMove = async () => {
    if (!moveTarget || !moveTarget.newPath.trim()) { setMoveErr('New folder path is required.'); return; }
    setMoveBusy(true); setMoveErr('');
    try {
      const r = await fetch(`${ENGINE}/api/kavita/libraries/${moveTarget.lib.id}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newFolder:   moveTarget.newPath.trim(),
          moveContent: moveTarget.moveContent,
          name:        moveTarget.lib.name,
          type:        moveTarget.lib.type,
        }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as { error?: string }).error ?? 'Move failed'); }
      setMoveTarget(null);
      setView('libraries');
    } catch (e) { setMoveErr((e as Error).message); }
    setMoveBusy(false);
  };

  // ── Ingest: file selection ────────────────────────────────────────────────
  const [pendingPaths, setPendingPaths]     = useState<string[]>([]);
  const [dropActive, setDropActive]         = useState(false);
  const [pickerBusy, setPickerBusy]         = useState(false);

  const addPaths = (incoming: string[]) => {
    setPendingPaths(prev => {
      const set = new Set(prev);
      for (const p of incoming) if (p) set.add(p);
      return Array.from(set);
    });
  };

  const openFilePicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-file-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'any' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) addPaths([d.path.trim()]);
    } catch { /* user cancelled or unavailable */ }
    setPickerBusy(false);
  };

  const openFolderPicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select books folder' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) {
        const r2 = await fetch(`${ENGINE}/api/kavita/ingest/scan-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: d.path.trim() }),
        });
        const d2 = await r2.json() as { files?: string[] };
        if (d2.files) addPaths(d2.files);
      }
    } catch { /* user cancelled or unavailable */ }
    setPickerBusy(false);
  };

  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    setClassifyErr('');

    const incoming: string[]    = [];
    const folderPaths: string[] = [];
    let missingPath = false;

    for (const file of Array.from(e.dataTransfer.files)) {
      const native = (file as any).path as string | undefined;
      if (!native) { missingPath = true; continue; }

      // Directories have no file extension in the native path.
      const lastDot = native.lastIndexOf('.');
      const lastSep = Math.max(native.lastIndexOf('/'), native.lastIndexOf('\\'));
      const hasExt  = lastDot > lastSep;

      if (hasExt) {
        incoming.push(native);
      } else {
        folderPaths.push(native);
      }
    }

    if (missingPath && incoming.length === 0 && folderPaths.length === 0) {
      setClassifyErr('Drag-and-drop paths are unavailable in browser mode — use Add File or Add Folder.');
      return;
    }

    addPaths(incoming);

    for (const fp of folderPaths) {
      try {
        const r = await fetch(`${ENGINE}/api/kavita/ingest/scan-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: fp }),
        });
        const d = await r.json() as { files?: string[] };
        if (d.files && d.files.length === 0) setClassifyErr('No files found in that folder.');
        if (d.files) addPaths(d.files);
      } catch { /* ignore */ }
    }
  };

  // ── Ingest: classify phase ────────────────────────────────────────────────
  const [classifyProgress, setClassifyProg] = useState<ClassifyProgress | null>(null);
  const [queue, setQueue]                   = useState<IngestQueueItem[]>([]);
  const [queueEdits, setQueueEdits]         = useState<Record<number, IngestDest>>({});
  const [classifyDone, setClassifyDone]     = useState(false);
  const [classifyErr, setClassifyErr]       = useState('');

  // Folder → destination mapping for commit
  const [libFolders, setLibFolders] = useState<Record<IngestDest, string>>({
    manga: '', comics: '', books: status.libraryPath ?? '', lightnovels: '', phobosdocs: status.libraryPath ?? '',
  });

  // Populate libFolders from loaded libraries when entering ingest view
  useEffect(() => {
    if (view !== 'ingest' || libraries.length === 0) return;
    const mapping: Record<IngestDest, string> = { manga: '', comics: '', books: '', lightnovels: '', phobosdocs: '' };
    for (const lib of libraries) {
      const folder = lib.folders[0] ?? '';
      if (lib.type === 0) mapping.manga       = folder;
      if (lib.type === 1) mapping.comics      = folder;
      if (lib.type === 3) mapping.books       = folder;
      if (lib.type === 5) mapping.lightnovels = folder;
      // phobosDocs library is type=3 named 'phobosDocs' — capture its folder directly
      if (lib.name === 'phobosDocs') mapping.phobosdocs = folder;
    }
    // Fallback: status.libraryPath is the phobosDocs path
    if (!mapping.phobosdocs) mapping.phobosdocs = status.libraryPath ?? '';
    if (!mapping.books)      mapping.books      = status.libraryPath ?? '';
    setLibFolders(mapping);
  }, [view, libraries, status.libraryPath]);

  const runClassify = async () => {
    if (pendingPaths.length === 0) { setClassifyErr('Add at least one file.'); return; }
    setClassifyErr('');
    setClassifyDone(false);
    setQueue([]);
    setQueueEdits({});
    setClassifyProg({ index: 0, total: pendingPaths.length, pct: 0, item: null! });

    const res = await fetch(`${ENGINE}/api/kavita/ingest/classify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: pendingPaths }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Server error ${res.status}` })) as { error?: string };
      setClassifyErr(err.error ?? `Server error ${res.status}`);
      setClassifyProg(null);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) { setClassifyErr('No response stream.'); setClassifyProg(null); return; }

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
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'classify_progress') {
            setClassifyProg({ index: evt.index, total: evt.total, pct: evt.pct, item: evt.item });
          } else if (evt.type === 'classify_done') {
            setQueue(evt.queue ?? []);
            setClassifyDone(true);
            setClassifyProg(null);
          } else if (evt.type === 'classify_error') {
            setClassifyErr(evt.error ?? 'Classification failed.');
            setClassifyProg(null);
          }
        } catch { /* malformed */ }
      }
    }

    // Flush any remaining buffer after stream closes — classify_done can arrive
    // in the same TCP segment as the connection close and end up in buf.
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'classify_done') {
          setQueue(evt.queue ?? []);
          setClassifyDone(true);
          setClassifyProg(null);
        } else if (evt.type === 'classify_error') {
          setClassifyErr(evt.error ?? 'Classification failed.');
          setClassifyProg(null);
        }
      } catch { /* malformed */ }
    }
  };

  // ── Ingest: commit phase ──────────────────────────────────────────────────
  const [commitBusy, setCommitBusy]   = useState(false);
  const [commitResult, setCommitResult] = useState<Array<{ source: string; dest: string; ok: boolean; error?: string }> | null>(null);
  const [commitErr, setCommitErr]     = useState('');

  const commitIngest = async () => {
    setCommitBusy(true); setCommitErr(''); setCommitResult(null);
    const items = queue.map((item, i) => ({
      sourcePath: item.sourcePath,
      suggestion: queueEdits[i] ?? item.suggestion,
    }));
    try {
      const r = await fetch(`${ENGINE}/api/kavita/ingest/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, libraryFolders: libFolders }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d as { error?: string }).error ?? 'Commit failed');
      setCommitResult(d.results ?? []);
      loadLibraries();
    } catch (e) { setCommitErr((e as Error).message); }
    setCommitBusy(false);
  };

  // ── Shared panel shell ────────────────────────────────────────────────────
  const panelHeader = (title: string, subtitle: string, back?: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '20px 28px', borderBottom: `1px solid ${colors.border}`,
      background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BookOpen size={24} style={{ color: colors.purple }} />
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: colors.text }}>{title}</span>
          {subtitle && <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 1 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {back && (
          <button onClick={back} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer',
            color: colors.muted, fontSize: 16, padding: '3px 6px' }}>← BACK</button>
        )}
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer',
          color: colors.muted, padding: 4 }}><X size={24} /></button>
      </div>
    </div>
  );


  // ── Move library view ─────────────────────────────────────────────────────
  if (view === 'move-library' && moveTarget) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 920, background: colors.bg, border: `1px solid ${colors.border}`,
          borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}>
          {panelHeader(`Move: ${moveTarget.lib.name}`, 'Change library folder location', () => setView('libraries'))}
          <div style={{ padding: 16 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>CURRENT LOCATION</label>
            <div style={{ ...mono, fontSize: 18, color: colors.dim, padding: '6px 9px',
              background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 4, marginBottom: 12 }}>
              {moveTarget.lib.folders[0] ?? '—'}
            </div>

            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>NEW LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><Input value={moveTarget.newPath}
                onChange={v => setMoveTarget(t => t ? { ...t, newPath: v } : null)}
                placeholder="/new/path/to/library" /></div>
              <button onClick={async () => { try { const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select new library location', initialPath: moveTarget?.lib.folders[0] ?? '' }) }); const d = await r.json(); if (d.path) setMoveTarget(t => t ? { ...t, newPath: d.path } : null); } catch { /* ignore */ } }} title="Browse for folder" style={{ background: colors.surfaceHi, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: colors.muted, padding: '0 14px', display: 'flex', alignItems: 'center' }}><FolderOpen size={22} /></button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={moveTarget.moveContent}
                onChange={e => setMoveTarget(t => t ? { ...t, moveContent: e.target.checked } : null)} />
              <span style={{ ...mono, fontSize: 18, color: colors.text }}>Move existing content to new location</span>
            </label>
            <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 4, marginLeft: 20 }}>
              Files will be copied to the new folder, originals removed. Only top-level files are moved.
            </div>

            {moveErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 10 }}>{moveErr}</div>}

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Btn onClick={commitMove} disabled={moveBusy}
                style={{ background: colors.purple + '18', borderColor: colors.purple + '40', color: colors.purple }}>
                {moveBusy
                  ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 4 }} />Moving…</>
                  : <><MoveRight size={18} style={{ display: 'inline', marginRight: 4 }} />Move Library</>}
              </Btn>
              <Btn onClick={() => { setMoveTarget(null); setView('libraries'); }}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Add library view ──────────────────────────────────────────────────────
  if (view === 'add-library') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 840, background: colors.bg, border: `1px solid ${colors.border}`,
          borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}>
          {panelHeader('Add Library', 'Create a new Kavita library', () => setView('libraries'))}
          <div style={{ padding: 16 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>LIBRARY NAME</label>
            <Input value={newLibName} onChange={setNewLibName} placeholder="My Manga" />

            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginTop: 10, marginBottom: 4 }}>TYPE</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(Object.keys(LIB_TYPE_LABELS) as KavitaLibType[]).map(t => (
                <button key={t} onClick={() => setNewLibType(t)} style={{
                  ...mono, fontSize: 16, padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${newLibType === t ? colors.purple + '80' : colors.border}`,
                  background: newLibType === t ? colors.purple + '18' : colors.surface,
                  color: newLibType === t ? colors.purple : colors.muted,
                }}>{LIB_TYPE_LABELS[t]}</button>
              ))}
            </div>

            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginTop: 10, marginBottom: 4 }}>FOLDER PATH</label>
            <Input value={newLibFolder} onChange={setNewLibFolder} placeholder="/path/to/library" />

            {addLibErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 8 }}>{addLibErr}</div>}

            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <Btn onClick={addLibrary} disabled={addLibBusy || !isRunning}
                style={{ background: colors.purple + '18', borderColor: colors.purple + '40', color: colors.purple }}>
                {addLibBusy ? 'Creating…' : 'Create Library'}
              </Btn>
              <Btn onClick={() => setView('libraries')}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Ingest view ───────────────────────────────────────────────────────────
  if (view === 'ingest') {
    const classifying   = classifyProgress !== null && !classifyDone;
    const reviewReady   = classifyDone && queue.length > 0 && !commitResult;
    const committed     = commitResult !== null;

    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500,
        background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 1080, maxHeight: '85vh', background: colors.bg,
          border: `1px solid ${colors.border}`, borderRadius: 6,
          boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          onClick={e => e.stopPropagation()}>
          {panelHeader('Ingest Documents', 'SYBIL classifies, you confirm', () => {
            setView('libraries');
            setClassifyDone(false); setQueue([]); setQueueEdits({});
            setClassifyProg(null); setCommitResult(null); setPendingPaths([]);
          })}

          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>

            {/* ── Step 1: file selection ───────────────────────────────── */}
            {!classifyDone && !classifying && (
              <>
                {/* Drop zone */}
                <div
                  onDragOver={e => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={onDropFiles}
                  style={{
                    border: `2px dashed ${dropActive ? colors.purple : colors.border}`,
                    borderRadius: 6, padding: '32px 28px', textAlign: 'center',
                    background: dropActive ? colors.purple + '0c' : colors.surface,
                    transition: 'border-color .15s, background .15s', marginBottom: 12,
                  }}>
                  <div style={{ ...mono, fontSize: 18, color: colors.muted, marginBottom: 10 }}>
                    Drop files or folders here
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <Btn onClick={openFilePicker} disabled={pickerBusy}
                      style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <FileText size={18} style={{ display: 'inline' }} /> Add File
                    </Btn>
                    <Btn onClick={openFolderPicker} disabled={pickerBusy}
                      style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <FolderOpen size={18} style={{ display: 'inline' }} /> Add Folder
                    </Btn>
                  </div>
                </div>

                {/* Pending list */}
                {pendingPaths.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 6 }}>
                      {pendingPaths.length} FILE{pendingPaths.length !== 1 ? 'S' : ''} QUEUED
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                      {pendingPaths.map((p, i) => (
                        <div key={p} style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
                          background: colors.surface, border: `1px solid ${colors.borderLo}`,
                          borderRadius: 4,
                        }}>
                          <FileText size={28} style={{ color: colors.muted, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...mono, fontSize: 18, color: colors.text,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p.split(/[\\/]/).pop()}
                            </div>
                            <div style={{ ...mono, fontSize: 14, color: colors.muted,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {p}
                            </div>
                          </div>
                          <button onClick={() => setPendingPaths(prev => prev.filter((_, j) => j !== i))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer',
                              color: colors.muted, padding: 2, flexShrink: 0, lineHeight: 1 }}>
                            <X size={18} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {classifyErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginBottom: 8 }}>{classifyErr}</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Btn onClick={runClassify} disabled={pendingPaths.length === 0}
                    style={{ background: colors.purple + '18', borderColor: colors.purple + '40', color: colors.purple }}>
                    Classify {pendingPaths.length > 0 ? `${pendingPaths.length} ` : ''}File{pendingPaths.length !== 1 ? 's' : ''}
                  </Btn>
                  {pendingPaths.length > 0 && (
                    <button onClick={() => setPendingPaths([])}
                      style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer',
                        color: colors.muted, fontSize: 16 }}>
                      Clear all
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── Step 2: classifying progress ─────────────────────────── */}
            {classifying && classifyProgress && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                  <Loader2 size={22} style={{ color: colors.purple, animation: 'spin 1s linear infinite' }} />
                  <span style={{ ...mono, fontSize: 18, color: colors.purple }}>
                    Classifying {classifyProgress.index + 1} / {classifyProgress.total}…
                  </span>
                </div>
                <div style={{ background: colors.surfaceHi, borderRadius: 3, height: 3, marginBottom: 12 }}>
                  <div style={{ background: colors.purple, height: 3, borderRadius: 3,
                    width: `${classifyProgress.pct}%`, transition: 'width .2s' }} />
                </div>
                {classifyProgress.item && (
                  <div style={{ ...mono, fontSize: 16, color: colors.muted }}>
                    {classifyProgress.item.filename}
                    <span style={{ color: classifyProgress.item.llmClassified ? colors.green : colors.amber, marginLeft: 8 }}>
                      → {INGEST_DEST_LABELS[classifyProgress.item.suggestion as IngestDest] ?? classifyProgress.item.suggestion}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── Step 3: review queue ─────────────────────────────────── */}
            {reviewReady && (
              <>
                <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 10 }}>
                  REVIEW — switch any category before committing. Files will be copied (originals untouched).
                </div>

                {/* Library folder targets */}
                <div style={{ marginBottom: 14, padding: 10, background: colors.surface,
                  border: `1px solid ${colors.border}`, borderRadius: 4 }}>
                  <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 8 }}>DESTINATION FOLDERS</div>
                  {(Object.keys(INGEST_DEST_LABELS) as IngestDest[]).map(t => (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ ...mono, fontSize: 16, color: t === 'phobosdocs' ? colors.green : colors.muted, width: 88, flexShrink: 0 }}>
                        {INGEST_DEST_LABELS[t]}
                      </span>
                      <Input value={libFolders[t]} onChange={v => setLibFolders(prev => ({ ...prev, [t]: v }))}
                        placeholder={t === 'phobosdocs' ? 'auto (defaultDocsPath)' : `/path/to/${t}`} style={{ fontSize: 16 }} />
                    </div>
                  ))}
                </div>

                {/* Queue items */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {queue.map((item, i) => {
                    const current = queueEdits[i] ?? item.suggestion as IngestDest;
                    return (
                      <div key={i} style={{ padding: 10, background: colors.surface,
                        border: `1px solid ${colors.border}`, borderRadius: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                          <FileText size={20} style={{ color: colors.muted, flexShrink: 0, marginTop: 1 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...mono, fontSize: 18, color: colors.text, wordBreak: 'break-all' }}>
                              {item.filename}
                            </div>
                            <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 2 }}>
                              {item.reason}
                              {item.llmClassified
                                ? <span style={{ color: colors.green, marginLeft: 6 }}>✦ LLM</span>
                                : <span style={{ color: colors.amber, marginLeft: 6 }}>~ heuristic</span>}
                            </div>
                          </div>
                        </div>
                        {/* Destination selector */}
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {(Object.keys(INGEST_DEST_LABELS) as IngestDest[]).map(t => (
                            <button key={t} onClick={() => setQueueEdits(prev => ({ ...prev, [i]: t }))} style={{
                              ...mono, fontSize: 16, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                              border: `1px solid ${current === t ? colors.purple + '80' : colors.borderLo}`,
                              background: current === t ? colors.purple + '18' : 'transparent',
                              color: current === t ? colors.purple : colors.muted,
                            }}>{INGEST_DEST_LABELS[t]}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {commitErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 10 }}>{commitErr}</div>}

                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <Btn onClick={commitIngest} disabled={commitBusy}
                    style={{ background: colors.purple + '18', borderColor: colors.purple + '40', color: colors.purple }}>
                    {commitBusy
                      ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 4 }} />Copying…</>
                      : <>Copy {queue.length} file{queue.length !== 1 ? 's' : ''} to Libraries</>}
                  </Btn>
                  <Btn onClick={() => { setClassifyDone(false); setQueue([]); setQueueEdits({}); setPendingPaths([]); }}>
                    Start Over
                  </Btn>
                </div>
              </>
            )}

            {/* ── Step 4: commit results ───────────────────────────────── */}
            {committed && commitResult && (
              <>
                <div style={{ ...mono, fontSize: 18, color: colors.green, marginBottom: 12,
                  display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle2 size={22} />
                  Ingest complete — Kavita is scanning.
                </div>
                {commitResult.map((r, i) => (
                  <div key={i} style={{ ...mono, fontSize: 16, marginBottom: 4,
                    color: r.ok ? colors.muted : colors.red }}>
                    {r.ok ? '✓' : '✗'} {r.source.split('/').pop() ?? r.source}
                    {r.ok && <span style={{ color: colors.dim }}> → {r.dest}</span>}
                    {!r.ok && <span> — {r.error}</span>}
                  </div>
                ))}
                <div style={{ marginTop: 14 }}>
                  <Btn onClick={() => {
                    setCommitResult(null); setClassifyDone(false); setQueue([]);
                    setQueueEdits({}); setPendingPaths([]);
                  }}>Ingest More</Btn>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Libraries view (default) ──────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9500,
      background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 1000, maxHeight: '80vh', background: colors.bg,
        border: `1px solid ${colors.border}`, borderRadius: 6,
        boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {panelHeader('Kavita', isRunning ? `Running · port ${status.port}` : status.state.toUpperCase())}

        {/* Status bar */}
        <div style={{ padding: '14px 28px', borderBottom: `1px solid ${colors.borderLo}`,
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: isRunning ? colors.green : isStarting ? colors.amber : colors.dim,
              boxShadow: isRunning ? `0 0 5px ${colors.green}` : 'none',
            }} />
            <span style={{ ...mono, fontSize: 16, color: isRunning ? colors.green : colors.muted, letterSpacing: '.08em' }}>
              {isRunning ? 'RUNNING' : isStarting ? 'STARTING' : status.state.toUpperCase()}
            </span>
          </div>
          {status.error && (
            <span style={{ ...mono, fontSize: 16, color: colors.red }}>{status.error}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {isRunning && (
              <>
                <Btn onClick={() => setView('ingest')}
                  style={{ background: colors.purple + '18', borderColor: colors.purple + '40', color: colors.purple }}>
                  <FileText size={18} style={{ display: 'inline', marginRight: 4 }} />Ingest
                </Btn>
                <Btn onClick={() => setView('add-library')}>
                  <Plus size={18} style={{ display: 'inline', marginRight: 4 }} />Add Library
                </Btn>
                <Btn onClick={triggerScan} disabled={scanning}>
                  <RefreshCw size={18} style={{ display: 'inline', marginRight: 4, animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
                  {scanning ? 'Scanning…' : 'Scan'}
                </Btn>
              </>
            )}
          </div>
        </div>

        {/* Libraries list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {libsLoading && (
            <div style={{ padding: '32px 28px', display: 'flex', alignItems: 'center', gap: 8, color: colors.muted }}>
              <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ ...mono, fontSize: 18 }}>Loading libraries…</span>
            </div>
          )}

          {!isRunning && !isStarting && !libsLoading && (
            <div style={{ padding: '32px 28px' }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted }}>
                {isStarting ? 'Kavita is starting…' : 'Kavita is not running. Check the binary or server logs.'}
              </div>
            </div>
          )}

          {isRunning && !libsLoading && libraries.length === 0 && (
            <div style={{ padding: '32px 28px' }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted }}>No libraries found.</div>
            </div>
          )}

          {libraries.map(lib => {
            const typeLabel = Object.entries(LIB_TYPE_CODES).find(([, v]) => v === lib.type)?.[0] ?? 'books';
            const folder    = lib.folders[0] ?? '';
            const isPhobosDocs = lib.name === 'phobosDocs';

            return (
              <div key={lib.id} style={{ padding: '20px 28px', borderBottom: `1px solid ${colors.borderLo}`,
                display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span style={{ ...mono, fontSize: 20, fontWeight: 600, color: colors.text }}>
                      {lib.name}
                    </span>
                    {isPhobosDocs && (
                      <span style={{ ...mono, fontSize: 14, color: colors.purple,
                        background: colors.purple + '15', border: `1px solid ${colors.purple + '30'}`,
                        borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>PHOBOS CORE</span>
                    )}
                    <span style={{ ...mono, fontSize: 16, color: colors.muted }}>
                      {LIB_TYPE_LABELS[typeLabel as KavitaLibType] ?? typeLabel}
                    </span>
                    <span style={{ ...mono, fontSize: 16, color: colors.dim }}>
                      {lib.seriesCount ?? lib.series ?? 0} series
                    </span>
                  </div>
                  <div style={{ ...mono, fontSize: 16, color: colors.dim,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {folder}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  {/* Open folder in OS explorer */}
                  <button onClick={() => openFolder(folder)} title="Open in file explorer"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                      color: colors.muted, padding: 4, display: 'flex' }}>
                    <FolderOpen size={22} />
                  </button>

                  {/* Move library — always available, even for phobosDocs */}
                  <button onClick={() => startMove(lib)} title="Move library folder"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                      color: colors.muted, padding: 4, display: 'flex' }}>
                    <MoveRight size={22} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 28px', borderTop: `1px solid ${colors.borderLo}` }}>
          <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.08em' }}>
            KAVITA · PORT {status.port} · phobosDocs IS PHOBOS CRITICAL STORAGE
          </span>
        </div>
      </div>
    </div>
  );
}


// ── JellyfinPanel ─────────────────────────────────────────────────────────────
// Core service — always running when binary is present.
// phobosVideos is the default local storage folder for user-created video content.

interface JellyfinLibrary {
  Name:           string;
  CollectionType: string;
  Locations:      string[];
  ItemId:         string;
}

type JellyfinView = 'libraries' | 'add-library' | 'move-library' | 'move-default' | 'ingest';
type JellyfinIngestDest = 'movies' | 'tvshows' | 'phobosVideos';

interface JellyfinIngestItem {
  sourcePath:    string;
  filename:      string;
  suggestion:    JellyfinIngestDest;
  seriesName:    string;
  seasonNumber:  number;
  reason:        string;
  llmClassified: boolean;
}

interface JellyfinMoveTarget {
  lib:         JellyfinLibrary;
  newPath:     string;
  moveContent: boolean;
}

const JF_COLLECTION_TYPES = ['movies', 'tvshows', 'music', 'homevideos', 'mixed'] as const;
type  JfCollectionType    = typeof JF_COLLECTION_TYPES[number];

const JF_COLLECTION_LABELS: Record<JfCollectionType, string> = {
  movies: 'Movies', tvshows: 'TV Shows', music: 'Music', homevideos: 'Home Videos', mixed: 'Mixed',
};

const JF_INGEST_LABELS: Record<JellyfinIngestDest, string> = {
  movies: 'Movies', tvshows: 'TV Shows', phobosVideos: 'phobosVideos (default)',
};

interface JfClassifyProgress { index: number; total: number; pct: number; item: JellyfinIngestItem | null; }

const JF_BLUE = '#3b82f6';

function JellyfinPanel({ status, onClose, onRefresh }: {
  status:    ServiceStatus;
  onClose:   () => void;
  onRefresh: () => void;
}) {
  const isRunning  = status.state === 'running';
  const isStarting = status.state === 'starting';
  const [view, setView]             = useState<JellyfinView>('libraries');
  const [libraries, setLibraries]   = useState<JellyfinLibrary[]>([]);
  const [libsLoading, setLibsLoading] = useState(false);
  const [scanning, setScanning]     = useState(false);

  const loadLibraries = useCallback(async () => {
    if (!isRunning) return;
    setLibsLoading(true);
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/libraries`);
      if (r.ok) { const d = await r.json(); setLibraries(d.libraries ?? []); }
    } catch { /* ignore */ }
    setLibsLoading(false);
  }, [isRunning]);

  useEffect(() => { if (view === 'libraries') loadLibraries(); }, [view, loadLibraries]);

  // Retry up to 8x (16s) if running but libraries come back empty — Jellyfin
  // finishes its first-run wizard and ensurePhobosLibrary after the panel opens.
  useEffect(() => {
    if (view !== 'libraries' || !isRunning || libsLoading) return;
    if (libraries.length > 0) return;
    const t = setTimeout(() => loadLibraries(), 2000);
    return () => clearTimeout(t);
  }, [view, isRunning, libraries, libsLoading, loadLibraries]);

  const triggerScan = async () => {
    setScanning(true);
    try { await fetch(`${ENGINE}/api/jellyfin/scan`, { method: 'POST' }); } catch { /* ignore */ }
    setScanning(false);
  };

  const openFolder = async (folderPath: string) =>
    fetch(`${ENGINE}/api/jellyfin/open-folder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });

  // ── Move default library ────────────────────────────────────────────────────
  const [moveDefaultPath, setMoveDefaultPath]       = useState('');
  const [moveDefaultContent, setMoveDefaultContent] = useState(false);
  const [moveDefaultBusy, setMoveDefaultBusy]       = useState(false);
  const [moveDefaultErr, setMoveDefaultErr]         = useState('');

  // ── Add library ────────────────────────────────────────────────────────────
  const [newLibName, setNewLibName]     = useState('');
  const [newLibType, setNewLibType]     = useState<JfCollectionType>('movies');
  const [newLibFolder, setNewLibFolder] = useState('');
  const [addLibErr, setAddLibErr]       = useState('');
  const [addLibBusy, setAddLibBusy]     = useState(false);

  const addLibrary = async () => {
    if (!newLibName.trim() || !newLibFolder.trim()) { setAddLibErr('Name and folder are required.'); return; }
    setAddLibErr(''); setAddLibBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/libraries`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newLibName.trim(), folderPath: newLibFolder.trim(), collectionType: newLibType }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error ?? 'Failed'); }
      setNewLibName(''); setNewLibFolder(''); setView('libraries');
    } catch (e) { setAddLibErr((e as Error).message); }
    setAddLibBusy(false);
  };

  // ── Move library ───────────────────────────────────────────────────────────
  const [moveTarget, setMoveTarget] = useState<JellyfinMoveTarget | null>(null);
  const [moveBusy, setMoveBusy]     = useState(false);
  const [moveErr, setMoveErr]       = useState('');

  const startMove = (lib: JellyfinLibrary) => {
    setMoveTarget({ lib, newPath: lib.Locations[0] ?? '', moveContent: false });
    setMoveErr(''); setView('move-library');
  };

  const commitMove = async () => {
    if (!moveTarget || !moveTarget.newPath.trim()) { setMoveErr('New folder path is required.'); return; }
    setMoveBusy(true); setMoveErr('');
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/libraries/${encodeURIComponent(moveTarget.lib.Name)}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newFolder: moveTarget.newPath.trim(), collectionType: moveTarget.lib.CollectionType, moveContent: moveTarget.moveContent }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error ?? 'Move failed'); }
      setMoveTarget(null); setView('libraries');
    } catch (e) { setMoveErr((e as Error).message); }
    setMoveBusy(false);
  };

  // ── Ingest ─────────────────────────────────────────────────────────────────
  const [pendingPaths, setPendingPaths]       = useState<string[]>([]);
  const [dropActive, setDropActive]           = useState(false);
  const [pickerBusy, setPickerBusy]           = useState(false);
  const [classifyErr, setClassifyErr]         = useState('');
  const [classifyProgress, setClassifyProg]   = useState<JfClassifyProgress | null>(null);
  const [queue, setQueue]                     = useState<JellyfinIngestItem[]>([]);
  const [queueEdits, setQueueEdits]           = useState<Record<number, JellyfinIngestDest>>({});
  const [classifyDone, setClassifyDone]       = useState(false);
  const [commitBusy, setCommitBusy]           = useState(false);
  const [commitResult, setCommitResult]       = useState<Array<{ source: string; dest: string; ok: boolean; error?: string }> | null>(null);
  const [commitErr, setCommitErr]             = useState('');
  const [libFolders, setLibFolders]           = useState<Record<JellyfinIngestDest, string>>({ movies: '', tvshows: '', phobosVideos: '' });

  useEffect(() => {
    if (view !== 'ingest' || libraries.length === 0) return;
    const m: Record<JellyfinIngestDest, string> = { movies: '', tvshows: '', phobosVideos: '' };
    for (const lib of libraries) {
      const folder = lib.Locations[0] ?? '';
      if (lib.CollectionType === 'movies')  m.movies  = folder;
      if (lib.CollectionType === 'tvshows') m.tvshows = folder;
      if (lib.Name === 'phobosVideos' || lib.Name === 'Phobos') m.phobosVideos = folder;
    }
    setLibFolders(m);
  }, [view, libraries]);

  const addPaths = (incoming: string[]) =>
    setPendingPaths(prev => Array.from(new Set([...prev, ...incoming.filter(Boolean)])));

  const openFilePicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-file-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'any' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) addPaths([d.path.trim()]);
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const openFolderPicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select video folder' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) {
        const r2 = await fetch(`${ENGINE}/api/jellyfin/ingest/scan-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: d.path.trim() }),
        });
        const d2 = await r2.json() as { files?: string[] };
        if (d2.files) addPaths(d2.files);
      }
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const runClassify = async () => {
    if (pendingPaths.length === 0) { setClassifyErr('Add at least one file.'); return; }
    setClassifyErr(''); setClassifyDone(false); setQueue([]); setQueueEdits({});
    setClassifyProg({ index: 0, total: pendingPaths.length, pct: 0, item: null });
    const res = await fetch(`${ENGINE}/api/jellyfin/ingest/classify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: pendingPaths }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Server error ${res.status}` })) as { error?: string };
      setClassifyErr(err.error ?? `Server error ${res.status}`); setClassifyProg(null); return;
    }
    const reader = res.body?.getReader();
    if (!reader) { setClassifyErr('No response stream.'); setClassifyProg(null); return; }
    const dec = new TextDecoder(); let buf = '';
    const flush = (line: string) => {
      if (!line.startsWith('data: ')) return;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'classify_progress') setClassifyProg({ index: evt.index, total: evt.total, pct: evt.pct, item: evt.item });
        else if (evt.type === 'classify_done') { setQueue(evt.queue ?? []); setClassifyDone(true); setClassifyProg(null); }
        else if (evt.type === 'classify_error') { setClassifyErr(evt.error ?? 'Failed.'); setClassifyProg(null); }
      } catch { /* malformed */ }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) flush(line);
    }
    for (const line of buf.split('\n')) flush(line);
  };

  const commitIngest = async () => {
    setCommitBusy(true); setCommitErr(''); setCommitResult(null);
    const items = queue.map((item, i) => ({
      sourcePath: item.sourcePath, filename: item.filename,
      suggestion: queueEdits[i] ?? item.suggestion,
      seriesName: item.seriesName, seasonNumber: item.seasonNumber,
    }));
    try {
      const r = await fetch(`${ENGINE}/api/jellyfin/ingest/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, libraryFolders: libFolders }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error((d as any).error ?? 'Commit failed');
      setCommitResult(d.results ?? []);
      loadLibraries();
    } catch (e) { setCommitErr((e as Error).message); }
    setCommitBusy(false);
  };

  const panelHeader = (title: string, subtitle: string, back?: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '20px 28px', borderBottom: `1px solid ${colors.border}`,
      background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Film size={24} style={{ color: JF_BLUE }} />
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: colors.text }}>{title}</span>
          {subtitle && <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 1 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {back && <button onClick={back} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16, padding: '3px 6px' }}>← BACK</button>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4 }}><X size={24} /></button>
      </div>
    </div>
  );

  if (view === 'move-library' && moveTarget) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 920, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader(`Move: ${moveTarget.lib.Name}`, 'Change library folder location', () => setView('libraries'))}
          <div style={{ padding: 16 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>CURRENT LOCATION</label>
            <div style={{ ...mono, fontSize: 18, color: colors.dim, padding: '6px 9px', background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 4, marginBottom: 12 }}>
              {moveTarget.lib.Locations[0] ?? '—'}
            </div>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>NEW LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><Input value={moveTarget.newPath} onChange={v => setMoveTarget(t => t ? { ...t, newPath: v } : null)} placeholder="/new/path" /></div>
              <button onClick={async () => { try { const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select new library location', initialPath: moveTarget?.lib.Locations[0] ?? '' }) }); const d = await r.json(); if (d.path) setMoveTarget(t => t ? { ...t, newPath: d.path } : null); } catch { /* ignore */ } }} title="Browse for folder" style={{ background: colors.surfaceHi, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: colors.muted, padding: '0 14px', display: 'flex', alignItems: 'center' }}><FolderOpen size={22} /></button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={moveTarget.moveContent}
                onChange={e => setMoveTarget(t => t ? { ...t, moveContent: e.target.checked } : null)} />
              <span style={{ ...mono, fontSize: 18, color: colors.text }}>Move existing content to new location</span>
            </label>
            {moveErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 10 }}>{moveErr}</div>}
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Btn onClick={commitMove} disabled={moveBusy}
                style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                {moveBusy ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 4 }} />Moving…</> : <><MoveRight size={18} style={{ display: 'inline', marginRight: 4 }} />Move Library</>}
              </Btn>
              <Btn onClick={() => { setMoveTarget(null); setView('libraries'); }}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'move-default') {
    const commitMoveDefault = async () => {
      if (!moveDefaultPath.trim()) { setMoveDefaultErr('New folder path is required.'); return; }
      setMoveDefaultBusy(true); setMoveDefaultErr('');
      try {
        const r = await fetch(`${ENGINE}/api/jellyfin/library/move-default`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPath: moveDefaultPath.trim(), moveContent: moveDefaultContent }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as any).error ?? 'Move failed'); }
        onRefresh(); setView('libraries');
      } catch (e) { setMoveDefaultErr((e as Error).message); }
      setMoveDefaultBusy(false);
    };
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 920, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Move: phobosVideos', 'Change library folder location', () => setView('libraries'))}
          <div style={{ padding: 28 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>CURRENT LOCATION</label>
            <div style={{ ...mono, fontSize: 18, color: colors.dim, padding: '12px 16px',
              background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 6, marginBottom: 20 }}>
              {status.libraryPath ?? '(no path configured)'}
            </div>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>NEW LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><Input value={moveDefaultPath} onChange={setMoveDefaultPath} placeholder="C:\Users\you\.phobos\media\jellyfin\phobosVideos" /></div>
              <button onClick={async () => { try { const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select new library location', initialPath: status.libraryPath ?? '' }) }); const d = await r.json(); if (d.path) setMoveDefaultPath(d.path); } catch { /* ignore */ } }} title="Browse for folder" style={{ background: colors.surfaceHi, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: colors.muted, padding: '0 14px', display: 'flex', alignItems: 'center' }}><FolderOpen size={22} /></button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, cursor: 'pointer' }}>
              <input type="checkbox" checked={moveDefaultContent} onChange={e => setMoveDefaultContent(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: JF_BLUE }} />
              <span style={{ ...mono, fontSize: 18, color: colors.text }}>Move existing content to new location</span>
            </label>
            <div style={{ ...mono, fontSize: 16, color: colors.dim, marginTop: 6, marginLeft: 26 }}>
              Files will be copied to the new folder, originals removed. Only top-level files are moved.
            </div>
            {moveDefaultErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 12 }}>{moveDefaultErr}</div>}
            <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
              <Btn onClick={commitMoveDefault} disabled={moveDefaultBusy}
                style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                {moveDefaultBusy
                  ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 6 }} />Moving…</>
                  : <><MoveRight size={18} style={{ display: 'inline', marginRight: 6 }} />Move Library</>}
              </Btn>
              <Btn onClick={() => setView('libraries')}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'add-library') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 840, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Add Library', 'Create a new Jellyfin library', () => setView('libraries'))}
          <div style={{ padding: 16 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 4 }}>LIBRARY NAME</label>
            <Input value={newLibName} onChange={setNewLibName} placeholder="My Movies" />
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginTop: 10, marginBottom: 4 }}>TYPE</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {JF_COLLECTION_TYPES.map(t => (
                <button key={t} onClick={() => setNewLibType(t)} style={{
                  ...mono, fontSize: 16, padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${newLibType === t ? JF_BLUE + '80' : colors.border}`,
                  background: newLibType === t ? JF_BLUE + '18' : colors.surface,
                  color: newLibType === t ? JF_BLUE : colors.muted,
                }}>{JF_COLLECTION_LABELS[t]}</button>
              ))}
            </div>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginTop: 10, marginBottom: 4 }}>FOLDER PATH</label>
            <Input value={newLibFolder} onChange={setNewLibFolder} placeholder="/path/to/library" />
            {addLibErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 8 }}>{addLibErr}</div>}
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <Btn onClick={addLibrary} disabled={addLibBusy || !isRunning}
                style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                {addLibBusy ? 'Creating…' : 'Create Library'}
              </Btn>
              <Btn onClick={() => setView('libraries')}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'ingest') {
    const classifying = classifyProgress !== null && !classifyDone;
    const reviewReady = classifyDone && queue.length > 0 && !commitResult;
    const committed   = commitResult !== null;
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 1080, maxHeight: '85vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Ingest Media', 'SYBIL classifies, you confirm', () => {
            setView('libraries'); setClassifyDone(false); setQueue([]); setQueueEdits({});
            setClassifyProg(null); setCommitResult(null); setPendingPaths([]);
          })}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            {!classifyDone && !classifying && (
              <>
                <div onDragOver={e => { e.preventDefault(); setDropActive(true); }} onDragLeave={() => setDropActive(false)}
                  onDrop={async e => {
                    e.preventDefault(); setDropActive(false);
                    const paths: string[] = [];
                    for (const file of Array.from(e.dataTransfer.files)) { const p = (file as any).path as string | undefined; if (p) paths.push(p); }
                    addPaths(paths);
                  }}
                  style={{ border: `2px dashed ${dropActive ? JF_BLUE : colors.border}`, borderRadius: 6, padding: '32px 28px', textAlign: 'center', background: dropActive ? JF_BLUE + '0c' : colors.surface, transition: 'border-color .15s, background .15s', marginBottom: 12 }}>
                  <div style={{ ...mono, fontSize: 18, color: colors.muted, marginBottom: 10 }}>Drop video files or folders here</div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <Btn onClick={openFilePicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FileText size={18} style={{ display: 'inline' }} /> Add File</Btn>
                    <Btn onClick={openFolderPicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FolderOpen size={18} style={{ display: 'inline' }} /> Add Folder</Btn>
                  </div>
                </div>
                {pendingPaths.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 6 }}>{pendingPaths.length} FILE{pendingPaths.length !== 1 ? 'S' : ''} QUEUED</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                      {pendingPaths.map((p, i) => (
                        <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: colors.surface, border: `1px solid ${colors.borderLo}`, borderRadius: 4 }}>
                          <Film size={28} style={{ color: colors.muted, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...mono, fontSize: 18, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.split(/[\/]/).pop()}</div>
                            <div style={{ ...mono, fontSize: 14, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>
                          </div>
                          <button onClick={() => setPendingPaths(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 2, lineHeight: 1 }}><X size={18} /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {classifyErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginBottom: 8 }}>{classifyErr}</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Btn onClick={runClassify} disabled={pendingPaths.length === 0} style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                    Classify {pendingPaths.length > 0 ? `${pendingPaths.length} ` : ''}File{pendingPaths.length !== 1 ? 's' : ''}
                  </Btn>
                  {pendingPaths.length > 0 && <button onClick={() => setPendingPaths([])} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16 }}>Clear all</button>}
                </div>
              </>
            )}
            {classifying && classifyProgress && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                  <Loader2 size={22} style={{ color: JF_BLUE, animation: 'spin 1s linear infinite' }} />
                  <span style={{ ...mono, fontSize: 18, color: JF_BLUE }}>Classifying {classifyProgress.index + 1} / {classifyProgress.total}…</span>
                </div>
                <div style={{ background: colors.surfaceHi, borderRadius: 3, height: 3, marginBottom: 12 }}>
                  <div style={{ background: JF_BLUE, height: 3, borderRadius: 3, width: `${classifyProgress.pct}%`, transition: 'width .2s' }} />
                </div>
                {classifyProgress.item && (
                  <div style={{ ...mono, fontSize: 16, color: colors.muted }}>
                    {classifyProgress.item.filename}
                    <span style={{ color: classifyProgress.item.llmClassified ? colors.green : colors.amber, marginLeft: 8 }}>
                      → {JF_INGEST_LABELS[classifyProgress.item.suggestion] ?? classifyProgress.item.suggestion}
                    </span>
                    {classifyProgress.item.seriesName && (
                      <span style={{ color: colors.dim, marginLeft: 6 }}>
                        · {classifyProgress.item.seriesName}{classifyProgress.item.seasonNumber > 0 ? ` S${String(classifyProgress.item.seasonNumber).padStart(2,'0')}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {reviewReady && (
              <>
                <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 10 }}>
                  REVIEW — verify classifications. TV shows → {'{Series}/Season NN/'}. Confirm before copying.
                </div>
                <div style={{ marginBottom: 14, padding: 10, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 4 }}>
                  <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 8 }}>DESTINATION FOLDERS</div>
                  {(Object.keys(JF_INGEST_LABELS) as JellyfinIngestDest[]).map(t => (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ ...mono, fontSize: 16, color: t === 'phobosVideos' ? JF_BLUE : colors.muted, width: 100, flexShrink: 0 }}>{JF_INGEST_LABELS[t]}</span>
                      <Input value={libFolders[t]} onChange={v => setLibFolders(prev => ({ ...prev, [t]: v }))} placeholder={`/path/to/${t}`} style={{ fontSize: 16 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {queue.map((item, i) => {
                    const current = queueEdits[i] ?? item.suggestion;
                    return (
                      <div key={i} style={{ padding: 10, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                          <Film size={20} style={{ color: colors.muted, flexShrink: 0, marginTop: 1 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ ...mono, fontSize: 18, color: colors.text, wordBreak: 'break-all' }}>{item.filename}</div>
                            {item.seriesName && <div style={{ ...mono, fontSize: 16, color: JF_BLUE, marginTop: 1 }}>{item.seriesName}{item.seasonNumber > 0 ? ` · Season ${item.seasonNumber}` : ''}</div>}
                            <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 2 }}>
                              {item.reason}
                              {item.llmClassified ? <span style={{ color: colors.green, marginLeft: 6 }}>✦ LLM</span> : <span style={{ color: colors.amber, marginLeft: 6 }}>~ heuristic</span>}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {(Object.keys(JF_INGEST_LABELS) as JellyfinIngestDest[]).map(t => (
                            <button key={t} onClick={() => setQueueEdits(prev => ({ ...prev, [i]: t }))} style={{
                              ...mono, fontSize: 16, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                              border: `1px solid ${current === t ? JF_BLUE + '80' : colors.borderLo}`,
                              background: current === t ? JF_BLUE + '18' : 'transparent',
                              color: current === t ? JF_BLUE : colors.muted,
                            }}>{JF_INGEST_LABELS[t]}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {commitErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 10 }}>{commitErr}</div>}
                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <Btn onClick={commitIngest} disabled={commitBusy} style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                    {commitBusy ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 4 }} />Copying…</> : <>Copy {queue.length} file{queue.length !== 1 ? 's' : ''} to Libraries</>}
                  </Btn>
                  <Btn onClick={() => { setClassifyDone(false); setQueue([]); setQueueEdits({}); setPendingPaths([]); }}>Start Over</Btn>
                </div>
              </>
            )}
            {committed && commitResult && (
              <>
                <div style={{ ...mono, fontSize: 18, color: colors.green, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle2 size={22} />Ingest complete — Jellyfin scanning.
                </div>
                {commitResult.map((r, i) => (
                  <div key={i} style={{ ...mono, fontSize: 16, marginBottom: 4, color: r.ok ? colors.muted : colors.red }}>
                    {r.ok ? '✓' : '✗'} {r.source.split('/').pop() ?? r.source}
                    {r.ok && <span style={{ color: colors.dim }}> → {r.dest}</span>}
                    {!r.ok && <span> — {r.error}</span>}
                  </div>
                ))}
                <div style={{ marginTop: 14 }}>
                  <Btn onClick={() => { setCommitResult(null); setClassifyDone(false); setQueue([]); setQueueEdits({}); setPendingPaths([]); }}>Ingest More</Btn>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Libraries view (default) ───────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 1000, maxHeight: '80vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        {panelHeader('Jellyfin', isRunning ? `Running · port ${status.port}` : status.state.toUpperCase())}
        <div style={{ padding: '14px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? colors.green : isStarting ? colors.amber : colors.dim, boxShadow: isRunning ? `0 0 5px ${colors.green}` : 'none' }} />
            <span style={{ ...mono, fontSize: 16, color: isRunning ? colors.green : colors.muted, letterSpacing: '.08em' }}>
              {isRunning ? 'RUNNING' : isStarting ? 'STARTING' : status.state.toUpperCase()}
            </span>
          </div>
          {status.error && <span style={{ ...mono, fontSize: 16, color: colors.red }}>{status.error}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {isRunning && (
              <>
                <Btn onClick={() => setView('ingest')} style={{ background: JF_BLUE + '18', borderColor: JF_BLUE + '40', color: JF_BLUE }}>
                  <FileText size={18} style={{ display: 'inline', marginRight: 4 }} />Ingest
                </Btn>
                <Btn onClick={() => setView('add-library')}><Plus size={18} style={{ display: 'inline', marginRight: 4 }} />Add Library</Btn>
                <Btn onClick={triggerScan} disabled={scanning}>
                  <RefreshCw size={18} style={{ display: 'inline', marginRight: 4, animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
                  {scanning ? 'Scanning…' : 'Scan'}
                </Btn>
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* phobosVideos: always rendered from known default path — never depends on API */}
          {isRunning && (() => {
            const defaultPath = status.libraryPath ?? '';
            return (
              <div style={{ padding: '20px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span style={{ ...mono, fontSize: 20, fontWeight: 600, color: colors.text }}>phobosVideos</span>
                    <span style={{ ...mono, fontSize: 14, color: JF_BLUE, background: JF_BLUE + '15', border: `1px solid ${JF_BLUE + '30'}`, borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>PHOBOS DEFAULT</span>
                    <span style={{ ...mono, fontSize: 16, color: colors.muted }}>Home Videos</span>
                  </div>
                  <div style={{ ...mono, fontSize: 16, color: colors.dim }}>{defaultPath}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  <button onClick={() => openFolder(defaultPath)} title="Open in file explorer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}><FolderOpen size={22} /></button>
                  <button onClick={() => { setMoveDefaultPath(status.libraryPath ?? ''); setMoveDefaultErr(''); setView('move-default'); }} title="Move library folder" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}><MoveRight size={22} /></button>
                </div>
              </div>
            );
          })()}
          {/* User-added libraries from Jellyfin API — exclude the phobosVideos default */}
          {libraries.filter(lib => lib.Name !== 'phobosVideos' && lib.Name !== 'Phobos').map(lib => {
            const folder = lib.Locations[0] ?? '';
            return (
              <div key={lib.ItemId} style={{ padding: '20px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span style={{ ...mono, fontSize: 20, fontWeight: 600, color: colors.text }}>{lib.Name}</span>
                    <span style={{ ...mono, fontSize: 16, color: colors.muted }}>{JF_COLLECTION_LABELS[lib.CollectionType as JfCollectionType] ?? lib.CollectionType}</span>
                  </div>
                  <div style={{ ...mono, fontSize: 16, color: colors.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  <button onClick={() => openFolder(folder)} title="Open in file explorer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}><FolderOpen size={22} /></button>
                  <button onClick={() => startMove(lib)} title="Move library folder" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}><MoveRight size={22} /></button>
                </div>
              </div>
            );
          })}
          {!isRunning && !isStarting && <div style={{ padding: '32px 28px' }}><div style={{ ...mono, fontSize: 18, color: colors.muted }}>Jellyfin is not running.</div></div>}
        </div>
        <div style={{ padding: '14px 28px', borderTop: `1px solid ${colors.borderLo}` }}>
          <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.08em' }}>
            JELLYFIN · PORT {status.port} · phobosVideos IS DEFAULT LOCAL STORAGE
          </span>
        </div>
      </div>
    </div>
  );
}

// ── MeridianPanel ─────────────────────────────────────────────────────────────
// Core service — always running. phobosPictures is the default photos folder.

// ── MeridianPanel ─────────────────────────────────────────────────────────────

const MERIDIAN_TEAL = '#14b8a6';

type MeridianView = 'libraries' | 'edit-path' | 'ingest';

function MeridianPanel({ status, onClose, onRefresh }: {
  status: ServiceStatus;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isRunning  = status.state === 'running';
  const isStarting = status.state === 'starting';
  const visionCapability = useAppStore(s => s.visionCapability);
  const hasVision = visionCapability?.coordinatorSupportsVision || visionCapability?.engineSupportsVision;

  const [view, setView]         = useState<MeridianView>('libraries');
  const [scanning, setScanning] = useState(false);
  const libraryFolder = status.libraryPath ?? '';

  const [newPath, setNewPath]               = useState('');
  const [saveErr, setSaveErr]               = useState('');
  const [saving, setSaving]                 = useState(false);
  const [saveMoveContent, setSaveMoveContent] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pickerBusy, setPickerBusy]     = useState(false);
  const [dropActive, setDropActive]     = useState(false);
  const [ingestNote, setIngestNote]     = useState('');

  const savePath = async () => {
    if (!newPath.trim()) { setSaveErr('Path is required.'); return; }
    setSaveErr(''); setSaving(true);
    try {
      await fetch(`${ENGINE}/api/services/meridian/config`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryPath: newPath.trim() }),
      });
      onRefresh(); setView('libraries');
    } catch (e) { setSaveErr((e as Error).message); }
    setSaving(false);
  };

  const triggerScan = async () => {
    setScanning(true);
    try { await fetch(`${ENGINE}/api/services/meridian/scan`, { method: 'POST' }); } catch { /* ignore */ }
    setScanning(false);
  };

  const openFolder = async (folderPath: string) => {
    await fetch(`${ENGINE}/api/services/meridian/open-folder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
  };

  const openFilePicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-file-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'any' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) setPendingPaths(prev => Array.from(new Set([...prev, d.path!.trim()])));
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const openFolderPicker = async () => {
    setPickerBusy(true);
    try {
      const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select photos folder' }) });
      const d = await r.json() as { path: string | null };
      if (d.path) {
        const r2 = await fetch(`${ENGINE}/api/meridian/ingest/scan-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: d.path.trim() }),
        });
        const d2 = await r2.json() as { files?: string[] };
        if (d2.files) setPendingPaths(prev => Array.from(new Set([...prev, ...d2.files!])));
      }
    } catch { /* cancelled */ }
    setPickerBusy(false);
  };

  const commitIngest = async () => {
    if (pendingPaths.length === 0) return;
    const targetFolder = hasVision
      ? (status.libraryPath ?? '')
      : `${status.libraryPath ?? ''}/Unsorted`;
    setIngestNote(hasVision ? 'Copying files to phobosPictures…' : 'Copying files to phobosPictures/Unsorted…');
    try {
      const r = await fetch(`${ENGINE}/api/meridian/ingest/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: pendingPaths, targetFolder }),
      });
      const d = await r.json() as { ok?: boolean; copied?: number; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'Commit failed');
      setIngestNote(`Done — ${d.copied ?? pendingPaths.length} file(s) copied. Meridian scanning.`);
      setPendingPaths([]);
    } catch (e) { setIngestNote(`Error: ${(e as Error).message}`); }
  };

  const panelHeader = (title: string, subtitle: string, back?: () => void) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '20px 28px', borderBottom: `1px solid ${colors.border}`,
      background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Camera size={24} style={{ color: MERIDIAN_TEAL }} />
        <div>
          <span style={{ ...mono, fontSize: 22, fontWeight: 700, color: colors.text }}>{title}</span>
          {subtitle && <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 1 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {back && <button onClick={back} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16, padding: '3px 6px' }}>← BACK</button>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4 }}><X size={24} /></button>
      </div>
    </div>
  );

  if (view === 'edit-path') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 920, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Move: phobosPictures', 'Change library folder location', () => setView('libraries'))}
          <div style={{ padding: 28 }}>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>CURRENT LOCATION</label>
            <div style={{ ...mono, fontSize: 18, color: colors.dim, padding: '12px 16px',
              background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 6, marginBottom: 20 }}>
              {libraryFolder || '(no path configured)'}
            </div>
            <label style={{ ...mono, fontSize: 16, color: colors.muted, display: 'block', marginBottom: 8 }}>NEW LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1 }}><Input value={newPath} onChange={setNewPath} placeholder="C:\Users\you\.phobos\media\meridian\phobosPictures" /></div>
              <button onClick={async () => { try { const r = await fetch(`${ENGINE}/api/phobos/models/open-folder-dialog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Select new library location', initialPath: libraryFolder }) }); const d = await r.json(); if (d.path) setNewPath(d.path); } catch { /* ignore */ } }} title="Browse for folder" style={{ background: colors.surfaceHi, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: colors.muted, padding: '0 14px', display: 'flex', alignItems: 'center' }}><FolderOpen size={22} /></button>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, cursor: 'pointer' }}>
              <input type="checkbox" checked={saveMoveContent} onChange={e => setSaveMoveContent(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: MERIDIAN_TEAL }} />
              <span style={{ ...mono, fontSize: 18, color: colors.text }}>Move existing content to new location</span>
            </label>
            <div style={{ ...mono, fontSize: 16, color: colors.dim, marginTop: 6, marginLeft: 26 }}>
              Files will be copied to the new folder, originals removed. Only top-level files are moved.
            </div>
            {saveErr && <div style={{ ...mono, fontSize: 18, color: colors.red, marginTop: 12 }}>{saveErr}</div>}
            <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
              <Btn onClick={savePath} disabled={saving}
                style={{ background: MERIDIAN_TEAL + '18', borderColor: MERIDIAN_TEAL + '40', color: MERIDIAN_TEAL }}>
                {saving
                  ? <><Loader2 size={18} style={{ display: 'inline', marginRight: 6 }} />Moving…</>
                  : <><MoveRight size={18} style={{ display: 'inline', marginRight: 6 }} />Move Library</>}
              </Btn>
              <Btn onClick={() => setView('libraries')}>Cancel</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'ingest') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 1000, maxHeight: '80vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {panelHeader('Ingest Photos', 'Copy images into phobosPictures', () => { setView('libraries'); setPendingPaths([]); setIngestNote(''); })}
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            {!hasVision && (
              <div style={{ ...mono, fontSize: 16, padding: '8px 10px', marginBottom: 12,
                background: colors.amber + '0c', border: `1px solid ${colors.amber + '30'}`,
                borderRadius: 4, color: colors.amber }}>
                No vision model detected. Photos will be added to an <strong>Unsorted</strong> folder.
                You can re-ingest that folder later with a vision model to categorize them.
              </div>
            )}
            <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 12 }}>
              Files are copied into phobosPictures and Meridian rescans automatically.
            </div>
            <div
              onDragOver={e => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={async e => {
                e.preventDefault(); setDropActive(false);
                const paths: string[] = [];
                for (const file of Array.from(e.dataTransfer.files)) {
                  const p = (file as any).path as string | undefined;
                  if (p) paths.push(p);
                }
                setPendingPaths(prev => Array.from(new Set([...prev, ...paths])));
              }}
              style={{ border: `2px dashed ${dropActive ? MERIDIAN_TEAL : colors.border}`, borderRadius: 6, padding: '32px 28px', textAlign: 'center', background: dropActive ? MERIDIAN_TEAL + '0c' : colors.surface, transition: 'border-color .15s, background .15s', marginBottom: 12 }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted, marginBottom: 10 }}>Drop photos or folders here</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <Btn onClick={openFilePicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FileText size={18} style={{ display: 'inline' }} /> Add File</Btn>
                <Btn onClick={openFolderPicker} disabled={pickerBusy} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><FolderOpen size={18} style={{ display: 'inline' }} /> Add Folder</Btn>
              </div>
            </div>
            {pendingPaths.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...mono, fontSize: 16, color: colors.muted, marginBottom: 6 }}>{pendingPaths.length} FILE{pendingPaths.length !== 1 ? 'S' : ''} QUEUED</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                  {pendingPaths.map((p, i) => (
                    <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: colors.surface, border: `1px solid ${colors.borderLo}`, borderRadius: 4 }}>
                      <Images size={28} style={{ color: colors.muted, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ ...mono, fontSize: 18, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.split(/[\/]/).pop()}</div>
                        <div style={{ ...mono, fontSize: 14, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>
                      </div>
                      <button onClick={() => setPendingPaths(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 2, lineHeight: 1 }}><X size={18} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {ingestNote && <div style={{ ...mono, fontSize: 18, color: ingestNote.startsWith('Error') ? colors.red : colors.green, marginBottom: 8 }}>{ingestNote}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn onClick={commitIngest} disabled={pendingPaths.length === 0} style={{ background: MERIDIAN_TEAL + '18', borderColor: MERIDIAN_TEAL + '40', color: MERIDIAN_TEAL }}>
                Copy {pendingPaths.length > 0 ? `${pendingPaths.length} ` : ''}file{pendingPaths.length !== 1 ? 's' : ''} to phobosPictures
              </Btn>
              {pendingPaths.length > 0 && <button onClick={() => setPendingPaths([])} style={{ ...mono, background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 16 }}>Clear all</button>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Libraries view (default) ───────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 960, maxHeight: '80vh', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        {panelHeader('Meridian', isRunning ? `Running · port ${status.port}` : status.state.toUpperCase())}
        <div style={{ padding: '14px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? colors.green : isStarting ? colors.amber : colors.dim, boxShadow: isRunning ? `0 0 5px ${colors.green}` : 'none' }} />
            <span style={{ ...mono, fontSize: 16, color: isRunning ? colors.green : colors.muted, letterSpacing: '.08em' }}>
              {isRunning ? 'RUNNING' : isStarting ? 'STARTING' : status.state.toUpperCase()}
            </span>
          </div>
          {status.error && <span style={{ ...mono, fontSize: 16, color: colors.red }}>{status.error}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {isRunning && (
              <>
                <Btn onClick={() => setView('ingest')} style={{ background: MERIDIAN_TEAL + '18', borderColor: MERIDIAN_TEAL + '40', color: MERIDIAN_TEAL }}>
                  <FileText size={18} style={{ display: 'inline', marginRight: 4 }} />Ingest
                </Btn>

                <Btn onClick={triggerScan} disabled={scanning}>
                  <RefreshCw size={18} style={{ display: 'inline', marginRight: 4, animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
                  {scanning ? 'Scanning…' : 'Scan'}
                </Btn>
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!isRunning && !isStarting && (
            <div style={{ padding: '32px 28px' }}>
              <div style={{ ...mono, fontSize: 18, color: colors.muted }}>Meridian is not running.</div>
            </div>
          )}
          {(isRunning || isStarting) && (
            <div style={{ padding: '20px 28px', borderBottom: `1px solid ${colors.borderLo}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ ...mono, fontSize: 20, fontWeight: 600, color: colors.text }}>phobosPictures</span>
                  <span style={{ ...mono, fontSize: 14, color: MERIDIAN_TEAL, background: MERIDIAN_TEAL + '15', border: `1px solid ${MERIDIAN_TEAL + '30'}`, borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>PHOBOS DEFAULT</span>
                  <span style={{ ...mono, fontSize: 16, color: colors.muted }}>Photos</span>
                </div>
                <div style={{ ...mono, fontSize: 16, color: colors.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{libraryFolder || '(no path configured)'}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                {libraryFolder && (
                  <button onClick={() => openFolder(libraryFolder)} title="Open in file explorer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}>
                    <FolderOpen size={22} />
                  </button>
                )}
                <button onClick={() => { setNewPath(libraryFolder); setView('edit-path'); }} title="Move library folder" style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4, display: 'flex' }}>
                  <MoveRight size={22} />
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ padding: '14px 28px', borderTop: `1px solid ${colors.borderLo}` }}>
          <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.08em' }}>
            MERIDIAN · PORT {status.port} · phobosPictures IS DEFAULT LOCAL STORAGE · GALLERY IN HEADER
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({ status, onConfigure }: {
  status: ServiceStatus;
  onConfigure: () => void;
}) {
  const meta  = SERVICE_META[status.name];
  const Icon  = meta.icon;

  const stateColor = status.state === 'running' ? '#10b981'
    : status.state === 'starting' ? '#f59e0b'
    : status.state === 'error'    ? '#ef4444'
    : 'hsl(var(--secondary))';

  const stateLabel = status.state === 'running' ? 'RUNNING'
    : status.state === 'starting' ? 'STARTING'
    : status.state === 'error'    ? 'ERROR'
    : status.binaryPresent        ? 'INSTALLED'
    : 'NOT INSTALLED';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 20, padding: '20px 24px',
      borderBottom: `1px solid ${colors.borderLo}`,
      cursor: meta.implemented ? 'pointer' : 'default', transition: 'background .15s',
    }}
      onClick={meta.implemented ? onConfigure : undefined}
      onMouseEnter={e => { if (meta.implemented) e.currentTarget.style.background = 'hsl(var(--card))'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      <div style={{ width: 64, height: 64, borderRadius: 10, flexShrink: 0,
        background: `${meta.accent}10`, border: `1px solid ${meta.accent}25`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: meta.implemented ? 1 : .4 }}>
        <Icon className="w-4 h-4" style={{ color: meta.accent }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ ...mono, fontSize: 22, fontWeight: 600, color: meta.implemented ? colors.text : colors.muted }}>
            {meta.label}
          </span>
          {!meta.implemented && (
            <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.1em' }}>COMING SOON</span>
          )}
        </div>
        <div style={{ ...mono, fontSize: 18, color: colors.muted }}>{meta.description}</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: stateColor,
            boxShadow: status.state === 'running' ? `0 0 8px ${stateColor}` : 'none' }} />
          <span style={{ ...mono, fontSize: 16, color: stateColor, letterSpacing: '.08em' }}>{stateLabel}</span>
        </div>
        {meta.implemented && <ChevronRight size={22} color={colors.dim} />}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface Props { onClose: () => void }

export function MediaHubPanel({ onClose }: Props) {
  const { data, loading, refresh } = useAllServices();
  const [configuring, setConfiguring] = useState<ServiceName | null>(null);

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9400,
        background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }} onClick={onClose}>
        <div className="phobos-mediahub-panel" style={{
          width: 960, background: colors.bg, border: `1px solid ${colors.border}`,
          borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,.8)', overflow: 'hidden',
        }} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '24px 32px', borderBottom: `1px solid ${colors.border}`,
            background: 'linear-gradient(180deg,#13161b 0%,#0d0f12 100%)' }}>
            <div>
              <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: colors.text, letterSpacing: '-.01em' }}>
                Media Hub
              </div>
              <div style={{ ...mono, fontSize: 16, color: colors.muted, marginTop: 2 }}>
                Local media services — self-hosted, zero cloud
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 4 }}>
              <X size={28} />
            </button>
          </div>

          {/* Services list */}
          {loading && (
            <div style={{ padding: '24px 18px', display: 'flex', alignItems: 'center', gap: 10, color: colors.muted }}>
              <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ ...mono, fontSize: 20 }}>Checking services…</span>
            </div>
          )}

          {!loading && data && SERVICE_ORDER.map(name => (
            <ServiceCard
              key={name}
              status={data[name]}
              onConfigure={() => setConfiguring(name)}
            />
          ))}

          {/* Footer */}
          <div style={{ padding: '18px 32px', borderTop: `1px solid ${colors.borderLo}` }}>
            <span style={{ ...mono, fontSize: 16, color: colors.dim, letterSpacing: '.08em' }}>
              ALL SERVICES RUN LOCALLY · NO DATA LEAVES YOUR MACHINE
            </span>
          </div>
        </div>
      </div>

      {/* Polaris config panel */}
      {configuring === 'polaris' && data && (
        <PolarisPanel
          status={data.polaris}
          onClose={() => setConfiguring(null)}
          onRefresh={refresh}
        />
      )}

      {/* Kavita config panel */}
      {configuring === 'jellyfin' && data && (
        <JellyfinPanel
          status={data.jellyfin}
          onClose={() => setConfiguring(null)}
          onRefresh={refresh}
        />
      )}

      {configuring === 'kavita' && data && (
        <KavitaPanel
          status={data.kavita}
          onClose={() => setConfiguring(null)}
          onRefresh={refresh}
        />
      )}

      {/* Meridian settings panel */}
      {configuring === 'meridian' && data && (
        <MeridianPanel
          status={data.meridian}
          onClose={() => setConfiguring(null)}
          onRefresh={refresh}
        />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
