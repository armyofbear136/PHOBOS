import type { FastifyReply } from 'fastify';
import { AgentStateManager, type AgentStateEvent } from './AgentStateManager.js';
import { engineClient, coordinatorClient, ENGINE_MODEL, COORDINATOR_MODEL, ENGINE_PROVIDER, COORDINATOR_PROVIDER, applyThinkingStrategy, getThinkingStrategy, getThinkingExtraBody, coordinatorStream } from './clients.js';
import { DispatchComposer, type ComposeInput } from './DispatchComposer.js';
import { ContextIngester } from './ContextIngester.js';
import { TaskPlanner } from './TaskPlanner.js';
import { DeliveryComposer } from './DeliveryComposer.js';
import { StreamParser } from './StreamParser.js';
import { InterventionHandler } from './InterventionHandler.js';
import { ThinkingBudgetMonitor } from './ThinkingBudgetMonitor.js';
import { FileToolParser } from '../patch/FileToolParser.js';
import { FileToolExecutor } from '../patch/FileToolExecutor.js';
import type { StagedFileToolResult } from '../patch/FileToolExecutor.js';
import { SyntaxValidator } from '../patch/SyntaxValidator.js';
import { BuildRunner } from '../build/BuildRunner.js';
import { ErrorFormatter } from '../build/ErrorFormatter.js';
import type { FileToolResult } from './FileTools.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * ToolTagFilter — streaming XML suppressor for file tool calls.
 *
 * ALLMIND emits tool calls as raw XML in the output stream, e.g.:
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
  // OR a self-closing read_file tag. Anchored to catch across chunk boundaries
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
  /** True when ALLMIND determined it needs more info from the user before executing */
  needsClarification?: boolean;
  /** The questions ALLMIND asked — populated when needsClarification is true */
  clarificationQuestions?: string[];
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
  | { type: 'complete'; approved: boolean; bestAttempt: number }
  | { type: 'thinking_retry'; attempt: number }
  | { type: 'clarification_needed'; questions: string[] }
  | { type: 'error'; message: string };

interface StreamResult {
  thinking: string;
  output: string;
  interventionResumePrompt?: string;
  interventionQuestion?: string;
}

export class LoopController {
  private composer = new DispatchComposer();
  private deliveryComposer = new DeliveryComposer();
  private interventionHandler = new InterventionHandler();
  private toolParser = new FileToolParser();
  private budgetMonitor = new ThinkingBudgetMonitor();

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

    // ── Agent state manager — emits agent_state SSE events ─────────────────
    const agentState = new AgentStateManager((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      this.options.onAgentState?.(event);
    });

