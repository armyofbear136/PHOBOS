/**
 * FriendsPanel.tsx — Full-height friends overlay for the desktop app.
 *
 * Slides in from the left edge, below the HeaderBar (top: 40px).
 * Renders via createPortal at z-index 9999 (matches CreateDropdown).
 * Scrim behind panel at z-index 9998.
 *
 * Content: FRIENDS · ACCESS · WORLD · WECLONE tabs.
 * Adapted from mobile FriendsDrawer — same data, same visual language,
 * wider layout (360px fixed), taller content areas.
 *
 * CHAT tab shows friend list only. Opening a conversation calls
 * openDockedChat() and closes this panel — the dock is the only chat surface.
 *
 * All data is stub. Wire to GET /api/social/friends when backend is ready.
 */

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, type FriendTone } from '@/store/useAppStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabId = 'friends' | 'access' | 'world' | 'weclone';

interface Friend {
  id:         string;
  name:       string;
  tone:       FriendTone;
  online:     boolean;
  phobos:     boolean;
  preview:    string;
  ts:         string;
  unread:     number;
  lastActive: string;
}

interface AccessEntry {
  id:         string;
  name:       string;
  tone:       FriendTone;
  level:      'VIEWER' | 'OPERATOR' | 'TRUSTED';
  lastActive: string;
  perms:      { COPILOT: boolean; ARCHIVE: boolean; TASKS: boolean };
}

interface WorldVisitor {
  id:     string;
  name:   string;
  tone:   FriendTone;
  sector: string;
  status: string;
}

interface WorldVisit {
  id:     string;
  world:  string;
  friend: string;
  tone:   FriendTone;
  count:  number;
}

interface WeClone {
  id:        string;
  name:      string;
  tone:      FriendTone;
  state:     'ONLINE' | 'TRAINING' | 'OFFLINE';
  persona:   string;
  sync?:     string;
  version?:  string;
  progress?: number;
}

// ── Stub data (mirrors mobile FriendsDrawer) ──────────────────────────────────

const FRIENDS: Friend[] = [
  { id: 'f1', name: 'kaelin.r',    tone: 'sayon',  online: true,  phobos: true,  preview: 'pushed the TURN config — try it now',          ts: '2m',  unread: 3, lastActive: '2M AGO'  },
  { id: 'f2', name: 'mira_void',   tone: 'seren',  online: true,  phobos: true,  preview: 'crystal engine logs look clean. 0 leaks.',      ts: '14m', unread: 0, lastActive: '14M AGO' },
  { id: 'f3', name: 'orson.exe',   tone: 'green',  online: false, phobos: false, preview: 'will check the latency thing tomorrow',         ts: '3h',  unread: 0, lastActive: '3H AGO'  },
  { id: 'f4', name: 'tessera_q',   tone: 'amber',  online: true,  phobos: true,  preview: 'sending you the atteshi LoRA, ~600MB',          ts: '1h',  unread: 1, lastActive: '1H AGO'  },
  { id: 'f5', name: 'silentnoise', tone: 'sayon',  online: false, phobos: true,  preview: 'good night',                                   ts: '8h',  unread: 0, lastActive: '8H AGO'  },
  { id: 'f6', name: 'glasshart',   tone: 'green',  online: false, phobos: false, preview: 'thx for the writeup. clean.',                   ts: '2d',  unread: 0, lastActive: '2D AGO'  },
];

const ACCESS_LIST: AccessEntry[] = [
  { id: 'a1', name: 'kaelin.r',  tone: 'sayon', level: 'TRUSTED',  lastActive: '2H AGO',  perms: { COPILOT: true,  ARCHIVE: true,  TASKS: true  } },
  { id: 'a2', name: 'mira_void', tone: 'seren', level: 'OPERATOR', lastActive: '14M AGO', perms: { COPILOT: true,  ARCHIVE: true,  TASKS: false } },
  { id: 'a3', name: 'tessera_q', tone: 'amber', level: 'VIEWER',   lastActive: '1D AGO',  perms: { COPILOT: true,  ARCHIVE: false, TASKS: false } },
];

const WORLD_VISITORS: WorldVisitor[] = [
  { id: 'v1', name: 'kaelin.r',  tone: 'sayon', sector: '4,7', status: 'PLAYING' },
  { id: 'v2', name: 'mira_void', tone: 'seren', sector: '1,2', status: 'VIEWING' },
];

