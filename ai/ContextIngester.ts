import fs from 'fs/promises';
import path from 'path';
import { coordinatorCall, coordinatorStream } from './clients.js';
import type { AgentStateManager } from './AgentStateManager.js';



/**
 * Stage 1 — Context Ingestion
 *
 * Before any routing decision, the coordinator reads and summarises all
 * available workspace files so that it understands the full picture.
 * Nothing is forwarded raw to the engine — only distilled summaries.
 *
 * Steps:
 *   1. Read each workspace file (up to size limit)
 *   2. Coordinator summarises each file: what it does, exports, key deps
 *   3. Coordinator rewrites the user message with all context available:
 *      - resolves ambiguous refs ("that function" → specific name)
 *      - clarifies the concrete goal
 *      - notes constraints
 *   4. Emits a status pill as each step completes
 */

export interface FileSummary {
  filename: string;
  language: string;
  sizeBytes: number;
  summary: string;       // coordinator-generated description
  content: string;       // raw content (kept for engine injection if needed)
}

export interface IngestionResult {
  fileSummaries: FileSummary[];
  rewrittenUserMessage: string;
  /** One-sentence coordinator summary emitted as coordinator bubble */
  coordinatorSummary: string;
  /**
   * Inline content blocks extracted from the user message (fenced code blocks,
   * large HTML blocks). Each has been written to a temp file in the workspace
   * so ALLMIND can receive them verbatim via loadedFiles injection.
   */
  extractedFiles: Array<{ path: string; content: string }>;
}

// Files larger than this are truncated before sending to the coordinator.
// ~20k chars ≈ ~5k tokens — safe for Qwen3-8B's 32k context with room to spare.
const MAX_FILE_CHARS = 20_000;
// Only summarise files smaller than this — huge files get a size-only note
const SUMMARISE_THRESHOLD_BYTES = 100_000;
// Max files to summarise in one pass (avoids coordinator overload on large workspaces)
const MAX_FILES_TO_SUMMARISE = 12;

export class ContextIngester {
  constructor(private workspaceDir: string) {}

