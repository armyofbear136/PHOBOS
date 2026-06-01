import { coordinatorCall } from './clients.js';
import { browseSearch, browseUrl } from '../phobos/CamofoxClient.js';

// ── Budget constants — permanent wire contracts, append-only ─────────────────
const MAX_QUERIES      = 3;    // SERP fetches in parallel
const MAX_PAGES        = 4;    // page fetches in parallel
const CHARS_PER_PAGE   = 8_000;
const PIPELINE_TIMEOUT = 90_000; // ms — acceptable for live-data queries

// ─────────────────────────────────────────────────────────────────────────────

interface SelectedUrl {
  url:    string;
  reason: string;
}

interface FetchedPage {
  url:      string;
  title:    string;
  content:  string;  // trimmed to CHARS_PER_PAGE
}

// ── Stage 1 — Query formulation ───────────────────────────────────────────────
// One coordinatorCall, no_think, returns 1–3 targeted search query strings.
// Uses the last 2 history turns for context without inflating the prompt.

async function formulateQueries(
  question: string,
  history:  Array<{ role: string; content: string }>,
): Promise<string[]> {
  const recentTurns = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-4)  // last 2 exchanges
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const contextBlock = recentTurns
    ? `Recent conversation:\n${recentTurns}\n\n`
    : '';

  const raw = await coordinatorCall({
    systemPrompt:
      'You are a web search query formulator. Given a question, produce 1–3 targeted search ' +
      'queries that together retrieve the best information to answer it. ' +
      'Respond ONLY with a JSON array of strings, nothing else. ' +
      'No markdown, no explanation. Example: ["query one","query two"]',
    messages: [{
      role: 'user',
      content:
        `${contextBlock}Question: ${question}\n\n` +
        'Produce 1–3 search queries. Include the current year when recency matters. ' +
        'Prefer specific queries over vague ones.',
    }],
    maxTokens:   150,
    temperature: 0.1,
    mode:        'no_think',
    stage:       'other',
  });

  try {
    // Strip markdown fences if the model added them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed as unknown[])
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .slice(0, MAX_QUERIES);
    }
  } catch { /* fall through */ }

  // Extraction fallback: pull quoted strings from the raw output
  const quoted = [...raw.matchAll(/"([^"]{3,150})"/g)].map(m => m[1]);
  if (quoted.length > 0) return quoted.slice(0, MAX_QUERIES);

  // Last resort: use the question verbatim
  return [question.slice(0, 120)];
}

// ── Stage 3 — URL selection ───────────────────────────────────────────────────
// One coordinatorCall with all SERP snapshots. Returns 2–4 URLs to fetch.
// This is the quality gate — filters paywalled, login-walled, irrelevant hits.

