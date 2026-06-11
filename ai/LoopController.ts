import type { FastifyReply } from 'fastify';
import { AgentStateManager, type AgentStateEvent } from './AgentStateManager.js';
import { engineClient, coordinatorClient, coordinatorCall, ENGINE_MODEL, COORDINATOR_MODEL, ENGINE_PROVIDER, COORDINATOR_PROVIDER, applyThinkingStrategy, getThinkingStrategy, getThinkingExtraBody, coordinatorStream } from './clients.js';
import { getServerStatus, awaitServerReady } from '../phobos/LlamaServerManager.js';
import { isMainThread } from 'node:worker_threads';
import { ThinkingTokenRouter } from './ThinkingTokenRouter.js';
import { DispatchComposer, type ComposeInput } from './DispatchComposer.js';
import { ContextIngester } from './ContextIngester.js';
import { TaskPlanner } from './TaskPlanner.js';
import { DeliveryComposer } from './DeliveryComposer.js';
import { StreamParser } from './StreamParser.js';
import { InterventionHandler } from './InterventionHandler.js';
import { ThinkingBudgetMonitor } from './ThinkingBudgetMonitor.js';
import { gsm } from '../game/GameStateManager.js';
import { FileToolParser } from '../patch/FileToolParser.js';
import { FileToolExecutor } from '../patch/FileToolExecutor.js';
import type { StagedFileToolResult } from '../patch/FileToolExecutor.js';
import { SyntaxValidator } from '../patch/SyntaxValidator.js';
import { BuildRunner } from '../build/BuildRunner.js';
import { ErrorFormatter } from '../build/ErrorFormatter.js';
import type { FileToolResult } from './FileTools.js';
import { getInjection, searchReserve, getReserveCompactList, getSkillInstructions } from './SkillManager.js';
import fs from 'fs/promises';
import path from 'path';

const DEBUG = process.env.PHOBOS_DEBUG === '1' || process.env.PHOBOS_DEBUG === 'true';
const dbg = (...args: unknown[]) => { if (DEBUG) console.log(...args); };
/**
 * ToolTagFilter — streaming XML suppressor for file tool calls.
 *
 * SEREN emits tool calls as raw XML in the output stream, e.g.:
 *   <write_file path="foo.ts">\nfull contents\n</write_file>
 *
 * These must never reach the frontend as output_token events.
 * This filter accumulates the stream incrementally and only forwards
 * the portions that are outside any tool tag to the emit callback.
 *
 * Works on both the field-path (clean outToken per chunk) and the
 * parser-path (outputBuffer slices), since both hit the same feed() method.
 *
 * Tool tags suppressed: write_file, append_file, insert_lines,
 *                       replace_lines, delete_lines, read_file
 */
class ToolTagFilter {
  private static readonly TOOL_NAMES = [
    'write_file', 'append_file', 'insert_lines',
    'replace_lines', 'delete_lines', 'read_file',
  ] as const;

  // Build a regex that matches any opening tool tag (with optional attributes)
  // OR a self-closing tag. Anchored to catch across chunk boundaries
  // via the accumulation buffer.
  private static readonly OPEN_RE  = /<(write_file|append_file|insert_lines|replace_lines|delete_lines|read_file)(\s[^>]*)?\/?>|<\/?(write_file|append_file|insert_lines|replace_lines|delete_lines|read_file)>/;

  private buf = '';          // accumulates unclassified input
  private insideTag = '';    // name of currently-open tool tag, or ''

  reset(): void {
    this.buf = '';
    this.insideTag = '';
  }

  /**
   * Feed a chunk of output text. Returns the portion safe to emit to the client.
   * Anything inside a tool XML block is swallowed.
   */
  feed(chunk: string): string {
    this.buf += chunk;
    let safe = '';

    while (this.buf.length > 0) {
      if (this.insideTag === '') {
        // Not inside a tool block — scan for an opening tag
        const match = ToolTagFilter.OPEN_RE.exec(this.buf);
        if (match === null) {
          // No tag found. But a partial tag could be at the tail — hold it back.
          const heldBack = this.partialTagLen(this.buf);
          const emit = this.buf.slice(0, this.buf.length - heldBack);
          safe += emit;
          this.buf = this.buf.slice(emit.length);
          break;
        }
        // Emit everything before the tag
        safe += this.buf.slice(0, match.index);
        const tagName = (match[1] ?? match[3] ?? '').replace('/', '');
        const fullMatch = match[0];

        // Self-closing, read_file, or stray closing tag — suppress and skip
        const isClosingTag = fullMatch.startsWith('</');
        if (fullMatch.endsWith('/>') || tagName === 'read_file' || isClosingTag) {
          // Suppress the tag itself, advance past it — insideTag stays ''
          this.buf = this.buf.slice(match.index + fullMatch.length);
        } else {
          // Opening tag — enter suppression mode
          this.insideTag = tagName;
          this.buf = this.buf.slice(match.index + fullMatch.length);
        }
      } else {
        // Inside a tool block — scan for the matching closing tag
        const closeTag = `</${this.insideTag}>`;
        const closeIdx = this.buf.indexOf(closeTag);
        if (closeIdx === -1) {
          // Closing tag not yet arrived — hold entire buffer
          break;
        }
        // Discard everything up to and including the closing tag
        this.buf = this.buf.slice(closeIdx + closeTag.length);
        this.insideTag = '';
      }
    }

    return safe;
  }

  /** How many trailing chars in str could be the start of any tool open-tag */
  private partialTagLen(str: string): number {
    // Longest possible tool open tag prefix to hold back: "<write_file" = 11 chars
    const MAX_HOLD = 12;
    const tail = str.slice(-MAX_HOLD);
    for (let len = Math.min(tail.length, MAX_HOLD); len >= 1; len--) {
      const candidate = tail.slice(tail.length - len);
      if ('<write_file'.startsWith(candidate) ||
          '<append_file'.startsWith(candidate) ||
          '<insert_lines'.startsWith(candidate) ||
          '<replace_lines'.startsWith(candidate) ||
          '<delete_lines'.startsWith(candidate) ||
          '<read_file'.startsWith(candidate)) {
        return len;
      }
    }
    return 0;
  }

  /**
   * Flush any remaining buffered content that is safe to emit.
   * Call after the stream ends. If we're still insideTag, the model
   * produced an unclosed tool block — discard the remainder.
   */
  flush(): string {
    if (this.insideTag !== '') {
      this.buf = '';
      this.insideTag = '';
      return '';
    }
    const remaining = this.buf;
    this.buf = '';
    return remaining;
  }
}

export interface LoopOptions {
  maxAttempts?: number;
  buildCommand?: string;
  projectRoot?: string;
  /** Thread ID — passed to FileToolExecutor for image output path resolution */
  threadId?: string;
  /** Absolute path to the workspace directory — used by Stage 1 file ingestion */
  workspaceDir?: string;
  skipBuild?: boolean;
  /** Called for every event that should be persisted to DB (file_panel, coordinator, etc.) */
  persistEvent?: (eventType: string, payload: object, messageId?: string) => Promise<void>;
  /** Called periodically with buffered think tokens — enables real-time DB persistence */
  onThinkChunk?: (content: string, source: 'coordinator' | 'engine', messageId?: string) => Promise<void>;
  /** Called when a thinking phase ends (coordinator done, or engine done) — used to close DB segment */
  onThinkPhaseComplete?: (source: 'coordinator' | 'engine') => Promise<void>;
  /** Called for every agent_state transition — wire to SSE for frontend icon updates */
  onAgentState?: (event: AgentStateEvent) => void;
  /** Called periodically with buffered output tokens — enables real-time DB persistence */
  onOutputChunk?: (content: string, messageId?: string) => Promise<void>;
  /** Called during image generation phases — wire to SSE for frontend status updates */
  onImageStatus?: (status: import('../phobos/ImageGenerationHandler.js').ImageGenStatus) => void;
  /** Called when an execute or simulate task completes — wire to SSE for frontend result card */
  onExecuteResult?: (result: { taskIndex: number; exitCode: number; durationMs: number; timedOut: boolean; stdoutPreview: string; mode: 'execute' | 'simulate' | 'audit' }) => void;
  /**
   * Called just before each task is dispatched to SEREN/SAYON for execution.
   * Receives the full system prompt + user message so it can be logged for export/debugging.
   * Non-blocking — errors are swallowed.
   */
  onDispatch?: (info: {
    taskIndex: number;
    total: number;
    title: string;
    assignedTo: 'sayon' | 'seren';
    operation: string;
    targetFile: string;
    systemPrompt: string;
    userPrompt: string;
    messageId?: string;
  }) => Promise<void>;

  /**
   * Sandbox executor flag. Read from DuckDB's model_path_settings table on
   * the main thread and threaded through to LoopController + DispatchComposer.
   * The coordinator worker has no DB access, so this value is supplied by
   * INIT_CONFIG / EXECUTOR_FLAG_UPDATE postMessages from main. Defaults to
   * false if unspecified — execute / simulate tasks degrade gracefully.
   */
  executorEnabled?: boolean;

  /**
   * Override for archive search. When set (in coordinator-worker context),
   * routes archive queries through main via postMessage round-trip instead
   * of calling ArchiveStore directly. When unset (main / tests), TaskPlanner
   * falls back to direct ArchiveClient.search.
   */
  archiveSearchFn?: (query: string, domains: import('../db/ArchiveStore.js').ArchiveDomain[], k: number) => Promise<string>;

  /**
   * Override for workspace memory search. Same pattern as archiveSearchFn —
   * coordinator routes through main; main / tests use direct DB call.
   */
  memorySearchFn?: (query: string) => Promise<string>;

  /**
   * The username of the user whose session this loop is running for.
   * Used to scope user skills (getUserSkillTriggerList, getUserSkillInstructions)
   * to the correct per-user directory. Defaults to 'owner'.
   */
  username?: string;

  /**
   * Override for code audit. The audit operation reads + writes the security
   * scan tables and runs SEREN-driven analysis — pure DB-bound work that
   * cannot run inside the coordinator worker. When set, LoopController
   * delegates the entire audit task to main via postMessage round-trip.
   */
  codeAuditFn?: (target: string, taskIndex: number, total: number) => Promise<{
    output:        string;
    exitCode:      number;
    durationMs:    number;
    stdoutPreview: string;
    findingsCount: number;
  }>;
}

export interface AttemptResult {
  attemptNumber: number;
  taskIndex: number;
  thinking: string;
  output: string;
  patchesApplied: boolean;
  buildPassed: boolean;
  reviewScore: number;
  approved: boolean;
  errorOutput?: string;
  /** True when SEREN determined it needs more info from the user before executing */
  needsClarification?: boolean;
  /** The questions SEREN asked — populated when needsClarification is true */
  clarificationQuestions?: string[];
  /** True when SAYON asked Phase 1 clarification before handing to SEREN */
  isPhase1Clarification?: boolean;
  /** finish_reason from the last stream chunk — 'length' signals truncation */
  finishReason?: string;
}

export type SSEEvent =
  | { type: 'status'; content: string }
  | { type: 'coordinator'; content: string; source?: 'coordinator' | 'engine' }
  | { type: 'think_token'; token: string; source?: 'coordinator' | 'engine' }
  | { type: 'output_token'; token: string }
  | { type: 'thinking_complete'; content: string; source?: 'coordinator' | 'engine' }
  | { type: 'file_panel'; filename: string; language: string; code: string }
  | { type: 'patches_applied'; count: number; files: string[] }
  | { type: 'build_result'; success: boolean; errors?: string }
  | { type: 'review'; score: number; decision: 'APPROVE' | 'NEEDS_REVISION' | 'REJECT'; guidance?: string }
  | { type: 'task_start'; taskIndex: number; total: number; title: string }
  | { type: 'task_complete'; taskIndex: number; total: number; title: string }
  | { type: 'task_failed'; taskIndex: number; total: number; title: string; reason: string }
  | { type: 'execute_result'; taskIndex: number; exitCode: number; durationMs: number; timedOut: boolean; stdoutPreview: string; mode: 'execute' | 'simulate' | 'audit' }
  | { type: 'complete'; approved: boolean; bestAttempt: number }
  | { type: 'thinking_retry'; attempt: number }
  | { type: 'clarification_needed'; questions: string[] }
  | { type: 'phase1_clarification_needed'; questions: string[]; log: Array<{ questions: string[]; userReply: string }> }
  | { type: 'error'; message: string };