  /**
   * Run the full ingestion pipeline.
   * @param filenames  Workspace file list from the index (relative paths)
   * @param userMessage  Raw user message
   * @param projectMd  Project context document
   * @param repoMap  Repo index string
   * @param sendStatus  Called to emit a status pill to the client
   * @param sendThinking  Called to stream coordinator thinking tokens
   */
  async ingest(
    filenames: string[],
    userMessage: string,
    projectMd: string,
    repoMap: string,
    sendStatus: (content: string) => void,
    sendThinking: (token: string) => void,
    chatSummary?: string,
    agentState?: AgentStateManager,
    clarificationLog?: Array<{ questions: string[]; userReply: string }>,
    intentType?: string
  ): Promise<IngestionResult> {
    // ── Pre-step: Extract inline content blocks from user message ───────────
    // If the user pasted a code block or HTML directly into the chat, SAYON's
    // rewrite would summarise it away before ALLMIND ever sees it. We pull those
    // blocks out first, write them as temp files, and replace them in the message
    // with a reference. The rewrite then only operates on the instructional prose.
    const { cleanedMessage, extractedFiles } = await this.extractInlineContent(userMessage);
    const effectiveUserMessage = cleanedMessage;

    const filesToProcess = filenames.slice(0, MAX_FILES_TO_SUMMARISE);

    // ── Step 1: Read files ──────────────────────────────────────────────────
    if (filesToProcess.length > 0) {
      sendStatus(`Reading ${filesToProcess.length} workspace file${filesToProcess.length > 1 ? 's' : ''}…`);
    }

    const fileContents: Array<{ filename: string; content: string; sizeBytes: number; language: string }> = [];
    for (const filename of filesToProcess) {
      try {
        agentState?.transition('reading', filename.split('/').pop()!.slice(0, 20));
        const absPath = path.resolve(this.workspaceDir, filename);
        const stat = await fs.stat(absPath);
        const ext = path.extname(filename).slice(1) || 'text';
        const language = LANGUAGE_LABELS[ext] ?? ext;

        if (stat.size > SUMMARISE_THRESHOLD_BYTES) {
          // Too large to summarise meaningfully — note the size only
          fileContents.push({ filename, content: `[File too large to display: ${(stat.size / 1024).toFixed(0)}KB]`, sizeBytes: stat.size, language });
          continue;
        }

        const raw = await fs.readFile(absPath, 'utf-8');
        const content = raw.length > MAX_FILE_CHARS
          ? raw.slice(0, MAX_FILE_CHARS) + `\n... [truncated at ${MAX_FILE_CHARS} chars, full size ${raw.length} chars]`
          : raw;
        fileContents.push({ filename, content, sizeBytes: stat.size, language });
      } catch {
        // File disappeared between index and read — skip silently
      }
    }

    // ── Step 2: Summarise files ─────────────────────────────────────────────
    const fileSummaries: FileSummary[] = [];

    if (fileContents.length > 0) {
      sendStatus(`Summarising ${fileContents.length} file${fileContents.length > 1 ? 's' : ''}…`);

      // Batch all files into one coordinator call to avoid round-trip overhead.
      // Qwen3-8B handles this well up to ~12 files within its context window.
      const fileBlocks = fileContents
        .map((f) => `<file path="${f.filename}" language="${f.language}">\n${f.content}\n</file>`)
        .join('\n\n');

      const summaryPrompt =
        `Summarise each file below. For each file, write ONE sentence (max 20 words) describing: ` +
        `what it does, its key exports or responsibilities, and main dependencies. ` +
        `Respond ONLY with a JSON array: [{"filename":"...","summary":"..."}]. No preamble.\n\n` +
        fileBlocks;

      try {
        const raw = await coordinatorCall({
          systemPrompt: '',
          messages: [{ role: 'user', content: summaryPrompt }],
          maxTokens: 1024,
          temperature: 0.1,
          mode: 'no_think',
        });
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Array<{ filename: string; summary: string }>;
          const summaryMap = new Map(parsed.map((p) => [p.filename, p.summary]));
          for (const f of fileContents) {
            fileSummaries.push({
              filename: f.filename,
              language: f.language,
              sizeBytes: f.sizeBytes,
              summary: summaryMap.get(f.filename) ?? `${f.language} file, ${(f.sizeBytes / 1024).toFixed(1)}KB`,
              content: f.content,
            });
          }
        } else {
          // Parse failed — use size-based fallbacks, still keep content
          for (const f of fileContents) {
            fileSummaries.push({
              filename: f.filename,
              language: f.language,
              sizeBytes: f.sizeBytes,
              summary: `${f.language} file, ${(f.sizeBytes / 1024).toFixed(1)}KB`,
              content: f.content,
            });
          }
        }
      } catch (err) {
        console.warn('[ContextIngester] File summarisation failed, using size fallbacks:', err);
        for (const f of fileContents) {
          fileSummaries.push({
            filename: f.filename,
            language: f.language,
            sizeBytes: f.sizeBytes,
            summary: `${f.language} file, ${(f.sizeBytes / 1024).toFixed(1)}KB`,
            content: f.content,
          });
        }
      }
    }

    // ── Step 3: Rewrite user message with full context ─────────────────────
    agentState?.transition('reading', 'Rewriting request');
    sendStatus('Coordinator reviewing request…');

    const contextHints: string[] = [];
    if (chatSummary) contextHints.push(`Conversation summary (prior turns):\n${chatSummary}`);
    if (projectMd) contextHints.push(`Project context:\n${projectMd}`);
    if (repoMap)   contextHints.push(`Workspace index:\n${repoMap}`);
    if (fileSummaries.length > 0) {
      const summaryLines = fileSummaries.map((f) => `  ${f.filename}: ${f.summary}`).join('\n');
      contextHints.push(`File summaries:\n${summaryLines}`);
    }

    // Clarification history — the full Q&A transcript for this loop.
    // Injected BEFORE the rewrite rules so SAYON can see exactly what was asked
    // and what the user said, rather than relying on the compressed chat summary.
    let clarificationHistoryBlock = '';
    let synthesisMode = false;
    if (clarificationLog && clarificationLog.length > 0) {
      synthesisMode = true;
      const rounds = clarificationLog
        .map((entry, i) => {
          const qLines = entry.questions.map((q, qi) => `  Q${qi + 1}: ${q}`).join('\n');
          const replyLine = entry.userReply
            ? `  User replied: ${entry.userReply}`
            : `  (User is replying now — see USER REQUEST below)`;
          return `Round ${i + 1}:\n${qLines}\n${replyLine}`;
        })
        .join('\n\n');
      clarificationHistoryBlock =
        `<clarification_history>\n` +
        `This request is part of an ongoing clarification loop. ` +
        `Use this history to understand what has already been asked and answered:\n\n` +
        rounds +
        `\n\nThe USER REQUEST below is the user's latest reply. ` +
        `Incorporate all prior answers into the reformulated prompt — do not lose them.\n` +
        `</clarification_history>\n\n`;
    }

