/**
 * useInstrumentChainStore.ts — UI state for the InstrumentChainModal.
 *
 * The modal opens on double-click of a channel header and is the primary
 * surface for editing the channel's instrument chain (host-routed
 * instrument + FX chain). Drill-in to the legacy InstrumentEditor (the
 * Efflux oscillator/modules/sample editor) happens via this store too —
 * we set `legacyEditorPending` so the chain modal stays mounted underneath
 * and resumes when the legacy editor closes.
 *
 * State scope:
 *   • Pure UI — open flag, target channel, browser-mode (which half the
 *     plugin browser is filtering for).
 *   • Schema/host data lives in useSessionStore (channel.hostInstrument,
 *     channel.fxChain). This store does NOT cache it.
 */

import { create } from 'zustand';

/**
 * Which half of the chain row is "active" for browser-driven adds. The
 * plugin browser at the bottom of the modal switches its filter based on
 * this:
 *   • 'instrument' → browser shows only instrument plugins. Picking
 *                    replaces the channel's hostInstrument.
 *   • 'fx'         → browser shows only effect plugins. Picking appends
 *                    to the channel's fxChain.
 */
export type ChainBrowserMode = 'instrument' | 'fx';

export interface InstrumentChainStoreState {
  /** True when the chain modal is mounted and visible. */
  open: boolean;
  /**
   * Channel index the modal is editing. Channel 0 is rejected at openFor
   * (system chain — no editing surface).
   */
  channelIdx: number;
  /** Which half of row 2 is active — drives row 3's browser filter. */
  browserMode: ChainBrowserMode;

  openFor:        (channelIdx: number) => void;
  close:          ()                   => void;
  setBrowserMode: (mode: ChainBrowserMode) => void;
}

export const useInstrumentChainStore = create<InstrumentChainStoreState>((set) => ({
  open:        false,
  channelIdx:  0,
  browserMode: 'instrument',

  openFor: (channelIdx) => {
    if (channelIdx === 0) return;                   // system chain — no editing
    set({ open: true, channelIdx, browserMode: 'instrument' });
  },
  close:          ()      => set({ open: false }),
  setBrowserMode: (mode)  => set({ browserMode: mode }),
}));