    const toolExecutor = new FileToolExecutor(projectRoot);
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
      composeInput.intentType        // intent-aware rewrite prompt branching
    );

    // After ingestion always go idle briefly before next stage (planning or direct dispatch)
    agentState.transition('idle', '');

    // Update composeInput with Stage 1 outputs.
    // Merge any inline content blocks extracted from the user message into
    // loadedFiles so they reach ALLMIND via the <loaded_files> injection path
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
    };

    await this.persistAndSend(
      reply,
      { type: 'coordinator', content: ingestion.coordinatorSummary, source: 'coordinator' },
      assistantMessageId
    );

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
      const plan = await planner.plan(
        ingestion.rewrittenUserMessage,
        ingestion.fileSummaries,
        composeInput.repoMap ?? '',
        sendStatus,
        sendThinking,            // SAYON: discovery + extraction thinking → coordinator panel
        sendEngineThinking,      // ALLMIND: decomposition thinking → engine panel
        this.options.onThinkPhaseComplete,  // closes the planning engine segment in DB
        composeInput.clarificationIteration,  // weight system for clarification loop
        composeInput.clarificationLog         // full Q&A transcript for this loop
      );
      // Persist planner engine thinking so it survives thread switch/server restart
      if (plannerEngineThinkingAccum && assistantMessageId) {
        await this.options.persistEvent?.('thinking_complete', {
          type: 'thinking_complete',
          content: plannerEngineThinkingAccum,
          source: 'engine',
        }, assistantMessageId).catch(() => {});
      }
      // If intent is CODE_REQUEST, remap any 'analyze' operation to 'modify'.
      // The coordinator sometimes returns 'analyze' for simple single-file edits
      // (e.g. "add text to test.txt") when the workspace has few/no files to discover.
      // An 'analyze' task sends a read-only directive to the engine, causing an
      // infinite read_file loop. CODE_REQUEST always means something should change.
      if (composeInput.intentType === 'CODE_REQUEST') {
        plan.tasks = plan.tasks.map((t) =>
          t.operation === 'analyze' ? { ...t, operation: 'modify' as const } : t
        );
      }

      // ── NEEDS_CLARIFICATION exit ───────────────────────────────────────────
      // ALLMIND determined it cannot proceed without more information from the user.
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
        console.log(`[loop:clarification] ${plan.clarificationQuestions.length} question(s) — returning early`);

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
      console.log(`[loop:plan] ${tasks.length} task(s) planned`);
      for (const t of tasks) {
        console.log(`[loop:plan:task${t.index}] op=${t.operation} file="${t.targetFile}" title="${t.title}"`);
      }
    } else {
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

    for (const task of tasks) {
      const total = tasks.length;

      this.sendEvent(reply, {
        type: 'task_start',
        taskIndex: task.index,
        total,
        title: task.title,
      });
      sendStatus(`[${task.index}/${total}] ${task.title}…`);

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

        const dispatch = await this.composer.compose({
          ...composeInput,
          currentTask: task,
          conversationHistory: needsPlanning ? [] : composeInput.conversationHistory,
          retryContext: retryContext ? { ...retryContext, attemptNumber: attempt } : undefined,
        });

        console.log(`[loop:attempt] task=${task.index}/${total} attempt=${attempt}/${maxAttempts} retryCtx=${retryContext ? 'yes' : 'none'}`);
        agentState.transition('thinking', task.title.slice(0, 20), task.index, total);
        sendStatus(`[${task.index}/${total}] Engine thinking…`);

        // ── Engine stream ────────────────────────────────────────────────────────
        const attemptResult = await this.runEngineWithInterventions(
          reply, dispatch, task.prompt, taskId, attempt, sendEngineThinking, assistantMessageId
        );
        attemptResult.taskIndex = task.index;
        taskAttempts.push(attemptResult);
        allAttempts.push(attemptResult);

        // ── Parse tool calls ──────────────────────────────────────────────────
        const parsed = this.toolParser.parse(attemptResult.output);

        if (parsed.toolCalls.length === 0) {
          // Pure Q&A / analysis — no file changes
          taskApproved = true;
          break;
        }

        console.log(`[loop:parse] task=${task.index} toolCalls=${parsed.toolCalls.length} hasRead=${parsed.hasReadRequest} tools=${JSON.stringify(parsed.toolCalls.map(c => c.tool + ':' + c.path))}`);
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
            reply, continuationMessages, taskId, attemptResult.thinking, sendThinking, assistantMessageId
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

        console.log(`[loop:exec] task=${task.index} writes=${writeCalls.length} results=${JSON.stringify(toolResults.map(r => r.tool + ':' + r.path + '=' + (r.success ? 'ok' : r.error?.slice(0,60))))}`);
        const failedOps = toolResults.filter(r => !r.success);
        if (failedOps.length > 0) {
          const errorSummary = failedOps.map(r => `${r.tool} ${r.path}: ${r.error}`).join('\n');
          this.sendEvent(reply, { type: 'build_result', success: false, errors: errorSummary });
          retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, errorOutput: `File operations failed:\n${errorSummary}` };
          taskFailReason = errorSummary;
          continue;
        }

        const writtenFiles = toolResults.filter(r => r.success && r.content && r.tool !== 'read_file');
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
              console.log('[LoopController] Build: no-inputs error — skipped');
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
        console.log(`[loop:review:in] task=${task.index} prompt="${task.prompt.slice(0, 120).replace(/\n/g, ' ')}" changed="${changedSummary}" outputLen=${reviewOutput.length}`);
        const review = await this.runReviewDispatch(task.prompt, reviewOutput, changedSummary, sendThinking);  // coordinator thinking

        console.log(`[loop:review:out] task=${task.index} score=${review.score} decision=${review.decision} guidance="${(review.guidance ?? '').slice(0, 120)}"`);
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
        console.log(`[loop:exit] task=${task.index} attempt=${attempt} REJECT/maxAttempts — breaking`);
        break;
      } // end attempt loop

      console.log(`[loop:task:done] task=${task.index} approved=${taskApproved} failReason="${taskFailReason ?? ''}"`);
      if (taskApproved) {
        this.sendEvent(reply, { type: 'task_complete', taskIndex: task.index, total, title: task.title });
      } else {
        this.sendEvent(reply, { type: 'task_failed', taskIndex: task.index, total, title: task.title, reason: taskFailReason ?? 'Unknown' });
      }

      taskResults.push({ task, approved: taskApproved, attempts: taskAttempts, failReason: taskFailReason });
      this.budgetMonitor.reset(taskId);
    } // end task loop

    // ── Stage 4.5: ALLMIND Final Validation ──────────────────────────────────
    // For multi-task plans or plans with failures, ALLMIND reviews all completed
    // work holistically. Single approved tasks skip this — the per-task review
    // already covered them.
    let overallApproved = taskResults.length > 0 && taskResults.every(r => r.approved);
    let validationSummary: string | undefined;

    const needsFinalValidation =
      taskResults.length > 1 ||
      taskResults.some(r => !r.approved);

    if (needsFinalValidation && allChangedFiles.length > 0) {
      agentState.transition('reviewing', 'Final validation');
      sendStatus('ALLMIND validating all changes…');

      try {
        validationSummary = await this.runFinalValidation(
          composeInput.userMessage,
          taskResults,
          allChangedFiles,
          stagedContents,
          sendEngineThinking,
          assistantMessageId,
        );
        console.log(`[loop:validation] summary="${(validationSummary ?? '').slice(0, 200).replace(/\n/g, ' ')}"`);
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
   * Stage 5: Ask ALLMIND to assemble a final natural-language summary,
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
        { type: 'coordinator', content: delivery, source: 'coordinator' },
        assistantMessageId
      );
    } catch (err) {
      console.warn('[LoopController] Stage 5 delivery failed, skipping:', err);
    }
  }

  /**
   * Stage 4.5: ALLMIND holistic validation of all completed work.
   *
   * Reads the final state of all changed files from disk and asks ALLMIND
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

    const prompt =
      `You are ALLMIND performing final validation. Review ALL completed work as a coherent whole.\n\n` +
      `ORIGINAL REQUEST:\n${originalRequest.slice(0, 2_000)}\n\n` +
      `TASK OUTCOMES:\n${taskOutcomes}\n\n` +
      `FINAL FILE STATE:\n${fileContents.join('\n\n')}\n\n` +
      `Evaluate holistically:\n` +
      `1. Does the combined output satisfy the original request?\n` +
      `2. Are there cross-file inconsistencies (mismatched imports, naming, types)?\n` +
      `3. Is anything missing that the request implied but no task addressed?\n` +
      `4. Are there any obvious integration issues between the changed files?\n\n` +
      `Respond with a brief validation summary (2-4 sentences). ` +
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
    assistantMessageId?: string
  ): Promise<AttemptResult> {
    let accumulatedThinking = '';
    let finalOutput = '';
    let interventionCount = 0;

    let engineMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: dispatch.systemPrompt },
      ...dispatch.messages,
    ];

    while (true) {
      const streamResult = await this.runSingleStream(
        reply, engineMessages, taskId, accumulatedThinking, sendThinking, assistantMessageId
      );

      accumulatedThinking += streamResult.thinking;
      finalOutput = streamResult.output;

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

    console.log(`[LoopController:engine:thinking_complete] length=${accumulatedThinking.length} msgId=${assistantMessageId?.slice(0,8) ?? 'undefined'}`);
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
    };
  }

  private async runSingleStream(
    reply: FastifyReply,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    taskId: string,
    priorThinkingContext: string,
    sendThinking: (token: string) => void,
    assistantMessageId?: string
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

    // Read the live baseURL from the client object — always current even in esbuild CJS
    // bundles where module-level `let` exports are captured at init time.
    const engineBaseURL = engineBaseURLEarly;
    const isPhobosLive = /127\.0\.0\.1:526/.test(engineBaseURL) || /localhost:526/.test(engineBaseURL);

    const engineExtraBody = getThinkingExtraBody(liveProvider, liveModel, 'think');
    console.log(`[engine:config] provider=${liveProvider} model=${liveModel} baseURL=${engineBaseURLEarly} extraBody=${JSON.stringify(engineExtraBody)}`);
    const engineCallParams = {
      model: liveModel,
      messages: finalMessages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      max_tokens: 32768,
      temperature: 0.4,
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
            const delta = parsed?.choices?.[0]?.delta;
            if (delta) yield delta as Record<string, unknown>;
          } catch { /* malformed chunk — skip */ }
        }
      }
    }

    let stream: import('openai/streaming').Stream<import('openai/resources').ChatCompletionChunk> | null = null;
    let rawStream: AsyncGenerator<Record<string, unknown>> | null = null;

    if (useRawFetch) {
      const baseURL = ((engineClient as unknown as { baseURL?: string }).baseURL ?? 'http://127.0.0.1:52627/v1').replace(/\/$/, '');
      rawStream = rawSseStream(
        `${baseURL}/chat/completions`,
        { ...engineCallParams },
        abortController.signal
      );
    } else {
      try {
        stream = await engineClient.chat.completions.create(
          { ...engineCallParams, stream: true as const },
          { signal: abortController.signal }
        );
      } catch (createErr: unknown) {
        console.error(`[engine:create:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        console.log('[engine:create:retry] Retrying without extra_body...');
        const fallbackParams = { ...engineCallParams };
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

    let fieldThinkBuf = ''; // accumulates thinking tokens on field-path (parser not used there)
    const toolFilter = new ToolTagFilter(); // suppresses tool XML from output_token stream
    try {
      let emittedThinkLen = 0;
      let emittedOutputLen = 0;
      let _dbgN = 0;
      const engineStrategy = getThinkingStrategy(liveProvider, liveModel);
      console.log(`[engine:strategy] thinkingPath=${engineStrategy.thinkingPath}`);

      for await (const delta of deltaIterator()) {
        if (streamAborted) break;

        // Log first 3 chunks fully
        if (_dbgN <= 2) {
          console.log(`[engine:delta:${_dbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))}`);
          console.log(`[engine:delta:${_dbgN}] content=${JSON.stringify(delta?.content)} thinking=${JSON.stringify(delta?.thinking)} reasoning=${JSON.stringify(delta?.reasoning_content ?? delta?.reasoning)}`);
        }
        _dbgN++;

        if (engineStrategy.thinkingPath === 'field') {
          // Ollama Qwen3: thinking in dedicated field, content in delta.content — fully separate streams
          const d = delta as Record<string, unknown>;
          let thinkToken = (d.thinking ?? d.reasoning_content ?? d.reasoning) as string | null | undefined;
          const outToken = d.content as string | null | undefined;

          if (thinkToken) {
            // Strip any <think>/<think> wrapper tags some providers inject into the field
            thinkToken = thinkToken.replace(/<\/?think>/g, '');
            if (thinkToken) {
              if (_dbgN <= 3) console.log(`[engine:think:field] ${JSON.stringify(thinkToken.slice(0, 80))}`);
              // Send directly — do NOT feed parser (would cause double-emit when outToken arrives)
              fieldThinkBuf += thinkToken;
              sendThinking(thinkToken);
            }
          }
          if (outToken) {
            // Content is clean on field-path providers — no <think> tags in delta.content
            parser.feedOutput(outToken);
            this.options.onOutputChunk?.(outToken, assistantMessageId).catch(() => {});
            const safeToken = toolFilter.feed(outToken);
            if (safeToken) {
              reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: safeToken })}\n\n`);
            }
            emittedOutputLen += outToken.length;
          }
        } else {
          // FastFlowLLM Qwen3 / Llama: everything in delta.content, <think> tags separate it
          const outToken = delta?.content as string | null | undefined;

          if (outToken != null) {
            _dbgN++;
            if (_dbgN <= 3 || outToken.includes('<think') || outToken.includes('</think')) {
              console.log(`[engine:${_dbgN}] raw=${JSON.stringify(outToken.slice(0, 100))}`);
            }
          }

          if (outToken) {
            parser.feed(outToken);
            const { thinking: thinkBuf, output: outBuf } = parser.getBuffers();
            const newThink = thinkBuf.slice(emittedThinkLen);
            if (newThink) {
              emittedThinkLen = thinkBuf.length;
              sendThinking(newThink);
            }
            const newOut = outBuf.slice(emittedOutputLen);
            if (newOut) {
              emittedOutputLen = outBuf.length;
              this.options.onOutputChunk?.(newOut, assistantMessageId).catch(() => {});
              const safeOut = toolFilter.feed(newOut);
              if (safeOut) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: safeOut })}\n\n`);
              }
            }
          }
        }

        const thinkCount = parser.getThinkTokenCount();
        if (thinkCount > 4000 && thinkCount % 500 < 10) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'status', content: `Thinking: ${thinkCount} tokens…` })}\n\n`);
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      if (!isAbort) throw err;
    }

    parser.complete();
    const { thinking: parserThinking, output: streamOutput } = parser.getBuffers();
    const streamThinking = fieldThinkBuf || parserThinking;

    // Flush any safe content held in the filter buffer (e.g. text after the last tool block)
    const filterFlush = toolFilter.flush();
    if (filterFlush) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: filterFlush })}

