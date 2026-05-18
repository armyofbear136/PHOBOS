import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Types — mirror the backend shapes ────────────────────────────────────────

export interface GpuDevice {
  index: number;
  name: string;
  vramGb: number;
  backend: 'cuda' | 'vulkan' | 'metal';
}

export interface HardwareProfile {
  ramGb: number;
  cpuCores: number;
  cpuName: string;
  gpus: GpuDevice[];
}

export interface GGUFSpec {
  modelId: string;
  label: string;
  family: string;
  role: 'sayon' | 'seren' | 'both';
  thinkingTokens: boolean;
  sizeBytes: number;
  ramRequiredGb: number;
  contextWindow: number;
  legacy?: boolean;
  activeParamsB?: number;
  sayonQuality?: number;
  serenQuality?: number;
  speedClass?: 'fast' | 'medium' | 'slow';
  license: string;
  licenseUrl: string;
}

export interface ModelRecommendation {
  sayon: GGUFSpec;
  seren: GGUFSpec;
  sayonDevice: 'cpu' | number;
  serenDevice: 'cpu' | number;
  sayonGpuLayers: number;
  serenGpuLayers: number;
  reasoning: string;
  sayonScore?: number;
  serenScore?: number;
}

export interface DownloadProgress {
  phase: 'sayon' | 'seren' | 'complete';
  modelId?: string;
  bytesReceived: number;
  bytesTotal: number;
  done: boolean;
  installing?: boolean;
  error?: string;
}

export interface PhobosServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  modelId: string;
  port: number;
  error: string | null;
  deviceIndex?: number;
  gpuBackend?: string;
}

// ── Download state machine ────────────────────────────────────────────────────

export type DownloadStage =
  | { kind: 'idle' }
  | { kind: 'downloading'; sayon: DownloadProgress | null; seren: DownloadProgress | null; queueRemaining: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

// ── Queries ───────────────────────────────────────────────────────────────────

export function usePhobosHardware() {
  return useQuery<{ hardware: HardwareProfile; recommendation: ModelRecommendation }>({
    queryKey: ['phobos', 'hardware'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/hardware`);
      if (!res.ok) throw new Error(`Hardware detect failed: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 1,
  });
}

type DownloadedModelsResponse = { models: Array<{ modelId: string; label: string; sizeBytes: number }> };

export function usePhobosDownloadedModels() {
  return useQuery<DownloadedModelsResponse>({
    queryKey: ['phobos', 'models'],
    queryFn: async (): Promise<DownloadedModelsResponse> => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models`);
      if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
      return res.json() as Promise<DownloadedModelsResponse>;
    },
    staleTime: 0,              // Always refetch on invalidation — instant availability after download
    placeholderData: keepPreviousData,  // Keep showing old data during refetch so UI doesn't flash
    retry: 1,
  });
}

export function usePhobosServerStatus() {
  return useQuery<{ status: Record<'sayon' | 'seren', PhobosServerStatus> }>({
    queryKey: ['phobos', 'serverStatus'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/status`);
      if (!res.ok) throw new Error(`Status failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 5_000,
    retry: 1,
  });
}

export function useModelsInfo() {
  return useQuery<{ path: string; totalBytes: number; overrides: Record<string, string> }>({
    queryKey: ['phobos', 'modelsInfo'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/info`);
      if (!res.ok) throw new Error('Failed to fetch models info');
      return res.json();
    },
    refetchInterval: 30_000,
    retry: 1,
  });
}

// ── Download hook ─────────────────────────────────────────────────────────────