async function selectUrls(
  question:      string,
  serpSnapshots: Array<{ query: string; snapshot: string }>,
): Promise<SelectedUrl[]> {
  const serpBlock = serpSnapshots
    .map(s => `Search: "${s.query}"\n${s.snapshot.slice(0, 6_000)}`)
    .join('\n\n---\n\n');

  const raw = await coordinatorCall({
    systemPrompt:
      'You are a web research URL selector. Given search results and a question, ' +
      'select the 2–4 most relevant, accessible URLs to fetch. ' +
      'Respond ONLY with a JSON array: [{"url":"...","reason":"..."}]. ' +
      'No markdown, no explanation. Exclude: paywalled sites, login walls, ' +
      'social media profiles, irrelevant or off-topic hits.',
    messages: [{
      role: 'user',
      content:
        `Question: ${question}\n\nSearch results:\n${serpBlock}\n\n` +
        'Select 2–4 URLs to fetch. Respond with JSON only.',
    }],
    maxTokens:   350,
    temperature: 0.1,
    mode:        'no_think',
    stage:       'other',
  });

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Extract first JSON array from response
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]) as unknown[];
      const valid = parsed
        .filter((item): item is SelectedUrl =>
          typeof item === 'object' && item !== null &&
          typeof (item as Record<string, unknown>).url === 'string' &&
          (item as Record<string, unknown>).url !== ''
        )
        .slice(0, MAX_PAGES);
      if (valid.length > 0) return valid;
    }
  } catch { /* fall through to URL extraction */ }

  // Fallback: extract URLs directly from the raw output
  const urlMatches = [...raw.matchAll(/https?:\/\/[^\s"',>)]{10,}/g)];
  return urlMatches
    .slice(0, MAX_PAGES)
    .map(m => ({ url: m[0], reason: 'extracted' }));
}

// ── Stage 4 — Page fetch ──────────────────────────────────────────────────────
// Fetches selected URLs in parallel. Skips error results and short snapshots
// (login walls / blocks return near-empty content).

async function fetchPages(selectedUrls: SelectedUrl[]): Promise<FetchedPage[]> {
  const results = await Promise.allSettled(
    selectedUrls.map(({ url }) => browseUrl(url))
  );

  const pages: FetchedPage[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') continue;
    const { url, title, snapshot, error } = r.value;
    if (error) continue;
    // Short snapshot = login wall, bot block, or empty page — skip
    if (snapshot.length < 200) continue;
    pages.push({
      url:     url || selectedUrls[i].url,
      title:   title || selectedUrls[i].url,
      content: snapshot.slice(0, CHARS_PER_PAGE),
    });
  }
  return pages;
}

// ── Stage 5 — Context assembly ────────────────────────────────────────────────
// Formats fetched pages into a single grounding block for injection into
// the SAYON system prompt. Empty string returned when nothing was retrieved.

function assembleContext(
  queries: string[],
  pages:   FetchedPage[],
): string {
  if (pages.length === 0) return '';

  const queryLine = queries.map(q => `"${q}"`).join(', ');
  const sourceSections = pages
    .map((p, i) =>
      `Source ${i + 1}: ${p.title} (${p.url})\n${p.content}`
    )
    .join('\n\n');

  return (
    `[WEB SEARCH CONTEXT — retrieved live by PHOBOS]\n` +
    `Queries: ${queryLine}\n\n` +
    `${sourceSections}\n\n` +
    `[END WEB SEARCH CONTEXT]`
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Runs the full SAYON web search pipeline for a direct-answer query.
 *
 * Pipeline stages:
 *   1. Query formulation  — coordinatorCall, no_think, 1–3 queries
 *   2. SERP fetch         — browseSearch × N in parallel
 *   3. URL selection      — coordinatorCall, no_think, 2–4 URLs
 *   4. Page fetch         — browseUrl × N in parallel
 *   5. Context assembly   — formatted grounding block
 *
 * Returns a formatted context string ready to inject into SAYON's system prompt.
 * Returns empty string on total failure — caller always proceeds to answer from weights.
 *
 * Self-contained: only depends on CamofoxClient and coordinatorCall.
 * Future delegation: SEREN can call this directly when parallel execution lands.
 */
export async function runWebSearch(
  question:   string,
  history:    Array<{ role: string; content: string }>,
  sendStatus: (msg: string) => void,
): Promise<string> {
  const deadline = Date.now() + PIPELINE_TIMEOUT;

  const checkTime = (): boolean => Date.now() < deadline;

  try {
    // Stage 1 — Query formulation
    sendStatus('Formulating search queries…');
    const queries = await formulateQueries(question, history);
    console.log(`[WebSearchPipeline] queries=${JSON.stringify(queries)}`);
    if (!checkTime()) return '';

    // Stage 2 — SERP fetch (parallel)
    sendStatus('Searching the web…');
    const serpResults = await Promise.allSettled(
      queries.map(q => browseSearch('@google_search', q))
    );

    const serpSnapshots: Array<{ query: string; snapshot: string }> = [];
    for (let i = 0; i < serpResults.length; i++) {
      const r = serpResults[i];
      if (r.status === 'fulfilled' && !r.value.error && r.value.snapshot.length > 50) {
        serpSnapshots.push({ query: queries[i], snapshot: r.value.snapshot });
      }
    }

    if (serpSnapshots.length === 0) {
      console.log('[WebSearchPipeline] All SERP fetches failed — answering from weights');
      return '';
    }
    if (!checkTime()) return '';

    // Stage 3 — URL selection
    sendStatus('Evaluating sources…');
    const selectedUrls = await selectUrls(question, serpSnapshots);
    console.log(`[WebSearchPipeline] selected=${JSON.stringify(selectedUrls.map(u => u.url))}`);
    if (selectedUrls.length === 0) {
      console.log('[WebSearchPipeline] URL selection returned 0 URLs — answering from weights');
      return '';
    }
    if (!checkTime()) return '';

    // Stage 4 — Page fetch (parallel)
    sendStatus('Reading pages…');
    const pages = await fetchPages(selectedUrls);
    console.log(`[WebSearchPipeline] fetched ${pages.length}/${selectedUrls.length} pages`);
    if (pages.length === 0) {
      console.log('[WebSearchPipeline] All page fetches failed/blocked — answering from weights');
      return '';
    }

    // Stage 5 — Context assembly
    const context = assembleContext(queries, pages);
    console.log(`[WebSearchPipeline] context assembled: ${context.length} chars, ${pages.length} sources`);
    return context;

  } catch (err) {
    console.error('[WebSearchPipeline] Pipeline error:', (err as Error).message);
    return '';
  }
}
