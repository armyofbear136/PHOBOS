// ── distillAssistantContent ───────────────────────────────────────────────────
//
// Strips non-conversational content from an AI response before it is stored
// in messages.distilled_content and before it is embedded into the conversation
// VSS index.
//
// What is removed:
//   - Triple-backtick fenced code blocks (any language tag)
//   - <file ...>...</file> injection blocks
//   - <loaded_files>...</loaded_files> blocks
//   - <attached_files>...</attached_files> blocks
//   - <think>...</think> / [THINK]...[/THINK] (already stripped by ThinkingStripper
//     before DB write, but handled here defensively)
//   - Diff/patch blocks (--- +++ @@ lines)
//   - Repeated blank lines collapsed to one
//   - Leading/trailing whitespace
//
// What is preserved:
//   - All natural-language prose the AI wrote
//   - Inline code spans (`code`) — short, readable, not noise
//   - Markdown formatting (bold, headers, lists) — part of the prose structure
//   - URLs and citations
//
// The distilled text should read like a clean conversation log: what the AI
// actually said, without the deliverables it produced.

// ── Patterns ──────────────────────────────────────────────────────────────────

// Fenced code blocks — non-greedy, any language tag including empty
const FENCE_RE = /```[\w]*\n[\s\S]*?```/g;

// XML content blocks injected by the pipeline
const FILE_BLOCK_RE = /<file\b[^>]*>[\s\S]*?<\/file>/gi;
const LOADED_FILES_RE = /<loaded_files>[\s\S]*?<\/loaded_files>/gi;
const ATTACHED_FILES_RE = /<attached_files>[\s\S]*?<\/attached_files>/gi;
const THINKING_RE = /<think>[\s\S]*?<\/think>/gi;
const THINKING_BRACKET_RE = /\[THINK\][\s\S]*?\[\/THINK\]/gi;

// Tool output blocks that sometimes leak into output
const TOOL_RESULT_RE = /<tool_result[\s\S]*?<\/tool_result>/gi;
const ARCHIVE_CTX_RE = /<archive_context>[\s\S]*?<\/archive_context>/gi;
const CONV_CTX_RE = /<conversation_history_context>[\s\S]*?<\/conversation_history_context>/gi;
const MEMORY_CTX_RE = /<(?:prior_memory|memory_context|knowledge_context)>[\s\S]*?<\/(?:prior_memory|memory_context|knowledge_context)>/gi;

// Unified diff lines — lines that are pure patch notation
// Only strip when 3+ consecutive diff lines appear (avoids stripping
// legitimate prose that happens to start with + or -)
const DIFF_BLOCK_RE = /^(?:---|\+\+\+|@@)[^\n]*\n(?:[+-][^\n]*\n){2,}/gm;

// Consecutive blank lines — collapse to single blank
const MULTI_BLANK_RE = /\n{3,}/g;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Distil an AI response down to its conversational prose content.
 * Safe to call on already-distilled content — idempotent.
 *
 * @param rawContent  Full AI response as stored in messages.content
 * @returns           Clean prose suitable for history injection and VSS embedding
 */
export function distillAssistantContent(rawContent: string): string {
  let text = rawContent;

  // Strip thinking first so its content doesn't contaminate later passes
  text = text.replace(THINKING_RE, '');
  text = text.replace(THINKING_BRACKET_RE, '');

  // Strip large content blocks
  text = text.replace(FENCE_RE, '');
  text = text.replace(FILE_BLOCK_RE, '');
  text = text.replace(LOADED_FILES_RE, '');
  text = text.replace(ATTACHED_FILES_RE, '');
  text = text.replace(TOOL_RESULT_RE, '');
  text = text.replace(ARCHIVE_CTX_RE, '');
  text = text.replace(CONV_CTX_RE, '');
  text = text.replace(MEMORY_CTX_RE, '');

  // Strip diff blocks
  text = text.replace(DIFF_BLOCK_RE, '');

  // Collapse whitespace
  text = text.replace(MULTI_BLANK_RE, '\n\n').trim();

  return text;
}

/**
 * Build the combined embedding input from a completed turn.
 * Concatenates user text and distilled assistant text so the vector
 * captures both sides of the exchange for recall.
 *
 * Capped at 950 chars to stay within SYBIL's safe token window.
 */
export function buildEmbedInput(userText: string, distilledAssistant: string): string {
  const combined = `User: ${userText}\nAssistant: ${distilledAssistant}`;
  return combined.slice(0, 950);
}
