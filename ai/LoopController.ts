import type { FastifyReply } from 'fastify';
import { AgentStateManager, type AgentStateEvent } from './AgentStateManager.js';
import { engineClient, coordinatorClient, coordinatorCall, ENGINE_MODEL, COORDINATOR_MODEL, ENGINE_PROVIDER, COORDINATOR_PROVIDER, applyThinkingStrategy, getThinkingStrategy, getThinkingExtraBody, coordinatorStream } from './clients.js';
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
  onExecuteResult?: (result: { taskIndex: number; exitCode: number; durationMs: number; timedOut: boolean; stdoutPreview: string; mode: 'execute' | 'simulate' }) => void;
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
  | { type: 'execute_result'; taskIndex: number; exitCode: number; durationMs: number; timedOut: boolean; stdoutPreview: string; mode: 'execute' | 'simulate' }
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

export class LoopController {
  private composer = new DispatchComposer();
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

  constructor(private options: LoopOptions = {}) {}

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
      const planner = new TaskPlanner(workspaceDir);

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

    // ── Stage 4: Per-task execution loop ────────────────────────────────────
    // Each task runs its own retry loop (up to maxAttempts).
    // Failures are recorded but execution continues to the next task.
    const taskResults: Array<{
      task: import('./TaskPlanner.js').Task;
      approved: boolean;
      attempts: AttemptResult[];
      failReason?: string;
    }> = [];

    // Rolling task log — each approved task appends a short executor-written summary.
    // Every subsequent task receives the full log so executors can see prior work.
    const taskLog: string[] = [];

    for (const task of tasks) {
      const total = tasks.length;

      // ── Reserve skill on-demand injection ──────────────────────────────────
      // Legacy SKILL_SEARCH sentinel: if SEREN planned a SKILL_SEARCH task, 
      // convert it to a reserve search and inject results.
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
        task.skillId = undefined; // clear sentinel
        dbg(`[loop:skill_search] reserve search completed for task=${task.index}`);
      }

      // Injected reserve skill instructions — set when SEREN emitted RESERVE_SKILL_REQUEST
      // in a prior attempt. Cleared after use so it doesn't re-inject on subsequent retries
      // unless SEREN requests again.
      let injectedReserveSkills = '';

      this.sendEvent(reply, {
        type: 'task_start',
        taskIndex: task.index,
        total,
        title: task.title,
      });
      sendStatus(`[${task.index}/${total}] ${task.title}…`);

      // Snapshot file count before this task runs so we can identify
      // exactly which files this task changed for the task log summary.
      const taskStartFileCount = allChangedFiles.length;

