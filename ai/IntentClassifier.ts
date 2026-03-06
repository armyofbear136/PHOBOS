import { coordinatorCall } from './clients.js';

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

export interface ClassificationContext {
  rewrittenMessage: string;
  fileSummaries?: import('./ContextIngester.js').FileSummary[];
  chatSummary?: string;
  repoMap?: string;
}

const CLASSIFIER_SYSTEM = `You are a fast intent classifier. Your only job is to classify the user's message into exactly one of these categories:

QUESTION - Any question, explanation, conversation, creative request, analysis, how-to, debugging help, or general assistance that does not require writing files
DOCUMENT_EDIT - Requests to update PHOBOS DIRECTIVES, project.md, or chat.md documents
CODE_REQUEST - Requests to write, modify, refactor, or debug actual code files or create/edit any files in the workspace
PLAN_REQUEST - Requests to create a plan, outline an approach, or discuss architecture before any file changes

Default toward QUESTION for anything conversational, creative, analytical, or informational.
Only use CODE_REQUEST when the user explicitly wants files written or changed.

Respond with ONLY a JSON object on a single line. No preamble, no explanation.
Format: {"type":"INTENT_TYPE","confidence":0.0}`;

export class IntentClassifier {
  async classify(
    userMessage: string,
    context?: ClassificationContext
  ): Promise<ClassifiedIntent> {
    const start = Date.now();

    try {
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
        const block = top.map((f) => `  ${f.filename} — ${f.summary}`).join('\n');
        contextParts.push(`<file_context>\n${block}\n</file_context>`);
      }

      const userContent = contextParts.length > 0
        ? `${contextParts.join('\n\n')}\n\nMessage: ${effectiveMessage}`
        : effectiveMessage;

      // no_think: fast routing, no chain-of-thought needed.
      // coordinatorCall applies the right strategy per model (Llama gets system prompt,
      // Qwen3 gets /no_think prefix, cloud models get nothing).
      const raw = await coordinatorCall({
        systemPrompt: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: 64,
        temperature: 0.1,
        mode: 'no_think',
      });

      const latency = Date.now() - start;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const cleaned = jsonMatch ? jsonMatch[0] : '';
      const parsed = JSON.parse(cleaned) as { type: IntentType; confidence: number };
      console.log(
        `[IntentClassifier] ${parsed.type} (${latency}ms, confidence=${parsed.confidence})`
      );
      return { type: parsed.type, confidence: parsed.confidence };
    } catch (err) {
      console.error('[IntentClassifier] Coordinator unreachable, using heuristic fallback:', err);
      const lower = userMessage.toLowerCase();
      if (lower.includes('plan') || lower.includes('approach') || lower.includes('architecture')) {
        return { type: 'PLAN_REQUEST', confidence: 0.6 };
      }
      if (/write|create|modify|refactor|implement|add.*file|edit.*file/.test(lower)) {
        return { type: 'CODE_REQUEST', confidence: 0.6 };
      }
      return { type: 'QUESTION', confidence: 0.6 };
    }
  }
}
