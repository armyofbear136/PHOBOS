/**
 * Act I — Zone 3 — CALDERA RING
 * Archetype index: 3
 * Tint: 0xa05030 (burnt orange-red)
 * Enemy flavour: ring-walkers
 *
 * An ancient volcanic caldera rim. Ring-walkers exploit circular terrain — they orbit,
 * flank, and never approach in straight lines. Rooms are curved or angular to facilitate
 * this. Palette is hot: burnt orange, deep red, lava-glow amber. The caldera wall looms
 * throughout. Scale is large — a significant geological feature.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_CALD_FLOOR: number = 0xa05030;  // burnt orange rock
const TINT_CALD_WALL:  number = 0x7a3018;  // deep caldera wall
const TINT_CALD_LAVA:  number = 0x3a1a0a;  // cooled lava surface
const TINT_CALD_HOT:   number = 0xff6020;  // heat-glow orange
const TINT_CALD_GLOW:  number = 0xff4400;  // intense orange-red volcanic glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z3: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── caldera-traverse-a ──────────────────────────────────────────────────────
  // 80×64. Exterior approach. Caldera wall visible on east — 3-tile-wide full
  // height blocked formation TINT_CALD_WALL. West side open. Passage along west.
  // 3 ring-walker markers in loose circling triangle.
  {
    id:           'caldera-traverse-a',
    zone_act:     1,
    region_types: ['caldera-ring-approach'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // East caldera wall — 3 tiles wide, full height
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 77, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-traverse-b ──────────────────────────────────────────────────────
  // 96×80. Broad rim traverse. Concave arc of wall structures along north edge,
  // 2-tile-wide blocked, concave toward south. Player traverses arc interior. 4 markers.
  {
    id:           'caldera-traverse-b',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // Concave arc along north edge — approximate arc with two wall rows
      // Outer arc row at ty=4
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 4, frame: i < 48 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Inner arc row at ty=5
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 5, frame: i < 48 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Arc sag — deepens the concave centre by extending south at mid-width
      { tx: 44, ty: 6, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 45, ty: 6, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 6, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 6, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 6, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 49, ty: 6, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 7, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 49, ty: 7, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      // Glow along arc interior
      { tx: 24, ty: 8, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 48, ty: 10, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 72, ty: 8, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 80, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-traverse-c ──────────────────────────────────────────────────────
  // 80×80. Exposed lava channel crossing. 6-tile-wide darker floor strip (TINT_CALD_LAVA)
  // E-W at mid-depth. Non-blocked, with 2 glow sources at east and west ends.
  // Ring-walkers anchor on the strip. 4 enemy markers.
  {
    id:           'caldera-traverse-c',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Lava channel strip at ty=37-42, non-blocked, depth 1
      ...Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 80 }, (_, tx) =>
          ({ tx, ty: row + 37, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      // Glow at east and west ends of channel
      { tx: 2,  ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 77, ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 56, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-traverse-d ──────────────────────────────────────────────────────
  // 64×80. Rim notch. 2-tile-wide wall formations flank both east and west edges
  // full room length — notch is 32 tiles wide. Ring-walkers circle inside notch. 3 markers.
  {
    id:           'caldera-traverse-d',
    zone_act:     1,
    region_types: ['caldera-ring-rim', 'caldera-ring-inner'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall — 2 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // East wall — 2 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Glow along wall faces
      { tx: 2,  ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 61, ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-traverse-e ──────────────────────────────────────────────────────
  // 96×64. Interior shelf. Central lava-cooled formation 6×4 blocked at room centre.
  // Ring-walkers orbit the formation. 4 markers orbiting. One glow at formation centre.
  {
    id:           'caldera-traverse-e',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Central 6×4 lava formation — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 6 }, (_, tx) =>
          ({ tx: tx + 45, ty: ty + 30, frame: tx < 3 ? 28 : 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
        )
      ).flat(),
      // Centre glow
      { tx: 48, ty: 32, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 72, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-traverse-f ──────────────────────────────────────────────────────
  // 80×64. Curving passage. Blocked wall formations step inward from east on south
  // half, from west on north half — creates S-shaped channel. 4 markers in S-curve.
  {
    id:           'caldera-traverse-f',
    zone_act:     1,
    region_types: ['caldera-ring-rim', 'caldera-ring-inner'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // South half — east wall steps inward (tx=56-79, ty=32-63)
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 56, ty: i + 32, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 57, ty: i + 32, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 58, ty: i + 32, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // North half — west wall steps inward (tx=0-23, ty=0-31)
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 21, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 22, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 23, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Glows at bend midpoints
      { tx: 40, ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-traverse-g ──────────────────────────────────────────────────────
  // 64×64. Volcanic outcrop crossing. 5–6 outcroppings (2×2 blocked TINT_CALD_WALL)
  // scattered asymmetrically. Ring-walkers exploit irregular spacing for flanking. 4 markers.
  {
    id:           'caldera-traverse-g',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // 6 asymmetric outcroppings
      { tx: 8,  ty: 10, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 10, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 40, ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 8,  frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 56, ty: 18, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 18, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 19, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 19, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 18, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 14, ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 36, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 37, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 36, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 44, ty: 44, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 45, ty: 44, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 45, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 45, ty: 45, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 44, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 22, ty: 52, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 23, ty: 52, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 53, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 23, ty: 53, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 52, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-traverse-h ──────────────────────────────────────────────────────
  // 96×80. Three parallel lava channels (each 4-tile-wide darker floor strips,
  // non-blocked) E-W across room. Ring-walkers cross freely. 4 markers.
  {
    id:           'caldera-traverse-h',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-descent'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // Three 4-tile-wide lava channels — non-blocked, depth 1
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 96 }, (_, tx) =>
          ({ tx, ty: row + 16, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 96 }, (_, tx) =>
          ({ tx, ty: row + 36, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 96 }, (_, tx) =>
          ({ tx, ty: row + 56, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      // Glow sources in each channel
      { tx: 24, ty: 18, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 72, ty: 18, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 48, ty: 38, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 24, ty: 58, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 72, ty: 58, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 80, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 80, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-traverse-i ──────────────────────────────────────────────────────
  // 80×64. Deep rim traverse. Wall formations close in from both sides — 8-tile
  // central passage. 5 markers in passage. Glow intensifies.
  {
    id:           'caldera-traverse-i',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-floor'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West wall closing in — 32 tiles from west edge
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 32, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 33, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // East wall closing in — 32 tiles from east edge
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Intense glow along passage
      { tx: 40, ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 32, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 50, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 58, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-traverse-j ──────────────────────────────────────────────────────
  // 64×80. Descending traverse. Two lava channel strips with stronger glow at north.
  // 4 markers. 1 mineral in lava channel side-pocket.
  {
    id:           'caldera-traverse-j',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-floor'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // South lava channel at ty=50-53 — lighter glow
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 64 }, (_, tx) =>
          ({ tx, ty: row + 50, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      { tx: 32, ty: 52, frame: 7, tint: TINT_CALD_HOT, depth: 2 },
      // North lava channel at ty=22-25 — stronger glow
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 64 }, (_, tx) =>
          ({ tx, ty: row + 22, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      { tx: 16, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 48, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 12, type: 'enemy'   },
      { id: 'e1', tx: 48, ty: 12, type: 'enemy'   },
      { id: 'e2', tx: 16, ty: 40, type: 'enemy'   },
      { id: 'e3', tx: 48, ty: 64, type: 'enemy'   },
      { id: 'm0', tx: 4,  ty: 52, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-traverse-k ──────────────────────────────────────────────────────
  // 80×80. Late approach. 10 blocked formations of mixed sizes. 5 ring-walker markers.
  // All glow at full intensity.
  {
    id:           'caldera-traverse-k',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // 10 mixed formations with hot glow at each
      { tx: 6,  ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 8,  frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 26, ty: 14, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 27, ty: 14, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 14, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 26, ty: 15, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 27, ty: 15, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 15, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 27, ty: 14, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 56, ty: 10, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 10, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 11, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 11, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 10, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 70, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 22, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 23, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 22, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 12, ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 36, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 37, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 36, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 32, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 32, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 33, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 33, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 32, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 62, ty: 42, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 42, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 43, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 43, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 42, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 8,  ty: 56, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 56, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 57, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 57, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 56, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 32, ty: 58, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 33, ty: 58, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 34, ty: 58, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 32, ty: 59, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 33, ty: 59, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 34, ty: 59, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 33, ty: 58, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 58, ty: 64, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 64, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 65, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 65, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 64, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 60, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-traverse-l ──────────────────────────────────────────────────────
  // 96×64. Final standard traversal. Wall formations both sides leaving 32-tile
  // passage. Dramatic. 5 markers. Orange-red glow full wall length.
  {
    id:           'caldera-traverse-l',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // West wall formation — 32 tiles wide, full height
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // East wall formation
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 93, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 94, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 95, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Orange-red glow along both walls
      { tx: 2,  ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 2,  ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 93, ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 93, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 72, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── caldera-combat-a ────────────────────────────────────────────────────────
  // 64×64. Ring-walker ambush. 6 lava-rock outcroppings at radius 18 create orbital
  // lane. 5 markers — all inside the ring orbiting. Player must enter ring to fight.
  {
    id:           'caldera-combat-a',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // 6 outcroppings at radius 18 from centre (32,32) at 60-degree intervals
      // North
      { tx: 30, ty: 12, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 12, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 13, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 13, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 12, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // NE
      { tx: 46, ty: 20, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 20, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 21, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 21, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 20, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SE
      { tx: 46, ty: 42, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 42, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 43, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 43, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 42, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // South
      { tx: 30, ty: 50, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 50, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 51, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 51, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 50, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SW
      { tx: 14, ty: 42, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 42, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 43, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 43, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 42, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // NW
      { tx: 14, ty: 20, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 20, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 21, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 21, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 20, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-combat-b ────────────────────────────────────────────────────────
  // 64×64. Converging ambush. E branch reinforcement. 5 markers — 3 main, 2 at E entry.
  // Outcrop cover on west.
  {
    id:           'caldera-combat-b',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // West outcrop cover — 3 formations
      { tx: 6,  ty: 12, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 12, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 13, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 13, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 12, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 6,  ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 30, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 6,  ty: 50, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 50, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 51, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 51, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 50, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 22, type: 'enemy' },  // E entry
      { id: 'e4', tx: 56, ty: 42, type: 'enemy' },  // E entry
    ],
    min_room_tier: 0,
  },

  // ── caldera-combat-c ────────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. W branch. Player cover on east. 5 markers.
  {
    id:           'caldera-combat-c',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // East outcrop cover
      { tx: 56, ty: 12, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 12, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 13, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 13, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 12, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 56, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 30, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 56, ty: 50, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 50, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 51, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 51, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 50, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 22, type: 'enemy' },  // W entry
      { id: 'e4', tx: 8,  ty: 42, type: 'enemy' },  // W entry
    ],
    min_room_tier: 0,
  },

  // ── caldera-combat-d ────────────────────────────────────────────────────────
  // 80×64. Orbital chaos. Two concentric outcrop rings — inner at radius 10, outer
  // at radius 20. Ring-walkers orbit both. 6 markers.
  {
    id:           'caldera-combat-d',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Inner ring — 4 outcroppings at radius 10 from centre (40,32)
      // North inner
      { tx: 38, ty: 20, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 20, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 21, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 21, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 20, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // East inner
      { tx: 48, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 49, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 49, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 30, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // South inner
      { tx: 38, ty: 42, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 42, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 43, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 43, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 42, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // West inner
      { tx: 28, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // Outer ring — 4 outcroppings at radius 20
      // North outer
      { tx: 38, ty: 10, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 10, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 11, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 11, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 10, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // East outer
      { tx: 58, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 30, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // South outer
      { tx: 38, ty: 52, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 52, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 53, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 53, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 52, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // West outer
      { tx: 18, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 30, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 18, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 46, type: 'enemy' },
      { id: 'e3', tx: 28, ty: 22, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 22, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-combat-e ────────────────────────────────────────────────────────
  // 64×80. Lava-divide fight. Full E-W blocked lava formation at 2/3 depth with
  // 4-tile gap. Behind it: 6 markers. Ring-walkers pour through gap and orbit.
  {
    id:           'caldera-combat-e',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-descent'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Lava divide at ty=50 — gap at tx=30-33
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i, ty: 50, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i, ty: 51, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i + 34, ty: 50, frame: 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: i + 34, ty: 51, frame: 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      // Intense glow at gap and along formation
      { tx: 16, ty: 50, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 32, ty: 50, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 48, ty: 50, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 20, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 36, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 40, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-combat-f ────────────────────────────────────────────────────────
  // 80×64. Caldera wall fight. Full north face 3-tile-wide blocked with 3 gaps of
  // 4 tiles. Ring-walkers behind wall — 6 markers. Emerge through gaps and orbit.
  {
    id:           'caldera-combat-f',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-descent'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // North face wall — 3 rows deep, three 4-tile gaps at tx=12-15, tx=37-40, tx=64-67
      ...Array.from({ length: 3 }, (_, row) =>
        [
          ...Array.from({ length: 12 }, (_, i) =>
            ({ tx: i, ty: row, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 21 }, (_, i) =>
            ({ tx: i + 16, ty: row, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 23 }, (_, i) =>
            ({ tx: i + 41, ty: row, frame: i < 12 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 12 }, (_, i) =>
            ({ tx: i + 68, ty: row, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // Glow at gaps and along wall
      { tx: 14, ty: 1, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 39, ty: 1, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 66, ty: 1, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 6,  ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 28, ty: 4,  type: 'enemy' },
      { id: 'e2', tx: 52, ty: 4,  type: 'enemy' },
      { id: 'e3', tx: 74, ty: 4,  type: 'enemy' },
      { id: 'e4', tx: 20, ty: 12, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 12, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-combat-g ────────────────────────────────────────────────────────
  // 64×64. Grid hub with orbital ring. 4×4 central lava formation. All exits. 6 markers.
  {
    id:           'caldera-combat-g',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-floor'],
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
      // 4×4 central lava formation — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 30, ty: ty + 30, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 32, ty: 32, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 48, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e5', tx: 12, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-combat-h ────────────────────────────────────────────────────────
  // 48×48. Volcanic throat. 4 outcroppings. Ring-walkers forced into direct engagement.
  // 6 markers. Maximum heat glow.
  {
    id:           'caldera-combat-h',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-floor'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // 4 outcroppings — NE, NW, SE, SW quadrants
      { tx: 8,  ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 8,  frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 36, ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 37, ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 36, ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 37, ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 36, ty: 8,  frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 8,  ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 36, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 37, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 36, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 36, ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 37, ty: 36, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 36, ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 37, ty: 37, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 36, ty: 36, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // Central glow
      { tx: 24, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 34, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 14, ty: 34, type: 'enemy' },
      { id: 'e4', tx: 34, ty: 34, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 12, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-combat-i ────────────────────────────────────────────────────────
  // 80×64. Three-ring formation. Three concentric partial rings of outcroppings,
  // gaps non-aligned. 6 markers one per ring plus boss-tier at centre.
  {
    id:           'caldera-combat-i',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Outer ring (radius ~24) — gap at south
      { tx: 40, ty: 6,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 6,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 7,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 7,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 6,  frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 62, ty: 16, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 16, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 17, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 17, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 16, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 16, ty: 16, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 17, ty: 16, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 17, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 17, ty: 17, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 16, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // Middle ring (radius ~16) — gap at east
      { tx: 40, ty: 14, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 14, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 15, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 41, ty: 15, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 14, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 24, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 25, ty: 22, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 24, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 25, ty: 23, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 24, ty: 22, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // Inner ring (radius ~8) — gap at north
      { tx: 34, ty: 28, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 35, ty: 28, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 34, ty: 29, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 35, ty: 29, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 34, ty: 28, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 46, ty: 28, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 28, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 29, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 29, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 28, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 12, type: 'enemy' },  // outer
      { id: 'e1', tx: 60, ty: 24, type: 'enemy' },  // outer
      { id: 'e2', tx: 40, ty: 20, type: 'enemy' },  // middle
      { id: 'e3', tx: 26, ty: 28, type: 'enemy' },  // middle
      { id: 'e4', tx: 40, ty: 34, type: 'enemy' },  // inner
      { id: 'e5', tx: 40, ty: 24, type: 'enemy' },  // inner
    ],
    min_room_tier: 2,
  },

  // ── caldera-combat-j ────────────────────────────────────────────────────────
  // 80×80. Maximum orbital chaos. 12 outcroppings in irregular orbital clusters.
  // 6 markers. Full volcanic glow at every structure.
  {
    id:           'caldera-combat-j',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // 12 outcroppings with individual glows
      { tx: 8,  ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 8,  frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 28, ty: 12, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 12, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 13, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 13, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 12, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 54, ty: 8,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 8,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 54, ty: 9,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 9,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 54, ty: 8,  frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 68, ty: 20, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 20, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 21, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 21, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 20, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 10, ty: 36, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 36, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 37, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 37, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 36, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 38, ty: 32, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 32, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 33, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 33, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 32, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 60, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 61, ty: 40, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 60, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 61, ty: 41, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 60, ty: 40, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 6,  ty: 56, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 56, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 57, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 57, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 56, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 28, ty: 60, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 60, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 61, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 61, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 60, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 52, ty: 56, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 53, ty: 56, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 52, ty: 57, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 53, ty: 57, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 52, ty: 56, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 68, ty: 62, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 62, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 63, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 63, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 62, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 18, ty: 68, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 68, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 69, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 69, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 68, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 44, ty: 70, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 45, ty: 70, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 71, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 45, ty: 71, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 70, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 18, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 40, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── caldera-dead-a ──────────────────────────────────────────────────────────
  // 32×32. Lava pocket alcove. One cooling lava formation. 1 loot, 1 mineral. Warm glow.
  {
    id:           'caldera-dead-a',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim', 'caldera-ring-inner'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Cooling lava formation — 2×2 non-blocked, depth 2
      { tx: 14, ty: 6, frame: 28, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 15, ty: 6, frame: 29, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 14, ty: 7, frame: 35, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 15, ty: 7, frame: 36, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 14, ty: 6, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 10, ty: 18, type: 'loot'    },
      { id: 'm0', tx: 22, ty: 18, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-dead-b ──────────────────────────────────────────────────────────
  // 48×32. Rim side pocket. Wall formation at north. 2 loot, 1 mineral. 1 ring-walker.
  {
    id:           'caldera-dead-b',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim'],
    type:         'dead-end',
    size:         { w: 48, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 31 },
    ],
    tiles: floor(48, 32),
    structures: [
      // North wall formation
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 24 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 2, frame: 7, tint: TINT_CALD_HOT, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 18, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 16, type: 'loot'    },
      { id: 'l1', tx: 24, ty: 16, type: 'loot'    },
      { id: 'm0', tx: 40, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-dead-c ──────────────────────────────────────────────────────────
  // 32×48. Narrow descent pocket. 3 mineral at base. 1 loot.
  {
    id:           'caldera-dead-c',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      { tx: 0,  ty: 10, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 10, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 0,  ty: 22, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 31, ty: 22, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 6, frame: 7, tint: TINT_CALD_HOT, depth: 2 },
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

  // ── caldera-dead-d ──────────────────────────────────────────────────────────
  // 48×48. Lava shelf alcove. Central lava formation with glow. 2 loot, 1 mineral.
  // 1 ring-walker.
  {
    id:           'caldera-dead-d',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-descent'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central lava formation — 4×4 blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 22, ty: ty + 14, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 24, ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 36, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 10, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 10, type: 'loot'    },
      { id: 'm0', tx: 36, ty: 36, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-dead-e ──────────────────────────────────────────────────────────
  // 32×32. Hot pocket. Intense glow. 2 loot. No combat.
  {
    id:           'caldera-dead-e',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-descent'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Lava strip on floor — non-blocked, depth 1
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 12 }, (_, tx) =>
          ({ tx: tx + 10, ty: row + 10, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      { tx: 16, ty: 12, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 20, type: 'loot' },
      { id: 'l1', tx: 22, ty: 20, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-dead-f ──────────────────────────────────────────────────────────
  // 48×48. Deep vent pocket. Intense lava glow. 2 loot, 2 mineral. 2 ring-walkers.
  {
    id:           'caldera-dead-f',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-floor'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central vent — 2×2 blocked
      { tx: 22, ty: 14, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 23, ty: 14, frame: 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 22, ty: 15, frame: 35, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 23, ty: 15, frame: 36, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 22, ty: 14, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 32, type: 'enemy'   },
      { id: 'e1', tx: 36, ty: 32, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 8,  type: 'loot'    },
      { id: 'l1', tx: 36, ty: 8,  type: 'loot'    },
      { id: 'm0', tx: 10, ty: 40, type: 'mineral' },
      { id: 'm1', tx: 36, ty: 40, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-dead-g ──────────────────────────────────────────────────────────
  // 32×48. Late mineral deposit. 4 mineral, 1 loot, 1 ring-walker.
  {
    id:           'caldera-dead-g',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      { tx: 15, ty: 8, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 16, ty: 36, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 14, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 20, ty: 6,  type: 'mineral' },
      { id: 'm3', tx: 26, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-dead-h ──────────────────────────────────────────────────────────
  // 48×48. Rich guarded caldera pocket. 3 loot, 3 mineral, 3 ring-walkers.
  {
    id:           'caldera-dead-h',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 24 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 6, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
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

  // ── caldera-junction-a ──────────────────────────────────────────────────────
  // 64×64. Eastern rim junction. Central lava outcrop. E exit. 2 ring-walkers.
  {
    id:           'caldera-junction-a',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim', 'caldera-ring-inner'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central 3×3 lava outcrop
      { tx: 28, ty: 28, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 29, ty: 28, frame: 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 30, ty: 28, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 28, ty: 29, frame: 35, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 36, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 30, ty: 29, frame: 35, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-junction-b ──────────────────────────────────────────────────────
  // 64×64. Western rim junction. W exit. 2 ring-walkers.
  {
    id:           'caldera-junction-b',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim', 'caldera-ring-inner'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      { tx: 32, ty: 28, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 33, ty: 28, frame: 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 34, ty: 28, frame: 28, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 32, ty: 29, frame: 35, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 33, ty: 29, frame: 36, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 34, ty: 29, frame: 35, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 33, ty: 30, frame: 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 34, ty: 30, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true },
      { tx: 33, ty: 29, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 50, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-junction-c ──────────────────────────────────────────────────────
  // 80×64. Caldera cross. Four corner lava formations. All passages clear. 3 ring-walkers.
  {
    id:           'caldera-junction-c',
    zone_act:     1,
    region_types: ['caldera-ring-rim', 'caldera-ring-inner', 'caldera-ring-shelf'],
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
      // NW lava formation
      { tx: 6,  ty: 6,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 6,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 7,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 7,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 6,  frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // NE lava formation
      { tx: 72, ty: 6,  frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 73, ty: 6,  frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 7,  frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 73, ty: 7,  frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 6,  frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SW lava formation
      { tx: 6,  ty: 56, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 56, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 57, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 57, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 56, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SE lava formation
      { tx: 72, ty: 56, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 73, ty: 56, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 57, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 73, ty: 57, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 56, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── caldera-junction-d ──────────────────────────────────────────────────────
  // 64×80. Rim descent junction. Caldera wall on west. E exit open toward inner
  // shelf. 3 ring-walkers.
  {
    id:           'caldera-junction-d',
    zone_act:     1,
    region_types: ['caldera-ring-rim', 'caldera-ring-inner'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Caldera wall on west
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 2, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 2, ty: 56, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-junction-e ──────────────────────────────────────────────────────
  // 64×64. Inner wall junction. Lava channel decorative strip. W exit. 3 ring-walkers.
  {
    id:           'caldera-junction-e',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Lava channel strip — non-blocked, depth 1
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 64 }, (_, tx) =>
          ({ tx, ty: row + 30, frame: 0, tint: TINT_CALD_LAVA, depth: 1 })
        )
      ).flat(),
      { tx: 32, ty: 32, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-junction-f ──────────────────────────────────────────────────────
  // 80×64. Wide caldera floor junction. Two concentric outcrops as landmark.
  // E exit. 3 ring-walkers.
  {
    id:           'caldera-junction-f',
    zone_act:     1,
    region_types: ['caldera-ring-shelf', 'caldera-ring-floor'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // Inner outcrop 2×2
      { tx: 38, ty: 30, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 30, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 31, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 39, ty: 31, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 38, ty: 30, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // Outer 4 single fragments
      { tx: 32, ty: 24, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 24, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 32, ty: 38, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 38, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── caldera-junction-g ──────────────────────────────────────────────────────
  // 64×64. Deep grid junction. Dense outcrops, all passages. 4 ring-walkers.
  {
    id:           'caldera-junction-g',
    zone_act:     1,
    region_types: ['caldera-ring-floor', 'caldera-ring-core'],
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
      // Dense outcrops off main passage lanes
      { tx: 10, ty: 10, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 10, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 48, ty: 10, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 10, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 10, ty: 50, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 50, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 48, ty: 50, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 50, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 20, ty: 22, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 22, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 42, ty: 40, frame: 14, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 42, ty: 40, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
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

  // ── caldera-junction-h ──────────────────────────────────────────────────────
  // 80×80. Large inner junction. 4×4 central lava pool formation. Intense glow.
  // 4 ring-walkers.
  {
    id:           'caldera-junction-h',
    zone_act:     1,
    region_types: ['caldera-ring-descent', 'caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // 4×4 central lava pool — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 38, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
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

  // ── caldera-approach-a ──────────────────────────────────────────────────────
  // 80×80. Caldera throat narrowing. Rocky walls close in. 5 ring-walkers orbital.
  {
    id:           'caldera-approach-a',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Closing walls with lava outcroppings
      { tx: 4,  ty: 10, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 11, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 11, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 10, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 14, ty: 24, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 24, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 25, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 25, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 24, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 6,  ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 40, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 41, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 40, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 18, ty: 58, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 58, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 59, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 59, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 58, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 8,  ty: 68, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 68, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 69, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 69, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 68, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      // East side mirror
      { tx: 70, ty: 10, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 10, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 11, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 11, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 10, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 62, ty: 24, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 24, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 25, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 25, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 24, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 68, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 40, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 69, ty: 41, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 68, ty: 40, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 58, ty: 58, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 58, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 59, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 59, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 58, ty: 58, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 70, ty: 68, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 68, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 69, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 69, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 68, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
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

  // ── caldera-approach-b ──────────────────────────────────────────────────────
  // 96×64. Three-stage rim gauntlet. Lava formations at each stage. 6 ring-walkers.
  {
    id:           'caldera-approach-b',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Stage 1 wall at ty=16 — gap at tx=8-13
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i + 14, ty: 16, frame: i < 41 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 10, ty: 16, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      // Stage 2 wall at ty=32 — gap at tx=45-50
      ...Array.from({ length: 45 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 45 }, (_, i) =>
        ({ tx: i + 51, ty: 32, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 48, ty: 32, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      // Stage 3 wall at ty=48 — gap at tx=82-87
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i, ty: 48, frame: i < 41 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 88, ty: 48, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 84, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 88, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 24, type: 'enemy' },
      { id: 'e4', tx: 8,  ty: 56, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-approach-c ──────────────────────────────────────────────────────
  // 80×96. Long descent. Glow maximised. 6 ring-walkers at full orbital aggression.
  {
    id:           'caldera-approach-c',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'standard',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 96),
    structures: [
      // Lava outcroppings thickening toward north
      { tx: 4,  ty: 80, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 80, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 81, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 81, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 80, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 70, ty: 80, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 80, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 81, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 81, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 80, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 12, ty: 60, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 60, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 61, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 61, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 60, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 62, ty: 60, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 60, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 61, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 63, ty: 61, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 62, ty: 60, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 20, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 40, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 41, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 40, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 54, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 40, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 40, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 54, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 41, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 41, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 40, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 28, ty: 18, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 18, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 18, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 28, ty: 19, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 19, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 30, ty: 19, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 29, ty: 18, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 46, ty: 18, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 18, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 18, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 19, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 19, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 19, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 18, frame: 7,  tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 80, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 80, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 34, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 46, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-approach-d ──────────────────────────────────────────────────────
  // 96×80. Final approach. Two massive caldera wall sections frame convergence.
  // 5 ring-walkers. Deep orange glow fills room from below.
  {
    id:           'caldera-approach-d',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // West massive wall section
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 0, ty: i + 10, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 1, ty: i + 10, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 2, ty: i + 10, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // East massive wall section
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 93, ty: i + 10, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 94, ty: i + 10, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: 95, ty: i + 10, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Deep orange glow along walls and floor
      { tx: 2,  ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 2,  ty: 56, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 93, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 93, ty: 56, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 48, ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e4', tx: 72, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS ARENAS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── caldera-boss-a ──────────────────────────────────────────────────────────
  // 96×96. The caldera floor. Central 8×8 ancient volcanic vent (outer 2-tile ring
  // blocked, open centre). Intense TINT_CALD_GLOW. Six 3×3 radial lava outcroppings
  // as cover. Ring-walker boss orbits vent. 6 markers in orbital positions.
  {
    id:           'caldera-boss-a',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // Central volcanic vent — 8×8, outer 2-tile ring blocked
      // Outer ring (blocked)
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 44, ty: 44, frame: i < 4 ? 21 : 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 44, ty: 51, frame: i < 4 ? 21 : 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: 44, ty: i + 45, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: 45, ty: i + 45, frame: 21, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: 50, ty: i + 45, frame: 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: 51, ty: i + 45, frame: 22, tint: TINT_CALD_LAVA, depth: 4, blocked: true })
      ),
      // Intense central glow
      { tx: 48, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      // Six 3×3 radial outcroppings at radius 28
      // North
      { tx: 46, ty: 14, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 14, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 14, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 15, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 15, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 15, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 16, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 16, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 16, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 14, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // NE
      { tx: 70, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 22, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 23, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 24, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 24, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 24, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 22, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SE
      { tx: 70, ty: 72, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 72, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 72, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 73, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 73, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 73, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 70, ty: 74, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 74, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 72, ty: 74, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 71, ty: 72, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // South
      { tx: 46, ty: 78, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 78, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 78, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 79, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 79, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 79, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 46, ty: 80, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 80, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 80, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 47, ty: 78, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // SW
      { tx: 20, ty: 72, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 72, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 72, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 73, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 73, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 73, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 74, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 74, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 74, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 72, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      // NW
      { tx: 20, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 22, frame: 29, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 22, frame: 28, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 23, frame: 36, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 23, frame: 35, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 24, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 24, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 22, ty: 24, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true },
      { tx: 21, ty: 22, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 28, type: 'enemy' },
      { id: 'e1', tx: 68, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 76, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 68, ty: 68, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 68, type: 'enemy' },
      { id: 'e5', tx: 18, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-boss-b ──────────────────────────────────────────────────────────
  // 80×80. Rim arc arena. Massive 4-tile-wide blocked arc on north face. Three entry
  // gaps. Boss and 6 markers in arc interior. Player must breach.
  {
    id:           'caldera-boss-b',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Massive arc — 4-tile-wide, across north face, 3 gaps of 4 tiles
      ...Array.from({ length: 4 }, (_, row) =>
        [
          ...Array.from({ length: 12 }, (_, i) =>
            ({ tx: i, ty: row, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 21 }, (_, i) =>
            ({ tx: i + 16, ty: row, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 21 }, (_, i) =>
            ({ tx: i + 41, ty: row, frame: i < 11 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 14 }, (_, i) =>
            ({ tx: i + 66, ty: row, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // Glows at each gap
      { tx: 14, ty: 2, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 39, ty: 2, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 64, ty: 2, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 28, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 40, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 52, ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 70, ty: 8,  type: 'enemy' },
      { id: 'e5', tx: 40, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-boss-c ──────────────────────────────────────────────────────────
  // 96×80. Asymmetric caldera shelf. Heavy east lava formations. Open west approach.
  // Boss spawns east amid formations. 6 markers distributed.
  {
    id:           'caldera-boss-c',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Heavy east lava formations — 5 large blocked formations
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 68, ty: ty + 8, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 70, ty: 8,  frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 76, ty: ty + 24, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 78, ty: 24, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 36, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 66, ty: 36, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 76, ty: ty + 52, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 78, ty: 52, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 68, ty: ty + 64, frame: tx < 2 ? 28 : 29, tint: TINT_CALD_WALL, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 70, ty: 64, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      // Boss spawn glow
      { tx: 80, ty: 40, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 60, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 80, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 84, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 64, type: 'enemy' },
      { id: 'e5', tx: 80, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── caldera-boss-d ──────────────────────────────────────────────────────────
  // 80×96. Concentric ring arena. Three concentric lava rock rings, each partial
  // with 4 gaps (no two gaps aligned). Boss at innermost ring. 6 markers, 2 per ring.
  // Maximum TINT_CALD_GLOW throughout.
  {
    id:           'caldera-boss-d',
    zone_act:     1,
    region_types: ['caldera-ring-core'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // Outer ring at radius ~32 — 4 arcs with gaps at N, E, S, W
      // North arc (ty=12) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 12, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 12, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // South arc (ty=80) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 80, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 80, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // West side (tx=8) — gap at ty=45-50
      ...Array.from({ length: 33 }, (_, i) =>
        ({ tx: 8, ty: i + 13, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: 8, ty: i + 51, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // East side (tx=72) — gap at ty=45-50
      ...Array.from({ length: 33 }, (_, i) =>
        ({ tx: 72, ty: i + 13, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: 72, ty: i + 51, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Middle ring at radius ~20 — gaps at NE, SW (offset from outer)
      // North arc (ty=28) — gap at tx=20-25
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: i + 20, ty: 28, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 34 }, (_, i) =>
        ({ tx: i + 26, ty: 28, frame: i < 17 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // South arc (ty=68) — gap at tx=54-59
      ...Array.from({ length: 34 }, (_, i) =>
        ({ tx: i + 20, ty: 68, frame: i < 17 ? 21 : 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: i + 54, ty: 68, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // West/East mid-sides
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: 20, ty: i + 29, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        ({ tx: 20, ty: i + 51, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: 60, ty: i + 29, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        ({ tx: 60, ty: i + 51, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Inner ring at radius ~10 — gaps at N, S (offset from middle)
      // North arc (ty=38) — gap at tx=37-42
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: i + 30, ty: 38, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 13 }, (_, i) =>
        ({ tx: i + 43, ty: 38, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // South arc (ty=58) — gap at tx=37-42
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: i + 30, ty: 58, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 13 }, (_, i) =>
        ({ tx: i + 43, ty: 58, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Inner sides
      ...Array.from({ length: 19 }, (_, i) =>
        ({ tx: 30, ty: i + 39, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 19 }, (_, i) =>
        ({ tx: 50, ty: i + 39, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      // Maximum glow at all ring gaps
      { tx: 40, ty: 12, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 8,  ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 72, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 80, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 22, ty: 28, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 56, ty: 68, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 38, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
      { tx: 40, ty: 48, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // Outer ring pair
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 72, type: 'enemy' },
      // Middle ring pair
      { id: 'e2', tx: 24, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 48, type: 'enemy' },
      // Inner ring pair
      { id: 'e4', tx: 36, ty: 48, type: 'enemy' },
      { id: 'e5', tx: 44, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── caldera-connector-a ─────────────────────────────────────────────────────
  // 16×24. Narrow volcanic crack. Wall formations both sides.
  {
    id:           'caldera-connector-a',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim', 'caldera-ring-inner', 'caldera-ring-shelf', 'caldera-ring-descent', 'caldera-ring-floor', 'caldera-ring-core'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── caldera-connector-b ─────────────────────────────────────────────────────
  // 24×16. Wide shallow crossing. Two small lava fragments flanking passage.
  {
    id:           'caldera-connector-b',
    zone_act:     1,
    region_types: ['caldera-ring-approach', 'caldera-ring-rim', 'caldera-ring-inner', 'caldera-ring-shelf', 'caldera-ring-descent', 'caldera-ring-floor', 'caldera-ring-core'],
    type:         'connector',
    size:         { w: 24, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 16),
    structures: [
      { tx: 4,  ty: 7, frame: 28, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 5,  ty: 7, frame: 29, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 18, ty: 7, frame: 28, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 19, ty: 7, frame: 29, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 4,  ty: 7, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
      { tx: 18, ty: 7, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── caldera-connector-c ─────────────────────────────────────────────────────
  // 16×32. Long narrow caldera throat. Full-length wall formations. Glow mid-passage.
  {
    id:           'caldera-connector-c',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf', 'caldera-ring-descent', 'caldera-ring-floor', 'caldera-ring-core'],
    type:         'connector',
    size:         { w: 16, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 22, tint: TINT_CALD_WALL, depth: 4, blocked: true })
      ),
      { tx: 8, ty: 15, frame: 7, tint: TINT_CALD_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── caldera-connector-d ─────────────────────────────────────────────────────
  // 24×24. Short junction stub. Single lava formation at centre. Hot glow.
  {
    id:           'caldera-connector-d',
    zone_act:     1,
    region_types: ['caldera-ring-inner', 'caldera-ring-shelf', 'caldera-ring-descent', 'caldera-ring-floor', 'caldera-ring-core'],
    type:         'connector',
    size:         { w: 24, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 24),
    structures: [
      { tx: 11, ty: 11, frame: 28, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 12, ty: 11, frame: 29, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 11, ty: 12, frame: 35, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 12, ty: 12, frame: 36, tint: TINT_CALD_LAVA, depth: 2 },
      { tx: 11, ty: 11, frame: 7,  tint: TINT_CALD_HOT,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z3

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z3: RegionDef[] = [
  {
    id:             'caldera-ring-approach',
    label:          'Caldera Ring — Exterior Approach',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-rim',
    label:          'Caldera Ring — Rim Traverse',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-inner',
    label:          'Caldera Ring — Inner Wall Descent',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-shelf',
    label:          'Caldera Ring — Interior Shelf',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-descent',
    label:          'Caldera Ring — Caldera Descent',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-floor',
    label:          'Caldera Ring — Caldera Floor',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_CALD_FLOOR,
  },
  {
    id:             'caldera-ring-core',
    label:          'Caldera Ring — Boss Core',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_CALD_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionApproach,
  regionRim,
  regionInner,
  regionShelf,
  regionDescent,
  regionFloor,
  regionCore,
] = REGIONS_A1Z3;

export const ZONE_A1Z3: ZoneDef = {
  id:           'caldera-ring',
  label:        'Caldera Ring',
  zone_act:     1,
  region_defs:  [
    regionApproach,
    regionRim,
    regionInner,
    regionShelf,
    regionDescent,
    regionFloor,
    regionCore,
  ],
  enemy_flavour: 'ring-walkers',
  tint:          TINT_CALD_FLOOR,
};
