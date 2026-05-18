/**
 * WeclonePanel.tsx — Digital Clone creation and management.
 *
 * Completely separate from CartridgesPanel. Clone cartridges (category='weclone')
 * never appear in the Cortex Cartridges list — they live here exclusively.
 *
 * Four states driven by profile + cartridge status:
 *   'setup'     — no clone exists yet; 2-step wizard (model → data)
 *   'training'  — LmTrainingPanel running live
 *   'configure' — post-training profile editor (system prompt, personality)
 *   'active'    — clone exists and is configured; dashboard view
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Cpu, Upload, Trash2, CheckCircle2, AlertTriangle,
  Loader2, ChevronRight, ChevronLeft, Zap, Edit3,
  Smartphone, FileText, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { LmTrainingPanel } from './LmTrainingPanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Trainable models — same list as CartridgeWizard ──────────────────────────

const TRAINABLE_MODELS = [
  { modelId: 'deepseek-r1-1.5b-q4', label: 'DeepSeek-R1 1.5B', family: 'DeepSeek-R1', vramGb: 2.5  },
  { modelId: 'qwen3.5-4b-q4',       label: 'Qwen 3.5 4B',       family: 'Qwen3.5',    vramGb: 5.5  },
  { modelId: 'gemma4-e4b-q4',       label: 'Gemma 4 E4B',       family: 'Gemma 4',    vramGb: 5.0  },
  { modelId: 'gemma3-4b-q4',        label: 'Gemma 3 4B',        family: 'Gemma 3',    vramGb: 5.5  },
  { modelId: 'qwen3.5-9b-q4',       label: 'Qwen 3.5 9B',       family: 'Qwen3.5',    vramGb: 9.0  },
  { modelId: 'llama3.1-8b-q4',      label: 'Llama 3.1 8B',      family: 'Llama 3',    vramGb: 8.0  },
  { modelId: 'deepseek-r1-8b-q4',   label: 'DeepSeek-R1 8B',    family: 'DeepSeek-R1', vramGb: 8.0 },
  { modelId: 'gemma3-12b-q4',       label: 'Gemma 3 12B',       family: 'Gemma 3',    vramGb: 11.0 },
  { modelId: 'deepseek-r1-14b-q4',  label: 'DeepSeek-R1 14B',   family: 'DeepSeek-R1', vramGb: 12.0 },
  { modelId: 'qwen3.5-27b-q4',      label: 'Qwen 3.5 27B',      family: 'Qwen3.5',    vramGb: 18.0 },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface SlotInfo {
  persona:   'sayon' | 'seren';
  label:     string;
  device:    string;
  vramGb:    number;
  backend:   string;
  available: boolean;
}

interface UploadedFile {
  name:      string;
  sizeBytes: number;
}

interface WecloneProfile {
  id:                 string;
  cartridge_id:       string | null;
  slot:               'sayon' | 'seren';
  display_name:       string;
  pronouns:           string;
  communication_style: string;
  love_topics:        string;   // JSON array
  avoid_topics:       string;   // JSON array
  humor_style:        string;
  response_length:    number;
  formality:          number;
  first_person:       boolean;
  context_summary:    string;
  limits_summary:     string;
  temperature:        number;
  top_p:              number;
  context_window:     number;
  system_prompt:      string;
  published:          boolean;
  created_at:         string;
  updated_at:         string;
}

interface CloneStatus {
  hasProfile:      boolean;
  hasCartridge:    boolean;
  cartridgeActive: boolean;
  slot:            'sayon' | 'seren' | null;
  profile:         WecloneProfile | null;
  cartridgeName:   string | null;
  trainedAt:       string | null;
  turnCount:       number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function buildSystemPrompt(p: {
  displayName: string; pronouns: string; communicationStyle: string;
  loveTopics: string[]; avoidTopics: string[]; humorStyle: string;
  responseLength: number; formality: number; firstPerson: boolean;
  contextSummary: string; limitsSummary: string;
}): string {
  const lengthWord  = p.responseLength < 0.4 ? 'concise' : p.responseLength > 0.7 ? 'detailed' : 'balanced';
  const formalWord  = p.formality < 0.35 ? 'casually' : p.formality > 0.65 ? 'professionally' : 'naturally';
  const voiceClause = p.firstPerson ? `Speak in first person as ${p.displayName}.` : `Describe ${p.displayName} in third person.`;
  const humorClause = p.humorStyle !== 'None' ? ` Your humor is ${p.humorStyle.toLowerCase()}.` : '';
  const loveClause  = p.loveTopics.length  ? `\nTopics to engage freely: ${p.loveTopics.join(', ')}.` : '';
  const avoidClause = p.avoidTopics.length ? `\nTopics to deflect or avoid: ${p.avoidTopics.join(', ')}.` : '';
  const limitsClause = p.limitsSummary ? `\nLimits: ${p.limitsSummary}` : '';

  return `You are ${p.displayName}'s digital clone — an AI trained on their actual messages and communication patterns.${p.contextSummary ? ` ${p.contextSummary}` : ''}

Communication style: ${p.communicationStyle || 'natural and authentic'}.${humorClause} Respond ${formalWord} and keep responses ${lengthWord}. ${voiceClause}${loveClause}${avoidClause}${limitsClause}`.trim();
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PanelHeader({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 shrink-0">
      <div className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-sm bg-seren/10 border border-seren/30 flex items-center justify-center">
          <span className="text-seren text-[11px]">◉</span>
        </div>
        <div>
          <span className="text-[13px] font-terminal text-foreground tracking-wider">{title}</span>
          {sub && <span className="text-[10px] font-mono text-muted-foreground/50 ml-2">{sub}</span>}
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-1.5 rounded-sm hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function SlotBadge({ slot, available }: { slot: SlotInfo; available: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-[10px] font-mono ${
      available
        ? 'border-phobos-green/30 text-phobos-green/80 bg-phobos-green/5'
        : 'border-amber-600/30 text-amber-500/70 bg-amber-950/10'
    }`}>
      <Cpu className="w-3 h-3" />
      {slot.persona.toUpperCase()} slot: {slot.device || 'CPU'} {available ? '✅' : '⚠️'}
    </div>
  );
}

// ── Step 0: Model picker ──────────────────────────────────────────────────────

function StepModel({
  modelId, slot, slots, onModelChange, onSlotChange,
}: {
  modelId:       string;
  slot:          'sayon' | 'seren';
  slots:         SlotInfo[];
  onModelChange: (id: string) => void;
  onSlotChange:  (s: 'sayon' | 'seren') => void;
}) {
  const selected = TRAINABLE_MODELS.find(m => m.modelId === modelId);

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-[10px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/50">
          Choose a base model
        </p>
        <p className="text-[12px] font-mono text-muted-foreground/70 leading-relaxed">
          This is the AI brain your clone will be built on. More VRAM = smarter starting point.
          You can always retrain later.
        </p>
      </div>

      <div className="space-y-1.5">
        {TRAINABLE_MODELS.map(m => {
          const active = m.modelId === modelId;
          return (
            <button
              key={m.modelId}
              onClick={() => onModelChange(m.modelId)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-sm border text-left transition-all ${
                active
                  ? 'border-seren/50 bg-seren/8 text-foreground'
                  : 'border-border/25 hover:border-border/50 text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {active
                  ? <span className="w-1.5 h-1.5 rounded-full bg-seren shrink-0" />
                  : <span className="w-1.5 h-1.5 rounded-full bg-border/30 shrink-0" />
                }
                <div>
                  <span className="text-[12px] font-mono">{m.label}</span>
                  <span className="text-[10px] font-mono text-muted-foreground/40 ml-2">{m.family}</span>
                </div>
              </div>
              <span className={`text-[10px] font-mono ${
                m.vramGb <= 6 ? 'text-phobos-green/60' :
                m.vramGb <= 10 ? 'text-amber-500/60' : 'text-red-400/60'
              }`}>
                {m.vramGb} GB VRAM
              </span>
            </button>
          );
        })}
      </div>

      {/* Slot selector */}
      <div className="space-y-2">
        <p className="text-[10px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/50">
          Which AI slot should your clone use?
        </p>
        <p className="text-[11px] font-mono text-muted-foreground/50 leading-relaxed">
          When someone chats with your clone, it will temporarily take over this slot.
        </p>
        <div className="flex gap-2">
          {slots.map(s => (
            <button
              key={s.persona}
              onClick={() => onSlotChange(s.persona)}
              className={`flex-1 flex flex-col gap-1 px-3 py-2.5 rounded-sm border text-left transition-all ${
                slot === s.persona
                  ? 'border-seren/50 bg-seren/8'
                  : 'border-border/25 hover:border-border/40'
              }`}
            >
              <span className={`text-[11px] font-terminal tracking-wider ${
                slot === s.persona ? 'text-seren' : 'text-muted-foreground/60'
              }`}>
                {s.persona.toUpperCase()} slot
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/50">
                {s.device || 'CPU'} {s.available ? '✅' : '⚠️'}
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="text-[10px] font-mono text-muted-foreground/40 mt-1">
            {selected.label} requires {selected.vramGb} GB VRAM ·{' '}
            {slots.find(s => s.persona === slot)?.vramGb
              ? slots.find(s => s.persona === slot)!.vramGb >= selected.vramGb
                ? '✅ sufficient'
                : `⚠️ ${slots.find(s => s.persona === slot)!.vramGb} GB available`
              : 'hardware unknown'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 1: Data ──────────────────────────────────────────────────────────────

function StepData({
  sessionId, files, onFilesChange,
}: {
  sessionId: string | null;
  files:     UploadedFile[];
  onFilesChange: (files: UploadedFile[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch the current file list from the server and sync state.
  const refreshFileList = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sid}/dataset`);
      if (res.ok) {
        const data = await res.json() as { files?: UploadedFile[] };
        if (data.files) onFilesChange(data.files);
      }
    } catch { /* non-fatal */ }
  }, [onFilesChange]);

  // Upload files sequentially then refresh the list once.
  const uploadFiles = useCallback(async (fileList: File[]) => {
    if (!sessionId || fileList.length === 0) return;
    setUploading(true);
    setUploadErr(null);
    try {
      for (const file of fileList) {
        const buf = await file.arrayBuffer();
        const res = await fetch(
          `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset?filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf },
        );
        if (!res.ok) {
          const e = await res.json() as { error?: string };
          throw new Error(e.error ?? `Upload failed: ${file.name}`);
        }
      }
      await refreshFileList(sessionId);
    } catch (e) {
      setUploadErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  }, [sessionId, refreshFileList]);

  const removeFile = useCallback(async (name: string) => {
    if (!sessionId) return;
    try {
      await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      onFilesChange(files.filter(f => f.name !== name));
    } catch { /* non-fatal */ }
  }, [sessionId, files, onFilesChange]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) uploadFiles(dropped);
  }, [uploadFiles]);

  const turnEstimate = files.reduce((acc, f) => acc + Math.floor(f.sizeBytes / 200), 0);

  return (
    <div className="space-y-5">
      {/* Mobile CTA — primary */}
      <div className="border border-seren/25 bg-seren/5 rounded-sm p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-seren/70" />
          <span className="text-[12px] font-terminal text-seren/80 tracking-wider">
            IMPORT FROM PHOBOS MOBILE
          </span>
          <span className="ml-auto text-[9px] font-mono text-muted-foreground/30 border border-border/20 px-1.5 py-0.5 rounded-sm">
            COMING SOON
          </span>
        </div>
        <p className="text-[11px] font-mono text-muted-foreground/60 leading-relaxed">
          The best training data is your real text messages. Connect your phone in the Phobos mobile
          app to import your message history directly. More messages = a clone that actually sounds
          like you.
        </p>
        <p className="text-[10px] font-mono text-muted-foreground/35">
          500+ conversation turns recommended · All processing stays on your machine
        </p>
      </div>

      {/* File drop zone — secondary, understated */}
      <div
        className="border border-dashed border-border/25 rounded-sm p-4 space-y-3"
        onDrop={onDrop}
        onDragOver={e => e.preventDefault()}
      >
        <div className="flex items-center gap-2 text-muted-foreground/40">
          <FileText className="w-3.5 h-3.5" />
          <span className="text-[10px] font-mono">Or drop files here</span>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={!sessionId || uploading}
            className="ml-auto text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground/70 underline underline-offset-2 transition-colors disabled:opacity-30"
          >
            browse
          </button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".jsonl,.txt,.md,.json"
            multiple
            onChange={e => { if (e.target.files) uploadFiles(Array.from(e.target.files)); }}
          />
        </div>
        <p className="text-[9px] font-mono text-muted-foreground/30">
          .jsonl · .txt · .md · .json — exported chat logs, journal entries, anything you've written
        </p>

        {uploadErr && (
          <p className="text-[10px] font-mono text-red-400/70">{uploadErr}</p>
        )}

        {uploading && (
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/40">
            <Loader2 className="w-3 h-3 animate-spin" />
            Uploading…
          </div>
        )}
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/50">
              {files.length} {files.length === 1 ? 'file' : 'files'} ready
            </span>
            <span className={`text-[10px] font-mono ${
              turnEstimate >= 500 ? 'text-phobos-green/60' :
              turnEstimate >= 100 ? 'text-amber-500/60' : 'text-red-400/60'
            }`}>
              ~{turnEstimate.toLocaleString()} turns
              {turnEstimate < 100 && ' · more data needed'}
              {turnEstimate >= 100 && turnEstimate < 500 && ' · more recommended'}
              {turnEstimate >= 500 && ' · good amount'}
            </span>
          </div>
          {files.map(f => (
            <div key={f.name} className="flex items-center gap-2 px-2.5 py-1.5 border border-border/20 rounded-sm group">
              <FileText className="w-3 h-3 text-muted-foreground/30 shrink-0" />
              <span className="text-[11px] font-mono text-muted-foreground/70 flex-1 truncate">{f.name}</span>
              <span className="text-[9px] font-mono text-muted-foreground/30">{fmtBytes(f.sizeBytes)}</span>
              <button
                onClick={() => removeFile(f.name)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground/30 hover:text-red-400/70 transition-all"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Configure: post-training profile editor ───────────────────────────────────

interface ProfileDraft {
  displayName:        string;
  pronouns:           string;
  communicationStyle: string;
  loveTopics:         string;
  avoidTopics:        string;
  humorStyle:         string;
  responseLength:     number;
  formality:          number;
  firstPerson:        boolean;
  contextSummary:     string;
  limitsSummary:      string;
  temperature:        number;
  topP:               number;
  contextWindow:      number;
}

const DEFAULT_DRAFT: ProfileDraft = {
  displayName:        '',
  pronouns:           '',
  communicationStyle: '',
  loveTopics:         '',
  avoidTopics:        '',
  humorStyle:         'None',
  responseLength:     0.5,
  formality:          0.4,
  firstPerson:        true,
  contextSummary:     '',
  limitsSummary:      '',
  temperature:        0.7,
  topP:               0.9,
  contextWindow:      4096,
};

function Slider({ label, value, min, max, step, onChange, leftLabel, rightLabel, fmt }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; leftLabel?: string; rightLabel?: string;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-terminal uppercase tracking-[0.18em] text-muted-foreground/50">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground/60">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-0.5 bg-border/30 rounded-full appearance-none cursor-pointer accent-seren"
      />
      {(leftLabel || rightLabel) && (
        <div className="flex justify-between text-[9px] font-mono text-muted-foreground/30">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-terminal uppercase tracking-[0.18em] text-muted-foreground/50 block mb-1">
      {children}
    </span>
  );
}

function ConfigureView({
  draft, onChange, onSave, saving, error, cartridgeId, chosenSlot,
}: {
  draft:       ProfileDraft;
  onChange:    (patch: Partial<ProfileDraft>) => void;
  onSave:      () => void;
  saving:      boolean;
  error:       string | null;
  cartridgeId: string;
  chosenSlot:  'sayon' | 'seren';
}) {
  const loveArr  = draft.loveTopics.split(',').map(t => t.trim()).filter(Boolean);
  const avoidArr = draft.avoidTopics.split(',').map(t => t.trim()).filter(Boolean);
  const preview  = buildSystemPrompt({
    displayName: draft.displayName || 'Your Clone',
    pronouns:    draft.pronouns,
    communicationStyle: draft.communicationStyle,
    loveTopics:  loveArr,
    avoidTopics: avoidArr,
    humorStyle:  draft.humorStyle,
    responseLength: draft.responseLength,
    formality:   draft.formality,
    firstPerson: draft.firstPerson,
    contextSummary: draft.contextSummary,
    limitsSummary:  draft.limitsSummary,
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6 min-h-0">

        {/* Welcome message */}
        <div className="border border-seren/20 bg-seren/5 rounded-sm px-4 py-3">
          <p className="text-[12px] font-mono text-seren/80 leading-relaxed">
            ◉ Training complete. Now tell your clone who you are.
          </p>
          <p className="text-[11px] font-mono text-muted-foreground/50 mt-1 leading-relaxed">
            These details shape how your clone talks, what it knows about you, and how it responds
            to others. You can edit this anytime.
          </p>
        </div>

        {/* Identity */}
        <section className="space-y-3">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            Identity
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Display name</FieldLabel>
              <input
                type="text"
                value={draft.displayName}
                onChange={e => onChange({ displayName: e.target.value })}
                placeholder="How your clone identifies itself"
                className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40"
              />
            </div>
            <div>
              <FieldLabel>Pronouns</FieldLabel>
              <select
                value={draft.pronouns}
                onChange={e => onChange({ pronouns: e.target.value })}
                className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground focus:outline-none focus:border-seren/40"
              >
                <option value="">prefer not to say</option>
                <option value="they/them">they/them</option>
                <option value="she/her">she/her</option>
                <option value="he/him">he/him</option>
                <option value="she/they">she/they</option>
                <option value="he/they">he/they</option>
              </select>
            </div>
          </div>
        </section>

        {/* Personality */}
        <section className="space-y-3">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            Personality snapshot
          </div>
          <div>
            <FieldLabel>How you communicate</FieldLabel>
            <textarea
              value={draft.communicationStyle}
              onChange={e => onChange({ communicationStyle: e.target.value })}
              placeholder="Describe your style in your own words — direct, sarcastic, rambling, thoughtful, technical…"
              rows={2}
              className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40 resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Topics you love</FieldLabel>
              <input
                type="text"
                value={draft.loveTopics}
                onChange={e => onChange({ loveTopics: e.target.value })}
                placeholder="coding, coffee, sci-fi…"
                className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40"
              />
              <p className="text-[9px] font-mono text-muted-foreground/25 mt-1">comma separated</p>
            </div>
            <div>
              <FieldLabel>Topics to avoid</FieldLabel>
              <input
                type="text"
                value={draft.avoidTopics}
                onChange={e => onChange({ avoidTopics: e.target.value })}
                placeholder="work drama, politics…"
                className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40"
              />
              <p className="text-[9px] font-mono text-muted-foreground/25 mt-1">comma separated</p>
            </div>
          </div>
          <div>
            <FieldLabel>Humor style</FieldLabel>
            <div className="flex gap-1.5 flex-wrap">
              {['None', 'Dry', 'Sarcastic', 'Wholesome', 'Dark', 'Absurd'].map(h => (
                <button
                  key={h}
                  onClick={() => onChange({ humorStyle: h })}
                  className={`px-2.5 py-1 text-[10px] font-mono rounded-sm border transition-all ${
                    draft.humorStyle === h
                      ? 'border-seren/50 text-seren bg-seren/8'
                      : 'border-border/25 text-muted-foreground/50 hover:border-border/50'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Voice & tone */}
        <section className="space-y-4">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            Voice & tone
          </div>
          <Slider
            label="Response length" value={draft.responseLength} min={0} max={1} step={0.05}
            onChange={v => onChange({ responseLength: v })}
            leftLabel="Short" rightLabel="Detailed"
            fmt={v => v < 0.4 ? 'Short' : v > 0.7 ? 'Detailed' : 'Balanced'}
          />
          <Slider
            label="Formality" value={draft.formality} min={0} max={1} step={0.05}
            onChange={v => onChange({ formality: v })}
            leftLabel="Casual" rightLabel="Professional"
            fmt={v => v < 0.35 ? 'Casual' : v > 0.65 ? 'Professional' : 'Natural'}
          />
          <div className="flex items-center justify-between">
            <div>
              <FieldLabel>First-person voice</FieldLabel>
              <p className="text-[10px] font-mono text-muted-foreground/40">
                {draft.firstPerson ? 'Clone speaks as "I"' : 'Clone speaks about you in third person'}
              </p>
            </div>
            <button
              onClick={() => onChange({ firstPerson: !draft.firstPerson })}
              className="text-seren/60 hover:text-seren transition-colors"
            >
              {draft.firstPerson
                ? <ToggleRight className="w-6 h-6" />
                : <ToggleLeft  className="w-6 h-6 text-muted-foreground/30" />
              }
            </button>
          </div>
        </section>

        {/* Context */}
        <section className="space-y-3">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            Context & limits
          </div>
          <div>
            <FieldLabel>What your clone knows about you</FieldLabel>
            <textarea
              value={draft.contextSummary}
              onChange={e => onChange({ contextSummary: e.target.value })}
              placeholder="Summarize your life, work, interests, relationships — anything the clone should know upfront…"
              rows={3}
              className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40 resize-none"
            />
          </div>
          <div>
            <FieldLabel>What it doesn't know / should deflect</FieldLabel>
            <textarea
              value={draft.limitsSummary}
              onChange={e => onChange({ limitsSummary: e.target.value })}
              placeholder="Private matters, work secrets, specific relationships — things the clone should not discuss…"
              rows={2}
              className="w-full bg-black/40 border border-border/30 rounded-sm px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40 resize-none"
            />
          </div>
        </section>

        {/* Inference tuning */}
        <section className="space-y-4">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            Inference tuning
          </div>
          <Slider
            label="Temperature" value={draft.temperature} min={0.1} max={1.5} step={0.05}
            onChange={v => onChange({ temperature: v })}
            leftLabel="Precise" rightLabel="Creative"
            fmt={v => v.toFixed(2)}
          />
          <Slider
            label="Top-p" value={draft.topP} min={0.1} max={1.0} step={0.05}
            onChange={v => onChange({ topP: v })}
            leftLabel="Focused" rightLabel="Diverse"
            fmt={v => v.toFixed(2)}
          />
          <div>
            <FieldLabel>Context window</FieldLabel>
            <div className="flex gap-1.5">
              {[2048, 4096, 8192, 16384].map(ctx => (
                <button
                  key={ctx}
                  onClick={() => onChange({ contextWindow: ctx })}
                  className={`flex-1 py-1.5 text-[10px] font-mono rounded-sm border transition-all ${
                    draft.contextWindow === ctx
                      ? 'border-seren/50 text-seren bg-seren/8'
                      : 'border-border/25 text-muted-foreground/50 hover:border-border/50'
                  }`}
                >
                  {ctx >= 1024 ? `${ctx / 1024}k` : ctx}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* System prompt preview */}
        <section className="space-y-2">
          <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-muted-foreground/30 border-b border-border/20 pb-1">
            System prompt preview
          </div>
          <div className="bg-black/60 border border-border/20 rounded-sm p-3">
            <pre className="text-[10px] font-mono text-muted-foreground/60 whitespace-pre-wrap leading-relaxed">
              {preview}
            </pre>
          </div>
        </section>

        {error && (
          <p className="text-[11px] font-mono text-red-400/70">{error}</p>
        )}
      </div>

      <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center justify-between gap-3">
        <p className="text-[10px] font-mono text-muted-foreground/35">
          Activating on {chosenSlot.toUpperCase()} slot
        </p>
        <button
          onClick={onSave}
          disabled={saving || !draft.displayName}
          className="flex items-center gap-2 px-5 py-2 bg-seren/15 border border-seren/40 text-seren text-[11px] font-terminal uppercase tracking-[0.2em] rounded-sm hover:bg-seren/20 hover:border-seren/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {saving ? 'Activating…' : 'Activate Clone'}
        </button>
      </div>
    </div>
  );
}

// ── Dashboard: active clone ───────────────────────────────────────────────────

function ActiveDashboard({
  status, onEdit, onRetrain, onDelete,
}: {
  status:    CloneStatus;
  onEdit:    () => void;
  onRetrain: () => void;
  onDelete:  () => void;
}) {
  const p = status.profile!;
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">

        {/* Status banner */}
        <div className="border border-seren/30 bg-seren/5 rounded-sm px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-seren animate-pulse" />
            <span className="text-[12px] font-terminal text-seren/90 tracking-wider">
              {p.display_name || 'YOUR CLONE'} · ACTIVE
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/40 border border-border/20 px-2 py-0.5 rounded-sm">
            {p.slot.toUpperCase()} slot
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'TRAINED ON', value: `${status.turnCount.toLocaleString()} turns` },
            { label: 'SLOT',       value: p.slot.toUpperCase() },
            { label: 'SINCE',      value: status.trainedAt ? new Date(status.trainedAt).toLocaleDateString() : '—' },
          ].map(s => (
            <div key={s.label} className="border border-border/20 rounded-sm px-3 py-2 bg-black/30">
              <p className="text-[8px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35 mb-1">{s.label}</p>
              <p className="text-[12px] font-mono text-foreground/80">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Personality summary */}
        <div className="space-y-2">
          <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35">
            Personality
          </p>
          <div className="border border-border/20 rounded-sm px-3 py-2.5 bg-black/20 space-y-1.5">
            {p.communication_style && (
              <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">
                {p.communication_style}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-1">
              {p.humor_style !== 'None' && (
                <span className="text-[9px] font-mono text-seren/60 border border-seren/20 px-1.5 py-0.5 rounded-sm">
                  {p.humor_style} humor
                </span>
              )}
              {(JSON.parse(p.love_topics || '[]') as string[]).slice(0, 3).map(t => (
                <span key={t} className="text-[9px] font-mono text-phobos-green/50 border border-phobos-green/15 px-1.5 py-0.5 rounded-sm">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* System prompt preview toggle */}
        <div className="space-y-2">
          <button
            onClick={() => setPromptOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 border border-border/20 rounded-sm hover:border-border/35 transition-colors text-left"
          >
            <span className="text-[10px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/50">
              System prompt
            </span>
            <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/30 transition-transform ${promptOpen ? 'rotate-90' : ''}`} />
          </button>
          {promptOpen && (
            <div className="bg-black/60 border border-border/20 rounded-sm p-3">
              <pre className="text-[10px] font-mono text-muted-foreground/50 whitespace-pre-wrap leading-relaxed">
                {p.system_prompt || '—'}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center gap-2">
        <button
          onClick={onEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-border/30 text-muted-foreground/60 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm hover:border-border/50 hover:text-foreground transition-all"
        >
          <Edit3 className="w-3 h-3" />
          Edit
        </button>
        <button
          onClick={onRetrain}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-border/30 text-muted-foreground/60 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm hover:border-border/50 hover:text-foreground transition-all"
        >
          <Zap className="w-3 h-3" />
          Retrain
        </button>
        <button
          onClick={onDelete}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 border border-red-900/30 text-red-400/50 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm hover:border-red-900/50 hover:text-red-400/80 transition-all"
        >
          <Trash2 className="w-3 h-3" />
          Delete Clone
        </button>
      </div>
    </div>
  );
}

// ── Main WeclonePanel ─────────────────────────────────────────────────────────

type PanelView = 'setup' | 'training' | 'configure' | 'active';

export function WeclonePanel({ onClose }: { onClose: () => void }) {
  const [view,       setView]       = useState<PanelView>('setup');
  const [loading,    setLoading]    = useState(true);
  const [status,     setStatus]     = useState<CloneStatus | null>(null);
  const [slots,      setSlots]      = useState<SlotInfo[]>([]);

  // Wizard state
  const [modelId,    setModelId]    = useState('qwen3.5-4b-q4');
  const [chosenSlot, setChosenSlot] = useState<'sayon' | 'seren'>('seren');
  const [sessionId,  setSessionId]  = useState<string | null>(null);
  const [files,      setFiles]      = useState<UploadedFile[]>([]);
  const [wizStep,    setWizStep]    = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [wizErr,     setWizErr]     = useState<string | null>(null);

  // Configure state
  const [draft,      setDraft]      = useState<ProfileDraft>(DEFAULT_DRAFT);
  const [saving,     setSaving]     = useState(false);
  const [saveErr,    setSaveErr]    = useState<string | null>(null);
  const [cartForConfig, setCartForConfig] = useState<string>('');

  // ── Load status on mount ────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/weclone/status`);
      if (!res.ok) { setLoading(false); return; }
      const s = await res.json() as CloneStatus;
      setStatus(s);
      if (s.hasProfile && s.hasCartridge && s.profile) {
        setView('active');
      }
    } catch { /* server not yet aware of weclone routes — stay in setup */ }
    setLoading(false);
  }, []);

  const fetchSlots = useCallback(async () => {
    const required = TRAINABLE_MODELS.find(m => m.modelId === modelId)?.vramGb ?? 0;
    const rank = 16;
    try {
      const [sayonRes, serenRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/phobos/training/lm/vram-check?baseModelId=${encodeURIComponent(modelId)}&rank=${rank}&persona=sayon`),
        fetch(`${ENGINE_URL}/api/phobos/training/lm/vram-check?baseModelId=${encodeURIComponent(modelId)}&rank=${rank}&persona=seren`),
      ]);
      const sayonHw = sayonRes.ok ? await sayonRes.json() as { totalGb: number; device: string } : null;
      const serenHw = serenRes.ok ? await serenRes.json() as { totalGb: number; device: string } : null;

      setSlots([
        {
          persona:   'sayon',
          label:     'SAYON slot',
          device:    sayonHw?.device ?? 'CPU',
          vramGb:    sayonHw?.totalGb ?? 0,
          backend:   'cuda',
          available: (sayonHw?.totalGb ?? 0) >= required,
        },
        {
          persona:   'seren',
          label:     'SEREN slot',
          device:    serenHw?.device ?? 'CPU',
          vramGb:    serenHw?.totalGb ?? 0,
          backend:   'cuda',
          available: (serenHw?.totalGb ?? 0) >= required,
        },
      ]);
    } catch { /* non-fatal */ }
  }, [modelId]);

  useEffect(() => {
    fetchStatus();
    fetchSlots();
  }, [fetchStatus, fetchSlots]);

  // ── Wizard: advance from step 0 → create session ───────────────────────────

  async function handleWizardNext() {
    setWizErr(null);
    if (wizStep === 0) {
      if (sessionId) { setWizStep(1); return; }
      setSubmitting(true);
      try {
        const res = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name:            'My Clone',
            description:     'Personal digital clone trained on conversation data',
            author:          'local',
            baseModelId:     modelId,
            targetPersona:   chosenSlot,
            category:        'weclone',
            behaviorSummary: 'Personal digital clone',
            dataMode:        'conversation',
          }),
        });
        const body = await res.json() as { session_id?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? 'Failed to create session');
        setSessionId(body.session_id!);
        setWizStep(1);
      } catch (e) {
        setWizErr((e as Error).message);
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (wizStep === 1) {
      setView('training');
    }
  }

  // ── Training done → go to configure ────────────────────────────────────────

  function handleTrainingDone(cartridgeId: string) {
    setCartForConfig(cartridgeId);
    setView('configure');
  }

  // ── Save profile → activate cartridge ──────────────────────────────────────

  async function handleSaveProfile() {
    setSaveErr(null);
    setSaving(true);
    const loveArr  = draft.loveTopics.split(',').map(t => t.trim()).filter(Boolean);
    const avoidArr = draft.avoidTopics.split(',').map(t => t.trim()).filter(Boolean);
    const systemPrompt = buildSystemPrompt({
      displayName:        draft.displayName,
      pronouns:           draft.pronouns,
      communicationStyle: draft.communicationStyle,
      loveTopics:         loveArr,
      avoidTopics:        avoidArr,
      humorStyle:         draft.humorStyle,
      responseLength:     draft.responseLength,
      formality:          draft.formality,
      firstPerson:        draft.firstPerson,
      contextSummary:     draft.contextSummary,
      limitsSummary:      draft.limitsSummary,
    });
    try {
      // 1. Activate the cartridge on the chosen slot
      const actRes = await fetch(`${ENGINE_URL}/api/cartridges/${chosenSlot}/activate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cartridgeId: cartForConfig }),
      });
      if (!actRes.ok) {
        const e = await actRes.json() as { error?: string };
        throw new Error(e.error ?? 'Failed to activate cartridge');
      }

      // 2. Save profile to weclone store
      const profRes = await fetch(`${ENGINE_URL}/api/weclone/profile`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartridgeId:       cartForConfig,
          slot:              chosenSlot,
          displayName:       draft.displayName,
          pronouns:          draft.pronouns,
          communicationStyle: draft.communicationStyle,
          loveTopics:        JSON.stringify(loveArr),
          avoidTopics:       JSON.stringify(avoidArr),
          humorStyle:        draft.humorStyle,
          responseLength:    draft.responseLength,
          formality:         draft.formality,
          firstPerson:       draft.firstPerson,
          contextSummary:    draft.contextSummary,
          limitsSummary:     draft.limitsSummary,
          temperature:       draft.temperature,
          topP:              draft.topP,
          contextWindow:     draft.contextWindow,
          systemPrompt,
        }),
      });
      if (!profRes.ok) {
        const e = await profRes.json() as { error?: string };
        throw new Error(e.error ?? 'Failed to save profile');
      }

      await fetchStatus();
      setView('active');
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete clone ────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!window.confirm('Delete your digital clone? This will remove the cartridge and profile. Your training data files are not deleted.')) return;
    try {
      if (status?.profile?.cartridge_id) {
        await fetch(`${ENGINE_URL}/api/cartridges/${status.profile.cartridge_id}`, { method: 'DELETE' });
      }
      await fetch(`${ENGINE_URL}/api/weclone/profile`, { method: 'DELETE' });
      setStatus(null);
      setSessionId(null);
      setFiles([]);
      setWizStep(0);
      setDraft(DEFAULT_DRAFT);
      setView('setup');
    } catch { /* non-fatal */ }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const panelTitle = view === 'training'  ? 'CLONE TRAINING'
                   : view === 'configure' ? 'CONFIGURE YOUR CLONE'
                   : view === 'active'    ? 'MY DIGITAL CLONE'
                   : 'DIGITAL CLONE';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="phobos-weclone-panel w-[680px] max-h-[88vh] bg-background border border-seren/20 shadow-[0_0_60px_rgba(99,102,241,0.08)] rounded-sm flex flex-col overflow-hidden">

        <PanelHeader title={panelTitle} onClose={onClose} />

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-muted-foreground/30 animate-spin" />
          </div>
        ) : view === 'training' && sessionId ? (
          <div className="flex-1 min-h-0">
            <LmTrainingPanel
              sessionId={sessionId}
              onCancel={() => setView('setup')}
              onDone={handleTrainingDone}
            />
          </div>
        ) : view === 'configure' ? (
          <ConfigureView
            draft={draft}
            onChange={patch => setDraft(d => ({ ...d, ...patch }))}
            onSave={handleSaveProfile}
            saving={saving}
            error={saveErr}
            cartridgeId={cartForConfig}
            chosenSlot={chosenSlot}
          />
        ) : view === 'active' && status?.hasProfile ? (
          <ActiveDashboard
            status={status}
            onEdit={() => {
              const p = status.profile!;
              setDraft({
                displayName:        p.display_name,
                pronouns:           p.pronouns ?? '',
                communicationStyle: p.communication_style ?? '',
                loveTopics:         (JSON.parse(p.love_topics  || '[]') as string[]).join(', '),
                avoidTopics:        (JSON.parse(p.avoid_topics || '[]') as string[]).join(', '),
                humorStyle:         p.humor_style ?? 'None',
                responseLength:     p.response_length ?? 0.5,
                formality:          p.formality ?? 0.4,
                firstPerson:        p.first_person ?? true,
                contextSummary:     p.context_summary ?? '',
                limitsSummary:      p.limits_summary ?? '',
                temperature:        p.temperature ?? 0.7,
                topP:               p.top_p ?? 0.9,
                contextWindow:      p.context_window ?? 4096,
              });
              setCartForConfig(p.cartridge_id ?? '');
              setChosenSlot(p.slot);
              setView('configure');
            }}
            onRetrain={() => {
              setSessionId(null);
              setFiles([]);
              setWizStep(0);
              setView('setup');
            }}
            onDelete={handleDelete}
          />
        ) : (
          /* Setup wizard */
          <div className="flex flex-col flex-1 min-h-0">
            {/* Step indicator */}
            <div className="flex items-center gap-0 px-5 pt-4 pb-3 shrink-0">
              {['Choose model', 'Add your data'].map((label, i) => (
                <div key={i} className="flex items-center gap-0">
                  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-sm text-[10px] font-terminal uppercase tracking-[0.18em] ${
                    i === wizStep
                      ? 'text-seren bg-seren/8 border border-seren/25'
                      : i < wizStep
                        ? 'text-muted-foreground/50'
                        : 'text-muted-foreground/25'
                  }`}>
                    <span>{i + 1}</span>
                    <span>{label}</span>
                  </div>
                  {i < 1 && <ChevronRight className="w-3 h-3 text-border/30 mx-1" />}
                </div>
              ))}
            </div>

            {/* Intro text — step 0 only */}
            {wizStep === 0 && (
              <div className="px-5 pb-3 shrink-0">
                <p className="text-[13px] font-mono text-foreground/80 leading-relaxed">
                  You're about to teach an AI to think and speak like you.
                </p>
                <p className="text-[11px] font-mono text-muted-foreground/50 mt-1 leading-relaxed">
                  It learns from your actual messages and writing. The result is a clone that friends
                  can talk to when you're away — in your voice, with your personality.
                </p>
              </div>
            )}

            {/* Step content */}
            <div className="flex-1 overflow-y-auto px-5 pb-4 min-h-0">
              {wizStep === 0 ? (
                <StepModel
                  modelId={modelId}
                  slot={chosenSlot}
                  slots={slots}
                  onModelChange={id => { setModelId(id); setSessionId(null); }}
                  onSlotChange={setChosenSlot}
                />
              ) : (
                <StepData
                  sessionId={sessionId}
                  files={files}
                  onFilesChange={setFiles}
                />
              )}
            </div>

            {/* Wizard footer */}
            <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {wizStep > 0 && (
                  <button
                    onClick={() => setWizStep(s => s - 1)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-border/25 text-muted-foreground/50 text-[10px] font-terminal uppercase tracking-[0.15em] rounded-sm hover:border-border/40 hover:text-muted-foreground transition-all"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Back
                  </button>
                )}
                {wizErr && <p className="text-[10px] font-mono text-red-400/70">{wizErr}</p>}
              </div>

              <button
                onClick={handleWizardNext}
                disabled={submitting || (wizStep === 1 && files.length === 0)}
                className="flex items-center gap-2 px-5 py-2 bg-seren/12 border border-seren/35 text-seren text-[11px] font-terminal uppercase tracking-[0.2em] rounded-sm hover:bg-seren/18 hover:border-seren/55 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {wizStep === 0 ? 'Next' : 'Begin Training'}
                {wizStep < 1 && !submitting && <ChevronRight className="w-3.5 h-3.5" />}
                {wizStep === 1 && !submitting && <Zap className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
