import { coordinatorCall } from './clients.js';

export type IntentType =
  | 'QUESTION'
  | 'DOCUMENT_EDIT'
  | 'CODE_REQUEST'
  | 'PLAN_REQUEST'
  | 'IMAGE_REQUEST'
  | 'NEEDS_CLARIFICATION';

export interface ClassifiedIntent {
  type: IntentType;
  confidence: number;
  routing: 'ANSWER_DIRECTLY' | 'NEEDS_SEREN' | 'NEEDS_CLARIFICATION';
  reasoning?: string;
}

export interface ClassificationContext {
  rewrittenMessage: string;
  fileSummaries?: import('./ContextIngester.js').FileSummary[];
  chatSummary?: string;
  repoMap?: string;
}

const CLASSIFIER_SYSTEM = `You are a fast intent classifier for PHOBOS, a dual-AI system. SAYON (you) is the coordinator. SEREN is the execution engine. These are the names of the two AI models in this system — not functions or code constructs.

Classify the user's message into exactly one of these categories:

QUESTION - Any question, explanation, conversation, creative request, analysis, how-to, debugging help, or general assistance that does not require writing files
DOCUMENT_EDIT - Requests to update PHOBOS DIRECTIVES, project.md, or chat.md documents
CODE_REQUEST - Requests to write, modify, refactor, or debug actual code files or create/edit any files in the workspace
PLAN_REQUEST - Requests to create a plan, outline an approach, or discuss architecture before any file changes
IMAGE_REQUEST - Requests to generate, create, draw, or make an image or picture using AI. Phrases like "generate an image", "draw me", "create a picture of", "make an image of", "show me a picture of" all indicate this type
NEEDS_CLARIFICATION - The request is too vague or ambiguous to act on. Use when: the request uses pronouns like "it" or "that" without clear antecedents, asks for a change but does not specify which file or what kind of change, could be interpreted in multiple incompatible ways, or asks to "fix" something without saying what is broken. It is always better to ask one question than to guess wrong.

Also determine routing — how the request should be handled:
ANSWER_DIRECTLY - SAYON can handle this alone (simple questions, conversation, short explanations)
NEEDS_SEREN - Requires the engine for code generation, file creation, complex analysis, or multi-step tasks
NEEDS_CLARIFICATION - Cannot proceed without more information from the user

ROUTING OVERRIDE RULES — these take precedence over the defaults above:
1. If the user mentions "SEREN" by name → always route NEEDS_SEREN, regardless of phrasing
2. If the request involves generating content longer than a short paragraph (documents, guides, articles, code files, scripts) → route NEEDS_SEREN even if phrased as a question
3. If the request asks to "write", "create", "build", "generate", or "make" anything substantial → route NEEDS_SEREN
4. If type is IMAGE_REQUEST → always route ANSWER_DIRECTLY (SAYON handles workflow creation)

Default toward QUESTION for anything purely conversational, analytical, or informational.
Only use CODE_REQUEST when the user explicitly wants files written or changed.
Always use IMAGE_REQUEST when the user wants any kind of image generated — never classify these as QUESTION or CODE_REQUEST.
Use NEEDS_CLARIFICATION when the request is genuinely ambiguous — do not guess.

Respond with ONLY a JSON object on a single line. No preamble, no explanation.
Format: {"type":"INTENT_TYPE","confidence":0.0,"routing":"ROUTING"}`;

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
        maxTokens: 96,
        temperature: 0.1,
        mode: 'no_think',
      });

      const latency = Date.now() - start;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const cleaned = jsonMatch ? jsonMatch[0] : '';
      const parsed = JSON.parse(cleaned) as { type: IntentType; confidence: number; routing?: string };

      // Derive routing if the model didn't return it (backward compat)
      const routing = (['ANSWER_DIRECTLY', 'NEEDS_SEREN', 'NEEDS_CLARIFICATION'].includes(parsed.routing ?? '')
        ? parsed.routing as ClassifiedIntent['routing']
        : this.deriveRouting(parsed.type));

      console.log(
        `[IntentClassifier] ${parsed.type} routing=${routing} (${latency}ms, confidence=${parsed.confidence})`
      );
      return { type: parsed.type, confidence: parsed.confidence, routing };
    } catch (err) {
      console.error('[IntentClassifier] Coordinator unreachable, using heuristic fallback:', err);
      const lower = userMessage.toLowerCase();
      if (lower.includes('plan') || lower.includes('approach') || lower.includes('architecture')) {
        return { type: 'PLAN_REQUEST', confidence: 0.6, routing: 'NEEDS_SEREN' };
      }
      if (/write|create|modify|refactor|implement|add.*file|edit.*file/.test(lower)) {
        return { type: 'CODE_REQUEST', confidence: 0.6, routing: 'NEEDS_SEREN' };
      }
      if (/generate.*image|draw|create.*image|make.*image|create.*picture|generate.*picture|show.*picture/.test(lower)) {
        return { type: 'IMAGE_REQUEST', confidence: 0.6, routing: 'ANSWER_DIRECTLY' };
      }
      return { type: 'QUESTION', confidence: 0.6, routing: 'ANSWER_DIRECTLY' };
    }
  }

  /** Fallback routing when the model returns type but not routing */
  private deriveRouting(type: IntentType): ClassifiedIntent['routing'] {
    switch (type) {
      case 'NEEDS_CLARIFICATION': return 'NEEDS_CLARIFICATION';
      case 'QUESTION': return 'ANSWER_DIRECTLY';
      case 'DOCUMENT_EDIT': return 'ANSWER_DIRECTLY';
      case 'CODE_REQUEST': return 'NEEDS_SEREN';
      case 'PLAN_REQUEST': return 'NEEDS_SEREN';
      case 'IMAGE_REQUEST': return 'ANSWER_DIRECTLY';
      default: return 'ANSWER_DIRECTLY';
    }
  }
}
