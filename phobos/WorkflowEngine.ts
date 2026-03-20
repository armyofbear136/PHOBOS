import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as crypto from 'crypto';

import {
  generateImage,
  nodeOutputExt,
  type SdServerConfig,
  type GenerateImageOptions,
} from './ImageServerManager.js';

import {
  generateFaceMask,
  generateHandMask,
  generateDepthMap,
  removeBackground,
  flattenAlpha,
} from './VisionProcessor.js';

import {
  getImageModelSpec,
  isImageModelDownloaded,
} from './PhobosLocalManager.js';

// ── Workspace root (mirrors convention across codebase) ───────────────────────

function workspacesRoot(): string {
  return process.env.WORKSPACES_ROOT
    ? path.resolve(process.env.WORKSPACES_ROOT)
    : path.resolve(process.cwd(), 'workspaces');
}

function workflowsDir(threadId: string): string {
  return path.join(workspacesRoot(), threadId, 'workflows');
}

function sessionDir(threadId: string, workflowId: string): string {
  return path.join(workflowsDir(threadId), workflowId);
}

function nodeDir(threadId: string, workflowId: string, index: number, type: WorkflowNodeType): string {
  return path.join(sessionDir(threadId, workflowId), `node-${String(index).padStart(2, '0')}-${type.toLowerCase()}`);
}

