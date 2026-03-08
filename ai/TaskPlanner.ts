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
 *   ALLMIND (engine) — task decomposition
 *     ALLMIND receives the fully assembled context package from SAYON and does
 *     the planning. It produces a tight, scoped task list. Keeping decomposition
 *     on the engine means the same model that will execute the tasks also plans
 *     them — it knows its own tools and won't over-decompose simple requests.
 *
 * Pipeline:
 *   1. SAYON builds a discovery roadmap (which files to read)
 *   2. SAYON reads those files and extracts task-relevant facts
 *   3. ALLMIND receives the assembled context package and decomposes into tasks
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
}

/** Files larger than this are paginated. ~30k chars ≈ 7.5k tokens */
const PAGE_SIZE_CHARS = 30_000;
/** Overlap between pages so context isn't lost at chunk boundaries (~12%) */
const OVERLAP_CHARS = Math.floor(PAGE_SIZE_CHARS * 0.12);
/** Max files to read during discovery — prevents coordinator overload */
const MAX_DISCOVERY_FILES = 8;
/** Max chars of extracted context per task */
const MAX_TASK_CONTEXT_CHARS = 8_000;
/** Hard cap on tasks ALLMIND can produce — safety valve */
const MAX_TASKS = 8;

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
   * @param sendEngineThinking  Streams engine thinking tokens to the ALLMIND panel
   */
  async plan(
    userMessage: string,
    fileSummaries: FileSummary[],
    repoMap: string,
    sendStatus: (content: string) => void,
    sendThinking: (token: string) => void,
    sendEngineThinking?: (token: string) => void,
    onThinkPhaseComplete?: (source: 'coordinator' | 'engine') => Promise<void>,
  ): Promise<TaskPlan> {

    // ── Step 1: SAYON — Discovery roadmap ─────────────────────────────────
    // The coordinator picks which files are actually needed — nothing more.
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

    // ── Step 3: ALLMIND — Task decomposition ───────────────────────────────
    // Hand the assembled context package to the engine. It knows its own tools
    // and execution model better than the coordinator — let it plan.
    sendStatus('ALLMIND planning tasks…');

    const plan = await this.decomposeTasks(
      userMessage, fileSummaries, completeContext, repoMap,
      sendEngineThinking ?? sendThinking
    );

    // Close the planning engine thinking segment so it persists correctly
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
      `Given this coding task and the available workspace files, ` +
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
   * Returns a single assembled context string for ALLMIND.
   */
  private async readFilesForContext(
    filenames: string[],
    userMessage: string,
    sendThinking: (token: string) => void
  ): Promise<string> {
    const contextParts: string[] = [];

    for (const filename of filenames) {
      const absPath = path.resolve(this.workspaceDir, filename);
      let content: string;
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        contextParts.push(`<file path="${filename}">\n[File not found]\n</file>`);
        continue;
      }

      if (content.length <= PAGE_SIZE_CHARS) {
        const extracted = await this.extractFromChunk(
          filename, content, userMessage, sendThinking
        );
        contextParts.push(`<file_context path="${filename}">\n${extracted}\n</file_context>`);
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
      `Focus on: function signatures, variable names, line numbers, imports, and constraints ` +
      `that directly affect implementing the task. Be concise — max 300 words. ` +
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
   * ALLMIND Step 3: Decompose the request into ordered, atomic, file-scoped tasks.
   *
   * ALLMIND receives a fully assembled context package from SAYON and produces
   * a tight task list. Scope rules are enforced in the prompt — ALLMIND must not
   * expand a simple request into infrastructure scaffolding.
   */
  private async decomposeTasks(
    userMessage: string,
    fileSummaries: FileSummary[],
    completeContext: string,
    repoMap: string,
    sendThinking: (token: string) => void
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
        `unless the request asks for it. When in doubt, do less.\n\n`;

    const prompt =
      `You are ALLMIND, a coding execution engine. Decompose the request below into ` +
      `ordered, atomic, file-scoped tasks that you will execute yourself. ` +
      `Each task targets exactly one file and performs one clear operation. ` +
      `For each task write a precise self-contained prompt — include exact function names, ` +
      `line references, and constraints from the context. No raw file contents in prompts.\n\n` +
      scopeRule +
      `Respond ONLY with a JSON object (no preamble, no markdown fences):\n` +
      `{\n` +
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
      `REQUEST: ${userMessage}\n\n` +
      fileListSection +
      contextSection +
      `RULES:\n` +
      `- Tasks must be ordered so dependencies come first (create before modify)\n` +
      `- Consolidate multiple changes to the same file into one task\n` +
      `- Hard maximum: ${MAX_TASKS} tasks\n` +
      `- If the request only touches one file, produce exactly one task\n` +
      `- Do NOT create tasks for files not mentioned or directly required`;

    console.log(`[planner:allmind:decompose] task="${userMessage.slice(0, 120).replace(/\n/g, ' ')}" simple=${isLikelySimple}`);

    try {
      const clean = await engineStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2048,
        temperature: 0.2,
        mode: 'think',
        onThinkToken: sendThinking,
      });

      console.log(`[planner:raw] "${clean.slice(0, 600).replace(/\n/g, ' ')}"`);

      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          planSummary: string;
          tasks: Array<{
            title: string;
            targetFile: string;
            operation: string;
            prompt: string;
            context: string;
          }>;
        };

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

          return {
            tasks,
            planSummary: String(parsed.planSummary ?? `Executing ${tasks.length} task${tasks.length > 1 ? 's' : ''}.`),
          };
        }
      }
    } catch (err) {
      console.warn('[TaskPlanner] ALLMIND task decomposition failed, falling back to single task:', err);
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
   * Heuristic: does this request look simple enough to warrant a strict
   * single-file scope guard? Used to set the SCOPE instruction in the
   * ALLMIND decomposition prompt.
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
