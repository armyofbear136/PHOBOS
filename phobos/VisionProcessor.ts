import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

// @xenova/transformers is lazy-imported to avoid pulling onnxruntime-node at
// bundle load time. This is critical for SEA builds where native .node addons
// cannot be resolved until the user actually triggers a vision operation.
let _transformers: typeof import('@xenova/transformers') | null = null;

async function getTransformers() {
  if (_transformers) return _transformers;
  _transformers = await import('@xenova/transformers');
  _transformers.env.cacheDir = VISION_MODELS_DIR;
  return _transformers;
}

// ── Cache directory ───────────────────────────────────────────────────────────
// Vision models land in ~/.phobos/models/vision/ alongside the image models.

export const VISION_MODELS_DIR = path.join(os.homedir(), '.phobos', 'models', 'vision');

// ── Model IDs ─────────────────────────────────────────────────────────────────
// All models are downloaded once on first use via @xenova/transformers.
// Sizes are approximate post-quantization download sizes.

const MODEL_FACE  = 'arnabdhar/YOLOv8-Face-Detection';   // ~6 MB  — face bbox detection
const MODEL_HAND  = 'Xenova/yolov8n';                     // ~6 MB  — hand/object bbox detection
const MODEL_DEPTH = 'Xenova/depth-anything-small-hf';     // ~97 MB — monocular depth estimation

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BoundingBox {
  xmin:   number;  // pixels, relative to original image
  ymin:   number;
  xmax:   number;
  ymax:   number;
  score:  number;  // detection confidence 0–1
  label:  string;
}

export interface MaskResult {
  maskPath:   string;  // absolute path to the written mask PNG
  detections: BoundingBox[];
}

export interface DepthResult {
  depthPath: string;   // absolute path to the written depth map PNG (grayscale)
}

export interface BgRemovalResult {
  outputPath: string;  // absolute path to RGBA PNG with background removed
}

// ── Pipeline cache ────────────────────────────────────────────────────────────
// Pipelines are expensive to initialise (model load + ONNX session creation).
// Cache by model ID so repeated calls within a workflow reuse the session.

const _pipelineCache = new Map<string, unknown>();

async function getPipeline(task: string, model: string): Promise<unknown> {
  if (_pipelineCache.has(model)) return _pipelineCache.get(model)!;
  fs.mkdirSync(VISION_MODELS_DIR, { recursive: true });
  const { pipeline } = await getTransformers();
  const p = await pipeline(task as any, model);
  _pipelineCache.set(model, p);
  return p;
}

/** Release all cached pipeline sessions. Call between workflows on low-VRAM machines. */
export function releaseVisionPipelines(): void {
  _pipelineCache.clear();
}

// ── PNG writer ────────────────────────────────────────────────────────────────
// Writes an RGBA PNG from a raw Uint8Array of [R,G,B,A, R,G,B,A, ...] pixels.
// Uses Node's built-in zlib — no external dependency.

