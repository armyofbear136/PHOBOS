import fs from 'fs/promises';
import path from 'path';
import { coordinatorCall, coordinatorStream } from './clients.js';



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
    chatSummary?: string
  ): Promise<IngestionResult> {
    const filesToProcess = filenames.slice(0, MAX_FILES_TO_SUMMARISE);

    // ── Step 1: Read files ──────────────────────────────────────────────────
    if (filesToProcess.length > 0) {
      sendStatus(`Reading ${filesToProcess.length} workspace file${filesToProcess.length > 1 ? 's' : ''}…`);
    }

    const fileContents: Array<{ filename: string; content: string; sizeBytes: number; language: string }> = [];
    for (const filename of filesToProcess) {
      try {
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
    sendStatus('Coordinator reviewing request…');

    const contextHints: string[] = [];
    if (chatSummary) contextHints.push(`Conversation summary (prior turns):\n${chatSummary}`);
    if (projectMd) contextHints.push(`Project context:\n${projectMd}`);
    if (repoMap)   contextHints.push(`Workspace index:\n${repoMap}`);
    if (fileSummaries.length > 0) {
      const summaryLines = fileSummaries.map((f) => `  ${f.filename}: ${f.summary}`).join('\n');
      contextHints.push(`File summaries:\n${summaryLines}`);
    }

    const rewritePrompt =
      `You are preparing a request for ALLMIND, a powerful AI execution engine. ` +
      `Rewrite the user's message into a precise, unambiguous task description. ` +
      `Resolve any vague references using the available context (exact function names, ` +
      `file paths, line numbers if relevant). Clarify scope. Note constraints. ` +
      `Preserve the intent exactly — if it is a question or conversation, keep it as such. ` +
      `Respond with JSON only: {"reformulated":"<improved prompt>","summary":"<one sentence, max 15 words>"}. ` +
      `No preamble, nothing outside the JSON.\n\n` +
      `USER REQUEST: ${userMessage}\n\n` +
      contextHints.join('\n\n');

    let rewrittenUserMessage = userMessage;
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

    return { fileSummaries, rewrittenUserMessage, coordinatorSummary };
  }
}

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