const WORLD_VISITS: WorldVisit[] = [
  { id: 'w1', world: 'GREENHOUSE PROTOCOL', friend: 'kaelin.r',  tone: 'sayon', count: 4 },
  { id: 'w2', world: 'ARCHIVE OF MIRRORS',  friend: 'mira_void', tone: 'seren', count: 2 },
  { id: 'w3', world: 'NULL CATHEDRAL',      friend: 'orson.exe', tone: 'green', count: 1 },
];

const WECLONES: WeClone[] = [
  { id: 'wc1', name: 'kaelin.r',  tone: 'sayon', state: 'ONLINE',   persona: 'Responds in depth to technical questions. Knows your project history.',       sync: '4H AGO', version: 'v0.4.1' },
  { id: 'wc2', name: 'mira_void', tone: 'seren', state: 'TRAINING', persona: 'Reflective and slow to commit. Will not answer about ongoing work.',          progress: 0.67 },
  { id: 'wc3', name: 'orson.exe', tone: 'green', state: 'OFFLINE',  persona: 'Casual. Knows your meme history. Bad at code review on purpose.' },
];

const ACCESS_LEVEL_META: Record<string, { color: string; note: string }> = {
  VIEWER:   { color: 'rgba(136,136,128,0.7)',          note: 'Read conversation history' },
  OPERATOR: { color: 'var(--sayon)',                   note: 'Send queries · read history' },
  TRUSTED:  { color: 'hsl(var(--phob-amber))',         note: 'Run tasks · access files · all of the above' },
};

// ── Tone helper ───────────────────────────────────────────────────────────────

function toneVar(tone: FriendTone): string {
  if (tone === 'sayon') return 'var(--sayon)';
  if (tone === 'seren') return 'var(--seren)';
  if (tone === 'amber') return 'hsl(var(--phob-amber))';
  return 'hsl(var(--phob-orange))';
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

function FAvatar({ tone, online = false, size = 28 }: { tone: FriendTone; online?: boolean; size?: number }) {
  const color = toneVar(tone);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color, fontFamily: 'var(--font-mono, monospace)', fontSize: size * 0.38, opacity: 0.75 }}>◈</span>
      </div>
      <span style={{
        position: 'absolute', right: -1, bottom: -1,
        width: 8, height: 8, borderRadius: '50%',
        background: online ? 'hsl(var(--phob-green))' : 'rgba(136,136,128,0.3)',
        boxShadow: online ? '0 0 4px hsl(var(--phob-green))' : 'none',
        border: '1px solid #080808',
      }} />
    </div>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 6px',
      border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
      background: `color-mix(in srgb, ${color} 8%, transparent)`,
      color,
      fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.18em',
    }}>{children}</span>
  );
}

// ── Tab content — Friends ─────────────────────────────────────────────────────

function FriendsTab({ onOpenChat }: { onOpenChat: (f: Friend) => void }) {
  return (
    <div className="no-scrollbar" style={{ height: '100%', overflowY: 'auto', padding: '6px 0' }}>
      {FRIENDS.map((f) => {
        const color = toneVar(f.tone);
        return (
          <button
            key={f.id}
            onClick={() => onOpenChat(f)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid rgba(232,66,10,0.12)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 120ms ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = `color-mix(in srgb, ${color} 6%, transparent)`)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <FAvatar tone={f.tone} online={f.online} size={30} />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'hsl(var(--phob-white) / 0.85)', letterSpacing: '0.04em' }}>
                  {f.name}
                </span>
                {f.phobos && (
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'hsl(var(--phob-amber) / 0.7)', letterSpacing: '0.15em' }}>
                    ◈ PHOBOS
                  </span>
                )}
              </div>
              <p style={{
                fontFamily: 'var(--font-sans, sans-serif)', fontSize: 10,
                color: 'rgba(136,136,128,0.6)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                margin: 0, marginTop: 2,
              }}>
                {f.preview}
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.4)' }}>{f.ts}</span>
              {f.unread > 0 && (
                <div style={{
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'hsl(var(--phob-orange))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-mono, monospace)', fontSize: 8, fontWeight: 700, color: '#000',
                }}>
                  {f.unread}
                </div>
              )}
            </div>
          </button>
        );
      })}

      {/* Add friend strip */}
      <div style={{ padding: '10px 12px', borderTop: '1px dashed rgba(232,66,10,0.15)', marginTop: 4 }}>
        <button style={{
          width: '100%', padding: '6px 10px',
          background: 'transparent',
          border: '1px solid hsl(var(--phob-orange) / 0.2)',
          color: 'hsl(var(--phob-orange) / 0.55)',
          fontFamily: 'var(--font-mono, monospace)', fontSize: 9, letterSpacing: '0.2em',
          cursor: 'pointer', transition: 'all 150ms ease',
        }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'hsl(var(--phob-orange) / 0.5)';
            e.currentTarget.style.color = 'hsl(var(--phob-orange) / 0.9)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'hsl(var(--phob-orange) / 0.2)';
            e.currentTarget.style.color = 'hsl(var(--phob-orange) / 0.55)';
          }}
        >
          + ADD FRIEND — ENTER PH1.FRD CODE
        </button>
      </div>
    </div>
  );
}

