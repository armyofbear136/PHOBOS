import { useState, useEffect } from 'react';
import { X, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { computeNextRunTs } from './cronUtils';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export interface TaskFormData {
  name:                string;
  description:         string;
  cron_expression:     string;
  prompt:              string;
  enabled:             boolean;
  task_type:           'conversation' | 'background' | 'security' | 'ha';
  task_parameters:     string[] | null;
  pinned_sayon_model:  string | null;
  pinned_seren_model:  string | null;
  pinned_cartridge_id: string | null;
}

interface CartridgeOption {
  id:             string;
  name:           string;
  target_persona: string;
  category:       string;
}

interface GGUFModel {
  modelId: string;
  label:   string;
}

interface Props {
  initial?: Partial<TaskFormData>;
  onSave:  (data: TaskFormData) => void;
  onClose: () => void;
  saving:  boolean;
}

const PRESETS = [
  { label: 'Every hour',         cron: '0 * * * *'   },
  { label: 'Daily at 9 AM',      cron: '0 9 * * *'   },
  { label: 'Weekdays at 9 AM',   cron: '0 9 * * 1-5' },
  { label: 'Sundays at 8 PM',    cron: '0 20 * * 0'  },
  { label: 'Monthly on the 1st', cron: '0 9 1 * *'   },
  { label: 'Custom',             cron: ''             },
];

function nextRuns(expr: string): string[] {
  const results: string[] = [];
  let cursor = new Date();
  for (let i = 0; i < 3; i++) {
    const next = computeNextRunTs(expr, cursor);
    if (!next) break;
    results.push(next.toLocaleString());
    cursor = new Date(next.getTime() + 60_000);
  }
  return results;
}

const INPUT = 'w-full bg-transparent border border-border/50 rounded-sm px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-phobos-green/40 transition-colors';
const LABEL = 'block text-[10px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/60 mb-1';

export function TaskBuilderDialog({ initial, onSave, onClose, saving }: Props) {
  const [name,        setName]        = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [cron,        setCron]        = useState(initial?.cron_expression ?? '0 9 * * *');
  const [prompt,      setPrompt]      = useState(initial?.prompt ?? '');
  const [enabled,     setEnabled]     = useState(initial?.enabled ?? true);
  const [presetIdx,   setPresetIdx]   = useState<number>(() => {
    const idx = PRESETS.findIndex(p => p.cron === (initial?.cron_expression ?? '0 9 * * *'));
    return idx >= 0 ? idx : PRESETS.length - 1;
  });

  const [taskType,     setTaskType]     = useState<'conversation' | 'background' | 'security' | 'ha'>(initial?.task_type ?? 'conversation');
  const [haApprovals,  setHaApprovals]  = useState<string>(initial?.task_parameters?.join(', ') ?? '');

  const [overridesOpen,    setOverridesOpen]    = useState(
    !!(initial?.pinned_sayon_model || initial?.pinned_seren_model || initial?.pinned_cartridge_id)
  );
  const [pinnedSayon,      setPinnedSayon]      = useState(initial?.pinned_sayon_model  ?? '');
  const [pinnedSeren,      setPinnedSeren]      = useState(initial?.pinned_seren_model  ?? '');
  const [pinnedCartridge,  setPinnedCartridge]  = useState(initial?.pinned_cartridge_id ?? '');
  const [sayonCartridge,   setSayonCartridge]   = useState(initial?.pinned_cartridge_id ?? '');
  const [serenCartridge,   setSerenCartridge]   = useState(initial?.pinned_cartridge_id ?? '');
  const [cartridges,       setCartridges]       = useState<CartridgeOption[]>([]);
  const [cartridgesLoaded, setCartridgesLoaded] = useState(false);
  const [models,           setModels]           = useState<GGUFModel[]>([]);
  const [modelsLoaded,     setModelsLoaded]     = useState(false);

  useEffect(() => {
    if (!overridesOpen || cartridgesLoaded) return;
    fetch(`${ENGINE_URL}/api/cartridges`)
      .then(r => r.ok ? r.json() : [])
      .then((data: CartridgeOption[]) => {
        setCartridges(data.filter(c => c.category !== 'weclone'));
        setCartridgesLoaded(true);
      })
      .catch(() => setCartridgesLoaded(true));
    fetch(`${ENGINE_URL}/api/phobos/models`)
      .then(r => r.ok ? r.json() : { models: [] })
      .then((data: { models: GGUFModel[] }) => { setModels(Array.isArray(data.models) ? data.models : []); setModelsLoaded(true); })
      .catch(() => setModelsLoaded(true));
  }, [overridesOpen, cartridgesLoaded]);

  const previews  = nextRuns(cron);
  const cronValid = previews.length > 0;

  function selectPreset(idx: number) {
    setPresetIdx(idx);
    if (PRESETS[idx].cron) setCron(PRESETS[idx].cron);
  }

  function handleSave() {
    if (!name.trim() || !cron.trim() || !prompt.trim() || !cronValid) return;
    onSave({
      name:                name.trim(),
      description:         description.trim(),
      cron_expression:     cron.trim(),
      prompt:              prompt.trim(),
      enabled,
      task_type: taskType,
      task_parameters: taskType === 'ha'
        ? haApprovals.split(',').map(s => s.trim()).filter(Boolean)
        : null,
      pinned_sayon_model:  pinnedSayon  || null,
      pinned_seren_model:  pinnedSeren  || null,
      pinned_cartridge_id: sayonCartridge || serenCartridge || null,
    });
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[560px] max-w-[96vw] bg-card border border-border rounded-sm flex flex-col shadow-2xl max-h-[90vh]">

        {/* Header */}
        <div className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-phobos-green/50" />
            <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-phobos-green/70">
              {initial ? 'Edit Task' : 'New Scheduled Task'}
            </span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4 overflow-y-auto">

          {/* Name */}
          <div>
            <label className={LABEL}>Name *</label>
            <input className={INPUT} value={name} onChange={e => setName(e.target.value)}
              placeholder="Daily standup summary" />
          </div>

          {/* Description */}
          <div>
            <label className={LABEL}>Description</label>
            <input className={INPUT} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What this task does (optional)" />
          </div>

          {/* Schedule */}
          <div>
            <label className={LABEL}>Schedule *</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {PRESETS.map((p, i) => (
                <button key={i} onClick={() => selectPreset(i)}
                  className={`px-2 py-0.5 text-[9px] font-terminal uppercase tracking-widest rounded-sm border transition-colors ${
                    presetIdx === i
                      ? 'border-phobos-green/50 text-phobos-green/80 bg-phobos-green/5'
                      : 'border-border/40 text-muted-foreground/50 hover:text-muted-foreground/70 hover:border-border/60'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input className={`${INPUT} font-mono`} value={cron}
              onChange={e => { setCron(e.target.value); setPresetIdx(PRESETS.length - 1); }}
              placeholder="0 9 * * *" />
            {cron && (
              <div className="mt-1.5 space-y-0.5">
                {cronValid ? previews.map((ts, i) => (
                  <div key={i} className="text-[9px] text-phobos-green/50 font-mono">
                    {i === 0 ? '↳ next: ' : '        '}{ts}
                  </div>
                )) : (
                  <div className="text-[9px] text-destructive/70">Invalid cron expression</div>
                )}
              </div>
            )}
          </div>

          {/* Prompt */}
          <div>
            <label className={LABEL}>Prompt *</label>
            <textarea className={`${INPUT} resize-none`} rows={4} value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="The message to send to PHOBOS when this task fires..." />
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-2">
            <button onClick={() => setEnabled(v => !v)}
              className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? 'bg-phobos-green/60' : 'bg-border'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${enabled ? 'left-4' : 'left-0.5'}`} />
            </button>
            <span className="text-[10px] font-terminal text-muted-foreground/60">
              {enabled ? 'Enabled -- will fire on schedule' : 'Disabled'}
            </span>
          </div>

          {/* Task Type */}
          <div>
            <label className={LABEL}>Task Type</label>
            <div className="flex flex-wrap gap-1">
              {(['conversation', 'background', 'ha'] as const).map(t => (
                <button key={t} onClick={() => setTaskType(t)}
                  className={`px-2.5 py-0.5 text-[9px] font-terminal uppercase tracking-widest rounded-sm border transition-colors ${
                    taskType === t
                      ? 'border-phobos-green/50 text-phobos-green/80 bg-phobos-green/5'
                      : 'border-border/40 text-muted-foreground/50 hover:text-muted-foreground/70 hover:border-border/60'
                  }`}>{t}</button>
              ))}
            </div>
            <p className="text-[9px] font-mono text-muted-foreground/30 mt-1.5 leading-relaxed">
              {taskType === 'conversation' && 'Fires a prompt into the copilot panel. Requires the frontend to be open.'}
              {taskType === 'background' && 'Runs a headless background handler. Works while frontend is closed.'}
              {taskType === 'ha' && 'Home Assistant watch duty. Monitors home state and acts or alerts on conditions.'}
            </p>
          </div>

          {/* HA approval rules */}
          {taskType === 'ha' && (
            <div>
              <label className={LABEL}>Approval-Required Actions</label>
              <input
                className={`${INPUT} font-mono`}
                value={haApprovals}
                onChange={e => setHaApprovals(e.target.value)}
                placeholder="e.g. lock.lock, climate.*, all_writes"
              />
              <p className="text-[9px] font-mono text-muted-foreground/30 mt-1 leading-relaxed">
                Comma-separated HA service patterns that require user confirmation before execution.
                Use <span className="text-muted-foreground/50">domain.*</span> to require approval for all actions in a domain,
                or <span className="text-muted-foreground/50">all_writes</span> to gate every service call.
                Leave blank to allow all actions to fire automatically.
              </p>
            </div>
          )}

          {/* Model Overrides */}
          <div className="border border-border/30 rounded-sm overflow-hidden">
            <button
              onClick={() => setOverridesOpen(v => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
            >
              {overridesOpen
                ? <ChevronDown  className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />}
              <span className="text-[10px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/50">
                Model Overrides
              </span>
              {(pinnedSayon || pinnedSeren || pinnedCartridge) && (
                <span className="ml-auto text-[9px] font-mono text-phobos-green/50">active</span>
              )}
            </button>

            {overridesOpen && (
              <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t border-border/20 bg-black/20">
                <p className="text-[9px] font-mono text-muted-foreground/35 leading-relaxed mt-1">
                  Override the active model for this task only. Leave blank to use whatever is currently loaded.
                  Pin a vision-capable model here if this task analyzes camera images.
                </p>

                {/* SAYON model + cartridge */}
                <div className="border border-border/20 rounded-sm p-2.5 space-y-2">
                  <span className="text-[10px] font-terminal uppercase tracking-widest text-sayon/60">SAYON</span>
                  <div>
                    <label className={LABEL}>Model</label>
                    <select
                      value={pinnedSayon}
                      onChange={e => setPinnedSayon(e.target.value)}
                      className={`${INPUT} cursor-pointer font-mono`}
                    >
                      <option value="">Use active model</option>
                      {models.map(m => (
                        <option key={m.modelId} value={m.modelId}>{m.label}</option>
                      ))}
                    </select>
                    {!modelsLoaded && <span className="text-[9px] font-mono text-muted-foreground/30 mt-1 block">Loading models...</span>}
                  </div>
                  <div>
                    <label className={LABEL}>Cartridge</label>
                    <select
                      value={sayonCartridge}
                      onChange={e => setSayonCartridge(e.target.value)}
                      className={`${INPUT} cursor-pointer`}
                    >
                      <option value="">None</option>
                      {cartridges.filter(c => c.target_persona === 'sayon' || c.target_persona === 'both').map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* SEREN model + cartridge */}
                <div className="border border-border/20 rounded-sm p-2.5 space-y-2">
                  <span className="text-[10px] font-terminal uppercase tracking-widest text-seren/60">SEREN</span>
                  <div>
                    <label className={LABEL}>Model</label>
                    <select
                      value={pinnedSeren}
                      onChange={e => setPinnedSeren(e.target.value)}
                      className={`${INPUT} cursor-pointer font-mono`}
                    >
                      <option value="">Use active model</option>
                      {models.map(m => (
                        <option key={m.modelId} value={m.modelId}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={LABEL}>Cartridge</label>
                    <select
                      value={serenCartridge}
                      onChange={e => setSerenCartridge(e.target.value)}
                      className={`${INPUT} cursor-pointer`}
                    >
                      <option value="">None</option>
                      {cartridges.filter(c => c.target_persona === 'seren' || c.target_persona === 'both').map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {!cartridgesLoaded && <span className="text-[9px] font-mono text-muted-foreground/30 mt-1 block">Loading...</span>}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/50 bg-black/30 shrink-0">
          <button onClick={onClose}
            className="px-3 py-1 text-[10px] font-terminal uppercase tracking-widest border border-border/40 text-muted-foreground/60 hover:text-muted-foreground rounded-sm transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !name.trim() || !cron.trim() || !prompt.trim() || !cronValid}
            className="px-4 py-1 text-[10px] font-terminal uppercase tracking-widest border border-phobos-green/40 text-phobos-green/80 hover:bg-phobos-green/5 disabled:opacity-40 disabled:cursor-not-allowed rounded-sm transition-colors">
            {saving ? 'Saving...' : 'Save Task'}
          </button>
        </div>

      </div>
    </div>
  );
}