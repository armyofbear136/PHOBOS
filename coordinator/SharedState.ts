/**
 * coordinator/SharedState.ts
 *
 * SharedArrayBuffer layout constants and enums.
 * Source of truth for both the Fastify process and the Coordinator process.
 *
 * Buffer: 512 bytes = 128 × Int32 slots.
 * All slots accessed via Atomics.load / Atomics.store — thread-safe across fork().
 *
 * INDEX POSITIONS ARE A PERMANENT WIRE CONTRACT.
 * Never reorder. Never remove. New fields append only (next free slot: 28).
 * Slots 28–31: reserved for In-Flight Coordinator (C4).
 * Slots 32–127: reserved for future use.
 */

export const S = {
  // ── Queue ───────────────────────────────────────────────────────────────────
  QUEUE_DEPTH:           0,  // int32 — pending tasks (not yet dispatched)
  QUEUE_ACTIVE_TASKS:    1,  // int32 — tasks currently executing
  QUEUE_TOTAL_ENQUEUED:  2,  // int32 — lifetime enqueue counter (wraps at MAX_INT32)
  QUEUE_TOTAL_COMPLETED: 3,  // int32 — lifetime completion counter

  // ── SAYON ───────────────────────────────────────────────────────────────────
  SAYON_STATE:           4,  // int32 — ProcessState enum
  SAYON_MODEL_HASH:      5,  // int32 — low 32 bits of loaded model ID hash
  SAYON_HEARTBEAT:       6,  // int32 — unix seconds of last activity
  SAYON_ACTIVE_TASK:     7,  // int32 — taskId low 16 bits (0 = idle)

  // ── SEREN ───────────────────────────────────────────────────────────────────
  SEREN_STATE:           8,  // int32 — ProcessState enum
  SEREN_MODEL_HASH:      9,  // int32 — low 32 bits of loaded model ID hash
  SEREN_HEARTBEAT:       10, // int32 — unix seconds of last activity
  SEREN_ACTIVE_TASK:     11, // int32 — taskId low 16 bits (0 = idle)

  // ── SYBIL ───────────────────────────────────────────────────────────────────
  SYBIL_STATE:           12, // int32 — ProcessState enum
  SYBIL_HEARTBEAT:       13, // int32 — unix seconds of last activity

  // ── VRAM Contention ─────────────────────────────────────────────────────────
  VRAM_LOCK:             14, // int32 — ContentionLock enum (0=free, 1=image, 2=audio, 3=video)
  VRAM_LOCK_TASK_ID:     15, // int32 — taskId holding the lock (0 = nobody)

  // ── Image Generation ────────────────────────────────────────────────────────
  IMAGE_STATE:           16, // int32 — GenerationState enum
  IMAGE_PROGRESS_PCT:    17, // int32 — 0–100
  IMAGE_CURRENT_STEP:    18, // int32 — current diffusion step
  IMAGE_TOTAL_STEPS:     19, // int32 — total diffusion steps

  // ── Audio Generation ────────────────────────────────────────────────────────
  AUDIO_STATE:           20, // int32 — GenerationState enum
  AUDIO_PROGRESS_PCT:    21, // int32 — 0–100

  // ── System Health ────────────────────────────────────────────────────────────
  COORDINATOR_HEARTBEAT: 22, // int32 — unix seconds (Fastify detects crash if stale >10s)
  COORDINATOR_BOOT_TIME: 23, // int32 — unix seconds of coordinator start
  FASTIFY_HEARTBEAT:     24, // int32 — unix seconds (coordinator detects Fastify crash if stale)

  // ── Performance Telemetry ────────────────────────────────────────────────────
  SAYON_LAST_LATENCY_MS: 25, // int32 — last SAYON response time ms
  SEREN_LAST_LATENCY_MS: 26, // int32 — last SEREN response time ms
  QUEUE_WAIT_TIME_AVG:   27, // int32 — rolling avg wait time ms

  // [28–31]: reserved for In-Flight Coordinator (C4)
  // [32–127]: reserved for future use
} as const;

export type SlotIndex = typeof S[keyof typeof S];

/** 128 × Int32 = 512 bytes */
export const SHARED_BUFFER_BYTE_LENGTH = 128 * Int32Array.BYTES_PER_ELEMENT;

export enum ProcessState {
  STOPPED  = 0,
  STARTING = 1,
  RUNNING  = 2,
  BUSY     = 3,  // processing a task
  YIELDING = 4,  // stopping to free VRAM
  ERROR    = 5,
}

export enum ContentionLock {
  FREE  = 0,
  IMAGE = 1,
  AUDIO = 2,
  VIDEO = 3,
}

export enum GenerationState {
  IDLE       = 0,
  QUEUED     = 1,
  GENERATING = 2,
  DONE       = 3,
  ERROR      = 4,
}
