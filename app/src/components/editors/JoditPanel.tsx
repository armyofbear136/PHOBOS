/**
 * JoditPanel.tsx — Fullscreen document editor: wasm-pandoc + TipTap.
 *
 * Layout (identical to previous Jodit version):
 *   Row 1 — PHOBOS toolbar: filename, page size, margins, web layout, open, new, export, save, close
 *   Row 2 — Custom DocToolbar: TipTap command bridge
 *   Scroll field — dark (#1a1a1a), owns scroll, centres white paper card
 *   Status bar  — word count, char count, page count, page size label
 *
 * Page break strategy:
 *   A custom ProseMirror node "pageBreak" is a non-editable full-width div.
 *   Text structurally cannot flow through it — the node is in the document,
 *   not a CSS illusion. A debounced layout pass after every editor update
 *   measures cumulative block heights and inserts/removes pageBreak nodes
 *   at each page.h boundary. Margins are applied via CSS to the .tiptap div.
 *
 * Performance:
 *   HTML content held in htmlRef (NOT state). onChange only flips dirty flag.
 *   Status bar written directly to DOM via statusRef — zero re-renders per keystroke.
 *
 * Save: tap = silent overwrite / save-as on first save. Hold 500ms = always save-as.
 */

import React, {
  useEffect, useRef, useState, useCallback, useMemo,
} from 'react';

// TipTap core
import { useEditor, EditorContent, Editor, Extension, BubbleMenu } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Superscript from '@tiptap/extension-superscript';
import Subscript from '@tiptap/extension-subscript';
import Typography from '@tiptap/extension-typography';
import { Node, mergeAttributes } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';

import { X, Save, FilePlus, FolderOpen, Loader2, AlertTriangle, FileDown, ChevronDown } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── FontSize extension ────────────────────────────────────────────────────────
// TextStyle carries arbitrary CSS. We store font-size as a mark attribute.
const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => el.style.fontSize?.replace('pt', '') || null,
          renderHTML: (attrs) => {
            if (!attrs.fontSize) return {};
            return { style: `font-size: ${attrs.fontSize}pt` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (size: string) => ({ chain }: { chain: () => ReturnType<Editor['chain']> }) =>
        chain().setMark('textStyle', { fontSize: size }).run(),
    } as Record<string, unknown>;
  },
});

// ── LineHeight extension ─────────────────────────────────────────────────────
// Stored as a paragraph-level attribute via TextStyle; applied as CSS line-height.
const LineHeight = Extension.create({
  name: 'lineHeight',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.lineHeight || null,
          renderHTML: (attrs) => {
            if (!attrs.lineHeight) return {};
            return { style: `line-height: ${attrs.lineHeight}` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setLineHeight: (lineHeight: string) => ({ commands }: { commands: { updateAttributes: (typeOrName: string, attrs: Record<string, unknown>) => boolean } }) =>
        commands.updateAttributes('paragraph', { lineHeight }),
    } as Record<string, unknown>;
  },
});

// ── PageBreak node ────────────────────────────────────────────────────────────
// Non-editable block node. Text cannot flow through it.
//
// Visual height = dark divider band (72px) + next page top margin.
// The top margin portion is transparent — it reads as whitespace at the top
// of the next page, matching the first page's top padding exactly.
// Height is driven by CSS custom properties written by buildPaperCSS so
// the node reacts to margin changes without a re-render.
//
//  ┌──────────────────────────────────┐  ← bottom of page N content
//  │  1px #c8ccd0 top edge            │
//  │  72px #1a1a1a dark band          │  PAGE_BREAK_BAND_HEIGHT
//  │  1px #c8ccd0 bottom edge         │
//  │  [mt]px transparent gap          │  = next page's top margin
//  └──────────────────────────────────┘  ← first line of page N+1 content

const PAGE_BREAK_BAND_HEIGHT = 72; // dark band only, px

const PageBreakNode = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-page-break': 'true',
      style: [
        'height:calc(var(--pb-mb,96px) + var(--pb-band,72px) + var(--pb-mt,96px))',
        'background:linear-gradient(to bottom,transparent 0px,transparent var(--pb-mb,96px),#c8ccd0 var(--pb-mb,96px),#1a1a1a calc(var(--pb-mb,96px) + 1px),#1a1a1a calc(var(--pb-mb,96px) + var(--pb-band,72px) - 1px),#c8ccd0 calc(var(--pb-mb,96px) + var(--pb-band,72px) - 1px),#c8ccd0 calc(var(--pb-mb,96px) + var(--pb-band,72px)),transparent calc(var(--pb-mb,96px) + var(--pb-band,72px)))',
        'margin:0',
        'padding:0',
        'user-select:none',
        'pointer-events:none',
        'width:100%',
        'box-sizing:border-box',
        'display:block',
      ].join(';'),
      contenteditable: 'false',
    })];
  },
});

// ── Format helpers ────────────────────────────────────────────────────────────
function extOf(f: string) { return (f.split('.').pop() ?? '').toLowerCase(); }
function isBinary(ext: string) { return ['docx', 'doc', 'odt', 'rtf'].includes(ext); }
function saveFilename(name: string) {
  const ext = extOf(name);
  return (ext === 'html' || ext === 'htm') ? name : name.replace(/\.[^.]+$/, '') + '.html';
}

// ── Backend pandoc helpers ────────────────────────────────────────────────────
// All pandoc conversion is done server-side. No WASM, no worker.

async function binaryToHtml(filename: string, base64: string): Promise<string> {
  const res  = await fetch(`${ENGINE_URL}/api/kavita/convert-file`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ base64, filename }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `convert-file ${res.status}`);
  return (await res.json()).html as string;
}

async function textToHtml(content: string, ext: string): Promise<string> {
  if (ext === 'html' || ext === 'htm') return content;
  // Encode text as base64 and send to convert-file — same path as binary docs.
  const encoded  = btoa(unescape(encodeURIComponent(content)));
  const fakeFile = `input.${ext === 'md' || ext === 'markdown' ? 'md' : 'txt'}`;
  return binaryToHtml(fakeFile, encoded);
}

async function htmlToDocx(html: string): Promise<Blob> {
  const res = await fetch(`${ENGINE_URL}/api/kavita/convert`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html, to: 'docx' }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `convert ${res.status}`);
  return res.blob();
}

async function htmlToMd(html: string): Promise<string> {
  const res = await fetch(`${ENGINE_URL}/api/kavita/convert`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ html, to: 'gfm' }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `convert ${res.status}`);
  return (await res.json()).markdown as string;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

