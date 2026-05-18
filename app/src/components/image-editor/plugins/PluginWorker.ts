import type {
  PhobosEffect,
  PhobosPluginManifest,
  WorkerInMessage,
  WorkerOutMessage,
} from '../types';

// =============================================================================
// PluginWorker — main-thread host
//
// Owns the Worker instance. All calls to this class are non-blocking:
// render() returns a Promise that resolves when the worker posts render-done.
//
// SharedArrayBuffer requirements:
//   - The page must be cross-origin isolated (COOP + COEP headers).
//   - Phobos core server must set these headers. This is a deployment concern,
//     not handled here.
//
// If SharedArrayBuffer is unavailable (non-isolated context), render() falls
// back to transferring a regular ArrayBuffer copy. Performance degrades but
// correctness is preserved.
// =============================================================================

interface PendingRender {
  resolve: () => void;
  reject:  (err: Error) => void;
}

export class PluginWorker {
  private readonly worker:   Worker;
  private readonly pending:  Map<number, PendingRender>;
  private nextRenderId:      number;
  private _ready:            Promise<void>;

  /**
   * @param workerUrl  URL of the compiled worker bundle.
   *                   In Vite: `new URL('./PluginWorker.worker.ts', import.meta.url)`
   *                   In webpack: similar pattern with worker-loader.
   */
  constructor(workerUrl: URL | string) {
    this.worker       = new Worker(workerUrl, { type: 'module' });
    this.pending      = new Map<number, PendingRender>();
    this.nextRenderId = 0;

    this.worker.addEventListener('message', this._onMessage.bind(this));
    this.worker.addEventListener('error',   this._onError.bind(this));

    // Wait for the 'ready' signal the worker posts immediately on startup.
    this._ready = new Promise<void>((resolve, reject) => {
      const onFirst = (event: MessageEvent<WorkerOutMessage>): void => {
        if (event.data.type === 'ready') {
          this.worker.removeEventListener('message', onFirst as EventListener);
          resolve();
        }
      };
      const onError = (e: ErrorEvent): void => {
        reject(new Error(`Worker failed to start: ${e.message}`));
      };
      this.worker.addEventListener('message', onFirst as EventListener);
      this.worker.addEventListener('error',   onError);
    });
  }

  /** Resolves when the worker has sent its 'ready' message. */
  get ready(): Promise<void> {
    return this._ready;
  }

  // ---------------------------------------------------------------------------
  // Effect registration
  // ---------------------------------------------------------------------------

  /**
   * Register a JS effect with the worker. The effect class is instantiated
   * on the main thread to generate the source string, then sent to the worker
   * for re-instantiation. This keeps the worker free of import machinery.
   *
   * Convention: the effect's constructor must be accessible as a named export
   * so the worker can call `new EffectClass()`. The source string wraps this
   * into the self.__phobosEffect convention expected by the worker.
   */
  registerJsEffect(manifest: PhobosPluginManifest, effectSource: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>): void => {
        const data = event.data;
        if (
          (data.type === 'register-ok' || data.type === 'register-error') &&
          data.pluginId === manifest.id
        ) {
          this.worker.removeEventListener('message', onMessage as EventListener);
          if (data.type === 'register-ok') {
            resolve();
          } else {
            reject(new Error(data.message));
          }
        }
      };
      this.worker.addEventListener('message', onMessage as EventListener);