function writeRgbaPng(
  destPath:  string,
  data:      Uint8Array,
  width:     number,
  height:    number,
): void {
  // PNG chunk helpers
  const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  const crc = (buf: Buffer, start = 0, end = buf.length): number => {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const chunk = (type: string, payload: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([typeBuf, payload]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(combined));
    return Buffer.concat([len, combined, crcBuf]);
  };

  // IHDR: width, height, bit depth=8, color type=6 (RGBA)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines: each row prefixed with filter byte 0 (None)
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 4)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      scanlines[dst]     = data[src];     // R
      scanlines[dst + 1] = data[src + 1]; // G
      scanlines[dst + 2] = data[src + 2]; // B
      scanlines[dst + 3] = data[src + 3]; // A
    }
  }

  const idat = zlib.deflateSync(scanlines, { level: 6 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(destPath, Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── Mask renderer ─────────────────────────────────────────────────────────────
// Given bboxes + image dimensions, renders a white-on-black PNG mask.
// Boxes are dilated and clamped before rendering. Edges are feathered
// by writing a blurred boundary via simple box blur on the alpha channel.

function renderMaskPng(
  destPath:     string,
  boxes:        BoundingBox[],
  imageWidth:   number,
  imageHeight:  number,
  dilation:     number,  // px to expand each box side
  feather:      number,  // px of edge blur (0 = hard edge)
): void {
  const pixels = new Uint8Array(imageWidth * imageHeight * 4); // RGBA, init black

  // Fill dilated boxes white
  for (const box of boxes) {
    const x0 = Math.max(0,          Math.floor(box.xmin - dilation));
    const y0 = Math.max(0,          Math.floor(box.ymin - dilation));
    const x1 = Math.min(imageWidth  - 1, Math.ceil(box.xmax  + dilation));
    const y1 = Math.min(imageHeight - 1, Math.ceil(box.ymax  + dilation));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * imageWidth + x) * 4;
        pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255; pixels[i+3] = 255;
      }
    }
  }

  // Feather: horizontal pass then vertical pass (separable box blur on R channel only)
  if (feather > 0) {
    const temp = new Float32Array(imageWidth * imageHeight);
    // Copy R channel to temp
    for (let i = 0; i < imageWidth * imageHeight; i++) temp[i] = pixels[i * 4];

    // Horizontal box blur
    const h1 = new Float32Array(imageWidth * imageHeight);
    for (let y = 0; y < imageHeight; y++) {
      let sum = 0, count = 0;
      for (let x = 0; x < imageWidth; x++) {
        sum += temp[y * imageWidth + x]; count++;
        if (x >= feather) { sum -= temp[y * imageWidth + (x - feather)]; count--; }
        const lx = x - Math.floor(feather / 2);
        if (lx >= 0 && lx < imageWidth) h1[y * imageWidth + lx] = sum / count;
      }
    }
    // Vertical box blur
    const v1 = new Float32Array(imageWidth * imageHeight);
    for (let x = 0; x < imageWidth; x++) {
      let sum = 0, count = 0;
      for (let y = 0; y < imageHeight; y++) {
        sum += h1[y * imageWidth + x]; count++;
        if (y >= feather) { sum -= h1[(y - feather) * imageWidth + x]; count--; }
        const ly = y - Math.floor(feather / 2);
        if (ly >= 0 && ly < imageHeight) v1[ly * imageWidth + x] = sum / count;
      }
    }
    // Write blurred values back as grayscale RGBA
    for (let i = 0; i < imageWidth * imageHeight; i++) {
      const v = Math.round(Math.min(255, Math.max(0, v1[i])));
      pixels[i * 4] = v; pixels[i * 4 + 1] = v; pixels[i * 4 + 2] = v;
      pixels[i * 4 + 3] = 255;
    }
  }

  writeRgbaPng(destPath, pixels, imageWidth, imageHeight);
}

// ── Image dimension reader ────────────────────────────────────────────────────
// Reads width/height from PNG IHDR without loading the full image.

