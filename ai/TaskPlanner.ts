import fs from 'fs/promises';
import path from 'path';
import { coordinatorCall, coordinatorStream, engineStream } from './clients.js';
import type { FileSummary } from './ContextIngester.js';


/**
 * Stage 3 — Instruction Query & Task Construction
 *
 * Role separation:
 *   SAYON (coordinator) — discovery roadmap + file extraction
 *     The coordinator is cheap and fast. It knows the workspace and the user's
 *     intent. It decides which files matter and pulls out the relevant facts.
 *
 *   SEREN (engine) — task decomposition
 *     SEREN receives the fully assembled context package from SAYON and does
 *     the planning. It produces a tight, scoped task list. Keeping decomposition
 *     on the engine means the same model that will execute the tasks also plans
 *     them — it knows its own tools and won't over-decompose simple requests.
 *
 * Pipeline:
 *   1. SAYON builds a discovery roadmap (which files to read)
 *   2. SAYON reads those files and extracts task-relevant facts
 *   3. SEREN receives the assembled context package and decomposes into tasks
 */

export interface Task {
  /** Sequential index (1-based) */
  index: number;
  /** One-line title for status display */
  title: string;
  /** Which file this task primarily targets (may be empty for analysis tasks) */
  targetFile: string;
  /** 'modify' | 'create' | 'delete' | 'analyze' */
  operation: 'modify' | 'create' | 'delete' | 'analyze';
  /**
   * The full distilled prompt sent to the engine for this task.
   * Contains: what to do, constraints, relevant extracted context.
   * No raw documents — only the facts the engine needs.
   */
  prompt: string;
  /**
   * Relevant file contents extracted for this task.
   * Injected as <task_context> in the engine's system prompt.
   */
  context: string;
}

export interface TaskPlan {
  tasks: Task[];
  /** One-line plan description emitted as coordinator bubble */
  planSummary: string;
  /** When true, SEREN determined it cannot proceed without user input */
  needsClarification?: boolean;
  /** Specific questions SEREN needs answered before it can plan */
  clarificationQuestions?: string[];
}

/** Files larger than this are paginated. ~30k chars ≈ 7.5k tokens */
const PAGE_SIZE_CHARS = 30_000;
/** Overlap between pages so context isn't lost at chunk boundaries (~12%) */
const OVERLAP_CHARS = Math.floor(PAGE_SIZE_CHARS * 0.12);
/** Max files to read during discovery — prevents coordinator overload */
const MAX_DISCOVERY_FILES = 8;
/** Max chars of extracted context per task */
const MAX_TASK_CONTEXT_CHARS = 8_000;
/** Hard cap on tasks SEREN can produce — safety valve */
const MAX_TASKS = 8;
/**
 * Max total chars of raw file content injected into SEREN's planning context.
 * ~80k chars ≈ 20k tokens. Leaves room for system prompt, summaries, and thinking.
 * Files beyond this budget get extraction-only treatment.
 */
const SEREN_CONTEXT_BUDGET = 80_000;

export class TaskPlanner {
  constructor(private workspaceDir: string) {}

