import type { FastifyReply } from 'fastify';
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
import { SyntaxValidator } from '../patch/SyntaxValidator.js';
import { BuildRunner } from '../build/BuildRunner.js';
import { ErrorFormatter } from '../build/ErrorFormatter.js';
import type { FileToolResult } from './FileTools.js';
import fs from 'fs/promises';
import path from 'path';

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
}

export type SSEEvent =
  | { type: 'status'; content: string }
  | { type: 'coordinator'; content: string }
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
    const sendEngineThinking = this.makeThinkingSender(reply, 'engine');
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

    const ingester = new ContextIngester(workspaceDir);
    const ingestion = await ingester.ingest(
      fileList,
      composeInput.userMessage,
      composeInput.projectMd,
      composeInput.repoMap ?? '',
      sendStatus,
      sendThinking,
      composeInput.chatSummary
    );

    // Update composeInput with Stage 1 outputs
    composeInput = {
      ...composeInput,
      userMessage: ingestion.rewrittenUserMessage,
      fileSummaries: ingestion.fileSummaries,
    };

    await this.persistAndSend(
      reply,
      { type: 'coordinator', content: ingestion.coordinatorSummary },
      assistantMessageId
    );

    const allAttempts: AttemptResult[] = [];
    const allChangedFiles: string[] = [];

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
      const planner = new TaskPlanner(workspaceDir);
      const plan = await planner.plan(
        ingestion.rewrittenUserMessage,
        ingestion.fileSummaries,
        composeInput.repoMap ?? '',
        sendStatus,
        sendThinking
      );
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
      tasks = plan.tasks;
      // Emit plan summary as coordinator bubble (distinct from Stage 1 summary)
      await this.persistAndSend(
        reply,
        { type: 'coordinator', content: plan.planSummary },
        assistantMessageId
      );
      console.log(`[LoopController] Stage 3: ${tasks.length} task(s) planned`);
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

        sendStatus(`[${task.index}/${total}] Executing ${writeCalls.length} operation(s)…`);
        const toolResults = await toolExecutor.executeAll(writeCalls);

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
        const review = await this.runReviewDispatch(task.prompt, currentOutput, changedSummary, sendThinking);  // coordinator thinking

        attemptResult.reviewScore = review.score;
        attemptResult.approved = review.decision === 'APPROVE';
        this.sendEvent(reply, { type: 'review', score: review.score, decision: review.decision, guidance: review.guidance });

        if (review.decision === 'APPROVE') {
          taskApproved = true;
          taskFailReason = undefined;
          break;
        }

        if (attempt < maxAttempts && review.decision === 'NEEDS_REVISION') {
          retryContext = { attemptNumber: attempt, priorThinking: attemptResult.thinking, guidanceFromReview: review.guidance };
          taskFailReason = review.guidance ?? 'Needs revision';
          continue;
        }

        taskFailReason = review.guidance ?? 'Max attempts reached';
      } // end attempt loop

      if (taskApproved) {
        this.sendEvent(reply, { type: 'task_complete', taskIndex: task.index, total, title: task.title });
      } else {
        this.sendEvent(reply, { type: 'task_failed', taskIndex: task.index, total, title: task.title, reason: taskFailReason ?? 'Unknown' });
      }

      taskResults.push({ task, approved: taskApproved, attempts: taskAttempts, failReason: taskFailReason });
      this.budgetMonitor.reset(taskId);
    } // end task loop

    // ── Stage 5: Delivery ──────────────────────────────────────────────────────
    const overallApproved = taskResults.length > 0 && taskResults.every(r => r.approved);
    await this.emitDelivery(
      reply,
      composeInput.userMessage,
      ingestion.rewrittenUserMessage,
      allAttempts,
      allChangedFiles,
      overallApproved,
      assistantMessageId,
      taskResults
    );

    // Persist coordinator thinking accumulated during the loop (planning, review calls)
    if (coordinatorThinkingAccum && assistantMessageId) {
      await this.options.persistEvent?.('thinking_complete', {
        type: 'thinking_complete',
        content: coordinatorThinkingAccum,
        source: 'coordinator',
      }, assistantMessageId).catch(() => {});
    }

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

    return allAttempts;
  }

  /**
   * Stage 5: Ask the coordinator to assemble a final natural-language summary,
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
    taskResults?: Array<{ task: import('./TaskPlanner.js').Task; approved: boolean; attempts: AttemptResult[]; failReason?: string }>
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
      });
      await this.persistAndSend(
        reply,
        { type: 'coordinator', content: delivery },
        assistantMessageId
      );
    } catch (err) {
      console.warn('[LoopController] Stage 5 delivery failed, skipping:', err);
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

    // Apply thinking activation strategy for the current engine model/provider
    const { messages: thinkMessages, systemPrompt: thinkSystemPrompt } = applyThinkingStrategy(
      messages.filter(m => m.role !== 'system'),
      messages.find(m => m.role === 'system')?.content ?? '',
      ENGINE_PROVIDER,
      ENGINE_MODEL,
      'think'
    );
    const finalMessages = thinkSystemPrompt
      ? [{ role: 'system' as const, content: thinkSystemPrompt }, ...thinkMessages]
      : thinkMessages;

    const engineExtraBody = getThinkingExtraBody(ENGINE_PROVIDER, ENGINE_MODEL, 'think');
    console.log(`[engine:config] provider=${ENGINE_PROVIDER} model=${ENGINE_MODEL} extraBody=${JSON.stringify(engineExtraBody)}`);
    const engineCallParams = {
      model: ENGINE_MODEL,
      messages: finalMessages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      max_tokens: 32768,
      temperature: 0.4,
      ...(Object.keys(engineExtraBody).length > 0 ? { extra_body: engineExtraBody } : {}),
    };

    let stream: Awaited<ReturnType<typeof engineClient.chat.completions.create>>;
    try {
      stream = await engineClient.chat.completions.create(
        { ...engineCallParams, stream: true as const },
        { signal: abortController.signal }
      );
    } catch (createErr: unknown) {
      // Ollama may reject think:true for certain models — retry without it
      console.error(`[engine:create:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      console.log('[engine:create:retry] Retrying without extra_body...');
      const fallbackParams = { ...engineCallParams };
      delete (fallbackParams as Record<string, unknown>).extra_body;
      stream = await engineClient.chat.completions.create(
        { ...fallbackParams, stream: true as const },
        { signal: abortController.signal }
      );
    }

    let fieldThinkBuf = ''; // accumulates thinking tokens on field-path (parser not used there)
    try {
      let emittedThinkLen = 0;
      let emittedOutputLen = 0;
      let _dbgN = 0;
      const engineStrategy = getThinkingStrategy(ENGINE_PROVIDER, ENGINE_MODEL);
      console.log(`[engine:strategy] thinkingPath=${engineStrategy.thinkingPath}`);

      for await (const chunk of stream) {
        if (streamAborted) break;

        const delta = chunk.choices[0]?.delta as Record<string, unknown>;

        // Log first 3 chunks fully — shows ALL delta keys Ollama actually sends
        if (_dbgN <= 2) {
          console.log(`[engine:delta:${_dbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))}`);
          console.log(`[engine:delta:${_dbgN}] content=${JSON.stringify(delta?.content)} thinking=${JSON.stringify((delta as any)?.thinking)} reasoning=${JSON.stringify((delta as any)?.reasoning_content ?? (delta as any)?.reasoning)}`);
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
              this.options.onThinkChunk?.(thinkToken, 'engine', assistantMessageId).catch(() => {});
              sendThinking(thinkToken);
            }
          }
          if (outToken) {
            // Content is clean on field-path providers — no <think> tags in delta.content
            this.options.onOutputChunk?.(outToken, assistantMessageId).catch(() => {});
            reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: outToken })}\n\n`);
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
              this.options.onThinkChunk?.(newThink, 'engine', assistantMessageId).catch(() => {});
              sendThinking(newThink);
            }
            const newOut = outBuf.slice(emittedOutputLen);
            if (newOut) {
              emittedOutputLen = outBuf.length;
              this.options.onOutputChunk?.(newOut, assistantMessageId).catch(() => {});
              reply.raw.write(`data: ${JSON.stringify({ type: 'output_token', token: newOut })}\n\n`);
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
  ): Promise<{ score: number; decision: 'APPROVE' | 'NEEDS_REVISION' | 'REJECT'; guidance?: string }> {
    const reviewSystem =
      'You are a coordinator reviewing whether a coding engine correctly solved a task. ' +
      'Respond with ONLY a JSON object: {"score":0.0-1.0,"decision":"APPROVE|NEEDS_REVISION|REJECT","guidance":"optional"}. ' +
      'APPROVE (score >= 0.8) if: the correct target file was modified/created AND the content matches what was requested. ' +
      'REJECT (score < 0.5) if: the wrong file was created, or the engine wrote example/stub code instead of performing the actual task, or the engine described what to do instead of doing it. ' +
      'NEEDS_REVISION (0.5-0.8) if: the right file was touched but content is incomplete or incorrect. ' +
      'No preamble.';
    const reviewPrompt =
      `ORIGINAL TASK:\n${originalTask}\n\n` +
      `CHANGES MADE:\n${changedSummary}\n\n` +
      `ENGINE OUTPUT (check that tool calls target the correct file with correct content):\n${output.slice(0, 2000)}`;

    try {
      const stripped = await coordinatorStream({
        systemPrompt: reviewSystem,
        messages: [{ role: 'user', content: reviewPrompt }],
        maxTokens: 256,
        temperature: 0.1,
        mode: 'think',
        onThinkToken: sendThinking,
      });
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      const cleaned = jsonMatch ? jsonMatch[0] : stripped;
      const parsed = JSON.parse(cleaned);
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 0.5,
        decision: parsed.decision ?? 'APPROVE',
        guidance: parsed.guidance,
      };
    } catch {
      return { score: 0.8, decision: 'APPROVE' };
    }
  }
}
