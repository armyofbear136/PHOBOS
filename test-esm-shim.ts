/**
 * test-esm-shim.ts — loaded via --import before any module in the tsx test run.
 *
 * tsx runs server.ts as ESM where __dirname is not defined.  The built client
 * compiles to CJS (esbuild) where __dirname is injected by the bundler.
 * This shim bridges the gap for the test environment only — no source files
 * need to change.
 *
 * Usage: tsx --import ./test-esm-shim.ts server.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Polyfill __dirname and __filename on globalThis so every module that
// references them as bare globals (without a typeof guard) finds them defined.
// The value is the project root — equivalent to what esbuild/CJS provides.
const _url  = new URL(import.meta.url);
const _file = fileURLToPath(_url);
const _dir  = path.dirname(_file);

(globalThis as Record<string, unknown>).__filename = _file;
(globalThis as Record<string, unknown>).__dirname  = _dir;
