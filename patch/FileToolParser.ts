import type { FileToolCall, ParsedToolOutput } from '../ai/FileTools.js';

/**
 * Parses file tool calls from engine output.
 *
 * Supported tags:
 *   <write_file path="...">content</write_file>
 *   <append_file path="...">content</append_file>
 *   <insert_lines path="..." after_line="N">content</insert_lines>
 *   <replace_lines path="..." start_line="N" end_line="M">content</replace_lines>
 *   <delete_lines path="..." start_line="N" end_line="M"/>
 *   <read_file path="..."/>
 */
export class FileToolParser {
  private static TOOL_NAMES = [
    'write_file', 'append_file', 'insert_lines',
    'replace_lines', 'delete_lines', 'read_file',
  ] as const;

  parse(output: string): ParsedToolOutput {
    const toolCalls: FileToolCall[] = [];
    let remaining = output;
    const explanationParts: string[] = [];

    // Find all tool tags in order
    while (true) {
      const { tagName, tagStart } = this.findNextTool(remaining);
      if (!tagName || tagStart === -1) {
        const trailing = remaining.trim();
        if (trailing) explanationParts.push(trailing);
        break;
      }

      // Capture explanation text before this tag
      const before = remaining.slice(0, tagStart).trim();
      if (before) explanationParts.push(before);

      // Parse the tag
      const { call, consumed } = this.parseTag(remaining.slice(tagStart), tagName);
      if (call) toolCalls.push(call);
      remaining = remaining.slice(tagStart + consumed);
    }

    return {
      toolCalls,
      explanation: explanationParts.join('\n\n').trim(),
      hasReadRequest: toolCalls.some(c => c.tool === 'read_file'),
    };
  }

  private findNextTool(text: string): { tagName: string | null; tagStart: number } {
    let earliest = -1;
    let earliestTag: string | null = null;

    for (const name of FileToolParser.TOOL_NAMES) {
      const idx = text.indexOf(`<${name}`);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestTag = name;
      }
    }

    return { tagName: earliestTag, tagStart: earliest };
  }

  private parseTag(text: string, tagName: string): { call: FileToolCall | null; consumed: number } {
    // Self-closing: <delete_lines ... /> or <read_file ... />
    const selfCloseMatch = text.match(new RegExp(`^<${tagName}([^>]*?)\\/>`));
    if (selfCloseMatch) {
      const attrs = this.parseAttrs(selfCloseMatch[1]);
      const call = this.buildCall(tagName, attrs, '');
      return { call, consumed: selfCloseMatch[0].length };
    }

    // Open tag
    const openMatch = text.match(new RegExp(`^<${tagName}([^>]*)>`));
    if (!openMatch) return { call: null, consumed: 1 };

    const attrs = this.parseAttrs(openMatch[1]);
    const afterOpen = openMatch[0].length;

    // Find closing tag
    const closeTag = `</${tagName}>`;
    const closeIdx = text.indexOf(closeTag, afterOpen);
    if (closeIdx === -1) {
      // No closing tag — consume the open tag and skip
      return { call: null, consumed: afterOpen };
    }

    // Content between open and close — strip exactly one leading newline
    let content = text.slice(afterOpen, closeIdx);
    if (content.startsWith('\n')) content = content.slice(1);
    if (content.endsWith('\n')) content = content.slice(0, -1);

    const call = this.buildCall(tagName, attrs, content);
    return { call, consumed: closeIdx + closeTag.length };
  }

  private parseAttrs(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const pattern = /(\w+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(attrString)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  private buildCall(tagName: string, attrs: Record<string, string>, content: string): FileToolCall | null {
    const p = attrs['path'];
    if (!p) return null;

    switch (tagName) {
      case 'write_file':
        return { tool: 'write_file', path: p, content };

      case 'append_file':
        return { tool: 'append_file', path: p, content };

      case 'insert_lines': {
        const afterLine = parseInt(attrs['after_line'] ?? '0', 10);
        return { tool: 'insert_lines', path: p, afterLine, content };
      }

      case 'replace_lines': {
        const startLine = parseInt(attrs['start_line'] ?? '1', 10);
        const endLine = parseInt(attrs['end_line'] ?? '1', 10);
        return { tool: 'replace_lines', path: p, startLine, endLine, content };
      }

      case 'delete_lines': {
        const startLine = parseInt(attrs['start_line'] ?? '1', 10);
        const endLine = parseInt(attrs['end_line'] ?? '1', 10);
        return { tool: 'delete_lines', path: p, startLine, endLine };
      }

      case 'read_file':
        return { tool: 'read_file', path: p };

      default:
        return null;
    }
  }
}
