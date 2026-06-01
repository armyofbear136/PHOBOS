/**
 * ChatDockColumn.tsx — Permanent 44px column left of the Sidebar.
 *
 * Always rendered. Houses scroll controls and 3 visible conversation slot tabs.
 * Visible slot count adapts to window height:
 *   ≥ 600px → 3 slots
 *   ≥ 430px → 2 slots
 *   <  430px → 1 slot
 *
 * Left edge glows when the Friends Panel is closed, signaling the hover trigger.
 * Tab labels are written vertically (bottom-to-top) like a notebook spine.
 */

import { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore, type FriendTone } from '@/store/useAppStore';

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTROLS_H = 34; // px — scroll controls strip height (always rendered)
const GAP        =  2; // px — gap between slot areas
const HEADER_H   = 40; // px — HeaderBar h-10

function visibleSlotCount(windowH: number): number {
  const available = windowH - HEADER_H - CONTROLS_H;
  if (available >= 430) return 3;
  if (available >= 215) return 2;
  return 1;
}

function slotHeight(windowH: number, slots: number): number {
  const available = windowH - HEADER_H - CONTROLS_H;
  return Math.floor((available - GAP * (slots - 1)) / slots);
}

// ── Tone helpers ──────────────────────────────────────────────────────────────

function toneVar(tone: FriendTone): string {
  if (tone === 'sayon') return 'var(--sayon)';
  if (tone === 'seren') return 'var(--seren)';
  if (tone === 'amber') return 'hsl(var(--phob-amber))';
  return 'hsl(var(--phob-orange))';
}

// ── EmptySlot ─────────────────────────────────────────────────────────────────

function EmptySlot({ height }: { height: number }) {
  return (
    <div
      style={{
        height,
        flexShrink: 0,
        border: '1px dashed rgba(232,66,10,0.12)',
        background: 'transparent',
      }}
    />
  );
}

// ── PopulatedSlot ─────────────────────────────────────────────────────────────

interface PopulatedSlotProps {
  friendId:    string;
  displayName: string;
  tone:        FriendTone;
  minimized:   boolean;
  unread:      number;
  height:      number;
}

function PopulatedSlot({ friendId, displayName, tone, minimized, unread, height }: PopulatedSlotProps) {
  const expandDockedChat   = useAppStore((s) => s.expandDockedChat);
  const minimizeDockedChat = useAppStore((s) => s.minimizeDockedChat);
  const [hovered, setHovered] = useState(false);

  const color    = toneVar(tone);
  const isActive = !minimized;

  const handleClick = () => {
    if (minimized) {
      expandDockedChat(friendId);
    } else {
      minimizeDockedChat(friendId);
    }
  };

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position:   'relative',
        height,
        flexShrink: 0,
        background: isActive ? `color-mix(in srgb, ${color} 10%, transparent)` : `color-mix(in srgb, ${color} 5%, transparent)`,
        border:     `1px solid color-mix(in srgb, ${color} ${isActive ? 40 : 25}%, transparent)`,
        borderLeft: `2px solid ${isActive ? color : `color-mix(in srgb, ${color} 40%, transparent)`}`,
        cursor:     'pointer',
        transition: 'all 150ms ease',
        boxShadow:  hovered ? `0 0 8px color-mix(in srgb, ${color} 30%, transparent)` : 'none',
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow:   'hidden',
      }}
    >
      {/* Rotated name label — reads bottom-to-top */}
      <span
        style={{
          writingMode:     'vertical-rl',
          textOrientation: 'mixed',
          transform:       'rotate(180deg)',
          fontFamily:      'var(--font-mono, monospace)',
          fontSize:        9,
          letterSpacing:   '0.18em',
          textTransform:   'uppercase',
          color:           `color-mix(in srgb, ${color} ${isActive ? 80 : 55}%, transparent)`,
          textShadow:      isActive ? `0 0 4px color-mix(in srgb, ${color} 40%, transparent)` : 'none',
          userSelect:      'none',
          maxHeight:       height - 28,
          overflow:        'hidden',
        }}
      >
        {displayName}
      </span>

      {/* Unread badge */}
      {unread > 0 && (
        <div
          style={{
            position:    'absolute',
            bottom:      6,
            left:        '50%',
            transform:   'translateX(-50%)',
            width:       16,
            height:      16,
            borderRadius: '50%',
            background:  'hsl(var(--phob-orange))',
            display:     'flex',
            alignItems:  'center',
            justifyContent: 'center',
            fontFamily:  'var(--font-mono, monospace)',
            fontSize:    8,
            fontWeight:  700,
            color:       '#000',
          }}
        >
          {unread > 9 ? '9+' : unread}
        </div>
      )}
    </div>
  );
}