function scratchDir(threadId: string): string {
  const dir = path.join(workspacesRoot(), threadId, 'vision-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(threadId: string): string {
  return path.join(workflowsDir(threadId), '_index.json');
}

// ── Node types ────────────────────────────────────────────────────────────────

export type WorkflowNodeType =
  | 'Source'
  | 'Generate'
  | 'VarySeed'
  | 'Img2imgRefine'
  | 'KontextEdit'
  | 'FaceFix'
  | 'HandFix'
  | 'DepthControlNet'
  | 'RemoveBg'
  | 'Upscale'
  | 'VideoGenerate'
  | 'VideoFromImage';

// sd-cli generation nodes — these require RGB input
const SD_CLI_GENERATION_TYPES = new Set<WorkflowNodeType>([
  'Generate', 'VarySeed', 'Img2imgRefine', 'KontextEdit', 'FaceFix', 'HandFix', 'DepthControlNet', 'Upscale',
  'VideoGenerate', 'VideoFromImage',
]);

// ── Per-node param types ──────────────────────────────────────────────────────

export interface SourceParams {
  sourcePath: string;  // absolute path to the user-uploaded source image
}

export interface GenerateParams {
  prompt:          string;
  negativePrompt?: string;
  steps?:          number;
  width?:          number;
  height?:         number;
  seed?:           number;
  sampler?:        string;
}

export interface VarySeedParams extends GenerateParams {
  seedOffset: number;    // added to seed from the Generate node upstream
}

export interface Img2imgRefineParams extends GenerateParams {
  strength: number;      // 0–1, denoising strength
}

export interface KontextEditParams extends GenerateParams {
  // refImage is wired automatically from the upstream node output at execution time.
  // No extra fields needed — prompt drives the edit, seed controls variation.
}

export interface FaceFixParams extends GenerateParams {
  width?:        number; // square output size (width = height, default 1024)
  strength:      number; // sd-cli --strength for inpaint
  bboxDilation?: number; // VisionProcessor dilation px (default 40)
  feather?:      number; // mask feather px (default 10)
  threshold?:    number; // detection confidence threshold (default 0.5)
}

export interface HandFixParams extends GenerateParams {
  strength:      number;
  bboxDilation?: number; // default 30
  feather?:      number; // default 8
  threshold?:    number; // default 0.5
  maxHands?:     number; // default 4
}

export interface DepthControlNetParams extends GenerateParams {
  strength:      number;
  controlScale?: number; // ControlNet guidance scale (default 1.0)
  preBlur?:      number; // depth map pre-blur (default 0)
}

export interface RemoveBgParams {
  model?:                  'small' | 'medium' | 'large';  // imgly v1.4+ API
  alphaMatting?:           boolean;
  alphaMattingFgThreshold?: number;
  alphaMattingBgThreshold?: number;
  alphaMattingErodeSize?:  number;
}

export interface UpscaleParams {
  upscaleRepeats?:  number;  // --upscale-repeats: number of upscaler passes (default 1)
                             // RealESRGAN_x4plus = 4x per pass. 1 pass = 4x, 2 passes = 16x (rarely useful)
  upscaleModel?:    string;  // ESRGAN model filename (default: RealESRGAN_x4plus.pth)
  upscaleTileSize?: number;  // --upscale-tile-size px (default 128)
  width?:           number;  // passed as --width to sd-cli upscale mode (optional, for crop/resize hint)
  height?:          number;  // passed as --height
}

export interface VideoGenerateParams {
  prompt:          string;
  negativePrompt?: string;
  steps?:          number;   // default 20
  width?:          number;   // default 832 (landscape 480P)
  height?:         number;   // default 480
  seed?:           number;   // -1 = random
  fps?:            number;   // --fps, default 12
  videoFrames?:    number;   // --video-frames, default 49 (≈4s at 12fps)
}

export interface VideoFromImageParams extends VideoGenerateParams {
  // initImg is wired automatically from upstream node output at execution time.
  // Only available when using an I2V model (wan21-i2v-14b-480p).
}

export type WorkflowNodeParams =
  | SourceParams
  | GenerateParams
  | VarySeedParams
  | Img2imgRefineParams
  | KontextEditParams
  | FaceFixParams
  | HandFixParams
  | DepthControlNetParams
  | RemoveBgParams
  | UpscaleParams
  | VideoGenerateParams
  | VideoFromImageParams;

// ── Node and session types ────────────────────────────────────────────────────

export interface WorkflowNode {
  id:            string;             // stable UUID, survives reorders
  index:         number;             // current position in chain (mutable on reorder)
  type:          WorkflowNodeType;
  label?:        string;             // user-editable display name
  params:        WorkflowNodeParams;
  paramSnapshot: WorkflowNodeParams | null; // params at last successful execution
  outputPath:    string | null;      // absolute path to cached output PNG
  maskPath:      string | null;      // VisionProcessor mask artifact (FaceFix/HandFix)
  depthPath:     string | null;      // VisionProcessor depth artifact (DepthControlNet)
  inputSnapshot: string | null;      // hash of input image at mask generation time
  executedAt:    string | null;      // ISO8601 timestamp of last successful run
  stale:         boolean;            // true if upstream node re-ran after this node last ran
  // Preserved state from the alternate mode (Generate↔Source toggle)
  altState?:     {
    type:          WorkflowNodeType;
    label:         string;
    params:        WorkflowNodeParams;
    paramSnapshot: WorkflowNodeParams | null;
    outputPath:    string | null;
    executedAt:    string | null;
  } | null;
}

export interface WorkflowSession {
  workflowId:   string;
  name:         string;
  createdAt:    string;
  modelId:      string;               // snapshotted at creation, must still be installed to run
  workflowType: 'image' | 'video';   // determines output format (.png vs .avi) and panel behaviour
  nodes:        WorkflowNode[];
  threadId:     string;
}

export interface WorkflowIndexEntry {
  workflowId:   string;
  name:         string;
  createdAt:    string;
  modelId:      string;
  workflowType: 'image' | 'video';
  thumbPath:    string | null;        // path to thumbnail for image workflows; null for video
}

// ── SSE event types ───────────────────────────────────────────────────────────

export type RenderPhase =
  | 'model_loading'
  | 'model_loaded'
  | 'conditioning'
  | 'conditioning_done'
  | 'sampling'
  | 'sampling_done'
  | 'decoding'
  | 'decode_done'
  | 'saving';

export type WorkflowEvent =
  | { phase: 'node_start';       nodeIndex: number; nodeType: WorkflowNodeType; totalNodes: number }
  | { phase: 'vision_start';     nodeIndex: number; step: 'face_detect' | 'hand_detect' | 'depth' | 'bg_remove' }
  | { phase: 'vision_done';      nodeIndex: number; artifactPath: string }
  | { phase: 'render_progress';  nodeIndex: number; step: number; totalSteps: number; previewPath?: string }
  | { phase: 'render_phase';     nodeIndex: number; renderPhase: RenderPhase; detail?: string }
  | { phase: 'node_done';        nodeIndex: number; outputPath: string }
  | { phase: 'stale_flagged';    fromIndex: number; toIndex: number }
  | { phase: 'workflow_done';    finalOutputPath: string; isFinal: boolean }
  | { phase: 'model_missing';    modelId: string }
  | { phase: 'error';            nodeIndex: number; message: string; fatal: boolean };

// ── Async queue for live event streaming ──────────────────────────────────────
// Allows the onProgress callback (sync, called from stdout) to push events
// that the async generator can pull in real-time via for-await.

class AsyncQueue<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  finish(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    if (this.done) {
      return Promise.resolve({ value: undefined as any, done: true });
    }
    return new Promise((resolve) => { this.resolve = resolve; });
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

export function writeSession(session: WorkflowSession): void {
  const dir  = sessionDir(session.threadId, session.workflowId);
  const file = path.join(dir, 'session.json');
  const tmp  = file + '.tmp';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readSession(threadId: string, workflowId: string): WorkflowSession | null {
  const file = path.join(sessionDir(threadId, workflowId), 'session.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowSession;
  } catch {
    return null;
  }
}

function updateIndex(threadId: string, entry: WorkflowIndexEntry): void {
  const file = indexPath(threadId);
  fs.mkdirSync(workflowsDir(threadId), { recursive: true });
  let entries: WorkflowIndexEntry[] = [];
  if (fs.existsSync(file)) {
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { entries = []; }
  }
  const idx = entries.findIndex(e => e.workflowId === entry.workflowId);
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readIndex(threadId: string): WorkflowIndexEntry[] {
  const file = indexPath(threadId);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// ── Session factory ───────────────────────────────────────────────────────────

export function createSession(
  threadId:     string,
  name:         string,
  modelId:      string,
  nodes:        Omit<WorkflowNode, 'id' | 'index' | 'paramSnapshot' | 'outputPath' | 'maskPath' | 'depthPath' | 'inputSnapshot' | 'executedAt' | 'stale'>[],
  workflowType: 'image' | 'video' = 'image',
): WorkflowSession {
  const session: WorkflowSession = {
    workflowId: crypto.randomUUID(),
    name,
    createdAt:    new Date().toISOString(),
    modelId,
    workflowType,
    threadId,
    nodes: nodes.map((n, index) => ({
      ...n,
      id:            crypto.randomUUID(),
      index,
      paramSnapshot: null,
      outputPath:    null,
      maskPath:      null,
      depthPath:     null,
      inputSnapshot: null,
      executedAt:    null,
      stale:         false,
    })),
  };
  writeSession(session);
  updateIndex(threadId, {
    workflowId:   session.workflowId,
    name:         session.name,
    createdAt:    session.createdAt,
    modelId:      session.modelId,
    workflowType: session.workflowType,
    thumbPath:    null,
  });
  return session;
}

// ── Dirty detection ───────────────────────────────────────────────────────────

function isDirty(node: WorkflowNode): boolean {
  if (node.executedAt === null)      return true;
  if (node.paramSnapshot === null)   return true;
  if (node.stale)                    return true;
  return JSON.stringify(node.params) !== JSON.stringify(node.paramSnapshot);
}

function computeExecutionRange(nodes: WorkflowNode[], targetIndex: number): number[] {
  let firstDirty = -1;
  for (let i = 0; i <= targetIndex; i++) {
    if (isDirty(nodes[i])) { firstDirty = i; break; }
  }
  if (firstDirty === -1) return [];
  const range: number[] = [];
  for (let i = firstDirty; i <= targetIndex; i++) range.push(i);
  return range;
}

// ── Mask caching — key mask to input image hash ───────────────────────────────

function hashFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

// ── Auto-correct: RemoveBg → sd-cli requires RGB flatten ─────────────────────

function needsFlatten(session: WorkflowSession, nodeIndex: number): boolean {
  if (nodeIndex === 0) return false;
  const prev = session.nodes[nodeIndex - 1];
  return prev.type === 'RemoveBg' && SD_CLI_GENERATION_TYPES.has(session.nodes[nodeIndex].type);
}

// ── Progress parsing ──────────────────────────────────────────────────────────
// sd-cli emits lines like "step X / Y" or "X/Y" to stdout during generation.
// FLUX: ~4 steps. Chroma: ~20 steps. Parse and yield render_progress events.
// previewPath is omitted until sd-cli preview frame support is verified.

function parseProgressLine(line: string): { step: number; total: number } | null {
  // Match patterns: "step 3/20", "3/20", "[3/20]", "Step 3 of 20"
  const m =
    line.match(/step\s+(\d+)\s*[/of]\s*(\d+)/i) ||
    line.match(/\[?(\d+)\s*\/\s*(\d+)\]?/);
  if (!m) return null;
  const step  = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (isNaN(step) || isNaN(total) || total === 0) return null;
  return { step, total };
}

// ── sd-cli generation with progress streaming ─────────────────────────────────
// Wraps generateImage() with the onProgress callback. Because yield cannot be
// ── sd-cli output line classifier ────────────────────────────────────────────

function classifySdLine(line: string, nodeIndex: number): WorkflowEvent | null {
  if (line.includes('loading diffusion model') || line.includes('loading t5xxl') ||
      line.includes('loading vae') || line.includes('loading clip')) {
    const model = line.includes('diffusion') ? 'diffusion' : line.includes('t5xxl') ? 't5xxl' : line.includes('vae') ? 'vae' : 'clip';
    return { phase: 'render_phase', nodeIndex, renderPhase: 'model_loading', detail: `Loading ${model}` };
  }
  if (line.includes('loading tensors completed')) {
    const m = line.match(/taking ([\d.]+)s/);
    return { phase: 'render_phase', nodeIndex, renderPhase: 'model_loaded', detail: m ? `Models loaded in ${m[1]}s` : 'Models loaded' };
  }
  if (line.includes('TXT2IMG') || line.includes('IMG2IMG')) {
    return { phase: 'render_phase', nodeIndex, renderPhase: 'conditioning', detail: 'Encoding prompt…' };
  }
  // Wan video: generate_video line signals the start of video generation
  if (line.includes('generate_video')) {
    const m = line.match(/generate_video (\d+x\d+x\d+)/);
    return { phase: 'render_phase', nodeIndex, renderPhase: 'conditioning', detail: m ? `Encoding prompt for ${m[1]}…` : 'Encoding prompt…' };
  }
  if (line.includes('get_learned_condition completed')) {
    const m = line.match(/taking (\d+) ms/);
    const secs = m ? (parseInt(m[1], 10) / 1000).toFixed(1) : '?';
    return { phase: 'render_phase', nodeIndex, renderPhase: 'conditioning_done', detail: `Prompt encoded in ${secs}s` };
  }
  if (line.includes('generating image:')) {
    const m = line.match(/seed (\d+)/);
    return { phase: 'render_phase', nodeIndex, renderPhase: 'sampling', detail: m ? `Seed ${m[1]}` : 'Sampling…' };
  }
  const prog = parseProgressLine(line);
  if (prog) {
    return { phase: 'render_progress', nodeIndex, step: prog.step, totalSteps: prog.total };
  }
  if (line.includes('sampling completed')) {
    const m = line.match(/taking ([\d.]+)s/);
    return { phase: 'render_phase', nodeIndex, renderPhase: 'sampling_done', detail: m ? `Sampled in ${m[1]}s` : 'Sampling done' };
  }
  // Wan video: latent video completed before the long per-frame VAE decode
  if (line.includes('generating latent video completed')) {
    const m = line.match(/taking ([\d.]+)s/);
    return { phase: 'render_phase', nodeIndex, renderPhase: 'sampling_done', detail: m ? `Latent video in ${m[1]}s — decoding frames…` : 'Latent video done — decoding frames…' };
  }
  if (line.includes('decoding') && line.includes('latent')) {
    return { phase: 'render_phase', nodeIndex, renderPhase: 'decoding', detail: 'Decoding latent…' };
  }
  // decode_first_stage for video covers per-frame VAE decode — can take 15–20 min on CPU
  if (line.includes('decode_first_stage completed')) {
    const m = line.match(/taking ([\d.]+)s/);
    const secs = m ? parseFloat(m[1]) : 0;
    const detail = secs > 60 ? `Frames decoded in ${(secs / 60).toFixed(1)}min` : `Frames decoded in ${secs.toFixed(1)}s`;
    return { phase: 'render_phase', nodeIndex, renderPhase: 'decode_done', detail };
  }
  if (line.includes('decoded, taking')) {
    return { phase: 'render_phase', nodeIndex, renderPhase: 'decode_done', detail: 'Decoded' };
  }
  // Video save line differs from image save line
  if (line.includes('save result MJPG AVI') || line.includes('save result image')) {
    const isVideo = line.includes('AVI');
    return { phase: 'render_phase', nodeIndex, renderPhase: 'saving', detail: isVideo ? 'Saving video…' : 'Saving image…' };
  }
  return null;
}

// ── sd-cli generation with LIVE progress streaming ──────────────────────────
// Uses AsyncQueue so events flow from the stdout callback to the async
// generator in real-time. No buffering — each sd-cli output line is parsed
// and yielded immediately as an SSE event.

async function* runGenerate(
  outputPath: string,
  cfg:        SdServerConfig,
  opts:       GenerateImageOptions,
  nodeIndex:  number,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const totalSteps = opts.steps ?? 20;
  const eventQueue = new AsyncQueue<WorkflowEvent>();

  // Start generation in background — stdout lines push events into the queue
  const genPromise = generateImage(outputPath, cfg, opts, (line: string) => {
    const evt = classifySdLine(line, nodeIndex);
    if (evt) eventQueue.push(evt);
  }, onAbortRegister).then(() => {
    eventQueue.push({ phase: 'render_progress', nodeIndex, step: totalSteps, totalSteps });
    eventQueue.finish();
  }).catch((err) => {
    eventQueue.push({ phase: 'error', nodeIndex, message: (err as Error).message, fatal: false });
    eventQueue.finish();
  });

  // Yield events as they arrive — truly live, not buffered
  for await (const evt of eventQueue) {
    yield evt;
  }

  await genPromise;
}

// ── Per-node executors ────────────────────────────────────────────────────────

async function* executeGenerate(
  node:      WorkflowNode,
  inputPath: string | null,   // null for first Generate node
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as GenerateParams;
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    width:          p.width,
    height:         p.height,
    seed:           p.seed,
    sampler:        p.sampler,
  }, node.index, onAbortRegister);
}

async function* executeVarySeed(
  node:      WorkflowNode,
  inputPath: string | null,
  outPath:   string,
  cfg:       SdServerConfig,
  session:   WorkflowSession,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as VarySeedParams;
  // Find base seed from upstream Generate node
  let baseSeed = p.seed ?? 42;
  for (let i = node.index - 1; i >= 0; i--) {
    if (session.nodes[i].type === 'Generate') {
      baseSeed = (session.nodes[i].params as GenerateParams).seed ?? 42;
      break;
    }
  }
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    width:          p.width,
    height:         p.height,
    seed:           baseSeed + (p.seedOffset ?? 1),
    sampler:        p.sampler,
  }, node.index, onAbortRegister);
}

async function* executeKontextEdit(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as KontextEditParams;
  // inputPath is the upstream node output — passed as -r (reference image) for editing.
  // Width/height inherit from upstream dimensions; sd-cli reads them from the ref image.
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    seed:           p.seed,
    sampler:        p.sampler,
    refImage:       inputPath,
  }, node.index, onAbortRegister);
}

