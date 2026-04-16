import * as fs   from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os   from 'os';

export interface SandboxSpec {
  taskId: string;
  /** Absolute path to the workspace root — files are copied from here. */
  workspaceDir: string;
  /**
   * Workspace-relative filenames to copy into the sandbox before execution.
   * SEREN declares these in the task plan; they are validated here.
   */
  sourceFiles: string[];
  /**
   * If true, populate the sandbox from the workspace.
   * If false (default), the sandbox starts empty — script must create what it needs.
   */
  useWorkspace: boolean;
}

export interface SandboxHandle {
  sandboxDir: string;
  /** Call after execution to copy declared output files back to workspace. */
  collectOutputs(outputFiles: string[]): Promise<string[]>;
  /** Always call in finally — removes the temp dir. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated temp directory, optionally populated with declared workspace files.
 * Returns a handle for output collection and cleanup.
 *
 * Security model: the sandbox has no write path back to the workspace during execution.
 * Output files are copied back explicitly via collectOutputs() only after the run completes.
 */
export async function createSandbox(spec: SandboxSpec): Promise<SandboxHandle> {
  const sandboxDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `phobos-sandbox-${spec.taskId}-`)
  );

  if (spec.useWorkspace && spec.sourceFiles.length > 0) {
    for (const rel of spec.sourceFiles) {
      // Validate: no path separators other than the normalized relative path,
      // no .. sequences — prevents escaping the workspace.
      const normalized = path.normalize(rel);
      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        console.warn(`[SandboxManager] Rejected unsafe sourceFile path: ${rel}`);
        continue;
      }
      const src = path.join(spec.workspaceDir, normalized);
      const dst = path.join(sandboxDir, path.basename(normalized));
      try {
        await fs.copyFile(src, dst);
      } catch {
        // Non-fatal — file may have been declared but not yet created by a prior task.
        // The script will fail if it actually needs the file.
      }
    }
  }

  return {
    sandboxDir,

    async collectOutputs(outputFiles: string[]): Promise<string[]> {
      const copied: string[] = [];
      for (const filename of outputFiles) {
        // Validate filename — output files must be plain names, no directory traversal.
        if (path.basename(filename) !== filename || filename.includes('..')) {
          console.warn(`[SandboxManager] Rejected unsafe outputFile: ${filename}`);
          continue;
        }
        const src = path.join(sandboxDir, filename);
        const dst = path.join(spec.workspaceDir, filename);
        try {
          await fs.copyFile(src, dst);
          copied.push(filename);
        } catch {
          // File was declared but not produced — non-fatal.
        }
      }
      return copied;
    },

    async cleanup(): Promise<void> {
      try {
        await fs.rm(sandboxDir, { recursive: true, force: true });
      } catch {
        // Best-effort — OS will clean temp dirs on reboot at worst.
      }
    },
  };
}

/**
 * Validate that an entrypoint filename is safe to execute:
 * - Must be a plain filename (no directory separators)
 * - Must not be empty or contain .. sequences
 * - Must exist inside the given sandbox dir
 */
export function validateEntrypoint(entrypoint: string, sandboxDir: string): boolean {
  if (!entrypoint || entrypoint.includes('/') || entrypoint.includes('\\') || entrypoint.includes('..')) {
    return false;
  }
  return fsSync.existsSync(path.join(sandboxDir, entrypoint));
}
