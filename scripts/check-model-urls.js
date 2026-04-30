#!/usr/bin/env node
// check-model-urls.js
// Checks every HuggingFace URL in GGUF_CATALOGUE and IMAGE_MODEL_CATALOGUE
// with a HEAD request. Run daily to catch broken links before users hit them.
//
// Usage:
//   node scripts/check-model-urls.js
//   node scripts/check-model-urls.js --timeout 15000
//   node scripts/check-model-urls.js --image-only
//   node scripts/check-model-urls.js --llm-only
//
// Exit code 0 if all URLs resolve, 1 if any are broken.

import https from 'https';

const args = process.argv.slice(2);
const TIMEOUT_MS = (() => {
  const i = args.indexOf('--timeout');
  return i !== -1 ? parseInt(args[i + 1], 10) : 10000;
})();
const IMAGE_ONLY = args.includes('--image-only');
const LLM_ONLY   = args.includes('--llm-only');

// ── LLM catalogue ─────────────────────────────────────────────────────────────
// Mirrors GGUF_CATALOGUE in PhobosLocalManager.ts. Keep in sync when models are
// added or renamed.
const LLM_CATALOGUE = [
  { modelId: 'llama3.2-3b-q4',        label: 'Llama 3.2 3B Q4',          hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',                           hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf' },
  { modelId: 'llama3.1-8b-q4',         label: 'Llama 3.1 8B Q4',           hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',                      hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' },
  { modelId: 'gemma3-1b-q4',           label: 'Gemma 3 1B Q4',             hfRepo: 'bartowski/google_gemma-3-1b-it-GGUF',                            hfFile: 'google_gemma-3-1b-it-Q4_K_M.gguf' },
  { modelId: 'gemma3-4b-q4',           label: 'Gemma 3 4B Q4',             hfRepo: 'bartowski/google_gemma-3-4b-it-GGUF',                            hfFile: 'google_gemma-3-4b-it-Q4_K_M.gguf' },
  { modelId: 'gemma3-12b-q4',          label: 'Gemma 3 12B Q4',            hfRepo: 'bartowski/google_gemma-3-12b-it-GGUF',                           hfFile: 'google_gemma-3-12b-it-Q4_K_M.gguf' },
  { modelId: 'qwen3.5-4b-q4',          label: 'Qwen3.5 4B Q4',             hfRepo: 'bartowski/Qwen_Qwen3.5-4B-GGUF',                                 hfFile: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf' },
  { modelId: 'qwen3.5-9b-q4',          label: 'Qwen3.5 9B Q4',             hfRepo: 'bartowski/Qwen_Qwen3.5-9B-GGUF',                                 hfFile: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf' },
  { modelId: 'qwen3.5-27b-q4',         label: 'Qwen3.5 27B Q4',            hfRepo: 'bartowski/Qwen_Qwen3.5-27B-GGUF',                                hfFile: 'Qwen_Qwen3.5-27B-Q4_K_M.gguf' },
  { modelId: 'qwen3.5-35b-a3b-q4',     label: 'Qwen3.5 35B-A3B Q4',       hfRepo: 'bartowski/Qwen_Qwen3.5-35B-A3B-GGUF',                           hfFile: 'Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf' },
  { modelId: 'qwen3-4b-q4',            label: 'Qwen3 4B Q4',               hfRepo: 'bartowski/Qwen_Qwen3-4B-GGUF',                                   hfFile: 'Qwen_Qwen3-4B-Q4_K_M.gguf' },
  { modelId: 'qwen3-8b-q4',            label: 'Qwen3 8B Q4',               hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',                                   hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf' },
  { modelId: 'qwen3-14b-q4',           label: 'Qwen3 14B Q4',              hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',                                  hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf' },
  { modelId: 'qwen3-30b-a3b-q4',       label: 'Qwen3 30B-A3B Q4',         hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',                              hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf' },
  { modelId: 'mistral-7b-q4',          label: 'Mistral 7B v0.3 Q4',        hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',                        hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf' },
  { modelId: 'magistral-8b-q4',        label: 'Magistral 24B Q4',          hfRepo: 'bartowski/mistralai_Magistral-Small-2506-GGUF',                   hfFile: 'mistralai_Magistral-Small-2506-Q4_K_M.gguf' },
  { modelId: 'deepseek-r1-8b-q4',      label: 'DeepSeek-R1 8B Q4',        hfRepo: 'bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF',           hfFile: 'deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf' },
  { modelId: 'deepseek-r1-14b-q4',     label: 'DeepSeek-R1 14B Q4',       hfRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',                    hfFile: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf' },
  { modelId: 'deepseek-r1-70b-q4',     label: 'DeepSeek-R1 70B Q4',       hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF',                   hfFile: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf' },
  { modelId: 'nemotron3-4b-q4',        label: 'Nemotron 3 Nano 4B Q4',    hfRepo: 'unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF',                         hfFile: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf' },
  { modelId: 'nemotron3-9b-q4',         label: 'Nemotron 3 Nano 9B v2 Q4', hfRepo: 'bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF',                hfFile: 'nvidia_NVIDIA-Nemotron-Nano-9B-v2-Q4_K_M.gguf' },
  { modelId: 'gemma4-e4b-q4',           label: 'Gemma 4 E4B Q4',           hfRepo: 'bartowski/google_gemma-4-E4B-it-GGUF',                           hfFile: 'google_gemma-4-E4B-it-Q4_K_M.gguf' },
  { modelId: 'gemma4-26b-a4b-q4',       label: 'Gemma 4 26B-A4B Q4',       hfRepo: 'bartowski/google_gemma-4-26B-A4B-it-GGUF',                       hfFile: 'google_gemma-4-26B-A4B-it-Q4_K_M.gguf' },
  { modelId: 'qwen3.5-27b-opus-distill-q4',    label: 'Qwen3.5 27B Opus Distill Q4',    hfRepo: 'Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF',           hfFile: 'Qwen3.5-27B.Q4_K_M.gguf' },
  { modelId: 'qwen3.5-27b-opus-distill-v2-q4', label: 'Qwen3.5 27B Opus Distill v2 Q4', hfRepo: 'Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF',        hfFile: 'Qwen3.5-27B.Q4_K_M.gguf' },
  { modelId: 'qwen3.5-9b-opus-distill-q4',     label: 'Qwen3.5 9B Opus Distill Q4',     hfRepo: 'Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-GGUF',            hfFile: 'Qwen3.5-9B.Q4_K_M.gguf' },
  { modelId: 'qwen3.5-2b-opus-distill-q4',     label: 'Qwen3.5 2B Opus Distill Q4',     hfRepo: 'Jackrong/Qwen3.5-2B-Claude-4.6-Opus-Reasoning-Distilled-GGUF',            hfFile: 'Qwen3.5-2B.Q4_K_M.gguf' },
];

// ── Image model catalogue ─────────────────────────────────────────────────────
// Mirrors IMAGE_MODEL_CATALOGUE in PhobosLocalManager.ts. Keep in sync.
// CivitAI models (lustify-v6-olt, bigasp-v2) excluded — no public HF URL.
// Wan 2.2 has two GGUFs per model (LowNoise + HighNoise) — both checked.
const IMAGE_CATALOGUE = [
  // Chroma
  { modelId: 'chroma-q4',                label: 'Chroma1-HD Q4',                hfRepo: 'silveroxides/Chroma1-HD-GGUF',                       hfFile: 'Chroma1-HD-Q4_0.gguf' },
  // Z-Image
  { modelId: 'z-image-turbo-q4',         label: 'Z-Image Turbo Q4',             hfRepo: 'leejet/Z-Image-Turbo-GGUF',                          hfFile: 'z_image_turbo-Q4_K.gguf' },
  { modelId: 'z-image-base-q6',          label: 'Z-Image Base Q6',              hfRepo: 'unsloth/Z-Image-GGUF',                               hfFile: 'z-image-Q6_K.gguf' },
  // SDXL
  { modelId: 'sdxl-turbo-fp16',          label: 'SDXL Turbo FP16',              hfRepo: 'stabilityai/sdxl-turbo',                             hfFile: 'sd_xl_turbo_1.0_fp16.safetensors' },
  { modelId: 'dreamshaper-xl-turbo-v2',  label: 'DreamShaper XL Turbo V2.1',    hfRepo: 'Lykon/dreamshaper-xl-v2-turbo',                      hfFile: 'DreamShaperXL_Turbo_v2_1.safetensors' },
  { modelId: 'realvisxl-v5-lightning',   label: 'RealVisXL V5 Lightning FP16',  hfRepo: 'SG161222/RealVisXL_V5.0_Lightning',                  hfFile: 'RealVisXL_V5.0_Lightning_fp16.safetensors' },
  { modelId: 'juggernaut-xl-v9-lightning', label: 'Juggernaut XL V9 Lightning', hfRepo: 'AiWise/Juggernaut-XL-V9-GE-RDPhoto2-Lightning_4S',  hfFile: 'juggernautXL_v9Rdphoto2Lightning.safetensors' },
  { modelId: 'sdxl-base-fp16',           label: 'SDXL Base 1.0 FP16',           hfRepo: 'stabilityai/stable-diffusion-xl-base-1.0',            hfFile: 'sd_xl_base_1.0.safetensors' },
  { modelId: 'realvisxl-v5-fp16',        label: 'RealVisXL V5 FP16',            hfRepo: 'SG161222/RealVisXL_V5.0',                            hfFile: 'RealVisXL_V5.0_fp16.safetensors' },
  { modelId: 'juggernaut-xl-v9-fp16',    label: 'Juggernaut XL V9 FP16',        hfRepo: 'RunDiffusion/Juggernaut-XL-v9',                      hfFile: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors' },
  { modelId: 'dreamshaper-xl-lightning', label: 'DreamShaper XL Lightning FP16', hfRepo: 'Lykon/dreamshaper-xl-v2-turbo',                     hfFile: 'DreamShaperXL_Turbo_V2-SFW.safetensors' },
  { modelId: 'pony-diffusion-v6-xl',     label: 'Pony Diffusion V6 XL FP16',    hfRepo: 'LyliaEngine/Pony_Diffusion_V6_XL',                   hfFile: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' },
  { modelId: 'pony-realism-v21',         label: 'Pony Realism V2.1 FP16',       hfRepo: 'LyliaEngine/ponyRealism_v21MainVAE',                  hfFile: 'ponyRealism_v21MainVAE.safetensors' },
  // FLUX.2
  { modelId: 'flux2-klein-4b-q4',        label: 'FLUX.2-klein-4B Q4',           hfRepo: 'unsloth/FLUX.2-klein-4B-GGUF',                       hfFile: 'flux-2-klein-4b-Q4_K_M.gguf' },
  { modelId: 'flux2-klein-9b-q4',        label: 'FLUX.2-klein-9B Q4',           hfRepo: 'unsloth/FLUX.2-klein-9B-GGUF',                       hfFile: 'flux-2-klein-9b-Q4_K_M.gguf' },
  // Kontext
  { modelId: 'kontext-dev-q5',           label: 'FLUX Kontext Dev Q5',          hfRepo: 'QuantStack/FLUX.1-Kontext-dev-GGUF',                  hfFile: 'flux1-kontext-dev-Q5_K_S.gguf' },
  // Qwen-Image
  { modelId: 'qwen-image-q4',            label: 'Qwen-Image Q4',                hfRepo: 'unsloth/Qwen-Image-2512-GGUF',                       hfFile: 'qwen-image-2512-Q4_K_M.gguf' },
  // Wan 2.1
  { modelId: 'wan21-t2v-1.3b-q4',        label: 'Wan 2.1 T2V 1.3B Q4',         hfRepo: 'samuelchristlie/Wan2.1-T2V-1.3B-GGUF',               hfFile: 'Wan2.1-T2V-1.3B-Q4_K_M.gguf' },
  { modelId: 'wan21-t2v-14b-q4',         label: 'Wan 2.1 T2V 14B Q4',          hfRepo: 'city96/Wan2.1-T2V-14B-gguf',                         hfFile: 'wan2.1-t2v-14b-Q4_K_M.gguf' },
  { modelId: 'wan21-i2v-14b-480p-q4',    label: 'Wan 2.1 I2V 14B 480P Q4',     hfRepo: 'city96/Wan2.1-I2V-14B-480P-gguf',                    hfFile: 'wan2.1-i2v-14b-480p-Q4_K_M.gguf' },
  // Wan 2.2 (two GGUFs each — both must be present)
  { modelId: 'wan22-t2v-14b-q4-lownoise',  label: 'Wan 2.2 T2V 14B LowNoise',  hfRepo: 'QuantStack/Wan2.2-T2V-A14B-GGUF',                    hfFile: 'LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf' },
  { modelId: 'wan22-t2v-14b-q4-highnoise', label: 'Wan 2.2 T2V 14B HighNoise', hfRepo: 'QuantStack/Wan2.2-T2V-A14B-GGUF',                    hfFile: 'HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf' },
  { modelId: 'wan22-i2v-14b-q4-lownoise',  label: 'Wan 2.2 I2V 14B LowNoise',  hfRepo: 'QuantStack/Wan2.2-I2V-A14B-GGUF',                    hfFile: 'LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf' },
  { modelId: 'wan22-i2v-14b-q4-highnoise', label: 'Wan 2.2 I2V 14B HighNoise', hfRepo: 'QuantStack/Wan2.2-I2V-A14B-GGUF',                    hfFile: 'HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf' },
  // FLUX.1 (legacy)
  { modelId: 'flux-schnell-q4',          label: 'FLUX.1-schnell Q4',            hfRepo: 'second-state/FLUX.1-schnell-GGUF',                   hfFile: 'flux1-schnell-Q4_K_M.gguf' },
  { modelId: 'flux-dev-q4',              label: 'FLUX.1-dev Q4',                hfRepo: 'city96/FLUX.1-dev-gguf',                             hfFile: 'flux1-dev-Q4_K_M.gguf' },
];

// ── Image aux file catalogue ──────────────────────────────────────────────────
// Shared encoder/VAE files downloaded once, reused across model families.
const IMAGE_AUX_CATALOGUE = [
  // FLUX.1 shared
  { modelId: 'flux-vae',               label: 'FLUX VAE (ae.safetensors)',       hfRepo: 'second-state/FLUX.1-schnell-GGUF',            hfFile: 'ae.safetensors' },
  { modelId: 'flux-clip-l',            label: 'FLUX CLIP-L encoder',            hfRepo: 'comfyanonymous/flux_text_encoders',            hfFile: 'clip_l.safetensors' },
  { modelId: 'flux-t5-q3',             label: 'T5-XXL encoder Q3_K_M',         hfRepo: 'city96/t5-v1_1-xxl-encoder-gguf',             hfFile: 't5-v1_1-xxl-encoder-Q3_K_M.gguf' },
  { modelId: 'flux-t5-q4',             label: 'T5-XXL encoder Q4_K_M',         hfRepo: 'city96/t5-v1_1-xxl-encoder-gguf',             hfFile: 't5-v1_1-xxl-encoder-Q4_K_M.gguf' },
  { modelId: 'flux-t5-q8',             label: 'T5-XXL encoder Q8_0',           hfRepo: 'city96/t5-v1_1-xxl-encoder-gguf',             hfFile: 't5-v1_1-xxl-encoder-Q8_0.gguf' },
  // FLUX.2 / Qwen-Image / Z-Image
  { modelId: 'flux2-vae',              label: 'FLUX.2 VAE',                     hfRepo: 'Comfy-Org/flux2-dev',                         hfFile: 'split_files/vae/flux2-vae.safetensors' },
  { modelId: 'qwen-image-vae',         label: 'Qwen-Image VAE',                hfRepo: 'Comfy-Org/Qwen-Image_ComfyUI',                hfFile: 'split_files/vae/qwen_image_vae.safetensors' },
  { modelId: 'zimage-llm-qwen3-4b-q4', label: 'Qwen3-4B text encoder Q4',      hfRepo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',         hfFile: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf' },
  { modelId: 'flux2-llm-qwen3-8b-q4',  label: 'Qwen3-8B text encoder Q4',      hfRepo: 'unsloth/Qwen3-8B-GGUF',                       hfFile: 'Qwen3-8B-Q4_K_M.gguf' },
  { modelId: 'qwen-image-llm-q4',      label: 'Qwen2.5-VL-7B text encoder Q4', hfRepo: 'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',         hfFile: 'Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf' },
  // Wan
  { modelId: 'wan-vae',                label: 'Wan 2.1 VAE',                    hfRepo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',        hfFile: 'split_files/vae/wan_2.1_vae.safetensors' },
  { modelId: 'wan-umt5-q5',            label: 'UMT5-XXL text encoder Q5_K_M',  hfRepo: 'city96/umt5-xxl-encoder-gguf',                hfFile: 'umt5-xxl-encoder-Q5_K_M.gguf' },
  { modelId: 'wan-clip-vision',        label: 'CLIP Vision encoder (I2V)',      hfRepo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',        hfFile: 'split_files/clip_vision/clip_vision_h.safetensors' },
];

function hfUrl(entry) {
  return `https://huggingface.co/${entry.hfRepo}/resolve/main/${entry.hfFile}`;
}

function headRequest(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: TIMEOUT_MS }, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    req.on('error',   (e) => resolve({ status: 0, ok: false, error: e.message }));
    req.end();
  });
}

async function checkAll(catalogue) {
  const CONCURRENCY = 6;
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < catalogue.length) {
      const entry = catalogue[idx++];
      const url = hfUrl(entry);
      process.stdout.write(`  checking ${entry.modelId}...`);
      const result = await headRequest(url);
      process.stdout.write(` ${result.ok ? '✓' : `✗ (${result.status || result.error})`}\n`);
      results.push({ ...entry, url, ...result });
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await Promise.all(workers);
  return results;
}

(async () => {
  console.log(`\nPHOBOS model URL check — ${new Date().toISOString()}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms  Concurrency: 6\n`);

  const allResults = [];

  if (!IMAGE_ONLY) {
    console.log('── LLM models ──────────────────────────────────────────────────────────');
    allResults.push(...await checkAll(LLM_CATALOGUE));
  }
  if (!LLM_ONLY) {
    console.log('\n── Image models ────────────────────────────────────────────────────────');
    allResults.push(...await checkAll(IMAGE_CATALOGUE));
    console.log('\n── Image aux files ─────────────────────────────────────────────────────');
    allResults.push(...await checkAll(IMAGE_AUX_CATALOGUE));
  }

  const ok     = allResults.filter(r => r.ok);
  const broken = allResults.filter(r => !r.ok);

  console.log(`\n${'─'.repeat(72)}`);
  if (broken.length === 0) {
    console.log(`All ${ok.length} models OK`);
  } else {
    console.log(`${ok.length}/${allResults.length} OK   ${broken.length} BROKEN:\n`);
    for (const r of broken) {
      console.log(`  ✗  ${r.modelId.padEnd(38)} ${r.status || r.error}`);
      console.log(`     ${r.url}`);
    }
    console.log('');
  }
  console.log('─'.repeat(72));

  process.exit(broken.length > 0 ? 1 : 0);
})();
