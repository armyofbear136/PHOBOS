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
  /** Human-readable name, from moduleinfo.json, deep-probe, or the bundle name. */
  name:     string;
  /** Absolute path to the .vst3 directory (or .vst3 file on Windows). */
  path:     string;
  /** Which source tree this plugin was discovered under. */
  source:   PluginSource;
  /** Platform this entry was cached on — used to invalidate cross-platform rows. */
  platform: string;
  /** Subcategory string. From moduleinfo.json or the host deep-probe. */
  category: string;
  /**
   * Authoritative instrument-vs-effect flag, populated by the host's
   * deep-probe (juce::PluginDescription::isInstrument). False until a deep
   * scan succeeds — callers MUST gate UI categorization on scanState ===
   * 'deep' before trusting this field. For shallow entries the only signal
   * is `category`, which is empty for plugins that don't ship moduleinfo.
   */
  isInstrument: boolean;
  /**
   * 'shallow' — only moduleinfo.json was read (or nothing — moduleinfo absent).
   * 'deep'    — the host's PluginScanner.scanFile was called and category +
   *             isInstrument were populated authoritatively.
   * Shallow entries are re-probed on every list() call until they succeed
   * (or the host stays offline). Deep entries are trusted forever (until
   * the user manually rescans).
   */
  scanState: 'shallow' | 'deep';
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
 * or falls back to the bundle basename. The entry starts as 'shallow' —
 * a deep-probe must run before isInstrument and (in the moduleinfo-less
 * case) category are trustworthy.
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
    isInstrument: false,                          // unknown until deep-probe
    scanState:    'shallow',
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
  platform: string; category: string;
  is_instrument: boolean | number;              // duckdb may emit 0/1 or boolean
  scan_state:    string;                          // 'shallow' | 'deep'
  last_scanned: string;
}

export class PluginScanner {
  private db: DatabaseManager;
  /**
   * Optional deep-probe hook. Set by callers that have access to the host
   * (PhobosHostManager.scanFile) so the scanner can promote shallow rows.
   * Left null when the host isn't reachable — shallow rows simply remain
   * shallow until a future scan finds the host running.
   */
  private deepProbe: ((vst3Path: string) => Promise<{ category: string; isInstrument: boolean } | null>) | null = null;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  /**
   * Wire a deep-probe function. The scanner will call this for every
   * shallow entry on each list() / rescan() pass; results promote the
   * row to 'deep'. The function should return null on probe failure
   * (broken plugin, host crash) — those rows stay shallow and the next
   * pass tries again.
   */
  setDeepProbe(fn: ((vst3Path: string) => Promise<{ category: string; isInstrument: boolean } | null>) | null): void {
    this.deepProbe = fn;
  }

  async ensureTable(): Promise<void> {
    // Base table — original schema. Created on first run of any version.
    
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

    // DuckDB does NOT accept constraints on ALTER TABLE ADD COLUMN (parser
    // rejects NOT NULL / DEFAULT clauses). Pattern is: add the column nullable,
    // then UPDATE legacy rows to populate. The application layer guarantees
    // these fields are non-null on all subsequent inserts/updates, so the
    // missing NOT NULL constraint is enforced upstream.
    //
    // The IF NOT EXISTS clause makes both ADD COLUMN and UPDATE safe to run
    // on every boot — first run adds + backfills, subsequent runs are no-ops.

    await this.db.run(`ALTER TABLE vst3_plugin_cache ADD COLUMN IF NOT EXISTS is_instrument BOOLEAN`);
    await this.db.run(`ALTER TABLE vst3_plugin_cache ADD COLUMN IF NOT EXISTS scan_state VARCHAR`);

    // Backfill any rows where the new columns are still NULL (legacy rows that
    // existed before the column was added). Idempotent — once backfilled, the
    // WHERE clause matches nothing on subsequent boots.
    await this.db.run(`UPDATE vst3_plugin_cache SET is_instrument = FALSE WHERE is_instrument IS NULL`);
    await this.db.run(`UPDATE vst3_plugin_cache SET scan_state    = 'shallow' WHERE scan_state    IS NULL`);
  }

  /**
   * Return cached entries. If the cache is older than the staleness window
   * (or empty, or force-refresh requested), rescan the filesystem first.
   * Then attempt a deep-probe pass on any rows still in 'shallow' state —
   * one moduleinfo-less plugin without category/isInstrument is benign in
   * isolation, but the chain modal needs that data to filter Instruments
   * vs FX correctly. Promotion is idempotent and host-availability-tolerant
   * (no host = leave shallow, retry next list()).
   */
  async list(options: { refresh?: boolean } = {}): Promise<PluginListing> {
    await this.ensureTable();

    if (options.refresh || await this.isStale()) {
      await this.rescan();
    }

    // Deep-probe pass — runs on every list() until all rows are 'deep' or
    // the host is unreachable. Cheap when there's nothing to promote.
    await this.promoteShallow();

    const rows = await this.db.query<RawRow>(
      `SELECT id, name, path, source, platform, category, is_instrument, scan_state, last_scanned
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
        isInstrument: !!row.is_instrument,         // duckdb may emit 0/1
        scanState:    row.scan_state === 'deep' ? 'deep' : 'shallow',
        last_scanned: row.last_scanned,
      };
      if (entry.source === 'phobos') phobos.push(entry);
      else                           system.push(entry);
    }
    return { phobos, system };
  }

  /**
   * Walk shallow rows and ask the host to deep-probe each one. On success,
   * write back category + isInstrument and flip scan_state to 'deep'. On
   * failure, leave the row shallow (next list() will retry).
   *
   * If no deep-probe hook is wired (host not booted yet), this is a no-op.
   * That keeps the scanner usable in environments where the host is not
   * reachable — categories simply won't be populated for moduleinfo-less
   * plugins until the host comes online.
   */
  private async promoteShallow(): Promise<void> {
    if (!this.deepProbe) return;

    const shallow = await this.db.query<{ id: string; path: string }>(
      `SELECT id, path FROM vst3_plugin_cache
        WHERE platform = ? AND scan_state = 'shallow'`,
      [process.platform],
    );
    if (shallow.length === 0) return;

    for (const row of shallow) {
      let probeResult: { category: string; isInstrument: boolean } | null = null;
      try {
        probeResult = await this.deepProbe(row.path);
      } catch {
        probeResult = null;                       // host crashed/timed out — try later
      }
      if (!probeResult) continue;                 // shallow row stays shallow

      await this.db.run(
        `UPDATE vst3_plugin_cache
            SET category = ?, is_instrument = ?, scan_state = 'deep', last_scanned = ?
          WHERE id = ?`,
        [probeResult.category, probeResult.isInstrument, new Date().toISOString(), row.id],
      );
    }
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
      // Plain INSERT — the DELETE above already cleared all rows for this platform,
      // so there can be no conflict. ON CONFLICT DO UPDATE is not used here because
      // DuckDB 1.4.x's binder fails on ON CONFLICT (col) in prepared statements.
      await this.db.run(
        `INSERT INTO vst3_plugin_cache (id, name, path, source, platform, category, is_instrument, scan_state, last_scanned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.name, entry.path, entry.source, entry.platform,
         entry.category, entry.isInstrument, entry.scanState, entry.last_scanned],
      );
    }
    return { phobos: phobos.length, system: system.length };
  }
}