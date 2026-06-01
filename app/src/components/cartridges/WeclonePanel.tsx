/**
 * WeclonePanel.tsx — Digital Clone creation and management.
 *
 * View states:
 *   'list'         — clone list + "About Me" user profile entry point
 *   'detail'       — single clone overview with action buttons
 *   'identity'     — clone # YOU ARE identity form
 *   'lm-setup'     — LM training wizard (model select + data upload)
 *   'lm-training'  — LmTrainingPanel running live
 *   'personality'  — personality / inference tuning (ConfigureView)
 *   'voice-train'  — VoiceTrainer
 *   'user-profile' — owner # YOU ARE TALKING TO form
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Cpu, Upload, Trash2, CheckCircle2, AlertTriangle,
  Loader2, ChevronRight, ChevronLeft, Zap, Edit3,
  Smartphone, FileText, ToggleLeft, ToggleRight, Mic, Radio,
  Plus, User, Brain, Settings,
} from 'lucide-react';
import { LmTrainingPanel } from './LmTrainingPanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Trainable models ──────────────────────────────────────────────────────────

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
  available: boolean;
}

interface UploadedFile {
  name:      string;
  sizeBytes: number;
}

interface WecloneProfile {
  id:                  string;
  cartridge_id:        string | null;
  voice_profile_id:    string | null;
  slot:                'sayon' | 'seren';
  display_name:        string;
  pronouns:            string;
  age:                 string;
  gender:              string;
  appearance:          string;
  personality_desc:    string;
  background:          string;
  interests:           string;
  dislikes:            string;
  hobbies:             string;
  goals:               string;
  fears:               string;
  values:              string;
  expertise:           string;
  relationship_style:  string;
  love_language:       string;
  dealbreakers:        string;
  communication_style: string;
  love_topics:         string;
  avoid_topics:        string;
  humor_style:         string;
  response_length:     number;
  formality:           number;
  first_person:        boolean;
  context_summary:     string;
  limits_summary:      string;
  temperature:         number;
  top_p:               number;
  context_window:      number;
  system_prompt:       string;
  published:           boolean;
  created_at:          string;
  updated_at:          string;
  // resolved from cartridge + voice store
  cartridgeName?:      string | null;
  trainedAt?:          string | null;
  turnCount?:          number;
  cartridgeActive?:    boolean;
  hasVoiceProfile?:    boolean;
  voiceProfileName?:   string | null;
}

interface UserProfile {
  display_name:      string;
  age:               string;
  gender:            string;
  pronouns:          string;
  appearance:        string;
  personality:       string;
  background:        string;
  interests:         string;
  dislikes:          string;
  hobbies:           string;
  goals:             string;
  fears:             string;
  values:            string;
  speech_style:      string;
  humor_style:       string;
  expertise:         string;
  relationship_style: string;
  love_language:     string;
  dealbreakers:      string;
}

type PanelView =
  | 'list'
  | 'detail'
  | 'identity'
  | 'lm-setup'
  | 'lm-training'
  | 'personality'
  | 'voice-train'
  | 'user-profile';

// ── Shared helpers ────────────────────────────────────────────────────────────

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
  const lines: string[] = [];
  const name = p.displayName || 'this clone';
  if (p.firstPerson) {
    lines.push(`You are ${name}.`);
  } else {
    lines.push(`You represent ${name}.`);
  }
  if (p.pronouns)           lines.push(`Pronouns: ${p.pronouns}.`);
  if (p.communicationStyle) lines.push(`\nCommunication style: ${p.communicationStyle}`);
  if (p.loveTopics.length)  lines.push(`\nTopics you love: ${p.loveTopics.join(', ')}.`);
  if (p.avoidTopics.length) lines.push(`Topics to avoid: ${p.avoidTopics.join(', ')}.`);
  if (p.humorStyle !== 'None') lines.push(`\nHumor: ${p.humorStyle}.`);
  const len = p.responseLength < 0.4 ? 'Keep responses concise.' : p.responseLength > 0.7 ? 'You can be detailed and thorough.' : 'Balance brevity with depth.';
  const form = p.formality < 0.35 ? 'Speak casually.' : p.formality > 0.65 ? 'Maintain a professional tone.' : 'Keep a natural conversational tone.';
  lines.push(`\n${len} ${form}`);
  if (p.contextSummary) lines.push(`\nContext: ${p.contextSummary}`);
  if (p.limitsSummary)  lines.push(`\nDo not discuss: ${p.limitsSummary}`);
  return lines.join('\n');
}

function PanelHeader({ title, sub, onClose, onBack }: {
  title: string; sub?: string; onClose: () => void; onBack?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5 border-b border-phob-yellow/20 shrink-0">
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="text-phob-steel/40 hover:text-phob-white/70 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-seren/60 animate-pulse" />
          <div>
            <h2 className="text-[11px] font-terminal uppercase tracking-[0.25em] text-phob-white/90">{title}</h2>
            {sub && <p className="text-[9px] font-mono text-phob-steel/40 mt-0.5">{sub}</p>}
          </div>
        </div>
      </div>
      <button onClick={onClose} className="text-phob-steel/40 hover:text-phob-white/70 transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] font-terminal uppercase tracking-[0.25em] text-phob-yellow/35 border-b border-phob-yellow/15 pb-1">
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-terminal uppercase tracking-[0.18em] text-phob-yellow/45 block mb-1">
      {children}
    </span>
  );
}

function Slider({ label, value, min, max, step, onChange, leftLabel, rightLabel, fmt }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; leftLabel?: string; rightLabel?: string;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-terminal uppercase tracking-[0.18em] text-phob-yellow/45">{label}</span>
        <span className="text-[10px] font-mono text-phob-white/60">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-0.5 bg-border/30 rounded-full appearance-none cursor-pointer accent-seren"
      />
      {(leftLabel || rightLabel) && (
        <div className="flex justify-between text-[9px] font-mono text-phob-steel/30">
          <span>{leftLabel}</span><span>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 2 }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full bg-phob-white/5 border border-border/30  px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40 resize-none"
      />
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-phob-white/5 border border-border/30  px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40"
      />
    </div>
  );
}

// ── Identity form — shared between clone and user profile ─────────────────────

interface IdentityDraft {
  displayName:       string;
  age:               string;
  gender:            string;
  pronouns:          string;
  appearance:        string;
  personalityDesc:   string;
  background:        string;
  interests:         string;
  dislikes:          string;
  hobbies:           string;
  goals:             string;
  fears:             string;
  values:            string;
  expertise:         string;
  relationshipStyle: string;
  loveLanguage:      string;
  dealbreakers:      string;
}

const BLANK_IDENTITY: IdentityDraft = {
  displayName: '', age: '', gender: '', pronouns: '',
  appearance: '', personalityDesc: '', background: '',
  interests: '', dislikes: '', hobbies: '',
  goals: '', fears: '', values: '',
  expertise: '',
  relationshipStyle: '', loveLanguage: '', dealbreakers: '',
};

function IdentityForm({
  draft, onChange, heading,
}: {
  draft:    IdentityDraft;
  onChange: (patch: Partial<IdentityDraft>) => void;
  heading:  string; // "# YOU ARE" or "# YOU ARE TALKING TO"
}) {
  return (
    <div className="space-y-6">
      <div className="border border-seren/15 bg-seren/5  px-3 py-2.5">
        <p className="text-[10px] font-mono text-seren/60 font-semibold">{heading}</p>
        <p className="text-[10px] font-mono text-muted-foreground/40 mt-0.5">
          These fields are injected directly into AI context. Leave blank anything you'd rather the AI not know.
        </p>
      </div>

      {/* Basic identity */}
      <div className="space-y-3">
        <SectionLabel>Identity</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Name" value={draft.displayName} onChange={v => onChange({ displayName: v })} placeholder="What your clone calls itself" />
          <TextInput label="Age" value={draft.age} onChange={v => onChange({ age: v })} placeholder="e.g. 28" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Gender" value={draft.gender} onChange={v => onChange({ gender: v })} placeholder="e.g. non-binary" />
          <div>
            <FieldLabel>Pronouns</FieldLabel>
            <select
              value={draft.pronouns}
              onChange={e => onChange({ pronouns: e.target.value })}
              className="w-full bg-phob-white/5 border border-border/30  px-3 py-1.5 text-[12px] font-mono text-foreground focus:outline-none focus:border-seren/40"
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
      </div>

      {/* Self-description */}
      <div className="space-y-3">
        <SectionLabel>Self-description</SectionLabel>
        <TextArea label="Appearance" value={draft.appearance} onChange={v => onChange({ appearance: v })} placeholder="Physical description, how you present yourself…" />
        <TextArea label="Personality" value={draft.personalityDesc} onChange={v => onChange({ personalityDesc: v })} placeholder="How would you describe yourself to someone who doesn't know you?" />
        <TextArea label="Background" value={draft.background} onChange={v => onChange({ background: v })} placeholder="Where you're from, how you got here, key life events…" rows={3} />
      </div>

      {/* Preferences */}
      <div className="space-y-3">
        <SectionLabel>Preferences</SectionLabel>
        <TextArea label="Interests & passions" value={draft.interests} onChange={v => onChange({ interests: v })} placeholder="What genuinely excites you?" />
        <TextArea label="Dislikes" value={draft.dislikes} onChange={v => onChange({ dislikes: v })} placeholder="Things you find grating, boring, or offensive" />
        <TextArea label="Hobbies" value={draft.hobbies} onChange={v => onChange({ hobbies: v })} placeholder="What you do with free time" />
      </div>

      {/* Inner life */}
      <div className="space-y-3">
        <SectionLabel>Inner life</SectionLabel>
        <TextArea label="Goals" value={draft.goals} onChange={v => onChange({ goals: v })} placeholder="What you're working toward, short or long term" />
        <TextArea label="Fears" value={draft.fears} onChange={v => onChange({ fears: v })} placeholder="What keeps you up at night" />
        <TextArea label="Values" value={draft.values} onChange={v => onChange({ values: v })} placeholder="What matters most to you" />
      </div>

      {/* Expertise */}
      <div className="space-y-3">
        <SectionLabel>Expertise</SectionLabel>
        <TextArea label="Knowledge areas & skills" value={draft.expertise} onChange={v => onChange({ expertise: v })} placeholder="What you know well — domains, tools, crafts…" />
      </div>

      {/* Relationship */}
      <div className="space-y-3">
        <SectionLabel>Relationship</SectionLabel>
        <TextArea label="Relationship style" value={draft.relationshipStyle} onChange={v => onChange({ relationshipStyle: v })} placeholder="How you approach close relationships" />
        <TextInput label="Love language" value={draft.loveLanguage} onChange={v => onChange({ loveLanguage: v })} placeholder="e.g. quality time, words of affirmation" />
        <TextArea label="Dealbreakers" value={draft.dealbreakers} onChange={v => onChange({ dealbreakers: v })} placeholder="Absolute no-gos" />
      </div>
    </div>
  );
}

