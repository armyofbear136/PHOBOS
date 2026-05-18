/**
 * usePluginsStore.ts — Cached VST3 plugin listing for the DAW UI.
 *
 * The backend (`/api/audio/plugins`) already caches to DuckDB with a 1h
 * staleness window. This store mirrors the result in memory so the
 * multiple UI consumers (ChannelHeader slot, EffluxBottomBar picker,
 * future SettingsWindow) share one fetch per app session.
 *
 * Consumers call `loadIfStale()` on mount — if the listing was never
 * loaded, or `refresh()` is explicitly requested, a single network fetch
 * fires. Concurrent loadIfStale calls are coalesced via a shared Promise.
 */

import { create } from 'zustand';
import { listPlugins, type PluginEntry, type PluginListing } from '@/components/audio/services/DawApi';

export interface PluginsStoreState {
  phobos:  PluginEntry[];
  system:  PluginEntry[];
  loaded:  boolean;
  loading: boolean;
  error:   string | null;

  loadIfStale: () => Promise<void>;
  refresh:     () => Promise<void>;
}

// Shared promise for coalescing concurrent loads.
let inflight: Promise<void> | null = null;

export const usePluginsStore = create<PluginsStoreState>((set, get) => {
  async function fetchListing(force: boolean): Promise<void> {
    if (inflight) return inflight;
    set({ loading: true, error: null });
    inflight = (async () => {
      try {
        const listing: PluginListing = await listPlugins({ refresh: force });
        set({
          phobos:  listing.phobos,
          system:  listing.system,
          loaded:  true,
          loading: false,
          error:   null,
        });
      } catch (err) {
        set({ loading: false, error: (err as Error).message });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    phobos:  [],
    system:  [],
    loaded:  false,
    loading: false,
    error:   null,
    loadIfStale: async () => { if (!get().loaded && !get().loading) await fetchListing(false); },
    refresh:     async () => { await fetchListing(true); },
  };
});
