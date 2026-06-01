/**
 * Act I — Zone 0 — CRATER FLAT
 * Archetype index: 0
 * Tint: 0x8888aa (cool grey-blue)
 * Enemy flavour: scavengers
 *
 * The most open zone in Act I. Vast dust plains, shallow impact craters, long
 * sightlines. Rooms are terrain segments being crossed rather than enclosed spaces.
 * Low rock outcroppings and rim walls — nothing enclosed. Scavengers spread wide
 * and move fast. Minimum room size 48×48; traversal rooms 64×96. Boss arenas 80–96.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_CRATER_FLOOR:  number = 0x8888aa;  // cool grey-blue dust
const TINT_CRATER_ROCK:   number = 0x6a6a88;  // darker blue-grey rock outcroppings
const TINT_CRATER_RIM:    number = 0x4a4a66;  // deep slate rim walls
const TINT_CRATER_DETAIL: number = 0xaaaacc;  // pale highlight on boulder tops
const TINT_CRATER_GLOW:   number = 0x8888ff;  // faint blue dust-scatter glow

// ── Helpers ───────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z0: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── crater-flat-traverse-a ──────────────────────────────────────────────────
  // 80×64. Wide open dust plain. 6–8 scattered boulder clusters. Rim walls on
  // east and west edges stopping 10 tiles from north/south faces. 3 enemy markers.
  {
    id:           'crater-flat-traverse-a',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-basin'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West rim wall — stops 10 tiles from each face
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: 0, ty: i + 10, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // East rim wall
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: 79, ty: i + 10, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // Boulder clusters — 6 scattered 2×2 blocked formations
      { tx: 12, ty: 14, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 14, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 15, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 15, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 35, ty: 22, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 22, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 35, ty: 23, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 23, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 60, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 61, ty: 16, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 60, ty: 17, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 61, ty: 17, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 52, ty: 44, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 53, ty: 44, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 52, ty: 45, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 53, ty: 45, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 25, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 38, type: 'enemy' },
      { id: 'e2', tx: 58, ty: 28, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-traverse-b ──────────────────────────────────────────────────
  // 96×64. Shallow crater crossing. Central oval rim ring (frame 13, non-blocked).
  // Boulders cluster outside the oval. 4 enemy markers — 2 outside, 2 inside.
  {
    id:           'crater-flat-traverse-b',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Oval rim ring — decorative non-blocked, frame 13 = rim tile
      // Approximate oval 20×14 centred at (48, 32)
      // Top and bottom arcs
      { tx: 38, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 40, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 42, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 44, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 46, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 48, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 50, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 52, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 54, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 56, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 58, ty: 25, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 38, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 40, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 42, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 44, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 46, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 48, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 50, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 52, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 54, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 56, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 58, ty: 38, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      // Side arcs
      { tx: 36, ty: 27, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 36, ty: 29, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 36, ty: 31, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 36, ty: 33, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 36, ty: 35, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 27, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 29, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 31, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 33, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 35, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      // Boulder clusters outside the oval
      { tx: 16, ty: 14, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 14, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 15, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 15, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 72, ty: 44, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 73, ty: 44, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 72, ty: 45, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 73, ty: 45, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 48, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 49, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 49, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 78, ty: 18, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 79, ty: 18, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 78, ty: 19, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 79, ty: 19, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 30, type: 'enemy' },  // outside oval
      { id: 'e1', tx: 76, ty: 32, type: 'enemy' },  // outside oval
      { id: 'e2', tx: 44, ty: 30, type: 'enemy' },  // inside oval
      { id: 'e3', tx: 52, ty: 33, type: 'enemy' },  // inside oval
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-traverse-c ──────────────────────────────────────────────────
  // 64×80. Two parallel east-west boulder ridges at 1/3 and 2/3 depth with 6-tile
  // central gaps. Forces funnel movement. 4 enemy markers exploiting chokepoints.
  {
    id:           'crater-flat-traverse-c',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-basin'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // First ridge at ty=26 — full width minus 6-tile gap centred at tx=29-34
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i, ty: 26, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i + 35, ty: 26, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Second ridge at ty=53
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i, ty: 53, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i + 35, ty: 53, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Glows at gap centres
      { tx: 31, ty: 26, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 31, ty: 53, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 18, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 18, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 62, type: 'enemy' },
      { id: 'e3', tx: 50, ty: 62, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-traverse-d ──────────────────────────────────────────────────
  // 80×80. Central impact scar — 12×8 visual marker (darker tint, frame 0). Boulder
  // clusters ring the scar at distance. 3 enemy markers around scar perimeter.
  {
    id:           'crater-flat-traverse-d',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-scar'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 80; ty++)
        for (let tx = 0; tx < 80; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // Impact scar — darker tint overlay tiles (non-blocked, depth 1)
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 12 }, (_, tx) =>
          ({ tx: tx + 34, ty: ty + 36, frame: 0, tint: 0x606080, depth: 1 })
        )
      ).flat(),
      // Boulder ring around scar
      { tx: 28, ty: 34, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 34, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 35, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 35, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 34, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 34, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 35, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 35, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 46, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 46, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 47, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 47, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 46, ty: 46, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 46, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 46, ty: 47, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 47, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 22, ty: 40, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-traverse-e ──────────────────────────────────────────────────
  // 96×80. Asymmetric boulder distribution — heavy west cluster, open east.
  // Single large 3×3 boulder disrupts the eastern lane. 4 enemy markers.
  {
    id:           'crater-flat-traverse-e',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // Heavy west cluster — 7 boulders in west 30 tiles
      { tx: 4,  ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4,  ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 28, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 28, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 29, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 29, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 42, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 42, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 43, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 43, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 54, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 54, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 55, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 55, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 64, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 64, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 65, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 65, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 18, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 18, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 19, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 19, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 70, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 70, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 71, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 71, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Single large 3×3 boulder disrupting east lane
      { tx: 66, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 67, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 36, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 66, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 67, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 37, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 66, ty: 38, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 67, ty: 38, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 38, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 60, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 76, ty: 50, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 60, type: 'enemy' },
      { id: 'e3', tx: 84, ty: 30, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-traverse-f ──────────────────────────────────────────────────
  // 80×64. Dust plain with shallow east-west trench — 3 gaps of 4 tiles each,
  // evenly spaced. Enemies visible beyond trench. 4 enemy markers.
  {
    id:           'crater-flat-traverse-f',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-ridge'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Trench wall at ty=32 — 3 gaps of 4 tiles at tx=12-15, tx=38-41, tx=64-67
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i + 16, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i + 42, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i + 68, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Glows at gaps
      { tx: 13, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 39, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 65, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 50, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 50, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 16, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-traverse-g ──────────────────────────────────────────────────
  // 64×64. Dense boulder field on west half; east half open. 3 enemy markers
  // on open east side. 1 mineral marker tucked in west boulder field.
  {
    id:           'crater-flat-traverse-g',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West boulder field — 8 formations in west 28 tiles
      { tx: 4,  ty: 10, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4,  ty: 11, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 11, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 16, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 17, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 17, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 28, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 28, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 29, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 29, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 44, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 44, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 45, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 45, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 52, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 52, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 53, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 53, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 56, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 56, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 57, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 57, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 60, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 60, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 61, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 61, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 44, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 56, type: 'enemy' },
      { id: 'm0', tx: 12, ty: 34, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-traverse-h ──────────────────────────────────────────────────
  // 96×96. Largest traversal. 10–12 scattered 1×1 boulders. Two faint glow sources
  // at NE and SW quadrants. 4 enemy markers, widely spaced. Exhale room.
  {
    id:           'crater-flat-traverse-h',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-scar'],
    type:         'standard',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 96),
    structures: [
      // 10 scattered 1×1 boulders
      { tx: 8,  ty: 14, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 72, ty: 18, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 84, ty: 10, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 44, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 38, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 80, ty: 50, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 68, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 60, ty: 72, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 82, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Two faint glow sources
      { tx: 72, ty: 16, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 24, ty: 72, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 76, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 68, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 72, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-traverse-i ──────────────────────────────────────────────────
  // 80×64. Three east-west lanes via two boulder ridges, gaps offset (west on first,
  // east on second) creating a slalom. 5 enemy markers.
  {
    id:           'crater-flat-traverse-i',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // First ridge at ty=21 — gap on west side (tx=4-7)
      ...Array.from({ length: 4 }, (_, i) =>
        ({ tx: i, ty: 21, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 72 }, (_, i) =>
        ({ tx: i + 8, ty: 21, frame: i < 36 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Second ridge at ty=42 — gap on east side (tx=72-75)
      ...Array.from({ length: 72 }, (_, i) =>
        ({ tx: i, ty: 42, frame: i < 36 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        ({ tx: i + 76, ty: 42, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2,  ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 76, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-traverse-j ──────────────────────────────────────────────────
  // 64×80. Pre-boss approach terrain. Slightly darker floor. 6-tile rock channel
  // running north-south, widening at faces. 4 enemy markers inside channel.
  {
    id:           'crater-flat-traverse-j',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-mouth'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 80; ty++)
        for (let tx = 0; tx < 64; tx++)
          // Darker tint for the whole room
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // West channel wall
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 24, ty: i + 10, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // East channel wall
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 39, ty: i + 10, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 18, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 36, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-traverse-k ──────────────────────────────────────────────────
  // 80×80. Tilted plain — heavy boulders at south thin out toward north.
  // 4 enemy markers across room. 1 loot marker near south boulders.
  {
    id:           'crater-flat-traverse-k',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Dense south boulders
      { tx: 8,  ty: 58, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 58, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 59, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 59, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 60, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 60, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 61, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 61, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 52, ty: 62, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 53, ty: 62, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 52, ty: 63, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 53, ty: 63, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 56, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 56, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 57, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 57, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Sparse mid boulders
      { tx: 16, ty: 36, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 56, ty: 40, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 44, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Almost nothing at north
      { tx: 20, ty: 10, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 68, type: 'enemy' },
      { id: 'l0', tx: 12, ty: 66, type: 'loot'  },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-traverse-l ──────────────────────────────────────────────────
  // 96×64. Long wide sweep. Central 4×4 angular rock slab landmark. 4 enemy markers
  // flanking formation. 1 mineral at formation's north face.
  {
    id:           'crater-flat-traverse-l',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar', 'crater-flat-mouth'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Central 4×4 angular rock slab (frame 35/36 pattern)
      { tx: 46, ty: 28, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 28, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 28, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 28, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 46, ty: 29, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 29, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 29, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 29, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 46, ty: 30, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 30, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 30, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 30, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 46, ty: 31, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 47, ty: 31, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 31, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 31, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 28, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 48, type: 'enemy' },
      { id: 'm0', tx: 48, ty: 26, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── crater-flat-combat-a ────────────────────────────────────────────────────
  // 64×64. Four 3×3 boulder clusters at quadrant centres create cross-shaped
  // open lane network. 5 enemy markers — one per lane + one centre.
  {
    id:           'crater-flat-combat-a',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // NW quadrant 3×3 boulder cluster
      { tx: 12, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 12, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 13, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 14, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 14, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 14, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // NE quadrant
      { tx: 48, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 12, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 13, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 14, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 14, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 14, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // SW quadrant
      { tx: 12, ty: 48, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 48, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 49, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 49, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 49, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 50, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 50, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 50, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // SE quadrant
      { tx: 48, ty: 48, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 48, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 49, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 49, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 49, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 50, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 50, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 50, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 8,  type: 'enemy' },  // north lane
      { id: 'e1', tx: 8,  ty: 32, type: 'enemy' },  // west lane
      { id: 'e2', tx: 56, ty: 32, type: 'enemy' },  // east lane
      { id: 'e3', tx: 32, ty: 56, type: 'enemy' },  // south lane
      { id: 'e4', tx: 32, ty: 32, type: 'enemy' },  // centre
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-combat-b ────────────────────────────────────────────────────
  // 48×64. Ambush room — narrow south entry opens east dramatically. Two parallel
  // east-west boulder ridges. E connection. 6 enemy markers — 3 behind each ridge.
  {
    id:           'crater-flat-combat-b',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 47, ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // First ridge at ty=20
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 20, frame: i < 24 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Second ridge at ty=44
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 44, frame: i < 24 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 10, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 54, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 54, type: 'enemy' },
      { id: 'e5', tx: 40, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-combat-c ────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. W branch. North-south boulder ridges create
  // vertical lanes. W connection. 6 enemy markers.
  {
    id:           'crater-flat-combat-c',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // North-south ridge at tx=20
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 20, ty: i, frame: i < 32 ? 21 : 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // North-south ridge at tx=44
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 44, ty: i, frame: i < 32 ? 22 : 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 16, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 16, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 48, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 48, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-combat-d ────────────────────────────────────────────────────
  // 80×64. Pincer room. Two 4×4 boulder formations flank north passage leaving
  // 6-tile central gap. 5 enemy markers clustered north of formations.
  {
    id:           'crater-flat-combat-d',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-ridge'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West flanking formation 4×4 at (28, 8)
      { tx: 28, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 10, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 10, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 10, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 10, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // East flanking formation 4×4 at (48, 8)
      { tx: 48, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 51, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 51, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 10, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 10, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 10, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 51, ty: 10, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 48, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 49, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 51, ty: 11, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 4, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 4, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 4, type: 'enemy' },
      { id: 'e3', tx: 44, ty: 4, type: 'enemy' },
      { id: 'e4', tx: 56, ty: 4, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-combat-e ────────────────────────────────────────────────────
  // 64×80. Full-width east-west rock wall at 2/3 depth with single 4-tile central
  // gap. 6 enemy markers in dense formation north of the wall. Glow on north side.
  {
    id:           'crater-flat-combat-e',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Wall at ty=52 — gap at tx=30-33
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i, ty: 52, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i + 34, ty: 52, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Glow north side of wall
      { tx: 32, ty: 48, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 20, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 48, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-combat-f ────────────────────────────────────────────────────
  // 80×80. Crater rim fight — approximate arc of blocked structures at 2/3 depth,
  // convex toward south, 3 penetration points. 6 enemy markers behind arc.
  {
    id:           'crater-flat-combat-f',
    zone_act:     1,
    region_types: ['crater-flat-ridge', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Arc segments — western arm
      { tx: 4,  ty: 52, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 12, ty: 48, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 16, ty: 46, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 20, ty: 44, frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 24, ty: 43, frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Gap 1 at tx=28-31
      // Central section
      { tx: 32, ty: 42, frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 36, ty: 42, frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Gap 2 at tx=40-43
      // Eastern arm
      { tx: 44, ty: 42, frame: 29, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 48, ty: 43, frame: 29, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 52, ty: 44, frame: 29, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 56, ty: 46, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 60, ty: 48, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 64, ty: 50, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Gap 3 at tx=68-71
      { tx: 72, ty: 52, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 76, ty: 52, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 18, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 68, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 40, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-combat-g ────────────────────────────────────────────────────
  // 64×64. Four-way junction combat. Open centre. Blocked formations flank each
  // connection entry creating pinch points. 6 enemy markers at centre.
  {
    id:           'crater-flat-combat-g',
    zone_act:     1,
    region_types: ['crater-flat-basin', 'crater-flat-ridge'],
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
      // North pinch flanks
      { tx: 24, ty: 4, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 4, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 4, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 4, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // South pinch flanks
      { tx: 24, ty: 59, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 59, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 59, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 59, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // East pinch flanks
      { tx: 59, ty: 24, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 59, ty: 25, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 59, ty: 38, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 59, ty: 39, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // West pinch flanks
      { tx: 4, ty: 24, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4, ty: 25, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4, ty: 38, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4, ty: 39, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-combat-h ────────────────────────────────────────────────────
  // 48×48. Dense close-quarters — tight 3×3 grid of single-boulder obstacles
  // at 8-tile spacing. 6 enemy markers woven between. Deliberately claustrophobic.
  {
    id:           'crater-flat-combat-h',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // 3×3 grid of single boulders at 8-tile spacing (inner 3×3 of 5×5 grid)
      { tx: 8,  ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 8,  frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 24, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 24, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 24, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 24, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 32, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 32, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 32, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 32, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 32, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 28, type: 'enemy' },
      { id: 'e3', tx: 36, ty: 28, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-combat-i ────────────────────────────────────────────────────
  // 80×64. Three angular formations in triangular kill zone. 6 enemy markers at
  // triangle vertices. Strong glow (radius 64) suggesting boss proximity.
  {
    id:           'crater-flat-combat-i',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar', 'crater-flat-mouth'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Formation A — south-west vertex
      { tx: 12, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Formation B — north vertex
      { tx: 38, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Formation C — south-east vertex
      { tx: 64, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 66, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 67, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 64, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 66, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 67, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Central glow
      { tx: 40, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 36, type: 'enemy' },
      { id: 'e1', tx: 18, ty: 44, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 44, ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 62, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 70, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-combat-j ────────────────────────────────────────────────────
  // 96×80. Final combat room. Maximum enemy density (6) + boulder density (12
  // formations). No clear lanes. Glows at every cluster. Chaotic.
  {
    id:           'crater-flat-combat-j',
    zone_act:     1,
    region_types: ['crater-flat-mouth', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // 12 scattered 2×2 formations
      { tx: 8,  ty: 10, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 28, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 56, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 57, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 56, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 57, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 80, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 81, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 80, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 81, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 44, ty: 34, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 45, ty: 34, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 44, ty: 35, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 45, ty: 35, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 33, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 33, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 88, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 89, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 88, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 89, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 60, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 60, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 61, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 61, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 62, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 37, ty: 62, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 63, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 37, ty: 63, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 64, ty: 60, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 60, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 64, ty: 61, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 61, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Glows at every cluster
      { tx: 9,  ty: 10, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 29, ty: 8,  frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 57, ty: 12, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 81, ty: 8,  frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 17, ty: 36, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 45, ty: 34, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 68, type: 'enemy' },
      { id: 'e5', tx: 80, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── crater-flat-dead-a ──────────────────────────────────────────────────────
  // 32×32. Shallow natural alcove. Small boulder cluster at back. 1 loot, 1 mineral.
  {
    id:           'crater-flat-dead-a',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-basin'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 13, ty: 4, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 4, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 13, ty: 5, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 5, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 16, ty: 12, type: 'loot'    },
      { id: 'm0', tx: 16, ty: 20, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-dead-b ──────────────────────────────────────────────────────
  // 48×48. Collapsed crater edge. Irregular blocked structures on east and north
  // suggesting collapse. 2 loot, 1 mineral, 1 enemy.
  {
    id:           'crater-flat-dead-b',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Collapsed east edge
      { tx: 40, ty: 8,  frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 42, ty: 12, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 44, ty: 18, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 44, ty: 24, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Collapsed north rubble
      { tx: 8,  ty: 4,  frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 16, ty: 6,  frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 24, ty: 4,  frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 32, ty: 6,  frame: 29, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 12, ty: 20, type: 'loot'    },
      { id: 'l1', tx: 28, ty: 16, type: 'loot'    },
      { id: 'm0', tx: 12, ty: 36, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-dead-c ──────────────────────────────────────────────────────
  // 32×48. Narrow north-pointing finger. Mineral vein along north wall — 3 markers.
  // 1 loot. No enemies. Reward for thorough exploration.
  {
    id:           'crater-flat-dead-c',
    zone_act:     1,
    region_types: ['crater-flat-basin', 'crater-flat-ridge'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Narrow walls define the finger
      { tx: 0,  ty: 8,  frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 31, ty: 8,  frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 0,  ty: 16, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 31, ty: 16, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
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

  // ── crater-flat-dead-d ──────────────────────────────────────────────────────
  // 48×32. Wide shallow alcove. Large 3×3 angular boulder dominates space.
  // Loot behind boulder. 2 mineral flanking. 1 enemy sentry.
  {
    id:           'crater-flat-dead-d',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-scar'],
    type:         'dead-end',
    size:         { w: 48, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 31 },
    ],
    tiles: floor(48, 32),
    structures: [
      // Large 3×3 angular boulder
      { tx: 20, ty: 4, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 4, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 4, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 5, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 5, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 5, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 6, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 6, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 6, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 18, type: 'enemy'   },
      { id: 'l0', tx: 21, ty: 10, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 8,  type: 'mineral' },
      { id: 'm1', tx: 38, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-dead-e ──────────────────────────────────────────────────────
  // 32×32. Meteorite fragment resting site — 2×2 glassy decorative structure.
  // 2 loot markers around fragment. No combat.
  {
    id:           'crater-flat-dead-e',
    zone_act:     1,
    region_types: ['crater-flat-basin', 'crater-flat-deep'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Meteorite fragment — 2×2 decorative non-blocked, high depth
      { tx: 14, ty: 8, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 15, ty: 8, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 14, ty: 9, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 15, ty: 9, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      // Faint glow at fragment
      { tx: 14, ty: 8, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 10, ty: 18, type: 'loot' },
      { id: 'l1', tx: 22, ty: 18, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-dead-f ──────────────────────────────────────────────────────
  // 48×48. Geologic vent pocket — 2×2 blocked vent at centre with glow.
  // 2 loot, 2 mineral. 2 enemies guarding the vent.
  {
    id:           'crater-flat-dead-f',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central vent — 2×2 blocked
      { tx: 22, ty: 18, frame: 28, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 23, ty: 18, frame: 29, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 22, ty: 19, frame: 35, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 23, ty: 19, frame: 36, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Glow at vent
      { tx: 22, ty: 18, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 28, type: 'enemy'   },
      { id: 'e1', tx: 36, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 10, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 10, type: 'loot'    },
      { id: 'm0', tx: 10, ty: 38, type: 'mineral' },
      { id: 'm1', tx: 36, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-dead-g ──────────────────────────────────────────────────────
  // 32×48. Narrow alcove leading to dense mineral deposit. 4 mineral at north.
  // 1 loot, 1 enemy. Late-zone mineral reward.
  {
    id:           'crater-flat-dead-g',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 16, ty: 36, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 14, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 20, ty: 6,  type: 'mineral' },
      { id: 'm3', tx: 26, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-dead-h ──────────────────────────────────────────────────────
  // 48×48. Richest dead-end. 3 loot, 3 mineral, 3 enemies. Risk/reward explicit.
  {
    id:           'crater-flat-dead-h',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-mouth'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // North wall defining the back of the vault
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 24 ? 21 : 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      { tx: 22, ty: 10, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
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

  // ── crater-flat-junction-a ──────────────────────────────────────────────────
  // 64×64. Standard eastern branch. Large 3×3 central boulder. E exit mid-depth.
  {
    id:           'crater-flat-junction-a',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      { tx: 29, ty: 29, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 29, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 29, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 30, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 29, ty: 31, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 30, ty: 31, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 31, ty: 31, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-junction-b ──────────────────────────────────────────────────
  // 64×64. Mirror of junction-a. Western branch. W exit mid-depth.
  {
    id:           'crater-flat-junction-b',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      { tx: 32, ty: 29, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 29, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 34, ty: 29, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 30, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 34, ty: 30, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 31, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 31, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 34, ty: 31, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 50, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-junction-c ──────────────────────────────────────────────────
  // 80×64. Full cross. Four 2×2 boulder clusters at four quadrant corners.
  // All passages clear. 3 enemy markers at centre.
  {
    id:           'crater-flat-junction-c',
    zone_act:     1,
    region_types: ['crater-flat-basin', 'crater-flat-ridge', 'crater-flat-deep'],
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
      // NW corner
      { tx: 8,  ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // NE corner
      { tx: 70, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 70, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // SW corner
      { tx: 8,  ty: 54, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 54, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 55, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 55, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // SE corner
      { tx: 70, ty: 54, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 54, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 70, ty: 55, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 55, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── crater-flat-junction-d ──────────────────────────────────────────────────
  // 64×80. Crater-rim junction. Curved blocked formation on west edge with east
  // and north exits feeling like descent from rim. 3 enemy markers.
  {
    id:           'crater-flat-junction-d',
    zone_act:     1,
    region_types: ['crater-flat-ridge', 'crater-flat-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Rim formation on west
      { tx: 0, ty: 16, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 0, ty: 24, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 0, ty: 32, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 0, ty: 40, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 0, ty: 48, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 4, ty: 12, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 4, ty: 56, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-junction-e ──────────────────────────────────────────────────
  // 64×64. Boulder field junction. Dense scatter in west half. W exit cuts through.
  // North passage clear. 3 enemy markers.
  {
    id:           'crater-flat-junction-e',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-basin'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Dense west boulders
      { tx: 4,  ty: 12, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 12, ty: 16, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 24, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 40, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4,  ty: 48, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 52, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 44, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-junction-f ──────────────────────────────────────────────────
  // 80×64. Wide junction. Decorative 1×6 ridge running east-west at 1/3 depth.
  // Non-blocked. 3 enemy markers north of ridge.
  {
    id:           'crater-flat-junction-f',
    zone_act:     1,
    region_types: ['crater-flat-field', 'crater-flat-ridge'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // Decorative ridge at ty=20 — non-blocked, visual only
      { tx: 10, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 20, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 30, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 40, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 50, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 60, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
      { tx: 70, ty: 20, frame: 13, tint: TINT_CRATER_RIM, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 10, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── crater-flat-junction-g ──────────────────────────────────────────────────
  // 64×64. Late-zone grid junction. Higher rock density than junction-c.
  // All passages maintained. 4 enemy markers.
  {
    id:           'crater-flat-junction-g',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar'],
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
      // 6–8 scattered boulders away from passage lanes
      { tx: 10, ty: 10, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 10, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 50, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 50, ty: 50, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 18, ty: 20, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 44, ty: 40, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 18, ty: 44, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 44, ty: 20, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
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

  // ── crater-flat-junction-h ──────────────────────────────────────────────────
  // 80×80. Large deep junction. Prominent 4×4 central formation with glow.
  // All exits wide. 4 enemy markers flanking the formation.
  {
    id:           'crater-flat-junction-h',
    zone_act:     1,
    region_types: ['crater-flat-deep', 'crater-flat-scar', 'crater-flat-mouth'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Central 4×4 formation
      { tx: 38, ty: 38, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 38, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 38, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 38, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 39, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 39, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 39, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 39, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 40, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 40, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 40, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 40, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 38, ty: 41, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 39, ty: 41, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 41, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 41, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Glow
      { tx: 40, ty: 39, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
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

  // ── crater-flat-approach-a ──────────────────────────────────────────────────
  // 80×80. Terrain closes in. Boulder density highest. Narrow 8-tile open corridor
  // winds N-S through dense rock. 5 enemy markers. 3 glow sources along walls.
  {
    id:           'crater-flat-approach-a',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Dense boulder walls flanking narrow central corridor (tx 36-43)
      // West wall boulders
      { tx: 4,  ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 4,  ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 5,  ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 16, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 14, ty: 17, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 15, ty: 17, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 28, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 28, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 6,  ty: 29, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 7,  ty: 29, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 40, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 40, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 41, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 41, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 56, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 56, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 57, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 57, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // East wall boulders
      { tx: 68, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 68, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 69, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 56, ty: 24, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 57, ty: 24, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 56, ty: 25, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 57, ty: 25, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 64, ty: 44, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 44, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 64, ty: 45, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 65, ty: 45, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 72, ty: 60, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 73, ty: 60, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 72, ty: 61, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 73, ty: 61, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Glow sources along corridor walls
      { tx: 36, ty: 20, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 44, ty: 44, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 36, ty: 64, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
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

  // ── crater-flat-approach-b ──────────────────────────────────────────────────
  // 96×64. Three parallel E-W boulder ridges, gaps non-aligned — serpentine forced
  // movement. 6 enemy markers maximising gauntlet. High glow density.
  {
    id:           'crater-flat-approach-b',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Ridge 1 at ty=16 — gap west (tx=8-13)
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i + 14, ty: 16, frame: i < 41 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Ridge 2 at ty=32 — gap centre (tx=45-50)
      ...Array.from({ length: 45 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 45 }, (_, i) =>
        ({ tx: i + 51, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Ridge 3 at ty=48 — gap east (tx=82-87)
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i, ty: 48, frame: i < 41 ? 28 : 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 88, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true })
      ),
      // Glows at gap centres
      { tx: 10,  ty: 16, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 48,  ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 84,  ty: 48, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10,  ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 80,  ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24,  ty: 24, type: 'enemy' },
      { id: 'e3', tx: 72,  ty: 24, type: 'enemy' },
      { id: 'e4', tx: 10,  ty: 56, type: 'enemy' },
      { id: 'e5', tx: 84,  ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-approach-c ──────────────────────────────────────────────────
  // 80×96. Long approach. Narrows from 80 tiles south to 20 tiles north via
  // stepped boulder formations. 6 enemy markers in the narrowing.
  {
    id:           'crater-flat-approach-c',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'standard',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 96),
    structures: [
      // West wall stepping in — 5 steps
      { tx: 0,  ty: 20, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 8,  ty: 36, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 16, ty: 52, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 24, ty: 68, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 28, ty: 80, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // East wall stepping in
      { tx: 79, ty: 20, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 71, ty: 36, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 63, ty: 52, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 55, ty: 68, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 51, ty: 80, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Glows along funnel
      { tx: 30, ty: 30, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 50, ty: 60, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 40, ty: 84, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 56, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 56, type: 'enemy' },
      { id: 'e4', tx: 36, ty: 76, type: 'enemy' },
      { id: 'e5', tx: 44, ty: 76, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-approach-d ──────────────────────────────────────────────────
  // 96×80. Open-plan approach. 12 boulder clusters in two arcing rows converging
  // on north exit. 5 enemy markers between arcs. Strong glow along arcs.
  {
    id:           'crater-flat-approach-d',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // West arc — 6 boulders converging toward north centre
      { tx: 8,  ty: 64, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 64, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 65, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 65, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 48, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 16, ty: 49, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 17, ty: 49, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 33, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 33, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 16, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 32, ty: 17, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 33, ty: 17, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 37, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 36, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 37, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 4,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 4,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 40, ty: 5,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 41, ty: 5,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // East arc — mirror
      { tx: 86, ty: 64, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 87, ty: 64, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 86, ty: 65, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 87, ty: 65, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 78, ty: 48, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 79, ty: 48, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 78, ty: 49, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 79, ty: 49, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 70, ty: 32, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 32, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 70, ty: 33, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 71, ty: 33, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 62, ty: 16, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 63, ty: 16, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 62, ty: 17, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 63, ty: 17, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 58, ty: 8,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 59, ty: 8,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 58, ty: 9,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 59, ty: 9,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 54, ty: 4,  frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 55, ty: 4,  frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 54, ty: 5,  frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 55, ty: 5,  frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // Arc glows
      { tx: 17, ty: 48, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 25, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 79, ty: 48, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 71, ty: 32, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 60, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 72, ty: 60, type: 'enemy' },
      { id: 'e3', tx: 36, ty: 36, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS ARENAS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── crater-flat-boss-a ──────────────────────────────────────────────────────
  // 96×96. Massive circular impact basin. Four radial rock ridges divide into
  // quadrants. Central 4×4 meteor fragment at dead centre. 6 enemy markers at
  // quadrant midpoints. Strong central glow.
  {
    id:           'crater-flat-boss-a',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // Central meteor fragment — 4×4 non-blocked decorative
      { tx: 46, ty: 46, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 47, ty: 46, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 48, ty: 46, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 49, ty: 46, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 46, ty: 47, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 47, ty: 47, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 48, ty: 47, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 49, ty: 47, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 46, ty: 48, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 47, ty: 48, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 48, ty: 48, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 49, ty: 48, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 46, ty: 49, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 47, ty: 49, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 48, ty: 49, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      { tx: 49, ty: 49, frame: 7, tint: TINT_CRATER_DETAIL, depth: 6 },
      // Central glow
      { tx: 48, ty: 48, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      // Four radial ridges — north, south, east, west — 1×12 each
      // North ridge
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 48, ty: i + 12, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // South ridge
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 48, ty: i + 72, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // West ridge
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i + 12, ty: 48, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // East ridge
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i + 72, ty: 48, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 72, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 72, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 16, type: 'enemy' },
      { id: 'e5', tx: 16, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-boss-b ──────────────────────────────────────────────────────
  // 80×80. Shallower impact bowl. Continuous ring of blocked 1-tile-high structures
  // at radius 24 with 4 gaps of 6 tiles at cardinal points. Boss spawns inside ring.
  // 6 enemy markers inside ring. External approach is clear.
  {
    id:           'crater-flat-boss-b',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Ring at radius 24 from centre (40, 40) — 4 cardinal gaps of 6 tiles
      // North arc (ty=16) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 16, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 16, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // South arc (ty=64) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 64, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 64, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // West side (tx=16) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 17, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 43, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // East side (tx=64) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 17, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 43, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // Central glow
      { tx: 40, ty: 40, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
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

  // ── crater-flat-boss-c ──────────────────────────────────────────────────────
  // 96×80. Asymmetric impact site — crater shifted east. Heavy boulders west,
  // light east. Boss spawns at east-centre lowest point. 4 boulder formations west.
  // 6 enemy markers.
  {
    id:           'crater-flat-boss-c',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Heavy boulder cover on west side — 4 large formations
      { tx: 8,  ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 12, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 12, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 13, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 13, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 14, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 14, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 14, frame: 21, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 14, frame: 22, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 15, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 15, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 15, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 15, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 36, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 36, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 20, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 21, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 22, ty: 37, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 23, ty: 37, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 56, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 56, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 56, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 56, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 8,  ty: 57, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 9,  ty: 57, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 10, ty: 57, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 11, ty: 57, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 64, frame: 28, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 64, frame: 29, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 24, ty: 65, frame: 35, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 25, ty: 65, frame: 36, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      // East crater marker — lowest point
      { tx: 68, ty: 38, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 60, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 80, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 84, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 60, type: 'enemy' },
      { id: 'e5', tx: 80, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── crater-flat-boss-d ──────────────────────────────────────────────────────
  // 80×96. Double-crater figure-eight. South crater is entry space; north crater
  // is boss territory. 6-tile chokepoint connection. Boss spawns north. Most
  // dramatic layout in the zone.
  {
    id:           'crater-flat-boss-d',
    zone_act:     1,
    region_types: ['crater-flat-mouth'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // South crater rim — incomplete circle, open south
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 60, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 60, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      // South crater sides
      { tx: 4,  ty: 68, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 4,  ty: 76, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 68, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 76, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // Chokepoint walls — narrows to 6 tiles at mid-room
      { tx: 4,  ty: 44, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 4,  ty: 52, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 8,  ty: 40, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 16, ty: 36, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 28, ty: 33, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 44, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 52, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 71, ty: 40, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 63, ty: 36, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 51, ty: 33, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // North crater rim — boss territory, open north
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 30, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 30, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      { tx: 4,  ty: 16, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 4,  ty: 22, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 16, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      { tx: 75, ty: 22, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true },
      // North and south crater glows
      { tx: 40, ty: 20, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
      { tx: 40, ty: 76, frame: 7, tint: TINT_CRATER_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 16, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── crater-flat-connector-a ─────────────────────────────────────────────────
  // 16×24. Minimal dust path. No structures. Brief transition.
  {
    id:           'crater-flat-connector-a',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-basin', 'crater-flat-ridge', 'crater-flat-scar', 'crater-flat-deep', 'crater-flat-mouth'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── crater-flat-connector-b ─────────────────────────────────────────────────
  // 24×16. Wide but shallow. Two small boulders flanking. Visual breathing room.
  {
    id:           'crater-flat-connector-b',
    zone_act:     1,
    region_types: ['crater-flat-approach', 'crater-flat-field', 'crater-flat-basin', 'crater-flat-ridge', 'crater-flat-scar', 'crater-flat-deep', 'crater-flat-mouth'],
    type:         'connector',
    size:         { w: 24, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 16),
    structures: [
      { tx: 4,  ty: 6, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
      { tx: 18, ty: 6, frame: 14, tint: TINT_CRATER_ROCK, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── crater-flat-connector-c ─────────────────────────────────────────────────
  // 16×32. Narrow rock channel — 1-tile blocked walls on east and west edges
  // for full length. 8-tile wide passage between walls. No enemies.
  {
    id:           'crater-flat-connector-c',
    zone_act:     1,
    region_types: ['crater-flat-ridge', 'crater-flat-scar', 'crater-flat-deep', 'crater-flat-mouth'],
    type:         'connector',
    size:         { w: 16, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 22, tint: TINT_CRATER_RIM, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── crater-flat-connector-d ─────────────────────────────────────────────────
  // 24×24. Junction stub. One decorative rock tile at centre.
  {
    id:           'crater-flat-connector-d',
    zone_act:     1,
    region_types: ['crater-flat-ridge', 'crater-flat-scar', 'crater-flat-deep', 'crater-flat-mouth'],
    type:         'connector',
    size:         { w: 24, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 24),
    structures: [
      { tx: 12, ty: 11, frame: 14, tint: TINT_CRATER_DETAIL, depth: 3 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z0

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z0: RegionDef[] = [
  {
    id:             'crater-flat-approach',
    label:          'Crater Flat — Open Approach',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-field',
    label:          'Crater Flat — Crater Field',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   8,
    corridor_max:   14,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-basin',
    label:          'Crater Flat — Dust Basin',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   6,
    corridor_max:   10,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-ridge',
    label:          'Crater Flat — Rock Ridge',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-scar',
    label:          'Crater Flat — Ancient Scar Approach',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   8,
    corridor_max:   14,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-deep',
    label:          'Crater Flat — Deep Geology',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   6,
    corridor_max:   10,
    tint:           TINT_CRATER_FLOOR,
  },
  {
    id:             'crater-flat-mouth',
    label:          'Crater Flat — Crater Mouth',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   6,
    corridor_max:   10,
    tint:           TINT_CRATER_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionApproach,
  regionField,
  regionBasin,
  regionRidge,
  regionScar,
  regionDeep,
  regionMouth,
] = REGIONS_A1Z0;

export const ZONE_A1Z0: ZoneDef = {
  id:           'crater-flat',
  label:        'Crater Flat',
  zone_act:     1,
  region_defs:  [
    regionApproach,
    regionField,
    regionBasin,
    regionRidge,
    regionScar,
    regionDeep,
    regionMouth,
  ],
  enemy_flavour: 'scavengers',
  tint:          TINT_CRATER_FLOOR,
};