      const taskAttempts: AttemptResult[] = [];
      let retryContext: ComposeInput['retryContext'] | undefined;
      let taskApproved = false;
      let taskFailReason: string | undefined;

      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          sendStatus(`[${task.index}/${total}] Retrying — attempt ${attempt}/${maxAttempts}…`);
          // Tell frontend to seal the current thinking segment — prevents accumulation across attempts
          this.sendEvent(reply, { type: 'thinking_retry', attempt });
        }

        if (this.budgetMonitor.shouldInjectFocus(taskId)) {
          const focusSignal = this.budgetMonitor.getFocusInjection(taskId, ingestion.rewrittenUserMessage);
          task.prompt = focusSignal + task.prompt;
        }

        // Build task with any injected reserve skill instructions from a prior attempt
        const taskWithSkills = injectedReserveSkills
          ? { ...task, context: task.context + injectedReserveSkills }
          : task;
        injectedReserveSkills = ''; // clear after use

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

        // Fire onDispatch so messages.ts can log the full system prompt + user prompt
        // for export/debugging. Captures exactly what SEREN receives.
        if (this.options.onDispatch && attempt === 1) {
          this.options.onDispatch({
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

        // ── Engine stream ────────────────────────────────────────────────────────
        const attemptResult = await this.runEngineWithInterventions(
          reply, dispatch, task.prompt, taskId, attempt, sendEngineThinking, assistantMessageId,
          dispatch.imageAttachments
        );
        attemptResult.taskIndex = task.index;

        // ── RESERVE_SKILL_REQUEST detection ──────────────────────────────────────
        // If SEREN emitted "RESERVE_SKILL_REQUEST: skill-id-1, skill-id-2", fetch those
        // skill instructions and immediately retry the task with them injected.
        // This consumes one attempt slot but is transparent to the user.
        const reserveMatch = attemptResult.output.match(/RESERVE_SKILL_REQUEST:\s*([^\r\n]+)/i);
        if (reserveMatch && attempt < maxAttempts) {
          const requestedIds = reserveMatch[1].split(',').map((s: string) => s.trim()).filter(Boolean);
          const skillContent = getSkillInstructions(requestedIds);
          if (skillContent) {
            sendStatus(`[${task.index}/${total}] Injecting reserve skills: ${requestedIds.join(', ')}…`);
            injectedReserveSkills = skillContent;
            dbg(`[loop:reserve_skill] task=${task.index} requested=${requestedIds.join(',')} found=${skillContent.length > 0}`);
            // Don't push this attempt — retry immediately with skills injected
            continue;
          }
        }

        taskAttempts.push(attemptResult);
        allAttempts.push(attemptResult);

        // ── image_gen operation: parse and dispatch workflow queue ────────────
        if (task.operation === 'image_gen') {
          const genMatch = attemptResult.output.match(/<generate_images>([\s\S]*?)<\/generate_images>/i);
          if (genMatch) {
            try {
              const entries = JSON.parse(genMatch[1].trim()) as Array<{
                prompt: string;
                negativePrompt?: string;
                modelId?: string;
                width?: number;
                height?: number;
                outputFolder?: string;
              }>;

              const { IMAGE_MODEL_CATALOGUE, isFluxDownloaded, getImageModelSpec } = await import('../phobos/PhobosLocalManager.js');
              const { buildSdConfig } = await import('../phobos/ImageServerManager.js');
              const { createSession } = await import('../phobos/WorkflowEngine.js');

              // Speed-ordered fallback for auto model selection
              const IMAGE_SPEED_ORDER = [
                'sdxl-turbo-fp16', 'dreamshaper-xl-turbo-v2', 'z-image-turbo-q4', 'flux2-klein-4b-q4',
                'realvisxl-v5-lightning', 'juggernaut-xl-v9-lightning', 'dreamshaper-xl-lightning',
                'flux-schnell-q4', 'chroma-q4', 'sdxl-base-fp16', 'flux-dev-q4',
              ];
              const installedModels = IMAGE_MODEL_CATALOGUE
                .filter(m => m.category !== 'video' && isFluxDownloaded(m as Parameters<typeof isFluxDownloaded>[0]))
                .map(m => m.modelId);
              const fastestModel = IMAGE_SPEED_ORDER.find(id => installedModels.includes(id))
                ?? installedModels[0]
                ?? 'chroma-q4';

              const threadId = this.options.threadId ?? 'default';
              const baseNegative = 'blurry, low quality, watermark, deformed';
              const createdWorkflows: string[] = [];

              for (const entry of entries) {
                // Resolve model: use requested if installed, else fallback to fastest
                let modelId = entry.modelId && entry.modelId !== 'auto' && installedModels.includes(entry.modelId)
                  ? entry.modelId
                  : fastestModel;

                // Validate model is loadable
                try {
                  const cfg = await buildSdConfig({ modelId });
                  if (!cfg) modelId = fastestModel;
                } catch { modelId = fastestModel; }

                const spec = getImageModelSpec(modelId);
                const profile = spec?.profile;
                const width  = entry.width  ?? profile?.defaultWidth  ?? 1024;
                const height = entry.height ?? profile?.defaultHeight ?? 1024;

                // Snap to nearest multiple of 64
                const snap64 = (n: number) => Math.round(n / 64) * 64;

                const nodeParams = {
                  prompt:         entry.prompt,
                  negativePrompt: entry.negativePrompt
                    ? `${baseNegative}, ${entry.negativePrompt}`
                    : baseNegative,
                  steps:   profile?.defaultSteps  ?? 20,
                  width:   snap64(width),
                  height:  snap64(height),
                  seed:    -1,
                  sampler: profile?.defaultSampler ?? 'euler',
                };

                const sessionName = entry.prompt.slice(0, 40).trim() || 'AI Generated';
                const session = createSession(
                  threadId,
                  sessionName,
                  modelId,
                  [{ type: 'Generate' as const, label: 'Generate', params: nodeParams }],
                  'image',
                );

                // Emit workflow created event to frontend
                this.sendEvent(reply, {
                  type: 'image_workflow_created' as unknown as 'status',
                  workflowId: session.workflowId,
                  threadId,
                  name: session.name,
                  prompt: entry.prompt,
                  outputFolder: entry.outputFolder,
                } as unknown as import('./LoopController.js').SSEEvent);

                createdWorkflows.push(session.workflowId);
                dbg(`[loop:image_gen] created workflow ${session.workflowId} model=${modelId} ${nodeParams.width}x${nodeParams.height}`);
              }

              // Fire all workflows sequentially via the internal run endpoint
              if (createdWorkflows.length > 0) {
                sendStatus(`Starting ${createdWorkflows.length} image generation${createdWorkflows.length > 1 ? 's' : ''}…`);
                const port = process.env.PORT ?? '3001';
                const { request: httpReq } = await import('node:http');
                for (const workflowId of createdWorkflows) {
                  try {
                    const runUrl = `http://localhost:${port}/api/threads/${threadId}/workflows/${workflowId}/run`;
                    const postData = JSON.stringify({ targetNodeIndex: 0, forceNodeIndex: 0 });
                    await new Promise<void>((resolve) => {
                      const req = httpReq(runUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                      }, () => resolve());
                      req.on('error', () => resolve()); // non-fatal
                      req.write(postData);
                      req.end();
                    });
                  } catch { /* fire-and-forget, non-fatal */ }
                }
              }

              taskApproved = true;
              break;
            } catch (imageErr) {
              console.warn('[loop:image_gen] Failed to parse or dispatch image queue:', imageErr);
              // Fall through to normal task handling
            }
          } else {
            // No generate_images block — treat as pure text output (description of what would be generated)
            taskApproved = true;
            break;
          }
        }

        // ── browse operation: fetch live web content via Camofox ─────────────
        if (task.operation === 'browse') {
          const { getCamofoxStatus } = await import('../phobos/CamofoxManager.js');
          const camofox = getCamofoxStatus();

          if (camofox.state !== 'running') {
            // Degrade gracefully — SEREN narrates what it would have fetched
            attemptResult.output =
              `[Web browse unavailable — Camofox not running. ` +
              `Cannot fetch: ${task.browseUrl ?? `${task.browseMacro ?? ''} ${task.browseQuery ?? ''}`.trim()}]`;
            taskApproved = true;
            break;
          }

          const { browseUrl, browseSearch, fetchYoutubeTranscript } = await import('../phobos/CamofoxClient.js');

          let browseOutput: string;

          try {
            if (task.browseMacro === '@youtube_transcript' && task.browseUrl) {
              // YouTube transcript — dedicated endpoint, returns full caption text
              sendStatus(`[${task.index}/${total}] Fetching YouTube transcript…`);
              const result = await fetchYoutubeTranscript(task.browseUrl);
              if (result.error) {
                browseOutput = `[YouTube transcript error: ${result.error}]`;
              } else {
                browseOutput =
                  `[YOUTUBE: ${result.title}]\n[URL: ${result.url}]\n\n${result.transcript}`;
              }
            } else if (task.browseMacro && task.browseQuery) {
              // Search macro
              sendStatus(`[${task.index}/${total}] Searching web: ${task.browseQuery}…`);
              const result = await browseSearch(task.browseMacro, task.browseQuery);
              if (result.error) {
                browseOutput = `[Browse error: ${result.error}]`;
              } else {
                browseOutput =
                  `[WEB SEARCH: ${task.browseMacro} — ${task.browseQuery}]\n` +
                  `[TITLE: ${result.title}]\n\n${result.snapshot}`;
              }
            } else if (task.browseUrl) {
              // Direct URL
              sendStatus(`[${task.index}/${total}] Browsing: ${task.browseUrl}…`);
              const result = await browseUrl(task.browseUrl);
              if (result.error) {
                browseOutput = `[Browse error: ${result.error}]`;
              } else {
                browseOutput =
                  `[WEB: ${result.title}]\n[URL: ${result.url}]\n\n${result.snapshot}`;
              }
            } else {
              browseOutput = `[Browse error: task has no url, macro, or query]`;
            }
          } catch (browseErr) {
            browseOutput = `[Browse error: ${(browseErr as Error).message}]`;
          }

          // Store output for outputRequiredBy injection — same mechanism as analyze
          attemptResult.output = browseOutput;
          task.completedOutput = browseOutput;
          taskApproved = true;
          break;
        }

        // ── execute / simulate operations: run code in an isolated sandbox ─────
        // execute  = verify code PHOBOS wrote (tests, migrations, build checks).
        //            Output formatted as diagnostic: exit code + stdout + stderr.
        // simulate = produce computed results as the deliverable (math, modeling,
        //            data generation). Output formatted as result data: stdout leads,
        //            exit code is secondary, stderr only shown on failure.
        // Both share identical sandboxing infrastructure; only output framing differs.
        if (task.operation === 'execute' || task.operation === 'simulate') {
          const isSimulate = task.operation === 'simulate';

          // Gate on feature flag — degrade gracefully if executor is disabled.
          let executorEnabled = false;
          try {
            const { getSandboxExecutorEnabled } = await import('../db/ModelPathStore.js');
            const { DatabaseManager: DM } = await import('../db/DatabaseManager.js');
            executorEnabled = await getSandboxExecutorEnabled(DM.getInstance());
          } catch { /* non-fatal — treat as disabled */ }

          if (!executorEnabled) {
            const desc = task.entrypoint ?? task.title;
            const fallback =
              `[Sandbox Executor is disabled. Cannot ${isSimulate ? 'simulate' : 'execute'}: ${desc}. ` +
              `Enable it in the PHOBOS Command Center.]`;
            attemptResult.output = fallback;
            task.completedOutput = fallback;
            taskApproved = true;
            break;
          }

          const runtime    = task.runtime ?? 'node';
          const entrypoint = task.entrypoint;
          const timeoutMs  = Math.min(120_000, (task.timeoutSeconds ?? 30) * 1_000);

          if (!entrypoint) {
            const errMsg = `[${isSimulate ? 'Simulate' : 'Execute'} task missing entrypoint — cannot run]`;
            attemptResult.output = errMsg;
            task.completedOutput = errMsg;
            taskApproved = true;
            break;
          }

          let sandboxOutput: string;
          try {
            const { createSandbox, validateEntrypoint } = await import('../execution/SandboxManager.js');
            const { runInSandbox } = await import('../execution/SandboxExecutor.js');

            const taskIdStr = `${task.index}-${Date.now()}`;
            const sandbox = await createSandbox({
              taskId: taskIdStr,
              workspaceDir: projectRoot,
              sourceFiles: task.sourceFiles ?? [],
              useWorkspace: !!(task.sourceFiles?.length),
            });

            let execResult;
            try {
              if (!validateEntrypoint(entrypoint, sandbox.sandboxDir)) {
                const srcPath = `${projectRoot}/${entrypoint}`;
                const { copyFile } = await import('fs/promises');
                try {
                  await copyFile(srcPath, `${sandbox.sandboxDir}/${entrypoint}`);
                } catch {
                  sandboxOutput =
                    `[${isSimulate ? 'Simulate' : 'Execute'} error: entrypoint "${entrypoint}" not found. ` +
                    `Ensure a preceding create task writes this file.]`;
                  await sandbox.cleanup();
                  attemptResult.output = sandboxOutput;
                  task.completedOutput = sandboxOutput;
                  taskApproved = true;
                  break;
                }
              }

              agentState.transition('executing', entrypoint, task.index, total);
              sendStatus(`[${task.index}/${total}] ${isSimulate ? 'Simulating' : 'Running'} ${entrypoint}…`);
              execResult = await runInSandbox({ runtime: runtime as 'node' | 'python' | 'bash', entrypoint, sandboxDir: sandbox.sandboxDir, timeoutMs });

              if (task.outputFiles?.length) {
                await sandbox.collectOutputs(task.outputFiles);
              }
            } finally {
              await sandbox.cleanup();
            }

            // Emit SSE event for frontend result card
            const stdoutPreview = execResult.stdout.split('\n')[0]?.slice(0, 120) ?? '';
            this.sendEvent(reply, {
              type: 'execute_result',
              taskIndex: task.index,
              exitCode: execResult.exitCode,
              durationMs: execResult.durationMs,
              timedOut: execResult.timedOut,
              stdoutPreview,
              mode: isSimulate ? 'simulate' : 'execute',
            });
            this.options.onExecuteResult?.({
              taskIndex: task.index,
              exitCode: execResult.exitCode,
              durationMs: execResult.durationMs,
              timedOut: execResult.timedOut,
              stdoutPreview,
              mode: isSimulate ? 'simulate' : 'execute',
            });

            if (isSimulate) {
              // ── Simulate: stdout IS the answer — lead with the data ──────────
              // Downstream analyze/respond tasks receive this as structured result
              // output. Exit code and stderr are secondary context.
              if (execResult.timedOut) {
                sandboxOutput =
                  `[SIMULATION TIMED OUT after ${timeoutMs / 1000}s]\n` +
                  (execResult.stdout ? `Partial output:\n${execResult.stdout}` : '');
              } else if (execResult.exitCode !== 0) {
                sandboxOutput =
                  `[SIMULATION ERROR — exit ${execResult.exitCode}]\n` +
                  (execResult.stderr ? `Error:\n${execResult.stderr}\n` : '') +
                  (execResult.stdout ? `Partial output:\n${execResult.stdout}` : '');
              } else {
                // Success: pure output, no diagnostic noise
                sandboxOutput =
                  (execResult.stdout || '[Simulation produced no output]') +
                  (execResult.stderr ? `\n\n[warnings]\n${execResult.stderr}` : '');
              }
            } else {
              // ── Execute: diagnostic format — exit code + full streams ────────
              const exitLabel = execResult.timedOut ? `TIMED OUT after ${timeoutMs / 1000}s` : `EXIT CODE: ${execResult.exitCode}`;
              sandboxOutput =
                `${exitLabel}\nDURATION: ${(execResult.durationMs / 1000).toFixed(1)}s\n\n` +
                (execResult.stdout ? `STDOUT:\n${execResult.stdout}\n` : 'STDOUT:\n(empty)\n') +
                (execResult.stderr ? `\nSTDERR:\n${execResult.stderr}` : '');

              // Single automatic fix cycle on non-zero exit
              if (execResult.exitCode !== 0 && task.retryWithFix && attempt < maxAttempts) {
                sendStatus(`[${task.index}/${total}] Execution failed — requesting fix…`);
                const fixInjection =
                  `\n\n<prior_task_output task="${task.title}" operation="execute">\n` +
                  sandboxOutput.slice(0, 8_000) +
                  `\n</prior_task_output>\n\n` +
                  `The script exited with a non-zero code. Fix the error in ${entrypoint} and rewrite it completely.`;
                retryContext = {
                  attemptNumber: attempt,
                  priorThinking: attemptResult.thinking,
                  errorOutput: fixInjection,
                };
                taskFailReason = `Execute failed: exit ${execResult.exitCode}`;
                continue;
              }
            }
          } catch (execErr) {
            sandboxOutput = `[${isSimulate ? 'Simulate' : 'Execute'} error: ${(execErr as Error).message}]`;
          }

          attemptResult.output = sandboxOutput!;
          task.completedOutput = sandboxOutput!;
          taskApproved = true;
          break;
        }
        // SEREN emitted a <continue_writing path="..."/> tag, run continuation
        // turns until the output is complete. Each turn appends to the prior
        // output. Hard cap: PAGINATE_MAX_CONTINUATIONS turns to prevent loops.
        //
        // Test threshold: PAGINATE_THRESHOLD chars. In production this catches
        // genuine token-limit truncations on large files. Set low for testing.
        const PAGINATE_THRESHOLD = 1_000;
        const PAGINATE_MAX_CONTINUATIONS = 6;

        const continueWritingRe = /<continue_writing(?:\s+path="([^"]*)")?\s*\/>/;
        let paginationCycles = 0;

        while (paginationCycles < PAGINATE_MAX_CONTINUATIONS) {
          const hitTokenLimit = attemptResult.finishReason === 'length';
          const continueMatch = continueWritingRe.exec(attemptResult.output);
          const outputLen = attemptResult.output.length;

          if (!hitTokenLimit && !continueMatch) break;
          if (outputLen < PAGINATE_THRESHOLD && !continueMatch) break;

          paginationCycles++;
          const targetPath = continueMatch?.[1] ?? '';
          sendStatus(`[${task.index}/${total}] Continuing output (part ${paginationCycles + 1})…`);
          dbg(`[loop:paginate] cycle=${paginationCycles} reason=${hitTokenLimit ? 'length' : 'tag'} path="${targetPath}"`);

          // Strip the continue_writing tag from prior output before appending
          const priorOutput = attemptResult.output.replace(continueWritingRe, '').trimEnd();

          const continuationMessages = [
            { role: 'system' as const, content: dispatch.systemPrompt },
            ...dispatch.messages,
            { role: 'assistant' as const, content: priorOutput },
            {
              role: 'user' as const,
              content: targetPath
                ? `Continue writing the file \`${targetPath}\` from exactly where you left off. ` +
                  `Do not repeat any content already written. Continue seamlessly.`
                : `You were cut off. Continue your response from exactly where you left off. ` +
                  `Do not repeat any content already written. Continue seamlessly.`,
            },
          ];

          const continued = await this.runSingleStream(
            reply, continuationMessages, taskId, attemptResult.thinking, sendEngineThinking, assistantMessageId
          );

          // Concatenate: prior output + continuation. If continuation is empty, stop.
          if (!continued.output.trim()) break;
          attemptResult.output = priorOutput + '\n' + continued.output;
          attemptResult.finishReason = continued.finishReason;
        }

        // ── Parse tool calls ──────────────────────────────────────────────────
        const parsed = this.toolParser.parse(attemptResult.output);

        if (parsed.toolCalls.length === 0) {
          // Pure Q&A / analysis — no file changes
          taskApproved = true;
          break;
        }

        dbg(`[loop:parse] task=${task.index} toolCalls=${parsed.toolCalls.length} hasRead=${parsed.hasReadRequest} tools=${JSON.stringify(parsed.toolCalls.map(c => c.tool + ':' + c.path))}`);
        // ── read_file → act cycle ──────────────────────────────────────────────
        let currentOutput = attemptResult.output;
        let currentParsed = parsed;
        let readCycles = 0;

        while (
          currentParsed.hasReadRequest &&
          currentParsed.toolCalls.every(c => c.tool === 'read_file') &&
          readCycles < LoopController.MAX_READ_CYCLES
        ) {
          readCycles++;
          agentState.transition('reading', `files (${readCycles})`, task.index, total);
          sendStatus(`[${task.index}/${total}] Reading files (${readCycles})…`);
          const readResults = await toolExecutor.executeAll(currentParsed.toolCalls);
          const readFeedback = readResults
            .map(r => r.success
              ? `<file_contents path="${r.path}">\n${r.content}\n</file_contents>`
              : `<file_error path="${r.path}">${r.error}</file_error>`
            )
            .join('\n');
          const continuationMessages = [
            { role: 'system' as const, content: dispatch.systemPrompt },
            ...dispatch.messages,
            { role: 'assistant' as const, content: currentOutput },
            { role: 'user' as const, content: `Here are the file contents you requested:\n\n${readFeedback}\n\nNow proceed with your changes.` },
          ];
          sendStatus(`[${task.index}/${total}] Engine continuing after file read…`);
          const continued = await this.runSingleStream(
            reply, continuationMessages, taskId, attemptResult.thinking, sendEngineThinking, assistantMessageId
          );
          currentOutput = continued.output;
          currentParsed = this.toolParser.parse(currentOutput);
        }

        // ── Execute writes ────────────────────────────────────────────────────
        const writeCalls = currentParsed.toolCalls.filter(c => c.tool !== 'read_file');

        if (writeCalls.length === 0) {
          taskApproved = true;
          break;
        }

        const execDetail = writeCalls[0]?.path ? writeCalls[0].path.split('/').pop()! : `${writeCalls.length} ops`;
        agentState.transition('executing', execDetail, task.index, total);
        sendStatus(`[${task.index}/${total}] Executing ${writeCalls.length} operation(s)…`);
        const toolResults = await toolExecutor.simulateAll(writeCalls) as StagedFileToolResult[];

        // Collect staging dirs for cleanup after delivery
        for (const r of toolResults) {
          if (r.stagedPath) {
            const dir = r.stagedPath.substring(0, r.stagedPath.lastIndexOf('/'));
            const stageRoot = dir.substring(0, dir.lastIndexOf('/'));
            if (!stagingDirsToClean.includes(stageRoot)) stagingDirsToClean.push(stageRoot);
          }
        }

        dbg(`[loop:exec] task=${task.index} writes=${writeCalls.length} results=${JSON.stringify(toolResults.map(r => r.tool + ':' + r.path + '=' + (r.success ? 'ok' : r.error?.slice(0,60))))}`);
        const failedOps = toolResults.filter(r => !r.success);
        if (failedOps.length > 0) {
          const errorSummary = failedOps.map(r => `${r.tool} ${r.path}: ${r.error}`).join('\n');
          this.sendEvent(reply, { type: 'build_result', success: false, errors: errorSummary });
          retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: `File operations failed:\n${errorSummary}` };
          taskFailReason = errorSummary;
          continue;
        }

        const writtenFiles = toolResults.filter(r => r.success && r.content && r.tool !== 'read_file' && r.tool !== 'generate_image');
        await this.persistAndSend(reply, {
          type: 'patches_applied',
          count: writtenFiles.length,
          files: writtenFiles.map(r => r.path),
        }, assistantMessageId);

        for (const r of writtenFiles) {
          if (!allChangedFiles.includes(r.path)) allChangedFiles.push(r.path);
          if (r.content) stagedContents.set(r.path, r.content);
        }
        for (const result of writtenFiles) {
          if (result.content) {
            await this.persistAndSend(reply, {
              type: 'file_panel',
              filename: result.path,
              language: result.path.split('.').pop() ?? 'text',
              code: result.content,
            }, assistantMessageId);
          }
        }

        // ── Syntax validation ──────────────────────────────────────────────────
        let syntaxError: { filePath: string; result: { valid: false; error: string; line?: number } } | null = null;
        for (const result of writtenFiles) {
          if (!result.content) continue;
          const validation = await syntaxValidator.validate(result.path, result.content);
          if (!validation.valid) {
            syntaxError = { filePath: result.path, result: validation as { valid: false; error: string; line?: number } };
            break;
          }
        }
        if (syntaxError) {
          const errMsg = `Syntax error in ${syntaxError.filePath} at line ${syntaxError.result.line ?? '?'}: ${syntaxError.result.error}`;
          this.sendEvent(reply, { type: 'build_result', success: false, errors: errMsg });
          retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: errMsg };
          taskFailReason = errMsg;
          continue;
        }

        // ── Build (only after last task) ─────────────────────────────────────
        // Intermediate tasks may leave the project in a temporarily broken state
        // (e.g. new imports not yet created). Only run the full build after the
        // final task so partial-completion states don’t cause false failures.
        const isLastTask = task.index === tasks.length;
        if (!this.options.skipBuild && isLastTask) {
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
                taskFailReason = 'Build failed';
                continue;
              }
            } else {
              this.sendEvent(reply, { type: 'build_result', success: true });
            }
          }
        }

        // ── Review ──────────────────────────────────────────────────────────────
        sendStatus(`[${task.index}/${total}] Reviewing…`);
        const changedSummary = writtenFiles.map(r => `${r.tool} ${r.path}`).join('\n');
        // Pass full file content to reviewer (up to 4000 chars each) so SAYON can
        // meaningfully assess code quality, not just see 400-char XML snippets.
        const reviewOutput = writtenFiles
          .map(r => `File: ${r.path}\nOperation: ${r.tool}\n---\n${(r.content ?? '').slice(0, 4_000)}\n---`)
          .join('\n\n');
        agentState.transition('reviewing', task.title.slice(0, 20), task.index, total);
        dbg(`[loop:review:in] task=${task.index} prompt="${task.prompt.slice(0, 120).replace(/\n/g, ' ')}" changed="${changedSummary}" outputLen=${reviewOutput.length}`);
        const review = await this.runReviewDispatch(task.prompt, reviewOutput, changedSummary, sendThinking);  // coordinator thinking

        dbg(`[loop:review:out] task=${task.index} score=${review.score} decision=${review.decision} guidance="${(review.guidance ?? '').slice(0, 120)}"`);
        attemptResult.reviewScore = review.score;
        attemptResult.approved = review.decision === 'APPROVE';
        this.sendEvent(reply, { type: 'review', score: review.score, decision: review.decision, guidance: review.guidance });

        if (review.decision === 'APPROVE') {
          taskApproved = true;
          taskFailReason = undefined;
          break;
        }

        if (attempt < maxAttempts && review.decision === 'NEEDS_REVISION') {
          retryContext = {
            attemptNumber: attempt,
            priorThinking: attemptResult.thinking,
            guidanceFromReview: review.guidance,
            reviewIssues: review.issues,
            priorOutput: attemptResult.output,
          };
          taskFailReason = review.guidance ?? 'Needs revision';
          continue;
        }

        // REJECT is terminal — do not retry. NEEDS_REVISION at maxAttempts also lands here.
        taskFailReason = review.guidance ?? 'Max attempts reached';
        dbg(`[loop:exit] task=${task.index} attempt=${attempt} REJECT/maxAttempts — breaking`);
        break;
      } // end attempt loop

      dbg(`[loop:task:done] task=${task.index} approved=${taskApproved} failReason="${taskFailReason ?? ''}"`);
      if (taskApproved) {
        this.sendEvent(reply, { type: 'task_complete', taskIndex: task.index, total, title: task.title });

        // ── Store completed output and inject into downstream tasks ─────────
        // When SEREN marks a task with outputRequiredBy, its full output is
        // injected into the prompt of those downstream tasks before they run.
        // This is how analyze/respond tasks pass their results forward.
        const taskOutput = taskAttempts[taskAttempts.length - 1]?.output ?? '';
        task.completedOutput = taskOutput;

        if (task.outputRequiredBy && task.outputRequiredBy.length > 0 && taskOutput.trim()) {
          for (const targetIdx of task.outputRequiredBy) {
            const targetTask = tasks.find(t => t.index === targetIdx);
            if (targetTask) {
              const injectionBlock =
                `\n\n<prior_task_output from_task="${task.index}" title="${task.title}">\n` +
                taskOutput.slice(0, 12_000) +  // cap at 12k chars — generous but bounded
                `\n</prior_task_output>\n`;
              targetTask.prompt = targetTask.prompt + injectionBlock;
              dbg(`[loop:inject] task ${task.index} output → task ${targetIdx} prompt (${taskOutput.length} chars)`);
            }
          }
        }

        // ── Generate task summary for rolling log ──────────────────────────
        // The executor writes a short plain-prose summary of what was done.
        // This gets passed to every subsequent task as context so executors
        // can see the work completed before them and build on it cleanly.
        if (tasks.length > 1) {
          try {
            const lastOutput = taskAttempts[taskAttempts.length - 1]?.output ?? '';
            // Collect files changed during this specific task by comparing
            // allChangedFiles before vs after — we track the delta via taskStartFileCount.
            const taskChangedFiles = allChangedFiles
              .filter((v, i, arr) => arr.indexOf(v) === i)
              .slice(taskStartFileCount)
              .join(', ');
            const changedFilesList = taskChangedFiles;

            const summaryPrompt =
              `You just completed a task. Write a single short sentence (max 25 words) ` +
              `summarising exactly what was done. Be specific — mention file names and what changed. ` +
              `Do NOT mention what still needs to be done. Plain prose only, no markdown.\n\n` +
              `Task: ${task.title}\n` +
              (changedFilesList ? `Files modified: ${changedFilesList}\n` : '') +
              `Output excerpt: ${lastOutput.slice(0, 400)}`;

            // Task log summaries are always short (25 words) — coordinator handles
            // both SAYON and SEREN task summaries. No SSE stream needed.
            const summaryText = await coordinatorCall({
              systemPrompt: '',
              messages: [{ role: 'user', content: summaryPrompt }],
              maxTokens: 80,
              temperature: 0.1,
              mode: 'no_think',
            });

            const cleanSummary = summaryText.trim().replace(/^["']|["']$/g, '');
            taskLog.push(cleanSummary);
            dbg(`[loop:tasklog] task=${task.index} summary="${cleanSummary}"`);
          } catch (err) {
            // Non-fatal — push a simple fallback so the log stays aligned
            taskLog.push(`${task.title} completed.`);
            console.warn('[LoopController] Task summary generation failed (non-fatal):', err);
          }
        }
      } else {
        this.sendEvent(reply, { type: 'task_failed', taskIndex: task.index, total, title: task.title, reason: taskFailReason ?? 'Unknown' });
      }

      taskResults.push({ task, approved: taskApproved, attempts: taskAttempts, failReason: taskFailReason });
      this.budgetMonitor.reset(taskId);
    } // end task loop

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