`);
    }

    if (interventionQuestion === null) {
      return { thinking: streamThinking, output: streamOutput };
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
    const reviewSystem =
      'You are SAYON, a coordinator reviewing whether a coding engine correctly solved a task. ' +
      'Evaluate the output against these criteria:\n' +
      '1. CORRECTNESS: Does the output address the original task? Are the right files targeted?\n' +
      '2. COMPLETENESS: Is the code complete (not truncated, not stubbed, not placeholder)?\n' +
      '3. QUALITY: Are there obvious syntax errors, logic flaws, or missing imports?\n' +
      '4. PRESERVATION: Do the changes preserve existing functionality that should remain?\n\n' +
      'Respond with ONLY a JSON object (no preamble, no markdown):\n' +
      '{\n' +
      '  "score": 0.0-1.0,\n' +
      '  "decision": "APPROVE|NEEDS_REVISION|REJECT",\n' +
      '  "issues": [\n' +
      '    {\n' +
      '      "file": "filename",\n' +
      '      "line_range": "45-60 (optional, if identifiable)",\n' +
      '      "issue": "what is wrong",\n' +
      '      "expected": "what should be there instead (optional)"\n' +
      '    }\n' +
      '  ],\n' +
      '  "guidance": "overall direction for the next attempt"\n' +
      '}\n\n' +
      'APPROVE (score >= 0.8): correct file, content matches request, no obvious defects.\n' +
      'NEEDS_REVISION (0.5-0.8): right direction but has specific fixable issues — list them.\n' +
      'REJECT (score < 0.5): wrong file, stub/placeholder code, or described instead of doing.\n' +
      'If approving, issues array should be empty.';

    const reviewPrompt =
      `ORIGINAL TASK:\n${originalTask.slice(0, 2_000)}\n\n` +
      `CHANGES MADE:\n${changedSummary}\n\n` +
      `FILE CONTENTS AFTER CHANGES:\n${output.slice(0, 8_000)}`;

    console.log(`[review:prompt] ${reviewPrompt.slice(0, 400).replace(/\n/g, ' ')}`);
    try {
      const stripped = await coordinatorStream({
        systemPrompt: reviewSystem,
        messages: [{ role: 'user', content: reviewPrompt }],
        maxTokens: 512,
        temperature: 0.1,
        mode: 'think',
        onThinkToken: sendThinking,
      });
      console.log(`[review:raw] "${stripped.slice(0, 300).replace(/\n/g, ' ')}"`);
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      const cleaned = jsonMatch ? jsonMatch[0] : stripped;
      const parsed = JSON.parse(cleaned);

      // Parse structured issues if present
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
