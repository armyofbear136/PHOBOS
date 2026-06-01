/**
 * coordinator-worker-bootstrap.mjs
 *
 * Loaded via --import in the coordinator Worker thread when the server runs
 * under `npx tsx` in dev/test mode. Uses module.register() with tsx/esm,
 * which is the correct tsx 4.x API for enabling TypeScript resolution and
 * .js → .ts extension remapping inside Worker threads.
 *
 * This file MUST be a plain .mjs (not .ts) — it is loaded before any TypeScript
 * resolution is active, so it cannot itself be TypeScript.
 *
 * NOT used in the production SEA build (coordinatorPath resolves to .cjs there).
 */
import { register }    from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Resolve tsx/esm from this file's own location. createRequire walks up the
// directory tree, so this works whether tsx is a local devDependency or
// installed globally — as long as it is reachable from the project root.
const _require  = createRequire(import.meta.url);
const tsxEsmPath = _require.resolve('tsx/esm');

// register() calls tsx's initialize() hook synchronously before any module
// in the worker is evaluated. Passing data: {} satisfies tsx's check that it
// was loaded via --import (not the deprecated --loader flag).
register(pathToFileURL(tsxEsmPath).href, import.meta.url, { data: {} });
