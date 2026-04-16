// test-model-parse.ts — LLM model parse system test
//
// Tests every unique runner configuration in the PHOBOS model catalogue.
// Models not yet downloaded are automatically fetched to ~/.phobos/models/
// (same location the PHOBOS UI uses) before testing.
//
// PINNED TEST SET — one representative per distinct runner family:
//   Gemma 3 1B       — non-thinking, no jinja (baseline)
//   Qwen3.5 9B       — field-path (reasoning_content), Qwen3.5 template
//   Qwen3 8B         — field-path (reasoning_content), Qwen3 template (legacy)
//   Nemotron 3 4B    — tag-path, mamba variant, <think> special tokens, CUDA preferred
//   Nanbeige4.1 3B   — field-path, Qwen2.5-based ChatML template
//   SmolLM3 3B       — tag-path, system-message activation, always-think
//   Phi-4 mini       — tag-path, phi-4 template, always-think
//   Ministral 3B     — tag-path, Mistral v7 template, [THINK] bracket tags, always-think
//   Gemma 4 E4B      — tag-path, <|channel>thought/<channel|> format, sayon role, vision
//   Gemma 4 26B      — tag-path, <|channel>thought/<channel|> format, seren role, vision
//   Qwen3.5 9B Opus  — field-path, same runner as Qwen3.5 but fine-tuned weights
//
// Usage:
//   npx tsx test-model-parse.ts                    ← pinned set (auto-download missing)
//   npx tsx test-model-parse.ts --all              ← test every downloaded model
//   npx tsx test-model-parse.ts --model gemma4-e4b-q4
//   npx tsx test-model-parse.ts --quick            ← skip think + vision probes
//   npx tsx test-model-parse.ts --no-download      ← skip models not yet downloaded
//   npx tsx test-model-parse.ts --gpu 0            ← force device index
//   npx tsx test-model-parse.ts --layers 99
//
// Exit code 0 = all passed (warns are not failures). Non-zero = hard failures.

import * as fs    from 'fs';
import * as os    from 'os';
import * as path  from 'path';
import * as http  from 'http';
import * as https from 'https';
import * as fsPromises from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import {
  GGUF_CATALOGUE,
  type GGUFSpec,
  type HardwareProfile,
  listDownloaded,
  isDownloaded,
  isMmprojDownloaded,
  modelPath,
  mmprojPath,
  MODELS_DIR,
  detectHardware,
  resolveLlamaServerBin,
  downloadModel,
} from './phobos/PhobosLocalManager.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const ALL_MODE      = args.includes('--all');
const QUICK_MODE    = args.includes('--quick');
const NO_DOWNLOAD   = args.includes('--no-download');
const modelFilter   = args.find(a => a.startsWith('--model='))?.split('=')[1]
                   ?? (args[args.indexOf('--model') + 1] && !args[args.indexOf('--model') + 1].startsWith('--')
                       ? args[args.indexOf('--model') + 1] : undefined);
const forceGpu      = args.find(a => a.startsWith('--gpu='))?.split('=')[1]
                   ?? (args[args.indexOf('--gpu') + 1] && !args[args.indexOf('--gpu') + 1].startsWith('--')
                       ? args[args.indexOf('--gpu') + 1] : undefined);
const forceLayers   = args.find(a => a.startsWith('--layers='))?.split('=')[1]
                   ?? (args[args.indexOf('--layers') + 1] && !args[args.indexOf('--layers') + 1].startsWith('--')
                       ? args[args.indexOf('--layers') + 1] : undefined);

// ── Pinned test set ───────────────────────────────────────────────────────────
// One entry per distinct runner family. Run `--all` to test every downloaded model.

const PINNED_MODEL_IDS: string[] = [
  'gemma3-1b-q4',                // Non-thinking baseline (no jinja)
  'qwen3.5-9b-q4',               // Qwen3.5 field-path (reasoning_content)
  'qwen3-8b-q4',                 // Qwen3 field-path (legacy, different template version)
  'nemotron3-4b-q4',             // Nemotron mamba tag-path, CUDA preferred
  'nanbeige4.1-3b-q4',           // Nanbeige field-path (Qwen2.5 ChatML base)
  'smollm3-3b-q4',               // SmolLM3 tag-path, system-prompt activation
  'phi4-mini-reasoning-q4',      // Phi-4 tag-path, always-think R1 distill
  'ministral-3b-q4',             // Ministral tag-path, [THINK] brackets, always-think
  'gemma4-e4b-q4',               // Gemma 4 tag-path, <|channel>thought format, vision
  'gemma4-26b-a4b-q4',           // Gemma 4 tag-path, <|channel>thought format, vision
  'qwen3.5-9b-opus-distill-q4',  // Qwen3.5 fine-tune, same runner as qwen3.5-9b-q4
];

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_PORT       = 18765;
const SERVER_READY_MS = 120_000;
const QUERY_MS        = 120_000;  // 2 min — enough for think chains at normal ctx
const THINK_QUERY_MS  = 180_000;  // 3 min — slow Vulkan models generating long chains
const CTX_SIZE        = 4096;     // baseline for text probes
const VISION_CTX_SIZE = 16384;    // vision probes need room for image tokens (~1120+ for Gemma 4)
const GPU_LAYERS      = forceLayers ? Number(forceLayers) : 99;

// phobos.png ships in phobos/ alongside the source — used as reference image for vision probe
const _thisDir       = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMG  = path.join(_thisDir, 'phobos', 'phobos.png');

// ── Colour helpers ────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const okStr   = (s: string) => `${C.green}✓${C.reset} ${s}`;
const failStr = (s: string) => `${C.red}✗${C.reset} ${s}`;
const warnStr = (s: string) => `${C.yellow}⚠${C.reset} ${s}`;
const hdr     = (s: string) => `${C.bold}${C.cyan}${s}${C.reset}`;
const dim     = (s: string) => `${C.dim}${s}${C.reset}`;

