import type { FastifyInstance } from 'fastify';
import * as https from 'https';
import { findUncensoredVariants } from '../phobos/UncensoredFinder.js';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as ModelPathStore from '../db/ModelPathStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import {
  detectHardware,
  buildRecommendation,
  isConfigOptimal,
  listDownloaded,
  isDownloaded,
  downloadModel,
  downloadVariantModel,
  modelPath,
  getSpec,
  deleteModel,
  deleteFluxModel,
  GGUF_CATALOGUE,
  MODELS_DIR,
  FLUX_CATALOGUE,
  FLUX_AUX_REQUIRED,
  CHROMA_AUX_REQUIRED,
  FLUX_T5_Q3,
  FLUX_T5_Q4,
  FLUX_T5_Q8,
  SDXL_AUX_REQUIRED,
  KONTEXT_AUX_REQUIRED,
  FLUX2_4B_AUX_REQUIRED,
  FLUX2_9B_AUX_REQUIRED,
  ZIMAGE_AUX_REQUIRED,
  QWEN_IMAGE_AUX_REQUIRED,
  WAN_AUX_REQUIRED,
  WAN_I2V_AUX_REQUIRED,
  IMAGE_MODEL_CATALOGUE,
  CHROMA_CATALOGUE,
  getImageModelSpec,
  isFluxDownloaded,
  isImageModelDownloaded,
  isFluxAuxDownloaded,
  getAuxFilesForModel,
  recommendT5Encoder,
  recommendT5EncodersForAllGpus,
  downloadFluxModel,
  fluxModelPath,
  fluxAuxPath,
  cancelImageDownload,
  cancelLlmDownload,
  ESRGAN_MODELS,
  downloadEsrgan,
  isEsrganDownloaded,
  esrganModelPath,
  scanFolderForModels,
  type EsrganSpec,
  type GGUFSpec,
  type ImageModelSpec,
  getCivitaiToken,
  setCivitaiToken,
  getAudioModelSpec,
  isAudioModelDownloaded,
  isWhisperDownloaded,
  audioModelDir,
  AUDIO_MODEL_CATALOGUE,
} from '../phobos/PhobosLocalManager.js';
import {
  prefetchVisionModels,
  VISION_MODELS_DIR,
} from '../phobos/VisionProcessor.js';
import {
  startServer,
  stopServer,
  getServerStatus,
  SAYON_PORT,
  SEREN_PORT,
} from '../phobos/LlamaServerManager.js';
import {
  getVendorReadiness,
  detectPython,
  install as installPythonEnv,
  uninstallVendor,
  isVendorReady,
  isInstallingVendor,
  getPythonPath,
  gpuToVendor,
  downloadAndInstallPython,
  invalidatePythonCache,
  isPython312,
  type GpuVendor,
  type InstallProgress,
} from '../phobos/PythonEnvManager.js';
import {
  convertModelToPyTorch,
  getPytorchVariantDir,
} from '../phobos/ImageServerManager.js';

// ── Image download lock ─────────────────────────────────────────────────────
// Prevents model deletion while a download is in progress.
// Set true when the image download SSE stream starts, cleared in its finally block.
let _imageDownloadActive = false;
export function isImageDownloadActive(): boolean { return _imageDownloadActive; }

// ── Relocate lock ───────────────────────────────────────────────────────────
// Prevents the frontend from showing the disconnect screen while models are
// being moved and LLM servers are intentionally stopped.
let _relocating = false;
export function isRelocating(): boolean { return _relocating; }

