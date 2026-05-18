import { create } from 'zustand';
import { usePolarisPlaybackStore } from './usePolarisPlaybackStore';

export type MessageRole = 'user' | 'assistant' | 'coordinator' | 'status';

export interface ExecuteResult {
  taskIndex: number;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdoutPreview: string;
  mode: 'execute' | 'simulate';
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  thinking?: string;
  filePanels?: Array<{
    filename: string;
    language: string;
    code: string;
  }>;
  executeResults?: ExecuteResult[];
  /** Files attached to this user message — shown as chips, not inlined in the bubble text */
  queryFiles?: Array<{ id: string; name: string; isImage: boolean }>;
  // Activity bubble fields
  activityEvents?: string[];
  activityActive?: boolean;
  // Coordinator message source — 'coordinator' = SAYON, 'engine' = SEREN plan summary
  coordSource?: 'coordinator' | 'engine';
}

export interface Thread {
  id: string;
  title: string;
  projectName: string | null;
  parentThreadId?: string;
  createdAt: string;
}

export interface WorkspaceFile {
  filename: string;
  language: string;
  size_bytes: number;
  note: string | null;
  last_written_by: string;
  content_hash?: string;
  updated_at: string;
}

export interface MediaFile {
  filename:     string;
  /** Absolute server-side path — used for open-native calls */
  absolutePath: string;
  threadId:     string;
  createdAt:    string;
  /** 'image' for png/jpg/webp, 'video' for avi/mp4. Defaults to 'image' for legacy entries. */
  mediaType?:   'image' | 'video';
  /** Subdirectory within the thread workspace: 'images' or 'videos' */
  dir?:         string;
}

/** One reasoning segment — DB shape, also used live (completedAt null = still streaming) */
export interface ThinkingSegment {
  id: string;
  phase: 'coordinator' | 'engine';
  content: string;
  startedAt: string;
  completedAt: string | null;
  tokenCount: number;
  /** true only while this segment is the active poll target during a stream */
  live: boolean;
}

export interface ProjectDoc {
  id: string;
  projectId: string;
  name: string;
  content: string;
}

export type AgentState = 'idle' | 'reading' | 'planning' | 'thinking' | 'executing' | 'reviewing' | 'building' | 'delivering' | 'error';

