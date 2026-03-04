import { spawn } from 'child_process';
import path from 'path';

export interface BuildError {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  type: 'error' | 'warning';
}

export interface BuildResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  errors: BuildError[];
  durationMs: number;
  timedOut: boolean;
}

export class BuildRunner {
  constructor(
    private projectRoot: string = process.cwd(),
    private defaultTimeoutMs = 60_000
  ) {}

  async run(
    command: string,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<BuildResult> {
    const start = Date.now();
    const [cmd, ...args] = this.parseCommand(command);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(cmd, args, {
        cwd: this.projectRoot,
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0' }, // Disable color codes
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const combinedOutput = stdout + stderr;
        const errors = this.parseErrors(combinedOutput);

        resolve({
          success: exitCode === 0 && !timedOut,
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          errors,
          durationMs,
          timedOut,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr: stderr + '\n' + err.message,
          errors: [{ file: '', line: null, column: null, message: err.message, type: 'error' }],
          durationMs: Date.now() - start,
          timedOut: false,
        });
      });
    });
  }

  private parseCommand(command: string): string[] {
    // Handle quoted arguments
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const ch of command) {
      if (inQuote) {
        if (ch === quoteChar) { inQuote = false; }
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ' && current) {
        parts.push(current);
        current = '';
      } else if (ch !== ' ') {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private parseErrors(output: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = this.stripAnsi(output).split('\n');

    for (const line of lines) {
      // TypeScript: src/foo.ts(10,5): error TS2345: ...
      const tsMatch = line.match(/^(.+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
      if (tsMatch) {
        errors.push({
          file: path.normalize(tsMatch[1]),
          line: parseInt(tsMatch[2], 10),
          column: parseInt(tsMatch[3], 10),
          type: tsMatch[4] as 'error' | 'warning',
          message: tsMatch[5],
        });
        continue;
      }

      // ESLint: /path/to/file.ts
      //   10:5  error  ...
      const eslintMatch = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
      if (eslintMatch) {
        errors.push({
          file: '',  // ESLint file parsed from previous line
          line: parseInt(eslintMatch[1], 10),
          column: parseInt(eslintMatch[2], 10),
          type: eslintMatch[3] as 'error' | 'warning',
          message: eslintMatch[4],
        });
        continue;
      }

      // Generic: error: ...
      if (/^\s*error:/i.test(line)) {
        errors.push({
          file: '',
          line: null,
          column: null,
          type: 'error',
          message: line.replace(/^\s*error:\s*/i, '').trim(),
        });
      }
    }

    return errors;
  }

  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
  }
}
