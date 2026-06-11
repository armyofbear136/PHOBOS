import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App.tsx";
import "./index.css";

// ── Local session header injection ────────────────────────────────────────────
// Patches window.fetch so every request to the phobos-core engine automatically
// carries the x-local-session token stored in sessionStorage. sessionStorage is
// tab-scoped and cleared on tab/browser close — exactly the lifetime we want.
// WebRTC remote sessions use x-webrtc-user/role instead and are unaffected.
const _nativeFetch = window.fetch.bind(window);
const ENGINE_ORIGIN = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

window.fetch = function phobosFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isEngineRequest = url.startsWith(ENGINE_ORIGIN) || url.startsWith('/api/') || url.startsWith('/tools/');

  if (isEngineRequest) {
    const sessionToken = sessionStorage.getItem('phobos_session');
    if (sessionToken) {
      const headers = new Headers(init?.headers);
      headers.set('x-local-session', sessionToken);
      return _nativeFetch(input, { ...init, headers });
    }
  }
  return _nativeFetch(input, init);
};

// Evict any service workers registered by embedded tools (e.g. Godot's service.worker.js).
// Godot's SW installs at /tools/godot/ scope and intercepts fetches to re-add COOP/COEP
// headers — but the Vite dev server already adds those globally, causing the SW's own
// fetch() calls to fail under COEP: require-corp, which crashes the Godot iframe.
// The server now serves a no-op SW at that path, but any previously installed real SW
// must be evicted here so it doesn't survive across page loads from a prior session.
// This runs once synchronously before React mounts — no UI delay.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      const scope = reg.scope ?? '';
      // Only unregister SWs that are NOT owned by PHOBOS itself.
      // PHOBOS does not register any service workers — any SW on this origin
      // was installed by an embedded tool iframe and should not persist.
      if (scope.includes('/tools/')) {
        reg.unregister();
      }
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    attribute="class"
    defaultTheme="dark"
    themes={["dark", "light"]}
    disableTransitionOnChange
  >
    <App />
  </ThemeProvider>
);