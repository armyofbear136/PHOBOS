/**
 * PHOBOS Scheduler — API Routes
 * Register via: await registerSchedulerRoutes(fastify) in server.ts
 *
 * GET    /api/scheduler/tasks              — list all tasks
 * POST   /api/scheduler/tasks              — create task
 * PUT    /api/scheduler/tasks/:id          — update task
 * DELETE /api/scheduler/tasks/:id          — delete task
 * PATCH  /api/scheduler/tasks/:id/toggle   — enable/disable
 * POST   /api/scheduler/tasks/:id/run      — manual trigger
 * GET    /api/scheduler/tasks/:id/runs     — run history
 * GET    /api/scheduler/pending            — pending fire (polled by frontend)
 * POST   /api/scheduler/pending/cancel     — user cancels pending fire
 * POST   /api/scheduler/pending/confirm    — frontend confirms dispatch, records run
 */

import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ScheduledTaskStore } from '../db/ScheduledTaskStore.js';
import { getScheduler, computeNextRun, getPendingFire } from '../scheduling/Scheduler.js';

export async function registerSchedulerRoutes(fastify: FastifyInstance): Promise<void> {
  const db    = DatabaseManager.getUserDb();
  const store = new ScheduledTaskStore(db);

  // ── Task CRUD ──────────────────────────────────────────────────────────────

  fastify.get('/api/scheduler/tasks', async (_req, reply) => {
    const tasks = await store.getAll();
    return reply.send(tasks);
  });

  fastify.post<{
    Body: {
      name:                 string;
      description?:         string;
      cron_expression:      string;
      prompt:               string;
      enabled?:             boolean;
      task_type?:           import('../db/ScheduledTaskStore.js').TaskType;
      task_parameters?:     string[] | null;
      pinned_sayon_model?:  string | null;
      pinned_seren_model?:  string | null;
      pinned_cartridge_id?: string | null;
    };
  }>('/api/scheduler/tasks', async (req, reply) => {
    const {
      name, description, cron_expression, prompt, enabled = true,
      task_type, task_parameters,
      pinned_sayon_model, pinned_seren_model, pinned_cartridge_id,
    } = req.body;
    if (!name || !cron_expression || !prompt) {
      return reply.status(400).send({ error: 'name, cron_expression and prompt are required' });
    }
    const next = computeNextRun(cron_expression);
    const task = await store.create({
      name,
      description:          description ?? null,
      cron_expression,
      prompt,
      enabled,
      task_type:            task_type            ?? 'conversation',
      task_parameters:      task_parameters      ?? null,
      next_run_at:          next?.toISOString()  ?? null,
      pinned_sayon_model:   pinned_sayon_model   ?? null,
      pinned_seren_model:   pinned_seren_model   ?? null,
      pinned_cartridge_id:  pinned_cartridge_id  ?? null,
    });
    return reply.status(201).send(task);
  });

  fastify.put<{
    Params: { id: string };
    Body: {
      name?:                string;
      description?:         string;
      cron_expression?:     string;
      prompt?:              string;
      enabled?:             boolean;
      task_type?:           import('../db/ScheduledTaskStore.js').TaskType;
      task_parameters?:     string[] | null;
      pinned_sayon_model?:  string | null;
      pinned_seren_model?:  string | null;
      pinned_cartridge_id?: string | null;
    };
  }>('/api/scheduler/tasks/:id', async (req, reply) => {
    const task = await store.getById(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Not found' });

    const cron = req.body.cron_expression ?? task.cron_expression;
    const next = computeNextRun(cron);
    await store.update(req.params.id, {
      ...req.body,
      next_run_at: next?.toISOString() ?? null,
    });
    return reply.send(await store.getById(req.params.id));
  });

  fastify.delete<{ Params: { id: string } }>('/api/scheduler/tasks/:id', async (req, reply) => {
    const task = await store.getById(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Not found' });
    await store.delete(req.params.id);
    return reply.send({ ok: true });
  });

  fastify.patch<{ Params: { id: string } }>('/api/scheduler/tasks/:id/toggle', async (req, reply) => {
    const task = await store.getById(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Not found' });
    const enabled = !task.enabled;
    // Recompute next_run_at when re-enabling
    const next_run_at = enabled ? (computeNextRun(task.cron_expression)?.toISOString() ?? null) : null;
    await store.update(req.params.id, { enabled, next_run_at });
    return reply.send(await store.getById(req.params.id));
  });

  fastify.get<{ Params: { id: string } }>('/api/scheduler/tasks/:id/runs', async (req, reply) => {
    const runs = await store.getRuns(req.params.id, 20);
    return reply.send(runs);
  });

  fastify.post<{ Params: { id: string } }>('/api/scheduler/tasks/:id/run', async (req, reply) => {
    const result = await getScheduler().triggerNow(req.params.id);
    if (!result.ok) return reply.status(404).send({ error: result.error });
    return reply.send({ ok: true });
  });

  // ── Pending fire ───────────────────────────────────────────────────────────

  fastify.get('/api/scheduler/pending', async (_req, reply) => {
    return reply.send({ pending: getPendingFire() });
  });

  fastify.post('/api/scheduler/pending/cancel', async (_req, reply) => {
    getScheduler().cancelPending();
    return reply.send({ ok: true });
  });

  fastify.post<{
    Body: { taskId: string; threadId: string };
  }>('/api/scheduler/pending/confirm', async (req, reply) => {
    const { taskId, threadId } = req.body;
    if (!taskId || !threadId) return reply.status(400).send({ error: 'taskId and threadId required' });
    await getScheduler().confirmDispatched(taskId, threadId);
    return reply.send({ ok: true });
  });
}