export function usePhobosDownload() {
  const [downloadStage, setDownloadStage] = useState<DownloadStage>({ kind: 'idle' });
  const esRef       = useRef<EventSource | null>(null);
  const queueRef    = useRef<string[]>([]);
  const queryClient = useQueryClient();

  const processNext = useCallback(() => {
    const queue = queueRef.current;
    if (queue.length === 0) {
      queryClient.invalidateQueries({ queryKey: ['phobos', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
      setDownloadStage({ kind: 'done' });
      return;
    }

    // Take up to 2 from the queue
    const first  = queue.shift()!;
    const second = queue.length > 0 ? queue.shift()! : first;
    const remaining = queue.length;

    setDownloadStage({ kind: 'downloading', sayon: null, seren: null, queueRemaining: remaining });

    const url = `${ENGINE_URL}/api/phobos/download?sayon=${encodeURIComponent(first)}&seren=${encodeURIComponent(second)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev: MessageEvent) => {
      let data: DownloadProgress;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.phase === 'complete') {
        es.close();
        queryClient.invalidateQueries({ queryKey: ['phobos', 'models'] });
        queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
        // Auto-chain: process next pair in queue
        processNext();
        return;
      }

      if (data.error) {
        es.close();
        queueRef.current = [];
        setDownloadStage({ kind: 'error', message: `${data.phase}: ${data.error}` });
        return;
      }

      setDownloadStage((prev) => {
        if (prev.kind !== 'downloading') return prev;
        return {
          kind:           'downloading',
          sayon:          data.phase === 'sayon'  ? data : prev.sayon,
          seren:          data.phase === 'seren'  ? data : prev.seren,
          queueRemaining: prev.queueRemaining,
        };
      });
    };

    es.onerror = () => {
      es.close();
      queueRef.current = [];
      setDownloadStage((prev) =>
        prev.kind === 'downloading'
          ? { kind: 'error', message: 'Connection to backend lost during download.' }
          : prev
      );
    };
  }, [queryClient]);

  const startDownload = useCallback((modelIds: string[]) => {
    esRef.current?.close();
    queueRef.current = [...modelIds];
    processNext();
  }, [processNext]);

  const cancelDownload = useCallback(() => {
    esRef.current?.close();
    queueRef.current = [];
    setDownloadStage({ kind: 'idle' });
  }, []);

  const resetDownload = useCallback(() => {
    setDownloadStage({ kind: 'idle' });
  }, []);

  return { downloadStage, startDownload, cancelDownload, resetDownload };
}

// ── Server start mutation ─────────────────────────────────────────────────────

export async function startPhobosServers(
  sayon:   { modelId: string; gpuLayers: number; deviceIndex?: number; gpuBackend?: string },
  seren: { modelId: string; gpuLayers: number; deviceIndex?: number; gpuBackend?: string },
): Promise<{ ok: boolean; errors?: string[] }> {
  const res = await fetch(`${ENGINE_URL}/api/phobos/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sayon, seren }),
  });
  return res.json();
}

// ── Image model types ────────────────────────────────────────────────────────

export type ImageRunnerProfile = 'flux' | 'sdxl' | 'flux1-kontext' | 'flux2' | 'z-image' | 'qwen-image' | 'wan';
export type ImageModelCategory = 'realistic' | 'anime' | 'nsfw-realistic' | 'nsfw-anime' | 'legacy' | 'video' | 'kontext';

export interface ImageAuxStatus {
  id: string;
  label: string;
  sizeBytes: number;
  downloaded: boolean;
  license: string;
  licenseUrl: string;
  /** GPU names that use this aux file (T5 tier). Undefined for non-T5 files. */
  forGpus?: string[];
}

/** Backward-compat alias */
export type FluxAuxStatus = ImageAuxStatus;

export interface ImageModelProfile {
  defaultSteps:      number;
  defaultCfgScale:   number;
  defaultWidth:      number;
  defaultHeight:     number;
  defaultSampler:    string;
  defaultScheduler?: string;
  defaultNegative:   string;
  promptStyle:       'natural' | 'tags' | 'booru';
  sayonBrief:        string;
  supportsNegative:  boolean;
  supportsLoRA:      boolean;
  maxDimension:      number;
  nativeDimension:   number;
}

export interface GpuCompat {
  gpuIndex: number;
  gpuName: string;
  backend: string;
  vramMb: number;
  totalNeededMb: number;
  fits: boolean;
  vulkanBlocked: boolean;
  reason?: string;
}

export interface ImageModelStatus {
  modelId: string;
  label: string;
  displayName: string;
  runnerProfile: ImageRunnerProfile;
  category: ImageModelCategory;
  variant: string;
  quantization: string;
  sizeBytes: number;
  vramRequiredGb: number;
  license: string;
  licenseUrl: string;
  estSecondsCuda: number;
  estSecondsVulkan: number;
  downloaded: boolean;
  mainDownloaded: boolean;
  auxFiles: ImageAuxStatus[];
  /** T5 encoder id — only set for flux-profile models */
  recommendedT5?: string;
  totalDownloadBytes: number;
  /** Model generation profile — defaults for steps, sampler, dimensions, negative prompt */
  profile?: ImageModelProfile | null;
  /** Per-GPU VRAM compatibility — shows whether model fits each detected GPU */
  gpuCompat?: GpuCompat[];
  /**
   * True if a pre-converted diffusers directory exists for this model
   * (at ~/.phobos/models/image/pytorch/<modelId>/). When true, PyTorch loads
   * from_pretrained instead of from_single_file — faster and works with any
   * diffusers/transformers version. Only relevant for sdxl runner profile.
   */
  pytorchVariantReady?: boolean;
}

/** Backward-compat alias */
export type FluxRecommendation = ImageModelStatus;

export interface ImageCatalogueResponse {
  models: ImageModelStatus[];
  hardware: {
    totalVramGb: number;
    isUnifiedMemory: boolean;
    gpuName: string;
    backend: 'cuda' | 'vulkan' | 'metal' | 'cpu';
    gpus?: Array<{ index: number; name: string; vramGb: number; backend: string; unified: boolean }>;
  };
}

/** Backward-compat alias */
export type FluxStatusResponse = ImageCatalogueResponse;

export interface FluxDownloadProgress {
  fileId: string;
  phase: string;
  label: string;
  bytesReceived: number;
  bytesTotal: number;
  done: boolean;
  error?: string;
}

export type ImageDownloadStage =
  | { kind: 'idle' }
  | { kind: 'downloading'; current: FluxDownloadProgress | null; modelId: string }
  | { kind: 'done'; modelId: string }
  | { kind: 'error'; message: string };

/** Backward-compat alias */
export type FluxDownloadStage = ImageDownloadStage;

// ── Queries ───────────────────────────────────────────────────────────────────

export function useFluxStatus() {
  return useQuery<ImageCatalogueResponse>({
    queryKey: ['phobos', 'image', 'catalogue'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/image/catalogue`);
      if (!res.ok) throw new Error(`Image catalogue failed: ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** Convenience alias for new code */
export const useImageCatalogue = useFluxStatus;

// ── FLUX download hook ────────────────────────────────────────────────────────
// Supports single-model download (startFluxDownload) and multi-model queue
// (startFluxDownloadQueue). Queue processes models sequentially — when one
// completes, the next starts automatically.
// Also handles beforeunload prevention during active downloads.

export function useFluxDownload() {
  const [stage, setStage]   = useState<ImageDownloadStage>({ kind: 'idle' });
  const esRef               = useRef<EventSource | null>(null);
  const activeModelIdRef    = useRef<string | null>(null);
  const queueRef            = useRef<string[]>([]);
  // Tracks intentional close (complete or user cancel) so onerror doesn't
  // misreport the server-side stream end as a connection failure.
  const doneRef             = useRef(false);
  const queryClient         = useQueryClient();

  // ── beforeunload: prevent accidental tab close during download ────────────
  useEffect(() => {
    if (stage.kind !== 'downloading') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore custom messages but still show a confirmation dialog
      e.returnValue = 'A model download is in progress. Are you sure you want to leave?';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stage.kind]);

  // ── Core download function (downloads one model via SSE) ──────────────────
  const downloadOne = useCallback((modelId: string) => {
    esRef.current?.close();
    doneRef.current = false;
    activeModelIdRef.current = modelId;
    setStage({ kind: 'downloading', current: null, modelId });

    const es = new EventSource(`${ENGINE_URL}/api/phobos/image/download?modelId=${encodeURIComponent(modelId)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const data: FluxDownloadProgress = JSON.parse(e.data);
      if (data.phase === 'complete') {
        doneRef.current = true;
        activeModelIdRef.current = null;
        es.close();
        queryClient.invalidateQueries({ queryKey: ['phobos', 'image', 'catalogue'] });

        // Auto-chain: if queue has more models, start next one
        if (queueRef.current.length > 0) {
          const next = queueRef.current.shift()!;
          // Small delay so the UI can flash "done" briefly before starting next
          setTimeout(() => downloadOne(next), 500);
        } else {
          setStage({ kind: 'done', modelId });
        }
        return;
      }
      if (data.error) {
        doneRef.current = true;
        activeModelIdRef.current = null;
        queueRef.current = []; // clear queue on error
        es.close();
        setStage({ kind: 'error', message: data.error });
        return;
      }
      setStage({ kind: 'downloading', current: data, modelId });
    };

    es.onerror = () => {
      if (doneRef.current) return;
      activeModelIdRef.current = null;
      queueRef.current = []; // clear queue on connection loss
      es.close();
      setStage((prev) =>
        prev.kind === 'downloading'
          ? { kind: 'error', message: 'Connection lost during download.' }
          : prev
      );
    };
  }, [queryClient]);

  // ── Public API ────────────────────────────────────────────────────────────

  /** Download a single image model (+ its aux files). */
  const startFluxDownload = useCallback((modelId: string) => {
    queueRef.current = [];
    downloadOne(modelId);
  }, [downloadOne]);

  /** Queue multiple image models for sequential download. */
  const startFluxDownloadQueue = useCallback((modelIds: string[]) => {
    if (modelIds.length === 0) return;
    queueRef.current = modelIds.slice(1); // everything after the first goes in queue
    downloadOne(modelIds[0]);             // start the first immediately
  }, [downloadOne]);

  const cancelFluxDownload = useCallback(() => {
    doneRef.current = true;
    queueRef.current = []; // clear the queue on cancel
    esRef.current?.close();
    const id = activeModelIdRef.current;
    if (id) {
      fetch(`${ENGINE_URL}/api/phobos/image/download/cancel?modelId=${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(() => { /* cleanup is best-effort */ });
    }
    activeModelIdRef.current = null;
    setStage({ kind: 'idle' });
  }, []);

  const resetFluxDownload = useCallback(() => {
    setStage({ kind: 'idle' });
  }, []);

  return { stage, startFluxDownload, startFluxDownloadQueue, cancelFluxDownload, resetFluxDownload };
}

export async function deleteFluxModel(modelId: string): Promise<void> {
  const res = await fetch(`${ENGINE_URL}/api/phobos/image/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
  if (res.status === 409) {
    throw new Error('Cannot delete while a download is in progress');
  }
}

/** Alias */
export const deleteImageModel = deleteFluxModel;

// ── PyTorch variant conversion hook ───────────────────────────────────────────
// Connects to /api/phobos/image/convert?modelId=<id> via SSE.
// Shares the _anyDownloadActive lock so nothing else can run concurrently.

export type ConvertStage =
  | { kind: 'idle' }
  | { kind: 'converting'; pct: number; label: string; modelId: string }
  | { kind: 'done'; modelId: string }
  | { kind: 'error'; message: string; modelId: string };

export function useImageConvert() {
  const [stage, setStage] = useState<ConvertStage>({ kind: 'idle' });
  const esRef             = useRef<EventSource | null>(null);
  const doneRef           = useRef(false);
  const queryClient       = useQueryClient();

  // Prevent accidental tab close during conversion
  useEffect(() => {
    if (stage.kind !== 'converting') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'A PyTorch conversion is in progress. Leaving will corrupt the output.';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stage.kind]);

  const startConvert = useCallback((modelId: string) => {
    esRef.current?.close();
    doneRef.current = false;
    setStage({ kind: 'converting', pct: 0, label: 'Starting conversion…', modelId });

    const es = new EventSource(`${ENGINE_URL}/api/phobos/image/convert?modelId=${encodeURIComponent(modelId)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const data: { phase: string; pct: number; label: string; message?: string } = JSON.parse(e.data);

      if (data.phase === 'done') {
        doneRef.current = true;
        es.close();
        // Invalidate catalogue so pytorchVariantReady refreshes on all cards
        queryClient.invalidateQueries({ queryKey: ['phobos', 'image', 'catalogue'] });
        setStage({ kind: 'done', modelId });
        return;
      }
      if (data.phase === 'error') {
        doneRef.current = true;
        es.close();
        setStage({ kind: 'error', message: data.message ?? 'Conversion failed', modelId });
        return;
      }
      setStage({ kind: 'converting', pct: data.pct ?? 0, label: data.label ?? '', modelId });
    };

    es.onerror = () => {
      if (doneRef.current) return;
      es.close();
      setStage((prev) =>
        prev.kind === 'converting'
          ? { kind: 'error', message: 'Connection lost during conversion.', modelId: prev.modelId }
          : prev
      );
    };
  }, [queryClient]);

  const cancelConvert = useCallback(() => {
    doneRef.current = true;
    esRef.current?.close();
    // Best-effort abort — server will notice the SSE connection dropped
    if (stage.kind === 'converting') {
      fetch(`${ENGINE_URL}/api/phobos/image/convert/cancel?modelId=${encodeURIComponent(stage.modelId)}`, { method: 'DELETE' })
        .catch(() => { /* best-effort */ });
    }
    setStage({ kind: 'idle' });
  }, [stage]);

  const resetConvert = useCallback(() => {
    setStage({ kind: 'idle' });
  }, []);

  return { stage, startConvert, cancelConvert, resetConvert };
}

// ── ESRGAN upscale models ─────────────────────────────────────────────────────

export interface EsrganModelInfo {
  id:         string;
  label:      string;
  filename:   string;
  sizeBytes:  number;
  downloaded: boolean;
}

export function useEsrganModels() {
  return useQuery<{ models: EsrganModelInfo[] }>({
    queryKey: ['phobos', 'esrgan', 'models'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/upscale/models`);
      if (!res.ok) throw new Error(`ESRGAN catalogue failed: ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export type EsrganDownloadStage =
  | { kind: 'idle' }
  | { kind: 'downloading'; id: string; bytesReceived: number; bytesTotal: number }
  | { kind: 'done'; id: string }
  | { kind: 'error'; message: string };

export function useEsrganDownload() {
  const [stage, setStage] = useState<EsrganDownloadStage>({ kind: 'idle' });
  const esRef             = useRef<EventSource | null>(null);
  const doneRef           = useRef(false);
  const queryClient       = useQueryClient();

  const startDownload = useCallback((id: string) => {
    esRef.current?.close();
    doneRef.current = false;
    setStage({ kind: 'downloading', id, bytesReceived: 0, bytesTotal: 0 });

    const es = new EventSource(`${ENGINE_URL}/api/phobos/upscale/download?id=${encodeURIComponent(id)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.done || data.phase === 'complete') {
        doneRef.current = true;
        es.close();
        setStage({ kind: 'done', id });
        queryClient.invalidateQueries({ queryKey: ['phobos', 'esrgan', 'models'] });
        return;
      }
      if (data.error) {
        doneRef.current = true;
        es.close();
        setStage({ kind: 'error', message: data.error });
        return;
      }
      setStage({ kind: 'downloading', id, bytesReceived: data.bytesReceived ?? 0, bytesTotal: data.bytesTotal ?? 0 });
    };

    es.onerror = () => {
      if (doneRef.current) return;
      es.close();
      setStage({ kind: 'error', message: 'Connection lost during download.' });
    };
  }, [queryClient]);

  const reset = useCallback(() => {
    doneRef.current = true;
    esRef.current?.close();
    setStage({ kind: 'idle' });
  }, []);

  return { stage, startDownload, reset };
}

export async function deleteEsrganModel(id: string): Promise<void> {
  await fetch(`${ENGINE_URL}/api/phobos/upscale/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Audio model download hook ─────────────────────────────────────────────────
// Downloads a single audio model via GET SSE, queues additional requests serially.
// Mirrors useFluxDownload: EventSource transport, doneRef sentinel, queue chaining.

export interface AudioDownloadProgress {
  type: 'progress' | 'done' | 'error';
  bytesReceived?: number;
  bytesTotal?: number;
  pct?: number;
  message?: string;
}

export type AudioDownloadStage =
  | { kind: 'idle' }
  | { kind: 'downloading'; modelId: string; bytesReceived: number; bytesTotal: number; pct: number }
  | { kind: 'done'; modelId: string }
  | { kind: 'error'; message: string };

export function useAudioDownload() {
  const [stage, setStage]       = useState<AudioDownloadStage>({ kind: 'idle' });
  const esRef                   = useRef<EventSource | null>(null);
  const activeModelIdRef        = useRef<string | null>(null);
  const queueRef                = useRef<string[]>([]);
  // Sentinel: true when we closed the EventSource intentionally (done or cancel),
  // so onerror doesn't misreport a clean server-close as a connection failure.
  const doneRef                 = useRef(false);

  // ── beforeunload: prevent accidental tab close during download ────────────
  useEffect(() => {
    if (stage.kind !== 'downloading') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'An audio model download is in progress. Are you sure you want to leave?';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stage.kind]);

  // ── Core: download one audio model via SSE, then chain to next in queue ───
  const downloadOne = useCallback((modelId: string) => {
    esRef.current?.close();
    doneRef.current = false;
    activeModelIdRef.current = modelId;
    setStage({ kind: 'downloading', modelId, bytesReceived: 0, bytesTotal: 0, pct: 0 });

    const es = new EventSource(
      `${ENGINE_URL}/api/phobos/audio-model/download?modelId=${encodeURIComponent(modelId)}`,
    );
    esRef.current = es;

    es.onmessage = (e: MessageEvent) => {
      let data: AudioDownloadProgress;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.type === 'done') {
        doneRef.current = true;
        activeModelIdRef.current = null;
        es.close();
        if (queueRef.current.length > 0) {
          const next = queueRef.current.shift()!;
          setTimeout(() => downloadOne(next), 500);
        } else {
          setStage({ kind: 'done', modelId });
        }
        return;
      }
      if (data.type === 'error') {
        doneRef.current = true;
        activeModelIdRef.current = null;
        queueRef.current = [];
        es.close();
        setStage({ kind: 'error', message: data.message ?? 'Download failed' });
        return;
      }
      // progress
      setStage({
        kind:          'downloading',
        modelId,
        bytesReceived: data.bytesReceived ?? 0,
        bytesTotal:    data.bytesTotal    ?? 0,
        pct:           data.pct           ?? 0,
      });
    };

    es.onerror = () => {
      if (doneRef.current) return;
      activeModelIdRef.current = null;
      queueRef.current = [];
      es.close();
      setStage((prev) =>
        prev.kind === 'downloading'
          ? { kind: 'error', message: 'Connection lost during audio model download.' }
          : prev,
      );
    };
  }, []);

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start downloading one audio model immediately. */
  const startDownload = useCallback((modelId: string) => {
    queueRef.current = [];
    downloadOne(modelId);
  }, [downloadOne]);

  /** Queue multiple audio models for sequential download. */
  const startDownloadQueue = useCallback((modelIds: string[]) => {
    if (modelIds.length === 0) return;
    queueRef.current = modelIds.slice(1);
    downloadOne(modelIds[0]);
  }, [downloadOne]);

  const cancelDownload = useCallback(() => {
    doneRef.current = true;
    queueRef.current = [];
    esRef.current?.close();
    activeModelIdRef.current = null;
    setStage({ kind: 'idle' });
  }, []);

  const resetDownload = useCallback(() => {
    setStage({ kind: 'idle' });
  }, []);

  return { stage, startDownload, startDownloadQueue, cancelDownload, resetDownload };
}

// ── Auto-config ──────────────────────────────────────────────────────────────

export interface AutoConfigPlan {
  recommendation: ModelRecommendation;
  imageModel:  { modelId: string; displayName: string; sizeBytes: number; vramRequiredGb: number } | null;
  videoModel:  { modelId: string; displayName: string; sizeBytes: number; vramRequiredGb: number } | null;
  llmNeeded:   string[];
  imageNeeded: string[];
  cleanupCandidates: { modelId: string; label: string; sizeBytes: number }[];
  readyToLaunch: boolean;
}

export type AutoConfigPhase =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'confirming'; plan: AutoConfigPlan }
  | { kind: 'cleanup'; plan: AutoConfigPlan }
  | { kind: 'downloading-llm'; plan: AutoConfigPlan; progress: DownloadProgress | null }
  | { kind: 'downloading-image'; plan: AutoConfigPlan; modelId: string; progress: FluxDownloadProgress | null }
  | { kind: 'starting'; plan: AutoConfigPlan }
  | { kind: 'done'; plan: AutoConfigPlan }
  | { kind: 'error'; message: string };

export function useAutoConfig() {
  const [phase, setPhase]   = useState<AutoConfigPhase>({ kind: 'idle' });
  const esRef               = useRef<EventSource | null>(null);
  const queryClient         = useQueryClient();
  // Track intentional close so onerror doesn't misreport
  const doneRef             = useRef(false);

  /** Step 1: Fetch the plan from the backend */
  const fetchPlan = useCallback(async () => {
    setPhase({ kind: 'planning' });
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/auto-config`, { method: 'POST' });
      if (!res.ok) throw new Error(`Auto-config failed: ${res.status}`);
      const plan: AutoConfigPlan = await res.json();
      setPhase({ kind: 'confirming', plan });
      return plan;
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to compute config' });
      return null;
    }
  }, []);

  /** Step 2: Run cleanup (delete unused LLM models, stops servers if needed) */
  const runCleanup = useCallback(async (plan: AutoConfigPlan, cleanupIds: string[]) => {
    if (cleanupIds.length === 0) return true;
    setPhase({ kind: 'cleanup', plan });
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelIds: cleanupIds }),
      });
      if (!res.ok) throw new Error(`Cleanup failed: ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ['phobos', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
      return true;
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Cleanup failed' });
      return false;
    }
  }, [queryClient]);

  /** Step 3: Download LLM models via existing SSE endpoint */
  const downloadLlms = useCallback((plan: AutoConfigPlan): Promise<boolean> => {
    return new Promise((resolve) => {
      if (plan.llmNeeded.length === 0) { resolve(true); return; }
      setPhase({ kind: 'downloading-llm', plan, progress: null });
      doneRef.current = false;

      // The SSE endpoint takes sayon + seren params. If only one is needed,
      // pass it as both — the backend skips the duplicate.
      const first  = plan.llmNeeded[0];
      const second = plan.llmNeeded.length > 1 ? plan.llmNeeded[1] : first;
      const url = `${ENGINE_URL}/api/phobos/download?sayon=${encodeURIComponent(first)}&seren=${encodeURIComponent(second)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (ev: MessageEvent) => {
        let data: DownloadProgress;
        try { data = JSON.parse(ev.data); } catch { return; }

        if (data.phase === 'complete') {
          doneRef.current = true;
          es.close();
          queryClient.invalidateQueries({ queryKey: ['phobos', 'models'] });
          queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
          resolve(true);
          return;
        }
        if (data.error) {
          doneRef.current = true;
          es.close();
          setPhase({ kind: 'error', message: `LLM download: ${data.error}` });
          resolve(false);
          return;
        }
        setPhase({ kind: 'downloading-llm', plan, progress: data });
      };

      es.onerror = () => {
        if (doneRef.current) return;
        es.close();
        setPhase({ kind: 'error', message: 'Connection lost during LLM download.' });
        resolve(false);
      };
    });
  }, [queryClient]);

  /** Step 4: Download image/video models sequentially via existing SSE endpoint */
  const downloadImageModels = useCallback(async (plan: AutoConfigPlan): Promise<boolean> => {
    for (const modelId of plan.imageNeeded) {
      const ok = await new Promise<boolean>((resolve) => {
        setPhase({ kind: 'downloading-image', plan, modelId, progress: null });
        doneRef.current = false;

        const es = new EventSource(`${ENGINE_URL}/api/phobos/image/download?modelId=${encodeURIComponent(modelId)}`);
        esRef.current = es;

        es.onmessage = (ev: MessageEvent) => {
          const data: FluxDownloadProgress = JSON.parse(ev.data);
          if (data.phase === 'complete') {
            doneRef.current = true;
            es.close();
            queryClient.invalidateQueries({ queryKey: ['phobos', 'image', 'catalogue'] });
            resolve(true);
            return;
          }
          if (data.error) {
            doneRef.current = true;
            es.close();
            setPhase({ kind: 'error', message: `Image download (${modelId}): ${data.error}` });
            resolve(false);
            return;
          }
          setPhase({ kind: 'downloading-image', plan, modelId, progress: data });
        };

        es.onerror = () => {
          if (doneRef.current) return;
          es.close();
          setPhase({ kind: 'error', message: `Connection lost during image download (${modelId}).` });
          resolve(false);
        };
      });
      if (!ok) return false;
    }
    return true;
  }, [queryClient]);

  /** Step 5: Start servers with recommended config */
  const launchServers = useCallback(async (plan: AutoConfigPlan, gpus: GpuDevice[]): Promise<boolean> => {
    setPhase({ kind: 'starting', plan });
    const rec = plan.recommendation;
    const sayonGpuLayers = rec.sayonDevice !== 'cpu' ? 99 : 0;
    const serenGpuLayers = rec.serenDevice !== 'cpu' ? 99 : 0;
    const sayonGpu = rec.sayonDevice !== 'cpu' ? gpus.find(g => g.index === rec.sayonDevice) : null;
    const serenGpu = rec.serenDevice !== 'cpu' ? gpus.find(g => g.index === rec.serenDevice) : null;

    try {
      const result = await startPhobosServers(
        { modelId: rec.sayon.modelId, gpuLayers: sayonGpuLayers, deviceIndex: rec.sayonDevice !== 'cpu' ? rec.sayonDevice : undefined, gpuBackend: sayonGpu?.backend },
        { modelId: rec.seren.modelId, gpuLayers: serenGpuLayers, deviceIndex: rec.serenDevice !== 'cpu' ? rec.serenDevice : undefined, gpuBackend: serenGpu?.backend },
      );
      if (!result.ok) {
        setPhase({ kind: 'error', message: result.errors?.join('; ') ?? 'Server start failed' });
        return false;
      }
      setPhase({ kind: 'done', plan });
      return true;
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Server start failed' });
      return false;
    }
  }, []);

  /**
   * Full auto-config orchestrator.
   * Called after user confirms the plan from the confirming dialog.
   * cleanupIds = the subset of cleanupCandidates the user chose to remove.
   */
  const execute = useCallback(async (plan: AutoConfigPlan, cleanupIds: string[], gpus: GpuDevice[]) => {
    // 1. Cleanup unused LLM models
    if (!(await runCleanup(plan, cleanupIds))) return;
    // 2. Download needed LLM models
    if (!(await downloadLlms(plan))) return;
    // 3. Download needed image/video models
    if (!(await downloadImageModels(plan))) return;
    // 4. Launch servers
    await launchServers(plan, gpus);
    queryClient.invalidateQueries({ queryKey: ['phobos'] });
  }, [runCleanup, downloadLlms, downloadImageModels, launchServers, queryClient]);

  const cancel = useCallback(() => {
    doneRef.current = true;
    esRef.current?.close();
    setPhase({ kind: 'idle' });
  }, []);

  const reset = useCallback(() => {
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, fetchPlan, execute, cancel, reset };
}

// ── Model path management hooks ───────────────────────────────────────────────

export interface ScannedMatch {
  ns:        'llm' | 'img';
  modelId:   string;
  label:     string;
  absPath:   string;
  sizeBytes: number;
}

export interface ScanResult {
  matches:    ScannedMatch[];
  totalKnown: number;
}

/**
 * Lazily scan a folder for known model files.
 * Only fires when folderPath is non-empty. Results are used for the
 * ChangeFolderDialog preview before committing any path change.
 */
export function useScanFolder(folderPath: string) {
  return useQuery<ScanResult>({
    queryKey: ['phobos', 'scanFolder', folderPath],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/scan-folder`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ folderPath }),
      });
      if (!res.ok) throw new Error('Scan failed');
      return res.json();
    },
    enabled: folderPath.trim().length > 0,
    staleTime: 10_000,
    retry: 0,
  });
}

/**
 * Set the models base path. Optionally applies overrides from a scan of the
 * new folder so existing models are linked without re-download.
 * Invalidates modelsInfo + both catalogues on success.
 */
export function useSetBasePath() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const setBasePath = useCallback(async (
    folderPath: string,
    applyOverridesFromScan = true,
  ): Promise<{ matchCount: number } | null> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/base-path`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ folderPath, applyOverridesFromScan }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Failed to set base path');
      }
      const data = await res.json() as { matchCount: number };
      queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'catalogue'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'imageCatalogue'] });
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPending(false);
    }
  }, [queryClient]);

  return { setBasePath, pending, error };
}

/**
 * Resync — clears all overrides then re-scans the current base folder to
 * rebuild them. Use after the user has manually dropped files into the folder.
 */
export function useResync() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const resync = useCallback(async (): Promise<{ matchCount: number } | null> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/resync`, { method: 'POST' });
      if (!res.ok) throw new Error('Resync failed');
      const data = await res.json() as { matchCount: number };
      queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'catalogue'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'imageCatalogue'] });
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setPending(false);
    }
  }, [queryClient]);

  return { resync, pending, error };
}

/**
 * Manually map a single model to an absolute file path.
 * Validates file existence + size on the backend before writing.
 */
export function useSetModelOverride() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const setOverride = useCallback(async (
    ns: 'llm' | 'img',
    modelId: string,
    filePath: string,
  ): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/${ns}/${encodeURIComponent(modelId)}/override`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filePath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Failed to set override');
      }
      queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'catalogue'] });
      queryClient.invalidateQueries({ queryKey: ['phobos', 'imageCatalogue'] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setPending(false);
    }
  }, [queryClient]);

  return { setOverride, pending, error };
}

/**
 * Remove a manual path override — model reverts to base-path-derived location.
 */
export function useClearModelOverride() {
  const queryClient = useQueryClient();

  const clearOverride = useCallback(async (
    ns: 'llm' | 'img',
    modelId: string,
  ): Promise<void> => {
    await fetch(`${ENGINE_URL}/api/phobos/models/${ns}/${encodeURIComponent(modelId)}/override`, {
      method: 'DELETE',
    });
    queryClient.invalidateQueries({ queryKey: ['phobos', 'modelsInfo'] });
    queryClient.invalidateQueries({ queryKey: ['phobos', 'catalogue'] });
    queryClient.invalidateQueries({ queryKey: ['phobos', 'imageCatalogue'] });
  }, [queryClient]);

  return { clearOverride };
}

/**
 * Open a native OS file picker. Returns the selected absolute path or null
 * if the user cancelled. filter: 'gguf' | 'safetensors' | 'pth' | 'any'
 */
export function useOpenFileDialog() {
  const [pending, setPending] = useState(false);

  const openDialog = useCallback(async (
    filter: 'gguf' | 'safetensors' | 'pth' | 'any' = 'any',
  ): Promise<string | null> => {
    setPending(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/open-file-dialog`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filter }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { path: string | null };
      return data.path;
    } catch {
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return { openDialog, pending };
}

