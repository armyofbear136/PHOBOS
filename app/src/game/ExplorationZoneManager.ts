/**
 * ExplorationZoneManager — daily-seeded procedural exploration zone.
 *
 * Zone direction: NORTH (decreasing ty, up-screen on the iso diamond).
 * Entry tile sits just north of the hub's top edge (ty = -1).
 * Zone spreads north and east/west from there — ty goes more negative as the
 * zone extends. dx offsets tile left/right of the entry column.
 *
 * Hub collision guard: any tile where ty >= 0 is discarded — hub tiles are
 * never overwritten regardless of archetype shape.
 *
 * Lifecycle:
 *   1. WorldScene.create() → getDailyZone() → ZoneSpec
 *   2. WorldScene iterates ZoneSpec.tiles → TileWorld.registerExplorationTile()
 *   3. WorldScene spawns tile images + structures from the spec
 *   4. _tickZoneGuard checks isTileInZone() before teleporting
 */

// ── Anchor ────────────────────────────────────────────────────────────────
// Gateway is at the north tip of the hub (tx=19, ty=0) — the Sybil/Seren gap.
// Zone entry is one tile north of that.
export const EXZONE_BRIDGE_HUB_TX = 19;
export const EXZONE_BRIDGE_HUB_TY = 0;

// Entry = first zone tile, directly north of the gateway
export const EXZONE_ENTRY_TX = 19;
export const EXZONE_ENTRY_TY = -3;   // zone starts 3 tiles north of hub edge

// Zone authored space: dx is east/west offset from entry col, dy is depth north.
// dx range: -(HALF_W)..+(HALF_W-1), dy range: 0..MAX_DEPTH-1
export const ZONE_HALF_W  = 10;   // tiles left and right of entry column
export const ZONE_DEPTH   = 14;   // tiles deep going north (dy 0 → 13, ty -1 → -14)

// ── Hub bounds (must match WorldScene ZONES) ──────────────────────────────
// Any tile within these bounds and ty >= 0 is a hub tile — skip it.
const HUB_TX_MIN = 0;
const HUB_TX_MAX = 39;

function isHubTile(tx: number, ty: number): boolean {
  return ty >= 0 && tx >= HUB_TX_MIN && tx <= HUB_TX_MAX;
}

