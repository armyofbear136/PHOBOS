import type {
  PhobosEffect,
  PhobosRenderContext,
  WorkerInMessage,
  WorkerOutMessage,
} from '../types';

// =============================================================================
// PluginWorker — worker thread
//
// This file runs inside a dedicated Worker. It:
//   - Maintains a registry of loaded JS effects and WASM instances.
//   - Receives render jobs via postMessage, executes them synchronously,
//     and posts the result back.
//   - Never allocates inside render() beyond what the effect itself does.
//     src/dst/mask are views into SharedArrayBuffers — zero copy.
//
// One Worker is spawned at startup and lives for the session.
// =============================================================================

// JS effect registry: pluginId → PhobosEffect instance
const jsRegistry = new Map<string, PhobosEffect>();

// WASM instance registry: pluginId → WebAssembly.Instance
const wasmRegistry = new Map<string, WebAssembly.Instance>();

// ---------------------------------------------------------------------------
// Progress throttle
// ---------------------------------------------------------------------------

// Throttle progress reports to at most once per 100ms per render.
// Avoids flooding the main thread with postMessage calls during long ops.
function makeProgressReporter(_renderId: number): (pct: number) => void {
  let lastSent = 0;
  return (_pct: number): void => {
    const now = Date.now();
    if (now - lastSent < 100) return;
    lastSent = now;
    // Progress reporting is best-effort in v1 — a dedicated message type
    // can be added in Phase 2 if the UI needs a progress bar.
  };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  switch (msg.type) {

    case 'ping': {
      const reply: WorkerOutMessage = { type: 'pong' };
      self.postMessage(reply);
      break;
    }

    case 'register-js': {
      try {
        // The effect source is a module-style IIFE that returns a PhobosEffect.
        // Convention: the source must assign `self.__phobosEffect = new MyEffect()`.
        // We evaluate it in the worker's global scope.
        // eslint-disable-next-line no-new-func
        const factory = new Function(msg.source);
        factory();
        const effect = (self as unknown as Record<string, unknown>)['__phobosEffect'] as PhobosEffect | undefined;
        if (!effect || typeof effect.render !== 'function') {
          throw new Error('Source did not expose self.__phobosEffect with a render() method');
        }
        jsRegistry.set(msg.manifest.id, effect);
        const reply: WorkerOutMessage = { type: 'register-ok', pluginId: msg.manifest.id };
        self.postMessage(reply);
      } catch (err) {
        const reply: WorkerOutMessage = {
          type:     'register-error',
          pluginId: msg.manifest.id,
          message:  String(err),
        };
        self.postMessage(reply);
      }
      break;
    }

    case 'register-wasm': {
      WebAssembly.instantiate(msg.wasmBytes).then(result => {
        wasmRegistry.set(msg.manifest.id, result.instance);
        const reply: WorkerOutMessage = { type: 'register-ok', pluginId: msg.manifest.id };
        self.postMessage(reply);
      }).catch((err: unknown) => {
        const reply: WorkerOutMessage = {
          type:     'register-error',
          pluginId: msg.manifest.id,
          message:  String(err),
        };
        self.postMessage(reply);
      });
      break;
    }

    case 'render': {
      const { renderId, pluginId, src, dst, width, height, params, mask } = msg;

      // Build typed views directly onto the SharedArrayBuffers — zero copy.
      const srcView  = new Uint8ClampedArray(src);
      const dstView  = new Uint8ClampedArray(dst);
      const maskView = mask ? new Uint8Array(mask) : undefined;

      const ctx: PhobosRenderContext = {
        src:      srcView,
        dst:      dstView,
        width,
        height,
        params,
        progress: makeProgressReporter(renderId),
        ...(maskView !== undefined ? { mask: maskView } : {}),
      };

      try {
        // Try JS registry first.
        const jsEffect = jsRegistry.get(pluginId);
        if (jsEffect) {
          jsEffect.render(ctx);
          const reply: WorkerOutMessage = { type: 'render-done', renderId };
          self.postMessage(reply);
          break;
        }

        // Try WASM registry.
        const wasmInstance = wasmRegistry.get(pluginId);
        if (wasmInstance) {
          // WASM effects export a `render` function that writes directly into
          // the shared buffers (the WASM memory must be configured to overlap
          // with the SharedArrayBuffers — see WasmEffectLoader in Phase 3).
          // For now, call the exported render function with the buffer pointers.
          const renderFn = wasmInstance.exports['render'] as
            | ((srcPtr: number, dstPtr: number, maskPtr: number, width: number, height: number) => void)
            | undefined;
          if (!renderFn) throw new Error(`WASM module for "${pluginId}" does not export render()`);
          // Phase 3: wire up memory pointers. Stub for now.
          renderFn(0, 0, 0, width, height);
          const reply: WorkerOutMessage = { type: 'render-done', renderId };
          self.postMessage(reply);
          break;
        }

        throw new Error(`No effect registered for plugin id "${pluginId}"`);

      } catch (err) {
        const reply: WorkerOutMessage = {
          type:     'render-error',
          renderId,
          message:  String(err),
        };
        self.postMessage(reply);
      }
      break;
    }

    default: {
      // Exhaustiveness guard — TypeScript ensures this is unreachable
      // if all WorkerInMessage variants are handled above.
      const _exhaustive: never = msg;
      void _exhaustive;
    }
  }
});

// Signal readiness to the main thread.
const readyMsg: WorkerOutMessage = { type: 'ready' };
self.postMessage(readyMsg);
