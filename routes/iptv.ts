/**
 * routes/iptv.ts — IPTV playlist fetch, parse, and live-check routes.
 *
 * All playlist data comes from iptv-org/iptv (MIT/Unlicense):
 *   https://iptv-org.github.io/iptv/
 *
 * Routes:
 *   GET  /api/iptv/categories        — list of known categories with channel counts
 *   GET  /api/iptv/playlist?cat=news — fetch + parse a category (or index) playlist
 *   POST /api/iptv/check             { urls: string[] } — live-check up to 20 streams
 *
 * The playlist fetch is cached server-side for 30 minutes per category.
 * The stream check uses a HEAD request with a 4s timeout — fast enough
 * to check 20 channels in ~4s with concurrency.
 *
 * Wire contract: channel shape returned to frontend:
 *   { name, url, logo, group, language, country, tvgId }
 */

import type { FastifyInstance } from 'fastify';
import * as https from 'https';

// ── Constants ─────────────────────────────────────────────────────────────────

const IPTV_BASE = 'https://iptv-org.github.io/iptv';

// curated category list with friendly labels — sourced from PLAYLISTS.md
const KNOWN_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'general',       label: 'General'        },
  { id: 'news',          label: 'News'            },
  { id: 'entertainment', label: 'Entertainment'   },
  { id: 'sports',        label: 'Sports'          },
  { id: 'movies',        label: 'Movies'          },
  { id: 'documentary',   label: 'Documentary'     },
  { id: 'music',         label: 'Music'           },
  { id: 'kids',          label: 'Kids'            },
  { id: 'education',     label: 'Education'       },
  { id: 'science',       label: 'Science'         },
  { id: 'business',      label: 'Business'        },
  { id: 'lifestyle',     label: 'Lifestyle'       },
  { id: 'travel',        label: 'Travel'          },
  { id: 'weather',       label: 'Weather'         },
  { id: 'cooking',       label: 'Cooking'         },
  { id: 'auto',          label: 'Auto'            },
  { id: 'religious',     label: 'Religious'       },
  { id: 'legislative',   label: 'Legislative'     },
  { id: 'shop',          label: 'Shopping'        },
  { id: 'outdoor',       label: 'Outdoor'         },
  { id: 'classic',       label: 'Classic TV'      },
  { id: 'animation',     label: 'Animation'       },
  { id: 'series',        label: 'Series'          },
  { id: 'comedy',        label: 'Comedy'          },
  { id: 'family',        label: 'Family'          },
  { id: 'xxx',           label: 'Adult'           },
];

// ── In-memory cache (TTL: 30 min) ────────────────────────────────────────────

interface CacheEntry {
  channels:  IptvChannel[];
  fetchedAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000;

// ── Channel type ──────────────────────────────────────────────────────────────

export interface IptvChannel {
  name:      string;
  url:       string;
  logo:      string | null;
  group:     string | null;
  language:  string | null;
  country:   string | null;
  tvgId:     string | null;
  userAgent: string | null;
  referrer:  string | null;
}

// ── M3U parser ────────────────────────────────────────────────────────────────
// Handles extended M3U format used by iptv-org.
// #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." tvg-language="..." tvg-country="..." group-title="...",Channel Name
// http://stream.url

function parseM3U(text: string): IptvChannel[] {
  const lines    = text.split(/\r?\n/);
  const channels: IptvChannel[] = [];
  let   meta: Partial<IptvChannel> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#EXTINF:')) {
      // Parse attributes from the EXTINF line.
      const tvgId    = extractAttr(trimmed, 'tvg-id');
      const tvgName  = extractAttr(trimmed, 'tvg-name');
      const logo     = extractAttr(trimmed, 'tvg-logo');
      const language = extractAttr(trimmed, 'tvg-language');
      const country  = extractAttr(trimmed, 'tvg-country');
      const group    = extractAttr(trimmed, 'group-title');

      // Channel name is everything after the final comma.
      const commaIdx = trimmed.lastIndexOf(',');
      const name     = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : (tvgName ?? 'Unknown');

      meta = { name: name || tvgName || 'Unknown', logo, group, language, country, tvgId, userAgent: null, referrer: null };
      continue;
    }

    // #EXTVLCOPT lines carry stream-specific headers — must appear between EXTINF and URL.
    if (trimmed.startsWith('#EXTVLCOPT:') && meta) {
      const val = trimmed.slice('#EXTVLCOPT:'.length);
      if (val.toLowerCase().startsWith('http-user-agent=')) {
        meta.userAgent = val.slice('http-user-agent='.length).trim() || null;
      } else if (val.toLowerCase().startsWith('http-referrer=')) {
        meta.referrer = val.slice('http-referrer='.length).trim() || null;
      }
      continue;
    }

    if (!trimmed.startsWith('#') && meta) {
      // This line is the stream URL.
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('rtmp://')) {
        channels.push({
          name:      meta.name      ?? 'Unknown',
          url:       trimmed,
          logo:      meta.logo      ?? null,
          group:     meta.group     ?? null,
          language:  meta.language  ?? null,
          country:   meta.country   ?? null,
          tvgId:     meta.tvgId     ?? null,
          userAgent: meta.userAgent ?? null,
          referrer:  meta.referrer  ?? null,
        });
      }
      meta = null;
    }
  }

  return channels;
}

function extractAttr(line: string, attr: string): string | null {
  const re  = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m   = line.match(re);
  return m ? m[1] || null : null;
}

// ── HTTPS fetch helper ────────────────────────────────────────────────────────