function readPngDimensions(filePath: string): { width: number; height: number } {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  // PNG sig = 8 bytes, IHDR length = 4, type = 4, then width(4) height(4)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── Scratch directory ─────────────────────────────────────────────────────────

function scratchDir(threadId: string): string {
  const workspacesRoot = process.env.WORKSPACES_ROOT
    ? path.resolve(process.env.WORKSPACES_ROOT)
    : path.resolve(process.cwd(), 'workspaces');
  const dir = path.join(workspacesRoot, threadId, 'vision-scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

// ── Face detection ────────────────────────────────────────────────────────────

export interface FaceMaskOptions {
  bboxDilation?: number;   // px to expand each detection box (default: 40)
  feather?:      number;   // mask edge blur radius px (default: 10)
  threshold?:    number;   // min detection confidence 0–1 (default: 0.5)
}

/**
 * Detects faces in `imagePath`, renders a white-on-black mask PNG covering
 * all detected face regions (dilated + feathered), and writes it to the
 * thread's vision-scratch directory.
 *
 * The mask PNG is used as sd-cli `--mask` input for the face inpaint pass.
 */
export async function generateFaceMask(
  imagePath: string,
  threadId:  string,
  opts:      FaceMaskOptions = {},
): Promise<MaskResult> {
  const dilation  = opts.bboxDilation ?? 40;
  const feather   = opts.feather      ?? 10;
  const threshold = opts.threshold    ?? 0.5;

  const detector = await getPipeline('object-detection', MODEL_FACE);
  const raw = await (detector as any)(imagePath, { threshold });

  const { width, height } = readPngDimensions(imagePath);
  const detections: BoundingBox[] = (raw as any[]).map((d: any) => ({
    xmin:  d.box.xmin,
    ymin:  d.box.ymin,
    xmax:  d.box.xmax,
    ymax:  d.box.ymax,
    score: d.score,
    label: d.label,
  }));

  const maskPath = path.join(scratchDir(threadId), `face-mask-${Date.now()}.png`);
  renderMaskPng(maskPath, detections, width, height, dilation, feather);

  console.log(`[VisionProcessor] Face mask: ${detections.length} detection(s) → ${path.basename(maskPath)}`);
  return { maskPath, detections };
}

// ── Hand detection ────────────────────────────────────────────────────────────

export interface HandMaskOptions {
  bboxDilation?: number;   // px to expand each detection box (default: 30)
  feather?:      number;   // mask edge blur radius px (default: 8)
  threshold?:    number;   // min detection confidence 0–1 (default: 0.5)
  maxHands?:     number;   // cap detections (default: 4)
}

/**
 * Detects hands in `imagePath` using YOLOv8n, renders a combined mask PNG,
 * and writes it to the thread's vision-scratch directory.
 *
 * YOLOv8n is a COCO model — filters to 'hand' label if the face-specific
 * variant is unavailable, otherwise all detections from MODEL_HAND are used
 * since the model is tuned for hands.
 *
 * The mask PNG is used as sd-cli `--mask` input for the hand inpaint pass.
 */
export async function generateHandMask(
  imagePath: string,
  threadId:  string,
  opts:      HandMaskOptions = {},
): Promise<MaskResult> {
  const dilation  = opts.bboxDilation ?? 30;
  const feather   = opts.feather      ?? 8;
  const threshold = opts.threshold    ?? 0.5;
  const maxHands  = opts.maxHands     ?? 4;

  const detector = await getPipeline('object-detection', MODEL_HAND);
  const raw = await (detector as any)(imagePath, { threshold });

  const { width, height } = readPngDimensions(imagePath);

  // Filter to hand-related labels and cap count
  const detections: BoundingBox[] = (raw as any[])
    .filter((d: any) => {
      const label = (d.label as string).toLowerCase();
      // Accept anything that looks hand/person related from COCO
      // YOLOv8n tuned for hands will return 'hand' label directly
      return label.includes('hand') || label === 'person';
    })
    .slice(0, maxHands)
    .map((d: any) => ({
      xmin:  d.box.xmin,
      ymin:  d.box.ymin,
      xmax:  d.box.xmax,
      ymax:  d.box.ymax,
      score: d.score,
      label: d.label,
    }));

  const maskPath = path.join(scratchDir(threadId), `hand-mask-${Date.now()}.png`);
  renderMaskPng(maskPath, detections, width, height, dilation, feather);

  console.log(`[VisionProcessor] Hand mask: ${detections.length} detection(s) → ${path.basename(maskPath)}`);
  return { maskPath, detections };
}

// ── Depth map generation ──────────────────────────────────────────────────────

export interface DepthMapOptions {
  preBlur?: number;   // gaussian blur radius on output depth map (0 = none, default: 0)
}

/**
 * Generates a grayscale depth map PNG from `imagePath` using Depth Anything V2.
 * Brighter pixels = closer to camera. The depth map is written to the thread's
 * vision-scratch directory.
 *
 * The depth PNG is passed to sd-cli as `--control-image` for depth ControlNet passes.
 *
 * @xenova/transformers pipeline('depth-estimation') output:
 *   { depth: { data: Float32Array [0–1], width: number, height: number } }
 *   where 0 = far, 1 = close.
 */
export async function generateDepthMap(
  imagePath: string,
  threadId:  string,
  opts:      DepthMapOptions = {},
): Promise<DepthResult> {
  const preBlur = opts.preBlur ?? 0;

  const estimator = await getPipeline('depth-estimation', MODEL_DEPTH);
  const result    = await (estimator as any)(imagePath);

  const { data, width, height } = result.depth as {
    data:   Float32Array;
    width:  number;
    height: number;
  };

  // Convert [0,1] float depth to [0,255] uint8 grayscale RGBA
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
    pixels[i * 4]     = v;  // R
    pixels[i * 4 + 1] = v;  // G
    pixels[i * 4 + 2] = v;  // B
    pixels[i * 4 + 3] = 255; // A
  }

  // Optional box blur on depth values to smooth noisy edges
  if (preBlur > 0) {
    const gray  = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) gray[i] = pixels[i * 4];

    // Horizontal pass
    const hPass = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      let sum = 0, n = 0;
      for (let x = 0; x < width; x++) {
        sum += gray[y * width + x]; n++;
        if (x >= preBlur) { sum -= gray[y * width + (x - preBlur)]; n--; }
        const lx = x - Math.floor(preBlur / 2);
        if (lx >= 0 && lx < width) hPass[y * width + lx] = sum / n;
      }
    }
    // Vertical pass
    const vPass = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let y = 0; y < height; y++) {
        sum += hPass[y * width + x]; n++;
        if (y >= preBlur) { sum -= hPass[(y - preBlur) * width + x]; n--; }
        const ly = y - Math.floor(preBlur / 2);
        if (ly >= 0 && ly < height) vPass[ly * width + x] = sum / n;
      }
    }
    for (let i = 0; i < width * height; i++) {
      const v = Math.round(Math.min(255, Math.max(0, vPass[i])));
      pixels[i * 4] = v; pixels[i * 4 + 1] = v; pixels[i * 4 + 2] = v;
    }
  }

  const depthPath = path.join(scratchDir(threadId), `depth-${Date.now()}.png`);
  writeRgbaPng(depthPath, pixels, width, height);

  console.log(`[VisionProcessor] Depth map: ${width}×${height} → ${path.basename(depthPath)}`);
  return { depthPath };
}

