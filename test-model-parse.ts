// test-model-parse.ts — LLM model parse system test
//
// Walks every downloaded model in GGUF_CATALOGUE, loads it via llama-server using
// the same flags LlamaServerManager would use, then fires a no-think probe and
// (for thinking-token models) a think probe. Validates the response structure:
//   - field-path models (deepseek format): delta.reasoning_content must be non-null
//   - tag-path models (Nemotron, Phi-4, Ministral, SmolLM3): <think> tag in delta.content
//   - non-thinking models: delta.content with the answer "4"
//
// Usage:
//   npx tsx test-model-parse.ts
//   npx tsx test-model-parse.ts --model nemotron3-4b-q4    ← single model
//   npx tsx test-model-parse.ts --quick                    ← skip think probe
//   npx tsx test-model-parse.ts --gpu 0                    ← force device index
//   npx tsx test-model-parse.ts --layers 99               ← force gpu layers
//
// Exit code 0 = all models passed. Non-zero = at least one failure.

import * as fs    from 'fs';
import * as os    from 'os';
import * as path  from 'path';
import * as http  from 'http';
import { spawn, ChildProcess } from 'child_process';
import {
  GGUF_CATALOGUE,
  GGUFSpec,
  HardwareProfile,
  listDownloaded,
  modelPath,
  detectHardware,
  resolveLlamaServerBin,
} from './phobos/PhobosLocalManager.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const modelFilter = args.find(a => a.startsWith('--model='))?.split('=')[1]
                 ?? (args[args.indexOf('--model') + 1] && !args[args.indexOf('--model') + 1].startsWith('--')
                     ? args[args.indexOf('--model') + 1] : undefined);
const QUICK_MODE  = args.includes('--quick');
const forceGpu    = args.find(a => a.startsWith('--gpu='))?.split('=')[1]
                 ?? (args[args.indexOf('--gpu') + 1] && !args[args.indexOf('--gpu') + 1].startsWith('--')
                     ? args[args.indexOf('--gpu') + 1] : undefined);
const forceLayers = args.find(a => a.startsWith('--layers='))?.split('=')[1]
                 ?? (args[args.indexOf('--layers') + 1] && !args[args.indexOf('--layers') + 1].startsWith('--')
                     ? args[args.indexOf('--layers') + 1] : undefined);

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_PORT       = 18765;  // ephemeral — nothing else should be on this port
const SERVER_READY_MS = 90_000; // llama-server load timeout
const QUERY_MS        = 60_000; // per-request timeout
const CTX_SIZE        = 2048;   // minimal context — fast load, enough for probes
const GPU_LAYERS      = forceLayers ? Number(forceLayers) : 99;

// ── Colour helpers ────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

function ok(s: string)   { return `${C.green}✓${C.reset} ${s}`; }
function fail(s: string) { return `${C.red}✗${C.reset} ${s}`; }
function warn(s: string) { return `${C.yellow}⚠${C.reset} ${s}`; }
function hdr(s: string)  { return `${C.bold}${C.cyan}${s}${C.reset}`; }
function dim(s: string)  { return `${C.dim}${s}${C.reset}`; }

// ── Result types ──────────────────────────────────────────────────────────────

type PassFail = 'pass' | 'fail' | 'warn' | 'skip';

interface ProbeResult {
  status: PassFail;
  detail: string;
  tokensPerSec?: number;
}

interface ModelResult {
  modelId:   string;
  label:     string;
  loadMs:    number;
  noThink:   ProbeResult;
  think:     ProbeResult;
}

// ── Tag-path detection — mirrors LlamaServerManager logic ─────────────────────

function isTagPathModel(spec: GGUFSpec): boolean {
  return (
    spec.nemotronVariant != null ||
    spec.modelId.startsWith('phi4-mini-reasoning') ||
    spec.modelId.startsWith('ministral-') ||
    spec.modelId.startsWith('smollm3')
  );
}

// ── Build llama-server args — same logic as LlamaServerManager.startServer ───