function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const follow = (target: string, hops = 0) => {
      if (hops > 5) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const req = https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-iptv/1.0', 'Accept': '*/*' } },
        (res) => {
          if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            follow(res.headers.location, hops + 1); return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${target}`)); return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        }
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Fetch timeout')); });
      req.on('error', reject);
    };
    follow(url);
  });
}

// ── Stream liveness check ─────────────────────────────────────────────────────
// Two-phase check for HLS streams:
//   Phase 1 — GET the manifest URL, read up to 4KB.
//   Phase 2 — If the body looks like an m3u8, extract the first non-comment
//             URI line (variant playlist or segment) and HEAD-check that URL.
//             This catches CDNs that serve manifests fine but have dead segments.
// Non-m3u8 URLs (mp3, aac, ts) are confirmed live if phase 1 returns any data.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function httpGet(url: string, maxBytes: number, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const mod     = isHttps ? https : require('http');
      const req = mod.request(
        { hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search, method: 'GET', timeout: timeoutMs,
          headers: { 'User-Agent': UA } },
        (res: import('http').IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            if (received >= maxBytes) { res.destroy(); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }); }
          });
          res.on('end',   () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        }
      );
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    } catch (e) { reject(e); }
  });
}

function httpHead(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    try {
      const parsed  = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const mod     = isHttps ? https : require('http');
      const req = mod.request(
        { hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search, method: 'HEAD', timeout: timeoutMs,
          headers: { 'User-Agent': UA } },
        (res: import('http').IncomingMessage) => { res.destroy(); resolve(res.statusCode ?? 0); }
      );
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error',   () => resolve(0));
      req.end();
    } catch { resolve(0); }
  });
}

// Resolve a relative URI found in an m3u8 against its base URL.
function resolveM3uUri(base: string, uri: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

// Extract the first playable URI from an m3u8 body (variant playlist or segment).
function extractFirstM3uUri(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('http://') || t.startsWith('https://') || t.endsWith('.m3u8') || t.endsWith('.ts') || t.endsWith('.aac')) {
      return t;
    }
  }
  return null;
}

async function checkStream(url: string): Promise<boolean> {
  try {
    // Phase 1 — fetch the manifest (4KB is enough to read the full m3u8 for most streams).
    const { status, body } = await httpGet(url, 4096, 6_000);

    if (status === 403) return true;  // geo-blocked but server alive
    if (status === 0 || status >= 400) return false;

    // Non-m3u8 streams (mp3, aac, raw TS): any data = live.
    const isM3u8 = body.trimStart().startsWith('#EXTM3U') || url.includes('.m3u8') || url.includes('.m3u');
    if (!isM3u8) return body.length > 0;

    // Phase 2 — extract first URI from manifest and probe it.
    const firstUri = extractFirstM3uUri(body);
    if (!firstUri) return false;  // empty manifest = dead

    const segUrl    = resolveM3uUri(url, firstUri);
    const segStatus = await httpHead(segUrl, 5_000);

    // 200/206 = live segment. 403 = geo-blocked but streaming. Anything else = dead.
    return segStatus === 200 || segStatus === 206 || segStatus === 403;
  } catch {
    return false;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerIptvRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Categories list ───────────────────────────────────────────────────────
  fastify.get('/api/iptv/categories', async (_req, reply) => {
    return reply.send({ categories: KNOWN_CATEGORIES });
  });

  // ── Playlist fetch + parse ────────────────────────────────────────────────
  // ?cat=news  — fetch category playlist
  // ?cat=index — fetch the master index (all channels, slower)
  fastify.get<{ Querystring: { cat?: string; country?: string; lang?: string } }>(
    '/api/iptv/playlist',
    async (req, reply) => {
      const cat     = (req.query.cat     ?? 'news').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const country = (req.query.country ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const lang    = (req.query.lang    ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

      // Build the URL for the requested playlist type.
      let playlistUrl: string;
      if (country) {
        playlistUrl = `${IPTV_BASE}/countries/${country}.m3u`;
      } else if (lang) {
        playlistUrl = `${IPTV_BASE}/languages/${lang}.m3u`;
      } else if (cat === 'index') {
        playlistUrl = `${IPTV_BASE}/index.m3u`;
      } else {
        playlistUrl = `${IPTV_BASE}/categories/${cat}.m3u`;
      }

      const cacheKey = playlistUrl;

      // Cache hit.
      const cached = CACHE.get(cacheKey);
      if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
        return reply.send({ channels: cached.channels, cached: true, source: playlistUrl });
      }

      // Cache miss — fetch and parse.
      try {
        const text     = await fetchText(playlistUrl);
        const channels = parseM3U(text);

        CACHE.set(cacheKey, { channels, fetchedAt: Date.now() });

        return reply.send({ channels, cached: false, source: playlistUrl });
      } catch (err) {
        return reply.status(502).send({ error: `Failed to fetch playlist: ${(err as Error).message}`, source: playlistUrl });
      }
    }
  );

  // ── Stream liveness check ─────────────────────────────────────────────────
  // Accepts up to 50 URLs per call. Returns { url, live } for each.
  // Checks run concurrently — total latency ≈ single check timeout (4s).
  fastify.post<{ Body: { urls: string[] } }>('/api/iptv/check', async (req, reply) => {
    const { urls } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return reply.status(400).send({ error: 'urls array required' });
    }

    const batch   = urls.slice(0, 50); // 50 concurrent HEAD requests at 4s timeout
    const results = await Promise.all(
      batch.map(async (url) => ({
        url,
        live: await checkStream(url),
      }))
    );

    return reply.send({ results });
  });
}
