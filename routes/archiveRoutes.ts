// ── archiveRoutes.ts ───────────────────────────────────────────────────────────
//
// REST API for PHOBOS Archive operations.
//
// GET    /api/archive/status                        — SYBIL state, total chunks, domain list
// GET    /api/archive/domains                       — list domains with stats
// POST   /api/archive/domains                       — create a domain
// DELETE /api/archive/domains/:domain               — delete a domain + all content
// GET    /api/archive/domains/:domain/sources       — list sources in a domain
// POST   /api/archive/ingest                        — ingest file/URL/paste (SSE progress)
// POST   /api/archive/ingest/open-file-dialog       — open native OS file picker, returns { path }
// DELETE /api/archive/sources/:domain/:sourceId     — remove a source and its chunks
// GET    /api/archive/search                        — hybrid search across domains

import type { FastifyInstance } from 'fastify';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ArchiveStore, type ArchiveDomain } from '../db/ArchiveStore.js';
import { ingestSource } from '../ai/ArchiveIngestor.js';
import { searchRaw } from '../ai/ArchiveClient.js';
import { getServerStatus } from '../phobos/LlamaServerManager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidDomain(domain: string): domain is ArchiveDomain {
  if (!domain || typeof domain !== 'string') return false;
  return /^[a-z0-9-]{1,64}$/.test(domain);
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function registerArchiveRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /api/archive/status ────────────────────────────────────────────────
  fastify.get('/api/archive/status', async (_req, reply) => {
    try {
      const sybil   = getServerStatus().sybil;
      const domains = await ArchiveStore.listDomains();
      const total   = domains.reduce((n, d) => n + d.chunkCount, 0);

      return reply.send({
        sybilState:  sybil.state,
        sybilOnline: sybil.state === 'running',
        totalChunks: total,
        domains:     domains.map(d => ({
          domain:      d.domain,
          chunkCount:  d.chunkCount,
          sourceCount: d.sourceCount,
          lastIngest:  d.lastIngest,
          sizeBytes:   d.sizeBytes,
        })),
      });
    } catch (err) {
      console.error('[ArchiveRoutes] /api/archive/status error:', err);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/archive/domains ───────────────────────────────────────────────
  fastify.get('/api/archive/domains', async (_req, reply) => {
    try {
      const domains = await ArchiveStore.listDomains();
      return reply.send({ domains });
    } catch (err) {
      console.error('[ArchiveRoutes] /api/archive/domains error:', err);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/archive/domains ──────────────────────────────────────────────
  fastify.post<{ Body: { domain: string } }>(
    '/api/archive/domains',
    async (req, reply) => {
      const { domain } = req.body ?? {};
      if (!isValidDomain(domain)) {
        return reply.status(400).send({ error: 'Invalid domain name. Use lowercase letters, numbers, hyphens only.' });
      }
      try {
        await ArchiveStore.ensureDomain(domain as ArchiveDomain);
        return reply.send({ ok: true, domain });
      } catch (err) {
        console.error('[ArchiveRoutes] POST /api/archive/domains error:', err);
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── DELETE /api/archive/domains/:domain ───────────────────────────────────
  fastify.delete<{ Params: { domain: string } }>(
    '/api/archive/domains/:domain',
    async (req, reply) => {
      const { domain } = req.params;
      if (!isValidDomain(domain)) {
        return reply.status(400).send({ error: 'Invalid domain name.' });
      }
      try {
        await ArchiveStore.deleteDomain(domain as ArchiveDomain);
        return reply.send({ ok: true });
      } catch (err) {
        console.error('[ArchiveRoutes] DELETE /api/archive/domains/:domain error:', err);
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── GET /api/archive/domains/:domain/sources ──────────────────────────────
  fastify.get<{ Params: { domain: string } }>(
    '/api/archive/domains/:domain/sources',
    async (req, reply) => {
      const { domain } = req.params;
      if (!isValidDomain(domain)) {
        return reply.status(400).send({ error: 'Invalid domain name.' });
      }
      try {
        const sources = await ArchiveStore.listSources(domain as ArchiveDomain);
        return reply.send({ sources });
      } catch (err) {
        console.error('[ArchiveRoutes] GET /api/archive/domains/:domain/sources error:', err);
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── DELETE /api/archive/sources/:domain/:sourceId ─────────────────────────
  fastify.delete<{ Params: { domain: string; sourceId: string } }>(
    '/api/archive/sources/:domain/:sourceId',
    async (req, reply) => {
      const { domain, sourceId } = req.params;
      if (!isValidDomain(domain)) {
        return reply.status(400).send({ error: 'Invalid domain name.' });
      }
      try {
        await ArchiveStore.deleteSourceById(domain as ArchiveDomain, sourceId);
        return reply.send({ ok: true });
      } catch (err) {
        console.error('[ArchiveRoutes] DELETE /api/archive/sources/:domain/:sourceId error:', err);
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── POST /api/archive/ingest (SSE) ────────────────────────────────────────
  // Body: { domain, input, sourceType }
  // Streams IngestProgressEvent objects as SSE until done or error.
  fastify.post<{
    Body: {
      domain:     string;
      input:      string;
      sourceType: 'file' | 'url' | 'paste';
    };
  }>('/api/archive/ingest', async (req, reply) => {
    const { domain, input, sourceType } = req.body ?? {};

    if (!isValidDomain(domain)) {
      return reply.status(400).send({ error: 'Invalid domain name.' });
    }
    if (!input || typeof input !== 'string') {
      return reply.status(400).send({ error: 'input is required.' });
    }
    if (!['file', 'url', 'paste'].includes(sourceType)) {
      return reply.status(400).send({ error: 'sourceType must be file | url | paste.' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':                 'text/event-stream',
      'Cache-Control':                'no-cache',
      'Connection':                   'keep-alive',
      'Access-Control-Allow-Origin':  req.headers.origin ?? '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });

    const send = (data: object) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof (reply.raw.socket as any)?.flush === 'function') {
        (reply.raw.socket as any).flush();
      }
    };

    try {
      await ingestSource(
        domain as ArchiveDomain,
        input,
        sourceType,
        (evt) => send(evt),
      );
    } catch (err) {
      send({ type: 'ingest_progress', status: 'error', error: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  // ── GET /api/archive/search ────────────────────────────────────────────────
  // Query params: q (required), domains (csv), k (int), minScore (float)
  fastify.get<{
    Querystring: {
      q:        string;
      domains?: string;
      k?:       string;
      minScore?: string;
    };
  }>('/api/archive/search', async (req, reply) => {
    const { q, domains: domainsParam, k: kParam, minScore: minParam } = req.query;

    if (!q?.trim()) {
      return reply.status(400).send({ error: 'q (query) is required.' });
    }

    try {
      const domains = domainsParam
        ? domainsParam.split(',').filter(isValidDomain) as ArchiveDomain[]
        : (await ArchiveStore.listDomains()).map(d => d.domain);

      const k        = kParam   ? Math.min(parseInt(kParam, 10) || 8, 20) : 8;
      const minScore = minParam  ? parseFloat(minParam) : 0.65;

      const results = await searchRaw({ query: q, domains, k, minScore });
      return reply.send({ results });
    } catch (err) {
      console.error('[ArchiveRoutes] GET /api/archive/search error:', err);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/archive/ingest/open-file-dialog ─────────────────────────────
  // Opens a native OS file picker filtered to document types the archive accepts.
  // Returns { path: string | null }.
  fastify.post('/api/archive/ingest/open-file-dialog', async (_req, reply) => {
    const execFileAsync = promisify(execFile);
    let selectedPath = '';
    try {
      if (process.platform === 'win32') {
        const tmpPs1 = path.join(os.tmpdir(), `phobos-archive-file-${Date.now()}.ps1`);
        const FILTER = 'Documents|*.md;*.txt;*.pdf;*.docx;*.html;*.py;*.ts;*.js;*.json;*.csv;*.xlsx;*.epub|All files (*.*)|*.*';
        const ps1 = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '$f = New-Object System.Windows.Forms.Form',
          '$f.TopMost = $true; $f.ShowInTaskbar = $false',
          '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
          '$f.Show(); $f.Hide()',
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          `$d.Filter = "${FILTER}"`,
          '$d.Title = "Select document to archive"',
          '$d.Multiselect = $false',
          'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
          '$f.Dispose()',
        ].join('\r\n');
        try {
          fs.writeFileSync(tmpPs1, ps1, 'utf-8');
          const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1]);
          selectedPath = stdout.trim();
        } finally { try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ } }
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose file with prompt "Select document to archive")']);
        selectedPath = stdout.trim();
      } else {
        const tryExec = async (cmd: string, args: string[]) => { try { const { stdout } = await execFileAsync(cmd, args); return stdout.trim() || null; } catch { return null; } };
        selectedPath = await tryExec('zenity', ['--file-selection', '--title=Select document to archive']) ?? await tryExec('kdialog', ['--getopenfilename', os.homedir(), '*']) ?? '';
      }
    } catch { /* user cancelled */ }
    return reply.send({ path: selectedPath || null });
  });
}
