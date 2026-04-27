/**
 * PHOBOS LLM Cartridge System — Active Slot Manager
 *
 * Singleton. All cartridge activate/deactivate operations go through here.
 * Persists slot state to CartridgeStore. Restarts the correct llama-server
 * process with the updated --lora args when a slot changes.
 *
 * Compatibility resolution order:
 *   1. compatibleModels contains "*" → family-level match on baseModel vs GGUFSpec.family
 *   2. compatibleModels is an explicit list → active modelId must appear exactly
 */

import { getSpec }                             from './PhobosLocalManager.js';
import { startServer, stopServer, getServerStatus } from './LlamaServerManager.js';
import type { CartridgeStore }                 from '../db/CartridgeStore.js';
import type { CartridgeBinding, CompatibilityResult } from './CartridgeTypes.js';

type Persona = 'sayon' | 'seren';

// ── Singleton state ───────────────────────────────────────────────────────────

const activeBindings: Record<Persona, CartridgeBinding | null> = {
  sayon: null,
  seren: null,
};

let _store: CartridgeStore | null = null;

export function initCartridgeManager(store: CartridgeStore): void {
  _store = store;
}

function store(): CartridgeStore {
  if (!_store) throw new Error('CartridgeManager not initialized — call initCartridgeManager() first');
  return _store;
}

// ── Boot reconciliation ───────────────────────────────────────────────────────

/**
 * Called once at boot after CartridgeStore.ensureTable().
 * Restores in-memory bindings from persisted slot state.
 */
export async function reconcileCartridgeSlots(): Promise<void> {
  for (const persona of ['sayon', 'seren'] as const) {
    const slot = await store().getActiveSlot(persona);
    if (!slot.cartridgeId) { activeBindings[persona] = null; continue; }

    const record = await store().get(slot.cartridgeId);
    if (!record) {
      // Cartridge was deleted from disk — clear stale slot.
      await store().clearActiveSlot(persona);
      activeBindings[persona] = null;
      console.warn(`[CartridgeManager] ${persona}: stale slot reference "${slot.cartridgeId}" cleared`);
      continue;
    }
    activeBindings[persona] = { cartridgeId: record.id, loraPath: record.lora_path, weight: slot.weight };
  }
}

// ── Compatibility check ───────────────────────────────────────────────────────

// export async function checkCompatibility( //old function saved while testing
//   cartridgeId: string,
//   persona: Persona,
// ): Promise<CompatibilityResult> {
//   const record = await store().get(cartridgeId);
//   if (!record) {
//     return { compatible: false, reason: 'family_mismatch', activeModelId: '', activeFamily: '' };
//   }

// ── Compatibility check ───────────────────────────────────────────────────────

export async function checkCompatibility(
  cartridgeOrId: string | any,
  persona: Persona,
): Promise<CompatibilityResult> {
  const record = typeof cartridgeOrId === 'string' 
    ? await store().get(cartridgeOrId) 
    : cartridgeOrId;
  if (!record) {
    return { compatible: false, reason: 'family_mismatch', activeModelId: '', activeFamily: '' };
  }

  const status        = getServerStatus();
  const activeModelId = status[persona].modelId;

  if (!activeModelId) return { compatible: true }; // server not running — check later

  const spec = getSpec(activeModelId);
  if (!spec)  return { compatible: true };           // unknown model — allow through

  const activeFamily     = spec.family;
  const compatibleModels = tryParseJson<string[]>(record.compatible_models, []);
  const hasWildcard      = compatibleModels.includes('*');

  if (hasWildcard) {
    // Family match: normalize both to lowercase, check prefix overlap.
    const cartFamily  = record.base_model.toLowerCase().trim();
    const serverFamily = activeFamily.toLowerCase().trim();
    if (!serverFamily.startsWith(cartFamily) && !cartFamily.startsWith(serverFamily)) {
      return { compatible: false, reason: 'family_mismatch', activeModelId, activeFamily };
    }
    return { compatible: true };
  }

  // Explicit list — exact modelId match required.
  if (!compatibleModels.includes(activeModelId)) {
    return { compatible: false, reason: 'model_not_in_list', activeModelId, activeFamily };
  }
  return { compatible: true };
}

// ── Slot operations ───────────────────────────────────────────────────────────

export async function activateCartridge(
  persona: Persona,
  cartridgeId: string,
  weight?: number,
): Promise<void> {
  const record = await store().get(cartridgeId);
  if (!record) throw new Error(`Cartridge not found: ${cartridgeId}`);

  const compat = await checkCompatibility(cartridgeId, persona);
  if (!compat.compatible) {
    const compatibleModels = tryParseJson<string[]>(record.compatible_models, []);
    const why = compat.reason === 'family_mismatch'
      ? `Cartridge family "${record.base_model}" does not match active model family "${compat.activeFamily}" (${compat.activeModelId})`
      : `Active model "${compat.activeModelId}" is not in this cartridge's allow-list. Allowed: ${compatibleModels.join(', ')}`;
    throw new Error(`Cartridge compatibility check failed: ${why}`);
  }

  const finalWeight: number = weight ?? record.recommended_weight;
  const binding: CartridgeBinding = {
    cartridgeId: record.id,
    loraPath:    record.lora_path,
    weight:      finalWeight,
  };

  // Persist before restarting — if restart fails, at least the DB reflects intent.
  await store().setActiveSlot(persona, record.id, finalWeight);
  activeBindings[persona] = binding;

  await _restartPersonaServer(persona);
  console.log(`[CartridgeManager] ${persona}: activated "${record.name}" (weight=${finalWeight})`);
}

export async function deactivateCartridge(persona: Persona): Promise<void> {
  const prev = activeBindings[persona];
  await store().clearActiveSlot(persona);
  activeBindings[persona] = null;
  await _restartPersonaServer(persona);
  if (prev) console.log(`[CartridgeManager] ${persona}: deactivated "${prev.cartridgeId}"`);
}

export function getActiveBinding(persona: Persona): CartridgeBinding | null {
  return activeBindings[persona];
}

// ── Server restart ────────────────────────────────────────────────────────────

async function _restartPersonaServer(persona: Persona): Promise<void> {
  const status  = getServerStatus();
  const current = status[persona];

  if (!current.modelId || current.state === 'stopped') {
    // Not running — binding will be applied next time startServer is called.
    return;
  }

  await stopServer(persona);
  await new Promise<void>(r => setTimeout(r, 500));

  const binding = activeBindings[persona];
  await startServer(persona, {
    modelId:          current.modelId,
    port:             current.port,
    gpuLayers:        current.gpuLayers,
    contextSize:      current.contextSize,
    threads:          current.threads,
    deviceIndex:      current.deviceIndex,
    gpuBackend:       current.gpuBackend as 'cuda' | 'vulkan' | 'metal' | undefined,
    cartridgeBinding: binding ?? undefined,
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function tryParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export const CartridgeManager = {
  getInstance: () => ({
    initCartridgeManager,
    reconcileCartridgeSlots,
    checkCompatibility,
    activateCartridge,
    deactivateCartridge,
    getActiveBinding
  })
};