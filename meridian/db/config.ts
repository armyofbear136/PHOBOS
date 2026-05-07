/**
 * meridian/config.ts — Configuration schema and loader for PHOBOS Meridian.
 *
 * MeridianManager writes config.json to ~/.phobos/services/meridian/config.json
 * before spawning the server process. The server reads it once at startup.
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

// ── Schema ────────────────────────────────────────────────────────────────────

export interface MeridianConfig {
  /** Port to bind (always 16320 — permanent wire contract). */
  port:          number;
  /** Primary PHOBOS-managed library root. Written by PHOBOS, shown as the default folder. */
  phobosLibPath: string;
  /** Additional user-owned library roots. Not shown in the single-root UI but fully indexed. */
  userLibPaths:  string[];
  /** Default user id for single-user mode. */
  userId:        string;
  /** Absolute path to the thumbnail cache directory. */
  thumbCacheDir: string;
  /** Absolute path to localai.duckdb. */
  dbPath:        string;
  /** Resolved ffmpeg binary path (from Jellyfin or system PATH). Null if unavailable. */
  ffmpegPath:    string | null;
  /** Whether the idle classifier pipeline is permitted to run. */
  idleEnabled:   boolean;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export function defaultConfig(): MeridianConfig {
  const base = path.join(os.homedir(), '.phobos', 'services', 'meridian');
  return {
    port:          16320,
    phobosLibPath: path.join(os.homedir(), '.phobos', 'media', 'meridian', 'phobosPhotos'),
    userLibPaths:  [],
    userId:        'default',
    thumbCacheDir: path.join(base, 'thumbs'),
    dbPath:        path.join(os.homedir(), '.phobos', 'localai.duckdb'),
    ffmpegPath:    null,
    idleEnabled:   true,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadConfig(configPath: string): MeridianConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Meridian config not found: ${configPath}`);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<MeridianConfig>;
    const defaults = defaultConfig();
    return {
      port:          raw.port          ?? defaults.port,
      phobosLibPath: raw.phobosLibPath ?? defaults.phobosLibPath,
      userLibPaths:  raw.userLibPaths  ?? defaults.userLibPaths,
      userId:        raw.userId        ?? defaults.userId,
      thumbCacheDir: raw.thumbCacheDir ?? defaults.thumbCacheDir,
      dbPath:        raw.dbPath        ?? defaults.dbPath,
      ffmpegPath:    raw.ffmpegPath    ?? defaults.ffmpegPath,
      idleEnabled:   raw.idleEnabled   ?? defaults.idleEnabled,
    };
  } catch (err) {
    throw new Error(`Failed to parse Meridian config at ${configPath}: ${(err as Error).message}`);
  }
}

// ── Config file path ──────────────────────────────────────────────────────────

export function resolveConfigPath(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'meridian', 'config.json');
}
