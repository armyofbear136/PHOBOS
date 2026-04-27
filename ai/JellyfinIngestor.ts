// ── JellyfinIngestor.ts ───────────────────────────────────────────────────────
//
// Classifies video files as movies or TV episodes, extracts series/season
// metadata, and organises them into the standard folder structure:
//
//   TV shows:  {library}/{Series Name}/Season {N}/{original-filename}
//   Movies:    {library}/{original-filename}
//
// Classification order:
//   1. Directory structure — if parent folder looks like a Season dir, it's TV.
//   2. Filename patterns  — SxxExx, s01e01, "Season 1", etc.
//   3. ffprobe metadata  — checks the container's embedded title/show tags.
//   4. LLM fallback      — SYBIL classifies ambiguous titles by name alone.
//
// Only video files are accepted as TV/movie targets. All other extensions
// fall through to the 'phobos' (homevideos) default library.

import fs   from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export type JellyfinIngestDest = 'movies' | 'tvshows' | 'phobos';

export interface JellyfinIngestItem {
  sourcePath:    string;
  filename:      string;
  /** Classifier suggestion: which library this file belongs in. */
  suggestion:    JellyfinIngestDest;
  /** For TV: detected series name, else empty. */
  seriesName:    string;
  /** For TV: detected season number (1-based), else 0. */
  seasonNumber:  number;
  reason:        string;
  llmClassified: boolean;
}

// ── Video extensions accepted as movies/TV candidates ─────────────────────────

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts',
  '.mpg', '.mpeg', '.flv', '.webm', '.vob', '.divx', '.xvid',
]);

// ── Filename patterns for TV detection ───────────────────────────────────────

// SxxExx / S01E01 / 1x01
const RE_SEASON_EPISODE = /[Ss](\d{1,2})[Ee](\d{1,2})|(\d{1,2})x(\d{2})/;
// "Season 1", "Season.1", "Season_1"
const RE_SEASON_WORD    = /[Ss]eason[\s._-]?(\d{1,2})/i;
// Standalone episode: "E01", "Ep01", "Episode 01"
const RE_EPISODE_ONLY   = /[Ee]p?(?:isode)?[\s._-]?(\d{1,3})/i;

// ── Infer series name from filename ──────────────────────────────────────────
// Remove season/episode markers and clean up separators.

function inferSeriesName(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  // Strip everything from the SxxExx marker onward.
  const stripped = base
    .replace(/[Ss]\d{1,2}[Ee]\d{1,2}.*/, '')
    .replace(/\d{1,2}x\d{2}.*/, '')
    .replace(/[Ss]eason[\s._-]?\d{1,2}.*/i, '')
    // Strip common quality/codec tags
    .replace(/\b(1080p|720p|480p|4K|UHD|BluRay|WEB|WEBRip|HDTV|x264|x265|HEVC|AAC|DTS|AC3|HDR)\b.*/i, '')
    // Replace separators with spaces
    .replace(/[._-]+/g, ' ')
    .trim();
  // Title-case
  return stripped
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function extractSeasonNumber(filename: string, dirName: string): number {
  // Check parent directory name first — "Season 2", "S02", "season_02"
  const dirMatch = dirName.match(/[Ss]eason[\s._-]?(\d{1,2})/i)
    ?? dirName.match(/^[Ss](\d{1,2})$/);
  if (dirMatch) return parseInt(dirMatch[1], 10);

  // Filename SxxExx
  const seMatch = filename.match(/[Ss](\d{1,2})[Ee]\d{1,2}/);
  if (seMatch) return parseInt(seMatch[1], 10);

  // Filename "Season N"
  const swMatch = filename.match(RE_SEASON_WORD);
  if (swMatch) return parseInt(swMatch[1], 10);

  // Nx style
  const nxMatch = filename.match(/(\d{1,2})x\d{2}/);
  if (nxMatch) return parseInt(nxMatch[1], 10);

  return 1; // Default to season 1 when only episode markers found
}

// ── ffprobe metadata probe ────────────────────────────────────────────────────

interface FfprobeFormat {
  tags?: {
    title?:       string;
    show?:        string;
    album?:       string;
    season_number?: string;
    episode_id?:  string;
  };
}

async function probeFfprobe(
  ffprobePath: string,
  filePath:    string,
): Promise<FfprobeFormat | null> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ], { timeout: 10_000 });
    const parsed = JSON.parse(stdout) as { format?: FfprobeFormat };
    return parsed.format ?? null;
  } catch {
    return null; // ffprobe unavailable or file unreadable — fall through
  }
}

// ── LLM fallback classification ───────────────────────────────────────────────

async function llmClassify(filename: string): Promise<{
  suggestion: JellyfinIngestDest;
  seriesName: string;
  seasonNumber: number;
}> {
  try {
    const prompt =
      `You are classifying a video file for a media library. ` +
      `Given only the filename, determine: ` +
      `(1) is it a movie, a TV show episode, or unknown/other? ` +
      `(2) if TV show: what is the series name and season number? ` +
      `Respond ONLY with JSON: ` +
      `{ "type": "movie"|"tvshow"|"other", "seriesName": string, "seasonNumber": number }. ` +
      `Filename: "${filename}"`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content.find(b => b.type === 'text')?.text ?? '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean) as { type: string; seriesName?: string; seasonNumber?: number };

    if (parsed.type === 'tvshow') {
      return {
        suggestion:   'tvshows',
        seriesName:   parsed.seriesName ?? inferSeriesName(filename),
        seasonNumber: parsed.seasonNumber ?? 1,
      };
    }
    if (parsed.type === 'movie') {
      return { suggestion: 'movies', seriesName: '', seasonNumber: 0 };
    }
  } catch { /* fall through to phobos */ }

  return { suggestion: 'phobos', seriesName: '', seasonNumber: 0 };
}

