/**
 * CartridgesPanel — AI Carts library and slot management.
 * Opened from SkillCartridge dropdown → "AI Carts".
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Upload, Cpu, AlertTriangle, CheckCircle2,
  Loader2, ChevronRight, BookOpen, Filter, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { CartridgeSlot }    from './CartridgeSlot';
import { CartridgeWizard }  from './CartridgeWizard';
import { LmTrainingPanel }  from './LmTrainingPanel';
import type {
  CartridgeRecord,
  CartridgeCategory,
  CartridgePersona,
  CompatibilityResult,
} from './CartridgeTypes';
import { CATEGORY_LABELS, PERSONA_LABELS } from './CartridgeTypes';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Badges ────────────────────────────────────────────────────────────────────

// API response enriches CartridgeRecord with slot-active flags and parsed arrays.
type CartridgeListItem = Omit<CartridgeRecord, 'compatible_models' | 'tags'> & {
  compatible_models: string[];
  tags:              string[];
  isActiveSayon:     boolean;
  isActiveSeren:     boolean;
  isActive:          boolean;
};

const CATEGORY_COLORS: Record<CartridgeCategory, string> = {
  expertise: 'text-blue-400   border-blue-400/30   bg-blue-400/5',
  persona:   'text-purple-400 border-purple-400/30 bg-purple-400/5',
  style:     'text-teal-400   border-teal-400/30   bg-teal-400/5',
  domain:    'text-orange-400 border-orange-400/30 bg-orange-400/5',
  task:      'text-pink-400   border-pink-400/30   bg-pink-400/5',
  weclone:   'text-indigo-400 border-indigo-400/30 bg-indigo-400/5',
};

function CategoryBadge({ category }: { category: CartridgeCategory }) {
  return (
    <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-sm border ${CATEGORY_COLORS[category]}`}>
      {CATEGORY_LABELS[category]}
    </span>
  );
}

function PersonaBadge({ persona }: { persona: CartridgePersona }) {
  const color = persona === 'sayon'
    ? 'text-phobos-amber/70 border-phobos-amber/20'
    : persona === 'seren'
      ? 'text-phobos-blue/70 border-phobos-blue/20'
      : 'text-phobos-green/50 border-phobos-green/20';
  return (
    <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-sm border ${color}`}>
      {PERSONA_LABELS[persona]}
    </span>
  );
}

function CompatBadge({ result }: { result: CompatibilityResult | null }) {
  if (!result) return null;
  if (result.compatible) {
    return (
      <span className="flex items-center gap-0.5 text-[8px] font-terminal text-phobos-green/60">
        <CheckCircle2 className="w-2.5 h-2.5" /> Compatible
      </span>
    );
  }
  const incompatible = result as Extract<CompatibilityResult, { compatible: false }>;
  const tip = incompatible.reason === 'family_mismatch'
    ? `Family mismatch — active: ${incompatible.activeFamily}`
    : `Model not in allow-list — active: ${incompatible.activeModelId}`;
  return (
    <span className="flex items-center gap-0.5 text-[8px] font-terminal text-red-400/80 cursor-help" title={tip}>
      <AlertTriangle className="w-2.5 h-2.5" /> Incompatible
    </span>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

interface CartridgeCardProps {
  cartridge:     CartridgeListItem;
  targetPersona: 'sayon' | 'seren';
  onActivate:    (id: string) => void;
  onRemove:      (id: string) => void;
  activating:    boolean;
}

function CartridgeCard({ cartridge, targetPersona, onActivate, onRemove, activating }: CartridgeCardProps) {
  const [compat, setCompat] = useState<CompatibilityResult | null>(null);
  const isActive      = targetPersona === 'sayon' ? cartridge.isActiveSayon : cartridge.isActiveSeren;
  const isIncompatible = compat?.compatible === false;

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/cartridges/${cartridge.id}/compatibility/${targetPersona}`)
      .then(r => r.json() as Promise<CompatibilityResult>)
      .then(setCompat)
      .catch(() => setCompat(null));
  }, [cartridge.id, targetPersona]);

  return (
    <div className={`
      border rounded-sm p-3 space-y-2 transition-all
      ${isActive
        ? 'border-phobos-green/40 bg-phobos-green/5 shadow-[0_0_8px_hsl(120_100%_50%/0.06)]'
        : isIncompatible
          ? 'border-red-900/30 bg-red-950/10 opacity-60'
          : 'border-border bg-black/20 hover:border-border/80'}
    `}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-terminal text-foreground leading-tight truncate">{cartridge.name}</p>
          <p className="text-[9px] text-muted-foreground/50 truncate mt-0.5">
            {cartridge.author} · v{cartridge.version}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isActive && (
            <span className="text-[8px] font-terminal text-phobos-green/70 border border-phobos-green/30 px-1.5 py-0.5 rounded-sm">
              ACTIVE
            </span>
          )}
          {!cartridge.is_protected && (
            <span className="text-[8px] font-terminal text-muted-foreground/30 border border-border/20 px-1 py-0.5 rounded-sm" title="No password protection">
              open
            </span>
          )}
        </div>
      </div>

      {cartridge.description && (
        <p className="text-[9px] text-muted-foreground/55 leading-relaxed line-clamp-2">{cartridge.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <CategoryBadge category={cartridge.category} />
        <PersonaBadge  persona={cartridge.target_persona} />
        <span className="text-[8px] font-mono text-muted-foreground/40 border border-border/40 px-1.5 py-0.5 rounded-sm">
          {cartridge.base_model}
        </span>
        <span className="text-[8px] font-mono text-muted-foreground/30">rank {cartridge.rank}</span>
      </div>

      <div className="flex items-center justify-between">
        <CompatBadge result={compat} />
        {cartridge.training_steps > 0 && (
          <span className="text-[8px] font-mono text-muted-foreground/25">
            {cartridge.training_steps.toLocaleString()} steps
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={() => onActivate(cartridge.id)}
          disabled={activating || isActive || isIncompatible}
          className="flex-1 flex items-center justify-center gap-1 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all disabled:opacity-30"
        >
          {activating
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading…</>
            : isActive
              ? <>Active</>
              : <>Load <ChevronRight className="w-3 h-3" /></>
          }
        </button>
        <button
          onClick={() => onRemove(cartridge.id)}
          disabled={activating}
          className="px-2 py-1 text-[9px] text-muted-foreground/30 hover:text-red-400 border border-transparent hover:border-red-900/30 rounded-sm transition-all disabled:opacity-30"
          title="Remove"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface CartridgesPanelProps { onClose: () => void }

export function CartridgesPanel({ onClose }: CartridgesPanelProps) {
  const [cartridges,     setCartridges]     = useState<CartridgeListItem[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [targetPersona,  setTargetPersona]  = useState<'sayon' | 'seren'>('seren');
  const [categoryFilter, setCategoryFilter] = useState<CartridgeCategory | 'all'>('all');
  const [searchQuery,    setSearchQuery]    = useState('');
  const [activatingId,   setActivatingId]   = useState<string | null>(null);
  const [uploading,      setUploading]      = useState(false);
  const [dragOver,       setDragOver]       = useState(false);
  const [slotKey,        setSlotKey]        = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  type ModalView = 'none' | 'wizard' | 'training';
  const [modalView,      setModalView]      = useState<ModalView>('none');
  const [trainSessionId, setTrainSessionId] = useState<string | null>(null);

  const fetchCartridges = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/cartridges`);
      if (res.ok) setCartridges((await res.json() as CartridgeListItem[]).filter(c => c.category !== 'weclone'));
    } catch {
      toast.error('Could not load cartridge library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCartridges(); }, [fetchCartridges]);

  const handleTrainDone   = useCallback((_cartridgeId: string) => {
    fetchCartridges();
    setSlotKey(k => k + 1);
  }, [fetchCartridges]);

  const handleTrainCancel = useCallback(() => {
    setModalView('none');
    setTrainSessionId(null);
  }, []);

  // ── Upload ──────────────────────────────────────────────────────────────

  const installFile = async (file: File) => {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.cartridge') && !name.endsWith('.gguf')) {
      toast.error('Only .cartridge archives and raw .gguf files are supported');
      return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(
        `${ENGINE_URL}/api/cartridges/install?filename=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf },
      );
      const data = await res.json() as CartridgeListItem & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Install failed');
      toast.success(`Installed "${data.name}"`);
      await fetchCartridges();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) installFile(f);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) installFile(f);
  };

  // ── Activate / remove ───────────────────────────────────────────────────

  const handleActivate = async (cartridgeId: string) => {
    setActivatingId(cartridgeId);
    try {
      const res = await fetch(
        `${ENGINE_URL}/api/cartridges/${targetPersona}/activate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cartridgeId }) },
      );
      const data = await res.json() as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error ?? 'Activation failed');
      toast.success(data.message ?? 'Cartridge activating — server restarting…');
      await fetchCartridges();
      setSlotKey(k => k + 1);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActivatingId(null);
    }
  };

  const handleRemove = async (id: string) => {
    const record = cartridges.find(c => c.id === id);
    if (!record) return;
    if (!window.confirm(`Remove "${record.name}"? This will delete the cartridge files.`)) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/cartridges/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Remove failed');
      toast.success(`Removed "${record.name}"`);
      await fetchCartridges();
      setSlotKey(k => k + 1);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // ── Filtering ───────────────────────────────────────────────────────────

  const filtered = cartridges.filter(c => {
    if (categoryFilter !== 'all' && c.category !== categoryFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.base_model.toLowerCase().includes(q) ||
        c.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const categories: CartridgeCategory[] = ['expertise', 'persona', 'style', 'domain', 'task'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="phobos-cartridges-panel w-[800px] max-h-[88vh] flex flex-col bg-background border border-phobos-green/20 rounded-sm shadow-[0_0_40px_hsl(120_100%_50%/0.04)]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-phobos-green/10">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-phobos-green/60" />
            <span className="text-[11px] font-terminal uppercase tracking-[0.2em] text-phobos-green/80">AI Cartridges</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setModalView('wizard')}
              className="flex items-center gap-1.5 px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all"
            >
              <Zap className="w-3 h-3" /> Train
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phobos-green/20 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/40 rounded-sm transition-all disabled:opacity-40"
            >
              {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Install
            </button>
            <input ref={fileRef} type="file" accept=".cartridge,.gguf" className="hidden" onChange={handleFileChange} />
            <button onClick={onClose} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* Active slots */}
          <div className="px-5 py-4 border-b border-phobos-green/10">
            <p className="text-[8px] font-terminal uppercase tracking-[0.2em] text-muted-foreground/35 mb-3">Active Slots</p>
            <div key={slotKey} className="flex gap-3">
              <CartridgeSlot
                persona="sayon"
                onSwapRequest={() => setTargetPersona('sayon')}
                onChanged={() => { fetchCartridges(); setSlotKey(k => k + 1); }}
              />
              <CartridgeSlot
                persona="seren"
                onSwapRequest={() => setTargetPersona('seren')}
                onChanged={() => { fetchCartridges(); setSlotKey(k => k + 1); }}
              />
            </div>
          </div>

          {/* Library */}
          <div className="px-5 py-4">
            {/* Filters */}
            <div className="flex items-center gap-3 mb-4">
              {/* Persona selector (sets activate target) */}
              <div className="flex items-center border border-border/50 rounded-sm overflow-hidden text-[9px] font-terminal uppercase tracking-[0.15em]">
                {(['sayon', 'seren'] as const).map((p, i) => (
                  <button
                    key={p}
                    onClick={() => setTargetPersona(p)}
                    className={`px-3 py-1 transition-colors ${i === 0 ? 'border-r border-border/50' : ''} ${
                      targetPersona === p
                        ? p === 'sayon' ? 'bg-phobos-amber/10 text-phobos-amber' : 'bg-phobos-blue/10 text-phobos-blue'
                        : 'text-muted-foreground/50 hover:text-muted-foreground'
                    }`}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                <Filter className="w-3 h-3 text-muted-foreground/30" />
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value as CartridgeCategory | 'all')}
                  className="bg-transparent text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 border border-border/40 rounded-sm px-2 py-0.5 focus:outline-none"
                >
                  <option value="all">All</option>
                  {categories.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
              </div>

              <input
                type="text"
                placeholder="Search…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-[10px] font-terminal border border-border/40 rounded-sm px-2 py-1 text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:border-phobos-green/30"
              />
            </div>

            {/* Drop zone + grid */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`min-h-[200px] rounded-sm transition-colors ${dragOver ? 'bg-phobos-green/5 border border-dashed border-phobos-green/40' : ''}`}
            >
              {loading ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/30" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-3">
                  <BookOpen className="w-8 h-8 text-muted-foreground/15" />
                  <div className="text-center">
                    <p className="text-[10px] font-terminal text-muted-foreground/35 uppercase tracking-wider">
                      {cartridges.length === 0 ? 'No AI cartridges installed' : 'No matching cartridges'}
                    </p>
                    {cartridges.length === 0 && (
                      <p className="text-[9px] text-muted-foreground/25 mt-1">
                        Drop a .cartridge file or click Install
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {filtered.map(c => (
                    <CartridgeCard
                      key={c.id}
                      cartridge={c}
                      targetPersona={targetPersona}
                      onActivate={handleActivate}
                      onRemove={handleRemove}
                      activating={activatingId === c.id}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Wizard + training panel modals */}
        {modalView === 'wizard' && (
          <CartridgeWizard
            onClose={() => setModalView('none')}
            onStart={(sessionId) => {
              setTrainSessionId(sessionId);
              setModalView('training');
            }}
          />
        )}
        {modalView === 'training' && trainSessionId && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-[560px] h-[640px] flex flex-col bg-background border border-phobos-green/20 rounded-sm shadow-[0_0_60px_hsl(120_100%_50%/0.05)]">
    <LmTrainingPanel
                sessionId={trainSessionId}
                onCancel={handleTrainCancel}
                onDone={handleTrainDone}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-2 border-t border-phobos-green/10 flex items-center justify-between">
          <p className="text-[8px] font-terminal text-muted-foreground/25 uppercase tracking-widest">
            {cartridges.length} cartridge{cartridges.length !== 1 ? 's' : ''} installed
          </p>
          <p className="text-[8px] font-terminal text-muted-foreground/25 uppercase tracking-widest">
            Server restart required on slot change · 15–45s
          </p>
        </div>
      </div>
    </div>
  );
}
