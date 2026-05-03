/**
 * PolarisHostPlayer.ts — Backend bridge: Polaris virtual paths → host file player.
 *
 * Polaris's REST API surfaces every song as a "virtual path" of the form
 *   <mountName>/<Artist>/<Album>/<Track>.<ext>
 * where mountName is the user-chosen label of a `[[mount_dirs]]` entry in
 * polaris.toml and the rest is the path relative to that mount's `source`
 * filesystem directory.
 *
 * The host's FilePlayerNode wants a real local filesystem path. It can't
 * resolve Polaris virtuals on its own. Two reasons we resolve here on the
 * backend rather than asking Polaris:
 *
 *   1. Polaris has no public "real_path" endpoint — virtuals are the entire
 *      surface. We'd have to read polaris.toml regardless to convert.
 *   2. The backend already manages polaris.toml (PolarisManager writes it).
 *      Owning translation here keeps the host generic ("just-a-fs-path") and
 *      lets future backend-mediated playback (game audio, ALDA's eventual
 *      sample-based instruments) reuse the same wrapper.
 *
 * The mount table is parsed from polaris.toml on each `playPolarisFile` call
 * — the file is small, parses in microseconds, and reading on every call
 * keeps us correct across Polaris config edits without needing a watcher.
 */

import * as fs   from 'fs';
import * as path from 'path';

import { resolveServiceDir as resolvePolarisServiceDir } from '../services/PolarisManager.js';
import {
  ensureRunning as ensureHostRunning,
  playAudioFile,
  pauseAudio,
  resumeAudio,
  seekAudio,
  stopAudio,
  getAudioStatus,
  type AudioStatus,
} from './PhobosHostManager.js';

// ── Mount table parsing ──────────────────────────────────────────────────────

interface PolarisMount {
  name:   string;        // virtual prefix, e.g. "Music"
  source: string;        // local fs root, e.g. "C:\\Users\\armyo\\Music"
}

/**
 * Parse polaris.toml's `[[mount_dirs]]` entries into a name→source map.
 * Tolerant: skips malformed entries, never throws on the file being absent
 * (callers see an empty map and report "polaris not configured" cleanly).
 *
 * The TOML format we expect (matches PolarisManager.writeConfig):
 *
 *   [[mount_dirs]]
 *   source = "C:\\Users\\armyo\\Music"
 *   name = "Music"
 *
 * We don't pull a TOML library for this — the format is simple and stable
 * (Polaris owns the schema, we own the writer). A regex over the file is
 * sufficient and avoids one more dependency.
 */
function readPolarisMounts(): PolarisMount[] {
  const tomlPath = path.join(resolvePolarisServiceDir(), 'polaris.toml');
  let text: string;
  try {
    text = fs.readFileSync(tomlPath, 'utf8');
  } catch {
    return [];
  }

  const mounts: PolarisMount[] = [];
  let inMountSection = false;
  let pendingName:   string | null = null;
  let pendingSource: string | null = null;

  const finalize = () => {
    if (pendingName && pendingSource) {
      mounts.push({ name: pendingName, source: pendingSource });
    }
    pendingName   = null;
    pendingSource = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      // Any new section starts — flush pending mount, then update mode.
      finalize();
      inMountSection = (line === '[[mount_dirs]]');
      continue;
    }

    if (!inMountSection) continue;

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = parseTomlString(line.slice(eq + 1).trim());
    if (val === null) continue;

    if      (key === 'name')   pendingName   = val;
    else if (key === 'source') pendingSource = val;
  }
  finalize();   // catch a [[mount_dirs]] that runs to EOF

  return mounts;
}

/** Parse a TOML basic-string value: a `"..."` literal with `\\` and `\"` escapes. */
function parseTomlString(raw: string): string | null {
  // Drop trailing comment, if any. (TOML comments after a value are legal.)
  // We only support double-quoted strings here; PolarisManager always writes
  // those.
  if (raw.length < 2 || raw[0] !== '"') return null;
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[++i];
      if (next === undefined) return null;
      out += next;
    } else if (c === '"') {
      return out;
    } else {
      out += c;
    }
  }
  return null;     // unterminated
}

/**
 * Translate a Polaris virtual path (`<mountName>/<rel>`) to a local fs path.
 * Returns null if no mount matches the leading segment, or if the relative
 * portion would escape the mount root via `..`.
 */