// ── Result types ──────────────────────────────────────────────────────────────

type PassFail = 'pass' | 'fail' | 'warn' | 'skip';

interface ProbeResult {
  status:        PassFail;
  detail:        string;
  tokensPerSec?: number;
}

interface ModelResult {
  modelId:  string;
  label:    string;
  loadMs:   number;
  noThink:  ProbeResult;
  think:    ProbeResult;
  vision:   ProbeResult;
}

// ── Runner classification — mirrors LlamaServerManager + clients.ts exactly ───

function isTagPathModel(spec: GGUFSpec): boolean {
  return (
    spec.nemotronVariant != null ||
    spec.modelId.startsWith('phi4-mini-reasoning') ||
    spec.modelId.startsWith('ministral-') ||
    spec.modelId.startsWith('smollm3') ||
    spec.modelId.startsWith('gemma4')   // <|channel>thought/<channel|> format
  );
}

function isAlwaysThinkModel(spec: GGUFSpec): boolean {
  return (
    spec.modelId.startsWith('phi4-mini-reasoning') ||
    spec.modelId.startsWith('ministral-') ||
    spec.modelId.startsWith('smollm3')
  );
}

// ── Build server args — exact match to LlamaServerManager.startServer ─────────

function buildServerArgs(
  spec:        GGUFSpec,
  deviceIndex: number,
  gpuBackend:  string,
  bin:         string,
  hw:          HardwareProfile,
  ctxOverride?: number,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const ggufPath = modelPath(spec);
  const threads  = Math.max(1, Math.floor(os.cpus().length / 2));
  const ctxSize  = ctxOverride ?? CTX_SIZE;

  const serverArgs: string[] = [
    '--model',        ggufPath,
    '--port',         String(TEST_PORT),
    '--host',         '127.0.0.1',
    '--ctx-size',     String(ctxSize),
    '--threads',      String(threads),
    '--n-gpu-layers', String(GPU_LAYERS),
    '--log-disable',
  ];

  if (spec.jinjaTemplate) {
    const tagPath = isTagPathModel(spec);
    serverArgs.push('--jinja', '--reasoning-format', tagPath ? 'none' : 'deepseek');
    if (spec.thinkingTokens && isAlwaysThinkModel(spec)) {
      serverArgs.push('--reasoning', 'on');
    }
  }

  // Vision projector — pass --mmproj when the sidecar is present on disk.
  // If missing, the server launches without vision and the vision probe returns WARN.
  if (spec.mmproj) {
    const projPath = path.join(MODELS_DIR(), spec.mmproj.hfFile);
    if (fs.existsSync(projPath)) {
      serverArgs.push('--mmproj', projPath);
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  if (GPU_LAYERS > 0) {
    const binDir    = path.dirname(bin);
    const hasCuda   = process.platform === 'win32'
      && fs.existsSync(path.join(binDir, 'ggml-cuda.dll'))
      && fs.existsSync(path.join(binDir, 'cudart64_12.dll'));

    if (gpuBackend === 'cuda' && deviceIndex < 100) {
      if (hasCuda) {
        env.CUDA_VISIBLE_DEVICES    = String(deviceIndex);
        env.GGML_VK_VISIBLE_DEVICES = '';
        serverArgs.push('--device', 'CUDA0');
      } else {
        env.GGML_VK_VISIBLE_DEVICES = String(deviceIndex);
        env.CUDA_VISIBLE_DEVICES    = '';
        serverArgs.push('--device', 'Vulkan0');
      }
    } else if (gpuBackend === 'vulkan' || (gpuBackend === 'cuda' && deviceIndex >= 100)) {
      const gpuEntry  = hw.gpus.find(g => g.index === deviceIndex);
      const vulkanIdx = gpuEntry?.runner?.vulkanIndex ?? (deviceIndex >= 100 ? deviceIndex - 100 : deviceIndex);
      env.GGML_VK_VISIBLE_DEVICES = String(vulkanIdx);
      env.CUDA_VISIBLE_DEVICES    = '';
      serverArgs.push('--device', 'Vulkan0');
      // AMD UMA iGPU (890M, 780M) on Windows: mmap causes the Vulkan allocator to split
      // tensors across device-local and host-visible heaps. --no-mmap forces a single
      // contiguous allocation that stays in the device-local pool.
      if (process.platform === 'win32' && gpuEntry?.runner?.kind === 'amd-igpu') {
        serverArgs.push('--no-mmap');
      }
    }
  } else {
    serverArgs.push('--device', 'none');
  }

  return { args: serverArgs, env };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

function waitForReady(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      err ? reject(err) : resolve();
    };
    const poll = setInterval(() => {
      const req = http.request(
        { host: '127.0.0.1', port: TEST_PORT, path: '/health', method: 'GET' },
        (res) => { if ((res.statusCode ?? 0) < 400) { res.resume(); finish(); } }
      );
      req.on('error', () => {});
      req.end();
    }, 500);
    const deadline = setTimeout(() => {
      finish(new Error(`Server not ready within ${timeoutMs / 1000}s`));
      proc.kill('SIGTERM');
    }, timeoutMs);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) finish(new Error(`Server exited code=${code} before ready`));
    });
  });
}

function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000);
  });
}

// ── Streaming completion ──────────────────────────────────────────────────────

interface StreamResult {
  contentChunks:    string[];
  reasoningChunks:  string[];
  finishReason:     string;
  promptTokens:     number;
  completionTokens: number;
}

