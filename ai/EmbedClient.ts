// ── EmbedClient ───────────────────────────────────────────────────────────────
//
// Thin wrapper around SYBIL's llama-server /embedding endpoint.
// SYBIL runs nomic-embed-text-v1.5 on CPU, port 52628, started at PHOBOS launch.
//
// Design constraints:
//   - All calls are fire-and-forget from hot paths; callers catch and swallow errors.
//   - No retry logic — if SYBIL is not running (e.g. model not yet downloaded),
//     the call returns null and the caller skips embedding.
//   - No OpenAI SDK dependency — llama-server's /embedding is a direct REST call,
//     not an OpenAI-compatible /embeddings endpoint.

import http from 'node:http';

export const SYBIL_PORT = 16315;

const EMBED_ENDPOINT = `http://127.0.0.1:${SYBIL_PORT}/embedding`;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Embed a single text string via SYBIL.
 * Returns a 768-float array, or null if SYBIL is unavailable or errors.
 */
export async function embed(text: string): Promise<number[] | null> {
  // Truncate to ~8 000 chars — nomic-embed has a 8192-token context window and
  // very long inputs produce diminishing returns for retrieval quality.
  const input = text.slice(0, 8_000);

  return new Promise<number[] | null>((resolve) => {
    const body = JSON.stringify({ content: input });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port:     SYBIL_PORT,
        path:     '/embedding',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            // llama-server /embedding returns one of two shapes depending on version:
            //   New (b8000+): [{ index: 0, embedding: [[f32, f32, ...]] }]  — array of objects, embedding is array-of-arrays
            //   Old:          { embedding: [f32, f32, ...] }                — direct object with flat array
            // Normalise both to a flat number[].
            let vec: number[] | undefined;
            if (Array.isArray(json) && json.length > 0) {
              // New format: outer array, take first element
              const first = json[0];
              const raw = first?.embedding;
              // embedding may be [[...]] (array-of-arrays) or [...] (flat)
              vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
            } else {
              // Old format: { embedding: [...] }
              const raw = json.embedding;
              vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
            }
            if (!Array.isArray(vec) || vec.length === 0) {
              console.warn('[EmbedClient] Unexpected response shape:', JSON.stringify(json).slice(0, 200));
              resolve(null);
              return;
            }
            resolve(vec);
          } catch (e) {
            console.warn('[EmbedClient] JSON parse failed:', (e as Error).message);
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      }
    );

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));

    req.write(body);
    req.end();
  });
}
