/**
 * useClipPopoverStore.ts — Transient UI state for the ClipPropsPopover.
 *
 * Single-purpose slice: holds whether the popover is open, where to anchor
 * it (right-click x/y in viewport coordinates), and which clip it targets.
 * ClipCell sets this on right-click; ClipPropsPopover reads from it.
 *
 * Why a separate store and not useEditorStore: useEditorStore's shape is
 * consumed by daw-bridge.EffluxState.editor. Adding popover state there
 * would leak transient UI concerns into the engine's state contract. This
 * slice stays purely on the React side.
 *
 * Mutation discipline: trivial set() — no nested objects to mutate in
 * place, so the standard Zustand pattern is fine here.
 */

import { create } from 'zustand';

export interface ClipPopoverAnchor {
  x: number;
  y: number;
}

export interface ClipPopoverState {
  open:         boolean;
  anchor:       ClipPopoverAnchor | null;
  channelIndex: number;
  clipIndex:    number;

  /** Open the popover anchored at (x, y), targeting (channelIndex, clipIndex). */
  openFor: (channelIndex: number, clipIndex: number, anchor: ClipPopoverAnchor) => void;

  /** Close the popover. */
  close:   () => void;
}

export const useClipPopoverStore = create<ClipPopoverState>((set) => ({
  open:         false,
  anchor:       null,
  channelIndex: 0,
  clipIndex:    0,

  openFor: (channelIndex, clipIndex, anchor) => set({
    open: true,
    anchor,
    channelIndex,
    clipIndex,
  }),

  close: () => set({ open: false, anchor: null }),
}));