      const msg: WorkerInMessage = {
        type:     'register-js',
        source:   effectSource,
        manifest,
      };
      this.worker.postMessage(msg);
    });
  }

  /**
   * Register a WASM effect. The .wasm bytes are transferred to the worker
   * (zero-copy transfer).
   */
  registerWasmEffect(manifest: PhobosPluginManifest, wasmBytes: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>): void => {
        const data = event.data;
        if (
          (data.type === 'register-ok' || data.type === 'register-error') &&
          data.pluginId === manifest.id
        ) {
          this.worker.removeEventListener('message', onMessage as EventListener);
          if (data.type === 'register-ok') {
            resolve();
          } else {
            reject(new Error(data.message));
          }
        }
      };
      this.worker.addEventListener('message', onMessage as EventListener);

      const msg: WorkerInMessage = {
        type:      'register-wasm',
        manifest,
        wasmBytes,
      };
      // Transfer wasmBytes — the main thread relinquishes ownership.
      this.worker.postMessage(msg, [wasmBytes]);
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  /**
   * Send a render job to the worker. Returns a Promise that resolves when
   * the worker has finished writing into `dst`.
   *
   * `src` and `dst` must be SharedArrayBuffers when cross-origin isolation is
   * active. In non-isolated contexts, pass regular ArrayBuffers — they will
   * be copied into SharedArrayBuffers internally (with a performance hit).
   *
   * The caller reads `dst` after the Promise resolves — it is already populated.
   */
  render(
    pluginId: string,
    src:      SharedArrayBuffer | ArrayBuffer,
    dst:      SharedArrayBuffer | ArrayBuffer,
    width:    number,
    height:   number,
    params:   Record<string, number | boolean | string>,
    mask?:    SharedArrayBuffer | ArrayBuffer,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const renderId = this.nextRenderId++;
      this.pending.set(renderId, { resolve, reject });

      const srcSab  = toShared(src);
      const dstSab  = toShared(dst);
      const maskSab = mask ? toShared(mask) : undefined;

      const msg: WorkerInMessage = {
        type: 'render',
        renderId,
        pluginId,
        src:    srcSab,
        dst:    dstSab,
        width,
        height,
        params,
        ...(maskSab ? { mask: maskSab } : {}),
      };
      this.worker.postMessage(msg);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ping(): Promise<void> {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>): void => {
        if (event.data.type === 'pong') {
          this.worker.removeEventListener('message', onMessage as EventListener);
          resolve();
        }
      };
      this.worker.addEventListener('message', onMessage as EventListener);
      const msg: WorkerInMessage = { type: 'ping' };
      this.worker.postMessage(msg);
    });
  }

  /** Terminate the worker. All pending renders will be rejected. */
  destroy(): void {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error('PluginWorker destroyed'));
    }
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _onMessage(event: MessageEvent<WorkerOutMessage>): void {
    const data = event.data;

    if (data.type === 'render-done') {
      const entry = this.pending.get(data.renderId);
      if (!entry) return;
      this.pending.delete(data.renderId);
      entry.resolve();
      return;
    }

    if (data.type === 'render-error') {
      const entry = this.pending.get(data.renderId);
      if (!entry) return;
      this.pending.delete(data.renderId);
      entry.reject(new Error(data.message));
      return;
    }
  }

  private _onError(event: ErrorEvent): void {
    // Reject all pending renders — the worker is in an unrecoverable state.
    for (const { reject } of this.pending.values()) {
      reject(new Error(`Worker error: ${event.message}`));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Helper: ensure a buffer is a SharedArrayBuffer
// ---------------------------------------------------------------------------

/**
 * If `buf` is already a SharedArrayBuffer, return it unchanged.
 * Otherwise copy it into a new SharedArrayBuffer. This fallback is slow —
 * it exists only for non-cross-origin-isolated contexts.
 */
function toShared(buf: SharedArrayBuffer | ArrayBuffer): SharedArrayBuffer {
  if (buf instanceof SharedArrayBuffer) return buf;
  const sab = new SharedArrayBuffer(buf.byteLength);
  new Uint8Array(sab).set(new Uint8Array(buf));
  return sab;
}

// ---------------------------------------------------------------------------
// Helper: allocate a SharedArrayBuffer for a pixel buffer
// ---------------------------------------------------------------------------

/**
 * Allocate a SharedArrayBuffer large enough for `width × height × 4` bytes.
 * Use this to create src/dst buffers before calling render().
 */
export function allocatePixelBuffer(width: number, height: number): SharedArrayBuffer {
  return new SharedArrayBuffer(width * height * 4);
}

/**
 * Copy an ImageData's pixels into a SharedArrayBuffer (or any Uint8Array target).
 * Used to populate the src buffer before a render call.
 */
export function copyImageDataToBuffer(
  imageData: ImageData,
  target:    SharedArrayBuffer | ArrayBuffer,
): void {
  new Uint8ClampedArray(target).set(imageData.data);
}

/**
 * Copy a SharedArrayBuffer's pixel data back into an ImageData.
 * Used to read the dst buffer after a render call.
 */
export function copyBufferToImageData(
  source:    SharedArrayBuffer | ArrayBuffer,
  imageData: ImageData,
): void {
  imageData.data.set(new Uint8ClampedArray(source));
}

// Re-export PhobosEffect so callers don't need a second import.
export type { PhobosEffect };
