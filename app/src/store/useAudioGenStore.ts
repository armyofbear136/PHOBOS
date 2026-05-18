/**
 * useAudioGenStore.ts — State store for the AudioGen workflow panel.
 *
 * Mirrors the shape of useWorkflowStore but is intentionally simpler: there is
 * no server-side session object and no node graph. Audio generation is a single
 * one-shot request parameterised by the fields below. All params persist across
 * panel close/open within the same app session.
 *
 * Panel mutual exclusion: openPanel() calls useWorkflowStore.closePanel() so
 * the image/video workflow panel and the audio gen panel never coexist.
 */

import { create } from 'zustand';
import { useWorkflowStore } from './useWorkflowStore';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AudioGenTab = 'music' | 'clone';

export interface AudioGenProgress {
  phase:   string;
  pct:     number;
  step?:   number;
  total?:  number;
  message?: string;
}

export interface AudioGenOutput {
  path:      string;
  category:  'music' | 'tts';
  elapsedMs: number;
  // Decoded waveform for canvas rendering — populated by the panel after
  // AudioContext.decodeAudioData. Null until the panel decodes the WAV.
  waveform:  Float32Array | null;
}

// Clone steps type is constrained to the three F5-TTS presets
export type CloneSteps = 16 | 32 | 64;

// ── Store interface ───────────────────────────────────────────────────────────

interface AudioGenStore {
  panelOpen:  boolean;
  activeTab:  AudioGenTab;

  // Generation state
  generating: boolean;
  progress:   AudioGenProgress | null;
  lastOutput: AudioGenOutput | null;

  // Music params — preserved across panel close/reopen
  musicPrompt:   string;
  musicLyrics:   string;
  musicDuration: number;   // seconds, 5–120
  musicSeed:     number;   // -1 = random
  musicSteps:    number;   // DiT steps, default 50
  musicCfg:      number;   // guidance strength, default 7.0
  musicBackend:  'auto' | 'gpu' | 'cpu';  // GPU = Python ACEStepPipeline, CPU = C++ binaries

  // Voice clone params — preserved across panel close/reopen
  cloneText:     string;
  cloneRefData:  string | null;   // base64 WAV held in memory for the session
  cloneRefName:  string | null;   // display filename
  cloneRefWaveform: Float32Array | null;  // decoded ref audio for preview
  cloneRefText:  string;
  cloneSpeed:    number;          // 0.5–2.0, default 1.0
  cloneSteps:    CloneSteps;      // default 32

  // Actions
  openPanel:        (tab?: AudioGenTab) => void;
  closePanel:       () => void;
  setTab:           (tab: AudioGenTab) => void;
  setGenerating:    (v: boolean) => void;
  setProgress:      (v: AudioGenProgress | null) => void;
  setLastOutput:    (v: AudioGenOutput | null) => void;

  setMusicPrompt:   (v: string) => void;
  setMusicLyrics:   (v: string) => void;
  setMusicDuration: (v: number) => void;
  setMusicSeed:     (v: number) => void;
  setMusicSteps:    (v: number) => void;
  setMusicCfg:      (v: number) => void;
  setMusicBackend:  (v: 'auto' | 'gpu' | 'cpu') => void;

  setCloneText:     (v: string) => void;
  setCloneRef:      (data: string, name: string) => void;
  setCloneRefWaveform: (wf: Float32Array | null) => void;
  clearCloneRef:    () => void;
  setCloneRefText:  (v: string) => void;
  setCloneSpeed:    (v: number) => void;
  setCloneSteps:    (v: CloneSteps) => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAudioGenStore = create<AudioGenStore>((set) => ({
  panelOpen:  false,
  activeTab:  'music',

  generating: false,
  progress:   null,
  lastOutput: null,

  musicPrompt:   '',
  musicLyrics:   '',
  musicDuration: 30,
  musicSeed:     -1,
  musicSteps:    50,
  musicCfg:      7.0,
  musicBackend:  'auto',

  cloneText:        '',
  cloneRefData:     null,
  cloneRefName:     null,
  cloneRefWaveform: null,
  cloneRefText:     '',
  cloneSpeed:       1.0,
  cloneSteps:       32,

  openPanel: (tab) => {
    // Mutual exclusion with image/video workflow panel.
    // The static import is safe here — both stores are initialized before any
    // action fires, so there is no circular initialization issue.
    useWorkflowStore.getState().closePanel();
    set((s) => ({
      panelOpen: true,
      activeTab: tab ?? s.activeTab,
      // Clear stale generation state from a previous session
      generating: false,
      progress:   null,
    }));
  },

  closePanel:    () => set({ panelOpen: false, generating: false, progress: null }),
  setTab:        (tab)  => set({ activeTab: tab }),
  setGenerating: (v)    => set({ generating: v }),
  setProgress:   (v)    => set({ progress: v }),
  setLastOutput: (v)    => set({ lastOutput: v }),

  setMusicPrompt:   (v) => set({ musicPrompt:   v }),
  setMusicLyrics:   (v) => set({ musicLyrics:   v }),
  setMusicDuration: (v) => set({ musicDuration: Math.min(120, Math.max(5, v)) }),
  setMusicSeed:     (v) => set({ musicSeed:     v }),
  setMusicSteps:    (v) => set({ musicSteps:    v }),
  setMusicCfg:      (v) => set({ musicCfg:      v }),
  setMusicBackend:  (v) => set({ musicBackend:  v }),

  setCloneText:     (v) => set({ cloneText:    v }),
  setCloneRef:      (data, name) => set({ cloneRefData: data, cloneRefName: name, cloneRefWaveform: null }),
  setCloneRefWaveform: (wf) => set({ cloneRefWaveform: wf }),
  clearCloneRef:    ()  => set({ cloneRefData: null, cloneRefName: null, cloneRefWaveform: null, cloneRefText: '' }),
  setCloneRefText:  (v) => set({ cloneRefText: v }),
  setCloneSpeed:    (v) => set({ cloneSpeed:   Math.min(2.0, Math.max(0.5, v)) }),
  setCloneSteps:    (v) => set({ cloneSteps:   v }),
}));