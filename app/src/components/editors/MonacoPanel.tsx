/**
 * MonacoPanel.tsx — Fullscreen code editor panel.
 *
 * CREATE → Text → Code
 *
 * Ships as a static npm dependency (@monaco-editor/react). No port, no process,
 * no backend involvement. The loader resolves Monaco workers from the bundled
 * copy at /monaco/vs (populated by the build script that copies
 * node_modules/monaco-editor/min/vs → public/monaco/vs).
 *
 * File I/O: reads/writes the active thread's workspace via the existing
 * /api/threads/:threadId/workspace endpoints. New files are created with a
 * generated name; open files are passed in via openRequest from WorkspacePanel.
 *
 * Theme: matches PHOBOS dark palette exactly. Cursor is phobos-green (#4ade80).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { X, Save, FilePlus, FolderOpen, ChevronDown, Check } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';

// ── Local Monaco worker path — swap to CDN/mirror URL when ready ──────────────
loader.config({ paths: { vs: `${window.location.origin}${import.meta.env.BASE_URL}monaco/vs` } });

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const PHOBOS_THEME_ID = 'phobos-dark';

// Language → file extension map for new file creation
const LANG_EXT: Record<string, string> = {
  typescript:  'ts',
  javascript:  'js',
  python:      'py',
  rust:        'rs',
  go:          'go',
  markdown:    'md',
  json:        'json',
  css:         'css',
  html:        'html',
  shell:       'sh',
  gdscript:    'gd',
  csharp:      'cs',
  plaintext:   'txt',
  lua:         'lua',
  yaml:        'yaml',
  toml:        'toml',
};

const LANG_OPTIONS = Object.keys(LANG_EXT).map((lang) => ({
  lang,
  ext: LANG_EXT[lang],
  label: lang.charAt(0).toUpperCase() + lang.slice(1),
}));

// Infer language from filename extension
function langFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const match = Object.entries(LANG_EXT).find(([, e]) => e === ext);
  return match ? match[0] : 'plaintext';
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function MonacoPanel() {
  const monacoPanelOpen    = useAppStore((s) => s.monacoPanelOpen);
  const toggleMonacoPanel  = useAppStore((s) => s.toggleMonacoPanel);
  const activeThreadId     = useAppStore((s) => s.activeThreadId);
  const openRequest        = useAppStore((s) => s.monacoOpenRequest);
  const setOpenRequest     = useAppStore((s) => s.setMonacoOpenRequest);

  const editorRef  = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const themeReady = useRef(false);

  const [filename,  setFilename]  = useState<string>('untitled.ts');
  const [language,  setLanguage]  = useState<string>('typescript');
  const [content,   setContent]   = useState<string>('');
  const [dirty,     setDirty]     = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [saveErr,   setSaveErr]   = useState<string | null>(null);
  const [langOpen,  setLangOpen]  = useState(false);

  // ── Theme definition (runs once Monaco is loaded) ─────────────────────────

  const defineTheme = useCallback((monaco: Monaco) => {
    if (themeReady.current) return;
    monaco.editor.defineTheme(PHOBOS_THEME_ID, {
      base:    'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment',     foreground: '4a5568', fontStyle: 'italic' },
        { token: 'keyword',     foreground: '63b3ed' },
        { token: 'string',      foreground: '68d391' },
        { token: 'number',      foreground: 'f6ad55' },
        { token: 'type',        foreground: 'b794f4' },
        { token: 'identifier',  foreground: 'e2e8f0' },
      ],
      colors: {
        'editor.background':              '#080808',
        'editor.foreground':              '#e8e8d8',
        'editorCursor.foreground':        '#e8420a',
        'editor.lineHighlightBackground': '#0f0f0a',
        'editor.selectionBackground':     '#2a1008',
        'editorLineNumber.foreground':    '#333328',
        'editorLineNumber.activeForeground': '#555548',
        'editor.inactiveSelectionBackground': '#1a0d06',
        'editorIndentGuide.background1': '#1a1a12',
        'editorWidget.background':        '#0f0f0a',
        'editorWidget.border':            '#2a1a08',
        'input.background':               '#080808',
        'input.foreground':               '#e8e8d8',
        'scrollbar.shadow':               '#00000000',
        'scrollbarSlider.background':     '#ffffff10',
        'scrollbarSlider.hoverBackground':'#ffffff18',
        'scrollbarSlider.activeBackground':'#e8420a30',
        'minimap.background':             '#0a0c0f',
      },
    });
    monaco.editor.setTheme(PHOBOS_THEME_ID);
    themeReady.current = true;
  }, []);

  // ── Consume open request from workspace file click ────────────────────────

  useEffect(() => {
    if (!monacoPanelOpen || !openRequest) return;
    setFilename(openRequest.filename);
    setLanguage(openRequest.language ?? langFromFilename(openRequest.filename));
    setContent(openRequest.content);
    setDirty(false);
    setSaveErr(null);
    setOpenRequest(null);
    editorRef.current?.setValue(openRequest.content);
  }, [monacoPanelOpen, openRequest, setOpenRequest]);

  // ── New file ──────────────────────────────────────────────────────────────

  const [savedPath,  setSavedPath]  = useState<string | null>(null);
  const saveHoldRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFSA = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  const newFile = useCallback(() => {
    const ext  = LANG_EXT[language] ?? 'txt';
    const name = `untitled-${Date.now()}.${ext}`;
    setFilename(name);
    setContent('');
    setDirty(false);
    setSaveErr(null);
    editorRef.current?.setValue('');
  }, [language]);

  // ── Save ──────────────────────────────────────────────────────────────────

  const save = useCallback(async (forceSaveAs = false) => {
    if (!activeThreadId || saving) return;
    const value = editorRef.current?.getValue() ?? content;
    setSaving(true); setSaveErr(null);
    try {
      if ((forceSaveAs || savedPath === null) && hasFSA) {
        const ext = LANG_EXT[language] ?? 'txt';
        const handle = await (window as unknown as {
          showSaveFilePicker: (o: object) => Promise<{ name: string; createWritable: () => Promise<{ write: (s: string) => Promise<void>; close: () => Promise<void> }> }>;
        }).showSaveFilePicker({
          suggestedName: filename || `untitled.${ext}`,
          id: 'phobosCode',
          startIn: 'documents',
          types: [{ description: 'Code File', accept: { 'text/plain': Object.values(LANG_EXT).map((e) => `.${e}` as `.${string}`) } }],
        }).catch((err: Error) => { if (err.name === 'AbortError') return null; throw err; });
        if (!handle) { setSaving(false); return; }
        const w = await handle.createWritable();
        await w.write(value); await w.close();
        setFilename(handle.name);
        setLanguage(langFromFilename(handle.name));
        setSavedPath(handle.name);
        setDirty(false);
      } else {
        // Workspace save (always — even after FSA save, index in workspace too)
        const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workspace`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, content: value }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSavedPath(filename);
        setDirty(false);
      }
    } catch (err) {
      setSaveErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [activeThreadId, content, filename, language, hasFSA, savedPath, saving]);

  const openFile = useCallback(async () => {
    try {
      if (hasFSA) {
        const [handle] = await (window as unknown as {
          showOpenFilePicker: (o: object) => Promise<Array<{ name: string; getFile: () => Promise<File> }>>;
        }).showOpenFilePicker({
          id: 'phobosCode', startIn: 'documents', multiple: false,
          types: [{ description: 'Code & Text', accept: { 'text/plain': Object.values(LANG_EXT).map((e) => `.${e}` as `.${string}`) } }],
        });
        const file = await handle.getFile();
        const text = await file.text();
        setFilename(file.name);
        setLanguage(langFromFilename(file.name));
        setContent(text);
        setSavedPath(file.name);
        setDirty(false);
        editorRef.current?.setValue(text);
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = Object.values(LANG_EXT).map((e) => `.${e}`).join(',');
        input.onchange = async () => {
          const file = input.files?.[0]; if (!file) return;
          const text = await file.text();
          setFilename(file.name); setLanguage(langFromFilename(file.name));
          setContent(text); setSavedPath(file.name); setDirty(false);
          editorRef.current?.setValue(text);
        };
        input.click();
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setSaveErr((err as Error).message);
    }
  }, [hasFSA]);

  const onSavePointerDown = useCallback(() => {
    saveHoldRef.current = setTimeout(() => { saveHoldRef.current = null; save(true); }, 500);
  }, [save]);
  const onSavePointerUp = useCallback(() => {
    if (saveHoldRef.current) { clearTimeout(saveHoldRef.current); saveHoldRef.current = null; save(false); }
  }, [save]);
  const onSavePointerLeave = useCallback(() => {
    if (saveHoldRef.current) { clearTimeout(saveHoldRef.current); saveHoldRef.current = null; }
  }, []);

  // Ctrl/Cmd+S
  useEffect(() => {
    if (!monacoPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [monacoPanelOpen, save]);

  // Escape to close (only when no language dropdown is open)
  useEffect(() => {
    if (!monacoPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !langOpen) toggleMonacoPanel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [monacoPanelOpen, langOpen, toggleMonacoPanel]);

  // Re-layout the editor when the panel becomes visible — required after CSS hide/show
  useEffect(() => {
    if (monacoPanelOpen) editorRef.current?.layout();
  }, [monacoPanelOpen]);

  return (
    <div className={`fixed inset-x-0 bottom-0 top-10 z-40 flex flex-col bg-[#080808] ${monacoPanelOpen ? 'flex' : 'hidden'}`}>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-phob-orange/20 bg-[#080808] shrink-0">

        {/* Filename */}
        <input
          value={filename}
          onChange={(e) => { setFilename(e.target.value); setDirty(true); }}
          className="flex-1 min-w-0 bg-transparent text-xs font-mono text-phob-white/75 focus:outline-none focus:text-phob-white transition-colors"
          spellCheck={false}
        />

        {dirty && (
          <span className="text-[10px] font-mono text-phob-amber/60 shrink-0">unsaved</span>
        )}

        {saveErr && (
          <span className="text-[10px] font-mono text-destructive/70 shrink-0">{saveErr}</span>
        )}

        {/* Language picker */}
        <div className="relative shrink-0">
          <button
            onClick={() => setLangOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-phob-orange/55 hover:text-phob-orange border border-phob-orange/15 hover:border-phob-orange/30 transition-all"
          >
            {language}
            <ChevronDown className={`w-2.5 h-2.5 transition-transform ${langOpen ? 'rotate-180' : ''}`} />
          </button>
          {langOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-[#0f0f0a] border border-phob-orange/20 shadow-xl max-h-64 overflow-y-auto min-w-[130px]">
              {LANG_OPTIONS.map((opt) => (
                <button
                  key={opt.lang}
                  onClick={() => {
                    setLanguage(opt.lang);
                    // Update filename extension if it matches current extension
                    const currentExt = filename.split('.').pop();
                    if (currentExt && Object.values(LANG_EXT).includes(currentExt)) {
                      setFilename(filename.replace(/\.[^.]+$/, `.${opt.ext}`));
                    }
                    setLangOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[10px] font-mono hover:bg-phob-orange/8 transition-colors"
                >
                  {opt.lang === language
                    ? <Check className="w-2.5 h-2.5 text-phob-orange shrink-0" />
                    : <span className="w-2.5 shrink-0" />
                  }
                  <span className={opt.lang === language ? 'text-phob-orange' : 'text-phob-steel/60'}>
                    {opt.label}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* New file */}
        <button
          onClick={newFile}
          title="New file"
          className="p-1 text-phob-steel/45 hover:text-phob-orange transition-colors"
        >
          <FilePlus className="w-3.5 h-3.5" />
        </button>

        {/* Save */}
        <button
          onClick={() => save(false)}
          disabled={saving || !activeThreadId}
          title="Save (Ctrl+S)"
          className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono border rounded-sm transition-all disabled:opacity-40
            border-phob-orange/30 text-phob-orange/70 hover:text-phob-orange hover:border-phob-orange/50"
        >
          <Save className="w-3 h-3" />
          {saving ? 'saving…' : 'save'}
        </button>

        {/* Close */}
        <button
          onClick={toggleMonacoPanel}
          title="Close (Esc)"
          className="p-1 text-phob-steel/40 hover:text-phob-white transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Editor surface ───────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme={PHOBOS_THEME_ID}
          beforeMount={defineTheme}
          onMount={(editor, monaco) => {
            editorRef.current  = editor;
            defineTheme(monaco);
            editor.focus();
          }}
          onChange={(val) => {
            setContent(val ?? '');
            setDirty(true);
          }}
          options={{
            fontSize:              13,
            fontFamily:            "'Share Tech Mono', 'Fira Code', monospace",
            fontLigatures:         true,
            lineHeight:            20,
            minimap:               { enabled: true, scale: 1 },
            scrollBeyondLastLine:  false,
            smoothScrolling:       true,
            cursorBlinking:        'phase',
            cursorSmoothCaretAnimation: 'on',
            renderWhitespace:      'selection',
            bracketPairColorization: { enabled: true },
            guides: {
              bracketPairs:        true,
              indentation:         true,
            },
            padding:               { top: 12, bottom: 12 },
            scrollbar: {
              verticalScrollbarSize:   6,
              horizontalScrollbarSize: 6,
            },
            wordWrap:              'on',
            tabSize:               2,
            insertSpaces:          true,
            formatOnPaste:         true,
            formatOnType:          false,
            automaticLayout:       true,
          }}
        />
      </div>
    </div>
  );
}
