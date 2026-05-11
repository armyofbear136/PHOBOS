/**
 * coordinator/MessageTypes.ts
 *
 * Wire contract for all postMessage traffic between the main thread and the
 * Coordinator worker_thread. Replaces the old PipeServer/PipeClient JSON
 * envelopes.
 *
 * Two directions:
 *   - CoordinatorOutbound: worker → main. Generated inside coordinator.ts and
 *     dispatched into the per-taskId handler registry on the main side.
 *   - CoordinatorInbound:  main → worker. Sent by CoordinatorBridge.enqueue
 *     and by the main thread's request/reply handlers.
 *
 * Three round-trip patterns are present (request/reply correlated by requestId):
 *   - ARCHIVE_SEARCH_REQUEST  ↔ ARCHIVE_SEARCH_REPLY
 *   - MEMORY_SEARCH_REQUEST   ↔ MEMORY_SEARCH_REPLY
 *   - CODE_AUDIT_REQUEST      ↔ CODE_AUDIT_REPLY
 *
 * INDEX POSITIONS in the SAB are managed in SharedState.ts. THIS FILE is the
 * permanent contract for postMessage payloads. New variants append only.
 */

import type { ArchiveDomain } from '../db/ArchiveStore.js';

// ── Initial configuration push (main → worker) ──────────────────────────────
//
// Sent once immediately after the worker emits COORDINATOR_READY. Carries the
// values LoopController needs that previously came from DuckDB: model client
// configuration, sandbox executor flag. Updated incrementally via
// MODEL_CONFIG_UPDATE and EXECUTOR_FLAG_UPDATE when admin routes mutate them.

export interface ClientRoleConfig {
  provider:    string;
  model:       string;
  endpoint:    string;
  apiKey?:     string | null;
  deviceIndex?:number | null;
  gpuBackend?: string | null;
  gpuLayers?:  number | null;
}

export interface InitConfigPayload {
  coordinator:     ClientRoleConfig;
  engine:          ClientRoleConfig;
  executorEnabled: boolean;
}

// ── Per-task callback messages (worker → main) ──────────────────────────────
//
// Same shapes the pipe-based design used. New transport, identical payloads.

export type CoordinatorOutbound =
  // ── Streaming + persistence ──────────────────────────────────────────────
  | { type: 'SSE_EVENT';            taskId: string; data: Record<string, unknown> }
  | { type: 'PERSIST_EVENT';        taskId: string; messageId: string; eventType: string; payload: unknown }
  | { type: 'THINK_CHUNK';          taskId: string; messageId: string; content: string; source: 'coordinator' | 'engine' }
  | { type: 'THINK_PHASE_COMPLETE'; taskId: string; messageId: string; source: 'coordinator' | 'engine' }
  | { type: 'AGENT_STATE';          taskId: string; messageId: string; event: unknown }
  | { type: 'DISPATCH_LOG';         taskId: string; messageId: string; info: unknown }
  | { type: 'IMAGE_STATUS';         taskId: string; status: unknown }
  | { type: 'EXECUTE_RESULT';       taskId: string; result: unknown }

  // ── Prompt log (Leak A — coordinator-side LLM calls) ─────────────────────
  | { type: 'PROMPT_LOG';
      taskId:    string;
      role:      'sayon' | 'seren';
      stage:     string;
      model:     string;
      prompt:    string;
      response:  string;
      latencyMs: number;
      threadId:  string;
      messageId: string | null }

  // ── Round-trip requests (worker asks main to do DB work) ─────────────────
  | { type: 'ARCHIVE_SEARCH_REQUEST'; requestId: string;
      query:   string;
      domains: ArchiveDomain[];
      k:       number }
  | { type: 'MEMORY_SEARCH_REQUEST';  requestId: string;
      query:   string }
  | { type: 'CODE_AUDIT_REQUEST';     requestId: string;
      target:  string;
      taskIndex: number;
      total:     number }

  // ── Task lifecycle ───────────────────────────────────────────────────────
  | { type: 'TASK_QUEUED';    taskId: string; position: number }
  | { type: 'TASK_STARTED';   taskId: string }
  | { type: 'TASK_COMPLETE';  taskId: string; attempts: unknown[]; lastPlanningContext: unknown; latencyMs: number }
  | { type: 'TASK_ERROR';     taskId: string; error: string }
  | { type: 'TASK_ABORTED';   taskId: string }

  // ── Worker readiness ─────────────────────────────────────────────────────
  | { type: 'COORDINATOR_READY' };

// ── Main → worker messages ───────────────────────────────────────────────────

export type CoordinatorInbound =
  // ── Task control ─────────────────────────────────────────────────────────
  | { type: 'ENQUEUE';        taskId: string; payload: EnqueuePayload }
  | { type: 'ABORT';          taskId: string }
  | { type: 'PRIORITY_BUMP';  taskId: string }

  // ── Initial config + incremental updates ─────────────────────────────────
  | { type: 'INIT_CONFIG';           payload: InitConfigPayload }
  | { type: 'MODEL_CONFIG_UPDATE';   coordinator: ClientRoleConfig; engine: ClientRoleConfig }
  | { type: 'EXECUTOR_FLAG_UPDATE';  enabled: boolean }

  // ── Round-trip replies (main answering worker requests) ──────────────────
  | { type: 'ARCHIVE_SEARCH_REPLY';
      requestId: string;
      result?:   string;
      error?:    string }
  | { type: 'MEMORY_SEARCH_REPLY';
      requestId: string;
      result?:   string;
      error?:    string }
  | { type: 'CODE_AUDIT_REPLY';
      requestId: string;
      result?:   CodeAuditResult;
      error?:    string };

// ── Sub-types ───────────────────────────────────────────────────────────────

export interface EnqueuePayload {
  composeInput: unknown;          // ComposeInput — typed unknown to avoid coordinator importing the full shape
  loopOptions:  LoopOptionsWire;
  messageId:    string;
  priority:     'local' | 'external';
}

export interface LoopOptionsWire {
  buildCommand?: string;
  projectRoot?:  string;
  workspaceDir?: string;
  threadId:      string;
  skipBuild?:    boolean;
  maxAttempts?:  number;
}

export interface CodeAuditResult {
  output:        string;          // formatted multi-line audit output for completedOutput
  exitCode:      number;          // 0 = clean, 1 = findings present
  durationMs:    number;
  stdoutPreview: string;
  findingsCount: number;
}
