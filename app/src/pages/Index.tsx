import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Download, Aperture, Film, Music } from 'lucide-react';
import { detectPlatform } from '@/components/splash/ConnectionSplash';
import { HeaderBar } from '@/components/header/HeaderBar';
import { Sidebar } from '@/components/layout/Sidebar';
import { CopilotPanel } from '@/components/layout/CopilotPanel';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput } from '@/components/chat/ChatInput';
import { WorkspacePanel } from '@/components/chat/WorkspacePanel';
import { WorkflowPanel } from '@/components/chat/WorkflowPanel';
import { ThinkingPanel } from '@/components/chat/ThinkingPanel';
import { WelcomeScreen } from '@/components/chat/WelcomeScreen';
import { ConnectionSplash } from '@/components/splash/ConnectionSplash';
import { VersionSplash } from '@/components/splash/VersionSplash';
import { SetupGuide } from '@/components/splash/SetupGuide';
import { PhobosLLMPanel } from '@/components/phobos/PhobosLLMPanel';
import { TrialPopup } from '@/components/phobos/TrialPopup';
import { UpdateBanner } from '@/components/phobos/UpdateBanner';
import { ConnectionStatus } from '@/components/phobos/ConnectionStatus';
import { useStream } from '@/hooks/useStream';
import { useAppStore } from '@/store/useAppStore';
import { useWorkflowStore, type WorkflowSession } from '@/store/useWorkflowStore';
// AudioGenPanel and useAudioGenStore removed — audio gen is now a workflow
import { useThreads, useThreadMessages, useStatus } from '@/hooks/useThread';
import { PhobosGame } from '@/game/PhobosGame';
import { EffluxPanel } from '@/components/editors/EffluxPanel';
import { MonacoPanel } from '@/components/editors/MonacoPanel';
import { JoditPanel } from '@/components/editors/JoditPanel';
import { ImageEditorPanel } from '@/components/editors/ImageEditorPanel';
import { StirlingPanel } from '@/components/editors/StirlingPanel';
import { VideosPanel } from '@/components/editors/VideosPanel';
import { BlockbenchPanel } from '@/components/editors/BlockbenchPanel';
import { SculptGLPanel }   from '@/components/editors/SculptGLPanel';
import { GodotPanel }      from '@/components/editors/GodotPanel';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

