import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Play, CheckSquare, AlertTriangle, Clock, ChevronRight, Plus, Image as ImageIcon, Film, Loader2, CheckCircle, Upload, Trash2, Monitor, Cpu, Music2, Volume2 } from 'lucide-react';
import { useWorkflowStore, type WorkflowNode, type WorkflowNodeType, type WorkflowSession } from '@/store/useWorkflowStore';
import { useAppStore } from '@/store/useAppStore';
import { useImageCatalogue, usePhobosHardware } from '@/hooks/usePhobosLocal';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const PANEL_H = 280; // px — fixed height

// ── Node type display metadata ────────────────────────────────────────────────

const NODE_META: Record<WorkflowNodeType, { label: string; color: string }> = {
  Source:          { label: 'Source',          color: 'text-amber-400' },
  Generate:        { label: 'Generate',         color: 'text-phobos-green' },
  VarySeed:        { label: 'Vary Seed',        color: 'text-blue-400' },
  Img2imgRefine:   { label: 'Img2Img',          color: 'text-cyan-400' },
  KontextEdit:     { label: 'Kontext Edit',     color: 'text-indigo-400' },
  FaceFix:         { label: 'Face Fix',         color: 'text-yellow-400' },
  HandFix:         { label: 'Hand Fix',         color: 'text-orange-400' },
  DepthControlNet: { label: 'Depth CN',         color: 'text-violet-400' },
  RemoveBg:        { label: 'Remove BG',        color: 'text-pink-400' },
  Upscale:         { label: 'Upscale',          color: 'text-emerald-400' },
  VideoGenerate:   { label: 'Video Generate',   color: 'text-phobos-amber' },
  VideoFromImage:  { label: 'Video From Image', color: 'text-orange-300' },
  MusicGenerate:   { label: 'Generate Music',   color: 'text-phobos-green' },
  VoiceClone:      { label: 'Voice Clone',      color: 'text-cyan-400' },
};

// ── Node status indicator ─────────────────────────────────────────────────────

function NodeStatus({ node }: { node: WorkflowNode }) {
  if (!node.executedAt && !node.stale) {
    return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 shrink-0" />;
  }
  if (node.stale) {
    return <AlertTriangle className="w-3 h-3 text-yellow-500/70 shrink-0" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full bg-phobos-green/60 shrink-0" />;
}

// ── Param field renderer ─────────────────────────────────────────────────────

interface ParamFieldProps {
  name:     string;
  value:    unknown;
  onChange: (name: string, value: unknown) => void;
}

function ParamField({ name, value, onChange }: ParamFieldProps) {
  const label = name.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());

  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-2 py-1.5">
        <span className="text-[11px] font-mono text-muted-foreground/60">{label}</span>
        <button
          onClick={() => onChange(name, !value)}
          className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${value ? 'bg-phobos-green/60' : 'bg-muted'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-4.5' : 'left-0.5'}`} />
        </button>
      </div>
    );
  }

  if (typeof value === 'number') {
    const hints: Record<string, string> = {
      strength:        '0–1 · how much to change (1 = ignore input)',
      steps:           'denoising steps · more = slower + higher quality',
      guidance:        'how strictly to follow the prompt',
      controlScale:    '0–1 · depth conditioning influence',
      seed:            '-1 = random · fixed = reproducible',
      seedOffset:      'added to upstream seed',
      preBlur:         'gaussian blur on depth map before generation',
      bboxDilation:    'px to expand the detection region',
      feather:         'px of edge softness on the mask',
      width:           'output width (multiple of 64)',
      height:          'output height (multiple of 64)',
      upscaleRepeats:  '1 pass = 4× scale · do not exceed 1',
      upscaleTileSize: 'larger = faster on high VRAM',
      // Audio params
      duration:        'seconds of audio to generate',
      cfgStrength:     'guidance scale · higher = closer to prompt · default 15',
      speed:           '0.5–2.0 · playback rate of cloned voice',
    };
    const floatFields = new Set(['strength', 'controlScale', 'guidance', 'cfgStrength', 'speed']);
    const hint = hints[name];
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">{label}</span>
          {hint && <span className="text-[9px] text-muted-foreground/30" title={hint}>ⓘ</span>}
        </div>
        <input
          type="number"
          value={value}
          onChange={(e) => {
            const parsed = floatFields.has(name)
              ? parseFloat(e.target.value)
              : parseInt(e.target.value);
            if (!isNaN(parsed)) onChange(name, parsed);
          }}
          step={floatFields.has(name) ? 0.05 : 1}
          className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40"
        />
        {hint && <span className="text-[9px] font-mono text-muted-foreground/25 leading-tight">{hint}</span>}
      </div>
    );
  }

  if (name === 'prompt' || name === 'negativePrompt' || name === 'lyrics' || name === 'text') {
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">{label}</span>
        <textarea
          value={String(value ?? '')}
          onChange={(e) => onChange(name, e.target.value)}
          rows={name === 'lyrics' || name === 'text' ? 5 : name === 'prompt' ? 3 : 2}
          className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40 resize-none"
          placeholder={
            name === 'prompt'         ? 'Describe the image or music style…'
            : name === 'lyrics'       ? 'Song lyrics (leave blank for instrumental)…'
            : name === 'text'         ? 'Text to synthesize…'
            : 'What to avoid…'
          }
        />
      </div>
    );
  }

  if (name === 'refAudio' || name === 'refAudioPath') {
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">Reference Audio</span>
        <div className="flex gap-1">
          <input
            type="text"
            readOnly
            value={String(value ?? '')}
            placeholder="No file selected"
            className="flex-1 min-w-0 bg-black/50 border border-border/30 rounded-l px-2 py-1 text-[11px] font-mono text-muted-foreground/60 focus:outline-none truncate"
          />
          <button
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.wav,.mp3,.flac,.ogg,.m4a';
              input.onchange = () => {
                const file = input.files?.[0];
                if (file) onChange(name, (file as any).path ?? file.name);
              };
              input.click();
            }}
            className="px-2 py-1 text-[10px] font-terminal border border-border/30 rounded-r text-muted-foreground/60 hover:text-phobos-green/70 hover:border-phobos-green/30 transition-colors whitespace-nowrap"
          >
            Browse
          </button>
        </div>
        <span className="text-[9px] font-mono text-muted-foreground/25">WAV · MP3 · FLAC · OGG</span>
      </div>
    );
  }

  if (name === 'sampler') {
    const samplers = ['euler', 'euler_a', 'dpmpp_2m', 'ddpm', 'lcm'];
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">{label}</span>
        <select
          value={String(value ?? 'euler')}
          onChange={(e) => onChange(name, e.target.value)}
          className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40"
        >
          {samplers.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    );
  }

  if (name === 'upscaleModel') {
    const models = ['RealESRGAN_x4plus.pth', 'RealESRGAN_x4plus_anime_6B.pth', 'RealESRGAN_x2plus.pth'];
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">{label}</span>
        <select
          value={String(value ?? models[0])}
          onChange={(e) => onChange(name, e.target.value)}
          className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40"
        >
          {models.map((m) => <option key={m} value={m}>{m.replace('RealESRGAN_', '').replace('.pth', '')}</option>)}
        </select>
      </div>
    );
  }

  if (name === 'model' && (value === 'small' || value === 'medium' || value === 'large')) {
    return (
      <div className="flex flex-col gap-0.5 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">BG Model</span>
        <select
          value={String(value)}
          onChange={(e) => onChange(name, e.target.value)}
          className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40"
        >
          {['small', 'medium', 'large'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
    );
  }

  // Default: text
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wide">{label}</span>
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(name, e.target.value)}
        className="w-full bg-black/50 border border-border/30 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none focus:border-phobos-green/40"
      />
    </div>
  );
}

// ── Param grid — 2 columns for numeric/select params, full-width for text ────

