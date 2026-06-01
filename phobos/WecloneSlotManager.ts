/**
 * WecloneSlotManager — orchestrates WeClone model activation and deactivation.
 *
 * Responsibilities:
 *   activateClone   — snapshot current slot, stop server, start clone model+LoRA,
 *                     persist holding snapshot to DB.
 *   deactivateClone — stop clone model, restore holding snapshot, clear DB row.
 *   hotswapForRemote — temporarily restore the original model for a remote user
 *                      request, then reload the clone.  Used exclusively for
 *                      remote (WebRTC-originated) requests — never for the local
 *                      desktop user (who deactivates permanently on Prime query).
 *   getActive       — sync in-memory read of current slot state.
 *
 * Model swapping reuses the same startServer / stopServer calls used by
 * ImageGenerationHandler and CartridgeManager — no new mechanism needed.
 *
 * There is no fast path: every activation restarts the server with the clone's
 * base_model + LoRA.  Without the LoRA the clone is non-functional.
 */

import {
  startServer,
  stopServer,
  getServerStatus,
  awaitServerReady,
  SAYON_PORT,
  SEREN_PORT,
  type ServerConfig,
} from './LlamaServerManager.js';
import {
  WecloneActivationStore,
  type SlotName,
  type SlotSnapshot,
  type ActiveSlotInfo,
} from '../db/WecloneActivationStore.js';
import { WecloneStore }    from '../db/WecloneStore.js';
import { CartridgeStore }  from '../db/CartridgeStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import type { CartridgeBinding } from './CartridgeTypes.js';

// ── In-memory mirror of DB state ──────────────────────────────────────────────
// Avoids DB round-trips on every coordinatorCall / engineStream guard check.
// Kept in sync by activate / deactivate.  Initialised from DB at server boot
// via initWecloneSlotManager().

const _active: { sayon: ActiveSlotInfo | null; seren: ActiveSlotInfo | null } = {
  sayon: null,
  seren: null,
};

// ── Boot init ─────────────────────────────────────────────────────────────────

/**
 * Call once at server startup (after system DB is open) to restore in-memory
 * state from any persisted activation that survived a server restart.
 */
