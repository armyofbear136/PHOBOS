import { validateManifest }           from '../types';
import { PluginWorker }               from './PluginWorker';
import type { EffectCategory, PhobosPluginManifest } from '../types';

// =============================================================================
// PluginRegistry
//
// Holds the manifest for every registered effect and coordinates with
// PluginWorker to load the implementation into the worker thread.
//
// Built-in effects are registered at startup by plugins/index.ts.
// Third-party effects are registered when a user loads a plugin URL.
//
// The registry is the only place manifest validation happens.
// =============================================================================

export class PluginRegistry {
  private readonly manifests: Map<string, PhobosPluginManifest>;
  private readonly worker:    PluginWorker;

  constructor(worker: PluginWorker) {
    this.manifests = new Map<string, PhobosPluginManifest>();
    this.worker    = worker;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a built-in JS effect.
   *
   * `effectSource` is a self-contained JS string that, when executed inside
   * the worker's global scope, assigns a PhobosEffect instance to
   * `self.__phobosEffect`. Built-in effects are bundled as strings at build
   * time (the build tool converts the import to an inline string).
   *
   * For development, callers can pass the source directly.
   */
  async registerBuiltin(
    manifest:     PhobosPluginManifest,
    effectSource: string,
  ): Promise<void> {
    this._validate(manifest);
    this._guardDuplicate(manifest.id);
    await this.worker.registerJsEffect(manifest, effectSource);
    this.manifests.set(manifest.id, manifest);
  }

  /**
   * Register a third-party WASM effect.
   * The .wasm bytes are fetched by the caller and transferred here.
   * The manifest must declare `wasm: <url>`.
   */
  async registerWasm(
    manifest:  PhobosPluginManifest,
    wasmBytes: ArrayBuffer,
  ): Promise<void> {
    this._validate(manifest);
    this._guardDuplicate(manifest.id);
    if (!manifest.wasm) {
      throw new Error(`Plugin "${manifest.id}" is missing the wasm field in its manifest`);
    }
    await this.worker.registerWasmEffect(manifest, wasmBytes);
    this.manifests.set(manifest.id, manifest);
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  get(id: string): PhobosPluginManifest | undefined {
    return this.manifests.get(id);
  }

  /** Return all registered manifests, optionally filtered by category. */
  list(category?: EffectCategory): PhobosPluginManifest[] {
    const all = Array.from(this.manifests.values());
    return category ? all.filter(m => m.category === category) : all;
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _validate(manifest: PhobosPluginManifest): void {
    const error = validateManifest(manifest);
    if (error) throw new Error(error);
  }

  private _guardDuplicate(id: string): void {
    if (this.manifests.has(id)) {
      throw new Error(`Plugin "${id}" is already registered`);
    }
  }
}
