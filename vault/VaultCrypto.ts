/**
 * VaultCrypto.ts — Argon2 engine registration and ProtectedValue helpers.
 *
 * Implements kdbxweb's Argon2 impl by instantiating argon2.wasm directly via
 * WebAssembly.instantiate — no argon2-browser JS wrapper involved at all.
 *
 * WASM export map (minified by Emscripten):
 *   c = memory (WebAssembly.Memory)
 *   d = __wasm_call_ctors (init — must call once after instantiate)
 *   f = malloc
 *   g = free
 *   j = argon2_encodedlen
 *   l = argon2_hash_ext
 *
 * WASM import map:
 *   a.a = emscripten_memcpy_big (dest, src, num)
 *   a.b = emscripten_resize_heap (requestedSize) → bool
 *
 * The WASM file is staged to dist/node_modules/argon2-browser/dist/argon2.wasm
 * by build.js. Resolved at runtime relative to process.execPath.
 *
 * initVaultCrypto() registers the impl. The WASM is loaded lazily on first
 * vault operation — not at boot — so a missing WASM file surfaces on first
 * use rather than preventing server startup.
 */

import * as fs                                            from 'node:fs';
import * as path                                          from 'node:path';
import { CryptoEngine, ProtectedValue, KdbxCredentials } from 'kdbxweb';

// ── WASM instance (loaded once on first vault op) ─────────────────────────────

interface Argon2Exports {
  c: WebAssembly.Memory;                                    // memory
  d: () => void;                                            // __wasm_call_ctors
  f: (size: number) => number;                              // malloc
  g: (ptr: number) => void;                                 // free
  j: (t: number, m: number, p: number, saltLen: number,    // argon2_encodedlen
      hashLen: number, type: number) => number;
  l: (t: number, m: number, p: number,                     // argon2_hash_ext
      pwd: number, pwdLen: number,
      salt: number, saltLen: number,
      hash: number, hashLen: number,
      encoded: number, encodedLen: number,
      type: number,
      secret: number, secretLen: number,
      ad: number, adLen: number,
      version: number) => number;
}

let _wasm: Argon2Exports | null = null;

async function _getWasm(): Promise<Argon2Exports> {
  if (_wasm) return _wasm;

  const wasmPath = path.join(
    path.dirname(process.execPath),
    'node_modules', 'argon2-browser', 'dist', 'argon2.wasm',
  );
  const wasmBytes = fs.readFileSync(wasmPath);

  let memory: WebAssembly.Memory;

  const imports = {
    a: {
      // emscripten_memcpy_big
      a: (dest: number, src: number, num: number): void => {
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
      },
      // emscripten_resize_heap
      b: (requestedSize: number): number => {
        requestedSize = requestedSize >>> 0;
        try {
          const delta = ((requestedSize - memory.buffer.byteLength + 65535) >>> 16);
          memory.grow(delta);
          return 1;
        } catch {
          return 0;
        }
      },
    },
  };

  const result = await WebAssembly.instantiate(wasmBytes, imports);
  const exp = result.instance.exports as unknown as Argon2Exports;

  memory = exp.c;
  exp.d(); // __wasm_call_ctors — required once after instantiate

  _wasm = exp;
  return _wasm;
}

// ── Argon2 hash via direct WASM call ─────────────────────────────────────────

async function _argon2Hash(
  pass:        Uint8Array,
  salt:        Uint8Array,
  memory:      number,
  iterations:  number,
  hashLen:     number,
  parallelism: number,
  type:        number,
  version:     number,
): Promise<Uint8Array> {
  const exp  = await _getWasm();
  const heap = (): Uint8Array => new Uint8Array(exp.c.buffer);

  // Write pass into WASM heap (null-terminated)
  const pwdPtr = exp.f(pass.length + 1);
  heap().set(pass, pwdPtr);
  heap()[pwdPtr + pass.length] = 0;

  // Write salt into WASM heap (null-terminated)
  const saltPtr = exp.f(salt.length + 1);
  heap().set(salt, saltPtr);
  heap()[saltPtr + salt.length] = 0;

  // Allocate hash output buffer
  const hashPtr = exp.f(hashLen);

  // Allocate encoded output buffer (we don't use encoded but argon2_hash_ext requires it)
  const encLen = exp.j(iterations, memory, parallelism, salt.length, hashLen, type);
  const encPtr = exp.f(encLen + 1);

  let code: number;
  try {
    code = exp.l(
      iterations, memory, parallelism,
      pwdPtr, pass.length,
      saltPtr, salt.length,
      hashPtr, hashLen,
      encPtr, encLen,
      type,
      0, 0, // secret, secretLen
      0, 0, // ad, adLen
      version,
    );
  } finally {
    exp.g(pwdPtr);
    exp.g(saltPtr);
    exp.g(encPtr);
  }

  if (code !== 0) {
    exp.g(hashPtr);
    throw new Error(`[Vault] Argon2 hash failed with code ${code}`);
  }

  // Copy hash out before freeing — heap() re-reads mem.buffer in case it grew
  const hashBytes = new Uint8Array(heap().buffer, hashPtr, hashLen).slice();
  exp.g(hashPtr);
  return hashBytes;
}

// ── Registration ──────────────────────────────────────────────────────────────

let _initialized = false;

export function initVaultCrypto(): void {
  if (_initialized) return;
  _initialized = true;

  CryptoEngine.setArgon2Impl(
    async (
      password:    ArrayBuffer,
      salt:        ArrayBuffer,
      memory:      number,
      iterations:  number,
      length:      number,
      parallelism: number,
      type:        number,
      version:     number,
    ): Promise<ArrayBuffer> => {
      const hash = await _argon2Hash(
        new Uint8Array(password).slice(),
        new Uint8Array(salt).slice(),
        memory,
        iterations,
        length,
        parallelism,
        type,
        version,
      );
      return hash.buffer as ArrayBuffer;
    },
  );
}

// ── ProtectedValue helpers ────────────────────────────────────────────────────

export function protectString(plaintext: string): ProtectedValue {
  return ProtectedValue.fromString(plaintext);
}

export function exposeProtected(value: ProtectedValue): string {
  return value.getText();
}

export function makeCredentials(masterPassword: string): KdbxCredentials {
  return new KdbxCredentials(ProtectedValue.fromString(masterPassword));
}
