import fs from 'fs/promises';
import path from 'path';
import type { ParsedPatch } from '../ai/ResponseInterpreter.js';

export interface PatchResult {
  success: boolean;
  filePath: string;
  originalContent?: string;
  patchedContent?: string;
  error?: PatchError;
}

export type PatchError =
  | { type: 'MATCH_NOT_FOUND'; searchContent: string }
  | { type: 'AMBIGUOUS_MATCH'; matchCount: number }
  | { type: 'FILE_READ_ERROR'; message: string }
  | { type: 'FILE_WRITE_ERROR'; message: string };

export class PatchApplicator {
  constructor(private projectRoot: string = process.cwd()) {}

  async apply(patch: ParsedPatch): Promise<PatchResult> {
    const absolutePath = path.isAbsolute(patch.filePath)
      ? patch.filePath
      : path.join(this.projectRoot, patch.filePath);

    // New file creation
    if (patch.isNewFile) {
      return this.createFile(absolutePath, patch.filePath, patch.replaceContent);
    }

    // Read existing file
    let originalContent: string;
    try {
      originalContent = await fs.readFile(absolutePath, 'utf-8');
    } catch (err: unknown) {
      return {
        success: false,
        filePath: patch.filePath,
        error: {
          type: 'FILE_READ_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (originalContent.trim() === '' && patch.searchContent === '') {
      try {
        await fs.writeFile(absolutePath, patch.replaceContent, 'utf-8');
        return { success: true, filePath: patch.filePath, originalContent, patchedContent: patch.replaceContent };
      } catch (err: unknown) {
        return { success: false, filePath: patch.filePath, error: { type: 'FILE_WRITE_ERROR', message: err instanceof Error ? err.message : String(err) } };
      }
    }

    // Try to find the search content using progressively looser matching.
    // Returns the matched region's start/end line indices, or null if not found.
    const match = this.findMatch(originalContent, patch.searchContent);

    if (!match) {
      return {
        success: false,
        filePath: patch.filePath,
        originalContent,
        error: { type: 'MATCH_NOT_FOUND', searchContent: patch.searchContent },
      };
    }

    if (match.count > 1) {
      return {
        success: false,
        filePath: patch.filePath,
        originalContent,
        error: { type: 'AMBIGUOUS_MATCH', matchCount: match.count },
      };
    }

    // Apply replacement using line-based splice so we preserve the original
    // file's line endings and indentation style outside the changed region.
    const originalLines = originalContent.split('\n');
    const replaceLines = patch.replaceContent.replace(/\r\n/g, '\n').split('\n');

    // If the file uses tabs but the engine output spaces (or vice versa),
    // re-indent the replacement to match the file's indentation style.
    const reindentedReplace = this.matchIndentStyle(
      originalLines.slice(match.startLine, match.endLine + 1),
      replaceLines
    );

    const patchedLines = [
      ...originalLines.slice(0, match.startLine),
      ...reindentedReplace,
      ...originalLines.slice(match.endLine + 1),
    ];

    const patchedContent = patchedLines.join('\n');

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, patchedContent, 'utf-8');
    } catch (err: unknown) {
      return {
        success: false,
        filePath: patch.filePath,
        error: {
          type: 'FILE_WRITE_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    return {
      success: true,
      filePath: patch.filePath,
      originalContent,
      patchedContent,
    };
  }

  async applyAll(
    patches: ParsedPatch[]
  ): Promise<{ results: PatchResult[]; allSucceeded: boolean }> {
    const results: PatchResult[] = [];
    for (const patch of patches) {
      const result = await this.apply(patch);
      results.push(result);
      if (!result.success) break;
    }
    return {
      results,
      allSucceeded: results.every((r) => r.success),
    };
  }

  private async createFile(
    absolutePath: string,
    filePath: string,
    content: string
  ): Promise<PatchResult> {
    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf-8');
      return { success: true, filePath, patchedContent: content };
    } catch (err: unknown) {
      return {
        success: false,
        filePath,
        error: {
          type: 'FILE_WRITE_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Find where searchContent appears in fileContent using three passes:
   *
   *   Pass 1 — exact match (trimEnd per line, preserve indent type)
   *   Pass 2 — indent-type-normalized (tabs→spaces or spaces→tabs)
   *   Pass 3 — indent-depth-agnostic (strip all leading whitespace for comparison)
   *
   * Returns { startLine, endLine, count } or null if not found at all.
   * count > 1 means ambiguous.
   */
  private findMatch(
    fileContent: string,
    searchContent: string
  ): { startLine: number; endLine: number; count: number } | null {
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
    const searchLines = searchContent.replace(/\r\n/g, '\n').split('\n');

    // Pass 1: trim trailing whitespace only
    const pass1 = this.findLineMatch(
      fileLines.map(l => l.trimEnd()),
      searchLines.map(l => l.trimEnd())
    );
    if (pass1.count === 1) return { ...pass1.matches[0], count: 1 };
    if (pass1.count > 1) return { ...pass1.matches[0], count: pass1.count };

    // Pass 2: normalize indent characters (tabs↔spaces)
    const normalizeIndent = (lines: string[]) =>
      lines.map(l => l.replace(/^\t+/, m => '  '.repeat(m.length)).trimEnd());

    const pass2 = this.findLineMatch(
      normalizeIndent(fileLines),
      normalizeIndent(searchLines)
    );
    if (pass2.count === 1) return { ...pass2.matches[0], count: 1 };
    if (pass2.count > 1) return { ...pass2.matches[0], count: pass2.count };

    // Pass 3: strip ALL leading whitespace (last resort — ignores indent depth)
    const stripIndent = (lines: string[]) =>
      lines.map(l => l.trimStart().trimEnd());

    const pass3 = this.findLineMatch(
      stripIndent(fileLines),
      stripIndent(searchLines)
    );
    if (pass3.count >= 1) return { ...pass3.matches[0], count: pass3.count };

    return null;
  }

  private findLineMatch(
    fileLines: string[],
    searchLines: string[]
  ): { matches: Array<{ startLine: number; endLine: number }>; count: number } {
    const matches: Array<{ startLine: number; endLine: number }> = [];

    // Skip leading/trailing blank lines in search pattern for robustness
    const firstNonBlank = searchLines.findIndex(l => l.trim() !== '');
    const lastNonBlank = [...searchLines].reverse().findIndex(l => l.trim() !== '');
    const trimmedSearch = firstNonBlank === -1
      ? searchLines
      : searchLines.slice(firstNonBlank, searchLines.length - lastNonBlank);

    outer: for (let i = 0; i <= fileLines.length - trimmedSearch.length; i++) {
      for (let j = 0; j < trimmedSearch.length; j++) {
        if (fileLines[i + j] !== trimmedSearch[j]) continue outer;
      }
      // Found a match — account for the trimmed leading blank lines offset
      matches.push({
        startLine: i - firstNonBlank < 0 ? i : i - firstNonBlank,
        endLine: i + trimmedSearch.length - 1 + (lastNonBlank > 0 ? lastNonBlank : 0),
      });
    }

    return { matches, count: matches.length };
  }

  /**
   * If the original region uses tabs and the replacement uses spaces (or vice versa),
   * re-indent the replacement lines to match the original's style.
   *
   * This handles the common case where the AI outputs spaces for a tab-indented
   * file (e.g. GDScript, Makefile, Go).
   */
  private matchIndentStyle(originalLines: string[], replaceLines: string[]): string[] {
    if (originalLines.length === 0 || replaceLines.length === 0) return replaceLines;

    // Detect indent character from the original region
    const originalUseTabs = originalLines.some(l => l.startsWith('\t'));
    const replaceUseSpaces = replaceLines.some(l => /^ +/.test(l));

    if (originalUseTabs && replaceUseSpaces) {
      // Convert leading spaces in replace to tabs
      // Detect the space width (2 or 4 spaces per indent level)
      const spaceMatch = replaceLines
        .filter(l => /^ +/.test(l))
        .map(l => l.match(/^ +/)?.[0].length ?? 0);
      const minIndent = spaceMatch.filter(n => n > 0).reduce((a, b) => Math.min(a, b), 8);
      const spaceWidth = minIndent >= 4 ? 4 : 2;

      return replaceLines.map(line => {
        const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
        const tabCount = Math.round(leadingSpaces / spaceWidth);
        return '\t'.repeat(tabCount) + line.slice(leadingSpaces);
      });
    }

    return replaceLines;
  }

  // kept for any internal callers that might reference it
  private normalizeWhitespace(str: string): string {
    return str.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n');
  }
}