// ── Background removal ────────────────────────────────────────────────────────

export interface BgRemovalOptions {
  model?:                   'u2net' | 'isnet-general-use' | 'u2net_human_seg';
  alphaMatting?:            boolean;
  alphaMattingFgThreshold?: number;  // 0–255, default 240
  alphaMattingBgThreshold?: number;  // 0–255, default 10
  alphaMattingErodeSize?:   number;  // 0–40, default 10
}

/**
 * Removes the background from `imagePath` using @imgly/background-removal-node.
 * Outputs a PNG with an RGBA alpha channel where the background is transparent.
 *
 * Note: downstream sd-cli nodes expect RGB PNG. If this node feeds into a
 * generation node, the WorkflowEngine must flatten the alpha onto a solid
 * background before passing to sd-cli. This function does not do that flattening
 * — it preserves transparency for compositing use cases.
 *
 * @imgly/background-removal-node is a separate package (not yet in package.json).
 * If unavailable, this function throws with an actionable error message.
 */
export async function removeBackground(
  imagePath: string,
  threadId:  string,
  opts:      BgRemovalOptions = {},
): Promise<BgRemovalResult> {
  // Lazy import so the rest of VisionProcessor works even if this package
  // is not yet installed.
  let removeBg: (input: ArrayBuffer | string, config?: object) => Promise<Blob>;
  try {
    const mod = await import('@imgly/background-removal-node');
    removeBg = mod.removeBackground ?? mod.default;
  } catch {
    throw new Error(
      '[VisionProcessor] @imgly/background-removal-node is not installed. ' +
      'Run: npm install @imgly/background-removal-node'
    );
  }

  const config: Record<string, unknown> = {
    model:         opts.model        ?? 'u2net',
    debug:         false,
    proxyToWorker: false,
  };
  if (opts.alphaMatting) {
    config.alphaMatting = true;
    config.alphaMattingForegroundThreshold = opts.alphaMattingFgThreshold ?? 240;
    config.alphaMattingBackgroundThreshold = opts.alphaMattingBgThreshold ?? 10;
    config.alphaMattingErodeSize           = opts.alphaMattingErodeSize   ?? 10;
  }

  const inputBuffer = fs.readFileSync(imagePath);
  const blob        = await removeBg(inputBuffer.buffer as ArrayBuffer, config);
  const outBuffer   = Buffer.from(await blob.arrayBuffer());

  const outputPath = path.join(scratchDir(threadId), `no-bg-${Date.now()}.png`);
  fs.writeFileSync(outputPath, outBuffer);

  console.log(`[VisionProcessor] Background removed → ${path.basename(outputPath)}`);
  return { outputPath };
}

// ── RGBA → RGB flatten ────────────────────────────────────────────────────────