// ── Coordinate mapping ────────────────────────────────────────────────────
// Local (dx, dy) → world (tx, ty).
// dx=0 is the entry column, positive dx goes east, negative dx goes west.
// dy=0 is the entry row (ty=-1), increasing dy goes further north (ty more negative).
function zoneTile(dx: number, dy: number): { tx: number; ty: number } {
  return {
    tx: EXZONE_ENTRY_TX + dx,
    ty: EXZONE_ENTRY_TY - dy,
  };
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface ZoneTile {
  tx: number;
  ty: number;
  frame: number;
}

export interface ZoneStructure {
  tx: number;
  ty: number;
  frame: number;
  tint: number;
  depth: number;
}

export interface ZoneGlow {
  tx: number;
  ty: number;
  color: number;
  alpha: number;
  radius: number;
}

export interface ZoneSpec {
  seed:         number;
  archetypeId:  number;
  label:        string;
  tint:         number;
  enemyFlavour: string;
  tiles:        ZoneTile[];
  structures:   ZoneStructure[];
  glows:        ZoneGlow[];
  entryTile:    { tx: number; ty: number };
}

// ── Three-Tier World Gen Types ─────────────────────────────────────────────
// These replace ChunkSpec/ChunkGraph in Phase A of the WorldGen design.
// ChunkSpec/ChunkGraph are retained as-is for the fallback linear generator.

/** Which edge of a room a connection slot sits on. */
export type EdgeDir = 'N' | 'S' | 'E' | 'W';

/**
 * A defined point on a room edge where a corridor can attach.
 * tx/ty are LOCAL to the room (0,0 = room top-left corner).
 * The generator converts these to world coordinates at placement time.
 */
export interface ConnectionSlot {
  id:    string;   // e.g. 'north-0', 'south-1'
  edge:  EdgeDir;
  tx:    number;   // local x offset from room anchor
  ty:    number;   // local y offset from room anchor
}

/**
 * A position within a room where an enemy, loot node, hazard, or
 * interactive object should spawn. tx/ty are LOCAL to the room.
 */
export interface SpawnMarker {
  id:      string;
  tx:      number;
  ty:      number;
  type:    'enemy' | 'mineral' | 'loot' | 'hazard' | 'interactive';
  /** Optional: enemy flavour override, mineral type, etc. */
  tag?:    string;
}

/**
 * A rule for a tile position that randomises each day within an authored range.
 * tx/ty are LOCAL to the room.
 */
export interface VariantRule {
  tx:      number;
  ty:      number;
  frames:  number[];  // tile frame indices to pick from (seeded random)
}

/**
 * The fundamental unit of world content. Hand-authored once, assembled
 * procedurally by the layout algorithms.
 *
 * Size must be a multiple of 4 in both dimensions so connection slots
 * always align to the tile grid regardless of assembly order.
 */
export interface RoomDef {
  id:           string;          // e.g. 'bunker-corridor-a'
  zone_act:     number;          // 1–6 — which act this room belongs to
  region_types: string[];        // which RegionDef ids can use this room
  type:         'entry' | 'standard' | 'dead-end' | 'connector' | 'boss' | 'secret';
  size:         { w: number; h: number };   // tile dimensions (multiples of 4)
  connections:  ConnectionSlot[];
  tiles:        Array<{ tx: number; ty: number; frame: number }>;
  /** blocked: true registers this tile in TileWorld._blocked at room placement time. */
  structures:   Array<{ tx: number; ty: number; frame: number; tint: number; depth: number; blocked?: boolean }>;
  variants:     VariantRule[];
  spawn_markers: SpawnMarker[];
  /** Minimum zone depth before this room can appear. 0 = anytime. */
  min_room_tier: number;
}

/**
 * A placed instance of a RoomDef within a zone.
 * worldOffsetTx/Ty translate local room coords to world tile coords.
 */
export interface RoomInstance {
  def:           RoomDef;
  worldOffsetTx: number;
  worldOffsetTy: number;
  /** Which ConnectionSlots are actively connected to another room or corridor. */
  usedSlots:     Set<string>;
}

/**
 * A corridor connecting two RoomInstance connection slots.
 * Stored so WorldScene can render it independently of the rooms.
 */
export interface CorridorSpec {
  fromSlot:   { worldTx: number; worldTy: number; edge: EdgeDir };
  toSlot:     { worldTx: number; worldTy: number; edge: EdgeDir };
  tiles:      Array<{ tx: number; ty: number; frame: number }>;
  tint:       number;
}

/**
 * Layout algorithms available to regions.
 * Each algorithm produces a different spatial arrangement of rooms.
 */
export type LayoutAlgorithm = 'spine' | 'grid' | 'branching' | 'ring' | 'convergence' | 'spiral';

/**
 * A region type definition — the template for a region within a zone.
 * The same RegionDef can be used across multiple zones.
 */
export interface RegionDef {
  id:             string;          // e.g. 'bunker-corridor'
  label:          string;
  zone_acts:      number[];        // which acts this region can appear in
  layout:         LayoutAlgorithm;
  room_count_min: number;
  room_count_max: number;
  /** Minimum corridor length in tiles between rooms in this region. */
  corridor_min:   number;
  /** Maximum corridor length in tiles. */
  corridor_max:   number;
  tint:           number;          // visual palette — applied to all tiles in this region
}

/**
 * A placed region within a zone — the assembled result of applying
 * a layout algorithm to a RegionDef's room set.
 */
export interface RegionInstance {
  def:       RegionDef;
  rooms:     RoomInstance[];
  corridors: CorridorSpec[];
  /** World tile coordinate of the entry connection point into this region. */
  entryTx:   number;
  entryTy:   number;
  /** World tile coordinate of the exit connection point out of this region. */
  exitTx:    number;
  exitTy:    number;
}

/**
 * A zone definition — the template for one of the 100 zones in the library.
 */
export interface ZoneDef {
  id:            string;
  label:         string;
  zone_act:      number;           // 1–6
  region_defs:   RegionDef[];      // ordered entry-to-boss
  enemy_flavour: string;
  tint:          number;
}

/**
 * A fully assembled zone — the output of generateZoneGraph().
 * Replaces ChunkGraph for the new system. ChunkGraph is retained as fallback.
 */
export interface ZoneGraph {
  seed:      number;
  def:       ZoneDef;
  regions:   RegionInstance[];
  /** World tile bounds for enemy/loot seeding and camera clamping. */
  bounds:    { minTx: number; maxTx: number; minTy: number; maxTy: number };
  entryTile: { tx: number; ty: number };
  bossTile:  { tx: number; ty: number } | null;
}

// ── Seeded LCG ────────────────────────────────────────────────────────────

function makeLcg(seed: number): () => number {
  let s = seed;
  return (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

// ── Tile push helper — discards hub tiles ─────────────────────────────────

function pushTile(
  tiles: ZoneTile[], dx: number, dy: number, frame: number,
): void {
  const { tx, ty } = zoneTile(dx, dy);
  if (isHubTile(tx, ty)) return;
  tiles.push({ tx, ty, frame });
}

function pushStructure(
  structures: ZoneStructure[], dx: number, dy: number,
  frame: number, tint: number, depth: number,
): void {
  const { tx, ty } = zoneTile(dx, dy);
  if (isHubTile(tx, ty)) return;
  structures.push({ tx, ty, frame, tint, depth });
}

// ── Archetype #0 — Crater Flat ────────────────────────────────────────────
// Filled circle 12×12, centred 6 tiles north of entry.
function generateArchetype0(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R = 6;
  for (let dy = 0; dy < 12; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const ddx = dx; const ddy = dy - R;
      if (ddx * ddx + ddy * ddy > R * R) continue;
      const isCentre = Math.abs(ddx) <= 1 && Math.abs(ddy) <= 1;
      const frame = isCentre ? (rng() < 0.5 ? 7 : 8) : (rng() < 0.7 ? 0 : 1);
      pushTile(tiles, dx, dy, frame);
    }
  }

  const centre = zoneTile(0, R);
  if (!isHubTile(centre.tx, centre.ty)) {
    glows.push({ tx: centre.tx, ty: centre.ty, color: 0x4040a0, alpha: 0.12, radius: 20 });
  }

  return {
    seed, archetypeId: 0, label: 'CRATER FLAT', tint: 0x8888aa,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #1 — Obsidian Shelf ────────────────────────────────────────
// Rectangle spanning full width, 8 deep, pillar rows.
function generateArchetype1(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 8;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.8 ? 0 : 1);
    }
  }

  for (let dx = -W2; dx <= W2; dx += 3) {
    if (Math.abs(dx) <= 1) continue; // leave centre corridor open
    for (const pillarDy of [2, 5]) {
      pushStructure(structures, dx, pillarDy, 21, 0x0a0a0a, 5);
    }
  }

  return {
    seed, archetypeId: 1, label: 'OBSIDIAN SHELF', tint: 0x606070,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #2 — Dust Bowl ──────────────────────────────────────────────
// Wide oval, scattered rocks.
function generateArchetype2(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const RX = ZONE_HALF_W - 1;
  const RY = Math.min(ZONE_DEPTH, 12) / 2;
  const CY = RY;

  for (let dy = 0; dy < Math.round(RY * 2); dy++) {
    for (let dx = -RX; dx <= RX; dx++) {
      const nx = dx / RX;
      const ny = (dy - CY) / RY;
      if (nx * nx + ny * ny > 1) continue;
      const dist = Math.sqrt(nx * nx + ny * ny);
      const frame = dist > 0.7 ? (rng() < 0.5 ? 7 : 8) : (rng() < 0.7 ? 0 : 1);
      pushTile(tiles, dx, dy, frame);
      if (rng() < 0.05) pushStructure(structures, dx, dy, 28, 0x2a2218, 5);
    }
  }

  return {
    seed, archetypeId: 2, label: 'DUST BOWL', tint: 0x9a8870,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #3 — Caldera Ring ───────────────────────────────────────────
// Donut with single bridge to centre, lava glow.
function generateArchetype3(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R = 7; const r = 3;

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R) continue;
      if (d2 < r * r) continue;
      pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
    }
  }

  // Bridge across inner void at dx=0
  for (let dy = R - r; dy <= R + r; dy++) {
    pushTile(tiles, 0, dy, 7);
  }

  const centrePos = zoneTile(0, R);
  if (!isHubTile(centrePos.tx, centrePos.ty)) {
    glows.push({ tx: centrePos.tx, ty: centrePos.ty, color: 0xff6600, alpha: 0.18, radius: 28 });
  }

  return {
    seed, archetypeId: 3, label: 'CALDERA RING', tint: 0xa05030,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #4 — Rift Valley ────────────────────────────────────────────
// Two wide strips north/south with gap and staggered bridges.
function generateArchetype4(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2     = ZONE_HALF_W;
  const BAND   = 4;   // depth of each band
  const GAP    = 3;   // void rows between bands
  const BAND2  = BAND + GAP;

  for (let dy = 0; dy < BAND; dy++) {
    for (let dx = -W2; dx <= W2; dx++) pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
  }
  for (let dy = BAND2; dy < BAND2 + BAND; dy++) {
    for (let dx = -W2; dx <= W2; dx++) pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
  }

  // Three staggered bridges across the gap
  for (const bdx of [-Math.floor(W2 * 0.6), 0, Math.floor(W2 * 0.6)]) {
    for (let dy = BAND; dy < BAND2; dy++) pushTile(tiles, bdx, dy, 7);
  }

  return {
    seed, archetypeId: 4, label: 'RIFT VALLEY', tint: 0x707080,
    enemyFlavour: 'rifters', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #5 — Fault Line ─────────────────────────────────────────────
// Two halves separated by a diagonal rift, single bridge.
function generateArchetype5(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = Math.min(ZONE_DEPTH, 12);

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // Diagonal rift: dx offset proportional to depth
      const riftDx = Math.round((dy - H / 2) * 0.5);
      if (dx === riftDx) continue;
      pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
    }
  }

  // Single bridge at midpoint
  const bridgeDy = Math.round(H / 2);
  const bridgeDx = Math.round((bridgeDy - H / 2) * 0.5);
  pushTile(tiles, bridgeDx, bridgeDy, 7);
  pushStructure(structures, bridgeDx, bridgeDy, 35, 0x1a1a2a, 5);

  return {
    seed, archetypeId: 5, label: 'FAULT LINE', tint: 0x7070a0,
    enemyFlavour: 'bridgeguards', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #6 — Lava Shelf ─────────────────────────────────────────────
// Rect with ragged south/east edges via noise, red-orange glow objects.
function generateArchetype6(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 11;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // Ragged south + east edges: noise drops tiles near edge
      const edgeFactor = Math.min(dy / 2, (H - dy - 1) / 2, (W2 - Math.abs(dx)) / 2);
      if (edgeFactor < 1 && rng() > edgeFactor * 0.55) continue;
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  // Scattered lava glow objects
  for (let i = 0; i < 6; i++) {
    const gdx = Math.round((rng() * 2 - 1) * (W2 - 1));
    const gdy = 1 + Math.round(rng() * (H - 2));
    const pos = zoneTile(gdx, gdy);
    if (!isHubTile(pos.tx, pos.ty)) {
      glows.push({ tx: pos.tx, ty: pos.ty, color: 0xff4400, alpha: 0.18, radius: 14 });
    }
  }

  return {
    seed, archetypeId: 6, label: 'LAVA SHELF', tint: 0x3a1a0a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #7 — Ice Basin ──────────────────────────────────────────────
// Oval zone, frozen pool voids, crystal structure at centre.
function generateArchetype7(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const RX = ZONE_HALF_W - 1;
  const RY = 7;
  const CY = RY;

  const frozenPools: Set<string> = new Set();
  // Place 2 frozen pools at seeded positions
  for (let p = 0; p < 2; p++) {
    const pdx = Math.round((rng() * 1.2 - 0.6) * (RX - 2));
    const pdy = 2 + Math.round(rng() * (RY * 2 - 4));
    for (let fy = pdy; fy <= pdy + 2; fy++) {
      for (let fx = pdx - 1; fx <= pdx + 1; fx++) {
        frozenPools.add(`${fx},${fy}`);
      }
    }
    const poolPos = zoneTile(pdx, pdy + 1);
    if (!isHubTile(poolPos.tx, poolPos.ty)) {
      glows.push({ tx: poolPos.tx, ty: poolPos.ty, color: 0x88ddff, alpha: 0.22, radius: 16 });
    }
  }

  for (let dy = 0; dy < RY * 2; dy++) {
    for (let dx = -RX; dx <= RX; dx++) {
      const nx = dx / RX; const ny = (dy - CY) / RY;
      if (nx * nx + ny * ny > 1) continue;
      const key = `${dx},${dy}`;
      if (frozenPools.has(key)) continue; // pool centre is void
      const frame = (dy % 4 === 0) ? (rng() < 0.5 ? 7 : 8) : (rng() < 0.7 ? 0 : 1);
      pushTile(tiles, dx, dy, frame);
    }
  }

  // Crystal column at zone centre
  pushStructure(structures, 0, RY, 14, 0x304060, 6);

  return {
    seed, archetypeId: 7, label: 'ICE BASIN', tint: 0x1a2a3a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #8 — Pumice Field ───────────────────────────────────────────
// Large irregular blob, 2×2 rock clusters force winding paths.
function generateArchetype8(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 13;

  // Blob via noise threshold on distance from centre
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      const d  = Math.sqrt(nx * nx + ny * ny);
      if (d > 0.88 + (rng() - 0.5) * 0.15) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // 2×2 rock cluster structures (~1 per 12 ground tiles → ~14 clusters)
  const placed: Set<string> = new Set();
  let attempts = 0;
  while (placed.size < 14 && attempts < 120) {
    attempts++;
    const cdx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const cdy = 1 + Math.round(rng() * (H - 3));
    const key = `${cdx},${cdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    pushStructure(structures, cdx,     cdy,     28, 0x2a1e1a, 4);
    pushStructure(structures, cdx + 1, cdy,     28, 0x2a1e1a, 4);
    pushStructure(structures, cdx,     cdy + 1, 28, 0x2a1e1a, 4);
    pushStructure(structures, cdx + 1, cdy + 1, 28, 0x2a1e1a, 4);
  }

  return {
    seed, archetypeId: 8, label: 'PUMICE FIELD', tint: 0x2a1e1a,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #9 — Crystal Spire Field ────────────────────────────────────
// Rect ground, dense hex-grid crystal spires, blue glow.
function generateArchetype9(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  // Hex grid of spires — stagger alternate rows
  for (let row = 0; row < H; row += 2) {
    const stagger = (row / 2) % 2 === 0 ? 0 : 2;
    for (let col = -W2 + 1 + stagger; col < W2; col += 4) {
      if (rng() < 0.25) continue; // ~25% omission for variety
      pushStructure(structures, col, row + 1, 14, 0x204060, 6);
      const sp = zoneTile(col, row + 1);
      if (!isHubTile(sp.tx, sp.ty)) {
        glows.push({ tx: sp.tx, ty: sp.ty, color: 0x60a5fa, alpha: 0.2, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 9, label: 'CRYSTAL SPIRE FIELD', tint: 0x0f1a2a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #10 — Ancient Seabed ────────────────────────────────────────
// Max rect, alternating row frame offset, scattered fossil decor.
function generateArchetype10(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    // Alternate rows use shifted frame
    const baseFrame = (dy % 2 === 0) ? 0 : 7;
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.6 ? baseFrame : baseFrame + 1);
    }
  }

  // Fossil decorations — single tile, scattered
  for (let i = 0; i < 10; i++) {
    const fdx = Math.round((rng() * 2 - 1) * (W2 - 1));
    const fdy = 1 + Math.round(rng() * (H - 2));
    pushStructure(structures, fdx, fdy, 42, 0x1a2018, 3);
  }

  return {
    seed, archetypeId: 10, label: 'ANCIENT SEABED', tint: 0x1a2018,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #11 — Geode Interior ────────────────────────────────────────
// 14×14 circle, ring path 2–3 tiles thick, crystal glow.
function generateArchetype11(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R  = 7;
  const r  = 4;  // inner void radius

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R) continue;
      if (d2 < r * r) {
        // Crystal structures lining inner wall
        const innerEdge = d2 >= (r - 1) * (r - 1);
        if (innerEdge && rng() < 0.35) {
          pushStructure(structures, dx, dy, 14, 0x6040a0, 5);
          const sp = zoneTile(dx, dy);
          if (!isHubTile(sp.tx, sp.ty)) {
            glows.push({ tx: sp.tx, ty: sp.ty, color: 0x9060ff, alpha: 0.2, radius: 8 });
          }
        }
        continue;
      }
      pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
    }
  }

  return {
    seed, archetypeId: 11, label: 'GEODE INTERIOR', tint: 0x120a2a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #12 — Salt Flat ─────────────────────────────────────────────
// Maximum size rectangle. No structures. Pure open space.
function generateArchetype12(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.85 ? 0 : 1);
    }
  }

  return {
    seed, archetypeId: 12, label: 'SALT FLAT', tint: 0x2a2a28,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #13 — Meteor Scar ───────────────────────────────────────────
// Ellipse 45°, void centre pit, debris radiates outward.
function generateArchetype13(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 11;
  const CX = 0; const CY = H / 2;
  const PIT = 2; // void pit radius

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // Tilted ellipse: rotate 45°
      const rx = (dx + (dy - CY)) / (W2 * 1.1);
      const ry = (dx - (dy - CY)) / (H * 0.85);
      if (rx * rx + ry * ry > 1) continue;
      const dxC = dx - CX; const dyC = dy - CY;
      if (dxC * dxC + dyC * dyC <= PIT * PIT) continue; // central pit
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Radial debris from centre
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 5) {
    for (let r = PIT + 1; r <= W2 - 1; r += 2) {
      const ddx = Math.round(Math.cos(angle) * r);
      const ddy = Math.round(CY + Math.sin(angle) * r);
      if (rng() < 0.5) pushStructure(structures, ddx, ddy, 28, 0x2a2010, 4);
    }
  }

  const centrePos = zoneTile(CX, Math.round(CY));
  if (!isHubTile(centrePos.tx, centrePos.ty)) {
    glows.push({ tx: centrePos.tx, ty: centrePos.ty, color: 0x806040, alpha: 0.15, radius: 22 });
  }

  return {
    seed, archetypeId: 13, label: 'METEOR SCAR', tint: 0x1e1a14,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #14 — Subsurface Vent ───────────────────────────────────────
// Normal rect, 8–12 vent glow columns, heat-adapted enemy flavour.
function generateArchetype14(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 11;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  const ventCount = 8 + Math.floor(rng() * 5);
  for (let i = 0; i < ventCount; i++) {
    const vdx = -W2 + 1 + Math.round(rng() * (W2 * 2 - 2));
    const vdy = 1 + Math.round(rng() * (H - 2));
    const vPos = zoneTile(vdx, vdy);
    if (!isHubTile(vPos.tx, vPos.ty)) {
      glows.push({ tx: vPos.tx, ty: vPos.ty, color: 0xf97316, alpha: 0.22, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 14, label: 'SUBSURFACE VENT', tint: 0x1a0e08,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #15 — Pressure Dome ─────────────────────────────────────────
// Circle with wall ring, 2-tile S entry gap, enemies trapped inside.
function generateArchetype15(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R = 7;

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);

      // Dome wall ring: outer 1-tile band, non-walkable
      const isWall = d2 >= (R - 1) * (R - 1);
      if (isWall) {
        // South entry gap: dy 0–1, dx in [-1, 1]
        const isSEntry = dy <= 1 && Math.abs(dx) <= 1;
        if (!isSEntry) {
          pushStructure(structures, dx, dy, 21, 0x203050, 5);
        }
      }
    }
  }

  return {
    seed, archetypeId: 15, label: 'PRESSURE DOME', tint: 0x141e2a,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #16 — Glacial Moraine ───────────────────────────────────────
// H-bands of walkable ground, 2-tile void gaps, staggered bridges.
function generateArchetype16(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const BAND = 3;  // depth of each walkable band
  const GAP  = 2;  // void gap between bands
  const UNIT = BAND + GAP;
  const BANDS = 3;

  for (let b = 0; b < BANDS; b++) {
    const dy0 = b * UNIT;
    for (let dy = dy0; dy < dy0 + BAND; dy++) {
      for (let dx = -W2; dx <= W2; dx++) {
        pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
      }
    }
    // Staggered bridge to next band
    if (b < BANDS - 1) {
      const bridgeDx = Math.round((rng() * 1.6 - 0.8) * (W2 - 2));
      for (let dy = dy0 + BAND; dy < dy0 + UNIT; dy++) {
        pushTile(tiles, bridgeDx, dy, 7);
      }
    }
  }

  return {
    seed, archetypeId: 16, label: 'GLACIAL MORAINE', tint: 0x1a222a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #17 — Thermal Plateau ───────────────────────────────────────
// Wide rect, darker N-edge ledge (elevation simulation), enemies mass on plateau.
function generateArchetype17(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2      = ZONE_HALF_W;
  const H       = 12;
  const LEDGE_Y = 8; // dy >= this is the elevated plateau

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const frame = (dy >= LEDGE_Y)
        ? (rng() < 0.65 ? 7 : 8)   // plateau: shifted frame for darker look
        : (rng() < 0.72 ? 0 : 1);  // ground floor
      pushTile(tiles, dx, dy, frame);
    }
  }

  // Ledge edge marker structures
  for (let dx = -W2; dx <= W2; dx += 2) {
    pushStructure(structures, dx, LEDGE_Y, 21, 0x14100a, 4);
  }

  return {
    seed, archetypeId: 17, label: 'THERMAL PLATEAU', tint: 0x1e1810,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #18 — Sinkhole Maze ─────────────────────────────────────────
// Large rect, 8 random 2×2 void sinkholes, natural maze.
function generateArchetype18(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  // Mark sinkhole positions first
  const holes: Set<string> = new Set();
  for (let i = 0; i < 8; i++) {
    const hx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const hy = 2 + Math.round(rng() * (H - 5));
    for (let fy = hy; fy <= hy + 1; fy++) {
      for (let fx = hx; fx <= hx + 1; fx++) {
        holes.add(`${fx},${fy}`);
      }
    }
  }

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      if (holes.has(`${dx},${dy}`)) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  return {
    seed, archetypeId: 18, label: 'SINKHOLE MAZE', tint: 0x181820,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #19 — Mineral Vein ──────────────────────────────────────────
// Irregular blob, branching fractal vein structures, mineral glow.
function generateArchetype19(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Blob base
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      const d  = Math.sqrt(nx * nx + ny * ny);
      if (d > 0.9 + (rng() - 0.5) * 0.12) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Branching vein: 3 main arms from centre, each 5 segments, splitting once
  const arms: Array<{ dx: number; dy: number; dir: number }> = [
    { dx: 0, dy: H / 2, dir: 0 },
    { dx: 0, dy: H / 2, dir: Math.PI * 2 / 3 },
    { dx: 0, dy: H / 2, dir: Math.PI * 4 / 3 },
  ];
  for (const arm of arms) {
    let cx = arm.dx; let cy = arm.dy; let angle = arm.dir;
    for (let seg = 0; seg < 5; seg++) {
      angle += (rng() - 0.5) * 0.6;
      cx += Math.round(Math.cos(angle) * 2);
      cy += Math.round(Math.sin(angle) * 2);
      pushStructure(structures, Math.round(cx), Math.round(cy), 14, 0x2a200a, 3);
      const vPos = zoneTile(Math.round(cx), Math.round(cy));
      if (!isHubTile(vPos.tx, vPos.ty)) {
        glows.push({ tx: vPos.tx, ty: vPos.ty, color: 0xffd700, alpha: 0.18, radius: 9 });
      }
    }
  }

  return {
    seed, archetypeId: 19, label: 'MINERAL VEIN', tint: 0x1a1612,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CATEGORY B — ARCHITECTURAL (archetypes 20–39)
// ══════════════════════════════════════════════════════════════════════════

// ── Archetype #20 — Abandoned Outpost ─────────────────────────────────────
// Rectangle, 4 partial-wall rooms, one building sprite at centre.
function generateArchetype20(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  // 4 room dividers: partial walls with 2-tile gap
  const roomRows = [3, 6, 9];
  for (const wy of roomRows) {
    const gapDx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    for (let dx = -W2; dx <= W2; dx++) {
      if (dx >= gapDx && dx <= gapDx + 1) continue;
      pushStructure(structures, dx, wy, 21, 0x141e14, 4);
    }
  }

  // Central building sprite
  pushStructure(structures, 0, Math.round(H / 2), 35, 0x1a2a1a, 6);

  return {
    seed, archetypeId: 20, label: 'ABANDONED OUTPOST', tint: 0x141e14,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #21 — Ruined Grid ───────────────────────────────────────────
// Grid of 4×4 room footprints, every wall partial.
function generateArchetype21(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const CELL = 5;  // each cell is 4 ground + 1 wall tile

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Horizontal wall rows at cell boundaries
  for (let wy = CELL - 1; wy < H; wy += CELL) {
    const gapDx = -W2 + 1 + Math.round(rng() * (W2 * 2 - 2));
    for (let dx = -W2; dx <= W2; dx++) {
      if (dx === gapDx || dx === gapDx + 1) continue;
      if (rng() < 0.3) continue; // 30% missing tiles = ruined
      pushStructure(structures, dx, wy, 21, 0x1a1a14, 4);
    }
  }

  // Vertical wall columns at cell boundaries
  for (let wx = -W2 + CELL - 1; wx < W2; wx += CELL) {
    const gapDy = 1 + Math.round(rng() * (H - 3));
    for (let dy = 0; dy < H; dy++) {
      if (dy === gapDy || dy === gapDy + 1) continue;
      if (rng() < 0.3) continue;
      pushStructure(structures, wx, dy, 21, 0x1a1a14, 4);
    }
  }

  return {
    seed, archetypeId: 21, label: 'RUINED GRID', tint: 0x1a1a14,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #22 — Signal Tower Site ────────────────────────────────────
// 12×12, central elevated platform, relay tower, signal light glow.
function generateArchetype22(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R = 6; // outer radius
  const PLAT_W = 3; const PLAT_H = 3;
  const PLAT_DX = 0; const PLAT_DY = R;

  // Outer circular ground
  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + (dy - R) * (dy - R) > R * R) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Central platform — darker frame
  for (let dy = PLAT_DY - 1; dy <= PLAT_DY + 1; dy++) {
    for (let dx = PLAT_DX - 1; dx <= PLAT_DX + 1; dx++) {
      pushTile(tiles, dx, dy, 7);
    }
  }

  // Relay tower structure at platform centre
  pushStructure(structures, PLAT_DX, PLAT_DY, 14, 0x101818, 7);

  // Signal light glow at top of tower
  const towPos = zoneTile(PLAT_DX, PLAT_DY);
  if (!isHubTile(towPos.tx, towPos.ty)) {
    glows.push({ tx: towPos.tx, ty: towPos.ty, color: 0x22d3ee, alpha: 0.28, radius: 16 });
  }

  // 2-tile ramp path from south entry to platform
  for (let dy = 1; dy < PLAT_DY - 1; dy++) {
    pushTile(tiles, 0, dy, 7);
  }

  return {
    seed, archetypeId: 22, label: 'SIGNAL TOWER SITE', tint: 0x101818,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #23 — Processing Facility ──────────────────────────────────
// Large rect divided into 3 longitudinal chambers by full-width walls, machine sprites.
function generateArchetype23(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;
  const CHAMBER_H = 3;
  const WALL_ROW   = [CHAMBER_H, CHAMBER_H * 2 + 1];

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Full-width walls at chamber boundaries, 2-tile gap offset per wall
  WALL_ROW.forEach((wy, i) => {
    const gapDx = (i === 0 ? -W2 + 3 : W2 - 4);
    for (let dx = -W2; dx <= W2; dx++) {
      if (dx === gapDx || dx === gapDx + 1) continue;
      pushStructure(structures, dx, wy, 21, 0x14181a, 4);
    }
  });

  // Machine sprite in each chamber
  for (let c = 0; c < 3; c++) {
    const cy = c * (CHAMBER_H + 1) + 1;
    pushStructure(structures, 0, cy + 1, 35, 0x14181a, 5);
  }

  return {
    seed, archetypeId: 23, label: 'PROCESSING FACILITY', tint: 0x14181a,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #24 — Landing Pad Array ────────────────────────────────────
// Flat rect, 4 circular pad ring outlines, gateway sprite at far end.
function generateArchetype24(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  // 4 pads arranged in 2×2 grid
  const padCentres = [
    { dx: -5, dy: 3 }, { dx: 5, dy: 3 },
    { dx: -5, dy: 9 }, { dx: 5, dy: 9 },
  ];
  for (const pc of padCentres) {
    // Pad ring (radius 2)
    for (let dy = pc.dy - 2; dy <= pc.dy + 2; dy++) {
      for (let dx = pc.dx - 2; dx <= pc.dx + 2; dx++) {
        const d2 = (dx - pc.dx) * (dx - pc.dx) + (dy - pc.dy) * (dy - pc.dy);
        if (d2 < 4 || d2 > 4) continue; // only the ring at r=2
        pushStructure(structures, dx, dy, 21, 0x101410, 3);
      }
    }
    // Pad glow
    const padPos = zoneTile(pc.dx, pc.dy);
    if (!isHubTile(padPos.tx, padPos.ty)) {
      glows.push({ tx: padPos.tx, ty: padPos.ty, color: 0x34d399, alpha: 0.14, radius: 18 });
    }
  }

  // Gateway sprite at far (north) end
  pushStructure(structures, 0, H - 1, 35, 0x101410, 6);

  return {
    seed, archetypeId: 24, label: 'LANDING PAD ARRAY', tint: 0x101410,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #25 — Collapsed Spire ──────────────────────────────────────
// 2×2 void at centre, radial rubble pattern.
function generateArchetype25(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 12;
  const CY = Math.round(H / 2);

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const isCentre = Math.abs(dx) <= 1 && Math.abs(dy - CY) <= 1;
      if (isCentre) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Radial rubble from void centre
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
    for (let r = 2; r <= W2 - 1; r += 2) {
      const rdx = Math.round(Math.cos(angle) * r);
      const rdy = Math.round(CY + Math.sin(angle) * r);
      if (rng() < 0.55) {
        pushStructure(structures, rdx, rdy, 28, 0x181614, 4);
      }
    }
  }

  return {
    seed, archetypeId: 25, label: 'COLLAPSED SPIRE', tint: 0x181614,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #26 — Watch Platform ───────────────────────────────────────
// Rect, raised N platform tint, 4 corner turret base structures.
function generateArchetype26(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2       = ZONE_HALF_W;
  const H        = 12;
  const PLAT_ROW = 7; // dy >= this is the "raised" platform

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const frame = dy >= PLAT_ROW ? (rng() < 0.65 ? 7 : 8) : (rng() < 0.73 ? 0 : 1);
      pushTile(tiles, dx, dy, frame);
    }
  }

  // 4 corner turret bases on platform
  for (const [cdx, cdy] of [[-W2 + 1, PLAT_ROW + 1], [W2 - 1, PLAT_ROW + 1],
                              [-W2 + 1, H - 1],         [W2 - 1, H - 1]]) {
    pushStructure(structures, cdx, cdy, 21, 0x0e1216, 5);
    const tPos = zoneTile(cdx, cdy);
    if (!isHubTile(tPos.tx, tPos.ty)) {
      glows.push({ tx: tPos.tx, ty: tPos.ty, color: 0xfbbf24, alpha: 0.16, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 26, label: 'WATCH PLATFORM', tint: 0x12161a,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #27 — Relay Node Cluster ───────────────────────────────────
// Rect, 5–7 relay tower structures with amber tweens, open ground.
function generateArchetype27(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 11;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  const towerCount = 5 + Math.floor(rng() * 3);
  const placed = new Set<string>();
  let attempts = 0;
  while (placed.size < towerCount && attempts < 60) {
    attempts++;
    const tdx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const tdy = 1 + Math.round(rng() * (H - 2));
    const key = `${tdx},${tdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    pushStructure(structures, tdx, tdy, 14, 0x141410, 6);
    const tp = zoneTile(tdx, tdy);
    if (!isHubTile(tp.tx, tp.ty)) {
      glows.push({ tx: tp.tx, ty: tp.ty, color: 0xffa040, alpha: 0.22, radius: 12 }); // amber
    }
  }

  return {
    seed, archetypeId: 27, label: 'RELAY NODE CLUSTER', tint: 0x141410,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #28 — Archive Annex ────────────────────────────────────────
// Rect, parallel shelf-aisle rows, Sybil violet tint.
function generateArchetype28(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Shelf rows: every 3 dy, place 1×3 shelf structures with 1-tile aisle gaps
  for (let dy = 2; dy < H - 1; dy += 3) {
    for (let dx = -W2 + 1; dx <= W2 - 1; dx += 2) {
      if (rng() < 0.15) continue; // occasional gap for variety
      pushStructure(structures, dx, dy, 42, 0x10101a, 4);
    }
    // Aisle glow on alternate rows
    if ((dy / 3) % 2 === 0) {
      const aislePos = zoneTile(0, dy);
      if (!isHubTile(aislePos.tx, aislePos.ty)) {
        glows.push({ tx: aislePos.tx, ty: aislePos.ty, color: 0x9060ff, alpha: 0.1, radius: 20 });
      }
    }
  }

  return {
    seed, archetypeId: 28, label: 'ARCHIVE ANNEX', tint: 0x10101a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #29 — Forge District ───────────────────────────────────────
// Large irregular blob, machine sprites, orange glow tweens.
function generateArchetype29(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Blob
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      if (Math.sqrt(nx * nx + ny * ny) > 0.9 + (rng() - 0.5) * 0.1) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Scattered machine sprites
  const machineCount = 5 + Math.floor(rng() * 4);
  const placed = new Set<string>();
  let attempts = 0;
  while (placed.size < machineCount && attempts < 80) {
    attempts++;
    const mdx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const mdy = 1 + Math.round(rng() * (H - 3));
    const key = `${mdx},${mdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    pushStructure(structures, mdx, mdy, 35, 0x1a1008, 5);
    const mp = zoneTile(mdx, mdy);
    if (!isHubTile(mp.tx, mp.ty)) {
      glows.push({ tx: mp.tx, ty: mp.ty, color: 0xf97316, alpha: 0.2, radius: 11 });
    }
  }

  return {
    seed, archetypeId: 29, label: 'FORGE DISTRICT', tint: 0x1a1008,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #30 — Derelict Hab Block ───────────────────────────────────
// Rectangle, 8–10 rooms with full walls + single-tile doorways. Claustrophobic.
function generateArchetype30(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2       = ZONE_HALF_W;
  const H        = 12;
  const ROOM_W   = 5;
  const ROOM_H   = 4;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Room grid: 2 columns × 3 rows = 6 rooms
  const cols = [-W2 + 1, W2 - ROOM_W];
  const rows = [0, ROOM_H, ROOM_H * 2];

  for (const rx of cols) {
    for (const ry of rows) {
      // N wall
      for (let dx = rx; dx <= rx + ROOM_W - 1; dx++) {
        pushStructure(structures, dx, ry, 21, 0x101010, 4);
      }
      // E wall
      for (let dy = ry; dy <= ry + ROOM_H - 1; dy++) {
        pushStructure(structures, rx + ROOM_W - 1, dy, 21, 0x101010, 4);
      }
      // Single-tile doorway in N wall at random position
      const doorDx = rx + 1 + Math.floor(rng() * (ROOM_W - 3));
      pushTile(tiles, doorDx, ry, 7); // overwrite wall with walkable door
    }
  }

  return {
    seed, archetypeId: 30, label: 'DERELICT HAB BLOCK', tint: 0x101010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #31 — Bunker Complex ───────────────────────────────────────
// Outer rect, non-walkable inner solid block, ring path, one doorway in.
function generateArchetype31(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2      = ZONE_HALF_W - 1;
  const H       = 12;
  const RING    = 2;  // ring depth
  const INNER_W = W2 * 2 + 1 - RING * 2;
  const INNER_H = H - RING * 2;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const inInner = Math.abs(dx) <= W2 - RING && dy >= RING && dy <= H - RING - 1;
      if (inInner) {
        // Solid inner block — walls, not walkable
        pushStructure(structures, dx, dy, 21, 0x0e1010, 4);
      } else {
        pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
      }
    }
  }

  // Single doorway in south face of inner block
  const doorDx = -1 + Math.floor(rng() * 3) - 1; // -2, -1, or 0
  pushTile(tiles, doorDx, RING, 7);
  pushTile(tiles, doorDx + 1, RING, 7);

  return {
    seed, archetypeId: 31, label: 'BUNKER COMPLEX', tint: 0x0e0e12,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #32 — Research Station ─────────────────────────────────────
// Long narrow 20×8, bench rows down central aisle, Seren blue glow.
function generateArchetype32(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 2;
  const H  = 8;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Bench rows: facing each other from east and west walls
  for (let dy = 1; dy < H - 1; dy += 2) {
    pushStructure(structures, -W2 + 1, dy, 42, 0x10141a, 4);
    pushStructure(structures,  W2 - 1, dy, 42, 0x10141a, 4);
    // Seren glow on each bench pair
    const bPos = zoneTile(0, dy);
    if (!isHubTile(bPos.tx, bPos.ty)) {
      glows.push({ tx: bPos.tx, ty: bPos.ty, color: 0x4080ff, alpha: 0.12, radius: 14 });
    }
  }

  // Building sprite at north end
  pushStructure(structures, 0, H - 1, 35, 0x10141a, 6);

  return {
    seed, archetypeId: 32, label: 'RESEARCH STATION', tint: 0x10141a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #33 — Excavation Site ──────────────────────────────────────
// Rect, 3×6 central void pit, crane/drill structures at pit edges.
function generateArchetype33(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const PIT_W = 3; const PIT_H = 6;
  const PIT_DX = -1; const PIT_DY = 3;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const inPit = dx >= PIT_DX && dx <= PIT_DX + PIT_W - 1
                 && dy >= PIT_DY && dy <= PIT_DY + PIT_H - 1;
      if (inPit) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Crane structures at cardinal pit edges
  pushStructure(structures, PIT_DX + 1, PIT_DY - 1, 14, 0x1a1610, 5);
  pushStructure(structures, PIT_DX + 1, PIT_DY + PIT_H, 14, 0x1a1610, 5);
  pushStructure(structures, PIT_DX - 1, PIT_DY + 2, 14, 0x1a1610, 5);
  pushStructure(structures, PIT_DX + PIT_W + 1, PIT_DY + 2, 14, 0x1a1610, 5);

  // Pit glow
  const pitPos = zoneTile(PIT_DX + 1, PIT_DY + 3);
  if (!isHubTile(pitPos.tx, pitPos.ty)) {
    glows.push({ tx: pitPos.tx, ty: pitPos.ty, color: 0x806040, alpha: 0.14, radius: 20 });
  }

  return {
    seed, archetypeId: 33, label: 'EXCAVATION SITE', tint: 0x1a1610,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #34 — Power Substation ─────────────────────────────────────
// Small 12×14, generator centre, tight machine ring, single S entry.
function generateArchetype34(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = 6;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Generator at centre
  const CY = Math.round(H / 2);
  pushStructure(structures, 0, CY, 35, 0x0e140e, 7);
  const genPos = zoneTile(0, CY);
  if (!isHubTile(genPos.tx, genPos.ty)) {
    glows.push({ tx: genPos.tx, ty: genPos.ty, color: 0x4ade80, alpha: 0.25, radius: 20 });
  }

  // Machine ring at radius 3
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 3) {
    const mdx = Math.round(Math.cos(angle) * 3);
    const mdy = Math.round(CY + Math.sin(angle) * 3);
    pushStructure(structures, mdx, mdy, 42, 0x0e140e, 5);
  }

  return {
    seed, archetypeId: 34, label: 'POWER SUBSTATION', tint: 0x0e140e,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #35 — Transit Hub ───────────────────────────────────────────
// 3 parallel lanes separated by 1-tile void rails, 3 cross-lane connections.
function generateArchetype35(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2    = ZONE_HALF_W;
  const H     = 12;
  const LANES = 3;
  const LANE_W = 3;
  const RAIL_W = 1;
  const UNIT   = LANE_W + RAIL_W; // 4 tiles per lane+rail

  for (let lane = 0; lane < LANES; lane++) {
    const lx0 = -W2 + lane * UNIT;
    for (let dy = 0; dy < H; dy++) {
      for (let dx = lx0; dx < lx0 + LANE_W; dx++) {
        pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
      }
    }
  }

  // 3 cross-lanes at top, middle, bottom
  for (const cy of [0, Math.round(H / 2), H - 1]) {
    for (let dx = -W2; dx < -W2 + LANES * UNIT; dx++) {
      pushTile(tiles, dx, cy, 7);
    }
  }

  return {
    seed, archetypeId: 35, label: 'TRANSIT HUB', tint: 0x121216,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #36 — Crater Installation ──────────────────────────────────
// Outer wall ring with 4 gun emplacements, inner open circle, central obelisk.
function generateArchetype36(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R = 7;

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
      // Outer wall ring
      if (d2 >= (R - 1) * (R - 1)) {
        const isSEntry = dy <= 1 && Math.abs(dx) <= 1;
        if (!isSEntry) pushStructure(structures, dx, dy, 21, 0x0e0e18, 5);
      }
    }
  }

  // 4 gun emplacements at N/S/E/W on the ring
  for (const [gdx, gdy] of [[0, 0], [0, R * 2], [-R + 1, R], [R - 1, R]]) {
    pushStructure(structures, gdx, gdy, 14, 0x0e0e18, 6);
  }

  // Central obelisk
  pushStructure(structures, 0, R, 35, 0x0e0e18, 7);
  const centPos = zoneTile(0, R);
  if (!isHubTile(centPos.tx, centPos.ty)) {
    glows.push({ tx: centPos.tx, ty: centPos.ty, color: 0x9060ff, alpha: 0.16, radius: 18 });
  }

  return {
    seed, archetypeId: 36, label: 'CRATER INSTALLATION', tint: 0x0e0e18,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #37 — Dormitory Block ──────────────────────────────────────
// Wide rect, alternating bunk-column and 1-wide aisle, enemies pour from east.
function generateArchetype37(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 6;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Alternating bunk columns (every 2 dx: bunk, aisle, bunk, aisle...)
  for (let dx = -W2 + 1; dx <= W2 - 1; dx += 2) {
    for (let dy = 1; dy < H - 1; dy += 3) {
      pushStructure(structures, dx, dy, 42, 0x101010, 4);
    }
  }

  return {
    seed, archetypeId: 37, label: 'DORMITORY BLOCK', tint: 0x101010,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #38 — Command Centre ───────────────────────────────────────
// H-shape: two rectangular ends joined by a narrow centre bridge.
function generateArchetype38(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2      = ZONE_HALF_W;
  const WING_H  = 5;
  const BRIDGE_H = 3;
  const TOTAL_H = WING_H * 2 + BRIDGE_H;

  // South wing
  for (let dy = 0; dy < WING_H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }
  // Narrow bridge
  for (let dy = WING_H; dy < WING_H + BRIDGE_H; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      pushTile(tiles, dx, dy, 7);
    }
  }
  // North wing
  for (let dy = WING_H + BRIDGE_H; dy < TOTAL_H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Building sprite in each wing
  pushStructure(structures, 0, Math.round(WING_H / 2), 35, 0x10141e, 6);
  pushStructure(structures, 0, WING_H + BRIDGE_H + Math.round(WING_H / 2), 35, 0x10141e, 6);

  return {
    seed, archetypeId: 38, label: 'COMMAND CENTRE', tint: 0x10141e,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #39 — Energy Node Garden ───────────────────────────────────
// Rect, 12–16 single-tile node structures, coloured glow per node.
function generateArchetype39(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 11;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Node colours: cycle Seren/Sybil/Sayon
  const nodeColors = [0x4080ff, 0x9060ff, 0xffa040];
  const nodeCount = 12 + Math.floor(rng() * 5);
  const placed = new Set<string>();
  let attempts = 0;
  while (placed.size < nodeCount && attempts < 100) {
    attempts++;
    const ndx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const ndy = 1 + Math.round(rng() * (H - 2));
    const key = `${ndx},${ndy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    const color = nodeColors[placed.size % 3];
    pushStructure(structures, ndx, ndy, 14, 0x0a0a18, 5);
    const np = zoneTile(ndx, ndy);
    if (!isHubTile(np.tx, np.ty)) {
      glows.push({ tx: np.tx, ty: np.ty, color, alpha: 0.2, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 39, label: 'ENERGY NODE GARDEN', tint: 0x0a0a18,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CATEGORY C — ORGANIC / ALIEN (archetypes 40–59)
// ══════════════════════════════════════════════════════════════════════════

// ── Archetype #40 — Spore Colony ──────────────────────────────────────────
// Blob base, 8–12 circular spore clusters of radius 2, bioluminescent greens.
function generateArchetype40(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      if (Math.sqrt(nx * nx + ny * ny) > 0.92 + (rng() - 0.5) * 0.1) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  const clusterCount = 8 + Math.floor(rng() * 5);
  const placed = new Set<string>();
  let attempts = 0;
  while (placed.size < clusterCount && attempts < 80) {
    attempts++;
    const cdx = -W2 + 3 + Math.round(rng() * (W2 * 2 - 6));
    const cdy = 2 + Math.round(rng() * (H - 4));
    const key = `${cdx},${cdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    // Spore cap structure at cluster centre
    pushStructure(structures, cdx, cdy, 14, 0x0a1a0a, 5);
    const cp = zoneTile(cdx, cdy);
    if (!isHubTile(cp.tx, cp.ty)) {
      glows.push({ tx: cp.tx, ty: cp.ty, color: 0x4ade80, alpha: 0.22, radius: 14 });
    }
  }

  return {
    seed, archetypeId: 40, label: 'SPORE COLONY', tint: 0x0a140a,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #41 — Tendril Maze ──────────────────────────────────────────
// 5 organic tendril arms branching from a central node, passable gaps between.
function generateArchetype41(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;
  const CY = Math.round(H * 0.6);

  // Central node — small 3×3 blob
  for (let dy = CY - 1; dy <= CY + 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      pushTile(tiles, dx, dy, 0);
    }
  }

  // 5 arms radiating outward
  const armAngles = [
    Math.PI * 0.0,   // south
    Math.PI * 0.4,
    Math.PI * 0.8,
    Math.PI * 1.2,
    Math.PI * 1.6,
  ];
  for (const baseAngle of armAngles) {
    let cx = 0.0; let cy = CY;
    let angle = baseAngle + (rng() - 0.5) * 0.3;
    const len = 5 + Math.floor(rng() * 4);
    for (let seg = 0; seg < len; seg++) {
      angle += (rng() - 0.5) * 0.4;
      cx += Math.cos(angle) * 2;
      cy += Math.sin(angle) * 2;
      const tx = Math.round(cx); const ty = Math.round(cy);
      // 2-tile wide arm
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          pushTile(tiles, tx + ox, ty + oy, rng() < 0.7 ? 0 : 1);
        }
      }
      if (seg % 3 === 0) {
        const ap = zoneTile(tx, ty);
        if (!isHubTile(ap.tx, ap.ty)) {
          glows.push({ tx: ap.tx, ty: ap.ty, color: 0x86efac, alpha: 0.16, radius: 10 });
        }
      }
    }
  }

  return {
    seed, archetypeId: 41, label: 'TENDRIL MAZE', tint: 0x0c180c,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #42 — Hive Cell ──────────────────────────────────────────────
// Hexagonal honeycomb pattern — alternating walkable cells and void walls.
function generateArchetype42(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2    = ZONE_HALF_W;
  const H     = 12;
  const CELL  = 3;  // cell width in tiles
  const WALL  = 1;  // wall thickness

  for (let row = 0; row * (CELL + WALL) < H; row++) {
    const stagger = row % 2 === 0 ? 0 : Math.round((CELL + WALL) / 2);
    const dy0 = row * (CELL + WALL);
    for (let col = 0; col * (CELL + WALL) - W2 < W2 + CELL; col++) {
      const dx0 = col * (CELL + WALL) - W2 + stagger;
      for (let dy = dy0; dy < dy0 + CELL && dy < H; dy++) {
        for (let dx = dx0; dx < dx0 + CELL && dx <= W2; dx++) {
          if (dx < -W2) continue;
          pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
        }
      }
      // Amber cell glow on every third cell
      if ((row + col) % 3 === 0) {
        const gp = zoneTile(dx0 + 1, dy0 + 1);
        if (!isHubTile(gp.tx, gp.ty)) {
          glows.push({ tx: gp.tx, ty: gp.ty, color: 0xfbbf24, alpha: 0.14, radius: 10 });
        }
      }
    }
  }

  return {
    seed, archetypeId: 42, label: 'HIVE CELL', tint: 0x1a1406,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #43 — Mycelium Web ──────────────────────────────────────────
// Thin 1-tile-wide web threads connecting 6–8 node hubs.
function generateArchetype43(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 12;

  // Generate 7 hub positions
  const hubs: Array<{ dx: number; dy: number }> = [];
  hubs.push({ dx: 0, dy: 0 }); // entry hub always at south
  for (let i = 1; i < 7; i++) {
    hubs.push({
      dx: Math.round((rng() * 2 - 1) * (W2 - 1)),
      dy: 1 + Math.round(rng() * (H - 2)),
    });
  }

  // 3×3 blob at each hub
  for (const h of hubs) {
    for (let dy = h.dy - 1; dy <= h.dy + 1; dy++) {
      for (let dx = h.dx - 1; dx <= h.dx + 1; dx++) {
        pushTile(tiles, dx, dy, 0);
      }
    }
    pushStructure(structures, h.dx, h.dy, 14, 0x0a0a1a, 5);
    const hp = zoneTile(h.dx, h.dy);
    if (!isHubTile(hp.tx, hp.ty)) {
      glows.push({ tx: hp.tx, ty: hp.ty, color: 0xc4b5fd, alpha: 0.2, radius: 10 });
    }
  }

  // Connect each hub to the next with a 1-tile-wide thread
  for (let i = 0; i < hubs.length - 1; i++) {
    const a = hubs[i]; const b = hubs[i + 1];
    const steps = Math.max(Math.abs(b.dx - a.dx), Math.abs(b.dy - a.dy));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const tdx = Math.round(a.dx + (b.dx - a.dx) * t);
      const tdy = Math.round(a.dy + (b.dy - a.dy) * t);
      pushTile(tiles, tdx, tdy, 7);
    }
  }

  return {
    seed, archetypeId: 43, label: 'MYCELIUM WEB', tint: 0x0a0a1a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #44 — Bioluminescent Pool ───────────────────────────────────
// Open oval, 4 glowing pool voids (player walks around them), dense cyan glow.
function generateArchetype44(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const RX = ZONE_HALF_W - 1;
  const RY = 6;
  const CY = RY;

  const pools: Set<string> = new Set();
  const poolCentres = [
    { dx: -4, dy: 3 }, { dx: 4, dy: 3 },
    { dx: -3, dy: 8 }, { dx: 3, dy: 8 },
  ];
  for (const pc of poolCentres) {
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        if (ox * ox + oy * oy <= 4) pools.add(`${pc.dx + ox},${pc.dy + oy}`);
      }
    }
    const pp = zoneTile(pc.dx, pc.dy);
    if (!isHubTile(pp.tx, pp.ty)) {
      glows.push({ tx: pp.tx, ty: pp.ty, color: 0x22d3ee, alpha: 0.3, radius: 18 });
    }
  }

  for (let dy = 0; dy < RY * 2; dy++) {
    for (let dx = -RX; dx <= RX; dx++) {
      const nx = dx / RX; const ny = (dy - CY) / RY;
      if (nx * nx + ny * ny > 1) continue;
      if (pools.has(`${dx},${dy}`)) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  return {
    seed, archetypeId: 44, label: 'BIOLUMINESCENT POOL', tint: 0x061414,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #45 — Cyst Chamber ──────────────────────────────────────────
// Concentric oval rings with 2-tile gaps between them, layered depth.
function generateArchetype45(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const RX = ZONE_HALF_W - 1;
  const RY = 6;
  const CY = RY;

  // 3 concentric rings, each 1 tile thick, gaps of 1 between
  for (let ring = 0; ring < 3; ring++) {
    const rxOuter = RX - ring * 3;
    const ryOuter = RY - ring * 2;
    const rxInner = rxOuter - 1;
    const ryInner = ryOuter - 1;
    if (rxOuter < 1 || ryOuter < 1) break;

    for (let dy = 0; dy <= CY * 2; dy++) {
      for (let dx = -rxOuter; dx <= rxOuter; dx++) {
        const nx = dx / rxOuter; const ny = (dy - CY) / ryOuter;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const nx2 = rxInner > 0 ? dx / rxInner : 2;
        const ny2 = ryInner > 0 ? (dy - CY) / ryInner : 2;
        if (nx2 * nx2 + ny2 * ny2 < 1) continue;
        pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
      }
    }

    // Gap passage between rings (seeded position)
    const passAngle = rng() * Math.PI * 2;
    const pdx = Math.round(Math.cos(passAngle) * (rxOuter - 1));
    const pdy = Math.round(CY + Math.sin(passAngle) * (ryOuter - 1));
    pushTile(tiles, pdx, pdy, 7);
    pushTile(tiles, pdx, pdy + 1, 7);
  }

  // Centre glow
  const cp = zoneTile(0, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0xf43f5e, alpha: 0.2, radius: 14 });
  }

  return {
    seed, archetypeId: 45, label: 'CYST CHAMBER', tint: 0x180a0c,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #46 — Parasite Nest ─────────────────────────────────────────
// Irregular blob, 5 egg-cluster structures (2×2), dense enemy spawn.
function generateArchetype46(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 11;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      if (Math.sqrt(nx * nx + ny * ny) > 0.9 + (rng() - 0.5) * 0.12) continue;
      pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
    }
  }

  // 5 egg clusters
  for (let e = 0; e < 5; e++) {
    const edx = -W2 + 3 + Math.round(rng() * (W2 * 2 - 6));
    const edy = 2 + Math.round(rng() * (H - 4));
    pushStructure(structures, edx,     edy,     42, 0x1a0a08, 5);
    pushStructure(structures, edx + 1, edy,     42, 0x1a0a08, 5);
    pushStructure(structures, edx,     edy + 1, 42, 0x1a0a08, 5);
    pushStructure(structures, edx + 1, edy + 1, 42, 0x1a0a08, 5);
    const ep = zoneTile(edx, edy);
    if (!isHubTile(ep.tx, ep.ty)) {
      glows.push({ tx: ep.tx, ty: ep.ty, color: 0xfca5a5, alpha: 0.18, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 46, label: 'PARASITE NEST', tint: 0x1a0a08,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #47 — Extrusion Field ──────────────────────────────────────
// Rect, dense irregular 1-tile extrusion spikes from N and S walls inward.
function generateArchetype47(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Full ground rect
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Spike structures from south (dy 0–3) and north (dy H-4 – H-1)
  for (let dx = -W2 + 1; dx <= W2 - 1; dx++) {
    const sLen = 1 + Math.floor(rng() * 4);
    for (let s = 0; s < sLen; s++) {
      pushStructure(structures, dx, s, 14, 0x1a0a14, 5);
    }
    const nLen = 1 + Math.floor(rng() * 4);
    for (let s = 0; s < nLen; s++) {
      pushStructure(structures, dx, H - 1 - s, 14, 0x1a0a14, 5);
    }
  }

  return {
    seed, archetypeId: 47, label: 'EXTRUSION FIELD', tint: 0x140a12,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #48 — Membrane Passage ──────────────────────────────────────
// 3 rectangular "chambers" connected by single-tile membrane slits.
function generateArchetype48(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2       = ZONE_HALF_W - 2;
  const CHAMBER_H = 4;
  const SLIT_H    = 1;
  const UNIT      = CHAMBER_H + SLIT_H;

  for (let c = 0; c < 3; c++) {
    const dy0 = c * UNIT;
    // Chamber ground
    for (let dy = dy0; dy < dy0 + CHAMBER_H; dy++) {
      for (let dx = -W2; dx <= W2; dx++) {
        pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
      }
    }
    // Slit — 1-tile passage, seeded X position
    if (c < 2) {
      const slitDx = Math.round((rng() * 1.6 - 0.8) * (W2 - 1));
      pushTile(tiles, slitDx, dy0 + CHAMBER_H, 7);
      // Membrane glow at slit
      const sp = zoneTile(slitDx, dy0 + CHAMBER_H);
      if (!isHubTile(sp.tx, sp.ty)) {
        glows.push({ tx: sp.tx, ty: sp.ty, color: 0xa78bfa, alpha: 0.24, radius: 8 });
      }
    }
  }

  return {
    seed, archetypeId: 48, label: 'MEMBRANE PASSAGE', tint: 0x120a18,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #49 — Coral Shelf ────────────────────────────────────────────
// Wide rect, dense scattered single-tile coral structures, teal glow.
function generateArchetype49(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 10;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // ~30% of tiles get a coral structure
  for (let dy = 1; dy < H - 1; dy++) {
    for (let dx = -W2 + 1; dx <= W2 - 1; dx++) {
      if (rng() > 0.28) continue;
      pushStructure(structures, dx, dy, 14, 0x082018, 4);
      if (rng() < 0.3) {
        const cp = zoneTile(dx, dy);
        if (!isHubTile(cp.tx, cp.ty)) {
          glows.push({ tx: cp.tx, ty: cp.ty, color: 0x2dd4bf, alpha: 0.18, radius: 8 });
        }
      }
    }
  }

  return {
    seed, archetypeId: 49, label: 'CORAL SHELF', tint: 0x082018,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #50 — Absorption Pit ────────────────────────────────────────
// Funnel shape: wide at south, narrows to 3 tiles at north, single exit.
function generateArchetype50(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H   = 12;
  const MAX_W = ZONE_HALF_W;
  const MIN_W = 1;

  for (let dy = 0; dy < H; dy++) {
    const t    = dy / (H - 1); // 0 at south, 1 at north
    const halfW = Math.round(MAX_W + (MIN_W - MAX_W) * t);
    for (let dx = -halfW; dx <= halfW; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Pit glow intensifies toward the north tip
  const pitPos = zoneTile(0, H - 2);
  if (!isHubTile(pitPos.tx, pitPos.ty)) {
    glows.push({ tx: pitPos.tx, ty: pitPos.ty, color: 0xf43f5e, alpha: 0.26, radius: 16 });
  }

  return {
    seed, archetypeId: 50, label: 'ABSORPTION PIT', tint: 0x180808,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #51 — Symbiote Grove ────────────────────────────────────────
// Blob, 4 large circular organism structures (r=2), faint purple glow web.
function generateArchetype51(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      if (Math.sqrt(nx * nx + ny * ny) > 0.9 + (rng() - 0.5) * 0.1) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  const organisms = [
    { dx: -5, dy: 3 }, { dx: 5, dy: 3 },
    { dx: -4, dy: 9 }, { dx: 4, dy: 9 },
  ];
  for (const o of organisms) {
    // 5-tile ring structure
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const d2 = ox * ox + oy * oy;
        if (d2 < 3 || d2 > 5) continue;
        pushStructure(structures, o.dx + ox, o.dy + oy, 21, 0x14082a, 5);
      }
    }
    const op = zoneTile(o.dx, o.dy);
    if (!isHubTile(op.tx, op.ty)) {
      glows.push({ tx: op.tx, ty: op.ty, color: 0xa78bfa, alpha: 0.22, radius: 20 });
    }
  }

  return {
    seed, archetypeId: 51, label: 'SYMBIOTE GROVE', tint: 0x0e0814,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #52 — Spinal Ridge ──────────────────────────────────────────
// Central S-curve spine of tiles, 2-tile wide, bony structure spurs off each side.
function generateArchetype52(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H = 14;
  let cx = 0.0;

  for (let dy = 0; dy < H; dy++) {
    // S-curve: cx oscillates gently
    cx += Math.sin(dy * 0.5) * 0.8;
    cx = Math.max(-ZONE_HALF_W + 2, Math.min(ZONE_HALF_W - 2, cx));
    const icx = Math.round(cx);

    // 2-tile wide spine
    for (let ox = -1; ox <= 1; ox++) {
      pushTile(tiles, icx + ox, dy, rng() < 0.72 ? 0 : 1);
    }

    // Spur structures on alternating sides
    if (dy % 3 === 0) {
      const side = dy % 6 === 0 ? 1 : -1;
      for (let s = 2; s <= 4; s++) {
        pushStructure(structures, icx + side * s, dy, 28, 0x1a1814, 4);
      }
    }
  }

  return {
    seed, archetypeId: 52, label: 'SPINAL RIDGE', tint: 0x1a1814,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #53 — Chitinous Labyrinth ───────────────────────────────────
// Dense rect, 2-tile-thick wall segments placed on a grid, 1-tile doorways.
function generateArchetype53(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const CELL = 4;

  // Full ground
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Horizontal wall segments at cell grid rows
  for (let wy = CELL - 1; wy < H; wy += CELL) {
    const gapDx = -W2 + 1 + Math.round(rng() * (W2 * 2 - 2));
    for (let dx = -W2; dx <= W2; dx++) {
      if (Math.abs(dx - gapDx) <= 0) continue;
      pushStructure(structures, dx, wy, 21, 0x120e0a, 4);
      if (wy + 1 < H) pushStructure(structures, dx, wy + 1, 21, 0x120e0a, 4);
    }
  }

  return {
    seed, archetypeId: 53, label: 'CHITINOUS LABYRINTH', tint: 0x120e0a,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #54 — Neural Lattice ────────────────────────────────────────
// Grid of single-tile nodes connected by 1-tile lines — circuit-board organic.
function generateArchetype54(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const STEP = 3;

  // Node grid
  for (let dy = 0; dy < H; dy += STEP) {
    for (let dx = -W2; dx <= W2; dx += STEP) {
      // Node tile
      pushTile(tiles, dx, dy, 7);
      pushStructure(structures, dx, dy, 14, 0x080a18, 5);
      const np = zoneTile(dx, dy);
      if (!isHubTile(np.tx, np.ty)) {
        glows.push({ tx: np.tx, ty: np.ty, color: 0x38bdf8, alpha: 0.2, radius: 8 });
      }

      // Horizontal trace to next node
      if (dx + STEP <= W2) {
        for (let lx = dx + 1; lx < dx + STEP; lx++) {
          pushTile(tiles, lx, dy, 0);
        }
      }
      // Vertical trace to next node
      if (dy + STEP < H) {
        for (let ly = dy + 1; ly < dy + STEP; ly++) {
          pushTile(tiles, dx, ly, 0);
        }
      }
    }
  }

  return {
    seed, archetypeId: 54, label: 'NEURAL LATTICE', tint: 0x060810,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #55 — Overgrowth Ruin ───────────────────────────────────────
// Architectural rect base heavily overwritten by organic blob patches.
function generateArchetype55(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Architectural base
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Wall remnants
  for (let wy of [3, 7]) {
    const gapDx = Math.round((rng() * 1.6 - 0.8) * (W2 - 2));
    for (let dx = -W2; dx <= W2; dx++) {
      if (Math.abs(dx - gapDx) <= 1) continue;
      if (rng() < 0.45) pushStructure(structures, dx, wy, 21, 0x0e1a0e, 4);
    }
  }

  // Organic blob patches overwriting tiles (re-push with organic frame)
  for (let patch = 0; patch < 4; patch++) {
    const pcx = Math.round((rng() * 2 - 1) * (W2 - 2));
    const pcy = 1 + Math.round(rng() * (H - 3));
    const pr  = 2 + Math.floor(rng() * 2);
    for (let dy = pcy - pr; dy <= pcy + pr; dy++) {
      for (let dx = pcx - pr; dx <= pcx + pr; dx++) {
        if ((dx - pcx) ** 2 + (dy - pcy) ** 2 > pr * pr) continue;
        pushTile(tiles, dx, dy, 1); // organic frame variant
      }
    }
    const pp = zoneTile(pcx, pcy);
    if (!isHubTile(pp.tx, pp.ty)) {
      glows.push({ tx: pp.tx, ty: pp.ty, color: 0x86efac, alpha: 0.16, radius: pr * 8 });
    }
  }

  return {
    seed, archetypeId: 55, label: 'OVERGROWTH RUIN', tint: 0x0e1a0e,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #56 — Xenolith Garden ───────────────────────────────────────
// Open field, 10–14 alien monolith structures in semi-random grid, each glowing.
function generateArchetype56(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  const monolithCount = 10 + Math.floor(rng() * 5);
  const placed = new Set<string>();
  let attempts = 0;
  const monolithColors = [0xa78bfa, 0x38bdf8, 0x4ade80, 0xfbbf24];
  while (placed.size < monolithCount && attempts < 100) {
    attempts++;
    const mdx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const mdy = 1 + Math.round(rng() * (H - 2));
    const key = `${mdx},${mdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    pushStructure(structures, mdx, mdy, 35, 0x080810, 6);
    const mp = zoneTile(mdx, mdy);
    if (!isHubTile(mp.tx, mp.ty)) {
      glows.push({ tx: mp.tx, ty: mp.ty, color: monolithColors[placed.size % 4], alpha: 0.22, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 56, label: 'XENOLITH GARDEN', tint: 0x080810,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #57 — Peristaltic Corridor ──────────────────────────────────
// Single winding organic corridor, 3 tiles wide, curves across full depth.
function generateArchetype57(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H  = ZONE_DEPTH;
  const HW = 1; // half-width of corridor (so corridor = 3 tiles)

  let cx = 0.0;
  for (let dy = 0; dy < H; dy++) {
    cx += (rng() - 0.5) * 2.2;
    cx = Math.max(-ZONE_HALF_W + HW + 1, Math.min(ZONE_HALF_W - HW - 1, cx));
    const icx = Math.round(cx);
    for (let ox = -HW; ox <= HW; ox++) {
      pushTile(tiles, icx + ox, dy, rng() < 0.72 ? 0 : 1);
    }
    // Periodic wall-bulge structures along sides
    if (dy % 4 === 0) {
      pushStructure(structures, icx - HW - 1, dy, 21, 0x100814, 4);
      pushStructure(structures, icx + HW + 1, dy, 21, 0x100814, 4);
    }
    if (dy % 6 === 0) {
      const gp = zoneTile(icx, dy);
      if (!isHubTile(gp.tx, gp.ty)) {
        glows.push({ tx: gp.tx, ty: gp.ty, color: 0xf43f5e, alpha: 0.14, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 57, label: 'PERISTALTIC CORRIDOR', tint: 0x100814,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #58 — Calcified Crater ──────────────────────────────────────
// Ring with calcified bone-white structures along rim, void pit, amber glow.
function generateArchetype58(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R  = 7;
  const RI = 3; // inner void radius

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R || d2 < RI * RI) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);

      // Rim structures at outer edge
      if (d2 >= (R - 1) * (R - 1) && rng() < 0.4) {
        pushStructure(structures, dx, dy, 28, 0x1e1a12, 4);
      }
    }
  }

  const centPos = zoneTile(0, R);
  if (!isHubTile(centPos.tx, centPos.ty)) {
    glows.push({ tx: centPos.tx, ty: centPos.ty, color: 0xfbbf24, alpha: 0.18, radius: 18 });
  }

  return {
    seed, archetypeId: 58, label: 'CALCIFIED CRATER', tint: 0x1a1810,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #59 — Alien Substrate ───────────────────────────────────────
// Max rect, 60% of tiles replaced by noise-seeded organic floor variants,
// no structures — pure alien ground texture, high enemy density.
function generateArchetype59(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // 3 organic floor variants weighted 50/30/20
      const r = rng();
      pushTile(tiles, dx, dy, r < 0.5 ? 0 : r < 0.8 ? 1 : 7);
    }
  }

  // Scattered faint glow patches — substrate "breathing"
  for (let i = 0; i < 8; i++) {
    const gdx = Math.round((rng() * 2 - 1) * (W2 - 1));
    const gdy = 1 + Math.round(rng() * (H - 2));
    const gp  = zoneTile(gdx, gdy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0x4ade80, alpha: 0.1, radius: 18 });
    }
  }

  return {
    seed, archetypeId: 59, label: 'ALIEN SUBSTRATE', tint: 0x081008,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CATEGORY D — MILITARY / INDUSTRIAL (archetypes 60–79)
// ══════════════════════════════════════════════════════════════════════════

// ── Archetype #60 — Fortification Wall ────────────────────────────────────
// Full-width rect, two staggered barricade lines across it, 2-tile gates.
function generateArchetype60(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Two barricade lines at dy 4 and dy 8, gates staggered
  const gateA = -W2 + 2 + Math.round(rng() * (W2 - 2));
  const gateB =  W2 - 2 - Math.round(rng() * (W2 - 2));
  for (let dx = -W2; dx <= W2; dx++) {
    if (dx !== gateA && dx !== gateA + 1) pushStructure(structures, dx, 4, 21, 0x0e1014, 5);
    if (dx !== gateB && dx !== gateB + 1) pushStructure(structures, dx, 8, 21, 0x0e1014, 5);
  }

  // Glow at each gate
  for (const [gx, gy] of [[gateA, 4], [gateB, 8]]) {
    const gp = zoneTile(gx, gy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0xfbbf24, alpha: 0.18, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 60, label: 'FORTIFICATION WALL', tint: 0x0e1014,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #61 — Trench Network ────────────────────────────────────────
// 4 parallel trench corridors (3 tiles wide), separated by impassable berms.
function generateArchetype61(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2         = ZONE_HALF_W;
  const H          = 12;
  const TRENCH_W   = 3;
  const BERM_W     = 2;
  const UNIT       = TRENCH_W + BERM_W;
  const TRENCHES   = 4;

  for (let t = 0; t < TRENCHES; t++) {
    const dx0 = -W2 + t * UNIT;
    for (let dy = 0; dy < H; dy++) {
      for (let dx = dx0; dx < dx0 + TRENCH_W && dx <= W2; dx++) {
        pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
      }
    }
    // Cross-connection at mid-height
    if (t < TRENCHES - 1) {
      const crossDy = 4 + Math.round(rng() * 4);
      for (let dx = dx0 + TRENCH_W; dx < dx0 + UNIT && dx <= W2; dx++) {
        pushTile(tiles, dx, crossDy, 7);
        pushTile(tiles, dx, crossDy + 1, 7);
      }
    }
    // Berm structures
    for (let dy = 0; dy < H; dy++) {
      for (let bx = dx0 + TRENCH_W; bx < dx0 + UNIT && bx <= W2; bx++) {
        if (rng() < 0.6) pushStructure(structures, bx, dy, 21, 0x10100e, 4);
      }
    }
  }

  return {
    seed, archetypeId: 61, label: 'TRENCH NETWORK', tint: 0x10100e,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #62 — Minefield ─────────────────────────────────────────────
// Open rect, scattered mine marker structures — visually warns player, tight pathing.
function generateArchetype62(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // ~20% tile density of mine markers
  for (let dy = 1; dy < H - 1; dy++) {
    for (let dx = -W2 + 1; dx <= W2 - 1; dx++) {
      if (rng() > 0.18) continue;
      pushStructure(structures, dx, dy, 42, 0x1a1008, 4);
      if (rng() < 0.25) {
        const mp = zoneTile(dx, dy);
        if (!isHubTile(mp.tx, mp.ty)) {
          glows.push({ tx: mp.tx, ty: mp.ty, color: 0xef4444, alpha: 0.14, radius: 8 });
        }
      }
    }
  }

  return {
    seed, archetypeId: 62, label: 'MINEFIELD', tint: 0x141208,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #63 — Killbox ───────────────────────────────────────────────
// Narrow central corridor, elevated fire positions left and right (non-walkable).
function generateArchetype63(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2        = ZONE_HALF_W;
  const H         = 12;
  const CORRIDOR  = 3; // half-width of walkable centre
  const FLANK_W   = W2 - CORRIDOR;

  // Central corridor
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -CORRIDOR; dx <= CORRIDOR; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Flanking fire positions — non-walkable raised platforms with cover structures
  for (let side of [-1, 1]) {
    for (let dy = 0; dy < H; dy++) {
      for (let fx = CORRIDOR + 1; fx <= W2; fx++) {
        pushStructure(structures, side * fx, dy, 21, 0x0e1218, 4);
      }
    }
    // Cover notches every 3 rows
    for (let dy = 1; dy < H - 1; dy += 3) {
      pushStructure(structures, side * (CORRIDOR + 1), dy, 14, 0x0e1218, 5);
      const cp = zoneTile(side * (CORRIDOR + 1), dy);
      if (!isHubTile(cp.tx, cp.ty)) {
        glows.push({ tx: cp.tx, ty: cp.ty, color: 0xfbbf24, alpha: 0.16, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 63, label: 'KILLBOX', tint: 0x0e1218,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #64 — Armament Depot ───────────────────────────────────────
// Rect, 3×2 crate-block structures in rows, tight aisle navigation.
function generateArchetype64(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2     = ZONE_HALF_W;
  const H      = 12;
  const CRATE_W = 3;
  const CRATE_H = 2;
  const AISLE  = 2;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Crate rows: stagger columns
  for (let row = 0; row < 3; row++) {
    const dy0 = 1 + row * (CRATE_H + AISLE);
    const stagger = row % 2 === 0 ? 0 : CRATE_W + 1;
    for (let col = 0; col * (CRATE_W + 1) - W2 + stagger < W2; col++) {
      const dx0 = col * (CRATE_W + 1) - W2 + 1 + stagger;
      for (let cy = dy0; cy < dy0 + CRATE_H; cy++) {
        for (let cx = dx0; cx < dx0 + CRATE_W && cx <= W2 - 1; cx++) {
          pushStructure(structures, cx, cy, 21, 0x18140a, 4);
        }
      }
    }
  }

  return {
    seed, archetypeId: 64, label: 'ARMAMENT DEPOT', tint: 0x18140a,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #65 — Barricade Run ────────────────────────────────────────
// Full rect, 6 offset single-tile barricade walls creating a staggered slalom.
function generateArchetype65(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2  = ZONE_HALF_W;
  const H   = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 6 barricade lines, alternating gap on left/right
  const LINES = 6;
  for (let i = 0; i < LINES; i++) {
    const dy  = 1 + Math.round(i * (H - 2) / (LINES - 1));
    const gapSide = i % 2 === 0 ? 1 : -1; // alternate gap side
    const gapDx   = gapSide * (W2 - 2);
    for (let dx = -W2; dx <= W2; dx++) {
      if (dx >= gapDx - 1 && dx <= gapDx + 1) continue;
      pushStructure(structures, dx, dy, 21, 0x141010, 4);
    }
  }

  return {
    seed, archetypeId: 65, label: 'BARRICADE RUN', tint: 0x141010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #66 — Siege Battery ────────────────────────────────────────
// C-shape (rect minus NE corner), 3 artillery emplacement structures facing south.
function generateArchetype66(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const NOTCH_W = W2 - 3;
  const NOTCH_H = 5;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // Carve NE notch
      if (dx > W2 - NOTCH_W && dy > H - NOTCH_H - 1) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 3 gun emplacements along north wall
  for (let i = 0; i < 3; i++) {
    const gdx = -W2 + 3 + i * 6;
    pushStructure(structures, gdx, H - 1, 35, 0x0e1410, 6);
    const gp = zoneTile(gdx, H - 1);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0xf97316, alpha: 0.2, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 66, label: 'SIEGE BATTERY', tint: 0x0e1410,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #67 — Staging Ground ───────────────────────────────────────
// Large open rect, 3 vehicle/equipment silhouette structures, wide combat space.
function generateArchetype67(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.75 ? 0 : 1);
    }
  }

  // 3 large equipment silhouettes — 2×3 blocks
  const stagingPositions = [
    { dx: -6, dy: 4 }, { dx: 2, dy: 8 }, { dx: -3, dy: 11 },
  ];
  for (const sp of stagingPositions) {
    for (let oy = 0; oy < 3; oy++) {
      for (let ox = 0; ox < 2; ox++) {
        pushStructure(structures, sp.dx + ox, sp.dy + oy, 35, 0x10140e, 5);
      }
    }
    const gp = zoneTile(sp.dx, sp.dy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0x6b7280, alpha: 0.16, radius: 14 });
    }
  }

  return {
    seed, archetypeId: 67, label: 'STAGING GROUND', tint: 0x10140e,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #68 — Detonation Zone ──────────────────────────────────────
// Rect with 5 blast-crater voids and radial debris, orange glow at each crater.
function generateArchetype68(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  const craters: Set<string> = new Set();
  const craterCentres: Array<{ dx: number; dy: number }> = [];
  for (let i = 0; i < 5; i++) {
    const cdx = -W2 + 3 + Math.round(rng() * (W2 * 2 - 6));
    const cdy = 2 + Math.round(rng() * (H - 4));
    craterCentres.push({ dx: cdx, dy: cdy });
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        craters.add(`${cdx + ox},${cdy + oy}`);
      }
    }
  }

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      if (craters.has(`${dx},${dy}`)) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  for (const c of craterCentres) {
    // Radial debris
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      const rdx = Math.round(c.dx + Math.cos(angle) * 2);
      const rdy = Math.round(c.dy + Math.sin(angle) * 2);
      if (rng() < 0.6) pushStructure(structures, rdx, rdy, 28, 0x1a1208, 3);
    }
    const cp = zoneTile(c.dx, c.dy);
    if (!isHubTile(cp.tx, cp.ty)) {
      glows.push({ tx: cp.tx, ty: cp.ty, color: 0xf97316, alpha: 0.2, radius: 14 });
    }
  }

  return {
    seed, archetypeId: 68, label: 'DETONATION ZONE', tint: 0x1a1208,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #69 — Perimeter Fence ──────────────────────────────────────
// Outer wall ring with two E/W entry gates, interior open.
function generateArchetype69(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 1;
  const H  = 12;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Perimeter wall
  const gateS = 0; // south gate at centre
  const gateN = 1; // north gate offset
  for (let dx = -W2; dx <= W2; dx++) {
    // South wall
    if (!(dx >= gateS - 1 && dx <= gateS + 1))
      pushStructure(structures, dx, 0, 21, 0x0e1010, 4);
    // North wall
    if (!(dx >= gateN - 1 && dx <= gateN + 1))
      pushStructure(structures, dx, H - 1, 21, 0x0e1010, 4);
  }
  for (let dy = 1; dy < H - 1; dy++) {
    pushStructure(structures, -W2, dy, 21, 0x0e1010, 4);
    pushStructure(structures,  W2, dy, 21, 0x0e1010, 4);
  }

  // Gate glow
  for (const [gx, gy] of [[gateS, 0], [gateN, H - 1]]) {
    const gp = zoneTile(gx, gy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0xfbbf24, alpha: 0.2, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 69, label: 'PERIMETER FENCE', tint: 0x0e1010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #70 — Fire Lane ─────────────────────────────────────────────
// Single straight open lane (6 wide), 3 cover berms on alternating sides.
function generateArchetype70(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const LANE_HW = 3;
  const H       = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -LANE_HW; dx <= LANE_HW; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 3 cover berms, alternating sides, each 3 tiles long
  for (let i = 0; i < 3; i++) {
    const bdy  = 2 + Math.round(i * (H - 4) / 2);
    const side = i % 2 === 0 ? -1 : 1;
    for (let dx = side * (LANE_HW - 2); dx !== side * (LANE_HW + 1); dx += side) {
      pushStructure(structures, dx, bdy, 21, 0x101010, 4);
      pushStructure(structures, dx, bdy + 1, 21, 0x101010, 4);
    }
  }

  return {
    seed, archetypeId: 70, label: 'FIRE LANE', tint: 0x101010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #71 — Gun Tower ──────────────────────────────────────────────
// Square with 4 corner towers (small 2×2 rects), central courtyard.
function generateArchetype71(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2    = ZONE_HALF_W - 1;
  const H     = 12;
  const TOWER = 2;

  // Main rect
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 4 corner towers: darker tinted tile + gun structure
  const corners = [
    [-W2, 0], [W2 - TOWER + 1, 0],
    [-W2, H - TOWER], [W2 - TOWER + 1, H - TOWER],
  ];
  for (const [cx, cy] of corners) {
    for (let oy = 0; oy < TOWER; oy++) {
      for (let ox = 0; ox < TOWER; ox++) {
        pushTile(tiles, cx + ox, cy + oy, 7);
      }
    }
    pushStructure(structures, cx, cy, 14, 0x0e1018, 6);
    const tp = zoneTile(cx, cy);
    if (!isHubTile(tp.tx, tp.ty)) {
      glows.push({ tx: tp.tx, ty: tp.ty, color: 0xfbbf24, alpha: 0.2, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 71, label: 'GUN TOWER', tint: 0x0e1018,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #72 — Debris Field ──────────────────────────────────────────
// Max rect, dense scattered debris structures (~35% coverage), open paths.
function generateArchetype72(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  for (let dy = 1; dy < H - 1; dy++) {
    for (let dx = -W2 + 1; dx <= W2 - 1; dx++) {
      if (rng() > 0.32) continue;
      pushStructure(structures, dx, dy, 28, 0x181614, 3);
    }
  }

  return {
    seed, archetypeId: 72, label: 'DEBRIS FIELD', tint: 0x181614,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #73 — Choke Bridge ──────────────────────────────────────────
// Two open zones (south and north) connected by a single 2-tile-wide bridge.
function generateArchetype73(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2       = ZONE_HALF_W;
  const ZONE_H   = 5;
  const BRIDGE_H = 3;
  const H        = ZONE_H * 2 + BRIDGE_H;

  // South zone
  for (let dy = 0; dy < ZONE_H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 2-tile bridge
  const bDx = Math.round((rng() - 0.5) * (W2 - 2));
  for (let dy = ZONE_H; dy < ZONE_H + BRIDGE_H; dy++) {
    pushTile(tiles, bDx,     dy, 7);
    pushTile(tiles, bDx + 1, dy, 7);
  }

  // Bridge glow
  const bp = zoneTile(bDx, ZONE_H + 1);
  if (!isHubTile(bp.tx, bp.ty)) {
    glows.push({ tx: bp.tx, ty: bp.ty, color: 0x38bdf8, alpha: 0.2, radius: 10 });
  }

  // North zone
  for (let dy = ZONE_H + BRIDGE_H; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  return {
    seed, archetypeId: 73, label: 'CHOKE BRIDGE', tint: 0x0e1014,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #74 — Firing Range ──────────────────────────────────────────
// Long narrow rect (20×6), silhouette target structures at north end.
function generateArchetype74(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W - 2;
  const H  = 8;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Target structures at north end
  for (let dx = -W2 + 1; dx <= W2 - 1; dx += 2) {
    pushStructure(structures, dx, H - 1, 42, 0x181010, 5);
    if (rng() < 0.4) {
      const tp = zoneTile(dx, H - 1);
      if (!isHubTile(tp.tx, tp.ty)) {
        glows.push({ tx: tp.tx, ty: tp.ty, color: 0xef4444, alpha: 0.18, radius: 8 });
      }
    }
  }

  return {
    seed, archetypeId: 74, label: 'FIRING RANGE', tint: 0x181010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #75 — Containment Block ────────────────────────────────────
// 3×3 grid of cells, each with a single-tile doorway, ring corridor around them.
function generateArchetype75(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const CELL_W   = 3;
  const CELL_H   = 3;
  const RING     = 1;
  const COLS     = 3;
  const ROWS     = 3;
  const W2_inner = Math.floor((COLS * (CELL_W + 1)) / 2);
  const H_inner  = ROWS * (CELL_H + 1);

  // Ring corridor
  for (let dy = 0; dy < H_inner + RING * 2; dy++) {
    for (let dx = -(W2_inner + RING); dx <= W2_inner + RING; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Cell walls and doorways
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const dx0 = -(W2_inner) + col * (CELL_W + 1) + RING;
      const dy0 = RING + row * (CELL_H + 1);

      // 4 walls of cell
      for (let ox = 0; ox < CELL_W; ox++) {
        pushStructure(structures, dx0 + ox, dy0,           21, 0x0e0e14, 4);
        pushStructure(structures, dx0 + ox, dy0 + CELL_H,  21, 0x0e0e14, 4);
      }
      for (let oy = 1; oy < CELL_H; oy++) {
        pushStructure(structures, dx0,           dy0 + oy, 21, 0x0e0e14, 4);
        pushStructure(structures, dx0 + CELL_W,  dy0 + oy, 21, 0x0e0e14, 4);
      }

      // Single-tile doorway in south wall at random position
      const doorX = dx0 + 1 + Math.floor(rng() * (CELL_W - 2));
      pushTile(tiles, doorX, dy0, 7);

      // Cell glow
      const cp = zoneTile(dx0 + 1, dy0 + 1);
      if (!isHubTile(cp.tx, cp.ty)) {
        glows.push({ tx: cp.tx, ty: cp.ty, color: 0xa78bfa, alpha: 0.14, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 75, label: 'CONTAINMENT BLOCK', tint: 0x0e0e14,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #76 — Salvage Yard ──────────────────────────────────────────
// Blob, irregular junk-pile structure clusters, amber industrial glow.
function generateArchetype76(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Blob base
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - H / 2) / (H / 2);
      if (Math.sqrt(nx * nx + ny * ny) > 0.9 + (rng() - 0.5) * 0.12) continue;
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Junk pile clusters — irregular 1–3 tile groups
  const pileCount = 8 + Math.floor(rng() * 6);
  const placed = new Set<string>();
  let attempts = 0;
  while (placed.size < pileCount && attempts < 80) {
    attempts++;
    const pdx = -W2 + 2 + Math.round(rng() * (W2 * 2 - 4));
    const pdy = 1 + Math.round(rng() * (H - 3));
    const key = `${pdx},${pdy}`;
    if (placed.has(key)) continue;
    placed.add(key);
    const pileSize = 1 + Math.floor(rng() * 3);
    for (let p = 0; p < pileSize; p++) {
      pushStructure(structures, pdx + p, pdy, 28, 0x1a1408, 4);
    }
    if (rng() < 0.4) {
      const pp = zoneTile(pdx, pdy);
      if (!isHubTile(pp.tx, pp.ty)) {
        glows.push({ tx: pp.tx, ty: pp.ty, color: 0xfbbf24, alpha: 0.14, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 76, label: 'SALVAGE YARD', tint: 0x1a1408,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #77 — Reactor Shell ────────────────────────────────────────
// Circle, ring catwalk path, central reactor structure, green radiation glow.
function generateArchetype77(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R  = 7;
  const RI = 3;

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - R) * (dy - R);
      if (d2 > R * R || d2 < RI * RI) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // 4 radial catwalks connecting ring to centre area
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    for (let r = RI; r <= R - 1; r++) {
      const cdx = Math.round(Math.cos(angle) * r);
      const cdy = Math.round(R + Math.sin(angle) * r);
      pushTile(tiles, cdx, cdy, 7);
    }
  }

  // Central reactor structure
  pushStructure(structures, 0, R, 35, 0x081408, 7);

  // Radiation glow
  const rp = zoneTile(0, R);
  if (!isHubTile(rp.tx, rp.ty)) {
    glows.push({ tx: rp.tx, ty: rp.ty, color: 0x4ade80, alpha: 0.28, radius: 22 });
  }

  return {
    seed, archetypeId: 77, label: 'REACTOR SHELL', tint: 0x081408,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #78 — Dropzone ──────────────────────────────────────────────
// Wide open rect, single large circular landing circle (6r), beacon glow.
function generateArchetype78(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;
  const CR = 4; // circle radius

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // Landing circle outline
  const CY = Math.round(H * 0.6);
  for (let dy = CY - CR; dy <= CY + CR; dy++) {
    for (let dx = -CR; dx <= CR; dx++) {
      const d2 = dx * dx + (dy - CY) * (dy - CY);
      // Ring only — 1 tile thick at radius CR
      if (d2 < (CR - 1) * (CR - 1) || d2 > CR * CR) continue;
      pushStructure(structures, dx, dy, 21, 0x0e1820, 3);
    }
  }

  // Beacon structures at cardinal points of circle
  for (const [bdx, bdy] of [[0, CY - CR], [0, CY + CR], [-CR, CY], [CR, CY]]) {
    pushStructure(structures, bdx, bdy, 14, 0x0e1820, 5);
    const bp = zoneTile(bdx, bdy);
    if (!isHubTile(bp.tx, bp.ty)) {
      glows.push({ tx: bp.tx, ty: bp.ty, color: 0x38bdf8, alpha: 0.24, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 78, label: 'DROPZONE', tint: 0x0e1820,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #79 — Armistice Line ───────────────────────────────────────
// Two symmetric halves mirrored N/S, divided by a broken no-man's-land void strip.
function generateArchetype79(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2      = ZONE_HALF_W;
  const H       = 12;
  const MID     = Math.round(H / 2);
  const VOID_H  = 2;

  // South half
  for (let dy = 0; dy < MID - VOID_H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // North half (mirrored)
  for (let dy = MID; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 2 crossing points through the void
  const crossA = -W2 + 2 + Math.round(rng() * (W2 - 2));
  const crossB =  W2 - 2 - Math.round(rng() * (W2 - 2));
  for (const cDx of [crossA, crossB]) {
    for (let dy = MID - VOID_H; dy < MID; dy++) {
      pushTile(tiles, cDx, dy, 7);
    }
    const cp = zoneTile(cDx, MID - 1);
    if (!isHubTile(cp.tx, cp.ty)) {
      glows.push({ tx: cp.tx, ty: cp.ty, color: 0xfbbf24, alpha: 0.2, radius: 10 });
    }
  }

  // Barricades on each half facing the void
  for (let dx = -W2; dx <= W2; dx++) {
    if (dx !== crossA && dx !== crossB) {
      pushStructure(structures, dx, MID - VOID_H - 1, 21, 0x101010, 4);
      pushStructure(structures, dx, MID, 21, 0x101010, 4);
    }
  }

  return {
    seed, archetypeId: 79, label: 'ARMISTICE LINE', tint: 0x101010,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CATEGORY E — SURREAL / ABSTRACT (archetypes 80–99)
// ══════════════════════════════════════════════════════════════════════════

// ── Archetype #80 — Concentric Squares ────────────────────────────────────
// 4 nested square rings, each 1 tile thick, seeded gap passage per ring.
function generateArchetype80(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const RINGS = 4;
  const GAP   = 1;

  for (let ring = 0; ring < RINGS; ring++) {
    const r  = (RINGS - ring) * 2 + GAP * ring;
    // Fill ring band
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const inner = r - 1;
        if (Math.abs(dx) <= inner && Math.abs(dy) <= inner) continue;
        pushTile(tiles, dx, dy + r, rng() < 0.72 ? 0 : 1);
      }
    }
    // Seeded gap on one wall face
    const face  = Math.floor(rng() * 4); // 0=S 1=N 2=E 3=W
    const gapAt = Math.round((rng() - 0.5) * (r - 2));
    for (let pass = -1; pass <= 1; pass++) {
      if (face === 0) pushTile(tiles, gapAt + pass, 0,       7);
      if (face === 1) pushTile(tiles, gapAt + pass, r * 2,   7);
      if (face === 2) pushTile(tiles, r,  r + gapAt + pass,  7);
      if (face === 3) pushTile(tiles, -r, r + gapAt + pass,  7);
    }
    // Ring colour glow
    const ringColors = [0x9060ff, 0x4080ff, 0x22d3ee, 0x4ade80];
    const rp = zoneTile(0, r);
    if (!isHubTile(rp.tx, rp.ty)) {
      glows.push({ tx: rp.tx, ty: rp.ty, color: ringColors[ring % 4], alpha: 0.14, radius: r * 6 });
    }
  }

  return {
    seed, archetypeId: 80, label: 'CONCENTRIC SQUARES', tint: 0x080810,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #81 — Fractal Cross ─────────────────────────────────────────
// Plus-sign base, each arm has a smaller plus at its tip (one level of recursion).
function generateArchetype81(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  function placePlus(cx: number, cy: number, arm: number, thick: number): void {
    // Horizontal bar
    for (let dx = -arm; dx <= arm; dx++) {
      for (let t = -thick; t <= thick; t++) {
        pushTile(tiles, cx + dx, cy + t, rng() < 0.72 ? 0 : 1);
      }
    }
    // Vertical bar
    for (let dy = -arm; dy <= arm; dy++) {
      for (let t = -thick; t <= thick; t++) {
        pushTile(tiles, cx + t, cy + dy, rng() < 0.72 ? 0 : 1);
      }
    }
  }

  const CY = 7;
  // Primary plus
  placePlus(0, CY, 5, 1);

  // Mini plus at each arm tip
  for (const [tx, ty] of [[0, CY - 5], [0, CY + 5], [-5, CY], [5, CY]]) {
    placePlus(tx, ty, 2, 0);
    const gp = zoneTile(tx, ty);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0xa78bfa, alpha: 0.2, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 81, label: 'FRACTAL CROSS', tint: 0x0c0814,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #82 — Spiral Path ───────────────────────────────────────────
// Single 2-tile-wide spiral coiling inward from south to a central node.
function generateArchetype82(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H   = 12;
  const CX  = 0;
  const CY  = Math.round(H * 0.55);
  const TURNS = 2.5;
  const STEPS = 120;

  for (let s = 0; s < STEPS; s++) {
    const t     = s / STEPS;
    const angle = t * Math.PI * 2 * TURNS;
    const r     = (1 - t) * 7;
    const sx    = Math.round(CX + Math.cos(angle) * r);
    const sy    = Math.round(CY + Math.sin(angle) * r);
    pushTile(tiles, sx,     sy,     rng() < 0.72 ? 0 : 1);
    pushTile(tiles, sx + 1, sy,     rng() < 0.72 ? 0 : 1);
    pushTile(tiles, sx,     sy + 1, rng() < 0.72 ? 0 : 1);
    if (s % 20 === 0) {
      const gp = zoneTile(sx, sy);
      if (!isHubTile(gp.tx, gp.ty)) {
        glows.push({ tx: gp.tx, ty: gp.ty, color: 0x38bdf8, alpha: 0.16, radius: 10 });
      }
    }
  }

  // Central node
  pushStructure(structures, CX, CY, 14, 0x080c14, 6);
  const cp = zoneTile(CX, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0x38bdf8, alpha: 0.3, radius: 16 });
  }

  return {
    seed, archetypeId: 82, label: 'SPIRAL PATH', tint: 0x080c14,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #83 — Checkerboard ──────────────────────────────────────────
// Perfect alternating void/walkable grid, each walkable cell 2×2.
function generateArchetype83(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const CELL = 2;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const col = Math.floor((dx + W2) / CELL);
      const row = Math.floor(dy / CELL);
      if ((col + row) % 2 === 0) continue; // void cell
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Glow every other walkable cell
  for (let row = 0; row * CELL < H; row++) {
    for (let col = 0; col * CELL <= W2 * 2; col++) {
      if ((col + row) % 2 === 0) continue;
      if ((col + row) % 4 !== 1) continue;
      const gdx = col * CELL - W2;
      const gdy = row * CELL;
      const gp  = zoneTile(gdx, gdy);
      if (!isHubTile(gp.tx, gp.ty)) {
        glows.push({ tx: gp.tx, ty: gp.ty, color: 0x9060ff, alpha: 0.14, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 83, label: 'CHECKERBOARD', tint: 0x0a0812,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #84 — Sine Wave Field ───────────────────────────────────────
// Full rect, sine-wave wall structures rippling across at 3 frequencies.
function generateArchetype84(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;

  // Ground
  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.73 ? 0 : 1);
    }
  }

  // 3 sine waves as wall rows, seeded phase and frequency
  const waves = [
    { freq: 0.6 + rng() * 0.4, phase: rng() * Math.PI * 2, dy: 3 },
    { freq: 0.4 + rng() * 0.3, phase: rng() * Math.PI * 2, dy: 6 },
    { freq: 0.8 + rng() * 0.5, phase: rng() * Math.PI * 2, dy: 9 },
  ];
  for (const w of waves) {
    for (let dx = -W2; dx <= W2; dx++) {
      const offset = Math.round(Math.sin(dx * w.freq + w.phase) * 1.5);
      pushStructure(structures, dx, w.dy + offset, 21, 0x10101a, 4);
    }
    // Gap in each wave
    const gapDx = Math.round((rng() * 2 - 1) * (W2 - 2));
    // Overwrite gap with walkable tile
    const offset = Math.round(Math.sin(gapDx * w.freq + w.phase) * 1.5);
    pushTile(tiles, gapDx, w.dy + offset, 7);
    pushTile(tiles, gapDx + 1, w.dy + offset, 7);
  }

  return {
    seed, archetypeId: 84, label: 'SINE WAVE FIELD', tint: 0x10101a,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #85 — Diamond Grid ──────────────────────────────────────────
// Walkable diamonds (rotated squares) on a grid, void between them.
function generateArchetype85(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2   = ZONE_HALF_W;
  const H    = 12;
  const STEP = 4; // spacing between diamond centres
  const R    = 2; // diamond radius (L1 norm)

  for (let cy = R; cy < H - R; cy += STEP) {
    for (let cx = -W2 + R; cx <= W2 - R; cx += STEP) {
      for (let dy = cy - R; dy <= cy + R; dy++) {
        for (let dx = cx - R; dx <= cx + R; dx++) {
          if (Math.abs(dx - cx) + Math.abs(dy - cy) > R) continue;
          pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
        }
      }
      const gp = zoneTile(cx, cy);
      if (!isHubTile(gp.tx, gp.ty) && rng() < 0.5) {
        glows.push({ tx: gp.tx, ty: gp.ty, color: 0xf43f5e, alpha: 0.18, radius: 10 });
      }
    }
  }

  return {
    seed, archetypeId: 85, label: 'DIAMOND GRID', tint: 0x140810,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #86 — Mirrored Void ─────────────────────────────────────────
// Left half and right half are perfect mirrors. Void down the centre axis.
function generateArchetype86(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2  = ZONE_HALF_W;
  const H   = 12;
  const GAP = 1; // void tiles either side of centre

  for (let dy = 0; dy < H; dy++) {
    for (let dx = GAP + 1; dx <= W2; dx++) {
      const frame = rng() < 0.73 ? 0 : 1;
      // Place on right half, mirror to left half
      pushTile(tiles,  dx, dy, frame);
      pushTile(tiles, -dx, dy, frame);
    }
  }

  // Occasional structure on right, mirrored left
  for (let dy = 2; dy < H - 2; dy += 3) {
    const sdx = GAP + 2 + Math.floor(rng() * (W2 - GAP - 3));
    pushStructure(structures,  sdx, dy, 14, 0x10080e, 5);
    pushStructure(structures, -sdx, dy, 14, 0x10080e, 5);
  }

  // Centre void glow
  const gp = zoneTile(0, Math.round(H / 2));
  if (!isHubTile(gp.tx, gp.ty)) {
    glows.push({ tx: gp.tx, ty: gp.ty, color: 0xf43f5e, alpha: 0.18, radius: 20 });
  }

  return {
    seed, archetypeId: 86, label: 'MIRRORED VOID', tint: 0x10080e,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #87 — Noise Scatter ─────────────────────────────────────────
// Pure LCG noise: each tile independently included at 65% probability.
// No shapes, no patterns — raw stochastic terrain.
function generateArchetype87(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      if (rng() > 0.65) continue;
      pushTile(tiles, dx, dy, rng() < 0.7 ? 0 : 1);
    }
  }

  // Entry corridor guaranteed passable — 3 wide from south
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      pushTile(tiles, dx, dy, 0);
    }
  }

  return {
    seed, archetypeId: 87, label: 'NOISE SCATTER', tint: 0x0c0c0c,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #88 — Rotational Symmetry ───────────────────────────────────
// One quadrant generated, then rotated 3× to fill all four quadrants.
function generateArchetype88(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R  = 6;
  const CY = R;

  // Generate one quadrant (dx 0..R, dy CY..CY+R)
  const quadrant: Array<[number, number, number]> = [];
  for (let dy = 0; dy <= R; dy++) {
    for (let dx = 0; dx <= R; dx++) {
      if (rng() < 0.6) {
        quadrant.push([dx, dy, rng() < 0.72 ? 0 : 1]);
      }
    }
  }

  // Rotate 4 times
  for (const [dx, dy, frame] of quadrant) {
    pushTile(tiles,  dx,         CY + dy,  frame);
    pushTile(tiles, -dy,         CY + dx,  frame);
    pushTile(tiles, -dx,         CY - dy,  frame);
    pushTile(tiles,  dy,         CY - dx,  frame);
  }

  // Guaranteed entry
  for (let dy = 0; dy <= 1; dy++) {
    pushTile(tiles, 0, dy, 0);
  }

  // Centre glow
  const cp = zoneTile(0, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0xa78bfa, alpha: 0.22, radius: 18 });
  }

  return {
    seed, archetypeId: 88, label: 'ROTATIONAL SYMMETRY', tint: 0x0c0814,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #89 — Interference Pattern ─────────────────────────────────
// Tiles placed where two overlapping sine waves constructively interfere.
function generateArchetype89(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2  = ZONE_HALF_W;
  const H   = 12;
  const f1x = 0.5 + rng() * 0.4;
  const f1y = 0.4 + rng() * 0.3;
  const f2x = 0.7 + rng() * 0.5;
  const f2y = 0.3 + rng() * 0.4;
  const THRESHOLD = 0.25;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const v1 = Math.sin(dx * f1x + dy * f1y);
      const v2 = Math.sin(dx * f2x - dy * f2y);
      if (v1 + v2 < THRESHOLD) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Guaranteed entry column
  for (let dy = 0; dy <= 2; dy++) {
    pushTile(tiles, 0, dy, 0);
    pushTile(tiles, 1, dy, 0);
  }

  return {
    seed, archetypeId: 89, label: 'INTERFERENCE PATTERN', tint: 0x080c10,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #90 — Cellular Growth ──────────────────────────────────────
// Simulated cellular automaton (5 steps from random seed), organic islands.
function generateArchetype90(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;
  const W  = W2 * 2 + 1;

  // Initialise grid — 48% alive
  let grid: boolean[][] = [];
  for (let dy = 0; dy < H; dy++) {
    grid[dy] = [];
    for (let dx = 0; dx < W; dx++) {
      grid[dy][dx] = rng() < 0.48;
    }
  }

  // 4 CA steps: birth if ≥5 neighbours, survive if ≥4
  for (let step = 0; step < 4; step++) {
    const next: boolean[][] = [];
    for (let dy = 0; dy < H; dy++) {
      next[dy] = [];
      for (let dx = 0; dx < W; dx++) {
        let neighbours = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const ny = dy + oy; const nx = dx + ox;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W) { neighbours++; continue; }
            if (grid[ny][nx]) neighbours++;
          }
        }
        next[dy][dx] = grid[dy][dx] ? neighbours >= 4 : neighbours >= 5;
      }
    }
    grid = next;
  }

  // Convert to tiles
  for (let dy = 0; dy < H; dy++) {
    for (let dx = 0; dx < W; dx++) {
      if (!grid[dy][dx]) continue;
      pushTile(tiles, dx - W2, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Guarantee entry
  for (let dy = 0; dy <= 2; dy++) {
    pushTile(tiles, 0, dy, 0);
    pushTile(tiles, 1, dy, 0);
  }

  return {
    seed, archetypeId: 90, label: 'CELLULAR GROWTH', tint: 0x0a100a,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #91 — Penrose Tiles ────────────────────────────────────────
// Approximated quasi-crystal: 5-fold radial sector pattern, non-repeating feel.
function generateArchetype91(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H  = 12;
  const CY = 6;
  const R  = 7;

  // 5-fold sectors: alternating thick/thin rhombs approximated as wedge strips
  const SECTORS = 5;
  for (let s = 0; s < SECTORS; s++) {
    const a0 = (s / SECTORS) * Math.PI * 2;
    const a1 = ((s + 0.55) / SECTORS) * Math.PI * 2; // thick rhomb width

    for (let r = 1; r <= R; r++) {
      // Walk arc from a0 to a1 at radius r
      const steps = Math.max(2, Math.round(r * (a1 - a0) * 2));
      for (let step = 0; step <= steps; step++) {
        const angle = a0 + (a1 - a0) * (step / steps);
        const dx = Math.round(Math.cos(angle) * r);
        const dy = Math.round(CY + Math.sin(angle) * r);
        pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
      }
    }
  }

  // Spokes between sectors
  for (let s = 0; s < SECTORS; s++) {
    const spoke = ((s + 0.5) / SECTORS) * Math.PI * 2;
    for (let r = 1; r <= R; r++) {
      const dx = Math.round(Math.cos(spoke) * r);
      const dy = Math.round(CY + Math.sin(spoke) * r);
      pushTile(tiles, dx, dy, 7);
    }
  }

  // Centre
  pushTile(tiles, 0, CY, 0);
  const cp = zoneTile(0, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0xfbbf24, alpha: 0.2, radius: 16 });
  }

  return {
    seed, archetypeId: 91, label: 'PENROSE TILES', tint: 0x10100a,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #92 — Void Archipelago ─────────────────────────────────────
// Islands of walkable tiles in a sea of void — 6–8 seeded blob islands.
function generateArchetype92(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2         = ZONE_HALF_W;
  const H          = 12;
  const ISLAND_CNT = 6 + Math.floor(rng() * 3);

  // Generate island centres
  const islands: Array<{ dx: number; dy: number; r: number }> = [];
  islands.push({ dx: 0, dy: 0, r: 2 }); // entry island always at south
  for (let i = 1; i < ISLAND_CNT; i++) {
    islands.push({
      dx: Math.round((rng() * 2 - 1) * (W2 - 2)),
      dy: 1 + Math.round(rng() * (H - 2)),
      r:  1 + Math.floor(rng() * 3),
    });
  }

  for (const isl of islands) {
    for (let dy = isl.dy - isl.r; dy <= isl.dy + isl.r; dy++) {
      for (let dx = isl.dx - isl.r; dx <= isl.dx + isl.r; dx++) {
        const nx = (dx - isl.dx) / isl.r;
        const ny = (dy - isl.dy) / isl.r;
        if (nx * nx + ny * ny > 1 + (rng() - 0.5) * 0.2) continue;
        pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
      }
    }
    // Bridge to next island
    if (islands.indexOf(isl) < islands.length - 1) {
      const next = islands[islands.indexOf(isl) + 1];
      const steps = Math.max(Math.abs(next.dx - isl.dx), Math.abs(next.dy - isl.dy));
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        pushTile(tiles, Math.round(isl.dx + (next.dx - isl.dx) * t),
                        Math.round(isl.dy + (next.dy - isl.dy) * t), 7);
      }
    }
    const gp = zoneTile(isl.dx, isl.dy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0x38bdf8, alpha: 0.18, radius: isl.r * 8 });
    }
  }

  return {
    seed, archetypeId: 92, label: 'VOID ARCHIPELAGO', tint: 0x08080e,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #93 — Recursive Rooms ──────────────────────────────────────
// Large room contains a medium room which contains a small room. Each ring walkable.
function generateArchetype93(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const rooms = [
    { w: ZONE_HALF_W * 2, h: 12 },
    { w: 12,              h: 8  },
    { w: 6,               h: 4  },
  ];
  const CY = 6;
  const ROOM_COLORS = [0x4080ff, 0x9060ff, 0xf43f5e];

  for (let ri = 0; ri < rooms.length; ri++) {
    const { w, h } = rooms[ri];
    const hw = Math.floor(w / 2); const hh = Math.floor(h / 2);
    const inner = ri < rooms.length - 1 ? rooms[ri + 1] : null;

    for (let dy = CY - hh; dy <= CY + hh; dy++) {
      for (let dx = -hw; dx <= hw; dx++) {
        if (inner) {
          const ihw = Math.floor(inner.w / 2);
          const ihh = Math.floor(inner.h / 2);
          if (Math.abs(dx) < ihw && Math.abs(dy - CY) < ihh) continue; // inner room void
        }
        pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
      }
    }

    // Doorway on south wall
    if (ri > 0) {
      const hw2 = Math.floor(rooms[ri].w / 2);
      const doorY = CY + Math.floor(rooms[ri].h / 2);
      pushTile(tiles, 0,  doorY, 7);
      pushTile(tiles, -1, doorY, 7);
    }

    const gp = zoneTile(0, CY);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: ROOM_COLORS[ri], alpha: 0.14, radius: Math.floor(rooms[ri].w / 2) * 6 });
    }
  }

  return {
    seed, archetypeId: 93, label: 'RECURSIVE ROOMS', tint: 0x0c0c12,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #94 — Phase Shift ───────────────────────────────────────────
// Zone tiles divided by a seeded horizontal cut; each half tinted differently.
function generateArchetype94(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2  = ZONE_HALF_W;
  const H   = 12;
  const CUT = 4 + Math.floor(rng() * 5); // cut line varies dy 4–8

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      // Two distinct tile frames per phase
      pushTile(tiles, dx, dy, dy < CUT ? 0 : 7);
    }
  }

  // Crossing structures at the cut line — like phase boundary markers
  for (let dx = -W2; dx <= W2; dx += 3) {
    pushStructure(structures, dx, CUT, 14, 0x12101a, 5);
    const pp = zoneTile(dx, CUT);
    if (!isHubTile(pp.tx, pp.ty)) {
      glows.push({ tx: pp.tx, ty: pp.ty, color: rng() < 0.5 ? 0x4080ff : 0x9060ff, alpha: 0.18, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 94, label: 'PHASE SHIFT', tint: 0x12101a,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #95 — Gravity Well ──────────────────────────────────────────
// Tiles get denser toward the centre — probability of inclusion rises with proximity.
function generateArchetype95(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = 12;
  const CY = Math.round(H * 0.6);

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      const nx = dx / W2; const ny = (dy - CY) / (H / 2);
      const d  = Math.sqrt(nx * nx + ny * ny);
      // Density increases toward centre: from 0.3 at edge to 0.95 at centre
      const prob = 0.3 + (1 - Math.min(d, 1)) * 0.65;
      if (rng() > prob) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Central singularity structure
  pushStructure(structures, 0, CY, 35, 0x0a0810, 7);
  const cp = zoneTile(0, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0x9060ff, alpha: 0.3, radius: 20 });
  }

  return {
    seed, archetypeId: 95, label: 'GRAVITY WELL', tint: 0x0a0810,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #96 — Tesseract Projection ─────────────────────────────────
// Hypercube projected to 2D: outer square, inner smaller square, 4 corner lines.
function generateArchetype96(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const H   = 12;
  const CY  = 6;
  const R1  = 6;   // outer square half-size
  const R2  = 3;   // inner square half-size

  // Outer square ring
  for (let dx = -R1; dx <= R1; dx++) {
    pushTile(tiles,  dx,      CY - R1, 7);
    pushTile(tiles,  dx,      CY + R1, 7);
  }
  for (let dy = CY - R1; dy <= CY + R1; dy++) {
    pushTile(tiles,  R1, dy, 7);
    pushTile(tiles, -R1, dy, 7);
  }

  // Inner square ring
  for (let dx = -R2; dx <= R2; dx++) {
    pushTile(tiles,  dx,      CY - R2, 0);
    pushTile(tiles,  dx,      CY + R2, 0);
  }
  for (let dy = CY - R2; dy <= CY + R2; dy++) {
    pushTile(tiles,  R2, dy, 0);
    pushTile(tiles, -R2, dy, 0);
  }

  // 4 corner connecting lines
  for (const [x1, y1, x2, y2] of [
    [-R1, CY - R1, -R2, CY - R2],
    [ R1, CY - R1,  R2, CY - R2],
    [-R1, CY + R1, -R2, CY + R2],
    [ R1, CY + R1,  R2, CY + R2],
  ]) {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      pushTile(tiles, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), 7);
    }
  }

  // Glows at inner corners
  for (const [gdx, gdy] of [[-R2, CY - R2], [R2, CY - R2], [-R2, CY + R2], [R2, CY + R2]]) {
    const gp = zoneTile(gdx, gdy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0x38bdf8, alpha: 0.22, radius: 10 });
    }
  }

  return {
    seed, archetypeId: 96, label: 'TESSERACT PROJECTION', tint: 0x06080e,
    enemyFlavour: 'wanderers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #97 — Event Horizon ────────────────────────────────────────
// Dense outer ring, sparse middle, void singularity centre. Pull topology.
function generateArchetype97(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const R  = 7;
  const CY = R;

  for (let dy = 0; dy <= R * 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + (dy - CY) * (dy - CY);
      const d  = Math.sqrt(d2);
      if (d > R) continue;
      if (d < 1.5) continue; // singularity void at centre

      // Density by zone: dense outer ring, sparse middle, near-void inner
      let prob: number;
      if (d > R - 2)      prob = 0.92;
      else if (d > R - 4) prob = 0.55;
      else                prob = 0.25;

      if (rng() > prob) continue;
      pushTile(tiles, dx, dy, rng() < 0.72 ? 0 : 1);
    }
  }

  // Radial access spokes (4) through sparse middle
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    for (let r = 2; r <= R - 2; r++) {
      const sdx = Math.round(Math.cos(angle) * r);
      const sdy = Math.round(CY + Math.sin(angle) * r);
      pushTile(tiles, sdx, sdy, 7);
    }
  }

  const cp = zoneTile(0, CY);
  if (!isHubTile(cp.tx, cp.ty)) {
    glows.push({ tx: cp.tx, ty: cp.ty, color: 0x9060ff, alpha: 0.35, radius: 24 });
  }

  return {
    seed, archetypeId: 97, label: 'EVENT HORIZON', tint: 0x060408,
    enemyFlavour: 'ring-walkers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #98 — Static Collapse ──────────────────────────────────────
// High-frequency noise at 80% — near-solid with random holes. Claustrophobic.
function generateArchetype98(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      if (rng() < 0.80) {
        pushTile(tiles, dx, dy, rng() < 0.65 ? 0 : 1);
      }
    }
  }

  // Guaranteed passable entry shaft
  for (let dy = 0; dy <= 3; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      pushTile(tiles, dx, dy, 0);
    }
  }

  // Scatter faint glows into the density
  for (let i = 0; i < 6; i++) {
    const gdx = Math.round((rng() * 2 - 1) * (W2 - 1));
    const gdy = 2 + Math.round(rng() * (H - 3));
    const gp  = zoneTile(gdx, gdy);
    if (!isHubTile(gp.tx, gp.ty)) {
      glows.push({ tx: gp.tx, ty: gp.ty, color: 0xfbbf24, alpha: 0.12, radius: 12 });
    }
  }

  return {
    seed, archetypeId: 98, label: 'STATIC COLLAPSE', tint: 0x0c0c08,
    enemyFlavour: 'scavengers', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Archetype #99 — The Null Zone ─────────────────────────────────────────
// A perfectly empty maximum rectangle. No structures, no glows.
// The contrast zone — players expect complexity, find pure open dread.
function generateArchetype99(seed: number): ZoneSpec {
  const rng = makeLcg(seed);
  const tiles: ZoneTile[] = [];
  const structures: ZoneStructure[] = [];
  const glows: ZoneGlow[] = [];

  const W2 = ZONE_HALF_W;
  const H  = ZONE_DEPTH;

  for (let dy = 0; dy < H; dy++) {
    for (let dx = -W2; dx <= W2; dx++) {
      pushTile(tiles, dx, dy, rng() < 0.5 ? 0 : 7);
    }
  }

  return {
    seed, archetypeId: 99, label: 'THE NULL ZONE', tint: 0x060606,
    enemyFlavour: 'sentinels', tiles, structures, glows,
    entryTile: zoneTile(0, 0),
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const ARCHETYPE_GENERATORS: Array<(seed: number) => ZoneSpec> = [
  generateArchetype0,  generateArchetype1,  generateArchetype2,  generateArchetype3,
  generateArchetype4,  generateArchetype5,  generateArchetype6,  generateArchetype7,
  generateArchetype8,  generateArchetype9,  generateArchetype10, generateArchetype11,
  generateArchetype12, generateArchetype13, generateArchetype14, generateArchetype15,
  generateArchetype16, generateArchetype17, generateArchetype18, generateArchetype19,
  generateArchetype20, generateArchetype21, generateArchetype22, generateArchetype23,
  generateArchetype24, generateArchetype25, generateArchetype26, generateArchetype27,
  generateArchetype28, generateArchetype29, generateArchetype30, generateArchetype31,
  generateArchetype32, generateArchetype33, generateArchetype34, generateArchetype35,
  generateArchetype36, generateArchetype37, generateArchetype38, generateArchetype39,
  generateArchetype40, generateArchetype41, generateArchetype42, generateArchetype43,
  generateArchetype44, generateArchetype45, generateArchetype46, generateArchetype47,
  generateArchetype48, generateArchetype49, generateArchetype50, generateArchetype51,
  generateArchetype52, generateArchetype53, generateArchetype54, generateArchetype55,
  generateArchetype56, generateArchetype57, generateArchetype58, generateArchetype59,
  generateArchetype60, generateArchetype61, generateArchetype62, generateArchetype63,
  generateArchetype64, generateArchetype65, generateArchetype66, generateArchetype67,
  generateArchetype68, generateArchetype69, generateArchetype70, generateArchetype71,
  generateArchetype72, generateArchetype73, generateArchetype74, generateArchetype75,
  generateArchetype76, generateArchetype77, generateArchetype78, generateArchetype79,
  generateArchetype80, generateArchetype81, generateArchetype82, generateArchetype83,
  generateArchetype84, generateArchetype85, generateArchetype86, generateArchetype87,
  generateArchetype88, generateArchetype89, generateArchetype90, generateArchetype91,
  generateArchetype92, generateArchetype93, generateArchetype94, generateArchetype95,
  generateArchetype96, generateArchetype97, generateArchetype98, generateArchetype99,
];

// ── ChunkSpec / ChunkGraph types ──────────────────────────────────────────

export interface ChunkConnection {
  edge:      'N' | 'S' | 'E' | 'W';
  bridgeTx:  number;
  bridgeTy:  number;
}

export interface ChunkSpec {
  archetypeId:     number;
  offsetTx:        number;
  offsetTy:        number;
  connections:     ChunkConnection[];
  enemyDensity:    number;
  materialDensity: number;
  isBossChunk:     boolean;
  endpointTile:    { tx: number; ty: number } | null;
}

export interface ChunkGraph {
  seed:   number;
  chunks: ChunkSpec[];
  bounds: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
}

// ── ChunkGraph generator ──────────────────────────────────────────────────

/**
 * Builds a 3-chunk linear chain deterministically from seed.
 * Chunks are stacked northward; each is ZONE_DEPTH tiles tall.
 * Chunk 2 is the boss chunk.
 *
 * Layout (ty decreases northward from EXZONE_ENTRY_TY):
 *   Chunk 0: offsetTy = EXZONE_ENTRY_TY        (ty -3  → -16)
 *   Chunk 1: offsetTy = EXZONE_ENTRY_TY - 14   (ty -17 → -30)
 *   Chunk 2: offsetTy = EXZONE_ENTRY_TY - 28   (ty -31 → -44) — boss
 *
 * A 3-wide corridor bridge connects each chunk to the next at a seeded X offset.
 */
function generateChunkGraph(seed: number): ChunkGraph {
  const rng = makeLcg(seed);

  const CHUNK_COUNT = 3;
  const chunks: ChunkSpec[] = [];

  // Archetypes — pick 3 distinct indices from the 100 available
  const a0 = Math.abs(Math.floor(rng() * ARCHETYPE_GENERATORS.length)) % ARCHETYPE_GENERATORS.length;
  let   a1 = Math.abs(Math.floor(rng() * ARCHETYPE_GENERATORS.length)) % ARCHETYPE_GENERATORS.length;
  let   a2 = Math.abs(Math.floor(rng() * ARCHETYPE_GENERATORS.length)) % ARCHETYPE_GENERATORS.length;
  if (a1 === a0) a1 = (a1 + 1) % ARCHETYPE_GENERATORS.length;
  if (a2 === a0 || a2 === a1) a2 = (a2 + 2) % ARCHETYPE_GENERATORS.length;

  const archetypeIds = [a0, a1, a2];

  for (let c = 0; c < CHUNK_COUNT; c++) {
    const offsetTy = EXZONE_ENTRY_TY - c * ZONE_DEPTH;
    const offsetTx = EXZONE_ENTRY_TX - ZONE_HALF_W;

    const isBoss = c === CHUNK_COUNT - 1;

    // Corridor bridge column: seeded offset within ±(ZONE_HALF_W - 2) of centre
    const corridorDx = Math.round((rng() - 0.5) * (ZONE_HALF_W - 2) * 2);
    const corridorTx = EXZONE_ENTRY_TX + corridorDx;

    const connections: ChunkConnection[] = [];

    // South connection (back toward previous chunk / hub bridge)
    if (c === 0) {
      // First chunk connects to the hub bridge
      connections.push({ edge: 'S', bridgeTx: EXZONE_ENTRY_TX, bridgeTy: EXZONE_ENTRY_TY });
    } else {
      // Connect southward to the previous chunk's north corridor
      const prevCorridorTx = EXZONE_ENTRY_TX + Math.round((rng() - 0.5) * (ZONE_HALF_W - 2) * 2);
      connections.push({ edge: 'S', bridgeTx: prevCorridorTx, bridgeTy: offsetTy + ZONE_DEPTH });
    }

    // North connection (toward next chunk) — not on boss chunk
    if (!isBoss) {
      connections.push({ edge: 'N', bridgeTx: corridorTx, bridgeTy: offsetTy - 1 });
    }

    // endpointTile: boss barrier sits on the north edge of the boss chunk's centre column
    const endpointTile = isBoss
      ? { tx: EXZONE_ENTRY_TX, ty: offsetTy - ZONE_DEPTH + 1 }
      : null;

    chunks.push({
      archetypeId:     archetypeIds[c],
      offsetTx,
      offsetTy,
      connections,
      enemyDensity:    isBoss ? 1.5 : 0.8 + rng() * 0.4,
      materialDensity: 0.5 + rng() * 1.0,
      isBossChunk:     isBoss,
      endpointTile,
    });
  }

  // Bounds: one per chunk — px bounds derived later by WorldScene
  const bounds = chunks.map(c => ({
    minX: c.offsetTx * 16,
    minY: (c.offsetTy - ZONE_DEPTH) * 16,
    maxX: (c.offsetTx + ZONE_HALF_W * 2) * 16,
    maxY: c.offsetTy * 16,
  }));

  return { seed, chunks, bounds };
}

// ── Singleton ─────────────────────────────────────────────────────────────

export class ExplorationZoneManager {
  private static _instance: ExplorationZoneManager | null = null;

  private _cachedSpec:  ZoneSpec | null   = null;
  private _cachedGraph: ChunkGraph | null = null;
  private _cachedSeed = -1;

  // Packed int key → fast O(1) zone membership test in _tickZoneGuard
  private _tileSet = new Set<number>();

  private constructor() {}

  static getInstance(): ExplorationZoneManager {
    if (!ExplorationZoneManager._instance) {
      ExplorationZoneManager._instance = new ExplorationZoneManager();
    }
    return ExplorationZoneManager._instance;
  }

  getDailyZone(): ZoneSpec {
    const seed = Math.floor(Date.now() / 86400000);
    if (this._cachedSeed === seed && this._cachedSpec) return this._cachedSpec;
    return this.generate(seed);
  }

  getDailyChunkGraph(): ChunkGraph {
    const seed = Math.floor(Date.now() / 86400000);
    if (this._cachedSeed === seed && this._cachedGraph) return this._cachedGraph;
    return this.generateGraph(seed);
  }

  generate(seed: number): ZoneSpec {
    const idx  = ((seed >>> 0) % ARCHETYPE_GENERATORS.length + ARCHETYPE_GENERATORS.length) % ARCHETYPE_GENERATORS.length;
    const spec = ARCHETYPE_GENERATORS[idx](seed);
    this._cachedSpec = spec;
    this._cachedSeed = seed;
    this._tileSet.clear();
    for (const t of spec.tiles) {
      this._tileSet.add(this._key(t.tx, t.ty));
    }
    return spec;
  }

  /**
   * Generate a ZoneSpec from a seed without touching the tile set or cache.
   * Used by _spawnChunk so iterating multiple chunks doesn't clobber the tile set.
   */
  generateSpecOnly(seed: number): ZoneSpec {
    const idx = ((seed >>> 0) % ARCHETYPE_GENERATORS.length + ARCHETYPE_GENERATORS.length) % ARCHETYPE_GENERATORS.length;
    return ARCHETYPE_GENERATORS[idx](seed);
  }

  generateGraph(seed: number): ChunkGraph {
    const graph = generateChunkGraph(seed);
    this._cachedGraph = graph;
    this._cachedSeed  = seed;
    // Pre-register bounding tiles for each chunk so isTileInZone works
    // immediately; WorldScene calls registerChunkTiles with exact tiles after render.
    this._tileSet.clear();
    for (let c = 0; c < graph.chunks.length; c++) {
      const chunk = graph.chunks[c];
      const chunkSeed = seed ^ (c * 0x9e3779b9);
      const spec  = ARCHETYPE_GENERATORS[chunk.archetypeId](chunkSeed);
      const dTx   = chunk.offsetTx - EXZONE_ENTRY_TX + ZONE_HALF_W;
      const dTy   = chunk.offsetTy - EXZONE_ENTRY_TY;
      for (const t of spec.tiles) {
        this._tileSet.add(this._key(t.tx + dTx, t.ty + dTy));
      }
    }
    return graph;
  }

  /**
   * Register exact world-tile positions for a rendered chunk.
   * Call after _spawnChunk() so isTileInZone is precise rather than approximate.
   */
  registerChunkTiles(tiles: Array<{ tx: number; ty: number }>): void {
    for (const t of tiles) {
      this._tileSet.add(this._key(t.tx, t.ty));
    }
  }

  isTileInZone(tx: number, ty: number): boolean {
    return this._tileSet.has(this._key(tx, ty));
  }

  // Uses same encoding as TileWorld._exTileKey: (ty+700)*2048 + (tx+200)
  private _key(tx: number, ty: number): number {
    return (ty + 700) * 2048 + (tx + 200);
  }
}

// ── ROOM_CATALOGUE ────────────────────────────────────────────────────────
//
// All rooms are in LOCAL tile space: (0,0) = NW corner of the room bounding box.
// Connection slots sit exactly on the room edge.
//   North edge: ty = 0
//   South edge: ty = size.h - 1
//   East edge:  tx = size.w - 1
//   West edge:  tx = 0
//
// Tile frames reference the 7×8 moon-tiles atlas (same sheet used by hub).
// Frame 0 = standard ground. Frame 7 = corridor. Frames 14–15, 21–22, 28–29 = structures.
//
// All sizes are multiples of 4. Entry room has a south connection, boss room has a south
// connection only (convergence assembler will use north later).
//
// Act 2 — Upper Bunkers / Barracks Block — region type: bunker-corridor

const TINT_BUNKER_FLOOR: number     = 0x141414;
const TINT_BUNKER_WALL: number      = 0x1e1e28;
const TINT_BUNKER_DETAIL: number    = 0x2a2040;

export const ROOM_CATALOGUE: RoomDef[] = [

  // ── bunker-entry ────────────────────────────────────────────────────────
  // 8×8. Entry room. South connection only (connects up to hub portal bridge).
  // Open rectangular floor with a doorway arch on the south edge.
  {
    id: 'bunker-entry',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'entry',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 4, ty: 7 },
      { id: 'north-0', edge: 'N', tx: 4, ty: 0 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 8; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // West wall
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 1, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 2, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 3, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 4, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 5, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // East wall
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 1, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 2, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 3, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 4, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Desk detail (interactive feel)
      { tx: 2, ty: 1, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 5, ty: 1, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 3, ty: 4, type: 'enemy' },
      { id: 'e1', tx: 5, ty: 5, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-corridor-straight ────────────────────────────────────────────
  // 4×12. Pure north-south corridor. Simplest connector.
  {
    id: 'bunker-corridor-straight',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'connector',
    size: { w: 4, h: 12 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 2, ty: 11 },
      { id: 'north-0', edge: 'N', tx: 2, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 12; ty++)
        for (let tx = 0; tx < 4; tx++)
          t.push({ tx, ty, frame: 7 });
      return t;
    })(),
    structures: [
      // Wall rails on each long side, every other tile — glow rail aesthetic
      { tx: 0, ty: 2,  frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 4,  frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 6,  frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 8,  frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 3,  frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 5,  frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 7,  frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 9,  frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 5,  type: 'enemy' },
      { id: 'e1', tx: 1, ty: 9,  type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-corridor-turn-NE ─────────────────────────────────────────────
  // 8×8. Enters from south, exits east. L-bend.
  {
    id: 'bunker-corridor-turn-NE',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'connector',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 2, ty: 7 },
      { id: 'east-0',  edge: 'E', tx: 7, ty: 2 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      // Vertical leg: columns 0–3, rows 0–7
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 4; tx++)
          t.push({ tx, ty, frame: 7 });
      // Horizontal leg: columns 4–7, rows 0–3 (minus overlap already covered)
      for (let ty = 0; ty < 4; ty++)
        for (let tx = 4; tx < 8; tx++)
          t.push({ tx, ty, frame: 7 });
      return t;
    })(),
    structures: [
      { tx: 0, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 5, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 6, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty: 0, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 3, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 1, ty: 4, type: 'enemy' },
      { id: 'e1', tx: 5, ty: 1, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-corridor-turn-NW ─────────────────────────────────────────────
  // 8×8. Enters from south, exits west.
  {
    id: 'bunker-corridor-turn-NW',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'connector',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 5, ty: 7 },
      { id: 'west-0',  edge: 'W', tx: 0, ty: 2 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      // Vertical leg: columns 4–7, rows 0–7
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 4; tx < 8; tx++)
          t.push({ tx, ty, frame: 7 });
      // Horizontal leg: columns 0–3, rows 0–3
      for (let ty = 0; ty < 4; ty++)
        for (let tx = 0; tx < 4; tx++)
          t.push({ tx, ty, frame: 7 });
      return t;
    })(),
    structures: [
      { tx: 7, ty: 2, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 6, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 3, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 6, ty: 4, type: 'enemy' },
      { id: 'e1', tx: 2, ty: 1, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-corridor-junction ────────────────────────────────────────────
  // 8×8. Three-way — south in, north and east out.
  {
    id: 'bunker-corridor-junction',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'standard',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 2, ty: 7 },
      { id: 'north-0', edge: 'N', tx: 2, ty: 0 },
      { id: 'east-0',  edge: 'E', tx: 7, ty: 4 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      // Full left column block: cols 0–4, all rows
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 5; tx++)
          t.push({ tx, ty, frame: 7 });
      // East branch: cols 5–7, rows 2–5
      for (let ty = 2; ty < 6; ty++)
        for (let tx = 5; tx < 8; tx++)
          t.push({ tx, ty, frame: 7 });
      return t;
    })(),
    structures: [
      { tx: 0, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 5, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 1, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 4, ty: 6, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 6, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 5, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 3, type: 'enemy' },
      { id: 'e1', tx: 2, ty: 6, type: 'enemy' },
      { id: 'e2', tx: 6, ty: 4, type: 'enemy' },
      { id: 'm0', tx: 1, ty: 1, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-room-small ───────────────────────────────────────────────────
  // 8×8. Dead-end room. South connection only. Rewards exploration.
  {
    id: 'bunker-room-small',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'dead-end',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 4, ty: 7 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 8; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Crate cluster detail
      { tx: 2, ty: 2, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 3, ty: 2, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 5, ty: 3, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [
      // North-wall tile can vary between frame 21 and frame 35 (adds graffiti variant)
      { tx: 3, ty: 0, frames: [21, 35] },
    ],
    spawn_markers: [
      { id: 'e0', tx: 4, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 6, ty: 5, type: 'enemy' },
      { id: 'l0', tx: 3, ty: 4, type: 'loot'  },
      { id: 'm0', tx: 6, ty: 2, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-room-medium ──────────────────────────────────────────────────
  // 12×8. Standard combat room. South + east connections.
  {
    id: 'bunker-room-medium',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'standard',
    size: { w: 12, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6,  ty: 7 },
      { id: 'east-0',  edge: 'E', tx: 11, ty: 4 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 12; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // Central dividing wall with gap — forces routing
      { tx: 4, ty: 2, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 3, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 5, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 6, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Equipment on east side
      { tx: 8,  ty: 1, frame: 7, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 9,  ty: 1, frame: 7, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 10, ty: 1, frame: 7, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 10, ty: 6, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [
      { tx: 4, ty: 4, frames: [0, 7] },  // gap in wall — open or blocked variant
    ],
    spawn_markers: [
      { id: 'e0', tx: 2,  ty: 4, type: 'enemy' },
      { id: 'e1', tx: 2,  ty: 6, type: 'enemy' },
      { id: 'e2', tx: 8,  ty: 4, type: 'enemy' },
      { id: 'e3', tx: 10, ty: 5, type: 'enemy' },
      { id: 'l0', tx: 9,  ty: 6, type: 'loot'  },
      { id: 'm0', tx: 1,  ty: 1, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-boss-antechamber ─────────────────────────────────────────────
  // 12×12. Boss lead-in. South connection only. High enemy density. Boss barrier
  // will be placed by WorldScene at the north connection slot world tile.
  {
    id: 'bunker-boss-antechamber',
    zone_act: 2,
    region_types: ['bunker-corridor'],
    type: 'boss',
    size: { w: 12, h: 12 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 11 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 12; ty++)
        for (let tx = 0; tx < 12; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // Outer wall ring — north and sides only (south is entry)
      // North wall
      { tx: 0, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty:  0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty:  0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty:  0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 8, ty:  0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 9, ty:  0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Corner pillars
      { tx: 0,  ty: 4, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0,  ty: 8, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 4, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 8, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Centre altar — blocked, imposing
      { tx: 5, ty: 4, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 6, ty: 4, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 5, ty: 5, frame: 35, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 6, ty: 5, frame: 36, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2,  ty: 2,  type: 'enemy' },
      { id: 'e1', tx: 9,  ty: 2,  type: 'enemy' },
      { id: 'e2', tx: 2,  ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 9,  ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 2,  ty: 10, type: 'enemy' },
      { id: 'e5', tx: 9,  ty: 10, type: 'enemy' },
      { id: 'l0', tx: 5,  ty: 9,  type: 'loot'  },
      { id: 'l1', tx: 7,  ty: 9,  type: 'loot'  },
    ],
    min_room_tier: 1,
  },

];  // end ROOM_CATALOGUE

// ── REGION_REGISTRY ───────────────────────────────────────────────────────

export const REGION_REGISTRY: RegionDef[] = [
  {
    id:             'bunker-corridor',
    label:          'Bunker Corridor',
    zone_acts:      [2],
    layout:         'spine',
    room_count_min: 3,
    room_count_max: 5,
    corridor_min:   2,
    corridor_max:   6,
    tint:           TINT_BUNKER_FLOOR,
  },
];

// ── ZONE_LIBRARY ──────────────────────────────────────────────────────────

export const ZONE_LIBRARY: ZoneDef[] = [
  {
    id:            'barracks-block',
    label:         'Barracks Block',
    zone_act:      2,
    region_defs:   [REGION_REGISTRY.find(r => r.id === 'bunker-corridor')!],
    enemy_flavour: 'sentinels',
    tint:          TINT_BUNKER_FLOOR,
  },
];

// ── Spine layout assembler ────────────────────────────────────────────────
//
// Assembles a linear north-going room chain for a region using 'spine' layout.
//
// Geometry:
//   - entryTy is the world ty of the first room's south connection tile
//     (for the first region this is EXZONE_ENTRY_TY; for subsequent regions
//     it's the exit of the prior region).
//   - Each room is placed so its south connection slot aligns to entryTy.
//   - A corridor of corridorLen tiles links each room's north slot to the
//     next room's south slot (with corridorLen drawn from [corridor_min..corridor_max]).
//   - entryTx is the world tx that the south connection slot lands on.
//
// Returns a RegionInstance with all world offsets resolved.

function assembleSpineRegion(
  def: RegionDef,
  seed: number,
  entryTx: number,
  entryTy: number,
): RegionInstance {
  const rng = makeLcg(seed);

  // Pick rooms: one entry, one boss (if boss rooms exist in catalogue),
  // fill remainder with standard/connector/dead-end.
  const entryRooms    = ROOM_CATALOGUE.filter(r => r.region_types.includes(def.id) && r.type === 'entry');
  const bossRooms     = ROOM_CATALOGUE.filter(r => r.region_types.includes(def.id) && r.type === 'boss');
  const standardRooms = ROOM_CATALOGUE.filter(r => r.region_types.includes(def.id) && r.type !== 'entry' && r.type !== 'boss');

  const roomCount = def.room_count_min + Math.floor(rng() * (def.room_count_max - def.room_count_min + 1));

  const selectedRoomDefs: RoomDef[] = [];

  // First room is always entry
  if (entryRooms.length > 0) {
    selectedRoomDefs.push(entryRooms[Math.floor(rng() * entryRooms.length)]);
  } else if (standardRooms.length > 0) {
    selectedRoomDefs.push(standardRooms[Math.floor(rng() * standardRooms.length)]);
  }

  // Middle rooms: standard/connector/dead-end
  const middleCount = bossRooms.length > 0 ? roomCount - 2 : roomCount - 1;
  for (let i = 0; i < Math.max(1, middleCount); i++) {
    selectedRoomDefs.push(standardRooms[Math.floor(rng() * standardRooms.length)]);
  }

  // Last room is boss if available
  if (bossRooms.length > 0) {
    selectedRoomDefs.push(bossRooms[Math.floor(rng() * bossRooms.length)]);
  }

  // Place rooms north along the spine.
  // currentTy = the world ty where the NEXT room's south connection lands.
  // currentTx = the world tx where the NEXT room's south connection lands.
  let currentTy = entryTy;
  let currentTx = entryTx;

  const rooms:     RoomInstance[] = [];
  const corridors: CorridorSpec[] = [];

  let overallEntryTx = entryTx;
  let overallEntryTy = entryTy;
  let overallExitTx  = entryTx;
  let overallExitTy  = entryTy;

  for (let i = 0; i < selectedRoomDefs.length; i++) {
    const roomDef = selectedRoomDefs[i];

    // Find south connection slot — this is how the room connects to the previous corridor.
    // If no south slot exists (e.g. a room only has a north slot), use slot index 0.
    const southSlot = roomDef.connections.find(c => c.edge === 'S')
                   ?? roomDef.connections[0];

    // World offset: place room so its south slot lands at (currentTx, currentTy)
    const worldOffsetTx = currentTx - southSlot.tx;
    const worldOffsetTy = currentTy - southSlot.ty;

    const instance: RoomInstance = {
      def:           roomDef,
      worldOffsetTx,
      worldOffsetTy,
      usedSlots:     new Set<string>(),
    };
    instance.usedSlots.add(southSlot.id);
    rooms.push(instance);

    if (i === 0) {
      overallEntryTx = currentTx;
      overallEntryTy = currentTy;
    }

    // Find north connection slot for the corridor to next room.
    const northSlot = roomDef.connections.find(c => c.edge === 'N');

    if (northSlot && i < selectedRoomDefs.length - 1) {
      instance.usedSlots.add(northSlot.id);

      // North slot world position
      const fromTx = worldOffsetTx + northSlot.tx;
      const fromTy = worldOffsetTy + northSlot.ty;

      // Corridor length seeded within region bounds
      const corridorLen = def.corridor_min + Math.floor(rng() * (def.corridor_max - def.corridor_min + 1));

      // Build corridor tiles: a 3-wide column going north from fromTy
      const corridorTiles: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let dy = 1; dy <= corridorLen; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          corridorTiles.push({ tx: fromTx + dx, ty: fromTy - dy, frame: 7 });
        }
      }

      const toTy = fromTy - corridorLen;
      corridors.push({
        fromSlot: { worldTx: fromTx, worldTy: fromTy, edge: 'N' },
        toSlot:   { worldTx: fromTx, worldTy: toTy,   edge: 'S' },
        tiles:    corridorTiles,
        tint:     def.tint,
      });

      // Next room's south slot lands at the corridor end
      currentTx = fromTx;
      currentTy = toTy;
    } else if (!northSlot) {
      // Dead-end or boss room — update exit to the north edge of this room
      overallExitTx = worldOffsetTx + Math.floor(roomDef.size.w / 2);
      overallExitTy = worldOffsetTy;
    } else {
      // Last room with a north slot (boss room has one eventually, for now track exit)
      overallExitTx = worldOffsetTx + Math.floor(roomDef.size.w / 2);
      overallExitTy = worldOffsetTy;
    }
  }

  return {
    def,
    rooms,
    corridors,
    entryTx: overallEntryTx,
    entryTy: overallEntryTy,
    exitTx:  overallExitTx,
    exitTy:  overallExitTy,
  };
}

// ── generateZoneGraph — Phase A stub ──────────────────────────────────────
//
// Currently wraps the existing 3-chunk linear output so WorldScene can begin
// calling generateZoneGraph() instead of generateChunkGraph() without any
// behaviour change. Phase B replaces the body with the full three-tier assembly.
//
// WorldScene should call generateZoneGraph() for new code paths.
// The old _spawnChunk / ChunkGraph path remains intact as a fallback.

export function generateZoneGraph(seed: number): ZoneGraph {
  const rng = makeLcg(seed);

  // Pick zone def — for Phase A always barracks-block.
  // Phase B will use: ZONE_LIBRARY[seed % ZONE_LIBRARY.length] or weighted draw.
  const zoneDef = ZONE_LIBRARY[0];

  // Assemble one region per region_def in the zone, chaining entry/exit.
  // First region's south entry connects to the hub portal at EXZONE_ENTRY_TX/TY.
  let chainTx = EXZONE_ENTRY_TX;
  let chainTy = EXZONE_ENTRY_TY;

  const regions: RegionInstance[] = [];

  for (let ri = 0; ri < zoneDef.region_defs.length; ri++) {
    const regionDef    = zoneDef.region_defs[ri];
    const regionSeed   = (seed ^ ((ri + 1) * 0x9e3779b9)) >>> 0;
    const region       = assembleSpineRegion(regionDef, regionSeed, chainTx, chainTy);
    regions.push(region);
    // Chain the next region's entry to this one's exit
    chainTx = region.exitTx;
    chainTy = region.exitTy;
  }

  // Compute world tile bounds across all rooms and corridors
  let minTx =  9999, maxTx = -9999;
  let minTy =  9999, maxTy = -9999;
  for (const region of regions) {
    for (const room of region.rooms) {
      const x0 = room.worldOffsetTx;
      const y0 = room.worldOffsetTy;
      const x1 = x0 + room.def.size.w - 1;
      const y1 = y0 + room.def.size.h - 1;
      if (x0 < minTx) minTx = x0;
      if (x1 > maxTx) maxTx = x1;
      if (y0 < minTy) minTy = y0;
      if (y1 > maxTy) maxTy = y1;
    }
    for (const corridor of region.corridors) {
      for (const t of corridor.tiles) {
        if (t.tx < minTx) minTx = t.tx;
        if (t.tx > maxTx) maxTx = t.tx;
        if (t.ty < minTy) minTy = t.ty;
        if (t.ty > maxTy) maxTy = t.ty;
      }
    }
  }

  // Boss tile: north-centre of last room in last region
  const lastRegion = regions[regions.length - 1];
  const lastRoom   = lastRegion?.rooms[lastRegion.rooms.length - 1] ?? null;
  const bossTile   = lastRoom
    ? {
        tx: lastRoom.worldOffsetTx + Math.floor(lastRoom.def.size.w / 2),
        ty: lastRoom.worldOffsetTy,
      }
    : null;

  return {
    seed,
    def:       zoneDef,
    regions,
    bounds:    { minTx, maxTx, minTy, maxTy },
    entryTile: { tx: EXZONE_ENTRY_TX, ty: EXZONE_ENTRY_TY },
    bossTile,
  };
}

// generateChunkGraph remains available internally for the legacy fallback path in WorldScene.