// ── Page sizes ────────────────────────────────────────────────────────────────
interface PageMargins { mt: number; mb: number; ml: number; mr: number; }

const DEFAULT_MARGINS: PageMargins = { mt: 96, mb: 96, ml: 120, mr: 120 };

const PAGE_SIZES = [
  { label: 'Letter',  detail: '8.5 × 11"',  w: 816,  h: 1056 },
  { label: 'Legal',   detail: '8.5 × 14"',  w: 816,  h: 1344 },
  { label: 'A4',      detail: '210 × 297mm', w: 794,  h: 1123 },
  { label: 'Tabloid', detail: '11 × 17"',    w: 1056, h: 1632 },
  { label: 'A3',      detail: '297 × 420mm', w: 1123, h: 1587 },
] as const;
type PageSize = typeof PAGE_SIZES[number];

// ── Paper style builder ────────────────────────────────────────────────────────
// TipTap renders into .tiptap (the contenteditable div).
// We target that class instead of .jodit-wysiwyg.
// PageBreak nodes render their own dark band inline — no gradient needed.
// The outer container just sets width, padding (margins), and typography.
//
// Pure function — returns CSS string only. The JoditPanel component owns the
// <style> element via a ref (created on mount, removed on unmount). This avoids
// the removeChild NotFoundError that occurred when document.getElementById +
// document.head.appendChild raced React's DOM reconciler during re-renders.

function buildPaperCSS(page: PageSize | null, margins: PageMargins): string {
  if (page === null) {
    return `
      .tiptap {
        background: #0d0f12 !important;
        color: #e2e8f0 !important;
        width: 100% !important;
        max-width: 100% !important;
        min-height: unset !important;
        padding: 32px 48px !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        font-family: ui-sans-serif, system-ui, sans-serif !important;
        font-size: 14px !important;
        line-height: 1.7 !important;
        box-sizing: border-box !important;
        outline: none !important;
      }
    `;
  }

  const { mt, mb, ml, mr } = margins;
  return `
    .tiptap {
      --pb-band: ${PAGE_BREAK_BAND_HEIGHT}px;
      --pb-mt: ${mt}px;
      --pb-mb: ${mb}px;
      background-color: #ffffff !important;
      color: #111111 !important;
      width: ${page.w}px !important;
      max-width: calc(100vw - 80px) !important;
      min-height: ${page.h}px !important;
      padding: ${mt}px ${mr}px ${mb}px ${ml}px !important;
      box-shadow: 0 2px 16px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3) !important;
      box-sizing: border-box !important;
      font-family: 'Times New Roman', Times, serif !important;
      font-size: 12pt !important;
      line-height: 1.6 !important;
      text-align: left !important;
      caret-color: #000 !important;
      outline: none !important;
      margin: 0 auto !important;
    }
    .tiptap p { margin: 0 0 0.25em; }
    .tiptap h1 { font-size: 2em;   font-weight: 700; margin: 0.67em 0; }
    .tiptap h2 { font-size: 1.5em; font-weight: 700; margin: 0.75em 0; }
    .tiptap h3 { font-size: 1.25em;font-weight: 600; margin: 0.83em 0; }
    .tiptap h4 { font-size: 1em;   font-weight: 600; margin: 1.12em 0; }
    .tiptap ul { list-style: disc;    padding-left: 1.5em; margin: 0.5em 0; }
    .tiptap ol { list-style: decimal; padding-left: 1.5em; margin: 0.5em 0; }
    .tiptap blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #555; }
    .tiptap pre { background: #f4f4f4; border-radius: 4px; padding: 0.75em 1em; font-family: 'Courier New', monospace; }
    .tiptap hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
    .tiptap a { color: #1a56db; text-decoration: underline; cursor: pointer; }
    .tiptap a:hover { color: #1e40af; }
    .tiptap table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.75em 0;
      table-layout: fixed;
      overflow: hidden;
    }
    .tiptap th, .tiptap td {
      border: 1px solid #b0b8c4;
      padding: 6px 10px;
      vertical-align: top;
      min-width: 60px;
      position: relative;
      box-sizing: border-box;
    }
    .tiptap th {
      background: #f0f2f5;
      font-weight: 600;
      text-align: left;
    }
    .tiptap .selectedCell::after {
      z-index: 2;
      position: absolute;
      content: '';
      inset: 0;
      background: rgba(34, 197, 94, 0.12);
      pointer-events: none;
    }
    .tiptap [data-page-break] {
      margin-left: -${ml}px !important;
      width: calc(100% + ${ml}px + ${mr}px) !important;
    }
  `;
}

// ── Page break layout pass ────────────────────────────────────────────────────
// After each editor update (debounced 400ms), walk the TipTap DOM,
// measure each block's offsetTop + offsetHeight, and insert/remove
// pageBreak nodes at positions where cumulative height crosses a page boundary.
//
// We work in DOM space (measured pixels) then map back to ProseMirror positions
// using editor.view.posAtDOM().

function runPageBreakLayout(editor: Editor, pageH: number, margins: PageMargins) {
  const { mt, mb } = margins;
  const contentH = pageH - mt - mb; // usable text area per page, px

  const { state, view } = editor;

  // ── Pass 1: strip all existing pageBreak nodes ───────────────────────────
  // Must measure from a clean DOM — break nodes carry mb+band+mt px of height
  // that would corrupt the cumulative measurement if left in place.
  const { doc } = state;
  const tr = state.tr;
  let offset = 0;
  doc.forEach((node, pos) => {
    if (node.type.name === 'pageBreak') {
      tr.delete(pos - offset, pos - offset + node.nodeSize);
      offset += node.nodeSize;
    }
  });
  if (tr.steps.length > 0) {
    view.dispatch(tr.setMeta('addToHistory', false));
    // DOM hasn't flushed yet — re-run next frame after React repaints
    requestAnimationFrame(() => runPageBreakLayout(editor, pageH, margins));
    return;
  }

  // ── Pass 2: measure content blocks in pure height-space ─────────────────
  // We sum each block's offsetHeight (ignoring its offsetTop, which includes
  // padding-top from .tiptap). This gives us the raw stack of content heights
  // independent of any CSS offset. When the running sum exceeds contentH we
  // insert a break before that block and reset the accumulator.
  const editorEl = editor.view.dom as HTMLElement;
  const children = Array.from(editorEl.childNodes).filter(
    (n): n is HTMLElement => n.nodeType === 1 /* ELEMENT_NODE */
  );

  const insertions: number[] = []; // PM positions to insert break before
  let runningH = 0;

  for (const el of children) {
    if (el.dataset?.pageBreak) continue;

    const blockH = el.offsetHeight;

    if (runningH + blockH > contentH && runningH > 0) {
      // This block would overflow — insert break before it
      try {
        const pmPos = view.posAtDOM(el, 0);
        insertions.push(Math.max(0, pmPos - 1));
      } catch { /* node not in doc, skip */ }
      // Reset accumulator: this block starts a fresh page
      runningH = blockH;
    } else {
      runningH += blockH;
    }
  }

  if (insertions.length === 0) return;

  // ── Pass 3: insert breaks in reverse so positions don't shift ───────────
  const tr2 = editor.state.tr;
  const pageBreakType = editor.schema.nodes['pageBreak'];
  if (!pageBreakType) return;

  for (let i = insertions.length - 1; i >= 0; i--) {
    tr2.insert(insertions[i], pageBreakType.create());
  }
  editor.view.dispatch(tr2.setMeta('addToHistory', false));
}

