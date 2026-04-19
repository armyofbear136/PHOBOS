// ── ArchiveIngestor ────────────────────────────────────────────────────────────
//
// Ingestion pipeline for the PHOBOS Archive.
//
// Stage order:
//   NormalizationLayer  — extract plain text from file/URL/paste
//   ChunkingEngine      — split into retrieval-sized chunks with overlap
//   BreadcrumbInjector  — prepend heading context to each chunk
//   EmbedClient.embed() — SYBIL embedding (sequential, 1ms yield between calls)
//   ArchiveStore.writeChunks() — persist to domain DuckDB
//
// No Python dependency. PDF extraction uses pdfjs-dist (pure JS).
// HTML stripping uses node-html-parser (pure JS).
// URL fetching uses plain fetch() — no browser dependency.
//
// Progress is reported via IngestProgressCallback — callers stream to SSE.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { embed } from './EmbedClient.js';
import { ArchiveStore, type ArchiveDomain } from '../db/ArchiveStore.js';
// URL ingestion uses plain fetch() — no external browser dependency.

const SUPPORTED_EXTENSIONS = new Set([
  '.md', '.txt', '.pdf', '.html', '.htm',
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mts', '.rs', '.go', '.cs', '.cpp', '.c',
  '.json',
  '.docx',                      // mammoth (pure JS)
  '.csv',                       // built-in text handling
  '.xlsx',                      // xlsx package (pure JS)
  '.epub',                      // epub-parser (pure JS)
]);

export { SUPPORTED_EXTENSIONS };

// SYBIL runs with --ctx-size 512 and --batch-size 512.
// nomic-embed tokenizes at 2–4 chars/token depending on content density.
// Legal/technical PDFs can hit 2 chars/token. Using 512 * 1.9 = ~970 chars as
// the safe embed ceiling regardless of content type.
const CHUNK_TARGET_CHARS  = 800;    // ~300 tokens — well within batch limit
const CHUNK_MAX_CHARS     = 1_000;  // hard ceiling before forced split
const CHUNK_OVERLAP_CHARS = 80;     // tail of previous chunk for retrieval continuity
const EMBED_INPUT_MAX     = 950;    // hard cap sent to embed() — safe for any tokenizer density

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestProgressEvent {
  type:     'ingest_progress';
  sourceId: string;
  current:  number;
  total:    number;
  pct:      number;
  status:   'running' | 'done' | 'error';
  error?:   string;
}

export type IngestProgressCallback = (event: IngestProgressEvent) => void;