interface StreamResult {
  thinking: string;
  output: string;
  interventionResumePrompt?: string;
  interventionQuestion?: string;
  /** 'length' when the model hit max_tokens mid-output — paginated writing trigger */
  finishReason?: string;
}

/**
 * Shared mutable state threaded through all parallel task execution methods.
 * All mutations are safe under Node's cooperative single-threaded scheduler.
 */
interface ParallelExecContext {
  tasks:             import('./TaskPlanner.js').Task[];
  total:             number;
  taskResults:       Array<{ task: import('./TaskPlanner.js').Task; approved: boolean; attempts: AttemptResult[]; failReason?: string }>;
  taskLog:           string[];
  allAttempts:       AttemptResult[];
  allChangedFiles:   string[];
  stagedContents:    Map<string, string>;
  stagingDirsToClean: string[];
  composeInput:      ComposeInput;
  needsPlanning:     boolean;
  ingestion:         Awaited<ReturnType<ContextIngester['ingest']>>;
  maxAttempts:       number;
  taskId:            string;
  reply:             FastifyReply;
  assistantMessageId?: string;
  agentState:        AgentStateManager;
  sendStatus:        (content: string) => void;
  sendThinking:      (token: string) => void;
  sendEngineThinking: (token: string) => void;
  buildCommand:      string;
  projectRoot:       string;
  workspaceDir:      string;
  options?:          LoopOptions;
}

export class LoopController {
  private composer: DispatchComposer;
  private deliveryComposer = new DeliveryComposer();
  private interventionHandler = new InterventionHandler();
  private toolParser = new FileToolParser();
  private budgetMonitor = new ThinkingBudgetMonitor();

  /**
   * After a fresh planning pass, holds SAYON's assembled context so messages.ts
   * can cache it for SEREN clarification re-entry. Cleared at the start of each run.
   */
  lastPlanningContext: {
    rewrittenMessage: string;
    fileSummaries: import('./ContextIngester.js').FileSummary[];
    completeContext: string;
    projectScope: import('./ContextIngester.js').ProjectScope;
    repoMap: string;
  } | undefined = undefined;

  private static MAX_INTERVENTIONS = 3;
  // Max read_file → act cycles per attempt (prevents infinite read loops)
  private static MAX_READ_CYCLES = 3;

  constructor(private options: LoopOptions = {}) {
    this.composer = new DispatchComposer(options.executorEnabled ?? false);
  }

