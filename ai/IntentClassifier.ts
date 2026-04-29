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

const CLASSIFIER_SYSTEM = `You are an accurate intent classifier for PHOBOS, a dual-AI system. SAYON (you) is the coordinator. SEREN is the powerful execution engine.

SEREN capabilities (always available — never assume a capability is missing):
- Write, create, modify, refactor, delete, or debug any file type
- Run code, execute scripts, run tests, build projects
- Scan files for security vulnerabilities using the AST audit engine
- Browse the internet and fetch live web content
- Search the web for current information, news, prices, weather, anything
- Generate images using the built-in image synthesis engine
- Analyse, summarise, or explain any file or codebase
- Perform multi-step plans across any number of tasks

Classify the user message into exactly one of:
QUESTION - conversation, explanation, analysis, help, web search, or any question (no file changes needed)
DOCUMENT_EDIT - update PHOBOS DIRECTIVES, project.md, or chat.md
CODE_REQUEST - write, modify, refactor, debug, scan, audit, run, execute, or test code or workspace files
PLAN_REQUEST - plan or discuss architecture before any file changes
IMAGE_REQUEST - generate, draw, or create an image or picture
VIDEO_REQUEST - generate, create, or make a video, animation, or movie clip
NEEDS_CLARIFICATION - genuinely too ambiguous to classify into any category above

Routing:
ANSWER_DIRECTLY - SAYON handles alone (questions, conversation, web search, image/video requests)
NEEDS_SEREN - requires the engine (code, files, scans, execution, multi-step tasks)
NEEDS_CLARIFICATION - needs more info before any classification is possible

Routing rules (in priority order):
- write/create/build/modify/delete/fix/refactor files -> CODE_REQUEST + NEEDS_SEREN
- scan/audit/analyse/run/execute/test + a file or path -> CODE_REQUEST + NEEDS_SEREN
- search/find/look up/browse/check + anything -> QUESTION + ANSWER_DIRECTLY
- weather/news/price/stock/sports/current events -> QUESTION + ANSWER_DIRECTLY
- image/draw/picture/render/illustration -> IMAGE_REQUEST + ANSWER_DIRECTLY
- video/animation/clip/movie -> VIDEO_REQUEST + ANSWER_DIRECTLY
- mentions SEREN by name -> NEEDS_SEREN
- simple Q&A, explain, summarise (no file target) -> QUESTION + ANSWER_DIRECTLY
- NEEDS_CLARIFICATION only when the message could map to multiple incompatible operations with no context clue

Examples:
"what is a closure" -> QUESTION + ANSWER_DIRECTLY
"search for the latest React release" -> QUESTION + ANSWER_DIRECTLY
"what's the weather in Tokyo" -> QUESTION + ANSWER_DIRECTLY
"scan vulnerable.ts for security issues" -> CODE_REQUEST + NEEDS_SEREN
"audit my code" -> CODE_REQUEST + NEEDS_SEREN
"run the tests" -> CODE_REQUEST + NEEDS_SEREN
"create a login component" -> CODE_REQUEST + NEEDS_SEREN
"draw a sunset" -> IMAGE_REQUEST + ANSWER_DIRECTLY

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

      // Routing resolution:
      // Some intent types have invariant routing that must not be overridden by the
      // model — DOCUMENT_EDIT, IMAGE_REQUEST, and VIDEO_REQUEST always resolve to
      // ANSWER_DIRECTLY regardless of what the model returned. This prevents the
      // classifier from misrouting these to NEEDS_SEREN when the model hallucinates.
      const FORCED_ROUTING: Partial<Record<IntentType, ClassifiedIntent['routing']>> = {
        DOCUMENT_EDIT: 'ANSWER_DIRECTLY',
        IMAGE_REQUEST:  'ANSWER_DIRECTLY',
        VIDEO_REQUEST:  'ANSWER_DIRECTLY',
      };
      const routing: ClassifiedIntent['routing'] =
        FORCED_ROUTING[parsed.type] ??
        (['ANSWER_DIRECTLY', 'NEEDS_SEREN', 'NEEDS_CLARIFICATION'].includes(parsed.routing ?? '')
          ? (parsed.routing as ClassifiedIntent['routing'])
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
      if (/write|create|modify|refactor|implement|add.*file|edit.*file|fix.*file|delete.*file/.test(lower)) {
        return { type: 'CODE_REQUEST', confidence: 0.6, routing: 'NEEDS_SEREN' };
      }
      if (/scan|audit|run.*test|execute|run.*script|build|compile/.test(lower)) {
        return { type: 'CODE_REQUEST', confidence: 0.6, routing: 'NEEDS_SEREN' };
      }
      if (/generate.*image|draw|create.*image|make.*image|create.*picture|generate.*picture|show.*picture/.test(lower)) {
        return { type: 'IMAGE_REQUEST', confidence: 0.6, routing: 'ANSWER_DIRECTLY' };
      }
      if (/search|look up|find.*online|browse|weather|news|price|stock|current/.test(lower)) {
        return { type: 'QUESTION', confidence: 0.6, routing: 'ANSWER_DIRECTLY' };
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
