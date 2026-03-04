import fs from 'fs/promises';
import path from 'path';

export interface RepoMap {
  summary: string;
  files: FileEntry[];
  generatedAt: string;
}

export interface FileEntry {
  path: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  size: number;
}

/**
 * Generates a compressed ~2k token map of the project repository.
 * Extracts function signatures, type definitions, import/export graphs.
 *
 * TODO: Wire up node-tree-sitter for accurate parsing:
 *   npm install node-tree-sitter tree-sitter-typescript
 *
 * Currently uses regex-based extraction as a lightweight fallback.
 * This covers ~80% of cases without the complexity of tree-sitter bindings.
 */
export class RepoMapper {
  private static SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts'];
  private static IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

  constructor(private projectRoot: string = process.cwd()) {}

  async generate(): Promise<RepoMap> {
    const files: FileEntry[] = [];

    const allFiles = await this.walkDirectory(this.projectRoot);
    for (const filePath of allFiles.slice(0, 100)) { // Cap at 100 files
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const entry = this.analyzeFile(filePath, content);
        files.push(entry);
      } catch {
        // Skip unreadable files
      }
    }

    const summary = this.buildSummary(files);
    return {
      summary,
      files,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Render the repo map as a compact string for injection into AI context */
  async render(): Promise<string> {
    const map = await this.generate();
    if (map.files.length === 0) return '';

    const lines: string[] = ['# Repository Map\n'];
    for (const file of map.files) {
      const relPath = path.relative(this.projectRoot, file.path);
      lines.push(`${relPath}`);
      if (file.exports.length > 0) {
        lines.push(`  exports: ${file.exports.slice(0, 8).join(', ')}`);
      }
      if (file.symbols.length > 0) {
        lines.push(`  symbols: ${file.symbols.slice(0, 6).join(', ')}`);
      }
    }

    const result = lines.join('\n');
    // Enforce ~2k token budget
    return result.slice(0, 8000);
  }

  private analyzeFile(filePath: string, content: string): FileEntry {
    const symbols: string[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    // Extract imports: import { X } from '...' or import X from '...'
    const importMatches = content.matchAll(/^import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/gm);
    for (const match of importMatches) {
      const named = match[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      const defaultImport = match[2] ? [match[2]] : [];
      imports.push(...named, ...defaultImport);
    }

    // Extract exports: export function/class/const/interface/type
    const exportMatches = content.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm);
    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    // Extract top-level functions and classes (not just exports)
    const symbolMatches = content.matchAll(/^(?:async\s+)?(?:function|class)\s+(\w+)/gm);
    for (const match of symbolMatches) {
      if (!symbols.includes(match[1])) symbols.push(match[1]);
    }

    return {
      path: filePath,
      symbols: [...new Set(symbols)],
      imports: [...new Set(imports)].slice(0, 20),
      exports: [...new Set(exports)],
      size: content.length,
    };
  }

  private buildSummary(files: FileEntry[]): string {
    const totalSymbols = files.reduce((acc, f) => acc + f.symbols.length, 0);
    return `${files.length} files, ${totalSymbols} symbols`;
  }

  private async walkDirectory(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (RepoMapper.IGNORE_DIRS.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this.walkDirectory(fullPath)));
        } else if (RepoMapper.SUPPORTED_EXTENSIONS.includes(path.extname(entry.name))) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
    return results;
  }
}