// ── Status bar helpers ────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}
function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

// ── File System Access helpers ────────────────────────────────────────────────
const hasFSA = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

async function fsaSave(html: string, origName: string): Promise<{ chosenName: string } | null> {
  if (!hasFSA) return null;
  try {
    const basename = origName.replace(/\.[^.]+$/, '') || 'untitled';
    const handle = await (window as unknown as {
      showSaveFilePicker: (o: object) => Promise<{
        name: string;
        createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }).showSaveFilePicker({
      suggestedName: `${basename}.docx`,
      id:            'phobosDocs',
      startIn:       'documents',
      types: [
        { description: 'Word Document', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } },
        { description: 'HTML Document', accept: { 'text/html': ['.html'] } },
        { description: 'Markdown',      accept: { 'text/markdown': ['.md'] } },
      ],
    });
    const ext = extOf(handle.name);
    let blob: Blob;
    if (ext === 'docx' || ext === 'doc') blob = await htmlToDocx(html);
    else if (ext === 'md') blob = new Blob([await htmlToMd(html)], { type: 'text/markdown' });
    else blob = new Blob([html], { type: 'text/html' });
    const w = await handle.createWritable();
    await w.write(blob); await w.close();
    return { chosenName: handle.name };
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  }
}

async function fileToHtml(file: File): Promise<string> {
  const ext = extOf(file.name);
  if (ext === 'html' || ext === 'htm') return file.text();
  if (isBinary(ext)) {
    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary  = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return binaryToHtml(file.name, btoa(binary));
  }
  // text-based (md, txt) — send to backend via convert-file
  const text    = await file.text();
  const encoded = btoa(unescape(encodeURIComponent(text)));
  return binaryToHtml(`input.${ext}`, encoded);
}

async function fsaOpen(): Promise<{ filename: string; html: string } | null> {
  if (hasFSA) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: object) => Promise<Array<{ name: string; getFile: () => Promise<File> }>>;
      }).showOpenFilePicker({
        id: 'phobosDocs', startIn: 'documents',
        types: [{ description: 'Documents', accept: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
          'text/html': ['.html', '.htm'], 'text/markdown': ['.md'],
          'text/plain': ['.txt'], 'application/vnd.oasis.opendocument.text': ['.odt'],
        }}],
        multiple: false,
      });
      const file = await handle.getFile();
      return { filename: file.name, html: await fileToHtml(file) };
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,.html,.htm,.md,.txt,.odt,.rtf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try { resolve({ filename: file.name, html: await fileToHtml(file) }); }
      catch (err) { reject(err); }
    };
    input.click();
  });
}

// ── DocToolbar ────────────────────────────────────────────────────────────────

const FONTS = [
  'Times New Roman', 'Georgia', 'Garamond',
  'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS',
  'Courier New', 'Consolas',
];
const FONT_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '32', '36', '48', '72'];
const LINE_SPACINGS: Array<[string, string]> = [
  ['Single',  '1'],
  ['1.15',    '1.15'],
  ['1.5',     '1.5'],
  ['Double',  '2'],
];
const TABLE_GRID_SIZE = 6; // 6×6 hover grid
const HEADINGS: Array<[string, string | null, number | null]> = [
  ['Paragraph',   'paragraph',  null],
  ['Heading 1',   'heading',    1],
  ['Heading 2',   'heading',    2],
  ['Heading 3',   'heading',    3],
  ['Heading 4',   'heading',    4],
  ['Preformatted','codeBlock',  null],
  ['Blockquote',  'blockquote', null],
];

interface DocToolbarProps {
  editor: Editor | null;
  bubbleLinkOpen:    boolean;
  setBubbleLinkOpen: (v: boolean) => void;
  bubbleLinkUrl:     string;
  setBubbleLinkUrl:  (v: string) => void;
  applyBubbleLink:   (url: string) => void;
}

