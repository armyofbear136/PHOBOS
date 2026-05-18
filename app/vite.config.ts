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

// ── wasm-pandoc copy plugin ───────────────────────────────────────────────────
// Copies node_modules/wasm-pandoc/src → public/pandoc once per build.
// pandoc-worker.js loads from /pandoc/index.browser.js as a static file,
// completely bypassing Vite's module graph. WASI imports never touch Rollup.
function wasmPandocCopy(): import("vite").Plugin {
  return {
    name: "wasm-pandoc-copy",
    buildStart() {
      const src  = path.resolve(__dirname, "node_modules/wasm-pandoc/src");
      const dest = path.resolve(__dirname, "public/pandoc");
      if (!fs.existsSync(src)) {
        this.warn("wasm-pandoc not installed — run: npm install wasm-pandoc");
        return;
      }
      fs.mkdirSync(dest, { recursive: true });

      // Always ensure pandoc.wasm is present — the full dir copy is skipped
      // when public/pandoc/ already exists in git, so wasm never lands.
      const wasmSrc  = path.join(src, "pandoc.wasm");
      const wasmDest = path.join(dest, "pandoc.wasm");
      if (fs.existsSync(wasmSrc) && !fs.existsSync(wasmDest)) {
        fs.copyFileSync(wasmSrc, wasmDest);
      }

      // Copy @bjorn3/browser_wasi_shim/dist/* into public/pandoc/wasi_shim/
      // so core.js can import it as a relative URL. Bare npm specifiers don't
      // resolve in browser module workers (pandoc-worker.js is a static file,
      // bypassing Vite's bundler). The dist/ folder has no bundle.js — it
      // ships as separate ES modules that cross-import each other, so we copy
      // the entire dist directory.
      const shimSrc  = path.resolve(__dirname, "node_modules/@bjorn3/browser_wasi_shim/dist");
      const shimDest = path.join(dest, "wasi_shim");
      if (fs.existsSync(shimSrc) && !fs.existsSync(shimDest)) {
        copyDirSync(shimSrc, shimDest);
      }

      // Patch index.browser.js: replace `await import("./pandoc.wasm")` with a
      // direct fetch(). ESM dynamic import() of .wasm is rejected by browsers
      // with strict MIME checking when served as a raw static file. Vite handles
      // it at build time, but pandoc-worker.js bypasses Vite entirely.
      const browserEntryPath = path.join(dest, "index.browser.js");
      if (fs.existsSync(browserEntryPath)) {
        const entry = fs.readFileSync(browserEntryPath, "utf8");
        const patched = entry
          .replace(
            /const pandocWasmModule\s*=\s*await import\(["']\.\/pandoc\.wasm["']\)\s*\n\s*const pandocWasmLocation\s*=\s*pandocWasmModule\.default\s*\n\s*const pandocWasmFetch\s*=\s*await fetch\(pandocWasmLocation\)/,
            'const pandocWasmFetch = await fetch(new URL("./pandoc.wasm", import.meta.url))'
          );
        if (patched !== entry) fs.writeFileSync(browserEntryPath, patched, "utf8");
      }

      // Rewrite bare specifier in core.js to the relative wasi_shim/index.js.
      const corePath = path.join(dest, "core.js");
      if (fs.existsSync(corePath)) {
        const content = fs.readFileSync(corePath, "utf8");
        const patched = content.replace(
          /from\s+["']@bjorn3\/browser_wasi_shim["']/g,
          'from "./wasi_shim/index.js"'
        );
        if (patched !== content) fs.writeFileSync(corePath, patched, "utf8");
      }
    },
  };
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
    wasmPandocCopy(),
    mode === 'development' && componentTagger(),
  ].filter(Boolean),
 
  resolve: {
    alias: {
      '@':       path.resolve(__dirname, './src'),
      '@engine': path.resolve(__dirname, './src/components/audio/engine'),
    },
  },
}));