  private sendEvent(reply: FastifyReply, event: SSEEvent): void {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private async persistAndSend(
    reply: FastifyReply,
    event: SSEEvent,
    messageId?: string
  ): Promise<void> {
    this.sendEvent(reply, event);
    if (this.options.persistEvent && (
      event.type === 'file_panel' ||
      event.type === 'coordinator' ||
      event.type === 'patches_applied' ||
      event.type === 'thinking_complete'
    )) {
      await this.options.persistEvent(event.type, event, messageId).catch(() => {});
    }
  }

  private makeThinkingSender(reply: FastifyReply, source: 'coordinator' | 'engine' = 'engine'): (token: string) => void {
    return (token: string) => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'think_token', token, source })}\n\n`);
      gsm.incrementTokens(source === 'coordinator' ? 'sayon' : 'seren');
    };
  }

  private async workspaceHasBuildableFiles(projectRoot: string): Promise<boolean> {
    const BUILDABLE = new Set(['.ts','.tsx','.mts','.js','.jsx','.mjs','.py','.rs','.go','.cs','.java','.cpp','.c']);
    const walk = async (dir: string, depth: number): Promise<boolean> => {
      if (depth < 0) return false;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (entry.isDirectory()) {
            if (await walk(path.join(dir, entry.name), depth - 1)) return true;
          } else if (BUILDABLE.has(path.extname(entry.name))) {
            return true;
          }
        }
      } catch { /* skip */ }
      return false;
    };
    return walk(projectRoot, 2);
  }

  private isNoInputsError(result: { stdout: string; stderr: string }): boolean {
    const combined = result.stdout + result.stderr;
    return (
      combined.includes('TS18003') ||
      combined.includes('No inputs were found') ||
      (combined.includes('tsconfig.json') && combined.includes('no input files'))
    );
  }

  async run(reply: FastifyReply, composeInput: ComposeInput, assistantMessageId?: string): Promise<AttemptResult[]> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const buildCommand = this.options.buildCommand ?? 'npm run build';
    const projectRoot = this.options.projectRoot ?? process.cwd();
    const workspaceDir = this.options.workspaceDir ?? projectRoot;
    const taskId = Math.random().toString(36).slice(2, 10);
    this.lastPlanningContext = undefined; // clear from previous run

    // ── Agent state manager — emits agent_state SSE events ─────────────────
    const agentState = new AgentStateManager((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      this.options.onAgentState?.(event);
    });

    const toolExecutor = new FileToolExecutor(projectRoot, this.options.threadId ?? 'default');
    if (this.options.onImageStatus) {
      toolExecutor.onImageStatus = this.options.onImageStatus;
    }
    const syntaxValidator = new SyntaxValidator();
    const buildRunner = new BuildRunner(projectRoot);
    const errorFormatter = new ErrorFormatter();
    let coordinatorThinkingAccum = '';
    const sendThinking = (() => {
      const raw = this.makeThinkingSender(reply, 'coordinator');
      return (token: string) => {
        coordinatorThinkingAccum += token;
        this.options.onThinkChunk?.(token, 'coordinator', assistantMessageId).catch(() => {});
        raw(token);
      };
    })();
    let plannerEngineThinkingAccum = '';
    const sendEngineThinking = (() => {
      const raw = this.makeThinkingSender(reply, 'engine');
      return (token: string) => {
        plannerEngineThinkingAccum += token;
        this.options.onThinkChunk?.(token, 'engine', assistantMessageId).catch(() => {});
        raw(token);
      };
    })();
    const sendStatus = (content: string) => this.sendEvent(reply, { type: 'status', content });

    // ── Stage 1: Context Ingestion ─────────────────────────────────────────────
    // Coordinator reads + summarises workspace files, rewrites the user message
    // with full context available, emits status pills per step.
    const fileList = composeInput.repoMap
      ? composeInput.repoMap
          .split('\n')
          .map((line) => line.split(/\s+/)[0])
          .filter((f) => f && !f.startsWith('#') && f.includes('.'))
      : [];

    agentState.transition('reading', 'Workspace files');
    const ingester = new ContextIngester(workspaceDir);
    const ingestion = await ingester.ingest(
      fileList,
      composeInput.userMessage,
      composeInput.projectMd,
      composeInput.repoMap ?? '',
      sendStatus,
      sendThinking,
      composeInput.chatSummary,
      agentState,
      composeInput.clarificationLog,
      composeInput.intentType,        // intent-aware rewrite prompt branching
      composeInput.phase1ClarificationLog, // Phase 1 Q&A for synthesis re-entry
      composeInput.phase1OriginalRequest   // original first-message request for synthesis anchor
    );

    // After ingestion always go idle briefly before next stage (planning or direct dispatch)
    agentState.transition('idle', '');

    // Update composeInput with Stage 1 outputs.
    // Merge any inline content blocks extracted from the user message into
    // loadedFiles so they reach SEREN via the <loaded_files> injection path
    // in DispatchComposer — exactly the same path as user-uploaded files.
    const mergedLoadedFiles = [
      ...(composeInput.loadedFiles ?? []),
      ...ingestion.extractedFiles,
    ];
    composeInput = {
      ...composeInput,
      userMessage: ingestion.rewrittenUserMessage,
      fileSummaries: ingestion.fileSummaries,
      loadedFiles: mergedLoadedFiles.length > 0 ? mergedLoadedFiles : undefined,
      projectScope: ingestion.projectScope,
    };

    await this.persistAndSend(
      reply,
      { type: 'coordinator', content: ingestion.coordinatorSummary, source: 'coordinator' },
      assistantMessageId
    );

    // ── Phase 1 Clarification early exit ────────────────────────────────────
    // SAYON determined during ingestion that the request needs clarification
    // before SEREN can plan. Emit questions, record pending state, return.
    // The caller (routes/messages.ts) handles state tracking via the returned result.
    if (ingestion.phase1Clarification) {
      const { questions } = ingestion.phase1Clarification;
      const questionText = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      await this.persistAndSend(
        reply,
        {
          type: 'coordinator',
          content: `Before I get started, I have a couple of quick questions:\n\n${questionText}`,
          source: 'coordinator',
        },
        assistantMessageId
      );
      this.sendEvent(reply, {
        type: 'phase1_clarification_needed',
        questions,
        log: ingestion.phase1Clarification.log,
      });
      agentState.idle();
      this.sendEvent(reply, { type: 'complete', approved: true, bestAttempt: 0 });
      return [{
        attemptNumber: 0,
        taskIndex: 0,
        thinking: '',
        output: '',
        patchesApplied: false,
        buildPassed: false,
        reviewScore: 0,
        approved: false,
        needsClarification: true,
        clarificationQuestions: questions,
        isPhase1Clarification: true,
      }];
    }


    const allAttempts: AttemptResult[] = [];
    const allChangedFiles: string[] = [];
    // Maps relative file path → staged content string for use by validation.
    // Populated by simulateAll; never touches the real workspace on disk.
    const stagedContents = new Map<string, string>();
    // Absolute paths of temp staging dirs to clean up after delivery.
    const stagingDirsToClean: string[] = [];

    // ── Stage 3: Task Planning ───────────────────────────────────────────────
    // For code/plan requests: coordinator reads relevant files and decomposes
    // the request into ordered, atomic, file-scoped tasks. Each task only
    // receives the context it needs.
    // For questions: skip planning, single-shot execution.
    const needsPlanning =
      composeInput.intentType === 'CODE_REQUEST' ||
      composeInput.intentType === 'PLAN_REQUEST';

    let tasks: import('./TaskPlanner.js').Task[];

    if (needsPlanning) {
      agentState.transition('planning', 'Decomposing tasks');
      const planner = new TaskPlanner(workspaceDir, {
        archiveSearchFn: this.options.archiveSearchFn,
        memorySearchFn:  this.options.memorySearchFn,
        username:        this.options.username ?? 'owner',
      });

      // ── SEREN clarification re-entry shortcut ────────────────────────────
      // When the user is answering SEREN's clarification question, we already
      // ran SAYON's full discovery + extraction on the first pass. Re-running it
      // would cause SAYON to rewrite the context around the short answer (e.g.
      // "use placeholder images") — burying the original request. Instead, we
      // skip Steps 1+2 and go straight to decomposeTasks with the cached context,
      // injecting the Q&A answer via the clarificationLog mechanism that already exists.
      const cachedCtx = composeInput.serenPlanningContext;
      const useCachedContext = !!(
        cachedCtx &&
        composeInput.clarificationIteration &&
        composeInput.clarificationIteration > 0
      );

      const plan = useCachedContext
        ? await planner.decomposeWithCachedContext(
            cachedCtx!.rewrittenMessage,
            cachedCtx!.fileSummaries,
            cachedCtx!.completeContext,
            cachedCtx!.repoMap,
            sendStatus,
            sendEngineThinking,
            this.options.onThinkPhaseComplete,
            composeInput.clarificationIteration,
            composeInput.clarificationLog,
            cachedCtx!.projectScope,
          )
        : await planner.plan(
            ingestion.rewrittenUserMessage,
            ingestion.fileSummaries,
            composeInput.repoMap ?? '',
            sendStatus,
            sendThinking,            // SAYON: discovery + extraction thinking → coordinator panel
            sendEngineThinking,      // SEREN: decomposition thinking → engine panel
            this.options.onThinkPhaseComplete,  // closes the planning engine segment in DB
            composeInput.clarificationIteration,  // weight system for clarification loop
            composeInput.clarificationLog,        // full Q&A transcript for this loop
            ingestion.projectScope,               // SAYON scope classification → drives task count + ambition
          );

      // Capture planning context for SEREN clarification re-entry.
      // Only on fresh passes — cached re-entry already has this context.
      if (!useCachedContext) {
        this.lastPlanningContext = {
          rewrittenMessage: ingestion.rewrittenUserMessage,
          fileSummaries: ingestion.fileSummaries,
          completeContext: planner.getLastCompleteContext(),
          projectScope: ingestion.projectScope,
          repoMap: composeInput.repoMap ?? '',
        };
      }
      // Persist planner engine thinking so it survives thread switch/server restart
      if (plannerEngineThinkingAccum && assistantMessageId) {
        await this.options.persistEvent?.('thinking_complete', {
          type: 'thinking_complete',
          content: plannerEngineThinkingAccum,
          source: 'engine',
        }, assistantMessageId).catch(() => {});
      }
      // Note: 'analyze' and 'respond' operations are intentional SEREN decisions.
      // Do not remap them — DispatchComposer gates file_tools appropriately per operation.

      // ── NEEDS_CLARIFICATION exit ───────────────────────────────────────────
      // SEREN determined it cannot proceed without more information from the user.
      // Emit the questions as a coordinator bubble and a structured event, then
      // return empty results. The frontend keeps the input open so the user can
      // respond, and their next message re-enters the pipeline with the
      // clarification exchange in conversation history.
      if (plan.needsClarification && plan.clarificationQuestions?.length) {
        const questionText = plan.clarificationQuestions
          .map((q, i) => `${i + 1}. ${q}`)
          .join('\n');
        await this.persistAndSend(
          reply,
          {
            type: 'coordinator',
            content: `I need a few things clarified before I can proceed:\n\n${questionText}`,
            source: 'engine',
          },
          assistantMessageId
        );
        this.sendEvent(reply, {
          type: 'clarification_needed',
          questions: plan.clarificationQuestions,
        });
        dbg(`[loop:clarification] ${plan.clarificationQuestions.length} question(s) — returning early`);

        agentState.idle();
        this.sendEvent(reply, { type: 'complete', approved: true, bestAttempt: 0 });
        return [{ attemptNumber: 0, taskIndex: 0, thinking: '', output: '', patchesApplied: false, buildPassed: false, reviewScore: 0, approved: false, needsClarification: true, clarificationQuestions: plan.clarificationQuestions }];
      }

      tasks = plan.tasks;
      // Emit plan summary as coordinator bubble (distinct from Stage 1 summary)
      await this.persistAndSend(
        reply,
        { type: 'coordinator', content: plan.planSummary, source: 'engine' },
        assistantMessageId
      );
      dbg(`[loop:plan] ${tasks.length} task(s) planned`);
      for (const t of tasks) {
        dbg(`[loop:plan:task${t.index}] op=${t.operation} file="${t.targetFile}" title="${t.title}"`);
      }
    } else {
      // IMAGE_REQUEST never reaches this path — it is handled exclusively by
      // handleDirectResponse() in messages.ts via the ANSWER_DIRECTLY route.
      // Q&A / direct answer path — wrap whole request as single task
      tasks = [{
        index: 1,
        title: 'Execute request',
        targetFile: '',
        operation: 'modify' as const,
        prompt: ingestion.rewrittenUserMessage,
        context: '',
      }];
    }

    // ── Stage 4: Parallel DAG task execution ────────────────────────────────
    // Tasks are partitioned by assignedTo. SAYON and SEREN each run a sequential
    // queue concurrently. Dependencies (outputRequiredBy) gate task dispatch until
    // the producing task is approved. SAYON also drains a verification queue for
    // SEREN's file-writing tasks — checking between every primary task it completes.
    //
    // Verification queue priority:
    //   1. Tasks that are blocking a downstream SEREN dependency — taken first
    //   2. Non-blocking completed SEREN tasks — taken in arrival order
    //   3. Next SAYON primary task
    //   4. Idle-wait for SEREN to complete something

    const taskResults: Array<{
      task: import('./TaskPlanner.js').Task;
      approved: boolean;
      attempts: AttemptResult[];
      failReason?: string;
    }> = [];

    // Rolling task log — each approved task appends a short executor-written summary.
    // Every subsequent task receives the full log so executors can see prior work.
    const taskLog: string[] = [];

    // Shared execution context — passed into executeTask and mutated under
    // Node's cooperative single-threaded scheduler (no races possible).
    const execCtx: ParallelExecContext = {
      tasks,
      total: tasks.length,
      taskResults,
      taskLog,
      allAttempts,
      allChangedFiles,
      stagedContents,
      stagingDirsToClean,
      composeInput,
      needsPlanning,
      ingestion,
      maxAttempts,
      taskId,
      reply,
      assistantMessageId,
      agentState,
      sendStatus,
      sendThinking,
      sendEngineThinking,
      buildCommand,
      projectRoot,
      workspaceDir,
      options: this.options,
    };

    // Single-task plans and non-planning paths skip the parallel dispatcher —
    // no partitioning overhead, identical behaviour to the old sequential loop.
    if (tasks.length <= 1) {
      if (tasks.length === 1) {
        const result = await this.executeTask(tasks[0], execCtx);
        taskResults.push(result);
        this.budgetMonitor.reset(taskId);
      }
    } else {
      await this.runParallelDAG(execCtx);
    }

    // Synthetic `total` binding for the code below that references it
    const total = tasks.length;

    // ── Stage 4.5: SEREN Final Validation ──────────────────────────────────
    // For multi-task plans or plans with failures, SEREN reviews all completed
    // work holistically. Single approved tasks skip this — the per-task review
    // already covered them.

    let overallApproved = taskResults.length > 0 && taskResults.every(r => r.approved);
    let validationSummary: string | undefined;


    const needsFinalValidation =
      taskResults.length > 1 ||
      taskResults.some(r => !r.approved);

    if (needsFinalValidation && allChangedFiles.length > 0) {
      agentState.transition('reviewing', 'Final validation');
      sendStatus('SEREN validating all changes…');

      try {
        validationSummary = await this.runFinalValidation(
          composeInput.userMessage,
          taskResults,
          allChangedFiles,
          stagedContents,
          sendEngineThinking,
          assistantMessageId,
        );
        dbg(`[loop:validation] summary="${(validationSummary ?? '').slice(0, 200).replace(/\n/g, ' ')}"`);
      } catch (err) {
        console.warn('[LoopController] Stage 4.5 final validation failed (non-fatal):', err);
      }
    }

    // ── Stage 5: Delivery ──────────────────────────────────────────────────────
    agentState.transition('delivering', 'Final response');
    await this.emitDelivery(
      reply,
      composeInput.userMessage,
      ingestion.rewrittenUserMessage,
      allAttempts,
      allChangedFiles,
      overallApproved,
      assistantMessageId,
      taskResults,
      validationSummary,
      composeInput.intentType
    );

    // Persist coordinator thinking accumulated during the loop (planning, review calls)
    if (coordinatorThinkingAccum && assistantMessageId) {
      await this.options.persistEvent?.('thinking_complete', {
        type: 'thinking_complete',
        content: coordinatorThinkingAccum,
        source: 'coordinator',
      }, assistantMessageId).catch(() => {});
      await this.options.onThinkPhaseComplete?.('coordinator').catch(() => {});
    }

    agentState.idle();

    const bestAttempt = allAttempts.length > 0
      ? allAttempts.reduce((best, curr) => curr.reviewScore > best.reviewScore ? curr : best, allAttempts[0])
      : { reviewScore: 1.0, attemptNumber: 1 };

    this.sendEvent(reply, {
      type: 'review',
      score: bestAttempt.reviewScore,
      decision: overallApproved ? 'APPROVE' : 'REJECT',
    });
    this.sendEvent(reply, {
      type: 'complete',
      approved: overallApproved,
      bestAttempt: bestAttempt.attemptNumber,
    });

    // ── Stage 6: Commit staged files to workspace ──────────────────────────────
    // simulateAll wrote to temp staging dirs for validation. Now that the loop
    // has completed, write every approved file to its real workspace path.
    // This is the only place a file touches disk in the actual workspace.
    for (const [relPath, content] of stagedContents) {
      try {
        const absPath = path.join(projectRoot, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content, 'utf-8');
      } catch (err) {
        console.warn(`[LoopController] commit failed for ${relPath}:`, err);
      }
    }

    // Clean up temp staging directories created by simulateAll
    for (const dir of stagingDirsToClean) {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    return allAttempts;
  }

  /**
   * Stage 5: Ask SEREN to assemble a final natural-language summary,
   * then emit it as a coordinator-type SSE event (which the frontend renders
   * as the assistant's chat message content).
   */
  private async emitDelivery(
    reply: FastifyReply,
    originalMessage: string,
    rewrittenTask: string,
    attempts: AttemptResult[],
    changedFiles: string[],
    approved: boolean,
    assistantMessageId?: string,
    taskResults?: Array<{ task: import('./TaskPlanner.js').Task; approved: boolean; attempts: AttemptResult[]; failReason?: string }>,
    validationSummary?: string,
    intentType?: string
  ): Promise<void> {
    try {
      this.sendEvent(reply, { type: 'status', content: 'Assembling response…' });
      const delivery = await this.deliveryComposer.compose({
        originalUserMessage: originalMessage,
        rewrittenTask,
        attempts,
        changedFiles,
        approved,
        taskResults,
        validationSummary,
        intentType,
      });
      await this.persistAndSend(
        reply,
        { type: 'coordinator', content: delivery, source: 'engine' },
        assistantMessageId
      );
    } catch (err) {
      console.warn('[LoopController] Stage 5 delivery failed, skipping:', err);
    }
  }

  // ── Parallel DAG execution ─────────────────────────────────────────────────

  /**
   * Stage 4: Parallel DAG dispatcher.
   *
   * Partitions tasks by assignedTo. SAYON and SEREN each run a sequential queue
   * concurrently. Cross-assignment dependencies are tracked via outputRequiredBy —
   * a task only dispatches when all its input tasks are approved.
   *
   * SAYON drains the verification queue between primary tasks:
   *   - If any pending verification item is a blocking dependency, it is taken first.
   *   - Otherwise the oldest non-blocking item is taken.
   *   - Approval of a dependency item immediately unblocks the downstream SEREN task.
   */
  private async runParallelDAG(ctx: ParallelExecContext): Promise<void> {
    const { tasks, taskResults, taskLog } = ctx;
    const total = tasks.length;

    // Dependency map: taskIndex → set of taskIndices whose output it needs
    // Built from outputRequiredBy on all tasks
    const dependsOn = new Map<number, Set<number>>();
    for (const t of tasks) {
      if (t.outputRequiredBy) {
        for (const downstreamIdx of t.outputRequiredBy) {
          const s = dependsOn.get(downstreamIdx) ?? new Set<number>();
          s.add(t.index);
          dependsOn.set(downstreamIdx, s);
        }
      }
    }

    // Tracks which task indices have been fully approved
    const approved = new Set<number>();
    // Tasks waiting for dependency resolution — keyed by task index
    const pendingByIdx = new Map<number, import('./TaskPlanner.js').Task>();
    // Verification queue: SEREN file-tasks that need SAYON review
    // isDependency=true means a downstream task is waiting on this approval
    const verifyQueue: Array<{
      task: import('./TaskPlanner.js').Task;
      attempts: AttemptResult[];
      taskStartFileCount: number;
      isDependency: boolean;
    }> = [];
    // Tasks dispatched to SEREN's queue but not yet verified
    const serenInflight = new Set<number>();

    // Whether dependencies for a task are all satisfied
    const depsReady = (t: import('./TaskPlanner.js').Task): boolean => {
      const deps = dependsOn.get(t.index);
      if (!deps) return true;
      return [...deps].every(d => approved.has(d));
    };

    // Dequeue next SAYON primary task — first task with deps ready that is SAYON-assigned
    const nextSayonTask = (): import('./TaskPlanner.js').Task | undefined =>
      tasks.find(t =>
        (t.assignedTo === 'sayon') &&
        !taskResults.some(r => r.task.index === t.index) &&
        !pendingByIdx.has(t.index) &&
        depsReady(t)
      );

    // Dequeue next SEREN primary task — first task with deps ready that is SEREN-assigned
    const nextSerenTask = (): import('./TaskPlanner.js').Task | undefined =>
      tasks.find(t =>
        (t.assignedTo !== 'sayon') &&
        !taskResults.some(r => r.task.index === t.index) &&
        !serenInflight.has(t.index) &&
        !pendingByIdx.has(t.index) &&
        depsReady(t)
      );

    // Pop the highest-priority verification item:
    // Dependency items (blocking a downstream task) float to the top.
    const popVerifyItem = (): typeof verifyQueue[number] | undefined => {
      const depIdx = verifyQueue.findIndex(v => v.isDependency);
      if (depIdx !== -1) return verifyQueue.splice(depIdx, 1)[0];
      if (verifyQueue.length > 0) return verifyQueue.shift();
      return undefined;
    };

    // Called after any task approval — refresh isDependency on queued items
    const refreshVerifyPriority = (): void => {
      // A verification item is a dependency if any pending task depends on it
      for (const v of verifyQueue) {
        const deps = v.task.outputRequiredBy;
        if (!deps) { v.isDependency = false; continue; }
        v.isDependency = deps.some(downstreamIdx => {
          const t = tasks.find(tt => tt.index === downstreamIdx);
          return t && !taskResults.some(r => r.task.index === downstreamIdx);
        });
      }
    };

    // Run SAYON's review pass on a completed SEREN task.
    // Returns the full taskResult entry and resolves any downstream dependencies.
    const verifySeren = async (
      verifyItem: typeof verifyQueue[number]
    ): Promise<void> => {
      const { task, attempts, taskStartFileCount } = verifyItem;
      const taskApproved = await this.runTaskReviewPhase(
        task, attempts, taskStartFileCount, total, ctx
      );
      const failReason = taskApproved
        ? undefined
        : (attempts[attempts.length - 1]?.output ? 'Review rejected' : 'No output');

      if (taskApproved) {
        approved.add(task.index);
        this.sendEvent(ctx.reply, { type: 'task_complete', taskIndex: task.index, total, title: task.title });
        await this.generateTaskSummary(task, attempts, taskStartFileCount, ctx);
        // Inject output into downstream tasks
        this.injectOutputRequiredBy(task, attempts, tasks);
        // Unblock any tasks that were waiting on this approval
        for (const [pendingIdx, pendingTask] of pendingByIdx) {
          if (depsReady(pendingTask)) {
            pendingByIdx.delete(pendingIdx);
            // Pending tasks are re-queued into the correct executor on next tick
          }
        }
        refreshVerifyPriority();
      } else {
        this.sendEvent(ctx.reply, { type: 'task_failed', taskIndex: task.index, total, title: task.title, reason: failReason ?? 'Unknown' });
      }
      taskResults.push({ task, approved: taskApproved, attempts, failReason });
      this.budgetMonitor.reset(ctx.taskId);
    };

    // SAYON executor: runs primary queue interleaved with verification drain
    const runSayonQueue = async (): Promise<void> => {
      while (true) {
        // Always check verify queue first (dependency items have priority)
        const verifyItem = popVerifyItem();
        if (verifyItem) {
          await verifySeren(verifyItem);
          continue;
        }

        const task = nextSayonTask();
        if (task) {
          const result = await this.executeTask(task, ctx);
          taskResults.push(result);
          if (result.approved) approved.add(task.index);
          this.budgetMonitor.reset(ctx.taskId);
          // After each primary task, drain any queued verification items
          // before pulling the next primary task — keeps SEREN unblocked
          let drain = popVerifyItem();
          while (drain) {
            await verifySeren(drain);
            drain = popVerifyItem();
          }
          continue;
        }

        // No primary task ready — check if we're waiting on SEREN to finish
        const serenRemaining = tasks.filter(t =>
          (t.assignedTo !== 'sayon') &&
          !taskResults.some(r => r.task.index === t.index)
        );
        if (serenRemaining.length === 0 && verifyQueue.length === 0) break;

        // Idle-wait: yield for 50ms then re-check
        await new Promise<void>(r => setTimeout(r, 50));
      }
    };

    // SEREN executor: runs its queue sequentially, posting completions to verifyQueue
    const runSerenQueue = async (): Promise<void> => {
      while (true) {
        const task = nextSerenTask();
        if (!task) {
          // Check if all SEREN tasks are accounted for
          const serenRemaining = tasks.filter(t =>
            (t.assignedTo !== 'sayon') &&
            !taskResults.some(r => r.task.index === t.index) &&
            !serenInflight.has(t.index) &&
            !verifyQueue.some(v => v.task.index === t.index)
          );
          if (serenRemaining.length === 0) break;
          // Tasks exist but deps not satisfied — idle-wait
          await new Promise<void>(r => setTimeout(r, 50));
          continue;
        }

        serenInflight.add(task.index);
        const taskStartFileCount = ctx.allChangedFiles.length;
        this.sendEvent(ctx.reply, { type: 'task_start', taskIndex: task.index, total, title: task.title });
        ctx.sendStatus(`[${task.index}/${total}] ${task.title}…`);

        // Run the task body (all retry logic, file writes, build — but NOT review)
        const attempts = await this.executeTaskBody(task, ctx);
        serenInflight.delete(task.index);

        // Post to verification queue — SAYON will review asynchronously
        const isDep = !!(task.outputRequiredBy?.some(downstreamIdx =>
          tasks.find(t => t.index === downstreamIdx && (t.assignedTo !== 'sayon'))
        ));
        verifyQueue.push({ task, attempts, taskStartFileCount, isDependency: isDep });
        refreshVerifyPriority();
      }
    };

    // Run both queues concurrently
    await Promise.all([runSayonQueue(), runSerenQueue()]);

    // Final drain: any remaining verify items (shouldn't happen, but belt-and-suspenders)
    let remaining = popVerifyItem();
    while (remaining) {
      await verifySeren(remaining);
      remaining = popVerifyItem();
    }
  }

  /**
   * Full task execution for a SAYON-assigned task: body + review in one step.
   * Returns a taskResult-shaped object ready to push into taskResults.
   */
  private async executeTask(
    task: import('./TaskPlanner.js').Task,
    ctx: ParallelExecContext
  ): Promise<{ task: import('./TaskPlanner.js').Task; approved: boolean; attempts: AttemptResult[]; failReason?: string }> {
    const total = ctx.total;
    const taskStartFileCount = ctx.allChangedFiles.length;

    this.sendEvent(ctx.reply, { type: 'task_start', taskIndex: task.index, total, title: task.title });
    ctx.sendStatus(`[${task.index}/${total}] ${task.title}…`);

    const attempts = await this.executeTaskBody(task, ctx);
    const approved = await this.runTaskReviewPhase(task, attempts, taskStartFileCount, total, ctx);
    const failReason = approved ? undefined : (attempts[attempts.length - 1]?.output ? 'Review rejected' : 'No output');

    if (approved) {
      this.sendEvent(ctx.reply, { type: 'task_complete', taskIndex: task.index, total, title: task.title });
      await this.generateTaskSummary(task, attempts, taskStartFileCount, ctx);
      this.injectOutputRequiredBy(task, attempts, ctx.tasks);
    } else {
      this.sendEvent(ctx.reply, { type: 'task_failed', taskIndex: task.index, total, title: task.title, reason: failReason ?? 'Unknown' });
    }

    return { task, approved, attempts, failReason };
  }

  /**
   * Task body: all retry attempts, reserve skill injection, file writes, build.
   * Does NOT run the per-task review — that is handled by runTaskReviewPhase.
   * Returns all AttemptResult objects accumulated during execution.
   *
   * File mutations (allChangedFiles, stagedContents, stagingDirsToClean) are
   * written into the shared ctx as they occur.
   */
  private async executeTaskBody(
    task: import('./TaskPlanner.js').Task,
    ctx: ParallelExecContext
  ): Promise<AttemptResult[]> {
    const {
      composeInput, needsPlanning, maxAttempts, taskId,
      reply, assistantMessageId, agentState,
      sendStatus, sendEngineThinking,
      buildCommand, projectRoot, workspaceDir,
      allAttempts, allChangedFiles, stagedContents, stagingDirsToClean,
      taskLog, tasks, total,
    } = ctx;

    const toolExecutor = new FileToolExecutor(projectRoot, ctx.options?.threadId ?? 'default');
    if (ctx.options?.onImageStatus) toolExecutor.onImageStatus = ctx.options.onImageStatus;
    const syntaxValidator = new SyntaxValidator();
    const buildRunner = new BuildRunner(projectRoot);
    const errorFormatter = new ErrorFormatter();

    // ── Reserve skill on-demand injection ──────────────────────────────────
    if (task.skillId === 'SKILL_SEARCH') {
      sendStatus(`[${task.index}/${total}] Searching skill library…`);
      const reserveResults = searchReserve(task.prompt);
      task.prompt =
        `You requested a skill search. Here are the reserve skills that match your query:\n\n` +
        reserveResults +
        `\n\nBased on these results, select the most appropriate skill (if any) and proceed ` +
        `with the original task. If a skill is relevant, use it. If none match well enough, ` +
        `proceed without a skill. Original request context:\n\n` +
        task.prompt;
      task.skillId = undefined;
      dbg(`[loop:skill_search] reserve search completed for task=${task.index}`);
    }

    let injectedReserveSkills = '';
    const taskAttempts: AttemptResult[] = [];
    let retryContext: ComposeInput['retryContext'] | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        sendStatus(`[${task.index}/${total}] Retrying — attempt ${attempt}/${maxAttempts}…`);
        this.sendEvent(reply, { type: 'thinking_retry', attempt });
      }

      if (this.budgetMonitor.shouldInjectFocus(taskId)) {
        const focusSignal = this.budgetMonitor.getFocusInjection(taskId, ctx.ingestion.rewrittenUserMessage);
        task.prompt = focusSignal + task.prompt;
      }

      const taskWithSkills = injectedReserveSkills
        ? { ...task, context: task.context + injectedReserveSkills }
        : task;
      injectedReserveSkills = '';

      const dispatch = await this.composer.compose({
        ...composeInput,
        currentTask: taskWithSkills,
        conversationHistory: needsPlanning ? [] : composeInput.conversationHistory,
        retryContext: retryContext ? { ...retryContext, attemptNumber: attempt } : undefined,
        taskLog: taskLog.length > 0 ? [...taskLog] : undefined,
      });

      dbg(`[loop:attempt] task=${task.index}/${total} attempt=${attempt}/${maxAttempts} retryCtx=${retryContext ? 'yes' : 'none'}`);
      agentState.transition('thinking', task.title.slice(0, 20), task.index, total);
      sendStatus(`[${task.index}/${total}] Engine thinking…`);

      if (ctx.options?.onDispatch && attempt === 1) {
        ctx.options.onDispatch({
          taskIndex: task.index,
          total,
          title: task.title,
          assignedTo: task.assignedTo ?? 'seren',
          operation: task.operation,
          targetFile: task.targetFile,
          systemPrompt: dispatch.systemPrompt,
          userPrompt: task.prompt,
          messageId: assistantMessageId,
        }).catch(() => {});
      }

      const attemptResult = await this.runEngineWithInterventions(
        reply, dispatch, task.prompt, taskId, attempt, sendEngineThinking, assistantMessageId,
        dispatch.imageAttachments
      );
      attemptResult.taskIndex = task.index;

      // ── RESERVE_SKILL_REQUEST detection ────────────────────────────────────
      const reserveMatch = attemptResult.output.match(/RESERVE_SKILL_REQUEST:\s*([^\r\n]+)/i);
      if (reserveMatch && attempt < maxAttempts) {
        const requestedIds = reserveMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean);
        const skillContent = getSkillInstructions(requestedIds, ctx.options?.username ?? 'owner');
        if (skillContent) {
          sendStatus(`[${task.index}/${total}] Injecting reserve skills: ${requestedIds.join(', ')}…`);
          injectedReserveSkills = skillContent;
          dbg(`[loop:reserve_skill] task=${task.index} requested=${requestedIds.join(',')} found=true`);
          continue;
        }
      }

      taskAttempts.push(attemptResult);
      allAttempts.push(attemptResult);

      // ── image_gen ───────────────────────────────────────────────────────────
      if (task.operation === 'image_gen') {
        const genMatch = attemptResult.output.match(/<generate_images>([\s\S]*?)<\/generate_images>/i);
        if (genMatch) {
          try {
            const entries = JSON.parse(genMatch[1].trim()) as Array<{
              prompt: string; negativePrompt?: string; modelId?: string;
              width?: number; height?: number; outputFolder?: string;
            }>;
            const { IMAGE_MODEL_CATALOGUE, isFluxDownloaded, getImageModelSpec } = await import('../phobos/PhobosLocalManager.js');
            const { buildSdConfig } = await import('../phobos/ImageServerManager.js');
            const { createSession } = await import('../phobos/WorkflowEngine.js');
            const IMAGE_SPEED_ORDER = [
              'sdxl-turbo-fp16','dreamshaper-xl-turbo-v2','z-image-turbo-q4','flux2-klein-4b-q4',
              'realvisxl-v5-lightning','juggernaut-xl-v9-lightning','dreamshaper-xl-lightning',
              'flux-schnell-q4','chroma-q4','sdxl-base-fp16','flux-dev-q4',
            ];
            const installedModels = IMAGE_MODEL_CATALOGUE
              .filter(m => m.category !== 'video' && isFluxDownloaded(m as Parameters<typeof isFluxDownloaded>[0]))
              .map(m => m.modelId);
            const fastestModel = IMAGE_SPEED_ORDER.find(id => installedModels.includes(id)) ?? installedModels[0] ?? 'chroma-q4';
            const threadId = ctx.options?.threadId ?? 'default';
            const baseNegative = 'blurry, low quality, watermark, deformed';
            const createdWorkflows: string[] = [];
            for (const entry of entries) {
              let modelId = entry.modelId && entry.modelId !== 'auto' && installedModels.includes(entry.modelId)
                ? entry.modelId : fastestModel;
              try { const cfg = await buildSdConfig({ modelId }); if (!cfg) modelId = fastestModel; } catch { modelId = fastestModel; }
              const spec = getImageModelSpec(modelId);
              const profile = spec?.profile;
              const snap64 = (n: number) => Math.round(n / 64) * 64;
              const nodeParams = {
                prompt: entry.prompt,
                negativePrompt: entry.negativePrompt ? `${baseNegative}, ${entry.negativePrompt}` : baseNegative,
                steps: profile?.defaultSteps ?? 20,
                width: snap64(entry.width ?? profile?.defaultWidth ?? 1024),
                height: snap64(entry.height ?? profile?.defaultHeight ?? 1024),
                seed: -1, sampler: profile?.defaultSampler ?? 'euler',
              };
              const session = createSession(threadId, entry.prompt.slice(0, 40).trim() || 'AI Generated', modelId,
                [{ type: 'Generate' as const, label: 'Generate', params: nodeParams }], 'image');
              this.sendEvent(reply, {
                type: 'image_workflow_created' as unknown as 'status',
                workflowId: session.workflowId, threadId, name: session.name, prompt: entry.prompt,
                outputFolder: entry.outputFolder,
              } as unknown as SSEEvent);
              createdWorkflows.push(session.workflowId);
            }
            if (createdWorkflows.length > 0) {
              sendStatus(`Starting ${createdWorkflows.length} image generation${createdWorkflows.length > 1 ? 's' : ''}…`);
              const port = process.env.PORT ?? '3001';
              const { request: httpReq } = await import('node:http');
              for (const workflowId of createdWorkflows) {
                try {
                  const runUrl = `http://localhost:${port}/api/threads/${threadId}/workflows/${workflowId}/run`;
                  const postData = JSON.stringify({ targetNodeIndex: 0, forceNodeIndex: 0 });
                  await new Promise<void>((resolve) => {
                    const req = httpReq(runUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, () => resolve());
                    req.on('error', () => resolve()); req.write(postData); req.end();
                  });
                } catch { /* fire-and-forget */ }
              }
            }
            break; // task approved implicitly
          } catch (imageErr) {
            console.warn('[loop:image_gen] Failed to parse or dispatch image queue:', imageErr);
          }
        } else { break; } // no block — text output, approved
      }

      // ── browse ──────────────────────────────────────────────────────────────
      if (task.operation === 'browse') {
        const { getCamofoxStatus } = await import('../phobos/CamofoxManager.js');
        const camofox = getCamofoxStatus();
        if (camofox.state !== 'running') {
          attemptResult.output = `[Web browse unavailable — Camofox not running. Cannot fetch: ${task.browseUrl ?? `${task.browseMacro ?? ''} ${task.browseQuery ?? ''}`.trim()}]`;
          task.completedOutput = attemptResult.output;
          break;
        }
        const { browseUrl, browseSearch, fetchYoutubeTranscript } = await import('../phobos/CamofoxClient.js');
        let browseOutput: string;
        try {
          if (task.browseMacro === '@youtube_transcript' && task.browseUrl) {
            sendStatus(`[${task.index}/${total}] Fetching YouTube transcript…`);
            const result = await fetchYoutubeTranscript(task.browseUrl);
            browseOutput = result.error ? `[YouTube transcript error: ${result.error}]`
              : `[YOUTUBE: ${result.title}]\n[URL: ${result.url}]\n\n${result.transcript}`;
          } else if (task.browseMacro && task.browseQuery) {
            sendStatus(`[${task.index}/${total}] Searching web: ${task.browseQuery}…`);
            const result = await browseSearch(task.browseMacro, task.browseQuery);
            browseOutput = result.error ? `[Browse error: ${result.error}]`
              : `[WEB SEARCH: ${task.browseMacro} — ${task.browseQuery}]\n[TITLE: ${result.title}]\n\n${result.snapshot}`;
          } else if (task.browseUrl) {
            sendStatus(`[${task.index}/${total}] Browsing: ${task.browseUrl}…`);
            const result = await browseUrl(task.browseUrl);
            browseOutput = result.error ? `[Browse error: ${result.error}]`
              : `[WEB: ${result.title}]\n[URL: ${result.url}]\n\n${result.snapshot}`;
          } else { browseOutput = `[Browse error: task has no url, macro, or query]`; }
        } catch (browseErr) { browseOutput = `[Browse error: ${(browseErr as Error).message}]`; }
        attemptResult.output = browseOutput;
        task.completedOutput = browseOutput;
        break;
      }

      // ── execute / simulate ──────────────────────────────────────────────────
      if (task.operation === 'execute' || task.operation === 'simulate') {
        const isSimulate = task.operation === 'simulate';
        const executorEnabled = ctx.options?.executorEnabled ?? false;
        if (!executorEnabled) {
          const desc = task.entrypoint ?? task.title;
          const fallback = `[Sandbox Executor is disabled. Cannot ${isSimulate ? 'simulate' : 'execute'}: ${desc}. Enable it in the PHOBOS Command Center.]`;
          attemptResult.output = fallback; task.completedOutput = fallback; break;
        }
        const runtime = task.runtime ?? 'node';
        const entrypoint = task.entrypoint;
        const timeoutMs = Math.min(120_000, (task.timeoutSeconds ?? 30) * 1_000);
        if (!entrypoint) {
          const errMsg = `[${isSimulate ? 'Simulate' : 'Execute'} task missing entrypoint — cannot run]`;
          attemptResult.output = errMsg; task.completedOutput = errMsg; break;
        }
        let sandboxOutput: string;
        try {
          const { createSandbox, validateEntrypoint } = await import('../execution/SandboxManager.js');
          const { runInSandbox } = await import('../execution/SandboxExecutor.js');
          const sandbox = await createSandbox({ taskId: `${task.index}-${Date.now()}`, workspaceDir: projectRoot, sourceFiles: task.sourceFiles ?? [], useWorkspace: !!(task.sourceFiles?.length) });
          let execResult;
          try {
            if (!validateEntrypoint(entrypoint, sandbox.sandboxDir)) {
              const srcPath = `${projectRoot}/${entrypoint}`;
              try { await (await import('fs/promises')).copyFile(srcPath, `${sandbox.sandboxDir}/${entrypoint}`); }
              catch { sandboxOutput = `[${isSimulate ? 'Simulate' : 'Execute'} error: entrypoint "${entrypoint}" not found.]`; await sandbox.cleanup(); attemptResult.output = sandboxOutput; task.completedOutput = sandboxOutput; break; }
            }
            agentState.transition('executing', entrypoint, task.index, total);
            sendStatus(`[${task.index}/${total}] ${isSimulate ? 'Simulating' : 'Running'} ${entrypoint}…`);
            execResult = await runInSandbox({ runtime: runtime as 'node'|'python'|'bash', entrypoint, sandboxDir: sandbox.sandboxDir, timeoutMs });
            if (task.outputFiles?.length) await sandbox.collectOutputs(task.outputFiles);
          } finally { await sandbox.cleanup(); }
          const stdoutPreview = execResult.stdout.split('\n')[0]?.slice(0, 120) ?? '';
          this.sendEvent(reply, { type: 'execute_result', taskIndex: task.index, exitCode: execResult.exitCode, durationMs: execResult.durationMs, timedOut: execResult.timedOut, stdoutPreview, mode: isSimulate ? 'simulate' : 'execute' });
          ctx.options?.onExecuteResult?.({ taskIndex: task.index, exitCode: execResult.exitCode, durationMs: execResult.durationMs, timedOut: execResult.timedOut, stdoutPreview, mode: isSimulate ? 'simulate' : 'execute' });
          if (isSimulate) {
            sandboxOutput = execResult.timedOut ? `[SIMULATION TIMED OUT after ${timeoutMs/1000}s]\n${execResult.stdout ? `Partial output:\n${execResult.stdout}` : ''}`
              : execResult.exitCode !== 0 ? `[SIMULATION ERROR — exit ${execResult.exitCode}]\n${execResult.stderr ? `Error:\n${execResult.stderr}\n` : ''}${execResult.stdout ? `Partial output:\n${execResult.stdout}` : ''}`
              : (execResult.stdout || '[Simulation produced no output]') + (execResult.stderr ? `\n\n[warnings]\n${execResult.stderr}` : '');
          } else {
            const exitLabel = execResult.timedOut ? `TIMED OUT after ${timeoutMs/1000}s` : `EXIT CODE: ${execResult.exitCode}`;
            sandboxOutput = `${exitLabel}\nDURATION: ${(execResult.durationMs/1000).toFixed(1)}s\n\n${execResult.stdout ? `STDOUT:\n${execResult.stdout}\n` : 'STDOUT:\n(empty)\n'}${execResult.stderr ? `\nSTDERR:\n${execResult.stderr}` : ''}`;
            if (execResult.exitCode !== 0 && task.retryWithFix && attempt < maxAttempts) {
              sendStatus(`[${task.index}/${total}] Execution failed — requesting fix…`);
              retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: `\n\n<prior_task_output task="${task.title}" operation="execute">\n${sandboxOutput.slice(0,8_000)}\n</prior_task_output>\n\nThe script exited with a non-zero code. Fix the error in ${entrypoint} and rewrite it completely.` };
              continue;
            }
          }
        } catch (execErr) { sandboxOutput = `[${isSimulate ? 'Simulate' : 'Execute'} error: ${(execErr as Error).message}]`; }
        attemptResult.output = sandboxOutput!; task.completedOutput = sandboxOutput!; break;
      }

      // ── audit ────────────────────────────────────────────────────────────────
      if (task.operation === 'audit') {
        const rawTarget = task.targetPath ?? task.targetFile ?? '';
        if (!rawTarget) {
          const errMsg = '[Audit task missing targetPath — cannot run]';
          attemptResult.output = errMsg; task.completedOutput = errMsg; break;
        }
        let auditOutput: string;
        if (ctx.options?.codeAuditFn) {
          agentState.transition('executing', rawTarget, task.index, total);
          sendStatus(`[${task.index}/${total}] Auditing ${rawTarget}…`);
          try {
            const result = await ctx.options.codeAuditFn(rawTarget, task.index, total);
            this.sendEvent(reply, { type: 'execute_result', taskIndex: task.index, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: false, stdoutPreview: result.stdoutPreview, mode: 'audit' });
            ctx.options.onExecuteResult?.({ taskIndex: task.index, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: false, stdoutPreview: result.stdoutPreview, mode: 'audit' });
            auditOutput = result.output;
          } catch (auditErr) { auditOutput = `[Audit error: ${(auditErr as Error).message}]`; }
        } else {
          const nodePath = await import('node:path');
          const absTarget = nodePath.isAbsolute(rawTarget) ? rawTarget : nodePath.join(projectRoot, rawTarget);
          try {
            const { DatabaseManager: DM } = await import('../db/DatabaseManager.js');
            const { SecurityStore } = await import('../db/SecurityStore.js');
            const { runCodeAudit } = await import('../security/CodeAuditor.js');
            const secStore = new SecurityStore(DM.getInstance());
            await secStore.ensureTable();
            const run = await secStore.createRun('code_audit');
            agentState.transition('executing', rawTarget, task.index, total);
            sendStatus(`[${task.index}/${total}] Auditing ${rawTarget}…`);
            await runCodeAudit(secStore, run.id, absTarget);
            const completed = await secStore.getRunById(run.id);
            const findings = await secStore.getFindingsByRun(run.id);
            const durationMs = Date.now() - (completed ? Date.parse(completed.started_at) : Date.now());
            const findingPreview = findings.length > 0 ? findings[0].title.slice(0, 120) : 'No issues found';
            this.sendEvent(reply, { type: 'execute_result', taskIndex: task.index, exitCode: findings.length > 0 ? 1 : 0, durationMs, timedOut: false, stdoutPreview: findingPreview, mode: 'audit' });
            ctx.options?.onExecuteResult?.({ taskIndex: task.index, exitCode: findings.length > 0 ? 1 : 0, durationMs, timedOut: false, stdoutPreview: findingPreview, mode: 'audit' });
            if (findings.length === 0) {
              auditOutput = `[CODE AUDIT CLEAN — ${rawTarget}]\nNo security issues detected.`;
            } else {
              const bySeverity: Record<string, typeof findings> = {};
              for (const f of findings) (bySeverity[f.severity] ??= []).push(f);
              const lines: string[] = [`[CODE AUDIT — ${findings.length} finding${findings.length !== 1 ? 's' : ''} in ${rawTarget}]`, ''];
              for (const sev of ['critical','high','medium','low','info'] as const) {
                const group = bySeverity[sev]; if (!group?.length) continue;
                lines.push(`${sev.toUpperCase()} (${group.length}):`);
                for (const f of group) { lines.push(`  [${f.target ?? rawTarget}] ${f.title}`); if (f.detail) lines.push(`    ${f.detail}`); }
                lines.push('');
              }
              if (completed?.seren_digest) lines.push('ANALYSIS:', completed.seren_digest);
              auditOutput = lines.join('\n');
            }
          } catch (auditErr) { auditOutput = `[Audit error: ${(auditErr as Error).message}]`; }
        }
        attemptResult.output = auditOutput; task.completedOutput = auditOutput; break;
      }

      // ── Pagination ──────────────────────────────────────────────────────────
      const PAGINATE_THRESHOLD = 1_000;
      const PAGINATE_MAX_CONTINUATIONS = 6;
      const continueWritingRe = /<continue_writing(?:\s+path="([^"]*)")?\s*\/>/;
      let paginationCycles = 0;
      while (paginationCycles < PAGINATE_MAX_CONTINUATIONS) {
        const hitTokenLimit = attemptResult.finishReason === 'length';
        const continueMatch = continueWritingRe.exec(attemptResult.output);
        if (!hitTokenLimit && !continueMatch) break;
        if (attemptResult.output.length < PAGINATE_THRESHOLD && !continueMatch) break;
        paginationCycles++;
        const targetPath = continueMatch?.[1] ?? '';
        sendStatus(`[${task.index}/${total}] Continuing output (part ${paginationCycles + 1})…`);
        const priorOutput = attemptResult.output.replace(continueWritingRe, '').trimEnd();
        const continuationMessages = [
          { role: 'system' as const, content: dispatch.systemPrompt },
          ...dispatch.messages,
          { role: 'assistant' as const, content: priorOutput },
          { role: 'user' as const, content: targetPath
            ? `Continue writing the file \`${targetPath}\` from exactly where you left off. Do not repeat any content already written. Continue seamlessly.`
            : `You were cut off. Continue your response from exactly where you left off. Do not repeat any content already written. Continue seamlessly.` },
        ];
        const continued = await this.runSingleStream(reply, continuationMessages, taskId, attemptResult.thinking, sendEngineThinking, assistantMessageId);
        if (!continued.output.trim()) break;
        attemptResult.output = priorOutput + '\n' + continued.output;
        attemptResult.finishReason = continued.finishReason;
      }

      // ── Parse tool calls ────────────────────────────────────────────────────
      const parsed = this.toolParser.parse(attemptResult.output);
      if (parsed.toolCalls.length === 0) { break; } // pure Q&A

      // ── read_file → act cycle ───────────────────────────────────────────────
      let currentOutput = attemptResult.output;
      let currentParsed = parsed;
      let readCycles = 0;
      while (currentParsed.hasReadRequest && currentParsed.toolCalls.every(c => c.tool === 'read_file') && readCycles < LoopController.MAX_READ_CYCLES) {
        readCycles++;
        agentState.transition('reading', `files (${readCycles})`, task.index, total);
        sendStatus(`[${task.index}/${total}] Reading files (${readCycles})…`);
        const readResults = await toolExecutor.executeAll(currentParsed.toolCalls);
        const readFeedback = readResults.map(r => r.success ? `<file_contents path="${r.path}">\n${r.content}\n</file_contents>` : `<file_error path="${r.path}">${r.error}</file_error>`).join('\n');
        const continuationMessages = [
          { role: 'system' as const, content: dispatch.systemPrompt },
          ...dispatch.messages,
          { role: 'assistant' as const, content: currentOutput },
          { role: 'user' as const, content: `Here are the file contents you requested:\n\n${readFeedback}\n\nNow proceed with your changes.` },
        ];
        sendStatus(`[${task.index}/${total}] Engine continuing after file read…`);
        const continued = await this.runSingleStream(reply, continuationMessages, taskId, attemptResult.thinking, sendEngineThinking, assistantMessageId);
        currentOutput = continued.output;
        currentParsed = this.toolParser.parse(currentOutput);
      }

      // ── Execute writes ──────────────────────────────────────────────────────
      const writeCalls = currentParsed.toolCalls.filter(c => c.tool !== 'read_file');
      if (writeCalls.length === 0) { break; }

      const execDetail = writeCalls[0]?.path ? writeCalls[0].path.split('/').pop()! : `${writeCalls.length} ops`;
      agentState.transition('executing', execDetail, task.index, total);
      sendStatus(`[${task.index}/${total}] Executing ${writeCalls.length} operation(s)…`);
      const toolResults = await toolExecutor.simulateAll(writeCalls) as StagedFileToolResult[];

      for (const r of toolResults) {
        if (r.stagedPath) {
          const dir = r.stagedPath.substring(0, r.stagedPath.lastIndexOf('/'));
          const stageRoot = dir.substring(0, dir.lastIndexOf('/'));
          if (!stagingDirsToClean.includes(stageRoot)) stagingDirsToClean.push(stageRoot);
        }
      }

      const failedOps = toolResults.filter(r => !r.success);
      if (failedOps.length > 0) {
        const errorSummary = failedOps.map(r => `${r.tool} ${r.path}: ${r.error}`).join('\n');
        this.sendEvent(reply, { type: 'build_result', success: false, errors: errorSummary });
        retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: `File operations failed:\n${errorSummary}` };
        continue;
      }

      const writtenFiles = toolResults.filter(r => r.success && r.content && r.tool !== 'read_file' && r.tool !== 'generate_image');
      await this.persistAndSend(reply, { type: 'patches_applied', count: writtenFiles.length, files: writtenFiles.map(r => r.path) }, assistantMessageId);

      for (const r of writtenFiles) {
        if (!allChangedFiles.includes(r.path)) allChangedFiles.push(r.path);
        if (r.content) stagedContents.set(r.path, r.content);
      }
      for (const result of writtenFiles) {
        if (result.content) {
          await this.persistAndSend(reply, { type: 'file_panel', filename: result.path, language: result.path.split('.').pop() ?? 'text', code: result.content }, assistantMessageId);
        }
      }

      // ── Syntax validation ───────────────────────────────────────────────────
      let syntaxError: { filePath: string; result: { valid: false; error: string; line?: number } } | null = null;
      for (const result of writtenFiles) {
        if (!result.content) continue;
        const validation = await syntaxValidator.validate(result.path, result.content);
        if (!validation.valid) { syntaxError = { filePath: result.path, result: validation as { valid: false; error: string; line?: number } }; break; }
      }
      if (syntaxError) {
        const errMsg = `Syntax error in ${syntaxError.filePath} at line ${syntaxError.result.line ?? '?'}: ${syntaxError.result.error}`;
        this.sendEvent(reply, { type: 'build_result', success: false, errors: errMsg });
        retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: errMsg };
        continue;
      }

      // ── Build (only after last task) ─────────────────────────────────────────
      const isLastTask = task.index === tasks.length;
      if (!ctx.options?.skipBuild && isLastTask) {
        const hasBuildableFiles = await this.workspaceHasBuildableFiles(projectRoot);
        if (hasBuildableFiles) {
          agentState.transition('building', buildCommand.slice(0, 20));
          sendStatus('Running build…');
          const buildResult = await buildRunner.run(buildCommand);
          if (!buildResult.success && this.isNoInputsError(buildResult)) {
            dbg('[LoopController] Build: no-inputs error — skipped');
          } else if (!buildResult.success) {
            this.sendEvent(reply, { type: 'build_result', success: false, errors: errorFormatter.formatBuildErrors(buildResult) });
            if (attempt < maxAttempts) {
              retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: errorFormatter.formatForRetry({ buildResult, attemptNumber: attempt }) };
              continue;
            }
          } else {
            this.sendEvent(reply, { type: 'build_result', success: true });
          }
        }
      }

      // File-writing task: return attempts here — review is caller's responsibility
      // (either runTaskReviewPhase for SAYON tasks, or verifySeren for SEREN tasks)
      break;
    } // end attempt loop

    return taskAttempts;
  }

  /**
   * Run the SAYON review pass for a completed task.
   * Called by executeTask (SAYON tasks) and verifySeren (SEREN tasks).
   * Returns true if approved.
   */
  private async runTaskReviewPhase(
    task: import('./TaskPlanner.js').Task,
    taskAttempts: AttemptResult[],
    taskStartFileCount: number,
    total: number,
    ctx: ParallelExecContext,
  ): Promise<boolean> {
    const { allChangedFiles, sendStatus, sendThinking, maxAttempts, composeInput, needsPlanning, taskLog, tasks, reply, assistantMessageId, agentState, taskId } = ctx;

    // Non-file operations are auto-approved — no review needed
    const lastAttempt = taskAttempts[taskAttempts.length - 1];
    if (!lastAttempt) return false;

    const writtenFileCount = allChangedFiles.length - taskStartFileCount;
    if (writtenFileCount === 0) {
      // Pure Q&A, browse, audit, execute, simulate, image_gen — no file review
      lastAttempt.approved = true;
      lastAttempt.reviewScore = 1.0;
      return true;
    }

    sendStatus(`[${task.index}/${total}] Reviewing…`);
    agentState.transition('reviewing', task.title.slice(0, 20), task.index, total);

    const writtenFiles = allChangedFiles.slice(taskStartFileCount);
    const changedSummary = writtenFiles.map(f => `modified ${f}`).join('\n');
    const reviewOutput = writtenFiles.map(f => `File: ${f}\n---\n[staged content]\n---`).join('\n\n');

    const review = await this.runReviewDispatch(task.prompt, reviewOutput, changedSummary, sendThinking);
    lastAttempt.reviewScore = review.score;
    lastAttempt.approved = review.decision === 'APPROVE';
    this.sendEvent(reply, { type: 'review', score: review.score, decision: review.decision, guidance: review.guidance });
    dbg(`[loop:review] task=${task.index} score=${review.score} decision=${review.decision}`);
    return review.decision === 'APPROVE';
  }

  /**
   * Generate a short rolling task log summary after a task completes.
   */
  private async generateTaskSummary(
    task: import('./TaskPlanner.js').Task,
    taskAttempts: AttemptResult[],
    taskStartFileCount: number,
    ctx: ParallelExecContext,
  ): Promise<void> {
    const { tasks, taskLog, allChangedFiles } = ctx;
    if (tasks.length <= 1) return;
    try {
      const lastOutput = taskAttempts[taskAttempts.length - 1]?.output ?? '';
      const taskChangedFiles = allChangedFiles.slice(taskStartFileCount).join(', ');
      const summaryPrompt =
        `You just completed a task. Write a single short sentence (max 25 words) ` +
        `summarising exactly what was done. Be specific — mention file names and what changed. ` +
        `Do NOT mention what still needs to be done. Plain prose only, no markdown.\n\n` +
        `Task: ${task.title}\n` +
        (taskChangedFiles ? `Files modified: ${taskChangedFiles}\n` : '') +
        `Output excerpt: ${lastOutput.slice(0, 400)}`;
      const summaryText = await coordinatorCall({
        systemPrompt: '', messages: [{ role: 'user', content: summaryPrompt }],
        maxTokens: 80, temperature: 0.1, mode: 'no_think',
      });
      taskLog.push(summaryText.trim().replace(/^["']|["']$/g, ''));
      dbg(`[loop:tasklog] task=${task.index} summary="${taskLog[taskLog.length - 1]}"`);
    } catch (err) {
      taskLog.push(`${task.title} completed.`);
      console.warn('[LoopController] Task summary generation failed (non-fatal):', err);
    }
  }

  /**
   * Inject completed task output into downstream tasks' prompts.
   */
  private injectOutputRequiredBy(
    task: import('./TaskPlanner.js').Task,
    taskAttempts: AttemptResult[],
    tasks: import('./TaskPlanner.js').Task[],
  ): void {
    const taskOutput = taskAttempts[taskAttempts.length - 1]?.output ?? '';
    task.completedOutput = taskOutput;
    if (!task.outputRequiredBy?.length || !taskOutput.trim()) return;
    for (const targetIdx of task.outputRequiredBy) {
      const targetTask = tasks.find(t => t.index === targetIdx);
      if (targetTask) {
        targetTask.prompt += `\n\n<prior_task_output from_task="${task.index}" title="${task.title}">\n${taskOutput.slice(0, 12_000)}\n</prior_task_output>\n`;
        dbg(`[loop:inject] task ${task.index} output → task ${targetIdx} prompt (${taskOutput.length} chars)`);
      }
    }
  }

  /**
   * Stage 4.5: SEREN holistic validation of all completed work.
   *
   * Reads the final state of all changed files from disk and asks SEREN
   * to review them as a coherent whole against the original request.
   * Returns a validation summary string that feeds into delivery.
   *
   * This catches cross-file inconsistencies that per-task review misses:
   * mismatched imports, naming inconsistencies, incomplete integration, etc.
   */
  private async runFinalValidation(
    originalRequest: string,
    taskResults: Array<{
      task: import('./TaskPlanner.js').Task;
      approved: boolean;
      failReason?: string;
    }>,
    changedFiles: string[],
    stagedContents: Map<string, string>,
    sendThinking: (token: string) => void,
    assistantMessageId?: string,
  ): Promise<string | undefined> {
    // Read final state of all changed files from staged content (never from disk)
    const fileContents: string[] = [];
    let totalChars = 0;
    const maxChars = 30_000;

    for (const filepath of changedFiles) {
      if (totalChars >= maxChars) {
        fileContents.push(`[${filepath}: skipped — validation budget exceeded]`);
        continue;
      }
      const content = stagedContents.get(filepath);
      if (content === undefined) {
        fileContents.push(`<file path="${filepath}">\n[Staged content unavailable]\n</file>`);
        continue;
      }
      const truncated = content.length > 6_000
        ? content.slice(0, 6_000) + `\n... [truncated at 6000 chars, full size ${content.length}]`
        : content;
      fileContents.push(`<file path="${filepath}">\n${truncated}\n</file>`);
      totalChars += truncated.length;
    }

    const taskOutcomes = taskResults
      .map(r =>
        `  ${r.approved ? '✓' : '✗'} Task ${r.task.index}: ${r.task.title} → ${r.task.targetFile || '(no file)'}` +
        (r.failReason ? ` — ${r.failReason.slice(0, 100)}` : '')
      )
      .join('\n');

    const reflexionGuidance = getInjection('seren_final_validation');

    const prompt =
      `You are SEREN performing final validation. Review ALL completed work as a coherent whole.\n\n` +
      `ORIGINAL REQUEST:\n${originalRequest.slice(0, 2_000)}\n\n` +
      `TASK OUTCOMES:\n${taskOutcomes}\n\n` +
      `FINAL FILE STATE:\n${fileContents.join('\n\n')}\n\n` +
      (reflexionGuidance
        ? reflexionGuidance + '\n\n'
        : `Evaluate holistically:\n` +
          `1. Does the combined output satisfy the original request?\n` +
          `2. Are there cross-file inconsistencies (mismatched imports, naming, types)?\n` +
          `3. Is anything missing that the request implied but no task addressed?\n` +
          `4. Are there any obvious integration issues between the changed files?\n\n`) +
      `Respond with a brief validation summary (3-6 sentences). ` +
      `If everything looks correct, say so. If there are issues, describe them specifically. ` +
      `No JSON, no formatting — just plain prose.`;

    try {
      const { engineStream: engStream } = await import('./clients.js');
      const result = await engStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.2,
        mode: 'think',
        onThinkToken: sendThinking,
      });

      // Persist the validation thinking
      if (assistantMessageId) {
        await this.options.onThinkPhaseComplete?.('engine').catch(() => {});
      }

      return result.trim() || undefined;
    } catch (err) {
      console.warn('[LoopController] Final validation engine call failed:', err);
      return undefined;
    }
  }

  private async runEngineWithInterventions(
    reply: FastifyReply,
    dispatch: Awaited<ReturnType<DispatchComposer['compose']>>,
    originalUserMessage: string,
    taskId: string,
    attempt: number,
    sendThinking: (token: string) => void,
    assistantMessageId?: string,
    imageAttachments?: Array<{ filename: string; base64: string; mimeType: string }>
  ): Promise<AttemptResult> {
    let accumulatedThinking = '';
    let finalOutput = '';
    let interventionCount = 0;
    let lastStreamFinishReason = '';

    let engineMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: dispatch.systemPrompt },
      ...dispatch.messages,
    ];

    // Track whether this is the first stream call for this engine invocation.
    // Images are only sent on attempt 0 — intervention re-entries have the image
    // content already established in the conversation context from the first call.
    let isFirstStream = true;

    while (true) {
      const streamResult = await this.runSingleStream(
        reply, engineMessages, taskId, accumulatedThinking, sendThinking, assistantMessageId,
        isFirstStream ? imageAttachments : undefined
      );
      isFirstStream = false;

      accumulatedThinking += streamResult.thinking;
      finalOutput = streamResult.output;
      lastStreamFinishReason = streamResult.finishReason ?? '';

      if (!streamResult.interventionResumePrompt) break;

      interventionCount++;
      if (interventionCount > LoopController.MAX_INTERVENTIONS) {
        console.warn(`[LoopController] Intervention limit reached, proceeding`);
        break;
      }

      const question = streamResult.interventionQuestion ?? '';
      this.sendEvent(reply, {
        type: 'status',
        content: `Coordinator answering (${interventionCount}/${LoopController.MAX_INTERVENTIONS}): "${question.slice(0, 60)}…"`,
      });

      engineMessages = [
        { role: 'system', content: dispatch.systemPrompt },
        ...dispatch.messages,
        { role: 'assistant', content: streamResult.interventionResumePrompt },
      ];
    }

    this.budgetMonitor.recordTokens(taskId, Math.ceil(accumulatedThinking.length / 4));

    dbg(`[LoopController:engine:thinking_complete] length=${accumulatedThinking.length} msgId=${assistantMessageId?.slice(0,8) ?? 'undefined'}`);
    if (accumulatedThinking) {
      await this.persistAndSend(reply, { type: 'thinking_complete', content: accumulatedThinking, source: 'engine' }, assistantMessageId);
      await this.options.onThinkPhaseComplete?.('engine').catch(() => {});
    }

    return {
      attemptNumber: attempt,
      taskIndex: 0,  // overwritten immediately by caller: attemptResult.taskIndex = task.index
      thinking: accumulatedThinking,
      output: finalOutput,
      patchesApplied: false,
      buildPassed: false,
      reviewScore: 0,
      approved: false,
      finishReason: lastStreamFinishReason || undefined,
    };
  }

  private async runSingleStream(
    reply: FastifyReply,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    taskId: string,
    priorThinkingContext: string,
    sendThinking: (token: string) => void,
    assistantMessageId?: string,
    imageAttachments?: Array<{ filename: string; base64: string; mimeType: string }>
  ): Promise<StreamResult> {
    const parser = new StreamParser();
    parser.reset();

    const abortController = new AbortController();
    let interventionQuestion: string | null = null;
    let streamAborted = false;

    parser.on('questionDetected', (question: string) => {
      if (interventionQuestion !== null) return;
      interventionQuestion = question;
      streamAborted = true;
      abortController.abort();
    });

    // Derive live provider from engineClient.baseURL — avoids esbuild CJS stale-binding
    // where module-level `let` exports are captured at bundle init time.
    const engineBaseURLEarly = ((engineClient as unknown as { baseURL?: string }).baseURL ?? '').replace(/\/$/, '');
    const liveProvider = /127\.0\.0\.1:526|localhost:526/.test(engineBaseURLEarly) ? 'phobos' : ENGINE_PROVIDER;
    const liveModel = ENGINE_MODEL; // model string suffix is stable enough for routing

    // Apply thinking activation strategy for the current engine model/provider
    const { messages: thinkMessages, systemPrompt: thinkSystemPrompt } = applyThinkingStrategy(
      messages.filter(m => m.role !== 'system'),
      messages.find(m => m.role === 'system')?.content ?? '',
      liveProvider,
      liveModel,
      'think'
    );
    const finalMessages = thinkSystemPrompt
      ? [{ role: 'system' as const, content: thinkSystemPrompt }, ...thinkMessages]
      : thinkMessages;

    // When image attachments are provided, transform the last user message into a
    // content array so vision-capable models receive the actual image bytes.
    // Option A: images appended to the existing final user message — not a separate message.
    type AnyMessage = { role: 'system' | 'user' | 'assistant'; content: string | unknown[] };
    const finalMessagesWithImages: AnyMessage[] =
      imageAttachments && imageAttachments.length > 0
        ? (finalMessages as AnyMessage[]).map((m, i) => {
            if (i === finalMessages.length - 1 && m.role === 'user') {
              return {
                role: 'user' as const,
                content: [
                  { type: 'text', text: typeof m.content === 'string' ? m.content : '' },
                  ...imageAttachments.map(img => ({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                  })),
                ],
              };
            }
            return m;
          })
        : (finalMessages as AnyMessage[]);

    // Read the live baseURL from the client object — always current even in esbuild CJS
    // bundles where module-level `let` exports are captured at init time.
    const engineBaseURL = engineBaseURLEarly;
    const isPhobosLive = /127\.0\.0\.1:526/.test(engineBaseURL) || /localhost:526/.test(engineBaseURL);

    const engineExtraBody = getThinkingExtraBody(liveProvider, liveModel, 'think');
    dbg(`[engine:config] provider=${liveProvider} model=${liveModel} baseURL=${engineBaseURLEarly} extraBody=${JSON.stringify(engineExtraBody)}`);

    // Build params differently for raw fetch vs SDK:
    // Raw fetch (phobos): spread extra body at top level — llama-server accepts reasoning_format etc. directly
    // SDK (non-phobos): nest under extra_body — the SDK passes it through
    const baseCallParams = {
      model: liveModel,
      messages: finalMessagesWithImages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      max_tokens: 32768,
      temperature: 0.4,
    };
    const engineCallParamsRaw = {
      ...baseCallParams,
      ...engineExtraBody,
    };
    const engineCallParamsSDK = {
      ...baseCallParams,
      ...(Object.keys(engineExtraBody).length > 0 ? { extra_body: engineExtraBody } : {}),
    };

    // For phobos provider, bypass the OpenAI SDK stream parser — it strips unknown
    // fields like reasoning_content from delta before we can read them.
    // Derived from live engineClient.baseURL to avoid esbuild CJS stale-binding issues.
    const useRawFetch = isPhobosLive;

    async function* rawSseStream(url: string, body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`[engine:raw] HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (json === '[DONE]') return;
          try {
            const parsed = JSON.parse(json);
            // Capture finish_reason so the caller can detect truncation
            const finishReason = parsed?.choices?.[0]?.finish_reason;
            if (finishReason) lastFinishReason = finishReason as string;
            const delta = parsed?.choices?.[0]?.delta;
            if (delta) yield delta as Record<string, unknown>;
          } catch { /* malformed chunk — skip */ }
        }
      }
    }

    // Tracks the finish_reason from the last SSE chunk.
    // 'length' means the model hit max_tokens mid-output — paginated writing trigger.
    let lastFinishReason = '';

    let stream: import('openai/streaming').Stream<import('openai/resources').ChatCompletionChunk> | null = null;
    let rawStream: AsyncGenerator<Record<string, unknown>> | null = null;

    // WeClone ready-guard: if seren is restarting after a model swap, wait.
    if (isMainThread) { const _s = getServerStatus().seren.state; if (_s === 'starting' || _s === 'stopped') await awaitServerReady('seren'); }

    if (useRawFetch) {
      const baseURL = ((engineClient as unknown as { baseURL?: string }).baseURL ?? 'http://127.0.0.1:52627/v1').replace(/\/$/, '');
      rawStream = rawSseStream(
        `${baseURL}/chat/completions`,
        { ...engineCallParamsRaw },
        abortController.signal
      );
    } else {
      try {
        stream = await engineClient.chat.completions.create(
          { ...engineCallParamsSDK, stream: true as const },
          { signal: abortController.signal }
        );
      } catch (createErr: unknown) {
        console.error(`[engine:create:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        dbg('[engine:create:retry] Retrying without extra_body...');
        const fallbackParams = { ...engineCallParamsSDK };
        delete (fallbackParams as Record<string, unknown>).extra_body;
        stream = await engineClient.chat.completions.create(
          { ...fallbackParams, stream: true as const },
          { signal: abortController.signal }
        );
      }
    }

    async function* deltaIterator(): AsyncGenerator<Record<string, unknown>> {
      if (rawStream) { yield* rawStream; return; }
      for await (const chunk of stream!) {
        yield chunk.choices[0]?.delta as Record<string, unknown>;
      }
    }

    let fieldThinkBuf = ''; // accumulates thinking tokens from ThinkingTokenRouter
    const toolFilter = new ToolTagFilter(); // suppresses tool XML from output_token stream
    try {
      let _dbgN = 0;
      const engineStrategy = getThinkingStrategy(liveProvider, liveModel);
      dbg(`[engine:strategy] thinkingPath=${engineStrategy.thinkingPath}`);

      // ThinkingTokenRouter: single source of truth for thinking token parsing.
      // Replaces the duplicate field-path / tag-path logic that was here before.
      const thinkForcedOpen = engineStrategy.thinkingForcedOpen === true;
      const thinkRouter = new ThinkingTokenRouter(engineStrategy, 'think', (token: string) => {
        fieldThinkBuf += token;
        sendThinking(token);
      }, thinkForcedOpen);

      for await (const delta of deltaIterator()) {
        if (streamAborted) break;

        // Log first 3 chunks fully
        if (_dbgN <= 2) {
          dbg(`[engine:delta:${_dbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))}`);
          dbg(`[engine:delta:${_dbgN}] content=${JSON.stringify(delta?.content)} thinking=${JSON.stringify(delta?.thinking)} reasoning=${JSON.stringify(delta?.reasoning_content ?? delta?.reasoning)}`);
        }
        _dbgN++;

        const { output: outChunk } = thinkRouter.feed(delta);
        if (outChunk) {
          // Feed output to parser for tool-call extraction
          parser.feedOutput(outChunk);
          this.options.onOutputChunk?.(outChunk, assistantMessageId).catch(() => {});
          const safeToken = toolFilter.feed(outChunk);
          if (safeToken) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: safeToken })}\n\n`);
            gsm.incrementTokens('seren');
          }
        }

        const thinkLen = fieldThinkBuf.length;
        if (thinkLen > 4000 && thinkLen % 500 < 100) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'status', content: `Thinking: ${Math.ceil(thinkLen / 4)} tokens…` })}\n\n`);
        }
      }

      thinkRouter.flush();
    } catch (err: unknown) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      if (!isAbort) throw err;
    }

    parser.complete();
    const { output: streamOutput } = parser.getBuffers();
    const streamThinking = fieldThinkBuf;

    // Flush any safe content held in the filter buffer (e.g. text after the last tool block)
    const filterFlush = toolFilter.flush();
    if (filterFlush) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: filterFlush })}\n\n`);
    }

    if (interventionQuestion === null) {
      return { thinking: streamThinking, output: streamOutput, finishReason: lastFinishReason || undefined };
    }

    const { resumePrompt } = await this.interventionHandler.handleQuestion(
      interventionQuestion,
      priorThinkingContext + streamThinking,
      messages.find((m) => m.role === 'user')?.content ?? '',
      sendThinking
    );

    return {
      thinking: streamThinking,
      output: streamOutput,
      interventionResumePrompt: resumePrompt,
      interventionQuestion,
    };
  }

  private async runReviewDispatch(
    originalTask: string,
    output: string,
    changedSummary: string,
    sendThinking?: (token: string) => void
  ): Promise<{
    score: number;
    decision: 'APPROVE' | 'NEEDS_REVISION' | 'REJECT';
    guidance?: string;
    issues?: Array<{ file: string; line_range?: string; issue: string; expected?: string }>;
  }> {
    // llm-as-judge skill provides the rubric when installed.
    // Falls back to the baseline rubric if the skill is not present.
    const skillGuidance = getInjection('sayon_review');

    const baselineRubric =
      'You are SAYON, reviewing whether SEREN correctly solved a task.\n' +
      'Evaluate the output against these criteria:\n' +
      '1. INTENT ALIGNMENT: Does the output address what was actually asked?\n' +
      '2. COMPLETENESS: Is it complete — not truncated, not stubbed, not placeholder?\n' +
      '3. CORRECTNESS: Are there obvious syntax errors, logic flaws, or missing imports?\n' +
      '4. PRESERVATION: Do the changes preserve existing functionality that should remain?\n\n' +
      'APPROVE (score >= 0.8): correct and complete. No critical issues.\n' +
      'NEEDS_REVISION (0.5–0.8): right direction, specific fixable issues — list them precisely.\n' +
      'REJECT (score < 0.5): wrong approach, wrong file, stub output, or described instead of doing.';

    const reviewSystem = skillGuidance
      ? `You are SAYON, reviewing SEREN's work.\n${skillGuidance}`
      : baselineRubric;

    const reviewSystem_suffix =
      '\n\nRespond with ONLY a JSON object (no preamble, no markdown):\n' +
      '{\n' +
      '  "score": 0.0-1.0,\n' +
      '  "decision": "APPROVE|NEEDS_REVISION|REJECT",\n' +
      '  "issues": [\n' +
      '    {\n' +
      '      "file": "filename",\n' +
      '      "line_range": "45-60 (optional)",\n' +
      '      "issue": "what is wrong",\n' +
      '      "expected": "what should be there instead (optional)"\n' +
      '    }\n' +
      '  ],\n' +
      '  "guidance": "targeted direction for the next attempt, or empty string if APPROVE"\n' +
      '}';

    const reviewPrompt =
      `ORIGINAL TASK:\n${originalTask.slice(0, 2_000)}\n\n` +
      `CHANGES MADE:\n${changedSummary}\n\n` +
      `OUTPUT / FILE CONTENTS:\n${output.slice(0, 8_000)}`;

    dbg(`[review:prompt] ${reviewPrompt.slice(0, 400).replace(/\n/g, ' ')}`);
    try {
      const stripped = await coordinatorStream({
        systemPrompt: reviewSystem + reviewSystem_suffix,
        messages: [{ role: 'user', content: reviewPrompt }],
        maxTokens: 512,
        temperature: 0.1,
        mode: 'think',
        onThinkToken: sendThinking,
      });
      dbg(`[review:raw] "${stripped.slice(0, 300).replace(/\n/g, ' ')}"`);
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      const cleaned = jsonMatch ? jsonMatch[0] : stripped;
      const parsed = JSON.parse(cleaned);

      let issues: Array<{ file: string; line_range?: string; issue: string; expected?: string }> | undefined;
      if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
        issues = parsed.issues
          .filter((iss: Record<string, unknown>) => typeof iss.file === 'string' && typeof iss.issue === 'string')
          .map((iss: Record<string, unknown>) => ({
            file: String(iss.file),
            line_range: typeof iss.line_range === 'string' ? iss.line_range : undefined,
            issue: String(iss.issue),
            expected: typeof iss.expected === 'string' ? iss.expected : undefined,
          }));
      }

      return {
        score: typeof parsed.score === 'number' ? parsed.score : 0.5,
        decision: parsed.decision ?? 'APPROVE',
        guidance: parsed.guidance,
        issues,
      };
    } catch {
      return { score: 0.8, decision: 'APPROVE' };
    }
  }
}