// src/lib/engineUrl.ts
//
// Single source of truth for the phobos-core API URL.
// In the Electron app, the preload script injects window.ELECTRON_ENGINE_URL
// via contextBridge before the renderer boots. In the browser, VITE_ENGINE_URL
// is baked in at build time.

export const ENGINE_URL: string = (
  (window as any).ELECTRON_ENGINE_URL ??
  (import.meta.env.VITE_ENGINE_URL as string | undefined) ??
  'http://localhost:3001'
).replace(/\/$/, '');
