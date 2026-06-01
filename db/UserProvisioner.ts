/**
 * UserProvisioner.ts — shared user provisioning logic.
 *
 * Used by both registerUserManagementRoutes (HTTP panel) and
 * DataChannelHandler (WebRTC guest auth). Kept here to avoid circular
 * imports between routes/ and webrtc/.
 *
 * provisionSystemUser        — create DB row, dirs, service accounts
 * queryDeprovisionInventory  — pre-flight: enumerate owned assets before deletion
 * deprovisionSystemUser      — two-phase: rescue assets → lost-and-found, then delete
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';
import { DatabaseManager, userDir }       from './DatabaseManager.js';
import { UserStore, type UserRole }       from './UserStore.js';
import { UserServiceTokenStore }          from './UserServiceTokenStore.js';
import { PluginStore }                    from './PluginStore.js';
import { CartridgeStore }                 from './CartridgeStore.js';
import { WecloneExporter }                from './WecloneExporter.js';
import type { PluginRecord }              from '../phobos/PluginTypes.js';
import type { CartridgeRecord }           from '../phobos/CartridgeTypes.js';
import {
  provisionUser   as jellyfinProvisionUser,
  deprovisionUser as jellyfinDeprovisionUser,
  removeLibrary   as jellyfinRemoveLibrary,
} from '../services/JellyfinManager.js';
import {
  provisionUser  as kavitaProvisionUser,
  deprovisionUser as kavitaDeprovisionUser,
} from '../services/KavitaManager.js';
import { MeridianDB } from '../meridian/db/db.js';

// ── Provision ─────────────────────────────────────────────────────────────────

export interface ProvisionResult {
  jellyfinOk: boolean;
  kavitaOk:   boolean;
  errors:     string[];
}

// ── Deprovision ───────────────────────────────────────────────────────────────

export interface DeprovisionInventory {
  plugins:      Array<{ pluginId: string; name: string; archivePath: string }>;
  cartridges:   Array<{ cartridgeId: string; name: string; installPath: string; loraPath: string }>;
  hasWeclone:   boolean;
  workspaceDir: string;
  libraryDir:   string;
  hasAssets:    boolean;
}

export interface RescuedItem {
  type:         'plugin' | 'cartridge' | 'weclone' | 'workspace' | 'library';
  name:         string;
  originalPath: string;
  rescuedPath:  string;
}

export interface DeprovisionResult {
  success:          boolean;
  lostAndFoundPath: string | null;
  rescuedItems:     RescuedItem[];
  message:          string | null;
}

// ── Lost-and-found root ───────────────────────────────────────────────────────

function lostAndFoundDir(username: string): string {
  return path.join(os.homedir(), '.phobos', 'lost-and-found', username);
}

// ── RESCUED.txt ───────────────────────────────────────────────────────────────

function writeRescuedTxt(
  lnfDir:       string,
  username:     string,
  rescuedItems: RescuedItem[],
  preserveAll:  boolean,
): void {
  const date      = new Date().toUTCString();
  const plugins   = rescuedItems.filter(i => i.type === 'plugin');
  const cartridges = rescuedItems.filter(i => i.type === 'cartridge');
  const weclone   = rescuedItems.filter(i => i.type === 'weclone');
  const workspaces = rescuedItems.filter(i => i.type === 'workspace');
  const library   = rescuedItems.filter(i => i.type === 'library');

  const lines: string[] = [
    `PHOBOS Lost & Found — ${username} — ${date}`,
    '='.repeat(60),
    '',
    `This directory was created when user '${username}' was removed from this PHOBOS installation.`,
    `The following files were preserved because they are owned by this user.`,
    '',
  ];

  if (plugins.length > 0) {
    lines.push(`PLUGINS (${plugins.length}):`);
    for (const p of plugins) lines.push(`  - ${p.name}  (${path.basename(p.rescuedPath)})`);
    lines.push('');
  }

  if (cartridges.length > 0) {
    lines.push(`CARTRIDGES (${cartridges.length}):`);
    for (const c of cartridges) lines.push(`  - ${c.name}  (${path.basename(c.rescuedPath)}/)`);
    lines.push('');
  }

  if (weclone.length > 0) {
    lines.push('WECLONE:');
    for (const w of weclone) lines.push(`  - ${path.basename(w.rescuedPath)}  (voice profile + LoRA)`);
    lines.push('');
  }

  if (preserveAll) {
    lines.push(workspaces.length > 0
      ? 'WORKSPACES: preserved (user chose to save all data)'
      : 'WORKSPACES: none found');
    lines.push(library.length > 0
      ? 'LIBRARY: preserved (user chose to save all data)'
      : 'LIBRARY: none found');
    lines.push('');
  } else {
    lines.push('WORKSPACES: deleted (user did not choose full preservation)');
    lines.push('LIBRARY: deleted (user did not choose full preservation)');
    lines.push('');
  }

  lines.push('HOW TO RESTORE:');
  lines.push('  Plugin  (.phobos): Plugin Library panel → drag-and-drop or Install from file.');
  lines.push('  Cartridge: Settings → Cartridges → Install from file.');
  lines.push('  Weclone (.weclone): Settings → Weclone → Import.');
  lines.push('');

  fs.writeFileSync(path.join(lnfDir, 'RESCUED.txt'), lines.join('\n'), 'utf-8');
}

// ── Move helpers ──────────────────────────────────────────────────────────────

/** Move src to dest, creating parent dirs. Falls back to copy+delete on cross-device. */
function moveItem(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch {
    // Cross-device rename fails on Windows/Linux — fall back to recursive copy.
    copyRecursive(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}



export async function provisionSystemUser(
  username:     string,
  role:         UserRole,
  userStore:    UserStore,
  display_name?: string,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { jellyfinOk: false, kavitaOk: false, errors: [] };

  await userStore.create({ username, display_name: display_name ?? username, role });

  const userDb = DatabaseManager.getUserDb(username);
  await userDb.initialize();

  const base = userDir(username);
  fs.mkdirSync(path.join(base, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(base, 'vault'),      { recursive: true });
  fs.mkdirSync(path.join(base, 'skills'),     { recursive: true });

  const phobosDir = path.join(os.homedir(), '.phobos');
  fs.mkdirSync(path.join(phobosDir, 'media', 'jellyfin', username, 'phobosVideos'), { recursive: true });
  fs.mkdirSync(path.join(phobosDir, 'media', 'kavita',   username, 'phobosDocs'), { recursive: true });
  fs.mkdirSync(path.join(phobosDir, 'media', 'meridian', username, 'phobosPhotos'), { recursive: true });

  // Register the per-user Meridian phobosPhotos library in the shared media DB.
  const photosPath = path.join(phobosDir, 'media', 'meridian', username, 'phobosPhotos');
  try {
    const crypto   = await import('node:crypto');
    const meridian = new MeridianDB(DatabaseManager.getInstance());
    const libId    = crypto.createHash('sha256').update(photosPath + username).digest('hex').slice(0, 16);
    await meridian.upsertLibrary({
      id:         libId,
      path:       photosPath,
      label:      'phobosPhotos',
      enabled:    true,
      lastScanAt: null,
      fileCount:  0,
      userId:     username,
      createdAt:  new Date().toISOString(),
    });
    console.log(`[UserProvisioner] Meridian phobosPhotos library created for ${username}`);
  } catch (err) {
    console.warn(`[UserProvisioner] Meridian library creation failed for ${username} (non-fatal):`, err);
  }

  try {
    const jf = await jellyfinProvisionUser(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    await tokenStore.setJellyfin({ user_id: jf.userId, access_token: jf.accessToken });
    result.jellyfinOk = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    result.errors.push(`Jellyfin: ${msg}`);
    console.warn(`[UserProvisioner] Jellyfin provision failed for ${username} (non-fatal): ${msg}`);
  }

  try {
    const tokenStore = new UserServiceTokenStore(userDb);
    // Pass the stored password so re-provision uses the same credential.
    // If this is the first provisioning, existingKavita is null and a new password is generated.
    const existingKavita = await tokenStore.getKavita().catch(() => null);
    const kv = await kavitaProvisionUser(username, existingKavita?.password);
    await tokenStore.setKavita({
      user_id:       kv.userId,
      jwt:           kv.jwt,
      refresh_token: kv.refreshToken,
      api_key:       kv.apiKey,
      password:      kv.password,
    });
    result.kavitaOk = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    result.errors.push(`Kavita: ${msg}`);
    console.warn(`[UserProvisioner] Kavita provision failed for ${username} (non-fatal): ${msg}`);
  }

  return result;
}

/**
 * Pre-flight query — call this before showing the deprovision UI.
 * Returns everything the user owns so the UI can show an inventory summary
 * and let the admin make an informed preservation choice.
 */
export async function queryDeprovisionInventory(
  username:  string,
  systemDb:  DatabaseManager,
): Promise<DeprovisionInventory> {
  const pluginStore    = new PluginStore(systemDb);
  const cartridgeStore = new CartridgeStore(systemDb);

  await pluginStore.ensureTable();
  const [ownedPlugins, ownedCartridges] = await Promise.all([
    pluginStore.queryOwnedByUser(username),
    cartridgeStore.queryOwnedByUser(username),
  ]);

  // Check for weclone data by inspecting the user DB — non-fatal if missing.
  let hasWeclone = false;
  try {
    const userDb = DatabaseManager.getUserDb(username);
    const rows   = await userDb.query<{ id: string }>(
      `SELECT id FROM weclone_profiles LIMIT 1`, [],
    );
    hasWeclone = rows.length > 0;
  } catch { /* user DB may not be initialized */ }

  const workspaceDir = path.join(userDir(username), 'workspaces');
  const libraryDir   = path.join(userDir(username), 'library');

  return {
    plugins:   ownedPlugins.map(p => ({
      pluginId:    p.id,
      name:        p.name,
      archivePath: p.archive_path,
    })),
    cartridges: ownedCartridges.map(c => ({
      cartridgeId: c.id,
      name:        c.name,
      installPath: c.install_path,
      loraPath:    c.lora_path,
    })),
    hasWeclone,
    workspaceDir,
    libraryDir,
    hasAssets: ownedPlugins.length > 0 || ownedCartridges.length > 0 || hasWeclone,
  };
}

/**
 * Two-phase deprovisioning.
 *
 * Phase 1 — Asset rescue (before any deletion):
 *   - Owned plugins and cartridges always move to lost-and-found.
 *   - Weclone is always packaged to lost-and-found (irreplaceable voice data).
 *   - If preserveAll: workspaces and library also move to lost-and-found.
 *   - If !preserveAll: workspaces and library are deleted.
 *
 * Phase 2 — Existing deprovision steps run unchanged (service accounts,
 *   DB rows, user directory, media hub dirs).
 *
 * DB archive_path / install_path / lora_path are updated to the new
 * lost-and-found location so any other user can still load the asset.
 * owner_username is cleared (set NULL) — asset becomes unowned/shared.
 */
export async function deprovisionSystemUser(
  username:    string,
  systemDb:    DatabaseManager,
  userStore:   UserStore,
  preserveAll: boolean = false,
): Promise<DeprovisionResult> {
  const rescuedItems: RescuedItem[] = [];
  const lnfDir   = lostAndFoundDir(username);
  let   anyRescued = false;

  // ── Phase 1a: Rescue owned plugins ────────────────────────────────────────
  const pluginStore = new PluginStore(systemDb);
  await pluginStore.ensureTable();
  const ownedPlugins = await pluginStore.queryOwnedByUser(username);

  if (ownedPlugins.length > 0) {
    const destDir = path.join(lnfDir, 'plugins');
    fs.mkdirSync(destDir, { recursive: true });

    for (const plugin of ownedPlugins) {
      const destPath = path.join(destDir, path.basename(plugin.archive_path));
      try {
        if (fs.existsSync(plugin.archive_path)) {
          moveItem(plugin.archive_path, destPath);
        }
        // Update DB: point archive_path to new location, clear owner.
        await systemDb.execWithParams(
          `UPDATE plugins SET archive_path = ?, owner_username = NULL WHERE id = ?`,
          [destPath, plugin.id],
        );
        rescuedItems.push({
          type:         'plugin',
          name:         plugin.name,
          originalPath: plugin.archive_path,
          rescuedPath:  destPath,
        });
        anyRescued = true;
      } catch (err) {
        console.warn(`[UserProvisioner] Could not rescue plugin '${plugin.name}': ${(err as Error).message}`);
      }
    }
  }

  // ── Phase 1b: Rescue owned cartridges ─────────────────────────────────────
  const cartridgeStore = new CartridgeStore(systemDb);
  const ownedCartridges = await cartridgeStore.queryOwnedByUser(username);

  if (ownedCartridges.length > 0) {
    const destDir = path.join(lnfDir, 'cartridges');
    fs.mkdirSync(destDir, { recursive: true });

    for (const cart of ownedCartridges) {
      const destInstallPath = path.join(destDir, path.basename(cart.install_path));
      const destLoraPath    = path.join(destInstallPath, path.basename(cart.lora_path));
      try {
        if (fs.existsSync(cart.install_path)) {
          moveItem(cart.install_path, destInstallPath);
        }
        // Update DB: new paths, clear owner.
        await systemDb.execWithParams(
          `UPDATE cartridges
             SET install_path = ?, lora_path = ?, owner_username = NULL
           WHERE id = ?`,
          [destInstallPath, destLoraPath, cart.id],
        );
        rescuedItems.push({
          type:         'cartridge',
          name:         cart.name,
          originalPath: cart.install_path,
          rescuedPath:  destInstallPath,
        });
        anyRescued = true;
      } catch (err) {
        console.warn(`[UserProvisioner] Could not rescue cartridge '${cart.name}': ${(err as Error).message}`);
      }
    }
  }

  // ── Phase 1c: Package weclone (always — voice data is irreplaceable) ───────
  try {
    const exporter    = new WecloneExporter(systemDb);
    const wecloneDir  = path.join(lnfDir, 'weclone');
    const weclonePath = path.join(wecloneDir, `${username}.weclone`);
    fs.mkdirSync(wecloneDir, { recursive: true });
    const result = await exporter.export(username, weclonePath);
    if (result.success && result.outputPath) {
      rescuedItems.push({
        type:         'weclone',
        name:         `${username}.weclone`,
        originalPath: userDir(username),
        rescuedPath:  result.outputPath,
      });
      anyRescued = true;
    }
  } catch (err) {
    console.warn(`[UserProvisioner] Weclone export failed for ${username} (non-fatal): ${(err as Error).message}`);
  }

  // ── Phase 1d: Workspaces and library (preserveAll vs delete) ──────────────
  const workspaceDir = path.join(userDir(username), 'workspaces');
  const libraryDir   = path.join(userDir(username), 'library');

  if (preserveAll) {
    for (const { src, type } of [
      { src: workspaceDir, type: 'workspace' as const },
      { src: libraryDir,   type: 'library' as const   },
    ]) {
      if (fs.existsSync(src)) {
        const dest = path.join(lnfDir, type === 'workspace' ? 'workspaces' : 'library');
        try {
          moveItem(src, dest);
          rescuedItems.push({
            type,
            name:         type,
            originalPath: src,
            rescuedPath:  dest,
          });
          anyRescued = true;
        } catch (err) {
          console.warn(`[UserProvisioner] Could not move ${type} dir: ${(err as Error).message}`);
        }
      }
    }
  } else {
    // Delete personal files; plugins/cartridges/weclone already rescued above.
    for (const dir of [workspaceDir, libraryDir]) {
      try {
        if (fs.existsSync(dir)) {
          await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      } catch (err) {
        console.warn(`[UserProvisioner] Could not delete ${dir} (non-fatal): ${(err as Error).message}`);
      }
    }
  }

  // Write human-readable audit trail if anything was rescued.
  if (anyRescued) {
    try { writeRescuedTxt(lnfDir, username, rescuedItems, preserveAll); } catch { /* non-fatal */ }
  }

  // ── Phase 2: Original deprovision steps ───────────────────────────────────

  // Step 2a: Read service tokens before touching anything.
  let jellyfinUserId: string | null = null;
  let kavitaWasProvisioned          = false;
  try {
    const userDb     = DatabaseManager.getUserDb(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    const jfTokens   = await tokenStore.getJellyfin();
    const kvTokens   = await tokenStore.getKavita().catch(() => null);
    jellyfinUserId       = jfTokens?.user_id ?? null;
    kavitaWasProvisioned = !!(kvTokens?.user_id);
  } catch (err) {
    console.warn(`[UserProvisioner] Could not read service tokens for ${username} (continuing):`, err);
  }

  // Step 2b: Deprovision media hub accounts.
  if (jellyfinUserId) {
    try {
      await jellyfinDeprovisionUser(jellyfinUserId);
      await jellyfinRemoveLibrary(`${username}-media`);
    } catch (err) {
      console.warn(`[UserProvisioner] Jellyfin deprovision failed for ${username} (non-fatal):`, err);
    }
  }
  if (kavitaWasProvisioned) {
    try {
      await kavitaDeprovisionUser(username);
    } catch (err) {
      console.warn(`[UserProvisioner] Kavita deprovision failed for ${username} (non-fatal):`, err);
    }
  }

  // Step 2c: Clean all system DB rows that reference this user.
  await systemDb.execWithParams(
    `DELETE FROM access_codes WHERE issuing_username = ? OR target_username = ?`,
    [username, username],
  );
  await systemDb.execWithParams(`DELETE FROM device_tokens WHERE username = ?`,    [username]);
  await systemDb.execWithParams(`DELETE FROM guest_credentials WHERE username = ?`, [username]);
  await systemDb.execWithParams(`DELETE FROM friend_invites WHERE issuing_username = ?`,        [username]);
  await systemDb.execWithParams(`DELETE FROM pending_friend_requests WHERE from_username = ?`,  [username]);
  await userStore.delete(username);

  // Step 2d: Clean Meridian media DB rows.
  try {
    const mediaDb = new MeridianDB(DatabaseManager.getInstance());
    await mediaDb.deleteUserData(username);
    console.log(`[UserProvisioner] Cleaned Meridian media DB rows for ${username}`);
  } catch (err) {
    console.warn(`[UserProvisioner] Meridian media DB cleanup failed (non-fatal):`, err);
  }

  // Step 2e: Evict cached DB connections before rmSync.
  await DatabaseManager.evictUser(username);
  await DatabaseManager.evictSocialDb(username);

  // Step 2f: Delete the user's data directory (workspaces/library already handled above).
  const base = userDir(username);
  try {
    if (fs.existsSync(base)) {
      await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } catch (err) {
    console.warn(`[UserProvisioner] Failed to delete user dir ${base} (non-fatal):`, err);
  }

  // Step 2g: Delete media hub directories.
  const phobosDir = path.join(os.homedir(), '.phobos');
  for (const dir of [
    path.join(phobosDir, 'media', 'jellyfin',  username),
    path.join(phobosDir, 'media', 'kavita',    username),
    path.join(phobosDir, 'media', 'meridian',  username),
    path.join(phobosDir, 'media', 'efflux',    username),
  ]) {
    try {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    } catch (err) {
      console.warn(`[UserProvisioner] Failed to delete media dir ${dir} (non-fatal):`, err);
    }
  }

  console.log(`[UserProvisioner] User '${username}' fully deprovisioned.`);

  const lostAndFoundPath = anyRescued ? lnfDir : null;
  return {
    success:          true,
    lostAndFoundPath,
    rescuedItems,
    message: lostAndFoundPath
      ? `Collect your protected user data here: ${lostAndFoundPath}`
      : null,
  };
}