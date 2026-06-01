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
import { useAppStore }       from '@/store/useAppStore';
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
  expertise: 'text-phob-teal   border-phob-teal/30   bg-phob-teal/5',
  persona:   'text-phob-teal border-phob-teal/30 bg-phob-teal/5',
  style:     'text-sayon   border-sayon/30   bg-sayon/5',
  domain:    'text-phob-amber border-phob-amber/30 bg-phob-amber/5',
  task:      'text-phob-amber border-phob-amber/30 bg-phob-amber/5',
  weclone:   'text-seren border-seren/30 bg-seren/5',
};

function CategoryBadge({ category }: { category: CartridgeCategory }) {
  return (
    <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5  border ${CATEGORY_COLORS[category]}`}>
      {CATEGORY_LABELS[category]}
    </span>
  );
}

function PersonaBadge({ persona }: { persona: CartridgePersona }) {
  const color = persona === 'sayon'
    ? 'text-phob-amber/70 border-phob-amber/20'
    : persona === 'seren'
      ? 'text-phob-teal/70 border-phob-teal/20'
      : 'text-phob-green/50 border-phob-green/20';
  return (
    <span className={`text-[8px] font-terminal uppercase tracking-[0.1em] px-1.5 py-0.5  border ${color}`}>
      {PERSONA_LABELS[persona]}
    </span>
  );
}

function CompatBadge({ result }: { result: CompatibilityResult | null }) {
  if (!result) return null;
  if (result.compatible) {
    return (
      <span className="flex items-center gap-0.5 text-[8px] font-terminal text-phob-amber/60">
        <CheckCircle2 className="w-2.5 h-2.5" /> Compatible
      </span>
    );
  }
  const incompatible = result as Extract<CompatibilityResult, { compatible: false }>;
  const tip = incompatible.reason === 'family_mismatch'
    ? `Family mismatch — active: ${incompatible.activeFamily}`
    : `Model not in allow-list — active: ${incompatible.activeModelId}`;
  return (
    <span className="flex items-center gap-0.5 text-[8px] font-terminal text-phob-red/70 cursor-help" title={tip}>
      <AlertTriangle className="w-2.5 h-2.5" /> Incompatible
    </span>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

interface CartridgeCardProps {
  cartridge:     CartridgeListItem;
  targetPersona: 'sayon' | 'seren';
  currentUser:   string;
  onActivate:    (id: string) => void;
  onRemove:      (id: string) => void;
  activating:    boolean;
}

function CartridgeCard({ cartridge, targetPersona, currentUser, onActivate, onRemove, activating }: CartridgeCardProps) {
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
      border  p-3 space-y-2 transition-all
      ${isActive
        ? 'border-phob-green/40 bg-phob-green/5 shadow-[0_0_8px_hsl(120_100%_50%/0.06)]'
        : isIncompatible
          ? 'border-phob-red/20 bg-phob-red/5 opacity-60'
          : 'border-phob-orange/15 bg-phob-white/3 hover:border-phob-orange/30'}
    `}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-terminal text-foreground leading-tight truncate">{cartridge.name}</p>
          <p className="text-[9px] text-phob-steel/45 truncate mt-0.5">
            {cartridge.author} · v{cartridge.version}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isActive && (
            <span className="text-[8px] font-terminal text-phob-green/70 border border-phob-green/30 px-1.5 py-0.5 ">
              ACTIVE
            </span>
          )}
          {!cartridge.is_protected && (
            <span className="text-[8px] font-terminal text-phob-steel/35 border border-phob-amber/15 px-1 py-0.5 " title="No password protection">
              open
            </span>
          )}
        </div>
      </div>

      {cartridge.description && (
        <p className="text-[9px] text-phob-steel/50 leading-relaxed line-clamp-2">{cartridge.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <CategoryBadge category={cartridge.category} />
        <PersonaBadge  persona={cartridge.target_persona} />
        <span className="text-[8px] font-mono text-phob-steel/40 border border-phob-orange/20 px-1.5 py-0.5 ">
          {cartridge.base_model}
        </span>
        <span className="text-[8px] font-mono text-phob-steel/35">rank {cartridge.rank}</span>
      </div>

      <div className="flex items-center justify-between">
        <CompatBadge result={compat} />
        {cartridge.training_steps > 0 && (
          <span className="text-[8px] font-mono text-phob-steel/25">
            {cartridge.training_steps.toLocaleString()} steps
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={() => onActivate(cartridge.id)}
          disabled={activating || isActive || isIncompatible}
          className="flex-1 flex items-center justify-center gap-1 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phob-green/20 text-phob-amber/60 hover:text-phob-green hover:border-phob-green/40  transition-all disabled:opacity-30"
        >
          {activating
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading…</>
            : isActive
              ? <>Active</>
              : <>Load <ChevronRight className="w-3 h-3" /></>
          }
        </button>
        {cartridge.owner_username && cartridge.owner_username !== currentUser ? (
          <span className="px-2 py-1 text-[8px] font-mono text-phob-steel/25" title={`Owned by ${cartridge.owner_username}`}>
            {cartridge.owner_username}
          </span>
        ) : (
          <button
            onClick={() => onRemove(cartridge.id)}
            disabled={activating}
            className="px-2 py-1 text-[9px] text-phob-steel/35 hover:text-phob-red border border-transparent hover:border-phob-red/20 transition-all disabled:opacity-30"
            title="Remove"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface CartridgesPanelProps { onClose: () => void }

export function CartridgesPanel({ onClose }: CartridgesPanelProps) {
  const currentUser      = useAppStore(s => s.activeUser);
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
      if (res.status === 403) {
        const data = await res.json() as { error: string };
        toast.error(data.error ?? 'You do not own this cartridge — only the owner can remove it.');
        return;
      }
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? 'Remove failed');
        return;
      }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-phob-white/6 backdrop-blur-sm">
      <div className="phobos-cartridges-panel phob-corners phob-corners-full w-[800px] max-h-[88vh] flex flex-col bg-[#0f0f0a] border border-phob-amber/30 shadow-[0_0_24px_rgba(200,160,0,0.08)]">

        {/* Header */}
        <div className="phob-chrome-zone phob-header flex items-center justify-between px-5 py-3 border-b border-phob-amber/15 bg-background">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-phob-amber/60" />
            <span className="text-[11px] font-terminal uppercase tracking-[0.2em] text-phob-green/80">AI Cartridges</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setModalView('wizard')}
              className="flex items-center gap-1.5 px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phob-green/20 text-phob-amber/60 hover:text-phob-green hover:border-phob-green/40  transition-all"
            >
              <Zap className="w-3 h-3" /> Train
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 px-3 py-1 text-[9px] font-terminal uppercase tracking-[0.15em] border border-phob-green/20 text-phob-amber/60 hover:text-phob-green hover:border-phob-green/40  transition-all disabled:opacity-40"
            >
              {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Install
            </button>
            <input ref={fileRef} type="file" accept=".cartridge,.gguf" className="hidden" onChange={handleFileChange} />
            <button onClick={onClose} className="text-phob-steel/40 hover:text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* Active slots */}
          <div className="px-5 py-4 border-b border-phob-amber/15">
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
              <div className="flex items-center border border-border/50  overflow-hidden text-[9px] font-terminal uppercase tracking-[0.15em]">
                {(['sayon', 'seren'] as const).map((p, i) => (
                  <button
                    key={p}
                    onClick={() => setTargetPersona(p)}
                    className={`px-3 py-1 transition-colors ${i === 0 ? 'border-r border-border/50' : ''} ${
                      targetPersona === p
                        ? p === 'sayon' ? 'bg-phob-amber/10 text-phob-amber' : 'bg-phob-teal/10 text-phob-teal'
                        : 'text-phob-steel/45 hover:text-muted-foreground'
                    }`}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                <Filter className="w-3 h-3 text-phob-steel/35" />
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value as CartridgeCategory | 'all')}
                  className="bg-transparent text-[9px] font-terminal uppercase tracking-widest text-phob-steel/45 border border-border/40  px-2 py-0.5 focus:outline-none"
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
                className="flex-1 bg-transparent text-[10px] font-terminal border border-border/40  px-2 py-1 text-foreground placeholder:text-phob-steel/35 focus:outline-none focus:border-phob-green/30"
              />
            </div>

            {/* Drop zone + grid */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`min-h-[200px]  transition-colors ${dragOver ? 'bg-phob-green/5 border border-dashed border-phob-green/40' : ''}`}
            >
              {loading ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-5 h-5 animate-spin text-phob-steel/35" />
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
                      currentUser={currentUser}
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
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-phob-void/80 backdrop-blur-sm">
            <div className="w-[560px] h-[640px] flex flex-col bg-card border border-phob-green/20  shadow-[0_0_60px_hsl(120_100%_50%/0.05)]">
    <LmTrainingPanel
                sessionId={trainSessionId}
                onCancel={handleTrainCancel}
                onDone={handleTrainDone}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-2 border-t border-phob-green/10 flex items-center justify-between">
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