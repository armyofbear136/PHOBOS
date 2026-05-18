/**
 * CartridgeWizard.tsx — LLM Cartridge Training Wizard
 *
 * Modal wizard opened from CartridgesPanel "Train New Cartridge" button.
 * Four steps:
 *   1. Base — name, base model, persona, category, behavior
 *   2. Data  — data mode selection, dataset file upload
 *   3. Config — rank, steps (auto), lr, license, password
 *   4. Review — VRAM check + confirm → fires onStart(sessionId)
 *
 * onStart receives the created sessionId. The parent swaps to LmTrainingPanel.
 */

import { useState, useRef, useCallback } from 'react';
import {
  X, ChevronRight, ChevronLeft, Upload, FileText,
  Cpu, Zap, Lock, AlertTriangle, Loader2, CheckCircle2,
  FileCode, BookOpen, MessageSquare, Layers, FolderOpen, Files,
} from 'lucide-react';
import type {
  CartridgeCategory,
  CartridgePersona,
  CartridgeLicense,
} from './CartridgeTypes';
import { CATEGORY_LABELS, PERSONA_LABELS } from './CartridgeTypes';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Trainable model list (dense only — populated from backend spec) ────────────

const TRAINABLE_MODELS: Array<{ modelId: string; label: string; family: string; vramGb: number }> = [
  { modelId: 'qwen3.5-4b-q4',      label: 'Qwen 3.5 4B',       family: 'Qwen3.5',    vramGb: 5.5  },
  { modelId: 'qwen3.5-9b-q4',      label: 'Qwen 3.5 9B',       family: 'Qwen3.5',    vramGb: 9.0  },
  { modelId: 'qwen3.5-27b-q4',     label: 'Qwen 3.5 27B',      family: 'Qwen3.5',    vramGb: 18.0 },
  { modelId: 'gemma3-4b-q4',       label: 'Gemma 3 4B',        family: 'Gemma 3',    vramGb: 5.5  },
  { modelId: 'gemma3-12b-q4',      label: 'Gemma 3 12B',       family: 'Gemma 3',    vramGb: 11.0 },
  { modelId: 'gemma4-e4b-q4',      label: 'Gemma 4 E4B',       family: 'Gemma 4',    vramGb: 5.0  },
  { modelId: 'llama3.1-8b-q4',     label: 'Llama 3.1 8B',      family: 'Llama 3',    vramGb: 8.0  },
  { modelId: 'deepseek-r1-1.5b-q4', label: 'DeepSeek-R1 1.5B', family: 'DeepSeek-R1', vramGb: 2.5 },
  { modelId: 'deepseek-r1-8b-q4',  label: 'DeepSeek-R1 8B',    family: 'DeepSeek-R1', vramGb: 8.0 },
  { modelId: 'deepseek-r1-14b-q4', label: 'DeepSeek-R1 14B',   family: 'DeepSeek-R1', vramGb: 12.0 },
];

// ── Data mode ─────────────────────────────────────────────────────────────────

type LmDataMode = 'document' | 'conversation' | 'mixed';

const DATA_MODE_META: Record<LmDataMode, { icon: React.FC<{ className?: string }>; label: string; desc: string; formats: string }> = {
  document: {
    icon:    FileText,
    label:   'Document',
    desc:    'Train on text documents. Best for expertise and domain cartridges.',
    formats: '.md  .txt  .pdf  .py  .ts  .js  .json  .html',
  },
  conversation: {
    icon:    MessageSquare,
    label:   'Conversation',
    desc:    'Train on JSONL conversation pairs. Best for persona and style cartridges.',
    formats: '.jsonl  { "user": "…", "assistant": "…" }',
  },
  mixed: {
    icon:    Layers,
    label:   'Mixed',
    desc:    'Combine document and conversation datasets in one session.',
    formats: 'Both document files and .jsonl pairs',
  },
};

// ── Accepted file extensions per mode ─────────────────────────────────────────

