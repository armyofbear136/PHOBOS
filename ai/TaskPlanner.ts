import fs from 'fs/promises';
import path from 'path';
import { coordinatorClient, COORDINATOR_MODEL } from './clients.js';
import type { FileSummary } from './ContextIngester.js';

/**
 * Stage 3 — Instruction Query & Task Construction
 *
 * Rather than dispatching the whole request to the engine in one shot,
 * the coordinator first:
 *
 *   1. Builds a discovery roadmap: which files must be read and why
 *   2. Reads those files (paginated for large files, with overlap buffer)
 *   3. Decomposes the request into ordered, atomic, file-scoped tasks
 *   4. Assigns each task only the context it needs — no raw docs, only
 *      the extracted constraints relevant to that task
 *
 * The result is a TaskPlan: an ordered list of Task objects ready for
 * the engine execution loop.
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
   * Relevant file contents the coordinator extracted for this task.
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

export class TaskPlanner {
  constructor(private workspaceDir: string) {}

  /**
   * Plan the full execution for a request.
   *
   * @param userMessage  Rewritten (Stage 1) user message
   * @param fileSummaries  Coordinator file summaries from Stage 1
   * @param repoMap  Workspace index string
   * @param sendStatus  Emits status pills to the client
   * @param sendThinking  Streams coordinator thinking tokens
   */
  async plan(
    userMessage: string,
    fileSummaries: FileSummary[],
    repoMap: string,
    sendStatus: (content: string) => void,
    sendThinking: (token: string) => void
  ): Promise<TaskPlan> {

    // ── Step 1: Discovery roadmap ──────────────────────────────────────────
    // Ask the coordinator which files it needs to read to make a precise plan.
    sendStatus('Building discovery roadmap…');

    const discoveryFiles = await this.buildDiscoveryRoadmap(
      userMessage, fileSummaries, repoMap, sendThinking
    );

    // ── Step 2: Read discovered files ─────────────────────────────────────
    let completeContext = '';

    if (discoveryFiles.length > 0) {
      sendStatus(`Reading ${discoveryFiles.length} file${discoveryFiles.length > 1 ? 's' : ''}…`);
      completeContext = await this.readFilesForContext(
        discoveryFiles, userMessage, sendThinking
      );
    }

    // ── Step 3: Task decomposition ────────────────────────────────────────
    sendStatus('Decomposing into tasks…');

    const plan = await this.decomposeTasks(
      userMessage, fileSummaries, completeContext, repoMap, sendThinking
    );

    return plan;
  }

  /**
   * Step 1: Ask coordinator which files to read and why.
   * Returns a list of filenames to load.
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
      `/no_think Given this coding task and the available workspace files, ` +
      `list which files need to be read to make an accurate implementation plan. ` +
      `Only include files genuinely needed — not all of them. ` +
      `Respond ONLY with a JSON array of filenames: ["file1.ts","file2.ts"]. ` +
      `Max ${MAX_DISCOVERY_FILES} files. Empty array if no files needed.\n\n` +
      `TASK: ${userMessage}\n\n` +
      `AVAILABLE FILES:\n${summaryBlock}`;

    try {
      const response = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0.1,
        stream: false,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '';
      const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        const files = JSON.parse(match[0]) as string[];
        // Validate against known files — ignore hallucinated paths
        const known = new Set(fileSummaries.map((f) => f.filename));
        return files.filter((f) => typeof f === 'string' && known.has(f)).slice(0, MAX_DISCOVERY_FILES);
      }
    } catch (err) {
      console.warn('[TaskPlanner] Discovery roadmap failed:', err);
    }
    return [];
  }

  /**
   * Step 2: Read each discovered file.
   * Large files are paginated with overlap. The coordinator's extraction
   * instructions are prepended to every chunk so it stays focused.
   * Returns a single assembled "complete context" string.
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
        // File fits in one chunk — extract directly
        const extracted = await this.extractFromChunk(
          filename, content, userMessage, sendThinking
        );
        contextParts.push(`<file_context path="${filename}">\n${extracted}\n</file_context>`);
      } else {
        // Paginate with overlap
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
   * Extract task-relevant information from a single file chunk.
   * Returns a concise prose summary of what was found.
   */
  private async extractFromChunk(
    filename: string,
    content: string,
    userMessage: string,
    sendThinking: (token: string) => void,
    chunkNote = ''
  ): Promise<string> {
    const prompt =
      `/think Extract only the information relevant to this task from the file below ${chunkNote}. ` +
      `Focus on: function signatures, variable names, line numbers, imports, and constraints ` +
      `that directly affect implementing the task. Be concise — max 300 words. ` +
      `Do not reproduce large code blocks; describe what is there and where.\n\n` +
      `TASK: ${userMessage}\n\n` +
      `FILE: ${filename}\n` +
      `---\n${content.slice(0, PAGE_SIZE_CHARS)}\n---`;

    try {
      let thinking = '';
      let output = '';
      const stream = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.1,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as Record<string, unknown>;
        const t = (delta?.reasoning_content ?? delta?.reasoning) as string | undefined;
        const o = delta?.content as string | undefined;
        if (t) { thinking += t; sendThinking(t); }
        if (o) output += o;
      }
      const clean = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      return clean || `[${filename}: no relevant content extracted]`;
    } catch (err) {
      console.warn(`[TaskPlanner] Extraction failed for ${filename}:`, err);
      return `[${filename}: extraction failed]`;
    }
  }

  /**
   * Step 3: Use the complete context to decompose the request into
   * ordered, atomic, file-scoped tasks with per-task prompts.
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

    const prompt =
      `/think Decompose this coding request into ordered, atomic, file-scoped tasks. ` +
      `Each task targets exactly one file and performs one clear operation. ` +
      `For each task, write a precise prompt the coding engine will execute — ` +
      `include exact function names, line references, and constraints from the context. ` +
      `No raw file contents in the prompts — only the facts needed.\n\n` +
      `Respond ONLY with a JSON object:\n` +
      `{\n` +
      `  "planSummary": "<one sentence describing the overall plan, max 20 words>",\n` +
      `  "tasks": [\n` +
      `    {\n` +
      `      "title": "<short action phrase e.g. 'Add JWT verification to middleware'>",\n` +
      `      "targetFile": "<filename or empty string for analysis tasks>",\n` +
      `      "operation": "<modify|create|delete|analyze>",\n` +
      `      "prompt": "<full engine prompt with all constraints and context>",\n` +
      `      "context": "<extracted constraints specific to this task, max 400 words>"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n\n` +
      `TASK: ${userMessage}\n\n` +
      fileListSection +
      contextSection +
      `Rules:\n` +
      `- Each task is independent enough that the engine can execute it with only the context provided\n` +
      `- Order tasks so dependencies come first (create files before modifying them)\n` +
      `- Max 8 tasks — consolidate small changes to the same file into one task\n` +
      `- If the request only touches one file, produce exactly one task`;

    try {
      let output = '';
      const stream = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
        temperature: 0.2,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as Record<string, unknown>;
        const t = (delta?.reasoning_content ?? delta?.reasoning) as string | undefined;
        const o = delta?.content as string | undefined;
        if (t) sendThinking(t);
        if (o) output += o;
      }

      const clean = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
          const tasks: Task[] = parsed.tasks.slice(0, 8).map((t, i) => ({
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
      console.warn('[TaskPlanner] Task decomposition failed, falling back to single task:', err);
    }

    // Fallback: treat the whole request as one task
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