// ── Personality / inference configure ─────────────────────────────────────────

interface PersonalityDraft {
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

const BLANK_PERSONALITY: PersonalityDraft = {
  communicationStyle: '', loveTopics: '', avoidTopics: '',
  humorStyle: 'None', responseLength: 0.5, formality: 0.4,
  firstPerson: true, contextSummary: '', limitsSummary: '',
  temperature: 0.7, topP: 0.9, contextWindow: 4096,
};

function PersonalityForm({ draft, onChange }: {
  draft:    PersonalityDraft;
  onChange: (patch: Partial<PersonalityDraft>) => void;
}) {
  const loveArr  = draft.loveTopics.split(',').map(t => t.trim()).filter(Boolean);
  const avoidArr = draft.avoidTopics.split(',').map(t => t.trim()).filter(Boolean);
  const preview  = buildSystemPrompt({
    displayName: 'Your Clone', pronouns: '', communicationStyle: draft.communicationStyle,
    loveTopics: loveArr, avoidTopics: avoidArr, humorStyle: draft.humorStyle,
    responseLength: draft.responseLength, formality: draft.formality,
    firstPerson: draft.firstPerson, contextSummary: draft.contextSummary,
    limitsSummary: draft.limitsSummary,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionLabel>Personality snapshot</SectionLabel>
        <TextArea label="How you communicate" value={draft.communicationStyle} onChange={v => onChange({ communicationStyle: v })}
          placeholder="Direct, sarcastic, rambling, thoughtful, technical…" />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Topics you love</FieldLabel>
            <input type="text" value={draft.loveTopics} onChange={e => onChange({ loveTopics: e.target.value })}
              placeholder="coding, coffee, sci-fi…"
              className="w-full bg-phob-white/5 border border-border/30  px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40" />
            <p className="text-[9px] font-mono text-muted-foreground/25 mt-1">comma separated</p>
          </div>
          <div>
            <FieldLabel>Topics to avoid</FieldLabel>
            <input type="text" value={draft.avoidTopics} onChange={e => onChange({ avoidTopics: e.target.value })}
              placeholder="work drama, politics…"
              className="w-full bg-phob-white/5 border border-border/30  px-3 py-1.5 text-[12px] font-mono text-foreground placeholder:text-muted-foreground/25 focus:outline-none focus:border-seren/40" />
            <p className="text-[9px] font-mono text-muted-foreground/25 mt-1">comma separated</p>
          </div>
        </div>
        <div>
          <FieldLabel>Humor style</FieldLabel>
          <div className="flex gap-1.5 flex-wrap">
            {['None', 'Dry', 'Sarcastic', 'Wholesome', 'Dark', 'Absurd'].map(h => (
              <button key={h} onClick={() => onChange({ humorStyle: h })}
                className={`px-2.5 py-1 text-[10px] font-mono  border transition-all ${
                  draft.humorStyle === h ? 'border-seren/50 text-seren bg-seren/8' : 'border-border/25 text-muted-foreground/50 hover:border-border/50'
                }`}>{h}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <SectionLabel>Voice & tone</SectionLabel>
        <Slider label="Response length" value={draft.responseLength} min={0} max={1} step={0.05}
          onChange={v => onChange({ responseLength: v })} leftLabel="Short" rightLabel="Detailed"
          fmt={v => v < 0.4 ? 'Short' : v > 0.7 ? 'Detailed' : 'Balanced'} />
        <Slider label="Formality" value={draft.formality} min={0} max={1} step={0.05}
          onChange={v => onChange({ formality: v })} leftLabel="Casual" rightLabel="Professional"
          fmt={v => v < 0.35 ? 'Casual' : v > 0.65 ? 'Professional' : 'Natural'} />
        <div className="flex items-center justify-between">
          <div>
            <FieldLabel>First-person voice</FieldLabel>
            <p className="text-[10px] font-mono text-muted-foreground/40">
              {draft.firstPerson ? 'Clone speaks as "I"' : 'Clone speaks in third person'}
            </p>
          </div>
          <button onClick={() => onChange({ firstPerson: !draft.firstPerson })} className="text-seren/60 hover:text-seren transition-colors">
            {draft.firstPerson ? <ToggleRight className="w-6 h-6" /> : <ToggleLeft className="w-6 h-6 text-muted-foreground/30" />}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Context & limits</SectionLabel>
        <TextArea label="What your clone knows about you" value={draft.contextSummary} onChange={v => onChange({ contextSummary: v })}
          placeholder="Summarize your life, work, interests…" rows={3} />
        <TextArea label="What it doesn't know / should deflect" value={draft.limitsSummary} onChange={v => onChange({ limitsSummary: v })}
          placeholder="Private matters, things the clone should not discuss…" />
      </div>

      <div className="space-y-4">
        <SectionLabel>Inference tuning</SectionLabel>
        <Slider label="Temperature" value={draft.temperature} min={0.1} max={1.5} step={0.05}
          onChange={v => onChange({ temperature: v })} leftLabel="Precise" rightLabel="Creative" fmt={v => v.toFixed(2)} />
        <Slider label="Top-p" value={draft.topP} min={0.1} max={1.0} step={0.05}
          onChange={v => onChange({ topP: v })} leftLabel="Focused" rightLabel="Diverse" fmt={v => v.toFixed(2)} />
        <div>
          <FieldLabel>Context window</FieldLabel>
          <div className="flex gap-1.5">
            {[2048, 4096, 8192, 16384].map(ctx => (
              <button key={ctx} onClick={() => onChange({ contextWindow: ctx })}
                className={`flex-1 py-1.5 text-[10px] font-mono  border transition-all ${
                  draft.contextWindow === ctx ? 'border-seren/50 text-seren bg-seren/8' : 'border-border/25 text-muted-foreground/50 hover:border-border/50'
                }`}>{ctx >= 1024 ? `${ctx / 1024}k` : ctx}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <SectionLabel>System prompt preview</SectionLabel>
        <div className="bg-phob-white/6 border border-border/20  p-3">
          <pre className="text-[10px] font-mono text-muted-foreground/60 whitespace-pre-wrap leading-relaxed">{preview}</pre>
        </div>
      </div>
    </div>
  );
}

// ── Slot badge ────────────────────────────────────────────────────────────────

function SlotBadge({ slot, available }: { slot: SlotInfo; available: boolean }) {
  return (
    <div className={`border  px-3 py-2 space-y-1 transition-colors ${
      available ? 'border-seren/30 bg-seren/5' : 'border-border/20 opacity-50'
    }`}>
      <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/50">{slot.label}</p>
      <p className="text-[11px] font-mono text-foreground/80">{slot.device}</p>
      <p className="text-[9px] font-mono text-muted-foreground/40">{slot.vramGb.toFixed(1)} GB VRAM</p>
    </div>
  );
}

// ── Data upload step ──────────────────────────────────────────────────────────

function DataUploadStep({ sessionId, files, onFilesChange }: {
  sessionId: string;
  files:     UploadedFile[];
  onFilesChange: (files: UploadedFile[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr]             = useState<string | null>(null);
  const inputRef                  = useRef<HTMLInputElement>(null);

  // Native OS multi-file picker — files copied server-side, no HTTP upload stream
  async function pickFiles() {
    setUploading(true); setErr(null);
    try {
      const r = await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/pick-files`,
        { method: 'POST' },
      );
      const d = await r.json() as { ok: boolean; files: { name: string; sizeBytes: number }[] };
      if (!r.ok) throw new Error((d as any).error ?? 'Pick failed');
      onFilesChange(d.files);
    } catch (e) { setErr((e as Error).message); }
    setUploading(false);
  }

  // Native OS folder picker — all valid files in folder copied server-side
  async function pickFolder() {
    setUploading(true); setErr(null);
    try {
      const r = await fetch(
        `${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/dataset/pick-folder`,
        { method: 'POST' },
      );
      const d = await r.json() as { ok: boolean; files: { name: string; sizeBytes: number }[] };
      if (!r.ok) throw new Error((d as any).error ?? 'Pick failed');
      onFilesChange(d.files);
    } catch (e) { setErr((e as Error).message); }
    setUploading(false);
  }

  // Browser drag-and-drop fallback
  async function handleFiles(picked: FileList) {
    setUploading(true); setErr(null);
    const fd = new FormData();
    Array.from(picked).forEach(f => fd.append('files', f));
    try {
      const res  = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions/${sessionId}/upload`, { method: 'POST', body: fd });
      const data = await res.json() as { files?: UploadedFile[] };
      if (!res.ok) throw new Error((data as any).error ?? 'Upload failed');
      onFilesChange([...files, ...(data.files ?? [])]);
    } catch (e) { setErr((e as Error).message); }
    setUploading(false);
  }

  return (
    <div className="space-y-4">
      <div className="border border-seren/20 bg-seren/5  px-4 py-3">
        <p className="text-[11px] font-mono text-seren/80 leading-relaxed">
          Upload conversation exports so the model can learn your writing style.
        </p>
        <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">
          Accepts .txt, .json, .csv — WhatsApp exports, iMessage backups, Discord logs.
        </p>
      </div>

      {/* Native pickers */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={pickFiles} disabled={uploading}
          className="flex items-center justify-center gap-2 py-2.5 border border-border/30 hover:border-seren/40  text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/60 hover:text-seren transition-all disabled:opacity-40">
          <FileText className="w-3.5 h-3.5" />
          Pick Files
        </button>
        <button onClick={pickFolder} disabled={uploading}
          className="flex items-center justify-center gap-2 py-2.5 border border-border/30 hover:border-seren/40  text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/60 hover:text-seren transition-all disabled:opacity-40">
          <Upload className="w-3.5 h-3.5" />
          Pick Folder
        </button>
      </div>

      {/* Drag-and-drop fallback */}
      <div
        className="border border-dashed border-border/20 hover:border-border/35  p-4 transition-colors cursor-pointer text-center"
        onClick={() => inputRef.current?.click()}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
        onDragOver={e => e.preventDefault()}
      >
        <input ref={inputRef} type="file" className="hidden" multiple accept=".txt,.json,.csv"
          onChange={e => { if (e.target.files?.length) handleFiles(e.target.files); }} />
        {uploading
          ? <Loader2 className="w-4 h-4 text-muted-foreground/30 animate-spin mx-auto" />
          : <p className="text-[10px] font-mono text-phob-steel/30">or drag and drop files here</p>
        }
      </div>

      {err && <p className="text-[10px] font-mono text-red-400/70">{err}</p>}
      {files.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-phob-steel/30">{files.length} file{files.length !== 1 ? 's' : ''} ready</p>
          {files.map(f => (
            <div key={f.name} className="flex items-center justify-between px-3 py-1.5 border border-border/20  bg-phob-white/3">
              <div className="flex items-center gap-2">
                <FileText className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                <span className="text-[11px] font-mono text-foreground/70 truncate max-w-[260px]">{f.name}</span>
              </div>
              <span className="text-[9px] font-mono text-muted-foreground/40 shrink-0 ml-2">{fmtBytes(f.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── VoiceTrainer ──────────────────────────────────────────────────────────────

type VoiceTrainPhase = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

function VoiceTrainer({ onLinked, onUnlink, linkedProfileName }: {
  onLinked:          (profileId: string, profileName: string) => void;
  onUnlink:          () => void;
  linkedProfileName: string | null;
}) {
  const [phase,    setPhase]    = useState<VoiceTrainPhase>('idle');
  const [log,      setLog]      = useState<string[]>([]);
  const [error,    setError]    = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const appendLog = useCallback((line: string) => {
    setLog(prev => { const next = [...prev, line]; return next.length > 40 ? next.slice(-40) : next; });
  }, []);

  const handlePick = useCallback(async () => {
    setPhase('uploading'); setError(null); setLog([]); setFileName(null);
    try {
      // Open native OS file picker — file is copied server-side, no HTTP upload
      const pickRes = await fetch(`${ENGINE_URL}/api/audio/pick-ref`, { method: 'POST' });
      if (!pickRes.ok) throw new Error('Failed to open file picker');
      const { serverPath } = await pickRes.json() as { serverPath: string | null };
      if (!serverPath) { setPhase('idle'); return; } // user cancelled
      setFileName(serverPath.split(/[\\/]/).pop() ?? serverPath);
      const profileName = (serverPath.split(/[\\/]/).pop() ?? 'My Voice').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My Voice';
      setPhase('processing');
      appendLog('Starting voice profile extraction…');
      const res = await fetch(`${ENGINE_URL}/api/audio/voice-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refAudioPath: serverPath, name: profileName }),
      });
      if (!res.ok || !res.body) throw new Error('Voice profile extraction failed to start');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf2 = '';
      let createdId: string | null = null;
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf2 += dec.decode(value, { stream: true });
        const lines = buf2.split('\n');
        buf2 = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as { type: string; message?: string; profile?: { id: string } };
            if (evt.type === 'progress' && evt.message) appendLog(evt.message);
            else if (evt.type === 'done' && evt.profile) { createdId = evt.profile.id; appendLog('Profile created successfully.'); break outer; }
            else if (evt.type === 'error') throw new Error(evt.message ?? 'Extraction error');
          } catch (pe) { if ((pe as Error).message !== 'Unexpected token') throw pe; }
        }
      }
      if (!createdId) throw new Error('No profile ID returned');
      setPhase('done');
      onLinked(createdId, profileName);
    } catch (e) { setError((e as Error).message); setPhase('error'); }
  }, [appendLog, onLinked]);

  if (linkedProfileName && phase !== 'processing' && phase !== 'uploading') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2.5 px-3 py-2.5 border border-phob-green/25 bg-phob-green/5 ">
          <Radio className="w-3.5 h-3.5 text-phob-green/70 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-mono text-phob-green/80 truncate">{linkedProfileName}</p>
            <p className="text-[9px] font-mono text-muted-foreground/40 mt-0.5">Voice profile linked</p>
          </div>
          <button onClick={onUnlink} className="text-[9px] font-mono text-muted-foreground/30 hover:text-red-400/60 transition-colors shrink-0">unlink</button>
        </div>
        <button onClick={() => { setPhase('idle'); setLog([]); setError(null); setFileName(null); }}
          className="w-full py-1.5 text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground/60 border border-dashed border-border/20 hover:border-border/35  transition-colors">
          Replace voice profile
        </button>
      </div>
    );
  }

  if (phase === 'processing' || phase === 'done' || phase === 'error') {
    return (
      <div className="space-y-3">
        <div className="bg-phob-white/6 border border-border/20  p-3 h-36 overflow-y-auto font-mono text-[10px] space-y-0.5">
          {log.map((l, i) => (
            <p key={i} className={`leading-relaxed ${l.toLowerCase().includes('error') ? 'text-red-400/70' : l.toLowerCase().includes('success') || l.toLowerCase().includes('done') ? 'text-phob-green/70' : 'text-muted-foreground/50'}`}>{l}</p>
          ))}
          {phase === 'processing' && <p className="text-muted-foreground/30 animate-pulse">…</p>}
        </div>
        {phase === 'error' && error && <p className="text-[10px] font-mono text-red-400/70">{error}</p>}
        {phase === 'error' && (
          <button onClick={() => { setPhase('idle'); setLog([]); setError(null); setFileName(null); }}
            className="text-[10px] font-mono text-muted-foreground/40 hover:text-muted-foreground/60 underline underline-offset-2 transition-colors">Try again</button>
        )}
      </div>
    );
  }

  if (phase === 'uploading') {
    return (
      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/40 py-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        Opening file picker…
      </div>
    );
  }

  // ── Idle — native picker button ─────────────────────────────────────────────
  return (
    <button
      onClick={handlePick}
      className="w-full border border-dashed border-border/25 hover:border-seren/30  p-4 transition-colors group"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Mic className="w-5 h-5 text-muted-foreground/20 group-hover:text-seren/40 transition-colors" />
        <p className="text-[11px] font-mono text-muted-foreground/50 group-hover:text-muted-foreground/70 transition-colors">
          Choose a voice recording
        </p>
        <p className="text-[9px] font-mono text-phob-steel/30">.wav · .mp3 · .flac — at least 8 seconds, clear speech</p>
      </div>
    </button>
  );
}

// ── Clone list view ────────────────────────────────────────────────────────────

function CloneListView({ clones, loading, onSelect, onCreate, onUserProfile }: {
  clones:        WecloneProfile[];
  loading:       boolean;
  onSelect:      (clone: WecloneProfile) => void;
  onCreate:      () => void;
  onUserProfile: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <Loader2 className="w-5 h-5 text-muted-foreground/30 animate-spin" />
          </div>
        ) : clones.length === 0 ? (
          <div className="text-center py-10 space-y-2">
            <p className="text-[12px] font-mono text-muted-foreground/40">No clones yet.</p>
            <p className="text-[10px] font-mono text-muted-foreground/25">Create your first digital clone below.</p>
          </div>
        ) : (
          clones.map(clone => (
            <button
              key={clone.id}
              onClick={() => onSelect(clone)}
              className="w-full text-left border border-border/25 hover:border-seren/30  px-4 py-3 bg-phob-white/3 hover:bg-seren/5 transition-all group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${clone.cartridgeActive ? 'bg-seren animate-pulse' : 'bg-border/40'}`} />
                  <div>
                    <p className="text-[12px] font-mono text-foreground/80 group-hover:text-foreground transition-colors">
                      {clone.display_name || 'Unnamed Clone'}
                    </p>
                    <p className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">
                      {clone.slot?.toUpperCase() ?? '—'} slot
                      {clone.cartridgeName ? ` · ${clone.cartridgeName}` : ' · no LM trained'}
                      {clone.hasVoiceProfile ? ' · voice ✓' : ''}
                    </p>
                  </div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
              </div>
            </button>
          ))
        )}
      </div>

      {/* Footer actions */}
      <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center gap-2">
        <button
          onClick={onCreate}
          className="flex items-center gap-1.5 px-4 py-2 bg-seren/10 border border-seren/30 text-seren text-[10px] font-terminal uppercase tracking-[0.18em]  hover:bg-seren/15 hover:border-seren/50 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          New Clone
        </button>
        <button
          onClick={onUserProfile}
          className="ml-auto flex items-center gap-1.5 px-4 py-2 border border-border/25 text-muted-foreground/50 text-[10px] font-terminal uppercase tracking-[0.18em]  hover:border-border/45 hover:text-muted-foreground/70 transition-all"
        >
          <User className="w-3.5 h-3.5" />
          About Me
        </button>
      </div>
    </div>
  );
}

// ── Progress helpers ──────────────────────────────────────────────────────────

const IDENTITY_FIELDS: (keyof WecloneProfile)[] = [
  'display_name', 'age', 'gender', 'pronouns',
  'appearance', 'personality_desc', 'background',
  'interests', 'dislikes', 'hobbies',
  'goals', 'fears', 'values', 'expertise',
  'relationship_style', 'love_language', 'dealbreakers',
];

function identityFieldsFilled(clone: WecloneProfile): number {
  return IDENTITY_FIELDS.filter(f => {
    const v = clone[f];
    return typeof v === 'string' && v.trim().length > 0;
  }).length;
}

const PERSONALITY_TOTAL = 6;

function personalityFieldsFilled(clone: WecloneProfile): number {
  let n = 0;
  if (clone.communication_style?.trim())                                       n++;
  try { if ((JSON.parse(clone.love_topics || '[]') as unknown[]).length > 0)  n++; } catch { /**/ }
  try { if ((JSON.parse(clone.avoid_topics || '[]') as unknown[]).length > 0) n++; } catch { /**/ }
  if (clone.humor_style && clone.humor_style !== 'None')                       n++;
  if (clone.context_summary?.trim())                                            n++;
  if (clone.limits_summary?.trim())                                             n++;
  return n;
}

function ProgressBadge({ value, total, done, doneLabel, emptyLabel }: {
  value?: number; total?: number;
  done?: boolean; doneLabel: string; emptyLabel: string;
}) {
  if (done) {
    return (
      <span className="text-[9px] font-mono text-phob-green/70 bg-phob-green/10 border border-phob-green/20  px-1.5 py-0.5 shrink-0">
        {doneLabel}
      </span>
    );
  }
  if (value !== undefined && total !== undefined && value > 0) {
    return (
      <span className="text-[9px] font-mono text-seren/50 bg-seren/8 border border-seren/15  px-1.5 py-0.5 shrink-0">
        {value}/{total}
      </span>
    );
  }
  return (
    <span className="text-[9px] font-mono text-muted-foreground/25 shrink-0">
      {emptyLabel}
    </span>
  );
}

// ── Clone detail view ─────────────────────────────────────────────────────────

function CloneDetailView({ clone, onIdentity, onLmTrain, onVoiceTrain, onPersonality, onDelete, onVoiceLinked, onVoiceUnlink }: {
  clone:         WecloneProfile;
  onIdentity:    () => void;
  onLmTrain:     () => void;
  onVoiceTrain:  () => void;
  onPersonality: () => void;
  onDelete:      () => void;
  onVoiceLinked: (id: string, name: string) => void;
  onVoiceUnlink: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">

        {/* Status banner */}
        <div className="border border-seren/25 bg-seren/5  px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className={`w-2 h-2 rounded-full ${clone.cartridgeActive ? 'bg-seren animate-pulse' : 'bg-border/40'}`} />
            <span className="text-[12px] font-terminal text-seren/90 tracking-wider">
              {clone.display_name || 'UNNAMED CLONE'}
              {clone.cartridgeActive ? ' · ACTIVE' : ' · INACTIVE'}
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/40 border border-border/20 px-2 py-0.5 ">
            {clone.slot?.toUpperCase() ?? '—'} slot
          </span>
        </div>

        {/* Training stats */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'LM TURNS',  value: clone.turnCount != null ? `${clone.turnCount.toLocaleString()} turns` : '—' },
            { label: 'VOICE',     value: clone.hasVoiceProfile ? clone.voiceProfileName ?? 'linked' : '—' },
            { label: 'TRAINED',   value: clone.trainedAt ? new Date(clone.trainedAt).toLocaleDateString() : '—' },
          ].map(s => (
            <div key={s.label} className="border border-border/20  px-3 py-2 bg-phob-white/4">
              <p className="text-[8px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35 mb-1">{s.label}</p>
              <p className="text-[11px] font-mono text-foreground/80 truncate">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="space-y-2">
          <SectionLabel>Configure</SectionLabel>

          <button onClick={onIdentity}
            className="w-full flex items-center justify-between px-4 py-3 border border-border/25 hover:border-seren/30  hover:bg-seren/5 transition-all group">
            <div className="flex items-center gap-3">
              <User className="w-4 h-4 text-muted-foreground/40 group-hover:text-seren/60 transition-colors shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-mono text-foreground/70 group-hover:text-foreground transition-colors">Identity Profile</p>
                <p className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">Who your clone is — # YOU ARE context</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ProgressBadge
                value={identityFieldsFilled(clone)}
                total={IDENTITY_FIELDS.length}
                done={identityFieldsFilled(clone) === IDENTITY_FIELDS.length}
                doneLabel="complete"
                emptyLabel="not set"
              />
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
            </div>
          </button>

          <button onClick={onPersonality}
            className="w-full flex items-center justify-between px-4 py-3 border border-border/25 hover:border-seren/30  hover:bg-seren/5 transition-all group">
            <div className="flex items-center gap-3">
              <Settings className="w-4 h-4 text-muted-foreground/40 group-hover:text-seren/60 transition-colors shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-mono text-foreground/70 group-hover:text-foreground transition-colors">Personality & Tuning</p>
                <p className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">Communication style, tone, inference settings</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ProgressBadge
                value={personalityFieldsFilled(clone)}
                total={PERSONALITY_TOTAL}
                done={personalityFieldsFilled(clone) === PERSONALITY_TOTAL}
                doneLabel="complete"
                emptyLabel="not set"
              />
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
            </div>
          </button>
        </div>

        <div className="space-y-2">
          <SectionLabel>Training</SectionLabel>

          <button onClick={onLmTrain}
            className="w-full flex items-center justify-between px-4 py-3 border border-border/25 hover:border-seren/30  hover:bg-seren/5 transition-all group">
            <div className="flex items-center gap-3">
              <Brain className="w-4 h-4 text-muted-foreground/40 group-hover:text-seren/60 transition-colors shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-mono text-foreground/70 group-hover:text-foreground transition-colors">
                  {clone.cartridge_id ? 'Retrain Language Model' : 'Train Language Model'}
                </p>
                <p className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">
                  {clone.cartridge_id ? `Currently: ${clone.cartridgeName ?? 'trained'}` : 'Teach this clone your writing style'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ProgressBadge
                done={!!clone.cartridge_id}
                doneLabel={clone.turnCount ? `${clone.turnCount.toLocaleString()} turns` : 'trained'}
                emptyLabel="not trained"
              />
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
            </div>
          </button>

          <button onClick={onVoiceTrain}
            className="w-full flex items-center justify-between px-4 py-3 border border-border/25 hover:border-seren/30  hover:bg-seren/5 transition-all group">
            <div className="flex items-center gap-3">
              <Mic className="w-4 h-4 text-muted-foreground/40 group-hover:text-seren/60 transition-colors shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-mono text-foreground/70 group-hover:text-foreground transition-colors">
                  {clone.hasVoiceProfile ? 'Replace Voice Profile' : 'Train Voice'}
                </p>
                <p className="text-[9px] font-mono text-muted-foreground/35 mt-0.5">
                  {clone.hasVoiceProfile ? `Voice: ${clone.voiceProfileName ?? 'linked'}` : 'Upload a recording to clone your voice'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ProgressBadge
                done={!!clone.hasVoiceProfile}
                doneLabel="linked"
                emptyLabel="not trained"
              />
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/25 group-hover:text-muted-foreground/50 transition-colors" />
            </div>
          </button>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center">
        <button onClick={onDelete}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 border border-red-900/30 text-red-400/50 text-[10px] font-terminal uppercase tracking-[0.15em]  hover:border-red-900/50 hover:text-red-400/80 transition-all">
          <Trash2 className="w-3 h-3" />
          Delete Clone
        </button>
      </div>
    </div>
  );
}

// ── Main WeclonePanel ─────────────────────────────────────────────────────────

export function WeclonePanel({ onClose }: { onClose: () => void }) {
  const [view,        setView]        = useState<PanelView>('list');
  const [loading,     setLoading]     = useState(true);
  const [clones,      setClones]      = useState<WecloneProfile[]>([]);
  const [activeClone, setActiveClone] = useState<WecloneProfile | null>(null);
  const [slots,       setSlots]       = useState<SlotInfo[]>([]);

  // LM training wizard state
  const [modelId,    setModelId]    = useState('qwen3.5-4b-q4');
  const [chosenSlot, setChosenSlot] = useState<'sayon' | 'seren'>('seren');
  const [sessionId,  setSessionId]  = useState<string | null>(null);
  const [files,      setFiles]      = useState<UploadedFile[]>([]);
  const [wizStep,    setWizStep]    = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [wizErr,     setWizErr]     = useState<string | null>(null);

  // Identity draft
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft>(BLANK_IDENTITY);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityErr,    setIdentityErr]    = useState<string | null>(null);

  // Personality draft
  const [personalityDraft, setPersonalityDraft] = useState<PersonalityDraft>(BLANK_PERSONALITY);
  const [personalitySaving, setPersonalitySaving] = useState(false);
  const [personalityErr,    setPersonalityErr]    = useState<string | null>(null);

  // User profile draft
  const [userDraft,   setUserDraft]   = useState<IdentityDraft>(BLANK_IDENTITY);
  const [userSaving,  setUserSaving]  = useState(false);
  const [userErr,     setUserErr]     = useState<string | null>(null);

  // Voice profile optimistic state per clone
  const [voiceProfileName, setVoiceProfileName] = useState<string | null>(null);

  // ── Fetch clones ────────────────────────────────────────────────────────────

  const fetchClones = useCallback(async () => {
    setLoading(true);
    try {
      const res    = await fetch(`${ENGINE_URL}/api/weclone/clones`);
      if (!res.ok) { setLoading(false); return; }
      const data   = await res.json() as { clones: WecloneProfile[] };
      setClones(data.clones);
      // Refresh activeClone if it's open
      if (activeClone) {
        const refreshed = data.clones.find(c => c.id === activeClone.id);
        if (refreshed) setActiveClone(refreshed);
      }
    } catch { /* non-fatal */ }
    setLoading(false);
  }, [activeClone]);

  const fetchSlots = useCallback(async () => {
    const required = TRAINABLE_MODELS.find(m => m.modelId === modelId)?.vramGb ?? 0;
    try {
      const [statusRes, hwRes] = await Promise.all([
        fetch(`${ENGINE_URL}/api/phobos/status`),
        fetch(`${ENGINE_URL}/api/phobos/hardware`),
      ]);
      const statusData = statusRes.ok
        ? await statusRes.json() as { status: { sayon: { deviceIndex?: number }; seren: { deviceIndex?: number } } }
        : null;
      const hwData = hwRes.ok
        ? await hwRes.json() as { hardware: { gpus: { index: number; name: string; vramGb: number }[] } }
        : null;

      const gpus  = hwData?.hardware.gpus ?? [];
      const gpuAt = (idx: number | undefined) =>
        idx !== undefined ? gpus.find(g => g.index === idx) ?? null : null;

      const sayonGpu = gpuAt(statusData?.status.sayon.deviceIndex);
      const serenGpu = gpuAt(statusData?.status.seren.deviceIndex);

      // Fall back to vram-check if status/hardware didn't give us what we need
      const fallback = async (persona: 'sayon' | 'seren') => {
        const r = await fetch(`${ENGINE_URL}/api/phobos/training/lm/vram-check?baseModelId=${encodeURIComponent(modelId)}&rank=16&persona=${persona}`);
        return r.ok ? await r.json() as { totalGb: number; device: string } : null;
      };

      const [sf, se] = sayonGpu && serenGpu
        ? [null, null]
        : await Promise.all([fallback('sayon'), fallback('seren')]);

      setSlots([
        {
          persona:   'sayon',
          label:     'SAYON slot',
          device:    sayonGpu?.name ?? sf?.device ?? 'CPU',
          vramGb:    sayonGpu?.vramGb ?? sf?.totalGb ?? 0,
          available: (sayonGpu?.vramGb ?? sf?.totalGb ?? 0) >= required,
        },
        {
          persona:   'seren',
          label:     'SEREN slot',
          device:    serenGpu?.name ?? se?.device ?? 'CPU',
          vramGb:    serenGpu?.vramGb ?? se?.totalGb ?? 0,
          available: (serenGpu?.vramGb ?? se?.totalGb ?? 0) >= required,
        },
      ]);
    } catch { /* non-fatal */ }
  }, [modelId]);

  const fetchUserProfile = useCallback(async () => {
    try {
      const res  = await fetch(`${ENGINE_URL}/api/weclone/user-profile`);
      if (!res.ok) return;
      const data = await res.json() as { profile: UserProfile | null };
      if (data.profile) {
        setUserDraft({
          displayName:       data.profile.display_name,
          age:               data.profile.age,
          gender:            data.profile.gender,
          pronouns:          data.profile.pronouns,
          appearance:        data.profile.appearance,
          personalityDesc:   data.profile.personality,
          background:        data.profile.background,
          interests:         data.profile.interests,
          dislikes:          data.profile.dislikes,
          hobbies:           data.profile.hobbies,
          goals:             data.profile.goals,
          fears:             data.profile.fears,
          values:            data.profile.values,
          expertise:         data.profile.expertise,
          relationshipStyle: data.profile.relationship_style,
          loveLanguage:      data.profile.love_language,
          dealbreakers:      data.profile.dealbreakers,
        });
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { fetchClones(); fetchSlots(); }, []);

  // ── Load identity/personality when entering edit views ──────────────────────

  function loadIdentityDraft(clone: WecloneProfile) {
    setIdentityDraft({
      displayName:       clone.display_name,
      age:               clone.age ?? '',
      gender:            clone.gender ?? '',
      pronouns:          clone.pronouns ?? '',
      appearance:        clone.appearance ?? '',
      personalityDesc:   clone.personality_desc ?? '',
      background:        clone.background ?? '',
      interests:         clone.interests ?? '',
      dislikes:          clone.dislikes ?? '',
      hobbies:           clone.hobbies ?? '',
      goals:             clone.goals ?? '',
      fears:             clone.fears ?? '',
      values:            clone.values ?? '',
      expertise:         clone.expertise ?? '',
      relationshipStyle: clone.relationship_style ?? '',
      loveLanguage:      clone.love_language ?? '',
      dealbreakers:      clone.dealbreakers ?? '',
    });
  }

  function loadPersonalityDraft(clone: WecloneProfile) {
    setPersonalityDraft({
      communicationStyle: clone.communication_style ?? '',
      loveTopics:         (JSON.parse(clone.love_topics || '[]') as string[]).join(', '),
      avoidTopics:        (JSON.parse(clone.avoid_topics || '[]') as string[]).join(', '),
      humorStyle:         clone.humor_style ?? 'None',
      responseLength:     clone.response_length ?? 0.5,
      formality:          clone.formality ?? 0.4,
      firstPerson:        clone.first_person ?? true,
      contextSummary:     clone.context_summary ?? '',
      limitsSummary:      clone.limits_summary ?? '',
      temperature:        clone.temperature ?? 0.7,
      topP:               clone.top_p ?? 0.9,
      contextWindow:      clone.context_window ?? 4096,
    });
  }

  // ── Save handlers ───────────────────────────────────────────────────────────

  async function saveIdentity() {
    if (!activeClone) return;
    setIdentitySaving(true); setIdentityErr(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName:       identityDraft.displayName,
          age:               identityDraft.age,
          gender:            identityDraft.gender,
          pronouns:          identityDraft.pronouns,
          appearance:        identityDraft.appearance,
          personalityDesc:   identityDraft.personalityDesc,
          background:        identityDraft.background,
          interests:         identityDraft.interests,
          dislikes:          identityDraft.dislikes,
          hobbies:           identityDraft.hobbies,
          goals:             identityDraft.goals,
          fears:             identityDraft.fears,
          values:            identityDraft.values,
          expertise:         identityDraft.expertise,
          relationshipStyle: identityDraft.relationshipStyle,
          loveLanguage:      identityDraft.loveLanguage,
          dealbreakers:      identityDraft.dealbreakers,
        }),
      });
      if (!res.ok) { const e = await res.json() as any; throw new Error(e.error ?? 'Save failed'); }
      const updated = await res.json() as WecloneProfile;
      setActiveClone(updated);
      setClones(prev => prev.map(c => c.id === updated.id ? updated : c));
      setView('detail');
    } catch (e) { setIdentityErr((e as Error).message); }
    setIdentitySaving(false);
  }

  async function savePersonality() {
    if (!activeClone) return;
    setPersonalitySaving(true); setPersonalityErr(null);
    const loveArr  = personalityDraft.loveTopics.split(',').map(t => t.trim()).filter(Boolean);
    const avoidArr = personalityDraft.avoidTopics.split(',').map(t => t.trim()).filter(Boolean);
    const systemPrompt = buildSystemPrompt({
      displayName: activeClone.display_name || 'Your Clone',
      pronouns: activeClone.pronouns,
      communicationStyle: personalityDraft.communicationStyle,
      loveTopics: loveArr, avoidTopics: avoidArr,
      humorStyle: personalityDraft.humorStyle,
      responseLength: personalityDraft.responseLength,
      formality: personalityDraft.formality,
      firstPerson: personalityDraft.firstPerson,
      contextSummary: personalityDraft.contextSummary,
      limitsSummary: personalityDraft.limitsSummary,
    });
    try {
      const res = await fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          communicationStyle: personalityDraft.communicationStyle,
          loveTopics:  JSON.stringify(loveArr),
          avoidTopics: JSON.stringify(avoidArr),
          humorStyle:  personalityDraft.humorStyle,
          responseLength: personalityDraft.responseLength,
          formality:      personalityDraft.formality,
          firstPerson:    personalityDraft.firstPerson,
          contextSummary: personalityDraft.contextSummary,
          limitsSummary:  personalityDraft.limitsSummary,
          temperature:    personalityDraft.temperature,
          topP:           personalityDraft.topP,
          contextWindow:  personalityDraft.contextWindow,
          systemPrompt,
        }),
      });
      if (!res.ok) { const e = await res.json() as any; throw new Error(e.error ?? 'Save failed'); }
      const updated = await res.json() as WecloneProfile;
      setActiveClone(updated);
      setClones(prev => prev.map(c => c.id === updated.id ? updated : c));
      setView('detail');
    } catch (e) { setPersonalityErr((e as Error).message); }
    setPersonalitySaving(false);
  }

  async function saveUserProfile() {
    setUserSaving(true); setUserErr(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/weclone/user-profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName:       userDraft.displayName,
          age:               userDraft.age,
          gender:            userDraft.gender,
          pronouns:          userDraft.pronouns,
          appearance:        userDraft.appearance,
          personality:       userDraft.personalityDesc,
          background:        userDraft.background,
          interests:         userDraft.interests,
          dislikes:          userDraft.dislikes,
          hobbies:           userDraft.hobbies,
          goals:             userDraft.goals,
          fears:             userDraft.fears,
          values:            userDraft.values,
          expertise:         userDraft.expertise,
          relationshipStyle: userDraft.relationshipStyle,
          loveLanguage:      userDraft.loveLanguage,
          dealbreakers:      userDraft.dealbreakers,
        }),
      });
      if (!res.ok) { const e = await res.json() as any; throw new Error(e.error ?? 'Save failed'); }
      setView('list');
    } catch (e) { setUserErr((e as Error).message); }
    setUserSaving(false);
  }

  // ── LM training wizard ──────────────────────────────────────────────────────

  async function handleWizardNext() {
    setWizErr(null);
    if (wizStep === 0) {
      if (sessionId) { setWizStep(1); return; }
      setSubmitting(true);
      try {
        const res  = await fetch(`${ENGINE_URL}/api/phobos/training/lm/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: activeClone?.display_name || 'My Clone',
            description: 'Personal digital clone',
            author: 'local', baseModelId: modelId,
            targetPersona: chosenSlot, category: 'weclone',
            behaviorSummary: 'Personal digital clone', dataMode: 'conversation',
          }),
        });
        const body = await res.json() as { session_id?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? 'Failed to create session');
        setSessionId(body.session_id!);
        setWizStep(1);
      } catch (e) { setWizErr((e as Error).message); }
      setSubmitting(false);
      return;
    }
    if (wizStep === 1) setView('lm-training');
  }

  async function handleTrainingDone(cartridgeId: string) {
    if (!activeClone) return;
    // Activate cartridge then link it to the clone
    try {
      await fetch(`${ENGINE_URL}/api/cartridges/${chosenSlot}/activate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cartridgeId }),
      });
      await fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cartridgeId, slot: chosenSlot }),
      });
    } catch { /* non-fatal */ }
    await fetchClones();
    setView('detail');
  }

  // ── Delete clone ────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!activeClone) return;
    if (!window.confirm(`Delete "${activeClone.display_name || 'this clone'}"? The training cartridge will also be removed.`)) return;
    try {
      if (activeClone.cartridge_id) {
        await fetch(`${ENGINE_URL}/api/cartridges/${activeClone.cartridge_id}`, { method: 'DELETE' });
      }
      await fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}`, { method: 'DELETE' });
    } catch { /* non-fatal */ }
    setActiveClone(null);
    await fetchClones();
    setView('list');
  }

  // ── Voice link / unlink ─────────────────────────────────────────────────────

  function handleVoiceLinked(profileId: string, profileName: string) {
    setVoiceProfileName(profileName);
    if (activeClone) {
      fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}/voice`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceProfileId: profileId }),
      }).catch(() => {});
    }
  }

  async function handleVoiceUnlink() {
    if (activeClone) {
      await fetch(`${ENGINE_URL}/api/weclone/clones/${activeClone.id}/voice`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceProfileId: null }),
      }).catch(() => {});
    }
    setVoiceProfileName(null);
  }

  // ── Panel title ─────────────────────────────────────────────────────────────

  const titles: Record<PanelView, { title: string; sub?: string }> = {
    'list':         { title: 'DIGITAL CLONE' },
    'detail':       { title: activeClone?.display_name || 'CLONE', sub: 'clone profile' },
    'identity':     { title: 'IDENTITY PROFILE', sub: activeClone?.display_name },
    'lm-setup':     { title: 'TRAIN LANGUAGE MODEL', sub: activeClone?.display_name },
    'lm-training':  { title: 'CLONE TRAINING' },
    'personality':  { title: 'PERSONALITY & TUNING', sub: activeClone?.display_name },
    'voice-train':  { title: 'VOICE TRAINING', sub: activeClone?.display_name },
    'user-profile': { title: 'ABOUT ME', sub: '# YOU ARE TALKING TO' },
  };

  const { title, sub } = titles[view];
  const backView: Partial<Record<PanelView, PanelView>> = {
    'detail': 'list', 'identity': 'detail', 'lm-setup': 'detail',
    'personality': 'detail', 'voice-train': 'detail', 'user-profile': 'list',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-phob-white/6 backdrop-blur-sm">
      <div className="phobos-weclone-panel w-[680px] max-h-[88vh] bg-card border border-seren/20 shadow-[0_0_24px_rgba(207,255,4,0.08)]  flex flex-col overflow-hidden">

        <PanelHeader
          title={title}
          sub={sub}
          onClose={onClose}
          onBack={backView[view] ? () => setView(backView[view]!) : undefined}
        />

        {/* LIST */}
        {view === 'list' && (
          <CloneListView
            clones={clones}
            loading={loading}
            onSelect={clone => {
              setActiveClone(clone);
              setVoiceProfileName(clone.voiceProfileName ?? null);
              setView('detail');
            }}
            onCreate={() => {
              setActiveClone(null);
              setSessionId(null);
              setFiles([]);
              setWizStep(0);
              setWizErr(null);
              // Create a blank stub clone first, then go to lm-setup
              fetch(`${ENGINE_URL}/api/weclone/clones`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName: 'New Clone', slot: 'seren' }),
              })
                .then(r => r.json() as Promise<WecloneProfile>)
                .then(clone => {
                  setActiveClone(clone);
                  setClones(prev => [...prev, clone]);
                  setView('detail');
                })
                .catch(() => {});
            }}
            onUserProfile={() => { fetchUserProfile(); setView('user-profile'); }}
          />
        )}

        {/* DETAIL */}
        {view === 'detail' && activeClone && (
          <CloneDetailView
            clone={{ ...activeClone, voiceProfileName: voiceProfileName ?? activeClone.voiceProfileName }}
            onIdentity={() => { loadIdentityDraft(activeClone); setView('identity'); }}
            onLmTrain={() => { setSessionId(null); setFiles([]); setWizStep(0); fetchSlots(); setView('lm-setup'); }}
            onVoiceTrain={() => setView('voice-train')}
            onPersonality={() => { loadPersonalityDraft(activeClone); setView('personality'); }}
            onDelete={handleDelete}
            onVoiceLinked={handleVoiceLinked}
            onVoiceUnlink={handleVoiceUnlink}
          />
        )}

        {/* IDENTITY */}
        {view === 'identity' && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
              <IdentityForm draft={identityDraft} onChange={p => setIdentityDraft(d => ({ ...d, ...p }))} heading="## YOU ARE" />
              {identityErr && <p className="text-[11px] font-mono text-red-400/70 mt-4">{identityErr}</p>}
            </div>
            <div className="px-5 py-3 border-t border-border/30 shrink-0 flex justify-end">
              <button onClick={saveIdentity} disabled={identitySaving}
                className="flex items-center gap-2 px-5 py-2 bg-seren/15 border border-seren/40 text-seren text-[11px] font-terminal uppercase tracking-[0.2em]  hover:bg-seren/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {identitySaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {identitySaving ? 'Saving…' : 'Save Identity'}
              </button>
            </div>
          </div>
        )}

        {/* PERSONALITY */}
        {view === 'personality' && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
              <PersonalityForm draft={personalityDraft} onChange={p => setPersonalityDraft(d => ({ ...d, ...p }))} />
              {personalityErr && <p className="text-[11px] font-mono text-red-400/70 mt-4">{personalityErr}</p>}
            </div>
            <div className="px-5 py-3 border-t border-border/30 shrink-0 flex justify-end">
              <button onClick={savePersonality} disabled={personalitySaving}
                className="flex items-center gap-2 px-5 py-2 bg-seren/15 border border-seren/40 text-seren text-[11px] font-terminal uppercase tracking-[0.2em]  hover:bg-seren/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {personalitySaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {personalitySaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* LM SETUP WIZARD */}
        {view === 'lm-setup' && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center gap-0 px-5 pt-4 pb-3 shrink-0">
              {['Choose model', 'Add your data'].map((label, i) => (
                <div key={i} className="flex items-center gap-0">
                  <div className={`flex items-center gap-2 px-3 py-1.5  text-[10px] font-terminal uppercase tracking-[0.18em] ${
                    i === wizStep ? 'text-seren bg-seren/8 border border-seren/25'
                    : i < wizStep ? 'text-muted-foreground/50' : 'text-muted-foreground/25'
                  }`}>
                    <span>{i + 1}</span><span>{label}</span>
                  </div>
                  {i < 1 && <ChevronRight className="w-3 h-3 text-border/30 mx-1" />}
                </div>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-5 min-h-0">
              {wizStep === 0 && (
                <>
                  <p className="text-[12px] font-mono text-foreground/80 leading-relaxed">
                    Choose a base model. More VRAM = smarter starting point.
                  </p>
                  <div className="space-y-1.5">
                    {TRAINABLE_MODELS.map(m => {
                      const required  = m.vramGb;
                      const available = slots.some(s => s.vramGb >= required);
                      return (
                        <button key={m.modelId} onClick={() => setModelId(m.modelId)}
                          className={`w-full flex items-center justify-between px-4 py-2.5  border transition-all ${
                            modelId === m.modelId ? 'border-seren/50 bg-seren/8 text-seren' : 'border-border/20 text-foreground/70 hover:border-border/40'
                          }`}>
                          <div className="flex items-center gap-2.5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${modelId === m.modelId ? 'bg-seren' : 'bg-transparent border border-border/40'}`} />
                            <span className="text-[12px] font-mono">{m.label}</span>
                            <span className="text-[9px] font-mono text-muted-foreground/35">{m.family}</span>
                          </div>
                          <span className={`text-[10px] font-mono ${available ? 'text-phob-green/60' : 'text-muted-foreground/30'}`}>
                            {m.vramGb} GB VRAM
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="space-y-2">
                    <p className="text-[9px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35">Which slot</p>
                    <div className="grid grid-cols-2 gap-2">
                      {slots.map(s => (
                        <button key={s.persona} onClick={() => setChosenSlot(s.persona)}
                          className={`text-left transition-all  ${chosenSlot === s.persona ? 'ring-1 ring-seren/40' : ''}`}>
                          <SlotBadge slot={s} available={s.available} />
                        </button>
                      ))}
                    </div>
                    {slots.length > 0 && (
                      <p className="text-[9px] font-mono text-muted-foreground/35">
                        {TRAINABLE_MODELS.find(m => m.modelId === modelId)?.label} requires {TRAINABLE_MODELS.find(m => m.modelId === modelId)?.vramGb} GB VRAM ·{' '}
                        <span className={slots.find(s => s.persona === chosenSlot)?.available ? 'text-phob-green/60' : 'text-red-400/60'}>
                          {slots.find(s => s.persona === chosenSlot)?.available ? '✓ sufficient' : '✗ insufficient'}
                        </span>
                      </p>
                    )}
                  </div>
                  {wizErr && <p className="text-[10px] font-mono text-red-400/70">{wizErr}</p>}
                </>
              )}

              {wizStep === 1 && sessionId && (
                <DataUploadStep sessionId={sessionId} files={files} onFilesChange={setFiles} />
              )}
            </div>

            <div className="px-5 py-3 border-t border-border/30 shrink-0 flex items-center justify-between">
              {wizStep > 0
                ? <button onClick={() => setWizStep(s => s - 1)} className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors">
                    <ChevronLeft className="w-3.5 h-3.5" /> Back
                  </button>
                : <div />
              }
              <button onClick={handleWizardNext} disabled={submitting}
                className="flex items-center gap-2 px-5 py-2 bg-seren/15 border border-seren/40 text-seren text-[11px] font-terminal uppercase tracking-[0.2em]  hover:bg-seren/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {wizStep === 1 ? 'Start Training' : 'Next'}
                {!submitting && wizStep < 1 && <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )}

        {/* LM TRAINING */}
        {view === 'lm-training' && sessionId && (
          <div className="flex-1 min-h-0">
            <LmTrainingPanel
              sessionId={sessionId}
              onCancel={() => setView('lm-setup')}
              onDone={handleTrainingDone}
            />
          </div>
        )}

        {/* VOICE TRAIN */}
        {view === 'voice-train' && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 space-y-4">
              <p className="text-[11px] font-mono text-muted-foreground/50 leading-relaxed">
                Upload a voice recording so this clone can speak in your voice during TTS-enabled sessions.
                Use a clear recording with minimal background noise — at least 8 seconds.
              </p>
              <VoiceTrainer
                linkedProfileName={voiceProfileName ?? activeClone?.voiceProfileName ?? null}
                onLinked={handleVoiceLinked}
                onUnlink={handleVoiceUnlink}
              />
            </div>
          </div>
        )}

        {/* USER PROFILE */}
        {view === 'user-profile' && (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
              <IdentityForm draft={userDraft} onChange={p => setUserDraft(d => ({ ...d, ...p }))} heading="## YOU ARE TALKING TO" />
              {userErr && <p className="text-[11px] font-mono text-red-400/70 mt-4">{userErr}</p>}
            </div>
            <div className="px-5 py-3 border-t border-border/30 shrink-0 flex justify-end">
              <button onClick={saveUserProfile} disabled={userSaving}
                className="flex items-center gap-2 px-5 py-2 bg-seren/15 border border-seren/40 text-seren text-[11px] font-terminal uppercase tracking-[0.2em]  hover:bg-seren/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {userSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {userSaving ? 'Saving…' : 'Save Profile'}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}