// ── Main classifier ───────────────────────────────────────────────────────────

async function classifyFile(
  filePath:    string,
  ffprobePath: string | null,
): Promise<Omit<JellyfinIngestItem, 'sourcePath'>> {
  const filename = path.basename(filePath);
  const ext      = path.extname(filename).toLowerCase();
  const dirName  = path.basename(path.dirname(filePath));

  // Non-video files → phobos default library, no further analysis needed.
  if (!VIDEO_EXTS.has(ext)) {
    return {
      filename,
      suggestion:   'phobos',
      seriesName:   '',
      seasonNumber: 0,
      reason:       `Non-video extension ${ext} → Phobos library`,
      llmClassified: false,
    };
  }

  // ── Stage 1: directory structure ──────────────────────────────────────────
  // Parent dir looks like a season folder → definite TV show.
  if (RE_SEASON_WORD.test(dirName) || /^[Ss]\d{1,2}$/.test(dirName)) {
    const grandparent = path.basename(path.dirname(path.dirname(filePath)));
    const seriesName  = grandparent && grandparent !== '.' ? grandparent : inferSeriesName(filename);
    const seasonNum   = extractSeasonNumber(filename, dirName);
    return {
      filename,
      suggestion:   'tvshows',
      seriesName,
      seasonNumber: seasonNum,
      reason:       `Parent directory "${dirName}" is a season folder`,
      llmClassified: false,
    };
  }

  // ── Stage 2: filename patterns ────────────────────────────────────────────
  if (RE_SEASON_EPISODE.test(filename)) {
    return {
      filename,
      suggestion:   'tvshows',
      seriesName:   inferSeriesName(filename),
      seasonNumber: extractSeasonNumber(filename, dirName),
      reason:       'SxxExx pattern matched in filename',
      llmClassified: false,
    };
  }

  if (RE_EPISODE_ONLY.test(filename)) {
    return {
      filename,
      suggestion:   'tvshows',
      seriesName:   inferSeriesName(filename),
      seasonNumber: 1,
      reason:       'Episode pattern matched in filename',
      llmClassified: false,
    };
  }

  // ── Stage 3: ffprobe metadata ─────────────────────────────────────────────
  if (ffprobePath) {
    const fmt = await probeFfprobe(ffprobePath, filePath);
    if (fmt?.tags) {
      const { show, season_number } = fmt.tags;
      if (show) {
        return {
          filename,
          suggestion:   'tvshows',
          seriesName:   show,
          seasonNumber: season_number ? parseInt(season_number, 10) : 1,
          reason:       'ffprobe show/season_number tag present',
          llmClassified: false,
        };
      }
    }
  }

  // ── Stage 4: LLM fallback ─────────────────────────────────────────────────
  const llm = await llmClassify(filename);
  return {
    filename,
    suggestion:   llm.suggestion,
    seriesName:   llm.seriesName,
    seasonNumber: llm.seasonNumber,
    reason:       'LLM classification',
    llmClassified: true,
  };
}

// ── Build full queue ──────────────────────────────────────────────────────────

export async function buildIngestQueue(
  files:       string[],
  ffprobePath: string | null,
  onProgress?: (item: JellyfinIngestItem, index: number, total: number) => void,
): Promise<JellyfinIngestItem[]> {
  const queue: JellyfinIngestItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const result   = await classifyFile(filePath, ffprobePath);
    const item: JellyfinIngestItem = { sourcePath: filePath, ...result };
    queue.push(item);
    onProgress?.(item, i, files.length);
  }

  return queue;
}

// ── Destination path builder ──────────────────────────────────────────────────
// Returns the target file path. Creates parent directories.

export function resolveDestPath(
  item:          JellyfinIngestItem,
  libraryFolder: string,
): string {
  if (item.suggestion === 'tvshows' && item.seriesName) {
    const seasonDir = `Season ${String(item.seasonNumber).padStart(2, '0')}`;
    const dest      = path.join(libraryFolder, item.seriesName, seasonDir, item.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return dest;
  }
  // movies and phobos: flat into library folder
  const dest = path.join(libraryFolder, item.filename);
  fs.mkdirSync(libraryFolder, { recursive: true });
  return dest;
}

// ── Safe copy (no overwrite — numeric suffix on collision) ────────────────────

export function copyToLibrary(item: JellyfinIngestItem, libraryFolder: string): string {
  let dest = resolveDestPath(item, libraryFolder);

  if (fs.existsSync(dest)) {
    const ext  = path.extname(dest);
    const base = dest.slice(0, dest.length - ext.length);
    let   n    = 1;
    while (fs.existsSync(`${base}.${n}${ext}`)) n++;
    dest = `${base}.${n}${ext}`;
  }

  fs.copyFileSync(item.sourcePath, dest);
  return dest;
}
