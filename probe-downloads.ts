/**
 * probe-downloads.ts
 * Run: npx tsx probe-downloads.ts
 *
 * Uses the same Node https.get + manual redirect chain as PhobosLocalManager.
 * No downloads — HEAD requests only, 1-byte Range GET fallback if HEAD is refused.
 * Reports every redirect hop, final status, Content-Length, and whether Phobos
 * would fail the redirect (308 not handled).
 */

import https from 'https';
import http  from 'http';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Hop {
  url:      string;
  status:   number;
  location: string | undefined;
  bytes:    number | undefined;  // Content-Length or Content-Range length
  note:     string;
}

interface ProbeResult {
  name:         string;
  modelId:      string;
  url:          string;
  codeSizeBytes: number;
  note:         string;
  hops:         Hop[];
  error:        string | undefined;
}

// ── Core probe ────────────────────────────────────────────────────────────────

const PHOBOS_HANDLED = new Set([301, 302, 307]);
const ALL_REDIRECTS  = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 12;

function headRequest(url: string): Promise<{ status: number; location?: string; bytes?: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'http:' ? http : https;

    const req = mod.request(
      {
        method:   'HEAD',
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers:  { 'User-Agent': 'PhobosDownloadProbe/1.0' },
      },
      (res) => {
        const status   = res.statusCode ?? 0;
        const location = res.headers['location'];
        const clen     = res.headers['content-length'];
        res.resume(); // drain so socket is released
        resolve({
          status,
          location: Array.isArray(location) ? location[0] : location,
          bytes:    clen ? parseInt(clen, 10) : undefined,
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function rangeRequest(url: string): Promise<{ status: number; location?: string; bytes?: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'http:' ? http : https;

    const req = mod.request(
      {
        method:   'GET',
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers:  {
          'User-Agent': 'PhobosDownloadProbe/1.0',
          'Range':      'bytes=0-0',
        },
      },
      (res) => {
        const status   = res.statusCode ?? 0;
        const location = res.headers['location'];
        const cr       = res.headers['content-range']; // "bytes 0-0/TOTAL"
        const clen     = res.headers['content-length'];
        let bytes: number | undefined;
        if (cr) {
          const m = cr.match(/\/(\d+)$/);
          if (m) bytes = parseInt(m[1], 10);
        } else if (clen) {
          bytes = parseInt(clen, 10);
        }
        res.resume();
        resolve({
          status,
          location: Array.isArray(location) ? location[0] : location,
          bytes,
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function probe(entry: {
  name:          string;
  modelId:       string;
  url:           string;
  codeSizeBytes: number;
  note:          string;
}): Promise<ProbeResult> {
  const result: ProbeResult = { ...entry, hops: [], error: undefined };
  let current = entry.url;

  for (let i = 0; i < MAX_HOPS; i++) {
    let hop: Hop;

    try {
      let r = await headRequest(current);

      // HEAD refused → retry with range GET
      if (r.status === 405 || r.status === 403) {
        r = await rangeRequest(current);
      }

      const note =
        r.status === 308 ? '⚠ 308 — Phobos redirect handler MISSING this code' :
        r.status === 303 ? '⚠ 303 — Phobos redirect handler MISSING this code' :
        ALL_REDIRECTS.has(r.status) ? `redirect (Phobos handles ${r.status})` :
        r.status === 200 || r.status === 206 ? '✓ reachable' :
        r.status === 404 ? '✗ not found' :
        r.status === 401 ? '✗ auth required (gated/token)' :
        '';

      hop = {
        url:      current,
        status:   r.status,
        location: r.location,
        bytes:    r.bytes,
        note,
      };
      result.hops.push(hop);

      if (r.status === 200 || r.status === 206) break;
      if (r.status === 404 || r.status === 401 || r.status === 403) break;

      if (ALL_REDIRECTS.has(r.status) && r.location) {
        // Resolve relative URLs the same way a browser would
        const base = new URL(current);
        current = new URL(r.location, base).toString();
        continue;
      }

      break; // unexpected status — stop

    } catch (err: unknown) {
      result.error = (err as Error).message;
      break;
    }
  }

  return result;
}

// ── Models ────────────────────────────────────────────────────────────────────

const HF = 'https://huggingface.co';

const MODELS = [
  // ── LLM models (downloadModel path) ────────────────────────────────────────
  {
    name:          'Qwen3.5 2B Opus Distill (Jackrong)',
    modelId:       'qwen3.5-2b-opus-distill-q4',
    url:           `${HF}/Jackrong/Qwen3.5-2B-Claude-4.6-Opus-Reasoning-Distilled-GGUF/resolve/main/Qwen3.5-2B.Q4_K_M.gguf`,
    codeSizeBytes: 1_520_000_000,
    note:          'Jackrong xet repo',
  },
  {
    name:          'Qwen3.5 2B Q4 (bartowski)',
    modelId:       'qwen3.5-2b-q4',
    url:           `${HF}/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/main/Qwen_Qwen3.5-2B-Q4_K_M.gguf`,
    codeSizeBytes: 1_520_000_000,
    note:          '',
  },
  {
    name:          'Qwen3.5 Coder 32B Q4 (bartowski) — SUSPECTED 404',
    modelId:       'qwen3.5-coder-32b-q4',
    url:           `${HF}/bartowski/Qwen_Qwen3.5-Coder-32B-Instruct-GGUF/resolve/main/Qwen_Qwen3.5-Coder-32B-Instruct-Q4_K_M.gguf`,
    codeSizeBytes: 19_400_000_000,
    note:          'Qwen3.5 has no Coder variant — repo likely does not exist',
  },
  {
    name:          'Magistral Small 24B Q4 (bartowski) [modelId bug: says 8b]',
    modelId:       'magistral-8b-q4',
    url:           `${HF}/bartowski/mistralai_Magistral-Small-2506-GGUF/resolve/main/mistralai_Magistral-Small-2506-Q4_K_M.gguf`,
    codeSizeBytes: 14_400_000_000,
    note:          'modelId should be magistral-24b-q4',
  },

  // ── Image/video models (downloadFluxModel path) ─────────────────────────────
  {
    name:          'Wan 2.1 I2V 14B 480P Q4 (city96)',
    modelId:       'wan21-i2v-14b-480p-q4',
    url:           `${HF}/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-Q4_K_M.gguf`,
    codeSizeBytes: 10_100_000_000,
    note:          'HF page reports 11.3 GB — sizeBytes may be wrong',
  },

  // ── Wan aux files ───────────────────────────────────────────────────────────
  {
    name:          'Wan VAE (Comfy-Org)',
    modelId:       'wan-vae',
    url:           `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors`,
    codeSizeBytes: 100_000_000,
    note:          'Code says 100 MB — verify real size (typical VAE is 300+ MB)',
  },
  {
    name:          'Wan UMT5-XXL T5 encoder Q5 (city96)',
    modelId:       'wan-umt5-q5',
    url:           `${HF}/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q5_K_M.gguf`,
    codeSizeBytes: 4_150_000_000,
    note:          '',
  },
  {
    name:          'Wan CLIP Vision encoder (Comfy-Org)',
    modelId:       'wan-clip-vision',
    url:           `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors`,
    codeSizeBytes: 1_730_000_000,
    note:          '',
  },
];

// ── Output ────────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${n} B`;
}

function printResult(r: ProbeResult): void {
  const sep = '─'.repeat(72);
  console.log(`\n${sep}`);
  console.log(`  ${r.name}`);
  console.log(`  modelId: ${r.modelId}`);
  if (r.note) console.log(`  note:    ${r.note}`);
  console.log(`  url:     ${r.url}`);
  console.log('');

  if (r.error) {
    console.log(`  ✗ Network error: ${r.error}`);
    return;
  }

  for (const h of r.hops) {
    const statusStr = String(h.status).padStart(3);
    const marker    =
      h.status === 308 || h.status === 303 ? '⚠ ' :
      h.status === 200 || h.status === 206  ? '✓ ' :
      h.status === 404 || h.status === 401  ? '✗ ' :
      '  ';
    console.log(`  ${marker}${statusStr}  ${h.url}`);
    if (h.note) console.log(`         ${h.note}`);
    if (h.bytes !== undefined && h.bytes > 0) {
      console.log(`         Content-Length: ${fmtBytes(h.bytes)} (${h.bytes.toLocaleString()} bytes)`);
    }
  }

  // Final hop analysis
  const last = r.hops.at(-1);
  if (!last) return;

  console.log('');

  const ok = last.status === 200 || last.status === 206;
  if (ok && last.bytes && r.codeSizeBytes > 0) {
    const delta = last.bytes - r.codeSizeBytes;
    const pct   = Math.abs(delta) / r.codeSizeBytes * 100;
    const flag  = pct > 5 ? ' ← SIZE MISMATCH' : '';
    console.log(`  code sizeBytes : ${fmtBytes(r.codeSizeBytes)}`);
    console.log(`  real file size : ${fmtBytes(last.bytes)}${flag}`);
    if (flag) {
      console.log(`  delta          : ${delta > 0 ? '+' : ''}${fmtBytes(delta)} (${pct.toFixed(1)}% off)`);
    }
  }

  const has308 = r.hops.some(h => h.status === 308);
  if (has308) {
    console.log('\n  *** BUG: 308 in redirect chain — Phobos follow() will treat this');
    console.log('  *** as an HTTP error and abort the download immediately.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Phobos Download Probe');
  console.log(`${new Date().toISOString()}\n`);
  console.log('Probing URLs using HEAD (+ Range GET fallback).');
  console.log('No files are downloaded.\n');

  for (const m of MODELS) {
    const r = await probe(m);
    printResult(r);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
