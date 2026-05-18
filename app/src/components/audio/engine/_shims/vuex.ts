/**
 * vuex.ts — Type-only shim for the Efflux engine port.
 *
 * The upstream Efflux codebase uses Vuex for state management. During Phase 2a
 * we replaced the runtime hooks (in AudioService) with a daw-bridge that reads
 * from our Zustand stores. But many action files and utility modules declare
 * `Store<EffluxState>` in their type signatures even when they don't run in
 * Phase 2a's hot path — they're imported only at `tsc` time by the transitive
 * graph.
 *
 * Rather than edit every file, we redirect `from "@engine/_shims/vuex"` imports to this shim
 * via tsconfig paths. The shim declares opaque types that preserve generic
 * arity but have no runtime. Files that *use* the Store at runtime (not just
 * as a type) are either:
 *   (a) Phase 2a stubs — KeyboardService, MidiService — no Vuex calls in their
 *       stub bodies.
 *   (b) Deferred to Phase 2b/2c/2d — e.g. undo/redo actions — they compile now
 *       and are rewritten against Zustand when the editor UI that uses them
 *       lands.
 *
 * This approach keeps upstream bug fixes mergeable: future Efflux changes to
 * actions keep importing `from "@engine/_shims/vuex"`, and we can sync them verbatim.
 */

/** Opaque Store type — commit/dispatch are typed as any-returning callables. */
export interface Store<S = unknown> {
  readonly state:   S;
  readonly getters: Record<string, unknown>;
  commit(type: string, payload?: unknown, options?: unknown): void;
  dispatch(type: string, payload?: unknown, options?: unknown): Promise<unknown>;
  subscribe(fn: (mutation: { type: string; payload: unknown }, state: S) => void): () => void;
}

export type Commit   = Store["commit"];
export type Dispatch = Store["dispatch"];

export interface ActionContext<S = unknown, R = unknown> {
  state:     S;
  rootState: R;
  commit:    Commit;
  dispatch:  Dispatch;
  getters:   Record<string, unknown>;
  rootGetters: Record<string, unknown>;
}

export interface Module<S, R> {
  state?:     S | (() => S);
  getters?:   Record<string, (state: S, getters: Record<string, unknown>, rootState: R) => unknown>;
  mutations?: Record<string, (state: S, payload: unknown) => void>;
  actions?:   Record<string, (ctx: ActionContext<S, R>, payload: unknown) => unknown>;
  modules?:   Record<string, Module<unknown, R>>;
  namespaced?: boolean;
}
