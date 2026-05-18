// This module is a backend-only module stub. It's not used in the browser.
// The actual implementation lives in the backend Fastify server.

export type PersistedEventType =
  | 'file_panel'
  | 'coordinator'
  | 'thinking_complete'
  | 'patches_applied'
  | 'activity';

export interface MessageEvent {
  id: string;
  thread_id: string;
  message_id: string | null;
  event_type: PersistedEventType;
  payload: string;
  seq: number;
  created_at: string;
}