interface AppState {
  threads: Thread[];
  activeThreadId: string;
  /**
   * Threads currently receiving an SSE stream. Multiple threads can stream
   * concurrently — the backend dispatches per-task (C2) and each fetch to
   * /api/threads/:id/messages is its own SSE channel. Read via
   * isThreadStreaming(id) for thread-specific UI; read isAnyStreaming() for
   * cross-thread status indicators (workspace refresh, scheduler gating).
   */
  streamingThreads: Set<string>;
  setThreadStreaming: (threadId: string, on: boolean) => void;
  isThreadStreaming: (threadId: string) => boolean;
  isAnyStreaming: () => boolean;
  messages: Record<string, Message[]>;
  documents: {
    claudeMd: string;
    userDirectivesMd: string;
    chatMd: string;
  };
  connectionStatus: {
    coordinator: 'connected' | 'disconnected';
    engine: 'connected' | 'disconnected';
  };
  modelNames: {
    coordinator: string;
    engine: string;
    coordinatorProvider?: string;
    engineProvider?: string;
    coordinatorHasThinking?: boolean;
    engineHasThinking?: boolean;
  };
  modelConfig: {
    coordinator: {
      provider: string;
      endpoint: string;
      model: string;
      apiKey?: string;
      options: Array<{ id: string; label: string; provider: string }>;
      providers: Array<{ id: string; label: string; defaultEndpoint: string; requiresApiKey: boolean }>;
    };
    engine: {
      provider: string;
      endpoint: string;
      model: string;
      apiKey?: string;
      options: Array<{ id: string; label: string; provider: string }>;
      providers: Array<{ id: string; label: string; defaultEndpoint: string; requiresApiKey: boolean }>;
    };
  } | null;
  sidebarOpen: boolean;
  /** 'hidden' = panel not rendered. 'compact' = 280px sidebar (original default). 'expanded' = half-screen hero+stats+chat. */
  copilotMode: 'hidden' | 'compact' | 'expanded';
  thinkingOpen: boolean;
  /**
   * All thinking segments keyed by threadId.
   * Single source of truth — written by the poll loop during streaming
   * and by useThreadMessages on thread load. No live/persisted split.
   */
  segments: Record<string, ThinkingSegment[]>;
  /** Live task progress from agent_state events — shown in ThinkingPanel headers */
  taskProgress: { taskIndex: number; taskTotal: number } | null;
  /** Live activity gizmo — rendered outside the message list, always trails at bottom */
  liveActivity: { label: string; log: string[] } | null;
  workspaceIndex: Record<string, WorkspaceFile[]>;
  mediaFiles: Record<string, MediaFile[]>;
  imageGenerating: boolean;
  imageGenStatus: string;
  projectDocs: ProjectDoc[];
  backendAlive: boolean;
  bootPhase: 'prep_deps' | 'db_init' | 'core_init' | 'services_wait' | 'ready' | null;
  versionMismatch: boolean;
  coreVersion: string;
  agentStates: {
    sayon: { state: AgentState; detail: string } | null;
    seren: { state: AgentState; detail: string } | null;
  };
  phobosLLMPanelOpen: boolean;
  imageEditorOpen: boolean;
  /** DAW (Audio) — Phase 2 fullscreen panel */
  dawPanelOpen: boolean;
  /** Monaco code editor — Text → Code */
  monacoPanelOpen: boolean;
  /** Jodit document editor (pandoc-wasm + Jodit) — Text → Document */
  joditPanelOpen: boolean;
  /** Stirling PDF — Text → PDF */
  stirlingPanelOpen: boolean;
  /** Videos — Phase 4 fullscreen panel (reserved) */
  videosPanelOpen: boolean;
  /** Models — Phase 4 fullscreen panel (reserved) */
  modelsPanelOpen: boolean;
  /** Worlds — Phase 4 fullscreen panel (reserved) */
  worldsPanelOpen: boolean;
  /** 3D Editor (Blockbench / SculptGL / Godot) — fullscreen panel */
  editor3dPanelOpen: boolean;
  blockbenchPanelOpen: boolean;
  sculptglPanelOpen: boolean;
  godotPanelOpen: boolean;
  phobosCoins:     number;
  gameFocused:     boolean;
  polarisPlayerOpen: boolean;
  kavitaBrowserOpen: boolean;
  jellyfinBrowserOpen: boolean;
  meridianViewerOpen: boolean;
  meridianBrowserOpen: boolean;
  iptvPlayerOpen: boolean;
  financeOpen: boolean;
  schedulerOpen: boolean;
  securityOpen: boolean;
  vaultOpen: boolean;
  userMgmtOpen: boolean;
  halcyonOptIn: boolean;
  contextHistoryDepth: number;
  /**
   * The AUTO-computed number of prior message pairs that actually fit the context
   * window on the last turn. null = no turn completed yet / manual mode active.
   * Sent by the server as a ctx_computed SSE event; reset to null on each new send.
   */
  ctxComputedCount: number | null;
  /**
   * When true, the user has manually clicked CTX to override AUTO mode.
   * useStream reads this to decide whether to send context_history_depth.
   */
  ctxOverrideActive: boolean;
  /** null = unknown (non-phobos provider or not yet checked), true/false = scoring result */
  configOptimal: boolean | null;
  /** Vision capability of the currently active coordinator and engine models. */
  visionCapability: { coordinatorSupportsVision: boolean; engineSupportsVision: boolean } | null;

