import fs from 'fs/promises';
import path from 'path';
import { coordinatorCall, coordinatorStream } from './clients.js';
import type { AgentStateManager } from './AgentStateManager.js';
import { getInjection } from './SkillManager.js';



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

/**
 * Project-level scope — classified by SAYON during ingest.
 * Drives how many tasks SEREN plans and how much content each task produces.
 *
 * MINIMAL      → Exactly what was asked. No extras. One thing, done precisely.
 * STANDARD     → All files a competent developer considers naturally implied.
 * COMPREHENSIVE → Production-ready. Tests, supporting files, configs where relevant.
 * EXHAUSTIVE   → Everything. Every file, every edge case, every supporting artifact.
 */
export type ProjectScope = 'MINIMAL' | 'STANDARD' | 'COMPREHENSIVE' | 'EXHAUSTIVE';

export interface IngestionResult {
  fileSummaries: FileSummary[];
  rewrittenUserMessage: string;
  /** One-sentence coordinator summary emitted as coordinator bubble */
  coordinatorSummary: string;
  /**
   * Inline content blocks extracted from the user message (fenced code blocks,
   * large HTML blocks). Each has been written to a temp file in the workspace
   * so SEREN can receive them verbatim via loadedFiles injection.
   */
  extractedFiles: Array<{ path: string; content: string }>;
  /**
   * SAYON's assessment of the project-level scope of this request.
   * Drives how many tasks SEREN plans and how much content each task produces.
   */
  projectScope: ProjectScope;
  /**
   * When SAYON needs clarification before handing off to SEREN, this is set.
   * The caller (LoopController) exits early, sends these questions to the user,
   * and records the thread as pending Phase 1 clarification.
   */
  phase1Clarification?: {
    questions: string[];
    /** Full Q&A transcript built up across rounds */
    log: Array<{ questions: string[]; userReply: string }>;
  };
}

// ── Module-level file summary cache ──────────────────────────────────────────
// Keyed on "filename:mtimeMs:sizeBytes". A file is re-summarised only when its
// mtime or size changes — not on every request. The cache persists for the life
// of the server process. Content is cached alongside the summary so TaskPlanner
// enrichment still works without re-reading disk.
interface CachedSummary {
  summary: string;
  content: string;
  language: string;
}
const _summaryCache = new Map<string, CachedSummary>();

