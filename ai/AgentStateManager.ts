/**
 * AgentStateManager
 *
 * Single source of truth for what the AI is doing at any moment.
 * Any stage (ingestion, planning, engine, review, build) calls transition()
 * and one `agent_state` SSE event fires to the client.
 *
 * The frontend maps `state` to an icon and shows `detail` as the label.
 * `detail` is always ≤ 20 characters — callers must enforce this contract.
 *
 * State machine (valid transitions listed; unlisted transitions are allowed
 * but logged as unexpected so we can tighten them later):
 *
 *   idle → reading | planning | thinking | executing | reviewing | building | delivering | error
 *   reading → planning | thinking | idle
 *   planning → thinking | idle
 *   thinking → executing | reviewing | delivering | idle
 *   executing → reviewing | building | thinking | idle
 *   building → reviewing | thinking | idle
 *   reviewing → thinking | delivering | idle
 *   delivering → idle
 *   * → error → idle
 */

export type AgentState =
  | 'idle'        // nothing in flight
  | 'reading'     // coordinator or engine reading files
  | 'planning'    // coordinator decomposing tasks
  | 'thinking'    // engine or coordinator generating tokens
  | 'executing'   // applying file tool calls to workspace
  | 'reviewing'   // coordinator reviewing engine output
  | 'building'    // running the build command
  | 'delivering'  // coordinator assembling final response
  | 'error';      // unrecoverable error in current turn

export interface AgentStateEvent {
  type: 'agent_state';
  state: AgentState;
  /** ≤ 20 chars — filename, search query, task title stub, etc. */
  detail: string;
  /** Unix ms — lets the frontend calculate time-in-state */
  ts: number;
  /** Optional task position for multi-task runs */
  taskIndex?: number;
  taskTotal?: number;
}

/** Trim detail to ≤ 20 chars, replacing interior with ellipsis if needed. */
function trimDetail(raw: string): string {
  const s = raw.trim();
  if (s.length <= 20) return s;
  // Keep first 9, ellipsis, last 8 — always ≤ 20 chars
  return s.slice(0, 9) + '…' + s.slice(-8);
}

// Transitions that are expected in normal operation — used to detect bugs.
const EXPECTED_TRANSITIONS = new Set<string>([
  'idle→reading', 'idle→planning', 'idle→thinking', 'idle→error',
  'reading→planning', 'reading→thinking', 'reading→idle',
  'planning→thinking', 'planning→idle',
  'thinking→executing', 'thinking→reviewing', 'thinking→delivering', 'thinking→idle', 'thinking→thinking',
  'executing→reviewing', 'executing→building', 'executing→thinking', 'executing→idle',
  'building→reviewing', 'building→thinking', 'building→idle',
  'reviewing→thinking', 'reviewing→delivering', 'reviewing→idle',
  'delivering→idle',
  'error→idle',
]);

export class AgentStateManager {
  private current: AgentState = 'idle';
  private emit: (event: AgentStateEvent) => void;

  constructor(emit: (event: AgentStateEvent) => void) {
    this.emit = emit;
  }

  get state(): AgentState {
    return this.current;
  }

  /**
   * Transition to a new state and emit the SSE event.
   * @param next       Target state
   * @param detail     ≤ 20 char description (filename, task title, etc.)
   * @param taskIndex  Optional: which task we're on
   * @param taskTotal  Optional: total tasks in current plan
   */
  transition(
    next: AgentState,
    detail: string,
    taskIndex?: number,
    taskTotal?: number
  ): void {
    const key = `${this.current}→${next}`;
    if (!EXPECTED_TRANSITIONS.has(key)) {
      console.warn(`[AgentState] unexpected transition ${key} detail="${detail}"`);
    }
    this.current = next;
    const event: AgentStateEvent = {
      type: 'agent_state',
      state: next,
      detail: trimDetail(detail),
      ts: Date.now(),
      ...(taskIndex !== undefined ? { taskIndex } : {}),
      ...(taskTotal !== undefined ? { taskTotal } : {}),
    };
    console.log(`[AgentState] ${key} "${event.detail}"${taskIndex !== undefined ? ` [${taskIndex}/${taskTotal}]` : ''}`);
    this.emit(event);
  }

  /** Convenience: transition to idle with no detail. */
  idle(): void {
    this.transition('idle', '');
  }

  /** Convenience: transition to error with a short reason. */
  error(reason: string): void {
    this.transition('error', reason);
  }
}