  setActiveThread: (id: string) => void;
  toggleSidebar: () => void;
  /** Cycles: hidden → compact → expanded → hidden */
  cycleCopilot: () => void;
  /** Expand directly — used by keyboard shortcuts or external triggers */
  expandCopilot: () => void;
  hideCopilot: () => void;
  toggleThinking: () => void;
  addMessage: (threadId: string, message: Message) => void;
  addThread: (thread: Thread) => void;
  updateDocument: (key: 'claudeMd' | 'userDirectivesMd' | 'chatMd', value: string) => void;
  setThreads: (threads: Thread[]) => void;
  setMessages: (threadId: string, messages: Message[]) => void;
  setConnectionStatus: (status: { coordinator: 'connected' | 'disconnected'; engine: 'connected' | 'disconnected' }) => void;
  setModelNames: (names: { coordinator: string; engine: string; coordinatorProvider?: string; engineProvider?: string; coordinatorHasThinking?: boolean; engineHasThinking?: boolean }) => void;
  setModelConfig: (config: AppState['modelConfig']) => void;
  setSegments: (threadId: string, segments: ThinkingSegment[]) => void;
  setTaskProgress: (progress: { taskIndex: number; taskTotal: number } | null) => void;
  setLiveActivity: (label: string) => void;
  clearLiveActivity: () => void;
  setWorkspaceIndex: (threadId: string, files: WorkspaceFile[]) => void;
  addMediaFile: (threadId: string, file: MediaFile) => void;
  setMediaFiles: (threadId: string, files: MediaFile[]) => void;
  setImageGenerating: (generating: boolean, status?: string) => void;
  deleteThread: (id: string) => void;
  addProjectDoc: (doc: ProjectDoc) => void;
  updateProjectDoc: (id: string, updates: Partial<ProjectDoc>) => void;
  deleteProjectDoc: (id: string) => void;
  setProjectDocs: (docs: ProjectDoc[]) => void;
  updateThreadProject: (threadId: string, projectId: string | null) => void;
  updateThreadTitle: (threadId: string, title: string) => void;
  setBackendAlive: (alive: boolean) => void;
  setBootPhase: (phase: 'prep_deps' | 'db_init' | 'core_init' | 'services_wait' | 'ready' | null) => void;
  setVersionMismatch: (mismatch: boolean, coreVersion?: string) => void;
  setAgentState: (role: 'sayon' | 'seren', state: AgentState, detail: string) => void;
  clearAgentStates: () => void;
  togglePhobosLLMPanel: () => void;
  toggleImageEditor: () => void;
  toggleDawPanel: () => void;
  toggleMonacoPanel: () => void;
  toggleJoditPanel: () => void;
  toggleStirlingPanel: () => void;
  toggleVideosPanel: () => void;
  /** Transient open requests — set by WorkspacePanel, consumed by editor panels */
  monacoOpenRequest:     { filename: string; content: string; language?: string } | null;
  joditOpenRequest: { filename: string; content: string } | null;
  setMonacoOpenRequest:     (r: { filename: string; content: string; language?: string } | null) => void;
  setJoditOpenRequest: (r: { filename: string; content: string } | null) => void;
  toggleModelsPanel: () => void;
  toggleWorldsPanel: () => void;
  toggleEditor3DPanel: () => void;
  toggleBlockbenchPanel: () => void;
  toggleSculptGLPanel: () => void;
  toggleGodotPanel: () => void;
  /**
   * Close every CREATE panel (Images/Documents/Audio/Videos/Models/Worlds).
   * Called before opening a new CREATE panel so only one fullscreen
   * surface below the header is visible at a time.
   */
  closeCreatePanels: () => void;
  togglePolarisPlayer: () => void;
  setPhobosCoins:      (coins: number) => void;
  setGameFocused:      (focused: boolean) => void;
  toggleKavitaBrowser: () => void;
  toggleJellyfinBrowser: () => void;
  toggleMeridianViewer: () => void;
  toggleMeridianBrowser: () => void;
  toggleIptvPlayer: () => void;
  toggleFinancePanel: () => void;
  setSchedulerOpen: (open: boolean) => void;
  setSecurityOpen:  (open: boolean) => void;
  setVaultOpen: (open: boolean) => void;
  setUserMgmtOpen: (open: boolean) => void;
  setHalcyonOptIn: (v: boolean) => void;
  setContextHistoryDepth: (depth: number) => void;
  setCtxComputedCount: (n: number | null) => void;
  setCtxOverrideActive: (active: boolean) => void;
  setConfigOptimal: (v: boolean | null) => void;
  setVisionCapability: (v: { coordinatorSupportsVision: boolean; engineSupportsVision: boolean } | null) => void;
  /** Patron license state — populated on startup by GET /api/license */
  licenseUsername: string | null;
  licenseChecked: boolean;
  setLicenseUsername: (username: string | null) => void;
  setLicenseChecked: (checked: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  threads: [],
  activeThreadId: '',
  streamingThreads: new Set<string>(),
  setThreadStreaming: (threadId, on) => set((s) => {
    const next = new Set(s.streamingThreads);
    if (on) next.add(threadId); else next.delete(threadId);
    return { streamingThreads: next };
  }),
  isThreadStreaming: (threadId) => get().streamingThreads.has(threadId),
  isAnyStreaming: () => get().streamingThreads.size > 0,
  messages: {},
  documents: {
    claudeMd: `# PHOBOS DIRECTIVES

## Identity
You are PHOBOS — a sovereign AI execution system. You respond to any request: code, analysis, writing, conversation, planning, research.
You do not lead. You do not assume. You execute what is asked, exactly.
When uncertain about scope or intent — stop and ask before acting.

## The Prime Directive
Precision over verbosity. Depth over surface. Permanent over temporary.
Every answer should leave the user better equipped than before.

## Behaviour
- Match tone to task: technical for code, direct for questions, creative when asked.
- Return only what is needed. No filler, no padding, no repetition.
- For code: return only what changes. One to three lines of reasoning before any block.
- For questions: answer directly first, elaborate only if useful.`,

    userDirectivesMd: '',
    chatMd: '',
  },
  connectionStatus: {
    coordinator: 'disconnected',
    engine: 'disconnected',
  },
  modelNames: {
    coordinator: 'NPU',
    engine: 'Engine',
    coordinatorProvider: '',
  },
  modelConfig: null,
  sidebarOpen: true,
  copilotMode: 'compact' as const,
  thinkingOpen: true,
  segments: {},
  taskProgress: null,
  liveActivity: null,
  workspaceIndex: {},
  mediaFiles: {},
  imageGenerating: false,
  imageGenStatus: '',
  projectDocs: [],
  backendAlive: false,
  bootPhase: null,
  versionMismatch: false,
  coreVersion: '',
  agentStates: { sayon: null, seren: null },
  phobosLLMPanelOpen: false,
  imageEditorOpen: false,
  dawPanelOpen: false,
  monacoPanelOpen: false,
  joditPanelOpen: false,
  stirlingPanelOpen: false,
  videosPanelOpen: false,
  monacoOpenRequest: null,
  joditOpenRequest: null,
  modelsPanelOpen: false,
  worldsPanelOpen: false,
  editor3dPanelOpen: false,
  blockbenchPanelOpen: false,
  sculptglPanelOpen: false,
  godotPanelOpen: false,
  phobosCoins:     0,
  gameFocused:     false,
  polarisPlayerOpen: false,
  kavitaBrowserOpen: false,
  jellyfinBrowserOpen: false,
  meridianViewerOpen: false,
  meridianBrowserOpen: false,
  iptvPlayerOpen: false,
  financeOpen: false,
  schedulerOpen: false,
  securityOpen:  false,
  vaultOpen: false,
  userMgmtOpen: false,
  halcyonOptIn: localStorage.getItem('halcyon_opt_in') === 'true',
  contextHistoryDepth: 6,
  ctxComputedCount: null,
  ctxOverrideActive: false,
  configOptimal: null,
  visionCapability: null,
  licenseUsername: null,
  licenseChecked: false,

  setActiveThread: (id) => set((s) => ({
    activeThreadId: id,
    imageGenerating: false,
    imageGenStatus: '',
    taskProgress: null,
    liveActivity: null,
    messages: s.activeThreadId && s.activeThreadId !== id
      ? { ...s.messages, [s.activeThreadId]: [] }
      : s.messages,
  })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  cycleCopilot: () => set((s) => {
    const next: Record<string, 'hidden' | 'compact' | 'expanded'> = {
      hidden: 'compact', compact: 'expanded', expanded: 'hidden',
    };
    return { copilotMode: next[s.copilotMode] };
  }),
  expandCopilot: () => set({ copilotMode: 'expanded' }),
  hideCopilot: () => set({ copilotMode: 'hidden' }),
  toggleThinking: () => set((s) => ({ thinkingOpen: !s.thinkingOpen })),
  addMessage: (threadId, message) =>
    set((s) => {
      const existing = s.messages[threadId] || [];
      if (message.role === 'coordinator') {
        const isDupe = existing.some(
          (m) => m.role === 'coordinator' && m.content === message.content
        );
        if (isDupe) return s;
      }
      return {
        messages: {
          ...s.messages,
          [threadId]: [...existing, message],
        },
      };
    }),
  addThread: (thread) =>
    set((s) => ({
      threads: [thread, ...s.threads],
      activeThreadId: thread.id,
      liveActivity: null,
      taskProgress: null,
    })),
  updateDocument: (key, value) =>
    set((s) => ({ documents: { ...s.documents, [key]: value } })),
  setThreads: (threads) => set({ threads }),
  setMessages: (threadId, messages) =>
    set((s) => {
      const seen = new Set<string>();
      const deduped = messages.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      return { messages: { ...s.messages, [threadId]: deduped } };
    }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setModelNames: (names) => set({ modelNames: names }),
  setModelConfig: (config) => set({ modelConfig: config }),
  /** Replace all segments for a thread. Called by poll loop and by useThreadMessages on load.
   *  Bails out without emitting a new state object if the segment list is identical by
   *  length + last-id check AND no segment is live — prevents reference churn from
   *  triggering render loops while still letting in-progress token appends write through. */
  setSegments: (threadId, segments) =>
    set((s) => {
      const existing = s.segments[threadId];
      if (existing === segments) return s;
      const hasLive = segments.some((seg) => seg.live);
      if (
        !hasLive &&
        existing?.length === segments.length &&
        segments.length > 0 &&
        existing[existing.length - 1]?.id === segments[segments.length - 1]?.id
      ) return s;
      return { segments: { ...s.segments, [threadId]: segments } };
    }),
  setTaskProgress: (progress) => set({ taskProgress: progress }),
  setLiveActivity: (label) => set((s) => ({
    liveActivity: { label, log: [...(s.liveActivity?.log ?? []), label] },
  })),
  clearLiveActivity: () => set({ liveActivity: null }),
  setWorkspaceIndex: (threadId, files) =>
    set((s) => ({
      workspaceIndex: { ...s.workspaceIndex, [threadId]: files },
    })),
  addMediaFile: (threadId, file) =>
    set((s) => {
      const existing = s.mediaFiles[threadId] ?? [];
      if (existing.some((f) => f.filename === file.filename)) return s;
      return { mediaFiles: { ...s.mediaFiles, [threadId]: [...existing, file] } };
    }),
  setMediaFiles: (threadId, files) =>
    set((s) => ({ mediaFiles: { ...s.mediaFiles, [threadId]: files } })),
  setImageGenerating: (generating, status = '') =>
    set({ imageGenerating: generating, imageGenStatus: status }),
  deleteThread: (id) =>
    set((s) => {
      const newThreads = s.threads.filter((t) => t.id !== id);
      const newMessages = { ...s.messages };
      delete newMessages[id];
      const newSegments = { ...s.segments };
      delete newSegments[id];
      return {
        threads: newThreads,
        messages: newMessages,
        segments: newSegments,
        activeThreadId: s.activeThreadId === id ? (newThreads[0]?.id ?? '') : s.activeThreadId,
      };
    }),
  addProjectDoc: (doc) =>
    set((s) => ({ projectDocs: [...s.projectDocs, doc] })),
  updateProjectDoc: (id, updates) =>
    set((s) => ({
      projectDocs: s.projectDocs.map((d) => (d.id === id ? { ...d, ...updates } : d)),
    })),
  deleteProjectDoc: (id) =>
    set((s) => ({ projectDocs: s.projectDocs.filter((d) => d.id !== id) })),
  setProjectDocs: (docs) => set({ projectDocs: docs }),
  updateThreadProject: (threadId, projectId) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, projectName: projectId } : t)),
    })),
  updateThreadTitle: (threadId, title) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
    })),
  setBackendAlive: (alive) => set({ backendAlive: alive }),
  setBootPhase: (phase) => set({ bootPhase: phase }),
  setVersionMismatch: (mismatch, coreVersion) => set({
    versionMismatch: mismatch,
    ...(coreVersion !== undefined ? { coreVersion } : {}),
  }),
  setAgentState: (role, state, detail) =>
    set((s) => ({
      agentStates: { ...s.agentStates, [role]: state === 'idle' && !detail ? null : { state, detail } },
    })),
  clearAgentStates: () => set({ agentStates: { sayon: null, seren: null } }),
  togglePhobosLLMPanel: () => set((s) => ({ phobosLLMPanelOpen: !s.phobosLLMPanelOpen })),
  toggleImageEditor: () => set(state => ({ imageEditorOpen: !state.imageEditorOpen })),
  setImageEditorOpen: (open: boolean) => set({ imageEditorOpen: open }),
  toggleDawPanel: () => set((s) => ({ dawPanelOpen: !s.dawPanelOpen })),
  toggleMonacoPanel: () => set((s) => ({ monacoPanelOpen: !s.monacoPanelOpen })),
  toggleJoditPanel: () => set((s) => ({ joditPanelOpen: !s.joditPanelOpen })),
  toggleStirlingPanel: () => set((s) => ({ stirlingPanelOpen: !s.stirlingPanelOpen })),
  toggleVideosPanel: () => set((s) => ({ videosPanelOpen: !s.videosPanelOpen })),
  setMonacoOpenRequest: (r) => set({ monacoOpenRequest: r }),
  setJoditOpenRequest: (r) => set({ joditOpenRequest: r }),
  toggleModelsPanel: () => set((s) => ({ modelsPanelOpen: !s.modelsPanelOpen })),
  toggleWorldsPanel: () => set((s) => ({ worldsPanelOpen: !s.worldsPanelOpen })),
  toggleEditor3DPanel: () => set((s) => ({ editor3dPanelOpen: !s.editor3dPanelOpen })),
  toggleBlockbenchPanel: () => set((s) => ({ blockbenchPanelOpen: !s.blockbenchPanelOpen })),
  toggleSculptGLPanel: () => set((s) => ({ sculptglPanelOpen: !s.sculptglPanelOpen })),
  toggleGodotPanel: () => set((s) => ({ godotPanelOpen: !s.godotPanelOpen })),
  setPhobosCoins:    (coins)   => set({ phobosCoins: coins }),
  setGameFocused:    (focused) => set({ gameFocused: focused }),
  closeCreatePanels: () => set({
    imageEditorOpen:       false,
    dawPanelOpen:        false,
    monacoPanelOpen:     false,
    joditPanelOpen: false,
    stirlingPanelOpen:   false,
    videosPanelOpen:     false,
    modelsPanelOpen:     false,
    worldsPanelOpen:     false,
    editor3dPanelOpen: false,
    blockbenchPanelOpen: false,
    sculptglPanelOpen: false,
    godotPanelOpen: false,
  }),
  togglePolarisPlayer: () => set((s) => {
    const next = !s.polarisPlayerOpen;
    // Mirror to the shared Polaris playback store so the floating window
    // appears (or collapses back to the dock) when the user clicks the
    // sidebar's Music icon. The dock itself stays mounted regardless and
    // self-hides via its own view check.
    usePolarisPlaybackStore.setState({ view: next ? 'floating' : 'docked' });
    return { polarisPlayerOpen: next };
  }),
  toggleKavitaBrowser: () => set((s) => ({ kavitaBrowserOpen: !s.kavitaBrowserOpen })),
  toggleJellyfinBrowser: () => set((s) => ({ jellyfinBrowserOpen: !s.jellyfinBrowserOpen })),
  toggleMeridianViewer: () => set((s) => ({ meridianViewerOpen: !s.meridianViewerOpen })),
  toggleMeridianBrowser: () => set((s) => ({ meridianBrowserOpen: !s.meridianBrowserOpen })),
  toggleIptvPlayer: () => set((s) => ({ iptvPlayerOpen: !s.iptvPlayerOpen })),
  toggleFinancePanel: () => set((s) => ({ financeOpen: !s.financeOpen })),
  setSchedulerOpen: (open) => set({ schedulerOpen: open }),
  setSecurityOpen:  (open) => set({ securityOpen:  open }),
  setVaultOpen: (open) => set({ vaultOpen: open }),
  setUserMgmtOpen: (open) => set({ userMgmtOpen: open }),
  setHalcyonOptIn: (v) => {
    localStorage.setItem('halcyon_opt_in', String(v));
    set({ halcyonOptIn: v });
  },
  setContextHistoryDepth: (depth) => set({ contextHistoryDepth: Math.max(1, Math.min(20, depth)) }),
  setCtxComputedCount: (n) => set({ ctxComputedCount: n }),
  setCtxOverrideActive: (active) => set({ ctxOverrideActive: active }),
  setConfigOptimal: (v) => set({ configOptimal: v }),
  setVisionCapability: (v) => set({ visionCapability: v }),
  setLicenseUsername: (username) => set({ licenseUsername: username }),
  setLicenseChecked: (checked) => set({ licenseChecked: checked }),
}));