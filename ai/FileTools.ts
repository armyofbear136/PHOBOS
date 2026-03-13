/**
 * FileTools — structured file operation tools for the engine.
 *
 * Instead of fragile SEARCH/REPLACE parsing, the engine emits XML tool calls
 * that the backend executes directly against the workspace. This eliminates
 * all SEARCH content matching, empty-file edge cases, and whitespace ambiguity.
 *
 * Engine output format:
 *
 *   <write_file path="filename.ts">
 *   full file contents here
 *   </write_file>
 *
 *   <append_file path="notes.txt">
 *   line to append
 *   </append_file>
 *
 *   <insert_lines path="main.ts" after_line="12">
 *   new lines to insert after line 12
 *   </insert_lines>
 *
 *   <replace_lines path="main.ts" start_line="5" end_line="8">
 *   replacement content
 *   </replace_lines>
 *
 *   <delete_lines path="main.ts" start_line="5" end_line="8"/>
 *
 *   <read_file path="config.ts"/>
 */

export type FileToolCall =
  | { tool: 'write_file';    path: string; content: string }
  | { tool: 'append_file';   path: string; content: string }
  | { tool: 'insert_lines';  path: string; afterLine: number; content: string }
  | { tool: 'replace_lines'; path: string; startLine: number; endLine: number; content: string }
  | { tool: 'delete_lines';  path: string; startLine: number; endLine: number }
  | { tool: 'read_file';     path: string }
  | { tool: 'generate_image'; path: string; prompt: string };

export interface FileToolResult {
  tool: string;
  path: string;
  success: boolean;
  content?: string;   // populated for read_file
  error?: string;
  lineCount?: number; // final line count after write ops
}

export interface ParsedToolOutput {
  toolCalls: FileToolCall[];
  explanation: string;   // text outside tool tags
  hasReadRequest: boolean;
}
