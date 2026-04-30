/**
 * PluginScanner.ts — VST3 plugin discovery for the PHOBOS DAW.
 *
 * Scans two sources:
 *   1. Bundled ("phobos") — VST3s shipped with PHOBOS itself. These live in
 *      ~/.phobos/services/phobos-host/plugins/ and are deployed by the
 *      fetch-*.js scripts (fetch-helm, fetch-crystal). They're trusted and
 *      always available.
 *
 *   2. System — VST3s the user has installed elsewhere. We read VST3_PATH
 *      first then fall back to platform-standard directories:
 *        • Windows: C:\Program Files\Common Files\VST3
 *        • macOS:   /Library/Audio/Plug-Ins/VST3  and  ~/Library/Audio/Plug-Ins/VST3
 *        • Linux:   /usr/lib/vst3, /usr/local/lib/vst3, ~/.vst3
 *
 * Discovery is filesystem-only — we identify plugins by the `.vst3` bundle
 * directory name + any `Contents/Resources/moduleinfo.json` metadata. We do
 * NOT probe plugins by spawning host subprocesses. Probing would catch
 * broken plugins that crash the host, which is exactly the kind of hazard
 * that can't be recovered from in a scanner. If a plugin's moduleinfo is
 * missing we fall back to deriving the display name from the bundle name.
 *
 * Note: PhobosHost has its own VST3 scanner (the C++ side, via JUCE's
 * AudioPluginFormatManager) used for plugin instantiation metadata. This
 * TypeScript scanner is the BACKEND-side filesystem catalog used for the
 * plugin-listing UI; it intentionally does NOT load plugin code.
 *
 * Results cache in DuckDB with a staleness window (default 1 hour). A
 * forced refresh rescans all sources unconditionally.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePluginsDir } from './PhobosHostManager.js';
import type { DatabaseManager } from '../db/DatabaseManager.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type PluginSource = 'phobos' | 'system';

export interface PluginEntry {
  /** Stable id — source-prefixed bundle-basename. e.g. "phobos:PhobosCrystal" */
  id:       string;
  /** Human-readable name, from moduleinfo.json or the bundle name. */
  name:     string;
  /** Absolute path to the .vst3 directory (or .vst3 file on Windows). */
  path:     string;
  /** Which source tree this plugin was discovered under. */
  source:   PluginSource;
  /** Platform this entry was cached on — used to invalidate cross-platform rows. */
  platform: string;
  /** Subcategory from moduleinfo.json if available, else ''. */
  category: string;
  /** ISO timestamp of the scan. */
  last_scanned: string;
}

export interface PluginListing {
  phobos: PluginEntry[];
  system: PluginEntry[];
}

const STALE_WINDOW_MS = 60 * 60 * 1000;       // 1 hour

// ── Path resolution ─────────────────────────────────────────────────────────

/**
 * Platform VST3 roots for system-installed plugins. Returns an array of
 * absolute paths; callers must filter for existence before walking.
 */
export function systemVst3Roots(): string[] {
  const roots: string[] = [];

  // VST3_PATH can be a path-delimited list. Prepend in discovery order.
  const envPaths = process.env.VST3_PATH;
  if (envPaths) {
    for (const p of envPaths.split(path.delimiter)) {
      if (p) roots.push(p);
    }
  }

  switch (process.platform) {
    case 'win32': {
      const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
      const commonFiles  = process.env['CommonProgramFiles'] ?? path.join(programFiles, 'Common Files');
      roots.push(path.join(commonFiles, 'VST3'));
      break;
    }
    case 'darwin': {
      roots.push('/Library/Audio/Plug-Ins/VST3');
      roots.push(path.join(os.homedir(), 'Library', 'Audio', 'Plug-Ins', 'VST3'));
      break;
    }
    default: {
      // Linux and other Unix.
      roots.push('/usr/lib/vst3');
      roots.push('/usr/local/lib/vst3');
      roots.push(path.join(os.homedir(), '.vst3'));
      break;
    }
  }

  // Dedupe preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const norm = path.resolve(r);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// ── Filesystem discovery ────────────────────────────────────────────────────

/**
 * Find every .vst3 bundle directly under the given directory. VST3 plugins
 * are ALWAYS directories on macOS/Linux and typically on Windows (the
 * "bundle" format). If we encounter a `.vst3` FILE (legacy Windows single-
 * file plugin), we include it too.
 *
 * We do NOT recurse deeply — VST3 hosts convention is one level. Going
 * deeper risks catching nested dependencies and slowing the scan.
 */
function scanDirForVst3s(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];                                  // unreadable dir — skip silently
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.vst3')) continue;
    // Accept directories (standard) and .vst3 files (legacy Windows).
    if (entry.isDirectory() || entry.isFile()) {
      results.push(path.join(root, entry.name));
    }
  }
  return results;
}

/**
 * Read moduleinfo.json if present. VST3 bundles have it at:
 *   <plugin>.vst3/Contents/Resources/moduleinfo.json
 * The JSON is spec-defined and contains Factory.Classes[i].Name and Category.
 */
