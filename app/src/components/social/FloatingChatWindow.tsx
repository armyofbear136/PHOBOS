/**
 * FloatingChatWindow.tsx — Wide-aspect chat window for an open docked conversation.
 *
 * Fixed size: 340px wide × 214px tall (landscape ratio, 3 fit vertically at 720p).
 * Rendered via createPortal into document.body to escape parent overflow:hidden.
 *
 * Position is computed from slotIndex (0, 1, 2) relative to the screen:
 *   left: 268px  (44px dock + 224px sidebar)
 *   top:  40px + 34px + slotIndex × (slotH + 2px)
 *
 * Message state is local for the visual shell pass. When backend wiring happens,
 * replace localMessages with a store slice keyed by friendId.
 */

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, type DockedChat, type FriendTone } from '@/store/useAppStore';

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_W   = 340;
const HEADER_H   = 40;
const CONTROLS_H = 34;
const GAP        =  2;

// ── Tone helpers ──────────────────────────────────────────────────────────────

function toneVar(tone: FriendTone): string {
  if (tone === 'sayon') return 'var(--sayon)';
  if (tone === 'seren') return 'var(--seren)';
  if (tone === 'amber') return 'hsl(var(--phob-amber))';
  return 'hsl(var(--phob-orange))';
}

// ── Stub data (matches mobile FriendsDrawer SAMPLE_THREADS) ──────────────────

interface ChatMessage {
  from: 'me' | 'them';
  text: string;
  ts:   string;
}

const SAMPLE_THREADS: Record<string, ChatMessage[]> = {
  f1: [
    { from: 'them', text: 'so I think the symmetric NAT thing is real',                                ts: '9:42' },
    { from: 'me',   text: 'yeah it forces TURN relay every time. measured ~30% more bandwidth',        ts: '9:42' },
    { from: 'them', text: 'huh. ok pushed a config — short-lived creds + tcp/443 fallback',            ts: '9:43' },
    { from: 'them', text: 'try it now',                                                                ts: '9:43' },
    { from: 'me',   text: 'on it. routing my SAYON through the new relay',                            ts: '9:44' },
  ],
};

const FALLBACK_THREAD: ChatMessage[] = [
  { from: 'them', text: 'hey', ts: 'now' },
  { from: 'me',   text: "hi — what's up", ts: 'now' },
];

// ── FloatingChatWindow ────────────────────────────────────────────────────────

interface Props {
  chat:        DockedChat;
  slotIndex:   number; // 0, 1, or 2 — position within the visible dock window
  slotH:       number; // computed per-slot height, passed in from Index.tsx
  leftAnchor:  number; // measured right edge of sidebar in px — passed from Index.tsx
}

