// ── ArchiveClient ──────────────────────────────────────────────────────────────
//
// Query interface for the PHOBOS Archive.
//
// Exposes a single `search()` entry point that:
//   1. Embeds the query via SYBIL
//   2. Runs semantic (HNSW) + FTS search in parallel across specified domains
//   3. Merges and re-ranks results by combined score
//   4. Returns top-k chunks formatted as XML for context injection
//
// Cross-domain queries use ArchiveStore.openAttachConnection() which ATTACHes
// domain files onto a transient in-memory DuckDB instance.

import { embed } from './EmbedClient.js';
import { ArchiveStore, type ArchiveDomain, type SemanticSearchRow } from '../db/ArchiveStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArchiveSearchOptions {
  query:    string;
  domains:  ArchiveDomain[];
  k?:       number;       // default 8
  minScore?: number;      // cosine similarity floor, default 0.65
}

export interface ArchiveChunkResult {
  id:          string;
  domain:      ArchiveDomain;
  sourceTitle: string | null;
  sourcePath:  string;
  breadcrumb:  string | null;
  chunkText:   string;
  score:       number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Hybrid semantic + FTS search across one or more archive domains.
 * Returns an XML string for injection as `<archive_context>` in the Complete Context,
 * or an empty string if SYBIL is unavailable or no results meet the score floor.
 */
export async function search(opts: ArchiveSearchOptions): Promise<string> {
  const { query, domains, k = 8, minScore = 0.65 } = opts;
  if (domains.length === 0) return '';

  const queryVec = await embed(query.slice(0, 800));
  if (!queryVec) return '';

  let results: ArchiveChunkResult[];

  if (domains.length === 1) {
    results = await searchSingleDomain(domains[0], queryVec, query, k, minScore);
  } else {
    results = await searchMultiDomain(domains, queryVec, query, k, minScore);
  }

  if (results.length === 0) return '';
  return formatArchiveContext(results);
}

/**
 * Raw search — returns structured results instead of XML.
 * Used by archiveRoutes search endpoint for the UI search panel.
 */
export async function searchRaw(opts: ArchiveSearchOptions): Promise<ArchiveChunkResult[]> {
  const { query, domains, k = 8, minScore = 0.65 } = opts;
  if (domains.length === 0) return [];

  const queryVec = await embed(query.slice(0, 800));
  if (!queryVec) return [];

  if (domains.length === 1) {
    return searchSingleDomain(domains[0], queryVec, query, k, minScore);
  }
  return searchMultiDomain(domains, queryVec, query, k, minScore);
}

// ── Single-domain path ────────────────────────────────────────────────────────

async function searchSingleDomain(
  domain: ArchiveDomain,
  queryVec: number[],
  queryText: string,
  k: number,
  minScore: number,
): Promise<ArchiveChunkResult[]> {
  const [semantic, fts] = await Promise.all([
    ArchiveStore.semanticSearch(domain, queryVec, k, minScore),
    ArchiveStore.ftsSearch(domain, queryText, k),
  ]);

  return mergeAndRerank(semantic, fts, k);
}

// ── Multi-domain ATTACH path ──────────────────────────────────────────────────

async function searchMultiDomain(
  domains: ArchiveDomain[],
  queryVec: number[],
  queryText: string,
  k: number,
  minScore: number,
): Promise<ArchiveChunkResult[]> {
  const { db, attachedAliases } = await ArchiveStore.openAttachConnection(domains);
  if (attachedAliases.length === 0) { await db.close(); return []; }

  const EMBED_DIM = 768;
  const vec       = `[${queryVec.join(',')}]`;

  const unionParts = attachedAliases.map((alias) => `
    SELECT id, chunk_text, breadcrumb, source_title, source_path, domain,
           array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) AS score
      FROM ${alias}.archive_chunks
     WHERE array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) >= ${minScore}
  `);

  const sql = `
    SELECT * FROM (
      ${unionParts.join('\n    UNION ALL\n')}
    )
    ORDER BY score DESC
    LIMIT ${k * 2}
  `;

  let semanticRows: SemanticSearchRow[] = [];
  const conn = await db.connect();
  try {
    const rows = await conn.all(sql);
    semanticRows = rows.map((r) => {
      const rec = r as Record<string, unknown>;
      return {
        id:          rec.id as string,
        chunkText:   rec.chunk_text as string,
        breadcrumb:  rec.breadcrumb as string | null,
        sourceTitle: rec.source_title as string | null,
        sourcePath:  rec.source_path as string,
        domain:      rec.domain as ArchiveDomain,
        score:       Number(rec.score),
      };
    });
  } finally {
    await conn.close();
  }

  // DETACH and close.
  const detachConn = await db.connect();
  try {
    for (const alias of attachedAliases) {
      await detachConn.exec(`DETACH ${alias}`).catch(() => {});
    }
  } finally {
    await detachConn.close();
  }
  await db.close();

  // FTS across individual domains in parallel — ATTACH doesn't support FTS extension.
  const ftsResults = await Promise.all(
    domains.map(d => ArchiveStore.ftsSearch(d, queryText, k))
  );
  const ftsFlat = ftsResults.flat();

  return mergeAndRerank(semanticRows, ftsFlat, k);
}

// ── Merge and re-rank ─────────────────────────────────────────────────────────
//
// Semantic and FTS results are merged by chunk id.
// A chunk that appears in both gets a score bonus (reciprocal rank fusion style):
//   finalScore = semanticScore + (ftsBonus if also in FTS results)
// Results are sorted by finalScore descending, deduped, and capped at k.

const FTS_BONUS = 0.05;

function mergeAndRerank(
  semantic: SemanticSearchRow[],
  fts: SemanticSearchRow[],
  k: number,
): ArchiveChunkResult[] {
  const ftsIds = new Set(fts.map(r => r.id));
  const byId   = new Map<string, ArchiveChunkResult>();

  for (const r of semantic) {
    const bonus = ftsIds.has(r.id) ? FTS_BONUS : 0;
    byId.set(r.id, {
      id:          r.id,
      domain:      r.domain,
      sourceTitle: r.sourceTitle,
      sourcePath:  r.sourcePath,
      breadcrumb:  r.breadcrumb,
      chunkText:   r.chunkText,
      score:       r.score + bonus,
    });
  }

  // Add FTS-only results (not found by semantic search) at base FTS score.
  for (const r of fts) {
    if (!byId.has(r.id)) {
      byId.set(r.id, {
        id:          r.id,
        domain:      r.domain,
        sourceTitle: r.sourceTitle,
        sourcePath:  r.sourcePath,
        breadcrumb:  r.breadcrumb,
        chunkText:   r.chunkText,
        score:       FTS_BONUS,
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ── XML formatter ─────────────────────────────────────────────────────────────

function formatArchiveContext(results: ArchiveChunkResult[]): string {
  const lines = ['<archive_context>'];
  for (const r of results) {
    const title = r.sourceTitle ?? r.sourcePath;
    const score = r.score.toFixed(2);
    lines.push(`  <chunk domain="${escXml(r.domain)}" source="${escXml(title)}" score="${score}">`);
    if (r.breadcrumb) {
      lines.push(`    ${escXml(r.breadcrumb)}`);
    }
    lines.push(`    ${escXml(r.chunkText)}`);
    lines.push(`  </chunk>`);
  }
  lines.push('</archive_context>');
  return lines.join('\n');
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
