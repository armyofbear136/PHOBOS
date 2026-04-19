// ── ConversationRAGClient ──────────────────────────────────────────────────────
//
// Agentic RAG over PHOBOS conversation history.
//
// Called once per message dispatch, after intent classification but before
// the final prompt assembly in DispatchComposer / handleDirectResponse.
//
// Pipeline:
//   1. detectMemoryIntent()  — zero-LLM, regex pattern match
//   2. embed(query)          — SYBIL
//   3. searchThread()        — ConversationStore VSS+FTS
//   4. assembleFileContext() — load linked files; fit or summarise to budget
//   5. formatRAGBlock()      — XML for injection into final prompt
//
// Isolation contract: only this file and the copilot investigation branch
// ever call ConversationStore. Nothing in ArchiveIntentClassifier or
// ArchiveClient touches the conversation DB.

import fs from 'fs/promises';
import path from 'path';
import { embed } from './EmbedClient.js';
import { coordinatorCall } from './clients.js';
import {
  searchThread,
  searchAllThreads,
  type ConversationSearchResult,
} from '../db/ConversationStore.js';

// ── Memory-retrieval intent patterns ─────────────────────────────────────────
//
// Ordered by specificity. First match wins. False positives cost one VSS
// search (~2ms). False negatives mean a miss — keep patterns broad.

const MEMORY_PATTERNS: RegExp[] = [
  /remember when (i|we|you) (said|asked|talked|mentioned|discussed|worked|built|wrote|made)/i,
  /do you remember (when|what|how|the)/i,
  /look back (to when|at when|at the)/i,
  /earlier (you|i|we) (said|mentioned|discussed|built|wrote)/i,
  /we (talked|discussed|worked) (about|on) .{3,60} (earlier|before|previously|last time)/i,
  /when (i|we) (asked|worked on|built|wrote|created|discussed)/i,
  /what did (i|we|you) (say|decide|agree|build|write) (about|when|earlier|before)/i,
  /find (the|that) (conversation|message|time) (when|where|about)/i,
  /go back to (when|where|the)/i,
  /that (thing|file|component|function|discussion) (we|i|you) (made|built|wrote|had)/i,
];

/**
 * Returns true when the message contains a memory-retrieval signal.
 * Zero LLM calls — deterministic, sub-millisecond.
 */
export function detectMemoryIntent(userMessage: string): boolean {
  return MEMORY_PATTERNS.some(p => p.test(userMessage));
}

// ── File budget constants ─────────────────────────────────────────────────────

// Chars reserved for the file context block inside the final prompt.
// ~20k chars ≈ ~5k tokens — leaves plenty of room for system + history + query.
const FILE_BUDGET_CHARS = 20_000;
// Single-file summarisation threshold — files larger than this get summarised
const SUMMARISE_THRESHOLD_CHARS = 6_000;
// Max chars fed to the summariser per file
const SUMMARISE_INPUT_CAP_CHARS = 24_000;

// ── Result type ───────────────────────────────────────────────────────────────

