import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Upload, Download, Plus, ToggleLeft, ToggleRight, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { UserSkillRecord } from './SkillTypes';
import { createEmptySkill } from './SkillTypes';
import { SkillConfigPanel } from './SkillConfigPanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface SkillsMenuProps {
  onClose: () => void;
}

// ── Scope badge ───────────────────────────────────────────────────────────────

function ScopeBadge({ scope }: { scope: 'sayon' | 'seren' | 'both' }) {
  if (scope === 'both') {
    return (
      <span className="flex items-center gap-0.5">
        <span className="text-[7px] font-terminal px-1 py-0.5 rounded-sm border border-sayon-tint/30 text-sayon-tint/70 bg-sayon-tint/5">S</span>
        <span className="text-[7px] font-terminal px-1 py-0.5 rounded-sm border border-seren-tint/30 text-seren-tint/70 bg-seren-tint/5">E</span>
      </span>
    );
  }
  if (scope === 'sayon') {
    return <span className="text-[7px] font-terminal px-1.5 py-0.5 rounded-sm border border-sayon-tint/30 text-sayon-tint/70 bg-sayon-tint/5">SAYON</span>;
  }
  return <span className="text-[7px] font-terminal px-1.5 py-0.5 rounded-sm border border-seren-tint/30 text-seren-tint/70 bg-seren-tint/5">SEREN</span>;
}

// ── Skill card in the left rack ───────────────────────────────────────────────