const Index = () => {
  const { sendMessage, stopStream } = useStream();
  // Expose sendMessage globally so useSchedulerPending can fire tasks through the full SSE stream path.
  (globalThis as any).__phobosSendMessage = sendMessage;
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const isStreaming = useAppStore((s) => s.streamingThreads.has(activeThreadId));
  const thinkingOpen = useAppStore((s) => s.thinkingOpen);
  const toggleThinking = useAppStore((s) => s.toggleThinking);
  const copilotMode = useAppStore((s) => s.copilotMode);
  const modelNames = useAppStore((s) => s.modelNames);
  const taskProgress = useAppStore((s) => s.taskProgress);
  const segments = useAppStore((s) => s.segments[s.activeThreadId]) ?? [];
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const projectDocs = useAppStore((s) => s.projectDocs);
  const updateThreadProject = useAppStore((s) => s.updateThreadProject);

  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const contextHistoryDepth = useAppStore((s) => s.contextHistoryDepth);
  const setContextHistoryDepth = useAppStore((s) => s.setContextHistoryDepth);
  const ctxComputedCount = useAppStore((s) => s.ctxComputedCount);
  const ctxOverrideActive = useAppStore((s) => s.ctxOverrideActive);
  const setCtxOverrideActive = useAppStore((s) => s.setCtxOverrideActive);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [platform, setPlatform] = useState<Parameters<typeof VersionSplash>[0]['platform']>('linux');
  const [audDepsReady, setAudDepsReady] = useState(false);
  const [audioModeTab, setAudioModeTab] = useState<'music' | 'clone'>('music');
  const [audioModeDropdownOpen, setAudioModeDropdownOpen] = useState(false);
  const audioModeRef = useRef<HTMLDivElement>(null);

  // Image gen model picker
  const openPanel = useWorkflowStore((s) => s.openPanel);
  const closePanel = useWorkflowStore((s) => s.closePanel);
  const workflowPanelOpen = useWorkflowStore((s) => s.panelOpen);
  const activeSession = useWorkflowStore((s) => s.activeSession);
  const workflowActiveNodeIndex = useWorkflowStore((s) => s.activeNodeIndex);
  const setActiveNodeIndex = useWorkflowStore((s) => s.setActiveNodeIndex);

  // Save panel state to backend (debounced)
  const savePanelStateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePanelState = useCallback(() => {
    if (!activeThreadId) return;
    if (savePanelStateRef.current) clearTimeout(savePanelStateRef.current);
    savePanelStateRef.current = setTimeout(async () => {
      try {
        const body = activeSession && workflowPanelOpen
          ? { workflowId: activeSession.workflowId, activeNodeIndex: workflowActiveNodeIndex, panelOpen: true }
          : { workflowId: '', activeNodeIndex: 0, panelOpen: false };
        await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows/panel-state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch { /* silent */ }
    }, 300);
  }, [activeThreadId, activeSession?.workflowId, workflowPanelOpen, workflowActiveNodeIndex]);

  // Auto-save panel state whenever it changes
  useEffect(() => { savePanelState(); }, [workflowPanelOpen, activeSession?.workflowId, workflowActiveNodeIndex]);

  // Restore panel state when switching threads or on initial load
  const prevThreadRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevThreadRef.current;
    prevThreadRef.current = activeThreadId;

    if (!activeThreadId) return;

    // Fetch workflows index + panel state from backend
    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows`);
        if (!res.ok) return;
        const data = await res.json();
        const panelState = data.panelState;

        if (panelState?.panelOpen && panelState.workflowId) {
          // Restore the saved workflow panel
          const wfRes = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows/${panelState.workflowId}`);
          if (wfRes.ok) {
            const wfData = await wfRes.json();
            openPanel(wfData.session as WorkflowSession);
            setActiveNodeIndex(panelState.activeNodeIndex ?? 0);

            // Reconnect generation polling if a render was in progress at refresh time.
            // runStatus survives F5 (backend in-memory, not frontend), so we can
            // reattach exactly where it left off.
            try {
              const statusRes = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows/${panelState.workflowId}/run-status`);
              if (statusRes.ok) {
                const status = await statusRes.json();
                if (status.generating) {
                  const { useWorkflowStore } = await import('@/store/useWorkflowStore');
                  const wfStore = useWorkflowStore.getState();
                  const wfId = panelState.workflowId;
                  useAppStore.getState().setImageGenerating(true, 'Resuming render…');
                  wfStore.setGenerating(wfId, true);
                  if (status.phases?.length > 0) {
                    wfStore.clearRenderPhases(wfId);
                    for (const p of status.phases) wfStore.pushRenderPhase(wfId, p.renderPhase, p.detail);
                  }
                  if (status.progress) wfStore.setProgress(wfId, status.progress);
                  (async () => {
                    while (true) {
                      await new Promise(r => setTimeout(r, 1500));
                      try {
                        const sr = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows/${wfId}/run-status`);
                        if (!sr.ok) continue;
                        const s = await sr.json();
                        if (s.progress) wfStore.setProgress(wfId, s.progress);
                        if (s.phases?.length > 0) { wfStore.clearRenderPhases(wfId); for (const p of s.phases) wfStore.pushRenderPhase(wfId, p.renderPhase, p.detail); }
                        if (s.activeNode !== undefined) wfStore.setActiveNodeIndex(s.activeNode);
                        if (!s.generating) {
                          wfStore.setGenerating(wfId, false);
                          wfStore.setProgress(wfId, null);
                          wfStore.clearRenderPhases(wfId);
                          useAppStore.getState().setImageGenerating(false, '');
                          const fr = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows/${wfId}`);
                          if (fr.ok) { const fd = await fr.json(); wfStore.setSession(fd.session); }
                          const ir = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows`);
                          if (ir.ok) { const id = await ir.json(); wfStore.setIndex(activeThreadId, id.workflows ?? []); }
                          break;
                        }
                      } catch { /* retry */ }
                    }
                  })();
                }
              }
            } catch { /* non-fatal */ }
            return;
          }
        }
        // No saved panel state or workflow was deleted — close panel
        if (prev !== activeThreadId) closePanel();
      } catch { /* silent */ }
    })();
  }, [activeThreadId]);
  const [imageModels, setImageModels] = useState<{ modelId: string; label: string; downloaded: boolean }[]>([]);
  const [selectedImageModel, setSelectedImageModel] = useState('');
  const [imageModelDropdownOpen, setImageModelDropdownOpen] = useState(false);
  const imageModelRef = useRef<HTMLDivElement>(null);
  const phobosLLMPanelOpen = useAppStore((s) => s.phobosLLMPanelOpen);
  const togglePhobosLLMPanel = useAppStore((s) => s.togglePhobosLLMPanel);
  const backendAlive = useAppStore((s) => s.backendAlive);

  // Fetch installed image models when backend comes alive, and re-fetch
  // when PhobosLLMPanel closes (user may have downloaded new models).
  useEffect(() => {
    if (!backendAlive) return;
    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/phobos/image/catalogue`);
        if (!res.ok) return;
        const data = await res.json();
        const installed = (data.models ?? [])
          .filter((m: any) => m.downloaded && m.category !== 'video' && m.category !== 'kontext')
          .map((m: any) => ({ modelId: m.modelId, label: m.label, downloaded: true }));
        setImageModels(installed);
        if (installed.length > 0 && !selectedImageModel) {
          // Default to fastest installed: z-image-turbo > flux2-klein-4b > flux-schnell > chroma > others
          const SPEED_ORDER = ['z-image-turbo-q4', 'flux2-klein-4b-q4', 'flux-schnell-q4', 'flux-schnell-q8', 'chroma-q4'];
          const fastest = SPEED_ORDER.map(id => installed.find((m: any) => m.modelId === id)).find(Boolean);
          setSelectedImageModel(fastest ? fastest.modelId : installed[0].modelId);
        }
      } catch { /* silent */ }
    })();
  }, [backendAlive, phobosLLMPanelOpen]);

  // Fetch audio dep status when backend comes alive — gates the AUD button
  useEffect(() => {
    if (!backendAlive) return;
    fetch(`${ENGINE_URL}/api/audio/dep-status`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { kokoro: boolean; whisper: boolean; aceStep: boolean } | null) => {
        if (d) setAudDepsReady(d.kokoro || d.aceStep);
      })
      .catch(() => {});
  }, [backendAlive]);

  const openWorkflowPanel = useWorkflowStore((s) => s.openPanel);

  const handleNewAudioGen = useCallback(async (tab: 'music' | 'clone' = 'music') => {
    if (!activeThreadId) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ workflowType: 'audio', audioMode: tab }),
      });
      if (res.ok) {
        const data = await res.json();
        openWorkflowPanel(data.session);
      }
    } catch { /* silent */ }
  }, [activeThreadId, openWorkflowPanel]);

  // Close image model dropdown on outside click
  useEffect(() => {
    if (!imageModelDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (imageModelRef.current && !imageModelRef.current.contains(e.target as Node)) setImageModelDropdownOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [imageModelDropdownOpen]);

  const handleNewImageGen = useCallback(async () => {
    if (!activeThreadId) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: selectedImageModel || undefined }),
      });
      if (res.ok) {
        const data = await res.json();
        openPanel(data.session as WorkflowSession);
      }
    } catch { /* silent */ }
  }, [activeThreadId, selectedImageModel, openPanel]);

  // ── Video gen state ────────────────────────────────────────────────────────
  const [videoModels, setVideoModels] = useState<{ modelId: string; label: string; downloaded: boolean }[]>([]);
  const [selectedVideoModel, setSelectedVideoModel] = useState('');
  const [videoModelDropdownOpen, setVideoModelDropdownOpen] = useState(false);
  const videoModelRef = useRef<HTMLDivElement>(null);

  // Fetch installed video models when backend comes alive, and re-fetch
  // when PhobosLLMPanel closes (user may have downloaded new models).
  useEffect(() => {
    if (!backendAlive) return;
    (async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/phobos/image/catalogue`);
        if (!res.ok) return;
        const data = await res.json();
        const installed = (data.models ?? [])
          .filter((m: any) => m.downloaded && m.category === 'video')
          .map((m: any) => ({ modelId: m.modelId, label: m.label, downloaded: true }));
        setVideoModels(installed);
        if (installed.length > 0 && !selectedVideoModel) {
          setSelectedVideoModel(installed[0].modelId);
        }
      } catch { /* silent */ }
    })();
  }, [backendAlive, phobosLLMPanelOpen]);

  // Close video model dropdown on outside click
  useEffect(() => {
    if (!videoModelDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (videoModelRef.current && !videoModelRef.current.contains(e.target as Node)) setVideoModelDropdownOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [videoModelDropdownOpen]);

  // Close audio mode dropdown on outside click
  useEffect(() => {
    if (!audioModeDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (audioModeRef.current && !audioModeRef.current.contains(e.target as Node)) setAudioModeDropdownOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [audioModeDropdownOpen]);

  const handleNewVideoGen = useCallback(async () => {
    if (!activeThreadId) return;
    try {
      const res = await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: selectedVideoModel || undefined, workflowType: 'video' }),
      });
      if (res.ok) {
        const data = await res.json();
        openPanel(data.session as WorkflowSession);
      }
    } catch { /* silent */ }
  }, [activeThreadId, selectedVideoModel, openPanel]);

  useEffect(() => {
    detectPlatform().then(setPlatform);
  }, []);

  // Trial popup logic — initialize from localStorage, then verify against phobos-core once connected
  // Trial popup bypassed — always dismissed.
  const [trialDismissed, setTrialDismissed] = useState(true);


  const formatModelLabel = (raw: string) => {
    if (!raw) return '—';
    if (raw.includes(':')) {
      const [name, tag] = raw.split(':');
      return `${name.charAt(0).toUpperCase()}${name.slice(1)}-${tag.toUpperCase()}`;
    }
    return raw;
  };

  // Thinking capability is determined by the backend via /api/status.
  // isThinkingModel() on the backend checks the GGUF spec's thinkingTokens field,
  // which is the single source of truth for whether a model supports reasoning.
  const coordHasThinking = modelNames.coordinatorHasThinking ?? false;
  const engineHasThinking = modelNames.engineHasThinking ?? false;
  const threads = useAppStore((s) => s.threads);
  const messages = useAppStore((s) => s.messages[s.activeThreadId]) ?? [];
  const imageGenerating = useAppStore((s) => s.imageGenerating);
  const versionMismatch = useAppStore((s) => s.versionMismatch);
  const coreVersion = useAppStore((s) => s.coreVersion);
  const activeThread = useAppStore((s) =>
    s.threads.find((t) => t.id === s.activeThreadId)
  );

  const engineOffline = connectionStatus.engine === 'disconnected';

  // Close dropdown on outside click
  useEffect(() => {
    if (!projectDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [projectDropdownOpen]);

  const handleProjectSelect = async (projectId: string | null) => {
    if (!activeThreadId) return;
    try {
      await fetch(`${ENGINE_URL}/api/threads/${activeThreadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      updateThreadProject(activeThreadId, projectId);
    } catch { /* silent */ }
    setProjectDropdownOpen(false);
  };

  const currentProject = activeThread?.projectName
    ? projectDocs.find((p) => p.projectId === activeThread.projectName)
    : null;

  // Check phobos-core for a valid license once connected — bypasses trial popup
  useEffect(() => {
    if (!backendAlive || trialDismissed) return;
    fetch(`${ENGINE_URL}/api/license`)
      .then(r => r.json())
      .then((data: { valid?: boolean }) => {
        if (data.valid) {
          localStorage.setItem('phobos_licensed', 'true');
          setTrialDismissed(true);
        }
      })
      .catch(() => { /* offline or not configured — leave trial as-is */ });
  }, [backendAlive]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'n') {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('phobos:new-chat'));
        }
      }
      if (mod && e.key === 'k') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('phobos:focus-search'));
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useThreads();
  useStatus();
  useThreadMessages(activeThreadId);

  // Hydrate user directives from backend on mount.
  // PHOBOS internal directives are hardcoded in the engine — not fetched here.
  useEffect(() => {
    const hydrateUserDirectives = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/documents/user-directives`);
        if (res.ok) {
          const data = await res.json();
          if (data.content) useAppStore.getState().updateDocument('userDirectivesMd', data.content);
        }
      } catch { /* fall back to empty — engine handles absence gracefully */ }
    };
    hydrateUserDirectives();
  }, []);

  const isEmpty = threads.length === 0 && messages.length === 0;
  const isDisconnected = connectionStatus.coordinator === 'disconnected' && connectionStatus.engine === 'disconnected';
  const bootPhase = useAppStore((s) => s.bootPhase);

  // Show ConnectionSplash for the entire boot sequence — not just when the backend
  // is unreachable. Once backendAlive is true but bootPhase is still not 'ready',
  // we're in dep-prep / db_init / core_init and must stay on the splash screen.
  // SetupGuide only appears once boot is confirmed done and LLMs are disconnected.
  //
  // bootPhase===null with backendAlive===true means the /api/status poll fired but
  // the SSE stream hasn't delivered its first event yet. Hold the splash through
  // that window so SetupGuide never flickers in during the handoff.
  const bootPhaseUnknown = backendAlive && bootPhase === null;
  const coreBooting = backendAlive && (bootPhaseUnknown || (bootPhase !== null && bootPhase !== 'ready'));
  const splashVisible = isDisconnected || coreBooting;

  return (
    <>
      <PhobosGame />
      <EffluxPanel />
      <MonacoPanel />
      <JoditPanel />
      <StirlingPanel />
      <ImageEditorPanel />
      <VideosPanel />
      <BlockbenchPanel />
      <SculptGLPanel />
      <GodotPanel />
      <div className="h-screen flex flex-col overflow-hidden phobos-ui-root" style={{ position: 'relative', zIndex: 10, backgroundColor: 'transparent' }}>
      {/* Trial popup */}
      {!trialDismissed && (
        <TrialPopup onDismiss={() => {
          setTrialDismissed(true);
          localStorage.setItem('phobos_trial_dismissed', 'true');
        }} />
      )}

      {splashVisible && (!backendAlive || coreBooting) && <ConnectionSplash />}
      {splashVisible && backendAlive && !coreBooting && <SetupGuide />}
      {!splashVisible && backendAlive && versionMismatch && <VersionSplash platform={platform} coreVersion={coreVersion} />}
      {phobosLLMPanelOpen && <PhobosLLMPanel onClose={togglePhobosLLMPanel} />}
      <UpdateBanner />
      <div className="phobos-header">
        <HeaderBar />
      </div>
      <div className="flex-1 flex overflow-hidden phobos-world-content" style={{ backgroundColor: 'transparent' }}>
        <div className="phobos-sidebar">
          <Sidebar />
        </div>
        {isEmpty ? (
          <>
            <div className="flex-1 phobos-world-panel">
              <WelcomeScreen />
            </div>
          </>
        ) : (
          <>
            <main className={`flex flex-col min-w-0 overflow-hidden relative transition-all duration-300 phobos-world-panel ${
              copilotMode === 'expanded' ? 'flex-[1]' : 'flex-1'
            }`}>
              {/* Ghost PHOBOS background hidden — game world is the background */}

              <div className="px-4 py-1.5 border-b border-border/30 bg-background/80 relative z-20 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <h2 className="text-[11px] font-mono font-medium text-foreground/70 truncate">
                    {activeThread?.title || 'Select a conversation'}
                  </h2>
                  {activeThread && (
                    <div className="relative" ref={dropdownRef}>
                      <button
                        onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                        className="flex items-center gap-1 text-[10px] text-ui-glow text-ui-glow-hover font-mono transition-colors mt-0.5"
                      >
                        {currentProject?.name || 'No project'}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {projectDropdownOpen && (
                        <div
                          className="absolute top-full left-0 mt-1 bg-secondary border border-phobos-green/20 rounded-sm shadow-lg z-50 min-w-[200px]"
                          style={{ boxShadow: '0 0 20px rgba(0,255,65,0.06)' }}
                        >
                          <button
                            onClick={() => handleProjectSelect(null)}
                            className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-muted-foreground/60 hover:bg-phobos-green/10 hover:text-phobos-green/80 transition-all"
                          >
                            — None —
                          </button>
                          {projectDocs.map((doc) => (
                            <button
                              key={doc.id}
                              onClick={() => handleProjectSelect(doc.projectId)}
                              className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-muted-foreground/60 hover:bg-phobos-green/10 hover:text-phobos-green/80 transition-all"
                            >
                              {doc.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Export conversation */}
                {activeThreadId && (
                  <div className="flex items-center shrink-0 ml-3">
                    <button
                      onClick={() => window.open(`${ENGINE_URL}/api/threads/${activeThreadId}/export`, '_blank')}
                      className="w-4 h-4 flex items-center justify-center rounded text-ui-glow hover:text-phobos-green/70 hover:bg-accent transition-all"
                      title="Export conversation transcript"
                    >
                      <Download className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* New Image Gen + model picker */}
                {activeThreadId && (
                  <div className="flex items-center gap-1 shrink-0 ml-3">
                    <button
                      onClick={handleNewImageGen}
                      disabled={imageModels.length === 0}
                      className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-phobos-green/25 text-phobos-green/60 hover:text-phobos-green hover:border-phobos-green/50 transition-all disabled:opacity-25"
                      title={imageModels.length === 0 ? 'No image models installed' : 'Create new image workflow'}
                    >
                      <Aperture className="w-2.5 h-2.5" />
                      IMG
                    </button>
                    <div className="relative" ref={imageModelRef}>
                      <button
                        onClick={() => setImageModelDropdownOpen(!imageModelDropdownOpen)}
                        disabled={imageModels.length === 0}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono text-ui-glow text-ui-glow-hover transition-all disabled:opacity-25"
                      >
                        <span className="truncate max-w-[80px]">
                          {imageModels.find(m => m.modelId === selectedImageModel)?.label ?? '—'}
                        </span>
                        <ChevronDown className="w-2 h-2 shrink-0" />
                      </button>
                      {imageModelDropdownOpen && imageModels.length > 0 && (
                        <div className="absolute top-full right-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-xl z-50 overflow-hidden">
                          {imageModels.map(m => (
                            <button
                              key={m.modelId}
                              onClick={() => { setSelectedImageModel(m.modelId); setImageModelDropdownOpen(false); }}
                              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono transition-all hover:bg-accent ${
                                m.modelId === selectedImageModel ? 'text-phobos-green bg-phobos-green/5' : 'text-muted-foreground/60'
                              }`}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* New Video Gen + model picker */}
                {activeThreadId && (
                  <div className="flex items-center gap-1 shrink-0 ml-1">
                    <button
                      onClick={handleNewVideoGen}
                      disabled={videoModels.length === 0}
                      className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-phobos-amber/25 text-phobos-amber/60 hover:text-phobos-amber hover:border-phobos-amber/50 transition-all disabled:opacity-25"
                      title={videoModels.length === 0 ? 'No video models installed' : 'Create new video workflow'}
                    >
                      <Film className="w-2.5 h-2.5" />
                      MOV
                    </button>
                    <div className="relative" ref={videoModelRef}>
                      <button
                        onClick={() => setVideoModelDropdownOpen(!videoModelDropdownOpen)}
                        disabled={videoModels.length === 0}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono text-ui-glow text-ui-glow-hover transition-all disabled:opacity-25"
                      >
                        <span className="truncate max-w-[80px]">
                          {videoModels.find(m => m.modelId === selectedVideoModel)?.label ?? '—'}
                        </span>
                        <ChevronDown className="w-2 h-2 shrink-0" />
                      </button>
                      {videoModelDropdownOpen && videoModels.length > 0 && (
                        <div className="absolute top-full right-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-xl z-50 overflow-hidden">
                          {videoModels.map(m => (
                            <button
                              key={m.modelId}
                              onClick={() => { setSelectedVideoModel(m.modelId); setVideoModelDropdownOpen(false); }}
                              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono transition-all hover:bg-accent ${
                                m.modelId === selectedVideoModel ? 'text-phobos-amber bg-phobos-amber/5' : 'text-muted-foreground/60'
                              }`}
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* New Audio Gen + mode picker */}
                {activeThreadId && (
                  <div className="flex items-center gap-1 shrink-0 ml-1">
                    <button
                      onClick={() => handleNewAudioGen(audioModeTab)}
                      disabled={!audDepsReady}
                      className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-terminal uppercase tracking-[0.1em] rounded-sm border border-cyan-400/25 text-cyan-400/60 hover:text-cyan-400 hover:border-cyan-400/50 transition-all disabled:opacity-25"
                      title={audDepsReady ? 'New audio workflow' : 'Audio gen deps not installed — open System Settings → Audio'}
                    >
                      <Music className="w-2.5 h-2.5" />
                      AUD
                    </button>
                    <div className="relative" ref={audioModeRef}>
                      <button
                        onClick={() => setAudioModeDropdownOpen(!audioModeDropdownOpen)}
                        disabled={!audDepsReady}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-mono text-ui-glow text-ui-glow-hover transition-all disabled:opacity-25"
                      >
                        <span className="truncate max-w-[80px]">
                          {audioModeTab === 'music' ? 'Music' : 'Voice Clone'}
                        </span>
                        <ChevronDown className="w-2 h-2 shrink-0" />
                      </button>
                      {audioModeDropdownOpen && (
                        <div className="absolute top-full right-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-xl z-50 overflow-hidden">
                          {([
                            { tab: 'music' as const,  label: 'Music' },
                            { tab: 'clone' as const,  label: 'Voice Clone' },
                          ] as const).map(({ tab, label }) => (
                            <button
                              key={tab}
                              onClick={() => { setAudioModeDropdownOpen(false); setAudioModeTab(tab); handleNewAudioGen(tab); }}
                              className={`w-full text-left px-3 py-1.5 text-[10px] font-mono transition-all hover:bg-accent ${
                                audioModeTab === tab
                                  ? 'text-cyan-400 bg-cyan-400/5'
                                  : 'text-muted-foreground/60'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Context history depth dial
                    - AUTO mode (ctxComputedCount set): CTX label is green, controls hidden
                    - Override mode (ctxOverrideActive): CTX label is red, +/- controls visible
                    - Click CTX label to toggle between modes
                    - Entering override mode seeds the input from the last computed count */}
                <div className="flex items-center gap-1 shrink-0 ml-3">
                  <button
                    onClick={() => {
                      if (ctxOverrideActive) {
                        // Return to AUTO — clear override flag and reset depth to default
                        setCtxOverrideActive(false);
                        setContextHistoryDepth(6);
                      } else {
                        // Enter override — seed depth from last computed count or current depth
                        setCtxOverrideActive(true);
                        if (ctxComputedCount !== null) {
                          setContextHistoryDepth(ctxComputedCount);
                        }
                      }
                    }}
                    className={`text-[9px] font-mono uppercase tracking-wider transition-colors select-none px-0.5 rounded hover:opacity-80 ${
                      ctxOverrideActive
                        ? 'text-red-400/90 cursor-pointer'
                        : 'text-phobos-green/70 cursor-pointer'
                    }`}
                    title={ctxOverrideActive
                      ? 'Context override active — click to return to AUTO'
                      : 'AUTO context mode — click to override'
                    }
                  >
                    CTX
                  </button>
                  <span
                    className={`text-[11px] font-mono w-5 text-center tabular-nums select-none transition-colors ${
                      ctxOverrideActive ? 'text-red-400/80' : 'text-phobos-green/60'
                    }`}
                    title={ctxOverrideActive
                      ? `Manual override: ${contextHistoryDepth} message pairs`
                      : ctxComputedCount !== null
                        ? `AUTO: ${ctxComputedCount} pair${ctxComputedCount !== 1 ? 's' : ''} fit the context window`
                        : 'AUTO context mode'
                    }
                  >
                    {ctxOverrideActive ? contextHistoryDepth : (ctxComputedCount ?? '·')}
                  </span>
                  {ctxOverrideActive && (
                    <>
                      <button
                        onClick={() => setContextHistoryDepth(contextHistoryDepth - 1)}
                        disabled={contextHistoryDepth <= 1}
                        className="w-4 h-4 flex items-center justify-center rounded text-red-400/60 hover:text-red-400 hover:bg-red-400/10 transition-all disabled:opacity-20 disabled:cursor-not-allowed text-xs leading-none"
                        title="Fewer context messages"
                      >
                        −
                      </button>
                      <button
                        onClick={() => setContextHistoryDepth(contextHistoryDepth + 1)}
                        disabled={contextHistoryDepth >= 20}
                        className="w-4 h-4 flex items-center justify-center rounded text-red-400/60 hover:text-red-400 hover:bg-red-400/10 transition-all disabled:opacity-20 disabled:cursor-not-allowed text-xs leading-none"
                        title="More context messages"
                      >
                        +
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="relative z-10 flex-1 flex flex-col overflow-hidden phobos-conversation-area">
                {engineOffline && backendAlive && !imageGenerating ? (
                  <ConnectionStatus />
                ) : (
                  <MessageList />
                )}
                <WorkflowPanel />
                <WorkspacePanel />
                <ChatInput onSend={sendMessage} onStop={stopStream} isStreaming={isStreaming} disabled={!imageGenerating && (connectionStatus.coordinator === 'disconnected' || connectionStatus.engine === 'disconnected')} />
              </div>
            </main>
            {thinkingOpen !== false && copilotMode !== 'expanded' && (
              <ThinkingPanel
                segments={segments}
                isStreaming={isStreaming}
                coordHasThinking={coordHasThinking}
                engineHasThinking={engineHasThinking}
                taskProgress={taskProgress}
                onClose={toggleThinking}
              />
            )}
          </>
        )}
        {/* CopilotPanel hoisted outside isEmpty branch — must never unmount (owns MediaRecorder refs) */}
        <CopilotPanel />
      </div>
    </div>
    </>
  );
};

export default Index;