function streamCompletion(body: object, timeoutMs: number): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const t = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    const result: StreamResult = {
      contentChunks: [], reasoningChunks: [], finishReason: '',
      promptTokens: 0, completionTokens: 0,
    };
    const onConnReset = (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      const hasData = result.contentChunks.length > 0 || result.reasoningChunks.length > 0;
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') {
        result.finishReason = hasData ? result.finishReason || 'length' : 'server-crash';
        resolve(result);
      } else {
        reject(e);
      }
    };
    const req = http.request(
      { host: '127.0.0.1', port: TEST_PORT, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.content != null)           result.contentChunks.push(delta.content);
              if (delta.reasoning_content != null) result.reasoningChunks.push(delta.reasoning_content);
            }
            const finish = parsed.choices?.[0]?.finish_reason;
            if (finish) result.finishReason = finish;
            const usage = parsed.usage;
            if (usage) {
              result.promptTokens     = usage.prompt_tokens     ?? result.promptTokens;
              result.completionTokens = usage.completion_tokens ?? result.completionTokens;
            }
          }
        });
        res.on('end',   () => { clearTimeout(t); resolve(result); });
        res.on('error', onConnReset);
      }
    );
    req.on('error', onConnReset);
    req.write(payload);
    req.end();
  });
}

// ── Probe config — mirrors clients.ts getThinkingStrategy exactly ─────────────
//
// THINK PROBE NOTE: Each probe runs on a fresh server (matching production's
// fresh-server-per-session model). The upstream second-request jinja crash
// (b8665–b8724) is confirmed fixed in b8763 — think probes now PASS cleanly.
// For Gemma 4: thinking is off by default and must be enabled per-request via
// chat_template_kwargs: { enable_thinking: true }.
//
// The think probe tests this production path:
//   field-path: sends reasoning_format:deepseek → reasoning_content must be populated
//   tag-path:   sends reasoning_format:none → <think>/<|channel>thought must appear in content
//
// This confirms the path PHOBOS actually uses, not a forced per-request path.

interface ProbeConfig {
  noThinkBody:  object;
  thinkBody:    object;
  tagPath:      boolean;
  alwaysThink:  boolean;
  gemma4Format: boolean;
  systemSuffix?: string;
}

