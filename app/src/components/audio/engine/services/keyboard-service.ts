/**
 * keyboard-service.ts — React-idiomatic port of upstream Efflux's
 * KeyboardService.ts.
 *
 * Architecture note: upstream Efflux installs a global `window.onkeydown`
 * listener inside this module. For React we flip that — the listener lives in
 * the `useKeyboardInput` hook which mounts alongside the DAW panel, and THIS
 * module is the stable API surface that the engine's other modules call into
 * to (a) suspend input when a modal takes focus, (b) install a scoped
 * listener override (note-entry editor, module param editor), and (c) query
 * the current modifier state.
 *
 * The hook reads the module-level state on every native keydown/keyup so
 * suspension and listener overrides are observed without React re-render
 * dependency.
 *
 * ZERO-ALLOCATION DISCIPLINE:
 *   • The modifier state is a single mutated object, never replaced.
 *   • `getModifierState()` returns the same reference each call — treat it
 *     as read-only.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Return `true` from a listener to mark the event handled (suppresses default dispatch). */
export type KeyEventListener = (
  type: 'down' | 'up',
  keyCode: number,
  event: KeyboardEvent,
) => boolean | void;

export interface ModifierState {
  shift: boolean;
  ctrl:  boolean;
  alt:   boolean;
  meta:  boolean;
}

// ── Module-level singletons (mutated, never replaced) ────────────────────────

const modifierState: ModifierState = {
  shift: false,
  ctrl:  false,
  alt:   false,
  meta:  false,
};

let suspended = false;
let listenerOverride: KeyEventListener | null = null;
let initialized = false;

// ── Public API ───────────────────────────────────────────────────────────────

const KeyboardService = {
  /**
   * Called by the React hook on mount. Idempotent — safe to call from
   * multiple mount/unmount cycles (useKeyboardInput does this under StrictMode).
   */
  init(): void {
    initialized = true;
  },

  /** Called on hook unmount; clears modal override and modifier latches. */
  reset(): void {
    suspended        = false;
    listenerOverride = null;
    modifierState.shift = false;
    modifierState.ctrl  = false;
    modifierState.alt   = false;
    modifierState.meta  = false;
  },

  /**
   * Modal lifecycle: call with `true` when a modal opens so the tracker grid
   * stops eating keys; call with `false` on close. The React hook checks this
   * flag on every keydown before dispatching note/navigation logic.
   */
  setSuspended(v: boolean): void {
    suspended = v;
  },

  /**
   * Install a scoped listener override (e.g. the note-entry editor) that
   * receives every key event until it returns `true` (handled) or the caller
   * unregisters by passing `null`. When set, the main tracker handler is
   * bypassed entirely.
   */
  setListener(listener: KeyEventListener | null): void {
    listenerOverride = listener;
  },

  // ── Read-only state accessors for useKeyboardInput ──────────────────────

  isInitialized():    boolean                   { return initialized;       },
  isSuspended():      boolean                   { return suspended;         },
  getListener():      KeyEventListener | null   { return listenerOverride;  },
  getModifierState(): Readonly<ModifierState>   { return modifierState;     },

  /**
   * Called by the hook from the native keydown handler BEFORE dispatch so the
   * modifier snapshot is current. Mutates the shared `modifierState` object.
   */
  updateModifiers(event: KeyboardEvent): void {
    modifierState.shift = event.shiftKey;
    modifierState.ctrl  = event.ctrlKey;
    modifierState.alt   = event.altKey;
    modifierState.meta  = event.metaKey;
  },
};

export default KeyboardService;
