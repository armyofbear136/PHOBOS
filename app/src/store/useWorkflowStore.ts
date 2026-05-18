import { create } from 'zustand';

// ── Types mirroring WorkflowEngine.ts (frontend-safe subset) ─────────────────

export type WorkflowNodeType =
  | 'Source'
  | 'Generate'
  | 'VarySeed'
  | 'Img2imgRefine'
  | 'KontextEdit'
  | 'FaceFix'
  | 'HandFix'
  | 'DepthControlNet'
  | 'RemoveBg'
  | 'Upscale'
  | 'VideoGenerate'
  | 'VideoFromImage'
  | 'MusicGenerate'
  | 'VoiceClone';

export interface WorkflowNode {
  id:            string;
  index:         number;
  type:          WorkflowNodeType;
  label?:        string;
  params:        Record<string, unknown>;
  paramSnapshot: Record<string, unknown> | null;
  outputPath:    string | null;
  maskPath:      string | null;
  depthPath:     string | null;
  executedAt:    string | null;
  stale:         boolean;
}

export interface WorkflowSession {
  workflowId:     string;
  name:           string;
  createdAt:      string;
  modelId:        string;
  workflowType:   'image' | 'video' | 'audio';
  nodes:          WorkflowNode[];
  threadId:       string;
  targetGpuIndex?: number;
  imageBackend?:   'auto' | 'pytorch' | 'sdcli';
  audioBackend?:   'auto' | 'gpu' | 'cpu';
}

export interface WorkflowIndexEntry {
  workflowId:   string;
  name:         string;
  createdAt:    string;
  modelId:      string;
  workflowType: 'image' | 'video' | 'audio';
  thumbPath:    string | null;
}

// Per-thread saved panel state — survives conversation switches
interface ThreadPanelState {
  workflowId:      string;
  activeNodeIndex: number;
}

// ── Store shape ───────────────────────────────────────────────────────────────

interface WorkflowState {
  panelOpen:        boolean;
  activeSession:    WorkflowSession | null;
  activeNodeIndex:  number;
  index:            Record<string, WorkflowIndexEntry[]>;
  generating:       Record<string, boolean>;
  progress:         Record<string, { nodeIndex: number; step: number; totalSteps: number } | null>;
  /** Live latent preview — base64 PNG per workflowId, null when not previewing */
  preview:          Record<string, string | null>;
  // Render phase log per workflowId — ordered list of completed/active phases
  renderPhases:     Record<string, { renderPhase: string; detail: string; done: boolean }[]>;
  revision:         number;
  threadPanelState: Record<string, ThreadPanelState>;

  openPanel:          (session: WorkflowSession) => void;
  closePanel:         () => void;
  setActiveNodeIndex: (index: number) => void;
  setSession:         (session: WorkflowSession) => void;
  updateNodeParams:   (nodeId: string, params: Record<string, unknown>) => void;
  setIndex:           (threadId: string, entries: WorkflowIndexEntry[]) => void;
  addIndexEntry:      (threadId: string, entry: WorkflowIndexEntry) => void;
  setGenerating:      (workflowId: string, generating: boolean) => void;
  setProgress:        (workflowId: string, progress: { nodeIndex: number; step: number; totalSteps: number } | null) => void;
  setPreview:         (workflowId: string, preview: string | null) => void;
  pushRenderPhase:    (workflowId: string, renderPhase: string, detail: string) => void;
  clearRenderPhases:  (workflowId: string) => void;
  markNodeDone:       (nodeIndex: number, outputPath: string) => void;
  markStale:          (fromIndex: number) => void;
  saveThreadState:    (threadId: string) => void;
  getThreadState:     (threadId: string) => ThreadPanelState | null;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  panelOpen:        false,
  activeSession:    null,
  activeNodeIndex:  0,
  index:            {},
  generating:       {},
  progress:         {},
  preview:          {},
  revision:         0,
  renderPhases:     {},
  threadPanelState: {},

  openPanel: (session) => set({
    panelOpen: true, activeSession: session, activeNodeIndex: 0,
  }),

  closePanel: () => set((s) => {
    if (s.activeSession) {
      const tid = s.activeSession.threadId;
      return {
        panelOpen: false,
        threadPanelState: {
          ...s.threadPanelState,
          [tid]: { workflowId: s.activeSession.workflowId, activeNodeIndex: s.activeNodeIndex },
        },
      };
    }
    return { panelOpen: false };
  }),

  setActiveNodeIndex: (index) => set({ activeNodeIndex: index }),

  setSession: (session) => set((s) => ({ activeSession: session, revision: s.revision + 1 })),

  updateNodeParams: (nodeId, params) =>
    set((s) => {
      if (!s.activeSession) return {};
      return {
        activeSession: {
          ...s.activeSession,
          nodes: s.activeSession.nodes.map((n) =>
            n.id === nodeId ? { ...n, params } : n
          ),
        },
      };
    }),

  setIndex: (threadId, entries) =>
    set((s) => ({ index: { ...s.index, [threadId]: entries }, revision: s.revision + 1 })),

  addIndexEntry: (threadId, entry) =>
    set((s) => {
      const existing = s.index[threadId] ?? [];
      const filtered = existing.filter((e) => e.workflowId !== entry.workflowId);
      return { index: { ...s.index, [threadId]: [...filtered, entry] } };
    }),

  setGenerating: (workflowId, generating) =>
    set((s) => ({ generating: { ...s.generating, [workflowId]: generating } })),

  setProgress: (workflowId, progress) =>
    set((s) => ({ progress: { ...s.progress, [workflowId]: progress } })),

  setPreview: (workflowId, preview) =>
    set((s) => ({ preview: { ...s.preview, [workflowId]: preview } })),

  pushRenderPhase: (workflowId, renderPhase, detail) =>
    set((s) => {
      const existing = s.renderPhases[workflowId] ?? [];
      // Mark previous phases as done
      const updated = existing.map(p => ({ ...p, done: true }));
      updated.push({ renderPhase, detail, done: false });
      return { renderPhases: { ...s.renderPhases, [workflowId]: updated } };
    }),

  clearRenderPhases: (workflowId) =>
    set((s) => ({ renderPhases: { ...s.renderPhases, [workflowId]: [] } })),

  markNodeDone: (nodeIndex, outputPath) =>
    set((s) => {
      if (!s.activeSession) return {};
      return {
        revision: s.revision + 1,
        activeSession: {
          ...s.activeSession,
          nodes: s.activeSession.nodes.map((n) =>
            n.index === nodeIndex
              ? { ...n, outputPath, stale: false, executedAt: new Date().toISOString(), paramSnapshot: n.params }
              : n
          ),
        },
      };
    }),

  markStale: (fromIndex) =>
    set((s) => {
      if (!s.activeSession) return {};
      return {
        activeSession: {
          ...s.activeSession,
          nodes: s.activeSession.nodes.map((n) =>
            n.index >= fromIndex ? { ...n, stale: true } : n
          ),
        },
      };
    }),

  saveThreadState: (threadId) =>
    set((s) => {
      if (!s.activeSession || s.activeSession.threadId !== threadId) return {};
      return {
        threadPanelState: {
          ...s.threadPanelState,
          [threadId]: { workflowId: s.activeSession.workflowId, activeNodeIndex: s.activeNodeIndex },
        },
      };
    }),

  getThreadState: (threadId) => {
    return get().threadPanelState[threadId] ?? null;
  },
}));