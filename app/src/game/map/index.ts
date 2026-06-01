/**
 * map/index.ts
 *
 * Aggregates all per-zone files into the three flat arrays consumed by
 * ExplorationZoneManager: ZONE_LIBRARY, ROOM_CATALOGUE, REGION_REGISTRY.
 *
 * Rules:
 *   - One import per zone file. Nothing else lives here.
 *   - Act order is preserved: act1 → act2 → act3 → act4 → act5.
 *   - Zone order within each act follows archetype index (ascending).
 *   - ROOM_CATALOGUE and REGION_REGISTRY are built by spreading each zone's
 *     ROOMS_* and REGIONS_* arrays. ExplorationZoneManager imports only from here.
 *
 * Adding a new zone: create the file, add three lines here (import + spread).
 * Nothing else changes.
 */

// ── Act I ─────────────────────────────────────────────────────────────────────

import { ROOMS_A1Z0,  REGIONS_A1Z0,  ZONE_A1Z0  } from './act1/A1Z0_CraterFlat';
import { ROOMS_A1Z1,  REGIONS_A1Z1,  ZONE_A1Z1  } from './act1/A1Z1_ObsidianShelf';

// ── Act II ────────────────────────────────────────────────────────────────────
// Zone 31 is the migrated barracks-block reference implementation.

import { ROOMS_A2Z31, REGIONS_A2Z31, ZONE_A2Z31 } from './act2/A2Z31_BunkerComplex';

// ── Aggregated exports ────────────────────────────────────────────────────────

import type { RoomDef, RegionDef, ZoneDef } from '../ExplorationZoneManager';

export const ROOM_CATALOGUE: RoomDef[] = [
  ...ROOMS_A1Z0,
  ...ROOMS_A1Z1,
  ...ROOMS_A2Z31,
];

export const REGION_REGISTRY: RegionDef[] = [
  ...REGIONS_A1Z0,
  ...REGIONS_A1Z1,
  ...REGIONS_A2Z31,
];

export const ZONE_LIBRARY: ZoneDef[] = [
  ZONE_A1Z0,
  ZONE_A1Z1,
  ZONE_A2Z31,
];