/**
 * fetch-image-models.ts
 *
 * Downloads the full PHOBOS image model catalogue to your user models folder,
 * exactly matching the directory structure production expects.
 *
 * Usage:
 *   npx tsx fetch-image-models.ts [options]
 *
 * Options:
 *   --base <path>      Models base path (default: C:\Users\<you>\.phobos\models)
 *   --hf-token <tok>   HuggingFace token (or set HF_TOKEN env var)
 *   --only <id,...>    Comma-separated modelIds to download (subset mode)
 *   --skip <id,...>    Comma-separated modelIds to skip
 *   --aux-only         Download shared aux files only (VAE, T5, encoders)
 *   --dry-run          Print what would be downloaded without downloading
 *   --no-resume        Re-download files that already exist
 *
 * Directory layout produced:
 *   <base>/image/flux/      FLUX.1, Chroma, Kontext, FLUX.2, Z-Image GGUFs
 *   <base>/image/sdxl/      SDXL single-file safetensors
 *   <base>/image/wan/       Wan VAE + T5 + model GGUFs
 *   <base>/image/llm/       LLM text encoders (Qwen3, Qwen2.5-VL)
 *   <base>/image/           Shared aux (FLUX VAE, CLIP-L, T5-XXL safetensors)
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as https from 'https';
import * as http  from 'http';
import { URL }    from 'url';

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(): {
  base: string;
  hfToken: string;
  only: Set<string>;
  skip: Set<string>;
  auxOnly: boolean;
  dryRun: boolean;
  resume: boolean;
} {
  const args = process.argv.slice(2);
  const get  = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag: string) => args.includes(flag);

  const defaultBase = path.join(os.homedir(), '.phobos', 'models');

  return {
    base:     get('--base')      ?? defaultBase,
    hfToken:  get('--hf-token')  ?? process.env['HF_TOKEN'] ?? '',
    only:     new Set((get('--only') ?? '').split(',').filter(Boolean)),
    skip:     new Set((get('--skip') ?? '').split(',').filter(Boolean)),
    auxOnly:  has('--aux-only'),
    dryRun:   has('--dry-run'),
    resume:   !has('--no-resume'),
  };
}

// ── Directory helpers ─────────────────────────────────────────────────────────

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download a single file with resume support and progress display.
 * Returns true on success, false on failure (non-throwing so we can continue).
 */
