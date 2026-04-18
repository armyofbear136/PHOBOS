// ── ArchiveIntentClassifier ────────────────────────────────────────────────────
//
// Deterministic routing — decides whether a query warrants an Archive lookup
// and which domains to search. Zero LLM calls. Sub-millisecond.
//
// Rules, in priority order:
//   1. Explicit domain pin (user preference, always included when set)
//   2. Active project context → include 'projects' domain
//   3. Keyword matching against domain topic signals
//   4. Copilot / simple conversational turns → skip Archive entirely

import type { ArchiveDomain } from '../db/ArchiveStore.js';
import { ArchiveStore } from '../db/ArchiveStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArchiveRoutingDecision {
  useArchive: boolean;
  domains:    ArchiveDomain[];
  k:          number;
  queryText:  string;
}

export interface ArchiveRoutingContext {
  /** Raw user message */
  userMessage:      string;
  /** Whether a project is currently active in this thread */
  hasActiveProject: boolean;
  /** Domains the user has pinned — always included */
  pinnedDomains:    ArchiveDomain[];
  /** Whether this is a copilot turn (Archive never injected into copilot) */
  isCopilot:        boolean;
}

// ── Domain topic signals ──────────────────────────────────────────────────────
//
// Each domain maps to a set of keyword patterns. A match → domain is included.
// Patterns are deliberately broad: false positives cost one extra HNSW search
// (~2ms); false negatives cost a missed retrieval.

const DOMAIN_SIGNALS: Array<{ domain: ArchiveDomain; patterns: RegExp[] }> = [
  {
    domain: 'projects',
    patterns: [
      /\bproject\b/i, /\bspec\b/i, /\bprd\b/i, /\brequirement/i,
      /\barchitecture\b/i, /\bdesign doc/i, /\bticket\b/i,
    ],
  },
  {
    domain: 'reference',
    patterns: [
      /\bdocumentation\b/i, /\bdocs?\b/i, /\bmanual\b/i, /\bapi\b/i,
      /\blibrary\b/i, /\bpackage\b/i, /\brfc\b/i, /\bspec(ification)?\b/i,
      /how (does|do|to)\b/i,
    ],
  },
  {
    domain: 'research',
    patterns: [
      /\bpaper\b/i, /\bstudy\b/i, /\bresearch\b/i, /\bwhitepaper\b/i,
      /\bacademic\b/i, /\bpublication\b/i, /\bjournal\b/i,
    ],
  },
  {
    domain: 'science',
    patterns: [
      /\bphysics\b/i, /\bchemistry\b/i, /\bbiology\b/i, /\bmathematic/i,
      /\bformula\b/i, /\bequation\b/i, /\btheorem\b/i, /\bstem\b/i,
    ],
  },
  {
    domain: 'literature',
    patterns: [
      /\bnovel\b/i, /\bfiction\b/i, /\bessay\b/i, /\bpoem\b/i,
      /\bauthor\b/i, /\bcharacter\b/i, /\bplot\b/i, /\bchapter\b/i,
    ],
  },
  {
    domain: 'history',
    patterns: [
      /\bhistor/i, /\bwar\b/i, /\bempire\b/i, /\bcentury\b/i,
      /\bcivilization\b/i, /\btimeline\b/i, /\bbiograph/i,
    ],
  },
  {
    domain: 'legal',
    patterns: [
      /\bcontract\b/i, /\blegal\b/i, /\blaw\b/i, /\bregulat/i,
      /\bcompliance\b/i, /\bterms\b/i, /\bclause\b/i, /\bprivacy\b/i,
    ],
  },
  {
    domain: 'finance',
    patterns: [
      /\bfinance\b/i, /\bfinancial\b/i, /\bbudget\b/i, /\brevenue\b/i,
      /\bprofit\b/i, /\bbalance sheet/i, /\binvestment\b/i, /\bstock\b/i,
    ],
  },
  {
    domain: 'personal',
    patterns: [
      /\bjournal\b/i, /\bnote\b/i, /\bmy (notes|writing|thoughts)\b/i,
      /\bi wrote\b/i, /\bi said\b/i,
    ],
  },
  {
    domain: 'media',
    patterns: [
      /\bfilm\b/i, /\bmovie\b/i, /\bscript\b/i, /\bscreenplay\b/i,
      /\blyric\b/i, /\bsong\b/i, /\bgame (design|story|lore)\b/i,
    ],
  },
];

// Signals that indicate the query is conversational — skip Archive.
const SKIP_PATTERNS: RegExp[] = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|yep|nope)\b/i,
  /^what (is|are) you\b/i,
  /^(can|could) you (explain|describe|tell me)/i,
  /generate (an? )?(image|picture|video|audio|music|art)/i,
  /^(create|draw|make|generate)\b.*(image|picture|video|clip|music|song)/i,
];

// ── Classifier ────────────────────────────────────────────────────────────────

export class ArchiveIntentClassifier {

  /**
   * Classify whether this turn should trigger an Archive lookup.
   * Checks hasAnyContent() synchronously — only opens domain DBs if needed.
   */
  async classify(ctx: ArchiveRoutingContext): Promise<ArchiveRoutingDecision> {
    const noMatch: ArchiveRoutingDecision = {
      useArchive: false, domains: [], k: 0, queryText: ctx.userMessage,
    };

    // Never inject Archive into copilot turns.
    if (ctx.isCopilot) return noMatch;

    // Skip if no Archive content exists at all.
    if (!ArchiveStore.hasAnyContent()) return noMatch;

    const msg = ctx.userMessage;

    // Skip obviously conversational turns.
    if (SKIP_PATTERNS.some(p => p.test(msg.trim()))) return noMatch;

    // Collect domains via keyword matching + project context + pins.
    const domainSet = new Set<ArchiveDomain>(ctx.pinnedDomains);

    if (ctx.hasActiveProject) {
      domainSet.add('projects');
    }

    for (const { domain, patterns } of DOMAIN_SIGNALS) {
      if (patterns.some(p => p.test(msg))) {
        domainSet.add(domain);
      }
    }

    // If no domain signals fired, default to 'reference' + 'projects' for any
    // substantive query — these are the most commonly useful domains.
    if (domainSet.size === 0 && msg.trim().split(/\s+/).length >= 4) {
      domainSet.add('reference');
      if (ctx.hasActiveProject) domainSet.add('projects');
    }

    // Filter to only domains that actually have content on disk.
    const available = await ArchiveStore.listDomains();
    const availableNames = new Set(available.map(d => d.domain));
    const domains = Array.from(domainSet).filter(d => availableNames.has(d));

    if (domains.length === 0) return noMatch;

    return {
      useArchive: true,
      domains,
      k:          8,
      queryText:  msg,
    };
  }
}