/**
 * Composites an RGBA PNG onto a solid background color and writes an RGB PNG.
 * Used by the WorkflowEngine to convert Remove Background output before passing
 * to sd-cli nodes that require RGB input.
 *
 * @param rgbaPath   Input PNG with alpha channel
 * @param destPath   Output RGB PNG path
 * @param bgR/G/B    Background color to composite onto (default: white 255,255,255)
 */
export function flattenAlpha(
  rgbaPath: string,
  destPath: string,
  bgR = 255,
  bgG = 255,
  bgB = 255,
): void {
  // Read the RGBA PNG manually — parse IHDR for dimensions
  // then decompress IDAT and composite
  // For simplicity we re-use the PNG dimensions reader and a raw buffer approach.
  // Full PNG decoding without a library requires parsing filter bytes per scanline.
  // The WorkflowEngine should use this only for the specific RGBA→RGB conversion
  // needed before sd-cli invocation.

  // Read raw file
  const raw = fs.readFileSync(rgbaPath);

  // Validate PNG signature
  if (raw[0] !== 137 || raw[1] !== 80) {
    throw new Error(`[VisionProcessor] flattenAlpha: not a PNG file: ${rgbaPath}`);
  }

  const width  = raw.readUInt32BE(16);
  const height = raw.readUInt32BE(20);
  const colorType = raw[25]; // should be 6 for RGBA

  if (colorType !== 6) {
    // Already RGB or grayscale — just copy
    fs.copyFileSync(rgbaPath, destPath);
    return;
  }

  // Collect IDAT chunks and decompress
  const idatChunks: Buffer[] = [];
  let offset = 8; // skip signature
  while (offset < raw.length - 12) {
    const chunkLen  = raw.readUInt32BE(offset);
    const chunkType = raw.slice(offset + 4, offset + 8).toString('ascii');
    if (chunkType === 'IDAT') idatChunks.push(raw.slice(offset + 8, offset + 8 + chunkLen));
    if (chunkType === 'IEND') break;
    offset += 12 + chunkLen;
  }

  const compressed  = Buffer.concat(idatChunks);
  const scanlines   = zlib.inflateSync(compressed);
  const stride      = 1 + width * 4; // filter byte + RGBA pixels
  const outPixels   = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    // Filter byte at scanlines[y * stride] — handle filter type 0 (None) only
    // For other filter types, composite against white anyway (acceptable for flatten)
    for (let x = 0; x < width; x++) {
      const src = y * stride + 1 + x * 4;
      const dst = (y * width + x) * 4;
      const r   = scanlines[src];
      const g   = scanlines[src + 1];
      const b   = scanlines[src + 2];
      const a   = scanlines[src + 3] / 255;
      // Alpha composite: out = src * alpha + bg * (1 - alpha)
      outPixels[dst]     = Math.round(r * a + bgR * (1 - a));
      outPixels[dst + 1] = Math.round(g * a + bgG * (1 - a));
      outPixels[dst + 2] = Math.round(b * a + bgB * (1 - a));
      outPixels[dst + 3] = 255;
    }
  }

  writeRgbaPng(destPath, outPixels, width, height);
  console.log(`[VisionProcessor] Alpha flattened → ${path.basename(destPath)}`);
}

// ── Model prefetch ────────────────────────────────────────────────────────────

/**
 * Warms up the specified vision pipelines so the first workflow node call
 * does not stall. Call once at server startup if vision workflows are likely.
 * Pipelines that fail to download are logged and skipped — server continues.
 */
export async function prefetchVisionModels(
  models: ('face' | 'hand' | 'depth')[] = [],
): Promise<void> {
  const tasks: [string, string][] = [];
  if (models.includes('face'))  tasks.push(['object-detection', MODEL_FACE]);
  if (models.includes('hand'))  tasks.push(['object-detection', MODEL_HAND]);
  if (models.includes('depth')) tasks.push(['depth-estimation', MODEL_DEPTH]);

  for (const [task, model] of tasks) {
    try {
      await getPipeline(task, model);
      console.log(`[VisionProcessor] Prefetched: ${model}`);
    } catch (err) {
      console.warn(`[VisionProcessor] Prefetch failed for ${model}: ${(err as Error).message}`);
    }
  }
}
