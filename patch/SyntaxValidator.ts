import path from 'path';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  line?: number;
  column?: number;
}

/**
 * Validates syntax of patched files using tree-sitter.
 *
 * TODO: Install full tree-sitter bindings:
 *   npm install tree-sitter tree-sitter-typescript tree-sitter-javascript
 *
 * Currently provides:
 * - Basic structural checks (bracket balancing) as a fallback
 * - Extension-based routing for future tree-sitter integration
 */
export class SyntaxValidator {
  private treeSitterAvailable = false;

  constructor() {
    // Try to dynamically load tree-sitter
    this.checkTreeSitter();
  }

  private async checkTreeSitter(): Promise<void> {
    try {
      await import('tree-sitter');
      this.treeSitterAvailable = true;
      console.log('[SyntaxValidator] tree-sitter available');
    } catch {
      console.log('[SyntaxValidator] tree-sitter not installed, using fallback validator');
    }
  }

  async validate(filePath: string, content: string): Promise<ValidationResult> {
    const ext = path.extname(filePath).toLowerCase();

    if (this.treeSitterAvailable) {
      return this.validateWithTreeSitter(filePath, content, ext);
    }

    return this.validateFallback(content, ext);
  }

  private async validateWithTreeSitter(
    _filePath: string,
    content: string,
    ext: string
  ): Promise<ValidationResult> {
    // TODO: Wire up tree-sitter parsers per language
    // const Parser = (await import('tree-sitter')).default;
    // const TypeScript = (await import('tree-sitter-typescript')).typescript;
    // const parser = new Parser();
    // parser.setLanguage(TypeScript);
    // const tree = parser.parse(content);
    // if (tree.rootNode.hasError()) { ... }
    console.log('[SyntaxValidator] tree-sitter validation stub for', ext);
    return this.validateFallback(content, ext);
  }

  /** Basic structural validation as fallback */
  private validateFallback(content: string, ext: string): ValidationResult {
    const tsExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];
    if (!tsExtensions.includes(ext)) {
      return { valid: true }; // No validation for non-JS/TS files
    }

    // Balance check for braces, brackets, parens
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const closes = new Set(Object.values(pairs));
    const stack: string[] = [];
    let inString = false;
    let stringChar = '';
    let inLineComment = false;
    let inBlockComment = false;
    let lineNum = 1;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const next = content[i + 1];

      if (ch === '\n') {
        lineNum++;
        inLineComment = false;
        continue;
      }
      if (inLineComment) continue;
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }

      if (ch === '/' && next === '/') { inLineComment = true; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (pairs[ch]) {
        stack.push(pairs[ch]);
      } else if (closes.has(ch)) {
        if (stack.length === 0 || stack[stack.length - 1] !== ch) {
          return {
            valid: false,
            error: `Unexpected '${ch}'`,
            line: lineNum,
          };
        }
        stack.pop();
      }
    }

    if (stack.length > 0) {
      return {
        valid: false,
        error: `Unclosed bracket: expected '${stack[stack.length - 1]}'`,
        line: lineNum,
      };
    }

    return { valid: true };
  }
}