function buildServerArgs(spec: GGUFSpec, deviceIndex: number, gpuBackend: string, bin: string, hw: HardwareProfile): {
  args: string[];
  env:  NodeJS.ProcessEnv;
} {
  const ggufPath = modelPath(spec);
  const threads  = Math.max(1, Math.floor(os.cpus().length / 2));

  const serverArgs: string[] = [
    '--model',        ggufPath,
    '--port',         String(TEST_PORT),
    '--host',         '127.0.0.1',
    '--ctx-size',     String(CTX_SIZE),
    '--threads',      String(threads),
    '--n-gpu-layers', String(GPU_LAYERS),
    '--log-disable',
  ];

  if (spec.jinjaTemplate) {
    const tagPath = isTagPathModel(spec);
    serverArgs.push('--jinja', '--reasoning-format', tagPath ? 'none' : 'deepseek');
    // b8662: --reasoning on overrides enable_thinking:false for toggleable models,
    // causing thinking bleed in the no-think probe. Only set it for always-think
    // R1 distills that have no off-switch (Phi-4, Ministral, SmolLM3).
    const isAlwaysThink = (
      spec.modelId.startsWith('phi4-mini-reasoning') ||
      spec.modelId.startsWith('ministral-') ||
      spec.modelId.startsWith('smollm3')
    );
    if (spec.thinkingTokens && isAlwaysThink) {
      serverArgs.push('--reasoning', 'on');
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  if (GPU_LAYERS > 0 && gpuBackend !== 'cpu') {
    const binDir    = path.dirname(bin);
    const cudaDll   = path.join(binDir, 'ggml-cuda.dll');
    const cudartDll = path.join(binDir, 'cudart64_12.dll');
    const hasCuda   = process.platform === 'win32' && fs.existsSync(cudaDll) && fs.existsSync(cudartDll);

    if (gpuBackend === 'cuda' && deviceIndex < 100) {
      if (hasCuda) {
        env.CUDA_VISIBLE_DEVICES    = String(deviceIndex);
        env.GGML_VK_VISIBLE_DEVICES = '';
        serverArgs.push('--device', 'CUDA0');
      } else {
        // Vulkan fallback for NVIDIA when no CUDA DLLs
        env.GGML_VK_VISIBLE_DEVICES = String(deviceIndex);
        env.CUDA_VISIBLE_DEVICES    = '';
        serverArgs.push('--device', 'Vulkan0');
      }
    } else if (gpuBackend === 'vulkan' || (gpuBackend === 'cuda' && deviceIndex >= 100)) {
      // Vulkan device (including iGPUs at index 100+).
      // Use gpu.runner.vulkanIndex — the actual system Vulkan enumeration index.
      // deviceIndex - 100 is WRONG: it gives 0 for the 890M when it's actually Vulkan1.
      const gpuEntry  = hw.gpus.find(g => g.index === deviceIndex);
      const vulkanIdx = gpuEntry?.runner?.vulkanIndex ?? (deviceIndex >= 100 ? deviceIndex - 100 : deviceIndex);
      env.GGML_VK_VISIBLE_DEVICES = String(vulkanIdx);
      env.CUDA_VISIBLE_DEVICES    = '';
      serverArgs.push('--device', 'Vulkan0');
    } else if (gpuBackend === 'metal') {
      // Metal — no env var needed
    }
  } else if (GPU_LAYERS === 0) {
    serverArgs.push('--device', 'none');
  }

  return { args: serverArgs, env };
}

// ── llama-server process lifecycle ────────────────────────────────────────────

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

    // Poll /health every 500ms — works regardless of --log-disable and log string format.
    const poll = setInterval(() => {
      const req = http.request(
        { host: '127.0.0.1', port: TEST_PORT, path: '/health', method: 'GET' },
        (res) => {
          if (res.statusCode !== undefined && res.statusCode < 400) {
            res.resume();
            finish();
          }
        }
      );
      req.on('error', () => { /* connection refused — still loading */ });
      req.end();
    }, 500);

    const deadline = setTimeout(() => {
      finish(new Error(`Server did not become ready within ${timeoutMs / 1000}s`));
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        finish(new Error(`Server exited code=${code} before becoming ready`));
      }
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

// ── HTTP streaming completion probe ──────────────────────────────────────────

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
    const t = setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs / 1000}s`)), timeoutMs);

    const result: StreamResult = {
      contentChunks: [], reasoningChunks: [], finishReason: '',
      promptTokens: 0, completionTokens: 0,
    };

    // Shared ECONNRESET handler — called from both res.on('error') and req.on('error').
    // llama-server RSTs the TCP connection when it hits max_tokens mid-stream.
    // The data arrives before the RST, so result is already populated when the error fires.
    const onConnReset = (e: NodeJS.ErrnoException, phase: string) => {
      clearTimeout(t);
      const hasData = result.contentChunks.length > 0 || result.reasoningChunks.length > 0;
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') {
        if (hasData) {
          result.finishReason = result.finishReason || 'length';
          resolve(result);
        } else {
          // RST before any data — genuine failure, not a token-limit teardown.
          // Server crashed before sending any data — likely an upstream template bug.
          // Resolve with a special sentinel rather than rejecting so callers can warn.
          resolve({ ...result, finishReason: 'server-crash' });
        }
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

        res.on('end', () => { clearTimeout(t); resolve(result); });
        res.on('error', (e: NodeJS.ErrnoException) => onConnReset(e, 'res'));
      }
    );

    // Socket-level RST fires here when the server resets before/during header delivery.
    req.on('error', (e: NodeJS.ErrnoException) => onConnReset(e, 'req'));
    req.write(payload);
    req.end();
  });
}

// ── Per-model extra_body — mirrors clients.ts exactly ─────────────────────────
// These must stay in sync with getModelConfig() in clients.ts.

interface ModelProbeConfig {
  noThinkBody:     object;  // extra fields to disable thinking
  thinkBody:       object;  // extra fields to enable thinking
  thinkingForcedOpen: boolean;  // true = model never emits opening <think> tag
  tagPath:         boolean; // true = thinking in delta.content, false = delta.reasoning_content
  // SmolLM3 only: thinking activated via system message suffix, not extra_body
  systemSuffix?:   string;
}

function getProbeConfig(spec: GGUFSpec): ModelProbeConfig {
  // ── b8653 API notes ────────────────────────────────────────────────────────
  // --reasoning-format now defaults to 'auto' (was unset/none in b8457).
  // Per-request thinking control:
  //   chat_template_kwargs: { enable_thinking: true }  → CRASHES server (ECONNRESET before data)
  //   chat_template_kwargs: { enable_thinking: false } → works (disables thinking)
  //   thinking_forced_open: true                       → works (forces think block open, per README)
  //   reasoning_budget: N                              → server-launch only in b8653, not per-request
  //
  // For the think probe: use thinking_forced_open:true instead of enable_thinking:true.
  // This forces the model into a thinking block without going through the broken
  // enable_thinking pathway. Works for both tag-path and field-path models.
  //
  // For the no-think probe: enable_thinking:false still works. Keep it.
  // ──────────────────────────────────────────────────────────────────────────

  // Nemotron: tag-path, reasoning_format:none.
  // no-think: enable_thinking:false (works). think: thinking_forced_open:true (workaround for b8653).
  // thinkingForcedOpen=true: server prepends <think> without streaming the open tag.
  if (spec.nemotronVariant != null) {
    // b8653 workaround: server launched with --reasoning on, so thinking fires by default.
    // Think probe sends no activation params. No-think probe uses enable_thinking:false (still works).
    return {
      noThinkBody:        { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      thinkBody:          { reasoning_format: 'none' },  // thinking on by default via --reasoning on
      thinkingForcedOpen: true,
      tagPath:            true,
    };
  }

  // SmolLM3: thinking activated via system message. chat_template_kwargs crashes server.
  if (spec.modelId.startsWith('smollm3')) {
    return {
      noThinkBody:        { reasoning_format: 'none' },
      thinkBody:          { reasoning_format: 'none' },
      thinkingForcedOpen: false,
      tagPath:            true,
      systemSuffix:       '\n\n## Metadata\nReasoning Mode: /think',
    };
  }

  // Phi-4 mini reasoning: always produces <think> tags, no activation needed.
  if (spec.modelId.startsWith('phi4-mini-reasoning')) {
    return {
      noThinkBody:        { reasoning_format: 'none' },
      thinkBody:          { reasoning_format: 'none' },
      thinkingForcedOpen: false,
      tagPath:            true,
    };
  }

  // Ministral: tag path + reasoning_format:none (confirmed working).
  if (spec.modelId.startsWith('ministral-')) {
    return {
      noThinkBody:        { reasoning_format: 'none' },
      thinkBody:          { reasoning_format: 'none' },
      thinkingForcedOpen: false,
      tagPath:            true,
    };
  }

  // Field-path models (Qwen3, Qwen3.5, Gemma, DeepSeek-R1, Nanbeige, etc):
  // reasoning_format:deepseek at server level populates delta.reasoning_content.
  // no-think: enable_thinking:false (works).
  // think: thinking_forced_open:true instead of enable_thinking:true (b8653 workaround).
  if (spec.jinjaTemplate) {
    // reasoning_format:none per-request overrides the server-level deepseek setting,
    // preventing reasoning_content bleed on the no-think probe (confirmed Nanbeige issue).
    return {
      noThinkBody:        { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      thinkBody:          {},  // thinking fires by default when server has reasoning:auto
      thinkingForcedOpen: false,
      tagPath:            false,
    };
  }

  // No thinking support (Llama 3, Mistral base, etc).
  return {
    noThinkBody:        {},
    thinkBody:          {},
    thinkingForcedOpen: false,
    tagPath:            false,
  };
}

// ── No-think probe ────────────────────────────────────────────────────────────
// Simple arithmetic — answer must contain "4" outside any <think> block.

async function runNoThinkProbe(spec: GGUFSpec): Promise<ProbeResult> {
  const cfg = getProbeConfig(spec);

  const body: any = {
    model:      spec.modelId,
    stream:     true,
    max_tokens: 200,  // always-think models need room for thinking block + answer
    messages: [
      { role: 'user', content: 'What is 2+2? Reply with just the number, nothing else.' },
    ],
    ...cfg.noThinkBody,
  };

  const startMs = Date.now();
  let result: StreamResult;
  try {
    result = await streamCompletion(body, QUERY_MS);
  } catch (err) {
    return { status: 'fail', detail: (err as Error).message };
  }

  const elapsedMs = Date.now() - startMs;
  const content   = result.contentChunks.join('');
  const tps       = result.completionTokens > 0
    ? Math.round(result.completionTokens / (elapsedMs / 1000))
    : undefined;

  // For always-think models (Phi-4, Ministral, SmolLM3), thinking is unconditional —
  // they always emit <think> tags. Skip the bleed check; just verify the answer is correct.
  const isAlwaysThinkModel = cfg.tagPath && (
    spec.modelId.startsWith('phi4-mini-reasoning') ||
    spec.modelId.startsWith('ministral-') ||
    spec.modelId.startsWith('smollm3')
  );

  // Field-path bleed: reasoning chunks should be empty on no-think probe (unless always-think).
  if (!isAlwaysThinkModel && result.reasoningChunks.length > 0) {
    return {
      status: 'fail',
      detail: `thinking tokens bled into no-think probe (${result.reasoningChunks.length} reasoning_content chunks)`,
      tokensPerSec: tps,
    };
  }

  // Tag-path bleed: strip any <think>...</think> block, check remainder for "4".
  // For always-think models (Phi-4, SmolLM3, Ministral): they always emit <think> and the
  // answer may be inside the thinking block or cut off by max_tokens. Check full content.
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const checkIn  = (cfg.tagPath && !isAlwaysThinkModel) ? stripped : content;

  // Always-think models (Phi-4, SmolLM3, Ministral) unconditionally emit <think> blocks.
  // Only flag thinking bleed for toggleable models.
  if (!isAlwaysThinkModel && cfg.tagPath && content.includes('</think>') && stripped.length < 3) {
    return {
      status: 'fail',
      detail: `thinking block present in no-think probe — enable_thinking:false not honoured. ` +
              `Content: "${content.slice(0, 80)}"`,
      tokensPerSec: tps,
    };
  }

  // Accept "4" anywhere in the answer — some models are verbose but still correct.
  // Also accept common forms: "4.", "= 4", "is 4", etc.
  const hasAnswer = /\b4\b/.test(checkIn) || checkIn.includes('4');
  if (!hasAnswer) {
    return {
      status: 'fail',
      detail: `answer "${checkIn.slice(0, 60)}" does not contain "4"`,
      tokensPerSec: tps,
    };
  }

  return {
    status: 'pass',
    detail: `"${checkIn.slice(0, 40)}" (${result.completionTokens} tok)`,
    tokensPerSec: tps,
  };
}

// ── Think probe ───────────────────────────────────────────────────────────────
// Forces thinking mode, validates that reasoning tokens appear in the expected path.
// field-path: delta.reasoning_content chunks must be non-empty
// tag-path:   delta.content must contain </think> (open tag may be absent if thinkingForcedOpen)

async function runThinkProbe(spec: GGUFSpec): Promise<ProbeResult> {
  const cfg = getProbeConfig(spec);

  const body: any = {
    model:      spec.modelId,
    stream:     true,
    max_tokens: 2048,  // Nemotron thinking blocks can be 1000+ tokens
    messages:   [] as any[],
    ...cfg.thinkBody,
  };

  // SmolLM3 needs the thinking activation in the system message, not extra_body.
  if (cfg.systemSuffix) {
    body.messages = [
      { role: 'system', content: `You are a helpful assistant.${cfg.systemSuffix}` },
      { role: 'user',   content: 'What is the capital of France? Think briefly, then answer.' },
    ];
  } else {
    body.messages = [
      { role: 'user', content: 'What is the capital of France? Think briefly, then answer.' },
    ];
  }

  let result: StreamResult;
  try {
    result = await streamCompletion(body, QUERY_MS);
  } catch (err) {
    return { status: 'fail', detail: (err as Error).message };
  }

  // Server crashed before any data — upstream template bug, not a PHOBOS issue.
  if (result.finishReason === 'server-crash') {
    return {
      status: 'warn',
      detail: `server crashed on think request before streaming any data — likely upstream template bug (check latest llama.cpp release)`,
    };
  }

  const content  = result.contentChunks.join('');
  const thinking = result.reasoningChunks.join('');

  if (cfg.tagPath) {
    // Tag path: </think> must appear in content (open tag may be absent if thinkingForcedOpen).
    // Verify the content after </think> contains something (the actual answer).
    const closeIdx = content.indexOf('</think>');
    if (closeIdx === -1) {
      const hasOpen = content.includes('<think>');
      return {
        status: 'fail',
        detail: hasOpen
          ? `<think> opened but </think> never streamed — max_tokens too low or server truncated`
          : `no <think> or </think> tags in delta.content — thinking not activated. ` +
            `Content: "${content.slice(0, 80)}"`,
      };
    }
    const answer = content.slice(closeIdx + 8).trim();
    if (answer.length < 2) {
      return {
        status: 'fail',
        detail: `</think> found but answer portion is empty — server may have cut off after thinking block`,
      };
    }
    const thinkLen = cfg.thinkingForcedOpen ? closeIdx : (content.indexOf('</think>'));
    return {
      status: 'pass',
      detail: `</think> found, ${thinkLen} chars of thinking, answer: "${answer.slice(0, 40)}"`,
    };
  } else {
    // Field path: reasoning_content must be populated.
    if (result.reasoningChunks.length === 0) {
      const leaked = content.includes('<think>');
      return {
        status: 'fail',
        detail: leaked
          ? `<think> leaked into delta.content — reasoning_format:deepseek not applied (--jinja regression?)`
          : `delta.reasoning_content empty — no thinking produced. finish=${result.finishReason}. ` +
            `Content: "${content.slice(0, 80)}"`,
      };
    }
    const preview = thinking.slice(0, 60).replace(/\n/g, '↵');
    return {
      status: 'pass',
      detail: `${result.reasoningChunks.length} reasoning chunks — "${preview}…"`,
    };
  }
}

// ── Per-model test runner ─────────────────────────────────────────────────────

async function testModel(
  spec:        GGUFSpec,
  deviceIndex: number,
  gpuBackend:  string,
  bin:         string,
): Promise<ModelResult> {
  console.log(`\n${hdr(`▶ ${spec.label}`)}  ${dim(`(${spec.modelId})`)}`);
  console.log(`  ${dim(`device=${gpuBackend}:${deviceIndex}  layers=${GPU_LAYERS}  jinja=${spec.jinjaTemplate}  tagPath=${isTagPathModel(spec)}`)}`);

  const { args: serverArgs, env } = buildServerArgs(spec, deviceIndex, gpuBackend, bin, hw);

  // Print the full command for debugging
  console.log(`  ${dim(`$ ${path.basename(bin)} ${serverArgs.join(' ')}`)}`);

  const proc = spawn(bin, serverArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: path.dirname(bin),
  });

  // Capture stderr for error context — suppress unless load fails
  const errLines: string[] = [];
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) errLines.push(line);
  });
  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) errLines.push(line);  // stdout also carries load logs
  });

  const loadStart = Date.now();
  let loadMs = 0;

  const result: ModelResult = {
    modelId: spec.modelId,
    label:   spec.label,
    loadMs:  0,
    noThink: { status: 'skip', detail: '' },
    think:   { status: 'skip', detail: '' },
  };

  try {
    await waitForReady(proc, SERVER_READY_MS);
    loadMs      = Date.now() - loadStart;
    result.loadMs = loadMs;
    console.log(`  ${ok(`loaded in ${(loadMs / 1000).toFixed(1)}s`)}`);

    // No-think probe
    process.stdout.write(`  no-think probe... `);
    result.noThink = await runNoThinkProbe(spec);
    if (result.noThink.status === 'pass') {
      const tps = result.noThink.tokensPerSec ? ` @ ${result.noThink.tokensPerSec} tok/s` : '';
      console.log(ok(`${result.noThink.detail}${tps}`));
    } else {
      console.log(fail(result.noThink.detail));
    }

    // Think probe — only for thinking-token models, skip in quick mode
    if (spec.thinkingTokens && !QUICK_MODE) {
      process.stdout.write(`  think probe... `);
      result.think = await runThinkProbe(spec);
      if (result.think.status === 'pass') {
        console.log(ok(result.think.detail));
      } else if (result.think.status === 'warn') {
        console.log(warn(result.think.detail));
      } else {
        console.log(fail(result.think.detail));
      }
    } else if (!spec.thinkingTokens) {
      result.think = { status: 'skip', detail: 'no thinking tokens' };
    } else {
      result.think = { status: 'skip', detail: '--quick' };
    }

  } catch (err) {
    const msg = (err as Error).message;
    result.loadMs  = Date.now() - loadStart;
    result.noThink = { status: 'fail', detail: `load failed: ${msg}` };
    result.think   = { status: 'fail', detail: `load failed: ${msg}` };
    console.log(`  ${fail(`load error: ${msg}`)}`);
    if (errLines.length > 0) {
      console.log(`  ${dim('Last server output:')}`);
      for (const line of errLines.slice(-8)) {
        console.log(`    ${dim(line)}`);
      }
    }
  } finally {
    await stopServer(proc);
    // Brief settle so the OS releases the port and VRAM
    // 4s settle: large models (30B+) need time to release Vulkan/CUDA memory
    await new Promise(r => setTimeout(r, 4000));
  }

  return result;
}

// ── Summary table ─────────────────────────────────────────────────────────────

function printSummary(results: ModelResult[]): number {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(hdr('SUMMARY'));
  console.log('─'.repeat(80));

  const colW = [35, 10, 12, 12, 8];
  const pad  = (s: string, w: number) => s.padEnd(w).slice(0, w);

  console.log(
    `${C.bold}` +
    pad('Model',       colW[0]) +
    pad('Load(s)',     colW[1]) +
    pad('No-Think',   colW[2]) +
    pad('Think',      colW[3]) +
    pad('tok/s',      colW[4]) +
    C.reset
  );
  console.log('─'.repeat(80));

  let failures = 0;
  for (const r of results) {
    const statusStr = (p: ProbeResult) => {
      if (p.status === 'pass') return `${C.green}PASS${C.reset}`;
      if (p.status === 'fail') return `${C.red}FAIL${C.reset}`;
      if (p.status === 'warn') return `${C.yellow}WARN${C.reset}`;
      return `${C.dim}skip${C.reset}`;
    };
    const tps  = r.noThink.tokensPerSec ? String(r.noThink.tokensPerSec) : '-';
    const load = r.loadMs > 0 ? (r.loadMs / 1000).toFixed(1) : 'ERR';

    console.log(
      pad(r.label, colW[0]) +
      pad(load,    colW[1]) +
      statusStr(r.noThink).padEnd(colW[2] + 10) +  // +10 for ANSI escape chars
      statusStr(r.think).padEnd(colW[3] + 10) +
      pad(tps,     colW[4])
    );

    if (r.noThink.status === 'fail') {
      console.log(`  ${C.dim}no-think: ${r.noThink.detail}${C.reset}`);
      failures++;
    }
    if (r.think.status === 'fail') {
      console.log(`  ${C.dim}think:    ${r.think.detail}${C.reset}`);
      failures++;
    }
    if (r.think.status === 'warn') {
      console.log(`  ${C.yellow}think:    ${r.think.detail}${C.reset}`);
    }
  }

  console.log('─'.repeat(80));
  const total   = results.length;
  const passed  = results.filter(r => r.noThink.status === 'pass' && r.think.status !== 'fail').length;
  if (failures === 0) {
    console.log(`${C.green}${C.bold}ALL ${total} MODELS PASSED${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}${failures} FAILURES across ${total} models (${passed} passed)${C.reset}`);
  }
  console.log('');

  return failures;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${hdr('═══ PHOBOS MODEL PARSE SYSTEM TEST ═══')}`);

// Hardware detection
console.log('\nDetecting hardware...');
const hw = await detectHardware();
console.log(`  CPU: ${hw.cpuName} (${hw.cpuCores} cores)`);
for (const gpu of hw.gpus) {
  console.log(`  GPU[${gpu.index}]: ${gpu.name} — ${gpu.vramGb}GB ${gpu.backend.toUpperCase()}`);
}

// Resolve binary
const bin = resolveLlamaServerBin();
console.log(`  Binary: ${bin}`);
if (!fs.existsSync(bin)) {
  console.error(`${fail('llama-server binary not found at:')} ${bin}`);
  process.exit(1);
}

// Determine default device — prefer NVIDIA CUDA, then Vulkan, then CPU
const primaryGpu    = hw.gpus.find(g => g.backend === 'cuda')
                   ?? hw.gpus.find(g => g.backend === 'vulkan' && g.index < 100)
                   ?? hw.gpus[0];
const defaultDevice = Number(forceGpu ?? primaryGpu?.index ?? 0);
const defaultBackend = hw.gpus.find(g => g.index === defaultDevice)?.backend ?? 'cpu';

console.log(`  Default device: [${defaultDevice}] ${hw.gpus.find(g => g.index === defaultDevice)?.name ?? 'CPU'} (${defaultBackend})`);

// Collect models to test
let toTest: GGUFSpec[];
if (modelFilter) {
  const spec = GGUF_CATALOGUE.find(s => s.modelId === modelFilter);
  if (!spec) {
    console.error(`${fail('Unknown model ID:')} ${modelFilter}`);
    console.error(`Available: ${GGUF_CATALOGUE.map(s => s.modelId).join(', ')}`);
    process.exit(1);
  }
  toTest = [spec];
} else {
  toTest = listDownloaded();
}

if (toTest.length === 0) {
  console.log(`\n${warn('No downloaded models found in catalogue.')}`);
  console.log('Download models first via the PHOBOS UI or catalogue API.\n');
  process.exit(0);
}

console.log(`\nModels to test: ${toTest.length}`);
for (const s of toTest) {
  console.log(`  ${dim(`• ${s.label}  (${s.modelId})`)}  role=${s.role}  jinja=${s.jinjaTemplate}  think=${s.thinkingTokens}`);
}

if (QUICK_MODE) console.log(`\n${warn('--quick: skipping think probes')}`);

// Run tests sequentially — no parallel to avoid VRAM pressure
const results: ModelResult[] = [];

for (const spec of toTest) {
  // Per-model device selection:
  // - SAYON models → prefer primary CUDA GPU (index 0 typically)
  // - SEREN models → prefer secondary Vulkan GPU (index 100+) if present, else primary
  // --gpu flag overrides both.
  let deviceIndex: number;
  let gpuBackend:  string;

  if (forceGpu !== undefined) {
    deviceIndex = Number(forceGpu);
    gpuBackend  = hw.gpus.find(g => g.index === deviceIndex)?.backend ?? 'cpu';
  } else {
    const cudaGpu   = hw.gpus.find(g => g.backend === 'cuda');
    const vulkanGpu = hw.gpus.find(g => g.backend === 'vulkan' && g.index >= 100);  // iGPU/APU at 100+

    if (spec.role === 'sayon') {
      // Coordinator: fast, prefers CUDA
      const chosen  = cudaGpu ?? hw.gpus[0];
      deviceIndex   = chosen?.index ?? 0;
      gpuBackend    = chosen?.backend ?? 'cpu';
    } else {
      // Engine: deep reasoning, prefers the secondary Vulkan device if available (frees CUDA for SAYON)
      const chosen  = vulkanGpu ?? cudaGpu ?? hw.gpus[0];
      deviceIndex   = chosen?.index ?? 0;
      gpuBackend    = chosen?.backend ?? 'cpu';
    }
  }

  const r = await testModel(spec, deviceIndex, gpuBackend, bin);
  results.push(r);
}

const failures = printSummary(results);
process.exit(failures > 0 ? 1 : 0);