export function FloatingChatWindow({ chat, slotIndex, slotH, leftAnchor }: Props) {
  const minimizeDockedChat = useAppStore((s) => s.minimizeDockedChat);
  const closeDockedChat    = useAppStore((s) => s.closeDockedChat);

  const color = toneVar(chat.tone);

  const [input,    setInput]    = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => SAMPLE_THREADS[chat.friendId] ?? FALLBACK_THREAD
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setMessages((prev) => [...prev, { from: 'me', text: trimmed, ts: 'now' }]);
    setInput('');
  };

  const topOffset = HEADER_H + CONTROLS_H + slotIndex * (slotH + GAP);

  const window_ = (
    <div
      style={{
        position:  'fixed',
        top:       topOffset,
        left:      leftAnchor,
        width:     WINDOW_W,
        height:    slotH,
        zIndex:    200,
        display:   'flex',
        flexDirection: 'column',
        background: '#080808',
        border:    `2px solid color-mix(in srgb, ${color} 70%, transparent)`,
        borderLeft: `3px solid ${color}`,
        boxShadow: [
          '0 0 24px rgba(0,0,0,0.85)',
          `0 0 0 1px color-mix(in srgb, ${color} 20%, transparent)`,
          `-4px 0 16px color-mix(in srgb, ${color} 12%, transparent)`,
        ].join(', '),
      }}
      className="phob-chrome-zone"
    >
      {/* Title bar — 28px */}
      <div
        style={{
          height:         28,
          flexShrink:     0,
          display:        'flex',
          alignItems:     'center',
          gap:            6,
          padding:        '0 8px',
          borderBottom:   `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
          background:     `color-mix(in srgb, ${color} 5%, transparent)`,
        }}
      >
        {/* ◈ tone symbol */}
        <span
          style={{
            color,
            fontFamily:  'var(--font-mono, monospace)',
            fontSize:    10,
            textShadow:  `0 0 4px color-mix(in srgb, ${color} 55%, transparent)`,
            flexShrink:  0,
          }}
        >
          ◈
        </span>

        {/* Display name */}
        <span
          style={{
            fontFamily:    'var(--font-mono, monospace)',
            fontSize:      11,
            color:         'hsl(var(--phob-white) / 0.8)',
            flex:          1,
            overflow:      'hidden',
            textOverflow:  'ellipsis',
            whiteSpace:    'nowrap',
            letterSpacing: '0.04em',
          }}
        >
          {chat.displayName}
        </span>

        {/* Online indicator */}
        <span
          style={{
            fontFamily:    'var(--font-mono, monospace)',
            fontSize:      8,
            letterSpacing: '0.18em',
            color:         'hsl(var(--phob-green) / 0.7)',
            flexShrink:    0,
          }}
        >
          ● ONLINE
        </span>

        {/* Minimize */}
        <button
          onClick={() => minimizeDockedChat(chat.friendId)}
          style={{
            background: 'transparent',
            border:     'none',
            color:      'rgba(136,136,128,0.55)',
            width:      16,
            height:     16,
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor:     'pointer',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize:   9,
            flexShrink: 0,
          }}
          title="Minimize"
        >
          –
        </button>

        {/* Close */}
        <button
          onClick={() => closeDockedChat(chat.friendId)}
          style={{
            background: 'transparent',
            border:     'none',
            color:      'rgba(136,136,128,0.55)',
            width:      16,
            height:     16,
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor:     'pointer',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize:   9,
            flexShrink: 0,
          }}
          title="Close"
        >
          ✕
        </button>
      </div>

      {/* Message area — fills remaining space minus input row */}
      <div
        className="no-scrollbar"
        style={{
          flex:       1,
          overflowY:  'auto',
          padding:    '8px 10px',
          display:    'flex',
          flexDirection: 'column',
          gap:        4,
        }}
      >
        {messages.map((m, i) => {
          const mine = m.from === 'me';
          return (
            <div
              key={i}
              style={{
                display:       'flex',
                flexDirection: 'column',
                alignItems:    mine ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth:   '85%',
                  padding:    '4px 8px',
                  background: mine
                    ? 'color-mix(in srgb, hsl(var(--phob-orange)) 10%, transparent)'
                    : `color-mix(in srgb, ${color} 10%, transparent)`,
                  border: mine
                    ? '1px solid color-mix(in srgb, hsl(var(--phob-orange)) 25%, transparent)'
                    : `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
                  fontFamily:  'var(--font-sans, sans-serif)',
                  fontSize:    10,
                  lineHeight:  1.45,
                  color:       mine
                    ? 'hsl(var(--phob-orange) / 0.85)'
                    : 'hsl(var(--phob-white) / 0.75)',
                }}
              >
                {m.text}
              </div>
              <span
                style={{
                  fontFamily:    'var(--font-mono, monospace)',
                  fontSize:      7,
                  color:         'rgba(136,136,128,0.4)',
                  marginTop:     2,
                  letterSpacing: '0.08em',
                }}
              >
                {m.ts}
              </span>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input row — 32px */}
      <div
        style={{
          height:      32,
          flexShrink:  0,
          display:     'flex',
          alignItems:  'center',
          borderTop:   'rgba(232,66,10,0.15)',
          borderTopWidth: 1,
          borderTopStyle: 'solid',
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="message..."
          style={{
            flex:        1,
            height:      '100%',
            background:  'transparent',
            border:      'none',
            outline:     'none',
            padding:     '0 8px',
            fontFamily:  'var(--font-mono, monospace)',
            fontSize:    10,
            color:       'hsl(var(--phob-white) / 0.75)',
          }}
        />
        <button
          onClick={handleSend}
          style={{
            height:        '100%',
            padding:       '0 10px',
            background:    'transparent',
            border:        'none',
            borderLeft:    '1px solid rgba(232,66,10,0.18)',
            cursor:        'pointer',
            fontFamily:    'var(--font-mono, monospace)',
            fontSize:      8,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color:         `color-mix(in srgb, ${color} 60%, transparent)`,
            transition:    'color 120ms ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = color)}
          onMouseLeave={(e) => (e.currentTarget.style.color = `color-mix(in srgb, ${color} 60%, transparent)`)}
        >
          SEND
        </button>
      </div>
    </div>
  );

  return createPortal(window_, document.body);
}
