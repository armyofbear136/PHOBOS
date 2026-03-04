import { coordinatorClient, COORDINATOR_MODEL } from './clients.js';
import type { FileSummary } from './ContextIngester.js';

export type IntentType =
  | 'QUESTION'
  | 'DOCUMENT_EDIT'
  | 'CODE_REQUEST'
  | 'PLAN_REQUEST';

export interface ClassifiedIntent {
  type: IntentType;
  confidence: number;
  reasoning?: string;
}

/**
 * Context passed to classify() after Stage 1 ingestion has run.
 * All fields except rewrittenMessage are optional so the classifier
 * degrades gracefully when called before ingestion (e.g. DOCUMENT_EDIT
 * fast-path that skips Stage 1).
 */
export interface ClassificationContext {
  /** Stage 1 rewritten message — resolves ambiguous references */
  rewrittenMessage: string;
  /** Top 3–5 file summaries from ContextIngester */
  fileSummaries?: FileSummary[];
  /** Rolling coordinator summary from ChatSummaryStore */
  chatSummary?: string;
  /** Workspace file tree from RepoMapper */
  repoMap?: string;
}

const CLASSIFIER_SYSTEM = `You are a fast intent classifier for a coding assistant. Your only job is to classify the user's message into exactly one of these categories:

QUESTION - General questions, explanations, how-to queries, debugging help without file changes
DOCUMENT_EDIT - Requests to update claude.md, project.md, or chat.md documents
CODE_REQUEST - Requests to write, modify, refactor, or debug actual code files
PLAN_REQUEST - Requests to create a plan, outline approach, or discuss architecture before coding

You are given the user's message (already rewritten with resolved references), optional file summaries, and a rolling conversation summary. Use all context to pick the most accurate category.

Respond with ONLY a JSON object on a single line. No preamble, no explanation.
Format: {"type":"INTENT_TYPE","confidence":0.0}`;

export class IntentClassifier {
  async classify(
    userMessage: string,
    context?: ClassificationContext
  ): Promise<ClassifiedIntent> {
    const start = Date.now();

    try {
      // Build context block — only include fields that are present and non-empty
      const contextParts: string[] = [];

      const effectiveMessage = context?.rewrittenMessage ?? userMessage;

      if (context?.chatSummary) {
        contextParts.push(`<conversation_summary>\n${context.chatSummary}\n</conversation_summary>`);
      }

      if (context?.repoMap?.trim()) {
        contextParts.push(`<workspace_files>\n${context.repoMap.trim()}\n</workspace_files>`);
      }

      if (context?.fileSummaries && context.fileSummaries.length > 0) {
        const top = context.fileSummaries.slice(0, 5);
        const block = top
          .map((f) => `  ${f.filename} — ${f.summary}`)
          .join('\n');
        contextParts.push(`<file_context>\n${block}\n</file_context>`);
      }

      const userContent =
        `/no_think ` +
        (contextParts.length > 0
          ? `${contextParts.join('\n\n')}\n\nMessage: ${effectiveMessage}`
          : effectiveMessage);

      // /no_think disables Qwen3's chain-of-thought for fast routing
      const response = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          { role: 'user', content: userContent },
        ],
        max_tokens: 64,
        temperature: 0.1,
        stream: false,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '';
      const latency = Date.now() - start;

      try {
        // Strip any thinking tokens that leaked through
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const cleaned = jsonMatch ? jsonMatch[0] : '';
        const parsed = JSON.parse(cleaned) as { type: IntentType; confidence: number };
        console.log(
          `[IntentClassifier] ${parsed.type} (${latency}ms, confidence=${parsed.confidence}, context=${context ? 'yes' : 'no'})`
        );
        return { type: parsed.type, confidence: parsed.confidence };
      } catch {
        console.warn('[IntentClassifier] Parse failed, defaulting to CODE_REQUEST:', raw);
        return { type: 'CODE_REQUEST', confidence: 0.5 };
      }
    } catch (err) {
      console.error('[IntentClassifier] Coordinator unreachable, defaulting:', err);
      // Heuristic fallback if coordinator is down
      const lower = userMessage.toLowerCase();
      if (lower.includes('plan') || lower.includes('approach') || lower.includes('architecture')) {
        return { type: 'PLAN_REQUEST', confidence: 0.6 };
      }
      if (lower.includes('what') || lower.includes('how') || lower.includes('why') || lower.includes('explain')) {
        return { type: 'QUESTION', confidence: 0.6 };
      }
      return { type: 'CODE_REQUEST', confidence: 0.5 };
    }
  }
}