async function* executeImg2imgRefine(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as Img2imgRefineParams;
  const width  = p.width  ?? 1024;
  const height = p.height ?? 1024;
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    width,
    height,
    seed:           p.seed,
    sampler:        p.sampler,
    initImg:        inputPath,
    strength:       p.strength,
  }, node.index, onAbortRegister);
}

async function* executeFaceFix(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  threadId:  string,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as FaceFixParams;

  // Check mask cache: if inputPath unchanged, reuse existing mask
  const inputHash = hashFile(inputPath);
  let maskPath = node.maskPath;

  if (!maskPath || node.inputSnapshot !== inputHash || !fs.existsSync(maskPath)) {
    yield { phase: 'vision_start', nodeIndex: node.index, step: 'face_detect' };
    const result = await generateFaceMask(inputPath, threadId, {
      bboxDilation: p.bboxDilation,
      feather:      p.feather,
      threshold:    p.threshold,
    });
    maskPath = result.maskPath;
    node.maskPath      = maskPath;
    node.inputSnapshot = inputHash;
    yield { phase: 'vision_done', nodeIndex: node.index, artifactPath: maskPath };
  }

  // sd-cli crops non-square images — always pass square dimensions
  const faceSize = p.width ?? p.height ?? 1024;
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    width:          faceSize,
    height:         faceSize,
    seed:           p.seed,
    sampler:        p.sampler,
    initImg:        inputPath,
    strength:       p.strength,
    maskPath,
  }, node.index, onAbortRegister);
}

