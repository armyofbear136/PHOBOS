import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { MessageBubble } from './MessageBubble';
import { LiveActivityGizmo } from './ActivityBubble';

export function MessageList() {
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const messages = useAppStore((s) => s.messages[activeThreadId]) ?? [];
  const liveActivity = useAppStore((s) => s.liveActivity);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content, liveActivity?.label]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
      {messages.length === 0 && !liveActivity && (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Send a message to start the conversation
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {/* Live activity gizmo — always rendered after the last message, never inside the list */}
      {liveActivity && <LiveActivityGizmo activity={liveActivity} />}
      <div ref={bottomRef} />
    </div>
  );
}
