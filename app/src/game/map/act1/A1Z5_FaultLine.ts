/**
 * Act I — Zone 5 — FAULT LINE
 * Archetype index: 5
 * Tint: 0x705848 (warm brown-grey)
 * Enemy flavour: wanderers
 *
 * A surface fault system — parallel fractures running across the terrain where tectonic
 * plates have shifted. The defining feature is the fault scarps: abrupt elevation changes
 * where one plate has moved relative to another. Rooms are bisected by these scarps,
 * creating terrain that rewards vertical thinking. Wanderers patrol erratically — they
 * cross the scarps, appear on elevated sections, drop down. Warm brown-grey palette
 * with amber glow tracing every scarp face.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_FAULT_FLOOR: number = 0x705848;  // warm brown-grey surface
const TINT_FAULT_SCARP: number = 0x503830;  // darker scarp face
const TINT_FAULT_HIGH:  number = 0x887060;  // elevated platform surface
const TINT_FAULT_CRACK: number = 0x302018;  // deep fault crack
const TINT_FAULT_GLOW:  number = 0xaa7744;  // warm amber fault glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// Elevated floor section — same size helper but TINT_FAULT_HIGH tinted
function highFloor(
  ox: number, oy: number, w: number, h: number
): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx: tx + ox, ty: ty + oy, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z5: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-traverse-a ────────────────────────────────────────────────────────
  // 80×64. Gentle fault approach. Single E-W scarp at mid-depth with 10-tile gap
  // at centre. Low side (south) TINT_FAULT_FLOOR; high side (north) TINT_FAULT_HIGH
  // floor overlay. 3 wanderer markers — 1 south, 1 at gap, 1 north.
  {
    id:           'fault-traverse-a',
    zone_act:     1,
    region_types: ['fault-line-surface'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // E-W scarp at ty=32 — full width, gap at tx=35-44
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i + 45, ty: 32, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i, ty: 33, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i + 45, ty: 33, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // High side floor overlay (north of scarp) — TINT_FAULT_HIGH, depth 1
      ...highFloor(0, 0, 80, 31).map(t =>
        ({ ...t, tint: TINT_FAULT_HIGH })
      ),
      // Amber glow at scarp gap
      { tx: 40, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 52, type: 'enemy' },  // south low side
      { id: 'e1', tx: 40, ty: 32, type: 'enemy' },  // at gap
      { id: 'e2', tx: 40, ty: 14, type: 'enemy' },  // north high side
    ],
    min_room_tier: 0,
  },

  // ── fault-traverse-b ────────────────────────────────────────────────────────
  // 96×64. Wide fault flat. N-S scarp on east third — raised east platform with no
  // access here (visual). Main floor TINT_FAULT_FLOOR. East platform TINT_FAULT_HIGH.
  // 3 wanderer markers on main floor.
  {
    id:           'fault-traverse-b',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // N-S scarp at tx=64 — from ty=4 to ty=60
      ...Array.from({ length: 57 }, (_, i) =>
        ({ tx: 64, ty: i + 4, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 57 }, (_, i) =>
        ({ tx: 65, ty: i + 4, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // East platform floor overlay — TINT_FAULT_HIGH, depth 1
      ...highFloor(66, 0, 30, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow along scarp face
      { tx: 64, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 64, ty: 44, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-traverse-c ────────────────────────────────────────────────────────
  // 64×80. Two opposing scarps create patchwork floor. West-to-east elevation
  // rises at ty=20, falls back at ty=56. Irregular two-tone floor. 4 wanderers.
  {
    id:           'fault-traverse-c',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Scarp 1 at ty=20 — gap at tx=28-35
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i + 36, ty: 20, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 2 at ty=56 — gap at tx=28-35
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i, ty: 56, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i + 36, ty: 56, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Mid-section floor overlay — TINT_FAULT_HIGH between ty=21 and ty=55
      ...highFloor(0, 21, 64, 34).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at both gaps
      { tx: 32, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 32, ty: 56, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 48, ty: 36, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-traverse-d ────────────────────────────────────────────────────────
  // 80×80. Three parallel terraced E-W scarps at ty=20, ty=40, ty=60. Gaps offset.
  // Stepwise elevation. 4 wanderers + 1 mineral on top terrace.
  {
    id:           'fault-traverse-d',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Terrace 1 at ty=60 — gap at tx=10-19 (west)
      ...Array.from({ length: 10 }, (_, i) =>
        ({ tx: i, ty: 60, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: i + 20, ty: 60, frame: i < 30 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Terrace 2 at ty=40 — gap at tx=35-44 (centre)
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 35 }, (_, i) =>
        ({ tx: i + 45, ty: 40, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Terrace 3 at ty=20 — gap at tx=60-69 (east)
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: i, ty: 20, frame: i < 30 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        ({ tx: i + 70, ty: 20, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Floor overlays per terrace
      ...highFloor(0, 41, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 21, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  80, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at each gap
      { tx: 14,  ty: 60, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 40,  ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 65,  ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 68, type: 'enemy'   },
      { id: 'e1', tx: 20, ty: 50, type: 'enemy'   },
      { id: 'e2', tx: 56, ty: 30, type: 'enemy'   },
      { id: 'e3', tx: 20, ty: 10, type: 'enemy'   },
      { id: 'm0', tx: 60, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── fault-traverse-e ────────────────────────────────────────────────────────
  // 64×64. Deep central crack forces E/W gap routing. Crack 4×2 blocked
  // TINT_FAULT_CRACK at mid-depth. E gap (tx=0-9) and W gap (tx=54-63). 4 wanderers.
  {
    id:           'fault-traverse-e',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-grid'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Crack wall at ty=30-31 — gap on west (tx=0-9) and east (tx=54-63)
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: i + 10, ty: 30, frame: i < 22 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: i + 10, ty: 31, frame: i < 22 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
      ),
      // Glow at crack and gaps
      { tx: 32, ty: 30, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 5,  ty: 30, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 58, ty: 30, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 6,  ty: 14, type: 'enemy' },
      { id: 'e1', tx: 58, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 6,  ty: 50, type: 'enemy' },
      { id: 'e3', tx: 58, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-traverse-f ────────────────────────────────────────────────────────
  // 80×64. Asymmetric fault step. N-S scarp along centreline (tx=38-39), two
  // crossing points at ty=16 and ty=48 (gaps in the scarp wall). 4 wanderers.
  {
    id:           'fault-traverse-f',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-grid'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // N-S scarp at tx=38-39 — gaps at ty=12-19 and ty=44-51
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 38, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 39, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 38, ty: i + 20, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 39, ty: i + 20, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 38, ty: i + 52, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: 39, ty: i + 52, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // East side elevated
      ...highFloor(40, 0, 40, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at crossing points
      { tx: 38, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 38, ty: 48, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-traverse-g ────────────────────────────────────────────────────────
  // 64×80. Compressed terrace sequence. Four E-W scarps at ty=16, ty=32, ty=48,
  // ty=64 (each 2-tile-wide blocked). Gaps alternate west/east/west/east. Each
  // terrace has TINT_FAULT_HIGH overlay progressively brighter. 4 markers, one per.
  {
    id:           'fault-traverse-g',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-elevated'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Scarp 1 at ty=64 — gap west (tx=0-9)
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i + 10, ty: 64, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i + 10, ty: 65, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 2 at ty=48 — gap east (tx=54-63)
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i, ty: 48, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i, ty: 49, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 3 at ty=32 — gap west (tx=0-9)
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i + 10, ty: 32, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i + 10, ty: 33, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 4 at ty=16 — gap east (tx=54-63)
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i, ty: 17, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Progressive TINT_FAULT_HIGH overlays per terrace
      ...highFloor(0, 50, 64, 13).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 34, 64, 13).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 18, 64, 13).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  64, 15).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at each gap
      { tx: 5,  ty: 64, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 58, ty: 48, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 5,  ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 58, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 72, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 56, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 8,  type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-traverse-h ────────────────────────────────────────────────────────
  // 96×80. Wide fault plain. Major 3-tile-high scarp at ty=52 — full width, 16-tile
  // gap at centre. High side north. 4 wanderers — 2 south, 2 north.
  {
    id:           'fault-traverse-h',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-elevated'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // Major scarp 3 tiles wide at ty=50-52
      ...Array.from({ length: 3 }, (_, row) =>
        [
          ...Array.from({ length: 40 }, (_, i) =>
            ({ tx: i, ty: row + 50, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 40 }, (_, i) =>
            ({ tx: i + 56, ty: row + 50, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // North high side floor
      ...highFloor(0, 0, 96, 49).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at gap
      { tx: 48, ty: 51, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 64, type: 'enemy' },
      { id: 'e1', tx: 72, ty: 64, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-traverse-i ────────────────────────────────────────────────────────
  // 80×64. Deep fault section. Multiple parallel crack lines (1-tile non-blocked
  // TINT_FAULT_CRACK decorative) E-W at ty=10, ty=22, ty=34, ty=46, ty=56. Floor
  // looks stressed. Amber glow traces each crack. 5 wanderers.
  {
    id:           'fault-traverse-i',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-descent'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Five crack lines — non-blocked decorative
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 10, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 22, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 34, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 46, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 56, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      // Glow traces along cracks
      { tx: 20, ty: 10, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 60, ty: 22, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 40, ty: 34, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 20, ty: 46, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 60, ty: 56, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 5,  type: 'enemy' },
      { id: 'e1', tx: 56, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 28, type: 'enemy' },
      { id: 'e3', tx: 64, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-traverse-j ────────────────────────────────────────────────────────
  // 64×80. Extreme terrace. Massive 3-tile scarp full width at ty=40 with 8-tile
  // gap. High north, low south. 5 wanderers — 1 south, 4 north. 1 loot north.
  {
    id:           'fault-traverse-j',
    zone_act:     1,
    region_types: ['fault-line-descent', 'fault-line-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Massive 3-tile scarp at ty=40-42 — gap at tx=28-35
      ...Array.from({ length: 3 }, (_, row) =>
        [
          ...Array.from({ length: 28 }, (_, i) =>
            ({ tx: i, ty: row + 40, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 28 }, (_, i) =>
            ({ tx: i + 36, ty: row + 40, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // North high side
      ...highFloor(0, 0, 64, 39).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at gap
      { tx: 32, ty: 41, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 60, type: 'enemy' },
      { id: 'e1', tx: 12, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 30, type: 'enemy' },
      { id: 'l0', tx: 8,  ty: 6,  type: 'loot'  },
    ],
    min_room_tier: 2,
  },

  // ── fault-traverse-k ────────────────────────────────────────────────────────
  // 80×80. Pre-boss funnel. Scarps from both sides step inward. Crack lines dense.
  // 5 wanderers in the narrowing zone.
  {
    id:           'fault-traverse-k',
    zone_act:     1,
    region_types: ['fault-line-descent', 'fault-line-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // West scarp steps inward northward
      { tx: 0,  ty: 72, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 8,  ty: 56, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 16, ty: 40, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 24, ty: 24, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 28, ty: 8,  frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      // East scarp steps inward northward
      { tx: 79, ty: 72, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 71, ty: 56, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 63, ty: 40, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 55, ty: 24, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 51, ty: 8,  frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      // Dense crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 64, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      // Glow
      { tx: 24, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 56, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 40, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 68, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 52, type: 'enemy' },
      { id: 'e2', tx: 52, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 8,  type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-traverse-l ────────────────────────────────────────────────────────
  // 96×64. Final traversal. Multiple terrace levels visible. 5 wanderers.
  // High amber glow on all scarp faces.
  {
    id:           'fault-traverse-l',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-core'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Three terrace scarps — E-W, staggered
      // Scarp 1 at ty=20 — gap east (tx=80-89)
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 20, frame: i < 40 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 2 at ty=40 — gap centre (tx=43-52)
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i + 53, ty: 40, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Terrace overlays
      ...highFloor(0, 0,  96, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 21, 96, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow
      { tx: 84, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 48, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 52, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 52, type: 'enemy' },
      { id: 'e2', tx: 84, ty: 10, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 30, type: 'enemy' },
      { id: 'e4', tx: 72, ty: 30, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-combat-a ──────────────────────────────────────────────────────────
  // 64×64. Scarp fight. 2-tile scarp at ty=20 with 6-tile gap. 5 wanderers
  // on the high side — fight is uphill.
  {
    id:           'fault-combat-a',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Scarp at ty=20-21 — gap at tx=29-34
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i + 35, ty: 20, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i, ty: 21, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        ({ tx: i + 35, ty: 21, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // North high side
      ...highFloor(0, 0, 64, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 32, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 10, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 10, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 10, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 6,  type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-combat-b ──────────────────────────────────────────────────────────
  // 64×64. Platform ambush. E half elevated. E exit from platform. 5 wanderers —
  // 3 on platform, 2 at ground level.
  {
    id:           'fault-combat-b',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // N-S scarp at tx=32-33 — no gaps
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 32, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 33, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // East half elevated — but E exit works through scarp via connection
      ...highFloor(34, 0, 30, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 32, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 48, ty: 14, type: 'enemy' },  // platform
      { id: 'e1', tx: 48, ty: 32, type: 'enemy' },  // platform
      { id: 'e2', tx: 48, ty: 50, type: 'enemy' },  // platform
      { id: 'e3', tx: 12, ty: 20, type: 'enemy' },  // ground
      { id: 'e4', tx: 12, ty: 48, type: 'enemy' },  // ground
    ],
    min_room_tier: 0,
  },

  // ── fault-combat-c ──────────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. Elevated west half. W exit from elevation. 5 wanderers.
  {
    id:           'fault-combat-c',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // N-S scarp at tx=30-31 — no gaps
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 30, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 31, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // West half elevated
      ...highFloor(0, 0, 29, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 30, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 14, type: 'enemy' },  // platform
      { id: 'e1', tx: 14, ty: 32, type: 'enemy' },  // platform
      { id: 'e2', tx: 14, ty: 50, type: 'enemy' },  // platform
      { id: 'e3', tx: 48, ty: 20, type: 'enemy' },  // ground
      { id: 'e4', tx: 48, ty: 48, type: 'enemy' },  // ground
    ],
    min_room_tier: 0,
  },

  // ── fault-combat-d ──────────────────────────────────────────────────────────
  // 80×64. Crack field fight. Three parallel 1-tile blocked E-W cracks at ty=16,
  // ty=32, ty=48. Gaps alternate E/W/E. 6 wanderers distributed across levels.
  {
    id:           'fault-combat-d',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-elevated'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Crack 1 at ty=16 — gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
      ),
      { tx: 74, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Crack 2 at ty=32 — gap west (tx=0-9)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i + 10, ty: 32, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
      ),
      { tx: 5, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Crack 3 at ty=48 — gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 48, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
      ),
      { tx: 74, ty: 48, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 74, ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 6,  type: 'enemy' },
      { id: 'e2', tx: 5,  ty: 24, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 74, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 24, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-combat-e ──────────────────────────────────────────────────────────
  // 64×80. Two-platform combat. Scarp at mid-depth. Two 4-tile crossing points.
  // 6 wanderers — 4 high, 2 at crossings.
  {
    id:           'fault-combat-e',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-elevated'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Scarp at ty=38-39 — two 4-tile crossings at tx=8-11 and tx=52-55
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 38, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 39, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        ({ tx: i + 12, ty: 38, frame: i < 20 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        ({ tx: i + 12, ty: 39, frame: i < 20 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 56, ty: 38, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i + 56, ty: 39, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // North high side
      ...highFloor(0, 0, 64, 37).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 10, ty: 38, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 54, ty: 38, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 52, ty: 16, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 28, type: 'enemy' },
      { id: 'e4', tx: 10, ty: 38, type: 'enemy' },  // crossing
      { id: 'e5', tx: 54, ty: 38, type: 'enemy' },  // crossing
    ],
    min_room_tier: 1,
  },

  // ── fault-combat-f ──────────────────────────────────────────────────────────
  // 80×64. Terrace gauntlet. Four terraces (4 E-W scarps). One dominant wanderer
  // pair per terrace. Player must advance through each defended level. 6 markers.
  {
    id:           'fault-combat-f',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-descent'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Four terrace scarps — staggered gaps
      ...Array.from({ length: 55 }, (_, i) =>
        ({ tx: i + 25, ty: 14, frame: i < 28 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 12, ty: 14, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      ...Array.from({ length: 60 }, (_, i) =>
        ({ tx: i, ty: 28, frame: i < 30 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 68, ty: 28, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      ...Array.from({ length: 55 }, (_, i) =>
        ({ tx: i + 25, ty: 44, frame: i < 28 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 12, ty: 44, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Terrace floor overlays
      ...highFloor(0, 0,  80, 13).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 15, 80, 12).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 29, 80, 14).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 56, ty: 6,  type: 'enemy' },
      { id: 'e2', tx: 68, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 36, type: 'enemy' },
      { id: 'e4', tx: 64, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 40, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-combat-g ──────────────────────────────────────────────────────────
  // 64×64. Cross-fault junction fight. Central deep crack landmark (4×2 blocked).
  // All four exits. 6 wanderers exploiting all directions.
  {
    id:           'fault-combat-g',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-elevated'],
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
      // Central 4×2 crack landmark — blocked
      { tx: 30, ty: 30, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 30, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 33, ty: 30, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 30, ty: 31, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 31, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 32, ty: 31, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 33, ty: 31, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 12, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 52, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-combat-h ──────────────────────────────────────────────────────────
  // 48×64. Compressed fault throat. Two scarps with 4-tile gaps. 6 wanderers.
  // No room to avoid contact.
  {
    id:           'fault-combat-h',
    zone_act:     1,
    region_types: ['fault-line-descent', 'fault-line-deep'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // Scarp 1 at ty=20 — gap at tx=22-25
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i + 26, ty: 20, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp 2 at ty=44 — gap at tx=22-25
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i, ty: 44, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 22 }, (_, i) =>
        ({ tx: i + 26, ty: 44, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 24, ty: 44, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Terrace overlays
      ...highFloor(0, 0,  48, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 21, 48, 22).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 36, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 10, ty: 30, type: 'enemy' },
      { id: 'e3', tx: 36, ty: 30, type: 'enemy' },
      { id: 'e4', tx: 10, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 36, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-combat-i ──────────────────────────────────────────────────────────
  // 80×64. Asymmetric terrace fight. Heavy scarping west; open east. 6 wanderers
  // use both levels simultaneously — fight on two elevation planes.
  {
    id:           'fault-combat-i',
    zone_act:     1,
    region_types: ['fault-line-descent', 'fault-line-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // N-S scarp at tx=36-37 — two crossings at ty=8-15 and ty=48-55
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 36, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 37, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 36, ty: i + 16, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 37, ty: i + 16, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 36, ty: i + 56, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: 37, ty: i + 56, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // West side elevated
      ...highFloor(0, 0, 35, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 36, ty: 12, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 36, ty: 52, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-combat-j ──────────────────────────────────────────────────────────
  // 80×80. Maximum fault combat. Multiple terrace levels, crack formations,
  // amber glow throughout. 6 wanderers at full erratic mobility.
  {
    id:           'fault-combat-j',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Two E-W scarps — staggered gaps
      // Scarp 1 at ty=26 — gap west (tx=0-9)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i + 10, ty: 26, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 5, ty: 26, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp 2 at ty=52 — gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 52, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 74, ty: 52, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Terrace overlays
      ...highFloor(0, 0,  80, 25).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 27, 80, 24).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Dense crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 14, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 66, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 5,  ty: 14, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 66, type: 'enemy' },
      { id: 'e5', tx: 74, ty: 66, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-dead-a ────────────────────────────────────────────────────────────
  // 32×32. Small fault pocket. Elevated back section. 1 loot, 1 mineral.
  {
    id:           'fault-dead-a',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step', 'fault-line-grid'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Small scarp at ty=16 — full width, no gap (dead-end, back wall)
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 16 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 32, 15).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 16, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 22, type: 'loot'    },
      { id: 'm0', tx: 22, ty: 22, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── fault-dead-b ────────────────────────────────────────────────────────────
  // 48×32. Wide scarp alcove. 2 loot, 1 mineral. 1 wanderer on elevated.
  {
    id:           'fault-dead-b',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step'],
    type:         'dead-end',
    size:         { w: 48, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 31 },
    ],
    tiles: floor(48, 32),
    structures: [
      // Scarp at ty=16 — gap at tx=20-27
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: i + 28, ty: 16, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 48, 15).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 24, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 6,  type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 24, type: 'loot'    },
      { id: 'l1', tx: 24, ty: 24, type: 'loot'    },
      { id: 'm0', tx: 10, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── fault-dead-c ────────────────────────────────────────────────────────────
  // 32×48. Narrow crack pocket. Amber glow from floor crack. 3 mineral. 1 loot.
  {
    id:           'fault-dead-c',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-elevated'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Floor crack — N-S
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 16, ty: i, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      { tx: 16, ty: 6, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 28, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 14, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 22, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── fault-dead-d ────────────────────────────────────────────────────────────
  // 48×48. Terrace alcove. Two level changes. 2 loot, 1 mineral. 1 wanderer.
  {
    id:           'fault-dead-d',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-descent'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Scarp 1 at ty=28 — full width (dead-end back)
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 28, frame: i < 24 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 2 at ty=14 — full width
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 14, frame: i < 24 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 15, 48, 12).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  48, 13).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 24, ty: 14, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 36, type: 'enemy'   },
      { id: 'l0', tx: 10, ty: 20, type: 'loot'    },
      { id: 'l1', tx: 36, ty: 6,  type: 'loot'    },
      { id: 'm0', tx: 10, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── fault-dead-e ────────────────────────────────────────────────────────────
  // 32×32. Simple elevated pocket. 2 loot. No enemies.
  {
    id:           'fault-dead-e',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-grid'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Small scarp at ty=16
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: i, ty: 16, frame: i < 16 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 32, 15).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 8, type: 'loot' },
      { id: 'l1', tx: 22, ty: 8, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── fault-dead-f ────────────────────────────────────────────────────────────
  // 48×48. Deep fault vent. Strong amber glow. 2 loot, 2 mineral. 2 wanderers.
  {
    id:           'fault-dead-f',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-descent'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Central crack vent — 2×2 blocked
      { tx: 22, ty: 14, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 23, ty: 14, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 22, ty: 15, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 23, ty: 15, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 22, ty: 14, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
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

  // ── fault-dead-g ────────────────────────────────────────────────────────────
  // 32×48. Late crack mineral deposit. 4 mineral, 1 loot, 1 wanderer.
  {
    id:           'fault-dead-g',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-core'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Crack lines with mineral deposits
      { tx: 16, ty: 6,  frame: 13, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 16, ty: 14, frame: 13, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 16, ty: 22, frame: 13, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 16, ty: 30, frame: 13, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 38, type: 'enemy'   },
      { id: 'l0', tx: 6,  ty: 38, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 6,  ty: 14, type: 'mineral' },
      { id: 'm2', tx: 22, ty: 22, type: 'mineral' },
      { id: 'm3', tx: 22, ty: 30, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── fault-dead-h ────────────────────────────────────────────────────────────
  // 48×48. Rich guarded terrace pocket. 3 loot, 3 mineral, 3 wanderers on highest.
  {
    id:           'fault-dead-h',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-core'],
    type:         'dead-end',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
    ],
    tiles: floor(48, 48),
    structures: [
      // Scarp at ty=20 — full width (vault wall)
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 20, frame: i < 24 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 48, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 24, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 8,  type: 'enemy'   },
      { id: 'e1', tx: 24, ty: 6,  type: 'enemy'   },
      { id: 'e2', tx: 40, ty: 8,  type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 30, type: 'loot'    },
      { id: 'l1', tx: 24, ty: 34, type: 'loot'    },
      { id: 'l2', tx: 40, ty: 30, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 40, type: 'mineral' },
      { id: 'm1', tx: 24, ty: 40, type: 'mineral' },
      { id: 'm2', tx: 40, ty: 40, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // JUNCTION ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-junction-a ────────────────────────────────────────────────────────
  // 64×64. Scarp east junction. Central 3×3 scarp feature. E exit elevated. 2 wanderers.
  {
    id:           'fault-junction-a',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step', 'fault-line-grid'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // N-S scarp at tx=36-37 creating elevated east section
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 36, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 37, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(38, 0, 26, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 36, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Central 3×3 scarp landmark on main floor
      { tx: 18, ty: 28, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 19, ty: 28, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 20, ty: 28, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 18, ty: 29, frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 19, ty: 29, frame: 36, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 20, ty: 29, frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 18, ty: 30, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 19, ty: 30, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 20, ty: 30, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-junction-b ────────────────────────────────────────────────────────
  // 64×64. Scarp west junction. Elevated west. W exit. 2 wanderers.
  {
    id:           'fault-junction-b',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step', 'fault-line-grid'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // N-S scarp at tx=26-27
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 26, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 27, ty: i, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 25, 64).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 26, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 46, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-junction-c ────────────────────────────────────────────────────────
  // 80×64. Flat cross junction. Four corner scarp fragments. All passages. 3 wanderers.
  {
    id:           'fault-junction-c',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-grid', 'fault-line-elevated'],
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
      // Four corner scarp fragments — 2×2 each
      { tx: 4,  ty: 4,  frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 5,  ty: 4,  frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 4,  ty: 5,  frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 5,  ty: 5,  frame: 36, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 4,  ty: 4,  frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 74, ty: 4,  frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 75, ty: 4,  frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 74, ty: 5,  frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 75, ty: 5,  frame: 36, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 74, ty: 4,  frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 4,  ty: 58, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 5,  ty: 58, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 4,  ty: 59, frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 5,  ty: 59, frame: 36, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 4,  ty: 58, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 74, ty: 58, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 75, ty: 58, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 74, ty: 59, frame: 35, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 75, ty: 59, frame: 36, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 74, ty: 58, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── fault-junction-d ────────────────────────────────────────────────────────
  // 64×80. Terrace junction. Two terrace levels. E exit from upper. 3 wanderers.
  {
    id:           'fault-junction-d',
    zone_act:     1,
    region_types: ['fault-line-grid', 'fault-line-elevated', 'fault-line-descent'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // E-W scarp at ty=40 — gap at tx=28-35
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 28 }, (_, i) =>
        ({ tx: i + 36, ty: 40, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...highFloor(0, 0, 64, 39).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      { tx: 32, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 60, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 52, ty: 20, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-junction-e ────────────────────────────────────────────────────────
  // 64×64. Crack junction. Major E-W crack line across room. W exit from low side.
  // 3 wanderers.
  {
    id:           'fault-junction-e',
    zone_act:     1,
    region_types: ['fault-line-step', 'fault-line-descent'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Major crack line at ty=32 — non-blocked decorative
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 })
      ),
      { tx: 32, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 8,  ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 56, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-junction-f ────────────────────────────────────────────────────────
  // 80×64. Wide junction. Central scarp landmark. E exit. 3 wanderers.
  {
    id:           'fault-junction-f',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-descent'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // Central 4×4 scarp formation as landmark
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 30, frame: tx < 2 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── fault-junction-g ────────────────────────────────────────────────────────
  // 64×64. Deep grid junction. Dense scarp fragments. All passages maintained. 4 wanderers.
  {
    id:           'fault-junction-g',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-descent'],
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
      // Scattered scarp fragments — off passage lanes
      { tx: 8,  ty: 8,  frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 8,  ty: 8,  frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 48, ty: 8,  frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 48, ty: 8,  frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 8,  ty: 50, frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 48, ty: 50, frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 48, ty: 50, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 20, ty: 20, frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 20, ty: 20, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
      { tx: 42, ty: 42, frame: 14, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 42, ty: 42, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 52, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-junction-h ────────────────────────────────────────────────────────
  // 80×80. Large late junction. 4×4 central crack formation with amber glow.
  // 4 wanderers on elevated flanks.
  {
    id:           'fault-junction-h',
    zone_act:     1,
    region_types: ['fault-line-deep', 'fault-line-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // 4×4 central crack formation — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 38, frame: tx < 2 ? 28 : 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Elevated east section
      ...highFloor(52, 0, 28, 80).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // N-S scarp edge for elevated section
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 52, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 60, type: 'enemy' },
      { id: 'e2', tx: 64, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 64, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS-APPROACH ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-approach-a ────────────────────────────────────────────────────────
  // 80×80. Fault at maximum stress. Scarps everywhere. 5 wanderers across multiple levels.
  {
    id:           'fault-approach-a',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Three overlapping scarps — complex patchwork
      // Scarp 1 at ty=20 — gap at tx=36-45
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 34 }, (_, i) =>
        ({ tx: i + 46, ty: 20, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 2 at ty=40 — gap at tx=18-27
      ...Array.from({ length: 18 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 52 }, (_, i) =>
        ({ tx: i + 28, ty: 40, frame: i < 26 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Scarp 3 at ty=60 — gap at tx=54-63
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i, ty: 60, frame: i < 27 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 64, ty: 60, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Terrace overlays
      ...highFloor(0, 0,  80, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 21, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 41, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glows at gaps
      { tx: 40, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 22, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 58, ty: 60, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 40, ty: 70, type: 'enemy' },
      { id: 'e1', tx: 22, ty: 50, type: 'enemy' },
      { id: 'e2', tx: 58, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 28, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 8,  type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-approach-b ────────────────────────────────────────────────────────
  // 96×64. Three scarp gauntlet. Gaps misaligned. 6 wanderers.
  {
    id:           'fault-approach-b',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'standard',
    size:         { w: 96, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 64),
    structures: [
      // Stage 1 at ty=16 — gap west (tx=4-13)
      ...Array.from({ length: 4 }, (_, i) =>
        ({ tx: i, ty: 16, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i + 14, ty: 16, frame: i < 41 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 8, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Stage 2 at ty=32 — gap centre (tx=43-52)
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 43 }, (_, i) =>
        ({ tx: i + 53, ty: 32, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 48, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Stage 3 at ty=48 — gap east (tx=82-91)
      ...Array.from({ length: 82 }, (_, i) =>
        ({ tx: i, ty: 48, frame: i < 41 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        ({ tx: i + 92, ty: 48, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 86, ty: 48, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Terrace overlays
      ...highFloor(0, 0,  96, 15).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 17, 96, 14).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 33, 96, 14).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 60, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 72, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 8,  ty: 56, type: 'enemy' },
      { id: 'e5', tx: 86, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-approach-c ────────────────────────────────────────────────────────
  // 80×96. Long fault descent. Terrace steps progressively lower. 6 wanderers.
  // Amber glow on all scarp faces.
  {
    id:           'fault-approach-c',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'standard',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 96),
    structures: [
      // Four scarp steps descending northward — gaps alternate
      // Scarp at ty=72 — gap east (tx=64-73)
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i, ty: 72, frame: i < 32 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: i + 74, ty: 72, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 68, ty: 72, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp at ty=52 — gap west (tx=6-15)
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: i, ty: 52, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i + 16, ty: 52, frame: i < 32 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 10, ty: 52, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp at ty=32 — gap east (tx=64-73)
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i, ty: 32, frame: i < 32 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: i + 74, ty: 32, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 68, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp at ty=12 — gap west (tx=6-15)
      ...Array.from({ length: 6 }, (_, i) =>
        ({ tx: i, ty: 12, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i + 16, ty: 12, frame: i < 32 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 10, ty: 12, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Progressive terrace overlays
      ...highFloor(0, 73, 80, 22).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 53, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 33, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 13, 80, 18).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  80, 11).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 30, ty: 82, type: 'enemy' },
      { id: 'e1', tx: 60, ty: 82, type: 'enemy' },
      { id: 'e2', tx: 10, ty: 60, type: 'enemy' },
      { id: 'e3', tx: 68, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 10, ty: 20, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 4,  type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-approach-d ────────────────────────────────────────────────────────
  // 96×80. Final approach. Two massive fault scarps converge toward north entry.
  // 5 wanderers. Maximum amber glow.
  {
    id:           'fault-approach-d',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'standard',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 48, ty: 0  },
    ],
    tiles: floor(96, 80),
    structures: [
      // West converging scarp
      { tx: 0,  ty: 64, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 8,  ty: 48, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 16, ty: 32, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 24, ty: 16, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 28, ty: 8,  frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 32, ty: 4,  frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      // East converging scarp
      { tx: 95, ty: 64, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 87, ty: 48, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 79, ty: 32, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 71, ty: 16, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 67, ty: 8,  frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      { tx: 63, ty: 4,  frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true },
      // Elevated central funnel section — north
      ...highFloor(0, 0, 96, 14).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Maximum glow
      { tx: 16, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 80, ty: 32, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 24, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 72, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 48, ty: 8,  frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
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

  // ── fault-boss-a ────────────────────────────────────────────────────────────
  // 96×96. Fault core multi-level arena. Three distinct terrace levels. Two 3-tile
  // scarps (two crossing points each). Boss on high platform. 6 markers distributed.
  // Amber glow traces every scarp edge.
  {
    id:           'fault-boss-a',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // Lower scarp at ty=60 — 3 tiles wide, two 8-tile crossings at tx=16-23 and tx=72-79
      ...Array.from({ length: 3 }, (_, row) =>
        [
          ...Array.from({ length: 16 }, (_, i) =>
            ({ tx: i, ty: row + 60, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 48 }, (_, i) =>
            ({ tx: i + 24, ty: row + 60, frame: i < 24 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 16 }, (_, i) =>
            ({ tx: i + 80, ty: row + 60, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // Upper scarp at ty=30 — 3 tiles wide, two 8-tile crossings at tx=24-31 and tx=64-71
      ...Array.from({ length: 3 }, (_, row) =>
        [
          ...Array.from({ length: 24 }, (_, i) =>
            ({ tx: i, ty: row + 30, frame: 28, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 32 }, (_, i) =>
            ({ tx: i + 32, ty: row + 30, frame: i < 16 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 24 }, (_, i) =>
            ({ tx: i + 72, ty: row + 30, frame: 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // Terrace floor overlays
      ...highFloor(0, 33, 96, 26).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  96, 29).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at all crossings
      { tx: 20, ty: 61, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 76, ty: 61, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 28, ty: 31, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 68, ty: 31, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // High platform (boss territory)
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 76, ty: 16, type: 'enemy' },
      // Mid platform
      { id: 'e3', tx: 20, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 76, ty: 44, type: 'enemy' },
      // Low approach
      { id: 'e5', tx: 48, ty: 76, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-boss-b ────────────────────────────────────────────────────────────
  // 80×80. Circular fault depression. Full arena is one level lower than entry.
  // Circular scarp ring (2-tile blocked, radius 24, 4 gaps). Boss inside ring. 6 markers.
  {
    id:           'fault-boss-b',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Ring at radius ~24 from centre (40,40) — 4 cardinal gaps of 6 tiles
      // North arc (ty=16) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 16, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 17, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 16, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 17, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // South arc (ty=64) — gap at tx=37-42
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 64, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 2, ty: 65, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 64, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 37 }, (_, i) =>
        ({ tx: i + 43, ty: 65, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // West side (tx=16-17) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 18, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 17, ty: i + 18, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 16, ty: i + 43, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 17, ty: i + 43, frame: 21, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // East side (tx=64-65) — gap at ty=37-42
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 18, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 65, ty: i + 18, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 64, ty: i + 43, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 21 }, (_, i) =>
        ({ tx: 65, ty: i + 43, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // Interior depression floor overlay
      ...highFloor(18, 18, 46, 46).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow at all gaps and centre
      { tx: 40, ty: 16, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 16, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 64, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 40, ty: 64, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 40, ty: 40, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
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

  // ── fault-boss-c ────────────────────────────────────────────────────────────
  // 96×80. Asymmetric fault arena. Major E-W scarp at 2/3 depth with 3 crossing
  // points. East high platform, west low ground. Boss on east platform. 6 markers.
  {
    id:           'fault-boss-c',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // N-S scarp at tx=48-49 — full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 48, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 49, ty: i, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // E-W scarp at ty=52-54 across east half — 3 crossing points
      // West half no horizontal scarp — just the vertical one
      // 3 crossings at tx=52-55, tx=65-68, tx=84-87 break the vertical scarp
      // (gap in vertical scarp at those y-positions)
      // Additional E-W scarp on east half at ty=26 — single crossing
      ...Array.from({ length: 46 }, (_, i) =>
        ({ tx: i + 50, ty: 26, frame: 22, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      // East platform overlay
      ...highFloor(50, 0, 46, 79).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // North elevated section on east platform
      ...highFloor(50, 0, 46, 25).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Glow traces
      { tx: 48, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 48, ty: 52, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      { tx: 72, ty: 26, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 68, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 80, ty: 12, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 84, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 64, type: 'enemy' },
      { id: 'e5', tx: 20, ty: 40, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── fault-boss-d ────────────────────────────────────────────────────────────
  // 80×96. Five-tier fault exposure. Central 6×2 crack at arena centre glows
  // intensely. Boss spawns at the crack. 6 wanderers on different tiers.
  {
    id:           'fault-boss-d',
    zone_act:     1,
    region_types: ['fault-line-core'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // Four E-W scarps creating 5 tiers — gaps alternating
      // Scarp 1 at ty=75 — gap west (tx=0-9)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i + 10, ty: 75, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 5, ty: 75, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp 2 at ty=57 — gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 57, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 74, ty: 57, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp 3 at ty=38 — gap west (tx=0-9)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i + 10, ty: 38, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 5, ty: 38, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Scarp 4 at ty=20 — gap east (tx=70-79)
      ...Array.from({ length: 70 }, (_, i) =>
        ({ tx: i, ty: 20, frame: i < 35 ? 28 : 29, tint: TINT_FAULT_SCARP, depth: 4, blocked: true })
      ),
      { tx: 74, ty: 20, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
      // Tier floor overlays
      ...highFloor(0, 76, 80, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 58, 80, 16).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 39, 80, 17).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 21, 80, 16).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      ...highFloor(0, 0,  80, 19).map(t => ({ ...t, tint: TINT_FAULT_HIGH })),
      // Central 6×2 crack at arena midpoint (boss spawn) — blocked
      { tx: 37, ty: 46, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 38, ty: 46, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 39, ty: 46, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 40, ty: 46, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 41, ty: 46, frame: 28, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 42, ty: 46, frame: 29, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 37, ty: 47, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 38, ty: 47, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 39, ty: 47, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 40, ty: 47, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 41, ty: 47, frame: 35, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 42, ty: 47, frame: 36, tint: TINT_FAULT_CRACK, depth: 4, blocked: true },
      { tx: 40, ty: 46, frame: 7, tint: TINT_FAULT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // Tier 1 (bottom)
      { id: 'e0', tx: 40, ty: 84, type: 'enemy' },
      // Tier 2
      { id: 'e1', tx: 74, ty: 64, type: 'enemy' },
      // Tier 3 (boss territory — crack centre)
      { id: 'e2', tx: 20, ty: 46, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 46, type: 'enemy' },
      // Tier 4
      { id: 'e4', tx: 5,  ty: 28, type: 'enemy' },
      // Tier 5 (top)
      { id: 'e5', tx: 74, ty: 8,  type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── fault-connector-a ───────────────────────────────────────────────────────
  // 16×24. Narrow fault path. Single scarp step decoration.
  {
    id:           'fault-connector-a',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step', 'fault-line-grid', 'fault-line-elevated', 'fault-line-descent', 'fault-line-deep', 'fault-line-core'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      // Small scarp decoration
      { tx: 4,  ty: 10, frame: 13, tint: TINT_FAULT_SCARP, depth: 3 },
      { tx: 8,  ty: 10, frame: 13, tint: TINT_FAULT_SCARP, depth: 3 },
      { tx: 12, ty: 10, frame: 13, tint: TINT_FAULT_SCARP, depth: 3 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── fault-connector-b ───────────────────────────────────────────────────────
  // 24×16. Wide shallow connector. Two small scarp fragments flanking.
  {
    id:           'fault-connector-b',
    zone_act:     1,
    region_types: ['fault-line-surface', 'fault-line-step', 'fault-line-grid', 'fault-line-elevated', 'fault-line-descent', 'fault-line-deep', 'fault-line-core'],
    type:         'connector',
    size:         { w: 24, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 16),
    structures: [
      { tx: 4,  ty: 6, frame: 14, tint: TINT_FAULT_SCARP, depth: 3 },
      { tx: 5,  ty: 6, frame: 14, tint: TINT_FAULT_SCARP, depth: 3 },
      { tx: 18, ty: 6, frame: 14, tint: TINT_FAULT_SCARP, depth: 3 },
      { tx: 19, ty: 6, frame: 14, tint: TINT_FAULT_SCARP, depth: 3 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── fault-connector-c ───────────────────────────────────────────────────────
  // 16×32. Long narrow fault corridor with strata-like crack lines on walls.
  {
    id:           'fault-connector-c',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-descent', 'fault-line-deep', 'fault-line-core'],
    type:         'connector',
    size:         { w: 16, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 32),
    structures: [
      // Crack lines on west and east wall faces
      { tx: 2,  ty: 8,  frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 2,  ty: 16, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 2,  ty: 24, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 13, ty: 8,  frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 13, ty: 16, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 13, ty: 24, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── fault-connector-d ───────────────────────────────────────────────────────
  // 24×24. Short stub with central crack decoration. Amber glow.
  {
    id:           'fault-connector-d',
    zone_act:     1,
    region_types: ['fault-line-elevated', 'fault-line-descent', 'fault-line-deep', 'fault-line-core'],
    type:         'connector',
    size:         { w: 24, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 12, ty: 0  },
    ],
    tiles: floor(24, 24),
    structures: [
      // Central crack decoration
      { tx: 12, ty: 8,  frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 12, ty: 12, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 12, ty: 16, frame: 13, tint: TINT_FAULT_CRACK, depth: 2 },
      { tx: 12, ty: 12, frame: 7,  tint: TINT_FAULT_GLOW,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z5

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z5: RegionDef[] = [
  {
    id:             'fault-line-surface',
    label:          'Fault Line — Surface Approach',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-step',
    label:          'Fault Line — Scarp Step Field',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-grid',
    label:          'Fault Line — Mid-Fault Grid',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-elevated',
    label:          'Fault Line — Elevated Plateau Ring',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-descent',
    label:          'Fault Line — Lower Fault Descent',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   5,
    corridor_max:   10,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-deep',
    label:          'Fault Line — Deep Fault Branches',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_FAULT_FLOOR,
  },
  {
    id:             'fault-line-core',
    label:          'Fault Line — Boss Core',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_FAULT_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionSurface,
  regionStep,
  regionGrid,
  regionElevated,
  regionDescent,
  regionDeep,
  regionCore,
] = REGIONS_A1Z5;

export const ZONE_A1Z5: ZoneDef = {
  id:           'fault-line',
  label:        'Fault Line',
  zone_act:     1,
  region_defs:  [
    regionSurface,
    regionStep,
    regionGrid,
    regionElevated,
    regionDescent,
    regionDeep,
    regionCore,
  ],
  enemy_flavour: 'wanderers',
  tint:          TINT_FAULT_FLOOR,
};
