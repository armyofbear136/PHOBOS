/**
 * SseEmitterRegistry.ts — per-request EventEmitter tap for WebRTC SSE routing.
 *
 * SSE routes write to reply.raw directly. When a request arrives via WebRTC
 * (detected by x-webrtc-request-id header), the route must write to this
 * registry instead — the DataChannelHandler subscribes and forwards as
 * RemoteSSEFrame messages on the control data channel.
 *
 * Usage in SSE routes (messages.ts, copilot.ts):
 *
 *   const webrtcId = req.headers['x-webrtc-request-id'] as string | undefined;
 *   const sendEvent = webrtcId
 *     ? SseEmitterRegistry.getSender(webrtcId)
 *     : (data: Record<string, unknown>) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
 *
 * The DataChannelHandler calls SseEmitterRegistry.register(id) before calling
 * fastify.inject(), subscribes to 'event' and 'done', then cleans up after.
 */

import { EventEmitter } from 'node:events';

interface SseEmitter {
  emitter: EventEmitter;
  send:    (data: Record<string, unknown>) => void;
  end:     () => void;
}

const _registry = new Map<string, SseEmitter>();

/**
 * Register an emitter for a WebRTC request ID.
 * Called by DataChannelHandler before inject().
 * Returns the emitter to subscribe to.
 */
export function register(requestId: string): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(2);

  const entry: SseEmitter = {
    emitter,
    send: (data) => emitter.emit('event', data),
    end:  ()     => {
      emitter.emit('done');
      _registry.delete(requestId);
    },
  };

  _registry.set(requestId, entry);
  return emitter;
}

/**
 * Returns a send function for the given request ID, or null if not registered.
 * Called by SSE routes when x-webrtc-request-id header is present.
 */
export function getSender(requestId: string): ((data: Record<string, unknown>) => void) | null {
  return _registry.get(requestId)?.send ?? null;
}

/**
 * Signal end-of-stream for a request. Called when the SSE route writes done.
 * The DataChannelHandler will forward RemoteDone and unsubscribe.
 */
export function signalDone(requestId: string): void {
  _registry.get(requestId)?.end();
}

/**
 * Force-remove a registry entry (e.g. client disconnected mid-stream).
 */
export function cleanup(requestId: string): void {
  const entry = _registry.get(requestId);
  if (entry) {
    entry.emitter.removeAllListeners();
    _registry.delete(requestId);
  }
}

export const WEBRTC_REQUEST_ID_HEADER = 'x-webrtc-request-id' as const;