async function* executeHandFix(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  threadId:  string,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as HandFixParams;

  const inputHash = hashFile(inputPath);
  let maskPath = node.maskPath;

  if (!maskPath || node.inputSnapshot !== inputHash || !fs.existsSync(maskPath)) {
    yield { phase: 'vision_start', nodeIndex: node.index, step: 'hand_detect' };
    const result = await generateHandMask(inputPath, threadId, {
      bboxDilation: p.bboxDilation,
      feather:      p.feather,
      threshold:    p.threshold,
      maxHands:     p.maxHands,
    });
    maskPath = result.maskPath;
    node.maskPath      = maskPath;
    node.inputSnapshot = inputHash;
    yield { phase: 'vision_done', nodeIndex: node.index, artifactPath: maskPath };
  }

  // If no hands detected, pass through unchanged
  if (!maskPath) {
    fs.copyFileSync(inputPath, outPath);
    return;
  }

  // sd-cli crops non-square images — always pass square dimensions
  const handSize = p.width ?? p.height ?? 1024;
  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    width:          handSize,
    height:         handSize,
    seed:           p.seed,
    sampler:        p.sampler,
    initImg:        inputPath,
    strength:       p.strength,
    maskPath,
  }, node.index, onAbortRegister);
}

async function* executeDepthControlNet(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  threadId:  string,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as DepthControlNetParams;

  const inputHash = hashFile(inputPath);
  let depthPath = node.depthPath;

  if (!depthPath || node.inputSnapshot !== inputHash || !fs.existsSync(depthPath)) {
    yield { phase: 'vision_start', nodeIndex: node.index, step: 'depth' };
    const result = await generateDepthMap(inputPath, threadId, {
      preBlur: p.preBlur,
    });
    depthPath = result.depthPath;
    node.depthPath     = depthPath;
    node.inputSnapshot = inputHash;
    yield { phase: 'vision_done', nodeIndex: node.index, artifactPath: depthPath };
  }

  yield* runGenerate(outPath, cfg, {
    prompt:         p.prompt,
    negativePrompt: p.negativePrompt,
    steps:          p.steps,
    seed:           p.seed,
    sampler:        p.sampler,
    initImg:        inputPath,
    strength:       p.strength,
    controlImage:   depthPath,
    controlScale:   p.controlScale ?? 1.0,
  }, node.index, onAbortRegister);
}

