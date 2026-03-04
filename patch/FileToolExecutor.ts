import fs from 'fs/promises';
import path from 'path';
import type { FileToolCall, FileToolResult } from '../ai/FileTools.js';

/**
 * Executes file tool calls against a workspace directory.
 * All paths are resolved relative to projectRoot and path-traversal-checked.
 */
export class FileToolExecutor {
  constructor(private projectRoot: string) {}

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

        default:
          return { tool: (call as FileToolCall).tool, path: call.path, success: false, error: 'Unknown tool' };
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

  // ── Safety ──────────────────────────────────────────────────────────────

  private resolveSafe(filePath: string): string {
    const resolved = path.resolve(this.projectRoot, filePath);
    if (!resolved.startsWith(path.resolve(this.projectRoot))) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
    return resolved;
  }
}
