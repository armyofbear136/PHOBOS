/**
 * GameSSEClient — connects to GET /api/game/stream and
 * writes events to the plain-JS GameStore.
 *
 * Auto-reconnects on drop. Created once, never destroyed
 * (until app unmount).
 */

import {
  gameStore,
  setPersonaState,
  pushCoin,
  setWorldState,
} from './GameStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

let es: EventSource | null = null;

export function connectGameSSE(): void {
  if (es) return; // already connected

  es = new EventSource(`${ENGINE_URL}/api/game/stream`);

  es.onopen = () => {
    gameStore.connected = true;
  };

  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      switch (data.type) {
        case 'persona_state':
          setPersonaState(data.persona, data.state, data.taskType);
          break;
        case 'coin_tick':
          pushCoin(data.source, data.value, data.size);
          break;
        case 'world_state':
          setWorldState(data.imageGenerating, data.allIdle);
          break;
        case 'heartbeat':
          // keepalive — no action needed
          break;
        // task_start, task_complete, thinking_start, thinking_end, error_event
        // can be used for future UI overlays — no action in v1
      }
    } catch {
      // malformed event — skip
    }
  };

  es.onerror = () => {
    gameStore.connected = false;
    // EventSource auto-reconnects. If permanently dead, it stays in CONNECTING.
  };
}

export function disconnectGameSSE(): void {
  if (es) {
    es.close();
    es = null;
    gameStore.connected = false;
  }
}
