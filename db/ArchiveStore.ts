// ── ArchiveStore ───────────────────────────────────────────────────────────────
//
// SYBIL Phase 2 — persistent, multi-domain knowledge base (the Archive).
//
// Each knowledge domain lives in its own DuckDB file at:
//   ~/.phobos/archive/{domain}.duckdb
//
// This store owns:
//   - Domain file creation and schema initialisation (archive_chunks, HNSW, FTS, meta)
//   - Chunk insert / delete / source-level delete
//   - Domain-level metadata reads (chunk count, last ingest, size on disk)
//   - Cross-domain connection factory used by ArchiveClient for ATTACH queries
//   - hasAnyContent() — used by server.ts to gate SYBIL required-startup
//
// Design constraints:
//   - Each domain opens its own Database instance. Domain DBs are independent
//     of the main phobos.duckdb managed by DatabaseManager.
//   - vss (HNSW) is loaded on every domain DB connection. FTS is additive:
//     failure to load the fts extension disables full-text search for that
//     domain but never blocks ingestion or semantic search.
//   - No domain DB instance is held open between calls. Each method opens,
//     operates, and closes. This keeps file locks minimal for backup/portability.
//   - ATTACH-based cross-domain queries are handled by openAttachConnection(),
//     which opens a transient in-memory DuckDB instance the caller ATTACHes
//     domain files onto. The caller is responsible for closing it.

import Database from 'duckdb-async';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { BUNDLED_EXTENSION_DIR } from './DatabaseManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const ARCHIVE_DIR = path.join(os.homedir(), '.phobos', 'archive');

/** Embedding dimension — must match nomic-embed-text-v1.5 and MemoryStore.EMBED_DIM */
const EMBED_DIM = 768;

// ── Domain taxonomy ───────────────────────────────────────────────────────────
//
// Built-in domains cover every reasonable knowledge category. The intent
// classifier uses these names as routing targets. 'custom-{name}' domains
// are user-created and share the same schema.

export const BUILTIN_DOMAINS = [
  'personal',    // journals, notes, personal scratch, life logs
  'projects',    // project-specific technical docs, specs, PRDs
  'reference',   // books, manuals, third-party library docs, RFCs
  'research',    // academic papers, studies, whitepapers
  'science',     // STEM reference material, textbooks
  'literature',  // fiction, essays, creative writing, humanities
  'media',       // film, music, game scripts, screenplays
  'history',     // historical records, timelines, biographical material
  'legal',       // contracts, regulations, terms, compliance docs
  'finance',     // financial statements, reports, economic data
  'phobos',      // PHOBOS system docs — auto-managed
] as const;

export type BuiltinDomain = (typeof BUILTIN_DOMAINS)[number];
export type ArchiveDomain = BuiltinDomain | `custom-${string}`;

// ── Schema ────────────────────────────────────────────────────────────────────

const DOMAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_chunks (
  id            VARCHAR     PRIMARY KEY,
  source_id     VARCHAR     NOT NULL,      -- stable UUID per ingested source file/URL/paste
  source_path   VARCHAR     NOT NULL,      -- original file path or URL
  source_title  VARCHAR,                   -- extracted title or filename
  domain        VARCHAR     NOT NULL,
  chunk_index   INTEGER     NOT NULL,      -- 0-based position within source document
  chunk_text    TEXT        NOT NULL,
  embedding     FLOAT[${EMBED_DIM}] NOT NULL,
  breadcrumb    TEXT,                      -- heading chain prepended before embedding
  source_type   VARCHAR     NOT NULL DEFAULT 'file', -- 'file' | 'url' | 'paste'
  word_count    INTEGER,
  char_count    INTEGER,
  ingest_at     TIMESTAMP   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_sources (
  id            VARCHAR     PRIMARY KEY,
  source_path   VARCHAR     NOT NULL UNIQUE,
  source_title  VARCHAR,
  source_type   VARCHAR     NOT NULL DEFAULT 'file',
  domain        VARCHAR     NOT NULL,
  chunk_count   INTEGER     NOT NULL DEFAULT 0,
  file_mtime    BIGINT,                    -- mtime ms at ingest time — for change detection
  ingest_at     TIMESTAMP   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_domain_meta (
  key   VARCHAR PRIMARY KEY,
  value TEXT
);
`;

// Inserted once on domain creation — OR IGNORE keeps re-runs safe.
const DOMAIN_META_SEED = (domainName: string) => `
INSERT OR IGNORE INTO archive_domain_meta (key, value) VALUES
  ('created_at',  current_timestamp),
  ('domain_name', '${domainName}'),
  ('schema_ver',  '1');
`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArchiveChunkRecord {
  id:           string;
  sourceId:     string;
  sourcePath:   string;
  sourceTitle:  string | null;
  domain:       ArchiveDomain;
  chunkIndex:   number;
  chunkText:    string;
  embedding:    number[];
  breadcrumb:   string | null;
  sourceType:   'file' | 'url' | 'paste';
  wordCount:    number | null;
  charCount:    number | null;
}

export interface ArchiveSourceRecord {
  id:           string;
  sourcePath:   string;
  sourceTitle:  string | null;
  sourceType:   'file' | 'url' | 'paste';
  domain:       ArchiveDomain;
  chunkCount:   number;
  fileMtime:    number | null;
  ingestAt:     string;
  updatedAt:    string;
}

export interface DomainInfo {
  domain:       ArchiveDomain;
  filePath:     string;
  exists:       boolean;
  chunkCount:   number;
  sourceCount:  number;
  lastIngest:   string | null;
  sizeBytes:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function domainFilePath(domain: ArchiveDomain): string {
  return path.join(ARCHIVE_DIR, `${domain}.duckdb`);
}

function ensureArchiveDir(): void {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

/**
 * Open a DuckDB database at filePath, load vss (required for HNSW),
 * and attempt to load fts (non-fatal if unavailable).
 * Returns { db, ftsAvailable }.
 */
async function openDomainDb(
  filePath: string,
): Promise<{ db: Database.Database; ftsAvailable: boolean }> {
  const dbConfig = BUNDLED_EXTENSION_DIR
    ? { extension_directory: BUNDLED_EXTENSION_DIR }
    : {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = await Database.Database.create(filePath, dbConfig as any);

  // Set extension directory explicitly before LOAD so DuckDB finds the
  // bundled extension without writing to ~/.duckdb/.
  if (BUNDLED_EXTENSION_DIR) {
    const escaped = BUNDLED_EXTENSION_DIR.replace(/\\/g, '/');
    const conn = await db.connect();
    try {
      await conn.exec(`SET extension_directory='${escaped}'`);
    } finally {
      await conn.close();
    }
  }

  // vss is required — HNSW index creation depends on it.
  const conn = await db.connect();
  try {
    await conn.exec(`LOAD vss`);
  } finally {
    await conn.close();
  }

  // fts is additive — log but continue if unavailable.
  let ftsAvailable = false;
  const ftsConn = await db.connect();
  try {
    await ftsConn.exec(`LOAD fts`);
    ftsAvailable = true;
  } catch {
    // FTS extension not available in this DuckDB build — semantic search only.
  } finally {
    await ftsConn.close();
  }

  return { db, ftsAvailable };
}

/**
 * Run schema DDL and seed meta table on a freshly opened domain DB.
 * Safe to call on an existing domain — all statements use IF NOT EXISTS / OR IGNORE.
 */
async function initDomainSchema(
  db: Database.Database,
  domain: ArchiveDomain,
  ftsAvailable: boolean,
): Promise<void> {
  const conn = await db.connect();
  try {
    await conn.exec(DOMAIN_SCHEMA);
    await conn.exec(DOMAIN_META_SEED(domain));

    // HNSW index — CREATE INDEX has no IF NOT EXISTS for HNSW in all builds;
    // catch duplicate gracefully (same pattern as MemoryStore).
    try {
      await conn.exec(`
        CREATE INDEX archive_hnsw
          ON archive_chunks USING HNSW (embedding)
          WITH (metric = 'cosine')
      `);
    } catch {
      // Already exists — normal on subsequent opens.
    }

    await conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_archive_source_id
        ON archive_chunks(source_id, chunk_index)
    `);

    await conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_archive_source_path
        ON archive_chunks(source_path)
    `);

    // FTS index over chunk_text — DuckDB fts extension syntax.
    // Only attempted if fts loaded successfully.
    if (ftsAvailable) {
      try {
        await conn.exec(`
          PRAGMA create_fts_index('archive_chunks', 'id', 'chunk_text', stemmer='english')
        `);
      } catch {
        // FTS index already exists — normal on subsequent opens.
      }
    }
  } finally {
    await conn.close();
  }
}

// ── ArchiveStore ──────────────────────────────────────────────────────────────

export class ArchiveStore {

  // ── Domain management ──────────────────────────────────────────────────────

  /**
   * Create a domain if it does not already exist.
   * Opens the DB file, runs schema DDL, closes.
   * Safe to call on an existing domain (idempotent).
   */
  static async ensureDomain(domain: ArchiveDomain): Promise<void> {
    ensureArchiveDir();
    const filePath = domainFilePath(domain);
    const { db, ftsAvailable } = await openDomainDb(filePath);
    try {
      await initDomainSchema(db, domain, ftsAvailable);
      console.log(`[ArchiveStore] Domain ready: ${domain} (fts=${ftsAvailable})`);
    } finally {
      await db.close();
    }
  }

  /**
   * Delete a domain and its entire DuckDB file.
   * Irreversible. The caller (archiveRoutes) must confirm with the user first.
   */
  static async deleteDomain(domain: ArchiveDomain): Promise<void> {
    const filePath = domainFilePath(domain);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      // Remove WAL file if present.
      const wal = filePath + '.wal';
      if (fs.existsSync(wal)) fs.rmSync(wal, { force: true });
    }
    console.log(`[ArchiveStore] Domain deleted: ${domain}`);
  }

  /**
   * Returns true if any domain .duckdb file exists in the archive directory.
   * Used by server.ts to determine whether SYBIL is required at startup.
   */
  static hasAnyContent(): boolean {
    if (!fs.existsSync(ARCHIVE_DIR)) return false;
    return fs.readdirSync(ARCHIVE_DIR).some(f => f.endsWith('.duckdb'));
  }

  /**
   * List all domains that have a .duckdb file on disk,
   * with their chunk counts, last ingest time, and file size.
   */
  static async listDomains(): Promise<DomainInfo[]> {
    if (!fs.existsSync(ARCHIVE_DIR)) return [];

    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.duckdb'));
    const results: DomainInfo[] = [];

    for (const file of files) {
      const domain = file.replace(/\.duckdb$/, '') as ArchiveDomain;
      const filePath = path.join(ARCHIVE_DIR, file);
      const sizeBytes = fs.statSync(filePath).size;

      let chunkCount  = 0;
      let sourceCount = 0;
      let lastIngest: string | null = null;

      try {
        const { db } = await openDomainDb(filePath);
        try {
          const conn = await db.connect();
          try {
            const rows = await conn.all(`SELECT COUNT(*) AS n FROM archive_chunks`);
            chunkCount = Number((rows[0] as { n: bigint | number }).n);

            const sRows = await conn.all(`SELECT COUNT(*) AS n FROM archive_sources`);
            sourceCount = Number((sRows[0] as { n: bigint | number }).n);

            const mRows = await conn.all(
              `SELECT MAX(ingest_at)::VARCHAR AS last FROM archive_sources`
            );
            lastIngest = (mRows[0] as { last: string | null }).last ?? null;
          } finally {
            await conn.close();
          }
        } finally {
          await db.close();
        }
      } catch {
        // Domain file exists but is unreadable — report it with zero counts.
      }

      results.push({ domain, filePath, exists: true, chunkCount, sourceCount, lastIngest, sizeBytes });
    }

    return results;
  }

  // ── Source management ──────────────────────────────────────────────────────

  /**
   * Look up a source record by path within a domain.
   * Returns null if not found.
   */
  static async getSource(
    domain: ArchiveDomain,
    sourcePath: string,
  ): Promise<ArchiveSourceRecord | null> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return null;

    const { db } = await openDomainDb(filePath);
    try {
      const conn = await db.connect();
      try {
        const rows = await conn.all(
          `SELECT id, source_path, source_title, source_type, domain,
                  chunk_count, file_mtime, ingest_at::VARCHAR AS ingest_at,
                  updated_at::VARCHAR AS updated_at
             FROM archive_sources
            WHERE source_path = ?`,
          sourcePath,
        );
        if (rows.length === 0) return null;
        const r = rows[0] as Record<string, unknown>;
        return {
          id:          r.id as string,
          sourcePath:  r.source_path as string,
          sourceTitle: r.source_title as string | null,
          sourceType:  r.source_type as 'file' | 'url' | 'paste',
          domain:      r.domain as ArchiveDomain,
          chunkCount:  Number(r.chunk_count),
          fileMtime:   r.file_mtime != null ? Number(r.file_mtime) : null,
          ingestAt:    r.ingest_at as string,
          updatedAt:   r.updated_at as string,
        };
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  /**
   * List all sources in a domain, ordered by most recently ingested.
   */
  static async listSources(domain: ArchiveDomain): Promise<ArchiveSourceRecord[]> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return [];

    const { db } = await openDomainDb(filePath);
    try {
      const conn = await db.connect();
      try {
        const rows = await conn.all(`
          SELECT id, source_path, source_title, source_type, domain,
                 chunk_count, file_mtime, ingest_at::VARCHAR AS ingest_at,
                 updated_at::VARCHAR AS updated_at
            FROM archive_sources
           ORDER BY ingest_at DESC
        `);
        return rows.map((r) => {
          const rec = r as Record<string, unknown>;
          return {
            id:          rec.id as string,
            sourcePath:  rec.source_path as string,
            sourceTitle: rec.source_title as string | null,
            sourceType:  rec.source_type as 'file' | 'url' | 'paste',
            domain:      rec.domain as ArchiveDomain,
            chunkCount:  Number(rec.chunk_count),
            fileMtime:   rec.file_mtime != null ? Number(rec.file_mtime) : null,
            ingestAt:    rec.ingest_at as string,
            updatedAt:   rec.updated_at as string,
          };
        });
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  // ── Chunk write operations ─────────────────────────────────────────────────

  /**
   * Register a source and write all its chunks in a single transaction.
   * If the source already exists (re-ingest after file change), callers
   * must call deleteSource() first to remove stale chunks.
   *
   * @param domain        Target domain
   * @param sourceId      Stable UUID for this source (caller generates once)
   * @param sourcePath    Original file path, URL, or paste identifier
   * @param sourceTitle   Human-readable title
   * @param sourceType    'file' | 'url' | 'paste'
   * @param fileMtime     mtime ms of source file (null for URL/paste)
   * @param chunks        Array of chunk records to insert
   */
  static async writeChunks(
    domain: ArchiveDomain,
    sourceId: string,
    sourcePath: string,
    sourceTitle: string | null,
    sourceType: 'file' | 'url' | 'paste',
    fileMtime: number | null,
    chunks: Array<{
      chunkIndex: number;
      chunkText:  string;
      embedding:  number[];
      breadcrumb: string | null;
      wordCount:  number;
      charCount:  number;
    }>,
  ): Promise<void> {
    ensureArchiveDir();
    const filePath = domainFilePath(domain);
    const { db, ftsAvailable } = await openDomainDb(filePath);

    try {
      // Ensure schema exists (safe on first write to a new domain).
      await initDomainSchema(db, domain, ftsAvailable);

      const conn = await db.connect();
      try {
        // Upsert source record.
        await conn.exec(`
          INSERT INTO archive_sources
            (id, source_path, source_title, source_type, domain, chunk_count, file_mtime)
          VALUES ('${sourceId}', '${_esc(sourcePath)}', ${sourceTitle ? `'${_esc(sourceTitle)}'` : 'NULL'},
                  '${sourceType}', '${domain}', ${chunks.length}, ${fileMtime ?? 'NULL'})
          ON CONFLICT (source_path) DO UPDATE SET
            source_title = excluded.source_title,
            chunk_count  = excluded.chunk_count,
            file_mtime   = excluded.file_mtime,
            updated_at   = now()
        `);

        // Insert chunks. Each embedding is written as a literal FLOAT[768] array.
        // We batch in groups of 50 to keep individual SQL strings manageable.
        const BATCH = 50;
        for (let i = 0; i < chunks.length; i += BATCH) {
          const slice = chunks.slice(i, i + BATCH);
          const valueRows = slice.map((c) => {
            const id  = randomUUID();
            const vec = `[${c.embedding.join(',')}]`;
            const bc  = c.breadcrumb ? `'${_esc(c.breadcrumb)}'` : 'NULL';
            const tt  = `'${_esc(c.chunkText)}'`;
            return `('${id}','${sourceId}','${_esc(sourcePath)}',`
              + `${sourceTitle ? `'${_esc(sourceTitle)}'` : 'NULL'},'${domain}',`
              + `${c.chunkIndex},${tt},${vec}::FLOAT[${EMBED_DIM}],`
              + `${bc},'${sourceType}',${c.wordCount},${c.charCount})`;
          }).join(',\n');

          await conn.exec(`
            INSERT INTO archive_chunks
              (id, source_id, source_path, source_title, domain,
               chunk_index, chunk_text, embedding,
               breadcrumb, source_type, word_count, char_count)
            VALUES ${valueRows}
          `);
        }

        // Rebuild FTS index after bulk insert.
        if (ftsAvailable) {
          try {
            await conn.exec(`PRAGMA drop_fts_index('archive_chunks')`);
            await conn.exec(
              `PRAGMA create_fts_index('archive_chunks', 'id', 'chunk_text', stemmer='english')`
            );
          } catch {
            // FTS rebuild failure is non-fatal — semantic search remains available.
          }
        }
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  /**
   * Delete all chunks and the source record for a given source_path.
   * Used both for explicit user deletion and for re-ingest (delete-then-rewrite).
   */
  static async deleteSource(domain: ArchiveDomain, sourcePath: string): Promise<void> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return;

    const { db, ftsAvailable } = await openDomainDb(filePath);
    try {
      const conn = await db.connect();
      try {
        await conn.exec(
          `DELETE FROM archive_chunks WHERE source_path = '${_esc(sourcePath)}'`
        );
        await conn.exec(
          `DELETE FROM archive_sources WHERE source_path = '${_esc(sourcePath)}'`
        );

        if (ftsAvailable) {
          try {
            await conn.exec(`PRAGMA drop_fts_index('archive_chunks')`);
            await conn.exec(
              `PRAGMA create_fts_index('archive_chunks', 'id', 'chunk_text', stemmer='english')`
            );
          } catch { /* non-fatal */ }
        }
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  /**
   * Delete a source by its stable UUID.
   * Used by archiveRoutes DELETE /api/archive/sources/:sourceId.
   */
  static async deleteSourceById(domain: ArchiveDomain, sourceId: string): Promise<void> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return;

    const { db, ftsAvailable } = await openDomainDb(filePath);
    try {
      const conn = await db.connect();
      try {
        await conn.exec(
          `DELETE FROM archive_chunks WHERE source_id = '${_esc(sourceId)}'`
        );
        await conn.exec(
          `DELETE FROM archive_sources WHERE id = '${_esc(sourceId)}'`
        );

        if (ftsAvailable) {
          try {
            await conn.exec(`PRAGMA drop_fts_index('archive_chunks')`);
            await conn.exec(
              `PRAGMA create_fts_index('archive_chunks', 'id', 'chunk_text', stemmer='english')`
            );
          } catch { /* non-fatal */ }
        }
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  // ── Search primitives (used by ArchiveClient) ──────────────────────────────

  /**
   * Semantic search within a single domain using HNSW cosine similarity.
   * Returns rows ordered by score descending, limited to k * 2
   * (caller merges with FTS results before final top-k cut).
   */
  static async semanticSearch(
    domain: ArchiveDomain,
    queryVec: number[],
    k: number,
    minScore: number,
  ): Promise<SemanticSearchRow[]> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return [];

    const { db } = await openDomainDb(filePath);
    try {
      const conn = await db.connect();
      try {
        const vec = `[${queryVec.join(',')}]`;
        const rows = await conn.all(`
          SELECT id, chunk_text, breadcrumb, source_title, source_path, domain,
                 array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) AS score
            FROM archive_chunks
           WHERE array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) >= ${minScore}
           ORDER BY score DESC
           LIMIT ${k * 2}
        `);
        return rows.map((r) => {
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
    } finally {
      await db.close();
    }
  }

  /**
   * Full-text search within a single domain.
   * Returns matching rows with score=1.0 (FTS scores are not normalised).
   * Returns empty array if FTS index is unavailable.
   */
  static async ftsSearch(
    domain: ArchiveDomain,
    queryText: string,
    k: number,
  ): Promise<SemanticSearchRow[]> {
    const filePath = domainFilePath(domain);
    if (!fs.existsSync(filePath)) return [];

    const { db, ftsAvailable } = await openDomainDb(filePath);
    if (!ftsAvailable) {
      await db.close();
      return [];
    }

    try {
      const conn = await db.connect();
      try {
        const escaped = _esc(queryText);
        const rows = await conn.all(`
          SELECT id, chunk_text, breadcrumb, source_title, source_path, domain, 1.0 AS score
            FROM archive_chunks
           WHERE fts_main_archive_chunks.match_bm25(id, '${escaped}') IS NOT NULL
           LIMIT ${k * 2}
        `);
        return rows.map((r) => {
          const rec = r as Record<string, unknown>;
          return {
            id:          rec.id as string,
            chunkText:   rec.chunk_text as string,
            breadcrumb:  rec.breadcrumb as string | null,
            sourceTitle: rec.source_title as string | null,
            sourcePath:  rec.source_path as string,
            domain:      rec.domain as ArchiveDomain,
            score:       1.0,
          };
        });
      } finally {
        await conn.close();
      }
    } finally {
      await db.close();
    }
  }

  /**
   * Open a transient in-memory DuckDB instance with vss loaded.
   * Used by ArchiveClient for ATTACH-based cross-domain queries.
   *
   * Caller pattern:
   *   const { db, attachedAliases } = await ArchiveStore.openAttachConnection(domains);
   *   try {
   *     // query across aliases: ref.archive_chunks, proj.archive_chunks …
   *   } finally {
   *     for (const alias of attachedAliases) await conn.exec(`DETACH ${alias}`);
   *     await db.close();
   *   }
   *
   * Returns db + the list of successfully attached domain aliases.
   * Domains whose files do not exist are silently skipped.
   */
  static async openAttachConnection(
    domains: ArchiveDomain[],
  ): Promise<{ db: Database.Database; attachedAliases: string[] }> {
    const dbConfig = BUNDLED_EXTENSION_DIR
      ? { extension_directory: BUNDLED_EXTENSION_DIR }
      : {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = await Database.Database.create(':memory:', dbConfig as any);

    // Load vss on the in-memory DB so HNSW cosine similarity works on ATTACH'd tables.
    const setup = await db.connect();
    try {
      if (BUNDLED_EXTENSION_DIR) {
        const escaped = BUNDLED_EXTENSION_DIR.replace(/\\/g, '/');
        await setup.exec(`SET extension_directory='${escaped}'`);
      }
      await setup.exec(`LOAD vss`);
    } finally {
      await setup.close();
    }

    const attachedAliases: string[] = [];
    const conn = await db.connect();
    try {
      for (const domain of domains) {
        const filePath = domainFilePath(domain);
        if (!fs.existsSync(filePath)) continue;
        // Alias: 'custom-foo' → 'custom_foo' (DuckDB identifiers disallow hyphens).
        const alias = domain.replace(/-/g, '_');
        const escaped = filePath.replace(/\\/g, '/');
        try {
          await conn.exec(`ATTACH '${escaped}' AS ${alias} (READ_ONLY)`);
          attachedAliases.push(alias);
        } catch {
          // File locked or corrupt — skip this domain.
          console.warn(`[ArchiveStore] Could not ATTACH domain: ${domain}`);
        }
      }
    } finally {
      await conn.close();
    }

    return { db, attachedAliases };
  }
}

// ── Types shared with ArchiveClient ───────────────────────────────────────────

export interface SemanticSearchRow {
  id:          string;
  chunkText:   string;
  breadcrumb:  string | null;
  sourceTitle: string | null;
  sourcePath:  string;
  domain:      ArchiveDomain;
  score:       number;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Escape single quotes for SQL string literals. */
function _esc(s: string): string {
  return s.replace(/'/g, "''");
}
