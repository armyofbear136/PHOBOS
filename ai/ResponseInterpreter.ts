export interface ParsedPatch {
  filePath: string;
  searchContent: string;
  replaceContent: string;
  isNewFile: boolean;
}

export interface InterpretedResponse {
  patches: ParsedPatch[];
  explanation: string;
  rawOutput: string;
  hasQuestion: boolean;
  questionText?: string;
}

/**
 * Parses DeepSeek output to extract SEARCH/REPLACE blocks.
 *
 * Format:
 * <<<< SEARCH path/to/file.ts
 * exact lines to find
 * ====
 * replacement content
 * >>>> REPLACE
 *
 * New file (empty SEARCH):
 * <<<< SEARCH path/to/newfile.ts
 * ====
 * full file contents
 * >>>> REPLACE
 */
export class ResponseInterpreter {
  private static SEARCH_START = /^<<<< SEARCH (.+)$/m;
  private static SEARCH_DIVIDER = '====';
  private static REPLACE_END = '>>>> REPLACE';

  interpret(output: string): InterpretedResponse {
    const patches: ParsedPatch[] = [];
    let remainingText = output;
    const explanationParts: string[] = [];

    let searchIdx: number;
    while ((searchIdx = remainingText.indexOf('<<<< SEARCH')) !== -1) {
      // Grab any explanation text before this block
      const before = remainingText.slice(0, searchIdx).trim();
      if (before) explanationParts.push(before);

      const blockStart = searchIdx;
      const blockEnd = remainingText.indexOf(ResponseInterpreter.REPLACE_END, blockStart);

      if (blockEnd === -1) break; // Incomplete block

      const block = remainingText.slice(
        blockStart,
        blockEnd + ResponseInterpreter.REPLACE_END.length
      );
      remainingText = remainingText.slice(blockEnd + ResponseInterpreter.REPLACE_END.length);

      const parsed = this.parseBlock(block);
      if (parsed) patches.push(parsed);
    }

    // Anything remaining is explanation
    const trailing = remainingText.trim();
    if (trailing) explanationParts.push(trailing);

    return {
      patches,
      explanation: explanationParts.join('\n\n').trim(),
      rawOutput: output,
      hasQuestion: false,
    };
  }

  private parseBlock(block: string): ParsedPatch | null {
    try {
      const firstLine = block.split('\n')[0];
      const pathMatch = firstLine.match(/<<<< SEARCH (.+)/);
      if (!pathMatch) return null;

      const filePath = pathMatch[1].trim();
      const afterHeader = block.indexOf('\n') + 1; // content after the first line

      // Primary: look for divider with surrounding newlines (\n====\n)
      const dividerIdx = block.indexOf('\n====\n');
      if (dividerIdx !== -1) {
        // searchContent: everything between header line and divider
        // Strip exactly one leading newline (the one after the header) and one trailing newline
        // (the one before ====) to get clean content for exact matching
        const rawSearch = block.slice(afterHeader, dividerIdx);
        const searchContent = rawSearch.replace(/^\n/, '').replace(/\n$/, '');

        const replaceEndIdx = block.lastIndexOf(ResponseInterpreter.REPLACE_END);
        // replaceContent: everything after \n====\n and before >>>> REPLACE
        // Strip exactly one leading newline
        const rawReplace = block.slice(dividerIdx + '\n====\n'.length, replaceEndIdx);
        const replaceContent = rawReplace.replace(/\n$/, '');

        return {
          filePath,
          searchContent,
          replaceContent,
          isNewFile: searchContent === '',
        };
      }

      // Fallback: ==== without surrounding newlines
      const divIdx = block.indexOf('====');
      if (divIdx === -1) return null;

      const searchContent = block.slice(afterHeader, divIdx).replace(/^\n/, '').replace(/\n$/, '');
      const replaceEnd = block.indexOf(ResponseInterpreter.REPLACE_END, divIdx);
      const replaceContent = block
        .slice(divIdx + '===='.length, replaceEnd)
        .replace(/^\n/, '')
        .replace(/\n$/, '');

      return {
        filePath,
        searchContent,
        replaceContent,
        isNewFile: searchContent === '',
      };
    } catch (err) {
      console.error('[ResponseInterpreter] Block parse error:', err);
      return null;
    }
  }

  /** Check if the output is a format violation (full file rewrite attempt) */
  isFormatViolation(output: string): boolean {
    const hasPatches = output.includes('<<<< SEARCH');
    const isLong = output.length > 2000;
    // Match any fenced code block: ```typescript, ```js, ```ts, ```python, ``` etc.
    const hasCodeBlock = /```[\w]*\n/.test(output);
    // Violation: long code output without any SEARCH/REPLACE blocks
    return !hasPatches && isLong && hasCodeBlock;
  }
}
