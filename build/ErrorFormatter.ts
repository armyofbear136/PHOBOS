import type { BuildError, BuildResult } from './BuildRunner.js';
import type { PatchResult } from '../patch/PatchApplicator.ts';
import type { ValidationResult } from '../patch/SyntaxValidator.ts';

/**
 * Converts raw build/patch/syntax errors into clean, minimal context
 * suitable for DeepSeek retry dispatches.
 *
 * Strips: ANSI codes, timestamps, duplicate messages, irrelevant stack frames.
 * Returns: minimum necessary context to explain the failure.
 */
export class ErrorFormatter {
  formatBuildErrors(result: BuildResult): string {
    if (result.timedOut) {
      return `BUILD TIMEOUT: Build command exceeded ${Math.round(60000 / 1000)}s limit. Ensure the build command completes quickly.`;
    }

    if (result.errors.length === 0) {
      // No structured errors, but build failed — use raw output
      const combined = (result.stdout + result.stderr).trim();
      return `BUILD FAILED (exit ${result.exitCode}):\n${this.truncate(combined, 2000)}`;
    }

    const lines: string[] = [`BUILD FAILED — ${result.errors.length} error(s):\n`];
    const seen = new Set<string>();

    for (const error of result.errors) {
      const key = `${error.file}:${error.line}:${error.message}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const location = [
        error.file,
        error.line ? `line ${error.line}` : null,
        error.column ? `col ${error.column}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      lines.push(`[${error.type.toUpperCase()}] ${location ? `${location}: ` : ''}${error.message}`);
    }

    return lines.join('\n');
  }

  formatPatchErrors(results: PatchResult[]): string {
    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) return '';

    const lines = [`PATCH FAILED — ${failed.length} patch(es) could not be applied:\n`];

    for (const result of failed) {
      if (!result.error) continue;
      switch (result.error.type) {
        case 'MATCH_NOT_FOUND':
          lines.push(
            `File: ${result.filePath}\n` +
            `Error: SEARCH block content not found in file.\n` +
            `The following text was not found:\n---\n${this.truncate(result.error.searchContent, 300)}\n---\n` +
            `Check for exact whitespace, indentation, and content match.`
          );
          break;
        case 'AMBIGUOUS_MATCH':
          lines.push(
            `File: ${result.filePath}\n` +
            `Error: SEARCH block matched ${result.error.matchCount} locations. ` +
            `Make the SEARCH block more specific by including more surrounding context.`
          );
          break;
        case 'FILE_READ_ERROR':
          lines.push(
            `File: ${result.filePath}\n` +
            `Error: Could not read file — ${result.error.message}\n` +
            `If this is a new file, use an empty SEARCH block.`
          );
          break;
        case 'FILE_WRITE_ERROR':
          lines.push(
            `File: ${result.filePath}\n` +
            `Error: Could not write file — ${result.error.message}`
          );
          break;
      }
    }

    return lines.join('\n\n');
  }

  formatSyntaxError(validation: ValidationResult, filePath: string): string {
    if (validation.valid) return '';
    return (
      `SYNTAX ERROR in ${filePath}:\n` +
      `${validation.error}` +
      (validation.line ? ` at line ${validation.line}` : '') +
      (validation.column ? `, column ${validation.column}` : '') +
      '\n\nFix the syntax error before the file can be used.'
    );
  }

  formatForRetry(opts: {
    buildResult?: BuildResult;
    patchResults?: PatchResult[];
    syntaxValidation?: { result: ValidationResult; filePath: string };
    attemptNumber: number;
  }): string {
    const parts: string[] = [];

    if (opts.syntaxValidation && !opts.syntaxValidation.result.valid) {
      parts.push(this.formatSyntaxError(
        opts.syntaxValidation.result,
        opts.syntaxValidation.filePath
      ));
    }

    if (opts.patchResults) {
      const patchErr = this.formatPatchErrors(opts.patchResults);
      if (patchErr) parts.push(patchErr);
    }

    if (opts.buildResult && !opts.buildResult.success) {
      parts.push(this.formatBuildErrors(opts.buildResult));
    }

    if (parts.length === 0) return '';

    return (
      `=== ATTEMPT ${opts.attemptNumber} FAILED ===\n\n` +
      parts.join('\n\n---\n\n') +
      '\n\n=== Please fix the above errors. Output corrected SEARCH/REPLACE blocks only. ==='
    );
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `\n... (${str.length - maxLen} chars truncated)`;
  }
}
