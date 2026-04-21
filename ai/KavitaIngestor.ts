// ── KavitaIngestor ─────────────────────────────────────────────────────────────
//
// Classifies documents for ingestion into Kavita libraries.
//
// Classification pipeline (per file):
//   1. Extract a text sample (title + first ~600 chars) via the same
//      normalization layer used by ArchiveIngestor.
//   2. Call Sayon or Seren (whichever is running) with a tight classification
//      prompt — max 60 tokens out, non-streaming.
//   3. If no LLM available, fall back to heuristic classification based on
//      file extension, name patterns, and EPUB/CBZ metadata.
//
// Output: a queue of IngestQueueItem — one per file — with suggested library
// type. The user reviews and confirms (or re-categorizes) before any files
// are copied.
//
// Copy operations only. Source files are never moved or deleted.

import fs   from 'fs';
import path from 'path';
import { getServerStatus } from '../phobos/LlamaServerManager.js';
import { KAVITA_LIB_TYPE, type KavitaLibType } from '../services/KavitaManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IngestQueueItem {
  /** Absolute path to the source file. */
  sourcePath:  string;
  /** Display filename. */
  filename:    string;
  /** Suggested Kavita library type. */
  suggestion:  KavitaLibType;
  /** Human-readable reason for the suggestion. */
  reason:      string;
  /** Whether the suggestion came from LLM (true) or heuristics (false). */
  llmClassified: boolean;
  /** Brief text sample used for classification (shown in UI for transparency). */
  sample:      string;
}

export type IngestQueueCallback = (item: IngestQueueItem, index: number, total: number) => void;

