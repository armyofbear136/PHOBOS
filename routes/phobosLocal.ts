import type { FastifyInstance } from 'fastify';
import {
  detectHardware,
  buildRecommendation,
  listDownloaded,
  downloadModel,
  getSpec,
} from '../phobos/PhobosLocalManager.js';
import {
  startServer,
  stopServer,
  getServerStatus,
  SAYON_PORT,
  ALLMIND_PORT,
} from '../phobos/LlamaServerManager.js';

export async function phobosLocalRoute(fastify: FastifyInstance): Promise<void> {

  // GET /api/phobos/hardware
  // Hardware profile + recommended model pair.
  fastify.get('/api/phobos/hardware', async (_req, reply) => {
    const hw  = await detectHardware();
    const rec = buildRecommendation(hw);
    return reply.send({ hardware: hw, recommendation: rec });
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

  // GET /api/phobos/download?sayon=<modelId>&allmind=<modelId>
  // SSE stream — downloads both GGUFs sequentially, emits progress.
  // Event shape: { phase, modelId, bytesReceived, bytesTotal, done, error? }
  fastify.get<{
    Querystring: { sayon: string; allmind: string };
  }>('/api/phobos/download', async (req, reply) => {
    const { sayon: sayonId, allmind: allmindId } = req.query;

    if (!sayonId || !allmindId) {
      return reply.status(400).send({ error: 'sayon and allmind query params required' });
    }

    const sayonSpec   = getSpec(sayonId);
    const allmindSpec = getSpec(allmindId);

    if (!sayonSpec)   return reply.status(400).send({ error: `Unknown model: ${sayonId}` });
    if (!allmindSpec) return reply.status(400).send({ error: `Unknown model: ${allmindId}` });

    reply.raw.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const emit = (payload: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const downloadPhase = async (spec: typeof sayonSpec, phase: 'sayon' | 'allmind') => {
      try {
        for await (const progress of downloadModel(spec, phase)) {
          emit(progress);
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
    await downloadPhase(allmindSpec, 'allmind');

    emit({ phase: 'complete', done: true });
    reply.raw.end();
  });

  // POST /api/phobos/start
  // Body: { sayon: { modelId, gpuLayers?, contextSize?, threads? }, allmind: { ... } }
  // Starts (or restarts) the two llama-server processes.
  fastify.post<{
    Body: {
      sayon:   { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number };
      allmind: { modelId: string; gpuLayers?: number; contextSize?: number; threads?: number };
    };
  }>('/api/phobos/start', async (req, reply) => {
    const { sayon, allmind } = req.body;

    const [sayonErr, allmindErr] = await Promise.allSettled([
      startServer('sayon', {
        modelId:     sayon.modelId,
        port:        SAYON_PORT,
        gpuLayers:   sayon.gpuLayers   ?? 0,
        contextSize: sayon.contextSize ?? 4096,
        threads:     sayon.threads     ?? 0,
      }),
      startServer('allmind', {
        modelId:     allmind.modelId,
        port:        ALLMIND_PORT,
        gpuLayers:   allmind.gpuLayers   ?? 99,
        contextSize: allmind.contextSize ?? 4096,
        threads:     allmind.threads     ?? 0,
      }),
    ]);

    const errors: string[] = [];
    if (sayonErr.status   === 'rejected') errors.push(`sayon: ${sayonErr.reason}`);
    if (allmindErr.status === 'rejected') errors.push(`allmind: ${allmindErr.reason}`);

    return reply.send({
      ok:     errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      status: getServerStatus(),
    });
  });

  // POST /api/phobos/stop
  fastify.post('/api/phobos/stop', async (_req, reply) => {
    await Promise.all([stopServer('sayon'), stopServer('allmind')]);
    return reply.send({ ok: true, status: getServerStatus() });
  });

  // GET /api/phobos/status
  fastify.get('/api/phobos/status', async (_req, reply) => {
    return reply.send({ status: getServerStatus() });
  });
}