async function downloadFile(
  url: string,
  destPath: string,
  label: string,
  expectedBytes: number,
  opts: { resume: boolean; hfToken: string; dryRun: boolean },
): Promise<boolean> {
  if (opts.dryRun) {
    const gb = (expectedBytes / 1e9).toFixed(2);
    console.log(`  [dry-run] ${label} (${gb} GB) → ${destPath}`);
    return true;
  }

  // Check existing file.
  let existingBytes = 0;
  if (fs.existsSync(destPath)) {
    existingBytes = fs.statSync(destPath).size;
    if (opts.resume && existingBytes >= expectedBytes * 0.9) {
      console.log(`  ✓ already complete: ${label}`);
      return true;
    }
    if (!opts.resume) {
      existingBytes = 0; // re-download from scratch
    }
  }

  mkdirp(path.dirname(destPath));

  const gb = (expectedBytes / 1e9).toFixed(2);
  const resumeMsg = existingBytes > 0 ? ` (resuming from ${(existingBytes / 1e9).toFixed(2)} GB)` : '';
  console.log(`  ↓ ${label} (${gb} GB)${resumeMsg}`);
  console.log(`    → ${destPath}`);

  return new Promise((resolve) => {
    const attempt = (retries: number) => {
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {};
      if (opts.hfToken) headers['Authorization'] = `Bearer ${opts.hfToken}`;
      if (existingBytes > 0) headers['Range'] = `bytes=${existingBytes}-`;

      const req = mod.get(url, { headers }, (res) => {
        // Follow redirects (HF uses CDN redirects).
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers.location;
          if (!location) { resolve(false); return; }
          // Rebuild with redirect target, no auth header on CDN redirect.
          const redirectUrl = location.startsWith('http') ? location : `${parsedUrl.origin}${location}`;
          const modR = redirectUrl.startsWith('https') ? https : http;
          modR.get(redirectUrl, (res2) => pipeResponse(res2));
          return;
        }

        pipeResponse(res);
      });

      req.on('error', (err) => {
        console.error(`    ✗ request error: ${err.message}`);
        if (retries > 0) {
          console.log(`    retrying (${retries} left)…`);
          setTimeout(() => attempt(retries - 1), 3000);
        } else {
          resolve(false);
        }
      });

      const pipeResponse = (res: http.IncomingMessage) => {
        if (res.statusCode === 404) {
          console.error(`    ✗ 404 Not Found: ${url}`);
          resolve(false);
          return;
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.error(`    ✗ ${res.statusCode}: auth required — pass --hf-token or set HF_TOKEN`);
          resolve(false);
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          console.error(`    ✗ HTTP ${res.statusCode}`);
          if (retries > 0) {
            setTimeout(() => attempt(retries - 1), 3000);
          } else {
            resolve(false);
          }
          return;
        }

        const append = res.statusCode === 206 && existingBytes > 0;
        const stream = fs.createWriteStream(destPath, append ? { flags: 'a' } : {});
        let downloaded = existingBytes;
        let lastPrint  = Date.now();

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          const now = Date.now();
          if (now - lastPrint > 2000) {
            const pct = expectedBytes > 0 ? ((downloaded / expectedBytes) * 100).toFixed(1) : '?';
            const dlGb = (downloaded / 1e9).toFixed(2);
            process.stdout.write(`\r    ${dlGb} GB / ${gb} GB (${pct}%)   `);
            lastPrint = now;
          }
        });

        res.pipe(stream);
        stream.on('finish', () => {
          process.stdout.write('\r');
          const finalSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          if (finalSize < expectedBytes * 0.9) {
            console.error(`    ✗ incomplete: got ${(finalSize / 1e9).toFixed(2)} GB, expected ~${gb} GB`);
            if (retries > 0) {
              existingBytes = finalSize; // attempt resume
              setTimeout(() => attempt(retries - 1), 3000);
            } else {
              resolve(false);
            }
          } else {
            console.log(`    ✓ done (${(finalSize / 1e9).toFixed(2)} GB)`);
            resolve(true);
          }
        });
        stream.on('error', (err) => {
          console.error(`    ✗ write error: ${err.message}`);
          resolve(false);
        });
      };
    };

    attempt(3);
  });
}