  /**
   * Plan the full execution for a request.
   *
   * @param userMessage  Rewritten (Stage 1) user message
   * @param fileSummaries  Coordinator file summaries from Stage 1
   * @param repoMap  Workspace index string
   * @param sendStatus  Emits status pills to the client
   * @param sendThinking  Streams coordinator thinking tokens to the SAYON panel
   * @param sendEngineThinking  Streams engine thinking tokens to the SEREN panel
   */
  async plan(
    userMessage: string,
    fileSummaries: FileSummary[],
    repoMap: string,
    sendStatus: (content: string) => void,
    sendThinking: (token: string) => void,
    sendEngineThinking?: (token: string) => void,
    onThinkPhaseComplete?: (source: 'coordinator' | 'engine') => Promise<void>,
    clarificationIteration?: number,
    clarificationLog?: Array<{ questions: string[]; userReply: string }>,
  ): Promise<TaskPlan> {

    // ── Step 1: SAYON — Discovery roadmap ─────────────────────────────────
    sendStatus('Building discovery roadmap…');
    const discoveryFiles = await this.buildDiscoveryRoadmap(
      userMessage, fileSummaries, repoMap, sendThinking
    );

    // ── Step 2: SAYON — Read and extract from discovered files ─────────────
    let completeContext = '';
    if (discoveryFiles.length > 0) {
      sendStatus(`Reading ${discoveryFiles.length} file${discoveryFiles.length > 1 ? 's' : ''}…`);
      completeContext = await this.readFilesForContext(
        discoveryFiles, userMessage, sendThinking
      );
    }

    // ── Step 3: SEREN — Task decomposition ───────────────────────────────
    sendStatus('SEREN planning tasks…');
    const plan = await this.decomposeTasks(
      userMessage, fileSummaries, completeContext, repoMap,
      sendEngineThinking ?? sendThinking,
      clarificationIteration,
      clarificationLog
    );

    await onThinkPhaseComplete?.('engine').catch(() => {});
    return plan;
  }

