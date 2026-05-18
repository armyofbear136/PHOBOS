import { useMemo, useState, useEffect, useRef } from 'react';
import { Plus, ChevronRight, GitBranch, FolderOpen, Trash2, X, CalendarClock, Shield, Music2, BookMarked, Film, Camera } from 'lucide-react';
import { useAppStore, type Message, type ProjectDoc, type Thread } from '@/store/useAppStore';
import { usePolarisPlaybackStore } from '@/store/usePolarisPlaybackStore';
import { FileEditorWindow } from '@/components/chat/FileEditorWindow';
import { PolarisPlayerDock } from '@/components/media/PolarisPlayerDock';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const uid = () => Math.random().toString(36).slice(2, 9);

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'just now';
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return 'just now';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function lastMessagePreview(messages: Message[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'status' && !m.activityEvents && m.content.trim()) {
      return m.content.slice(0, 80).replace(/\n/g, ' ');
    }
  }
  return null;
}

// ── SidebarIconGrid — 2x2 tool/media shortcut cluster ────────────────────────

function SidebarIconGrid() {
  const setSchedulerOpen    = useAppStore((s) => s.setSchedulerOpen);
  const setSecurityOpen     = useAppStore((s) => s.setSecurityOpen);
  const togglePolarisPlayer  = useAppStore((s) => s.togglePolarisPlayer);
  const toggleKavitaBrowser  = useAppStore((s) => s.toggleKavitaBrowser);
  const toggleJellyfinBrowser = useAppStore((s) => s.toggleJellyfinBrowser);
  const toggleMeridianBrowser = useAppStore((s) => s.toggleMeridianBrowser);
  const polarisPlayerOpen   = usePolarisPlaybackStore((s) => s.view === 'floating');
  const kavitaBrowserOpen    = useAppStore((s) => s.kavitaBrowserOpen);
  const jellyfinBrowserOpen  = useAppStore((s) => s.jellyfinBrowserOpen);
  const meridianBrowserOpen  = useAppStore((s) => s.meridianBrowserOpen);

  return (
    <div className="px-2 py-1.5 border-b border-border/30">
      <div className="grid grid-cols-2 gap-1">
        {/* Row 1 — Tools */}
        <button
          onClick={() => setSchedulerOpen(true)}
          title="Scheduler"
          className="flex items-center gap-1.5 px-2 py-1 rounded-sm border border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green transition-all text-[9px] font-terminal uppercase tracking-widest"
        >
          <CalendarClock className="w-3 h-3 shrink-0" />
          <span>Schedule</span>
        </button>
        <button
          onClick={() => setSecurityOpen(true)}
          title="Security"
          className="flex items-center gap-1.5 px-2 py-1 rounded-sm border border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green transition-all text-[9px] font-terminal uppercase tracking-widest"
        >
          <Shield className="w-3 h-3 shrink-0" />
          <span>Security</span>
        </button>
        {/* Row 2 — Media */}
        <button
          onClick={togglePolarisPlayer}
          title="Music Player"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border transition-all text-[9px] font-terminal uppercase tracking-widest ${
            polarisPlayerOpen
              ? 'border-amber-500/30 text-amber-500/70'
              : 'border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green'
          }`}
        >
          <Music2 className="w-3 h-3 shrink-0" />
          <span>Music</span>
        </button>
        <button
          onClick={toggleKavitaBrowser}
          title="Reading Library"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border transition-all text-[9px] font-terminal uppercase tracking-widest ${
            kavitaBrowserOpen
              ? 'border-cyan-500/30 text-cyan-400/70'
              : 'border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green'
          }`}
        >
          <BookMarked className="w-3 h-3 shrink-0" />
          <span>Library</span>
        </button>
        {/* Row 3 — Video & Photos */}
        <button
          onClick={toggleJellyfinBrowser}
          title="Video Library"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border transition-all text-[9px] font-terminal uppercase tracking-widest ${
            jellyfinBrowserOpen
              ? 'border-blue-500/30 text-blue-400/70'
              : 'border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green'
          }`}
        >
          <Film className="w-3 h-3 shrink-0" />
          <span>Videos</span>
        </button>
        <button
          onClick={toggleMeridianBrowser}
          title="Photo Library"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border transition-all text-[9px] font-terminal uppercase tracking-widest ${
            meridianBrowserOpen
              ? 'border-teal-500/30 text-teal-400/70'
              : 'border-transparent hover:border-phobos-green/20 text-muted-foreground/40 hover:text-phobos-green'
          }`}
        >
          <Camera className="w-3 h-3 shrink-0" />
          <span>Photos</span>
        </button>
      </div>
    </div>
  );
}