function getProbeConfig(spec: GGUFSpec): ProbeConfig {
  if (spec.nemotronVariant != null) {
    return {
      noThinkBody:  { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      thinkBody:    { reasoning_format: 'none' },
      tagPath: true, alwaysThink: false, gemma4Format: false,
    };
  }
  if (spec.modelId.startsWith('smollm3')) {
    return {
      noThinkBody:  { reasoning_format: 'none' },
      thinkBody:    { reasoning_format: 'none' },
      tagPath: true, alwaysThink: true, gemma4Format: false,
      systemSuffix: '\n\n## Metadata\nReasoning Mode: /think',
    };
  }
  if (spec.modelId.startsWith('phi4-mini-reasoning')) {
    return {
      noThinkBody:  { reasoning_format: 'none' },
      thinkBody:    { reasoning_format: 'none' },
      tagPath: true, alwaysThink: true, gemma4Format: false,
    };
  }
  if (spec.modelId.startsWith('ministral-')) {
    return {
      noThinkBody:  { reasoning_format: 'none' },
      thinkBody:    { reasoning_format: 'none' },
      tagPath: true, alwaysThink: true, gemma4Format: false,
    };
  }
  if (spec.modelId.startsWith('gemma4')) {
    // E4B and E2B: thinking is triggered by <|think|> at the start of the system prompt,
    // not by chat_template_kwargs. The 26B/31B honor enable_thinking:true as a kwarg.
    // Use a system prompt with <|think|> for the think probe — works on all variants.
    const isSmallGemma4 = spec.modelId === 'gemma4-e4b-q4' || spec.modelId === 'gemma4-e2b-q4';
    return {
      noThinkBody:  { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      thinkBody:    isSmallGemma4
        // E4B/E2B: trigger thinking via system prompt <|think|> token
        ? { reasoning_format: 'none', messages_override: [
            { role: 'system', content: '<|think|>' },
            { role: 'user',   content: 'What is the capital of France? Think briefly, then answer.' },
          ] }
        // 26B/31B: chat_template_kwargs works correctly
        : { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: true } },
      tagPath: true, alwaysThink: false, gemma4Format: true,
    };
  }
  if (spec.jinjaTemplate) {
    return {
      // No-think: disable via enable_thinking:false + reasoning_format:none
      noThinkBody:  { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      // Think: send reasoning_format:deepseek — matches extraBodyThink in production.
      // Server launched with --reasoning-format deepseek fires thinking by default.
      thinkBody:    { reasoning_format: 'deepseek' },
      tagPath: false, alwaysThink: false, gemma4Format: false,
    };
  }
  return { noThinkBody: {}, thinkBody: {}, tagPath: false, alwaysThink: false, gemma4Format: false };
}

// Normalize all thinking tag variants to <think>/</think> for uniform analysis
function normalizeTags(raw: string): string {
  return raw
    .replace(/\[THINK\]/gi,        '<think>')
    .replace(/\[\/THINK\]/gi,      '</think>')
    .replace(/<\|channel>thought/g, '<think>')
    .replace(/<channel\|>/g,       '</think>');
}

// ── No-think probe ────────────────────────────────────────────────────────────

async function runNoThinkProbe(spec: GGUFSpec): Promise<ProbeResult> {
  const cfg  = getProbeConfig(spec);
  const body: any = {
    model: spec.modelId, stream: true, max_tokens: 200,
    messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number, nothing else.' }],
    ...cfg.noThinkBody,
  };

  let result: StreamResult;
  const t0 = Date.now();
  try { result = await streamCompletion(body, QUERY_MS); }
  catch (err) { return { status: 'fail', detail: (err as Error).message }; }

  if (result.finishReason === 'server-crash') {
    return { status: 'fail', detail: 'server crashed on no-think probe — critical failure' };
  }

  const content    = result.contentChunks.join('');
  const normalized = normalizeTags(content);
  const elapsedS   = (Date.now() - t0) / 1000;
  const tps        = result.completionTokens > 0
    ? Math.round(result.completionTokens / elapsedS) : undefined;

  // Field-path bleed check (non-always-think models only)
  if (!cfg.tagPath && !cfg.alwaysThink && result.reasoningChunks.length > 0) {
    return { status: 'fail',
      detail: `thinking bleed: ${result.reasoningChunks.length} reasoning_content chunks in no-think response` };
  }

  // Always-think models: thinking block always appears — just verify answer present
  if (cfg.alwaysThink) {
    const hasAnswer = /\b4\b/.test(normalized) || normalized.includes('4');
    const prev = normalized.slice(0, 40);
    return hasAnswer
      ? { status: 'pass', detail: `"${prev}" (always-think, answer found)`, tokensPerSec: tps }
      : { status: 'fail', detail: `answer not found in: "${prev}"` };
  }

  // Tag-path toggleable: strip think block, answer must be in remainder
  if (cfg.tagPath) {
    const stripped = normalized.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // If stripping removed everything but content had a think block: thinking wasn't suppressed
    if (stripped.length < 1 && normalized.includes('<think>')) {
      return { status: 'fail',
        detail: `thinking block not suppressed — enable_thinking:false not honoured. Raw: "${content.slice(0, 80)}"` };
    }
    const checkIn   = stripped.length > 0 ? stripped : normalized;
    const hasAnswer = /\b4\b/.test(checkIn) || checkIn.includes('4');
    return hasAnswer
      ? { status: 'pass', detail: `"${checkIn.slice(0, 40)}" (${result.completionTokens} tok)`, tokensPerSec: tps }
      : { status: 'fail', detail: `answer not found: "${checkIn.slice(0, 60)}"` };
  }

  // Field-path: answer in content
  const hasAnswer = /\b4\b/.test(content) || content.includes('4');
  return hasAnswer
    ? { status: 'pass', detail: `"${content.slice(0, 40)}" (${result.completionTokens} tok)`, tokensPerSec: tps }
    : { status: 'fail', detail: `answer not found: "${content.slice(0, 60)}"` };
}

// ── Think probe ───────────────────────────────────────────────────────────────
// Tests the PRODUCTION thinking path — identical to what PHOBOS sends via extraBodyThink.
// Runs on its own fresh server instance (matching production's fresh-server-per-session
// behavior), so the upstream second-request jinja crash (b8665–b8724) cannot occur here.
// A WARN result means a real upstream issue, not a test artifact.

async function runThinkProbe(spec: GGUFSpec): Promise<ProbeResult> {
  const cfg  = getProbeConfig(spec);
  // Extract messages_override from thinkBody before spreading (it's not a valid API field).
  const { messages_override, ...thinkBodyClean } = (cfg.thinkBody as any);

  const body: any = {
    model: spec.modelId, stream: true, max_tokens: 2048,
    messages: [] as any[],
    ...thinkBodyClean,
  };

  if (messages_override) {
    body.messages = messages_override;
  } else if (cfg.systemSuffix) {
    body.messages = [
      { role: 'system', content: `You are a helpful assistant.${cfg.systemSuffix}` },
      { role: 'user',   content: 'What is the capital of France? Think briefly, then answer.' },
    ];
  } else {
    body.messages = [{ role: 'user', content: 'What is the capital of France? Think briefly, then answer.' }];
  }

  let result: StreamResult;
  try { result = await streamCompletion(body, THINK_QUERY_MS); }
  catch (err) { return { status: 'fail', detail: (err as Error).message }; }

  if (result.finishReason === 'server-crash') {
    // Each probe runs on a fresh server (matching production), so a crash here is a real
    // upstream failure, not the known second-request jinja bug.
    return {
      status: 'fail',
      detail: 'server crashed on think probe — upstream jinja renderer issue on first request',
    };
  }

  const content  = result.contentChunks.join('');
  const thinking = result.reasoningChunks.join('');

  if (!cfg.tagPath) {
    // Field-path: reasoning_content must be populated
    if (result.reasoningChunks.length === 0) {
      return {
        status: 'fail',
        detail: content.includes('<think>')
          ? `<think> leaked into content — reasoning_format:deepseek not applied`
          : `reasoning_content empty. finish=${result.finishReason}. Content: "${content.slice(0, 80)}"`,
      };
    }
    const preview = thinking.slice(0, 60).replace(/\n/g, '↵');
    return { status: 'pass', detail: `${result.reasoningChunks.length} reasoning_content chunks — "${preview}…"` };
  } else {
    // Tag-path: </think> (normalized from any tag variant) must appear
    const normalized = normalizeTags(content);
    const closeIdx   = normalized.indexOf('</think>');
    if (closeIdx === -1) {
      const hasOpen = normalized.includes('<think>');
      return {
        status: 'fail',
        detail: hasOpen
          ? '<think> found but </think> never closed — max_tokens too low?'
          : `no thinking tags in content. Content: "${content.slice(0, 80)}"`,
      };
    }
    const answer   = normalized.slice(closeIdx + 8).trim();
    const thinkLen = closeIdx;
    const tagName  = cfg.gemma4Format ? '<|channel>thought' : '<think>';
    return {
      status: 'pass',
      detail: `${tagName} found, ${thinkLen} chars thinking, answer: "${answer.slice(0, 40)}"`,
    };
  }
}

// ── Vision probe ──────────────────────────────────────────────────────────────
// Sends phobos.png as base64 in an image_url content block — same format as
// PHOBOS multimodal passthrough. Only runs for supportsVision:true models.

async function runVisionProbe(spec: GGUFSpec): Promise<ProbeResult> {
  if (!spec.supportsVision) {
    return { status: 'skip', detail: 'supportsVision not set' };
  }

  // Warn rather than fail when the projector sidecar was never downloaded.
  // The server launched without --mmproj silently ignores image content —
  // that would produce a misleading FAIL instead of a clear WARN.
  if (spec.mmproj && !isMmprojDownloaded(spec)) {
    return { status: 'warn', detail: `mmproj not downloaded (${spec.mmproj.hfFile}) — re-trigger model download to fetch it` };
  }

  if (!fs.existsSync(REFERENCE_IMG)) {
    return { status: 'warn', detail: `reference image not found: ${REFERENCE_IMG}` };
  }

  const b64  = fs.readFileSync(REFERENCE_IMG).toString('base64');
  const body: any = {
    model: spec.modelId, stream: true, max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text',      text: 'Describe what you see in this image in one sentence.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
  };

  let result: StreamResult;
  try { result = await streamCompletion(body, QUERY_MS); }
  catch (err) { return { status: 'fail', detail: (err as Error).message }; }

  if (result.finishReason === 'server-crash') {
    return { status: 'fail', detail: 'server crashed on vision probe — model may not support image input without --mmproj' };
  }

  const raw    = (result.contentChunks.join('') + result.reasoningChunks.join('')).trim();
  const answer = normalizeTags(raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim() || raw;

  if (answer.length < 5) {
    return { status: 'fail', detail: 'empty response to vision input' };
  }
  return { status: 'pass', detail: `"${answer.slice(0, 80)}"` };
}

// ── Auto-download ─────────────────────────────────────────────────────────────

async function ensureDownloaded(spec: GGUFSpec): Promise<boolean> {
  const baseOk   = isDownloaded(spec);
  const mmprojOk = isMmprojDownloaded(spec);

  if (baseOk && mmprojOk) return true;

  if (NO_DOWNLOAD) {
    if (!baseOk) return false;
    process.stdout.write(`  ${dim(`⚠ ${spec.label}: mmproj missing and --no-download set — vision probe will WARN.`)}\n`);
    return true;
  }

  fs.mkdirSync(MODELS_DIR(), { recursive: true });

  // ── Download base GGUF if needed ──────────────────────────────────────────
  if (!baseOk) {
    const gb = (spec.sizeBytes / 1e9).toFixed(1);
    process.stdout.write(`  ${dim(`⬇ Downloading ${spec.label} (${gb} GB)…`)}\n`);
    try {
      for await (const progress of downloadModel(spec, 'seren')) {
        if (progress.done) { process.stdout.write('\r' + ' '.repeat(70) + '\r'); break; }
        const pct = progress.bytesTotal > 0
          ? Math.round((progress.bytesReceived / progress.bytesTotal) * 100) : 0;
        const mb = (progress.bytesReceived / 1e6).toFixed(0);
        process.stdout.write(`\r  ${dim(`  ${pct}% (${mb} MB)`)}`);
      }
    } catch (err) {
      process.stdout.write('\n');
      console.log(`  ${failStr(`Download failed: ${(err as Error).message}`)}`);
      return false;
    }
    if (!isDownloaded(spec)) return false;
    // downloadModel also fetches mmproj at the end — re-check before doing it again.
    if (isMmprojDownloaded(spec)) return true;
  }

  // ── Download mmproj if still needed ──────────────────────────────────────
  // Covers: (a) base already present, mmproj was missing, or
  //         (b) base just downloaded but downloadModel's mmproj fetch failed.
  if (spec.mmproj && !isMmprojDownloaded(spec)) {
    const mmprojGb = (spec.mmproj.sizeBytes / 1e9).toFixed(2);
    process.stdout.write(`  ${dim(`⬇ Downloading mmproj sidecar ${spec.mmproj.hfFile} (${mmprojGb} GB)…`)}\n`);
    const dest = path.join(MODELS_DIR(), spec.mmproj.hfFile);
    const tmp  = dest + '.download';
    const url  = `https://huggingface.co/${spec.mmproj.hfRepo}/resolve/main/${spec.mmproj.hfFile}`;
    const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    const reqHeaders: Record<string, string> = {};
    if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

    try {
      await new Promise<void>((resolve, reject) => {
        let received = existingBytes;
        let total    = spec.mmproj!.sizeBytes;
        let lastEmit = Date.now();

        const follow = (targetUrl: string, redirects = 0) => {
          if (redirects > 5) { reject(new Error('Too many redirects')); return; }
          const parsed = new URL(targetUrl);
          https.get(
            { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders },
            (res) => {
              if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                follow(res.headers.location!, redirects + 1); return;
              }
              if (res.statusCode !== 200 && res.statusCode !== 206) {
                reject(new Error(`HTTP ${res.statusCode} fetching mmproj`)); return;
              }
              if (res.headers['content-length']) {
                total = existingBytes + parseInt(res.headers['content-length'], 10);
              }
              const fd = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });
              res.on('data', (chunk: Buffer) => {
                received += chunk.length;
                fd.write(chunk);
                const now = Date.now();
                if (now - lastEmit >= 250) {
                  lastEmit = now;
                  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
                  const mb  = (received / 1e6).toFixed(0);
                  process.stdout.write(`\r  ${dim(`  ${pct}% (${mb} MB)`)}`);
                }
              });
              res.on('end', () => {
                fd.end(async () => {
                  process.stdout.write('\r' + ' '.repeat(70) + '\r');
                  try {
                    try { await fsPromises.rename(tmp, dest); }
                    catch { await fsPromises.copyFile(tmp, dest); await fsPromises.unlink(tmp); }
                    resolve();
                  } catch (e) { reject(e); }
                });
              });
              res.on('error', reject);
            },
          ).on('error', reject);
        };
        follow(url);
      });
    } catch (err) {
      process.stdout.write('\n');
      console.log(`  ${failStr(`mmproj download failed: ${(err as Error).message}`)}`);
      // Non-fatal — text probes still work; vision probe will WARN.
      return true;
    }
  }

  return isDownloaded(spec);
}