async function* executeRemoveBg(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  threadId:  string,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as RemoveBgParams;
  yield { phase: 'vision_start', nodeIndex: node.index, step: 'bg_remove' };
  // Pre-process to a clean standard RGB PNG. imgly/sharp rejects some PNG
  // variants (interlaced, unusual color profiles, RGBA). flattenAlpha re-encodes
  // to a plain RGBA PNG that sharp can always handle.
  const scratchRoot = path.join(
    process.env.WORKSPACES_ROOT ?? path.join(os.homedir(), '.phobos', 'workspaces'),
    threadId, 'vision-scratch'
  );
  fs.mkdirSync(scratchRoot, { recursive: true });
  const cleanInput = path.join(scratchRoot, `removebg-in-${Date.now()}.png`);
  try { flattenAlpha(inputPath, cleanInput); } catch { fs.copyFileSync(inputPath, cleanInput); }
  const result = await removeBackground(cleanInput, threadId, {
    model:                   p.model,
    alphaMatting:            p.alphaMatting,
    alphaMattingFgThreshold: p.alphaMattingFgThreshold,
    alphaMattingBgThreshold: p.alphaMattingBgThreshold,
    alphaMattingErodeSize:   p.alphaMattingErodeSize,
  });
  // Copy RGBA result to stable node output path
  fs.copyFileSync(result.outputPath, outPath);
  try { fs.unlinkSync(cleanInput); } catch { /* non-fatal */ }
  yield { phase: 'vision_done', nodeIndex: node.index, artifactPath: outPath };
}

