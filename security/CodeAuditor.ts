/**
 * CodeAuditor.ts — AST-based static security analyzer using tree-sitter.
 *
 * Languages: TypeScript, JavaScript (tree-sitter-javascript + tree-sitter-typescript).
 * Walks .ts/.tsx/.js/.jsx files recursively. Skips node_modules, dist, .git.
 * Files over 1MB skipped with an info finding.
 *
 * Each rule receives AST nodes during a depth-first walk and returns a match or null.
 * Rules are independently testable. The ruleset is extensible without touching the walker.
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { SecurityStore, type SecurityFinding, type Severity } from '../db/SecurityStore.js';
import { engineStream } from '../ai/clients.js';

// ── Tree-sitter types (minimal surface needed) ────────────────────────────────

interface SyntaxNode {
  type:          string;
  text:          string;
  startPosition: { row: number; column: number };
  endPosition:   { row: number; column: number };
  children:      SyntaxNode[];
  parent:        SyntaxNode | null;
  childCount:    number;
  namedChildren: SyntaxNode[];
  firstChild:    SyntaxNode | null;
  lastChild:     SyntaxNode | null;
  nextSibling:   SyntaxNode | null;
  hasError():    boolean;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
}

interface Tree {
  rootNode: SyntaxNode;
}

interface Parser {
  setLanguage(language: unknown): void;
  parse(source: string): Tree;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FILE_SIZE_LIMIT   = 1024 * 1024;  // 1 MB
const DIGEST_TIMEOUT_MS = 60_000;
const RAW_OUTPUT_CAP    = 64 * 1024;
const DIGEST_INPUT_CAP  = 4_000;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'coverage']);
const JS_EXTS   = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

// ── Rule interface ────────────────────────────────────────────────────────────

interface CodeAuditMatch {
  title:  string;
  detail: string;
  row:    number;
  col:    number;
}

interface CodeAuditRule {
  id:          string;
  severity:    Severity;
  check: (node: SyntaxNode, source: string) => CodeAuditMatch | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLiteralNode(node: SyntaxNode): boolean {
  return node.type === 'string'
      || node.type === 'number'
      || node.type === 'template_string'
      || node.type === 'true'
      || node.type === 'false'
      || node.type === 'null'
      || node.type === 'undefined';
}

function isStringConcatNode(node: SyntaxNode): boolean {
  if (node.type !== 'binary_expression') return false;
  // operator is the second child in tree-sitter JS grammar
  const op = node.child(1);
  return op?.text === '+';
}

function containsNonLiteralArg(argsNode: SyntaxNode | null): boolean {
  if (!argsNode) return false;
  return argsNode.namedChildren.some(child => !isLiteralNode(child));
}

function nodeText(node: SyntaxNode): string {
  return node.text.trim();
}

function calleeName(callNode: SyntaxNode): string {
  const fn = callNode.childForFieldName('function');
  return fn ? nodeText(fn) : '';
}

function callArgs(callNode: SyntaxNode): SyntaxNode | null {
  return callNode.childForFieldName('arguments');
}

const SQL_KEYWORDS = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|UNION|FROM|WHERE)\b/i;

const SECRET_NAMES = /^(password|passwd|secret|api_?key|apikey|token|auth_?token|private_?key|access_?key|client_?secret)$/i;

// ── Ruleset ───────────────────────────────────────────────────────────────────

const RULES: CodeAuditRule[] = [

  // js/eval-call — eval(...) with non-literal argument
  {
    id:       'js/eval-call',
    severity: 'high',
    check(node) {
      if (node.type !== 'call_expression') return null;
      if (calleeName(node) !== 'eval')     return null;
      if (!containsNonLiteralArg(callArgs(node))) return null;
      return {
        title:  'Dynamic eval() call',
        detail: 'eval() with a non-literal argument executes arbitrary code. Use JSON.parse() or a safe alternative.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/function-constructor — new Function(...) with non-literal argument
  {
    id:       'js/function-constructor',
    severity: 'high',
    check(node) {
      if (node.type !== 'new_expression') return null;
      const ctor = node.childForFieldName('constructor');
      if (!ctor || nodeText(ctor) !== 'Function') return null;
      const args = node.childForFieldName('arguments');
      if (!containsNonLiteralArg(args)) return null;
      return {
        title:  'Dynamic Function() constructor',
        detail: 'new Function() with non-literal arguments executes arbitrary code.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/exec-concat — exec/execSync/spawn with string concatenation in args
  {
    id:       'js/exec-concat',
    severity: 'high',
    check(node) {
      if (node.type !== 'call_expression') return null;
      const name = calleeName(node);
      if (!['exec', 'execSync', 'spawnSync', 'execFileSync'].includes(name)) return null;
      const args = callArgs(node);
      if (!args) return null;
      const firstArg = args.namedChildren[0];
      if (!firstArg) return null;
      if (!isStringConcatNode(firstArg) && firstArg.type !== 'identifier') return null;
      // Only flag if it contains concatenation or a bare identifier (not a literal)
      if (isLiteralNode(firstArg)) return null;
      return {
        title:  `Command injection risk: ${name}() with dynamic argument`,
        detail: `${name}() called with a non-literal first argument. String concatenation in shell commands enables injection.`,
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/child-process-shell — exec/execSync with shell: true option
  {
    id:       'js/child-process-shell',
    severity: 'medium',
    check(node) {
      if (node.type !== 'call_expression') return null;
      const name = calleeName(node);
      if (!['exec', 'execSync', 'spawn', 'spawnSync'].includes(name)) return null;
      const args = callArgs(node);
      if (!args) return null;
      // Look for options object with shell: true
      for (const arg of args.namedChildren) {
        if (arg.type !== 'object') continue;
        for (const prop of arg.namedChildren) {
          if (prop.type !== 'pair') continue;
          const key = prop.childForFieldName('key');
          const val = prop.childForFieldName('value');
          if (key?.text === 'shell' && val?.text === 'true') {
            return {
              title:  `shell: true in ${name}() options`,
              detail: 'Enabling shell expansion allows injection if any argument contains user input. Use execFile() with explicit args arrays.',
              row:    node.startPosition.row,
              col:    node.startPosition.column,
            };
          }
        }
      }
      return null;
    },
  },

  // js/innerHTML-assign — assignment to innerHTML/outerHTML with non-literal
  {
    id:       'js/innerHTML-assign',
    severity: 'medium',
    check(node) {
      if (node.type !== 'assignment_expression') return null;
      const left  = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (!left || !right) return null;
      if (!['innerHTML', 'outerHTML'].some(p => nodeText(left).endsWith(p))) return null;
      if (isLiteralNode(right)) return null;
      return {
        title:  `Assignment to ${left.text.split('.').pop()} with dynamic value`,
        detail: 'Direct innerHTML/outerHTML assignment with non-literal content enables XSS. Use textContent or a sanitizer.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/dangerous-react — dangerouslySetInnerHTML usage
  {
    id:       'js/dangerous-react',
    severity: 'medium',
    check(node) {
      if (node.type !== 'jsx_attribute') return null;
      const name = node.childForFieldName('name');
      if (name?.text !== 'dangerouslySetInnerHTML') return null;
      return {
        title:  'dangerouslySetInnerHTML usage',
        detail: 'dangerouslySetInnerHTML bypasses React XSS protections. Ensure content is sanitized with DOMPurify or equivalent.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/sql-concat — string concatenation involving SQL keywords
  {
    id:       'js/sql-concat',
    severity: 'high',
    check(node, source) {
      if (node.type !== 'binary_expression') return null;
      const op = node.child(1);
      if (op?.text !== '+') return null;
      // At least one side must contain a SQL keyword
      const left  = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (!left || !right) return null;
      const combined = nodeText(node);
      if (!SQL_KEYWORDS.test(combined)) return null;
      // Must involve at least one non-literal (otherwise it's a static string)
      if (isLiteralNode(left) && isLiteralNode(right)) return null;
      return {
        title:  'SQL query built with string concatenation',
        detail: 'String concatenation in SQL queries enables injection. Use parameterized queries or a query builder.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/hardcoded-secret — variable named password/secret/token assigned a string literal
  {
    id:       'js/hardcoded-secret',
    severity: 'high',
    check(node) {
      // Covers: const password = "...", let apiKey = '...', password: "..."
      let name:  string | null = null;
      let value: SyntaxNode | null = null;

      if (node.type === 'variable_declarator') {
        const id = node.childForFieldName('name');
        name     = id?.text ?? null;
        value    = node.childForFieldName('value');
      } else if (node.type === 'pair') {
        // Object literal key: "password": "..."
        const key = node.childForFieldName('key');
        name      = key?.text?.replace(/['"]/g, '') ?? null;
        value     = node.childForFieldName('value');
      } else if (node.type === 'assignment_expression') {
        const left = node.childForFieldName('left');
        name       = left?.text.split('.').pop() ?? null;
        value      = node.childForFieldName('right');
      }

      if (!name || !value) return null;
      if (!SECRET_NAMES.test(name)) return null;
      if (value.type !== 'string' && value.type !== 'template_string') return null;
      // Skip empty strings and placeholders
      const raw = nodeText(value);
      if (raw.length < 4 || /^['"]{2}$/.test(raw) || /placeholder|example|changeme|xxx/i.test(raw)) return null;

      return {
        title:  `Hardcoded secret: ${name}`,
        detail: `Variable "${name}" is assigned a string literal. Store secrets in environment variables, never in source code.`,
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/prototype-pollution — assignment to __proto__ or constructor.prototype
  {
    id:       'js/prototype-pollution',
    severity: 'medium',
    check(node) {
      if (node.type !== 'assignment_expression') return null;
      const left = node.childForFieldName('left');
      if (!left) return null;
      const text = nodeText(left);
      if (text.includes('__proto__') || text.includes('constructor.prototype')) {
        return {
          title:  `Prototype pollution: assignment to ${text}`,
          detail: 'Writing to __proto__ or constructor.prototype can corrupt the global Object prototype.',
          row:    node.startPosition.row,
          col:    node.startPosition.column,
        };
      }
      return null;
    },
  },

  // js/path-traversal — readFile/path.join with identifier from parameter
  {
    id:       'js/path-traversal',
    severity: 'medium',
    check(node) {
      if (node.type !== 'call_expression') return null;
      const name = calleeName(node);
      if (!['readFile', 'readFileSync', 'writeFile', 'writeFileSync',
            'createReadStream', 'createWriteStream', 'join', 'resolve'].includes(
              name.split('.').pop() ?? ''
            )) return null;
      const args = callArgs(node);
      if (!args) return null;
      const firstArg = args.namedChildren[0];
      if (!firstArg) return null;
      // Only flag if first arg is an identifier (likely user-controlled) or member expression
      if (firstArg.type !== 'identifier' && firstArg.type !== 'member_expression') return null;
      return {
        title:  `Path traversal risk: ${name}() with variable argument`,
        detail: `${name}() called with an identifier as the first argument. Validate and sanitize file paths against a known root before use.`,
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/require-injection — require(variable) where argument is not a literal
  {
    id:       'js/require-injection',
    severity: 'high',
    check(node) {
      if (node.type !== 'call_expression') return null;
      if (calleeName(node) !== 'require') return null;
      const args = callArgs(node);
      if (!args) return null;
      const firstArg = args.namedChildren[0];
      if (!firstArg || isLiteralNode(firstArg)) return null;
      return {
        title:  'Dynamic require() call',
        detail: 'require() with a non-literal argument may load arbitrary modules. Use static import paths.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

  // js/open-redirect — res.redirect(variable) without apparent validation
  {
    id:       'js/open-redirect',
    severity: 'medium',
    check(node) {
      if (node.type !== 'call_expression') return null;
      const name = calleeName(node);
      if (!name.endsWith('.redirect')) return null;
      const args = callArgs(node);
      if (!args) return null;
      const firstArg = args.namedChildren[0];
      if (!firstArg || isLiteralNode(firstArg)) return null;
      return {
        title:  'Open redirect risk: redirect() with dynamic URL',
        detail: 'redirect() called with a non-literal URL. Validate the target URL against an allowlist to prevent open redirect attacks.',
        row:    node.startPosition.row,
        col:    node.startPosition.column,
      };
    },
  },

];

// ── AST walker ────────────────────────────────────────────────────────────────

function walkNode(
  node:     SyntaxNode,
  source:   string,
  filepath: string,
  runId:    string,
  priorKeys: Set<string>,
  findings: Omit<SecurityFinding, 'id' | 'created_at'>[],
): void {
  for (const rule of RULES) {
    const match = rule.check(node, source);
    if (match) {
      const target = `${filepath}:${match.row + 1}:${match.col + 1}`;
      findings.push({
        run_id:    runId,
        scan_type: 'code_audit',
        severity:  rule.severity,
        title:     `[${rule.id}] ${match.title}`,
        detail:    match.detail,
        target,
        cve_id:    null,
        is_new:    !priorKeys.has(`[${rule.id}] ${match.title}||${target}`),
      });
    }
  }

  for (const child of node.children) {
    walkNode(child, source, filepath, runId, priorKeys, findings);
  }
}

// ── File discovery ────────────────────────────────────────────────────────────

function collectFiles(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (entry.isFile() && JS_EXTS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

// ── Parser loader ─────────────────────────────────────────────────────────────

let _parserJs:  Parser | null = null;
let _parserTs:  Parser | null = null;
let _parserTsx: Parser | null = null;
let _loadError: string | null = null;

async function loadParsers(): Promise<{
  js: Parser | null;
  ts: Parser | null;
  tsx: Parser | null;
  error: string | null;
}> {
  if (_loadError !== null) return { js: null, ts: null, tsx: null, error: _loadError };
  if (_parserJs)           return { js: _parserJs, ts: _parserTs, tsx: _parserTsx, error: null };

  try {
    const TreeSitter = (await import('tree-sitter')).default as unknown as new () => Parser;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const JavaScript = ((await import('tree-sitter-javascript' as string)) as any).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tsGrammars = ((await import('tree-sitter-typescript' as string)) as any).default as {
      typescript: unknown;
      tsx:        unknown;
    };
    const { typescript, tsx } = tsGrammars;

    const parserJs  = new TreeSitter();
    parserJs.setLanguage(JavaScript);

    const parserTs  = new TreeSitter();
    parserTs.setLanguage(typescript);

    const parserTsx = new TreeSitter();
    parserTsx.setLanguage(tsx);

    _parserJs  = parserJs;
    _parserTs  = parserTs;
    _parserTsx = parserTsx;

    return { js: parserJs, ts: parserTs, tsx: parserTsx, error: null };
  } catch (err) {
    _loadError = `tree-sitter grammar load failed: ${(err as Error).message}`;
    return { js: null, ts: null, tsx: null, error: _loadError };
  }
}

function selectParser(
  ext:     string,
  parsers: { js: Parser | null; ts: Parser | null; tsx: Parser | null },
): Parser | null {
  switch (ext) {
    case '.ts':  case '.mts': case '.cts': return parsers.ts;
    case '.tsx':                           return parsers.tsx;
    case '.js':  case '.jsx':
    case '.mjs': case '.cjs':             return parsers.js;
    default:                              return null;
  }
}

// ── Digest ────────────────────────────────────────────────────────────────────

async function buildDigest(
  targetPath:   string,
  findingCount: number,
  newCount:     number,
  rawOutput:    string,
): Promise<string> {
  const preview = rawOutput.slice(0, DIGEST_INPUT_CAP);
  const prompt  = [
    `You are reviewing a PHOBOS code security audit of: ${targetPath}`,
    'Summarize the findings in 3-5 sentences.',
    'Focus on: the most critical issues, patterns across findings, and recommended fixes.',
    'Be concise. Do not repeat every finding verbatim.',
    '',
    `New findings:   ${newCount}`,
    `Total findings: ${findingCount}`,
    '',
    'Top findings:',
    preview,
  ].join('\n');

  try {
    return await Promise.race([
      engineStream({
        systemPrompt: 'You are a concise security analyst. Respond in plain text, no markdown.',
        messages:     [{ role: 'user', content: prompt }],
        maxTokens:    512,
        temperature:  0.2,
        mode:         'no_think',
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('digest timeout')), DIGEST_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    return `Digest unavailable: ${(err as Error).message}`;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runCodeAudit(
  store:      SecurityStore,
  runId:      string,
  targetPath: string,
): Promise<void> {
  try {
    const parsers = await loadParsers();

    const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];
    const rawLines: string[]                                        = [`Code audit: ${targetPath}`, ''];

    if (parsers.error) {
      // Grammar unavailable — record as a single info finding rather than hard-failing
      rawLines.push(`Parser unavailable: ${parsers.error}`);
      findings.push({
        run_id:    runId,
        scan_type: 'code_audit',
        severity:  'info',
        title:     'Code audit unavailable: tree-sitter grammar not loaded',
        detail:    parsers.error,
        target:    targetPath,
        cve_id:    null,
        is_new:    true,
      });
      const raw = rawLines.join('\n').slice(0, RAW_OUTPUT_CAP);
      await store.insertFindings(findings);
      await store.setAnalyzing(runId);
    const digest = await buildDigest(targetPath, findings.length, 1, raw);
      await store.completeRun(runId, 'success', findings.length, 1, raw, null, digest);
      return;
    }

    const priorKeys = await store.getPriorFindingKeys('code_audit');
    const files     = fs.statSync(targetPath).isDirectory()
      ? collectFiles(targetPath)
      : [targetPath];

    rawLines.push(`Files scanned: ${files.length}`);

    for (const filepath of files) {
      let stat: fs.Stats;
      try { stat = fs.statSync(filepath); } catch { continue; }

      if (stat.size > FILE_SIZE_LIMIT) {
        const title  = `File skipped (too large): ${path.basename(filepath)}`;
        const target = filepath;
        findings.push({
          run_id:    runId,
          scan_type: 'code_audit',
          severity:  'info',
          title,
          detail:    `File size ${stat.size} bytes exceeds 1 MB limit.`,
          target,
          cve_id:    null,
          is_new:    !priorKeys.has(`${title}||${target}`),
        });
        continue;
      }

      const ext    = path.extname(filepath).toLowerCase();
      const parser = selectParser(ext, parsers);
      if (!parser) continue;

      let source: string;
      try { source = fs.readFileSync(filepath, 'utf-8'); } catch { continue; }

      let tree: Tree;
      try { tree = parser.parse(source); } catch { continue; }

      walkNode(tree.rootNode, source, filepath, runId, priorKeys, findings);
    }

    // Sort by severity then filepath for readable output
    const SEV_ORDER: Record<Severity, number> = {
      critical: 0, high: 1, medium: 2, low: 3, info: 4,
    };
    findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

    for (const f of findings) {
      rawLines.push(`${f.severity.toUpperCase().padEnd(8)} ${f.title}  @ ${f.target}`);
    }

    const newCount = findings.filter(f => f.is_new).length;
    const raw      = rawLines.join('\n').slice(0, RAW_OUTPUT_CAP);

    await store.insertFindings(findings);
    await store.setAnalyzing(runId);
    const digest = await buildDigest(targetPath, findings.length, newCount, raw);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, digest);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}