/**
 * useSampleStore.ts — Sample library state (Phase 2c minimal surface).
 *
 * Upstream Efflux's sample-module.ts maintains a Map<sampleId, SampleCache>
 * where each entry holds the raw AudioBuffer plus any slice regions used by
 * the sample editor. Phase 2c lands the surface; the actual loading,
 * decoding, waveform rendering, and slice manipulation land in Phase 2c.1
 * alongside SampleEditor.
 *
 * Rationale for landing this now: the daw-bridge needs a stable
 * `state.sample.sampleCache` reference. Phase 2a/2b returned a fresh Map
 * on every bridge snapshot — technically allocation per read. This store
 * owns ONE persistent Map instance.
 */

import { create } from 'zustand';
import type { Sample } from '@/components/audio/engine/model/types/sample';

export interface SampleCacheEntry {
  sample:  Sample;
  buffer:  AudioBuffer | null;
  slices:  AudioBuffer[];
}

export interface SampleStoreState {
  /** Canonical sample cache — the same Map reference across the app's lifetime. */
  sampleCache: Map<string, SampleCacheEntry>;
  /** Version counter — bump after in-place writes to drive UI re-renders. */
  version:     number;

  cacheSample:  (sample: Sample, buffer: AudioBuffer | null) => void;
  updateSample: (sampleId: string, patch: Partial<Sample>) => void;
  removeSample: (sampleId: string) => void;
  getAllSamples: () => SampleCacheEntry[];
  bumpVersion:  () => void;
}

const cache = new Map<string, SampleCacheEntry>();

export const useSampleStore = create<SampleStoreState>((set, get) => ({
  sampleCache: cache,
  version:     0,

  cacheSample: (sample, buffer) => {
    cache.set(sample.id ?? sample.name, { sample, buffer, slices: [] });
    set({ version: get().version + 1 });
  },

  /** Mutate an existing sample's metadata in place (trim, loop, pitch). */
  updateSample: (sampleId, patch) => {
    const entry = cache.get(sampleId);
    if (!entry) return;
    Object.assign(entry.sample, patch);                   // in-place mutation
    set({ version: get().version + 1 });
  },

  removeSample: (sampleId) => {
    cache.delete(sampleId);
    set({ version: get().version + 1 });
  },

  /** Snapshot of all cached entries — allocates a new array, call sparingly. */
  getAllSamples: () => Array.from(cache.values()),

  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
}));
