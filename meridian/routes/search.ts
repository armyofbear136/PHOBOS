/**
 * meridian/routes/search.ts — Keyword and SYBIL vector search.
 *
 * Keyword search: DuckDB LIKE on filename + labels.
 * Vector search: array_distance on embed_vec via DuckDB VSS (when available).
 * Results are unioned, deduplicated, and ranked by relevance.
 */

import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { MeridianDB } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';

const SYBIL_PORT = 16315;

async function embedQuery(query: string): Promise<number[] | null> {
  return new Promise(resolve => {
    const body = JSON.stringify({ content: query.slice(0, 2_000) });
    const req  = http.request({
      hostname: '127.0.0.1', port: SYBIL_PORT, path: '/embedding',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8_000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          let vec: number[] | undefined;
          if (Array.isArray(json) && json.length > 0) {
            const raw = json[0]?.embedding;
            vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
          } else {
            const raw = json.embedding;
            vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
          }
          resolve(Array.isArray(vec) && vec.length > 0 ? vec : null);
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body);
    req.end();
  });
}

export async function searchRoutes(
  fastify: FastifyInstance,
  opts: { db: MeridianDB; config: MeridianConfig },
): Promise<void> {

  fastify.get('/api/search', async (req, reply) => {
    const q      = (req.query as Record<string, string>).q?.trim();
    const limit  = Math.min(parseInt((req.query as Record<string, string>).limit ?? '50', 10), 200);
    const offset = Math.max(parseInt((req.query as Record<string, string>).offset ?? '0', 10), 0);

    if (!q) return reply.send({ files: [], total: 0 });

    // Run keyword and vector searches in parallel
    const [keywordResult, vec] = await Promise.all([
      opts.db.searchFiles({ userId: opts.config.userId, query: q, limit, offset }),
      embedQuery(q),
    ]);

    // If SYBIL is unavailable or no embeddings exist yet, return keyword results
    if (!vec) {
      return reply.send({
        files:  keywordResult.files.map(toSearchResult),
        total:  keywordResult.total,
        source: 'keyword',
      });
    }

    // Vector search via DuckDB — array_distance is available when VSS extension is loaded
    let vectorIds: string[] = [];
    try {
      const rows = await opts.db.rawQuery(
        `SELECT id FROM meridian_files
         WHERE user_id = ? AND embed_vec IS NOT NULL
         ORDER BY array_distance(embed_vec::FLOAT[768], ?::FLOAT[768])
         LIMIT ?`,
        [opts.config.userId, JSON.stringify(vec), limit]
      );
      vectorIds = rows.map(r => r.id as string);
    } catch {
      // VSS not available or no embeddings — fall back to keyword only
      return reply.send({
        files:  keywordResult.files.map(toSearchResult),
        total:  keywordResult.total,
        source: 'keyword',
      });
    }

    // Merge: keyword results first (exact matches), then vector results not already present
    const seen = new Set(keywordResult.files.map(f => f.id));
    const merged = [...keywordResult.files];

    for (const id of vectorIds) {
      if (!seen.has(id)) {
        const file = await opts.db.getFile(id);
        if (file) { merged.push(file); seen.add(id); }
      }
    }

    return reply.send({
      files:  merged.slice(0, limit).map(toSearchResult),
      total:  merged.length,
      source: 'hybrid',
    });
  });
}

function toSearchResult(f: import('../db/db.js').MeridianFile) {
  return {
    id:        f.id,
    filename:  f.filename,
    ext:       f.ext,
    type:      f.type,
    takenAt:   f.takenAt,
    thumbReady: f.thumbReady,
    width:     f.width,
    height:    f.height,
    labels:    f.labelsJson,
  };
}
