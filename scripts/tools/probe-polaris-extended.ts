/**
 * probe-via-phobos-proxy.ts
 * 
 * Probes Polaris API endpoints through the PHOBOS proxy (port 3001).
 * No credentials needed — the proxy injects the Bearer token.
 * 
 * Run with PHOBOS server running:
 *   npx tsx scripts/tools/probe-via-phobos-proxy.ts
 */
export {};

const PROXY = 'http://localhost:3001/api/services/polaris/proxy';
const V8    = { 'Accept-Version': '8' };

async function probe(method: string, path: string, body?: unknown): Promise<void> {
  const r = await fetch(`${PROXY}${path}`, {
    method,
    headers: { ...V8, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text.substring(0, 200); }
  console.log(`\n--- ${method} ${path} (${r.status}) ---`);
  console.log(JSON.stringify(parsed)?.substring(0, 600));
}

// Get real paths to use in tests
const flatRes  = await fetch(`${PROXY}/api/flatten`, { headers: V8 });
const flatData = await flatRes.json() as { paths: string[] };
const paths    = flatData.paths?.slice(0, 3) ?? [];
const p0       = paths[0];
console.log('Sample paths:', paths);

// ── POST /api/songs with JSON body ────────────────────────────────────────────
await probe('POST', '/api/songs', { paths });
await probe('POST', '/api/songs', paths);

// ── GET /api/song/<path> (singular, by path) ──────────────────────────────────
if (p0) await probe('GET', `/api/song/${encodeURIComponent(p0)}`);

// ── GET /api/browse on a file (not directory) ─────────────────────────────────
if (p0) await probe('GET', `/api/browse?path=${encodeURIComponent(p0)}`);

// ── GET /api/artist/<name>/songs ──────────────────────────────────────────────
const artRes  = await fetch(`${PROXY}/api/artists?offset=0&count=1`, { headers: V8 });
const artData = await artRes.json() as any[];
const artist  = Array.isArray(artData) ? artData[0]?.name : null;
console.log('\nFirst artist:', artist);
if (artist) {
  await probe('GET', `/api/artist/${encodeURIComponent(artist)}/albums?offset=0&count=3`);
  await probe('GET', `/api/artist/${encodeURIComponent(artist)}/songs?offset=0&count=3`);
}

// ── /api/search shape ────────────────────────────────────────────────────────
await probe('GET', '/api/search/some%20chords');

// ── HEAD /api/songs (what methods are allowed?) ───────────────────────────────
const head = await fetch(`${PROXY}/api/songs`, { method: 'OPTIONS', headers: V8 });
const allow = head.headers.get('allow') ?? head.headers.get('Allow') ?? '(no Allow header)';
console.log(`\n--- OPTIONS /api/songs (${head.status}) --- Allow: ${allow}`);