export async function phobosLocalRoute(fastify: FastifyInstance): Promise<void> {

  // GET /api/phobos/hardware
  fastify.get('/api/phobos/hardware', async (_req, reply) => {
    const hw  = await detectHardware();
    const rec = buildRecommendation(hw);
    return reply.send({ hardware: hw, recommendation: rec });
  });

  // POST /api/phobos/auto-config
  // Computes the optimal config and returns a full plan: what to download, what to
  // clean up, and what to launch. The frontend orchestrates the sequence.
  fastify.post('/api/phobos/auto-config', async (_req, reply) => {
    const hw  = await detectHardware();
    const rec = buildRecommendation(hw);

    // ── VRAM-tiered image/video picks for auto-config ──
    // Use the best GPU's total VRAM to pick the right tier.
    const bestGpuVram = hw.gpus.reduce((max, g) => Math.max(max, g.vramGb), 0);

    // Image: ≤6 GB → DreamShaper XL Lightning, 8-10 GB → FLUX.2 Klein 4B, ≥12 GB → FLUX.2 Klein 9B
    const autoImageId = bestGpuVram >= 12 ? 'flux2-klein-9b-q4'
                      : bestGpuVram >= 8  ? 'flux2-klein-4b-q4'
                      : 'dreamshaper-xl-lightning';

    // Video: ≤10 GB → Wan 2.1 1.3B, ≥12 GB → Wan 2.1 14B
    // (Wan 2.2 14B blocked — requires dual HighNoise/LowNoise GGUF pipeline not yet implemented)
    const autoVideoId = bestGpuVram >= 12 ? 'wan21-t2v-14b-q4'
                      : 'wan21-t2v-1.3b-q4';

    const imageSpec = getImageModelSpec(autoImageId) ?? null;
    const videoSpec = getImageModelSpec(autoVideoId) ?? null;

    // ── LLM models: what needs downloading ──
    const llmNeeded: string[] = [];
    const sayonSpec = getSpec(rec.sayon.modelId);
    const serenSpec = getSpec(rec.seren.modelId);
    if (sayonSpec && !isDownloaded(sayonSpec)) llmNeeded.push(rec.sayon.modelId);
    if (serenSpec && !isDownloaded(serenSpec) && rec.seren.modelId !== rec.sayon.modelId) {
      llmNeeded.push(rec.seren.modelId);
    }

    // ── Image/video models: what needs downloading ──
    const imageNeeded: string[] = [];
    if (imageSpec && !isImageModelDownloaded(imageSpec)) imageNeeded.push(imageSpec.modelId);
    if (videoSpec && !isImageModelDownloaded(videoSpec)) imageNeeded.push(videoSpec.modelId);

    // ── Cleanup candidates: downloaded LLM models NOT in the recommended set ──
    // Only LLM models — optional models (image, video, upscale) are never touched.
    const keepSet = new Set([rec.sayon.modelId, rec.seren.modelId]);
    const downloaded = listDownloaded();
    const cleanupCandidates = downloaded
      .filter(s => !keepSet.has(s.modelId))
      .map(s => ({ modelId: s.modelId, label: s.label, sizeBytes: s.sizeBytes }));

    return reply.send({
      recommendation: rec,
      imageModel:  imageSpec ? { modelId: imageSpec.modelId, displayName: imageSpec.displayName, sizeBytes: imageSpec.sizeBytes, vramRequiredGb: imageSpec.vramRequiredGb } : null,
      videoModel:  videoSpec ? { modelId: videoSpec.modelId, displayName: videoSpec.displayName, sizeBytes: videoSpec.sizeBytes, vramRequiredGb: videoSpec.vramRequiredGb } : null,
      llmNeeded,
      imageNeeded,
      cleanupCandidates,
      readyToLaunch: llmNeeded.length === 0,
    });
  });

  // GET /api/phobos/catalogue
  // Returns the full model catalogue with scoring fields for frontend display.
  fastify.get('/api/phobos/catalogue', async (_req, reply) => {
    return reply.send({
      models: GGUF_CATALOGUE.map(s => ({
        modelId: s.modelId,
        label:   s.label,
        family:  s.family,
        role:    s.role,
        thinkingTokens: s.thinkingTokens,
        sizeBytes: s.sizeBytes,
        ramRequiredGb: s.ramRequiredGb,
        contextWindow: s.contextWindow,
        legacy:  s.legacy ?? false,
        activeParamsB: s.activeParamsB,
        sayonQuality:  s.sayonQuality ?? 0,
        serenQuality:  s.serenQuality ?? 0,
        speedClass:    s.speedClass,
      })),
    });
  });

  // GET /api/phobos/models
  // Lists GGUFs that have been fully downloaded to ~/.phobos/models/.
  fastify.get('/api/phobos/models', async (_req, reply) => {
    const downloaded = listDownloaded();
    return reply.send({
      models: downloaded.map(s => ({
        modelId: s.modelId,
        label:   s.label,
        sizeBytes: s.sizeBytes,
        contextWindow: s.contextWindow,
      })),
    });
  });

  // GET /api/phobos/download?sayon=<modelId>&seren=<modelId>
  // SSE stream — downloads both GGUFs sequentially, emits progress.
  fastify.get<{
    Querystring: { sayon: string; seren: string };
  }>('/api/phobos/download', async (req, reply) => {
    const { sayon: sayonId, seren: serenId } = req.query;

    if (!sayonId || !serenId) {
      return reply.status(400).send({ error: 'sayon and seren query params required' });
    }

    const sayonSpec   = getSpec(sayonId);
    const serenSpec = getSpec(serenId);

    if (!sayonSpec)   return reply.status(400).send({ error: `Unknown model: ${sayonId}` });
    if (!serenSpec) return reply.status(400).send({ error: `Unknown model: ${serenId}` });

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const emit = (payload: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const downloadPhase = async (spec: typeof sayonSpec, phase: 'sayon' | 'seren') => {
      try {
        for await (const progress of downloadModel(spec, phase)) {
          emit(progress as unknown as Record<string, unknown>);
        }
      } catch (err) {
        emit({
          phase,
          modelId:  spec.modelId,
          done:     true,
          error:    err instanceof Error ? err.message : String(err),
          bytesReceived: 0,
          bytesTotal:    spec.sizeBytes,
        });
      }
    };

    await downloadPhase(sayonSpec, 'sayon');
    // Skip seren phase if it's the same model — the frontend sends the same ID
    // for both when downloading a single model from the queue.
    if (serenId !== sayonId) {
      await downloadPhase(serenSpec, 'seren');
    }

    emit({ phase: 'complete', done: true });
    reply.raw.end();
  });

  // POST /api/phobos/start
  // Body: { sayon: { modelId, gpuLayers?, contextSize?, threads?, deviceIndex?, gpuBackend? },
  //         seren: { ... } }
  // An empty modelId means "stop this server" — useful when the user selects "— stopped —"
  // in the launch config dropdown.
  fastify.post<{
    Body: {
      sayon:   { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number; deviceIndex?: number; gpuBackend?: string };
      seren: { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number; deviceIndex?: number; gpuBackend?: string };
    };
  }>('/api/phobos/start', async (req, reply) => {
    const { sayon, seren } = req.body;

    const [sayonErr, serenErr] = await Promise.allSettled([
      sayon.modelId
        ? startServer('sayon', {
            modelId:     sayon.modelId,
            port:        SAYON_PORT,
            gpuLayers:   sayon.gpuLayers   ?? 0,
            contextSize: sayon.contextSize ?? 4096,
            threads:     sayon.threads     ?? 0,
            deviceIndex: sayon.deviceIndex,
            gpuBackend:  sayon.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
          })
        : stopServer('sayon'),
      seren.modelId
        ? startServer('seren', {
            modelId:     seren.modelId,
            port:        SEREN_PORT,
            gpuLayers:   seren.gpuLayers   ?? 99,
            contextSize: seren.contextSize ?? 4096,
            threads:     seren.threads     ?? 0,
            deviceIndex: seren.deviceIndex,
            gpuBackend:  seren.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
          })
        : stopServer('seren'),
    ]);

    const errors: string[] = [];
    if (sayonErr.status   === 'rejected') errors.push(`sayon: ${sayonErr.reason}`);
    if (serenErr.status === 'rejected') errors.push(`seren: ${serenErr.reason}`);

    return reply.send({
      ok:     errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      status: getServerStatus(),
    });
  });

  // POST /api/phobos/stop
  fastify.post('/api/phobos/stop', async (_req, reply) => {
    await Promise.all([stopServer('sayon'), stopServer('seren')]);
    return reply.send({ ok: true, status: getServerStatus() });
  });

  // GET /api/phobos/status
  fastify.get('/api/phobos/status', async (_req, reply) => {
    return reply.send({ status: getServerStatus() });
  });

  // GET /api/phobos/models/info
  // Returns the models folder path, total disk usage, and active path overrides.
  fastify.get('/api/phobos/models/info', async (_req, reply) => {
    const modelsDir = MODELS_DIR();
    let totalBytes = 0;
    const countFiles = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) countFiles(full);
          else try { totalBytes += fs.statSync(full).size; } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist yet */ }
    };
    countFiles(modelsDir);

    const overrides: Record<string, string> = {};
    for (const [k, v] of ModelPathStore.getAllOverrides()) overrides[k] = v;

    return reply.send({ path: modelsDir, totalBytes, overrides });
  });

  // GET /api/phobos/open-folder?path=...
  // Opens a folder in the native file manager. Used by the UI's "Open" button.
  fastify.get<{ Querystring: { path: string } }>(
    '/api/phobos/open-folder',
    async (req, reply) => {
      const folderPath = req.query.path;
      if (!folderPath) return reply.status(400).send({ error: 'path required' });
      try {
        const { exec } = await import('child_process');
        const cmd = process.platform === 'win32' ? `explorer "${folderPath}"`
          : process.platform === 'darwin' ? `open "${folderPath}"`
          : `xdg-open "${folderPath}"`;
        exec(cmd);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // DELETE /api/phobos/models/:modelId
  fastify.delete<{ Params: { modelId: string } }>(
    '/api/phobos/models/:modelId',
    async (req, reply) => {
      const { modelId } = req.params;

      const status = getServerStatus();
      for (const [role, s] of Object.entries(status) as [string, { state: string; modelId: string }][]) {
        if (s.modelId === modelId && (s.state === 'running' || s.state === 'starting')) {
          return reply.status(409).send({
            error: `Model is currently loaded in ${role.toUpperCase()} server. Stop the server before deleting.`,
          });
        }
      }

      try {
        const existed = deleteModel(modelId);
        if (!existed) return reply.status(404).send({ error: `Model not found: ${modelId}` });
        return reply.send({ ok: true, modelId });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // GET /api/phobos/models/:modelId/uncensored
  // Returns a list of publicly-available uncensored GGUF variants for a given
  // catalogue model, sourced from HuggingFace Hub search. No auth required.
  fastify.get<{ Params: { modelId: string } }>(
    '/api/phobos/models/:modelId/uncensored',
    async (req, reply) => {
      const spec = getSpec(req.params.modelId);
      if (!spec) return reply.status(404).send({ error: 'Unknown model ID' });
      const variants = findUncensoredVariants(spec.modelId);
      return reply.send({ variants });
    },
  );

  // GET /api/phobos/models/:modelId/download-variant-sse?repoId=...&fileName=...
  // SSE stream — downloads a specific HF variant, writing it to the
  // original model's on-disk path (replacing it in-place).
  fastify.get<{
    Params: { modelId: string };
    Querystring: { repoId: string; fileName: string };
  }>(
    '/api/phobos/models/:modelId/download-variant-sse',
    async (req, reply) => {
      const { modelId } = req.params;
      const { repoId, fileName } = req.query;

      if (!repoId || !fileName) {
        return reply.status(400).send({ error: 'repoId and fileName required' });
      }

      const spec = getSpec(modelId);
      if (!spec) return reply.status(404).send({ error: 'Unknown model ID' });

      const variantUrl = `https://huggingface.co/${repoId}/resolve/main/${fileName}`;
      const destPath   = modelPath(spec);
      // sizeBytes unknown at this point — pass 0, downloadVariantModel will
      // use the Content-Length header from the response once connected.
      const sizeBytes  = 0;

      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (data: object) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        for await (const progress of downloadVariantModel(modelId, variantUrl, destPath, sizeBytes)) {
          send(progress);
          if (progress.done || progress.error) break;
        }
      } catch (err) {
        send({ modelId, phase: 'seren', bytesReceived: 0, bytesTotal: sizeBytes, done: false,
          error: err instanceof Error ? err.message : String(err) });
      } finally {
        reply.raw.end();
      }
    },
  );

  // POST /api/phobos/cleanup
  // Deletes LLM models from the cleanup list. Stops servers first if any model
  // being deleted is currently loaded. Only LLM models — never optional models.
  fastify.post<{
    Body: { modelIds: string[] };
  }>('/api/phobos/cleanup', async (req, reply) => {
    const { modelIds } = req.body;
    if (!modelIds || modelIds.length === 0) return reply.send({ ok: true, deleted: [] });

    // Check if any model being cleaned is currently loaded
    const status = getServerStatus();
    const loadedIds = new Set<string>();
    for (const [, s] of Object.entries(status) as [string, { state: string; modelId: string }][]) {
      if (s.modelId && (s.state === 'running' || s.state === 'starting')) {
        loadedIds.add(s.modelId);
      }
    }
    const needsStop = modelIds.some(id => loadedIds.has(id));

    // Stop servers if a loaded model is being cleaned
    if (needsStop) {
      await Promise.all([stopServer('sayon'), stopServer('seren')]);
    }

    // Delete each model
    const deleted: string[] = [];
    const errors: string[]  = [];
    for (const modelId of modelIds) {
      try {
        if (deleteModel(modelId)) deleted.push(modelId);
      } catch (err) {
        errors.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return reply.send({ ok: errors.length === 0, deleted, errors: errors.length > 0 ? errors : undefined, serversStopped: needsStop });
  });

  // ── Image model routes ───────────────────────────────────────────────────

  // GET /api/phobos/image/catalogue
  // Returns full catalogue of all image models across all runner profiles,
  // each with download state and hardware-selected aux file recommendations.
  fastify.get('/api/phobos/image/catalogue', async (_req, reply) => {
    const hw = await detectHardware();

    // ── Multi-GPU aware hardware summary ──────────────────────────────────────
    // Collect ALL GPUs that could run image gen (discrete GPUs with VRAM).
    // Each GPU gets its own T5 recommendation; we download the union of all.
    // NOTE: unifiedMemory is determined by the GPU's actual property, NOT by
    // whether index >= 100 (which just means non-NVIDIA, not unified).
    const imageCapableGpus = hw.gpus.filter(g => g.vramGb > 0);

    // Pick the "best" GPU for display/VRAM-ok checks (highest VRAM discrete first)
    const bestGpu = [...imageCapableGpus]
      .sort((a, b) => {
        // Discrete before unified
        const uDiff = (a.unifiedMemory ? 1 : 0) - (b.unifiedMemory ? 1 : 0);
        if (uDiff !== 0) return uDiff;
        // Then by VRAM descending
        return b.vramGb - a.vramGb;
      })[0] ?? null;

    const totalVramGb = bestGpu?.vramGb ?? 0;
    const isUnified   = bestGpu?.unifiedMemory === true;

    const hardware = {
      totalVramGb,
      isUnifiedMemory: isUnified,
      gpuName:  bestGpu?.name ?? 'Unknown',
      backend:  bestGpu?.backend ?? 'cpu',
      gpus: imageCapableGpus.map(g => ({
        index:    g.index,
        name:     g.name,
        vramGb:   g.vramGb,
        backend:  g.backend,
        unified:  g.unifiedMemory === true,
      })),
    };

    const models = IMAGE_MODEL_CATALOGUE.filter(spec => !spec.blocked).map(spec => {
      // Determine aux files for this model.
      // For T5-dependent models, collect T5 encoders for ALL GPUs so the
      // download includes every T5 size any GPU in the system might need.
      let auxFiles: typeof FLUX_AUX_REQUIRED;
      let recommendedT5: string | undefined;

      if (spec.runnerProfile === 'flux1-kontext') {
        const t5s = recommendT5EncodersForAllGpus(spec, imageCapableGpus);
        recommendedT5 = t5s[0]?.id;
        auxFiles = [...KONTEXT_AUX_REQUIRED, ...t5s];
      } else if (spec.runnerProfile === 'flux2') {
        auxFiles = spec.modelId.includes('9b') ? [...FLUX2_9B_AUX_REQUIRED] : [...FLUX2_4B_AUX_REQUIRED];
      } else if (spec.runnerProfile === 'z-image') {
        auxFiles = [...ZIMAGE_AUX_REQUIRED];
      } else if (spec.runnerProfile === 'qwen-image') {
        auxFiles = [...QWEN_IMAGE_AUX_REQUIRED];
      } else if (spec.runnerProfile === 'wan') {
        auxFiles = spec.modelId.includes('i2v') ? [...WAN_I2V_AUX_REQUIRED] : [...WAN_AUX_REQUIRED];
      } else if (spec.runnerProfile === 'sdxl') {
        auxFiles = [...SDXL_AUX_REQUIRED];
      } else {
        // flux and chroma — T5 tiered by VRAM; chroma skips CLIP-L
        const t5s = recommendT5EncodersForAllGpus(spec, imageCapableGpus);
        recommendedT5 = t5s[0]?.id;
        const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
        auxFiles = [...baseAux, ...t5s];
      }

      const mainDownloaded = isImageModelDownloaded(spec);

      // Build a map of T5 aux file -> which GPUs use it
      const t5GpuMap = new Map<string, string[]>();
      if (spec.runnerProfile !== 'sdxl' && spec.runnerProfile !== 'flux2' && spec.runnerProfile !== 'z-image' && spec.runnerProfile !== 'qwen-image' && spec.runnerProfile !== 'wan') {
        for (const gpu of imageCapableGpus) {
          const isUnifiedG = gpu.unifiedMemory === true;
          const t5 = recommendT5Encoder(spec, gpu.vramGb, isUnifiedG);
          const shortName = gpu.name.replace(/NVIDIA |AMD |Intel |Apple |Radeon\(TM\) |GeForce /g, '').trim();
          if (!t5GpuMap.has(t5.id)) t5GpuMap.set(t5.id, []);
          t5GpuMap.get(t5.id)!.push(shortName);
        }
      }

      const auxStatus = auxFiles.map(a => ({
        id:         a.id,
        label:      a.label,
        sizeBytes:  a.sizeBytes,
        downloaded: isFluxAuxDownloaded(a),
        license:    a.license,
        licenseUrl: a.licenseUrl,
        forGpus:    t5GpuMap.get(a.id) ?? undefined,
      }));
      const allDownloaded = mainDownloaded && auxStatus.every(a => a.downloaded);
      // MoE dual-model: include HighNoise GGUF in download total.
      // mainDownloaded already checks both files via isImageModelDownloaded().
      const highNoisePending = spec.highNoiseHfFile && !mainDownloaded
        ? (spec.highNoiseSizeBytes ?? 0) : 0;
      const totalDownloadBytes = (mainDownloaded ? 0 : spec.sizeBytes)
        + highNoisePending
        + auxStatus.reduce((s, a) => s + (a.downloaded ? 0 : a.sizeBytes), 0);

      // ── Node prerequisite files: ESRGAN upscale models ──────────────────────
      // These are workflow node prerequisites bundled with every image model so
      // they appear in the checklist and download alongside the main model.
      // Only the x4plus general model is required — anime and x2plus are optional.
      const esrganRequired = ESRGAN_MODELS.filter(m => m.id === 'realesrgan-x4plus');
      const esrganStatus = esrganRequired.map(m => ({
        id:         m.id,
        label:      m.label,
        sizeBytes:  m.sizeBytes,
        downloaded: isEsrganDownloaded(m),
        license:    'BSD-3-Clause',
        licenseUrl: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE',
      }));

      // Depth model: Depth Anything V2 ViT-S ~97 MB ONNX
      // Downloaded directly via onnxruntime-node (no @xenova/transformers dependency).
      // Cached at VISION_MODELS_DIR/depth-anything-small/model_quantized.onnx
      const depthModelFile = require('path').join(VISION_MODELS_DIR(), 'depth-anything-small', 'model_quantized.onnx');
      const depthDownloaded = require('fs').existsSync(depthModelFile);
      const depthStatus = [{
        id:         'depth-model',
        label:      'Depth model (DepthControlNet node, ~97 MB)',
        sizeBytes:  97_000_000,
        downloaded: depthDownloaded,
        license:    'Apache-2.0',
        licenseUrl: 'https://huggingface.co/LiheYoung/depth-anything-small-hf',
      }];

      const nodePrereqStatus = [...esrganStatus, ...depthStatus];
      const allPrereqsDownloaded = nodePrereqStatus.every(p => p.downloaded);
      const allFilesDownloaded = allDownloaded && allPrereqsDownloaded;
      const prereqDownloadBytes = nodePrereqStatus.reduce((s, p) => s + (p.downloaded ? 0 : p.sizeBytes), 0);

      // ── Per-GPU VRAM compatibility ──────────────────────────────────────────
      // Models with encoderMb > 0 have a built-in LLM encoder (Z-Image, Klein, Qwen-Image).
      // Models with encoderMb === 0 use external T5 (FLUX/Chroma) or have everything baked in (SDXL).
      // For external-T5 models, encoder size = the T5 tier recommended for THAT GPU.
      const vulkanBlockedEncoderModels = new Set(['flux2-klein-9b-q4', 'qwen-image-q4']);
      const vulkanBlockedLargeModels   = new Set([
        'flux-dev-q4', 'flux-dev-q8', 'flux-schnell-q8',  // huge diffusion, impractical on Vulkan
        'wan21-t2v-14b-q4', 'wan21-i2v-14b-480p-q4', 'wan22-t2v-14b-q4',  // 14B video models
      ]);

      const gpuCompat = imageCapableGpus.map(gpu => {
        const vramMb     = gpu.vramGb * 1024;
        const isVulkan   = gpu.backend === 'vulkan';
        const isUnifiedG = gpu.unifiedMemory === true;
        const workingMb  = gpu.backend === 'cuda' ? 512 : 256;

        // Determine encoder size for this GPU
        let encMb = spec.diffusionMb > 0 ? spec.encoderMb : 0;
        if (encMb === 0 && spec.runnerProfile !== 'sdxl') {
          // External T5 — pick tier based on this GPU's budget
          if (isUnifiedG) {
            // Unified memory: use Q8 if >= 16GB total, else Q3
            encMb = gpu.vramGb >= 16 ? 5100 : 2300;
          } else {
            const t5Budget = vramMb - spec.diffusionMb - (spec.vaeMb || 95) - workingMb;
            if (t5Budget >= 5100)      encMb = 5100;  // Q8
            else if (t5Budget >= 2300) encMb = 2300;  // Q3
            else                       encMb = 2300;  // minimum viable
          }
        }

        const totalMb = spec.diffusionMb + encMb + (spec.vaeMb || 0) + workingMb;

        // Vulkan-specific blocks — applies to ALL Vulkan GPUs including unified.
        // The Vulkan per-allocation buffer limit (~2 GB) is a driver/API constraint,
        // not a VRAM capacity issue. Unified memory doesn't bypass it.
        let vulkanBlocked = false;
        let reason: string | undefined;
        if (isVulkan) {
          if (vulkanBlockedEncoderModels.has(spec.modelId)) {
            vulkanBlocked = true;
            reason = 'Encoder exceeds Vulkan 2GB buffer limit';
          } else if (vulkanBlockedLargeModels.has(spec.modelId)) {
            vulkanBlocked = true;
            reason = 'Impractical on Vulkan (use CUDA or ROCm)';
          }
        }

        // VRAM fit check — unified memory always fits (RAM = VRAM pool),
        // but vulkanBlocked overrides even if it fits.
        const fits = isUnifiedG ? !vulkanBlocked : (totalMb <= vramMb && !vulkanBlocked);

        if (!fits && !isUnifiedG && !vulkanBlocked) {
          const shortMb = totalMb - vramMb;
          reason = `${(shortMb / 1024).toFixed(1)} GB short`;
        }

        return {
          gpuIndex:  gpu.index,
          gpuName:   gpu.name,
          backend:   gpu.backend as string,
          vramMb,
          totalNeededMb: totalMb,
          fits,
          vulkanBlocked,
          reason,
        };
      });

      return {
        modelId:            spec.modelId,
        label:              spec.label,
        displayName:        spec.displayName,
        runnerProfile:      spec.runnerProfile,
        category:           spec.category,
        variant:            spec.variant,
        quantization:       spec.quantization,
        sizeBytes:          spec.sizeBytes,
        vramRequiredGb:     spec.vramRequiredGb,
        license:            spec.license,
        licenseUrl:         spec.licenseUrl,
        estSecondsCuda:     spec.estSecondsCuda,
        estSecondsVulkan:   spec.estSecondsVulkan,
        downloaded:         allFilesDownloaded,
        mainDownloaded,
        auxFiles:           [...auxStatus, ...nodePrereqStatus],
        ...(recommendedT5 ? { recommendedT5 } : {}),
        totalDownloadBytes: totalDownloadBytes + prereqDownloadBytes,
        profile:            spec.profile ?? null,
        gpuCompat,
        // Pre-converted diffusers directory exists — from_pretrained path available
        pytorchVariantReady: getPytorchVariantDir(spec.modelId) !== null,
        // CivitAI-only models: frontend shows "requires CivitAI token" when no token is set
        ...(spec.civitaiVersionId ? { civitaiVersionId: spec.civitaiVersionId } : {}),
      };
    });

    return reply.send({ models, hardware });
  });

  // ── CivitAI API token management ─────────────────────────────────────────
  // Token stored at ~/.phobos/civitai-token.txt — never sent to the frontend.

  fastify.get('/api/phobos/civitai-token', async (_req, reply) => {
    return reply.send({ hasToken: getCivitaiToken().length > 0 });
  });

  fastify.put<{ Body: { token: string } }>('/api/phobos/civitai-token', async (req, reply) => {
    const { token } = req.body ?? {};
    if (!token || typeof token !== 'string') {
      return reply.status(400).send({ error: 'Missing token' });
    }
    setCivitaiToken(token);
    console.log('[phobosLocal] CivitAI API token saved');
    return reply.send({ ok: true });
  });

  fastify.delete('/api/phobos/civitai-token', async (_req, reply) => {
    setCivitaiToken('');
    console.log('[phobosLocal] CivitAI API token cleared');
    return reply.send({ ok: true });
  });

  // GET /api/phobos/image/download?modelId=<id>
  // SSE stream — downloads main model + all aux files for the given model.
  fastify.get<{ Querystring: { modelId: string } }>(
    '/api/phobos/image/download',
    async (req, reply) => {
      const { modelId } = req.query;
      const spec = getImageModelSpec(modelId);
      if (!spec) {
        return reply.status(400).send({ error: `Unknown image model: ${modelId}` });
      }

      // CivitAI models require a token
      if (spec.civitaiVersionId && !getCivitaiToken()) {
        return reply.status(400).send({ error: 'CivitAI API token required. Set it in the Optional Models panel.' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (data: object) => {
        try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
      };

      _imageDownloadActive = true;
      try {
        const hw = await detectHardware();
        const imageCapableGpus = hw.gpus.filter(g => g.vramGb > 0);

        let auxFiles: typeof FLUX_AUX_REQUIRED;
        if (spec.runnerProfile === 'flux1-kontext') {
          const t5s = recommendT5EncodersForAllGpus(spec, imageCapableGpus);
          auxFiles = [...KONTEXT_AUX_REQUIRED, ...t5s];
        } else if (spec.runnerProfile === 'flux2') {
          auxFiles = spec.modelId.includes('9b') ? [...FLUX2_9B_AUX_REQUIRED] : [...FLUX2_4B_AUX_REQUIRED];
        } else if (spec.runnerProfile === 'z-image') {
          auxFiles = [...ZIMAGE_AUX_REQUIRED];
        } else if (spec.runnerProfile === 'qwen-image') {
          auxFiles = [...QWEN_IMAGE_AUX_REQUIRED];
        } else if (spec.runnerProfile === 'wan') {
          auxFiles = spec.modelId.includes('i2v') ? [...WAN_I2V_AUX_REQUIRED] : [...WAN_AUX_REQUIRED];
        } else if (spec.runnerProfile === 'sdxl') {
          auxFiles = [...SDXL_AUX_REQUIRED];
        } else {
          // flux and chroma — download T5 encoders for all GPUs
          const t5s = recommendT5EncodersForAllGpus(spec, imageCapableGpus);
          const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
          auxFiles = [...baseAux, ...t5s];
        }

        for await (const progress of downloadFluxModel(spec, auxFiles)) {
          send(progress);
          if (progress.error) break;
        }

        // ── Download ESRGAN x4plus (required by Upscale node) ─────────────────
        const esrganSpec = ESRGAN_MODELS.find(m => m.id === 'realesrgan-x4plus')!;
        if (!isEsrganDownloaded(esrganSpec)) {
          for await (const progress of downloadEsrgan(esrganSpec)) {
            // Map ESRGAN progress to FluxDownloadProgress shape for consistent SSE
            send({
              fileId:        progress.id,
              phase:         'flux-aux',
              label:         esrganSpec.label,
              bytesReceived: progress.bytesReceived,
              bytesTotal:    progress.bytesTotal,
              done:          progress.done,
              ...(progress.error ? { error: progress.error } : {}),
            });
            if (progress.error) break;
          }
        } else {
          send({ fileId: esrganSpec.id, phase: 'flux-aux', label: esrganSpec.label,
                 bytesReceived: esrganSpec.sizeBytes, bytesTotal: esrganSpec.sizeBytes, done: true });
        }

        // ── Prefetch depth model (DepthControlNet node) ───────────────────────
        // @xenova/transformers downloads ~97 MB to VISION_MODELS_DIR on first call.
        // No per-byte progress available — runs in background, send a single event.
        send({ fileId: 'depth-model', phase: 'flux-aux', label: 'Depth model (DepthControlNet)',
               bytesReceived: 0, bytesTotal: 97_000_000, done: false });
        try {
          await prefetchVisionModels(['depth']);
          send({ fileId: 'depth-model', phase: 'flux-aux', label: 'Depth model (DepthControlNet)',
                 bytesReceived: 97_000_000, bytesTotal: 97_000_000, done: true });
        } catch {
          // Non-fatal — depth model will still download on first node use
          send({ fileId: 'depth-model', phase: 'flux-aux', label: 'Depth model (DepthControlNet)',
                 bytesReceived: 0, bytesTotal: 97_000_000, done: true });
        }

        send({ fileId: 'complete', phase: 'complete', label: 'Done', bytesReceived: 0, bytesTotal: 0, done: true });
      } catch (err) {
        console.error(`[phobosLocal] image download error (${modelId}): ${err}`);
        send({ fileId: 'error', phase: 'error', label: String(err), bytesReceived: 0, bytesTotal: 0, done: true, error: String(err) });
      } finally {
        _imageDownloadActive = false;
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    }
  );

  // DELETE /api/phobos/image/:modelId
  fastify.delete<{ Params: { modelId: string } }>(
    '/api/phobos/image/:modelId',
    async (req, reply) => {
      if (_imageDownloadActive) {
        return reply.status(409).send({ error: 'Cannot delete models while a download is in progress' });
      }
      const spec = getImageModelSpec(req.params.modelId);
      if (!spec) return reply.status(404).send({ error: 'Unknown image model' });
      const p = fluxModelPath(spec);
      const fs = await import('fs');
      if (!fs.existsSync(p)) return reply.status(404).send({ error: 'File not found' });
      fs.unlinkSync(p);
      return reply.send({ ok: true });
    }
  );

  // DELETE /api/phobos/image/download/cancel?modelId=<id>
  // Cleans up in-progress .download temp files when the user cancels an image download.
  fastify.delete<{ Querystring: { modelId: string } }>(
    '/api/phobos/image/download/cancel',
    async (req, reply) => {
      const spec = getImageModelSpec(req.query.modelId);
      if (!spec) return reply.status(400).send({ error: 'Unknown image model' });

      const hw        = await detectHardware().catch(() => ({ gpus: [] }));
      const bestGpu   = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb)[0] ?? null;
      const totalVram = bestGpu?.vramGb ?? 0;
      const isUnified = bestGpu?.unifiedMemory === true || (bestGpu?.index ?? 0) >= 100;

      let auxFiles: typeof FLUX_AUX_REQUIRED;
      if (spec.runnerProfile === 'flux') {
        const t5 = recommendT5Encoder(spec, totalVram, isUnified);
        const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
        auxFiles = [...baseAux, t5];
      } else {
        auxFiles = [...SDXL_AUX_REQUIRED];
      }

      cancelImageDownload(spec, auxFiles);
      return reply.send({ ok: true });
    }
  );

  // ── PyTorch variant conversion routes ────────────────────────────────────────

  // GET /api/phobos/image/convert?modelId=<id>
  // SSE stream — converts a single-file model to a split diffusers directory.
  // Shares the _imageDownloadActive lock so downloads and conversions are mutually exclusive.
  fastify.get<{ Querystring: { modelId: string } }>(
    '/api/phobos/image/convert',
    async (req, reply) => {
      const { modelId } = req.query;
      const spec = getImageModelSpec(modelId);
      if (!spec) {
        return reply.status(400).send({ error: `Unknown image model: ${modelId}` });
      }
      if (spec.runnerProfile !== 'sdxl') {
        return reply.status(400).send({ error: `PyTorch conversion is only supported for SDXL models (got: ${spec.runnerProfile})` });
      }
      if (_imageDownloadActive) {
        return reply.status(409).send({ error: 'A download or conversion is already in progress' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (data: object) => {
        try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
      };

      _imageDownloadActive = true;
      try {
        const hw = await detectHardware();
        const bestGpu = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb)[0] ?? null;
        const vendor = bestGpu ? gpuToVendor(bestGpu) : 'cpu';

        if (!isVendorReady(vendor)) {
          send({ phase: 'error', pct: 0, label: 'PyTorch environment not installed', message: `PyTorch env not ready for vendor: ${vendor}` });
          return;
        }

        const modelPath = fluxModelPath(spec);
        console.log(`[phobosLocal] Converting ${modelId} to PyTorch variant — vendor: ${vendor}, path: ${modelPath}`);

        for await (const progress of convertModelToPyTorch(modelId, modelPath, 'sdxl', vendor)) {
          send(progress);
          if (progress.phase === 'error') return;
        }

        send({ phase: 'done', pct: 1, label: 'Conversion complete' });
      } catch (err) {
        console.error(`[phobosLocal] convert error (${modelId}): ${err}`);
        send({ phase: 'error', pct: 0, label: String(err), message: String(err) });
      } finally {
        _imageDownloadActive = false;
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    }
  );

  // DELETE /api/phobos/image/convert/cancel?modelId=<id>
  // Best-effort abort — the SSE disconnect will kill the convert process naturally,
  // but this endpoint lets the frontend signal intent explicitly.
  fastify.delete<{ Querystring: { modelId: string } }>(
    '/api/phobos/image/convert/cancel',
    async (_req, reply) => {
      // The convert process will exit when the SSE connection drops.
      // _imageDownloadActive is cleared in the SSE route's finally block.
      return reply.send({ ok: true });
    }
  );

  // ── ESRGAN upscale model routes ──────────────────────────────────────────────

  // GET /api/phobos/upscale/models
  fastify.get('/api/phobos/upscale/models', async (_req, reply) => {
    return reply.send({
      models: ESRGAN_MODELS.map((m) => ({
        ...m,
        downloaded: isEsrganDownloaded(m),
      })),
    });
  });

  // GET /api/phobos/upscale/download?id=<id>  — SSE stream
  fastify.get<{ Querystring: { id: string } }>(
    '/api/phobos/upscale/download',
    async (req, reply) => {
      const spec = ESRGAN_MODELS.find((m) => m.id === req.query.id);
      if (!spec) return reply.status(400).send({ error: `Unknown ESRGAN model: ${req.query.id}` });

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (data: object) => {
        try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
      };

      try {
        for await (const progress of downloadEsrgan(spec)) {
          send(progress);
          if (progress.error) break;
        }
        send({ id: 'complete', bytesReceived: 0, bytesTotal: 0, done: true });
      } catch (err) {
        send({ id: 'error', error: String(err), done: true });
      } finally {
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    }
  );

  // DELETE /api/phobos/upscale/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/phobos/upscale/:id',
    async (req, reply) => {
      const spec = ESRGAN_MODELS.find((m) => m.id === req.params.id);
      if (!spec) return reply.status(404).send({ error: 'Unknown ESRGAN model' });
      const p = esrganModelPath(spec);
      const fs = await import('fs');
      if (!fs.existsSync(p)) return reply.status(404).send({ error: 'Not downloaded' });
      fs.unlinkSync(p);
      return reply.send({ ok: true });
    }
  );

  // DELETE /api/phobos/download/cancel?sayon=<id>&seren=<id>
  // Cleans up in-progress .download temp files when the user cancels an LLM download.
  fastify.delete<{ Querystring: { sayon?: string; seren?: string } }>(
    '/api/phobos/download/cancel',
    async (req, reply) => {
      const ids = [req.query.sayon, req.query.seren].filter(Boolean) as string[];
      cancelLlmDownload(...ids);
      return reply.send({ ok: true });
    }
  );

  // ── Model path management ─────────────────────────────────────────────────

  // POST /api/phobos/models/scan-folder
  // Scans a folder for known model files. Returns matches for the dialog preview.
  // Does NOT write anything — read-only probe.
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/phobos/models/scan-folder',
    async (req, reply) => {
      const { folderPath } = req.body;
      if (!folderPath || typeof folderPath !== 'string') {
        return reply.status(400).send({ error: 'folderPath required' });
      }
      if (!fs.existsSync(folderPath)) {
        return reply.send({ matches: [], totalKnown: GGUF_CATALOGUE.length + IMAGE_MODEL_CATALOGUE.length });
      }
      const matches = scanFolderForModels(folderPath);
      return reply.send({
        matches,
        totalKnown: GGUF_CATALOGUE.length + IMAGE_MODEL_CATALOGUE.length,
      });
    }
  );

  // PUT /api/phobos/models/base-path
  // Sets the models base path. Optionally scans the new folder and writes
  // override entries for any models found there (so they don't need re-download).
  fastify.put<{ Body: { folderPath: string; applyOverridesFromScan?: boolean } }>(
    '/api/phobos/models/base-path',
    async (req, reply) => {
      const { folderPath, applyOverridesFromScan = true } = req.body;
      if (!folderPath || typeof folderPath !== 'string') {
        return reply.status(400).send({ error: 'folderPath required' });
      }

      const db = DatabaseManager.getInstance();
      await ModelPathStore.setBasePath(db, folderPath);

      let matchCount = 0;
      if (applyOverridesFromScan) {
        const matches = scanFolderForModels(folderPath);
        for (const m of matches) {
          await ModelPathStore.setOverride(db, m.ns, m.modelId, m.absPath);
        }
        matchCount = matches.length;
      }

      return reply.send({ ok: true, basePath: folderPath, matchCount });
    }
  );

  // POST /api/phobos/models/resync
  // Clears all path overrides then re-scans the current base path to rebuild them.
  // Use after manually moving files into the base folder.
  fastify.post('/api/phobos/models/resync', async (_req, reply) => {
    const db = DatabaseManager.getInstance();
    await ModelPathStore.clearAllOverrides(db);
    const basePath = ModelPathStore.getBasePath();
    const matches  = scanFolderForModels(basePath);
    for (const m of matches) {
      await ModelPathStore.setOverride(db, m.ns, m.modelId, m.absPath);
    }
    return reply.send({ ok: true, basePath, matchCount: matches.length });
  });

  // PUT /api/phobos/models/:ns/:modelId/override
  // Manually maps a single model to an absolute file path.
  // Validates the file exists and is at least 90% of the expected size.
  fastify.put<{ Params: { ns: string; modelId: string }; Body: { filePath: string } }>(
    '/api/phobos/models/:ns/:modelId/override',
    async (req, reply) => {
      const { ns, modelId } = req.params;
      const { filePath }    = req.body;

      if (ns !== 'llm' && ns !== 'img') {
        return reply.status(400).send({ error: 'ns must be llm or img' });
      }
      if (!filePath || typeof filePath !== 'string') {
        return reply.status(400).send({ error: 'filePath required' });
      }
      if (!fs.existsSync(filePath)) {
        return reply.status(400).send({ error: `File not found: ${filePath}` });
      }

      // Size validation — find the spec and check against expected sizeBytes
      let expectedBytes = 0;
      if (ns === 'llm') {
        const spec = getSpec(modelId);
        if (!spec) return reply.status(404).send({ error: `Unknown LLM model: ${modelId}` });
        expectedBytes = spec.sizeBytes;
      } else {
        const spec = getImageModelSpec(modelId);
        if (!spec) return reply.status(404).send({ error: `Unknown image model: ${modelId}` });
        expectedBytes = spec.sizeBytes;
      }

      const actualBytes = fs.statSync(filePath).size;
      if (actualBytes < expectedBytes * 0.9) {
        return reply.status(400).send({
          error: `File appears incomplete: ${actualBytes} bytes, expected ~${expectedBytes} bytes`,
        });
      }

      const db = DatabaseManager.getInstance();
      await ModelPathStore.setOverride(db, ns as ModelPathStore.ModelNamespace, modelId, filePath);
      return reply.send({ ok: true, modelId, filePath });
    }
  );

  // DELETE /api/phobos/models/:ns/:modelId/override
  // Removes a manual path override — model reverts to base-path-derived location.
  fastify.delete<{ Params: { ns: string; modelId: string } }>(
    '/api/phobos/models/:ns/:modelId/override',
    async (req, reply) => {
      const { ns, modelId } = req.params;
      if (ns !== 'llm' && ns !== 'img') {
        return reply.status(400).send({ error: 'ns must be llm or img' });
      }
      const db = DatabaseManager.getInstance();
      await ModelPathStore.clearOverride(db, ns as ModelPathStore.ModelNamespace, modelId);
      return reply.send({ ok: true, modelId });
    }
  );

  // POST /api/phobos/models/open-file-dialog
  // Opens a native OS file picker and returns the selected path.
  // filter: 'gguf' | 'safetensors' | 'pth' | 'any'
  fastify.post<{ Body: { filter?: string } }>(
    '/api/phobos/models/open-file-dialog',
    async (req, reply) => {
      const filter = req.body?.filter ?? 'any';
      try {
        const { execFile: execFileCb } = await import('child_process');
        const { promisify } = await import('util');
        const execFileP = promisify(execFileCb);

        let selectedPath = '';

        if (process.platform === 'win32') {
          // WinForms OpenFileDialog requires EnableVisualStyles + explicit message pump.
          // Write a temp .ps1 and invoke it with -STA so the COM apartment is correct.
          const extensions = filter === 'gguf' ? '*.gguf'
            : filter === 'safetensors' ? '*.safetensors'
            : filter === 'pth' ? '*.pth'
            : '*.*';
          const tmpPs1 = path.join(os.tmpdir(), `phobos-file-${Date.now()}.ps1`);
          const ps1Script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '[System.Windows.Forms.Application]::EnableVisualStyles()',
            '$f = New-Object System.Windows.Forms.Form',
            '$f.TopMost = $true',
            '$f.ShowInTaskbar = $false',
            '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
            '$f.Show()',
            '$f.Hide()',
            '$d = New-Object System.Windows.Forms.OpenFileDialog',
            `$d.Filter = "Model files (${extensions})|${extensions}|All files (*.*)|*.*"`,
            '$d.Title = "Select model file"',
            '$d.Multiselect = $false',
            'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
            '$f.Dispose()',
          ].join("\r\n");
          try {
            fs.writeFileSync(tmpPs1, ps1Script, 'utf-8');
            const { stdout } = await execFileP('powershell', [
              '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1,
            ]);
            selectedPath = stdout.trim();
          } finally {
            try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ }
          }
        } else if (process.platform === 'darwin') {
          const ext = filter === 'gguf' ? 'gguf'
            : filter === 'safetensors' ? 'safetensors'
            : filter === 'pth' ? 'pth'
            : '';
          const typeClause = ext ? `of type {"${ext}"}` : '';
          const { stdout } = await execFileP('osascript', [
            '-e', `POSIX path of (choose file ${typeClause} with prompt "Select model file")`,
          ]);
          selectedPath = stdout.trim();
        } else {
          // Linux — try dialog tools in order: zenity, kdialog, yad
          const extFilter = filter !== 'any' ? `*.${filter}` : '';
          const tryExec = async (cmd: string, args: string[]): Promise<string | null> => {
            try {
              const { stdout } = await execFileP(cmd, args);
              return stdout.trim() || null;
            } catch { return null; }
          };
          const zenArgs = ['--file-selection', '--title=Select model file'];
          if (extFilter) zenArgs.push(`--file-filter=${extFilter}`);
          const kdArgs = ['--getopenfilename', os.homedir(), extFilter || '*'];
          const yadArgs = ['--file', '--title=Select model file'];
          if (extFilter) yadArgs.push(`--file-filter=${extFilter}`);
          selectedPath =
            await tryExec('zenity', zenArgs)
            ?? await tryExec('kdialog', kdArgs)
            ?? await tryExec('yad', yadArgs)
            ?? '';
        }

        if (!selectedPath) return reply.send({ path: null });
        return reply.send({ path: selectedPath });
      } catch (err) {
        // User cancelled (osascript exits non-zero on cancel) — not an error
        return reply.send({ path: null });
      }
    }
  );

  // POST /api/phobos/models/open-folder-dialog
  // Opens a native OS folder picker and returns the selected path.
  // Body: { initialPath?: string } — opens the dialog at this location if provided.
  fastify.post<{ Body: { initialPath?: string; title?: string } }>('/api/phobos/models/open-folder-dialog', async (req, reply) => {
    const initialPath = req.body?.initialPath ?? '';
    const title       = req.body?.title ?? 'Select a folder';
    try {
      const { execFile: execFileCb } = await import('child_process');
      const { promisify } = await import('util');
      const execFileP = promisify(execFileCb);

      let selectedPath = '';

      if (process.platform === 'win32') {
        // Modern Vista+ folder picker via IFileOpenDialog COM interop.
        // This replaces the ancient FolderBrowserDialog tree view with the
        // full Explorer-style dialog that supports navigation, breadcrumbs,
        // search, and respects the initial path reliably.
        const tmpPs1 = path.join(os.tmpdir(), `phobos-folder-${Date.now()}.ps1`);
        const escapedInitial = initialPath.replace(/'/g, "''");
        const ps1Script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '',
          '# Inline C# to access IFileOpenDialog COM with FOS_PICKFOLDERS',
          '$src = @"',
          'using System;',
          'using System.Runtime.InteropServices;',
          'using System.Windows.Forms;',
          '',
          '[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]',
          'class FileOpenDialogCOM {}',
          '',
          'public class FolderPicker {',
          '  public static string Show(string title, string initial, IntPtr hwnd) {',
          '    var dlg = (IFileOpenDialog)new FileOpenDialogCOM();',
          '    try {',
          '      dlg.SetOptions(0x00000020 | 0x00000800);',  // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
          '      dlg.SetTitle(title);',
          '      if (!string.IsNullOrEmpty(initial) && System.IO.Directory.Exists(initial)) {',
          '        IShellItem folder;',
          '        SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);',
          '        if (folder != null) dlg.SetFolder(folder);',
          '      }',
          '      var hr = dlg.Show(hwnd);',
          '      if (hr != 0) return "";',
          '      IShellItem item;',
          '      dlg.GetResult(out item);',
          '      string path;',
          '      item.GetDisplayName(0x80058000, out path);',
          '      return path ?? "";',
          '    } catch { return ""; }',
          '  }',
          '',
          '  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]',
          '  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [In] Guid riid, out IShellItem ppv);',
          '',
          '  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
          '  interface IShellItem {',
          '    void BindToHandler(IntPtr pbc, Guid bhid, Guid riid, out IntPtr ppv);',
          '    void GetParent(out IShellItem ppsi);',
          '    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);',
          '    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);',
          '    void Compare(IShellItem psi, uint hint, out int piOrder);',
          '  }',
          '',
          '  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
          '  interface IFileOpenDialog {',
          '    [PreserveSig] int Show(IntPtr hwndOwner);',
          '    void SetFileTypes();',
          '    void SetFileTypeIndex();',
          '    void GetFileTypeIndex();',
          '    void Advise();',
          '    void Unadvise();',
          '    void SetOptions(uint fos);',
          '    void GetOptions(out uint pfos);',
          '    void SetDefaultFolder(IShellItem psi);',
          '    void SetFolder(IShellItem psi);',
          '    void GetFolder(out IShellItem ppsi);',
          '    void GetCurrentSelection(out IShellItem ppsi);',
          '    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
          '    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);',
          '    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);',
          '    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);',
          '    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);',
          '    void GetResult(out IShellItem ppsi);',
          '    void AddPlace(IShellItem psi, int fdap);',
          '    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);',
          '    void Close(int hr);',
          '    void SetClientGuid(Guid guid);',
          '    void ClearClientData();',
          '    void SetFilter(IntPtr pFilter);',
          '    void GetResults();',
          '    void GetSelectedItems();',
          '  }',
          '}',
          '"@',
          '',
          'Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms -Language CSharp',
          '',
          '# Create a TopMost form to get a foreground HWND',
          '$f = New-Object System.Windows.Forms.Form',
          '$f.TopMost = $true',
          '$f.ShowInTaskbar = $false',
          '$f.WindowState = "Minimized"',
          '$f.Show()',
          '$f.Hide()',
          '',
          `$result = [FolderPicker]::Show("${title}", '${escapedInitial}', $f.Handle)`,
          '$f.Dispose()',
          'if ($result) { Write-Output $result }',
        ].join("\r\n");
        try {
          fs.writeFileSync(tmpPs1, ps1Script, 'utf-8');
          const { stdout } = await execFileP('powershell', [
            '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1,
          ]);
          selectedPath = stdout.trim();
        } finally {
          try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ }
        }
      } else if (process.platform === 'darwin') {
        const defaultClause = initialPath ? `default location POSIX file "${initialPath}"` : '';
        const { stdout } = await execFileP('osascript', [
          '-e', `POSIX path of (choose folder with prompt "${title}" ${defaultClause})`,
        ]);
        selectedPath = stdout.trim().replace(/\/$/, '');
      } else {
        // Linux — try dialog tools in order of availability.
        // zenity (GNOME), kdialog (KDE), yad (XFCE/GTK fork of zenity),
        // then xdg-desktop-portal via gdbus (works on any modern DE).
        const filenameArg = initialPath || os.homedir();
        const tryExec = async (cmd: string, args: string[]): Promise<string | null> => {
          try {
            const { stdout } = await execFileP(cmd, args);
            return stdout.trim() || null;
          } catch { return null; }
        };
        selectedPath =
          await tryExec('zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${filenameArg}/`])
          ?? await tryExec('kdialog', ['--getexistingdirectory', filenameArg])
          ?? await tryExec('yad', ['--file', '--directory', `--title=${title}`, `--filename=${filenameArg}/`])
          ?? '';
      }

      if (!selectedPath) return reply.send({ path: null });
      return reply.send({ path: selectedPath });
    } catch {
      return reply.send({ path: null });
    }
  });

  // POST /api/phobos/models/relocate
  // SSE stream. Stops servers, copies all model files to a new base path with
  // per-file progress events, verifies, updates base path, resyncs, deletes originals.
  // Cross-filesystem safe: always copy+delete, never rename.
  fastify.post<{ Body: { targetPath: string } }>(
    '/api/phobos/models/relocate',
    async (req, reply) => {
      const { targetPath } = req.body;
      if (!targetPath || typeof targetPath !== 'string') {
        return reply.status(400).send({ error: 'targetPath required' });
      }

      const sourcePath = MODELS_DIR();
      if (path.resolve(targetPath) === path.resolve(sourcePath)) {
        return reply.status(400).send({ error: 'Target is the same as current folder' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let aborted = false;
      (global as Record<string, unknown>).__phobosRelocateAbort = () => { aborted = true; };

      // Detect same drive/filesystem.
      // Windows: compare drive letter prefix (C:\ vs D:\).
      // POSIX: attempt a probe rename across the boundary — EXDEV means cross-device.
      const isSameDrive = (): boolean => {
        if (process.platform === 'win32') {
          const srcDrive = path.resolve(sourcePath).slice(0, 3).toLowerCase();
          const dstDrive = path.resolve(targetPath).slice(0, 3).toLowerCase();
          return srcDrive === dstDrive;
        }
        const probe    = path.join(sourcePath, '.phobos-probe');
        const probeDst = path.join(targetPath, '.phobos-probe');
        try {
          fs.mkdirSync(targetPath, { recursive: true });
          fs.writeFileSync(probe, '');
          fs.renameSync(probe, probeDst);
          fs.unlinkSync(probeDst);
          return true;
        } catch (e: unknown) {
          try { fs.unlinkSync(probe); }    catch { /* ignore */ }
          try { fs.unlinkSync(probeDst); } catch { /* ignore */ }
          return (e as NodeJS.ErrnoException).code !== 'EXDEV';
        }
      };

      try {
        _relocating = true;

        // 1. Snapshot running server configs BEFORE stopping (stop clears modelId)
        const preStopStatus = getServerStatus();
        const serverSnaps: Array<{ role: 'sayon' | 'seren'; modelId: string; port: number; gpuLayers: number; deviceIndex?: number; gpuBackend?: string }> = [];
        for (const role of ['sayon', 'seren'] as const) {
          const s = preStopStatus[role];
          if (s.state === 'running' && s.modelId) {
            serverSnaps.push({
              role,
              modelId:     s.modelId,
              port:        s.port,
              gpuLayers:   s.gpuLayers,
              deviceIndex: s.deviceIndex as number | undefined,
              gpuBackend:  s.gpuBackend as string | undefined,
            });
          }
        }

        send({ phase: 'stopping-servers' });
        const { stopServer: stopSrv } = await import('../phobos/LlamaServerManager.js');
        await Promise.all([stopSrv('sayon'), stopSrv('seren')]);

        // 2. Collect all files
        const filePairs: Array<{ src: string; dst: string; sizeBytes: number }> = [];
        const collectFiles = (srcDir: string) => {
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of entries) {
            const srcFull = path.join(srcDir, entry.name);
            const relPath = path.relative(sourcePath, srcFull);
            const dstFull = path.join(targetPath, relPath);
            if (entry.isDirectory()) {
              collectFiles(srcFull);
            } else if (entry.isFile() && !entry.name.endsWith('.download')) {
              try {
                filePairs.push({ src: srcFull, dst: dstFull, sizeBytes: fs.statSync(srcFull).size });
              } catch { /* skip unreadable */ }
            }
          }
        };
        collectFiles(sourcePath);

        const sameDrive = isSameDrive();
        const opPhase   = sameDrive ? 'moving' : 'copying';
        send({ phase: opPhase, fileCount: filePairs.length, fileIndex: 0 });

        // 3. Move each file — rename on same drive (instant, zero extra space),
        //    or copy → verify size → delete source sequentially on cross-drive.
        //    Never hold two copies of the same file at the same time.
        for (let i = 0; i < filePairs.length; i++) {
          if (aborted) { send({ phase: 'aborted' }); reply.raw.end(); return; }

          const { src, dst, sizeBytes } = filePairs[i];
          fs.mkdirSync(path.dirname(dst), { recursive: true });

          // Resume check
          let dstSize = 0;
          try { dstSize = fs.statSync(dst).size; } catch { /* not there yet */ }
          if (dstSize === sizeBytes) {
            // Destination already valid. On cross-drive a previous run may have
            // copied but not yet deleted the source — finish that now.
            if (!sameDrive) { try { fs.unlinkSync(src); } catch { /* ignore */ } }
            send({ phase: opPhase, fileIndex: i + 1, fileCount: filePairs.length, file: path.basename(src), skipped: true });
            continue;
          }

          if (sameDrive) {
            // Atomic rename — instant, zero extra disk space used
            fs.renameSync(src, dst);
          } else {
            // Cross-drive: copy → verify → delete source before moving to next file
            await fsPromises.copyFile(src, dst);
            const written = fs.statSync(dst).size;
            if (written !== sizeBytes) {
              try { fs.unlinkSync(dst); } catch { /* ignore */ }
              throw new Error(`Verification failed: ${path.basename(src)} (expected ${sizeBytes} bytes, got ${written})`);
            }
            fs.unlinkSync(src);
          }

          send({ phase: opPhase, fileIndex: i + 1, fileCount: filePairs.length, file: path.basename(src) });
        }

        // 4. Update base path + resync overrides
        send({ phase: 'updating-config' });
        const db = DatabaseManager.getInstance();
        await ModelPathStore.clearAllOverrides(db);
        await ModelPathStore.setBasePath(db, targetPath);
        const matches = scanFolderForModels(targetPath);
        for (const m of matches) {
          await ModelPathStore.setOverride(db, m.ns, m.modelId, m.absPath);
        }

        // 5. Clean up now-empty source directories.
        // Same-drive rename moves files but leaves empty dir shells.
        // Cross-drive copy+delete also leaves empty dirs.
        // Walk deepest-first so children are removed before parents.
        const tryRmdir = (dir: string) => {
          try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
        };
        const collectDirs = (dir: string): string[] => {
          const result: string[] = [];
          try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.isDirectory()) result.push(...collectDirs(path.join(dir, e.name)), path.join(dir, e.name));
            }
          } catch { /* ignore */ }
          return result;
        };
        for (const d of collectDirs(sourcePath)) tryRmdir(d);
        tryRmdir(sourcePath);

        send({ phase: 'done', targetPath, matchCount: matches.length });

        // 6. Restart LLM servers that were running before the move
        if (serverSnaps.length > 0) {
          send({ phase: 'restarting-servers' });
          for (const snap of serverSnaps) {
            try {
              await startServer(snap.role, {
                modelId:     snap.modelId,
                port:        snap.port,
                gpuLayers:   snap.gpuLayers,
                contextSize: 32768,
                threads:     0,
                deviceIndex: snap.deviceIndex,
                gpuBackend:  snap.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
              });
            } catch { /* non-fatal — servers may fail to restart if model paths shifted */ }
          }
        }
      } catch (err) {
        send({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        _relocating = false;
        delete (global as Record<string, unknown>).__phobosRelocateAbort;
        reply.raw.end();
      }
    }
  );

  // POST /api/phobos/models/relocate/abort
  fastify.post('/api/phobos/models/relocate/abort', async (_req, reply) => {
    const abort = (global as Record<string, unknown>).__phobosRelocateAbort as (() => void) | undefined;
    if (abort) abort();
    return reply.send({ ok: true });
  });

  // ── PyTorch environment management ────────────────────────────────────────

  // GET /api/phobos/python-env/status
  // Returns Python detection + per-vendor PyTorch venv readiness.
  // Used by the hardware cards in PhobosLLMPanel to show setup status.
  fastify.get('/api/phobos/python-env/status', async (_req, reply) => {
    const python = await detectPython();
    const vendors = await getVendorReadiness();
    // Augment each vendor with whether a background install is currently running.
    // This lets the frontend show a spinner on reconnect if pip is still in progress.
    const vendorsWithStatus = vendors.map(v => ({
      ...v,
      installing: isInstallingVendor(v.vendor),
    }));
    return reply.send({ python, vendors: vendorsWithStatus });
  });

  // POST /api/phobos/python-env/install
  // SSE stream — creates venv and installs PyTorch + Diffusers for a vendor.
  // Body: { vendor: 'cuda' | 'rocm' | 'xpu' | 'apple' }
  fastify.post<{
    Body: { vendor: string };
  }>('/api/phobos/python-env/install', async (req, reply) => {
    const vendor = req.body?.vendor as GpuVendor;
    if (!vendor || !['cuda', 'rocm', 'xpu', 'apple'].includes(vendor)) {
      return reply.status(400).send({ error: `Invalid vendor: ${vendor}` });
    }

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const emit = (data: Record<string, unknown>) => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
    };

    // Heartbeat — pip install operations for torch/ROCm can take 5-15 minutes
    // with no output. Without this the browser SSE connection times out (~2 min)
    // and the UI reverts while the install continues silently on the server.
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { /* socket closed */ }
    }, 30_000);

    try {
      for await (const progress of installPythonEnv(vendor)) {
        emit(progress as unknown as Record<string, unknown>);
      }
    } catch (err) {
      emit({ phase: 'error', vendor, label: err instanceof Error ? err.message : String(err), progress: -1, done: true, error: String(err) });
    } finally {
      clearInterval(heartbeat);
    }

    reply.raw.end();
  });

  // POST /api/phobos/python-env/reinstall
  // SSE stream — wipes the existing vendor env then runs a full fresh install.
  // Used by the "Update PyTorch env" button when isEnvStale() is true.
  // Identical SSE shape to /install so the frontend hook is reused unchanged.
  fastify.post<{
    Body: { vendor: string };
  }>('/api/phobos/python-env/reinstall', async (req, reply) => {
    const vendor = req.body?.vendor as GpuVendor;
    if (!vendor || !['cuda', 'rocm', 'xpu', 'apple'].includes(vendor)) {
      return reply.status(400).send({ error: `Invalid vendor: ${vendor}` });
    }

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const emit = (data: Record<string, unknown>) => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
    };

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n'); } catch { /* socket closed */ }
    }, 30_000);

    try {
      emit({ phase: 'detect', vendor, label: 'Removing existing environment…', progress: 0, done: false });
      await uninstallVendor(vendor);
      for await (const progress of installPythonEnv(vendor)) {
        emit(progress as unknown as Record<string, unknown>);
      }
    } catch (err) {
      emit({ phase: 'error', vendor, label: err instanceof Error ? err.message : String(err), progress: -1, done: true, error: String(err) });
    } finally {
      clearInterval(heartbeat);
    }

    reply.raw.end();
  });

  // GET /api/phobos/python-env/sage-check
  // Checks if SageAttention is installed at the correct version (≥2.1.1) in any venv.
  // Returns { installed: boolean, version: string | null, vendor: string | null }
  fastify.get('/api/phobos/python-env/sage-check', async (_req, reply) => {
    // Check CUDA venv first, then ROCm
    for (const vendor of ['cuda', 'rocm', 'xpu'] as GpuVendor[]) {
      if (!isVendorReady(vendor)) continue;
      const pyPath = getPythonPath(vendor);
      if (!pyPath) continue;
      try {
        const { execFile: execFileCb } = await import('child_process');
        const { promisify: prom } = await import('util');
        const exec = prom(execFileCb);
        const { stdout } = await exec(pyPath, ['-c', 'import sageattention; print(sageattention.__version__)'], { timeout: 15_000 });
        const version = stdout.trim();
        if (version) {
          // Check if version >= 2.1.1
          const parts = version.split('.').map(Number);
          const ok = parts[0] > 2 || (parts[0] === 2 && parts[1] > 1) || (parts[0] === 2 && parts[1] === 1 && parts[2] >= 1);
          return reply.send({ installed: ok, version, vendor });
        }
      } catch {
        // Not installed in this venv — try next
      }
    }
    return reply.send({ installed: false, version: null, vendor: null });
  });

  // POST /api/phobos/python-env/install-python
  // SSE stream — downloads Python 3.12.10 installer and runs it silently.
  // Windows only. No body required.
  // On failure the error event contains manual install instructions.
  fastify.post('/api/phobos/python-env/install-python', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const emit = (data: Record<string, unknown>) => {
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
    };

    try {
      for await (const progress of downloadAndInstallPython()) {
        emit(progress as unknown as Record<string, unknown>);
        if (progress.done) break;
      }
    } catch (err) {
      emit({
        phase: 'error',
        label: err instanceof Error ? err.message : String(err),
        done: true,
        error: String(err),
      });
    }

    reply.raw.end();
  });

  // POST /api/phobos/python-env/invalidate-cache
  // Clears the in-process Python detection cache and re-runs detection.
  // Call this after the user has installed Python manually in another window.
  // Returns the fresh PythonDetection result plus isPython312 flag.
  fastify.post('/api/phobos/python-env/invalidate-cache', async (_req, reply) => {
    invalidatePythonCache();
    const python = await detectPython();
    return reply.send({ python, isPython312: isPython312(python) });
  });

  // ── POST /api/phobos/audio-model/download ─────────────────────────────────
  //
  // Downloads a single audio model by modelId using direct HTTPS.
  // Mirrors the LLM/image download pattern: resume-capable, progress-emitting,
  // SSE-streamed to the client. All audio models are single-file downloads
  // (hfRepo + hfFile → https://huggingface.co/<repo>/resolve/main/<file>).
  // hfFile may contain a subdirectory path (e.g. F5TTS_v1_Base/model.safetensors).
  //
  // Body: { modelId: string }
  //
  // SSE events:
  //   { type: 'progress', bytesReceived, bytesTotal, pct }
  //   { type: 'done' }
  //   { type: 'error', message }

  fastify.post<{ Body: { modelId: string } }>(
    '/api/phobos/audio-model/download',
    async (req, reply) => {
      const { modelId } = req.body ?? {};
      if (!modelId) return reply.status(400).send({ error: '"modelId" required' });

      const spec = getAudioModelSpec(modelId);
      if (!spec) return reply.status(400).send({ error: `Unknown audio model: ${modelId}` });
      if (spec.blocked) return reply.status(400).send({ error: `Model ${modelId} is not yet available` });

      const origin = req.headers?.origin;
      const sseHead: Record<string, string> = {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      if (origin) sseHead['Access-Control-Allow-Origin'] = origin;
      reply.raw.writeHead(200, sseHead);

      const emit = (payload: Record<string, unknown>) => {
        try { reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket closed */ }
      };

      const abort = new AbortController();
      req.raw.socket?.on('close', () => abort.abort());

      try {
        // All audio models download as a single file via HTTPS — the same
        // resume-capable, redirect-following downloader used for LLM GGUFs.
        // hfFile may contain a subdirectory (e.g. F5TTS_v1_Base/model.safetensors)
        // so we mkdirSync on the full destPath's parent, not just audioModelDir.
        const THROTTLE_MS    = 250;
        const THROTTLE_BYTES = 2_097_152; // 2 MB

        const destPath = path.join(audioModelDir(spec), spec.hfFile);
        const tmpPath  = destPath + '.part';

        fs.mkdirSync(path.dirname(destPath), { recursive: true });

          const existingBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
          let bytesReceived   = existingBytes;
          let bytesTotal      = spec.sizeBytes;
          let lastEmitBytes   = existingBytes;
          let lastEmitTime    = Date.now();

          const reqHeaders: Record<string, string> = {
            'User-Agent': 'PHOBOS/1.0 (audio-model-downloader)',
          };
          if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

          const hfUrl = `https://huggingface.co/${spec.hfRepo}/resolve/main/${spec.hfFile}`;

          await new Promise<void>((resolve, reject) => {
            const follow = (url: string, hops = 0) => {
              if (hops > 10) { reject(new Error('Too many redirects')); return; }
              if (abort.signal.aborted) { resolve(); return; }
              const parsed = new URL(url);
              const req2   = https.get(
                { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders },
                (res) => {
                  if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    follow(res.headers.location!, hops + 1); return;
                  }
                  if (res.statusCode !== 200 && res.statusCode !== 206) {
                    reject(new Error(`HTTP ${res.statusCode}`)); return;
                  }
                  if (res.statusCode === 206) {
                    bytesTotal = existingBytes + parseInt(res.headers['content-length'] ?? '0', 10);
                  } else {
                    bytesTotal = parseInt(res.headers['content-length'] ?? String(spec.sizeBytes), 10);
                  }
                  const fd = fs.createWriteStream(tmpPath, { flags: existingBytes > 0 ? 'a' : 'w' });
                  res.on('data', (chunk: Buffer) => {
                    if (abort.signal.aborted) { res.destroy(); fd.destroy(); resolve(); return; }
                    bytesReceived += chunk.length;
                    fd.write(chunk);
                    const now = Date.now();
                    if (now - lastEmitTime >= THROTTLE_MS || bytesReceived - lastEmitBytes >= THROTTLE_BYTES) {
                      lastEmitTime  = now;
                      lastEmitBytes = bytesReceived;
                      const pct = bytesTotal > 0 ? Math.round((bytesReceived / bytesTotal) * 100) : 0;
                      emit({ type: 'progress', bytesReceived, bytesTotal, pct });
                    }
                  });
                  res.on('end', () => {
                    fd.end(() => {
                      try { fs.renameSync(tmpPath, destPath); } catch {
                        try { fs.copyFileSync(tmpPath, destPath); fs.unlinkSync(tmpPath); } catch { /* ignore */ }
                      }
                      resolve();
                    });
                  });
                  res.on('error', reject);
                },
              );
              req2.on('error', reject);
              abort.signal.addEventListener('abort', () => req2.destroy());
            };
            follow(hfUrl);
          });

        if (!abort.signal.aborted) {
          emit({ type: 'done' });
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          emit({ type: 'error', message: (err as Error).message });
        }
      } finally {
        reply.raw.end();
      }
    },
  );

}