function readModuleInfo(pluginPath: string): { name?: string; category?: string } {
  if (!fs.statSync(pluginPath).isDirectory()) return {};
  const infoPath = path.join(pluginPath, 'Contents', 'Resources', 'moduleinfo.json');
  if (!fs.existsSync(infoPath)) return {};
  try {
    const raw = fs.readFileSync(infoPath, 'utf8');
    // Strip line comments that some Steinberg SDK builds emit — JSON.parse
    // rejects them. Cheap regex; good enough for metadata.
    const clean = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const data  = JSON.parse(clean) as {
      Factory?: {
        Classes?: Array<{ Name?: string; Category?: string }>;
      };
    };
    const first = data.Factory?.Classes?.[0];
    return {
      name:     first?.Name,
      category: first?.Category,
    };
  } catch {
    return {};                                  // corrupt / unparseable — fall through
  }
}

/**
 * Build a PluginEntry from a filesystem path. Derives name from moduleinfo
 * or falls back to the bundle basename.
 */
function makeEntry(pluginPath: string, source: PluginSource): PluginEntry {
  const basename = path.basename(pluginPath, '.vst3');
  const info     = readModuleInfo(pluginPath);
  return {
    id:           `${source}:${basename}`,
    name:         info.name || basename,
    path:         pluginPath,
    source,
    platform:     process.platform,
    category:     info.category ?? '',
    last_scanned: new Date().toISOString(),
  };
}

// ── Scan ─────────────────────────────────────────────────────────────────────

/** Scan the bundled-plugin dir (the one PhobosHost loads from). */
export function scanPhobosPlugins(): PluginEntry[] {
  const root = resolvePluginsDir();
  return scanDirForVst3s(root).map((p) => makeEntry(p, 'phobos'));
}

/** Scan every system VST3 root. Deduplicated by absolute path. */
export function scanSystemPlugins(): PluginEntry[] {
  const seen    = new Set<string>();
  const entries: PluginEntry[] = [];
  for (const root of systemVst3Roots()) {
    for (const p of scanDirForVst3s(root)) {
      const norm = path.resolve(p);
      if (seen.has(norm)) continue;
      seen.add(norm);
      entries.push(makeEntry(norm, 'system'));
    }
  }
  return entries;
}

// ── DuckDB-backed cache ─────────────────────────────────────────────────────

interface RawRow {
  id: string; name: string; path: string; source: string;
  platform: string; category: string; last_scanned: string;
}

export class PluginScanner {
  private db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS vst3_plugin_cache (
        id           VARCHAR PRIMARY KEY,
        name         VARCHAR NOT NULL,
        path         VARCHAR NOT NULL,
        source       VARCHAR NOT NULL,
        platform     VARCHAR NOT NULL,
        category     VARCHAR NOT NULL,
        last_scanned TIMESTAMP NOT NULL
      )
    `);
  }

  /**
   * Return cached entries. If the cache is older than the staleness window
   * (or empty, or force-refresh requested), rescan the filesystem first.
   */
  async list(options: { refresh?: boolean } = {}): Promise<PluginListing> {
    await this.ensureTable();

    if (options.refresh || await this.isStale()) {
      await this.rescan();
    }

    const rows = await this.db.query<RawRow>(
      `SELECT id, name, path, source, platform, category, last_scanned
         FROM vst3_plugin_cache
         WHERE platform = ?
         ORDER BY source, name`,
      [process.platform],
    );

    const phobos: PluginEntry[] = [];
    const system: PluginEntry[] = [];
    for (const row of rows) {
      const entry: PluginEntry = {
        id:           row.id,
        name:         row.name,
        path:         row.path,
        source:       row.source === 'phobos' ? 'phobos' : 'system',
        platform:     row.platform,
        category:     row.category,
        last_scanned: row.last_scanned,
      };
      if (entry.source === 'phobos') phobos.push(entry);
      else                           system.push(entry);
    }
    return { phobos, system };
  }

  private async isStale(): Promise<boolean> {
    const rows = await this.db.query<{ max_ts: string | null }>(
      `SELECT MAX(last_scanned) AS max_ts FROM vst3_plugin_cache WHERE platform = ?`,
      [process.platform],
    );
    const maxTs = rows[0]?.max_ts;
    if (!maxTs) return true;                    // empty cache → stale
    const age = Date.now() - new Date(maxTs).getTime();
    return age > STALE_WINDOW_MS;
  }

  /**
   * Full filesystem rescan — replaces all rows for the current platform.
   * Other platforms' cached rows are preserved (useful if the DB is shared
   * via sync or a migration tool).
   */
  async rescan(): Promise<{ phobos: number; system: number }> {
    const phobos = scanPhobosPlugins();
    const system = scanSystemPlugins();
    const all = [...phobos, ...system];

    // Delete stale rows for this platform, then insert fresh.
    await this.db.run(
      `DELETE FROM vst3_plugin_cache WHERE platform = ?`,
      [process.platform],
    );
    for (const entry of all) {
      await this.db.run(
        `INSERT INTO vst3_plugin_cache (id, name, path, source, platform, category, last_scanned)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           source = excluded.source,
           category = excluded.category,
           last_scanned = excluded.last_scanned`,
        [entry.id, entry.name, entry.path, entry.source, entry.platform, entry.category, entry.last_scanned],
      );
    }
    return { phobos: phobos.length, system: system.length };
  }
}