export function resolvePolarisLocalPath(virtualPath: string): string | null {
  if (typeof virtualPath !== 'string' || virtualPath.length === 0) return null;

  // Polaris uses forward slashes in virtuals regardless of host OS. Split on
  // the first separator.
  const normalized = virtualPath.replace(/\\/g, '/');
  const slashIdx   = normalized.indexOf('/');
  const mountName  = slashIdx < 0 ? normalized                : normalized.slice(0, slashIdx);
  const rel        = slashIdx < 0 ? ''                        : normalized.slice(slashIdx + 1);

  // Reject path-traversal attempts. `..` segments anywhere in the relative
  // portion mean a malicious or buggy caller is trying to escape the mount.
  // Polaris itself rejects these in its own resolver; we mirror that here as
  // defence-in-depth.
  if (rel.split('/').some((seg) => seg === '..')) return null;

  const mounts = readPolarisMounts();
  const match  = mounts.find((m) => m.name === mountName);
  if (!match) return null;

  return path.join(match.source, rel);
}


// ── Active session state ─────────────────────────────────────────────────────
//
// Tracks the currently playing Polaris session so the frontend can rehydrate
// after a page refresh without losing queue/position context. Written on every
// playPolarisFile call; cleared when stop is called. positionMs is NOT tracked
// here — the frontend polls /api/audio/player/status for that live.

export interface PolarisSession {
  audioId:    number;
  virtualPath: string;
  durationMs: number;
  queue:      string[];   // virtualPaths in order
  queueIdx:   number;
  shuffle:    boolean;
  repeat:     'none' | 'one' | 'all';
}

let activeSession: PolarisSession | null = null;

export function getActiveSession(): PolarisSession | null {
  return activeSession;
}

export function clearActiveSession(): void {
  activeSession = null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface PlayPolarisResult {
  audioId:    number;
  durationMs: number;
  /** The resolved local fs path (echoed for diagnostics; clients usually ignore). */
  localPath:  string;
}

/**
 * Resolve a Polaris virtual path and play it through the host's FilePlayerNode.
 * Returns the audioId for subsequent pause/resume/seek/stop calls.
 *
 * Throws on:
 *   - host unreachable
 *   - virtualPath not resolvable (no matching mount, traversal attempt)
 *   - file missing on disk after resolution
 *   - host file-player error (unsupported format, etc.)
 */
export async function playPolarisFile(args: {
  virtualPath: string;
  startMs?:    number;
  loop?:       boolean;
  queue?:      string[];
  queueIdx?:   number;
  shuffle?:    boolean;
  repeat?:     'none' | 'one' | 'all';
}): Promise<PlayPolarisResult> {
  const local = resolvePolarisLocalPath(args.virtualPath);
  if (local === null) {
    throw new Error(
      `Polaris virtual path could not be resolved: ${args.virtualPath}. ` +
      `Check that polaris.toml has a [[mount_dirs]] entry whose name matches the leading segment.`,
    );
  }
  if (!fs.existsSync(local)) {
    throw new Error(`Resolved file does not exist on disk: ${local}`);
  }

  await ensureHostRunning();
  const result = await playAudioFile({
    path:    local,
    startMs: args.startMs,
    loop:    args.loop,
  });

  activeSession = {
    audioId:     result.audioId,
    virtualPath: args.virtualPath,
    durationMs:  result.durationMs,
    queue:       args.queue    ?? [args.virtualPath],
    queueIdx:    args.queueIdx ?? 0,
    shuffle:     args.shuffle  ?? false,
    repeat:      args.repeat   ?? 'none',
  };

  return {
    audioId:    result.audioId,
    durationMs: result.durationMs,
    localPath:  local,
  };
}

// Re-export the per-id ops so callers can use the entire Polaris-flavored
// surface from this one module rather than mixing imports. The host doesn't
// distinguish "Polaris audioIds" from "any other audioIds" — they're all just
// audioIds — but the convenience aliases keep frontend call sites cohesive.

export {
  pauseAudio   as pausePolarisFile,
  resumeAudio  as resumePolarisFile,
  seekAudio    as seekPolarisFile,
  stopAudio    as stopPolarisFile,
  getAudioStatus as getPolarisFileStatus,
};

export type { AudioStatus };