function acceptForMode(mode: LmDataMode): string {
  const text = [
    '.md','.txt','.pdf','.py','.ts','.js','.json','.html','.htm',
    '.ahk','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd',
    '.lua','.rb','.go','.rs','.c','.cpp','.h','.hpp','.cs','.java',
    '.kt','.swift','.r','.m','.pl','.pm','.php','.sql',
    '.yaml','.yml','.toml','.ini','.cfg','.conf','.env','.log',
    '.csv','.xml','.rst','.tex','.org','.wiki','.adoc',
    '.nfo','.me','.readme','.license',
  ].join(',');
  if (mode === 'conversation') return '.jsonl';
  if (mode === 'document')     return text;
  return text + ',.jsonl';
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/80">
      {children}
    </span>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-black/40 border border-border/40 rounded-sm px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-phobos-green/30 transition-colors ${mono ? 'font-mono' : 'font-terminal'}`}
    />
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-black/40 border border-border/40 rounded-sm px-2.5 py-1.5 text-[13px] font-terminal text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-phobos-green/30 transition-colors resize-none leading-relaxed"
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={e => onChange(Number(e.target.value))}
      className="w-full bg-black/40 border border-border/40 rounded-sm px-2.5 py-1.5 text-[13px] font-mono text-foreground focus:outline-none focus:border-phobos-green/30 transition-colors"
    />
  );
}

// ── Step 1: Base ──────────────────────────────────────────────────────────────

interface BaseFields {
  name:            string;
  description:     string;
  author:          string;
  baseModelId:     string;
  targetPersona:   CartridgePersona;
  category:        CartridgeCategory;
  behaviorSummary: string;
  triggerContext:  string;
  tags:            string;
}

function StepBase({ fields, onChange }: { fields: BaseFields; onChange: (f: Partial<BaseFields>) => void }) {
  const categories: CartridgeCategory[] = ['expertise', 'persona', 'style', 'domain', 'task'];
  const personas:   CartridgePersona[]  = ['sayon', 'seren', 'both'];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <FieldGroup label="Cartridge Name">
          <TextInput value={fields.name} onChange={v => onChange({ name: v })} placeholder="My Expert Cartridge" />
        </FieldGroup>
        <FieldGroup label="Author">
          <TextInput value={fields.author} onChange={v => onChange({ author: v })} placeholder="local" />
        </FieldGroup>
      </div>

      <FieldGroup label="Description">
        <TextArea value={fields.description} onChange={v => onChange({ description: v })} placeholder="What does this cartridge do?" rows={2} />
      </FieldGroup>

      <FieldGroup label="Base Model">
        <select
          value={fields.baseModelId}
          onChange={e => onChange({ baseModelId: e.target.value })}
          className="w-full bg-black/40 border border-border/40 rounded-sm px-2.5 py-1.5 text-[13px] font-mono text-foreground focus:outline-none focus:border-phobos-green/30 transition-colors"
        >
          <option value="">— Select base model —</option>
          {TRAINABLE_MODELS.map(m => (
            <option key={m.modelId} value={m.modelId}>
              {m.label}  ·  {m.family}  ·  ~{m.vramGb} GB VRAM
            </option>
          ))}
        </select>
        <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">
          Training requires the model to be downloaded. The HF safetensors base will be cached separately.
        </p>
      </FieldGroup>

      <div className="grid grid-cols-2 gap-4">
        <FieldGroup label="Target Persona">
          <div className="flex border border-border/40 rounded-sm overflow-hidden">
            {personas.map((p, i) => (
              <button
                key={p}
                onClick={() => onChange({ targetPersona: p })}
                className={`flex-1 py-1.5 text-[12px] font-terminal uppercase tracking-[0.15em] transition-colors ${i < personas.length - 1 ? 'border-r border-border/40' : ''} ${
                  fields.targetPersona === p
                    ? p === 'sayon' ? 'bg-phobos-amber/10 text-phobos-amber'
                    : p === 'seren' ? 'bg-phobos-blue/10 text-phobos-blue'
                    : 'bg-phobos-green/10 text-phobos-green'
                    : 'text-muted-foreground/40 hover:text-muted-foreground/70'
                }`}
              >
                {PERSONA_LABELS[p]}
              </button>
            ))}
          </div>
        </FieldGroup>

        <FieldGroup label="Category">
          <select
            value={fields.category}
            onChange={e => onChange({ category: e.target.value as CartridgeCategory })}
            className="w-full bg-black/40 border border-border/40 rounded-sm px-2.5 py-1.5 text-[13px] font-terminal text-foreground focus:outline-none focus:border-phobos-green/30 transition-colors"
          >
            {categories.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </FieldGroup>
      </div>

      <FieldGroup label="Behavior Summary">
        <TextArea
          value={fields.behaviorSummary}
          onChange={v => onChange({ behaviorSummary: v })}
          placeholder="Describe how this cartridge changes the model's behavior, expertise, or persona…"
          rows={3}
        />
      </FieldGroup>

      <div className="grid grid-cols-2 gap-4">
        <FieldGroup label="Trigger Context (optional)">
          <TextInput
            value={fields.triggerContext}
            onChange={v => onChange({ triggerContext: v })}
            placeholder="When should this activate?"
          />
        </FieldGroup>
        <FieldGroup label="Tags (comma separated)">
          <TextInput
            value={fields.tags}
            onChange={v => onChange({ tags: v })}
            placeholder="medicine, diagnostics, clinical"
          />
        </FieldGroup>
      </div>
    </div>
  );
}

// ── Step 2: Data ──────────────────────────────────────────────────────────────

interface DataFields {
  dataMode: LmDataMode;
  files:    File[];
}

function StepData({
  fields,
  onChange,
  sessionId,
  onFileCountChange,
}: {
  fields:             DataFields;
  onChange:           (f: Partial<DataFields>) => void;
  sessionId:          string | null;
  onFileCountChange:  (count: number) => void;
}) {
  const fileRef       = useRef<HTMLInputElement>(null);
  const [uploading,   setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded,    setUploaded]    = useState<string[]>([]);
  const [dragOver,    setDragOver]    = useState(false);

  const refreshFileList = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset`);
      if (!r.ok) return;
      const d = await r.json() as { files: { name: string; sizeBytes: number }[] };
      setUploaded(d.files.map(f => f.name));
      onFileCountChange(d.files.length);
    } catch { /* non-fatal */ }
  }, [sessionId]);

  // Native OS multi-file picker — files copied server-side, no HTTP upload stream
  const pickFiles = useCallback(async () => {
    if (!sessionId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const r = await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/pick-files`,
        { method: 'POST' },
      );
      const d = await r.json() as { ok: boolean; copied: number; files: { name: string; sizeBytes: number }[] };
      if (!r.ok) throw new Error((d as unknown as { error?: string }).error ?? 'Pick failed');
      setUploaded(d.files.map(f => f.name));
      onFileCountChange(d.files.length);
      onChange({ files: [] }); // files field only used for count tracking — server owns the truth
    } catch (e) { setUploadError((e as Error).message); }
    setUploading(false);
  }, [sessionId, onChange]);

  // Native OS folder picker — all valid files in folder copied server-side
  const pickFolder = useCallback(async () => {
    if (!sessionId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const r = await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/pick-folder`,
        { method: 'POST' },
      );
      const d = await r.json() as { ok: boolean; copied: number; folderPath: string | null; files: { name: string; sizeBytes: number }[] };
      if (!r.ok) throw new Error((d as unknown as { error?: string }).error ?? 'Pick failed');
      setUploaded(d.files.map(f => f.name));
      onFileCountChange(d.files.length);
      onChange({ files: [] });
    } catch (e) { setUploadError((e as Error).message); }
    setUploading(false);
  }, [sessionId, onChange]);

  // Browser drop zone / file input — fallback for drag-and-drop
  const uploadFiles = useCallback(async (incoming: File[]) => {
    if (!sessionId || incoming.length === 0) return;
    setUploading(true);
    setUploadError(null);
    for (const file of incoming) {
      try {
        const buf = await file.arrayBuffer();
        const res = await fetch(
          `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset?filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf },
        );
        if (!res.ok) {
          const d = await res.json() as { error?: string };
          throw new Error(d.error ?? 'Upload failed');
        }
      } catch (e) { setUploadError((e as Error).message); }
    }
    await refreshFileList();
    setUploading(false);
  }, [sessionId, refreshFileList]);

  const removeFile = useCallback(async (name: string) => {
    if (!sessionId) return;
    try {
      await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
    } catch { /* best effort */ }
    setUploaded(prev => prev.filter(f => f !== name));
    onChange({ files: fields.files.filter(f => f.name !== name) });
  }, [sessionId, fields.files, onChange]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    uploadFiles(Array.from(e.dataTransfer.files));
  };

  const dataModes: LmDataMode[] = ['document', 'conversation', 'mixed'];

  return (
    <div className="space-y-5">
      {/* Mode selector */}
      <FieldGroup label="Training Data Mode">
        <div className="grid grid-cols-3 gap-2">
          {dataModes.map(mode => {
            const meta   = DATA_MODE_META[mode];
            const Icon   = meta.icon;
            const active = fields.dataMode === mode;
            return (
              <button
                key={mode}
                onClick={() => onChange({ dataMode: mode })}
                className={`p-3 rounded-sm border text-left space-y-1.5 transition-all ${
                  active
                    ? 'border-phobos-green/40 bg-phobos-green/5'
                    : 'border-border/30 bg-black/20 hover:border-border/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-phobos-green/70' : 'text-muted-foreground/30'}`} />
                <p className={`text-[10px] font-terminal uppercase tracking-[0.15em] ${active ? 'text-phobos-green/80' : 'text-muted-foreground/50'}`}>
                  {meta.label}
                </p>
                <p className="text-[11px] font-mono text-muted-foreground/65 leading-relaxed">{meta.desc}</p>
                <p className="text-[7px] font-mono text-muted-foreground/25 leading-relaxed">{meta.formats}</p>
              </button>
            );
          })}
        </div>
      </FieldGroup>

      {/* Dataset — native pickers (primary) + drop zone (fallback) */}
      <FieldGroup label="Dataset Files">
        {/* Native picker buttons */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            onClick={pickFiles}
            disabled={uploading}
            className="flex items-center justify-center gap-2 px-4 py-3 rounded-sm border border-phobos-green/30 bg-phobos-green/5 hover:bg-phobos-green/10 hover:border-phobos-green/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 text-phobos-green/60 animate-spin" />
            ) : (
              <Files className="w-4 h-4 text-phobos-green/60" />
            )}
            <span className="text-[10px] font-terminal text-phobos-green/70 uppercase tracking-[0.15em]">
              Pick Files
            </span>
          </button>
          <button
            onClick={pickFolder}
            disabled={uploading}
            className="flex items-center justify-center gap-2 px-4 py-3 rounded-sm border border-phobos-green/30 bg-phobos-green/5 hover:bg-phobos-green/10 hover:border-phobos-green/50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 text-phobos-green/60 animate-spin" />
            ) : (
              <FolderOpen className="w-4 h-4 text-phobos-green/60" />
            )}
            <span className="text-[10px] font-terminal text-phobos-green/70 uppercase tracking-[0.15em]">
              Pick Folder
            </span>
          </button>
        </div>

        {/* Drop zone — secondary fallback */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className={`cursor-pointer border rounded-sm p-4 flex flex-col items-center justify-center gap-2 transition-all ${
            dragOver
              ? 'border-phobos-green/50 bg-phobos-green/5'
              : 'border-dashed border-border/20 hover:border-border/40 bg-black/10'
          }`}
        >
          <Upload className="w-5 h-5 text-muted-foreground/15" />
          <p className="text-[9px] font-terminal text-muted-foreground/30 uppercase tracking-[0.15em]">
            {uploading ? 'Uploading…' : 'Or drag and drop files here'}
          </p>
          <p className="text-[9px] font-mono text-muted-foreground/25">
            {acceptForMode(fields.dataMode).split(',').join('  ')}
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={acceptForMode(fields.dataMode)}
          className="hidden"
          onChange={e => {
            const fs = e.target.files;
            if (fs && fs.length > 0) uploadFiles(Array.from(fs));
            e.target.value = '';
          }}
        />
      </FieldGroup>

      {/* Uploaded file list */}
      {uploaded.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-terminal uppercase tracking-[0.15em] text-phobos-green/60 mb-1">
            {uploaded.length} file{uploaded.length !== 1 ? 's' : ''} ready
          </p>
          {uploaded.map(name => (
            <div key={name} className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground/70 group">
              <CheckCircle2 className="w-3 h-3 text-phobos-green/50 shrink-0" />
              <span className="truncate flex-1">{name}</span>
              <button
                onClick={() => removeFile(name)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400/70 transition-all shrink-0"
                title="Remove file"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadError && (
        <div className="flex items-center gap-2 text-[11px] font-mono text-red-400/80">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {uploadError}
        </div>
      )}

      {/* Minimum requirements note */}
      <div className="border border-border/20 rounded-sm p-3 bg-black/20">
        <p className="text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/70 mb-1.5">Minimum requirements</p>
        <div className="space-y-0.5 text-[10px] font-mono text-muted-foreground/60">
          <p>Document mode — 50+ documents recommended</p>
          <p>Conversation mode — 100+ turns required</p>
          <p>Total training pairs are computed automatically after upload</p>
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Config ────────────────────────────────────────────────────────────

interface ConfigFields {
  rank:       number;
  steps:      number;  // 0 = auto
  lr:         number;
  license:    CartridgeLicense;
  password:   string;
  addLicense: boolean;
}

function StepConfig({ fields, onChange }: { fields: ConfigFields; onChange: (f: Partial<ConfigFields>) => void }) {
  const licenses: CartridgeLicense[] = ['personal', 'commercial', 'community'];
  const licenseLabels: Record<CartridgeLicense, string> = {
    personal:   'Personal',
    commercial: 'Commercial',
    community:  'Community',
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <FieldGroup label="LoRA Rank">
          <NumberInput value={fields.rank} onChange={v => onChange({ rank: v })} min={4} max={64} step={4} />
          <p className="text-[10px] font-mono text-muted-foreground/55 mt-1">4–64 · 16 recommended</p>
        </FieldGroup>
        <FieldGroup label="Training Steps">
          <NumberInput value={fields.steps} onChange={v => onChange({ steps: v })} min={0} max={8000} step={100} />
          <p className="text-[10px] font-mono text-muted-foreground/55 mt-1">0 = auto from dataset size</p>
        </FieldGroup>
        <FieldGroup label="Learning Rate">
          <NumberInput value={fields.lr} onChange={v => onChange({ lr: v })} min={1e-5} max={1e-3} step={1e-5} />
          <p className="text-[10px] font-mono text-muted-foreground/55 mt-1">2e-4 default</p>
        </FieldGroup>
      </div>

      <FieldGroup label="License">
        <div className="flex border border-border/40 rounded-sm overflow-hidden">
          {licenses.map((l, i) => (
            <button
              key={l}
              onClick={() => onChange({ license: l })}
              className={`flex-1 py-1.5 text-[12px] font-terminal uppercase tracking-[0.15em] transition-colors ${i < licenses.length - 1 ? 'border-r border-border/40' : ''} ${
                fields.license === l
                  ? 'bg-phobos-green/10 text-phobos-green/80'
                  : 'text-muted-foreground/40 hover:text-muted-foreground/70'
              }`}
            >
              {licenseLabels[l]}
            </button>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup label="Password">
        <div className="relative">
          <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/25" />
          <input
            type="password"
            value={fields.password}
            onChange={e => onChange({ password: e.target.value })}
            placeholder="Leave empty for open cartridge"
            className="w-full bg-black/40 border border-border/40 rounded-sm pl-7 pr-2.5 py-1.5 text-[13px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-phobos-green/30 transition-colors"
          />
        </div>
        <p className="text-[10px] font-mono text-muted-foreground/55 mt-1">
          Password-protects the cartridge. Recipients must enter it to load.
        </p>
      </FieldGroup>

      <label className="flex items-center gap-2.5 cursor-pointer">
        <div
          onClick={() => onChange({ addLicense: !fields.addLicense })}
          className={`w-4 h-4 rounded-sm border flex items-center justify-center transition-colors ${
            fields.addLicense ? 'border-phobos-green/50 bg-phobos-green/10' : 'border-border/40'
          }`}
        >
          {fields.addLicense && <CheckCircle2 className="w-2.5 h-2.5 text-phobos-green/70" />}
        </div>
        <span className="text-[11px] font-terminal text-muted-foreground/75">
          Embed license text in cartridge archive
        </span>
      </label>
    </div>
  );
}

// ── Step 4: Review + VRAM check ───────────────────────────────────────────────

interface VramCheck {
  ok:          boolean;
  requiredGb:  number;
  freeGb:      number;
  totalGb:     number;
  device:      string;
  message:     string;
}

function StepReview({
  baseFields,
  dataFields,
  configFields,
  vram,
  checkingVram,
  fileCount,
}: {
  baseFields:   BaseFields;
  dataFields:   DataFields;
  configFields: ConfigFields;
  vram:         VramCheck | null;
  checkingVram: boolean;
  fileCount:    number;
}) {
  const model = TRAINABLE_MODELS.find(m => m.modelId === baseFields.baseModelId);

  return (
    <div className="space-y-4">
      {/* Summary card */}
      <div className="border border-border/30 rounded-sm divide-y divide-border/20">
        <Row label="Cartridge"    value={baseFields.name || '—'} />
        <Row label="Base Model"   value={model?.label ?? baseFields.baseModelId} />
        <Row label="Persona"      value={PERSONA_LABELS[baseFields.targetPersona]} />
        <Row label="Category"     value={CATEGORY_LABELS[baseFields.category]} />
        <Row label="Data Mode"    value={DATA_MODE_META[dataFields.dataMode].label} />
        <Row label="Files"        value={`${fileCount} uploaded`} />
        <Row label="LoRA Rank"    value={String(configFields.rank)} />
        <Row label="Steps"        value={configFields.steps === 0 ? 'Auto' : String(configFields.steps)} />
        <Row label="License"      value={configFields.license} />
        <Row label="Protected"    value={configFields.password ? 'Yes' : 'No'} />
      </div>

      {/* VRAM check */}
      <div className={`border rounded-sm p-3 flex items-start gap-3 ${
        checkingVram ? 'border-border/30' :
        vram?.ok     ? 'border-phobos-green/30 bg-phobos-green/5' :
                       'border-red-900/30 bg-red-950/10'
      }`}>
        {checkingVram ? (
          <Loader2 className="w-4 h-4 text-muted-foreground/30 animate-spin shrink-0 mt-0.5" />
        ) : vram?.ok ? (
          <CheckCircle2 className="w-4 h-4 text-phobos-green/60 shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-red-400/60 shrink-0 mt-0.5" />
        )}
        <div>
          <p className="text-[11px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/80 mb-0.5">VRAM Check</p>
          <p className="text-[12px] font-mono text-foreground/90">
            {checkingVram ? 'Checking GPU memory…' : (vram?.message ?? 'Unknown')}
          </p>
          {vram && !checkingVram && (
            <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">
              {vram.device}  ·  {vram.totalGb} GB total  ·  {vram.requiredGb} GB required
            </p>
          )}
        </div>
      </div>

      {/* Training time estimate */}
      {model && configFields.steps > 0 && (
        <div className="text-[10px] font-mono text-muted-foreground/60 border border-border/20 rounded-sm p-2.5 bg-black/20">
          Estimated training time: {_estimateMinutes(model.vramGb, configFields.steps)} min on a capable GPU · HF base model download will add time on first run
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/70">{label}</span>
      <span className="text-[12px] font-mono text-foreground/90">{value}</span>
    </div>
  );
}

function _estimateMinutes(vramGb: number, steps: number): string {
  // Very rough: ~1s per step at 4 GB, ~0.5s at 10+ GB (GPU throughput)
  const secPerStep = vramGb >= 10 ? 0.5 : vramGb >= 6 ? 0.8 : 1.2;
  const mins       = Math.ceil((steps * secPerStep) / 60);
  return mins < 60 ? `${mins}` : `${Math.round(mins / 6) / 10}h`;
}

// ── Wizard shell ──────────────────────────────────────────────────────────────

interface CartridgeWizardProps {
  onClose:  () => void;
  onStart:  (sessionId: string) => void;
}

const STEPS = ['Base', 'Data', 'Config', 'Review'] as const;

export function CartridgeWizard({ onClose, onStart }: CartridgeWizardProps) {
  const [step, setStep]       = useState(0);
  const [submitting, setSub]  = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Created session ID (after step 1 POST, before run)
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [base, setBase] = useState<BaseFields>({
    name:            '',
    description:     '',
    author:          'local',
    baseModelId:     '',
    targetPersona:   'seren',
    category:        'expertise',
    behaviorSummary: '',
    triggerContext:  '',
    tags:            '',
  });

  const [data, setData] = useState<DataFields>({
    dataMode: 'document',
    files:    [],
  });
  const [serverFileCount, setServerFileCount] = useState(0);

  const [config, setConfig] = useState<ConfigFields>({
    rank:       16,
    steps:      0,
    lr:         2e-4,
    license:    'personal',
    password:   '',
    addLicense: false,
  });

  const [vram,         setVram]         = useState<VramCheck | null>(null);
  const [checkingVram, setCheckingVram] = useState(false);

  // ── Step validation ────────────────────────────────────────────────────────

  function canAdvance(): boolean {
    if (step === 0) return !!base.name && !!base.baseModelId && !!base.behaviorSummary;
    if (step === 1) return data.files.length > 0 || serverFileCount > 0;
    if (step === 2) return config.rank >= 4 && config.rank <= 64;
    return true;
  }

  // ── Next step handler ──────────────────────────────────────────────────────

  async function handleNext() {
    setError(null);

    // After step 0: create the session on the backend so we have a sessionId
    // for the dataset upload endpoint on step 1.
    if (step === 0 && !sessionId) {
      setSub(true);
      try {
        const res = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            name:            base.name,
            description:     base.description,
            author:          base.author,
            baseModelId:     base.baseModelId,
            targetPersona:   base.targetPersona,
            category:        base.category,
            behaviorSummary: base.behaviorSummary,
            triggerContext:  base.triggerContext || null,
            tags:            base.tags.split(',').map(t => t.trim()).filter(Boolean),
            license:         config.license,
            password:        config.password,
            addLicense:      config.addLicense,
            dataMode:        data.dataMode,
            rank:            config.rank,
            steps:           config.steps,
            lr:              config.lr,
          }),
        });
        const body = await res.json() as { session_id?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? 'Failed to create session');
        setSessionId(body.session_id!);
        setStep(1);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSub(false);
      }
      return;
    }

    // Step 3: trigger VRAM check before showing review
    if (step === 2) {
      setStep(3);
      setCheckingVram(true);
      try {
        const res = await fetch(
          `${ENGINE_URL}/api/phobos/training/lm/vram-check?baseModelId=${encodeURIComponent(base.baseModelId)}&rank=${config.rank}`,
        );
        if (res.ok) setVram(await res.json() as VramCheck);
      } catch { /* non-fatal */ } finally {
        setCheckingVram(false);
      }
      return;
    }

    setStep(s => s + 1);
  }

  // ── Start training ─────────────────────────────────────────────────────────

  async function handleStart() {
    if (!sessionId) return;
    setError(null);
    setSub(true);
    try {
      // Update config fields that weren't part of the initial POST
      // (rank/steps/lr/license/password may have changed in step 3)
      await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/config`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          rank:       config.rank,
          steps:      config.steps,
          lr:         config.lr,
          license:    config.license,
          password:   config.password,
          addLicense: config.addLicense,
        }),
      });
    } catch { /* config patch is best-effort — session was created with initial values */ }
    setSub(false);
    onStart(sessionId);
  }

  // ── Step indicators ────────────────────────────────────────────────────────

  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[620px] max-h-[88vh] flex flex-col bg-background border border-phobos-green/20 rounded-sm shadow-[0_0_60px_hsl(120_100%_50%/0.05)]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-phobos-green/10 shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-phobos-green/60" />
            <span className="text-[11px] font-terminal uppercase tracking-[0.2em] text-phobos-green/80">Train Cartridge</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step breadcrumb */}
        <div className="flex items-center gap-0 px-5 py-2 border-b border-border/20 shrink-0">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center">
              <span className={`text-[11px] font-terminal uppercase tracking-[0.2em] transition-colors ${
                i === step         ? 'text-phobos-green/80' :
                i < step           ? 'text-muted-foreground/40' :
                                     'text-muted-foreground/20'
              }`}>
                {i < step && <span className="mr-1 text-phobos-green/50">✓</span>}
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <ChevronRight className="w-3 h-3 text-border/30 mx-2" />
              )}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
          {step === 0 && <StepBase fields={base} onChange={f => setBase(b => ({ ...b, ...f }))} />}
          {step === 1 && (
            <StepData
              fields={data}
              onChange={f => setData(d => ({ ...d, ...f }))}
              sessionId={sessionId}
              onFileCountChange={setServerFileCount}
            />
          )}
          {step === 2 && <StepConfig fields={config} onChange={f => setConfig(c => ({ ...c, ...f }))} />}
          {step === 3 && (
            <StepReview
              baseFields={base}
              dataFields={data}
              configFields={config}
              vram={vram}
              checkingVram={checkingVram}
              fileCount={Math.max(data.files.length, serverFileCount)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border/20 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                disabled={submitting}
                className="flex items-center gap-1 px-3 py-1.5 text-[12px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/70 border border-border/30 rounded-sm hover:border-border/60 hover:text-muted-foreground/80 transition-all disabled:opacity-40"
              >
                <ChevronLeft className="w-3 h-3" /> Back
              </button>
            )}
            {error && (
              <span className="text-[11px] font-mono text-red-400/90">{error}</span>
            )}
          </div>

          {isLast ? (
            <button
              onClick={handleStart}
              disabled={submitting || checkingVram}
              className="flex items-center gap-1.5 px-5 py-1.5 text-[12px] font-terminal uppercase tracking-[0.2em] text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_16px_hsl(120_100%_50%/0.1)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              Start Training
            </button>
          ) : (
            <button
              onClick={handleNext}
              disabled={!canAdvance() || submitting}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-terminal uppercase tracking-[0.2em] text-phobos-green/80 border border-phobos-green/20 rounded-sm hover:border-phobos-green/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {step === 0 ? 'Continue' : 'Next'}
              {!submitting && <ChevronRight className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