function ResponsiveParamGrid({
  params,
  onChange,
}: {
  params: [string, unknown][];
  onChange: (name: string, value: unknown) => void;
}) {
  // Prompts and booleans go full-width; everything else in a 2-col grid
  const fullWidth = params.filter(([k, v]) => k === 'prompt' || k === 'negativePrompt' || typeof v === 'boolean');
  const gridItems = params.filter(([k, v]) => k !== 'prompt' && k !== 'negativePrompt' && typeof v !== 'boolean');

  return (
    <div className="space-y-0.5">
      {fullWidth.map(([key, val]) => (
        <ParamField key={key} name={key} value={val} onChange={onChange} />
      ))}
      {gridItems.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4">
          {gridItems.map(([key, val]) => (
            <ParamField key={key} name={key} value={val} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Add node button ───────────────────────────────────────────────────────────

const BASE_ADD_NODE_TYPES: WorkflowNodeType[] = [
  'VarySeed', 'Img2imgRefine', 'FaceFix', 'HandFix',
  'DepthControlNet', 'RemoveBg', 'Upscale',
];

/**
 * Returns default params for a new node, applying the active model's profile
 * when available. Profile controls steps, sampler, dimensions, and negative
 * prompt so each model type gets correct defaults out of the box.
 *
 * Nodes that don't use generation params (RemoveBg, Upscale) ignore the profile.
 */
function defaultParamsForType(
  type: WorkflowNodeType,
  profile?: { defaultSteps: number; defaultSampler: string; defaultWidth: number; defaultHeight: number; defaultNegative: string; defaultScheduler?: string } | null,
): Record<string, unknown> {
  const p = profile;
  const base = {
    prompt:         '',
    negativePrompt: p?.defaultNegative ?? '',
    steps:          p?.defaultSteps    ?? 20,
    seed:           -1,
    sampler:        p?.defaultSampler  ?? 'euler',
  };
  const w = p?.defaultWidth  ?? 1024;
  const h = p?.defaultHeight ?? 1024;

  switch (type) {
    case 'VarySeed':        return { ...base, seedOffset: 1, width: w, height: h };
    case 'Img2imgRefine':   return { ...base, strength: 0.8, width: w, height: h };
    case 'FaceFix':         return { ...base, width: Math.min(w, h), strength: 0.5, bboxDilation: 40, feather: 10, threshold: 0.5 };
    case 'HandFix':         return { ...base, width: Math.min(w, h), strength: 0.65, bboxDilation: 30, feather: 8, threshold: 0.5, maxHands: 4 };
    case 'DepthControlNet': return { ...base, strength: 0.7, controlScale: 1.0, preBlur: 0, width: w, height: h };
    case 'KontextEdit':     return { ...base, width: w, height: h };
    case 'RemoveBg':        return { model: 'medium', alphaMatting: false };
    case 'Upscale':         return { upscaleRepeats: 1, upscaleModel: 'RealESRGAN_x4plus.pth', upscaleTileSize: 128, width: w, height: h };
    case 'VideoGenerate':   return { prompt: '', negativePrompt: p?.defaultNegative ?? '', steps: p?.defaultSteps ?? 20, width: p?.defaultWidth ?? 832, height: p?.defaultHeight ?? 480, seed: -1, fps: 12, videoFrames: 49 };
    case 'VideoFromImage':  return { prompt: '', negativePrompt: p?.defaultNegative ?? '', steps: p?.defaultSteps ?? 20, width: p?.defaultWidth ?? 832, height: p?.defaultHeight ?? 480, seed: -1, fps: 12, videoFrames: 49 };
    default:                return { ...base, width: w, height: h }; // Generate
  }
}

function AddNodeMenu({ threadId, workflowId, onAdded, upstreamNode, activeModelId }: { threadId: string; workflowId: string; onAdded: () => void; upstreamNode?: { index: number; outputPath?: string | null }; activeModelId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // KontextEdit node only appears when a kontext model is fully downloaded.
  const { data: imageCatalogue } = useImageCatalogue();
  const kontextInstalled = (imageCatalogue?.models ?? []).some(
    m => m.runnerProfile === 'flux1-kontext' && m.downloaded
  );
  const addNodeTypes: WorkflowNodeType[] = kontextInstalled
    ? [...BASE_ADD_NODE_TYPES.slice(0, 2), 'KontextEdit', ...BASE_ADD_NODE_TYPES.slice(2)]
    : BASE_ADD_NODE_TYPES;

  // Look up the active model's profile for default params
  const activeProfile = (imageCatalogue?.models ?? []).find(m => m.modelId === activeModelId)?.profile ?? null;

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const addNode = async (type: WorkflowNodeType) => {
    setOpen(false);
    try {
      let params = defaultParamsForType(type, activeProfile);
      // Stamp the model onto the new node so it remembers which model created it
      // and the dropdown reflects it correctly when the node is selected.
      if (activeModelId) params = { ...params, modelId: activeModelId };
      const needsDims = ['Img2imgRefine', 'FaceFix', 'HandFix', 'DepthControlNet', 'Upscale'].includes(type);
      if (needsDims && upstreamNode?.outputPath) {
        try {
          const imgUrl = `${ENGINE_URL}/api/threads/${threadId}/workflows/${workflowId}/nodes/${upstreamNode.index}/output`;
          const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
            const img = new Image();
            img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = imgUrl;
          });
          if (dims && dims.width > 0 && dims.height > 0) {
            const isSquareNode = ['FaceFix', 'HandFix'].includes(type);
            if (isSquareNode) {
              // Square: use shortest side rounded to ×64, capped at 1024
              const side = Math.min(1024, Math.round(Math.min(dims.width, dims.height) / 64) * 64);
              params = { ...params, width: side };
            } else {
              const scale = 1024 / Math.max(dims.width, dims.height);
              params = { ...params, width: Math.round(dims.width * scale / 64) * 64, height: Math.round(dims.height * scale / 64) * 64 };
            }
          }
        } catch { /* fall back to defaults */ }
      }
      await fetch(`${ENGINE_URL}/api/threads/${threadId}/workflows/${workflowId}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, label: NODE_META[type].label, params }),
      });
      onAdded();
    } catch { /* silent */ }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-mono text-ui-glow hover:text-phobos-green/70 hover:bg-phobos-green/5 transition-all border-t border-border/20"
      >
        <Plus className="w-3 h-3" />
        ADD NODE
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-40 bg-background border border-phobos-green/20 rounded-sm shadow-xl z-50 overflow-hidden">
          {addNodeTypes.map((type) => (
            <button
              key={type}
              onClick={() => addNode(type)}
              className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-muted-foreground/60 hover:bg-phobos-green/10 hover:text-phobos-green/80 transition-all"
            >
              {NODE_META[type].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Preview pane ──────────────────────────────────────────────────────────────

function PreviewPane({
  threadId,
  workflowId,
  node,
  isGenerating,
  progress,
  previewBase64,
  revision,
}: {
  threadId:    string;
  workflowId:  string;
  node:        WorkflowNode | null;
  isGenerating: boolean;
  progress:    { nodeIndex: number; step: number; totalSteps: number } | null;
  previewBase64: string | null;
  revision:    number;
}) {
  const imgUrl = node?.outputPath
    ? `${ENGINE_URL}/api/threads/${threadId}/workflows/${workflowId}/nodes/${node.index}/output?r=${revision}`
    : null;

  const progressPct = progress && progress.totalSteps > 0
    ? Math.round((progress.step / progress.totalSteps) * 100)
    : 0;

  return (
    <div className="flex flex-col h-full gap-1">
      {/* Status text above preview */}
      {isGenerating && (
        <div className="flex items-center gap-1.5 px-1 shrink-0">
          <Loader2 className="w-3 h-3 text-phobos-green/50 animate-spin shrink-0" />
          <span className="text-[9px] font-mono text-phobos-green/50 truncate">
            {progress ? `Step ${progress.step}/${progress.totalSteps}` : 'Generating…'}
          </span>
        </div>
      )}
      {node?.stale && !isGenerating && (
        <div className="flex items-center gap-1 px-1 shrink-0">
          <AlertTriangle className="w-2.5 h-2.5 text-yellow-500/60 shrink-0" />
          <span className="text-[9px] font-mono text-yellow-500/50">Stale — regenerate to update</span>
        </div>
      )}
      {/* Preview image / video output */}
      <div className="flex-1 relative bg-black/60 rounded border border-border/20 overflow-hidden flex items-center justify-center">
        {node?.type === 'VideoGenerate' || node?.type === 'VideoFromImage' ? (
          node?.outputPath ? (
            <div className="flex flex-col items-center gap-3 select-none">
              <Film className="w-6 h-6 text-phobos-amber/50" />
              <span className="text-[10px] font-mono text-phobos-amber/60">Video ready</span>
              <button
                onClick={async () => {
                  if (!node.outputPath) return;
                  try {
                    await fetch(`${ENGINE_URL}/api/workspace/open-native`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: node.outputPath }),
                    });
                  } catch { /* silent */ }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-terminal tracking-[0.1em] rounded-sm border border-phobos-amber/30 text-phobos-amber/70 hover:text-phobos-amber hover:border-phobos-amber/50 transition-all"
              >
                ▶ Open in native player
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 select-none">
              <Film className="w-6 h-6 text-muted-foreground/15" />
              <span className="text-[10px] font-mono text-muted-foreground/40">
                {isGenerating ? 'Generating video…' : 'No output yet'}
              </span>
            </div>
          )
        ) : imgUrl && !isGenerating ? (
          <img
            src={imgUrl}
            alt="Node output"
            className="max-w-full max-h-full object-contain"
          />
        ) : isGenerating && previewBase64 ? (
          <img
            src={`data:image/png;base64,${previewBase64}`}
            alt="Live preview"
            className="max-w-full max-h-full object-contain opacity-80 transition-opacity duration-300"
          />
        ) : imgUrl ? (
          <img
            src={imgUrl}
            alt="Node output"
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 select-none">
            <ImageIcon className="w-6 h-6 text-muted-foreground/15" />
            <span className="text-[10px] font-mono text-muted-foreground/40">
              {isGenerating ? 'Rendering…' : 'No output yet'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

// ── Plugin Slot ───────────────────────────────────────────────────────────────
// Rendered below the param grid for prompt-bearing nodes when PyTorch is active.
// Up to 3 plugins per node. Each row: plugin dropdown + weight slider.

// Node types that accept LoRA plugins (have a prompt; generate via PyTorch)
const PLUGIN_CAPABLE_NODES = new Set([
  'Generate', 'VarySeed', 'Img2imgRefine', 'FaceFix', 'HandFix',
]);

interface PluginRow {
  pluginId:    string;   // '' = none
  archivePath: string;
  weight:      number;
  triggerWord: string;
  kind:        'plugin' | 'raw_lora';
}

interface InstalledPlugin {
  id:            string;
  name:          string;
  base_model:    string;
  compatible_models: string[] | string;
  kind:          'plugin' | 'raw_lora';
  archive_path:  string;
  trigger_words: string[] | string;
  recommended_weight: number;
  category:      string;
}

const MAX_PLUGINS = 3;
const EMPTY_ROW: PluginRow = { pluginId: '', archivePath: '', weight: 0.75, triggerWord: '', kind: 'plugin' };

function PluginSlot({
  node,
  session,
  disabled,
}: {
  node:     WorkflowNode;
  session:  WorkflowSession;
  disabled: boolean;
}) {
  const [allPlugins, setAllPlugins] = useState<InstalledPlugin[]>([]);
  const [rows,       setRows]       = useState<PluginRow[]>([{ ...EMPTY_ROW }]);
  const patchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch installed plugins once on mount
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/phobos/plugins`)
      .then(r => r.ok ? r.json() : [])
      .then((data: InstalledPlugin[]) => setAllPlugins(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Sync rows from node.params.plugins on node change
  useEffect(() => {
    const stored = (node.params as Record<string, unknown>).plugins;
    if (Array.isArray(stored) && stored.length > 0) {
      setRows(stored as PluginRow[]);
    } else {
      setRows([{ ...EMPTY_ROW }]);
    }
  }, [node.id]);

  // Persist rows to node params (debounced 300ms to avoid hammering)
  const persistRows = useCallback((nextRows: PluginRow[]) => {
    if (patchTimeoutRef.current) clearTimeout(patchTimeoutRef.current);
    patchTimeoutRef.current = setTimeout(async () => {
      const bindings = nextRows.filter(r => r.pluginId !== '');
      try {
        await fetch(
          `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${node.id}`,
          {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ params: { ...node.params, plugins: bindings } }),
          }
        );
      } catch { /* silent */ }
    }, 300);
  }, [node.id, node.params, session.threadId, session.workflowId]);

  const updateRow = (i: number, patch: Partial<PluginRow>) => {
    setRows(prev => {
      const next = prev.map((r, idx) => idx === i ? { ...r, ...patch } : r);
      persistRows(next);
      return next;
    });
  };

  const selectPlugin = (i: number, pluginId: string) => {
    if (pluginId === '') {
      updateRow(i, { ...EMPTY_ROW });
      return;
    }
    const plugin = allPlugins.find(p => p.id === pluginId);
    if (!plugin) return;
    const triggerWords = Array.isArray(plugin.trigger_words)
      ? plugin.trigger_words
      : tryParseJson<string[]>(plugin.trigger_words as string, []);
    updateRow(i, {
      pluginId:    plugin.id,
      archivePath: plugin.archive_path,
      weight:      plugin.recommended_weight,
      triggerWord: triggerWords[0] ?? '',
      kind:        plugin.kind,
    });
  };

  const addRow = () => {
    if (rows.length >= MAX_PLUGINS) return;
    const next = [...rows, { ...EMPTY_ROW }];
    setRows(next);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    const final = next.length > 0 ? next : [{ ...EMPTY_ROW }];
    setRows(final);
    persistRows(final);
  };

  // Filter to plugins compatible with current model
  const modelId     = (session.modelId ?? '').toLowerCase();
  const compatible  = allPlugins.filter(p => {
    if (p.kind === 'raw_lora') return true;                      // raw LoRAs always shown
    if (p.base_model === '*')   return true;
    const models = Array.isArray(p.compatible_models)
      ? p.compatible_models
      : tryParseJson<string[]>(p.compatible_models as string, [p.base_model]);
    return models.some(m => modelId.includes(m) || m === '*');
  });

  const activeCount  = rows.filter(r => r.pluginId !== '').length;
  const activeRows   = rows.filter(r => r.pluginId !== '');
  const totalWeight  = activeRows.reduce((s, r) => s + r.weight, 0);

  // Detect category conflicts — two or more active plugins sharing the same
  // non-generic category. Pull category from the catalogue for each active row.
  const conflictCategories: string[] = [];
  if (activeRows.length >= 2) {
    const catCount: Record<string, number> = {};
    for (const row of activeRows) {
      const plugin = allPlugins.find(p => p.id === row.pluginId);
      const cat    = plugin?.category ?? '';
      if (cat && cat !== 'generic') catCount[cat] = (catCount[cat] ?? 0) + 1;
    }
    for (const [cat, count] of Object.entries(catCount)) {
      if (count >= 2) conflictCategories.push(cat);
    }
  }

  const weightWarn  = activeRows.length >= 2 && totalWeight > 1.0 && totalWeight <= 1.5;
  const weightError = activeRows.length >= 2 && totalWeight > 1.5;

  return (
    <div className="mt-2 pt-2 border-t border-border/20">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[8px] font-terminal uppercase tracking-[0.12em] text-muted-foreground/40">
          Art Plugins
          {activeCount > 0 && (
            <span className="ml-1.5 text-phobos-green/50">{activeCount} active</span>
          )}
        </span>
        {rows.length < MAX_PLUGINS && !disabled && (
          <button
            onClick={addRow}
            className="flex items-center gap-0.5 text-[8px] font-terminal text-muted-foreground/30 hover:text-phobos-green/50 transition-colors"
          >
            <Plus className="w-2.5 h-2.5" /> add
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {/* Plugin select */}
            <select
              value={row.pluginId}
              disabled={disabled}
              onChange={e => selectPlugin(i, e.target.value)}
              className="flex-1 min-w-0 text-[9px] font-mono bg-background border border-border/30 rounded-sm px-1.5 py-1 text-foreground/70 focus:outline-none focus:border-phobos-green/30 disabled:opacity-40 disabled:cursor-not-allowed appearance-none"
            >
              <option value="">— none —</option>
              {compatible.map(p => (
                <option key={p.id} value={p.id} className="bg-black">
                  {p.name}{p.kind === 'raw_lora' ? ' ⚠' : ''}
                </option>
              ))}
            </select>

            {/* Weight slider — only shown when a plugin is selected */}
            {row.pluginId !== '' && (
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="range"
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  value={row.weight}
                  disabled={disabled}
                  onChange={e => updateRow(i, { weight: Number(e.target.value) })}
                  className="w-16 accent-phobos-green disabled:opacity-40"
                />
                <span className="text-[9px] font-mono text-muted-foreground/50 w-7 text-right">
                  {row.weight.toFixed(2)}
                </span>
              </div>
            )}

            {/* Remove row button — always shown except when it's the only empty row */}
            {(rows.length > 1 || row.pluginId !== '') && (
              <button
                onClick={() => removeRow(i)}
                disabled={disabled}
                className="shrink-0 text-muted-foreground/20 hover:text-red-400/50 transition-colors disabled:opacity-30"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Weight sum indicator — shown when 2+ active plugins */}
      {activeRows.length >= 2 && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-terminal text-muted-foreground/30 uppercase tracking-[0.1em]">
              Combined weight
            </span>
            <span className={`text-[9px] font-mono ${
              weightError ? 'text-red-400/80' : weightWarn ? 'text-phobos-amber/80' : 'text-phobos-green/60'
            }`}>
              {totalWeight.toFixed(2)}
            </span>
          </div>
          <div className="h-0.5 w-full bg-border/20 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                weightError ? 'bg-red-400/70' : weightWarn ? 'bg-phobos-amber/60' : 'bg-phobos-green/50'
              }`}
              style={{ width: `${Math.min(100, (totalWeight / 2.0) * 100)}%` }}
            />
          </div>
          {weightError && (
            <p className="text-[8px] font-mono text-red-400/70 leading-relaxed">
              Total weight over 1.5 — results may be incoherent. Lower individual weights.
            </p>
          )}
          {weightWarn && !weightError && (
            <p className="text-[8px] font-mono text-phobos-amber/60 leading-relaxed">
              Combined weight over 1.0 — styles may compete. Consider lowering one.
            </p>
          )}
          {conflictCategories.length > 0 && (
            <p className="text-[8px] font-mono text-phobos-amber/60 leading-relaxed">
              Multiple {conflictCategories.join(' & ')} plugins active — they may conflict.
            </p>
          )}
        </div>
      )}

      {compatible.length === 0 && allPlugins.length > 0 && (
        <p className="text-[8px] font-mono text-muted-foreground/25 mt-1">
          No plugins compatible with current model
        </p>
      )}
      {allPlugins.length === 0 && (
        <p className="text-[8px] font-mono text-muted-foreground/25 mt-1">
          No plugins installed — open Art Plugins to add one
        </p>
      )}
    </div>
  );
}

function tryParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// ── AudioOutputPane — plays generated WAV output in the right column ──────────

function AudioOutputPane({
  node, isGenerating, threadId, workflowId,
}: {
  node:         WorkflowNode | null;
  isGenerating: boolean;
  threadId:     string;
  workflowId:   string;
}) {
  const outputPath = node?.outputPath ?? null;
  const audioUrl   = outputPath
    ? `${ENGINE_URL}/api/audio/output?path=${encodeURIComponent(outputPath)}`
    : null;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 border border-border/20 rounded-sm bg-black/40">
      {isGenerating ? (
        <div className="flex flex-col items-center gap-2">
          <Music2 className="w-6 h-6 text-phobos-green/40 animate-pulse" />
          <span className="text-[9px] font-mono text-muted-foreground/40">Generating…</span>
        </div>
      ) : audioUrl ? (
        <div className="flex flex-col items-center gap-2 px-3 w-full">
          <Volume2 className="w-4 h-4 text-phobos-green/50" />
          <audio
            src={audioUrl}
            controls
            className="w-full h-8"
            style={{ colorScheme: 'dark' }}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <Music2 className="w-6 h-6 text-muted-foreground/20" />
          <span className="text-[9px] font-mono text-muted-foreground/30">No output yet</span>
        </div>
      )}
    </div>
  );
}

export function WorkflowPanel() {
  const activeSession    = useWorkflowStore((s) => s.activeSession);
  const panelOpen        = useWorkflowStore((s) => s.panelOpen);
  const activeNodeIndex  = useWorkflowStore((s) => s.activeNodeIndex);
  const generating       = useWorkflowStore((s) => s.generating);
  const progress         = useWorkflowStore((s) => s.progress);
  const preview          = useWorkflowStore((s) => s.preview);
  const closePanel       = useWorkflowStore((s) => s.closePanel);
  const setActiveNodeIndex = useWorkflowStore((s) => s.setActiveNodeIndex);

  const [batchEnabled, setBatchEnabled] = useState(false);
  const [batchCount,   setBatchCount]   = useState(4);
  const [batchStep,    setBatchStep]    = useState<{ current: number; total: number } | null>(null);
  const batchAbortRef = useRef(false);
  const [nodeError,    setNodeError]    = useState<string | null>(null);
  const updateNodeParams = useWorkflowStore((s) => s.updateNodeParams);
  const markNodeDone     = useWorkflowStore((s) => s.markNodeDone);
  const markStale        = useWorkflowStore((s) => s.markStale);
  const setGenerating    = useWorkflowStore((s) => s.setGenerating);
  const setProgress      = useWorkflowStore((s) => s.setProgress);
  const setPreview       = useWorkflowStore((s) => s.setPreview);
  const pushRenderPhase  = useWorkflowStore((s) => s.pushRenderPhase);
  const clearRenderPhases = useWorkflowStore((s) => s.clearRenderPhases);
  const renderPhases     = useWorkflowStore((s) => s.renderPhases);
  const setSession       = useWorkflowStore((s) => s.setSession);
  const revision         = useWorkflowStore((s) => s.revision);
  const activeThreadId   = useAppStore((s) => s.activeThreadId);
  const imageGenerating  = useAppStore((s) => s.imageGenerating);

  const [localParams, setLocalParams] = useState<Record<string, unknown>>({});
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');

  // ── Model & GPU dropdown data ──────────────────────────────────────────────
  const { data: catalogueData } = useImageCatalogue();
  const { data: hwData } = usePhobosHardware();
  const downloadedModels = (catalogueData?.models ?? []).filter(m => m.downloaded);
  const gpus = hwData?.hardware?.gpus ?? [];

  // Save GPU target to the session (session-level, not per-node)
  const saveGpuTarget = useCallback(async (targetGpuIndex: number | null) => {
    if (!activeSession) return;
    try {
      await fetch(`${ENGINE_URL}/api/threads/${activeSession.threadId}/workflows/${activeSession.workflowId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetGpuIndex }),
      });
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeSession.threadId}/workflows/${activeSession.workflowId}`);
      if (res.ok) {
        const data = await res.json();
        setSession(data.session);
      }
    } catch { /* silent */ }
  }, [activeSession, setSession]);

  // Hoist these before saveImageBackend so activeModelId is available in its deps
  const session      = activeSession;
  const workflowId   = session?.workflowId ?? '';
  const nodes        = session?.nodes ?? [];
  const activeNode   = nodes[activeNodeIndex] ?? null;
  // The model for the active node — per-node if set, otherwise session default
  const activeModelId = (activeNode?.params?.modelId as string) || session?.modelId || '';

  // Save image generation backend preference to the session.
  // If switching to pytorch and the active model is an unconverted SDXL,
  // clear the model selection — unconverted SDXL can't run on pytorch.
  const saveAudioBackend = useCallback(async (audioBackend: 'auto' | 'gpu' | 'cpu') => {
    if (!session) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBackend }),
      });
      if (res.ok) {
        const data = await res.json();
        setSession(data.session);
      }
    } catch { /* silent */ }
  }, [session, setSession]);

  const saveImageBackend = useCallback(async (imageBackend: 'auto' | 'pytorch' | 'sdcli') => {
    if (!activeSession) return;
    try {
      const activeModel = downloadedModels.find(m => m.modelId === activeModelId);
      const isUnconvertedSdxl = activeModel?.runnerProfile === 'sdxl' && !activeModel?.pytorchVariantReady;
      const shouldClearModel  = imageBackend === 'pytorch' && isUnconvertedSdxl;

      const body: Record<string, unknown> = { imageBackend };
      if (shouldClearModel) body.modelId = null;

      await fetch(`${ENGINE_URL}/api/threads/${activeSession.threadId}/workflows/${activeSession.workflowId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeSession.threadId}/workflows/${activeSession.workflowId}`);
      if (res.ok) {
        const data = await res.json();
        setSession(data.session);
      }
    } catch { /* silent */ }
  }, [activeSession, setSession, activeModelId, downloadedModels]);

  const anyWorkflowGenerating = Object.values(generating).some(Boolean);
  const isGenerating  = anyWorkflowGenerating || imageGenerating;
  const currentProg   = progress[workflowId] ?? null;
  const currentPhases = renderPhases[workflowId] ?? [];

  // Sync local params when active node changes
  useEffect(() => {
    if (activeNode) setLocalParams({ ...activeNode.params });
  }, [activeNode?.id, activeNodeIndex]);

  const handleParamChange = useCallback((name: string, value: unknown) => {
    setLocalParams((p) => ({ ...p, [name]: value }));
  }, []);

  // Auto-save params after any edit (debounced 500ms)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeNode || !session) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      updateNodeParams(activeNode.id, localParams);
      try {
        await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params: localParams }),
        });
      } catch { /* silent */ }
    }, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [localParams]);

  const saveParams = useCallback(async () => {
    // Flush any pending debounced save immediately
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!activeNode || !session) return;
    updateNodeParams(activeNode.id, localParams);
    try {
      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: localParams }),
      });
    } catch { /* silent */ }
  }, [activeNode, localParams, session, updateNodeParams]);

  // Change the active node's model — resets generation params to the new model's
  // profile defaults (steps, sampler, dimensions, negative prompt) while preserving
  // user-entered content (prompt, seed). Only applies to generation-capable nodes.
  const changeNodeModel = useCallback(async (modelId: string) => {
    if (!session || !activeNode) return;

    // Flush any pending debounced save so stale params don't overwrite our new ones
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    // Look up the new model's profile from catalogue
    const newModelSpec = downloadedModels.find(m => m.modelId === modelId);
    const profile = newModelSpec?.profile ?? null;

    // Node types that use generation params and should get profile defaults
    const generationNodes = new Set<string>([
      'Generate', 'VarySeed', 'Img2imgRefine', 'DepthControlNet',
      'KontextEdit', 'VideoGenerate', 'VideoFromImage',
    ]);

    let newParams: Record<string, unknown>;
    if (profile && generationNodes.has(activeNode.type)) {
      // Start with profile defaults
      let profileWidth  = profile.defaultWidth;
      let profileHeight = profile.defaultHeight;

      // If the node has an upstream image (index > 0), fit the profile's max
      // dimension to the upstream output while preserving its aspect ratio,
      // matching the behaviour of AddNodeMenu when a node is first added.
      const upstreamNode = nodes[activeNode.index - 1] ?? null;
      const needsDims = ['Img2imgRefine', 'FaceFix', 'HandFix', 'DepthControlNet', 'Upscale'].includes(activeNode.type);
      if (needsDims && upstreamNode?.outputPath) {
        try {
          const imgUrl = `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${upstreamNode.index}/output`;
          const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
            const img = new Image();
            img.onload  = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = imgUrl;
          });
          if (dims && dims.width > 0 && dims.height > 0) {
            const isSquareNode = activeNode.type === 'FaceFix' || activeNode.type === 'HandFix';
            if (isSquareNode) {
              profileWidth = Math.min(1024, Math.round(Math.min(dims.width, dims.height) / 64) * 64);
              profileHeight = profileWidth;
            } else {
              const scale = 1024 / Math.max(dims.width, dims.height);
              profileWidth  = Math.round(dims.width  * scale / 64) * 64;
              profileHeight = Math.round(dims.height * scale / 64) * 64;
            }
          }
        } catch { /* fall back to profile defaults */ }
      }

      // Reset generation params to new model's defaults, preserve user content
      newParams = {
        ...localParams,
        modelId,
        steps:          profile.defaultSteps,
        sampler:        profile.defaultSampler,
        negativePrompt: profile.defaultNegative,
        width:          profileWidth,
        height:         profileHeight,
        // Preserve: prompt, seed, strength, controlScale, etc. — these are user choices
      };
      // FaceFix/HandFix use square dimensions — use single width field
      if (activeNode.type === 'FaceFix' || activeNode.type === 'HandFix') {
        newParams.width = profileWidth;
        delete newParams.height; // square nodes only use width
      }
    } else {
      // Non-generation node or no profile — just stamp the modelId
      newParams = { ...localParams, modelId };
    }

    setLocalParams(newParams);
    updateNodeParams(activeNode.id, newParams);
    // Save immediately (don't wait for debounce)
    try {
      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: newParams }),
      });
    } catch { /* silent */ }
  }, [session, activeNode, localParams, updateNodeParams, downloadedModels]);

  const reloadSession = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}`);
      if (res.ok) {
        const data = await res.json();
        setSession(data.session);
      }
    } catch { /* silent */ }
  }, [session, setSession]);

  // Switch between MusicGenerate and VoiceClone for audio workflows.
  // Uses the same PATCH node/type mechanism as Generate↔Source toggling —
  // alt-state is preserved server-side so switching back restores prior params.
  const switchAudioMode = useCallback(async (newType: 'MusicGenerate' | 'VoiceClone') => {
    if (!session || !activeNode || activeNode.type === newType) return;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const defaultParams = newType === 'MusicGenerate'
      ? { prompt: '', lyrics: '', duration: 30, steps: 60, cfgStrength: 15.0, seed: -1 }
      : { text: '', refAudio: '', refText: '', speed: 1.0, steps: 32 };
    try {
      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newType, params: defaultParams }),
      });
      await reloadSession();
    } catch { /* silent */ }
  }, [session, activeNode, reloadSession]);

  const saveRename = useCallback(async (newName: string) => {
    if (!session || !newName.trim()) { setEditingName(false); return; }
    const trimmed = newName.trim();
    try {
      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      await reloadSession();
    } catch { /* silent */ }
    setEditingName(false);
  }, [session, reloadSession]);

  const runGenerate = useCallback(async (targetNodeIndex: number, isFinal = false) => {
    if (!session || isGenerating) return;
    await saveParams();
    setGenerating(session.workflowId, true);
    setProgress(session.workflowId, null);
    clearRenderPhases(session.workflowId);
    setNodeError(null);
    setActiveNodeIndex(targetNodeIndex);

    try {
      // Fire-and-forget — starts generation on server
      const res = await fetch(
        `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetNodeIndex,
            isFinal,
            forceNodeIndex: isFinal ? undefined : targetNodeIndex,
          }),
        }
      );

      if (!res.ok) {
        setGenerating(session.workflowId, false);
        return;
      }

      // Poll run-status until generation completes
      // Max 20 minutes of polling — safety net against infinite loops
      const pollInterval = 1500;
      const pollDeadline = Date.now() + 20 * 60 * 1000;
      let consecutiveErrors = 0;
      while (Date.now() < pollDeadline) {
        await new Promise(r => setTimeout(r, pollInterval));
        try {
          const statusRes = await fetch(
            `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/run-status`
          );
          if (!statusRes.ok) { consecutiveErrors++; if (consecutiveErrors > 10) break; continue; }
          consecutiveErrors = 0;
          const status = await statusRes.json();

          // Update progress
          if (status.progress) {
            setProgress(session.workflowId, status.progress);
          }

          // Live preview — base64 PNG from latent projection, updated each step
          if (status.preview) {
            setPreview(session.workflowId, status.preview);
          }

          // Update phases
          if (status.phases?.length > 0) {
            // Replace all phases from server state
            clearRenderPhases(session.workflowId);
            for (const p of status.phases) {
              pushRenderPhase(session.workflowId, p.renderPhase, p.detail);
            }
          }

          // Switch active node
          if (status.activeNode !== undefined) {
            setActiveNodeIndex(status.activeNode);
          }

          // Check if done
          if (!status.generating) {
            setGenerating(session.workflowId, false);
            setProgress(session.workflowId, null);
            setPreview(session.workflowId, null);
            clearRenderPhases(session.workflowId);
            if (status.error) {
              setNodeError(status.error);
            } else {
              setNodeError(null);
              try { await reloadSession(); } catch { /* non-fatal */ }
            }
            break;
          }
        } catch { consecutiveErrors++; if (consecutiveErrors > 10) break; /* poll failed, retry */ }
      }
      // Ensure generating is always cleared when the loop exits
      setGenerating(session.workflowId, false);
      setProgress(session.workflowId, null);
      setPreview(session.workflowId, null);
    } catch {
      setGenerating(session.workflowId, false);
      setProgress(session.workflowId, null);
      setPreview(session.workflowId, null);
    }
  }, [session, isGenerating, saveParams, setGenerating, setProgress, setPreview, pushRenderPhase, clearRenderPhases, markNodeDone, markStale, reloadSession, setActiveNodeIndex]);

  const runBatch = useCallback(async (targetNodeIndex: number, count: number) => {
    if (!session || isGenerating) return;
    const node = session.nodes[targetNodeIndex];
    if (!node) return;
    batchAbortRef.current = false;

    // Acquire a Web Lock to prevent browser from throttling JS timers in background tabs.
    // navigator.locks keeps the tab "active" for the duration of the batch.
    const runBatchWork = async () => {
    for (let i = 1; i <= count; i++) {
      if (batchAbortRef.current) break;
      setBatchStep({ current: i, total: count });

      // Run one generation step — inline the poll loop so we don't hit
      // the isGenerating guard in runGenerate on iterations 2+
      await saveParams();
      setGenerating(session.workflowId, true);
      setProgress(session.workflowId, null);
      clearRenderPhases(session.workflowId);
      setActiveNodeIndex(targetNodeIndex);

      // Snapshot the output file's mtime before the run starts. After the run
      // completes we wait until the mtime has advanced, guaranteeing the file
      // on disk is the result of this iteration and not the previous one.
      let preMtime = 0;
      try {
        const mtimeRes = await fetch(
          `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${node.id}/output-mtime`
        );
        if (mtimeRes.ok) { const { mtime } = await mtimeRes.json(); preMtime = mtime ?? 0; }
      } catch { /* file may not exist yet on first iteration */ }

      if (batchAbortRef.current) break;
      const res = await fetch(
        `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetNodeIndex, isFinal: false, forceNodeIndex: targetNodeIndex }),
        }
      );
      if (!res.ok) break;

      // Poll until done
      while (true) {
        await new Promise(r => setTimeout(r, 500));
        if (batchAbortRef.current) break;
        try {
          const sr = await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/run-status`);
          if (!sr.ok) continue;
          const s = await sr.json();
          if (s.progress) setProgress(session.workflowId, s.progress);
          if (s.preview) setPreview(session.workflowId, s.preview);
          if (s.phases?.length > 0) {
            clearRenderPhases(session.workflowId);
            for (const p of s.phases) pushRenderPhase(session.workflowId, p.renderPhase, p.detail);
          }
          if (s.activeNode !== undefined) setActiveNodeIndex(s.activeNode);
          if (!s.generating) {
            // Don't call setGenerating(false) here — batch loop keeps generating=true
            // across all iterations to prevent overlay flicker between images.
            setProgress(session.workflowId, null);
            setPreview(session.workflowId, null);
            clearRenderPhases(session.workflowId);
            if (!batchAbortRef.current) await reloadSession();
            break;
          }
        } catch { /* retry */ }
      }

      if (batchAbortRef.current) break;

      // Wait for the output file mtime to advance past the pre-run snapshot.
      // This guarantees the file on disk is the result of this iteration before
      // we copy it — prevents two consecutive saves picking up the same image.
      if (preMtime > 0) {
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(r => setTimeout(r, 250));
          try {
            const mtimeRes = await fetch(
              `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${node.id}/output-mtime`
            );
            if (mtimeRes.ok) {
              const { mtime } = await mtimeRes.json();
              if ((mtime ?? 0) > preMtime) break;
            }
          } catch { /* continue waiting */ }
        }
      }

      // Save this run's output to the images folder with batch naming
      await fetch(
        `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${node.id}/save-batch-output`,
        { method: 'POST' }
      ).catch(() => { /* non-fatal — generation succeeded, copy failure is cosmetic */ });
    }

    setGenerating(session.workflowId, false);
    batchAbortRef.current = false;
    setBatchStep(null);
    }; // end runBatchWork

    // Run inside a Web Lock so background tab timers aren't throttled
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('phobos-batch-render', runBatchWork);
    } else {
      await runBatchWork();
    }
  }, [session, isGenerating, saveParams, setGenerating, setProgress, setPreview, clearRenderPhases, pushRenderPhase, setActiveNodeIndex, reloadSession]);

  const handleAbort = useCallback(async () => {
    if (!session) return;
    batchAbortRef.current = true;
    try {
      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/abort`, { method: 'POST' });
    } catch { /* non-fatal */ }
    setGenerating(session.workflowId, false);
    setProgress(session.workflowId, null);
    clearRenderPhases(session.workflowId);
    setBatchStep(null);
    // Reload session so any nodes that completed before abort show their output
    try { await reloadSession(); } catch { /* non-fatal */ }
  }, [session, setGenerating, setProgress, clearRenderPhases, reloadSession]);

  if (!panelOpen || !session) return null;

  return (
    <div
      className="phobos-panel border-t border-phobos-green/20 bg-black/95 shrink-0 flex flex-col"
      style={{ height: PANEL_H }}
    >
      {/* Panel header */}
      <div className="flex items-center gap-2 px-3 h-8 border-b border-border/30 shrink-0">
        {session.workflowType === 'audio'
          ? <Music2 className="w-3 h-3 text-phobos-green/60" />
          : <ImageIcon className="w-3 h-3 text-phobos-green/60" />
        }
        {editingName ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={() => saveRename(nameValue)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveRename(nameValue); if (e.key === 'Escape') setEditingName(false); }}
            className="text-[10px] font-terminal tracking-[0.15em] text-phobos-green/70 uppercase bg-transparent border-b border-phobos-green/40 focus:outline-none px-0 py-0 w-48"
          />
        ) : (
          <span
            onDoubleClick={() => { setNameValue(session.name); setEditingName(true); }}
            className="text-[10px] font-terminal tracking-[0.15em] text-phobos-green/70 uppercase cursor-default select-none"
            title="Double-click to rename"
          >
            {session.name}
          </span>
        )}
        <span className="text-[9px] font-mono text-muted-foreground/50 ml-1">·</span>

        {/* Model selector — audio workflows show a Music/Clone mode switcher;
            image/video workflows show the downloaded model dropdown */}
        {session.workflowType === 'audio' ? (
          <div className="flex items-center gap-0.5 border border-border/30 rounded overflow-hidden h-5">
            <button
              onClick={() => switchAudioMode('MusicGenerate')}
              disabled={isGenerating}
              className={`px-2 h-full text-[9px] font-terminal tracking-[0.08em] transition-colors disabled:opacity-30 ${
                activeNode?.type === 'MusicGenerate'
                  ? 'bg-phobos-green/20 text-phobos-green/90'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title="Music generation"
            >MUSIC</button>
            <span className="w-px h-3 bg-border/40 shrink-0" />
            <button
              onClick={() => switchAudioMode('VoiceClone')}
              disabled={isGenerating}
              className={`px-2 h-full text-[9px] font-terminal tracking-[0.08em] transition-colors disabled:opacity-30 ${
                activeNode?.type === 'VoiceClone'
                  ? 'bg-cyan-400/15 text-cyan-400/90'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title="Voice clone"
            >CLONE</button>
          </div>
        ) : (
          <select
            value={activeModelId}
            onChange={(e) => changeNodeModel(e.target.value)}
            disabled={isGenerating}
            className="text-[9px] font-mono text-phobos-green/80 bg-background border border-phobos-green/20 rounded px-1 py-0 h-5 hover:border-phobos-green/40 focus:border-phobos-green/50 focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed max-w-[200px] truncate appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2322c55e\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '14px' }}
            title="Image model (per node)"
          >
            {downloadedModels.length > 0 ? (
              downloadedModels.filter(m => m.runnerProfile !== 'flux1-kontext').map(m => {
                const compat = m.gpuCompat ?? [];
                const anyFits = compat.length === 0 || compat.some(g => g.fits && !g.vulkanBlocked);
                const bestTotal = compat.length > 0
                  ? Math.min(...compat.filter(g => g.fits).map(g => g.totalNeededMb))
                  : m.vramRequiredGb * 1024;
                const label = bestTotal > 0 ? `${(bestTotal / 1024).toFixed(1)}GB` : `${m.vramRequiredGb}GB`;
                const isPytorch = (session?.imageBackend ?? 'auto') === 'pytorch';
                const needsConvert = isPytorch && m.runnerProfile === 'sdxl' && !m.pytorchVariantReady;
                const isDisabled = !anyFits || needsConvert;
                const suffix = !anyFits ? ' ⚠' : needsConvert ? ' — requires PyTorch conversion' : '';
                return (
                  <option
                    key={m.modelId}
                    value={m.modelId}
                    className={`bg-background ${isDisabled ? 'text-muted-foreground/30' : anyFits ? 'text-phobos-green/80' : 'text-red-400/60'}`}
                    disabled={isDisabled}
                  >
                    {m.displayName || m.label} ({label}){suffix}
                  </option>
                );
              })
            ) : (
              <option value={activeModelId} className="bg-black">{activeModelId}</option>
            )}
          </select>
        )}

        {/* GPU target dropdown — hidden for audio (resolvePythonDevice picks GPU internally) */}
        {gpus.length > 0 && session.workflowType !== 'audio' && (
          <>
            <Monitor className="w-2.5 h-2.5 text-muted-foreground/50 ml-1 shrink-0" />
            <select
              value={session.targetGpuIndex ?? 'auto'}
              onChange={(e) => {
                const val = e.target.value;
                saveGpuTarget(val === 'auto' ? null : Number(val));
              }}
              disabled={isGenerating}
              className="text-[9px] font-mono text-ui-glow bg-background border border-border/30 rounded px-1 py-0 h-5 hover:border-muted-foreground/40 focus:border-muted-foreground/50 focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed max-w-[160px] truncate appearance-none"
              style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236b7280\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '14px' }}
              title="Target GPU"
            >
              <option value="auto" className="bg-black">Auto</option>
              {gpus.map(g => (
                <option key={g.index} value={g.index} className="bg-black">
                  {g.name} ({g.vramGb}GB)
                </option>
              ))}
              <option value={-1} className="bg-black">CPU</option>
            </select>
          </>
        )}

        {/* Backend dropdown — changes based on workflowType */}
        <Cpu className="w-2.5 h-2.5 text-muted-foreground/50 ml-1 shrink-0" />
        {session.workflowType === 'audio' ? (
          <select
            value={session.audioBackend ?? 'auto'}
            onChange={(e) => saveAudioBackend(e.target.value as 'auto' | 'gpu' | 'cpu')}
            disabled={isGenerating}
            className="text-[9px] font-mono text-ui-glow bg-background border border-border/30 rounded px-1 py-0 h-5 hover:border-muted-foreground/40 focus:border-muted-foreground/50 focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236b7280\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '14px' }}
            title="Audio generation backend"
          >
            <option value="auto" className="bg-black">Auto</option>
            <option value="gpu" className="bg-black">GPU (Python)</option>
            <option value="cpu" className="bg-black">CPU (C++)</option>
          </select>
        ) : (
          <select
            value={session.imageBackend ?? 'auto'}
            onChange={(e) => saveImageBackend(e.target.value as 'auto' | 'pytorch' | 'sdcli')}
            disabled={isGenerating}
            className="text-[9px] font-mono text-ui-glow bg-background border border-border/30 rounded px-1 py-0 h-5 hover:border-muted-foreground/40 focus:border-muted-foreground/50 focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236b7280\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '14px' }}
            title="Image generation backend"
          >
            <option value="auto" className="bg-black">Auto</option>
            <option value="pytorch" className="bg-black">PyTorch</option>
            <option value="sdcli" className="bg-black">sd-cli</option>
          </select>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={closePanel}
            className="p-1 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title="Close workflow"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Three-column body */}
      <div className="flex flex-1 min-h-0">

        {/* LEFT: Node list */}
        <div className="w-36 shrink-0 flex flex-col border-r border-border/30 relative">
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {nodes.map((node) => {
              const meta    = NODE_META[node.type];
              const isActive = node.index === activeNodeIndex;
              const canToggleSource = node.index === 0 && (node.type === 'Generate' || node.type === 'Source');
              return (
                <button
                  key={node.id}
                  onClick={() => !isGenerating && setActiveNodeIndex(node.index)}
                  onContextMenu={canToggleSource && !isGenerating ? async (e) => {
                    e.preventDefault();
                    const newType = node.type === 'Generate' ? 'Source' : 'Generate';
                    const newParams = newType === 'Source'
                      ? { sourcePath: '' }
                      : { prompt: '', negativePrompt: '', steps: 20, width: 1024, height: 1024, seed: -1, sampler: 'euler' };
                    try {
                      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${node.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ params: newParams, type: newType }),
                      });
                      await reloadSession();
                    } catch { /* silent */ }
                  } : undefined}
                  disabled={isGenerating}
                  title={canToggleSource ? 'Right-click to toggle Generate ↔ Source' : undefined}
                  className={`w-full flex items-center gap-2 px-2 py-2 text-left transition-all border-b border-border/10 ${
                    isActive
                      ? 'bg-phobos-green/8 border-l-2 border-l-phobos-green/50'
                      : 'hover:bg-muted/20 border-l-2 border-l-transparent'
                  } ${isGenerating ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <NodeStatus node={node} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[10px] font-mono truncate ${isActive ? meta.color : 'text-foreground/80'}`}>
                      {node.label || meta.label}
                    </div>
                    <div className="text-[9px] font-mono text-muted-foreground/50 truncate">
                      {node.executedAt ? 'done' : 'pending'}
                    </div>
                  </div>
                  {isActive && <ChevronRight className="w-3 h-3 text-phobos-green/40 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Add node + Delete last node + Generate Final */}
          <div className="shrink-0 border-t border-border/20">
            <div className="flex items-stretch">
              <div className="flex-1">
                {session.workflowType !== 'video' && session.workflowType !== 'audio' && (
                  <AddNodeMenu
                    threadId={session.threadId}
                    workflowId={session.workflowId}
                    onAdded={reloadSession}
                    upstreamNode={nodes.length > 0 ? nodes[nodes.length - 1] : undefined}
                    activeModelId={
                      // Use the last node's model for new node defaults — the new node
                      // chains from the last node, so its defaults should match that model.
                      (nodes.length > 0
                        ? (nodes[nodes.length - 1].params as Record<string, unknown>)?.modelId as string
                        : undefined
                      ) || session.modelId
                    }
                  />
                )}
              </div>
              {nodes.length > 1 && nodes[nodes.length - 1].type !== 'Generate' && nodes[nodes.length - 1].type !== 'Source' && (
                <button
                  onClick={async () => {
                    const last = nodes[nodes.length - 1];
                    if (!last || isGenerating) return;
                    try {
                      await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${last.id}`, { method: 'DELETE' });
                      await reloadSession();
                    } catch { /* silent */ }
                  }}
                  disabled={isGenerating}
                  title={`Delete last node (${nodes[nodes.length - 1]?.type})`}
                  className="px-2 border-l border-border/20 text-destructive/40 hover:text-destructive/80 hover:bg-destructive/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
            <button
              onClick={() => runGenerate(nodes.length - 1, true)}
              disabled={isGenerating}
              className="w-full flex items-center gap-1.5 px-2 py-2 text-[10px] font-terminal tracking-[0.1em] text-phobos-green/80 hover:text-phobos-green hover:bg-phobos-green/8 transition-all disabled:opacity-30 disabled:cursor-not-allowed border-t border-phobos-green/10"
            >
              {isGenerating ? (
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              ) : (
                <CheckSquare className="w-3 h-3 shrink-0" />
              )}
              <span className="truncate">{session.workflowType === 'video' ? 'EXPORT VIDEO' : session.workflowType === 'audio' ? 'GENERATE' : 'FINAL'}</span>
            </button>
          </div>
        </div>

        {/* CENTER: Params */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border/30 relative">
          {/* Generation lockout overlay with phase checklist */}
          {isGenerating && (
            <div className="absolute inset-0 bg-black/70 z-10 flex flex-col items-center justify-center gap-3 px-6">
              <Loader2 className="w-5 h-5 text-phobos-green/50 animate-spin" />
              <span className="text-[11px] font-terminal tracking-[0.15em] text-phobos-green/60 uppercase">
                Generating · Node {(currentProg?.nodeIndex ?? activeNodeIndex) + 1}
              </span>
              {/* Phase checklist */}
              {currentPhases.length > 0 && (
                <div className="flex flex-col gap-1 w-full max-w-xs">
                  {currentPhases.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {p.done ? (
                        <CheckCircle className="w-3 h-3 text-phobos-green/50 shrink-0" />
                      ) : (
                        <Loader2 className="w-3 h-3 text-phobos-green/40 animate-spin shrink-0" />
                      )}
                      <span className={`text-[10px] font-mono truncate ${p.done ? 'text-muted-foreground/40' : 'text-phobos-green/60'}`}>
                        {p.detail || p.renderPhase}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Step progress bar */}
              {currentProg && currentProg.totalSteps > 0 && (
                <div className="w-full max-w-xs flex flex-col gap-1">
                  <div className="w-full h-1 bg-muted/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-phobos-green/50 rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((currentProg.step / currentProg.totalSteps) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-phobos-green/40 text-center">
                    {batchStep ? `Batch ${batchStep.current}/${batchStep.total} · ` : ''}Step {currentProg.step} / {currentProg.totalSteps}
                  </span>
                </div>
              )}
              <button
                onClick={handleAbort}
                className="mt-2 px-3 py-1 text-[9px] font-terminal tracking-[0.1em] border border-destructive/30 text-destructive/50 hover:text-destructive/80 hover:border-destructive/60 rounded-sm transition-all"
              >
                ■ ABORT
              </button>
            </div>
          )}
          {nodeError && !isGenerating && (
            <div className="absolute inset-x-0 top-0 z-10 mx-2 mt-2 flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2">
              <AlertTriangle className="w-3 h-3 text-destructive/70 shrink-0 mt-0.5" />
              <span className="text-[10px] font-mono text-destructive/80 break-all leading-relaxed">{nodeError}</span>
              <button onClick={() => setNodeError(null)} className="ml-auto text-destructive/40 hover:text-destructive/80"><X className="w-3 h-3" /></button>
            </div>
          )}
          {activeNode ? (
            activeNode.type === 'Source' ? (
              /* ── Source node: drop zone instead of params ── */
              <>
                <div className="flex items-center gap-2 px-3 py-1 border-b border-border/20 shrink-0">
                  <span className={`text-[11px] font-terminal tracking-[0.1em] ${NODE_META.Source.color}`}>
                    Source Image
                  </span>
                  {activeNode.outputPath && (
                    <span className="text-[9px] font-mono text-phobos-green/40 ml-auto">Ready</span>
                  )}
                </div>
                <div
                  className="flex-1 flex flex-col items-center justify-center gap-3 px-6 cursor-pointer border-2 border-dashed border-border/20 hover:border-phobos-green/30 m-2 rounded transition-colors"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.png,.jpg,.jpeg,.webp';
                    input.onchange = async () => {
                      const file = input.files?.[0];
                      if (!file || !session) return;
                      const reader = new FileReader();
                      reader.onload = async () => {
                        const base64 = (reader.result as string).split(',')[1];
                        try {
                          await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}/source`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ data: base64, filename: file.name }),
                          });
                          await reloadSession();
                        } catch { /* silent */ }
                      };
                      reader.readAsDataURL(file);
                    };
                    input.click();
                  }}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-phobos-green/50'); }}
                  onDragLeave={(e) => { e.currentTarget.classList.remove('border-phobos-green/50'); }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('border-phobos-green/50');
                    const file = e.dataTransfer.files[0];
                    if (!file || !session) return;
                    const ext = file.name.split('.').pop()?.toLowerCase();
                    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext ?? '')) return;
                    const reader = new FileReader();
                    reader.onload = async () => {
                      const base64 = (reader.result as string).split(',')[1];
                      try {
                        await fetch(`${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}/source`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ data: base64, filename: file.name }),
                        });
                        await reloadSession();
                      } catch { /* silent */ }
                    };
                    reader.readAsDataURL(file);
                  }}
                >
                  <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
                  <span className="text-[11px] font-mono text-muted-foreground/40 text-center">
                    {(activeNode.params as any).sourcePath
                      ? 'Click or drop to replace source image'
                      : 'Click or drop a source image here'}
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground/25">
                    PNG · JPG · WEBP
                  </span>
                </div>
              </>
            ) : (
            /* ── Normal node: params + generate ── */
            <>
              <div className="shrink-0 border-b border-border/20">
                {/* Node label + stale indicator */}
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className={`text-[11px] font-terminal tracking-[0.1em] ${NODE_META[activeNode.type].color}`}>
                    {NODE_META[activeNode.type].label}
                  </span>
                  {activeNode.stale && (
                    <span className="flex items-center gap-1 text-[9px] font-mono text-yellow-500/70">
                      <AlertTriangle className="w-2.5 h-2.5" /> stale
                    </span>
                  )}
                </div>
                {/* Action row: generate + batch + export */}
                <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/10">
                  <button
                    onClick={() => batchEnabled ? runBatch(activeNode.index, batchCount) : runGenerate(activeNode.index)}
                    disabled={isGenerating}
                    className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-terminal tracking-[0.1em] border border-phobos-green/30 text-phobos-green/70 hover:text-phobos-green hover:border-phobos-green/50 rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {isGenerating
                      ? batchStep
                        ? <><Loader2 className="w-3 h-3 animate-spin" /><span className="ml-1">{batchStep.current}/{batchStep.total}</span></>
                        : <Loader2 className="w-3 h-3 animate-spin" />
                      : <Play className="w-3 h-3" />}
                    {!isGenerating && (batchEnabled ? `BATCH ×${batchCount}` : 'GENERATE')}
                  </button>
                  {/* Batch toggle + count — image/video only (audio batch is separate) */}
                  {session.workflowType !== 'audio' && (
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={batchEnabled}
                        onChange={(e) => setBatchEnabled(e.target.checked)}
                        disabled={isGenerating}
                        className="w-3 h-3 accent-phobos-green"
                      />
                      <span className="text-[9px] font-mono text-muted-foreground/50">batch</span>
                    </label>
                  )}
                  {session.workflowType !== 'audio' && batchEnabled && (
                    <input
                      type="number"
                      min={2}
                      max={99}
                      value={batchCount}
                      onChange={(e) => setBatchCount(Math.max(2, parseInt(e.target.value) || 2))}
                      disabled={isGenerating}
                      className="w-14 px-2 py-1 text-[11px] font-mono text-center bg-black/50 border border-phobos-green/20 rounded-sm text-phobos-green/70 focus:outline-none focus:border-phobos-green/50 disabled:opacity-30"
                    />
                  )}
                  {/* Export — image/video only */}
                  {session.workflowType !== 'audio' && activeNode.outputPath && (
                    <button
                      onClick={async () => {
                        if (!session || !activeNode.outputPath) return;
                        try {
                          await fetch(
                            `${ENGINE_URL}/api/threads/${session.threadId}/workflows/${session.workflowId}/nodes/${activeNode.id}/save-batch-output`,
                            { method: 'POST' }
                          );
                        } catch { /* non-fatal */ }
                      }}
                      disabled={isGenerating}
                      className="ml-auto flex items-center gap-1 px-2 py-1 text-[9px] font-terminal tracking-[0.1em] border border-border/30 text-ui-glow hover:text-phobos-green/70 hover:border-phobos-green/30 rounded-sm transition-all disabled:opacity-30"
                      title="Export to images folder"
                    >
                      ↓ EXPORT
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-phobos px-3 py-2">
                {(() => {
                  const isSquareNode = activeNode.type === 'FaceFix' || activeNode.type === 'HandFix';
                  const entries = Object.entries(localParams).filter(([k]) => {
                    if (isSquareNode && k === 'height') return false;
                    if (k === 'plugins') return false;  // handled by PluginSlot
                    return true;
                  }).map(([k, v]) => isSquareNode && k === 'width' ? ['size (square)', v] : [k, v]);
                  if (entries.length === 0) return null;
                  return (
                    <ResponsiveParamGrid
                      params={entries as [string, unknown][]}
                      onChange={(name, value) => {
                        if (isSquareNode && name === 'size (square)') {
                          handleParamChange('width', value);
                          handleParamChange('height', value);
                        } else {
                          handleParamChange(name, value);
                        }
                      }}
                    />
                  );
                })()}
                {PLUGIN_CAPABLE_NODES.has(activeNode.type) && (session.imageBackend === 'pytorch' || session.imageBackend === 'auto' || !session.imageBackend) && (
                  <PluginSlot
                    node={activeNode}
                    session={session}
                    disabled={isGenerating}
                  />
                )}
              </div>
            </>
            )
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-[11px] font-mono text-muted-foreground/40">Select a node</span>
            </div>
          )}
        </div>

        {/* RIGHT: Preview — image for image/video, audio player for audio */}
        <div className="w-56 shrink-0 flex flex-col p-2">
          {session.workflowType === 'audio' ? (
            <AudioOutputPane
              node={activeNode}
              isGenerating={isGenerating}
              threadId={session.threadId}
              workflowId={session.workflowId}
            />
          ) : (
            <PreviewPane
              threadId={session.threadId}
              workflowId={session.workflowId}
              node={activeNode}
              isGenerating={isGenerating && currentProg?.nodeIndex === activeNodeIndex}
              progress={currentProg?.nodeIndex === activeNodeIndex ? currentProg : null}
              previewBase64={preview[workflowId] ?? null}
              revision={revision}
            />
          )}
        </div>
      </div>
    </div>
  );
}