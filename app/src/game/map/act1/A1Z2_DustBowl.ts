/**
 * Act I — Zone 2 — DUST BOWL
 * Archetype index: 2
 * Tint: 0x9a8870 (warm tan-grey)
 * Enemy flavour: wanderers
 *
 * A sunken basin of deep fine dust — the lowest-lying terrain on this section of Phobos.
 * Dust has drifted into ripple fields, dune ridges, and partially buried ancient structures.
 * Wanderers patrol without clear pattern, drawn to any movement in the dust. Rooms feel
 * silted and heavy. Palette is warm — tan, ochre, muted earth tones — distinct from the
 * cool grey of Crater Flat and the blue-grey geometry of Obsidian Shelf.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_DUST_FLOOR:  number = 0x9a8870;  // warm tan dust
const TINT_DUST_DUNE:   number = 0x7a6855;  // compressed dune formation
const TINT_DUST_BURIED: number = 0x5a5040;  // partially buried structure
const TINT_DUST_RIPPLE: number = 0xb8a888;  // pale ripple surface highlight
const TINT_DUST_GLOW:   number = 0xcc9944;  // warm amber subsurface glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z2: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── dust-traverse-a ─────────────────────────────────────────────────────────
  // 80×64. Open dust flat. Decorative ripple structures (1×4 non-blocked,
  // TINT_DUST_RIPPLE, depth 2) run roughly east-west in soft curves. Low dune
  // formations (2×1 blocked) at east and west edges only. 3 wanderer markers.
  {
    id:           'dust-traverse-a',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Decorative ripple lines — non-blocked, depth 2
      { tx: 8,  ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 12, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 16, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 20, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 24, ty: 12, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 28, ty: 12, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 32, ty: 12, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 36, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 44, ty: 12, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 12, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 52, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 16, ty: 32, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 24, ty: 32, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 32, ty: 30, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 30, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 32, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 56, ty: 32, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 12, ty: 50, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 24, ty: 52, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 36, ty: 50, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 50, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 60, ty: 52, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      // Low dune formations at west edge
      { tx: 0, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Low dune formations at east edge
      { tx: 78, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 78, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 78, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 22, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 55, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-traverse-b ─────────────────────────────────────────────────────────
  // 80×80. Dune ridge crossing. Single major dune ridge E-W at 2/3 depth with
  // 10-tile central gap. Amber glow at crest. 4 enemy markers.
  {
    id:           'dust-traverse-b',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Main dune ridge at ty=52 — gap at tx=35-44
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i, ty: 52, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i, ty: 53, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i + 45, ty: 52, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i + 45, ty: 53, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Amber glow at crest and gap
      { tx: 16, ty: 52, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 52, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 62, ty: 52, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 28, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 64, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-traverse-c ─────────────────────────────────────────────────────────
  // 64×80. Ripple field. Dense decorative ripple lines across full room. Small 1×1
  // buried fragments (TINT_DUST_BURIED) at edges. 3 enemy markers.
  {
    id:           'dust-traverse-c',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Dense ripple field — 10 ripple lines
      { tx: 4,  ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 12, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 20, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 28, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 36, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 44, ty: 10, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 52, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 8,  ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 16, ty: 26, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 24, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 32, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 26, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 56, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 6,  ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 20, ty: 42, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 34, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 42, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 60, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 12, ty: 58, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 26, ty: 60, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 58, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 54, ty: 60, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      // Buried fragment edges — 1×1 non-blocked
      { tx: 2,  ty: 36, frame: 14, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 60, ty: 20, frame: 14, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 4,  ty: 68, frame: 14, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 58, ty: 56, frame: 14, tint: TINT_DUST_BURIED, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-traverse-d ─────────────────────────────────────────────────────────
  // 96×64. Wide shallow crossing. Two shallow parallel dune ridges (1-tile-wide
  // blocked, E-W, offset) with wide gaps. 4 wanderer markers.
  {
    id:           'dust-traverse-d',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Ridge 1 at ty=20 — gap on west (tx=8-17) and east (tx=78-87)
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: i + 18, ty: 20, frame: i < 30 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 88, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Ridge 2 at ty=44 — gap on centre (tx=44-53)
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: i, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 42 }, (_, i) =>
        ({ tx: i + 54, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Glow at gap centres
      { tx: 13,  ty: 20, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 83,  ty: 20, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 48,  ty: 44, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-traverse-e ─────────────────────────────────────────────────────────
  // 80×64. Partially buried structure field. 6–8 buried fragment structures
  // (2×1 TINT_DUST_BURIED, non-blocked, depth 2) scattered. 4 wanderer markers.
  // 1 mineral near a buried corner.
  {
    id:           'dust-traverse-e',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Buried fragment structures — 2×1, non-blocked, depth 2
      { tx: 8,  ty: 10, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 24, ty: 8,  frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 25, ty: 8,  frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 52, ty: 12, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 53, ty: 12, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 68, ty: 8,  frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 69, ty: 8,  frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 14, ty: 32, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 15, ty: 32, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 28, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 28, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 62, ty: 36, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 63, ty: 36, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 30, ty: 52, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 31, ty: 52, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 20, type: 'enemy'   },
      { id: 'e1', tx: 56, ty: 20, type: 'enemy'   },
      { id: 'e2', tx: 24, ty: 48, type: 'enemy'   },
      { id: 'e3', tx: 64, ty: 48, type: 'enemy'   },
      { id: 'm0', tx: 8,  ty: 14, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── dust-traverse-f ─────────────────────────────────────────────────────────
  // 64×64. Dust hollow — four low dune humps (2×2 blocked) at quadrant centres.
  // Wanderers weave between humps. 4 enemy markers.
  {
    id:           'dust-traverse-f',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // NW hump
      { tx: 12, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NE hump
      { tx: 50, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 50, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SW hump
      { tx: 12, ty: 50, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 50, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 51, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 51, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SE hump
      { tx: 50, ty: 50, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 50, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 50, ty: 51, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 51, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 52, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-traverse-g ─────────────────────────────────────────────────────────
  // 80×80. Large drift field. West half has 8 dune formations (2×2 blocked).
  // East half is flat. Wanderers prefer east half. 4 enemy markers.
  {
    id:           'dust-traverse-g',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // West half dune maze — 8 2×2 formations
      { tx: 4,  ty: 10, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 11, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 11, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 20, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 21, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 21, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 33, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 33, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 45, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 57, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 22, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 23, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 22, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 23, ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 70, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 71, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 56, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 64, ty: 44, type: 'enemy' },
      { id: 'e2', tx: 56, ty: 60, type: 'enemy' },
      { id: 'e3', tx: 68, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-traverse-h ─────────────────────────────────────────────────────────
  // 96×80. Widest traversal. Dense ripple decoration full floor. Light amber glow
  // at north-centre. 4 enemy markers.
  {
    id:           'dust-traverse-h',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-deep'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // Dense ripple field across full floor
      { tx: 8,  ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 20, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 32, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 44, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 56, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 68, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 80, ty: 8,  frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 4,  ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 16, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 28, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 52, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 64, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 76, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 88, ty: 24, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 8,  ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 24, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 40, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 56, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 72, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 88, ty: 40, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 16, ty: 56, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 32, ty: 56, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 56, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 64, ty: 56, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 80, ty: 56, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 8,  ty: 68, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 28, ty: 68, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 48, ty: 68, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 68, ty: 68, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      // Light amber glow at north-centre
      { tx: 48, ty: 12, frame: 7,  tint: TINT_DUST_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 60, type: 'enemy' },
      { id: 'e3', tx: 68, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-traverse-i ─────────────────────────────────────────────────────────
  // 80×64. Compressed terrain. 3-tile-deep dune walls (blocked). Two parallel
  // walls with offset gaps force slalom. 5 enemy markers.
  {
    id:           'dust-traverse-i',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Wall 1 at ty=20-22 — gap west (tx=4-11)
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 68 }, (_, i) =>
          ({ tx: i + 12, ty: row + 20, frame: i < 34 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      // Wall 2 at ty=40-42 — gap east (tx=68-75)
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 68 }, (_, i) =>
          ({ tx: i, ty: row + 40, frame: i < 34 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      // Glows at gaps
      { tx: 8,  ty: 21, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 72, ty: 41, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 10, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 54, type: 'enemy' },
      { id: 'e4', tx: 72, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-traverse-j ─────────────────────────────────────────────────────────
  // 64×80. Buried structure exposure. Large 4×4 fragment (TINT_DUST_BURIED,
  // non-blocked, depth 2) at room centre. 4 enemy markers around it. 1 loot.
  {
    id:           'dust-traverse-j',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Large 4×4 buried structure — non-blocked, depth 2
      { tx: 30, ty: 36, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 31, ty: 36, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 36, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 36, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 30, ty: 37, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 31, ty: 37, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 37, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 37, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 30, ty: 38, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 31, ty: 38, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 38, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 38, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 30, ty: 39, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 31, ty: 39, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 39, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 39, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      // Amber glow at fragment
      { tx: 31, ty: 37, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 28, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 52, type: 'enemy' },
      { id: 'l0', tx: 30, ty: 34, type: 'loot'  },
    ],
    min_room_tier: 2,
  },

  // ── dust-traverse-k ─────────────────────────────────────────────────────────
  // 80×64. Pre-boss. Highest dune density. 8 formations of mixed 2×2 and 3×2.
  // 5 enemy markers. Amber glow at each dune.
  {
    id:           'dust-traverse-k',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // 8 mixed dune formations
      // 2×2
      { tx: 6,  ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 8,  frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 3×2
      { tx: 26, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 27, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 26, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 27, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 27, ty: 12, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 2×2
      { tx: 56, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 8,  frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 3×2
      { tx: 68, ty: 18, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 18, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 18, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 68, ty: 19, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 19, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 19, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 18, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 2×2
      { tx: 14, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 33, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 33, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 32, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 3×2
      { tx: 38, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 28, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 2×2
      { tx: 58, ty: 36, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 37, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 36, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
      // 3×2
      { tx: 20, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 22, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 22, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 48, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 64, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 54, type: 'enemy' },
      { id: 'e4', tx: 72, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-traverse-l ─────────────────────────────────────────────────────────
  // 96×64. Final standard traversal. Two dune ridges converging toward north.
  // 5 enemy markers. High amber glow along converging ridges.
  {
    id:           'dust-traverse-l',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift', 'dust-bowl-sink'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // West converging ridge — steps inward northward
      { tx: 0,  ty: 50, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0,  ty: 40, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 30, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 20, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 10, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 32, ty: 4,  frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East converging ridge
      { tx: 95, ty: 50, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 95, ty: 40, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 87, ty: 30, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 20, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 10, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 63, ty: 4,  frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Glows along ridges
      { tx: 8,  ty: 30, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 24, ty: 10, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 87, ty: 30, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 71, ty: 10, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 52, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 52, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 64, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 10, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── dust-combat-a ───────────────────────────────────────────────────────────
  // 64×64. Dune ambush. Five 2×2 dune formations in arc across north. Wanderers
  // behind arc. 5 enemy markers. Amber glow traces arc interior.
  {
    id:           'dust-combat-a',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Five 2×2 dune formations in arc at north face
      { tx: 4,  ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Glow traces arc interior
      { tx: 10, ty: 14, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 32, ty: 10, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 52, ty: 14, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 22, ty: 4,  type: 'enemy' },
      { id: 'e2', tx: 32, ty: 4,  type: 'enemy' },
      { id: 'e3', tx: 42, ty: 4,  type: 'enemy' },
      { id: 'e4', tx: 54, ty: 4,  type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-combat-b ───────────────────────────────────────────────────────────
  // 48×64. Drift pinch with E exit. West dune density forces zigzag passage.
  // 5 enemy markers along passage.
  {
    id:           'dust-combat-b',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 47, ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // West side dunes — 4 formations
      { tx: 2,  ty: 10, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 10, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 11, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 11, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 24, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 24, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 25, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 25, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 52, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 52, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 53, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 53, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East side dunes — 3 formations offset
      { tx: 44, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 17, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 17, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 45, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 58, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 58, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 59, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 59, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 50, type: 'enemy' },
      { id: 'e4', tx: 36, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-combat-c ───────────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. W exit. Heavy east accumulation. 5 enemy markers.
  {
    id:           'dust-combat-c',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // East side heavy drift — 4 formations
      { tx: 60, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 24, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 24, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 25, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 25, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 40, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 40, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 41, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 41, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 54, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 54, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 55, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 55, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // West side — 3 formations offset
      { tx: 2,  ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 17, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 17, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 45, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 58, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 58, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 2,  ty: 59, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 3,  ty: 59, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 32, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 50, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-combat-d ───────────────────────────────────────────────────────────
  // 80×64. Buried ambush. Six buried fragment structures (non-blocked) create
  // irregular field. 6 enemy markers. 1 loot in densest cluster.
  {
    id:           'dust-combat-d',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Six buried fragment structures — non-blocked, depth 2
      { tx: 8,  ty: 10, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 28, ty: 14, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 29, ty: 14, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 28, ty: 15, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 29, ty: 15, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 52, ty: 10, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 53, ty: 10, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 52, ty: 11, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 53, ty: 11, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 14, ty: 36, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 15, ty: 36, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 14, ty: 37, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 15, ty: 37, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 32, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 32, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 33, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 33, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 66, ty: 38, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 67, ty: 38, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 66, ty: 39, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 67, ty: 39, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 64, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 48, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 48, type: 'enemy' },
      { id: 'e5', tx: 72, ty: 48, type: 'enemy' },
      { id: 'l0', tx: 40, ty: 34, type: 'loot'  },
    ],
    min_room_tier: 1,
  },

  // ── dust-combat-e ───────────────────────────────────────────────────────────
  // 64×80. Dune ring fight. 8 formations (2×2) at radius 20 create natural arena.
  // 6 enemy markers inside ring. S-side gap aligns with entry.
  {
    id:           'dust-combat-e',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // 8 dune formations at radius 20 from centre (32,40) — gap at south
      // North
      { tx: 30, ty: 18, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 18, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 19, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 19, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NE
      { tx: 46, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East
      { tx: 50, ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 50, ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SE
      { tx: 46, ty: 54, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 54, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 55, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 55, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NW
      { tx: 14, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // West
      { tx: 10, ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SW
      { tx: 14, ty: 54, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 54, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 55, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 55, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // South gap — no formation — aligns with S entry
      // Central glow
      { tx: 32, ty: 40, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 56, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 48, type: 'enemy' },
      { id: 'e5', tx: 20, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-combat-f ───────────────────────────────────────────────────────────
  // 80×64. Crossdrift. Two perpendicular dune ridges divide into quadrants.
  // Each ridge has central gap. 6 enemy markers — cluster per quadrant.
  {
    id:           'dust-combat-f',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // E-W ridge at ty=30 — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i, ty: 30, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 30, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // N-S ridge at tx=38 — gap at ty=28-33 (aligns with EW gap)
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: 38, ty: i, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        ({ tx: 38, ty: i + 34, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Glow at intersection
      { tx: 40, ty: 30, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 48, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 30, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 30, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-combat-g ───────────────────────────────────────────────────────────
  // 64×64. Grid hub combat. Open centre, dune formations at all 4 inner walls.
  // All exits. 6 enemy markers at centre. High chaos.
  {
    id:           'dust-combat-g',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-buried'],
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
      // North inner dune pair
      { tx: 24, ty: 4, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 4, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 4, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 4, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // South inner dune pair
      { tx: 24, ty: 59, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 59, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 59, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 59, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East inner dune pair
      { tx: 59, ty: 24, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 25, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 38, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 39, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // West inner dune pair
      { tx: 4, ty: 24, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4, ty: 25, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4, ty: 38, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4, ty: 39, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 16, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-combat-h ───────────────────────────────────────────────────────────
  // 48×48. Small dense fight. 8 dune formations packed. 6 enemy markers. Wanderers
  // fully disoriented — erratic movement.
  {
    id:           'dust-combat-h',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // 8 tightly packed 2×2 dune formations
      { tx: 4,  ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 36, ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 37, ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 36, ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 37, ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 31, ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 36, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 37, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 36, ty: 36, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 37, ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 36, ty: 37, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 37, ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 30, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 16, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 28, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 30, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-combat-i ───────────────────────────────────────────────────────────
  // 80×64. Pre-convergence. Three concentric dune arcs with offset single gaps.
  // 6 enemy markers behind innermost arc. High amber glow.
  {
    id:           'dust-combat-i',
    zone_act:     1,
    region_types: ['dust-bowl-drift', 'dust-bowl-sink'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Outer arc at ty=48 — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Middle arc at ty=32 — gap at tx=16-21
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 58 }, (_, i) =>
        ({ tx: i + 22, ty: 32, frame: i < 29 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Inner arc at ty=16 — gap at tx=59-64
      ...Array.from({ length: 59 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 30 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        ({ tx: i + 65, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      // Glows
      { tx: 40, ty: 48, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 18, ty: 32, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 62, ty: 16, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 48, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 56, ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e5', tx: 40, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-combat-j ───────────────────────────────────────────────────────────
  // 80×80. Maximum dust combat. Entire room is dune field — 14 mixed formations.
  // 6 enemy markers, 2 mineral markers. Wanderers at highest tier.
  {
    id:           'dust-combat-j',
    zone_act:     1,
    region_types: ['dust-bowl-drift', 'dust-bowl-sink'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // 14 formations — 2×2 and 3×2 mixed, scattered across full room
      { tx: 6,  ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 26, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 26, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 14, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 14, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 14, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 15, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 15, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 15, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 30, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 30, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 31, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 31, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 60, ty: 33, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 61, ty: 33, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 50, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 50, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 51, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 51, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 51, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 52, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 52, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 53, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 53, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 52, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 52, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 68, ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 68, ty: 57, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 66, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 66, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 44, ty: 67, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 45, ty: 67, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 20, type: 'enemy'   },
      { id: 'e1', tx: 64, ty: 20, type: 'enemy'   },
      { id: 'e2', tx: 32, ty: 40, type: 'enemy'   },
      { id: 'e3', tx: 56, ty: 44, type: 'enemy'   },
      { id: 'e4', tx: 24, ty: 68, type: 'enemy'   },
      { id: 'e5', tx: 60, ty: 70, type: 'enemy'   },
      { id: 'm0', tx: 40, ty: 36, type: 'mineral' },
      { id: 'm1', tx: 8,  ty: 60, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── dust-dead-a ─────────────────────────────────────────────────────────────
  // 32×32. Simple alcove. 1 loot, 1 mineral. Amber glow.
  {
    id:           'dust-dead-a',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes', 'dust-bowl-flat'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 15, ty: 8, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 10, ty: 14, type: 'loot'    },
      { id: 'm0', tx: 22, ty: 14, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── dust-dead-b ─────────────────────────────────────────────────────────────
  // 48×32. Exposed buried fragment at north. 2 loot, 1 mineral. 1 wanderer.
  {
    id:           'dust-dead-b',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes'],
    type:         'dead-end',
    size:         { w: 48, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 31 },
    ],
    tiles: floor(48, 32),
    structures: [
      // Exposed fragment at north — 4×2 non-blocked
      { tx: 20, ty: 2, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 21, ty: 2, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 22, ty: 2, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 23, ty: 2, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 20, ty: 3, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 21, ty: 3, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 22, ty: 3, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 23, ty: 3, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 21, ty: 2, frame: 7,  tint: TINT_DUST_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 20, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 18, type: 'loot'    },
      { id: 'l1', tx: 24, ty: 18, type: 'loot'    },
      { id: 'm0', tx: 38, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── dust-dead-c ─────────────────────────────────────────────────────────────
  // 32×48. Narrow dust pocket. 3 mineral at back. 1 loot.
  {
    id:           'dust-dead-c',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-buried'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 16, ty: 28, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 16, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 24, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── dust-dead-d ─────────────────────────────────────────────────────────────
  // 48×48. Basin sink. Darker floor tint at centre (non-blocked). 2 loot, 1 mineral.
  // Amber glow. 1 enemy.
  {
    id:           'dust-dead-d',
    zone_act:     1,
    region_types: ['dust-bowl-flat', 'dust-bowl-deep'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Darker centre suggesting sink depth
      ...Array.from({ length: 12 }, (_, ty) =>
        Array.from({ length: 12 }, (_, tx) =>
          ({ tx: tx + 18, ty: ty + 14, frame: 0, tint: TINT_DUST_DUNE, depth: 1 })
        )
      ).flat(),
      { tx: 24, ty: 20, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 36, type: 'enemy'   },
      { id: 'l0', tx: 12, ty: 10, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 10, type: 'loot'    },
      { id: 'm0', tx: 36, ty: 36, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── dust-dead-e ─────────────────────────────────────────────────────────────
  // 32×32. Buried corner. One dominant 2×2 fragment. 2 loot. No combat.
  {
    id:           'dust-dead-e',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-deep'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 13, ty: 8, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 14, ty: 8, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 13, ty: 9, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 14, ty: 9, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 20, type: 'loot' },
      { id: 'l1', tx: 22, ty: 20, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── dust-dead-f ─────────────────────────────────────────────────────────────
  // 48×48. Deep drift pocket. Dense fragment structures. 2 loot, 2 mineral. 2 enemies.
  {
    id:           'dust-dead-f',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Dense fragment cluster at north
      { tx: 12, ty: 6,  frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 13, ty: 6,  frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 12, ty: 7,  frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 13, ty: 7,  frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 22, ty: 4,  frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 23, ty: 4,  frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 22, ty: 5,  frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 23, ty: 5,  frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 6,  frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 6,  frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 32, ty: 7,  frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 33, ty: 7,  frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 22, ty: 4,  frame: 7,  tint: TINT_DUST_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 28, type: 'enemy'   },
      { id: 'e1', tx: 36, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 12, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 12, type: 'loot'    },
      { id: 'm0', tx: 10, ty: 38, type: 'mineral' },
      { id: 'm1', tx: 36, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── dust-dead-g ─────────────────────────────────────────────────────────────
  // 32×48. Late mineral sink. 4 mineral, 1 loot, 1 enemy.
  {
    id:           'dust-dead-g',
    zone_act:     1,
    region_types: ['dust-bowl-drift', 'dust-bowl-sink'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      { tx: 15, ty: 6, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
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

  // ── dust-dead-h ─────────────────────────────────────────────────────────────
  // 48×48. Rich guarded pocket. 3 loot, 3 mineral, 3 enemies. North wall.
  {
    id:           'dust-dead-h',
    zone_act:     1,
    region_types: ['dust-bowl-drift', 'dust-bowl-sink'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 24 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 6, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
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

  // ── dust-junction-a ─────────────────────────────────────────────────────────
  // 64×64. East branch. Central 3×3 dune cluster. E exit clear. 2 enemy markers.
  {
    id:           'dust-junction-a',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central 3×3 dune cluster
      { tx: 28, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-junction-b ─────────────────────────────────────────────────────────
  // 64×64. West branch. Dense east drift. W exit open. 2 enemy markers.
  {
    id:           'dust-junction-b',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes', 'dust-bowl-flat'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // East side drifted
      { tx: 52, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 52, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 52, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 52, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 53, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-junction-c ─────────────────────────────────────────────────────────
  // 80×64. Cross junction. Four corner dunes. All passages clear. 3 enemy markers.
  {
    id:           'dust-junction-c',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-flat', 'dust-bowl-buried'],
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
      // NW dune
      { tx: 6,  ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NE dune
      { tx: 72, ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SW dune
      { tx: 6,  ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 57, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SE dune
      { tx: 72, ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 57, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── dust-junction-d ─────────────────────────────────────────────────────────
  // 64×80. Rim junction. Dune ridge along west edge. E exit open. 3 enemy markers.
  {
    id:           'dust-junction-d',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Dune ridge along west edge
      { tx: 0, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0, ty: 24, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 24, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0, ty: 40, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 40, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0, ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1, ty: 56, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-junction-e ─────────────────────────────────────────────────────────
  // 64×64. Drift junction. Heavy east accumulation. W exit open. 3 enemy markers.
  {
    id:           'dust-junction-e',
    zone_act:     1,
    region_types: ['dust-bowl-dunes', 'dust-bowl-buried'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Heavy east accumulation — 5 dune formations
      { tx: 54, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 21, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 21, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 58, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 56, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 57, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-junction-f ─────────────────────────────────────────────────────────
  // 80×64. Wide junction. Central exposed fragment as landmark. All exits clear.
  // 3 enemy markers.
  {
    id:           'dust-junction-f',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // Central exposed fragment — 4×4 non-blocked, depth 2
      { tx: 38, ty: 30, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 39, ty: 30, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 30, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 30, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 38, ty: 31, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 39, ty: 31, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 31, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 31, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 38, ty: 32, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 39, ty: 32, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 32, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 32, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 38, ty: 33, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 39, ty: 33, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 33, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 41, ty: 33, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 40, ty: 31, frame: 7,  tint: TINT_DUST_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── dust-junction-g ─────────────────────────────────────────────────────────
  // 64×64. Deep grid junction. Dense but maintained passages. 4 enemy markers.
  {
    id:           'dust-junction-g',
    zone_act:     1,
    region_types: ['dust-bowl-deep', 'dust-bowl-drift'],
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
      // Dense scattered dunes away from passages
      { tx: 10, ty: 10, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 10, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 50, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 50, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 22, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 42, ty: 40, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
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

  // ── dust-junction-h ─────────────────────────────────────────────────────────
  // 80×80. Large late junction. Major dune formation at centre. Strong amber glow.
  // 4 enemy markers.
  {
    id:           'dust-junction-h',
    zone_act:     1,
    region_types: ['dust-bowl-drift', 'dust-bowl-sink'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Major 4×4 dune formation at centre
      { tx: 38, ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 38, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 41, ty: 38, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 39, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 41, ty: 39, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 40, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 40, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 40, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 41, ty: 40, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 41, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 41, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 41, frame: 21, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 41, ty: 41, frame: 22, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 40, ty: 39, frame: 7,  tint: TINT_DUST_GLOW, depth: 2 },
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

  // ── dust-approach-a ─────────────────────────────────────────────────────────
  // 80×80. Heavy dune corridor. Narrow winding path. 5 enemy markers. Amber glow peaks.
  {
    id:           'dust-approach-a',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Dense dune pairs flanking central 12-tile corridor
      { tx: 4,  ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 20, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 21, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 21, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 36, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 37, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 37, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 52, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 52, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 53, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 21, ty: 53, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 68, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 68, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 69, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 28, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 28, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 29, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 29, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 64, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 65, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 64, ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 65, ty: 45, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 60, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 60, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 61, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 61, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Peak glows
      { tx: 40, ty: 20, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 44, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 64, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 60, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 72, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-approach-b ─────────────────────────────────────────────────────────
  // 96×64. Three dune gauntlet. 6 enemy markers in passage zones.
  {
    id:           'dust-approach-b',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Stage 1 wall at ty=16 — gap west (tx=4-9)
      ...Array.from({ length: 4 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 4 }, (_, i) =>
          ({ tx: i, ty: 16 + row, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 86 }, (_, i) =>
          ({ tx: i + 10, ty: 16 + row, frame: i < 43 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      // Stage 2 wall at ty=32 — gap centre (tx=45-50)
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 45 }, (_, i) =>
          ({ tx: i, ty: 32 + row, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 45 }, (_, i) =>
          ({ tx: i + 51, ty: 32 + row, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      // Stage 3 wall at ty=48 — gap east (tx=86-91)
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 86 }, (_, i) =>
          ({ tx: i, ty: 48 + row, frame: i < 43 ? 28 : 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      ...Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 4 }, (_, i) =>
          ({ tx: i + 92, ty: 48 + row, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
        )
      ).flat(),
      // Glows at gaps
      { tx: 6,  ty: 17, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 48, ty: 33, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 88, ty: 49, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 88, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24, ty: 26, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 26, type: 'enemy' },
      { id: 'e4', tx: 8,  ty: 56, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-approach-c ─────────────────────────────────────────────────────────
  // 80×96. Long narrowing. Dune formations step inward at each depth. 6 enemy markers.
  {
    id:           'dust-approach-c',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'standard',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 96),
    structures: [
      // West funnel steps
      { tx: 0,  ty: 80, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1,  ty: 80, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 0,  ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 1,  ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 4,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 4,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East funnel steps
      { tx: 78, ty: 80, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 80, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 78, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 62, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 63, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 54, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 55, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 50, ty: 4,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 4,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Glows along funnel
      { tx: 30, ty: 36, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 50, ty: 60, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 80, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 76, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 76, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 34, ty: 24, type: 'enemy' },
      { id: 'e5', tx: 46, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-approach-d ─────────────────────────────────────────────────────────
  // 96×80. Final approach. Two converging dune arcs frame boss entry. 5 enemy markers.
  // Maximum amber glow.
  {
    id:           'dust-approach-d',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // West arc converging north
      { tx: 8,  ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 8,  ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 9,  ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 17, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 33, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 33, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 32, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 33, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 32, ty: 17, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 33, ty: 17, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 38, ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 39, ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East arc converging north
      { tx: 86, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 87, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 86, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 87, ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 78, ty: 48, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 48, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 78, ty: 49, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 79, ty: 49, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 32, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 32, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 70, ty: 33, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 71, ty: 33, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 62, ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 63, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 62, ty: 17, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 63, ty: 17, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 6,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 6,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 56, ty: 7,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 57, ty: 7,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Maximum glow
      { tx: 17, ty: 48, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 25, ty: 32, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 79, ty: 48, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 71, ty: 32, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 48, ty: 12, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
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

  // ── dust-boss-a ─────────────────────────────────────────────────────────────
  // 96×96. The basin sink. 6×6 darker depression at centre (TINT_DUST_DUNE).
  // 8 radial 3×2 dune formations at radius 32. Boss at centre of sink.
  // 6 enemy markers at radial positions. Strong amber glow at centre.
  {
    id:           'dust-boss-a',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // 6×6 central depression (darker tint, non-blocked, depth 1)
      ...Array.from({ length: 6 }, (_, ty) =>
        Array.from({ length: 6 }, (_, tx) =>
          ({ tx: tx + 45, ty: ty + 45, frame: 0, tint: TINT_DUST_DUNE, depth: 1 })
        )
      ).flat(),
      // Central glow
      { tx: 48, ty: 48, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      // 8 radial 3×2 dune formations at radius ~32
      // North
      { tx: 46, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 12, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 12, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 13, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 13, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NE
      { tx: 72, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 74, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 74, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // East
      { tx: 80, ty: 46, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 81, ty: 46, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 82, ty: 46, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 80, ty: 47, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 81, ty: 47, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 82, ty: 47, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SE
      { tx: 72, ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 70, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 74, ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 72, ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 73, ty: 71, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 74, ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // South
      { tx: 46, ty: 80, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 80, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 80, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 46, ty: 81, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 47, ty: 81, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 48, ty: 81, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // SW
      { tx: 18, ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 70, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 71, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // West
      { tx: 12, ty: 46, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 46, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 46, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 47, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 13, ty: 47, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 47, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // NW
      { tx: 18, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 23, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 23, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 80, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 72, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 72, type: 'enemy' },
      { id: 'e5', tx: 16, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-boss-b ─────────────────────────────────────────────────────────────
  // 80×80. Buried structure arena. Large 4×4 non-blocked fragments across floor.
  // Boss spawns north-centre. 6 enemy markers.
  {
    id:           'dust-boss-b',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Four large 4×4 buried fragments as cover features
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 16, frame: tx < 2 ? 28 : 29, tint: TINT_DUST_BURIED, depth: 2 })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 56, ty: ty + 16, frame: tx < 2 ? 28 : 29, tint: TINT_DUST_BURIED, depth: 2 })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 52, frame: tx < 2 ? 28 : 29, tint: TINT_DUST_BURIED, depth: 2 })
        )
      ).flat(),
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 56, ty: ty + 52, frame: tx < 2 ? 28 : 29, tint: TINT_DUST_BURIED, depth: 2 })
        )
      ).flat(),
      // Boss spawn glow
      { tx: 40, ty: 20, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 64, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 28, ty: 60, type: 'enemy' },
      { id: 'e5', tx: 52, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── dust-boss-c ─────────────────────────────────────────────────────────────
  // 96×80. Asymmetric drift arena. Massive west dune field. East open.
  // Boss spawns east-centre. 6 enemy markers.
  {
    id:           'dust-boss-c',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Massive west dune field — 10 mixed formations
      { tx: 4,  ty: 8,  frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 8,  frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 9,  frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 9,  frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 20, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 20, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 20, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 14, ty: 21, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 15, ty: 21, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 16, ty: 21, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 34, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 34, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 35, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 5,  ty: 35, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 19, ty: 45, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 45, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 58, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 58, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 6,  ty: 59, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 7,  ty: 59, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 64, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 26, ty: 64, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 24, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 25, ty: 65, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 26, ty: 65, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 70, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 10, ty: 71, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 11, ty: 71, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 10, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 10, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 11, frame: 35, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 29, ty: 11, frame: 36, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Boss spawn glow — east centre
      { tx: 72, ty: 40, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
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

  // ── dust-boss-d ─────────────────────────────────────────────────────────────
  // 80×96. Double basin sink. Two sink depressions connected by clear channel.
  // Player enters south sink, boss occupies north sink. 4 markers in channel,
  // boss + 2 in north sink. Maximum amber glow both sinks.
  {
    id:           'dust-boss-d',
    zone_act:     1,
    region_types: ['dust-bowl-sink'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // South sink boundary
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 60, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 60, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      { tx: 4,  ty: 70, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 78, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 70, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 78, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Channel walls — narrow passage between sinks
      { tx: 4,  ty: 44, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 52, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 12, ty: 40, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 20, ty: 36, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 28, ty: 33, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 44, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 52, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 67, ty: 40, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 59, ty: 36, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 51, ty: 33, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // North sink boundary
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 2, ty: 30, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i + 42, ty: 30, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      { tx: 4,  ty: 16, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 4,  ty: 22, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 16, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 75, ty: 22, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      // Both sinks glows
      { tx: 40, ty: 18, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 76, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
      { tx: 40, ty: 46, frame: 7, tint: TINT_DUST_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // North sink boss territory
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 16, type: 'enemy' },
      // Channel kill zone
      { id: 'e3', tx: 28, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 44, type: 'enemy' },
      { id: 'e5', tx: 52, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── dust-connector-a ────────────────────────────────────────────────────────
  // 16×24. Narrow dust path. Ripple decoration only.
  {
    id:           'dust-connector-a',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes', 'dust-bowl-flat', 'dust-bowl-buried', 'dust-bowl-deep', 'dust-bowl-drift', 'dust-bowl-sink'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      { tx: 4,  ty: 11, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
      { tx: 10, ty: 13, frame: 13, tint: TINT_DUST_RIPPLE, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── dust-connector-b ────────────────────────────────────────────────────────
  // 24×16. Wide shallow. Two small dune fragments flanking.
  {
    id:           'dust-connector-b',
    zone_act:     1,
    region_types: ['dust-bowl-rim', 'dust-bowl-dunes', 'dust-bowl-flat', 'dust-bowl-buried', 'dust-bowl-deep', 'dust-bowl-drift', 'dust-bowl-sink'],
    type:         'connector',
    size:         { w: 24, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 16),
    structures: [
      { tx: 4,  ty: 7, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
      { tx: 18, ty: 7, frame: 14, tint: TINT_DUST_DUNE, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── dust-connector-c ────────────────────────────────────────────────────────
  // 16×32. Long narrow dune channel. 1-tile dune walls both sides.
  {
    id:           'dust-connector-c',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-deep', 'dust-bowl-drift', 'dust-bowl-sink'],
    type:         'connector',
    size:         { w: 16, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 28, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 15, ty: i, frame: 29, tint: TINT_DUST_DUNE, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── dust-connector-d ────────────────────────────────────────────────────────
  // 24×24. Short stub. One buried fragment at centre.
  {
    id:           'dust-connector-d',
    zone_act:     1,
    region_types: ['dust-bowl-buried', 'dust-bowl-deep', 'dust-bowl-drift', 'dust-bowl-sink'],
    type:         'connector',
    size:         { w: 24, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 24),
    structures: [
      { tx: 10, ty: 10, frame: 28, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 11, ty: 10, frame: 29, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 10, ty: 11, frame: 35, tint: TINT_DUST_BURIED, depth: 2 },
      { tx: 11, ty: 11, frame: 36, tint: TINT_DUST_BURIED, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z2

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z2: RegionDef[] = [
  {
    id:             'dust-bowl-rim',
    label:          'Dust Bowl — Rim Descent',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-dunes',
    label:          'Dust Bowl — Dune Field',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-flat',
    label:          'Dust Bowl — Bowl Flat',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   6,
    corridor_max:   10,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-buried',
    label:          'Dust Bowl — Buried Structure Ring',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-deep',
    label:          'Dust Bowl — Deep Descent',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   6,
    corridor_max:   12,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-drift',
    label:          'Dust Bowl — Drift Formations',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_DUST_FLOOR,
  },
  {
    id:             'dust-bowl-sink',
    label:          'Dust Bowl — Basin Sink',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_DUST_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionRim,
  regionDunes,
  regionFlat,
  regionBuried,
  regionDeep,
  regionDrift,
  regionSink,
] = REGIONS_A1Z2;

export const ZONE_A1Z2: ZoneDef = {
  id:           'dust-bowl',
  label:        'Dust Bowl',
  zone_act:     1,
  region_defs:  [
    regionRim,
    regionDunes,
    regionFlat,
    regionBuried,
    regionDeep,
    regionDrift,
    regionSink,
  ],
  enemy_flavour: 'wanderers',
  tint:          TINT_DUST_FLOOR,
};
