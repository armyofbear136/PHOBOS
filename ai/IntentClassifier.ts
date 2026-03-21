import { coordinatorCall } from './clients.js';

export type IntentType =
  | 'QUESTION'
  | 'DOCUMENT_EDIT'
  | 'CODE_REQUEST'
  | 'PLAN_REQUEST'
  | 'IMAGE_REQUEST'
  | 'VIDEO_REQUEST'
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

const CLASSIFIER_SYSTEM = `You are an accurate intent classifier for PHOBOS, a dual-AI system. SAYON (you) is the coordinator. SEREN is the execution engine.

Classify the user message into exactly one of:
QUESTION - conversation, explanation, analysis, help (no file changes needed)
DOCUMENT_EDIT - update PHOBOS DIRECTIVES, project.md, or chat.md
CODE_REQUEST - write, modify, refactor, or debug code files or workspace files
PLAN_REQUEST - plan or discuss architecture before any file changes
IMAGE_REQUEST - generate, draw, or create an image or picture
VIDEO_REQUEST - generate, create, or make a video, animation, or movie clip
NEEDS_CLARIFICATION - genuinely too ambiguous to classify

Routing:
ANSWER_DIRECTLY - SAYON handles alone (questions, conversation, image/video requests)
NEEDS_SEREN - requires the engine (code, files, complex multi-step tasks)
NEEDS_CLARIFICATION - needs more info

Rules: write/create/build/modify files -> CODE_REQUEST + NEEDS_SEREN. Image/draw/picture -> IMAGE_REQUEST + ANSWER_DIRECTLY. Video/animation/clip/movie -> VIDEO_REQUEST + ANSWER_DIRECTLY. Mentions SEREN by name -> NEEDS_SEREN. Simple Q&A -> ANSWER_DIRECTLY.

Respond ONLY with JSON on one line: {"type":"TYPE","confidence":0.0,"routing":"ROUTING"}`;

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
        const block = top.map((f) => `  ${f.filename} - ${f.summary}`).join('\n');
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
        maxTokens: 512,
        temperature: 0.1,
        mode: 'no_think',
      });

      const latency = Date.now() - start;
      // Try JSON extraction — model should return {"type":"...","confidence":...,"routing":"..."}
      // Use non-greedy match first to avoid grabbing the entire thinking trace.
      // Try multiple patterns in order of specificity.
      const tryParseJSON = (text: string): { type: IntentType; confidence: number; routing?: string } | null => {
        // Strip markdown fences — small models like Gemma 1B wrap output in ```json ... ```
        const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        const sources = stripped !== text ? [stripped, text] : [text];

        for (const s of sources) {
          // Pattern 1: compact single-line JSON object with "type" key
          const compact = s.match(/\{"type"\s*:\s*"[^"]+[^}]*\}/);
          if (compact) { try { return JSON.parse(compact[0]); } catch { /* try next */ } }
          // Pattern 2: any JSON object (greedy, may grab thinking trace)
          const greedy = s.match(/\{[^]*\}/);
          if (greedy) { try { return JSON.parse(greedy[0]); } catch { /* fall through */ } }
        }

        // Pattern 3: Gemma 1B corruption repair
        // Model scrambles JSON like {"{"type":"CODECODE" — extract type value directly
        const typeMatch = text.match(/"type"[^:]*:\s*"?([A-Z_]{4,25})"?/);
        if (typeMatch) {
          const routingMatch = text.match(/"routing"[^:]*:\s*"?(NEEDS_SEREN|ANSWER_DIRECTLY|NEEDS_CLARIFICATION)"?/);
          const confMatch    = text.match(/"confidence"[^:]*:\s*"?([0-9.]+)"?/);
          // Deduplicate corrupted type tokens like "CODECODE" -> "CODE_REQUEST"
          const raw = typeMatch[1];
          const KNOWN: IntentType[] = ['CODE_REQUEST','IMAGE_REQUEST','VIDEO_REQUEST','DOCUMENT_EDIT','PLAN_REQUEST','NEEDS_CLARIFICATION','QUESTION'];
          const found = KNOWN.find(t => raw.startsWith(t.replace('_REQUEST','').replace('_EDIT','').replace('_','')) || t.startsWith(raw.slice(0,5)));
          if (found) {
            return {
              type: found,
              confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
              routing: routingMatch?.[1] as ClassifiedIntent['routing'] | undefined,
            };
          }
        }

        return null;
      };

      let parsed: { type: IntentType; confidence: number; routing?: string } | null = tryParseJSON(raw);
      if (!parsed) {
        // JSON not found or malformed — keyword extraction from raw text
        const upper = raw.toUpperCase();
        const TYPES: IntentType[] = ['CODE_REQUEST', 'VIDEO_REQUEST', 'IMAGE_REQUEST', 'DOCUMENT_EDIT', 'PLAN_REQUEST', 'NEEDS_CLARIFICATION', 'QUESTION'];
        const foundType    = TYPES.find(t => upper.includes(t));
        const foundRouting = upper.includes('NEEDS_SEREN') ? 'NEEDS_SEREN'
          : upper.includes('ANSWER_DIRECTLY') ? 'ANSWER_DIRECTLY'
          : upper.includes('NEEDS_CLARIFICATION') ? 'NEEDS_CLARIFICATION'
          : null;
        if (foundType) {
          parsed = { type: foundType, confidence: 0.5, routing: foundRouting ?? undefined };
        }
      }

      if (!parsed?.type) throw new Error(`No valid classification in: ${raw.slice(0, 80)}`);

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
      case 'VIDEO_REQUEST':        return 'ANSWER_DIRECTLY';
      case 'QUESTION': return 'ANSWER_DIRECTLY';
      case 'DOCUMENT_EDIT': return 'ANSWER_DIRECTLY';
      case 'CODE_REQUEST': return 'NEEDS_SEREN';
      case 'PLAN_REQUEST': return 'NEEDS_SEREN';
      case 'IMAGE_REQUEST': return 'ANSWER_DIRECTLY';
      default: return 'ANSWER_DIRECTLY';
    }
  }
}