export function Sidebar() {
  const { threads, activeThreadId, setActiveThread, sidebarOpen, addThread, deleteThread } = useAppStore();
  const allMessages = useAppStore((s) => s.messages);
  const projectDocs = useAppStore((s) => s.projectDocs);
  const addProjectDoc = useAppStore((s) => s.addProjectDoc);
  const updateProjectDoc = useAppStore((s) => s.updateProjectDoc);
  const deleteProjectDoc = useAppStore((s) => s.deleteProjectDoc);
  const setProjectDocs = useAppStore((s) => s.setProjectDocs);
  const updateThreadTitle = useAppStore((s) => s.updateThreadTitle);
  const backendAlive = useAppStore((s) => s.backendAlive);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [editingProjectDoc, setEditingProjectDoc] = useState<ProjectDoc | null>(null);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Load projects from backend on mount
  useEffect(() => {
    if (!backendAlive) return;
    fetch(`${ENGINE_URL}/api/projects`)
      .then((r) => r.json())
      .then((projects: Array<{ id: string; name: string }>) => {
        const docs = projects.map((p) => ({
          id: uid(),
          projectId: p.id,
          name: p.name,
          content: '',
        }));
        setProjectDocs(docs);
      })
      .catch(() => { /* silent */ });
  }, [backendAlive, setProjectDocs]);

  const searchLower = search.toLowerCase();
  const matchThread = (t: Thread) => !search || t.title.toLowerCase().includes(searchLower);

  const { ungrouped, grouped } = useMemo(() => {
    const ug: Thread[] = [];
    const gMap: Record<string, Thread[]> = {};
    threads.forEach((t) => {
      if (!matchThread(t)) return;
      if (!t.projectName) {
        ug.push(t);
      } else {
        const projectExists = projectDocs.some((p) => p.projectId === t.projectName);
        if (projectExists) {
          if (!gMap[t.projectName!]) gMap[t.projectName!] = [];
          gMap[t.projectName!].push(t);
        } else {
          ug.push(t);
        }
      }
    });
    return { ungrouped: ug, grouped: gMap };
  }, [threads, projectDocs, search]);

  // Date-bucket labels and ordering for ungrouped threads
  const DATE_BUCKETS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'] as const;
  type DateBucket = typeof DATE_BUCKETS[number];

  function getDateBucket(iso: string): DateBucket {
    const now = new Date();
    const d = new Date(iso);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    const startOfWeek = new Date(startOfToday.getTime() - (now.getDay() || 7) * 86400000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    if (d >= startOfToday) return 'Today';
    if (d >= startOfYesterday) return 'Yesterday';
    if (d >= startOfWeek) return 'This Week';
    if (d >= startOfMonth) return 'This Month';
    return 'Older';
  }

  const dateBuckets = useMemo(() => {
    const map: Partial<Record<DateBucket, Thread[]>> = {};
    ungrouped.forEach((t) => {
      const bucket = getDateBucket(t.createdAt);
      if (!map[bucket]) map[bucket] = [];
      map[bucket]!.push(t);
    });
    return map;
  }, [ungrouped]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('phobos_sidebar_collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  const toggle = (key: string) => setCollapsed((c) => {
    const next = { ...c, [key]: !c[key] };
    try { localStorage.setItem('phobos_sidebar_collapsed', JSON.stringify(next)); } catch {}
    return next;
  });

  // Listen for keyboard shortcut events
  useEffect(() => {
    const onNewChat = () => handleNew();
    const onFocusSearch = () => searchInputRef.current?.focus();
    document.addEventListener('phobos:new-chat', onNewChat);
    document.addEventListener('phobos:focus-search', onFocusSearch);
    return () => {
      document.removeEventListener('phobos:new-chat', onNewChat);
      document.removeEventListener('phobos:focus-search', onFocusSearch);
    };
  }, []);

  const handleNew = async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New conversation' }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const thread = await res.json();
      addThread(thread);
    } catch {
      const id = 't' + Math.random().toString(36).slice(2, 7);
      addThread({
        id,
        title: 'New conversation',
        projectName: null,
        createdAt: new Date().toISOString(),
      });
    }
  };

  const handleDelete = async (threadId: string) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${threadId}`, { method: 'DELETE' });
      if (!res.ok) { setDeletingId(null); return; }
    } catch { setDeletingId(null); return; }

    // Compute the next thread to select before removing the deleted one.
    // Build the same flat ordered list the sidebar renders:
    //   - project threads are sorted by createdAt DESC within their project
    //   - ungrouped threads are sorted by createdAt DESC
    // If the deleted thread is active, select the next item in the same context.
    if (activeThreadId === threadId) {
      const deleted = threads.find((t) => t.id === threadId);
      const projectId = deleted?.projectName ?? null;

      // Get the ordered list of candidates in the same context
      const candidates = threads
        .filter((t) => t.id !== threadId && t.projectName === projectId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      if (candidates.length > 0) {
        // candidates is sorted newest-first (index 0 = top of list).
        // Find the deleted item's position in that order, then pick:
        //   - the item at the same index (what shifts up to fill the slot), i.e. the next older one
        //   - if deleted was the oldest (last), pick the one above it instead
        const deletedTime = deleted ? new Date(deleted.createdAt).getTime() : 0;
        const olderThan = candidates.filter((t) => new Date(t.createdAt).getTime() < deletedTime);
        const next = olderThan[0] ?? candidates[candidates.length - 1];
        setActiveThread(next.id);
      } else if (projectId) {
        // Last thread in project deleted — fall back to most recent ungrouped thread
        const ungroupedFallback = threads
          .filter((t) => t.id !== threadId && !t.projectName)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (ungroupedFallback) setActiveThread(ungroupedFallback.id);
        else setActiveThread('');
      } else {
        setActiveThread('');
      }
    }

    deleteThread(threadId);
    setDeletingId(null);
  };

  const handleNewProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const project = await res.json();
      const doc: ProjectDoc = { id: uid(), projectId: project.id, name: project.name, content: '' };
      addProjectDoc(doc);
      setNewProjectName('');
      setShowNewProject(false);
      openProjectEditor(doc);
    } catch {
      const doc: ProjectDoc = { id: uid(), projectId: uid(), name, content: `# ${name}\n\n` };
      addProjectDoc(doc);
      setNewProjectName('');
      setShowNewProject(false);
      setEditingProjectDoc(doc);
    }
  };

  const openProjectEditor = async (doc: ProjectDoc) => {
    try {
      const res = await fetch(`${ENGINE_URL}/api/documents/project-md?project_id=${doc.projectId}`);
      if (res.ok) {
        const data = await res.json();
        updateProjectDoc(doc.id, { content: data.content || `# ${doc.name}\n\n` });
        setEditingProjectDoc({ ...doc, content: data.content || `# ${doc.name}\n\n` });
      } else {
        setEditingProjectDoc(doc);
      }
    } catch {
      setEditingProjectDoc(doc);
    }
  };

  const handleSaveProjectDoc = async (content: string) => {
    if (!editingProjectDoc) return;
    try {
      await fetch(`${ENGINE_URL}/api/documents/project-md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, project_id: editingProjectDoc.projectId }),
      });
      updateProjectDoc(editingProjectDoc.id, { content });
    } catch {
      // Silent fail
    }
  };

  const handleDeleteProject = async (doc: ProjectDoc) => {
    try {
      await fetch(`${ENGINE_URL}/api/projects/${doc.projectId}`, { method: 'DELETE' });
    } catch { /* silent */ }
    deleteProjectDoc(doc.id);
  };

  const handleRenameCommit = (t: Thread) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== t.title) {
      updateThreadTitle(t.id, trimmed);
      fetch(`${ENGINE_URL}/api/threads/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      }).catch(() => { /* silent */ });
    }
    setRenamingId(null);
  };

  if (!sidebarOpen) return null;

  const sortedGroupKeys = Object.keys(grouped).sort();

  const getProjectName = (projectId: string): string => {
    const doc = projectDocs.find((p) => p.projectId === projectId);
    return doc?.name || projectId;
  };

  const renderThread = (t: Thread) => {
    const preview = lastMessagePreview(allMessages[t.id]);
    const isFork = !!t.parentThreadId;
    const isDeleting = deletingId === t.id;
    const isRenaming = renamingId === t.id;

    return (
      <div
        key={t.id}
        className={`group relative flex items-start gap-1.5 py-1.5 rounded-sm transition-all cursor-pointer ${
          isFork ? 'ml-3 pl-1.5 pr-2' : 'px-2'
        } ${
          t.id === activeThreadId
            ? 'bg-phobos-green/10 text-foreground border-l-2 border-phobos-green/60 pl-1.5'
            : 'text-foreground/80 hover:bg-accent hover:text-foreground border-l-2 border-transparent'
        }`}
        onClick={() => !isRenaming && setActiveThread(t.id)}
      >
        {isFork && <GitBranch className="w-3 h-3 shrink-0 text-muted-foreground/60 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-1">
            {isRenaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameCommit(t);
                  if (e.key === 'Escape') setRenamingId(null);
                  e.stopPropagation();
                }}
                onBlur={() => handleRenameCommit(t)}
                onClick={(e) => e.stopPropagation()}
                className="text-xs flex-1 font-mono bg-transparent border-b border-phobos-green/30 focus:outline-none text-foreground"
              />
            ) : (
              <span
                className="text-xs truncate flex-1 font-mono"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenamingId(t.id);
                  setRenameValue(t.title);
                }}
              >
                {t.title}
              </span>
            )}
            <span className="text-[10px] text-sayon/55 shrink-0 font-mono">
              {relativeTime(t.createdAt)}
            </span>
          </div>
          {preview && (
            <p className="text-[10px] text-muted-foreground/30 truncate leading-tight mt-0.5">
              {preview}
            </p>
          )}
        </div>

        {/* Delete */}
        {isDeleting ? (
          <div
            className="absolute right-1 top-1 flex items-center gap-1 bg-card border border-border rounded px-1.5 py-0.5 z-10"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[10px] text-destructive font-mono">Delete?</span>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
              className="text-[10px] px-1 rounded bg-destructive/20 text-destructive hover:bg-destructive/30"
            >
              Yes
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setDeletingId(null); }}
              className="text-[10px] px-1 rounded bg-muted text-muted-foreground hover:text-foreground"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setDeletingId(t.id); }}
            className="p-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 mt-0.5"
            title="Delete conversation"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <aside className="w-56 border-r border-border/50 bg-background flex flex-col shrink-0 h-full">
        {/* Polaris dock — top of sidebar */}
        <div className="p-2 border-b border-border/30">
          <PolarisPlayerDock />
        </div>

        {/* Tool + Media icon grid — 2 rows x 2 cols
             Row 1: Scheduler | Security
             Row 2: Polaris   | Kavita     */}
        <SidebarIconGrid />

        {/* Projects section */}
        <div className="px-2 pt-2 pb-1 border-b border-border/30">
          <div className="flex items-center justify-between px-1 mb-1">
            <span className="text-[10px] font-terminal text-ui-glow tracking-wider uppercase">Projects</span>
            <button
              onClick={() => setShowNewProject(!showNewProject)}
              className="p-0.5 text-ui-glow hover:text-foreground transition-colors"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          {showNewProject && (
            <div className="flex items-center gap-1 px-1 py-1">
              <input
                autoFocus
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNewProject()}
                placeholder="Name…"
                className="flex-1 bg-transparent text-xs font-mono text-foreground placeholder:text-muted-foreground/30 focus:outline-none border-b border-border/30 pb-0.5"
              />
              <button
                onClick={handleNewProject}
                className="text-[10px] px-1.5 py-0.5 rounded bg-phobos-green/10 text-phobos-green/60 hover:bg-phobos-green/20 font-mono"
              >
                Add
              </button>
            </div>
          )}
          {projectDocs.map((doc) => (
            <div key={doc.id} className="group flex items-center gap-1 px-1 py-0.5">
              <button
                onClick={() => openProjectEditor(doc)}
                className="flex-1 text-left text-[11px] font-mono text-phobos-green/50 hover:text-phobos-green/80 truncate transition-colors"
              >
                <FolderOpen className="w-3 h-3 inline mr-1 opacity-50" />
                {doc.name}
              </button>
              <button
                onClick={() => handleDeleteProject(doc)}
                className="p-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-all"
              >
                <Trash2 className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>

        {/* New Chat button */}
        <div className="p-2">
          <button
            onClick={handleNew}
            title="New chat (⌘N)"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono rounded-sm hover:bg-accent text-phobos-green/70 hover:text-phobos-green transition-colors border border-border/30 hover:border-border/60"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 text-left">New Chat</span>
            <span className="text-[9px] font-mono text-ui-glow">⌘N</span>
          </button>
        </div>

        {/* Thread search */}
        <div className="px-2 pb-1">
          <div className="relative">
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search… ⌘K"
              className="w-full bg-transparent text-[10px] font-mono text-foreground/60 placeholder:text-muted-foreground/20 focus:outline-none border border-border/20 focus:border-phobos-green/30 rounded-sm px-2 py-1 pr-5 transition-all"
            />
            {search.length > 0 && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
          {/* Ungrouped conversations — date-bucketed */}
          {DATE_BUCKETS.map((bucket) => {
            const items = dateBuckets[bucket];
            if (!items || items.length === 0) return null;
            const bucketKey = `__date__${bucket}`;
            // Today + Yesterday default open; older buckets default collapsed
            const defaultCollapsed = bucket !== 'Today' && bucket !== 'Yesterday';
            const hasActiveThread = items.some((t) => t.id === activeThreadId);
            // Force open if active thread is in this bucket, or if searching
            const isCollapsed = search ? false : (hasActiveThread ? false : (collapsed[bucketKey] ?? defaultCollapsed));

            return (
              <div key={bucket} className="mb-1">
                <button
                  onClick={() => toggle(bucketKey)}
                  className="w-full flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-mono text-ui-glow text-ui-glow-hover transition-colors"
                >
                  <ChevronRight
                    className={`w-2.5 h-2.5 transition-transform shrink-0 ${!isCollapsed ? 'rotate-90' : ''}`}
                  />
                  <span className="tracking-wider uppercase">{bucket}</span>
                  <span className="ml-auto text-ui-glow">{items.length}</span>
                </button>
                {!isCollapsed && (
                  <div>
                    {items.map(renderThread)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Grouped by project */}
          {sortedGroupKeys.map((projectId) => {
            const items = grouped[projectId];
            const isCollapsed = search ? false : collapsed[projectId];
            const displayName = getProjectName(projectId);

            return (
              <div key={projectId} className="mb-1">
                <button
                  onClick={() => toggle(projectId)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 text-xs font-mono text-phobos-green/50 hover:text-phobos-green/80 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 transition-transform ${!isCollapsed ? 'rotate-90' : ''}`}
                  />
                  <FolderOpen className="w-3 h-3" />
                  <span>{displayName}</span>
                  <span className="ml-auto text-[10px] text-phobos-green/40">{items.length}</span>
                </button>

                {!isCollapsed && (
                  <div className="ml-2">
                    {items.map(renderThread)}
                  </div>
                )}
              </div>
            );
          })}

          {threads.length === 0 && (
            <div className="px-3 py-8 text-center text-[10px] text-muted-foreground/20 font-mono">
              No conversations
            </div>
          )}
        </div>
      </aside>

      {editingProjectDoc && (
        <FileEditorWindow
          filename={`${editingProjectDoc.name}.md`}
          initialContent={editingProjectDoc.content}
          language="markdown"
          onClose={() => setEditingProjectDoc(null)}
          onSaveContent={handleSaveProjectDoc}
        />
      )}
    </>
  );
}