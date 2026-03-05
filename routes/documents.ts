import type { FastifyInstance } from 'fastify';
import { DocumentStore, type DocType } from '../db/DocumentStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

const DOC_TYPE_MAP: Record<string, DocType> = {
  'claude-md': 'claude_md',
  'phobos-directives': 'claude_md',
  'phobos_directives': 'claude_md',
  'project-md': 'project_md',
  'chat-md': 'chat_md',
  // Also accept the underscore variant
  claude_md: 'claude_md',
  project_md: 'project_md',
  chat_md: 'chat_md',
};

export async function documentsRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const store = new DocumentStore(db);

  // GET /api/documents/:type
  // Optional ?project_id=xxx
  fastify.get<{
    Params: { type: string };
    Querystring: { project_id?: string };
  }>('/api/documents/:type', async (req, reply) => {
    const docType = DOC_TYPE_MAP[req.params.type];
    if (!docType) {
      return reply.status(400).send({ error: `Unknown doc type: ${req.params.type}` });
    }

    const doc = await store.getLatest(docType, req.query.project_id ?? null);
    if (!doc) {
      // Return empty document rather than 404
      return reply.send({
        id: null,
        doc_type: docType,
        content: '',
        version: 0,
        project_id: req.query.project_id ?? null,
        created_at: null,
      });
    }
    return reply.send(doc);
  });

  // PUT /api/documents/:type
  fastify.put<{
    Params: { type: string };
    Body: { content: string; project_id?: string };
  }>('/api/documents/:type', async (req, reply) => {
    const docType = DOC_TYPE_MAP[req.params.type];
    if (!docType) {
      return reply.status(400).send({ error: `Unknown doc type: ${req.params.type}` });
    }

    const doc = await store.write(
      docType,
      req.body.content,
      req.body.project_id ?? null
    );
    return reply.send(doc);
  });

  // GET /api/documents/:type/history
  fastify.get<{
    Params: { type: string };
    Querystring: { project_id?: string };
  }>('/api/documents/:type/history', async (req, reply) => {
    const docType = DOC_TYPE_MAP[req.params.type];
    if (!docType) {
      return reply.status(400).send({ error: `Unknown doc type: ${req.params.type}` });
    }

    const history = await store.getHistory(docType, req.query.project_id ?? null);
    return reply.send(history);
  });
}