function _summaryCacheKey(filename: string, mtimeMs: number, sizeBytes: number): string {
  return `${filename}:${mtimeMs}:${sizeBytes}`;
}

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
    intentType?: string,
    /** Phase 1 clarification state — set when the user is replying to SAYON's pre-SEREN questions */
    phase1ClarificationLog?: Array<{ questions: string[]; userReply: string }>,
    /** The original first-message request that triggered Phase 1 — needed for synthesis */
    phase1OriginalRequest?: string
  ): Promise<IngestionResult> {
    // ── Pre-step: Extract inline content blocks from user message ───────────
    // If the user pasted a code block or HTML directly into the chat, SAYON's
    // rewrite would summarise it away before SEREN ever sees it. We pull those
    // blocks out first, write them as temp files, and replace them in the message
    // with a reference. The rewrite then only operates on the instructional prose.
    const { cleanedMessage, extractedFiles } = await this.extractInlineContent(userMessage);
    const effectiveUserMessage = cleanedMessage;

    const filesToProcess = filenames.slice(0, MAX_FILES_TO_SUMMARISE);

    // ── Step 1: Read files ──────────────────────────────────────────────────
    if (filesToProcess.length > 0) {
      sendStatus(`Reading ${filesToProcess.length} workspace file${filesToProcess.length > 1 ? 's' : ''}…`);
    }

    // ── Step 1: Read files — cache hit skips disk read ─────────────────────
    const fileContents: Array<{ filename: string; content: string; sizeBytes: number; language: string; cacheKey: string; cached: boolean }> = [];
    for (const filename of filesToProcess) {
      try {
        agentState?.transition('reading', filename.split('/').pop()!.slice(0, 20));
        const absPath = path.resolve(this.workspaceDir, filename);
        const stat = await fs.stat(absPath);
        const ext = path.extname(filename).slice(1) || 'text';
        const language = LANGUAGE_LABELS[ext] ?? ext;
        const cacheKey = _summaryCacheKey(filename, stat.mtimeMs, stat.size);

        // Cache hit — no need to read file or re-summarise
        if (_summaryCache.has(cacheKey)) {
          const hit = _summaryCache.get(cacheKey)!;
          fileContents.push({ filename, content: hit.content, sizeBytes: stat.size, language: hit.language, cacheKey, cached: true });
          continue;
        }

        if (stat.size > SUMMARISE_THRESHOLD_BYTES) {
          fileContents.push({ filename, content: `[File too large to display: ${(stat.size / 1024).toFixed(0)}KB]`, sizeBytes: stat.size, language, cacheKey, cached: false });
          continue;
        }

        const raw = await fs.readFile(absPath, 'utf-8');
        const content = raw.length > MAX_FILE_CHARS
          ? raw.slice(0, MAX_FILE_CHARS) + `\n... [truncated at ${MAX_FILE_CHARS} chars, full size ${raw.length} chars]`
          : raw;
        fileContents.push({ filename, content, sizeBytes: stat.size, language, cacheKey, cached: false });
      } catch {
        // File disappeared between index and read — skip silently
      }
    }

    // ── Step 2: Summarise files — only those not already cached ────────────
    const fileSummaries: FileSummary[] = [];
    const needsSummarising = fileContents.filter(f => !f.cached);
    const cachedCount = fileContents.length - needsSummarising.length;

    if (needsSummarising.length > 0) {
      sendStatus(cachedCount > 0
        ? `Summarising ${needsSummarising.length} file${needsSummarising.length > 1 ? 's' : ''} (${cachedCount} cached)…`
        : `Summarising ${needsSummarising.length} file${needsSummarising.length > 1 ? 's' : ''}…`
      );

      const SUMMARY_BATCH_SIZE = 4;
      const compressionGuidance = getInjection('sayon_ingest');
      const summaryMap = new Map<string, string>();

      for (let batchStart = 0; batchStart < needsSummarising.length; batchStart += SUMMARY_BATCH_SIZE) {
        const batch = needsSummarising.slice(batchStart, batchStart + SUMMARY_BATCH_SIZE);
        const fileBlocks = batch
          .map((f) => `<file path="${f.filename}" language="${f.language}">\n${f.content.slice(0, 8_000)}\n</file>`)
          .join('\n\n');

        const summaryPrompt =
          `You are SAYON preparing file summaries for SEREN. Summarise each file below. ` +
          `For each file, document EVERY critical part: what it does, its key exports or ` +
          `responsibilities, and main dependencies. Use as much space as is truly necessary and no more. ` +
          `Respond ONLY with a JSON array: [{"filename":"...","summary":"..."}]. No preamble.` +
          compressionGuidance +
          `\n\n` +
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
            for (const p of parsed) summaryMap.set(p.filename, p.summary);
          }
        } catch (err) {
          console.warn(`[ContextIngester] Batch summarisation failed (batch ${batchStart}), using fallbacks:`, err);
        }
      }

      // Write new summaries into cache
      for (const f of needsSummarising) {
        const summary = summaryMap.get(f.filename) ?? `${f.language} file, ${(f.sizeBytes / 1024).toFixed(1)}KB`;
        _summaryCache.set(f.cacheKey, { summary, content: f.content, language: f.language });
      }
    } else if (cachedCount > 0) {
      sendStatus(`${cachedCount} file${cachedCount > 1 ? 's' : ''} loaded from cache…`);
    }

    // Assemble fileSummaries from cache + fresh results
    for (const f of fileContents) {
      const cached = _summaryCache.get(f.cacheKey);
      fileSummaries.push({
        filename: f.filename,
        language: f.language,
        sizeBytes: f.sizeBytes,
        summary: cached?.summary ?? `${f.language} file, ${(f.sizeBytes / 1024).toFixed(1)}KB`,
        content: f.content,
      });
    }

    // ── Phase 1 Clarification check ────────────────────────────────────────
    // synthesisMode is declared here (hoisted) because Phase 1 check needs it.
    // It is fully set in Step 3 below — here we just need to know if we are
    // already mid-SEREN clarification so we can skip Phase 1.
    const synthesisMode = !!(clarificationLog && clarificationLog.length > 0);

    // Fires for CODE_REQUEST and PLAN_REQUEST regardless of whether a workspace
    // is present — non-file tasks (writing, analysis, docs) need clarity too.
    // Only skipped when already mid-clarification loop (either kind).
    const canAskPhase1 =
      !synthesisMode &&
      !phase1ClarificationLog?.length &&
      (intentType === 'CODE_REQUEST' || intentType === 'PLAN_REQUEST');

    if (canAskPhase1) {
      // Build the full picture SAYON now has after Step 2 — this is why Phase 1
      // must fire AFTER file summarisation, not before it.
      const contextSummaryForClarity: string[] = [];
      if (chatSummary) contextSummaryForClarity.push(`Prior conversation summary available.`);
      if (fileSummaries.length > 0) {
        contextSummaryForClarity.push(
          `Workspace files:\n` +
          fileSummaries.map(f => `  ${f.filename}: ${f.summary}`).join('\n')
        );
      }

      const clarityCheckPrompt =
        `You are SAYON. You have read the user's request and all available workspace context. ` +
        `Before handing this to the execution engine, decide: is the request ` +
        `clear enough to plan and execute without risking producing the wrong result?\n\n` +
        `Ask yourself:\n` +
        `- Do I know exactly what the user wants as the end result?\n` +
        `- If files are involved, do I know which ones and what changes to make?\n` +
        `- If no files are involved, do I know the format, scope, and content expected?\n` +
        `- Is there any ambiguity that would force the executor to guess at intent?\n\n` +
        `If YES to all: respond {"decision":"PROCEED"}.\n` +
        `If any answer is NO: respond {"decision":"CLARIFY","questions":["<q1>","<q2>"]}.\n` +
        `Maximum 2 questions. Only ask what you genuinely cannot infer from the request and context.\n` +
        `Do NOT ask about files if the request clearly does not involve files.\n\n` +
        `USER REQUEST: ${effectiveUserMessage}` +
        (contextSummaryForClarity.length > 0
          ? `\n\nAVAILABLE CONTEXT:\n${contextSummaryForClarity.join('\n\n')}`
          : `\nNo workspace files are present.`) +
        `\n\nRespond ONLY with JSON. No preamble.`;

      try {
        sendStatus('SAYON reviewing request clarity…');
        const raw = await coordinatorCall({
          systemPrompt: '',
          messages: [{ role: 'user', content: clarityCheckPrompt }],
          maxTokens: 256,
          temperature: 0.1,
          mode: 'no_think',
        });
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { decision: string; questions?: string[] };
          if (parsed.decision === 'CLARIFY' && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            return {
              fileSummaries,
              rewrittenUserMessage: effectiveUserMessage,
              coordinatorSummary: 'I need a bit more information before I can get started.',
              extractedFiles,
              projectScope: 'STANDARD', // default — will be set properly on re-entry
              phase1Clarification: {
                questions: parsed.questions,
                log: [{ questions: parsed.questions, userReply: '' }],
              },
            };
          }
        }
      } catch (err) {
        console.warn('[ContextIngester] Phase 1 clarity check failed, proceeding anyway:', err);
      }
    }

    // If we are re-entering with Phase 1 answers, build a transcript seed.
    // This is set before contextHints/synthesisMode so the rewrite can use it.
    // phase1SeedOverride only activates when at least one log entry has a filled
    // userReply. If all entries have empty replies, the user hasn't answered yet
    // and we should NOT enter synthesis mode — let Phase 1 ask again or proceed.
    let phase1SeedOverride: string | null = null;
    const hasFilledPhase1Replies = phase1ClarificationLog?.some(e => e.userReply.trim().length > 0) ?? false;
    if (phase1ClarificationLog && phase1ClarificationLog.length > 0 && hasFilledPhase1Replies) {
      // Use the stored originalRequest (first message) as the anchor — NOT effectiveUserMessage
      // which is just the second message (the answer). Without this, the original "build me a
      // website" request is lost and only the short answer makes it into the synthesis.
      const anchor = phase1OriginalRequest ?? effectiveUserMessage;
      const parts: string[] = [`Original request: ${anchor}`];
      for (const entry of phase1ClarificationLog) {
        for (const q of entry.questions) parts.push(`SAYON asked: ${q}`);
        if (entry.userReply) parts.push(`User replied: ${entry.userReply}`);
      }
      phase1SeedOverride = parts.join('\n');
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
    if (synthesisMode) {
      const rounds = clarificationLog!
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
    // Phase 1 clarification transcript overrides any other seed — it carries
    // the full SAYON Q&A history before SEREN ever saw the request.
    if (phase1SeedOverride) seedMessage = phase1SeedOverride;

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

    if (synthesisMode || phase1SeedOverride) {
      // ── Mode 2: Clarification synthesis ──────────────────────────────────────
      // Used for both SEREN clarification re-entry and Phase 1 SAYON clarification re-entry.
      // seedMessage already contains the full Q&A transcript in either case.
      const historyBlock = phase1SeedOverride
        ? `<phase1_clarification_history>\n${phase1SeedOverride}\n</phase1_clarification_history>\n\n`
        : clarificationHistoryBlock;

      rewritePrompt =
        historyBlock +
        `You are SAYON, preparing the final task brief for SEREN. ` +
        `The user's request has been clarified through a Q&A exchange. ` +
        `Synthesise ALL of the information below into a single precise, unambiguous task description ` +
        `that SEREN can execute without needing to ask anything further.\n\n` +
        `SYNTHESIS RULE: Do NOT flag ambiguity, do NOT prefix with [AMBIGUOUS]. ` +
        `Incorporate every answer the user gave. Make reasonable creative choices for ` +
        `anything left genuinely open, and describe those choices explicitly. ` +
        `The reformulated prompt must fully describe the complete original request — ` +
        `do not reduce it to just the clarification answers.\n\n` +
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
        `You are preparing a question brief for SEREN, an AI reasoning engine. ` +
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
      // SAYON's prompt enhancement happens in handleDirectResponse() in messages.ts.
      rewritePrompt =
        `Respond with JSON only: {"reformulated":${JSON.stringify(seedMessage)},"summary":"Generate image"}. ` +
        `No preamble, nothing outside the JSON.`;

    } else {
      // ── Mode 3: Execution (CODE_REQUEST / PLAN_REQUEST) ─────────────────────────────
      const hasFiles = fileSummaries.length > 0;
      rewritePrompt =
        `You are SAYON, preparing a task brief for SEREN, the execution engine. ` +
        `Rewrite the user's request into a precise, unambiguous description that SEREN ` +
        `can act on without needing to guess at intent.\n\n` +
        `AMBIGUITY RULE: If the request leaves the expected outcome unclear — whether that ` +
        `is a file change, a written document, a code snippet, or an analysis — flag it ` +
        `by prefixing the reformulated prompt with [AMBIGUOUS: <what is unclear>]. ` +
        `Do not invent details the user did not provide. Surface ambiguity rather than ` +
        `silently assuming an interpretation.\n\n` +
        `SCOPE RULE: Describe exactly what needs to be produced and what the outcome must be. ` +
        `Do NOT expand scope. Do NOT add infrastructure (tsconfig, package.json, scaffolding) ` +
        `unless explicitly requested. If the request is for a single function, snippet, or ` +
        `written response, state that explicitly — do not escalate it into a larger task.\n\n` +
        (hasFiles
          ? `FILE RULE: If files are involved, name them exactly using the filenames from context. ` +
            `If the task does not require touching any file, state that clearly so SEREN ` +
            `produces a text response rather than a file operation.\n\n`
          : `FILE RULE: No workspace files are present. If the user's request requires a file ` +
            `to be created, name it explicitly. If the request is for a response or analysis ` +
            `with no file output, state that clearly.\n\n`) +
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
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { reformulated?: string; summary?: string };
          if (parsed.reformulated) rewrittenUserMessage = parsed.reformulated;
          if (parsed.summary)      coordinatorSummary    = parsed.summary;
        } catch {
          // Malformed JSON — try to extract reformulated/summary from raw text
          const refMatch   = stripped.match(/"reformulated"\s*:\s*"([^"]{10,})"/);
          const summMatch  = stripped.match(/"summary"\s*:\s*"([^"]{5,})"/);
          if (refMatch?.[1])  rewrittenUserMessage = refMatch[1];
          if (summMatch?.[1]) coordinatorSummary   = summMatch[1];
        }
      }
    } catch (err) {
      console.warn('[ContextIngester] Request rewrite failed, using original:', err);
    }

    // ── Scope classification ──────────────────────────────────────────────
    // A quick follow-up SAYON call to classify the project scope based on the
    // rewritten message and available context. Cheap, no_think, single token output.
    let projectScope: ProjectScope = 'STANDARD';
    if (intentType === 'CODE_REQUEST' || intentType === 'PLAN_REQUEST') {
      const scopePrompt =
        `Classify the scope of this request into exactly one of: MINIMAL, STANDARD, COMPREHENSIVE, EXHAUSTIVE.\n\n` +
        `MINIMAL      = Exactly one specific thing asked for. A single file, function, fix, or short response.\n` +
        `STANDARD     = A well-defined task with an understood set of deliverables. A feature, a component, a document.\n` +
        `COMPREHENSIVE = A substantial project or feature that should be production-ready. Multiple files, tests if relevant.\n` +
        `EXHAUSTIVE   = The user wants everything possible. A full system, full site, full app, or explicitly comprehensive output.\n\n` +
        `REQUEST: ${rewrittenUserMessage.slice(0, 2_000)}\n\n` +
        `Respond with ONLY one word: MINIMAL, STANDARD, COMPREHENSIVE, or EXHAUSTIVE. Nothing else.`;
      try {
        const scopeRaw = await coordinatorCall({
          systemPrompt: '',
          messages: [{ role: 'user', content: scopePrompt }],
          maxTokens: 8,
          temperature: 0.0,
          mode: 'no_think',
        });
        const scopeWord = scopeRaw.trim().toUpperCase() as ProjectScope;
        if (['MINIMAL', 'STANDARD', 'COMPREHENSIVE', 'EXHAUSTIVE'].includes(scopeWord)) {
          projectScope = scopeWord;
        }
      } catch (err) {
        console.warn('[ContextIngester] Scope classification failed, defaulting to STANDARD:', err);
      }
      console.log(`[ingest:scope] classified as ${projectScope}`);
    }

    return { fileSummaries, rewrittenUserMessage, coordinatorSummary, extractedFiles, projectScope };
  }

  /**
   * Detect and extract inline content blocks from the user message before the
   * rewrite step. Without this, SAYON's rewrite compresses pasted code/HTML into
   * a one-liner and SEREN never sees the actual content.
   *
   * Detected patterns:
   *   - Fenced code blocks: ```lang\n...\n``` (any language, min 3 lines)
   *   - Bare HTML blocks: large structural HTML not wrapped in fences
   *
   * Each extracted block is written to a temp file in the workspace so it flows
   * into SEREN via the existing loadedFiles → <loaded_files> injection path.
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
