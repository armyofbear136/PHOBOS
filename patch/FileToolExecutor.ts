import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import type { FileToolCall, FileToolResult } from '../ai/FileTools.js';
import { generateWithFlux, type ImageGenStatus } from '../phobos/ImageGenerationHandler.js';

export interface StagedFileToolResult extends FileToolResult {
  /** Absolute path to the temp file holding the computed result. Undefined for read_file. */
  stagedPath?: string;
}

/**
 * Executes file tool calls against a workspace directory.
 * All paths are resolved relative to projectRoot and path-traversal-checked.
 */
export class FileToolExecutor {
  constructor(
    private projectRoot: string,
    /** Thread ID — required for generate_image output path resolution */
    private threadId: string = 'default',
  ) {}

  async execute(call: FileToolCall): Promise<FileToolResult> {
    try {
      const absPath = this.resolveSafe(call.path);

      switch (call.tool) {
        case 'write_file':
          return await this.writeFile(absPath, call.path, call.content);

        case 'append_file':
          return await this.appendFile(absPath, call.path, call.content);

        case 'insert_lines':
          return await this.insertLines(absPath, call.path, call.afterLine, call.content);

        case 'replace_lines':
          return await this.replaceLines(absPath, call.path, call.startLine, call.endLine, call.content);

        case 'delete_lines':
          return await this.deleteLines(absPath, call.path, call.startLine, call.endLine);

        case 'read_file':
          return await this.readFile(absPath, call.path);

        case 'generate_image':
          return await this.generateImage(call.path, (call as any).prompt ?? '', this.threadId);

        default: {
          const unknown = call as FileToolCall;
          return { tool: unknown.tool, path: unknown.path, success: false, error: 'Unknown tool' };
        }
      }
    } catch (err) {
      return {
        tool: call.tool,
        path: call.path,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async executeAll(calls: FileToolCall[]): Promise<FileToolResult[]> {
    const results: FileToolResult[] = [];
    for (const call of calls) {
      const result = await this.execute(call);
      results.push(result);
      // Don't abort on read failures — reads are informational
      if (!result.success && call.tool !== 'read_file') {
        console.error(`[FileToolExecutor] ${call.tool} failed on ${call.path}: ${result.error}`);
      }
    }
    return results;
  }

  /**
   * Simulates all write tool calls — computes the result for each operation
   * (reading source files from the real workspace as needed) but writes output
   * to a temporary directory instead of the workspace.
   *
   * Returns StagedFileToolResult with a stagedPath pointing to the temp file.
   * read_file calls pass through to the real workspace unchanged.
   * The caller is responsible for cleaning up the staged temp directory.
   */
  async simulateAll(calls: FileToolCall[]): Promise<StagedFileToolResult[]> {
    const stagingDir = path.join(os.tmpdir(), 'phobos-stage', randomBytes(8).toString('hex'));
    await fs.mkdir(stagingDir, { recursive: true });

    const results: StagedFileToolResult[] = [];
    for (const call of calls) {
      if (call.tool === 'read_file' || call.tool === 'generate_image') {
        // Reads and image generation bypass staging — execute directly
        const result = await this.execute(call);
        results.push(result);
        continue;
      }

      try {
        const realAbsPath = this.resolveSafe(call.path);
        const stagedAbsPath = path.join(stagingDir, call.path.replace(/[/\\]/g, '__'));

        let finalContent: string;

        switch (call.tool) {
          case 'write_file': {
            finalContent = call.content;
            break;
          }
          case 'append_file': {
            let existing = '';
            try { existing = await fs.readFile(realAbsPath, 'utf-8'); } catch { /* new file */ }
            const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
            finalContent = existing + separator + call.content;
            break;
          }
          case 'insert_lines': {
            const existing = await fs.readFile(realAbsPath, 'utf-8');
            const lines = existing.split('\n');
            const insertAt = Math.min(Math.max(call.afterLine, 0), lines.length);
            lines.splice(insertAt, 0, ...call.content.split('\n'));
            finalContent = lines.join('\n');
            break;
          }
          case 'replace_lines': {
            const existing = await fs.readFile(realAbsPath, 'utf-8');
            const lines = existing.split('\n');
            const start = Math.max(call.startLine - 1, 0);
            const end = Math.min(call.endLine - 1, lines.length - 1);
            lines.splice(start, end - start + 1, ...call.content.split('\n'));
            finalContent = lines.join('\n');
            break;
          }
          case 'delete_lines': {
            const existing = await fs.readFile(realAbsPath, 'utf-8');
            const lines = existing.split('\n');
            const start = Math.max(call.startLine - 1, 0);
            const end = Math.min(call.endLine - 1, lines.length - 1);
            lines.splice(start, end - start + 1);
            finalContent = lines.join('\n');
            break;
          }
          default: {
            const unknown = call as FileToolCall;
            results.push({ tool: unknown.tool, path: unknown.path, success: false, error: 'Unknown tool' });
            continue;
          }
        }

        await fs.writeFile(stagedAbsPath, finalContent, 'utf-8');
        results.push({
          tool: call.tool,
          path: call.path,
          success: true,
          content: finalContent,
          lineCount: finalContent.split('\n').length,
          stagedPath: stagedAbsPath,
        });
      } catch (err) {
        results.push({
          tool: call.tool,
          path: call.path,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ── Tool implementations ────────────────────────────────────────────────

  private async writeFile(absPath: string, relPath: string, content: string): Promise<FileToolResult> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    const lines = content.split('\n').length;
    return { tool: 'write_file', path: relPath, success: true, content, lineCount: lines };
  }

  private async appendFile(absPath: string, relPath: string, content: string): Promise<FileToolResult> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    let existing = '';
    try {
      existing = await fs.readFile(absPath, 'utf-8');
    } catch {
      // File doesn't exist — create it
    }

    // Ensure a newline between existing content and appended content
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const final = existing + separator + content;
    await fs.writeFile(absPath, final, 'utf-8');
    return { tool: 'append_file', path: relPath, success: true, content: final, lineCount: final.split('\n').length };
  }

  private async insertLines(absPath: string, relPath: string, afterLine: number, content: string): Promise<FileToolResult> {
    const existing = await fs.readFile(absPath, 'utf-8');
    const lines = existing.split('\n');

    // afterLine is 1-indexed; 0 means insert at top
    const insertAt = Math.min(Math.max(afterLine, 0), lines.length);
    const newLines = content.split('\n');
    lines.splice(insertAt, 0, ...newLines);

    const final = lines.join('\n');
    await fs.writeFile(absPath, final, 'utf-8');
    return { tool: 'insert_lines', path: relPath, success: true, content: final, lineCount: lines.length };
  }

  private async replaceLines(absPath: string, relPath: string, startLine: number, endLine: number, content: string): Promise<FileToolResult> {
    const existing = await fs.readFile(absPath, 'utf-8');
    const lines = existing.split('\n');

    // Convert 1-indexed to 0-indexed
    const start = Math.max(startLine - 1, 0);
    const end = Math.min(endLine - 1, lines.length - 1);
    const newLines = content.split('\n');

    lines.splice(start, end - start + 1, ...newLines);

    const final = lines.join('\n');
    await fs.writeFile(absPath, final, 'utf-8');
    return { tool: 'replace_lines', path: relPath, success: true, content: final, lineCount: lines.length };
  }

  private async deleteLines(absPath: string, relPath: string, startLine: number, endLine: number): Promise<FileToolResult> {
    const existing = await fs.readFile(absPath, 'utf-8');
    const lines = existing.split('\n');

    const start = Math.max(startLine - 1, 0);
    const end = Math.min(endLine - 1, lines.length - 1);
    lines.splice(start, end - start + 1);

    const final = lines.join('\n');
    await fs.writeFile(absPath, final, 'utf-8');
    return { tool: 'delete_lines', path: relPath, success: true, lineCount: lines.length };
  }

  private async readFile(absPath: string, relPath: string): Promise<FileToolResult> {
    const content = await fs.readFile(absPath, 'utf-8');
    // Number the lines so the engine can reference them precisely in follow-up calls
    const numbered = content
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
      .join('\n');
    return { tool: 'read_file', path: relPath, success: true, content: numbered, lineCount: content.split('\n').length };
  }

  // ── Image generation ────────────────────────────────────────────────────

  private async generateImage(path: string, prompt: string, threadId: string): Promise<FileToolResult> {
    if (!prompt?.trim()) {
      return { tool: 'generate_image', path, success: false, error: 'generate_image requires a non-empty prompt' };
    }

    // Do NOT call buildSdConfig or snapshotServerOnDevice here.
    // generateWithFlux owns the full lifecycle: preliminary config → stop server →
    // re-query VRAM with driver-settle polling → final config → spawn sd-cli → restart server.
    // Passing sdCfg=null tells it to manage everything itself.

    let lastStatus: ImageGenStatus | null = null;
    try {
      for await (const status of generateWithFlux(threadId, prompt, {}, null, null)) {
        lastStatus = status;
        if (this.onImageStatus) this.onImageStatus(status);
        if (status.phase === 'error') {
          return { tool: 'generate_image', path, success: false, error: status.error ?? status.message };
        }
      }
    } catch (err) {
      return { tool: 'generate_image', path, success: false, error: (err as Error).message };
    }

    if (lastStatus?.phase === 'done' && lastStatus.result) {
      return {
        tool: 'generate_image',
        path: lastStatus.result.outputPath,
        success: true,
        content: lastStatus.result.outputPath,
        lineCount: 0,
      };
    }

    return { tool: 'generate_image', path, success: false, error: 'Generation did not complete' };
  }

  /**
   * Optional callback — set by the route layer to stream image generation
   * status events to the frontend via SSE as they occur.
   */
  onImageStatus?: (status: ImageGenStatus) => void;

  // ── Safety ──────────────────────────────────────────────────────────────

  private resolveSafe(filePath: string): string {
    const resolved = path.resolve(this.projectRoot, filePath);
    if (!resolved.startsWith(path.resolve(this.projectRoot))) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
    return resolved;
  }
}