interface ChunkSpec {
  text:        string;
  chunkIndex:  number;
  breadcrumb:  string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a file path, URL, or paste string into the specified domain.
 *
 * @param domain      Target archive domain
 * @param input       Absolute file path, http(s) URL, or raw text for 'paste'
 * @param sourceType  'file' | 'url' | 'paste'
 * @param onProgress  Called after each chunk is embedded and written
 * @returns           The stable sourceId for this ingestion
 */
export async function ingestSource(
  domain: ArchiveDomain,
  input: string,
  sourceType: 'file' | 'url' | 'paste',
  onProgress?: IngestProgressCallback,
): Promise<string> {
  const sourceId = randomUUID();

  try {
    // ── Step 1: Normalize ────────────────────────────────────────────────────
    const { text, title, fileMtime } = await normalizeInput(input, sourceType);

    if (!text.trim()) {
      throw new Error('No extractable text content found in source.');
    }

    // ── Step 2: Chunk ────────────────────────────────────────────────────────
    const chunks = chunkText(text, title ?? path.basename(input), domain);

    onProgress?.({
      type: 'ingest_progress', sourceId,
      current: 0, total: chunks.length, pct: 0, status: 'running',
    });

    // ── Step 3: Embed + collect ───────────────────────────────────────────────
    // Sequential embedding — SYBIL is single-process CPU, parallel calls queue anyway.
    const embedded: Array<{
      chunkIndex: number;
      chunkText:  string;
      embedding:  number[];
      breadcrumb: string | null;
      wordCount:  number;
      charCount:  number;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const c   = chunks[i];
      const embedInput = `${c.breadcrumb}\n\n${c.text}`.slice(0, EMBED_INPUT_MAX);
      const vec = await embed(embedInput);
      if (!vec) {
        // SYBIL unavailable — abort rather than write zero-vector garbage.
        throw new Error('SYBIL embedding server unavailable. Ensure SYBIL is running.');
      }

      embedded.push({
        chunkIndex: c.chunkIndex,
        chunkText:  c.text,
        embedding:  vec,
        breadcrumb: c.breadcrumb,
        wordCount:  countWords(c.text),
        charCount:  c.text.length,
      });

      onProgress?.({
        type: 'ingest_progress', sourceId,
        current: i + 1, total: chunks.length,
        pct: Math.round(((i + 1) / chunks.length) * 100),
        status: 'running',
      });

      // 1ms yield — keeps event loop alive for concurrent workspace requests.
      await new Promise(r => setTimeout(r, 1));
    }

    // ── Step 4: Write ─────────────────────────────────────────────────────────
    await ArchiveStore.writeChunks(
      domain, sourceId, input, title, sourceType, fileMtime, embedded,
    );

    onProgress?.({
      type: 'ingest_progress', sourceId,
      current: chunks.length, total: chunks.length, pct: 100, status: 'done',
    });

    console.log(`[ArchiveIngestor] Ingested ${chunks.length} chunks → ${domain} (${title ?? input})`);
    return sourceId;

  } catch (err) {
    onProgress?.({
      type: 'ingest_progress', sourceId,
      current: 0, total: 0, pct: 0, status: 'error',
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Re-ingest a source when its file has changed (detected by mtime).
 * Deletes the existing chunks and runs full ingestion.
 */
export async function reingestIfChanged(
  domain: ArchiveDomain,
  filePath: string,
  onProgress?: IngestProgressCallback,
): Promise<'skipped' | 'reingested'> {
  const mtime   = fs.statSync(filePath).mtimeMs;
  const existing = await ArchiveStore.getSource(domain, filePath);

  if (existing && existing.fileMtime === mtime) return 'skipped';

  if (existing) {
    await ArchiveStore.deleteSource(domain, filePath);
  }

  await ingestSource(domain, filePath, 'file', onProgress);
  return 'reingested';
}

// ── Normalization Layer ───────────────────────────────────────────────────────

interface NormalizedInput {
  text:      string;
  title:     string | null;
  fileMtime: number | null;
}

async function normalizeInput(
  input: string,
  sourceType: 'file' | 'url' | 'paste',
): Promise<NormalizedInput> {
  if (sourceType === 'paste') {
    return { text: cleanText(input), title: 'Pasted text', fileMtime: null };
  }

  if (sourceType === 'url') {
    return normalizeUrl(input);
  }

  // sourceType === 'file'
  if (!fs.existsSync(input)) {
    throw new Error(`File not found: ${input}`);
  }

  const ext      = path.extname(input).toLowerCase();
  const mtime    = fs.statSync(input).mtimeMs;
  const basename = path.basename(input, ext);

  if (ext === '.pdf')  return { text: await extractPdf(input),  title: basename, fileMtime: mtime };
  if (ext === '.docx') return { text: await extractDocx(input), title: basename, fileMtime: mtime };
  if (ext === '.xlsx') return { text: await extractXlsx(input), title: basename, fileMtime: mtime };
  if (ext === '.epub') return { text: await extractEpub(input), title: basename, fileMtime: mtime };

  if (ext === '.csv') {
    return { text: extractCsv(fs.readFileSync(input, 'utf8')), title: basename, fileMtime: mtime };
  }

  if (ext === '.html' || ext === '.htm') {
    const raw = fs.readFileSync(input, 'utf8');
    return { text: extractHtml(raw), title: extractHtmlTitle(raw) ?? basename, fileMtime: mtime };
  }

  if (['.py', '.ts', '.tsx', '.js', '.jsx', '.mts', '.rs', '.go', '.cs', '.cpp', '.c'].includes(ext)) {
    return { text: extractCode(fs.readFileSync(input, 'utf8'), ext), title: basename, fileMtime: mtime };
  }

  if (ext === '.json') {
    return { text: extractJson(fs.readFileSync(input, 'utf8')), title: basename, fileMtime: mtime };
  }

  // .md, .txt, and all other text types — direct read.
  return { text: cleanText(fs.readFileSync(input, 'utf8')), title: basename, fileMtime: mtime };
}

async function normalizeUrl(url: string): Promise<NormalizedInput> {
  // Plain fetch — no Camofox dependency. For JS-heavy pages that require
  // a real browser, users should download the page first and ingest as a file.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PHOBOS-Archive/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ct   = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = ct.includes('html') ? extractHtml(body) : cleanText(body);
    const title = ct.includes('html')
      ? (extractHtmlTitle(body) ?? url)
      : url;
    return { text, title, fileMtime: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── PDF extraction (pdfjs-dist, pure JS) ──────────────────────────────────────

async function extractPdf(filePath: string): Promise<string> {
  // pdfjs-dist v5 restructured its entry points. We try each known path in order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfjsLib: any;
  const candidates = [
    'pdfjs-dist/build/pdf.node.mjs',     // v5 dedicated Node build (no worker needed)
    'pdfjs-dist/legacy/build/pdf.mjs',   // v4 legacy Node path
    'pdfjs-dist/legacy/build/pdf.js',    // v3 legacy path
    'pdfjs-dist',                         // fallback main entry
  ];

  for (const candidate of candidates) {
    try {
      pdfjsLib = await import(candidate);
      break;
    } catch { /* try next */ }
  }

  if (!pdfjsLib) {
    throw new Error('PDF extraction requires pdfjs-dist. Run: npm install pdfjs-dist');
  }

  // In pdfjs v5, GlobalWorkerOptions.workerSrc must be set to a non-empty string
  // even when running in Node.js without an actual worker. We point it at the
  // worker bundle path resolved from the installed package location.
  // If that fails, we set a placeholder — pdfjs will use its synchronous fallback.
  if (pdfjsLib.GlobalWorkerOptions) {
    try {
      const workerUrl = import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch {
      try {
        const workerUrl = import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      } catch {
        // Last resort — any non-empty string suppresses the workerSrc check.
        // pdfjs will still use its synchronous text-extraction path.
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'noop';
      }
    }
  }

  const data    = new Uint8Array(fs.readFileSync(filePath));
  const loadDoc = pdfjsLib.getDocument({ data, verbosity: 0, isEvalSupported: false });
  const pdf     = await loadDoc.promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageText = (content.items as any[])
      .map((item) => item.str ?? '')
      .join(' ');
    if (pageText.trim()) {
      pages.push(`[Page ${i}]\n${pageText}`);
    }
  }

  return cleanText(pages.join('\n\n'));
}

// ── DOCX extraction (mammoth, pure JS) ───────────────────────────────────────

async function extractDocx(filePath: string): Promise<string> {
  let mammoth: typeof import('mammoth');
  try {
    mammoth = await import('mammoth');
  } catch {
    throw new Error('DOCX extraction requires mammoth. Run: npm install mammoth');
  }
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages.length > 0 && process.env.PHOBOS_DEBUG === '1') {
    console.warn('[ArchiveIngestor] mammoth warnings:', result.messages.map(m => m.message).join(', '));
  }
  return cleanText(result.value);
}

// ── XLSX extraction (xlsx, pure JS) ───────────────────────────────────────────

async function extractXlsx(filePath: string): Promise<string> {
  let XLSX: typeof import('xlsx');
  try {
    XLSX = await import('xlsx');
  } catch {
    throw new Error('XLSX extraction requires xlsx. Run: npm install xlsx');
  }
  const workbook = XLSX.readFile(filePath);
  const lines: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    lines.push(`## Sheet: ${sheetName}`);
    const sheet = workbook.Sheets[sheetName];
    const csv   = XLSX.utils.sheet_to_csv(sheet);
    lines.push(csv);
  }
  return cleanText(lines.join('\n\n'));
}

// ── CSV extraction ─────────────────────────────────────────────────────────────

function extractCsv(raw: string): string {
  // Convert CSV rows to readable key: value prose so embeddings are meaningful.
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const rows    = lines.slice(1, 201); // cap at 200 rows
  const prose   = rows.map(row => {
    const vals = row.split(',').map(v => v.replace(/^"|"$/g, '').trim());
    return headers.map((h, i) => `${h}: ${vals[i] ?? ''}`).join(' | ');
  });
  return cleanText([`Headers: ${headers.join(', ')}`, ...prose].join('\n'));
}

// ── EPUB extraction (adm-zip, already in dependencies) ───────────────────────
// EPUB is a ZIP archive containing HTML/XHTML files.

async function extractEpub(filePath: string): Promise<string> {
  const AdmZip = (await import('adm-zip')).default;
  const zip    = new AdmZip(filePath);
  const texts: string[] = [];

  for (const entry of zip.getEntries()) {
    const name = entry.entryName.toLowerCase();
    if (name.endsWith('.html') || name.endsWith('.xhtml') || name.endsWith('.htm')) {
      const html = entry.getData().toString('utf8');
      const text = extractHtml(html);
      if (text.trim()) texts.push(text);
    }
  }

  if (texts.length === 0) throw new Error('No readable HTML content found in EPUB');
  return cleanText(texts.join('\n\n'));
}

// ── HTML extraction (node-html-parser, pure JS) ───────────────────────────────

function extractHtml(html: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parseHtml: (html: string) => any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parseHtml = require('node-html-parser').parse;
  } catch {
    // Fallback: strip tags with regex if node-html-parser not installed.
    return cleanText(html.replace(/<[^>]+>/g, ' '));
  }

  const root = parseHtml(html);

  // Prefer <main> or <article>; fall back to full body text.
  const target = root.querySelector('main') ?? root.querySelector('article') ?? root;
  const text: string = target.structuredText ?? target.text ?? '';
  return cleanText(text);
}

function extractHtmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

// ── Code extraction ───────────────────────────────────────────────────────────
// Extracts docstrings, type signatures, and comments. Skips bare implementation.

function extractCode(raw: string, ext: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  let blockChar = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // TypeScript/JS function/class/type signatures
    if (ext !== '.py') {
      if (/^(export\s+)?(async\s+)?function\b|^(export\s+)?class\b|^(export\s+)?(interface|type|enum)\b/.test(trimmed)) {
        kept.push(line);
        continue;
      }
    }

    // Python def/class
    if (ext === '.py') {
      if (/^(def |class |async def )/.test(trimmed)) {
        kept.push(line);
        continue;
      }
    }

    // Single-line comments
    if (/^(\/\/|#|\/\*)/.test(trimmed)) {
      kept.push(line);
      continue;
    }

    // Block comments / docstrings
    if (!inBlock && (trimmed.startsWith('/*') || trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
      inBlock   = true;
      blockChar = trimmed.startsWith('/*') ? '*/' : trimmed.slice(0, 3);
      kept.push(line);
      continue;
    }
    if (inBlock) {
      kept.push(line);
      if (trimmed.endsWith(blockChar)) inBlock = false;
      continue;
    }

    // JSDoc / decorators
    if (trimmed.startsWith('@') || trimmed.startsWith('*')) {
      kept.push(line);
    }
  }

  return cleanText(kept.join('\n'));
}

// ── JSON extraction ───────────────────────────────────────────────────────────

function extractJson(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return cleanText(raw);
    // Emit top-level keys and their string/number values — skip nested objects.
    const lines = Object.entries(obj as Record<string, unknown>)
      .slice(0, 200)
      .map(([k, v]) => {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          return `${k}: ${v}`;
        }
        return `${k}: [${Array.isArray(v) ? 'array' : 'object'}]`;
      });
    return lines.join('\n');
  } catch {
    return cleanText(raw.slice(0, 50_000));
  }
}

// ── Chunking Engine ───────────────────────────────────────────────────────────

function chunkText(text: string, sourceTitle: string, domain: ArchiveDomain): ChunkSpec[] {
  // Split on heading boundaries first (Markdown # headings).
  const sections = splitOnHeadings(text);
  const chunks: ChunkSpec[] = [];
  let chunkIndex = 0;
  let prevTail   = '';

  for (const section of sections) {
    const headingChain = section.headingChain;
    const paragraphs   = section.body.split(/\n{2,}/).filter(p => p.trim().length > 0);

    let buffer = '';

    for (const para of paragraphs) {
      const candidate = buffer ? `${buffer}\n\n${para}` : para;

      if (candidate.length > CHUNK_MAX_CHARS) {
        // Current buffer is full — emit it, then handle the oversized paragraph.
        if (buffer.trim()) {
          chunks.push(buildChunk(buffer, headingChain, sourceTitle, domain, chunkIndex++, prevTail));
          prevTail = buffer.slice(-CHUNK_OVERLAP_CHARS);
          buffer   = '';
        }
        // Split the oversized paragraph on sentence boundaries.
        const sentences = splitSentences(para);
        let sentBuf = '';
        for (const s of sentences) {
          if ((sentBuf + ' ' + s).length > CHUNK_TARGET_CHARS && sentBuf) {
            chunks.push(buildChunk(sentBuf, headingChain, sourceTitle, domain, chunkIndex++, prevTail));
            prevTail = sentBuf.slice(-CHUNK_OVERLAP_CHARS);
            sentBuf  = s;
          } else {
            sentBuf = sentBuf ? `${sentBuf} ${s}` : s;
          }
        }
        if (sentBuf.trim()) buffer = sentBuf;
      } else if (candidate.length >= CHUNK_TARGET_CHARS) {
        chunks.push(buildChunk(candidate, headingChain, sourceTitle, domain, chunkIndex++, prevTail));
        prevTail = candidate.slice(-CHUNK_OVERLAP_CHARS);
        buffer   = '';
      } else {
        buffer = candidate;
      }
    }

    // Flush remaining buffer for this section.
    if (buffer.trim()) {
      chunks.push(buildChunk(buffer, headingChain, sourceTitle, domain, chunkIndex++, prevTail));
      prevTail = buffer.slice(-CHUNK_OVERLAP_CHARS);
      buffer   = '';
    }
  }

  return chunks;
}

function buildChunk(
  text: string,
  headingChain: string,
  sourceTitle: string,
  domain: ArchiveDomain,
  chunkIndex: number,
  prevTail: string,
): ChunkSpec {
  const body       = prevTail ? `${prevTail}\n\n${text}` : text;
  const breadcrumb = headingChain
    ? `[${titleCase(domain)} > ${sourceTitle} > ${headingChain}]`
    : `[${titleCase(domain)} > ${sourceTitle}]`;
  return { text: body.slice(0, CHUNK_MAX_CHARS + CHUNK_OVERLAP_CHARS), chunkIndex, breadcrumb };
}

interface Section {
  headingChain: string;
  body:         string;
}

function splitOnHeadings(text: string): Section[] {
  const lines    = text.split('\n');
  const sections: Section[] = [];
  let headingChain = '';
  let body: string[] = [];

  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.+)/);
    if (m) {
      if (body.join('\n').trim()) {
        sections.push({ headingChain, body: body.join('\n') });
      }
      headingChain = updateHeadingChain(headingChain, m[2].trim(), m[1].length);
      body = [];
    } else {
      body.push(line);
    }
  }

  if (body.join('\n').trim()) {
    sections.push({ headingChain, body: body.join('\n') });
  }

  // If no headings were found, return the whole text as one section.
  if (sections.length === 0) {
    sections.push({ headingChain: '', body: text });
  }

  return sections;
}

function updateHeadingChain(current: string, newHeading: string, level: number): string {
  const parts = current ? current.split(' > ') : [];
  // Level 1 = index 0, level 2 = index 1, etc.
  parts[level - 1] = newHeading;
  // Truncate deeper levels that are now stale.
  return parts.slice(0, level).join(' > ');
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// ── Text utilities ────────────────────────────────────────────────────────────

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')          // null bytes
    .replace(/[\u200B-\u200D\uFEFF]/g, '')  // zero-width chars
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')  // control chars
    .replace(/[ \t]+/g, ' ')         // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')      // collapse excessive blank lines
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