export interface ConversationRAGResult {
  /** XML block ready for prompt injection — empty string when nothing found */
  contextBlock: string;
  /** Number of VSS hits returned */
  hitCount: number;
  /** Whether any file content was attached */
  hasFileContent: boolean;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full conversation RAG pipeline for a user message.
 *
 * @param threadId     Current thread
 * @param userMessage  Raw user typed text
 * @param workspaceDir Absolute path to the thread's workspace root
 * @param k            Max VSS hits to retrieve (default 5)
 * @returns            Structured result with the XML context block
 */
export async function runConversationRAG(
  threadId: string,
  userMessage: string,
  workspaceDir: string,
  k = 5,
): Promise<ConversationRAGResult> {
  const empty: ConversationRAGResult = { contextBlock: '', hitCount: 0, hasFileContent: false };

  if (!detectMemoryIntent(userMessage)) return empty;

  const queryVec = await embed(userMessage.slice(0, 800));
  if (!queryVec) return empty;

  const hits = await searchThread(threadId, queryVec, userMessage, k);
  if (hits.length === 0) return empty;

  const fileContext = await assembleFileContext(hits, workspaceDir);
  const contextBlock = formatRAGBlock(hits, fileContext);

  return {
    contextBlock,
    hitCount: hits.length,
    hasFileContent: fileContext.length > 0,
  };
}

/**
 * Cross-thread search for copilot "investigate system" branch.
 * Not called from the main message pipeline.
 */
export async function runSystemInvestigation(
  query: string,
  k = 10,
): Promise<ConversationRAGResult> {
  const empty: ConversationRAGResult = { contextBlock: '', hitCount: 0, hasFileContent: false };

  const queryVec = await embed(query.slice(0, 800));
  if (!queryVec) return empty;

  const hits = await searchAllThreads(queryVec, query, k);
  if (hits.length === 0) return empty;

  // Cross-thread searches don't attempt to load workspace files —
  // workspace root varies per thread and we don't want to expose
  // arbitrary file paths in a copilot summary context.
  const contextBlock = formatRAGBlock(hits, []);

  return { contextBlock, hitCount: hits.length, hasFileContent: false };
}

// ── File budget assembly ──────────────────────────────────────────────────────

interface FileEntry {
  filePath: string;
  content: string;
  summarised: boolean;
}

/**
 * For each VSS hit, load the workspace files linked to that turn.
 * Fits raw content within FILE_BUDGET_CHARS. Files that overflow individually
 * get summarised. Returns entries in order of score descending.
 */
async function assembleFileContext(
  hits: ConversationSearchResult[],
  workspaceDir: string,
): Promise<FileEntry[]> {
  // Collect unique file paths in score order (highest-score hit first)
  const seen = new Set<string>();
  const orderedPaths: string[] = [];
  for (const hit of hits) {
    for (const fp of hit.files) {
      if (!seen.has(fp)) {
        seen.add(fp);
        orderedPaths.push(fp);
      }
    }
  }
  if (orderedPaths.length === 0) return [];

  const entries: FileEntry[] = [];
  let budgetUsed = 0;

  for (const relPath of orderedPaths) {
    if (budgetUsed >= FILE_BUDGET_CHARS) break;

    const absPath = path.resolve(workspaceDir, relPath);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue; // file deleted or moved since the turn was indexed
    }

    const remaining = FILE_BUDGET_CHARS - budgetUsed;

    if (raw.length <= SUMMARISE_THRESHOLD_CHARS) {
      // Fits raw — include verbatim
      const content = raw.slice(0, remaining);
      entries.push({ filePath: relPath, content, summarised: false });
      budgetUsed += content.length;
    } else if (remaining >= 400) {
      // Too large for raw — summarise
      const summary = await summariseFile(relPath, raw);
      const content = summary.slice(0, remaining);
      entries.push({ filePath: relPath, content, summarised: true });
      budgetUsed += content.length;
    }
    // If remaining < 400 we can't fit even a summary — skip
  }

  return entries;
}

/**
 * Single coordinator call to produce a concise summary of a file.
 * Targets key exports, responsibilities, and decisions — not line-by-line.
 */
async function summariseFile(filePath: string, content: string): Promise<string> {
  try {
    const prompt =
      `Summarise the following file for use as retrieved context in a conversation. ` +
      `Cover: what it does, its key exports or responsibilities, any important decisions or ` +
      `patterns visible in the code, and its main dependencies. Be concise — target 150-250 words. ` +
      `Do not include line-by-line descriptions.\n\n` +
      `File: ${filePath}\n\n` +
      content.slice(0, SUMMARISE_INPUT_CAP_CHARS);

    const raw = await coordinatorCall({
      systemPrompt: '',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.1,
      mode: 'no_think',
    });
    return raw.trim() || `[${filePath}: summary unavailable]`;
  } catch {
    return `[${filePath}: summary unavailable]`;
  }
}

// ── XML formatter ─────────────────────────────────────────────────────────────

function formatRAGBlock(
  hits: ConversationSearchResult[],
  fileEntries: FileEntry[],
): string {
  const lines: string[] = ['<conversation_history_context>'];
  lines.push('  <!-- Retrieved from conversation history via semantic search -->');

  for (const hit of hits) {
    const score = hit.score.toFixed(2);
    const date = hit.createdAt.slice(0, 10);
    lines.push(`  <prior_exchange score="${score}" date="${date}" message_id="${escXml(hit.messageId)}">`);
    lines.push(`    <user>${escXml(hit.userText)}</user>`);
    lines.push(`    <assistant>${escXml(hit.assistantText)}</assistant>`);
    if (hit.files.length > 0) {
      lines.push(`    <linked_files>${hit.files.map(f => escXml(f)).join(', ')}</linked_files>`);
    }
    lines.push(`  </prior_exchange>`);
  }

  if (fileEntries.length > 0) {
    lines.push('  <linked_file_contents>');
    for (const entry of fileEntries) {
      const tag = entry.summarised ? 'summary' : 'content';
      lines.push(`    <file path="${escXml(entry.filePath)}" type="${tag}">`);
      lines.push(`      ${escXml(entry.content)}`);
      lines.push(`    </file>`);
    }
    lines.push('  </linked_file_contents>');
  }

  lines.push('</conversation_history_context>');
  return lines.join('\n');
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