// Kavita-supported file extensions
const KAVITA_EXTENSIONS = new Set([
  // Archives (comics/manga)
  '.cbz', '.cbr', '.cb7', '.zip', '.rar',
  // Ebooks
  '.epub',
  // Documents
  '.pdf',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a list of file paths, classify each, and return an ingest queue.
 * Calls onProgress after each file is classified.
 *
 * Skips files with unsupported extensions (returns them with type 'books' and
 * a reason indicating the extension is not natively supported by Kavita — the
 * user can reassign or ignore).
 */
export async function buildIngestQueue(
  filePaths:  string[],
  onProgress: IngestQueueCallback,
): Promise<IngestQueueItem[]> {
  const llmPort = await getAvailableLlmPort();
  const queue: IngestQueueItem[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const item     = await classifyFile(filePath, llmPort);
    queue.push(item);
    onProgress(item, i, filePaths.length);
    // Yield to keep event loop alive during batch.
    await new Promise(r => setTimeout(r, 1));
  }

  return queue;
}

/**
 * Copy a confirmed ingest queue item into the target Kavita library folder.
 * Destination: libraryFolder / filename (flat, no subdirectory).
 * Never overwrites — appends a numeric suffix if the filename already exists.
 */
export function copyToLibrary(item: IngestQueueItem, libraryFolder: string): string {
  fs.mkdirSync(libraryFolder, { recursive: true });

  const base    = path.basename(item.sourcePath);
  const ext     = path.extname(base);
  const stem    = path.basename(base, ext);

  let dest = path.join(libraryFolder, base);
  let n    = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(libraryFolder, `${stem} (${n})${ext}`);
    n++;
  }

  fs.copyFileSync(item.sourcePath, dest);
  return dest;
}

// ── Classification ────────────────────────────────────────────────────────────

async function classifyFile(filePath: string, llmPort: number | null): Promise<IngestQueueItem> {
  const filename = path.basename(filePath);
  const ext      = path.extname(filePath).toLowerCase();

  // Extract a readable sample for classification.
  const { sample, readable } = await extractSample(filePath, ext);

  let suggestion:    KavitaLibType;
  let reason:        string;
  let llmClassified  = false;

  if (readable && sample.trim().length > 40 && llmPort !== null) {
    // LLM path — attempt classification from content.
    const llmResult = await classifyWithLlm(filename, sample, llmPort);
    if (llmResult) {
      suggestion    = llmResult.type;
      reason        = llmResult.reason;
      llmClassified = true;
    } else {
      // LLM returned unusable output — fall back.
      const h    = heuristicClassify(filename, ext, sample);
      suggestion = h.type;
      reason     = `${h.reason} (LLM classification unavailable)`;
    }
  } else {
    // Heuristic path.
    const h    = heuristicClassify(filename, ext, sample);
    suggestion = h.type;
    reason     = readable ? h.reason : `${h.reason} (file not readable for content analysis)`;
  }

  return { sourcePath: filePath, filename, suggestion, reason, llmClassified, sample: sample.slice(0, 200) };
}

// ── LLM classification ────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You classify documents into Kavita library types.
Output ONLY a JSON object with two fields: "type" and "reason".
type must be exactly one of: manga | comics | books | lightnovels
reason is one sentence max explaining the classification.
Do not output anything else.`;

const CLASSIFY_USER = (filename: string, sample: string) =>
  `Filename: ${filename}\n\nContent sample:\n${sample.slice(0, 600)}`;

interface LlmResult { type: KavitaLibType; reason: string; }

async function classifyWithLlm(
  filename: string,
  sample:   string,
  port:     number,
): Promise<LlmResult | null> {
  try {
    const body = JSON.stringify({
      model:      'local',
      messages:   [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user',   content: CLASSIFY_USER(filename, sample) },
      ],
      max_tokens:  60,
      temperature: 0,
      stream:      false,
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(8_000),
    });

    if (!res.ok) return null;

    const json     = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw      = json.choices?.[0]?.message?.content?.trim() ?? '';
    // Strip markdown fences if present.
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed   = JSON.parse(jsonText) as { type: string; reason: string };

    const validTypes: KavitaLibType[] = ['manga', 'comics', 'books', 'lightnovels'];
    if (!validTypes.includes(parsed.type as KavitaLibType)) return null;

    return { type: parsed.type as KavitaLibType, reason: parsed.reason };
  } catch {
    return null;
  }
}

// ── Heuristic classification ──────────────────────────────────────────────────

interface HeuristicResult { type: KavitaLibType; reason: string; }

function heuristicClassify(filename: string, ext: string, sample: string): HeuristicResult {
  const lower = filename.toLowerCase();

  // Extension signals.
  if (ext === '.cbz' || ext === '.cbr' || ext === '.cb7') {
    // CBZ/CBR is almost always comics or manga — disambiguate by name.
    if (isMangaName(lower)) {
      return { type: 'manga', reason: 'CBZ/CBR archive with manga naming patterns' };
    }
    return { type: 'comics', reason: 'CBZ/CBR archive — comic book format' };
  }

  if (ext === '.epub') {
    // Light novels often have "LN", "light novel", "vol" + Japanese-style names.
    if (/light.?novel|ln\b|\blightnovel/.test(lower) || isMangaName(lower)) {
      return { type: 'lightnovels', reason: 'EPUB with light novel naming patterns' };
    }
    // EPUB with manga/manhwa keywords — some digital manga ships as EPUB.
    if (isMangaName(lower) && /manhwa|manhua|webtoon/.test(lower)) {
      return { type: 'manga', reason: 'EPUB with manhwa/webtoon naming' };
    }
    return { type: 'books', reason: 'EPUB ebook' };
  }

  if (ext === '.pdf') {
    // PDFs are almost always books/documents in Kavita context.
    if (isMangaName(lower)) {
      return { type: 'manga', reason: 'PDF with manga naming patterns (unusual format)' };
    }
    return { type: 'books', reason: 'PDF document' };
  }

  // Content-based signals when sample is available.
  if (sample) {
    const s = sample.toLowerCase();
    if (/manga|chapter|scanlat|scans|typeset|tankobon/.test(s)) {
      return { type: 'manga', reason: 'Content references manga/scanlation terminology' };
    }
    if (/comic|panel|issue|variant|collected edition|trade paperback/.test(s)) {
      return { type: 'comics', reason: 'Content references comic book terminology' };
    }
  }

  return { type: 'books', reason: 'Default classification (no strong signals detected)' };
}

function isMangaName(lower: string): boolean {
  return /manga|manhwa|manhua|webtoon|tankob|ch\.\d|vol\.\d|\[\w+\]\s*\[.*\]/.test(lower);
}

// ── Text sample extraction ────────────────────────────────────────────────────

async function extractSample(
  filePath: string,
  ext:      string,
): Promise<{ sample: string; readable: boolean }> {
  if (!fs.existsSync(filePath)) return { sample: '', readable: false };

  try {
    if (ext === '.epub') {
      const AdmZip = (await import('adm-zip')).default;
      const zip    = new AdmZip(filePath);
      for (const entry of zip.getEntries()) {
        const name = entry.entryName.toLowerCase();
        if (name.endsWith('.html') || name.endsWith('.xhtml')) {
          const html = entry.getData().toString('utf8');
          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (text.length > 40) return { sample: text.slice(0, 800), readable: true };
        }
      }
      return { sample: '', readable: false };
    }

    if (ext === '.pdf') {
      // Use pdfjs-dist if available — same approach as ArchiveIngestor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pdfjsLib: any;
      for (const candidate of ['pdfjs-dist/build/pdf.node.mjs', 'pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist']) {
        try { pdfjsLib = await import(candidate); break; } catch { /* next */ }
      }
      if (!pdfjsLib) return { sample: '', readable: false };

      if (pdfjsLib.GlobalWorkerOptions) {
        try {
          const u = import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
          pdfjsLib.GlobalWorkerOptions.workerSrc = u;
        } catch { pdfjsLib.GlobalWorkerOptions.workerSrc = 'noop'; }
      }

      const data = new Uint8Array(fs.readFileSync(filePath));
      const pdf  = await pdfjsLib.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
      const page = await pdf.getPage(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (await page.getTextContent()).items as any[];
      const text  = items.map((i: { str?: string }) => i.str ?? '').join(' ').trim();
      return { sample: text.slice(0, 800), readable: text.length > 40 };
    }

    // CBZ/CBR — read the comment field of the ZIP central directory if present.
    if (ext === '.cbz' || ext === '.zip') {
      const AdmZip = (await import('adm-zip')).default;
      const zip    = new AdmZip(filePath);
      const comment = zip.getZipComment();
      // Some tools embed ComicInfo.xml — extract title/series from it.
      const comicInfo = zip.getEntry('ComicInfo.xml') ?? zip.getEntry('comicinfo.xml');
      if (comicInfo) {
        const xml  = comicInfo.getData().toString('utf8');
        const title  = xml.match(/<Title>([^<]+)<\/Title>/)?.[1] ?? '';
        const series = xml.match(/<Series>([^<]+)<\/Series>/)?.[1] ?? '';
        const genre  = xml.match(/<Genre>([^<]+)<\/Genre>/)?.[1] ?? '';
        const text   = [title, series, genre, comment].filter(Boolean).join(' ');
        return { sample: text.slice(0, 800), readable: text.length > 0 };
      }
      return { sample: comment?.slice(0, 800) ?? '', readable: false };
    }

    return { sample: '', readable: false };
  } catch {
    return { sample: '', readable: false };
  }
}

// ── LLM port detection ────────────────────────────────────────────────────────

const SAYON_PORT = 16313;
const SEREN_PORT = 16314;

async function getAvailableLlmPort(): Promise<number | null> {
  const status = getServerStatus();
  if (status.sayon.state === 'running') return SAYON_PORT;
  if (status.seren.state === 'running') return SEREN_PORT;
  return null;
}