    // In synthesis mode (mid-clarification), seed the effective message with the
    // original request + all user replies so SAYON composes a full task brief,
    // not just a rewrite of the latest one-liner.
    let seedMessage = effectiveUserMessage;
    if (synthesisMode && clarificationLog) {
      const parts: string[] = [];
      parts.push(`Original request: ${effectiveUserMessage}`);
      for (const entry of clarificationLog) {
        if (entry.userReply) parts.push(`User also said: ${entry.userReply}`);
      }
      if (parts.length > 1) seedMessage = parts.join('\n');
    }

    // ── Intent-aware rewrite prompt ────────────────────────────────────────
    // The rewrite prompt branches on three distinct modes:
    //   1. QUESTION  — user is asking something; preserve conversational nature,
    //                  no file-change language whatsoever.
    //   2. Synthesis — mid-clarification; synthesise all prior answers into one
    //                  complete task brief. Overrides both other modes.
    //   3. Execution — CODE_REQUEST / PLAN_REQUEST; resolve file references,
    //                  flag ambiguity, scope tightly to what was asked.

    const isQuestion = !synthesisMode && intentType === 'QUESTION';
    // Image prompts must never be rewritten or have [AMBIGUOUS] injected —
    // the raw user message is the prompt that goes directly to sd-cli.
    const isImageRequest = !synthesisMode && intentType === 'IMAGE_REQUEST';

    let rewritePrompt: string;

