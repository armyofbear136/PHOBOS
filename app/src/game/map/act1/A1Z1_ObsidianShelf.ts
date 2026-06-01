/**
 * Act I — Zone 1 — OBSIDIAN SHELF
 * Archetype index: 1
 * Tint: 0x606070 (dark blue-grey)
 * Enemy flavour: sentinels
 *
 * A volcanic shelf where ancient lava flows have cooled into flat obsidian plates.
 * Dark, reflective, cracked. Sightlines are moderate — plates create natural
 * elevated platforms, cracks define movement lanes. Sentinels patrol methodically.
 * Rooms medium to large. Visual language geometric and angular — obsidian breaks
 * in straight lines, rooms feel machined by geology rather than by hands.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_OBS_FLOOR: number = 0x606070;  // dark blue-grey obsidian
const TINT_OBS_SLAB:  number = 0x404050;  // deeper plate edge
const TINT_OBS_CRACK: number = 0x2a2a38;  // crack line structures
const TINT_OBS_SHEEN: number = 0x8888a0;  // reflective highlight on slab tops
const TINT_OBS_GLOW:  number = 0x6666cc;  // faint violet slab-edge glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z1: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-traverse-a ─────────────────────────────────────────────────────
  // 64×64. Clean obsidian plate crossing. E/W slab edge structures (non-blocked,
  // depth 3). Three horizontal crack lines (non-blocked). 3 enemy markers in
  // patrol triangle. Faint violet glow along slab edges.
  {
    id:           'obsidian-traverse-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West slab edge — 2 tiles wide, non-blocked, depth 3
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_OBS_SLAB, depth: 3 })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_OBS_SLAB, depth: 3 })
      ),
      // East slab edge
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_OBS_SLAB, depth: 3 })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_OBS_SLAB, depth: 3 })
      ),
      // Three horizontal crack lines — non-blocked decorative
      { tx: 8,  ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 16, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 24, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 40, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 48, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 12, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 20, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 28, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 36, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 44, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 8,  ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 18, ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 30, ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 42, ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 52, ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // Glow along slab edges
      { tx: 1,  ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 62, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-traverse-b ─────────────────────────────────────────────────────
  // 80×64. Two plates at different heights. 2-tile-wide step E-W at mid-depth
  // (blocked), 6-tile gap at centre. Enemies prefer high ground — 3 north, 1 south.
  // Glow traces step edge.
  {
    id:           'obsidian-traverse-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Step row 1 at ty=30 — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i, ty: 30, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 30, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Step row 2 at ty=31
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i, ty: 31, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 31, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Glow along step edge
      { tx: 20, ty: 30, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 60, ty: 30, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 30, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 64, ty: 14, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-traverse-c ─────────────────────────────────────────────────────
  // 64×80. Three staggered E-W ridge segments (each 16 tiles, 1 tile blocked)
  // at 1/4, 1/2, 3/4 depth, each offset. Subtle weave. 4 enemy markers.
  {
    id:           'obsidian-traverse-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Ridge 1 at ty=20 — west side (tx=0-15)
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Ridge 2 at ty=40 — centre (tx=24-39)
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 24, ty: 40, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Ridge 3 at ty=60 — east side (tx=48-63)
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 48, ty: 60, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 8,  ty: 30, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 50, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 70, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-traverse-d ─────────────────────────────────────────────────────
  // 80×80. Central obsidian pillar formation (4×8 N-S, blocked) divides room
  // into two equal lanes. 2 enemy markers per lane. Glow pools at N and S ends.
  {
    id:           'obsidian-traverse-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-deep'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Central N-S pillar 4×8, centred horizontally
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 36, frame: tx < 2 ? 21 : 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      // Glow pools at north and south ends of pillar
      { tx: 40, ty: 34, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 45, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 56, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-traverse-e ─────────────────────────────────────────────────────
  // 64×64. Cracked plate room. Three 6-tile crack lines radiating from centre
  // (non-blocked decorative). 4 enemy markers at crack ends. 1 loot at shatter origin.
  {
    id:           'obsidian-traverse-e',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-plates'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Three crack lines radiating from (32,32) — north, SW, SE
      // North crack (straight up)
      { tx: 32, ty: 26, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 27, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 28, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 29, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 30, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 31, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // SW crack (diagonal approximation)
      { tx: 31, ty: 33, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 30, ty: 34, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 29, ty: 35, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 28, ty: 36, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 27, ty: 37, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 26, ty: 38, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // SE crack
      { tx: 33, ty: 33, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 34, ty: 34, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 35, ty: 35, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 36, ty: 36, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 37, ty: 37, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 38, ty: 38, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // Glow at shatter origin
      { tx: 32, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 22, type: 'enemy' },
      { id: 'e1', tx: 22, ty: 42, type: 'enemy' },
      { id: 'e2', tx: 42, ty: 42, type: 'enemy' },
      { id: 'e3', tx: 50, ty: 16, type: 'enemy' },
      { id: 'l0', tx: 32, ty: 32, type: 'loot'  },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-traverse-f ─────────────────────────────────────────────────────
  // 80×64. Two parallel N-S obsidian walls (1×24 blocked) from south face stopping
  // at 2/3 depth. Three-lane approach merges into open north. 4+2 enemy markers.
  {
    id:           'obsidian-traverse-f',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West lane wall — tx=22, ty=20 to ty=43 (24 tiles)
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 22, ty: i + 20, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // East lane wall — tx=57
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 57, ty: i + 20, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 48, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 68, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 10, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e5', tx: 68, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-traverse-g ─────────────────────────────────────────────────────
  // 64×64. Reflective pool — 16×16 TINT_OBS_SHEEN floor area at centre.
  // Single glow source. 4 enemy markers ringing the pool.
  {
    id:           'obsidian-traverse-g',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-elevated'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // 16×16 reflective pool area — non-blocked, depth 1 lighter tint
      ...Array.from({ length: 16 }, (_, ty) =>
        Array.from({ length: 16 }, (_, tx) =>
          ({ tx: tx + 24, ty: ty + 24, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 })
        )
      ).flat(),
      // Central glow
      { tx: 32, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-traverse-h ─────────────────────────────────────────────────────
  // 96×64. Widest traversal. 2×2 slab outcroppings in grid pattern at 10-tile
  // spacing. Regular obstacle field — sentinels exploit for cover. 4 enemy markers.
  {
    id:           'obsidian-traverse-h',
    zone_act:     1,
    region_types: ['obsidian-shelf-plates', 'obsidian-shelf-deep'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Grid of 2×2 slab outcroppings at ~10-tile spacing, avoiding corridor centres
      { tx: 8,  ty: 10, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 10, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 10, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 11, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 11, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 58, ty: 10, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 10, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 58, ty: 11, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 11, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 80, ty: 10, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 81, ty: 10, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 80, ty: 11, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 81, ty: 11, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 18, ty: 30, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 19, ty: 30, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 18, ty: 31, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 19, ty: 31, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 44, ty: 30, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 45, ty: 30, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 44, ty: 31, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 45, ty: 31, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 30, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 30, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 31, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 31, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 50, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 51, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 51, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 38, ty: 50, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 39, ty: 50, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 38, ty: 51, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 39, ty: 51, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 68, ty: 50, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 69, ty: 50, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 68, ty: 51, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 69, ty: 51, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 18, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 58, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-traverse-i ─────────────────────────────────────────────────────
  // 64×80. Diagonal crack line (staggered 1×1 TINT_OBS_CRACK, non-blocked).
  // Sentinels patrol along the crack. 4 enemy markers along diagonal.
  {
    id:           'obsidian-traverse-i',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-fracture'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Diagonal crack — staggered 1×1 tiles from SW to NE
      { tx: 8,  ty: 72, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 12, ty: 66, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 16, ty: 60, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 20, ty: 54, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 24, ty: 48, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 28, ty: 42, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 32, ty: 36, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 36, ty: 30, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 40, ty: 24, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 44, ty: 18, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 48, ty: 12, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 52, ty: 6,  frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // Crack glow
      { tx: 28, ty: 42, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 24, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 68, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 50, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 14, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-traverse-j ─────────────────────────────────────────────────────
  // 80×64. Collapsing east shelf edge — three 4×8 blocked slab formations against
  // east wall. West side open. 4 enemy markers west. 1 mineral in slab gap.
  {
    id:           'obsidian-traverse-j',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-fracture'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Three 4×8 slab formations on east wall
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 4, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 28, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 52, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 12, type: 'enemy'   },
      { id: 'e1', tx: 32, ty: 32, type: 'enemy'   },
      { id: 'e2', tx: 16, ty: 50, type: 'enemy'   },
      { id: 'e3', tx: 48, ty: 18, type: 'enemy'   },
      { id: 'm0', tx: 63, ty: 22, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-traverse-k ─────────────────────────────────────────────────────
  // 64×64. Pre-boss compression. Two inward-stepping slab walls narrow to 16-tile
  // passage at north. 5 enemy markers in the funnel.
  {
    id:           'obsidian-traverse-k',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West funnel wall — steps inward in 3 stages
      { tx: 0,  ty: 48, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 0,  ty: 40, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 0,  ty: 32, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 24, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 16, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 8,  frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 4,  frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // East funnel wall
      { tx: 63, ty: 48, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 40, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 32, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 55, ty: 24, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 55, ty: 16, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 47, ty: 8,  frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 47, ty: 4,  frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Glow at funnel apex
      { tx: 32, ty: 6,  frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 56, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 26, ty: 18, type: 'enemy' },
      { id: 'e4', tx: 38, ty: 18, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-traverse-l ─────────────────────────────────────────────────────
  // 80×80. Final standard traversal. 12 small 2×2 slab fragments scattered as
  // non-blocked decorative shards. 4 enemy markers.
  {
    id:           'obsidian-traverse-l',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // 12 scattered 2×2 slab fragments — non-blocked, purely decorative
      { tx: 8,  ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 9,  ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 8,  ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 9,  ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 28, ty: 8,  frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 29, ty: 8,  frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 28, ty: 9,  frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 29, ty: 9,  frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 52, ty: 14, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 53, ty: 14, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 52, ty: 15, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 53, ty: 15, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 68, ty: 20, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 69, ty: 20, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 68, ty: 21, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 69, ty: 21, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 14, ty: 38, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 15, ty: 38, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 14, ty: 39, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 15, ty: 39, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 40, ty: 36, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 41, ty: 36, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 40, ty: 37, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 41, ty: 37, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 62, ty: 42, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 63, ty: 42, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 62, ty: 43, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 63, ty: 43, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 20, ty: 60, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 21, ty: 60, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 20, ty: 61, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 21, ty: 61, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 46, ty: 58, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 47, ty: 58, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 46, ty: 59, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 47, ty: 59, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 70, ty: 64, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 71, ty: 64, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 70, ty: 65, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 71, ty: 65, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 8,  ty: 68, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 9,  ty: 68, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 8,  ty: 69, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 9,  ty: 69, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 36, ty: 72, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 37, ty: 72, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 36, ty: 73, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 37, ty: 73, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-combat-a ───────────────────────────────────────────────────────
  // 64×64. Four 2×2 obsidian pillars at equidistant points. 5 enemy markers —
  // one at each pillar, one at centre. Sentinels retreat to cover.
  {
    id:           'obsidian-combat-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // NW pillar
      { tx: 12, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 13, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 12, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 13, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // NE pillar
      { tx: 50, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 50, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // SW pillar
      { tx: 12, ty: 50, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 13, ty: 50, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 12, ty: 51, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 13, ty: 51, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // SE pillar
      { tx: 50, ty: 50, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 50, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 50, ty: 51, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 51, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 13, ty: 13, type: 'enemy' },
      { id: 'e1', tx: 51, ty: 13, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 13, ty: 51, type: 'enemy' },
      { id: 'e4', tx: 51, ty: 51, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-combat-b ───────────────────────────────────────────────────────
  // 48×64. Dominant N-S slab wall (1×24 blocked) bisects room. 12 tiles passage
  // each side. E exit mid-depth. 5 enemy markers.
  {
    id:           'obsidian-combat-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-plates', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 47, ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // Central N-S wall at tx=23, ty=20 to ty=43
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 23, ty: i + 20, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 10, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 36, ty: 36, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-combat-c ───────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. W branch. West side denser with secondary L-shaped
  // cover wall. 5 enemy markers.
  {
    id:           'obsidian-combat-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-plates', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Primary N-S wall at tx=32
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 32, ty: i + 20, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Secondary L-shaped cover on west side
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 14, ty: i + 20, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      { tx: 15, ty: 28, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 17, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 18, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 16, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 8,  ty: 48, type: 'enemy' },
      { id: 'e3', tx: 50, ty: 48, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-combat-d ───────────────────────────────────────────────────────
  // 80×64. Crossfire room. Two 1×16 slab walls from east and west walls at
  // different depths (1/3 and 2/3), not meeting. 6 enemy markers covering both
  // chokepoints simultaneously.
  {
    id:           'obsidian-combat-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-elevated'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West wall projection at ty=20 — 16 tiles inward from west
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // East wall projection at ty=44 — 16 tiles inward from east
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 64, ty: 44, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 8,  ty: 32, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 56, ty: 54, type: 'enemy' },
      { id: 'e5', tx: 20, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-combat-e ───────────────────────────────────────────────────────
  // 64×80. Slab maze — four 2×8 formations in pinwheel pattern. Four curved lanes
  // between them. 6 enemy markers in alternating lanes. 1 mineral at pinwheel centre.
  {
    id:           'obsidian-combat-e',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-elevated'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // North formation — 2×8 horizontal
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 24, ty: 20, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 24, ty: 21, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // South formation — 2×8 horizontal
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 24, ty: 58, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 24, ty: 59, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // West formation — 8×2 vertical
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 12, ty: i + 36, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 13, ty: i + 36, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // East formation — 8×2 vertical
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 50, ty: i + 36, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 51, ty: i + 36, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 16, type: 'enemy'   },
      { id: 'e1', tx: 56, ty: 16, type: 'enemy'   },
      { id: 'e2', tx: 8,  ty: 60, type: 'enemy'   },
      { id: 'e3', tx: 56, ty: 60, type: 'enemy'   },
      { id: 'e4', tx: 20, ty: 40, type: 'enemy'   },
      { id: 'e5', tx: 44, ty: 40, type: 'enemy'   },
      { id: 'm0', tx: 32, ty: 40, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-combat-f ───────────────────────────────────────────────────────
  // 80×64. Sentinel ambush. South half open. North half has 6 pillar pairs
  // creating gatehouse effect. 6 enemy markers behind pillars.
  {
    id:           'obsidian-combat-f',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Six pillar pairs flanking three lanes in north half
      // Lane 1 pillars (west lane)
      { tx: 8,  ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 20, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 21, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 20, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 21, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Lane 2 pillars (centre lane)
      { tx: 36, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 37, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 37, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 44, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 45, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 44, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 45, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Lane 3 pillars (east lane)
      { tx: 58, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 58, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 40, ty: 6,  type: 'enemy' },
      { id: 'e2', tx: 64, ty: 6,  type: 'enemy' },
      { id: 'e3', tx: 14, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 20, type: 'enemy' },
      { id: 'e5', tx: 64, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-combat-g ───────────────────────────────────────────────────────
  // 64×64. Grid anchor combat. Slab walls on all four internal faces (1×8 inward).
  // Open centre. 6 enemy markers. All exits clear.
  {
    id:           'obsidian-combat-g',
    zone_act:     1,
    region_types: ['obsidian-shelf-plates', 'obsidian-shelf-elevated'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // North face — 1×8 inward from north wall at tx=28-35
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 28 + i, ty: 0, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // South face
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 28 + i, ty: 63, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // West face
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 0, ty: 28 + i, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // East face
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 63, ty: 28 + i, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 44, ty: 44, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 16, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-combat-h ───────────────────────────────────────────────────────
  // 48×48. Small and brutal. Single central 4×4 blocked slab formation.
  // 6 enemy markers ringing it. No disengagement space.
  {
    id:           'obsidian-combat-h',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-fracture'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central 4×4 slab
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 22, ty: ty + 22, frame: tx < 2 ? 28 : 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 24, ty: 24, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 36, ty: 12, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 28, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 28, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 38, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-combat-i ───────────────────────────────────────────────────────
  // 80×64. Three 4×4 slab formations in arc across north face. 6 enemy markers
  // behind arc. Strong glow traces inside of arc.
  {
    id:           'obsidian-combat-i',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West arc formation 4×4 at (12, 8)
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 12, ty: ty + 8, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      // Centre arc formation 4×4 at (38, 4)
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 4, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      // East arc formation 4×4 at (64, 8)
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 8, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      // Arc interior glow
      { tx: 14, ty: 14, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 10, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 66, ty: 14, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 26, ty: 4,  type: 'enemy' },
      { id: 'e2', tx: 40, ty: 4,  type: 'enemy' },
      { id: 'e3', tx: 54, ty: 4,  type: 'enemy' },
      { id: 'e4', tx: 72, ty: 4,  type: 'enemy' },
      { id: 'e5', tx: 40, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-combat-j ───────────────────────────────────────────────────────
  // 80×80. Maximum combat density. 10 scattered 2×2 slab obstacles, 6 enemy
  // markers, violet glow at every obstacle. Close-quarters in deepest shelf.
  {
    id:           'obsidian-combat-j',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // 10 scattered 2×2 slab obstacles
      { tx: 8,  ty: 10, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 10, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 28, ty: 16, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 16, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 17, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 17, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 16, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 56, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 57, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 56, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 57, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 56, ty: 12, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 70, ty: 22, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 22, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 23, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 23, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 22, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 14, ty: 40, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 15, ty: 40, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 14, ty: 41, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 15, ty: 41, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 14, ty: 40, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 36, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 41, ty: 36, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 40, ty: 37, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 41, ty: 37, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 40, ty: 36, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 64, ty: 44, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 65, ty: 44, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 64, ty: 45, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 65, ty: 45, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 64, ty: 44, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 8,  ty: 58, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 58, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 59, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 59, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 58, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 36, ty: 60, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 37, ty: 60, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 61, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 37, ty: 61, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 60, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 60, ty: 64, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 61, ty: 64, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 60, ty: 65, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 61, ty: 65, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 60, ty: 64, frame: 7,  tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 56, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 60, type: 'enemy' },
      { id: 'e5', tx: 72, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-dead-a ─────────────────────────────────────────────────────────
  // 32×32. Natural shelf alcove. 1 loot, 1 mineral. Clean.
  {
    id:           'obsidian-dead-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-cracks'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 2,  ty: 0, frame: 21, tint: TINT_OBS_SLAB, depth: 3, blocked: true },
      { tx: 29, ty: 0, frame: 22, tint: TINT_OBS_SLAB, depth: 3, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 12, ty: 14, type: 'loot'    },
      { id: 'm0', tx: 20, ty: 14, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-dead-b ─────────────────────────────────────────────────────────
  // 48×32. Broken slab pocket. Three 2×1 non-blocked slab fragments lean against
  // north wall. 2 loot, 1 mineral, 1 enemy.
  {
    id:           'obsidian-dead-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates'],
    type:         'dead-end',
    size:         { w: 48, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 31 },
    ],
    tiles: floor(48, 32),
    structures: [
      // Three 2×1 slab fragments against north wall — non-blocked
      { tx: 8,  ty: 2, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 9,  ty: 2, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 22, ty: 2, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 23, ty: 2, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 36, ty: 2, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 37, ty: 2, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 20, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 18, type: 'loot'    },
      { id: 'l1', tx: 24, ty: 18, type: 'loot'    },
      { id: 'm0', tx: 38, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-dead-c ─────────────────────────────────────────────────────────
  // 32×48. Narrow crack pocket. Slab wall formations on east and west.
  // 3 mineral markers in a line at north face. 1 loot.
  {
    id:           'obsidian-dead-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-elevated'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Slab walls defining the crack pocket
      { tx: 0,  ty: 8,  frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 0,  ty: 16, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 0,  ty: 24, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 31, ty: 8,  frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 31, ty: 16, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 31, ty: 24, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 16, ty: 28, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 16, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 24, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-dead-d ─────────────────────────────────────────────────────────
  // 48×48. Reflective pool alcove. 16×16 sheen floor at centre. Glow.
  // 2 loot, 1 mineral. 1 enemy.
  {
    id:           'obsidian-dead-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-deep'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // 16×16 sheen pool
      ...Array.from({ length: 16 }, (_, ty) =>
        Array.from({ length: 16 }, (_, tx) =>
          ({ tx: tx + 16, ty: ty + 12, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 })
        )
      ).flat(),
      // Pool glow
      { tx: 24, ty: 20, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 36, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 10, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 10, type: 'loot'    },
      { id: 'm0', tx: 24, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-dead-e ─────────────────────────────────────────────────────────
  // 32×32. Minimal shard pocket. One 2×2 slab fragment. 2 loot. No combat.
  {
    id:           'obsidian-dead-e',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-deep'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 14, ty: 8, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 15, ty: 8, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 14, ty: 9, frame: 35, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 15, ty: 9, frame: 36, tint: TINT_OBS_SLAB, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 20, type: 'loot' },
      { id: 'l1', tx: 22, ty: 20, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-dead-f ─────────────────────────────────────────────────────────
  // 48×48. Fracture vent. Central crack with glow. 2 loot, 2 mineral. 2 enemies.
  {
    id:           'obsidian-dead-f',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-deep'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central crack structure
      { tx: 22, ty: 10, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 23, ty: 12, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 24, ty: 14, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 23, ty: 16, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 22, ty: 18, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 23, ty: 14, frame: 7,  tint: TINT_OBS_GLOW,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 30, type: 'enemy'   },
      { id: 'e1', tx: 36, ty: 30, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 8,  type: 'loot'    },
      { id: 'l1', tx: 36, ty: 8,  type: 'loot'    },
      { id: 'm0', tx: 10, ty: 40, type: 'mineral' },
      { id: 'm1', tx: 36, ty: 40, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-dead-g ─────────────────────────────────────────────────────────
  // 32×48. Narrow late-zone mineral pocket. 4 mineral, 1 loot, 1 enemy.
  {
    id:           'obsidian-dead-g',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 30, type: 'enemy'   },
      { id: 'l0', tx: 16, ty: 38, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 14, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 20, ty: 6,  type: 'mineral' },
      { id: 'm3', tx: 26, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-dead-h ─────────────────────────────────────────────────────────
  // 48×48. Rich guarded alcove. 3 loot, 3 mineral, 3 enemy markers.
  {
    id:           'obsidian-dead-h',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 24 ? 21 : 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 8, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 24, type: 'enemy'   },
      { id: 'e1', tx: 24, ty: 20, type: 'enemy'   },
      { id: 'e2', tx: 40, ty: 24, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 8,  type: 'loot'    },
      { id: 'l1', tx: 24, ty: 6,  type: 'loot'    },
      { id: 'l2', tx: 40, ty: 8,  type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 36, type: 'mineral' },
      { id: 'm1', tx: 24, ty: 36, type: 'mineral' },
      { id: 'm2', tx: 40, ty: 36, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // JUNCTION ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-junction-a ─────────────────────────────────────────────────────
  // 64×64. Eastern branch junction. Central 3×3 slab pillar. E exit clear.
  // 2 enemy markers.
  {
    id:           'obsidian-junction-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central 3×3 slab pillar
      { tx: 28, ty: 28, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 30, ty: 28, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 29, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 30, ty: 29, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-junction-b ─────────────────────────────────────────────────────
  // 64×64. Western branch junction. West slab bias — pillar shifted west.
  // W exit. 2 enemy markers.
  {
    id:           'obsidian-junction-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central pillar shifted slightly east to leave west lane open
      { tx: 34, ty: 28, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 35, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 28, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 34, ty: 29, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 35, ty: 29, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 29, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 34, ty: 30, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 35, ty: 30, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 36, ty: 30, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 48, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-junction-c ─────────────────────────────────────────────────────
  // 80×64. Full cross. Four corner slab clusters leave all passages clear.
  // 3 enemy markers at centre.
  {
    id:           'obsidian-junction-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-plates', 'obsidian-shelf-elevated'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // NW corner slab
      { tx: 6,  ty: 6,  frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 7,  ty: 6,  frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 6,  ty: 7,  frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 7,  ty: 7,  frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // NE corner slab
      { tx: 72, ty: 6,  frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 73, ty: 6,  frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 72, ty: 7,  frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 73, ty: 7,  frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // SW corner slab
      { tx: 6,  ty: 56, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 7,  ty: 56, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 6,  ty: 57, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 7,  ty: 57, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // SE corner slab
      { tx: 72, ty: 56, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 73, ty: 56, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 72, ty: 57, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 73, ty: 57, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── obsidian-junction-d ─────────────────────────────────────────────────────
  // 64×80. Elevated junction. Step structure at mid-depth east half raised.
  // E exit from elevated section. 3 enemy markers.
  {
    id:           'obsidian-junction-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Step edge at tx=32 running N-S (east half elevated)
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 32, ty: i + 10, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Glow along step
      { tx: 32, ty: 30, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 32, ty: 50, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 40, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 50, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-junction-e ─────────────────────────────────────────────────────
  // 64×64. Crack-line junction. Major decorative crack E-W. W exit cuts across.
  // 3 enemy markers.
  {
    id:           'obsidian-junction-e',
    zone_act:     1,
    region_types: ['obsidian-shelf-cracks', 'obsidian-shelf-fracture'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Major E-W decorative crack at ty=32
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 })
      ),
      { tx: 32, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-junction-f ─────────────────────────────────────────────────────
  // 80×64. Wide junction with central reflective pool. All exits clear.
  // 3 enemy markers.
  {
    id:           'obsidian-junction-f',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-cracks'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // 12×12 reflective pool at centre
      ...Array.from({ length: 12 }, (_, ty) =>
        Array.from({ length: 12 }, (_, tx) =>
          ({ tx: tx + 34, ty: ty + 26, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 })
        )
      ).flat(),
      { tx: 40, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── obsidian-junction-g ─────────────────────────────────────────────────────
  // 64×64. Late grid junction. 6–8 slab fragments, all passages maintained.
  // 4 enemy markers.
  {
    id:           'obsidian-junction-g',
    zone_act:     1,
    region_types: ['obsidian-shelf-deep', 'obsidian-shelf-fracture'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // 6 slab fragments away from passage lanes
      { tx: 10, ty: 10, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 48, ty: 10, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 10, ty: 48, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 48, ty: 48, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 20, ty: 20, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 42, ty: 42, frame: 14, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-junction-h ─────────────────────────────────────────────────────
  // 80×80. Large deep junction. 4×4 central formation with strong glow.
  // 4 enemy markers.
  {
    id:           'obsidian-junction-h',
    zone_act:     1,
    region_types: ['obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Central 4×4 slab formation
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 38, frame: tx < 2 ? 28 : 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 40, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 40, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS-APPROACH ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-approach-a ─────────────────────────────────────────────────────
  // 80×80. Dense slab corridor approach. 5 enemy markers. Glow intensifies.
  {
    id:           'obsidian-approach-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Dense slab pairs flanking central corridor (tx 32-47)
      { tx: 8,  ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 20, ty: 28, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 21, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 20, ty: 29, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 21, ty: 29, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 10, ty: 48, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 11, ty: 48, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 10, ty: 49, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 11, ty: 49, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 22, ty: 60, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 23, ty: 60, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 22, ty: 61, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 23, ty: 61, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 68, ty: 12, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 69, ty: 12, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 68, ty: 13, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 69, ty: 13, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 58, ty: 28, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 28, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 58, ty: 29, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 59, ty: 29, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 66, ty: 48, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 67, ty: 48, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 66, ty: 49, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 67, ty: 49, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 54, ty: 60, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 55, ty: 60, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 54, ty: 61, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 55, ty: 61, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Glows
      { tx: 40, ty: 20, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 44, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 64, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 60, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 72, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-approach-b ─────────────────────────────────────────────────────
  // 96×64. Three staggered slab walls create gauntlet. 6 enemy markers.
  {
    id:           'obsidian-approach-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Wall 1 at ty=16 — from west, gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 48 ? 28 : 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Wall 2 at ty=32 — centre gap (tx=43-52)
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i + 53, ty: 32, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Wall 3 at ty=48 — from east, gap west (tx=0-25)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i + 26, ty: 48, frame: i < 35 ? 28 : 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Glows at gaps
      { tx: 76, ty: 16, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 48, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 14, ty: 48, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 80, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 24, type: 'enemy' },
      { id: 'e4', tx: 8,  ty: 56, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-approach-c ─────────────────────────────────────────────────────
  // 80×96. Narrowing funnel. 6 enemy markers. Violet glow traces funnel walls.
  {
    id:           'obsidian-approach-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 96),
    structures: [
      // West funnel wall
      { tx: 0,  ty: 80, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 0,  ty: 64, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 48, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 32, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 24, ty: 16, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 4,  frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // East funnel wall
      { tx: 79, ty: 80, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 79, ty: 64, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 48, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 32, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 55, ty: 16, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 4,  frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Glows tracing funnel walls
      { tx: 28, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 52, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 60, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 76, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 76, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 34, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 46, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-approach-d ─────────────────────────────────────────────────────
  // 96×80. Two arcing slab rows frame the boss entry. 5 enemy markers. Maximum
  // glow density.
  {
    id:           'obsidian-approach-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // West arc converging north
      { tx: 8,  ty: 64, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 64, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 65, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 9,  ty: 65, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 48, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 17, ty: 48, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 49, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 17, ty: 49, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 24, ty: 32, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 25, ty: 32, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 24, ty: 33, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 25, ty: 33, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 32, ty: 16, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 33, ty: 16, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 32, ty: 17, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 33, ty: 17, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 38, ty: 6,  frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 39, ty: 6,  frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 38, ty: 7,  frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 39, ty: 7,  frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // East arc converging north
      { tx: 86, ty: 64, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 87, ty: 64, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 86, ty: 65, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 87, ty: 65, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 78, ty: 48, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 79, ty: 48, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 78, ty: 49, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 79, ty: 49, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 32, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 32, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 70, ty: 33, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 33, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 62, ty: 16, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 16, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 62, ty: 17, frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 17, frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 56, ty: 6,  frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 57, ty: 6,  frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 56, ty: 7,  frame: 35, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 57, ty: 7,  frame: 36, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Maximum glow
      { tx: 17, ty: 48, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 25, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 79, ty: 48, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 71, ty: 32, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 48, ty: 16, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 60, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 60, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 36, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 14, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS ARENAS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-boss-a ─────────────────────────────────────────────────────────
  // 96×96. Vast fractured obsidian plate. Six crack panel divisions (non-blocked).
  // Central 4×4 obsidian throne (non-blocked, depth 6). Four 2×8 slab walls as
  // cover. 6 enemy markers. Central glow pool.
  {
    id:           'obsidian-boss-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // Panel crack divisions — non-blocked decorative
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 13, tint: TINT_OBS_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 64, frame: 13, tint: TINT_OBS_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 32, ty: i, frame: 13, tint: TINT_OBS_CRACK, depth: 2 })
      ),
      // Throne — 4×4 non-blocked, high depth
      { tx: 46, ty: 46, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 47, ty: 46, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 48, ty: 46, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 49, ty: 46, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 46, ty: 47, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 47, ty: 47, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 48, ty: 47, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 49, ty: 47, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 46, ty: 48, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 47, ty: 48, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 48, ty: 48, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 49, ty: 48, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 46, ty: 49, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 47, ty: 49, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 48, ty: 49, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      { tx: 49, ty: 49, frame: 7, tint: TINT_OBS_SLAB, depth: 6 },
      // Four 2×8 slab cover walls at cardinal positions
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 16, ty: 16, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 16, ty: 17, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 72, ty: 16, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 72, ty: 17, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 16, ty: 78, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 16, ty: 79, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 72, ty: 78, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 72, ty: 79, frame: 29, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Central glow pool
      { tx: 48, ty: 48, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 76, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 76, type: 'enemy' },
      { id: 'e3', tx: 76, ty: 76, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-boss-b ─────────────────────────────────────────────────────────
  // 80×80. Circular slab ring arena. Continuous 2-tile-wide slab ring at radius
  // 24 with 4 entry gaps. Boss spawns inside ring. 6 enemy markers. Violet glow ring.
  {
    id:           'obsidian-boss-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // North arc (ty=16) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 16, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 15, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 16, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 15, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // South arc (ty=64) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 64, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 65, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 64, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 65, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // West side (tx=16-17) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 17, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 15, ty: i + 17, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 43, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 15, ty: i + 43, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // East side (tx=64-65) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 17, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 65, ty: i + 17, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 43, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 65, ty: i + 43, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Violet glow ring markers
      { tx: 24, ty: 16, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 56, ty: 16, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 16, ty: 28, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 64, ty: 28, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 40, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 28, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 28, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 52, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-boss-c ─────────────────────────────────────────────────────────
  // 96×80. Asymmetric fracture arena. Heavy slab formations west, open east.
  // Boss spawns east. Player cover on west. 6 enemy markers distributed.
  {
    id:           'obsidian-boss-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Heavy west slab formations — player cover
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 8, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 36, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 64, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 22, ty: ty + 22, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 22, ty: ty + 52, frame: 28, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
        )
      ).flat(),
      // Light east decorative cracks
      { tx: 72, ty: 20, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 80, ty: 30, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      { tx: 72, ty: 50, frame: 13, tint: TINT_OBS_CRACK, depth: 2 },
      // Boss spawn glow
      { tx: 72, ty: 40, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 64, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 80, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 84, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 64, ty: 64, type: 'enemy' },
      { id: 'e5', tx: 80, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── obsidian-boss-d ─────────────────────────────────────────────────────────
  // 80×96. Double-plate arena. Two plates connected by 8-tile bridge.
  // Boss on north plate. Player enters south. 6 enemy markers. Maximum violet glow.
  {
    id:           'obsidian-boss-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-core'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // South plate boundary
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 56, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 56, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      // Bridge walls — narrows to 8 tiles
      { tx: 4,  ty: 44, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 4,  ty: 48, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 8,  ty: 40, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 16, ty: 36, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 28, ty: 32, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 75, ty: 44, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 75, ty: 48, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 71, ty: 40, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 63, ty: 36, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 51, ty: 32, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // North plate boundary
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 28, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 28, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      { tx: 4,  ty: 16, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 4,  ty: 20, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 75, ty: 16, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      { tx: 75, ty: 20, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true },
      // Glows — both plates and bridge
      { tx: 40, ty: 18, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 44, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
      { tx: 40, ty: 72, frame: 7, tint: TINT_OBS_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 14, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 22, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 22, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 22, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── obsidian-connector-a ────────────────────────────────────────────────────
  // 16×24. Narrow crack passage. Slab walls on both sides.
  {
    id:           'obsidian-connector-a',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-cracks', 'obsidian-shelf-elevated', 'obsidian-shelf-deep', 'obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── obsidian-connector-b ────────────────────────────────────────────────────
  // 24×16. Wide shallow crossing. Two decorative slab shards flanking.
  {
    id:           'obsidian-connector-b',
    zone_act:     1,
    region_types: ['obsidian-shelf-entry', 'obsidian-shelf-plates', 'obsidian-shelf-cracks', 'obsidian-shelf-elevated', 'obsidian-shelf-deep', 'obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'connector',
    size:         { w: 24, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 16),
    structures: [
      { tx: 4,  ty: 6, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 5,  ty: 6, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 18, ty: 6, frame: 28, tint: TINT_OBS_SLAB, depth: 3 },
      { tx: 19, ty: 6, frame: 29, tint: TINT_OBS_SLAB, depth: 3 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── obsidian-connector-c ────────────────────────────────────────────────────
  // 16×32. Long narrow slab channel. Full-length wall structures.
  {
    id:           'obsidian-connector-c',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-deep', 'obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'connector',
    size:         { w: 16, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 22, tint: TINT_OBS_SLAB, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── obsidian-connector-d ────────────────────────────────────────────────────
  // 24×24. Short junction stub. Single reflective floor tile at centre.
  {
    id:           'obsidian-connector-d',
    zone_act:     1,
    region_types: ['obsidian-shelf-elevated', 'obsidian-shelf-deep', 'obsidian-shelf-fracture', 'obsidian-shelf-core'],
    type:         'connector',
    size:         { w: 24, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 24),
    structures: [
      { tx: 11, ty: 11, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 },
      { tx: 12, ty: 11, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 },
      { tx: 11, ty: 12, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 },
      { tx: 12, ty: 12, frame: 0, tint: TINT_OBS_SHEEN, depth: 1 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z1

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z1: RegionDef[] = [
  {
    id:             'obsidian-shelf-entry',
    label:          'Obsidian Shelf — Entry Crossing',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-plates',
    label:          'Obsidian Shelf — Plate Field',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-cracks',
    label:          'Obsidian Shelf — Crack Network',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-elevated',
    label:          'Obsidian Shelf — Elevated Plate Ring',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-deep',
    label:          'Obsidian Shelf — Deep Shelf',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-fracture',
    label:          'Obsidian Shelf — Fracture Zone',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_OBS_FLOOR,
  },
  {
    id:             'obsidian-shelf-core',
    label:          'Obsidian Shelf — Core Convergence',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_OBS_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionEntry,
  regionPlates,
  regionCracks,
  regionElevated,
  regionDeep,
  regionFracture,
  regionCore,
] = REGIONS_A1Z1;

export const ZONE_A1Z1: ZoneDef = {
  id:           'obsidian-shelf',
  label:        'Obsidian Shelf',
  zone_act:     1,
  region_defs:  [
    regionEntry,
    regionPlates,
    regionCracks,
    regionElevated,
    regionDeep,
    regionFracture,
    regionCore,
  ],
  enemy_flavour: 'sentinels',
  tint:          TINT_OBS_FLOOR,
};