  /**
   * SAYON Step 1: Ask coordinator which files to read and why.
   * Returns a list of filenames to load. Cheap, fast, no thinking needed.
   */
  private async buildDiscoveryRoadmap(
    userMessage: string,
    fileSummaries: FileSummary[],
    repoMap: string,
    sendThinking: (token: string) => void
  ): Promise<string[]> {
    if (fileSummaries.length === 0) return [];

    const summaryBlock = fileSummaries
      .map((f) => `  ${f.filename}: ${f.summary}`)
      .join('\n');

    const prompt =
      `Given this task and the available workspace files, ` +
      `list which files need to be read to make an accurate implementation plan. ` +
      `Only include files genuinely needed — not all of them. ` +
      `Respond ONLY with a JSON array of filenames: ["file1.ts","file2.ts"]. ` +
      `Max ${MAX_DISCOVERY_FILES} files. Empty array if no files needed.\n\n` +
      `TASK: ${userMessage}\n\n` +
      `AVAILABLE FILES:\n${summaryBlock}`;

    try {
      const clean = await coordinatorCall({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 256,
        temperature: 0.1,
        mode: 'no_think',
      });
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        const files = JSON.parse(match[0]) as string[];
        const known = new Set(fileSummaries.map((f) => f.filename));
        return files.filter((f) => typeof f === 'string' && known.has(f)).slice(0, MAX_DISCOVERY_FILES);
      }
    } catch (err) {
      console.warn('[TaskPlanner] Discovery roadmap failed:', err);
    }
    return [];
  }

  /**
   * SAYON Step 2: Read each discovered file and extract task-relevant facts.
   * Large files are paginated with overlap.
   * Returns a single assembled context string for SEREN that includes both
   * SAYON's extraction AND the raw file content (budget-gated).
   *
   * Also populates discoveredFileContents so decomposeTasks can enrich
   * per-task context with the actual file being edited.
   */
  private discoveredFileContents = new Map<string, string>();

  private async readFilesForContext(
    filenames: string[],
    userMessage: string,
    sendThinking: (token: string) => void
  ): Promise<string> {
    const contextParts: string[] = [];
    this.discoveredFileContents.clear();
    let rawBudgetRemaining = SEREN_CONTEXT_BUDGET;

    for (const filename of filenames) {
      const absPath = path.resolve(this.workspaceDir, filename);
      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        contextParts.push(`<file path="${filename}">\n[File not found]\n</file>`);
        continue;
      }

      // Store raw content for per-task enrichment in decomposeTasks
      this.discoveredFileContents.set(filename, content);

      if (content.length <= PAGE_SIZE_CHARS) {
        const extracted = await this.extractFromChunk(
          filename, content, userMessage, sendThinking
        );
        // Include both SAYON analysis and raw content (budget-gated)
        if (content.length <= rawBudgetRemaining) {
          contextParts.push(
            `<file_context path="${filename}">\n` +
            `<sayon_analysis>\n${extracted}\n</sayon_analysis>\n` +
            `<full_content>\n${content}\n</full_content>\n` +
            `</file_context>`
          );
          rawBudgetRemaining -= content.length;
        } else {
          // Over budget — extraction only
          contextParts.push(`<file_context path="${filename}">\n${extracted}\n</file_context>`);
        }
      } else {
        const chunks = this.paginate(content);
        const extractions: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const extracted = await this.extractFromChunk(
            filename, chunks[i], userMessage, sendThinking,
            `(chunk ${i + 1}/${chunks.length})`
          );
          extractions.push(extracted);
        }
        // Large paginated files: extraction only in the planning context.
        // Full content is still available via discoveredFileContents for
        // per-task injection in decomposeTasks.
        contextParts.push(
          `<file_context path="${filename}" chunks="${chunks.length}">\n` +
          extractions.join('\n---\n') +
          `\n</file_context>`
        );
      }
    }

    return contextParts.join('\n\n');
  }

  /**
   * SAYON: Extract task-relevant information from a single file chunk.
   * Returns concise prose — function signatures, line numbers, constraints.
   */
  private async extractFromChunk(
    filename: string,
    content: string,
    userMessage: string,
    sendThinking: (token: string) => void,
    chunkNote = ''
  ): Promise<string> {
    const prompt =
      `Extract only the information relevant to this task from the file below ${chunkNote}. ` +
      `Keep in mind: user goals for this task, the type of work, the scope of work. ` +
      `If code related, focus on function signatures, variable names, line numbers, imports, and constraints ` +
      `that directly affect implementing the task. Be concise but don't miss anything important — ~ 300 words. ` +
      `If non-code related, use logic and context from the task to determine the valuable information` +
      `Do not reproduce large code blocks; describe what is there and where.\n\n` +
      `TASK: ${userMessage}\n\n` +
      `FILE: ${filename}\n` +
      `---\n${content.slice(0, PAGE_SIZE_CHARS)}\n---`;

    console.log(`[planner:sayon:extract] file="${filename}" task="${userMessage.slice(0, 80).replace(/\n/g, ' ')}"`);
    try {
      const clean = await coordinatorStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.1,
        mode: 'think',
        onThinkToken: sendThinking,
      });
      return clean || `[${filename}: no relevant content extracted]`;
    } catch (err) {
      console.warn(`[TaskPlanner] Extraction failed for ${filename}:`, err);
      return `[${filename}: extraction failed]`;
    }
  }

  /**
   * SEREN Step 3: Decompose the request into ordered, atomic, file-scoped tasks.
   *
   * SEREN receives a fully assembled context package from SAYON and produces
   * a tight task list. Scope rules are enforced in the prompt — SEREN must not
   * expand a simple request into infrastructure scaffolding.
   */
  private async decomposeTasks(
    userMessage: string,
    fileSummaries: FileSummary[],
    completeContext: string,
    repoMap: string,
    sendThinking: (token: string) => void,
    clarificationIteration?: number,
    clarificationLog?: Array<{ questions: string[]; userReply: string }>,
  ): Promise<TaskPlan> {
    const contextSection = completeContext
      ? `EXTRACTED FILE CONTEXT:\n${completeContext.slice(0, 12_000)}\n\n`
      : '';

    const fileListSection = fileSummaries.length > 0
      ? `WORKSPACE FILES:\n${fileSummaries.map((f) => `  ${f.filename}: ${f.summary}`).join('\n')}\n\n`
      : '';

    // Estimate complexity from the request text — used in the scope instruction
    const isLikelySimple = this.looksSimple(userMessage, fileSummaries);

    const scopeRule = isLikelySimple
      ? `SCOPE: This request appears simple. Produce the MINIMUM number of tasks ` +
        `to satisfy it — do not add project scaffolding, config files, package.json, ` +
        `tsconfig, or dependency installation unless explicitly requested. ` +
        `If the request can be done in a single file, produce exactly one task.\n\n`
      : `SCOPE: Only touch files the request explicitly mentions or that are directly ` +
        `required by the change. Do not add infrastructure (config, manifests, lockfiles) ` +
        `unless the request asks for it. When in doubt, do less. Precision edits, complete functions.\n\n`;

    // Clarification weight — injected when this is a follow-up to a prior
    // NEEDS_CLARIFICATION. The weight increases pressure to attempt the task
    // rather than asking again. Formula: min(10, count*2 + 2).
    // Weight 1-4: ask freely. 5-6: lean toward attempting. 7-8: strong pressure.
    // 9-10: must attempt with best interpretation — do not ask another question.
    let clarificationBlock = '';
    if (clarificationIteration && clarificationIteration > 0) {
      const weight = Math.min(10, clarificationIteration * 2 + 2);
      const guidance =
        weight <= 4 ? 'You may ask for clarification if genuinely needed.' :
        weight <= 6 ? 'Lean toward attempting the task with your best interpretation rather than asking again.' :
        weight <= 8 ? 'Strong pressure to attempt: only ask another question if it is truly impossible to proceed otherwise.' :
        'You MUST attempt the task now. Do not ask another question. Use your best interpretation of the user\'s intent.';

      // Build a full transcript of the Q&A so far
      let historyLines = '';
      if (clarificationLog && clarificationLog.length > 0) {
        historyLines = clarificationLog.map((entry, i) => {
          const qLines = entry.questions.map((q, qi) => `  Q${qi + 1}: ${q}`).join('\n');
          const replyLine = entry.userReply
            ? `  User answered: ${entry.userReply}`
            : `  (User is replying now — see REQUEST below)`;
          return `Round ${i + 1}:\n${qLines}\n${replyLine}`;
        }).join('\n\n');
      }

      clarificationBlock =
        `<clarification_context iteration="${clarificationIteration}" weight="${weight}/10">\n` +
        `The user has answered ${clarificationIteration} clarification question(s). ` +
        `Weight: ${weight}/10. ${guidance}\n\n` +
        (historyLines
          ? `Full clarification history:\n${historyLines}\n\n` +
            `The REQUEST below is the user's latest reply. ` +
            `Treat all prior answers as established facts — do NOT ask about them again.\n`
          : '') +
        `</clarification_context>\n\n`;
    }

    // In synthesis mode (clarificationIteration > 0), the "ask if unsure" rule
    // is replaced with "attempt using best interpretation". The BEFORE PLANNING
    // check is the primary reason SEREN loops identically — it fires even when
    // the user has already answered, because the three-question test still fails
    // on unresolved details the user deliberately left open ("just create something").
    const beforePlanningRule = (clarificationIteration && clarificationIteration > 0)
      ? `BEFORE PLANNING — the user has already answered clarification questions. ` +
        `You have all the information you need to proceed. Make reasonable creative decisions ` +
        `for any details the user left open (filename, structure, content). ` +
        `Do NOT ask another NEEDS_CLARIFICATION — proceed to BUILD_QUEUE.\n\n`
      : `BEFORE PLANNING — ask yourself: "Do I know if I'm editing a file or creating one or not at all? ` +
        `If so do I know what to change, and exactly what the result should look like?" If the answer to ANY of ` +
        `those is no, return NEEDS_CLARIFICATION with specific questions. It is ALWAYS better ` +
        `to ask one question and get it right than to produce work the user has to redo.\n\n`;

    const prompt =
      `You are SEREN, a critical analysis and intelligence execution engine. Decompose the request below into ` +
      `ordered, atomic, tasks that you will execute yourself. Determine the purpose of the task: code - logic - general` +
      `Each task needs a meaningful plan and performs one clear operation. ` +
      `For each task write a precise self-contained prompt — ` +
      `if it is a general question, task, or analysis, structure it critically. For code, include exact function names, ` +
      `line references, and constraints from the context. Don't include your full file contents in prompts.\n\n` +
      beforePlanningRule +
      clarificationBlock +
      scopeRule +
      `Respond ONLY with a JSON object (no preamble, no markdown fences).\n\n` +
      `If you CAN proceed:\n` +
      `{\n` +
      `  "decision": "BUILD_QUEUE",\n` +
      `  "planSummary": "<one sentence, max 20 words>",\n` +
      `  "tasks": [\n` +
      `    {\n` +
      `      "title": "<short action phrase>",\n` +
      `      "targetFile": "<filename or empty string>",\n` +
      `      "operation": "<modify|create|delete|analyze>",\n` +
      `      "prompt": "<full self-contained engine prompt>",\n` +
      `      "context": "<extracted constraints for this task only, max 400 words>"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n\n` +
      `If you CANNOT proceed without more information:\n` +
      `{\n` +
      `  "decision": "NEEDS_CLARIFICATION",\n` +
      `  "planSummary": "Need clarification before proceeding",\n` +
      `  "questions": ["<specific question 1>", "<specific question 2>"]\n` +
      `}\n\n` +
      `REQUEST: ${userMessage}\n\n` +
      fileListSection +
      contextSection +
      `RULES:\n` +
      `- Tasks must be ordered so dependencies come first (create before modify)\n` +
      `- Ensure sequenced tasks have adequate context about their expected input\n` +
      `- Consolidate multiple changes to the same file into one task\n` +
      `- Hard maximum: ${MAX_TASKS} tasks\n` +
      `- If the request touches a file, try to fit as much into a single task as makes sense\n` +
      `- AVOID creating tasks for files not mentioned or directly required\n` +
      `- IF a substantial amount of accesory data is pertinent, such as large quantities of changes or notes\n` +
      `determine the best format to relay that information in such as .md or .html\n` +
      ((!clarificationIteration || clarificationIteration === 0)
        ? `- If you are uncertain on which files, what approach, or what the outcome should be — use NEEDS_CLARIFICATION`
        : `- User has already answered questions — if suitable do your best to fill in the gaps and proceed with BUILD_QUEUE. If absolutely necessary use NEEDS_CLARIFICATION if your result might error.`);

    console.log(`[planner:seren:decompose] task="${userMessage.slice(0, 120).replace(/\n/g, ' ')}" simple=${isLikelySimple}`);

    try {
      const clean = await engineStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 8192,  // thinking models (Phi-4, SmolLM3, Ministral) spend 500-2000 tokens
                          // thinking before producing JSON — 2048 was too tight and caused truncation
        temperature: 0.2,
        mode: 'think',
        onThinkToken: sendThinking,
      });

      console.log(`[planner:raw] "${clean.slice(0, 600).replace(/\n/g, ' ')}"`);

      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          decision?: string;
          planSummary: string;
          questions?: string[];
          tasks?: Array<{
            title: string;
            targetFile: string;
            operation: string;
            prompt: string;
            context: string;
          }>;
        };

        // ── NEEDS_CLARIFICATION exit ──────────────────────────────────────
        if (
          parsed.decision === 'NEEDS_CLARIFICATION' &&
          Array.isArray(parsed.questions) &&
          parsed.questions.length > 0
        ) {
          console.log(`[planner:clarification] ${parsed.questions.length} question(s)`);
          return {
            tasks: [],
            planSummary: String(parsed.planSummary ?? 'Need clarification before proceeding'),
            needsClarification: true,
            clarificationQuestions: parsed.questions.map(String),
          };
        }

        // ── BUILD_QUEUE (normal path) ─────────────────────────────────────
        if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
          const tasks: Task[] = parsed.tasks.slice(0, MAX_TASKS).map((t, i) => ({
            index: i + 1,
            title: String(t.title ?? `Task ${i + 1}`),
            targetFile: String(t.targetFile ?? ''),
            operation: (['modify', 'create', 'delete', 'analyze'].includes(t.operation)
              ? t.operation
              : 'modify') as Task['operation'],
            prompt: String(t.prompt ?? userMessage),
            context: String(t.context ?? '').slice(0, MAX_TASK_CONTEXT_CHARS),
          }));

          // ── Enrich: inject full target file content into each task ───────
          // SEREN's context field from planning is a 400-word summary.
          // For modify/analyze operations, replace it with the actual file
          // so the engine has the real code during execution.
          this.enrichTasksWithFileContent(tasks, fileSummaries);

          return {
            tasks,
            planSummary: String(parsed.planSummary ?? `Executing ${tasks.length} task${tasks.length > 1 ? 's' : ''}.`),
          };
        }
      }
    } catch (err) {
      console.warn('[TaskPlanner] SEREN task decomposition failed, falling back to single task:', err);
    }

    // Fallback: send the whole request as one task
    return {
      tasks: [{
        index: 1,
        title: 'Execute request',
        targetFile: '',
        operation: 'modify',
        prompt: userMessage,
        context: completeContext.slice(0, MAX_TASK_CONTEXT_CHARS),
      }],
      planSummary: 'Sending task to engine.',
    };
  }

  /**
   * Post-plan enrichment: for each task that targets an existing file,
   * replace the SEREN-generated 400-word context summary with the actual
   * file content. The target file always gets full injection regardless of
   * budget — this is the file SEREN is about to edit.
   *
   * Sources checked in order:
   *   1. discoveredFileContents — files read during SAYON discovery (Step 2)
   *   2. fileSummaries[].content — files read during Stage 1 ingestion
   *
   * For 'create' operations the file doesn't exist yet, so no enrichment.
   */
  private enrichTasksWithFileContent(tasks: Task[], fileSummaries: FileSummary[]): void {
    const summaryContentMap = new Map<string, string>();
    for (const fs of fileSummaries) {
      if (fs.content && !fs.content.startsWith('[File too large')) {
        summaryContentMap.set(fs.filename, fs.content);
      }
    }

    for (const task of tasks) {
      if (!task.targetFile || task.operation === 'create') continue;

      // Prefer discovery content (read at full resolution in Step 2)
      // Fall back to ingestion content (may be truncated at 20k chars)
      const fullContent =
        this.discoveredFileContents.get(task.targetFile) ??
        summaryContentMap.get(task.targetFile);

      if (!fullContent) continue;

      // Preserve SEREN's extracted constraints as a preamble, then append full file.
      // The constraints tell SEREN what to focus on; the file gives it the real code.
      const enriched =
        task.context +
        `\n\n<target_file path="${task.targetFile}">\n` +
        fullContent +
        `\n</target_file>`;

      task.context = enriched;
      console.log(`[planner:enrich] task=${task.index} file="${task.targetFile}" injected=${fullContent.length} chars`);
    }
  }

  /**
   * Heuristic: does this request look simple enough to warrant a strict
   * single-file scope guard? Used to set the SCOPE instruction in the
   * SEREN decomposition prompt.
   *
   * Simple signals:
   * - Short request text (< 120 chars)
   * - Contains "function", "hello", "snippet", "example", "demo", "test"
   * - Empty workspace (no existing files)
   * - Request mentions exactly one file or none
   */
  private looksSimple(userMessage: string, fileSummaries: FileSummary[]): boolean {
    const msg = userMessage.toLowerCase();
    if (fileSummaries.length === 0) return true;
    if (userMessage.length < 120) return true;
    if (/\b(hello|snippet|example|demo|sample|test function|simple function)\b/.test(msg)) return true;
    // Count explicit file references — if zero or one, likely simple
    const fileRefs = (userMessage.match(/\.(ts|js|tsx|jsx|py|go|rs|cs|cpp|c|json|md)\b/gi) ?? []).length;
    if (fileRefs <= 1) return true;
    return false;
  }

  /** Split content into overlapping pages */
  private paginate(content: string): string[] {
    const pages: string[] = [];
    let offset = 0;
    while (offset < content.length) {
      pages.push(content.slice(offset, offset + PAGE_SIZE_CHARS));
      offset += PAGE_SIZE_CHARS - OVERLAP_CHARS;
    }
    return pages;
  }
}