    if (synthesisMode) {
      // ── Mode 2: Clarification synthesis ──────────────────────────────────────
      rewritePrompt =
        clarificationHistoryBlock +
        `You are preparing a task brief for ALLMIND, a coding execution engine. ` +
        `Rewrite the user's message into a precise, unambiguous task description. ` +
        `Resolve any vague references using the available context (exact function names, ` +
        `file paths, line numbers if relevant).\n\n` +
        `SYNTHESIS RULE: This is a clarification follow-up. The user has already answered ` +
        `questions — do NOT flag ambiguity, do NOT prefix with [AMBIGUOUS]. Instead, synthesize ` +
        `ALL of the user's replies (including prior rounds shown in <clarification_history>) into ` +
        `one complete, unambiguous task description. If the user said "I don't have X, just create ` +
        `something new", treat that as a complete answer — make reasonable creative choices and ` +
        `describe them explicitly in the reformulated prompt (e.g. "create home_networking.html ` +
        `in the workspace root with standard HTML5 structure").\n\n` +
        `SCOPE RULE: Describe only what files need to change and what the outcome must be. ` +
        `Do NOT expand scope beyond what is asked. Do NOT mention project setup, tsconfig, ` +
        `package.json, package managers, or infrastructure unless explicitly requested. ` +
        `If the request is for a single function or snippet, state that explicitly.\n\n` +
        `CONTENT PRESERVATION RULE: If the user's message contains code, HTML, templates, ` +
        `examples, or other structured content, do NOT summarise or omit it. Inline content ` +
        `has already been extracted as attached files — reference them by filename.\n\n` +
        `Respond with JSON only: {"reformulated":"<improved prompt>","summary":"<one sentence, max 15 words>"}. ` +
        `No preamble, nothing outside the JSON.\n\n` +
        `USER REQUEST: ${seedMessage}\n\n` +
        contextHints.join('\n\n');

    } else if (isQuestion) {
      // ── Mode 1: Question / conversational ────────────────────────────────────────
      // SAYON's only job here is to make the question precise and note any
      // workspace context that directly bears on the answer.
      // No file-change rules, no ambiguity flags, no scope constraints.
      const workspaceNote = contextHints.length > 0
        ? `\n\nAvailable context (use only if directly relevant to answering the question):\n` +
          contextHints.join('\n\n')
        : '';

      rewritePrompt =
        `You are preparing a question brief for ALLMIND, an AI reasoning engine. ` +
        `The user is asking a question or having a conversation — there are no files to modify.\n\n` +
        `Your job: rewrite the question to be precise and unambiguous. ` +
        `If it references something vague (e.g. "that function", "my config"), resolve it using ` +
        `the available context. If it is already clear, keep it as-is — do not over-elaborate.\n\n` +
        `Preserve the conversational nature exactly. Do NOT add file paths, scope constraints, ` +
        `or change descriptions. Do NOT mention files unless the question is explicitly about ` +
        `a specific file in the workspace.\n\n` +
        `Respond with JSON only: {"reformulated":"<precise question>","summary":"<one sentence, max 15 words>"}. ` +
        `No preamble, nothing outside the JSON.\n\n` +
        `USER REQUEST: ${seedMessage}` +
        workspaceNote;

    } else if (isImageRequest) {
      // ── Mode 4: Image generation — pass through raw, no rewriting ────────────
      // The user message IS the image prompt. Any rewriting or [AMBIGUOUS] prefix
      // corrupts the string that goes directly to sd-cli. Echo back verbatim.
      rewritePrompt =
        `Respond with JSON only: {"reformulated":${JSON.stringify(seedMessage)},"summary":"Generate image"}. ` +
        `No preamble, nothing outside the JSON.`;

    } else {
      // ── Mode 3: Execution (CODE_REQUEST / PLAN_REQUEST) ─────────────────────────────
      rewritePrompt =
        `You are preparing a task brief for ALLMIND, a coding execution engine. ` +
        `Rewrite the user's message into a precise, unambiguous task description. ` +
        `Resolve any vague references using the available context (exact function names, ` +
        `file paths, line numbers if relevant).\n\n` +
        `AMBIGUITY RULE: If the user's request is ambiguous about ANY of: which files to modify, ` +
        `what the output should look like, or which approach to take among multiple valid options — ` +
        `flag this in the reformulated prompt by prefixing it with [AMBIGUOUS: <what is unclear>]. ` +
        `Do not guess or fill in details the user did not provide. It is ALWAYS better to surface ` +
        `ambiguity than to silently assume an interpretation.\n\n` +
        `SCOPE RULE: Describe only what files need to change and what the outcome must be. ` +
        `Do NOT expand scope beyond what is asked. Do NOT mention project setup, tsconfig, ` +
        `package.json, package managers, or infrastructure unless explicitly requested. ` +
        `If the request is for a single function or snippet, state that explicitly so the ` +
        `planner produces exactly one task — not a full project scaffold.\n\n` +
        `CONTENT PRESERVATION RULE: If the user's message contains code, HTML, templates, ` +
        `examples, or other structured content meant to be used as input or reference, do NOT ` +
        `summarise or omit it. Inline content has already been extracted as attached files — ` +
        `reference them by their filename in the reformulated prompt.\n\n` +
        `Respond with JSON only: {"reformulated":"<improved prompt>","summary":"<one sentence, max 15 words>"}. ` +
        `No preamble, nothing outside the JSON.\n\n` +
        `USER REQUEST: ${seedMessage}\n\n` +
        contextHints.join('\n\n');
    }

    let rewrittenUserMessage = effectiveUserMessage;
    let coordinatorSummary = 'Sending task to engine.';

