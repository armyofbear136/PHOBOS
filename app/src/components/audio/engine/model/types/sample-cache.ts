/**
 * Types extracted from upstream src/store/modules/sample-module.ts.
 * Originally a Vuex module — we only need the pure type exports here so
 * AudioService and other engine files can type their sampleCache maps.
 * The Zustand `useSampleStore` in `store/daw/` holds the live instance.
 */

import type { Sample } from "../types/sample";

export type SampleCacheEntry = {
  sample: Sample;
  slices: AudioBuffer[];
};

export interface SampleState {
  currentSampleId: string | null;
  sampleCache:     Map<string, SampleCacheEntry>;
}

export const createSampleState = (props?: Partial<SampleState>): SampleState => ({
  currentSampleId: null,
  sampleCache:     new Map(),
  ...props,
});