async function* executeUpscale(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as UpscaleParams;
  // Resolve ESRGAN model path — lives in ~/.phobos/models/upscale/
  const upscaleModelsDir = path.join(os.homedir(), '.phobos', 'models', 'upscale');
  const modelFile = p.upscaleModel ?? 'RealESRGAN_x4plus.pth';
  const modelPath = path.join(upscaleModelsDir, modelFile);
  if (!fs.existsSync(modelPath)) {
    yield { phase: 'error', nodeIndex: node.index,
      message: `ESRGAN model not found: ${modelPath}. Download RealESRGAN_x4plus.pth to ~/.phobos/models/upscale/`,
      fatal: false };
    return;
  }
  yield* runGenerate(outPath, cfg, {
    prompt:          '',
    upscaleInput:    inputPath,
    upscaleModel:    modelPath,
    upscaleFactor:   p.upscaleRepeats  ?? 1,   // 1 pass = 4x with x4plus model
    upscaleTileSize: p.upscaleTileSize ?? 128,
    width:           p.width,
    height:          p.height,
  }, node.index, onAbortRegister);
}

async function* executeVideoGenerate(
  node:      WorkflowNode,
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as VideoGenerateParams;
  yield* runGenerate(outPath, cfg, {
    prompt:       p.prompt,
    negativePrompt: p.negativePrompt,
    steps:        p.steps,
    width:        p.width,
    height:       p.height,
    seed:         p.seed,
    fps:          p.fps,
    videoFrames:  p.videoFrames,
  }, node.index, onAbortRegister);
}

async function* executeVideoFromImage(
  node:      WorkflowNode,
  inputPath: string,
  outPath:   string,
  cfg:       SdServerConfig,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {
  const p = node.params as VideoFromImageParams;
  // Passes the upstream image as --init-img for I2V generation
  yield* runGenerate(outPath, cfg, {
    prompt:       p.prompt,
    negativePrompt: p.negativePrompt,
    steps:        p.steps,
    width:        p.width,
    height:       p.height,
    seed:         p.seed,
    fps:          p.fps,
    videoFrames:  p.videoFrames,
    initImg:      inputPath,
  }, node.index, onAbortRegister);
}


// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Execute a workflow up to targetNodeIndex (inclusive).
 *
 * Only re-runs nodes that are dirty (params changed or stale from upstream).
 * Nodes after targetNodeIndex are flagged stale but not executed.
 *
 * isFinal controls whether the result is saved to the workspace:
 *   false (default) — Generate button: run dirty nodes up to target, no workspace save
 *   true            — Final button: run dirty nodes up to last node, save to workspace
 */
// Returns the next available N for {prefix}-{N}{ext} in dir
function nextFinalN(dir: string, prefix: string, ext: string = '.png'): number {
  let maxN = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix + '-') && f.endsWith(ext)) {
        const n = parseInt(f.slice(prefix.length + 1, -ext.length), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  } catch { /* dir may not exist yet */ }
  return maxN + 1;
}