    try {
      const stripped = await coordinatorStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: rewritePrompt }],
        maxTokens: 768,
        temperature: 0.2,
        mode: 'think',
        onThinkToken: sendThinking,
      });
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { reformulated?: string; summary?: string };
        if (parsed.reformulated) rewrittenUserMessage = parsed.reformulated;
        if (parsed.summary)      coordinatorSummary    = parsed.summary;
      }
    } catch (err) {
      console.warn('[ContextIngester] Request rewrite failed, using original:', err);
    }

    return { fileSummaries, rewrittenUserMessage, coordinatorSummary, extractedFiles };
  }

  /**
   * Detect and extract inline content blocks from the user message before the
   * rewrite step. Without this, SAYON's rewrite compresses pasted code/HTML into
   * a one-liner and ALLMIND never sees the actual content.
   *
   * Detected patterns:
   *   - Fenced code blocks: ```lang\n...\n``` (any language, min 3 lines)
   *   - Bare HTML blocks: large structural HTML not wrapped in fences
   *
   * Each extracted block is written to a temp file in the workspace so it flows
   * into ALLMIND via the existing loadedFiles → <loaded_files> injection path.
   * The cleaned message replaces the block with a short reference note.
   */
  private async extractInlineContent(
    userMessage: string
  ): Promise<{ cleanedMessage: string; extractedFiles: Array<{ path: string; content: string }> }> {
    const extractedFiles: Array<{ path: string; content: string }> = [];
    let cleaned = userMessage;
    let counter = 0;

    // ── Pattern 1: fenced code blocks ─────────────────────────────────────
    // Non-greedy so multiple blocks are captured separately.
    const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    const fenceReplacements: Array<{ original: string; filename: string; content: string }> = [];

    while ((match = fenceRe.exec(userMessage)) !== null) {
      const lang = match[1] || 'txt';
      const blockContent = match[2];
      if (blockContent.split('\n').length < 3) continue; // trivially short — skip

      counter += 1;
      const ext = FENCE_LANG_TO_EXT[lang.toLowerCase()] ?? (lang || 'txt');
      fenceReplacements.push({
        original: match[0],
        filename: `_user_content_${counter}.${ext}`,
        content: blockContent,
      });
    }

    for (const rep of fenceReplacements) {
      extractedFiles.push({ path: rep.filename, content: rep.content });
      cleaned = cleaned.replace(
        rep.original,
        `[See attached: ${rep.filename} — use this as the content/input for the task]`
      );
      try {
        await fs.writeFile(path.resolve(this.workspaceDir, rep.filename), rep.content, 'utf-8');
        console.log(`[ContextIngester] extracted inline block → ${rep.filename} (${rep.content.length} chars)`);
      } catch (err) {
        console.warn(`[ContextIngester] could not write temp file ${rep.filename}:`, err);
      }
    }

    // ── Pattern 2: bare HTML blocks ───────────────────────────────────────
    // Large raw HTML pasted directly (not in fences). Only extract when the
    // block is a dominant portion of the message — avoids pulling short inline
    // HTML examples that are meant to illustrate rather than be used as input.
    const htmlRe = /(<(?:html|head|body|div|section|article|main|nav|header|footer|ul|ol|table|form|script|style)\b[\s\S]*?<\/(?:html|body|div|section|article|main|nav|header|footer|ul|ol|table|form|script|style)>)/gi;
    let htmlMatch: RegExpExecArray | null;

    while ((htmlMatch = htmlRe.exec(cleaned)) !== null) {
      const block = htmlMatch[1];
      if (block.length < 200) continue;
      if (block.length / cleaned.length < 0.35) continue; // not dominant

      counter += 1;
      const filename = `_user_content_${counter}.html`;
      extractedFiles.push({ path: filename, content: block });
      cleaned = cleaned.replace(
        block,
        `[See attached: ${filename} — use this as the content/input for the task]`
      );
      try {
        await fs.writeFile(path.resolve(this.workspaceDir, filename), block, 'utf-8');
        console.log(`[ContextIngester] extracted inline HTML → ${filename} (${block.length} chars)`);
      } catch (err) {
        console.warn(`[ContextIngester] could not write temp file ${filename}:`, err);
      }
    }

    return { cleanedMessage: cleaned.trim(), extractedFiles };
  }
}

const FENCE_LANG_TO_EXT: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  javascript: 'js', js: 'js', jsx: 'jsx',
  python: 'py', py: 'py',
  rust: 'rs', go: 'go', ruby: 'rb', php: 'php',
  csharp: 'cs', cs: 'cs', cpp: 'cpp', c: 'c',
  html: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yaml', yml: 'yml', toml: 'toml',
  sql: 'sql', sh: 'sh', bash: 'sh', shell: 'sh',
  markdown: 'md', md: 'md', text: 'txt', txt: 'txt',
};

const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript',
  py: 'Python', pyi: 'Python',
  gd: 'GDScript', tscn: 'Godot Scene', tres: 'Godot Resource',
  rs: 'Rust', go: 'Go', rb: 'Ruby', php: 'PHP',
  cs: 'C#', java: 'Java', cpp: 'C++', c: 'C', h: 'C',
  md: 'Markdown', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', env: 'ENV', sh: 'Shell', bash: 'Shell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL',
};