/** Build HuggingFace direct download URL. */
function hfUrl(repo: string, file: string): string {
  // Handles files with subdirectory paths in hfFile (e.g. split_files/vae/foo.safetensors).
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

// ── Catalogue (mirrors PhobosLocalManager constants) ─────────────────────────
// Hard-coded here so this script has no import dependency on the full project.
// Keep in sync with PhobosLocalManager.ts when catalogue changes.

interface ModelFile {
  id:            string;
  label:         string;
  hfRepo:        string;
  hfFile:        string;
  localFile?:    string;   // override basename
  destDir:       string;   // resolved at runtime from base
  sizeBytes:     number;
  isAux:         boolean;
  modelId?:      string;   // parent model ID (for --only/--skip matching)
}

function buildCatalogue(base: string): ModelFile[] {
  const flux     = path.join(base, 'image', 'flux');
  const sdxl     = path.join(base, 'image', 'sdxl');
  const wan      = path.join(base, 'image', 'wan');
  const llm      = path.join(base, 'image', 'llm');
  const shared   = path.join(base, 'image');       // VAE, CLIP-L, T5 safetensors

  const f = (
    id: string, label: string, hfRepo: string, hfFile: string,
    sizeBytes: number, destDir: string, isAux: boolean,
    localFile?: string, modelId?: string,
  ): ModelFile => ({ id, label, hfRepo, hfFile, localFile, destDir, sizeBytes, isAux, modelId });

  return [
    // ── Shared aux — download once, used by all FLUX-family models ──────────
    f('flux-vae',   'FLUX VAE',          'second-state/FLUX.1-schnell-GGUF', 'ae.safetensors',         335_000_000,   shared, true),
    f('flux-clip-l','FLUX CLIP-L',       'comfyanonymous/flux_text_encoders', 'clip_l.safetensors',     246_000_000,   shared, true),
    f('flux-t5-q3', 'T5-XXL Q3_K_M',    'city96/t5-v1_1-xxl-encoder-gguf',  't5-v1_1-xxl-encoder-Q3_K_M.gguf', 2_300_000_000, shared, true),
    f('flux-t5-q4', 'T5-XXL Q4_K_M',    'city96/t5-v1_1-xxl-encoder-gguf',  't5-v1_1-xxl-encoder-Q4_K_M.gguf', 2_900_000_000, shared, true),
    f('flux-t5-q8', 'T5-XXL Q8_0',      'city96/t5-v1_1-xxl-encoder-gguf',  't5-v1_1-xxl-encoder-Q8_0.gguf',   5_060_000_000, shared, true),

    // ── FLUX.2-family aux ───────────────────────────────────────────────────
    f('flux2-vae',  'FLUX.2 VAE',        'Comfy-Org/flux2-dev',               'split_files/vae/flux2-vae.safetensors',          335_000_000,   shared, true, 'flux2-vae.safetensors'),

    // ── Qwen-Image aux ──────────────────────────────────────────────────────
    f('qwen-image-vae', 'Qwen-Image VAE','Comfy-Org/Qwen-Image_ComfyUI',      'split_files/vae/qwen_image_vae.safetensors',     254_000_000,   shared, true),

    // ── LLM encoders ────────────────────────────────────────────────────────
    f('zimage-llm-qwen3-4b-q4', 'Qwen3-4B encoder (Z-Image/FLUX.2-4B)', 'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 2_500_000_000, llm, true),
    f('flux2-llm-qwen3-8b-q4',  'Qwen3-8B encoder (FLUX.2-9B)',         'unsloth/Qwen3-8B-GGUF',               'Qwen3-8B-Q4_K_M.gguf',               5_190_000_000, llm, true),
    f('qwen-image-llm-q4',      'Qwen2.5-VL-7B encoder (Qwen-Image)',   'unsloth/Qwen2.5-VL-7B-Instruct-GGUF', 'Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf', 5_200_000_000, llm, true),

    // ── Wan aux ─────────────────────────────────────────────────────────────
    f('wan-vae',      'Wan 2.1 VAE',      'Comfy-Org/Wan_2.1_ComfyUI_repackaged', 'split_files/vae/wan_2.1_vae.safetensors',                100_000_000,   wan, true, 'wan_2.1_vae.safetensors'),
    f('wan-umt5-q5',  'UMT5-XXL Q5_K_M', 'city96/umt5-xxl-encoder-gguf',         'umt5-xxl-encoder-Q5_K_M.gguf',                         4_150_000_000, wan, true),
    f('wan-clip-vision','CLIP Vision I2V','Comfy-Org/Wan_2.1_ComfyUI_repackaged', 'split_files/clip_vision/clip_vision_h.safetensors',     1_730_000_000, wan, true, 'clip_vision_h.safetensors'),

    // ── FLUX.1 models ────────────────────────────────────────────────────────
    f('flux-schnell-q4', 'FLUX.1-schnell Q4', 'calcuis/flux1-gguf',       'flux1-schnell-q4_k_m.gguf', 6_800_000_000, flux, false, undefined, 'flux-schnell-q4'),
    f('flux-schnell-q8', 'FLUX.1-schnell Q8', 'city96/FLUX.1-schnell-gguf','flux1-schnell-Q8_0.gguf',  11_900_000_000,flux, false, undefined, 'flux-schnell-q8'),
    f('flux-dev-q4',     'FLUX.1-dev Q4',     'city96/FLUX.1-dev-gguf',   'flux1-dev-Q4_0.gguf',       6_790_000_000, flux, false, undefined, 'flux-dev-q4'),
    f('flux-dev-q8',     'FLUX.1-dev Q8',     'city96/FLUX.1-dev-gguf',   'flux1-dev-Q8_0.gguf',      11_900_000_000, flux, false, undefined, 'flux-dev-q8'),

    // ── Chroma ───────────────────────────────────────────────────────────────
    f('chroma-q4', 'Chroma1-HD Q4', 'silveroxides/Chroma1-HD-GGUF', 'Chroma1-HD-Q4_0.gguf', 5_430_000_000, flux, false, undefined, 'chroma-q4'),

    // ── SDXL models ──────────────────────────────────────────────────────────
    f('sdxl-turbo-fp16',             'SDXL Turbo FP16',                   'stabilityai/sdxl-turbo',                 'sd_xl_turbo_1.0_fp16.safetensors',                          6_940_000_000, sdxl, false, undefined, 'sdxl-turbo-fp16'),
    f('dreamshaper-xl-turbo-v2',     'DreamShaper XL Turbo V2.1',         'Lykon/dreamshaper-xl-v2-turbo',          'DreamShaperXL_Turbo_v2_1.safetensors',                      6_940_000_000, sdxl, false, undefined, 'dreamshaper-xl-turbo-v2'),
    f('realvisxl-v5-lightning',      'RealVisXL V5.0 Lightning',          'SG161222/RealVisXL_V5.0_Lightning',      'RealVisXL_V5.0_Lightning_fp16.safetensors',                 6_940_000_000, sdxl, false, undefined, 'realvisxl-v5-lightning'),
    f('juggernaut-xl-v9-lightning',  'Juggernaut XL V9 Lightning',        'AiWise/Juggernaut-XL-V9-GE-RDPhoto2-Lightning_4S', 'juggernautXL_v9Rdphoto2Lightning.safetensors',  7_110_000_000, sdxl, false, undefined, 'juggernaut-xl-v9-lightning'),
    f('sdxl-base-fp16',              'SDXL Base 1.0 FP16',                'stabilityai/stable-diffusion-xl-base-1.0','sd_xl_base_1.0.safetensors',                              6_940_000_000, sdxl, false, undefined, 'sdxl-base-fp16'),
    f('realvisxl-v5-fp16',           'RealVisXL V5.0 FP16',               'SG161222/RealVisXL_V5.0',                'RealVisXL_V5.0_fp16.safetensors',                           6_940_000_000, sdxl, false, undefined, 'realvisxl-v5-fp16'),
    f('juggernaut-xl-v9-fp16',       'Juggernaut XL V9 FP16',             'RunDiffusion/Juggernaut-XL-v9',          'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',         7_110_000_000, sdxl, false, undefined, 'juggernaut-xl-v9-fp16'),
    f('dreamshaper-xl-lightning',    'DreamShaper XL Lightning',          'Lykon/dreamshaper-xl-v2-turbo',          'DreamShaperXL_Turbo_V2-SFW.safetensors',                    6_940_000_000, sdxl, false, undefined, 'dreamshaper-xl-lightning'),

    // ── Kontext ───────────────────────────────────────────────────────────────
    f('kontext-dev-q5', 'FLUX Kontext Dev Q5', 'QuantStack/FLUX.1-Kontext-dev-GGUF', 'flux1-kontext-dev-Q5_K_S.gguf', 8_280_000_000, flux, false, undefined, 'kontext-dev-q5'),

    // ── FLUX.2 models ─────────────────────────────────────────────────────────
    f('flux2-klein-4b-q4', 'FLUX.2-klein-4B Q4', 'unsloth/FLUX.2-klein-4B-GGUF', 'flux-2-klein-4b-Q4_K_M.gguf', 2_280_000_000, flux, false, undefined, 'flux2-klein-4b-q4'),
    f('flux2-klein-9b-q4', 'FLUX.2-klein-9B Q4', 'unsloth/FLUX.2-klein-9B-GGUF', 'flux-2-klein-9b-Q4_K_M.gguf', 5_400_000_000, flux, false, undefined, 'flux2-klein-9b-q4'),

    // ── Z-Image ───────────────────────────────────────────────────────────────
    f('z-image-turbo-q4', 'Z-Image Turbo Q4',  'leejet/Z-Image-Turbo-GGUF',  'z_image_turbo-Q4_K.gguf', 3_860_000_000, flux, false, undefined, 'z-image-turbo-q4'),
    f('z-image-base-q6',  'Z-Image Base Q6',   'unsloth/Z-Image-GGUF',        'z-image-Q6_K.gguf',       6_100_000_000, flux, false, undefined, 'z-image-base-q6'),

    // ── Qwen-Image ────────────────────────────────────────────────────────────
    f('qwen-image-q4', 'Qwen-Image Q4', 'unsloth/Qwen-Image-2512-GGUF', 'qwen-image-2512-Q4_K_M.gguf', 13_200_000_000, flux, false, undefined, 'qwen-image-q4'),

    // ── Wan video models ──────────────────────────────────────────────────────
    f('wan21-t2v-1.3b-q4', 'Wan 2.1 T2V 1.3B Q4',  'samuelchristlie/Wan2.1-T2V-1.3B-GGUF',      'Wan2.1-T2V-1.3B-Q4_K_M.gguf',  983_000_000,   wan, false, undefined, 'wan21-t2v-1.3b-q4'),
    f('wan21-t2v-14b-q4',  'Wan 2.1 T2V 14B Q4',   'city96/Wan2.1-T2V-14B-GGUF',                 'Wan2.1-T2V-14B-Q4_K_M.gguf',   9_400_000_000,  wan, false, undefined, 'wan21-t2v-14b-q4'),
    f('wan21-i2v-14b-480p-q4','Wan 2.1 I2V 14B 480P Q4','city96/Wan2.1-I2V-14B-480P-GGUF',       'Wan2.1-I2V-14B-480P-Q4_K_M.gguf', 9_400_000_000, wan, false, undefined, 'wan21-i2v-14b-480p-q4'),
    f('wan22-t2v-14b-q4',  'Wan 2.2 T2V 14B Q4 (LowNoise)', 'city96/Wan2.2-T2V-14B-GGUF',        'Wan2.2-T2V-14B-LowNoise-Q4_K_M.gguf',   9_400_000_000, wan, false, undefined, 'wan22-t2v-14b-q4'),
    f('wan22-t2v-14b-q4-hn','Wan 2.2 T2V 14B Q4 (HighNoise)','city96/Wan2.2-T2V-14B-GGUF',       'Wan2.2-T2V-14B-HighNoise-Q4_K_M.gguf',  9_400_000_000, wan, false, undefined, 'wan22-t2v-14b-q4'),
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log('═══ PHOBOS Image Model Fetch ═══');
  console.log(`Base:    ${opts.base}`);
  console.log(`Token:   ${opts.hfToken ? 'set' : 'not set (public repos only)'}`);
  if (opts.dryRun)  console.log('Mode:    DRY RUN — nothing will be downloaded');
  if (opts.auxOnly) console.log('Mode:    AUX ONLY — model GGUFs will be skipped');
  if (opts.only.size > 0) console.log(`Only:    ${[...opts.only].join(', ')}`);
  if (opts.skip.size > 0) console.log(`Skip:    ${[...opts.skip].join(', ')}`);
  console.log();

  const catalogue = buildCatalogue(opts.base);

  // Create all directories up front.
  if (!opts.dryRun) {
    for (const dir of [
      path.join(opts.base, 'image'),
      path.join(opts.base, 'image', 'flux'),
      path.join(opts.base, 'image', 'sdxl'),
      path.join(opts.base, 'image', 'wan'),
      path.join(opts.base, 'image', 'llm'),
    ]) {
      mkdirp(dir);
    }
  }

  // Filter catalogue.
  const toDownload = catalogue.filter(entry => {
    if (opts.auxOnly && !entry.isAux) return false;

    // --only: if set, include only entries whose modelId or id is in the set.
    if (opts.only.size > 0) {
      const match = (entry.modelId && opts.only.has(entry.modelId)) || opts.only.has(entry.id);
      // Always include aux files when --only is used (they're shared dependencies).
      if (!match && !entry.isAux) return false;
    }

    // --skip: exclude entries whose modelId or id is in the set.
    if (opts.skip.size > 0) {
      if ((entry.modelId && opts.skip.has(entry.modelId)) || opts.skip.has(entry.id)) return false;
    }

    return true;
  });

  // Deduplicate by dest path (e.g. T5 variants — only download ones actually needed).
  const seen = new Set<string>();
  const deduped = toDownload.filter(entry => {
    const destPath = path.join(entry.destDir, entry.localFile ?? path.basename(entry.hfFile));
    if (seen.has(destPath)) return false;
    seen.add(destPath);
    return true;
  });

  // Compute total size.
  const totalBytes = deduped.reduce((sum, e) => sum + e.sizeBytes, 0);
  const totalGb    = (totalBytes / 1e9).toFixed(1);
  console.log(`Planned: ${deduped.length} files, ~${totalGb} GB total`);
  console.log();

  // Download.
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const entry of deduped) {
    const filename = entry.localFile ?? path.basename(entry.hfFile);
    const destPath = path.join(entry.destDir, filename);
    const url      = hfUrl(entry.hfRepo, entry.hfFile);

    const ok = await downloadFile(url, destPath, entry.label, entry.sizeBytes, {
      resume:   opts.resume,
      hfToken:  opts.hfToken,
      dryRun:   opts.dryRun,
    });

    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push(`${entry.label} (${entry.hfRepo}/${entry.hfFile})`);
    }
  }

  console.log();
  console.log('═══ Summary ═══');
  console.log(`${passed} succeeded, ${failed} failed`);
  if (failures.length > 0) {
    console.log('Failed:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
