/**
 * UserProvisioner.ts — shared user provisioning logic.
 *
 * Used by both registerUserManagementRoutes (HTTP panel) and
 * DataChannelHandler (WebRTC guest auth). Kept here to avoid circular
 * imports between routes/ and webrtc/.
 *
 * provisionSystemUser  — create DB row, dirs, service accounts
 * deprovisionSystemUser — revoke codes, remove service accounts, delete row
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';
import { DatabaseManager, userDir }       from './DatabaseManager.js';
import { UserStore, type UserRole }       from './UserStore.js';
import { UserServiceTokenStore }          from './UserServiceTokenStore.js';
import {
  provisionUser  as jellyfinProvisionUser,
  deprovisionUser as jellyfinDeprovisionUser,
} from '../services/JellyfinManager.js';
import {
  provisionUser  as kavitaProvisionUser,
  deprovisionUser as kavitaDeprovisionUser,
} from '../services/KavitaManager.js';

export interface ProvisionResult {
  jellyfinOk: boolean;
  kavitaOk:   boolean;
  errors:     string[];
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
  fs.mkdirSync(path.join(phobosDir, 'media', 'jellyfin', username),               { recursive: true });
  fs.mkdirSync(path.join(phobosDir, 'media', 'kavita',   username, 'phobosDocs'), { recursive: true });
  fs.mkdirSync(path.join(phobosDir, 'media', 'meridian', username),               { recursive: true });

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
    const kv = await kavitaProvisionUser(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    await tokenStore.setKavita({
      user_id:       kv.userId,
      jwt:           kv.jwt,
      refresh_token: kv.refreshToken,
      api_key:       kv.apiKey,
    });
    result.kavitaOk = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    result.errors.push(`Kavita: ${msg}`);
    console.warn(`[UserProvisioner] Kavita provision failed for ${username} (non-fatal): ${msg}`);
  }

  return result;
}

export async function deprovisionSystemUser(
  username:  string,
  systemDb:  DatabaseManager,
  userStore: UserStore,
): Promise<void> {
  await systemDb.execWithParams(
    `UPDATE access_codes SET consumed = true
     WHERE (issuing_username = ? OR target_username = ?) AND consumed = false`,
    [username, username],
  );

  try {
    const userDb     = DatabaseManager.getUserDb(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    const jfTokens   = await tokenStore.getJellyfin();
    if (jfTokens?.user_id) await jellyfinDeprovisionUser(jfTokens.user_id);
  } catch (err) {
    console.warn(`[UserProvisioner] Jellyfin deprovision failed for ${username} (non-fatal):`, err);
  }

  try {
    const userDb     = DatabaseManager.getUserDb(username);
    const tokenStore = new UserServiceTokenStore(userDb);
    const kvTokens   = await tokenStore.getKavita();
    if (kvTokens?.user_id) await kavitaDeprovisionUser(kvTokens.user_id);
  } catch (err) {
    console.warn(`[UserProvisioner] Kavita deprovision failed for ${username} (non-fatal):`, err);
  }

  await userStore.delete(username);
}
