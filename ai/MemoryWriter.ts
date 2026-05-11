// ── MemoryWriter ──────────────────────────────────────────────────────────────
//
// Post-processing hooks called AFTER stream completion — never during generation.
// Decides what content is worth embedding and calls MemoryStore.insert().
//
// Three entry points:
//   embedCopilotExchange()  — called after every copilot turn
//   embedTaskCompletion()   — called after SEREN's final output is persisted
//   embedExplicitMemory()   — called when [REMEMBER] tags extract a key-value pair
//
// All functions are fire-and-forget: they catch their own errors so callers
// never need a try/catch. Embedding latency (~50ms CPU) is non-blocking.

import { MemoryStore, type MemoryScope, type MemoryCategory } from '../db/MemoryStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { embed } from './EmbedClient.js';
import { gsm } from '../game/GameStateManager.js';

// ── Keyword patterns for category inference ───────────────────────────────────

const DECISION_PATTERNS = [
  /\bwe decided\b/i, /\bchose to\b/i, /\bwent with\b/i, /\busing\b.{0,30}\bbecause\b/i,
  /\barchitecture\b/i, /\btrade.?off\b/i, /\binstead of\b/i, /\brather than\b/i,
];

const CODE_PATTERN_PATTERNS = [
  /\bpattern\b/i, /\bconvention\b/i, /\bapproach\b/i, /\bstrategy\b/i,
  /\balways\b/i, /\bnever\b/i, /\bprefer\b/i, /\bstandard\b/i,
];

function inferCategory(text: string): MemoryCategory {
  if (DECISION_PATTERNS.some(r => r.test(text)))    return 'decision';
  if (CODE_PATTERN_PATTERNS.some(r => r.test(text))) return 'code_pattern';
  return 'session_fact';
}

// ── Sentence extraction ───────────────────────────────────────────────────────
// Splits text on sentence boundaries and returns non-trivial sentences
// (>30 chars, no pure code lines) that are worth embedding individually.

