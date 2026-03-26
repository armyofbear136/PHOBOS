import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import {
  detectHardware,
  buildRecommendation,
  isConfigOptimal,
  listDownloaded,
  isDownloaded,
  downloadModel,
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
  type EsrganSpec,
  type GGUFSpec,
  type ImageModelSpec,
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

// ── Image download lock ─────────────────────────────────────────────────────
// Prevents model deletion while a download is in progress.
// Set true when the image download SSE stream starts, cleared in its finally block.
let _imageDownloadActive = false;
export function isImageDownloadActive(): boolean { return _imageDownloadActive; }

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
  // Returns the models folder path and total disk usage for the UI.
  fastify.get('/api/phobos/models/info', async (_req, reply) => {
    const modelsDir = MODELS_DIR;
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
    return reply.send({ path: modelsDir, totalBytes });
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
        auxFiles = [...WAN_AUX_REQUIRED];
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
      const totalDownloadBytes = (mainDownloaded ? 0 : spec.sizeBytes)
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
      const depthModelFile = require('path').join(VISION_MODELS_DIR, 'depth-anything-small', 'model_quantized.onnx');
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
      };
    });

    return reply.send({ models, hardware });
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
          auxFiles = [...WAN_AUX_REQUIRED];
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
}