function DocToolbar({ editor, bubbleLinkOpen, setBubbleLinkOpen, bubbleLinkUrl, setBubbleLinkUrl, applyBubbleLink }: DocToolbarProps) {
  const [fontOpen,      setFontOpen]      = useState(false);
  const [sizeOpen,      setSizeOpen]      = useState(false);
  const [headingOpen,   setHeadingOpen]   = useState(false);
  const [spacingOpen,   setSpacingOpen]   = useState(false);
  const [tableOpen,     setTableOpen]     = useState(false);
  const [tableHov,      setTableHov]      = useState<[number, number]>([0, 0]);
  const [linkOpen,      setLinkOpen]      = useState(false);
  const [linkUrl,       setLinkUrl]       = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  const closeAll = () => {
    setFontOpen(false); setSizeOpen(false); setHeadingOpen(false);
    setSpacingOpen(false); setTableOpen(false); setLinkOpen(false);
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      // Don't close link panel on click inside it — handled by its own buttons
      if ((e.target as HTMLElement)?.closest?.('[data-link-panel]')) return;
      closeAll();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const run = useCallback((fn: (e: Editor) => void) => {
    if (!editor) return;
    editor.chain().focus();
    fn(editor);
  }, [editor]);

  const btn = (label: React.ReactNode, onClick: () => void, title: string) => (
    <button
      key={title}
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className="px-2 py-1 text-[12px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none leading-none"
    >{label}</button>
  );

  const sep = () => <span className="mx-1 text-border select-none">│</span>;

  return (
    <div
      className="shrink-0 border-b border-border bg-background"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 42, padding: '0 12px', flexWrap: 'wrap', gap: 2 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Heading/paragraph */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onMouseDown={(ev) => { ev.preventDefault(); setHeadingOpen((v) => !v); setSizeOpen(false); setFontOpen(false); }}
          className="px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none"
        >¶ Style</button>
        {headingOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-background border border-border rounded-sm shadow-xl min-w-[140px] overflow-hidden">
            {HEADINGS.map(([label, cmd, level]) => (
              <button key={label}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  if (!editor) return;
                  const chain = editor.chain().focus();
                  if (cmd === 'heading' && level) (chain as unknown as { toggleHeading: (o: { level: number }) => typeof chain }).toggleHeading({ level }).run();
                  else if (cmd === 'paragraph') (chain as unknown as { setParagraph: () => typeof chain }).setParagraph().run();
                  else if (cmd === 'codeBlock') (chain as unknown as { toggleCodeBlock: () => typeof chain }).toggleCodeBlock().run();
                  else if (cmd === 'blockquote') (chain as unknown as { toggleBlockquote: () => typeof chain }).toggleBlockquote().run();
                  setHeadingOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-all">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Font family */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onMouseDown={(ev) => { ev.preventDefault(); setFontOpen((v) => !v); setSizeOpen(false); setHeadingOpen(false); }}
          className="px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none"
        >A Font</button>
        {fontOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-background border border-border rounded-sm shadow-xl min-w-[170px] overflow-hidden max-h-60 overflow-y-auto">
            {FONTS.map((f) => (
              <button key={f}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  editor?.chain().focus().setFontFamily(f).run();
                  setFontOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                style={{ fontFamily: f }}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Font size */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onMouseDown={(ev) => { ev.preventDefault(); setSizeOpen((v) => !v); setFontOpen(false); setHeadingOpen(false); }}
          className="px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none"
        >Tt Size</button>
        {sizeOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-background border border-border rounded-sm shadow-xl min-w-[80px] overflow-hidden max-h-60 overflow-y-auto">
            {FONT_SIZES.map((s) => (
              <button key={s}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  (editor?.chain().focus() as unknown as { setFontSize: (s: string) => { run: () => void } })?.setFontSize(s)?.run();
                  setSizeOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-all">
                {s}pt
              </button>
            ))}
          </div>
        )}
      </div>

      {sep()}

      {/* Inline formatting */}
      {btn(<b>B</b>,          () => run((e) => e.chain().focus().toggleBold().run()),          'Bold (Ctrl+B)')}
      {btn(<i>I</i>,          () => run((e) => e.chain().focus().toggleItalic().run()),        'Italic (Ctrl+I)')}
      {btn(<u>U</u>,          () => run((e) => e.chain().focus().toggleUnderline().run()),     'Underline (Ctrl+U)')}
      {btn(<s>S</s>,          () => run((e) => e.chain().focus().toggleStrike().run()),        'Strikethrough')}

      {sep()}

      {/* Alignment */}
      {btn('⬅', () => run((e) => e.chain().focus().setTextAlign('left').run()),    'Align Left')}
      {btn('⬛', () => run((e) => e.chain().focus().setTextAlign('center').run()),  'Center')}
      {btn('➡', () => run((e) => e.chain().focus().setTextAlign('right').run()),   'Align Right')}
      {btn('☰', () => run((e) => e.chain().focus().setTextAlign('justify').run()), 'Justify')}

      {sep()}

      {/* Lists */}
      {btn('• List',  () => run((e) => e.chain().focus().toggleBulletList().run()),  'Bullet list')}
      {btn('1. List', () => run((e) => e.chain().focus().toggleOrderedList().run()), 'Numbered list')}

      {sep()}

      {/* Indent — TipTap list indent/outdent */}
      {btn('→ In',  () => run((e) => e.chain().focus().sinkListItem('listItem').run()),  'Indent')}
      {btn('← Out', () => run((e) => e.chain().focus().liftListItem('listItem').run()),  'Outdent')}

      {sep()}

      {/* Undo / redo */}
      {btn('↩', () => run((e) => e.chain().focus().undo().run()), 'Undo (Ctrl+Z)')}
      {btn('↪', () => run((e) => e.chain().focus().redo().run()), 'Redo (Ctrl+Y)')}

      {sep()}

      {/* Clear / select all */}
      {btn('✕ Clear',    () => run((e) => e.chain().focus().unsetAllMarks().clearNodes().run()), 'Clear formatting')}
      {btn('Select All', () => editor?.commands.selectAll(),                                     'Select all')}

      {sep()}

      {/* Superscript / subscript */}
      {btn(<sup style={{ fontSize: '9px' }}>x²</sup>, () => run((e) => e.chain().focus().toggleSuperscript().run()), 'Superscript')}
      {btn(<sub style={{ fontSize: '9px' }}>x₂</sub>, () => run((e) => e.chain().focus().toggleSubscript().run()),   'Subscript')}

      {sep()}

      {/* Horizontal rule */}
      {btn('── HR', () => run((e) => e.chain().focus().setHorizontalRule().run()), 'Horizontal rule')}

      {sep()}

      {/* Font colour */}
      <label title="Font colour" className="relative flex items-center cursor-pointer px-1">
        <span className="text-[12px] font-mono text-muted-foreground hover:text-foreground select-none">A</span>
        <input type="color" defaultValue="#000000"
          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
          onInput={(ev) => {
            ev.preventDefault();
            editor?.chain().focus().setColor((ev.target as HTMLInputElement).value).run();
          }}
          title="Font colour"
        />
      </label>

      {/* Highlight colour */}
      <label title="Highlight colour" className="relative flex items-center cursor-pointer px-1">
        <span className="text-[12px] font-mono text-muted-foreground hover:text-foreground select-none" style={{ background: '#ff0', color: '#000', padding: '0 2px' }}>H</span>
        <input type="color" defaultValue="#ffff00"
          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
          onInput={(ev) => {
            ev.preventDefault();
            editor?.chain().focus().setHighlight({ color: (ev.target as HTMLInputElement).value }).run();
          }}
          title="Highlight colour"
        />
      </label>

      {sep()}

      {/* Line spacing */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onMouseDown={(ev) => { ev.preventDefault(); setSpacingOpen((v) => !v); setFontOpen(false); setSizeOpen(false); setHeadingOpen(false); setTableOpen(false); setLinkOpen(false); }}
          className="px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none"
        >↕ Spacing</button>
        {spacingOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-background border border-border rounded-sm shadow-xl min-w-[100px] overflow-hidden">
            {LINE_SPACINGS.map(([label, val]) => (
              <button key={val}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  if (!editor) return;
                  (editor.chain().focus() as unknown as { setLineHeight: (v: string) => { run: () => void } }).setLineHeight(val).run();
                  setSpacingOpen(false);
                }}
                className="w-full px-3 py-1.5 text-left text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent transition-all">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {sep()}

      {/* Table grid picker */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          onMouseDown={(ev) => { ev.preventDefault(); setTableOpen((v) => !v); setFontOpen(false); setSizeOpen(false); setHeadingOpen(false); setSpacingOpen(false); setLinkOpen(false); }}
          className="px-2 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-all select-none"
        >⊞ Table</button>
        {tableOpen && (
          <div className="absolute top-full left-0 mt-0.5 z-50 bg-background border border-border rounded-sm shadow-xl p-2"
            style={{ width: TABLE_GRID_SIZE * 22 + 16 }}>
            <div className="text-[9px] font-mono text-muted-foreground/60 mb-1.5 select-none">
              {tableHov[0] > 0 ? `${tableHov[1]} × ${tableHov[0]}` : 'hover to select'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TABLE_GRID_SIZE}, 20px)`, gap: 2 }}>
              {Array.from({ length: TABLE_GRID_SIZE * TABLE_GRID_SIZE }, (_, i) => {
                const row = Math.floor(i / TABLE_GRID_SIZE) + 1;
                const col = (i % TABLE_GRID_SIZE) + 1;
                const active = row <= tableHov[0] && col <= tableHov[1];
                return (
                  <div key={i}
                    onMouseEnter={() => setTableHov([row, col])}
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      if (!editor || tableHov[0] === 0) return;
                      (editor.chain().focus() as unknown as {
                        insertTable: (o: { rows: number; cols: number; withHeaderRow: boolean }) => { run: () => void }
                      }).insertTable({ rows: tableHov[0], cols: tableHov[1], withHeaderRow: true }).run();
                      setTableOpen(false);
                      setTableHov([0, 0]);
                    }}
                    style={{
                      width: 20, height: 20,
                      background: active ? '#22c55e22' : '#1a1d23',
                      border: `1px solid ${active ? '#22c55e55' : '#1e2433'}`,
                      borderRadius: 2,
                      cursor: 'pointer',
                      transition: 'background 80ms, border-color 80ms',
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      {sep()}

      {/* Link — handled by BubbleMenu on text selection; toolbar button is a hint */}
      {btn('🔗 Link', () => {
        // If cursor is on an existing link, unset it. Otherwise hint to select text.
        if (editor?.isActive('link')) {
          editor.chain().focus().unsetLink().run();
        }
      }, 'Select text to insert link (bubble menu)')}

      {sep()}

      {/* Image — file picker + drag-drop handled by TipTap Image extension */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          if (!file || !editor) return;
          const reader = new FileReader();
          reader.onload = () => {
            const src = reader.result as string;
            (editor.chain().focus() as unknown as { setImage: (o: { src: string; alt: string }) => { run: () => void } })
              .setImage({ src, alt: file.name }).run();
          };
          reader.readAsDataURL(file);
          ev.target.value = '';
        }}
      />
      {btn('🖼 Image', () => imageInputRef.current?.click(), 'Insert image')}

      {sep()}

      {/* Source view */}
      {btn('</>', () => {
        if (!editor) return;
        const html = editor.getHTML();
        const win = window.open('', '_blank', 'width=800,height=600');
        if (!win) return;
        win.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;padding:1em">${html.replace(/</g, '&lt;')}</pre>`);
        win.document.close();
      }, 'View source HTML')}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
export function JoditPanel() {
  const joditPanelOpen   = useAppStore((s) => s.joditPanelOpen);
  const toggleJoditPanel = useAppStore((s) => s.toggleJoditPanel);
  const activeThreadId   = useAppStore((s) => s.activeThreadId);
  const openRequest      = useAppStore((s) => s.joditOpenRequest);
  const setOpenRequest   = useAppStore((s) => s.setJoditOpenRequest);

  const htmlRef        = useRef('');
  const statusRef      = useRef<HTMLDivElement>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const breakTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styleElRef     = useRef<HTMLStyleElement | null>(null);

  const [origName,     setOrigName]     = useState('untitled.docx');
  const [editingName,  setEditingName]  = useState(false);
  const [draftName,    setDraftName]    = useState('untitled.docx');
  const [converting,   setConverting]   = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [convertErr,   setConvertErr]   = useState<string | null>(null);
  const [saveErr,      setSaveErr]      = useState<string | null>(null);
  const [dirty,        setDirty]        = useState(false);
  const [exportOpen,   setExportOpen]   = useState(false);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const [marginsOpen,  setMarginsOpen]  = useState(false);
  const [savedPath,    setSavedPath]    = useState<string | null>(null);
  const [pageSize,     setPageSize]     = useState<PageSize>(PAGE_SIZES[0]);
  const [margins,      setMargins]      = useState<PageMargins>(DEFAULT_MARGINS);
  const [webView,      setWebView]      = useState(false);

  const saveHoldRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bubble menu link state — declared here, handler defined after useEditor
  const [bubbleLinkOpen, setBubbleLinkOpen] = useState(false);
  const [bubbleLinkUrl,  setBubbleLinkUrl]  = useState('');

  // TipTap extensions — stable reference, built once
  const extensions = useMemo(() => [
    StarterKit.configure({
      // Disable StarterKit's hardBreak — we use our own pageBreak node
      hardBreak: false,
    }),
    Underline,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    FontFamily,
    Superscript,
    Subscript,
    Typography,
    FontSize,
    LineHeight,
    PageBreakNode,
    Link.configure({ openOnClick: false, autolink: true }),
    Image.configure({ allowBase64: true, inline: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ], []);

  const updateStatus = useCallback((html: string, pageCount: number) => {
    if (!statusRef.current) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const text  = tmp.innerText;
    const words = countWords(text);
    const chars = countChars(text);
    statusRef.current.textContent =
      `words: ${words.toLocaleString()}  ·  chars: ${chars.toLocaleString()}  ·  ${pageCount} page${pageCount !== 1 ? 's' : ''}  ·  ${pageSize.label}`;
  }, [pageSize]);

  const editor = useEditor({
    extensions,
    content: '',
    autofocus: true,
    editorProps: {
      attributes: {
        spellcheck: 'false',
      },
    },
    onUpdate({ editor: ed }) {
      const html = ed.getHTML();
      htmlRef.current = html;
      setDirty(true);

      // Debounced status update
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => {
        // Count pageBreak nodes in the ProseMirror doc for exact page count
        let breakCount = 0;
        ed.state.doc.forEach((node) => { if (node.type.name === 'pageBreak') breakCount++; });
        updateStatus(html, breakCount + 1);
      }, 300);

      // Debounced page break layout pass — only in page view
      if (!webView) {
        if (breakTimerRef.current) clearTimeout(breakTimerRef.current);
        breakTimerRef.current = setTimeout(() => {
          runPageBreakLayout(ed, pageSize.h, margins);
        }, 400);
      }
    },
  });

  // Create the paper <style> element once on mount; remove it on unmount.
  // Never query by ID — that races React's DOM reconciler (removeChild crash).
  useEffect(() => {
    const el = document.createElement('style');
    document.head.appendChild(el);
    styleElRef.current = el;
    return () => {
      el.remove();
      styleElRef.current = null;
    };
  }, []);

  // Update paper styles whenever page size, view mode, or margins change.
  useEffect(() => {
    if (styleElRef.current) {
      styleElRef.current.textContent = buildPaperCSS(webView ? null : pageSize, margins);
    }
  }, [pageSize, webView, margins]);

  const loadHtml = useCallback((html: string) => {
    htmlRef.current = html;
    editor?.commands.setContent(html, false);
    setDirty(false);
  }, [editor]);

  const applyBubbleLink = useCallback((url: string) => {
    if (!editor) return;
    if (url.trim()) {
      editor.chain().focus().setLink({ href: url.trim() }).run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    setBubbleLinkOpen(false);
    setBubbleLinkUrl('');
  }, [editor]);

  // Consume workspace open request — html is pre-converted by backend
  useEffect(() => {
    if (!joditPanelOpen || !openRequest || !editor) return;
    setOpenRequest(null);
    const { filename, content } = openRequest;
    setOrigName(filename); setConvertErr(null); setSavedPath(null);
    loadHtml(content);
  }, [joditPanelOpen, openRequest, setOpenRequest, loadHtml, editor]);

  const openFile = useCallback(async () => {
    try {
      const result = await fsaOpen();
      if (!result) return;
      const { filename, html } = result;
      setOrigName(filename); setConvertErr(null); setSavedPath(null);
      setConverting(true);
      loadHtml(html);
      setConverting(false);
    } catch (err) {
      setConverting(false);
      setSaveErr((err as Error).message);
    }
  }, [loadHtml]);

  const newFile = useCallback(() => {
    setOrigName('untitled.docx');
    loadHtml('');
    setConvertErr(null); setSaveErr(null); setSavedPath(null);
  }, [loadHtml]);

  const getCurrentHtml = useCallback((): string => {
    if (!editor) return htmlRef.current;
    // Strip pageBreak nodes from HTML before save/export
    const raw = editor.getHTML();
    const tmp = document.createElement('div');
    tmp.innerHTML = raw;
    tmp.querySelectorAll('[data-page-break]').forEach((el) => el.remove());
    return tmp.innerHTML;
  }, [editor]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const doSave = useCallback(async (forceSaveAs = false) => {
    if (!activeThreadId || saving) return;
    const html = getCurrentHtml();
    setSaving(true); setSaveErr(null);
    try {
      if (forceSaveAs || savedPath === null) {
        const result = await fsaSave(html, origName);
        if (!result) { setSaving(false); return; }
        const { chosenName } = result;
        const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: saveFilename(chosenName), content: html }),
        });
        if (!res.ok) throw new Error(`workspace HTTP ${res.status}`);
        setSavedPath(chosenName); setOrigName(chosenName); setDirty(false);
      } else {
        const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: saveFilename(savedPath), content: html }),
        });
        if (!res.ok) throw new Error(`workspace HTTP ${res.status}`);
        setDirty(false);
      }
    } catch (err) { setSaveErr((err as Error).message); }
    finally { setSaving(false); }
  }, [activeThreadId, saving, savedPath, origName, getCurrentHtml]);

  const onSavePointerDown  = useCallback(() => {
    saveHoldRef.current = setTimeout(() => { saveHoldRef.current = null; doSave(true); }, 500);
  }, [doSave]);
  const onSavePointerUp    = useCallback(() => {
    if (saveHoldRef.current) { clearTimeout(saveHoldRef.current); saveHoldRef.current = null; doSave(false); }
  }, [doSave]);
  const onSavePointerLeave = useCallback(() => {
    if (saveHoldRef.current) { clearTimeout(saveHoldRef.current); saveHoldRef.current = null; }
  }, []);

  const exportDocx = useCallback(async () => {
    try { triggerDownload(await htmlToDocx(getCurrentHtml()), origName.replace(/\.[^.]+$/, '') + '.docx'); }
    catch (err) { setSaveErr(`Export: ${(err as Error).message}`); }
  }, [getCurrentHtml, origName]);
  const exportMd = useCallback(async () => {
    try {
      const md = await htmlToMd(getCurrentHtml());
      triggerDownload(new Blob([md], { type: 'text/markdown' }), origName.replace(/\.[^.]+$/, '') + '.md');
    }
    catch (err) { setSaveErr(`Export: ${(err as Error).message}`); }
  }, [getCurrentHtml, origName]);
  const exportHtml = useCallback(() => {
    triggerDownload(new Blob([getCurrentHtml()], { type: 'text/html' }), origName.replace(/\.[^.]+$/, '') + '.html');
  }, [getCurrentHtml, origName]);

  // Ctrl+S
  useEffect(() => {
    if (!joditPanelOpen) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [joditPanelOpen, doSave]);

  // Escape
  useEffect(() => {
    if (!joditPanelOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exportOpen && !pageSizeOpen && !marginsOpen) toggleJoditPanel();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [joditPanelOpen, exportOpen, pageSizeOpen, marginsOpen, toggleJoditPanel]);

  // Re-run page break layout when page size or margins change
  useEffect(() => {
    if (editor && !webView) {
      requestAnimationFrame(() => runPageBreakLayout(editor, pageSize.h, margins));
    }
  }, [editor, pageSize, margins, webView]);

  return (
    <div className={`fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-background ${joditPanelOpen ? 'flex' : 'hidden'}`}>

      {/* ── Row 1: PHOBOS toolbar ──────────────────────────────────────────── */}
      <div className="phobos-jodit-toolbar flex items-center gap-1.5 px-3 h-11 border-b border-border bg-background shrink-0">

        <span className="text-[13px] font-terminal text-phobos-green/50 uppercase tracking-widest shrink-0">DOC</span>

        {editingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => { const name = draftName.trim() || origName; setOrigName(name); setEditingName(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { const name = draftName.trim() || origName; setOrigName(name); setEditingName(false); }
              if (e.key === 'Escape') { setDraftName(origName); setEditingName(false); }
            }}
            className="bg-transparent border-b border-phobos-green/40 text-[13px] font-mono text-muted-foreground/80 outline-none max-w-[260px] px-0.5"
          />
        ) : (
          <span
            className="text-[13px] font-mono text-muted-foreground/60 truncate max-w-[260px] cursor-text hover:text-muted-foreground/80 transition-colors"
            onDoubleClick={() => { setDraftName(origName); setEditingName(true); }}
            title="Double-click to rename"
          >
            {origName}{dirty && <span className="text-phobos-amber/60 ml-1">●</span>}
          </span>
        )}

        {saveErr && <span className="text-[9px] font-mono text-destructive/70 truncate max-w-[160px] shrink-0">{saveErr}</span>}

        <div className="flex-1" />

        {/* Page size picker */}
        <div className="relative">
          <button
            onClick={() => setPageSizeOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono border border-border/20 text-muted-foreground/40 hover:text-phobos-green hover:border-phobos-green/30 rounded-sm transition-all">
            {pageSize.label}
            <ChevronDown className={`w-2.5 h-2.5 transition-transform ${pageSizeOpen ? 'rotate-180' : ''}`} />
          </button>
          {pageSizeOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-phobos-green/20 rounded-sm shadow-xl min-w-[170px] overflow-hidden">
              {PAGE_SIZES.map((ps) => (
                <button key={ps.label} onClick={() => { setPageSize(ps); setPageSizeOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left flex items-center justify-between gap-4 transition-all ${pageSize.label === ps.label ? 'text-phobos-green bg-phobos-green/5' : 'text-muted-foreground/60 hover:text-phobos-green hover:bg-phobos-green/5'}`}>
                  <span className="text-[9px] font-mono">{ps.label}</span>
                  <span className="text-[8px] font-mono opacity-50">{ps.detail}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Margins picker */}
        <div className="relative">
          <button
            onClick={() => setMarginsOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border border-border/20 text-muted-foreground/40 hover:text-phobos-green hover:border-phobos-green/30 rounded-sm transition-all">
            ⊞ margins
            <ChevronDown className={`w-2.5 h-2.5 transition-transform ${marginsOpen ? 'rotate-180' : ''}`} />
          </button>
          {marginsOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-phobos-green/20 rounded-sm shadow-xl p-3 min-w-[200px]"
              onMouseDown={(e) => e.stopPropagation()}>
              <div className="text-[9px] font-mono text-muted-foreground/30 uppercase tracking-widest mb-2">Margins (inches)</div>
              {(['mt', 'mb', 'ml', 'mr'] as const).map((k) => {
                const labels: Record<string, string> = { mt: 'Top', mb: 'Bottom', ml: 'Left', mr: 'Right' };
                return (
                  <div key={k} className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-[10px] font-mono text-muted-foreground/50 w-12">{labels[k]}</span>
                    <input
                      type="number" min="0" max="4" step="0.25"
                      value={+(margins[k] / 96).toFixed(2)}
                      onChange={(e) => {
                        const px = Math.round(parseFloat(e.target.value) * 96);
                        if (!isNaN(px) && px >= 0) setMargins((m) => ({ ...m, [k]: px }));
                      }}
                      className="w-16 bg-background border border-border rounded-sm px-2 py-0.5 text-[10px] font-mono text-phobos-green/70 outline-none focus:border-phobos-green/40"
                    />
                    <span className="text-[9px] font-mono text-muted-foreground/20">in</span>
                  </div>
                );
              })}
              <button
                onClick={() => setMargins(DEFAULT_MARGINS)}
                className="mt-1 w-full text-[9px] font-mono text-muted-foreground/30 hover:text-phobos-green/60 transition-colors text-center">
                reset to default
              </button>
            </div>
          )}
        </div>

        {/* View mode toggle */}
        <div className="flex items-center border border-border rounded-sm overflow-hidden text-[11px] font-mono">
          <button
            onClick={() => setWebView(false)}
            className={`px-2 py-0.5 transition-all ${!webView ? 'bg-phobos-green/10 text-phobos-green border-r border-border' : 'text-muted-foreground/30 hover:text-muted-foreground/60 border-r border-border'}`}
            title="Page View">
            page view
          </button>
          <button
            onClick={() => setWebView(true)}
            className={`px-2 py-0.5 transition-all ${webView ? 'bg-phobos-green/10 text-phobos-green' : 'text-muted-foreground/30 hover:text-muted-foreground/60'}`}
            title="Web Layout">
            web layout
          </button>
        </div>

        {/* Open */}
        <button onClick={openFile} title="Open file…"
          className="p-1 text-muted-foreground/40 hover:text-phobos-green transition-colors">
          <FolderOpen className="w-3.5 h-3.5" />
        </button>

        {/* New */}
        <button onClick={newFile} title="New document"
          className="p-1 text-muted-foreground/40 hover:text-phobos-green transition-colors">
          <FilePlus className="w-3.5 h-3.5" />
        </button>

        {/* Export */}
        <div className="relative">
          <button onClick={() => setExportOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border border-border/20 text-muted-foreground/50 hover:text-phobos-green hover:border-phobos-green/30 rounded-sm transition-all">
            <FileDown className="w-3 h-3" />
            export
            <ChevronDown className={`w-2.5 h-2.5 transition-transform ${exportOpen ? 'rotate-180' : ''}`} />
          </button>
          {exportOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-phobos-green/20 rounded-sm shadow-xl min-w-[110px] overflow-hidden">
              {([
                ['.docx', exportDocx], ['.md', exportMd], ['.html', exportHtml],
              ] as [string, () => void][]).map(([label, action]) => (
                <button key={label} onClick={() => { action(); setExportOpen(false); }}
                  className="w-full px-3 py-2 text-left text-[10px] font-mono text-phobos-green/60 hover:text-phobos-green hover:bg-phobos-green/5 transition-all">
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Save */}
        <button
          onPointerDown={onSavePointerDown} onPointerUp={onSavePointerUp} onPointerLeave={onSavePointerLeave}
          disabled={saving || !activeThreadId}
          title="Save (Ctrl+S) · Hold for Save As…"
          className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono border rounded-sm transition-all disabled:opacity-40 border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 select-none">
          <Save className="w-3 h-3" />
          {saving ? 'saving…' : savedPath ? 'save' : 'save as…'}
        </button>

        <button onClick={toggleJoditPanel} title="Close (Esc)"
          className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors ml-1">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Row 2: DocToolbar ─────────────────────────────────────────────── */}
      <DocToolbar
        editor={editor}
        bubbleLinkOpen={bubbleLinkOpen}
        setBubbleLinkOpen={setBubbleLinkOpen}
        bubbleLinkUrl={bubbleLinkUrl}
        setBubbleLinkUrl={setBubbleLinkUrl}
        applyBubbleLink={applyBubbleLink}
      />

      {/* ── Content area ─────────────────────────────────────────────────── */}
      {/* Outer wrapper: position:relative so overlays can cover it absolutely. */}
      <div className="flex-1 min-h-0 relative">

        {/* Scroll container — EditorContent is its ONLY React child.
            ProseMirror mutates this div's children directly. React must never
            insert/remove siblings here, or insertBefore/removeChild will crash
            because ProseMirror has invalidated React's sibling anchors. */}
        <div
          className="absolute inset-0 overflow-y-auto"
          style={{
            background:     webView ? 'hsl(var(--background))' : 'hsl(var(--card))',
            display:        'flex',
            flexDirection:  'column',
            alignItems:     webView ? 'stretch' : 'center',
            padding:        webView ? '24px' : '40px 24px 60px',
            scrollbarWidth: 'thin',
            scrollbarColor: '#333 #1a1a1a',
          }}
        >
          <EditorContent editor={editor} />
        </div>

        {/* BubbleMenu portal — appendTo panel root so React owns full DOM lifecycle.
             Never gate on joditPanelOpen: toggling unmounts while Tippy still holds
             a body-appended node, causing React removeChild crash on close. */}
        {editor && (
          <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 120, placement: 'top', appendTo: 'parent' }}
            shouldShow={({ editor: ed, state }) => {
              const { empty } = state.selection;
              return !empty && !ed.isActive('pageBreak');
            }}
          >
            <div
              style={{
                display:        'flex',
                alignItems:     'center',
                gap:            2,
                background:     '#0a0c0f',
                border:         '1px solid #1e2433',
                borderRadius:   4,
                padding:        '3px 6px',
                boxShadow:      '0 4px 16px rgba(0,0,0,0.6)',
                zIndex:         9999,
              }}
            >
                  {/* Quick format buttons */}
                  {([
                    ['B',  () => editor.chain().focus().toggleBold().run(),      editor.isActive('bold')],
                    ['I',  () => editor.chain().focus().toggleItalic().run(),    editor.isActive('italic')],
                    ['U',  () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline')],
                    ['S',  () => editor.chain().focus().toggleStrike().run(),    editor.isActive('strike')],
                  ] as [string, () => void, boolean][]).map(([label, action, active]) => (
                    <button key={label}
                      onMouseDown={(e) => { e.preventDefault(); action(); }}
                      style={{
                        padding:      '2px 6px',
                        fontSize:     11,
                        fontFamily:   'monospace',
                        fontWeight:   label === 'B' ? 700 : 400,
                        fontStyle:    label === 'I' ? 'italic' : 'normal',
                        textDecoration: label === 'U' ? 'underline' : label === 'S' ? 'line-through' : 'none',
                        color:        active ? '#22c55e' : '#64748b',
                        background:   active ? '#22c55e11' : 'transparent',
                        border:       'none',
                        borderRadius: 2,
                        cursor:       'pointer',
                      }}
                    >{label}</button>
                  ))}

                  <span style={{ width: 1, height: 14, background: '#1e2433', margin: '0 3px' }} />

                  {/* Link input — inline, selection stays live */}
                  {!bubbleLinkOpen ? (
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setBubbleLinkUrl(editor.getAttributes('link').href ?? '');
                        setBubbleLinkOpen(true);
                      }}
                      style={{
                        padding:    '2px 6px',
                        fontSize:   11,
                        fontFamily: 'monospace',
                        color:      editor.isActive('link') ? '#22c55e' : '#64748b',
                        background: editor.isActive('link') ? '#22c55e11' : 'transparent',
                        border:     'none',
                        borderRadius: 2,
                        cursor:     'pointer',
                      }}
                    >🔗</button>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <input
                        autoFocus
                        type="url"
                        value={bubbleLinkUrl}
                        onChange={(e) => setBubbleLinkUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); applyBubbleLink(bubbleLinkUrl); }
                          if (e.key === 'Escape') { setBubbleLinkOpen(false); }
                        }}
                        placeholder="https://…"
                        style={{
                          width:        160,
                          background:   'hsl(var(--background))',
                          border:       '1px solid #22c55e44',
                          borderRadius: 2,
                          padding:      '2px 6px',
                          fontSize:     11,
                          fontFamily:   'monospace',
                          color:        '#4ade80',
                          outline:      'none',
                        }}
                      />
                      <button
                        onMouseDown={(e) => { e.preventDefault(); applyBubbleLink(bubbleLinkUrl); }}
                        style={{ padding: '2px 8px', fontSize: 10, fontFamily: 'monospace', background: '#22c55e22', border: '1px solid #22c55e44', borderRadius: 2, color: '#4ade80', cursor: 'pointer' }}
                      >↵</button>
                      {editor.isActive('link') && (
                        <button
                          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().unsetLink().run(); setBubbleLinkOpen(false); }}
                          style={{ padding: '2px 6px', fontSize: 10, fontFamily: 'monospace', background: 'transparent', border: '1px solid #1e2433', borderRadius: 2, color: '#64748b', cursor: 'pointer' }}
                        >✕</button>
                      )}
                    </div>
                  )}
                </div>
              </BubbleMenu>
          )}

        {/* Overlays — siblings of the scroll div, never siblings of ProseMirror nodes */}
        {converting && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
            <Loader2 className="w-8 h-8 text-phobos-green/40 animate-spin" />
            <span className="text-xs font-mono text-muted-foreground/40">Converting with pandoc WASM…</span>
            <span className="text-[10px] font-mono text-muted-foreground/20">first load downloads pandoc.wasm (~30 MB, then cached)</span>
          </div>
        )}
        {convertErr && !converting && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-background">
            <AlertTriangle className="w-8 h-8 text-destructive/50" />
            <span className="text-sm font-mono text-destructive/70">Conversion failed</span>
            <span className="text-xs font-mono text-muted-foreground/40 max-w-md text-center">{convertErr}</span>
            <button onClick={() => { setConvertErr(null); loadHtml(''); }}
              className="px-3 py-1.5 text-xs font-mono border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all">
              open blank instead
            </button>
          </div>
        )}
      </div>

      {/* ── Status bar ────────────────────────────────────────────────────── */}
      <div
        ref={statusRef}
        className="shrink-0 h-6 flex items-center px-4 border-t border-border bg-background text-[9px] font-mono text-muted-foreground/30 select-none"
      >
        words: 0  ·  chars: 0  ·  page 1 of 1  ·  {pageSize.label}
      </div>
    </div>
  );
}