// ── Tab content — Access ──────────────────────────────────────────────────────
//
// Three sections:
//   1. Your Phobos ID — name entry gate, then copyable code
//   2. Add / known servers — list of added instances, click online ones to browse users
//   3. Inbound friend requests — pending requests waiting for response

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface MyId {
  instanceId:   string;
  relayAddress: string;
  coreName:     string | null;
}

interface KnownInstance {
  instanceUuid: string;
  relayAddress: string;
  label:        string | null;
  friended:     boolean;
  addedAt:      number;
  online:       boolean;
}

interface RemoteUser {
  username:    string;
  displayName: string;
}

interface PendingRequest {
  id:                string;
  from_instance_id:  string;
  from_username:     string;
  from_display_name: string;
  received_at:       number;
  expires_at:        number;
}

function AccessTab() {
  const [myId, setMyId]               = useState<MyId | null>(null);
  const [nameInput, setNameInput]     = useState('');
  const [nameSaving, setNameSaving]   = useState(false);
  const [servers, setServers]         = useState<KnownInstance[]>([]);
  const [addInput, setAddInput]       = useState('');
  const [addLabel, setAddLabel]       = useState('');
  const [addError, setAddError]       = useState('');
  const [addLoading, setAddLoading]   = useState(false);
  const [expanded, setExpanded]       = useState<string | null>(null);
  const [remoteUsers, setRemoteUsers] = useState<Record<string, RemoteUser[] | 'loading' | 'error'>>({});
  const [pendingReqs, setPendingReqs] = useState<PendingRequest[]>([]);
  const [responding, setResponding]   = useState<string | null>(null);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/social/my-id`)
      .then(r => r.ok ? r.json() : null)
      .then((data: MyId | null) => { if (data) setMyId(data); })
      .catch(() => {});
    void loadServers();
    void loadPending();
  }, []);

  async function loadServers() {
    try {
      const r = await fetch(`${ENGINE_URL}/api/social/discovery`);
      if (r.ok) {
        const data = await r.json() as { instances: KnownInstance[] };
        setServers(data.instances);
      }
    } catch {}
  }

  async function loadPending() {
    try {
      const r = await fetch(`${ENGINE_URL}/api/social/friend-requests/pending`);
      if (r.ok) {
        const data = await r.json() as { requests: PendingRequest[] };
        setPendingReqs(data.requests);
      }
    } catch {}
  }

  async function saveName() {
    if (!nameInput.trim()) return;
    setNameSaving(true);
    try {
      const r = await fetch(`${ENGINE_URL}/api/social/core-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.trim() }),
      });
      if (r.ok) {
        const data = await r.json() as { coreName: string };
        setMyId(prev => prev ? { ...prev, coreName: data.coreName } : prev);
        setNameInput('');
      }
    } catch {}
    setNameSaving(false);
  }

  async function addServer() {
    if (!addInput.trim()) return;
    setAddError('');
    setAddLoading(true);
    const parts = addInput.trim().split('|');
    if (parts.length < 2) {
      setAddError('INVALID FORMAT · PASTE A PHOBOS ID CODE');
      setAddLoading(false);
      return;
    }
    const label        = addLabel.trim() || parts[0] || null;
    const instanceUuid = parts[1];
    const relayAddress = parts[2] ?? '';
    try {
      const r = await fetch(`${ENGINE_URL}/api/social/discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceUuid, relayAddress, label }),
      });
      if (r.ok) {
        setAddInput(''); setAddLabel('');
        await loadServers();
      } else {
        const err = await r.json() as { error: string };
        setAddError(err.error.toUpperCase().replace(/_/g, ' '));
      }
    } catch { setAddError('REQUEST FAILED'); }
    setAddLoading(false);
  }

  async function removeServer(instanceUuid: string) {
    try {
      await fetch(`${ENGINE_URL}/api/social/discovery/${instanceUuid}`, { method: 'DELETE' });
      setServers(prev => prev.filter(s => s.instanceUuid !== instanceUuid));
      if (expanded === instanceUuid) setExpanded(null);
    } catch {}
  }

  async function toggleExpand(s: KnownInstance) {
    if (expanded === s.instanceUuid) { setExpanded(null); return; }
    setExpanded(s.instanceUuid);
    if (remoteUsers[s.instanceUuid]) return;
    setRemoteUsers(prev => ({ ...prev, [s.instanceUuid]: 'loading' }));
    try {
      const r = await fetch(`${ENGINE_URL}/api/social/users/${s.instanceUuid}`);
      if (r.ok) {
        const data = await r.json() as { users: RemoteUser[] };
        setRemoteUsers(prev => ({ ...prev, [s.instanceUuid]: data.users }));
      } else {
        setRemoteUsers(prev => ({ ...prev, [s.instanceUuid]: 'error' }));
      }
    } catch { setRemoteUsers(prev => ({ ...prev, [s.instanceUuid]: 'error' })); }
  }

  async function sendFriendRequest(instanceUuid: string) {
    try {
      await fetch(`${ENGINE_URL}/api/social/friend-request/${instanceUuid}`, { method: 'POST' });
      await loadServers();
    } catch {}
  }

  async function respond(id: string, decision: 'accept' | 'decline') {
    setResponding(id);
    try {
      await fetch(`${ENGINE_URL}/api/social/friend-requests/${id}/${decision}`, { method: 'POST' });
      await loadPending();
    } catch {}
    setResponding(null);
  }

  const btn = (color = 'hsl(var(--phob-orange))', dim = false): React.CSSProperties => ({
    padding: '5px 10px', background: 'transparent', cursor: 'pointer',
    border: `1px solid color-mix(in srgb, ${color} ${dim ? 25 : 45}%, transparent)`,
    color: `color-mix(in srgb, ${color} ${dim ? 45 : 80}%, transparent)`,
    fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.18em',
    transition: 'all 120ms ease', whiteSpace: 'nowrap' as const,
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '5px 8px', boxSizing: 'border-box',
    background: 'rgba(232,66,10,0.04)', border: '1px solid rgba(232,66,10,0.2)',
    color: 'hsl(var(--phob-orange))', fontFamily: 'var(--font-mono, monospace)', fontSize: 10,
    outline: 'none',
  };

  const sectionLabel: React.CSSProperties = {
    fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.22em',
    color: 'rgba(136,136,128,0.5)', marginBottom: 8, display: 'block',
  };

  const idCode = myId ? `${myId.coreName ?? 'UNNAMED'}|${myId.instanceId}|${myId.relayAddress}` : '';

  return (
    <div className="no-scrollbar" style={{ height: '100%', overflowY: 'auto' }}>

      {/* Section 1: Your Phobos ID */}
      <div style={{ padding: '10px 12px 10px', borderBottom: '1px solid rgba(232,66,10,0.12)' }}>
        <span style={sectionLabel}>YOUR PHOBOS ID</span>
        {!myId?.coreName ? (
          <div>
            <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9, color: 'rgba(136,136,128,0.6)', marginBottom: 8, lineHeight: 1.5 }}>
              NAME YOUR PHOBOS CORE BEFORE SHARING YOUR ID
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="CORE NAME..."
                value={nameInput} onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void saveName()} maxLength={40} />
              <button style={btn()} onClick={() => void saveName()} disabled={nameSaving || !nameInput.trim()}>
                {nameSaving ? '…' : 'SET'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13, color: 'hsl(var(--phob-orange))', letterSpacing: '0.08em', flex: 1 }}>
                {myId.coreName}
              </span>
              <button style={btn('rgba(136,136,128,0.7)', true)}
                onClick={() => setMyId(prev => prev ? { ...prev, coreName: null } : prev)}>
                RENAME
              </button>
            </div>
            <div title="Click to copy" onClick={() => void navigator.clipboard.writeText(idCode)}
              style={{
                padding: '6px 8px', background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(232,66,10,0.18)', cursor: 'pointer',
                fontFamily: 'var(--font-mono, monospace)', fontSize: 8,
                color: 'rgba(136,136,128,0.7)', letterSpacing: '0.05em',
                wordBreak: 'break-all', lineHeight: 1.6,
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(232,66,10,0.45)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(232,66,10,0.18)')}
            >
              {idCode}
              <span style={{ display: 'block', marginTop: 4, color: 'rgba(232,66,10,0.5)', fontSize: 7, letterSpacing: '0.2em' }}>
                CLICK TO COPY · SHARE WITH FRIENDS
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Add server */}
      <div style={{ padding: '10px 12px 10px', borderBottom: '1px solid rgba(232,66,10,0.12)' }}>
        <span style={sectionLabel}>ADD PHOBOS CORE</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <input style={inputStyle} placeholder="PASTE PHOBOS ID CODE..."
            value={addInput} onChange={e => { setAddInput(e.target.value); setAddError(''); }} />
          <div style={{ display: 'flex', gap: 5 }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="LOCAL NICKNAME (OPTIONAL)"
              value={addLabel} onChange={e => setAddLabel(e.target.value)} />
            <button style={btn()} onClick={() => void addServer()} disabled={addLoading || !addInput.trim()}>
              {addLoading ? '…' : 'ADD'}
            </button>
          </div>
          {addError && (
            <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(255,60,60,0.8)', letterSpacing: '0.12em' }}>
              ⚠ {addError}
            </span>
          )}
        </div>
      </div>

      {/* Section 3: Known servers */}
      {servers.length > 0 && (
        <div style={{ borderBottom: '1px solid rgba(232,66,10,0.12)' }}>
          <span style={{ ...sectionLabel, padding: '10px 12px 0', display: 'block' }}>KNOWN CORES</span>
          {servers.map(s => {
            const isOpen = expanded === s.instanceUuid;
            const users  = remoteUsers[s.instanceUuid];
            return (
              <div key={s.instanceUuid}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                  borderTop: '1px solid rgba(232,66,10,0.08)',
                  background: isOpen ? 'rgba(232,66,10,0.04)' : 'transparent',
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
                    background: s.friended ? 'hsl(var(--phob-orange))' : s.online ? 'hsl(var(--phob-green))' : 'rgba(136,136,128,0.3)',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: s.friended ? 'hsl(var(--phob-orange))' : 'rgba(200,200,195,0.85)' }}>
                      {s.label ?? s.instanceUuid.slice(0, 16) + '…'}
                    </span>
                    <span style={{ display: 'block', fontFamily: 'var(--font-mono, monospace)', fontSize: 7, color: 'rgba(136,136,128,0.4)', marginTop: 1 }}>
                      {s.friended ? '◈ FRIEND' : s.online ? 'ONLINE' : 'OFFLINE'} · {s.instanceUuid.slice(0, 12)}…
                    </span>
                  </div>
                  {s.online && !s.friended && (
                    <button style={btn('hsl(var(--phob-orange))', !isOpen)} onClick={() => void toggleExpand(s)}>
                      {isOpen ? 'CLOSE' : 'BROWSE'}
                    </button>
                  )}
                  {!s.friended && !s.online && (
                    <button style={btn('rgba(136,136,128,0.5)', true)} onClick={() => void sendFriendRequest(s.instanceUuid)}>
                      REQUEST
                    </button>
                  )}
                  {s.friended && (
                    <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(232,66,10,0.5)', letterSpacing: '0.15em' }}>FRIEND</span>
                  )}
                  <button style={{ ...btn('rgba(255,60,60,0.7)', true), padding: '5px 7px' }}
                    onClick={() => void removeServer(s.instanceUuid)}>✕</button>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 12px 10px', background: 'rgba(0,0,0,0.2)' }}>
                    {users === 'loading' && <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.5)' }}>CONNECTING…</span>}
                    {users === 'error'   && <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(255,60,60,0.7)' }}>⚠ UNREACHABLE</span>}
                    {Array.isArray(users) && users.length === 0 && <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.4)' }}>NO USERS FOUND</span>}
                    {Array.isArray(users) && users.map(u => (
                      <div key={u.username} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(232,66,10,0.08)' }}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, border: '1px solid rgba(232,66,10,0.25)', background: 'rgba(232,66,10,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(232,66,10,0.6)' }}>◈</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'rgba(200,200,195,0.85)' }}>{u.displayName}</span>
                          <span style={{ display: 'block', fontFamily: 'var(--font-mono, monospace)', fontSize: 7, color: 'rgba(136,136,128,0.4)' }}>@{u.username}</span>
                        </div>
                        <button style={btn('hsl(var(--phob-orange))')} onClick={() => void sendFriendRequest(s.instanceUuid)}>
                          + FRIEND
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Section 4: Inbound friend requests */}
      {pendingReqs.length > 0 && (
        <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid rgba(232,66,10,0.12)' }}>
          <span style={sectionLabel}>FRIEND REQUESTS</span>
          {pendingReqs.map(req => (
            <div key={req.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(232,66,10,0.08)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, border: '1px solid rgba(232,66,10,0.3)', background: 'rgba(232,66,10,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9, color: 'rgba(232,66,10,0.6)' }}>◈</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'rgba(200,200,195,0.85)' }}>{req.from_display_name}</span>
                  <span style={{ display: 'block', fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.45)', marginTop: 1 }}>
                    @{req.from_username} · {req.from_instance_id.slice(0, 12)}…
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={{ ...btn('hsl(var(--phob-orange))'), flex: 1 }}
                  disabled={responding === req.id} onClick={() => void respond(req.id, 'accept')}>
                  {responding === req.id ? '…' : 'ACCEPT'}
                </button>
                <button style={{ ...btn('rgba(255,60,60,0.7)'), flex: 1 }}
                  disabled={responding === req.id} onClick={() => void respond(req.id, 'decline')}>
                  DECLINE
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {servers.length === 0 && pendingReqs.length === 0 && myId?.coreName && (
        <div style={{ padding: '20px 12px', textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.35)', letterSpacing: '0.18em', lineHeight: 1.8 }}>
            COPY YOUR PHOBOS ID AND SHARE IT<br />TO START ADDING FRIENDS
          </p>
        </div>
      )}
    </div>
  );
}

// ── Tab content — World ───────────────────────────────────────────────────────

function WorldTab() {
  return (
    <div className="no-scrollbar" style={{ height: '100%', overflowY: 'auto', padding: '8px 12px' }}>
      {/* Visitors here */}
      <div style={{ marginBottom: 14 }}>
        <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.22em', color: 'rgba(136,136,128,0.5)', marginBottom: 8 }}>
          VISITING YOUR WORLD
        </p>
        {WORLD_VISITORS.map((v) => {
          const color = toneVar(v.tone);
          return (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <FAvatar tone={v.tone} online size={26} />
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'hsl(var(--phob-white) / 0.8)', flex: 1 }}>{v.name}</span>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.4)' }}>SECTOR {v.sector}</span>
              <Pill color={color}>{v.status}</Pill>
            </div>
          );
        })}
      </div>

      {/* Your visits */}
      <div style={{ borderTop: '1px dashed rgba(232,66,10,0.15)', paddingTop: 12 }}>
        <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.22em', color: 'rgba(136,136,128,0.5)', marginBottom: 8 }}>
          YOUR VISITS
        </p>
        {WORLD_VISITS.map((w) => {
          const color = toneVar(w.tone);
          return (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 18, color: `color-mix(in srgb, ${color} 40%, transparent)` }}>◉</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9, color: 'hsl(var(--phob-white) / 0.75)', letterSpacing: '0.08em', margin: 0 }}>{w.world}</p>
                <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: `color-mix(in srgb, ${color} 65%, transparent)`, margin: 0, marginTop: 2 }}>via {w.friend}</p>
              </div>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.4)' }}>{w.count}×</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tab content — WeClone ─────────────────────────────────────────────────────

function WeCloneTab() {
  return (
    <div className="no-scrollbar" style={{ height: '100%', overflowY: 'auto', padding: '6px 0' }}>
      {/* Safety strip */}
      <div style={{
        padding: '6px 12px', marginBottom: 4,
        background: 'rgba(255,60,60,0.06)',
        borderBottom: '1px solid rgba(255,60,60,0.3)',
        color: 'rgba(255,60,60,0.8)',
        fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.15em',
        textAlign: 'center',
      }}>
        ⚠ RESPONSES GENERATED BY AI CLONE · NOT A REAL PERSON
      </div>

      {WECLONES.map((w) => {
        const stateColor = w.state === 'ONLINE'
          ? 'var(--seren)'
          : w.state === 'TRAINING'
            ? 'hsl(var(--phob-amber))'
            : 'rgba(136,136,128,0.5)';
        const color = toneVar(w.tone);
        return (
          <div key={w.id} style={{
            padding: '10px 12px',
            borderBottom: '1px solid rgba(232,66,10,0.12)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <FAvatar tone={w.tone} online={w.state === 'ONLINE'} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'hsl(var(--foreground) / 0.85)' }}>{w.name}</span>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'var(--seren)', letterSpacing: '0.18em' }}>·WECLONE</span>
                </div>
                <Pill color={stateColor}>● {w.state}</Pill>
              </div>
            </div>

            <div style={{
              marginTop: 8, padding: '5px 8px',
              background: 'rgba(232,66,10,0.03)', border: '1px dashed rgba(232,66,10,0.15)',
              color: 'rgba(136,136,128,0.65)',
              fontFamily: 'var(--font-sans, sans-serif)', fontSize: 10,
              fontStyle: 'italic', lineHeight: 1.5,
            }}>
              "{w.persona}"
            </div>

            {w.state === 'ONLINE' && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'rgba(136,136,128,0.4)' }}>LAST SYNC · {w.sync}</span>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'hsl(var(--phob-amber) / 0.7)' }}>◈ PHOBOS {w.version}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button style={{ flex: 1, padding: '5px 8px', background: `color-mix(in srgb, var(--seren) 10%, transparent)`, border: `1px solid color-mix(in srgb, var(--seren) 50%, transparent)`, color: 'var(--seren)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.2em', cursor: 'pointer' }}>CHAT</button>
                  <button style={{ flex: 1, padding: '5px 8px', background: 'transparent', border: `1px solid color-mix(in srgb, var(--seren) 30%, transparent)`, color: `color-mix(in srgb, var(--seren) 55%, transparent)`, fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.2em', cursor: 'pointer' }}>CALL</button>
                </div>
              </>
            )}

            {w.state === 'TRAINING' && w.progress !== undefined && (
              <div style={{ marginTop: 8 }}>
                <div style={{ height: 4, background: 'rgba(136,136,128,0.15)', borderRadius: 0 }}>
                  <div style={{ height: '100%', width: `${w.progress * 100}%`, background: 'hsl(var(--phob-amber))', transition: 'width 1s ease' }} />
                </div>
                <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 8, color: 'hsl(var(--phob-amber) / 0.7)', marginTop: 4, display: 'block' }}>
                  TRAINING · {Math.round(w.progress * 100)}% — EST. {Math.round((1 - w.progress) * 8)}H REMAINING
                </span>
              </div>
            )}

            {w.state === 'OFFLINE' && (
              <div style={{ marginTop: 8, padding: '4px 8px', border: '1px solid rgba(136,136,128,0.2)', color: 'rgba(136,136,128,0.45)', fontFamily: 'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.15em' }}>
                WECLONE OFFLINE · HOST UNREACHABLE
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; color: string }[] = [
  { id: 'friends', label: 'FRIENDS', color: 'hsl(var(--phob-orange))' },
  { id: 'access',  label: 'ACCESS',  color: 'hsl(var(--phob-amber))' },
  { id: 'world',   label: 'WORLD',   color: 'var(--sayon)' },
  { id: 'weclone', label: 'WECLONE', color: 'var(--seren)' },
];

// ── FriendsPanel ──────────────────────────────────────────────────────────────

export function FriendsPanel() {
  const friendsPanelOpen    = useAppStore((s) => s.friendsPanelOpen);
  const setFriendsPanelOpen = useAppStore((s) => s.setFriendsPanelOpen);
  const openDockedChat      = useAppStore((s) => s.openDockedChat);

  const [tab, setTab] = useState<TabId>('friends');

  // Mounted state — keep alive during 220ms exit animation
  const [mounted, setMounted] = useState(false);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (friendsPanelOpen) {
      setMounted(true);
      if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
    } else {
      unmountTimerRef.current = setTimeout(() => setMounted(false), 240);
    }
    return () => { if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current); };
  }, [friendsPanelOpen]);

  if (!mounted && !friendsPanelOpen) return null;

  const handleOpenChat = (f: Friend) => {
    openDockedChat(f.id, f.name, f.tone);
    setFriendsPanelOpen(false);
  };

  const panel = (
    <>
      {/* Scrim */}
      <div
        onClick={() => setFriendsPanelOpen(false)}
        style={{
          position:       'fixed',
          top:            40,
          left:           0,
          right:          0,
          bottom:         0,
          background:     friendsPanelOpen ? 'rgba(0,0,0,0.55)' : 'transparent',
          transition:     'background 220ms ease-out',
          zIndex:         9998,
          pointerEvents:  friendsPanelOpen ? 'auto' : 'none',
        }}
      />

      {/* Panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="phob-chrome-zone"
        style={{
          position:   'fixed',
          top:        40,
          left:       0,
          width:      360,
          bottom:     0,
          background: '#080808',
          border:     '1px solid rgba(232,66,10,0.30)',
          borderLeft: 'none',
          boxShadow:  '4px 0 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(232,66,10,0.08)',
          display:    'flex',
          flexDirection: 'column',
          overflow:   'hidden',
          zIndex:     9999,
          transform:  friendsPanelOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: friendsPanelOpen
            ? 'transform 220ms cubic-bezier(0.25, 0.46, 0.45, 0.94)'
            : 'transform 180ms cubic-bezier(0.55, 0, 1, 0.45)',
        }}
      >
        {/* Header */}
        <div style={{
          padding:        '10px 12px 8px',
          borderBottom:   '1px solid rgba(232,66,10,0.20)',
          display:        'flex',
          alignItems:     'center',
          gap:            8,
          background:     'rgba(232,66,10,0.04)',
          flexShrink:     0,
        }}>
          <span style={{ color: 'hsl(var(--phob-orange))', fontFamily: 'var(--font-mono, monospace)', fontSize: 14, textShadow: '0 0 6px rgba(232,66,10,0.5)', lineHeight: 1 }}>◉</span>
          <span style={{ color: 'hsl(var(--phob-orange))', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, letterSpacing: '0.22em' }}>FRIENDS</span>
          <span style={{ flex: 1, color: 'rgba(136,136,128,0.5)', fontFamily: 'var(--font-mono, monospace)', fontSize: 9, letterSpacing: '0.22em' }}>PHOBOS NETWORK</span>
          <button
            onClick={() => setFriendsPanelOpen(false)}
            style={{
              width: 24, height: 24, padding: 0,
              background: 'transparent', border: '1px solid rgba(232,66,10,0.2)',
              color: 'rgba(136,136,128,0.6)', cursor: 'pointer',
              fontFamily: 'var(--font-mono, monospace)', fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(232,66,10,0.15)', flexShrink: 0 }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  flex:         1,
                  padding:      '7px 4px',
                  background:   active ? `color-mix(in srgb, ${t.color} 10%, transparent)` : 'transparent',
                  border:       'none',
                  borderBottom: `2px solid ${active ? t.color : 'transparent'}`,
                  color:        active ? t.color : 'rgba(136,136,128,0.5)',
                  fontFamily:   'var(--font-mono, monospace)', fontSize: 8, letterSpacing: '0.2em',
                  cursor:       'pointer',
                  textShadow:   active ? `0 0 4px color-mix(in srgb, ${t.color} 50%, transparent)` : 'none',
                  transition:   'all 120ms ease',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {tab === 'friends' && <FriendsTab onOpenChat={handleOpenChat} />}
          {tab === 'access'  && <AccessTab />}
          {tab === 'world'   && <WorldTab />}
          {tab === 'weclone' && <WeCloneTab />}
        </div>
      </div>
    </>
  );

  return createPortal(panel, document.body);
}
