/**
 * useSettingsStore.ts — Zustand replacement for upstream settings-module.ts.
 *
 * Holds user preferences (input format, follow playback, display help, etc.)
 * keyed by the PROPERTIES enum from engine/definitions/settings-properties.
 *
 * Phase 2a surface: enough for the daw-bridge to answer `followPlayback` and
 * `paramFormat` queries. Persistence to localStorage lands in Phase 2c.
 */

import { create } from 'zustand';
import { PROPERTIES } from '@/components/audio/engine/definitions/settings-properties';

export interface SettingsState {
  _settings: Record<string, unknown>;

  setSetting: (name: PROPERTIES, value: unknown) => void;
  getSetting: (name: PROPERTIES) => unknown;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  _settings: {},

  setSetting: (name, value) => set((s) => ({
    _settings: { ...s._settings, [name]: value },
  })),
  getSetting: (name) => get()._settings[name],
}));