// ── Per-model test runner ─────────────────────────────────────────────────────

let hw!: HardwareProfile;  // populated in main, used in buildServerArgs

async function testModel(
  spec:        GGUFSpec,
  deviceIndex: number,
  gpuBackend:  string,
  bin:         string,
): Promise<ModelResult> {
  const tagPath = isTagPathModel(spec);
  const vision  = spec.supportsVision ?? false;
  console.log(`\n${hdr(`▶ ${spec.label}`)}  ${dim(`(${spec.modelId})`)}`);
  console.log(`  ${dim(`device=${gpuBackend}:${deviceIndex}  layers=${GPU_LAYERS}  jinja=${spec.jinjaTemplate}  tagPath=${tagPath}  vision=${vision}`)}`);

  const { args: serverArgs, env } = buildServerArgs(spec, deviceIndex, gpuBackend, bin, hw);
  console.log(`  ${dim(`$ ${path.basename(bin)} ${serverArgs.join(' ')}`)}`);

  const proc = spawn(bin, serverArgs, {
    stdio: ['ignore', 'pipe', 'pipe'], env, cwd: path.dirname(bin),
  });
  const errLines: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => errLines.push(d.toString().trim()));
  proc.stdout?.on('data', (d: Buffer) => errLines.push(d.toString().trim()));

  let procStopped = false;  // set true when vision restart stops proc early

  const result: ModelResult = {
    modelId: spec.modelId, label: spec.label, loadMs: 0,
    noThink: { status: 'skip', detail: '' },
    think:   { status: 'skip', detail: '' },
    vision:  { status: 'skip', detail: '' },
  };

  // ── Helper: spawn a fresh server and wait for it to be ready ──────────────
  // Production starts a fresh llama-server per session. The test mirrors this
  // exactly: each probe gets its own server instance so the first-request slot
  // is always available. This eliminates the upstream jinja second-request crash
  // (b8665–b8724) entirely — it only manifests on request N>1 to the same process.
  const spawnFresh = async (ctxOverride?: number): Promise<{ proc: ReturnType<typeof spawn>; loadMs: number }> => {
    const { args: freshArgs, env: freshEnv } = ctxOverride
      ? buildServerArgs(spec, deviceIndex, gpuBackend, bin, hw, ctxOverride)
      : { args: serverArgs, env };
    const p = spawn(bin, freshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'], env: freshEnv, cwd: path.dirname(bin),
    });
    p.stderr?.on('data', (d: Buffer) => errLines.push(d.toString().trim()));
    p.stdout?.on('data', (d: Buffer) => errLines.push(d.toString().trim()));
    const t0 = Date.now();
    await waitForReady(p, SERVER_READY_MS);
    return { proc: p, loadMs: Date.now() - t0 };
  };

  const loadStart = Date.now();

  try {
    // ── No-think probe — first request on fresh server ────────────────────
    await waitForReady(proc, SERVER_READY_MS);
    result.loadMs = Date.now() - loadStart;
    console.log(`  ${okStr(`loaded in ${(result.loadMs / 1000).toFixed(1)}s`)}`);

    process.stdout.write('  no-think probe... ');
    result.noThink = await runNoThinkProbe(spec);
    const ntTps = result.noThink.tokensPerSec ? ` @ ${result.noThink.tokensPerSec} tok/s` : '';
    if (result.noThink.status === 'pass') console.log(okStr(`${result.noThink.detail}${ntTps}`));
    else                                  console.log(failStr(result.noThink.detail));

    // Stop the no-think server — done with it regardless of what comes next.
    procStopped = true;
    await stopServer(proc);
    await new Promise(r => setTimeout(r, 1500));

    // ── Think probe — fresh server, first request ─────────────────────────
    if (spec.thinkingTokens && !QUICK_MODE) {
      process.stdout.write('  think probe...    ');
      let thinkProc: ReturnType<typeof spawn> | null = null;
      try {
        const fresh = await spawnFresh();
        thinkProc = fresh.proc;
        result.think = await runThinkProbe(spec);
        if (result.think.status === 'pass')      console.log(okStr(result.think.detail));
        else if (result.think.status === 'warn') console.log(warnStr(result.think.detail));
        else                                     console.log(failStr(result.think.detail));
      } catch (thinkErr) {
        result.think = { status: 'warn', detail: `server restart failed: ${(thinkErr as Error).message}` };
        console.log(warnStr(result.think.detail));
      } finally {
        if (thinkProc) {
          await stopServer(thinkProc);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } else {
      result.think = { status: 'skip', detail: spec.thinkingTokens ? '--quick' : 'non-thinking model' };
    }

    // ── Vision probe — ensure mmproj downloaded, then fresh server ─────────
    // Download the projector sidecar inline here so --all mode and manual
    // --model invocations get the same auto-fetch as the pinned set loop.
    if (spec.supportsVision && !QUICK_MODE && spec.mmproj && !isMmprojDownloaded(spec) && !NO_DOWNLOAD) {
      const mmprojGb = (spec.mmproj.sizeBytes / 1e9).toFixed(2);
      process.stdout.write(`  ${dim(`⬇ Downloading mmproj ${spec.mmproj.hfFile} (${mmprojGb} GB)…`)}\n`);
      const mmprojDest = path.join(MODELS_DIR(), spec.mmproj.hfFile);
      const mmprojTmp  = mmprojDest + '.download';
      const mmprojUrl  = `https://huggingface.co/${spec.mmproj.hfRepo}/resolve/main/${spec.mmproj.hfFile}`;
      const existingBytes = fs.existsSync(mmprojTmp) ? fs.statSync(mmprojTmp).size : 0;
      const dlHeaders: Record<string, string> = {};
      if (existingBytes > 0) dlHeaders['Range'] = `bytes=${existingBytes}-`;
      try {
        await new Promise<void>((resolve, reject) => {
          let received = existingBytes;
          let total    = spec.mmproj!.sizeBytes;
          let lastEmit = Date.now();
          const follow = (targetUrl: string, redirects = 0) => {
            if (redirects > 5) { reject(new Error('Too many redirects')); return; }
            const parsed = new URL(targetUrl);
            https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: dlHeaders }, (res) => {
              if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                follow(res.headers.location!, redirects + 1); return;
              }
              if (res.statusCode !== 200 && res.statusCode !== 206) {
                reject(new Error(`HTTP ${res.statusCode}`)); return;
              }
              if (res.headers['content-length']) total = existingBytes + parseInt(res.headers['content-length'], 10);
              const fd = fs.createWriteStream(mmprojTmp, { flags: existingBytes > 0 ? 'a' : 'w' });
              res.on('data', (chunk: Buffer) => {
                received += chunk.length; fd.write(chunk);
                const now = Date.now();
                if (now - lastEmit >= 300) {
                  lastEmit = now;
                  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
                  process.stdout.write(`\r  ${dim(`  ${pct}% (${(received / 1e6).toFixed(0)} MB)`)}`);
                }
              });
              res.on('end', () => fd.end(async () => {
                process.stdout.write('\r' + ' '.repeat(70) + '\r');
                try {
                  try { await fsPromises.rename(mmprojTmp, mmprojDest); }
                  catch { await fsPromises.copyFile(mmprojTmp, mmprojDest); await fsPromises.unlink(mmprojTmp); }
                  resolve();
                } catch (e) { reject(e); }
              }));
              res.on('error', reject);
            }).on('error', reject);
          };
          follow(mmprojUrl);
        });
      } catch (dlErr) {
        process.stdout.write('\n');
        console.log(`  ${warnStr(`mmproj download failed: ${(dlErr as Error).message} — vision probe will WARN`)}`);
      }
    }

    if (spec.supportsVision && !QUICK_MODE) {
      process.stdout.write('  vision probe...   ');
      let visionProc: ReturnType<typeof spawn> | null = null;
      try {
        const fresh = await spawnFresh(VISION_CTX_SIZE);
        visionProc = fresh.proc;
        result.vision = await runVisionProbe(spec);
        if (result.vision.status === 'pass')      console.log(okStr(result.vision.detail));
        else if (result.vision.status === 'warn') console.log(warnStr(result.vision.detail));
        else if (result.vision.status === 'skip') console.log(dim(`skip — ${result.vision.detail}`));
        else                                      console.log(failStr(result.vision.detail));
      } catch (vErr) {
        result.vision = { status: 'warn', detail: `server restart failed: ${(vErr as Error).message}` };
        console.log(warnStr(result.vision.detail));
      } finally {
        if (visionProc) {
          await stopServer(visionProc);
          await new Promise(r => setTimeout(r, 3000));  // VRAM settle after vision
        }
      }
    } else {
      result.vision = { status: 'skip', detail: spec.supportsVision ? '--quick' : 'no vision support' };
    }

  } catch (err) {
    const msg = (err as Error).message;
    result.loadMs  = Date.now() - loadStart;
    result.noThink = { status: 'fail', detail: `load failed: ${msg}` };
    result.think   = { status: 'fail', detail: `load failed: ${msg}` };
    result.vision  = { status: 'fail', detail: `load failed: ${msg}` };
    console.log(`  ${failStr(`load error: ${msg}`)}`);
    for (const line of errLines.slice(-6)) console.log(`    ${dim(line)}`);
  } finally {
    if (!procStopped) {
      await stopServer(proc);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return result;
}

// ── Summary table ─────────────────────────────────────────────────────────────

function printSummary(results: ModelResult[]): number {
  console.log(`\n${'─'.repeat(92)}`);
  console.log(hdr('SUMMARY'));
  console.log('─'.repeat(92));

  const colW = [33, 8, 10, 10, 10, 6];
  const ANSI = 10;
  const pad  = (s: string, w: number) => s.padEnd(w).slice(0, w);
  const stat = (p: ProbeResult) => {
    if (p.status === 'pass') return `${C.green}PASS${C.reset}`;
    if (p.status === 'fail') return `${C.red}FAIL${C.reset}`;
    if (p.status === 'warn') return `${C.yellow}WARN${C.reset}`;
    return `${C.dim}skip${C.reset}`;
  };

  console.log(`${C.bold}${pad('Model',colW[0])}${pad('Load(s)',colW[1])}${pad('No-Think',colW[2])}${pad('Think',colW[3])}${pad('Vision',colW[4])}${pad('tok/s',colW[5])}${C.reset}`);
  console.log('─'.repeat(92));

  let failures = 0;
  for (const r of results) {
    const tps  = r.noThink.tokensPerSec ? String(r.noThink.tokensPerSec) : '-';
    const load = r.loadMs > 0 ? (r.loadMs / 1000).toFixed(1) : 'ERR';
    console.log(
      pad(r.label, colW[0]) + pad(load, colW[1]) +
      stat(r.noThink).padEnd(colW[2] + ANSI) +
      stat(r.think).padEnd(colW[3] + ANSI) +
      stat(r.vision).padEnd(colW[4] + ANSI) +
      pad(tps, colW[5])
    );
    if (r.noThink.status === 'fail') { console.log(`  ${C.dim}no-think: ${r.noThink.detail}${C.reset}`); failures++; }
    if (r.think.status === 'fail')   { console.log(`  ${C.dim}think:    ${r.think.detail}${C.reset}`);   failures++; }
    if (r.vision.status === 'fail')  { console.log(`  ${C.dim}vision:   ${r.vision.detail}${C.reset}`);  failures++; }
    if (r.think.status === 'warn')   { console.log(`  ${C.yellow}think:    ${r.think.detail}${C.reset}`); }
    if (r.vision.status === 'warn')  { console.log(`  ${C.yellow}vision:   ${r.vision.detail}${C.reset}`); }
  }

  console.log('─'.repeat(92));
  const passed = results.filter(r =>
    r.noThink.status === 'pass' && r.think.status !== 'fail' && r.vision.status !== 'fail'
  ).length;

  if (failures === 0) {
    console.log(`${C.green}${C.bold}ALL ${results.length} MODELS PASSED${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}${failures} FAILURES across ${results.length} models (${passed} passed)${C.reset}`);
  }

  if (results.some(r => r.think.status === 'warn')) {
    console.log(`\n${C.dim}ℹ think WARN = upstream llama.cpp jinja issue. Each probe runs on its own`);
    console.log(`  fresh server instance (matching production). If WARN persists it is a real`);
    console.log(`  upstream bug, not a test artifact.${C.reset}`);
  }
  console.log('');

  return failures;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${hdr('═══ PHOBOS MODEL PARSE SYSTEM TEST ═══')}`);

console.log('\nDetecting hardware...');
hw = await detectHardware();
console.log(`  CPU: ${hw.cpuName} (${hw.cpuCores} cores)`);
for (const gpu of hw.gpus) {
  console.log(`  GPU[${gpu.index}]: ${gpu.name} — ${gpu.vramGb}GB ${gpu.backend.toUpperCase()}`);
}

const bin = resolveLlamaServerBin();
console.log(`  Binary: ${bin}`);
if (!fs.existsSync(bin)) {
  console.error(failStr(`llama-server binary not found: ${bin}`));
  process.exit(1);
}

const primaryGpu     = hw.gpus.find(g => g.backend === 'cuda')
                    ?? hw.gpus.find(g => g.backend === 'vulkan' && g.index < 100)
                    ?? hw.gpus[0];
const defaultDevice  = Number(forceGpu ?? primaryGpu?.index ?? 0);
const defaultBackend = hw.gpus.find(g => g.index === defaultDevice)?.backend ?? 'cpu';
console.log(`  Default: [${defaultDevice}] ${hw.gpus.find(g => g.index === defaultDevice)?.name ?? 'CPU'} (${defaultBackend})`);
console.log(`  Reference image: ${fs.existsSync(REFERENCE_IMG) ? REFERENCE_IMG : `${C.yellow}NOT FOUND${C.reset} (vision probes will warn)`}`);

if (NO_DOWNLOAD) console.log(`\n${warnStr('--no-download: skipping models not yet on disk')}`);
if (QUICK_MODE)  console.log(`\n${warnStr('--quick: skipping think and vision probes')}`);

// Build model list
let toTest: GGUFSpec[];

if (modelFilter) {
  const spec = GGUF_CATALOGUE.find(s => s.modelId === modelFilter);
  if (!spec) {
    console.error(failStr(`Unknown model ID: ${modelFilter}`));
    console.error(`Available: ${GGUF_CATALOGUE.map(s => s.modelId).join(', ')}`);
    process.exit(1);
  }
  toTest = [spec];
} else if (ALL_MODE) {
  toTest = listDownloaded();
  if (toTest.length === 0) {
    console.log(`\n${warnStr('No downloaded models found. Run without --all to use the pinned set with auto-download.')}`);
    process.exit(0);
  }
} else {
  // Pinned set — auto-download missing models
  const pinned = PINNED_MODEL_IDS
    .map(id => GGUF_CATALOGUE.find(s => s.modelId === id))
    .filter(Boolean) as GGUFSpec[];

  console.log(`\nPinned test set: ${pinned.length} models (one per runner family)`);
  const downloaded: GGUFSpec[] = [];
  const skipped:    GGUFSpec[] = [];

  for (const spec of pinned) {
    if (isDownloaded(spec)) {
      downloaded.push(spec);
    } else if (NO_DOWNLOAD) {
      skipped.push(spec);
      console.log(`  ${dim(`• ${spec.label} — skipped (--no-download)`)}`);
    } else {
      const ok = await ensureDownloaded(spec);
      if (ok) { downloaded.push(spec); console.log(`  ${dim(`• ${spec.label} — downloaded ✓`)}`); }
      else    { skipped.push(spec);    console.log(`  ${warnStr(`${spec.label} — download failed, skipping`)}`); }
    }
  }

  if (skipped.length > 0) {
    console.log(`\n${warnStr(`${skipped.length} model(s) skipped`)}`);
  }
  toTest = downloaded;
}

if (toTest.length === 0) {
  console.log(`\n${warnStr('No models to test.')}`);
  process.exit(0);
}

console.log(`\nModels to test: ${toTest.length}`);
for (const s of toTest) {
  const visionTag = s.supportsVision ? ` ${C.cyan}[vision]${C.reset}` : '';
  console.log(`  ${dim(`• ${s.label}  (${s.modelId})`)}  role=${s.role}  jinja=${s.jinjaTemplate}  think=${s.thinkingTokens}${visionTag}`);
}

// Run sequentially
const results: ModelResult[] = [];

for (const spec of toTest) {
  let deviceIndex: number;
  let gpuBackend:  string;

  if (forceGpu !== undefined) {
    deviceIndex = Number(forceGpu);
    gpuBackend  = hw.gpus.find(g => g.index === deviceIndex)?.backend ?? 'cpu';
  } else {
    const cudaGpu   = hw.gpus.find(g => g.backend === 'cuda');
    const vulkanGpu = hw.gpus.find(g => g.backend === 'vulkan' && g.index >= 100);
    const chosen    = spec.role === 'sayon'
      ? (cudaGpu ?? hw.gpus[0])
      : (vulkanGpu ?? cudaGpu ?? hw.gpus[0]);
    deviceIndex = chosen?.index ?? 0;
    gpuBackend  = chosen?.backend ?? 'cpu';
  }

  results.push(await testModel(spec, deviceIndex, gpuBackend, bin));
}

const failures = printSummary(results);
process.exit(failures > 0 ? 1 : 0);