export async function* run(
  session:         WorkflowSession,
  targetNodeIndex: number,
  cfg:             SdServerConfig,
  isFinal:         boolean = false,
  onAbortRegister?: (killFn: () => void) => void,
): AsyncGenerator<WorkflowEvent> {

  // ── Guard: model still installed ──────────────────────────────────────────
  const modelSpec = getImageModelSpec(session.modelId);
  if (!modelSpec || !isImageModelDownloaded(modelSpec)) {
    yield { phase: 'model_missing', modelId: session.modelId };
    return;
  }

  const { threadId, nodes } = session;

  // ── Compute which nodes need to run ───────────────────────────────────────
  const range = computeExecutionRange(nodes, targetNodeIndex);
  if (range.length === 0) {
    // Everything clean up to target — nothing to re-run
    const lastOutput = nodes[targetNodeIndex].outputPath;
    if (lastOutput && isFinal) {
      // Still need to save to workspace even though nothing was re-generated
      const isVideo   = session.workflowType === 'video';
      const outExt    = isVideo ? '.avi' : '.png';
      const outSubdir = isVideo ? 'videos' : 'images';
      const finalName = isVideo ? `final${outExt}` : 'final.png';
      const finalPath = path.join(sessionDir(threadId, session.workflowId), finalName);
      fs.copyFileSync(lastOutput, finalPath);
      const workspaceOutDir = path.join(workspacesRoot(), threadId, outSubdir);
      fs.mkdirSync(workspaceOutDir, { recursive: true });
      const sanitisedName = session.name.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
      const n = nextFinalN(workspaceOutDir, sanitisedName, outExt);
      const workspaceOut = path.join(workspaceOutDir, `${sanitisedName}-${n}${outExt}`);
      fs.copyFileSync(lastOutput, workspaceOut);
      updateIndex(threadId, {
        workflowId:   session.workflowId,
        name:         session.name,
        createdAt:    session.createdAt,
        modelId:      session.modelId,
        workflowType: session.workflowType,
        thumbPath:    isVideo ? null : finalPath,
      });
      yield { phase: 'workflow_done', finalOutputPath: workspaceOut, isFinal: true };
    } else if (lastOutput) {
      yield { phase: 'workflow_done', finalOutputPath: lastOutput, isFinal: false };
    }
    return;
  }

  // ── Clear vision-scratch at start of run ──────────────────────────────────
  try {
    const scratch = scratchDir(threadId);
    for (const f of fs.readdirSync(scratch)) {
      fs.rmSync(path.join(scratch, f), { force: true });
    }
  } catch { /* non-fatal */ }

  // ── Execute each node in range ────────────────────────────────────────────
  let lastOutputPath: string | null = null;

  for (const nodeIndex of range) {
    const node = nodes[nodeIndex];

    // Resolve input: output of the previous node, or null for the first node
    let inputPath: string | null = nodeIndex === 0
      ? null
      : nodes[nodeIndex - 1].outputPath;

    // Auto-correct: RemoveBg → sd-cli requires RGB flatten
    if (inputPath && needsFlatten(session, nodeIndex)) {
      const flatPath = path.join(scratchDir(threadId), `flat-${Date.now()}.png`);
      flattenAlpha(inputPath, flatPath);
      inputPath = flatPath;
    }

    // Resolve stable output path for this node
    const nDir = nodeDir(threadId, session.workflowId, nodeIndex, node.type);
    fs.mkdirSync(nDir, { recursive: true });
    const outExt  = nodeOutputExt(cfg.modelType);
    const outPath = path.join(nDir, `output${outExt}`);

    yield { phase: 'node_start', nodeIndex, nodeType: node.type, totalNodes: range.length };

    try {
      switch (node.type) {
        case 'Source': {
          // Source nodes don't generate — they just provide a user-uploaded image
          const p = node.params as SourceParams;
          if (!p.sourcePath || !fs.existsSync(p.sourcePath)) {
            throw new Error('Source node has no uploaded image');
          }
          fs.copyFileSync(p.sourcePath, outPath);
          break;
        }

        case 'Generate':
          yield* executeGenerate(node, inputPath, outPath, cfg, onAbortRegister);
          break;

        case 'VarySeed':
          yield* executeVarySeed(node, inputPath, outPath, cfg, session, onAbortRegister);
          break;

        case 'Img2imgRefine':
          if (!inputPath) throw new Error('Img2imgRefine requires an upstream node with output');
          yield* executeImg2imgRefine(node, inputPath, outPath, cfg, onAbortRegister);
          break;

        case 'KontextEdit':
          if (!inputPath) throw new Error('KontextEdit requires an upstream node with output');
          yield* executeKontextEdit(node, inputPath, outPath, cfg, onAbortRegister);
          break;

        case 'FaceFix':
          if (!inputPath) throw new Error('FaceFix requires an upstream node with output');
          yield* executeFaceFix(node, inputPath, outPath, cfg, threadId, onAbortRegister);
          break;

        case 'HandFix':
          if (!inputPath) throw new Error('HandFix requires an upstream node with output');
          yield* executeHandFix(node, inputPath, outPath, cfg, threadId, onAbortRegister);
          break;

        case 'DepthControlNet':
          if (!inputPath) throw new Error('DepthControlNet requires an upstream node with output');
          yield* executeDepthControlNet(node, inputPath, outPath, cfg, threadId, onAbortRegister);
          break;

        case 'RemoveBg':
          if (!inputPath) throw new Error('RemoveBg requires an upstream node with output');
          yield* executeRemoveBg(node, inputPath, outPath, threadId);
          break;

        case 'Upscale':
          if (!inputPath) throw new Error('Upscale requires an upstream node with output');
          yield* executeUpscale(node, inputPath, outPath, cfg, onAbortRegister);
          break;

        case 'VideoGenerate':
          yield* executeVideoGenerate(node, outPath, cfg, onAbortRegister);
          break;

        case 'VideoFromImage':
          if (!inputPath) throw new Error('VideoFromImage requires an upstream node with output');
          yield* executeVideoFromImage(node, inputPath, outPath, cfg, onAbortRegister);
          break;

        default:
          throw new Error(`Unknown node type: ${(node as WorkflowNode).type}`);
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      yield { phase: 'error', nodeIndex, message, fatal: false };
      // Do not update snapshot — node remains dirty for retry
      continue;
    }

    // ── Node succeeded: update state ────────────────────────────────────────
    node.outputPath    = outPath;
    node.paramSnapshot = JSON.parse(JSON.stringify(node.params));
    node.executedAt    = new Date().toISOString();
    node.stale         = false;
    lastOutputPath     = outPath;

    // If mask/depth paths were updated inside the executor, they're already
    // written to the node object by reference. Persist now.
    // Copy mask/depth artifacts into the stable node dir if they came from scratch
    if (node.maskPath && node.maskPath !== path.join(nDir, 'mask.png')) {
      const stableMask = path.join(nDir, 'mask.png');
      fs.copyFileSync(node.maskPath, stableMask);
      node.maskPath = stableMask;
    }
    if (node.depthPath && node.depthPath !== path.join(nDir, 'depth.png')) {
      const stableDepth = path.join(nDir, 'depth.png');
      fs.copyFileSync(node.depthPath, stableDepth);
      node.depthPath = stableDepth;
    }

    writeSession(session);

    yield { phase: 'node_done', nodeIndex, outputPath: outPath };
  }

  // ── Flag all nodes after targetNodeIndex as stale ─────────────────────────
  const staleStart = targetNodeIndex + 1;
  if (staleStart < nodes.length) {
    for (let i = staleStart; i < nodes.length; i++) {
      nodes[i].stale = true;
    }
    writeSession(session);
    yield { phase: 'stale_flagged', fromIndex: staleStart, toIndex: nodes.length - 1 };
  }

  // ── Clean vision-scratch ──────────────────────────────────────────────────
  try {
    const scratch = path.join(workspacesRoot(), threadId, 'vision-scratch');
    if (fs.existsSync(scratch)) {
      for (const f of fs.readdirSync(scratch)) {
        fs.rmSync(path.join(scratch, f), { force: true });
      }
    }
  } catch { /* non-fatal */ }

  if (!lastOutputPath) return;

  // ── Generate Final: write to workspace ───────────────────────────────────
  if (isFinal && lastOutputPath) {
    const isVideo   = session.workflowType === 'video';
    const outExt    = isVideo ? '.avi' : '.png';
    const outSubdir = isVideo ? 'videos' : 'images';
    const finalName = isVideo ? `final${outExt}` : 'final.png';
    const finalPath = path.join(sessionDir(threadId, session.workflowId), finalName);
    fs.copyFileSync(lastOutputPath, finalPath);

    const workspaceOutDir = path.join(workspacesRoot(), threadId, outSubdir);
    fs.mkdirSync(workspaceOutDir, { recursive: true });
    const sanitisedName = session.name.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
    const n = nextFinalN(workspaceOutDir, sanitisedName, outExt);
    const workspaceOut = path.join(workspaceOutDir, `${sanitisedName}-${n}${outExt}`);
    fs.copyFileSync(lastOutputPath, workspaceOut);

    updateIndex(threadId, {
      workflowId:   session.workflowId,
      name:         session.name,
      createdAt:    session.createdAt,
      modelId:      session.modelId,
      workflowType: session.workflowType,
      thumbPath:    isVideo ? null : finalPath,
    });

    yield { phase: 'workflow_done', finalOutputPath: workspaceOut, isFinal: true };
    return;
  }

  // Non-final generate: update thumbnail to last node output and signal done
  updateIndex(threadId, {
    workflowId:   session.workflowId,
    name:         session.name,
    createdAt:    session.createdAt,
    modelId:      session.modelId,
    workflowType: session.workflowType,
    thumbPath:    session.workflowType === 'video' ? null : lastOutputPath,
  });

  yield { phase: 'workflow_done', finalOutputPath: lastOutputPath, isFinal: false };
}

// ── Generate Final convenience wrapper ────────────────────────────────────────

export async function* runFinal(
  session: WorkflowSession,
  cfg:     SdServerConfig,
): AsyncGenerator<WorkflowEvent> {
  yield* run(session, session.nodes.length - 1, cfg, true);
}

// ── Node management helpers ───────────────────────────────────────────────────

/** Mark both nodes dirty after a reorder. Caller must writeSession() after. */
export function applyReorder(
  session: WorkflowSession,
  fromIndex: number,
  toIndex:   number,
): void {
  const nodes = session.nodes;
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= nodes.length || toIndex >= nodes.length) return;

  // Splice node out and insert at new position
  const [moved] = nodes.splice(fromIndex, 1);
  nodes.splice(toIndex, 0, moved);

  // Re-index all nodes
  for (let i = 0; i < nodes.length; i++) nodes[i].index = i;

  // Both positions are dirty; all downstream of the earlier position are stale
  const earlierIndex = Math.min(fromIndex, toIndex);
  for (let i = earlierIndex; i < nodes.length; i++) {
    nodes[i].stale = true;
    nodes[i].paramSnapshot = null;
  }

  writeSession(session);
}

/** Append a new node to the end of the chain. */
export function appendNode(
  session: WorkflowSession,
  type:    WorkflowNodeType,
  params:  WorkflowNodeParams,
  label?:  string,
): WorkflowNode {
  const node: WorkflowNode = {
    id:            crypto.randomUUID(),
    index:         session.nodes.length,
    type,
    label,
    params,
    paramSnapshot: null,
    outputPath:    null,
    maskPath:      null,
    depthPath:     null,
    inputSnapshot: null,
    executedAt:    null,
    stale:         false,
  };
  session.nodes.push(node);
  writeSession(session);
  return node;
}

/** Update a node's params. Marks it dirty (stale flag stays as-is; isDirty() will catch it). */
export function updateNodeParams(
  session:   WorkflowSession,
  nodeId:    string,
  newParams: WorkflowNodeParams,
): void {
  const node = session.nodes.find(n => n.id === nodeId);
  if (!node) return;
  node.params = newParams;
  // paramSnapshot no longer matches — isDirty() will return true on next run
  writeSession(session);
}