// ── ChatDockColumn ────────────────────────────────────────────────────────────

export function ChatDockColumn() {
  const friendsPanelOpen = useAppStore((s) => s.friendsPanelOpen);
  const dockedChats      = useAppStore((s) => s.dockedChats);
  const dockScrollOffset = useAppStore((s) => s.dockScrollOffset);
  const scrollDockUp     = useAppStore((s) => s.scrollDockUp);
  const scrollDockDown   = useAppStore((s) => s.scrollDockDown);

  const [windowH, setWindowH] = useState(() => window.innerHeight);

  useEffect(() => {
    const onResize = () => setWindowH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const slots    = visibleSlotCount(windowH);
  const slotH    = slotHeight(windowH, slots);
  const visible  = dockedChats.slice(dockScrollOffset, dockScrollOffset + slots);
  const overflow = Math.max(0, dockedChats.length - slots);
  const canUp    = dockScrollOffset > 0;
  const canDown  = dockScrollOffset < Math.max(0, dockedChats.length - slots);

  // Left-edge glow pulse — only when Friends Panel is closed
  const glowStyle = friendsPanelOpen
    ? {}
    : {
        borderLeft:   'none',
        boxShadow:    'none',
        animation:    'none',
      };

  return (
    <>
      {/* Keyframe for edge pulse */}
      <style>{`
        @keyframes phobos-dock-pulse {
          from { box-shadow: inset 3px 0 8px hsl(var(--phob-orange) / 0.06); }
          to   { box-shadow: inset 3px 0 12px hsl(var(--phob-orange) / 0.14); }
        }
        .phobos-dock-glow {
          border-left: 1px solid hsl(var(--phob-orange) / 0.25);
          animation: phobos-dock-pulse 3s ease-in-out infinite alternate;
        }
        .phobos-dock-glow-off {
          border-left: 1px solid transparent;
        }
      `}</style>

      <aside
        className={`phob-chrome-zone shrink-0 flex flex-col bg-[#080808] border-r border-phob-orange/20 ${
          friendsPanelOpen ? 'phobos-dock-glow-off' : 'phobos-dock-glow'
        }`}
        style={{ width: 44, height: '100%' }}
      >
        {/* Scroll controls strip — always 34px */}
        <div
          style={{
            height:         CONTROLS_H,
            flexShrink:     0,
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            gap:            2,
            borderBottom:   '1px solid rgba(232,66,10,0.15)',
          }}
        >
          <button
            onClick={scrollDockUp}
            disabled={!canUp}
            style={{
              background: 'transparent',
              border:     'none',
              padding:    '1px 0',
              cursor:     canUp ? 'pointer' : 'default',
              color:      canUp
                ? 'hsl(var(--phob-orange) / 0.7)'
                : 'rgba(136,136,128,0.2)',
              display:    'flex',
              alignItems: 'center',
            }}
          >
            <ChevronUp className="w-3 h-3" />
          </button>

          {/* Overflow count — hidden when fits */}
          <span
            style={{
              fontFamily:  'var(--font-mono, monospace)',
              fontSize:    8,
              color:       overflow > 0
                ? 'hsl(var(--phob-orange) / 0.7)'
                : 'transparent',
              letterSpacing: '0.05em',
              lineHeight:  1,
              minHeight:   10,
              userSelect:  'none',
            }}
          >
            {overflow > 0 ? overflow : ''}
          </span>

          <button
            onClick={scrollDockDown}
            disabled={!canDown}
            style={{
              background: 'transparent',
              border:     'none',
              padding:    '1px 0',
              cursor:     canDown ? 'pointer' : 'default',
              color:      canDown
                ? 'hsl(var(--phob-orange) / 0.7)'
                : 'rgba(136,136,128,0.2)',
              display:    'flex',
              alignItems: 'center',
            }}
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        {/* Slot area — fills remaining height */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: GAP, overflow: 'hidden' }}>
          {Array.from({ length: slots }).map((_, i) => {
            const chat = visible[i];
            if (!chat) return <EmptySlot key={`empty-${i}`} height={slotH} />;
            return (
              <PopulatedSlot
                key={chat.friendId}
                friendId={chat.friendId}
                displayName={chat.displayName}
                tone={chat.tone}
                minimized={chat.minimized}
                unread={chat.unread}
                height={slotH}
              />
            );
          })}
        </div>
      </aside>
    </>
  );
}
