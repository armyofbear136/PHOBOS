import { useState, useRef, useCallback } from 'react';
import { Save, Trash2, Upload, X, FileCode2, Package, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { UserSkillRecord, DepFile } from './SkillTypes';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── File section tabs ─────────────────────────────────────────────────────────

type LogicTab = 'skill_md' | 'runner' | 'seren_context';

const LOGIC_TAB_LABELS: Record<LogicTab, string> = {
  skill_md:      'SKILL.md',
  runner:        'runner.ts',
  seren_context: 'seren_context.md',
};

// ── Dep file tree ─────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DepFileTree({
  skillId,
  deps,
  onDepsChanged,
}: {
  skillId: string;
  deps: DepFile[];
  onDepsChanged: (deps: DepFile[]) => void;
}) {
  const [dragging,   setDragging]   = useState(false);
  const [uploading,  setUploading]  = useState<string[]>([]);
  const [removing,   setRemoving]   = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(async (files: FileList) => {
    if (!skillId) {
      toast.error('Save the skill first before adding dependencies');
      return;
    }

    const names = Array.from(files).map(f => f.name);
    setUploading(names);

    const newDeps = [...deps];
    try {
      for (const file of Array.from(files)) {
        const res = await fetch(
          `${ENGINE_URL}/api/user-skills/${encodeURIComponent(skillId)}/deps?filename=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
        );
        if (res.ok) {
          const data = await res.json() as { dep: DepFile };
          // Replace or add
          const idx = newDeps.findIndex(d => d.name === data.dep.name);
          if (idx >= 0) newDeps[idx] = data.dep;
          else          newDeps.push(data.dep);
        } else {
          toast.error(`${file.name}: upload failed`);
        }
      }
      onDepsChanged(newDeps);
    } finally {
      setUploading([]);
    }
  }, [skillId, deps, onDepsChanged]);

  const removeDep = async (dep: DepFile) => {
    if (!skillId) return;
    setRemoving(r => [...r, dep.name]);
    try {
      await fetch(
        `${ENGINE_URL}/api/user-skills/${encodeURIComponent(skillId)}/deps/${encodeURIComponent(dep.name)}`,
        { method: 'DELETE' },
      );
      onDepsChanged(deps.filter(d => d.name !== dep.name));
    } catch {
      toast.error(`Failed to remove ${dep.name}`);
    } finally {
      setRemoving(r => r.filter(n => n !== dep.name));
    }
  };

  return (
    <div className="skill-field">
      <div className="flex items-center justify-between mb-1.5">
        <span className="skill-field-label flex items-center gap-1.5">
          <Package className="w-3 h-3 text-muted-foreground/40" />
          Dependencies
          {deps.length > 0 && (
            <span className="text-[9px] font-mono text-muted-foreground/40">({deps.length})</span>
          )}
        </span>
        <button
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1 text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 hover:text-phobos-green/70 transition-colors"
          title="Upload dependency file"
        >
          <Upload className="w-2.5 h-2.5" />
          Add file
        </button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          onChange={e => e.target.files && uploadFiles(e.target.files)}
        />
      </div>

      {/* Drop zone + file tree */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        }}
        className={`rounded-sm border transition-all ${
          dragging
            ? 'border-phobos-green/40 bg-phobos-green/5'
            : 'border-border/30 bg-black/30'
        }`}
      >
        {deps.length === 0 && uploading.length === 0 ? (
          <div
            className="px-3 py-3 text-center cursor-pointer"
            onClick={() => inputRef.current?.click()}
          >
            <p className="text-[9px] font-mono text-muted-foreground/30 leading-relaxed">
              Drop executables, data files, or any dependencies here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {deps.map(dep => (
              <div key={dep.name} className="flex items-center gap-2 px-2.5 py-1.5 group">
                <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/20 shrink-0" />
                <FileCode2 className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                <span className="flex-1 text-[10px] font-mono text-muted-foreground/70 truncate">{dep.name}</span>
                <span className="text-[9px] font-mono text-muted-foreground/30 shrink-0">{formatBytes(dep.size)}</span>
                {removing.includes(dep.name) ? (
                  <Loader2 className="w-3 h-3 text-muted-foreground/30 animate-spin shrink-0" />
                ) : (
                  <button
                    onClick={() => removeDep(dep)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-red-500/40 hover:text-red-500/70 transition-all"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            ))}
            {uploading.map(name => (
              <div key={name} className="flex items-center gap-2 px-2.5 py-1.5 opacity-50">
                <Loader2 className="w-2.5 h-2.5 text-phobos-green/40 animate-spin shrink-0" />
                <span className="text-[10px] font-mono text-muted-foreground/50 truncate">{name}</span>
                <span className="text-[9px] font-mono text-phobos-green/40 ml-auto shrink-0">uploading…</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface SkillConfigPanelProps {
  skill: UserSkillRecord;
  onChange: (skill: UserSkillRecord) => void;
  onSave: (skill: UserSkillRecord) => void;
  onDelete?: () => void;
}

export function SkillConfigPanel({ skill, onChange, onSave, onDelete }: SkillConfigPanelProps) {
  const [activeLogicTab, setActiveLogicTab] = useState<LogicTab>('skill_md');

  const update = (patch: Partial<UserSkillRecord>) => onChange({ ...skill, ...patch });

  const updateLogicFile = (key: LogicTab, value: string) => {
    if (key === 'skill_md')      update({ skill_md: value });
    else if (key === 'runner')   update({ runner: value });
    else                         update({ seren_context: value });
  };

  const getLogicFileValue = (key: LogicTab): string => {
    if (key === 'skill_md')    return skill.skill_md;
    if (key === 'runner')      return skill.runner;
    return skill.seren_context;
  };

  const toggleScope = (s: 'sayon' | 'seren') => {
    const cur = skill.scope;
    if (cur === 'both')  update({ scope: s });
    else if (cur === s)  update({ scope: s === 'sayon' ? 'seren' : 'sayon' });
    else                 update({ scope: 'both' });
  };

  const scopeActive = (s: 'sayon' | 'seren') =>
    skill.scope === s || skill.scope === 'both';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between bg-black/50 shrink-0">
        <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-muted-foreground/60">
          Skill Configuration
        </span>
        <div className="flex items-center gap-2">
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1.5 rounded hover:bg-destructive/20 text-destructive/50 hover:text-destructive transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => onSave(skill)}
            className="flex items-center gap-1.5 px-3 py-1 rounded border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 transition-all text-[10px] font-terminal uppercase tracking-wider"
          >
            <Save className="w-3 h-3" />
            Save
          </button>
        </div>
      </div>

      {/* Scrollable form */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">

        {/* Row: id + name */}
        <div className="grid grid-cols-2 gap-3">
          <label className="skill-field">
            <span className="skill-field-label">ID (slug)</span>
            <input
              type="text"
              value={skill.id}
              onChange={e => update({ id: e.target.value })}
              placeholder="my-typescript-style"
              className="skill-input"
            />
          </label>
          <label className="skill-field">
            <span className="skill-field-label">Name</span>
            <input
              type="text"
              value={skill.name}
              onChange={e => update({ name: e.target.value })}
              placeholder="Display name"
              className="skill-input"
            />
          </label>
        </div>

        {/* Row: version + scope */}
        <div className="grid grid-cols-2 gap-3">
          <label className="skill-field">
            <span className="skill-field-label">Version</span>
            <input
              type="text"
              value={skill.version}
              onChange={e => update({ version: e.target.value })}
              placeholder="0.1.0"
              className="skill-input"
            />
          </label>
          <div className="skill-field">
            <span className="skill-field-label">Scope</span>
            <div className="flex gap-2 mt-1">
              {(['sayon', 'seren'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => toggleScope(s)}
                  className={`px-3 py-1 rounded text-[10px] font-terminal uppercase tracking-wider border transition-all ${
                    scopeActive(s)
                      ? s === 'sayon'
                        ? 'border-sayon-tint/50 text-sayon-tint bg-sayon-tint/10'
                        : 'border-seren-tint/50 text-seren-tint bg-seren-tint/10'
                      : 'border-border text-muted-foreground/40 hover:border-border/80'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Description */}
        <label className="skill-field">
          <span className="skill-field-label">Description</span>
          <textarea
            value={skill.description}
            onChange={e => update({ description: e.target.value })}
            placeholder="What this skill does..."
            className="skill-input h-16 resize-none"
          />
        </label>

        {/* Trigger hints */}
        <label className="skill-field">
          <span className="skill-field-label">Trigger hints</span>
          <textarea
            value={skill.trigger}
            onChange={e => update({ trigger: e.target.value })}
            placeholder='format code, fix style, generate docs... (use "always" to fire on every task)'
            className="skill-input h-12 resize-none"
          />
        </label>

        {/* Enabled toggle */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer group">
            <button
              role="switch"
              aria-checked={skill.enabled}
              onClick={() => update({ enabled: !skill.enabled })}
              className={`relative w-8 h-4 rounded-full border transition-all ${
                skill.enabled
                  ? 'bg-phobos-green/20 border-phobos-green/40'
                  : 'bg-background border-border/40'
              }`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                  skill.enabled
                    ? 'left-4 bg-phobos-green/80'
                    : 'left-0.5 bg-muted-foreground/30'
                }`}
              />
            </button>
            <span className="text-[10px] font-terminal uppercase tracking-widest text-muted-foreground/50">
              {skill.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>

        {/* ── LOGIC FILES ─────────────────────────────────────────── */}
        <div className="skill-field">
          <span className="skill-field-label mb-1.5">Logic Files</span>
          <div className="flex gap-0 border-b border-border/50">
            {(Object.keys(LOGIC_TAB_LABELS) as LogicTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveLogicTab(tab)}
                className={`px-3 py-1.5 text-[10px] font-mono transition-colors border-b-2 -mb-px ${
                  activeLogicTab === tab
                    ? 'text-phobos-green border-phobos-green/50'
                    : 'text-muted-foreground/50 border-transparent hover:text-muted-foreground'
                }`}
              >
                {LOGIC_TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {/* Tab hint */}
          <p className="text-[9px] font-mono text-muted-foreground/30 pt-1 pb-0.5">
            {activeLogicTab === 'skill_md' && 'Primary context injected into both SAYON and SEREN when this skill activates. Markdown.'}
            {activeLogicTab === 'runner'   && 'Optional TypeScript entry point executed as a subprocess. Receives params on stdin, returns JSON on stdout.'}
            {activeLogicTab === 'seren_context' && 'Override or supplement the SKILL.md content for SEREN specifically. Leave empty to use SKILL.md for both.'}
          </p>

          <textarea
            key={activeLogicTab}
            value={getLogicFileValue(activeLogicTab)}
            onChange={e => updateLogicFile(activeLogicTab, e.target.value)}
            className="skill-input h-48 resize-none font-mono text-[11px] rounded-t-none border-t-0"
            spellCheck={false}
          />
        </div>

        {/* ── DEPENDENCIES ────────────────────────────────────────── */}
        <DepFileTree
          skillId={skill.id}
          deps={skill.deps}
          onDepsChanged={deps => update({ deps })}
        />

      </div>
    </div>
  );
}
