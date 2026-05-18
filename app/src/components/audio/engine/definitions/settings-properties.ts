/**
 * PROPERTIES — setting name constants extracted from upstream
 * src/store/modules/settings-module.ts so the engine can reference them
 * without pulling a full Vuex module.
 *
 * The Zustand `useSettingsStore` in `store/daw/` holds the runtime values;
 * this file is just the canonical key names.
 */

export enum PROPERTIES {
  INPUT_FORMAT    = "if",
  FOLLOW_PLAYBACK = "fp",
  DISPLAY_HELP    = "dh",
  DISPLAY_WELCOME = "dw",
  USE_ORDERS      = "po",
}

export interface SettingsState {
  _settings: Record<string, unknown>;
}

export const createSettingsState = (props?: Partial<SettingsState>): SettingsState => ({
  _settings: {},
  ...props,
});