export async function initWecloneSlotManager(): Promise<void> {
  const store = _activationStore();
  const both  = await store.getBothSlots();
  _active.sayon = both.sayon;
  _active.seren = both.seren;
  if (_active.sayon) console.log(`[WeCloneSlot] Restored: sayon → clone ${_active.sayon.cloneId}`);
  if (_active.seren) console.log(`[WeCloneSlot] Restored: seren → clone ${_active.seren.cloneId}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Sync read from in-memory mirror.  Zero DB cost. */
export function getActive(slot: SlotName): ActiveSlotInfo | null {
  return _active[slot];
}

/**
 * Activate a clone on its designated slot.
 *
 * 1. Snapshot what is currently running on the slot.
 * 2. Stop the current server.
 * 3. Start the clone's base_model + LoRA.
 * 4. Persist the snapshot and clone ID to DB and in-memory mirror.
 *
 * Throws if the clone has no cartridge — a LoRA-less clone is non-functional.
 */
export async function activateClone(
  cloneId:  string,
  username: string,
): Promise<void> {
  const { clone, cartridgeBinding } = await _resolveClone(cloneId, username);
  const slot = clone.slot;

  if (_active[slot]) {
    // Already active on this slot — deactivate first, then activate the new one.
    await deactivateClone(slot);
  }

  const snapshot  = _snapshotSlot(slot);
  const baseModel = await _resolveBaseModel(clone.cartridge_id!, username);

  console.log(`[WeCloneSlot] Activating clone "${clone.display_name}" on ${slot} — stopping current model`);
  await stopServer(slot);

  const cfg: ServerConfig = {
    modelId:          baseModel,
    port:             slot === 'sayon' ? SAYON_PORT : SEREN_PORT,
    gpuLayers:        snapshot.gpuLayers,
    contextSize:      clone.context_window > 0 ? clone.context_window : snapshot.contextSize,
    threads:          snapshot.threads,
    deviceIndex:      snapshot.deviceIndex,
    gpuBackend:       snapshot.gpuBackend,
    cartridgeBinding,
  };

  console.log(`[WeCloneSlot] Starting clone model "${cfg.modelId}" on ${slot}`);
  await startServer(slot, cfg);
  await awaitServerReady(slot);

  await _activationStore().setActiveSlot(slot, cloneId, username, snapshot);
  _active[slot] = { cloneId, username, holdingSnapshot: snapshot };
  console.log(`[WeCloneSlot] Clone "${clone.display_name}" active on ${slot}`);
}

/**
 * Deactivate the active clone on a slot and restore the original model.
 * No-op if no clone is active on the slot.
 */
export async function deactivateClone(slot: SlotName): Promise<void> {
  const info = _active[slot];
  if (!info) return;

  console.log(`[WeCloneSlot] Deactivating clone ${info.cloneId} on ${slot} — restoring previous model`);
  await stopServer(slot);

  const { holdingSnapshot: snap } = info;
  await startServer(slot, _snapshotToConfig(snap));
  await awaitServerReady(slot);

  await _activationStore().clearActiveSlot(slot);
  _active[slot] = null;
  console.log(`[WeCloneSlot] ${slot} restored to model "${snap.modelId}"`);
}

/**
 * hotswapForRemote — used exclusively when a remote (WebRTC) user requests
 * the slot while a clone is active.
 *
 * Temporarily restores the original model, runs the remote handler callback,
 * then reloads the clone — always, even if the callback throws.
 */
export async function hotswapForRemote(
  slot:            SlotName,
  remoteHandler:   () => Promise<void>,
): Promise<void> {
  const info = _active[slot];
  if (!info) {
    // No clone active — just run the handler directly.
    await remoteHandler();
    return;
  }

  const { holdingSnapshot: snap, cloneId, username } = info;
  console.log(`[WeCloneSlot] Hotswap: unloading clone ${cloneId} for remote request on ${slot}`);

  await stopServer(slot);
  await startServer(slot, _snapshotToConfig(snap));
  await awaitServerReady(slot);

  try {
    await remoteHandler();
  } finally {
    // Reload the clone unconditionally — the slot must be restored whether
    // the remote request succeeded or failed.
    console.log(`[WeCloneSlot] Hotswap: reloading clone ${cloneId} on ${slot}`);
    await stopServer(slot);
    const { clone, cartridgeBinding } = await _resolveClone(cloneId, username);
    const baseModelId = await _resolveBaseModel(clone.cartridge_id!, username);
    await startServer(slot, {
      ..._snapshotToConfig(snap),
      modelId:          baseModelId,
      contextSize:      clone.context_window > 0 ? clone.context_window : snap.contextSize,
      cartridgeBinding,
    });
    await awaitServerReady(slot);
    // In-memory mirror and DB already reflect the active clone — no write needed.
    console.log(`[WeCloneSlot] Hotswap complete: clone ${cloneId} reloaded on ${slot}`);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _activationStore(): WecloneActivationStore {
  return new WecloneActivationStore(DatabaseManager.getInstance());
}

/** Capture the live running config for a slot as a SlotSnapshot. */
function _snapshotSlot(slot: SlotName): SlotSnapshot {
  const s = getServerStatus()[slot];
  return {
    role:        slot,
    modelId:     s.modelId,
    port:        s.port,
    gpuLayers:   s.gpuLayers,
    contextSize: s.contextSize,
    threads:     s.threads,
    deviceIndex: s.deviceIndex,
    gpuBackend:  s.gpuBackend as SlotSnapshot['gpuBackend'],
  };
}

/** Convert a persisted SlotSnapshot back to a ServerConfig for startServer. */
function _snapshotToConfig(snap: SlotSnapshot): ServerConfig {
  return {
    modelId:     snap.modelId,
    port:        snap.port,
    gpuLayers:   snap.gpuLayers,
    contextSize: snap.contextSize,
    threads:     snap.threads,
    deviceIndex: snap.deviceIndex,
    gpuBackend:  snap.gpuBackend,
  };
}

/** Resolve a clone profile + cartridge binding.  Throws if clone or cartridge missing. */
async function _resolveClone(
  cloneId:  string,
  username: string,
): Promise<{ clone: Awaited<ReturnType<WecloneStore['getProfile']>> & object; cartridgeBinding: CartridgeBinding }> {
  const userDb = DatabaseManager.getUserDb(username);
  const ws     = new WecloneStore(userDb);
  const clone  = await ws.getProfile(cloneId);
  if (!clone) throw new Error(`[WeCloneSlot] Clone ${cloneId} not found for user ${username}`);
  if (!clone.cartridge_id) throw new Error(`[WeCloneSlot] Clone ${cloneId} has no cartridge — cannot activate`);

  const cartridge = await new CartridgeStore(DatabaseManager.getInstance()).get(clone.cartridge_id);
  if (!cartridge) throw new Error(`[WeCloneSlot] Cartridge ${clone.cartridge_id} not found`);

  const cartridgeBinding: CartridgeBinding = {
    cartridgeId: cartridge.id,
    loraPath:    cartridge.lora_path,
    weight:      cartridge.recommended_weight,
  };

  return { clone, cartridgeBinding };
}

/** Fetch base_model string from a cartridge record. */
async function _resolveBaseModel(cartridgeId: string, _username: string): Promise<string> {
  const cartridge = await new CartridgeStore(DatabaseManager.getInstance()).get(cartridgeId);
  if (!cartridge) throw new Error(`[WeCloneSlot] Cartridge ${cartridgeId} not found`);
  return cartridge.base_model;
}
