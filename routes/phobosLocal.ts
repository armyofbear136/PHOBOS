import type { FastifyInstance } from 'fastify';
import {
  detectHardware,
  buildRecommendation,
  listDownloaded,
  downloadModel,
  getSpec,
  deleteModel,
  GGUF_CATALOGUE,
  FLUX_CATALOGUE,
  FLUX_AUX_REQUIRED,
  CHROMA_AUX_REQUIRED,
  FLUX_T5_Q3,
  FLUX_T5_Q4,
  FLUX_T5_Q8,
  SDXL_AUX_REQUIRED,
  IMAGE_MODEL_CATALOGUE,
  CHROMA_CATALOGUE,
  getImageModelSpec,
  isFluxDownloaded,
  isImageModelDownloaded,
  isFluxAuxDownloaded,
  getAuxFilesForModel,
  recommendT5Encoder,
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
} from '../phobos/PhobosLocalManager.js';
import {
  startServer,
  stopServer,
  getServerStatus,
  SAYON_PORT,
  SEREN_PORT,
} from '../phobos/LlamaServerManager.js';

export async function phobosLocalRoute(fastify: FastifyInstance): Promise<void> {

  // GET /api/phobos/hardware
  fastify.get('/api/phobos/hardware', async (_req, reply) => {
    const hw  = await detectHardware();
    const rec = buildRecommendation(hw);
    return reply.send({ hardware: hw, recommendation: rec });
  });

  // GET /api/phobos/catalogue
  // Returns the full model catalogue (for frontend display of all available models).
  fastify.get('/api/phobos/catalogue', async (_req, reply) => {
    return reply.send({
      models: GGUF_CATALOGUE.map(s => ({
        modelId: s.modelId,
        label:   s.label,
        sizeBytes: s.sizeBytes,
        ramRequiredGb: s.ramRequiredGb,
        contextWindow: s.contextWindow,
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
    await downloadPhase(serenSpec, 'seren');

    emit({ phase: 'complete', done: true });
    reply.raw.end();
  });

  // POST /api/phobos/start
  // Body: { sayon: { modelId, gpuLayers?, contextSize?, threads?, deviceIndex?, gpuBackend? },
  //         seren: { ... } }
  fastify.post<{
    Body: {
      sayon:   { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number; deviceIndex?: number; gpuBackend?: string };
      seren: { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number; deviceIndex?: number; gpuBackend?: string };
    };
  }>('/api/phobos/start', async (req, reply) => {
    const { sayon, seren } = req.body;

    const [sayonErr, serenErr] = await Promise.allSettled([
      startServer('sayon', {
        modelId:     sayon.modelId,
        port:        SAYON_PORT,
        gpuLayers:   sayon.gpuLayers   ?? 0,
        contextSize: sayon.contextSize ?? 4096,
        threads:     sayon.threads     ?? 0,
        deviceIndex: sayon.deviceIndex,
        gpuBackend:  sayon.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
      }),
      startServer('seren', {
        modelId:     seren.modelId,
        port:        SEREN_PORT,
        gpuLayers:   seren.gpuLayers   ?? 99,
        contextSize: seren.contextSize ?? 4096,
        threads:     seren.threads     ?? 0,
        deviceIndex: seren.deviceIndex,
        gpuBackend:  seren.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
      }),
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

  // ── Image model routes ───────────────────────────────────────────────────

  // GET /api/phobos/image/catalogue
  // Returns full catalogue of all image models across all runner profiles,
  // each with download state and hardware-selected aux file recommendations.
  fastify.get('/api/phobos/image/catalogue', async (_req, reply) => {
    const hw = await detectHardware();

    const backendScore = (g: typeof hw.gpus[0]): number =>
      (g.unifiedMemory || g.index >= 100) ? 0
      : g.backend === 'cuda'  ? 3
      : g.backend === 'metal' ? 2
      : 1;
    const bestGpu = [...hw.gpus]
      .sort((a, b) => {
        const scoreDiff = backendScore(b) - backendScore(a);
        return scoreDiff !== 0 ? scoreDiff : b.vramGb - a.vramGb;
      })[0] ?? null;

    const totalVramGb = bestGpu?.vramGb ?? 0;
    const isUnified   = bestGpu?.unifiedMemory === true || (bestGpu?.index ?? 0) >= 100;

    const hardware = {
      totalVramGb,
      isUnifiedMemory: isUnified,
      gpuName:  bestGpu?.name ?? 'Unknown',
      backend:  bestGpu?.backend ?? 'cpu',
    };

    const models = IMAGE_MODEL_CATALOGUE.map(spec => {
      // Determine aux files for this model
      let auxFiles: typeof FLUX_AUX_REQUIRED;
      let recommendedT5: string | undefined;

      if (spec.runnerProfile === 'flux') {
        const t5 = recommendT5Encoder(spec, totalVramGb, isUnified);
        recommendedT5 = t5.id;
        const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
        auxFiles = [...baseAux, t5];
      } else {
        auxFiles = [...SDXL_AUX_REQUIRED];
      }

      const mainDownloaded = isImageModelDownloaded(spec);
      const auxStatus = auxFiles.map(a => ({
        id:         a.id,
        label:      a.label,
        sizeBytes:  a.sizeBytes,
        downloaded: isFluxAuxDownloaded(a),
        license:    a.license,
        licenseUrl: a.licenseUrl,
      }));
      const allDownloaded = mainDownloaded && auxStatus.every(a => a.downloaded);
      const totalDownloadBytes = (mainDownloaded ? 0 : spec.sizeBytes)
        + auxStatus.reduce((s, a) => s + (a.downloaded ? 0 : a.sizeBytes), 0);

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
        downloaded:         allDownloaded,
        mainDownloaded,
        auxFiles:           auxStatus,
        ...(recommendedT5 ? { recommendedT5 } : {}),
        totalDownloadBytes,
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

      try {
        const hw        = await detectHardware();
        const _bScore   = (g: typeof hw.gpus[0]): number =>
          (g.unifiedMemory || g.index >= 100) ? 0
          : g.backend === 'cuda'  ? 3
          : g.backend === 'metal' ? 2
          : 1;
        const bestGpu   = [...hw.gpus].sort((a, b) => { const d = _bScore(b) - _bScore(a); return d !== 0 ? d : b.vramGb - a.vramGb; })[0] ?? null;
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

        for await (const progress of downloadFluxModel(spec, auxFiles)) {
          send(progress);
          if (progress.error) break;
        }
        send({ fileId: 'complete', phase: 'complete', label: 'Done', bytesReceived: 0, bytesTotal: 0, done: true });
      } catch (err) {
        console.error(`[phobosLocal] image download error (${modelId}): ${err}`);
        send({ fileId: 'error', phase: 'error', label: String(err), bytesReceived: 0, bytesTotal: 0, done: true, error: String(err) });
      } finally {
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    }
  );

  // DELETE /api/phobos/image/:modelId
  fastify.delete<{ Params: { modelId: string } }>(
    '/api/phobos/image/:modelId',
    async (req, reply) => {
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