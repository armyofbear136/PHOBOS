import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Loader2, Upload, Plus, Pencil, Puzzle,
  AlertTriangle, Check, KeyRound, ShieldCheck, Lock,
  Zap, ChevronRight, CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  type PluginRecord,
  type PluginKind,
  type PluginCategory,
  type PluginBaseModel,
  CATEGORY_LABELS,
  BASE_MODEL_LABELS,
} from './PluginTypes';
import { TrainingPanel } from './TrainingPanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface PluginsMenuProps { onClose: () => void; }

// ── Badges ────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<PluginCategory, string> = {
  style:   'text-blue-400 border-blue-400/30 bg-blue-400/5',
  subject: 'text-purple-400 border-purple-400/30 bg-purple-400/5',
  lighting:'text-amber-400 border-amber-400/30 bg-amber-400/5',
  texture: 'text-orange-400 border-orange-400/30 bg-orange-400/5',
  concept: 'text-teal-400 border-teal-400/30 bg-teal-400/5',
  generic: 'text-muted-foreground border-border bg-transparent',
};

function CategoryBadge({ category }: { category: PluginCategory }) {
  return (
    <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-sm border ${CATEGORY_COLORS[category]}`}>
      {CATEGORY_LABELS[category]}
    </span>
  );
}

function BaseModelBadge({ model }: { model: PluginBaseModel }) {
  return (
    <span className="text-[8px] font-mono text-phobos-green/50 border border-phobos-green/20 px-1.5 py-0.5 rounded-sm bg-phobos-green/5">
      {BASE_MODEL_LABELS[model]}
    </span>
  );
}

// ── Auth gate ─────────────────────────────────────────────────────────────────
// Shown when the Edit button is clicked on a plugin that hasn't been
// license-unlocked silently. User enters their password (or, if no license
// matched, that's the only option).

interface AuthGateProps {
  plugin:       PluginRecord;
  licenseAvail: boolean;   // true when local license exists (from /license-unlocked check)
  onAuth:       (credential: { password: string } | { useLicense: true }) => Promise<boolean>;
  onCancel:     () => void;
}

function AuthGate({ plugin, licenseAvail, onAuth, onCancel }: AuthGateProps) {
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);

  const submit = async (credential: { password: string } | { useLicense: true }) => {
    setBusy(true);
    setError('');
    const ok = await onAuth(credential);
    if (!ok) {
      setError('credential' in credential
        ? 'Incorrect password'
        : 'License does not match this plugin');
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-8">
      <Lock className="w-6 h-6 text-muted-foreground/30" />
      <div className="text-center">
        <p className="text-xs font-terminal text-foreground/60 mb-0.5">{plugin.name}</p>
        <p className="text-[10px] font-mono text-muted-foreground/40">Enter your plugin password to edit</p>
      </div>

      <div className="w-full max-w-[260px] space-y-2">
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && password && submit({ password })}
          placeholder="Plugin password"
          autoFocus
          className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-3 py-2 text-foreground/80 focus:outline-none focus:border-phobos-green/40 placeholder:text-muted-foreground/30"
        />
        {error && (
          <p className="text-[10px] font-mono text-red-400/70">{error}</p>
        )}
        <button
          disabled={busy || !password}
          onClick={() => submit({ password })}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[9px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
          Unlock with Password
        </button>

        {/* License unlock option — shown only when a local license exists
            and the plugin has has_license_unlock. Already tried silently;
            this is the manual fallback if silent check failed for any reason. */}
        {licenseAvail && plugin.has_license_unlock && (
          <button
            disabled={busy}
            onClick={() => submit({ useLicense: true })}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[9px] font-terminal uppercase tracking-widest text-blue-400/70 border border-blue-400/20 rounded-sm hover:border-blue-400/40 transition-all disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
            Unlock with License
          </button>
        )}
      </div>

      <button
        onClick={onCancel}
        className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ── Plugin list card ──────────────────────────────────────────────────────────

function PluginCard({ plugin, selected, onSelect }: {
  plugin: PluginRecord; selected: boolean; onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 rounded-sm border transition-all hover:border-phobos-green/30 ${
        selected
          ? 'border-phobos-green/40 bg-phobos-green/5 shadow-[0_0_8px_hsl(120_100%_50%/0.06)]'
          : 'border-border/40 bg-background hover:bg-phobos-green/[0.02]'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-[11px] font-terminal text-foreground/90 leading-tight">{plugin.name}</span>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {plugin.has_license_unlock && (
            <span title="License unlock enabled">
              <ShieldCheck className="w-2.5 h-2.5 text-blue-400/50" />
            </span>
          )}
          {plugin.kind === 'raw_lora' && (
            <span title="Raw LoRA — unverified compatibility">
              <AlertTriangle className="w-2.5 h-2.5 text-amber-400/60" />
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <CategoryBadge category={plugin.category} />
        <BaseModelBadge model={plugin.base_model} />
      </div>
      <div className="mt-1.5 text-[9px] font-mono text-muted-foreground/50 truncate">{plugin.author}</div>
    </button>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

type PanelMode = 'view' | 'auth' | 'edit' | 'create';

interface EditDraft {
  name:              string;
  description:       string;
  tags:              string;
  recommendedWeight: number;
}

// Credential held in session memory — cleared on tab close / panel close
let _sessionCredential: ({ password: string } | { useLicense: true }) | null = null;

function DetailPanel({
  plugin,
  mode,
  onRequestEdit,
  onEditUnlocked,
  onSaveDraft,
  onCancelEdit,
  onDelete,
  licenseAvail,
}: {
  plugin:         PluginRecord | null;
  mode:           PanelMode;
  onRequestEdit:  () => void;
  onEditUnlocked: (credential: { password: string } | { useLicense: true }) => void;
  onSaveDraft:    (draft: EditDraft, credential: { password: string } | { useLicense: true }) => Promise<void>;
  onCancelEdit:   () => void;
  onDelete:       () => void;
  licenseAvail:   boolean;
}) {
  const [draft,  setDraft]  = useState<EditDraft>({ name: '', description: '', tags: '', recommendedWeight: 0.8 });
  const [saving, setSaving] = useState(false);
  const [addingLicense, setAddingLicense] = useState(false);

  useEffect(() => {
    if (plugin && (mode === 'view' || mode === 'auth')) {
      setDraft({
        name:              plugin.name,
        description:       plugin.description,
        tags:              plugin.tags.join(', '),
        recommendedWeight: plugin.recommended_weight,
      });
    }
  }, [plugin, mode]);

  if (!plugin) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Puzzle className="w-8 h-8 text-muted-foreground/10 mx-auto mb-3" />
          <p className="text-xs font-mono text-muted-foreground/30">Select a plugin or drop files to install</p>
        </div>
      </div>
    );
  }

  if (mode === 'auth') {
    return (
      <AuthGate
        plugin={plugin}
        licenseAvail={licenseAvail}
        onAuth={async (credential) => {
          const res = await fetch(`${ENGINE_URL}/api/phobos/plugins/${encodeURIComponent(plugin.id)}/check-auth`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(credential),
          });
          if (res.ok) {
            _sessionCredential = credential;
            onEditUnlocked(credential);
            return true;
          }
          return false;
        }}
        onCancel={onCancelEdit}
      />
    );
  }

  const isEditing = mode === 'edit';

  const handleAddLicense = async () => {
    if (!_sessionCredential) return;
    setAddingLicense(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/plugins/${encodeURIComponent(plugin.id)}/add-license`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(_sessionCredential),
      });
      if (res.ok) toast.success('License unlock added');
      else toast.error((await res.json() as { error: string }).error);
    } catch {
      toast.error('Failed to add license unlock');
    } finally {
      setAddingLicense(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-terminal text-foreground/80">{plugin.name}</span>
          {plugin.kind === 'raw_lora' && (
            <span className="text-[8px] font-terminal text-amber-400/70 border border-amber-400/20 px-1.5 py-0.5 rounded-sm">
              Raw LoRA
            </span>
          )}
          {plugin.is_local_author && (
            <span className="text-[8px] font-terminal text-phobos-green/60 border border-phobos-green/20 px-1.5 py-0.5 rounded-sm">
              YOUR PLUGIN
            </span>
          )}
          {plugin.has_license_unlock && (
            <span className="flex items-center gap-1 text-[8px] font-terminal text-blue-400/60 border border-blue-400/20 px-1.5 py-0.5 rounded-sm">
              <ShieldCheck className="w-2 h-2" /> LICENSE KEY
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {plugin.is_local_author && !isEditing && (
            <button
              onClick={onRequestEdit}
              className="flex items-center gap-1 px-2 py-1 text-[9px] font-terminal uppercase tracking-widest text-muted-foreground hover:text-foreground border border-border/40 rounded-sm hover:border-border/60 transition-all"
            >
              <Pencil className="w-2.5 h-2.5" /> Edit
            </button>
          )}
          {isEditing && (
            <button
              onClick={onCancelEdit}
              className="px-2 py-1 text-[9px] font-terminal uppercase tracking-widest text-muted-foreground border border-border/40 rounded-sm hover:border-border/60 transition-all"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">

        <div>
          <label className="block text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 mb-1">Description</label>
          {isEditing ? (
            <textarea
              value={draft.description}
              onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
              rows={3}
              className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-2 py-1.5 text-foreground/80 focus:outline-none focus:border-phobos-green/40 resize-none"
            />
          ) : (
            <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">{plugin.description || '—'}</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <MetaField label="Author"     value={plugin.author} />
          <MetaField label="Version"    value={plugin.version} />
          <MetaField label="Base Model" value={BASE_MODEL_LABELS[plugin.base_model]} />
          <MetaField label="Category"   value={CATEGORY_LABELS[plugin.category]} />
          {plugin.rank             !== null && <MetaField label="Rank"            value={String(plugin.rank)} />}
          {plugin.training_images  !== null && <MetaField label="Training Images" value={String(plugin.training_images)} />}
          {plugin.training_steps   !== null && <MetaField label="Training Steps"  value={String(plugin.training_steps)} />}
        </div>

        {plugin.trigger_words.length > 0 && (
          <div>
            <label className="block text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 mb-1">Trigger Words</label>
            <div className="flex flex-wrap gap-1">
              {plugin.trigger_words.map(tw => (
                <span key={tw} className="text-[9px] font-mono text-phobos-green/70 bg-phobos-green/5 border border-phobos-green/20 px-1.5 py-0.5 rounded-sm">{tw}</span>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 mb-1">Recommended Weight</label>
          {isEditing ? (
            <input type="number" min={plugin.weight_min} max={plugin.weight_max} step={0.05}
              value={draft.recommendedWeight}
              onChange={e => setDraft(d => ({ ...d, recommendedWeight: Number(e.target.value) }))}
              className="w-24 text-[11px] font-mono bg-background border border-border/50 rounded-sm px-2 py-1 text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            />
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 max-w-[160px] h-1.5 bg-border/30 rounded-full overflow-hidden">
                <div className="h-full bg-phobos-green/60 rounded-full"
                  style={{ width: `${(plugin.recommended_weight / plugin.weight_max) * 100}%` }} />
              </div>
              <span className="text-[11px] font-mono text-muted-foreground/60">
                {plugin.recommended_weight.toFixed(2)} ({plugin.weight_min}–{plugin.weight_max})
              </span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 mb-1">Tags</label>
          {isEditing ? (
            <input type="text" value={draft.tags} placeholder="painterly, oil, portrait..."
              onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
              className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-2 py-1.5 text-foreground/80 focus:outline-none focus:border-phobos-green/40"
            />
          ) : (
            <div className="flex flex-wrap gap-1">
              {plugin.tags.length > 0
                ? plugin.tags.map(t => (
                    <span key={t} className="text-[9px] font-mono text-muted-foreground/50 border border-border/30 px-1.5 py-0.5 rounded-sm">{t}</span>
                  ))
                : <span className="text-[10px] font-mono text-muted-foreground/30">none</span>
              }
            </div>
          )}
        </div>

        {/* Add license unlock — shown in edit mode when not already set */}
        {isEditing && !plugin.has_license_unlock && (
          <div className="px-3 py-2.5 bg-blue-400/[0.03] border border-blue-400/15 rounded-sm flex items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-400/50 shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
                Add your license as a second unlock key. Anyone with your license can edit this plugin without the password.
              </p>
            </div>
            <button
              disabled={addingLicense}
              onClick={handleAddLicense}
              className="shrink-0 flex items-center gap-1 px-2 py-1 text-[9px] font-terminal uppercase tracking-widest text-blue-400/60 border border-blue-400/20 rounded-sm hover:border-blue-400/40 transition-all disabled:opacity-40"
            >
              {addingLicense ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Plus className="w-2.5 h-2.5" />}
              Add
            </button>
          </div>
        )}

        {plugin.kind === 'raw_lora' && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-400/5 border border-amber-400/20 rounded-sm">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70 shrink-0 mt-0.5" />
            <p className="text-[10px] font-mono text-amber-400/70 leading-relaxed">
              Raw LoRA — compatibility unverified. Works with any image model but may produce unexpected results. No trigger words required.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border/50 flex items-center justify-between shrink-0">
        <button
          onClick={onDelete}
          className="text-[9px] font-terminal uppercase tracking-widest text-red-500/50 hover:text-red-500/80 transition-colors"
        >
          Remove Plugin
        </button>
        {isEditing && _sessionCredential && (
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try { await onSaveDraft(draft, _sessionCredential!); }
              finally { setSaving(false); }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/50 transition-all disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5" />}
            Save Changes
          </button>
        )}
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 mb-0.5">{label}</div>
      <div className="text-[11px] font-mono text-muted-foreground/70">{value}</div>
    </div>
  );
}

// ── Create panel ──────────────────────────────────────────────────────────────

const VALID_BASE_MODELS: PluginBaseModel[] = ['flux-dev', 'flux-schnell', 'flux2-klein', 'sdxl', 'chroma'];
const VALID_CATEGORIES:  PluginCategory[]  = ['style', 'subject', 'lighting', 'texture', 'concept'];

interface CreateDraft {
  name:              string;
  description:       string;
  tags:              string;
  baseModel:         PluginBaseModel;
  category:          PluginCategory;
  triggerWord:       string;
  rank:              number;
  recommendedWeight: number;
  password:          string;
  confirmPassword:   string;
  addLicense:        boolean;
  licenseAvail:      boolean;
  stagedCount:       number;
  sessionId:         string;
}

// ── Image count tier helper ───────────────────────────────────────────────────

function imageCountTier(count: number): {
  color: string; dotColor: string; label: string; sublabel: string;
} {
  if (count === 0)        return { color: 'text-muted-foreground/40', dotColor: 'bg-muted-foreground/20', label: 'No images yet', sublabel: 'Drop in your artwork to get started' };
  if (count < 15)        return { color: 'text-red-400',             dotColor: 'bg-red-400',             label: `${count} images`,  sublabel: 'Need at least 15 to train — add more' };
  if (count < 75)        return { color: 'text-red-400/80',          dotColor: 'bg-red-400/80',          label: `${count} images`,  sublabel: 'More images = better results. Aim for 100+' };
  if (count < 100)       return { color: 'text-phobos-amber',        dotColor: 'bg-phobos-amber',        label: `${count} images`,  sublabel: 'Getting there — 100 is the sweet spot' };
  if (count < 136)       return { color: 'text-phobos-green',        dotColor: 'bg-phobos-green',        label: `${count} images`,  sublabel: 'Great set — ready to train a high-quality plugin' };
  return                        { color: 'text-blue-400',            dotColor: 'bg-blue-400',            label: `${count} images`,  sublabel: 'Going the extra mile — this will be exceptional' };
}

// ── VRAM check result ─────────────────────────────────────────────────────────

interface VramCheckResult {
  ok:         boolean;
  requiredGb: number;
  freeGb:     number;
  totalGb:    number;
  vendor:     string;
  device:     string;
  message:    string;
}

// ── Create Wizard ─────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

function CreateWizard({ onCancel, licenseAvail, onTrainingStarted }: {
  onCancel:          () => void;
  licenseAvail:      boolean;
  onTrainingStarted: (sessionId: string) => void;
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<CreateDraft>({
    name: '', description: '', tags: '',
    baseModel: 'flux-dev', category: 'style',
    triggerWord: '', rank: 16, recommendedWeight: 0.75,
    password: '', confirmPassword: '',
    addLicense: licenseAvail,
    licenseAvail,
    stagedCount: 0,
    sessionId:   `session_${Date.now()}`,
  });
  const [errors,    setErrors]    = useState<Partial<Record<keyof CreateDraft, string>>>({});
  const [vram,      setVram]      = useState<VramCheckResult | null>(null);
  const [vramBusy,  setVramBusy]  = useState(false);
  const [starting,  setStarting]  = useState(false);

  // ── VRAM check runs when user reaches step 3 ──────────────────────────────
  useEffect(() => {
    if (step !== 3) return;
    setVramBusy(true);
    setVram(null);
    fetch(`${ENGINE_URL}/api/phobos/training/vram-check?baseModel=${encodeURIComponent(draft.baseModel)}&rank=${draft.rank}`)
      .then(r => r.json())
      .then((d: VramCheckResult) => setVram(d))
      .catch(() => setVram({ ok: false, requiredGb: 0, freeGb: 0, totalGb: 0, vendor: '', device: '', message: 'Could not connect to PHOBOS to check available memory.' }))
      .finally(() => setVramBusy(false));
  }, [step, draft.baseModel, draft.rank]);

  const validateStep1 = () => draft.stagedCount >= 15;

  const validateStep2 = (): boolean => {
    const e: Partial<Record<keyof CreateDraft, string>> = {};
    if (!draft.name.trim())      e.name        = 'Give your plugin a name';
    if (!draft.triggerWord.trim()) e.triggerWord = 'A trigger word is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const validateStep3 = (): boolean => {
    const e: Partial<Record<keyof CreateDraft, string>> = {};
    if (draft.password.length < 4)               e.password        = 'Password must be at least 4 characters';
    if (draft.password !== draft.confirmPassword) e.confirmPassword = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleNext = () => {
    if (step === 1 && validateStep1()) { setErrors({}); setStep(2); }
    if (step === 2 && validateStep2()) setStep(3);
  };

  const handleStart = async () => {
    if (!validateStep3()) return;
    setStarting(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/training/sessions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:              draft.name.trim(),
          description:       draft.description.trim(),
          baseModel:         draft.baseModel,
          category:          draft.category,
          triggerWord:       draft.triggerWord.trim(),
          tags:              draft.tags.split(',').map((t: string) => t.trim()).filter(Boolean),
          rank:              draft.rank,
          recommendedWeight: draft.recommendedWeight,
          password:          draft.password,
          addLicense:        draft.addLicense,
          steps:             1000,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        toast.error(err.error);
        return;
      }
      const session = await res.json() as { session_id: string };
      onTrainingStarted(session.session_id);
    } catch {
      toast.error('Failed to start training — is PHOBOS running?');
    } finally {
      setStarting(false);
    }
  };

  const tier = imageCountTier(draft.stagedCount);

  // ── Step labels ────────────────────────────────────────────────────────────
  const STEPS: { n: WizardStep; label: string }[] = [
    { n: 1, label: 'Your Artwork' },
    { n: 2, label: 'Plugin Details' },
    { n: 3, label: 'Protect & Launch' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="px-6 py-4 border-b border-border/50 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          {STEPS.map(({ n, label }) => (
            <button
              key={n}
              onClick={() => { if (n < step) setStep(n); }}
              className={`flex items-center gap-2 transition-colors ${n === step ? 'cursor-default' : n < step ? 'cursor-pointer hover:opacity-80' : 'cursor-default opacity-30'}`}
            >
              <span className={`w-5 h-5 rounded-full text-[9px] font-terminal flex items-center justify-center border transition-colors ${
                n === step   ? 'bg-phobos-green/20 border-phobos-green/60 text-phobos-green' :
                n < step     ? 'bg-phobos-green/10 border-phobos-green/30 text-phobos-green/60' :
                               'border-border/40 text-muted-foreground/30'
              }`}>{n < step ? '✓' : n}</span>
              <span className={`text-[10px] font-terminal uppercase tracking-widest ${n === step ? 'text-foreground/80' : 'text-muted-foreground/40'}`}>{label}</span>
            </button>
          ))}
        </div>
        <button onClick={onCancel} className="p-1 hover:bg-accent rounded transition-colors">
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Step 1 — Your Artwork */}
      {step === 1 && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-12 py-8">

            <div className="text-center space-y-2 max-w-[520px]">
              <h2 className="text-xl font-terminal text-foreground/90">Drop in your artwork</h2>
              <p className="text-sm font-mono text-muted-foreground/50 leading-relaxed">
                These are the images PHOBOS will learn from. The more variety and quality you provide, the better your plugin will capture your style. Aim for <span className="text-phobos-green/70">100 images</span> for best results.
              </p>
            </div>

            {/* Large drop zone */}
            <TrainingDropZone
              stagedCount={draft.stagedCount}
              sessionId={draft.sessionId}
              onStaged={count => setDraft(d => ({ ...d, stagedCount: count }))}
              large
            />

            {/* Count indicator */}
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${tier.dotColor} transition-colors`} />
              <div>
                <span className={`text-sm font-terminal ${tier.color} transition-colors`}>{tier.label}</span>
                <span className="text-[11px] font-mono text-muted-foreground/40 ml-3">{tier.sublabel}</span>
              </div>
            </div>

            {/* Visual quality bar */}
            <div className="w-full max-w-[480px] space-y-1.5">
              <div className="flex justify-between text-[8px] font-mono text-muted-foreground/30">
                <span>15 min</span><span>75</span><span>100 ideal</span><span>136+</span>
              </div>
              <div className="h-1.5 w-full bg-border/20 rounded-full overflow-hidden">
                {/* Track: red at 15, amber at 75, green at 100, blue at 136 */}
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    draft.stagedCount >= 136 ? 'bg-blue-400' :
                    draft.stagedCount >= 100 ? 'bg-phobos-green' :
                    draft.stagedCount >= 75  ? 'bg-phobos-amber' :
                    draft.stagedCount >= 15  ? 'bg-red-400/80' :
                                              'bg-red-400/40'
                  }`}
                  style={{ width: `${Math.min(100, (draft.stagedCount / 136) * 100)}%` }}
                />
              </div>
            </div>

            {draft.stagedCount < 15 && draft.stagedCount > 0 && (
              <p className="text-[11px] font-mono text-red-400/70 text-center max-w-[380px] leading-relaxed">
                You need at least 15 images to start training. Add more for significantly better quality — the difference between 15 and 100 images is enormous.
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-border/30 flex items-center justify-between shrink-0">
            <button onClick={onCancel} className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors">
              Cancel
            </button>
            <button
              disabled={draft.stagedCount < 15}
              onClick={handleNext}
              className="flex items-center gap-1.5 px-5 py-2 text-[10px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_16px_hsl(120_100%_50%/0.1)] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next — Plugin Details <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — Plugin Details */}
      {step === 2 && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto scrollbar-thin px-10 py-8 space-y-6">

            <div className="space-y-1">
              <h2 className="text-lg font-terminal text-foreground/90">Describe your plugin</h2>
              <p className="text-[11px] font-mono text-muted-foreground/40 leading-relaxed">
                This is what people will see when they find your plugin on Auvera. Be clear and specific.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <Field label="Plugin Name" error={errors.name}>
                  <Input value={draft.name} onChange={v => setDraft(d => ({ ...d, name: v }))} placeholder="My Brushwork Style" />
                </Field>

                <Field
                  label="Trigger Word"
                  error={errors.triggerWord}
                  hint="This word activates your style in prompts — e.g. 'in MyArtStyle style'"
                >
                  <Input value={draft.triggerWord} onChange={v => setDraft(d => ({ ...d, triggerWord: v }))} placeholder="MyArtStyle" />
                </Field>

                <Field label="Description" hint="What makes your style unique? What subjects or moods does it suit?">
                  <textarea
                    value={draft.description}
                    onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                    placeholder="Painterly oil-textured style with warm midtones, expressive brushwork, and a sense of light coming from the upper left..."
                    rows={4}
                    className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-3 py-2 text-foreground/80 focus:outline-none focus:border-phobos-green/40 resize-none placeholder:text-muted-foreground/25 leading-relaxed"
                  />
                </Field>
              </div>

              <div className="space-y-4">
                <Field
                  label="Base Model"
                  hint="What image model were your training images made with, or best suit?"
                >
                  <Select value={draft.baseModel} onChange={v => setDraft(d => ({ ...d, baseModel: v as PluginBaseModel }))}>
                    {VALID_BASE_MODELS.map(m => <option key={m} value={m} className="bg-black">{BASE_MODEL_LABELS[m]}</option>)}
                  </Select>
                </Field>

                <Field
                  label="Category"
                  hint="The primary thing your plugin changes — helps crafters find the right plugin"
                >
                  <Select value={draft.category} onChange={v => setDraft(d => ({ ...d, category: v as PluginCategory }))}>
                    {VALID_CATEGORIES.map(c => (
                      <option key={c} value={c} className="bg-black">
                        {CATEGORY_LABELS[c]} — {CATEGORY_HINTS[c]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Tags (comma-separated)" hint="Help people find your plugin — style keywords, medium, mood">
                  <Input value={draft.tags} onChange={v => setDraft(d => ({ ...d, tags: v }))} placeholder="painterly, oil, warm, portrait, moody" />
                </Field>

                <Field label="Recommended Weight" hint="How strongly to apply the style (0.1 = subtle, 1.0 = full). 0.75 is a good default.">
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={0.1} max={1.0} step={0.05}
                      value={draft.recommendedWeight}
                      onChange={e => setDraft(d => ({ ...d, recommendedWeight: Number(e.target.value) }))}
                      className="flex-1 accent-phobos-green"
                    />
                    <span className="text-[12px] font-mono text-foreground/70 w-8 text-right">{draft.recommendedWeight.toFixed(2)}</span>
                  </div>
                </Field>
              </div>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-border/30 flex items-center justify-between shrink-0">
            <button onClick={() => setStep(1)} className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors flex items-center gap-1">
              ← Back
            </button>
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-5 py-2 text-[10px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_16px_hsl(120_100%_50%/0.1)] transition-all"
            >
              Next — Protect & Launch <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Protect & Launch */}
      {step === 3 && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto scrollbar-thin px-10 py-8">
            <div className="max-w-[720px] mx-auto space-y-7">

              <div className="space-y-1">
                <h2 className="text-lg font-terminal text-foreground/90">Protect your plugin</h2>
                <p className="text-[11px] font-mono text-muted-foreground/40 leading-relaxed">
                  Set a password to protect your plugin from unauthorized edits. Only you will be able to change its metadata or delete it from the library.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-5">
                <Field label="Password" error={errors.password}>
                  <input type="password" value={draft.password}
                    onChange={e => setDraft(d => ({ ...d, password: e.target.value }))}
                    placeholder="Set a password"
                    className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-3 py-2 text-foreground/80 focus:outline-none focus:border-phobos-green/40 placeholder:text-muted-foreground/25"
                  />
                </Field>
                <Field label="Confirm Password" error={errors.confirmPassword}>
                  <input type="password" value={draft.confirmPassword}
                    onChange={e => setDraft(d => ({ ...d, confirmPassword: e.target.value }))}
                    placeholder="Confirm password"
                    className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-3 py-2 text-foreground/80 focus:outline-none focus:border-phobos-green/40 placeholder:text-muted-foreground/25"
                  />
                </Field>
              </div>

              {licenseAvail && (
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input type="checkbox" checked={draft.addLicense}
                    onChange={e => setDraft(d => ({ ...d, addLicense: e.target.checked }))}
                    className="accent-blue-400 w-4 h-4"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground/70 group-hover:text-muted-foreground/90 transition-colors">
                      <ShieldCheck className="w-3.5 h-3.5 text-blue-400/60" />
                      Also unlock with my Auvera license key <span className="text-muted-foreground/30">(recommended)</span>
                    </div>
                    <p className="text-[10px] font-mono text-muted-foreground/30 mt-0.5">Lets you unlock this plugin on any machine where your license is active — no need to remember the password.</p>
                  </div>
                </label>
              )}

              {/* Advanced settings — collapsible */}
              <details className="group">
                <summary className="cursor-pointer text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors select-none list-none flex items-center gap-1.5">
                  <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                  Advanced Training Settings
                </summary>
                <div className="mt-4 grid grid-cols-2 gap-5 pl-4 border-l border-border/20">
                  <Field label="LoRA Rank" hint="Higher rank = more detail captured, more VRAM needed. 16 is ideal for most styles.">
                    <Select value={String(draft.rank)} onChange={v => setDraft(d => ({ ...d, rank: Number(v) }))}>
                      {[4, 8, 16, 32, 64].map(r => (
                        <option key={r} value={r} className="bg-black">
                          Rank {r}{r === 16 ? ' ★ recommended' : r < 16 ? ' · lighter, less detail' : ' · heavier, more detail'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </details>

              {/* VRAM check */}
              <div className={`flex items-start gap-3 p-4 rounded-sm border transition-colors ${
                vramBusy          ? 'border-border/30 bg-black/20' :
                vram?.ok          ? 'border-phobos-green/30 bg-phobos-green/5' :
                vram              ? 'border-red-400/30 bg-red-400/5' :
                                    'border-border/20 bg-black/10'
              }`}>
                {vramBusy ? (
                  <Loader2 className="w-4 h-4 text-muted-foreground/40 animate-spin shrink-0 mt-0.5" />
                ) : vram?.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-phobos-green/60 shrink-0 mt-0.5" />
                ) : vram ? (
                  <AlertTriangle className="w-4 h-4 text-red-400/60 shrink-0 mt-0.5" />
                ) : (
                  <Loader2 className="w-4 h-4 text-muted-foreground/20 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="text-[11px] font-mono text-foreground/70">
                    {vramBusy ? 'Checking available GPU memory…' : vram?.message ?? 'Checking system…'}
                  </p>
                  {vram && !vram.ok && (
                    <p className="text-[10px] font-mono text-muted-foreground/40 mt-1">
                      Try closing other applications, stopping the PHOBOS LLM servers, or using a lower LoRA rank.
                    </p>
                  )}
                </div>
              </div>

            </div>
          </div>

          <div className="px-6 py-4 border-t border-border/30 flex items-center justify-between shrink-0">
            <button onClick={() => setStep(2)} className="text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors flex items-center gap-1">
              ← Back
            </button>
            <button
              disabled={starting || vramBusy || (vram !== null && !vram.ok)}
              onClick={handleStart}
              className="flex items-center gap-2 px-6 py-2.5 text-[10px] font-terminal uppercase tracking-widest text-phobos-green border border-phobos-green/30 rounded-sm hover:border-phobos-green/60 hover:shadow-[0_0_20px_hsl(120_100%_50%/0.15)] transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {starting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting…</> : <><Zap className="w-3.5 h-3.5" /> Start Training</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Category hints shown inline in the step-2 dropdown
const CATEGORY_HINTS: Record<PluginCategory, string> = {
  style:   'overall visual style & medium',
  subject: 'specific characters or objects',
  lighting:'mood, atmosphere, light quality',
  texture: 'surface detail & material feel',
  concept: 'abstract ideas & themes',
  generic: 'general purpose',
};

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 mb-1">{label}</label>
      {children}
      {hint && !error && <p className="text-[9px] font-mono text-muted-foreground/30 mt-0.5 leading-relaxed">{hint}</p>}
      {error && <p className="text-[9px] font-mono text-red-400/70 mt-0.5">{error}</p>}
    </div>
  );
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-2 py-1.5 text-foreground/80 focus:outline-none focus:border-phobos-green/40 placeholder:text-muted-foreground/30"
    />
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full text-[11px] font-mono bg-background border border-border/50 rounded-sm px-2 py-1.5 text-foreground/80 focus:outline-none focus:border-phobos-green/40"
    >
      {children}
    </select>
  );
}

function DropZone({ onFilesDropped }: { onFilesDropped: (files: FileList) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length > 0) onFilesDropped(e.dataTransfer.files); }}
      className={`border border-dashed rounded-sm px-3 py-3 text-center cursor-pointer transition-all ${
        dragging ? 'border-phobos-green/50 bg-phobos-green/5' : 'border-border/30 hover:border-phobos-green/30 hover:bg-phobos-green/[0.02]'
      }`}
      onClick={() => inputRef.current?.click()}
    >
      <Upload className="w-4 h-4 text-muted-foreground/30 mx-auto mb-1" />
      <p className="text-[9px] font-mono text-muted-foreground/40 leading-relaxed">
        Drop to install<br />.phobos · .safetensors · .gguf
      </p>
      <input ref={inputRef} type="file" className="hidden" multiple
        accept=".phobos,.safetensors,.gguf"
        onChange={e => e.target.files && onFilesDropped(e.target.files)}
      />
    </div>
  );
}

// ── Training image drop zone (inside Create Plugin form) ──────────────────────

function TrainingDropZone({
  stagedCount,
  sessionId,
  onStaged,
  large = false,
}: {
  stagedCount:  number;
  sessionId:    string;
  onStaged:     (count: number) => void;
  large?:       boolean;
}) {
  const [dragging,   setDragging]   = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList) => {
    setUploading(true);
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        const res = await fetch(
          `${ENGINE_URL}/api/phobos/plugins/upload?filename=${encodeURIComponent(file.name)}&sessionId=${encodeURIComponent(sessionId)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
        );
        const data = res.ok ? await res.json() : null;
        if (data?.staged) count += data.staged.imageCount ?? 1;
        else if (data?.error) toast.error(`${file.name}: ${data.error}`);
      }
      if (count > 0) onStaged(stagedCount + count);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); }}
      className={`border border-dashed rounded-sm text-center cursor-pointer transition-all ${
        large ? 'px-8 py-16' : 'px-3 py-3'
      } ${
        dragging ? 'border-phobos-green/60 bg-phobos-green/5' : 'border-border/30 hover:border-phobos-green/30 hover:bg-phobos-green/[0.02]'
      }`}
      onClick={() => !uploading && inputRef.current?.click()}
    >
      {uploading ? (
        <Loader2 className={`text-phobos-green/40 animate-spin mx-auto mb-2 ${large ? 'w-8 h-8' : 'w-4 h-4 mb-1'}`} />
      ) : (
        <Upload className={`text-muted-foreground/30 mx-auto mb-2 ${large ? 'w-10 h-10' : 'w-4 h-4 mb-1'}`} />
      )}
      <p className={`font-mono text-muted-foreground/40 leading-relaxed ${large ? 'text-sm' : 'text-[9px]'}`}>
        {stagedCount > 0
          ? <><span className="text-phobos-green/60">{stagedCount} images staged</span><br />Drop more to add</>
          : large
            ? <>Drop your artwork here, or click to browse<br /><span className="text-[11px] text-muted-foreground/25">.png · .jpg · .webp · .tiff · zip archives accepted</span></>
            : <>Drop training images or zips<br />.png · .jpg · .webp · .tiff</>
        }
      </p>
      <input ref={inputRef} type="file" className="hidden" multiple
        accept=".zip,.png,.jpg,.jpeg,.webp,.tiff,.bmp"
        onChange={e => e.target.files && handleFiles(e.target.files)}
      />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function PluginsMenu({ onClose }: PluginsMenuProps) {
  const [plugins,    setPlugins]    = useState<PluginRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [uploading,  setUploading]  = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode,       setMode]       = useState<PanelMode>('view');
  const [filterKind, setFilterKind] = useState<PluginKind | 'all'>('all');
  const [licenseAvail, setLicenseAvail] = useState(false);
  const [activeTrainingId, setActiveTrainingId] = useState<string | null>(null);

  const selected = plugins.find(p => p.id === selectedId) ?? null;

  const fetchPlugins = useCallback(async () => {
    try {
      const res  = await fetch(`${ENGINE_URL}/api/phobos/plugins`);
      const data = res.ok ? await res.json() : [];
      setPlugins(Array.isArray(data) ? data : []);
    } catch { setPlugins([]); }
    finally  { setLoading(false); }
  }, []);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  // Silent license check when a plugin is selected
  useEffect(() => {
    if (!selected || selected.kind !== 'plugin' || !selected.is_local_author) {
      setLicenseAvail(false);
      return;
    }
    fetch(`${ENGINE_URL}/api/phobos/plugins/${encodeURIComponent(selected.id)}/license-unlocked`)
      .then(r => r.json())
      .then((d: { unlocked: boolean }) => {
        setLicenseAvail(d.unlocked);
        // If license matches, skip auth gate entirely when Edit is clicked
      })
      .catch(() => setLicenseAvail(false));
  }, [selected]);

  const handleRequestEdit = () => {
    if (!selected) return;
    // If license already unlocked silently, go straight to edit
    if (licenseAvail && selected.has_license_unlock) {
      _sessionCredential = { useLicense: true };
      setMode('edit');
    } else {
      setMode('auth');
    }
  };

  const handleFilesDropped = async (files: FileList) => {
    setUploading(true);
    // Stable session ID for the whole drop — groups all training images together
    const sessionId = `session_${Date.now()}`;
    let installedCount = 0;
    let stagedCount    = 0;

    try {
      for (const file of Array.from(files)) {
        try {
          const res  = await fetch(
            `${ENGINE_URL}/api/phobos/plugins/upload?filename=${encodeURIComponent(file.name)}&sessionId=${sessionId}`,
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
          );
          const data = res.ok ? await res.json() : null;
          if (!res.ok || !data) { toast.error(`${file.name}: upload failed`); continue; }
          if (data.installed) installedCount++;
          if (data.staged)    stagedCount += data.staged.imageCount ?? 1;
          if (data.error)     toast.error(`${file.name}: ${data.error}`);
        } catch {
          toast.error(`${file.name}: network error`);
        }
      }

      if (installedCount > 0) { toast.success(`Installed ${installedCount} plugin${installedCount > 1 ? 's' : ''}`); await fetchPlugins(); }
      if (stagedCount    > 0)   toast.success(`Staged ${stagedCount} training image${stagedCount > 1 ? 's' : ''} (session: ${sessionId})`);
    } finally {
      setUploading(false);
    }
  };

  const handleSaveDraft = async (
    draft:      { name: string; description: string; tags: string; recommendedWeight: number },
    credential: { password: string } | { useLicense: true },
  ) => {
    if (!selected) return;
    const res = await fetch(`${ENGINE_URL}/api/phobos/plugins/${encodeURIComponent(selected.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        ...credential,
        name:              draft.name,
        description:       draft.description,
        tags:              draft.tags.split(',').map((t: string) => t.trim()).filter(Boolean),
        recommendedWeight: draft.recommendedWeight,
      }),
    });
    if (!res.ok) { toast.error((await res.json() as { error: string }).error); return; }
    const updated = await res.json() as PluginRecord;
    setPlugins(ps => ps.map(p => p.id === updated.id ? updated : p));
    setMode('view');
    toast.success('Plugin updated');
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Remove "${selected.name}"?`)) return;
    await fetch(`${ENGINE_URL}/api/phobos/plugins/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
    setPlugins(ps => ps.filter(p => p.id !== selected.id));
    setSelectedId(null);
    setMode('view');
    toast.success('Plugin removed');
  };

  const visible = filterKind === 'all' ? plugins : plugins.filter(p => p.kind === filterKind);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-[1280px] max-w-[98vw] h-[820px] max-h-[94vh] bg-card border border-border rounded-sm flex flex-col overflow-hidden shadow-2xl">

        <div className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0">
          <div className="flex items-center gap-2">
            <Puzzle className="w-3.5 h-3.5 text-phobos-green/50" />
            <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-phobos-green/70">Art Plugins</span>
          </div>
          <div className="flex items-center gap-2">
            {uploading && <Loader2 className="w-3 h-3 text-phobos-green/40 animate-spin" />}
            <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left column */}
          <div className="w-56 border-r border-border flex flex-col bg-background shrink-0">
            <div className="flex border-b border-border/50 shrink-0">
              {(['all', 'plugin', 'raw_lora'] as const).map(k => (
                <button key={k} onClick={() => setFilterKind(k)}
                  className={`flex-1 py-1.5 text-[8px] font-terminal uppercase tracking-widest transition-colors ${
                    filterKind === k
                      ? 'text-phobos-green/80 border-b border-phobos-green/40 bg-phobos-green/5'
                      : 'text-muted-foreground/40 hover:text-muted-foreground/60'
                  }`}
                >
                  {k === 'all' ? 'All' : k === 'raw_lora' ? 'Raw' : 'Plugin'}
                </button>
              ))}
            </div>

            <div className="p-2 border-b border-border/30 shrink-0">
              <DropZone onFilesDropped={handleFilesDropped} />
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
              {loading && <div className="flex items-center justify-center py-8"><Loader2 className="w-4 h-4 text-phobos-green/40 animate-spin" /></div>}
              {!loading && visible.length === 0 && <p className="text-center py-8 text-[10px] font-mono text-muted-foreground/30">No plugins installed</p>}
              {!loading && visible.map(p => (
                <PluginCard key={p.id} plugin={p} selected={p.id === selectedId}
                  onSelect={() => { setSelectedId(p.id); setMode('view'); _sessionCredential = null; }}
                />
              ))}
            </div>

            <div className="p-2 border-t border-border/30 shrink-0">
              <button
                onClick={() => { setSelectedId(null); setMode('create'); }}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[9px] font-terminal uppercase tracking-widest text-phobos-green/60 border border-phobos-green/20 rounded-sm hover:text-phobos-green hover:border-phobos-green/40 hover:shadow-[0_0_8px_hsl(120_100%_50%/0.08)] transition-all"
              >
                <Plus className="w-3 h-3" /> Create Plugin
              </button>
            </div>
          </div>

          {/* Right column */}
          <div className="flex-1 flex flex-col min-h-0">
            {activeTrainingId ? (
              <TrainingPanel
                sessionId={activeTrainingId}
                onCancel={() => { setActiveTrainingId(null); setMode('view'); }}
                onDone={(pluginId) => {
                  setActiveTrainingId(null);
                  setMode('view');
                  fetchPlugins();
                  setSelectedId(pluginId);
                }}
              />
            ) : mode === 'create' ? (
              <CreateWizard
                onCancel={() => setMode('view')}
                licenseAvail={licenseAvail}
                onTrainingStarted={(sessionId) => {
                  setMode('view');
                  setActiveTrainingId(sessionId);
                }}
              />
            ) : (
              <DetailPanel
                plugin={selected}
                mode={mode}
                onRequestEdit={handleRequestEdit}
                onEditUnlocked={() => setMode('edit')}
                onSaveDraft={handleSaveDraft}
                onCancelEdit={() => { setMode('view'); _sessionCredential = null; }}
                onDelete={handleDelete}
                licenseAvail={licenseAvail}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