/**
 * Open a native OS folder picker. Returns the selected absolute path or null.
 */
export function useOpenFolderDialog() {
  const [pending, setPending] = useState(false);

  const openDialog = useCallback(async (initialPath?: string): Promise<string | null> => {
    setPending(true);
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/open-folder-dialog`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ initialPath: initialPath ?? '' }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { path: string | null };
      return data.path;
    } catch {
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return { openDialog, pending };
}

// ── Relocate phase type ───────────────────────────────────────────────────────

export type RelocatePhase =
  | { kind: 'idle' }
  | { kind: 'stopping-servers' }
  | { kind: 'copying'; fileIndex: number; fileCount: number; file?: string }
  | { kind: 'moving';  fileIndex: number; fileCount: number; file?: string }
  | { kind: 'updating-config' }
  | { kind: 'deleting-originals' }
  | { kind: 'done'; matchCount: number }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

/**
 * SSE-based file relocation hook.
 * Stops servers, copies all model files to targetPath, updates base path,
 * resyncs overrides, deletes originals. Progress streamed via SSE.
 */
export function useRelocate() {
  const queryClient                   = useQueryClient();
  const [phase, setPhase]             = useState<RelocatePhase>({ kind: 'idle' });
  const abortRef                      = useRef(false);

  const relocate = useCallback(async (targetPath: string): Promise<void> => {
    abortRef.current = false;
    setPhase({ kind: 'stopping-servers' });

    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/relocate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ targetPath }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Relocate failed');
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            if (evt.phase === 'copying' || evt.phase === 'moving') {
              setPhase({ kind: evt.phase as 'copying' | 'moving', fileIndex: evt.fileIndex as number, fileCount: evt.fileCount as number, file: evt.file as string | undefined });
            } else if (evt.phase === 'updating-config') {
              setPhase({ kind: 'updating-config' });
            } else if (evt.phase === 'deleting-originals') {
              setPhase({ kind: 'deleting-originals' });
            } else if (evt.phase === 'done') {
              setPhase({ kind: 'done', matchCount: evt.matchCount as number });
              queryClient.invalidateQueries({ queryKey: ['phobos'] });
            } else if (evt.phase === 'error') {
              setPhase({ kind: 'error', message: evt.message as string });
            } else if (evt.phase === 'aborted') {
              setPhase({ kind: 'aborted' });
            }
          } catch { /* malformed SSE line — skip */ }
        }
      }
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [queryClient]);

  const abort = useCallback(async (): Promise<void> => {
    abortRef.current = true;
    await fetch(`${ENGINE_URL}/api/phobos/models/relocate/abort`, { method: 'POST' });
  }, []);

  const reset = useCallback(() => {
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, relocate, abort, reset };
}

// ── PyTorch Environment ──────────────────────────────────────────────────────

export interface PythonEnvVendorStatus {
  vendor: string;
  label: string;
  ready: boolean;
  gpuName: string;
  /** True if a pip install is currently running server-side for this vendor. */
  installing: boolean;
  /** True if the env exists but was built against an older package version — needs update. */
  stale: boolean;
}

export interface PythonEnvStatusResponse {
  python: { found: boolean; version: string | null; path: string | null };
  vendors: PythonEnvVendorStatus[];
}

export function usePythonEnvStatus() {
  return useQuery<PythonEnvStatusResponse>({
    queryKey: ['phobos', 'python-env', 'status'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/python-env/status`);
      if (!res.ok) throw new Error(`Python env status failed: ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,   // Poll frequently enough to catch background install completion
    refetchInterval: 15_000,
    retry: 1,
  });
}

export interface SageCheckResponse {
  installed: boolean;
  version: string | null;
  vendor: string | null;
}

export function useSageCheck() {
  return useQuery<SageCheckResponse>({
    queryKey: ['phobos', 'python-env', 'sage-check'],
    queryFn: async () => {
      const res = await fetch(`${ENGINE_URL}/api/phobos/python-env/sage-check`);
      if (!res.ok) throw new Error(`Sage check failed: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export interface PythonInstallProgress {
  phase: string;
  vendor: string;
  label: string;
  progress: number;
  done: boolean;
  error?: string;
}

export function usePythonEnvInstall() {
  const [installing, setInstalling] = useState<string | null>(null);  // vendor being installed
  const [progress, setProgress] = useState<PythonInstallProgress | null>(null);
  const queryClient = useQueryClient();

  const startInstall = useCallback(async (vendor: string, wipe = false) => {
    setInstalling(vendor);
    setProgress({ phase: 'detect', vendor, label: wipe ? 'Removing existing environment…' : 'Starting…', progress: 0, done: false });

    try {
      const endpoint = wipe ? 'reinstall' : 'install';
      const res = await fetch(`${ENGINE_URL}/api/phobos/python-env/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor }),
      });

      if (!res.ok || !res.body) {
        setProgress({ phase: 'error', vendor, label: `Install failed: ${res.status}`, progress: -1, done: true, error: `HTTP ${res.status}` });
        setInstalling(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as PythonInstallProgress;
            setProgress(data);
          } catch { /* malformed SSE line */ }
        }
      }
    } catch (err) {
      setProgress({ phase: 'error', vendor, label: err instanceof Error ? err.message : 'Install failed', progress: -1, done: true, error: String(err) });
    }

    setInstalling(null);
    // Invalidate status so the hardware cards refresh
    queryClient.invalidateQueries({ queryKey: ['phobos', 'python-env', 'status'] });
  }, [queryClient]);

  return { installing, progress, startInstall };
}

// ── Automated Python installer hook ──────────────────────────────────────────

export interface PythonAutoInstallProgress {
  phase: 'download' | 'install' | 'complete' | 'error';
  label: string;
  progress?: number;
  done: boolean;
  error?: string;
}

/**
 * Drives the automated Python 3.12 install flow.
 * Calls POST /api/phobos/python-env/install-python (SSE).
 * On completion (success or failure) invalidates the python-env status cache
 * so the hardware cards re-check automatically.
 */
export function usePythonInstall() {
  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState<PythonAutoInstallProgress | null>(null);
  const queryClient             = useQueryClient();

  const start = useCallback(async () => {
    setRunning(true);
    setProgress({ phase: 'download', label: 'Starting…', done: false });

    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/python-env/install-python`, {
        method: 'POST',
      });

      if (!res.ok || !res.body) {
        setProgress({
          phase: 'error',
          label: `Server error ${res.status} — install Python 3.12 manually: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe — check "Add Python to PATH".`,
          done: true,
          error: `HTTP ${res.status}`,
        });
        setRunning(false);
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as PythonAutoInstallProgress;
            setProgress(data);
          } catch { /* malformed SSE line — skip */ }
        }
      }
    } catch (err) {
      setProgress({
        phase: 'error',
        label: [
          err instanceof Error ? err.message : 'Install failed.',
          'Please install Python 3.12 manually: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe',
          '— check "Add Python to PATH" during install, then restart PHOBOS.',
        ].join(' '),
        done: true,
        error: String(err),
      });
    }

    setRunning(false);
    queryClient.invalidateQueries({ queryKey: ['phobos', 'python-env', 'status'] });
  }, [queryClient]);

  /** Clears progress and re-runs detection only (no install). */
  const retryDetection = useCallback(async () => {
    setProgress(null);
    try {
      await fetch(`${ENGINE_URL}/api/phobos/python-env/invalidate-cache`, { method: 'POST' });
    } catch { /* ignore */ }
    queryClient.invalidateQueries({ queryKey: ['phobos', 'python-env', 'status'] });
  }, [queryClient]);

  return { running, progress, start, retryDetection };
}

// ── Uncensored variant search + download ──────────────────────────────────────

export interface UncensoredVariant {
  repoId:   string;
  fileName: string;
  label:    string;
  method:   'heretic' | 'abliterated' | 'dolphin' | 'uncensored';
  pageUrl:  string;
}

export type VariantDownloadStage =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'found'; variants: UncensoredVariant[] }
  | { kind: 'none-found' }
  | { kind: 'downloading'; bytesReceived: number; bytesTotal: number; repoId: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export function useUncensoredVariant(modelId: string | null) {
  const [stage, setStage] = useState<VariantDownloadStage>({ kind: 'idle' });
  const esRef = useRef<EventSource | null>(null);
  const queryClient = useQueryClient();

  const search = useCallback(async () => {
    if (!modelId) return;
    setStage({ kind: 'searching' });
    try {
      const res = await fetch(`${ENGINE_URL}/api/phobos/models/${encodeURIComponent(modelId)}/uncensored`);
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data: { variants: UncensoredVariant[] } = await res.json();
      if (data.variants.length === 0) {
        setStage({ kind: 'none-found' });
      } else {
        setStage({ kind: 'found', variants: data.variants });
      }
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [modelId]);

  const download = useCallback((variant: UncensoredVariant) => {
    if (!modelId) return;
    setStage({ kind: 'downloading', bytesReceived: 0, bytesTotal: 0, repoId: variant.repoId });

    const es = new EventSource(
      `${ENGINE_URL}/api/phobos/models/${encodeURIComponent(modelId)}/download-variant-sse?` +
      `repoId=${encodeURIComponent(variant.repoId)}&fileName=${encodeURIComponent(variant.fileName)}`,
    );
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.error) {
          setStage({ kind: 'error', message: d.error });
          es.close(); esRef.current = null; return;
        }
        if (d.done) {
          setStage({ kind: 'done' });
          es.close(); esRef.current = null;
          queryClient.invalidateQueries({ queryKey: ['phobos', 'models'] });
          return;
        }
        setStage({ kind: 'downloading', bytesReceived: d.bytesReceived, bytesTotal: d.bytesTotal, repoId: variant.repoId });
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      setStage({ kind: 'error', message: 'Connection lost during download.' });
      es.close(); esRef.current = null;
    };
  }, [modelId, queryClient]);

  const reset = useCallback(() => {
    esRef.current?.close(); esRef.current = null;
    setStage({ kind: 'idle' });
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  return { stage, search, download, reset };
}