function extractEmbeddableSentences(text: string, maxCount = 8): string[] {
  const sentences = text
    .replace(/```[\s\S]*?```/g, '')   // strip code blocks
    .replace(/`[^`]+`/g, '')          // strip inline code
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 30 && s.length < 1_000);

  return sentences.slice(0, maxCount);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a copilot exchange (user + assistant message pair) as a session_fact.
 * Called after the stream closes in routes/copilot.ts.
 * Non-blocking — errors are swallowed.
 */
export async function embedCopilotExchange(
  persona: 'sayon' | 'seren',
  userMsg: string,
  assistantMsg: string,
): Promise<void> {
  try {
    gsm.setPersonaState('sybil', 'embedding');
    const db    = DatabaseManager.getUserDb();
    const store = new MemoryStore(db);
    const scope: MemoryScope = `copilot-${persona}`;

    // Embed the combined exchange so the vector captures both sides.
    const combined = `User: ${userMsg.slice(0, 400)}\n${persona.toUpperCase()}: ${assistantMsg.slice(0, 600)}`;
    const vec = await embed(combined);
    if (!vec) return;

    await store.insert(
      {
        content:  combined,
        scope,
        category: 'session_fact',
      },
      vec,
    );
    gsm.setPersonaState('sybil', 'idle');
  } catch {
    gsm.setPersonaState('sybil', 'idle');
    // Non-fatal — embedding failure never surfaces to the user.
  }
}

/**
 * Embed significant content from a completed task pipeline run.
 * Called after SEREN's final output is persisted in routes/messages.ts.
 * Extracts decision-class and code-pattern-class sentences; skips trivial content.
 * Non-blocking — errors are swallowed.
 */
export async function embedTaskCompletion(
  threadId: string,
  messageId: string,
  output: string,
): Promise<void> {
  try {
    gsm.setPersonaState('sybil', 'embedding');
    const db    = DatabaseManager.getUserDb();
    const store = new MemoryStore(db);

    const sentences = extractEmbeddableSentences(output);
    if (sentences.length === 0) { gsm.setPersonaState('sybil', 'idle'); return; }

    for (const sentence of sentences) {
      const category = inferCategory(sentence);
      // Skip generic session_facts from task output — they're too noisy.
      // Only decisions and code patterns from the task pipeline are worth
      // persisting to workspace scope.
      if (category === 'session_fact') continue;

      const vec = await embed(sentence);
      if (!vec) continue;

      await store.insert(
        {
          content:   sentence,
          scope:     'workspace',
          category,
          threadId,
          sourceMsgId: messageId,
        },
        vec,
      );
    }
    gsm.setPersonaState('sybil', 'idle');
  } catch {
    gsm.setPersonaState('sybil', 'idle');
    // Non-fatal.
  }
}

/**
 * Embed an explicit [REMEMBER] memory extracted from copilot output.
 * Called alongside CopilotMemoryStore.store() so the key-value pair is
 * also available for semantic search, not just exact-key lookup.
 * Non-blocking — errors are swallowed.
 */
export async function embedExplicitMemory(
  persona: 'sayon' | 'seren',
  category: string,
  key: string,
  value: string,
): Promise<void> {
  try {
    const db    = DatabaseManager.getUserDb();
    const store = new MemoryStore(db);
    const scope: MemoryScope = `copilot-${persona}`;

    const content = `${key}: ${value}`;
    const vec = await embed(content);
    if (!vec) return;

    await store.insert(
      {
        content,
        scope,
        category: category as MemoryCategory,
      },
      vec,
    );
  } catch {
    // Non-fatal.
  }
}

/**
 * Query workspace + global scope for memories relevant to a user request.
 * Returns formatted XML for injection into Complete Context.
 * Returns empty string if SYBIL is unavailable or no results found.
 */
export async function retrieveWorkspaceMemory(
  query: string,
  k = 5,
): Promise<string> {
  try {
    gsm.setPersonaState('sybil', 'retrieving_memory');
    const db    = DatabaseManager.getUserDb();
    const store = new MemoryStore(db);

    const vec = await embed(query.slice(0, 800));
    if (!vec) { gsm.setPersonaState('sybil', 'idle'); return ''; }

    const results = await store.searchMultiScope(vec, ['workspace', 'global'], k);
    if (results.length === 0) { gsm.setPersonaState('sybil', 'idle'); return ''; }

    const lines = ['<prior_memory>'];
    for (const r of results) {
      const date = r.created_at ? r.created_at.toString().slice(0, 10) : '';
      lines.push(`  <memory category="${r.category}" score="${r.score.toFixed(2)}" date="${date}">`);
      lines.push(`    ${r.content}`);
      lines.push(`  </memory>`);
    }
    lines.push('</prior_memory>');
    gsm.setPersonaState('sybil', 'idle');
    return lines.join('\n');
  } catch {
    gsm.setPersonaState('sybil', 'idle');
    return '';
  }
}

/**
 * Query copilot-scoped memory for a persona.
 * Returns formatted XML for injection into the copilot system prompt.
 * Returns empty string if SYBIL is unavailable or no results found.
 */
export async function retrieveCopilotMemory(
  persona: 'sayon' | 'seren',
  query: string,
  k = 5,
): Promise<string> {
  try {
    gsm.setPersonaState('sybil', 'retrieving_memory');
    const db    = DatabaseManager.getUserDb();
    const store = new MemoryStore(db);

    // Short queries get context from recent message history to improve recall.
    const searchText = query.length < 40
      ? query  // caller should pre-pend conversation tail if query is sparse
      : query.slice(0, 800);

    const vec = await embed(searchText);
    if (!vec) { gsm.setPersonaState('sybil', 'idle'); return ''; }

    const scope: MemoryScope = `copilot-${persona}`;
    const results = await store.search(vec, scope, null, k);
    if (results.length === 0) { gsm.setPersonaState('sybil', 'idle'); return ''; }

    const lines = ['<memory_context>'];
    for (const r of results) {
      const date = r.created_at ? r.created_at.toString().slice(0, 10) : '';
      lines.push(`  <memory date="${date}">${r.content}</memory>`);
    }
    lines.push('</memory_context>');
    gsm.setPersonaState('sybil', 'idle');
    return lines.join('\n');
  } catch {
    gsm.setPersonaState('sybil', 'idle');
    return '';
  }
}
