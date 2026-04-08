#!/usr/bin/env node
// check-model-urls.js
// Checks every HuggingFace URL in GGUF_CATALOGUE with a HEAD request.
// Run daily to catch broken links before users hit them.
//
// Usage:
//   node scripts/check-model-urls.js
//   node scripts/check-model-urls.js --timeout 15000
//
// Exit code 0 if all URLs resolve, 1 if any are broken.

import https from 'https';

const args = process.argv.slice(2);
const TIMEOUT_MS = (() => {
  const i = args.indexOf('--timeout');
  return i !== -1 ? parseInt(args[i + 1], 10) : 10000;
})();

// Inline catalogue — mirrors GGUF_CATALOGUE in PhobosLocalManager.ts.
// Keep in sync when models are added or renamed.
const CATALOGUE = [
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

// Check all URLs with bounded concurrency (6 at a time — HF rate limits aggressively)
async function checkAll() {
  const CONCURRENCY = 6;
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < CATALOGUE.length) {
      const entry = CATALOGUE[idx++];
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

  const results = await checkAll();

  const ok     = results.filter(r => r.ok);
  const broken = results.filter(r => !r.ok);

  console.log(`\n${'─'.repeat(72)}`);
  if (broken.length === 0) {
    console.log(`All ${ok.length} models OK`);
  } else {
    console.log(`${ok.length}/${results.length} OK   ${broken.length} BROKEN:\n`);
    for (const r of broken) {
      console.log(`  ✗  ${r.modelId.padEnd(30)} ${r.status || r.error}`);
      console.log(`     ${r.url}`);
    }
    console.log('');
  }
  console.log('─'.repeat(72));

  process.exit(broken.length > 0 ? 1 : 0);
})();