function SkillCard({
  skill,
  selected,
  onSelect,
  onToggle,
}: {
  skill:    UserSkillRecord;
  selected: boolean;
  onSelect: () => void;
  onToggle: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left skill-slot-filled group ${
        selected ? 'ring-1 ring-phobos-green/40' : ''
      } ${!skill.enabled ? 'opacity-40' : ''}`}
    >
      <div className="skill-slot-tape">
        <span className="skill-slot-marker-text truncate flex-1">{skill.name || 'Unnamed'}</span>
        <span
          onClick={onToggle}
          role="button"
          title={skill.enabled ? 'Disable' : 'Enable'}
          className="shrink-0 ml-1 text-muted-foreground/30 hover:text-phobos-green/60 transition-colors"
        >
          {skill.enabled
            ? <ToggleRight className="w-3 h-3" />
            : <ToggleLeft  className="w-3 h-3" />
          }
        </span>
      </div>
      <div className="px-2 pb-1 flex items-center justify-between gap-1">
        <ScopeBadge scope={skill.scope} />
        {skill.deps.length > 0 && (
          <span className="text-[8px] font-mono text-muted-foreground/30">{skill.deps.length} dep{skill.deps.length !== 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="skill-slot-pins" />
    </button>
  );
}

// ── Drop zone for zip import ──────────────────────────────────────────────────

function ImportDropZone({ onFilesDropped }: { onFilesDropped: (files: FileList) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) onFilesDropped(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`border border-dashed rounded-sm px-2 py-2.5 text-center cursor-pointer transition-all ${
        dragging
          ? 'border-phobos-green/50 bg-phobos-green/5'
          : 'border-border/30 hover:border-phobos-green/30 hover:bg-phobos-green/[0.02]'
      }`}
    >
      <Upload className="w-3.5 h-3.5 text-muted-foreground/30 mx-auto mb-0.5" />
      <p className="text-[9px] font-mono text-muted-foreground/40 leading-snug">
        Drop to import<br />.zip · SKILL.md
      </p>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple
        accept=".zip,.md"
        onChange={e => e.target.files && onFilesDropped(e.target.files)}
      />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function SkillsMenu({ onClose }: SkillsMenuProps) {
  const [skills,      setSkills]      = useState<UserSkillRecord[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [importing,   setImporting]   = useState(false);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<UserSkillRecord | null>(null);
  const [isNew,       setIsNew]       = useState(false);

  const selected = skills.find(s => s.id === selectedId) ?? null;

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/user-skills`);
      const data = res.ok ? await res.json() : [];
      setSkills(Array.isArray(data) ? data : []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  // ── Select / New ───────────────────────────────────────────────────────────

  const handleSelect = (id: string) => {
    const sk = skills.find(s => s.id === id);
    if (!sk) return;
    setSelectedId(id);
    setEditingSkill({ ...sk });
    setIsNew(false);
  };

  const handleNew = () => {
    setSelectedId(null);
    setEditingSkill(createEmptySkill());
    setIsNew(true);
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async (skill: UserSkillRecord) => {
    try {
      if (isNew) {
        const res = await fetch(`${ENGINE_URL}/api/user-skills`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(skill),
        });
        if (!res.ok) {
          const err = await res.json() as { error: string };
          toast.error(err.error);
          return;
        }
        const saved = await res.json() as UserSkillRecord;
        setSkills(prev => [...prev, saved]);
        setSelectedId(saved.id);
        setEditingSkill(saved);
        setIsNew(false);
        toast.success('Skill created');
      } else {
        const res = await fetch(`${ENGINE_URL}/api/user-skills/${encodeURIComponent(skill.id)}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(skill),
        });
        if (!res.ok) {
          const err = await res.json() as { error: string };
          toast.error(err.error);
          return;
        }
        const saved = await res.json() as UserSkillRecord;
        setSkills(prev => prev.map(s => s.id === saved.id ? saved : s));
        setEditingSkill(saved);
        toast.success('Skill saved');
      }
    } catch {
      toast.error('Backend unreachable');
    }
  };

  // ── Toggle ─────────────────────────────────────────────────────────────────

  const handleToggle = async (e: React.MouseEvent, skillId: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(`${ENGINE_URL}/api/user-skills/${encodeURIComponent(skillId)}/toggle`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const updated = await res.json() as UserSkillRecord;
        setSkills(prev => prev.map(s => s.id === updated.id ? updated : s));
        // Keep editing panel in sync if this is the selected skill
        if (editingSkill?.id === updated.id) setEditingSkill(updated);
      }
    } catch { /* silent */ }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!selectedId) return;
    const name = skills.find(s => s.id === selectedId)?.name ?? selectedId;
    if (!window.confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    try {
      await fetch(`${ENGINE_URL}/api/user-skills/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
      setSkills(prev => prev.filter(s => s.id !== selectedId));
      setSelectedId(null);
      setEditingSkill(null);
      toast.success('Skill deleted');
    } catch {
      toast.error('Delete failed');
    }
  };

  // ── Import zip / SKILL.md ─────────────────────────────────────────────────

  const handleImport = async (files: FileList) => {
    setImporting(true);
    let imported = 0;

    try {
      for (const file of Array.from(files)) {
        // Raw SKILL.md — wrap it into a minimal in-memory zip on the backend
        // by posting directly to import endpoint; backend handles it too
        const isZip = file.name.endsWith('.zip');
        const isMd  = file.name.endsWith('.md');

        if (!isZip && !isMd) {
          toast.error(`${file.name}: must be .zip or .md`);
          continue;
        }

        // For bare .md files, POST the raw content — the backend's import
        // path will still hit /import; we'll send it as a zip-wrapped version
        // by using a client-side AdmZip stub — but since we can't run AdmZip
        // in the browser, we POST the file with ?isMd=1 to let the backend
        // handle it directly as a SKILL.md-only import.
        const url = isZip
          ? `${ENGINE_URL}/api/user-skills/import`
          : `${ENGINE_URL}/api/user-skills/import?isMd=1&filename=${encodeURIComponent(file.name)}`;

        try {
          const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body:    file,
          });
          if (res.ok) {
            const sk = await res.json() as UserSkillRecord;
            setSkills(prev => {
              const exists = prev.find(s => s.id === sk.id);
              return exists ? prev.map(s => s.id === sk.id ? sk : s) : [...prev, sk];
            });
            imported++;
          } else {
            const err = await res.json() as { error: string };
            toast.error(`${file.name}: ${err.error}`);
          }
        } catch {
          toast.error(`${file.name}: network error`);
        }
      }

      if (imported > 0) {
        toast.success(`Imported ${imported} skill${imported > 1 ? 's' : ''}`);
      }
    } finally {
      setImporting(false);
    }
  };

  // ── Export ─────────────────────────────────────────────────────────────────

  const handleExport = async (skillId: string) => {
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/user-skills/${encodeURIComponent(skillId)}/export`);
      if (!res.ok) { toast.error('Export failed'); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${skillId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed');
    }
  };

  // ── Empty slots ────────────────────────────────────────────────────────────

  const emptySlots = Math.max(0, 6 - skills.length);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="phobos-skills-panel w-[960px] max-w-[95vw] h-[640px] max-h-[88vh] bg-card border border-border rounded-sm flex flex-col overflow-hidden shadow-2xl">

        {/* Top bar */}
        <div className="h-10 flex items-center justify-between px-3 border-b border-border/50 bg-background shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-terminal uppercase tracking-[0.15em] text-phobos-green/70">
              Skill Rack
            </span>
            {skills.length > 0 && (
              <span className="text-[9px] font-mono text-muted-foreground/30">
                {skills.filter(s => s.enabled).length}/{skills.length} active
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {importing && <Loader2 className="w-3 h-3 text-phobos-green/40 animate-spin" />}
            <button onClick={onClose} className="p-1 hover:bg-accent rounded transition-colors">
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">

          {/* ── Left column: rack ─────────────────────────────────── */}
          <div className="w-56 border-r border-border flex flex-col bg-background shrink-0">

            {/* Import drop zone */}
            <div className="p-2 border-b border-border/30 shrink-0">
              <ImportDropZone onFilesDropped={handleImport} />
            </div>

            {/* Skill list */}
            <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1.5">
              {loading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-4 h-4 text-phobos-green/40 animate-spin" />
                </div>
              )}

              {!loading && skills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  selected={skill.id === selectedId}
                  onSelect={() => handleSelect(skill.id)}
                  onToggle={e => handleToggle(e, skill.id)}
                />
              ))}

              {/* Empty slots */}
              {!loading && Array.from({ length: emptySlots }).map((_, i) => (
                <button
                  key={`empty-${i}`}
                  onClick={i === 0 ? handleNew : undefined}
                  className={`w-full skill-slot-empty ${
                    i === 0
                      ? 'cursor-pointer hover:border-phobos-green/30'
                      : 'opacity-30 cursor-default'
                  }`}
                >
                  {i === 0 && (
                    <span className="text-[9px] font-terminal uppercase tracking-[0.15em] text-phobos-green/50">
                      + NEW
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Footer actions */}
            <div className="p-2 border-t border-border/30 space-y-1.5 shrink-0">
              <button
                onClick={handleNew}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[9px] font-terminal uppercase tracking-widest text-phobos-green/60 border border-phobos-green/20 rounded-sm hover:text-phobos-green hover:border-phobos-green/40 hover:shadow-[0_0_8px_hsl(120_100%_50%/0.08)] transition-all"
              >
                <Plus className="w-3 h-3" /> New Skill
              </button>

              {selectedId && (
                <button
                  onClick={() => handleExport(selectedId)}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[9px] font-terminal uppercase tracking-widest text-muted-foreground/50 border border-border/30 rounded-sm hover:text-muted-foreground hover:border-border/60 transition-all"
                >
                  <Download className="w-3 h-3" /> Export .zip
                </button>
              )}
            </div>
          </div>

          {/* ── Right column: config ───────────────────────────────── */}
          <div className="flex-1 flex flex-col min-h-0">
            {editingSkill ? (
              <SkillConfigPanel
                skill={editingSkill}
                onChange={setEditingSkill}
                onSave={handleSave}
                onDelete={!isNew ? handleDelete : undefined}
              />
            ) : (
              <EmptyState hasSkills={skills.length > 0} onNew={handleNew} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ hasSkills, onNew }: { hasSkills: boolean; onNew: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="text-3xl font-terminal text-muted-foreground/10">⬡</div>
        <p className="text-xs font-mono text-muted-foreground/30">
          {hasSkills ? 'Select a skill to edit it' : 'No skills yet'}
        </p>
        {!hasSkills && (
          <div className="space-y-1.5 text-[10px] font-mono text-muted-foreground/25 max-w-[220px] mx-auto leading-relaxed">
            <p>Create a skill manually, or drop a .zip or SKILL.md to import.</p>
            <div className="flex items-start gap-1.5 text-left">
              <AlertTriangle className="w-3 h-3 text-amber-400/30 shrink-0 mt-0.5" />
              <p>Skills are stored in ~/.phobos/user/skills/ and travel with you between machines.</p>
            </div>
          </div>
        )}
        <button
          onClick={onNew}
          className="mt-2 flex items-center gap-1.5 mx-auto px-4 py-1.5 text-[9px] font-terminal uppercase tracking-widest text-phobos-green/50 border border-phobos-green/20 rounded-sm hover:text-phobos-green hover:border-phobos-green/40 transition-all"
        >
          <Plus className="w-3 h-3" /> New Skill
        </button>
      </div>
    </div>
  );
}
