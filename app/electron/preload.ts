import { contextBridge } from 'electron';

// Expose the engine URL to the renderer so it can reach phobos-core.
// The renderer reads window.ELECTRON_ENGINE_URL if present, falling back
// to the VITE_ENGINE_URL baked in at build time.
contextBridge.exposeInMainWorld('ELECTRON_ENGINE_URL', process.env.VITE_ENGINE_URL ?? 'http://localhost:3001');
