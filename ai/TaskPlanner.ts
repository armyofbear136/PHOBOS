import fs from 'fs/promises';
import path from 'path';
import { coordinatorCall, coordinatorStream, engineStream } from './clients.js';
import type { FileSummary, ProjectScope } from './ContextIngester.js';
import { getPrimeTriggerList, getUserSkillTriggerList } from './SkillManager.js';
import { retrieveWorkspaceMemory } from './MemoryWriter.js';
import { gsm } from '../game/GameStateManager.js';


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
  /** Which file this task primarily targets (empty for respond/analyze tasks) */
  targetFile: string;
  /**
   * 'modify'  — edit an existing file
   * 'create'  — create a new file
   * 'delete'  — remove a file
   * 'analyze' — read and reason, no file output
   * 'respond' — produce a text response with no file operations
   */
  operation: 'modify' | 'create' | 'delete' | 'analyze' | 'respond' | 'image_gen' | 'browse' | 'execute';
  /** browse operation — url or macro+query params. Only set when operation === 'browse'. */
  browseUrl?:   string;
  browseMacro?: string;
  browseQuery?: string;
  /** execute operation — run a script in an isolated sandbox. Only set when operation === 'execute'. */
  runtime?:        'node' | 'python' | 'bash';
  entrypoint?:     string;   // filename only (no path separators) — the script to run
  timeoutSeconds?: number;   // hard kill after N seconds, max 120, default 30
  retryWithFix?:   boolean;  // one automatic fix cycle on non-zero exit
  outputFiles?:    string[]; // filenames to copy from sandbox back to workspace after execution
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
  /**
   * Which model executes this task.
   * Defaults to 'seren'. SEREN may assign simpler tasks to 'sayon'.
   */
  assignedTo?: 'sayon' | 'seren';
  /**
   * Optional skill ID SEREN selected for this task from available tool skills.
   */
  skillId?: string;
  /**
   * Executor-level scope for this specific task — set by SEREN during planning.
   * Independent of project scope: an EXHAUSTIVE project can have BRIEF tasks.
   *
   * BRIEF    → Small, focused artifact. Write exactly what's needed.
   * STANDARD → Complete, correct, follows conventions. No stubs.
   * DETAILED → Substantial artifact. All states, edge cases, documented.
   * COMPLETE → Exhaustive implementation. Every feature, every edge case.
   */
  taskScope?: 'BRIEF' | 'STANDARD' | 'DETAILED' | 'COMPLETE';
  /**
   * Task indices (1-based) that need this task's full output injected into their
   * prompt before they execute. Used when an analyze/respond task produces data
   * that downstream tasks depend on. SEREN sets this during planning.
   * Example: task 1 extracts JSON → outputRequiredBy: [2, 3]
   */
  outputRequiredBy?: number[];
  /**
   * Filled by LoopController after this task executes — the raw output text.
   * Injected into the prompt of any task listed in outputRequiredBy.
   */
  completedOutput?: string;
  /**
   * Additional workspace files this task needs in full — beyond targetFile.
   * SEREN sets these during planning when a task needs to read source documents,
   * reference files, or data files that inform its output.
   * The enrichment step injects their full content as <source_file> blocks.
   * Example: a page creation task that needs the full design document.
   */
  sourceFiles?: string[];
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
// Task count is no longer hard-capped — scope directive guides SEREN instead.
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
    projectScope: ProjectScope = 'STANDARD',
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
    // Augment completeContext with semantic memory from SYBIL before SEREN sees it.
    // Fire retrieveWorkspaceMemory in the background while we set up the cache —
    // await resolves quickly (<5ms) from the HNSW index if SYBIL is online.
    gsm.setPersonaState('sybil', 'searching');
    const priorMemory = await retrieveWorkspaceMemory(userMessage);
    gsm.setPersonaState('sybil', 'idle');
    if (priorMemory) {
      completeContext = completeContext
        ? completeContext + '\n\n' + priorMemory
        : priorMemory;
    }

    // Cache for clarification re-entry (messages.ts reads via getLastCompleteContext)
    this._lastCompleteContext = completeContext;
    sendStatus('SEREN planning tasks…');
    const plan = await this.decomposeTasks(
      userMessage, fileSummaries, completeContext, repoMap,
      sendEngineThinking ?? sendThinking,
      clarificationIteration,
      clarificationLog,
      projectScope,
    );

    await onThinkPhaseComplete?.('engine').catch(() => {});
    return plan;
  }

  /**
   * SAYON Step 1: Ask coordinator which files to read and why.
   * Returns a list of filenames to load. Cheap, fast, no thinking needed.
   */
  /** Stores the completeContext from the last plan() call for clarification caching. */
  private _lastCompleteContext = '';

  /** Returns the completeContext assembled in the last plan() call. */
  getLastCompleteContext(): string {
    return this._lastCompleteContext;
  }

  /**
   * Skip SAYON's discovery + extraction (Steps 1+2) and go straight to decomposeTasks.
   * Used on SEREN clarification re-entry to preserve the original planning context
   * rather than having SAYON rewrite it around the short clarification answer.
   */
  async decomposeWithCachedContext(
    rewrittenMessage: string,
    fileSummaries: FileSummary[],
    completeContext: string,
    repoMap: string,
    sendStatus: (content: string) => void,
    sendThinking: (token: string) => void,
    onThinkPhaseComplete?: (source: 'coordinator' | 'engine') => Promise<void>,
    clarificationIteration?: number,
    clarificationLog?: Array<{ questions: string[]; userReply: string }>,
    projectScope: ProjectScope = 'STANDARD',
  ): Promise<TaskPlan> {
    sendStatus('SEREN re-planning with clarification…');
    const plan = await this.decomposeTasks(
      rewrittenMessage,
      fileSummaries,
      completeContext,
      repoMap,
      sendThinking,
      clarificationIteration,
      clarificationLog,
      projectScope,
    );
    await onThinkPhaseComplete?.('engine').catch(() => {});
    return plan;
  }

  /**
   * File importance tags used in SEREN's planning context.
   * CRITICAL: SEREN receives the full file content — essential for planning.
   * CONTEXT:  SEREN receives summary only — useful background, not line-level detail.
   */
  private discoveryTags = new Map<string, 'CRITICAL' | 'CONTEXT'>();

  private async buildDiscoveryRoadmap(
    userMessage: string,
    fileSummaries: FileSummary[],
    repoMap: string,
    sendThinking: (token: string) => void
  ): Promise<string[]> {
    if (fileSummaries.length === 0) return [];
    this.discoveryTags.clear();

    const summaryBlock = fileSummaries
      .map((f) => `  ${f.filename}: ${f.summary}`)
      .join('\n');

    // Ask SAYON to classify files as CRITICAL (needs full content) or CONTEXT (summary only)
    const prompt =
      `Given this task and the available workspace files, classify which files SEREN needs ` +
      `to plan an implementation. For each file, assign one of:\n` +
      `  CRITICAL — SEREN needs the full file content to plan accurately (e.g. files being modified, ` +
      `primary source documents the output is based on)\n` +
      `  CONTEXT — summary is enough for planning (e.g. reference files, adjacent components)\n\n` +
      `Respond ONLY with a JSON array: [{"file":"name.ts","importance":"CRITICAL"},...]. ` +
      `Omit files not needed at all. Max ${MAX_DISCOVERY_FILES} files total. ` +
      `Empty array if no files needed.\n\n` +
      `TASK: ${userMessage}\n\n` +
      `AVAILABLE FILES:\n${summaryBlock}`;

    try {
      const clean = await coordinatorCall({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.1,
        mode: 'no_think',
      });
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        const entries = JSON.parse(match[0]) as Array<{ file: string; importance?: string }>;
        const known = new Set(fileSummaries.map((f) => f.filename));
        const files: string[] = [];
        for (const e of entries) {
          if (typeof e.file === 'string' && known.has(e.file) && files.length < MAX_DISCOVERY_FILES) {
            files.push(e.file);
            this.discoveryTags.set(e.file, e.importance === 'CONTEXT' ? 'CONTEXT' : 'CRITICAL');
          }
        }
        return files;
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
      const tag = this.discoveryTags.get(filename) ?? 'CRITICAL';
      const absPath = path.resolve(this.workspaceDir, filename);
      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        contextParts.push(`<file path="${filename}">\n[File not found]\n</file>`);
        continue;
      }

      // Always store raw content for per-task enrichment regardless of tag
      this.discoveredFileContents.set(filename, content);

      // CONTEXT-tagged files: SEREN already sees a summary in fileListSection.
      // Don't re-inject the same info — just record the content for task enrichment.
      if (tag === 'CONTEXT') {
        console.log(`[planner:discovery] "${filename}" tagged CONTEXT — skipping full injection (summary sufficient)`);
        continue;
      }

      // CRITICAL-tagged files: inject full content so SEREN can plan at line level
      if (content.length <= PAGE_SIZE_CHARS) {
        const extracted = await this.extractFromChunk(
          filename, content, userMessage, sendThinking
        );
        if (content.length <= rawBudgetRemaining) {
          contextParts.push(
            `<file_context path="${filename}" importance="CRITICAL">\n` +
            `<sayon_analysis>\n${extracted}\n</sayon_analysis>\n` +
            `<full_content>\n${content}\n</full_content>\n` +
            `</file_context>`
          );
          rawBudgetRemaining -= content.length;
        } else {
          // Over budget — extraction only
          contextParts.push(`<file_context path="${filename}" importance="CRITICAL">\n${extracted}\n</file_context>`);
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
        contextParts.push(
          `<file_context path="${filename}" importance="CRITICAL" chunks="${chunks.length}">\n` +
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
    projectScope: ProjectScope = 'STANDARD',
  ): Promise<TaskPlan> {
    const contextSection = completeContext
      ? `EXTRACTED FILE CONTEXT:\n${completeContext.slice(0, 40_000)}\n\n`
      : '';

    // Files tagged CRITICAL get full content in contextSection — mark them so SEREN
    // knows not to re-derive from the summary what it already has verbatim.
    const criticalFiles = new Set(
      [...this.discoveryTags.entries()]
        .filter(([, tag]) => tag === 'CRITICAL')
        .map(([f]) => f)
    );
    const fileListSection = fileSummaries.length > 0
      ? `WORKSPACE FILES:\n` +
        fileSummaries.map((f) => {
          const tag = criticalFiles.has(f.filename) ? ' [full content provided below]' : '';
          return `  ${f.filename}${tag}: ${f.summary}`;
        }).join('\n') +
        `\n\n`
      : '';

    // ── Scope-driven planning directive ─────────────────────────────────────
    // SAYON classified the project scope during ingest. This drives how many
    // tasks SEREN plans and what ambition level each task should have.
    // There is NO hard task count limit — scope guides completeness instead.
    const scopePlanningDirectives: Record<string, string> = {
      MINIMAL:
        `SCOPE — MINIMAL: The user asked for exactly one specific thing. ` +
        `Create exactly as many tasks as the request explicitly requires — no more. ` +
        `Do not add scaffolding, config files, tests, or extras. ` +
        `Even so: every task you create must be fully implemented — never stub or truncate.`,
      STANDARD:
        `SCOPE — STANDARD: Create all tasks a competent practitioner would consider ` +
        `naturally necessary for this request. Include implied dependencies ` +
        `(a component needs its styles, a route needs its handler) but do not pad. ` +
        `Every task must be fully implemented — no stubs, no placeholders.`,
      COMPREHENSIVE:
        `SCOPE — COMPREHENSIVE: The user wants a production-ready result. ` +
        `Include every task needed: all files, supporting configs, and anything that makes ` +
        `the deliverable genuinely complete and shippable. Do not cut corners. ` +
        `Every task must be fully implemented with RICH, DETAILED content — not outlines or stubs. ` +
        `For content tasks (pages, documents, copy): each must contain substantial real content ` +
        `drawn from the source material — multiple sections, full paragraphs, specific details. ` +
        `"Rich details" means 300-600+ words of real content per page, not placeholder text.`,
      EXHAUSTIVE:
        `SCOPE — EXHAUSTIVE: Spare nothing. Create a task for every file, every page, ` +
        `every component, every config. Every task must be exhaustively implemented — ` +
        `no stubs, no truncation, no placeholder text. ` +
        `For content tasks: each page must contain COMPREHENSIVE content drawn from source material — ` +
        `multiple detailed sections, 500-1000+ words of specific, accurate information. ` +
        `If you find yourself about to write a short stub — stop and write the full thing instead.`,
    };
    const scopeRule = (scopePlanningDirectives[projectScope] ?? scopePlanningDirectives['STANDARD']) + '\n\n';

    // Per-task scope guidance injected into each task's context field during planning.
    // SEREN uses this to know how much to write when executing that specific task.
    const taskScopeGuidance: Record<string, string> = {
      MINIMAL:  'BRIEF',
      STANDARD: 'STANDARD',
      COMPREHENSIVE: 'DETAILED',
      EXHAUSTIVE: 'COMPLETE',
    };
    const defaultTaskScope = taskScopeGuidance[projectScope] ?? 'STANDARD';

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
      : `BEFORE PLANNING — ask yourself: "Do I know exactly what the user wants as the end result? ` +
        `Do I know whether this requires file changes, a written response, or an analysis? ` +
        `If file changes are needed, do I know which files and what to change?" ` +
        `If the answer to ANY of those is no, return NEEDS_CLARIFICATION with specific questions. ` +
        `It is ALWAYS better to ask one question and get it right than to produce work the user has to redo.\n\n`;

    const toolSkillsBlock = getPrimeTriggerList() + getUserSkillTriggerList();

    const prompt =
      `Hi SEREN, this is SAYON. I've spoken with the user and prepared the request below for you. ` +
      `Please decompose it into ordered, atomic tasks. Each task performs one clear operation. ` +
      `For each task write a precise self-contained prompt — ` +
      `for code, include exact function names, line references, and constraints. ` +
      `For written responses or analysis, describe exactly what must be produced.\n\n` +
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
      `      "targetFile": "<filename or empty string if no file involved>",\n` +
      `      "operation": "<modify|create|delete|analyze|respond|image_gen|browse|execute>",\n` +
      `      "prompt": "<full self-contained engine prompt>",\n` +
      `      "context": "<extracted constraints for this task only, max 400 words>",\n` +
      `      "assignedTo": "<seren|sayon — seren is default, assign sayon only for simple fast tasks>",\n` +
      `      "skillId": "<skill id from available_skills, or omit if none needed>",\n` +
      `      "taskScope": "<BRIEF|STANDARD|DETAILED|COMPLETE — how much to produce for this specific task>",\n` +
      `      "outputRequiredBy": [<task indices that need this task\'s output, e.g. [2,3] — omit if none>],\n` +
      `      "sourceFiles": ["<workspace filename that this task needs to read in full, e.g. doc.md>"]\n` +
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
      toolSkillsBlock +
      `\nRULES:\n` +
      `- Tasks must be ordered so dependencies come first (create before modify)\n` +
      `- Ensure sequenced tasks have adequate context about their expected input\n` +
      `- Consolidate multiple changes to the same file into one task\n` +
      `- Create as many tasks as the scope requires — do not artificially limit the count\n` +
      `- Use operation "respond" for tasks that produce text output with no file changes\n` +
      `- Use operation "analyze" for tasks that read files but produce no output file\n` +
      `- Use operation "image_gen" ONLY when you want PHOBOS to literally generate image files ` +
      `using its built-in image synthesis engine (Stable Diffusion / FLUX / Chroma). ` +
      `This is NOT for creating React components, UI elements, or placeholder tags — ` +
      `it triggers actual image generation hardware. Use it when the task is to produce ` +
      `real image files (hero images, illustrations, diagrams) as output artifacts. ` +
      `Describe each image: subject, style, dimensions (e.g. 1216x704 for 16:9), model if relevant. ` +
      `SEREN should NOT use image_gen for web components that display images; ` +
      `use \"create\" for those instead.\n` +
      `- AVOID creating tasks for files not mentioned or directly required by scope\n` +
      `- Assign "assignedTo":"sayon" only for simple, fast tasks SAYON can handle well; use "seren" for everything else\n` +
      `- Only set skillId if a skill from available_skills is genuinely useful for that task\n` +
      `- Set taskScope per-task: BRIEF for small focused artifacts, STANDARD for typical deliverables, ` +
      `DETAILED for substantial implementations, COMPLETE for exhaustive artifacts\n` +
      `- Default taskScope if unsure: ${defaultTaskScope}\n` +
      `- Use operation \"browse\" to fetch live web content during task execution. ` +
      `Set \"browseUrl\" for a direct URL, or set \"browseMacro\" + \"browseQuery\" for a search. ` +
      `Available macros: @google_search, @youtube_search, @reddit_subreddit, @wikipedia_search, @amazon_search. ` +
      `Use browse when the task requires current information, fact-checking, or reading a specific URL. ` +
      `Browse output is injected via outputRequiredBy into any downstream task that uses the result.\\n` +
      `- Use operation \"browse\" with browseMacro=\"@youtube_search\" and a follow-up respond task ` +
      `when the user asks to summarise or reference a YouTube video — the /youtube/transcript endpoint ` +
      `returns the full transcript without playback.\\n` +
      `- Use operation \"browse\" ONLY when Camofox web browse is available (it will be noted in system context). ` +
      `Do not plan browse tasks if no web browse tool is listed.\\n` + +
      `- Use operation \"execute\" to run code that PHOBOS just wrote, in an isolated sandbox. ` +
      `Always pair with a preceding \"create\" task that writes the script file. ` +
      `Set \"runtime\": \"node\" | \"python\" | \"bash\", \"entrypoint\": \"filename.ts\" (plain filename, no path), ` +
      `\"timeoutSeconds\": 30 (max 120), \"retryWithFix\": true if execution success is required for downstream tasks. ` +
      `Set \"outputFiles\" to copy specific files from the sandbox back to workspace after execution. ` +
      `Use outputRequiredBy to inject execution output (stdout/stderr/exit code) into downstream tasks. ` +
      `- Use operation \"execute\" ONLY when the Sandbox Executor is available (it will be noted in system context). ` +
      `Do not plan execute tasks if no sandbox executor is listed. ` +
      `- For TypeScript/Node scripts: write plain .ts files — the executor runs them via tsx directly. ` +
      `- execute tasks do NOT use file tools — they run the script and capture output only.\\n` +
      `a later task needs as input. Set it to the array of task indices that depend on this output.\n` +
      `- For "analyze" and "respond" operations: always set outputRequiredBy if any later task references this task\'s results\n` +
      `\nFILE INJECTION - read carefully:\n` +
      `- sourceFiles: list workspace files this task needs to read in full. ` +
      `The executor receives complete file content without any read_file call.\n` +
      `- Ask for each task: does it need to know what is inside [filename]? If yes, add it to sourceFiles.\n` +
      `- Example: LandingPage.jsx uses PHOBOS-System-Design-v9.md for text content -> sourceFiles: ["PHOBOS-System-Design-v9.md"]\n` +
      `- For large complex documents (design docs, specs, long markdown): ` +
      `create an analyze task to extract structured data via outputRequiredBy, ` +
      `AND still put the file in sourceFiles on tasks that use it directly. ` +
      `Both serve different purposes: analyze gives structured extracts; sourceFiles gives raw access.\n` +
      `- Do NOT add files to sourceFiles unless the task actually uses their content.\n` +
      ((!clarificationIteration || clarificationIteration === 0)
        ? `- If you are uncertain on the intent, outcome, or which files are involved -- use NEEDS_CLARIFICATION`
        : `- User has already answered questions -- proceed with BUILD_QUEUE using your best interpretation. Use NEEDS_CLARIFICATION only if proceeding would cause an error.`)

    console.log(`[planner:seren:decompose] task="${userMessage.slice(0, 120).replace(/\n/g, ' ')}" scope=${projectScope}`);

    try {
      let raw = await engineStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 16384, // Large plans (10+ tasks with full prompts) exceed 8192 tokens.
                          // Thinking tokens consume ~2000-4000 tokens before JSON starts.
                          // 16384 gives headroom for COMPREHENSIVE/EXHAUSTIVE plans.
        temperature: 0.2,
        mode: 'think',
        onThinkToken: sendThinking,
      });

      console.log(`[planner:raw] "${raw.slice(0, 600).replace(/\n/g, ' ')}"`);

      // ── Truncation recovery ───────────────────────────────────────────────
      // If the output ends mid-JSON (no closing }]), attempt one continuation
      // turn to get the remainder. This happens when a large plan hits the token
      // limit before the JSON array closes.
      const openBraces = (raw.match(/\{/g) ?? []).length;
      const closeBraces = (raw.match(/\}/g) ?? []).length;
      const looksIncomplete = openBraces > closeBraces || (raw.includes('"tasks"') && !raw.trimEnd().endsWith('}'));
      if (looksIncomplete) {
        console.warn('[planner:truncation] Planning JSON appears truncated — requesting continuation');
        try {
          const continuation = await engineStream({
            systemPrompt: '',
            messages: [
              { role: 'user', content: prompt },
              { role: 'assistant', content: raw },
              { role: 'user', content: 'Your JSON was cut off. Continue from exactly where you left off — do not repeat anything already written. Complete the JSON.' },
            ],
            maxTokens: 8192,
            temperature: 0.0,
            mode: 'no_think',
            onThinkToken: sendThinking,
          });
          raw = raw.trimEnd() + continuation.trimStart();
          console.log(`[planner:truncation] Continuation added ${continuation.length} chars`);
        } catch (contErr) {
          console.warn('[planner:truncation] Continuation failed:', contErr);
        }
      }

      const clean = raw;
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
          const VALID_OPS: ReadonlyArray<Task['operation']> = ['modify', 'create', 'delete', 'analyze', 'respond', 'image_gen', 'browse', 'execute'];
          const VALID_TASK_SCOPES = ['BRIEF', 'STANDARD', 'DETAILED', 'COMPLETE'] as const;
          const VALID_RUNTIMES = ['node', 'python', 'bash'] as const;
          const tasks: Task[] = parsed.tasks.map((raw, i) => {
            // Cast the JSON-parsed task to a typed record — parsed tasks are
            // plain objects whose fields may be missing or wrongly typed.
            const t = raw as {
              title?: unknown; targetFile?: unknown; operation?: unknown;
              prompt?: unknown; context?: unknown;
              assignedTo?: unknown; skillId?: unknown; taskScope?: unknown; outputRequiredBy?: unknown;
              sourceFiles?: unknown;
              browseUrl?: unknown; browseMacro?: unknown; browseQuery?: unknown;
              runtime?: unknown; entrypoint?: unknown; timeoutSeconds?: unknown;
              retryWithFix?: unknown; outputFiles?: unknown;
            };
            const op = VALID_OPS.includes(t.operation as Task['operation'])
              ? (t.operation as Task['operation'])
              : 'modify';
            const ts: Task['taskScope'] =
              typeof t.taskScope === 'string' &&
              (VALID_TASK_SCOPES as readonly string[]).includes(t.taskScope)
                ? (t.taskScope as Task['taskScope'])
                : (defaultTaskScope as Task['taskScope']);
            // Execute-specific field extraction
            const runtime = VALID_RUNTIMES.includes(t.runtime as typeof VALID_RUNTIMES[number])
              ? (t.runtime as Task['runtime'])
              : undefined;
            const entrypoint = typeof t.entrypoint === 'string' &&
              t.entrypoint.trim() &&
              !t.entrypoint.includes('/') &&
              !t.entrypoint.includes('\\') &&
              !t.entrypoint.includes('..')
              ? t.entrypoint.trim()
              : undefined;
            const timeoutSeconds = typeof t.timeoutSeconds === 'number'
              ? Math.min(120, Math.max(1, Math.round(t.timeoutSeconds)))
              : undefined;
            return {
              index: i + 1,
              title: String(t.title ?? `Task ${i + 1}`),
              targetFile: String(t.targetFile ?? ''),
              operation: op,
              prompt: String(t.prompt ?? userMessage),
              context: String(t.context ?? '').slice(0, MAX_TASK_CONTEXT_CHARS),
              assignedTo: (t.assignedTo === 'sayon' ? 'sayon' : 'seren') as Task['assignedTo'],
              skillId: typeof t.skillId === 'string' && t.skillId.trim() ? t.skillId.trim() : undefined,
              taskScope: ts,
              outputRequiredBy: Array.isArray(t.outputRequiredBy)
                ? (t.outputRequiredBy as unknown[]).filter((n): n is number => typeof n === 'number')
                : undefined,
              sourceFiles: Array.isArray(t.sourceFiles)
                ? (t.sourceFiles as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                : undefined,
              // Browse fields
              browseUrl:   op === 'browse' && typeof t.browseUrl   === 'string' ? t.browseUrl   : undefined,
              browseMacro: op === 'browse' && typeof t.browseMacro === 'string' ? t.browseMacro : undefined,
              browseQuery: op === 'browse' && typeof t.browseQuery === 'string' ? t.browseQuery : undefined,
              // Execute fields
              runtime,
              entrypoint,
              timeoutSeconds,
              retryWithFix: op === 'execute' ? (t.retryWithFix === true) : undefined,
              outputFiles: op === 'execute' && Array.isArray(t.outputFiles)
                ? (t.outputFiles as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                : undefined,
            };
          });

          // ── Enrich: inject full target file + sourceFiles content ─────────
          // For modify/analyze operations, targetFile gets its content injected.
          // sourceFiles declared by SEREN get their full content injected too,
          // so executors have raw access to source documents without read_file calls.
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
        taskScope: defaultTaskScope as Task['taskScope'],
      }],
      planSummary: 'Sending task to engine.',
    };
  }

  /**
   * Post-plan enrichment: for each task that targets an existing file,
   * replace the SEREN-generated 400-word context summary with the actual
   * file content. Also injects any sourceFiles SEREN declared — these are
   * source documents the executor needs to read in full to do its job.
   *
   * Sources checked in order:
   *   1. discoveredFileContents — files read during SAYON discovery (Step 2)
   *   2. fileSummaries[].content — files read during Stage 1 ingestion
   *
   * For 'create' operations targetFile doesn't exist yet, so no targetFile enrichment.
   * sourceFiles enrichment always runs regardless of operation type.
   */
  private enrichTasksWithFileContent(tasks: Task[], fileSummaries: FileSummary[]): void {
    const summaryContentMap = new Map<string, string>();
    for (const fs of fileSummaries) {
      if (fs.content && !fs.content.startsWith('[File too large')) {
        summaryContentMap.set(fs.filename, fs.content);
      }
    }

    for (const task of tasks) {
      // ── targetFile enrichment (existing files being modified/analyzed) ───
      if (task.targetFile && task.operation !== 'create') {
        const fullContent =
          this.discoveredFileContents.get(task.targetFile) ??
          summaryContentMap.get(task.targetFile);

        if (fullContent) {
          task.context =
            task.context +
            `\n\n<target_file path="${task.targetFile}">\n` +
            fullContent +
            `\n</target_file>`;
          console.log(`[planner:enrich:target] task=${task.index} file="${task.targetFile}" injected=${fullContent.length} chars`);
        }
      }

      // ── sourceFiles enrichment — source documents declared by SEREN ─────
      // These are files the executor needs to read for content (e.g. a design doc
      // that a page creation task draws its text from). Injected as <source_file>
      // blocks so the executor has raw access without a read_file round-trip.
      if (task.sourceFiles && task.sourceFiles.length > 0) {
        const sourceBlocks: string[] = [];
        for (const filename of task.sourceFiles) {
          // Don't re-inject targetFile — already handled above
          if (filename === task.targetFile) continue;
          const content =
            this.discoveredFileContents.get(filename) ??
            summaryContentMap.get(filename);
          if (!content) continue;
          sourceBlocks.push(
            `<source_file path="${filename}">\n${content}\n</source_file>`
          );
          console.log(`[planner:enrich:source] task=${task.index} file="${filename}" injected=${content.length} chars`);
        }
        if (sourceBlocks.length > 0) {
          task.context = task.context + '\n\n' + sourceBlocks.join('\n\n');
        }
      }
    }
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
