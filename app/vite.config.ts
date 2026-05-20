import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import fs from "fs";

// ── Monaco worker copy plugin ─────────────────────────────────────────────────
// Copies node_modules/monaco-editor/min/vs → public/monaco/vs once per build.
// MonacoPanel.tsx loader.config({ paths: { vs: '/monaco/vs' } }) resolves
// workers from PHOBOS's own origin — zero external requests.
function monacoWorkerCopy(): import("vite").Plugin {
  return {
    name: "monaco-worker-copy",
    buildStart() {
      const src  = path.resolve(__dirname, "node_modules/monaco-editor/min/vs");
      const dest = path.resolve(__dirname, "public/monaco/vs");
      if (!fs.existsSync(src)) {
        this.warn("monaco-editor not installed — run: npm install @monaco-editor/react monaco-editor");
        return;
      }
      if (fs.existsSync(dest)) return;
      copyDirSync(src, dest);
    },
  };
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'electron' ? './' : '/phobos/',
 
  server: {
    host: '::',
    port: 5173,
    // COOP+COEP on the parent page makes it cross-origin isolated, which is
    // required for Godot's iframe to use SharedArrayBuffer (Wasm threads).
    // Blockbench and SculptGL are proxied through Vite and would inherit COEP,
    // but their proxy entries use configure/proxyRes to strip it before the
    // browser sees the response — so their iframes don't inherit COEP and their
    // sub-resources don't need CORP headers to load.
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    hmr: { overlay: false },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: false,
      },

      // /tools/* editors are all proxied through Vite so their iframes are
      // same-origin with the parent (:5173). Same-origin iframes are exempt
      // from COEP enforcement — no CORP negotiation required.
      // Godot, Blockbench, and SculptGL are served by Fastify @fastify/static
      // on :3001. Stirling is proxied separately under /api/tools/stirling/app/*.
      '/tools/godot': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/tools/blockbench': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/tools/sculptgl': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
 
  build: {
    target: 'esnext',
  },
 
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
 
  plugins: [
    react(),
    monacoWorkerCopy(),
    mode === 'development' && componentTagger(),
  ].filter(Boolean),
 
  resolve: {
    alias: {
      '@':       path.resolve(__dirname, './src'),
      '@engine': path.resolve(__dirname, './src/components/audio/engine'),
    },
  },
}));