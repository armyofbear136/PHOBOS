/**
 * Act I — Zone 6 — LAVA SHELF
 * Archetype index: 6
 * Tint: 0x3a1a0a (deep char-black with orange undertone)
 * Enemy flavour: wanderers
 *
 * A volcanic shelf where active geological processes continue. The floor is cracked
 * basalt over active lava flows. Vent openings punctuate every room. Visual language
 * is dark and glowing — the darkest floor tints in Act I, offset by intense orange
 * and red glow from every vent and crack. Wanderers move quickly across the hot
 * surfaces. This zone uses more glow structures per room than any other Act I zone.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_LAVA_FLOOR:  number = 0x3a1a0a;  // deep char-black basalt
const TINT_LAVA_CRACK:  number = 0x1a0a00;  // void-black deep crack
const TINT_LAVA_BASALT: number = 0x4a2818;  // cooled basalt structure
const TINT_LAVA_VENT:   number = 0x1a0800;  // vent opening surround
const TINT_LAVA_GLOW:   number = 0xff6600;  // intense orange-red lava glow
const TINT_LAVA_HOT:    number = 0xcc3300;  // deep red heat glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z6: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-traverse-a ─────────────────────────────────────────────────────────
  // 48×64. Cooled crust section. Network of non-blocked crack lines (TINT_LAVA_CRACK)
  // showing cooling pattern. Two small vents (2×2 blocked, TINT_LAVA_VENT) at east
  // and west edges with intense glow. 3 wanderer markers.
  {
    id:           'lava-traverse-a',
    zone_act:     1,
    region_types: ['lava-shelf-crust'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // Cooling crack network — non-blocked decorative
      { tx: 6,  ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 12, ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 18, ty: 10, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 24, ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 30, ty: 10, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 36, ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 8,  ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 16, ty: 22, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 24, ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 32, ty: 22, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 40, ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 6,  ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 14, ty: 42, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 22, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 30, ty: 42, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 38, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 10, ty: 56, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 24, ty: 56, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 38, ty: 58, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      // West vent — 2×2 blocked
      { tx: 2,  ty: 28, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 3,  ty: 28, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 2,  ty: 29, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 3,  ty: 29, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 2,  ty: 28, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // East vent — 2×2 blocked
      { tx: 44, ty: 28, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 28, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 29, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 29, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 28, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 36, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-traverse-b ─────────────────────────────────────────────────────────
  // 64×64. Vent field crossing. Four vents (2×2 blocked, TINT_LAVA_VENT) distributed
  // organically. Dense glow from all four. 3 wanderer markers.
  {
    id:           'lava-traverse-b',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Vent 1 — NW area
      { tx: 8,  ty: 10, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 9,  ty: 10, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 8,  ty: 11, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 9,  ty: 11, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 8,  ty: 10, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Vent 2 — NE area
      { tx: 50, ty: 14, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 51, ty: 14, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 50, ty: 15, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 51, ty: 15, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 50, ty: 14, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Vent 3 — SW area
      { tx: 12, ty: 50, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 13, ty: 50, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 12, ty: 51, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 13, ty: 51, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 12, ty: 50, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Vent 4 — SE area
      { tx: 48, ty: 46, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 49, ty: 46, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 48, ty: 47, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 49, ty: 47, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 48, ty: 46, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 36, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-traverse-c ─────────────────────────────────────────────────────────
  // 48×80. Lava tube approach. Corridor narrows from 32 tiles (south) to 20 tiles
  // (north) via basalt column formations. Orange glow intensifies north. 3 wanderers.
  {
    id:           'lava-traverse-c',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-tube'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // West basalt column formations stepping inward
      { tx: 0,  ty: 48, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 1,  ty: 48, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 0,  ty: 49, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 1,  ty: 49, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 2,  ty: 36, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 3,  ty: 36, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 2,  ty: 37, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 3,  ty: 37, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 22, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 22, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 23, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 23, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      // East basalt column formations stepping inward
      { tx: 46, ty: 48, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 47, ty: 48, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 46, ty: 49, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 47, ty: 49, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 44, ty: 36, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 45, ty: 36, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 44, ty: 37, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 45, ty: 37, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 42, ty: 22, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 43, ty: 22, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 42, ty: 23, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 43, ty: 23, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      // Glow intensifying north
      { tx: 24, ty: 60, frame: 7, tint: TINT_LAVA_HOT,  depth: 2 },
      { tx: 24, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 24, ty: 8,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 64, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 44, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 16, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-traverse-d ─────────────────────────────────────────────────────────
  // 64×48. Wide shallow shelf. E-W lava flow trace (4-tile-wide TINT_LAVA_CRACK strip
  // with glow) at mid-depth. Non-blocked. 3 wanderers, 1 crossing the trace.
  {
    id:           'lava-traverse-d',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'standard',
    size:         { w: 64, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 48),
    structures: [
      // E-W lava flow trace at ty=22-25 — non-blocked, depth 1
      ...Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 64 }, (_, tx) =>
          ({ tx, ty: row + 22, frame: 0, tint: TINT_LAVA_CRACK, depth: 1 })
        )
      ).flat(),
      // Glow along the flow trace
      { tx: 16, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 48, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 24, type: 'enemy' },  // on the flow trace
      { id: 'e2', tx: 44, ty: 38, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-traverse-e ─────────────────────────────────────────────────────────
  // 64×64. Basalt column field. 8 columns (2×2 blocked, TINT_LAVA_BASALT) at
  // irregular positions. Crack lines radiate between them. 4 wanderer markers.
  {
    id:           'lava-traverse-e',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-platform'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // 8 basalt columns — irregular spacing
      { tx: 6,  ty: 8,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 7,  ty: 8,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 6,  ty: 9,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 7,  ty: 9,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 6,  ty: 8,  frame: 7,  tint: TINT_LAVA_HOT,   depth: 2 },
      { tx: 28, ty: 12, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 12, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 13, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 13, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 12, frame: 7,  tint: TINT_LAVA_HOT,   depth: 2 },
      { tx: 50, ty: 8,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 51, ty: 8,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 50, ty: 9,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 51, ty: 9,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 50, ty: 8,  frame: 7,  tint: TINT_LAVA_HOT,   depth: 2 },
      { tx: 12, ty: 32, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 13, ty: 32, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 12, ty: 33, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 13, ty: 33, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 12, ty: 32, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 40, ty: 28, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 41, ty: 28, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 40, ty: 29, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 41, ty: 29, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 40, ty: 28, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 8,  ty: 50, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 9,  ty: 50, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 8,  ty: 51, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 9,  ty: 51, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 34, ty: 48, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 48, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 49, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 49, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 48, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 54, ty: 52, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 55, ty: 52, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 54, ty: 53, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 55, ty: 53, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 54, ty: 52, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 22, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-traverse-f ─────────────────────────────────────────────────────────
  // 48×64. Vent corridor. East wall has 3 vents at equal spacing. West wall clean.
  // 4 wanderer markers along west passage.
  {
    id:           'lava-traverse-f',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-tube'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // Three east wall vents at equal spacing (ty=12, ty=30, ty=48)
      { tx: 44, ty: 12, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 12, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 13, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 13, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 12, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 44, ty: 30, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 30, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 31, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 31, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 30, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 44, ty: 48, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 48, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 49, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 45, ty: 49, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 44, ty: 48, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 16, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-traverse-g ─────────────────────────────────────────────────────────
  // 64×80. Double vent room. One massive vent (4×4 blocked, TINT_LAVA_VENT) at NE
  // corner and SW corner. Passage runs diagonally. 4 wanderers flanking the diagonal.
  {
    id:           'lava-traverse-g',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-platform'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // NE massive vent — 4×4
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 56, ty: ty + 4, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 58, ty: 6,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // SW massive vent — 4×4
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 4, ty: ty + 68, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 6,  ty: 70, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Diagonal crack lines
      { tx: 16, ty: 64, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 24, ty: 52, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 32, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 40, ty: 28, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 48, ty: 16, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 24, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-traverse-h ─────────────────────────────────────────────────────────
  // 80×64. Widest lava traversal. Six vents (2×2 blocked) distributed full width.
  // Dense crack lines everywhere. 4 wanderer markers.
  {
    id:           'lava-traverse-h',
    zone_act:     1,
    region_types: ['lava-shelf-platform', 'lava-shelf-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Six vents distributed across full width
      { tx: 4,  ty: 10, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 11, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 11, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 10, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 14, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 14, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 15, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 15, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 14, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 40, ty: 8,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 8,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 9,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 9,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 58, ty: 12, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 12, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 13, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 13, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 12, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 10, ty: 48, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 48, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 49, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 49, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 48, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 66, ty: 50, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 67, ty: 50, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 66, ty: 51, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 67, ty: 51, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 66, ty: 50, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Dense crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 32, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 48, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-traverse-i ─────────────────────────────────────────────────────────
  // 48×80. Deep lava tube. Basalt column walls (2-tile-wide, full length), passage
  // 20 tiles wide. Dark except vent glows at each end. 5 wanderer markers in tube.
  {
    id:           'lava-traverse-i',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-deep'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // West basalt wall — 2 tiles wide, full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // East basalt wall — 2 tiles wide, full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Vent at south end
      { tx: 22, ty: 72, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 72, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 73, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 73, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 72, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Vent at north end
      { tx: 22, ty: 6,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 6,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 7,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 7,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Glow fills tube
      { tx: 24, ty: 40, frame: 7, tint: TINT_LAVA_HOT, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 16, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 54, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 66, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-traverse-j ─────────────────────────────────────────────────────────
  // 64×64. Collapsing crust. 12 crack lines radiating from central 4×4 vent.
  // Maximum glow at vent centre. 5 wanderers circling.
  {
    id:           'lava-traverse-j',
    zone_act:     1,
    region_types: ['lava-shelf-deep', 'lava-shelf-edge'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central 4×4 vent — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 30, ty: ty + 30, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 32, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // 12 crack lines radiating from centre
      { tx: 32, ty: 28, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 32, ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 32, ty: 20, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 32, ty: 16, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 36, ty: 28, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 42, ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 48, ty: 20, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 36, ty: 36, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 42, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 28, ty: 36, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 22, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 28, ty: 28, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 22, ty: 24, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 24, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-traverse-k ─────────────────────────────────────────────────────────
  // 48×96. Long pre-boss tube. Maximum confinement. Multiple vent glows. 5 wanderers.
  {
    id:           'lava-traverse-k',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 48, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 96),
    structures: [
      // Basalt walls full height
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Vent glows at regular intervals
      { tx: 22, ty: 8,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 48, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 72, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 88, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 56, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 72, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 84, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-traverse-l ─────────────────────────────────────────────────────────
  // 64×64. Final traversal. Maximum heat activity. Dense basalt columns. 5 wanderers.
  {
    id:           'lava-traverse-l',
    zone_act:     1,
    region_types: ['lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Dense basalt column coverage — 10 columns
      { tx: 4,  ty: 6,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 6,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 7,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 7,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 22, ty: 8,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 23, ty: 8,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 22, ty: 9,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 23, ty: 9,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 22, ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 48, ty: 6,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 49, ty: 6,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 48, ty: 7,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 49, ty: 7,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 48, ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 8,  ty: 28, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 9,  ty: 28, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 8,  ty: 29, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 9,  ty: 29, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 8,  ty: 28, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 36, ty: 24, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 37, ty: 24, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 36, ty: 25, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 37, ty: 25, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 36, ty: 24, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 54, ty: 28, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 55, ty: 28, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 54, ty: 29, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 55, ty: 29, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 54, ty: 28, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 14, ty: 50, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 15, ty: 50, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 14, ty: 51, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 15, ty: 51, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 14, ty: 50, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 44, ty: 54, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 45, ty: 54, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 44, ty: 55, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 45, ty: 55, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 44, ty: 54, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      // Dense crack lines
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 18, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 52, type: 'enemy' },
      { id: 'e4', tx: 52, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-combat-a ───────────────────────────────────────────────────────────
  // 48×64. Vent ambush. Three vents in arc at 2/3 depth. 5 wanderers behind vents.
  {
    id:           'lava-combat-a',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // Three vents in arc at ty≈20
      // West vent
      { tx: 4,  ty: 18, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 18, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 19, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 19, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 18, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Centre vent (deeper in arc)
      { tx: 22, ty: 16, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 16, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 17, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 17, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 16, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // East vent
      { tx: 40, ty: 18, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 18, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 19, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 19, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 18, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 40, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 12, ty: 6,  type: 'enemy' },
      { id: 'e4', tx: 36, ty: 6,  type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-combat-b ───────────────────────────────────────────────────────────
  // 64×64. Basalt column ambush. E branch reinforcement. 5 wanderers.
  {
    id:           'lava-combat-b',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Two basalt columns — T-intersection cover
      { tx: 28, ty: 24, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 24, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 25, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 25, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 24, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 28, ty: 36, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 36, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 37, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 29, ty: 37, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 28, ty: 36, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 24, type: 'enemy' },  // E entry
      { id: 'e4', tx: 52, ty: 40, type: 'enemy' },  // E entry
    ],
    min_room_tier: 0,
  },

  // ── lava-combat-c ───────────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. W branch. 5 wanderers.
  {
    id:           'lava-combat-c',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Two basalt columns on east side
      { tx: 34, ty: 24, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 24, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 25, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 25, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 24, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 34, ty: 36, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 36, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 37, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 35, ty: 37, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 34, ty: 36, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 48, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 10, ty: 24, type: 'enemy' },  // W entry
      { id: 'e4', tx: 10, ty: 40, type: 'enemy' },  // W entry
    ],
    min_room_tier: 0,
  },

  // ── lava-combat-d ───────────────────────────────────────────────────────────
  // 64×64. Vent ring combat. Six vents in hexagonal pattern at radius 18. 6 wanderers
  // inside the ring. Player must enter. Intense glow from all six.
  {
    id:           'lava-combat-d',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-platform'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // Six vents in hexagonal arrangement at radius 18 from centre (32,32)
      // North
      { tx: 30, ty: 12, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 12, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 13, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 13, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 12, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // NE
      { tx: 46, ty: 20, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 47, ty: 20, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 46, ty: 21, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 47, ty: 21, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 46, ty: 20, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // SE
      { tx: 46, ty: 42, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 47, ty: 42, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 46, ty: 43, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 47, ty: 43, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 46, ty: 42, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // South
      { tx: 30, ty: 50, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 50, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 51, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 51, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 50, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // SW
      { tx: 14, ty: 42, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 15, ty: 42, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 14, ty: 43, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 15, ty: 43, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 14, ty: 42, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // NW
      { tx: 14, ty: 20, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 15, ty: 20, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 14, ty: 21, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 15, ty: 21, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 14, ty: 20, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 22, type: 'enemy' },
      { id: 'e1', tx: 42, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 42, ty: 36, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 22, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 22, ty: 28, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-combat-e ───────────────────────────────────────────────────────────
  // 48×80. Tube combat. Central basalt pillar (4×4 blocked) forces split approach.
  // 6 wanderers split between both paths.
  {
    id:           'lava-combat-e',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-platform'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // Basalt walls full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Central 4×4 basalt pillar at mid-room
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 22, ty: ty + 38, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 24, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 36, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 12, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 36, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-combat-f ───────────────────────────────────────────────────────────
  // 64×64. Crust rupture fight. 6×2 blocked central formation (TINT_LAVA_CRACK)
  // represents open lava. 6 wanderers on all sides — circular movement forced.
  {
    id:           'lava-combat-f',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // 6×2 blocked central rupture
      { tx: 29, ty: 30, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 30, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 33, ty: 30, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 34, ty: 30, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 29, ty: 31, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 30, ty: 31, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 31, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 32, ty: 31, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 33, ty: 31, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 34, ty: 31, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      // Maximum glow at rupture
      { tx: 32, ty: 30, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 29, ty: 30, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 34, ty: 30, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 8,  ty: 32, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 32, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 50, type: 'enemy' },
      { id: 'e5', tx: 48, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-combat-g ───────────────────────────────────────────────────────────
  // 64×64. Grid hub. Central vent. All four exits. 6 wanderers from all directions.
  {
    id:           'lava-combat-g',
    zone_act:     1,
    region_types: ['lava-shelf-platform', 'lava-shelf-deep'],
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
      // Central vent 2×2
      { tx: 30, ty: 30, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 30, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 31, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 31, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 14, ty: 50, type: 'enemy' },
      { id: 'e3', tx: 50, ty: 50, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 14, type: 'enemy' },
      { id: 'e5', tx: 14, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-combat-h ───────────────────────────────────────────────────────────
  // 48×48. Boiling tube combat. Tightest room. Basalt walls. 6 wanderers close quarters.
  {
    id:           'lava-combat-h',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-deep'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // Basalt walls — 2 tiles each side
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Maximum glow
      { tx: 24, ty: 8,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 24, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 24, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 34, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 14, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 34, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 14, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 34, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-combat-i ───────────────────────────────────────────────────────────
  // 64×64. Triple vent gauntlet. Three massive vents (4×4 blocked) in triangle.
  // 6 wanderers in orbital patterns. Extreme heat.
  {
    id:           'lava-combat-i',
    zone_act:     1,
    region_types: ['lava-shelf-deep', 'lava-shelf-edge'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // North vent 4×4
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 30, ty: ty + 8, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 32, ty: 10, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // SW vent 4×4
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 8, ty: ty + 44, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 10, ty: 46, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // SE vent 4×4
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 52, ty: ty + 44, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 54, ty: 46, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 28, type: 'enemy' },
      { id: 'e3', tx: 16, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 40, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-combat-j ───────────────────────────────────────────────────────────
  // 80×64. Final combat. Maximum lava activity. 8 vents various sizes. 6 wanderers.
  {
    id:           'lava-combat-j',
    zone_act:     1,
    region_types: ['lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // 8 vents of various sizes scattered
      { tx: 4,  ty: 8,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 8,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 9,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 9,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 6,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 6,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 40, ty: 8,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 8,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 9,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 41, ty: 9,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 40, ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 62, ty: 6,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 63, ty: 6,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 62, ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 10, ty: 44, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 44, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 45, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 45, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 44, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 36, ty: 48, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 37, ty: 48, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 36, ty: 48, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 56, ty: 46, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 57, ty: 46, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 56, ty: 47, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 57, ty: 47, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 56, ty: 46, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 72, ty: 50, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 73, ty: 50, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 72, ty: 50, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      // Dense crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 30, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 22, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 22, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 68, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-dead-a ─────────────────────────────────────────────────────────────
  // 24×32. Vent pocket. 1 loot, 1 mineral. Warm glow.
  {
    id:           'lava-dead-a',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents', 'lava-shelf-tube'],
    type:         'dead-end',
    size:         { w: 24, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 31 },
    ],
    tiles: floor(24, 32),
    structures: [
      // Small vent at back
      { tx: 10, ty: 6, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 6, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 7, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 7, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 6, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 6,  ty: 20, type: 'loot'    },
      { id: 'm0', tx: 16, ty: 20, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── lava-dead-b ─────────────────────────────────────────────────────────────
  // 32×32. Cooled flow alcove. Crack line decoration. 2 loot, 1 mineral. 1 wanderer.
  {
    id:           'lava-dead-b',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      // Crack line decorations
      { tx: 8,  ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 16, ty: 6,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 24, ty: 8,  frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
      { tx: 16, ty: 6,  frame: 7,  tint: TINT_LAVA_HOT,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 22, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 18, type: 'loot'    },
      { id: 'l1', tx: 20, ty: 18, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── lava-dead-c ─────────────────────────────────────────────────────────────
  // 24×48. Tube end pocket. 3 mineral along back wall. 1 loot.
  {
    id:           'lava-dead-c',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-platform'],
    type:         'dead-end',
    size:         { w: 24, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 47 },
    ],
    tiles: floor(24, 48),
    structures: [
      { tx: 12, ty: 6, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 12, ty: 28, type: 'loot'    },
      { id: 'm0', tx: 4,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 12, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 20, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── lava-dead-d ─────────────────────────────────────────────────────────────
  // 32×48. Vent cluster alcove. Three small vents. 2 loot, 1 mineral. 1 wanderer.
  {
    id:           'lava-dead-d',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-deep'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Three small vents along back
      { tx: 4,  ty: 6, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 6, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 7, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 7, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 6, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 14, ty: 4, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 15, ty: 4, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 14, ty: 4, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 22, ty: 6, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 6, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 7, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 7, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 6, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 30, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 20, type: 'loot'    },
      { id: 'l1', tx: 22, ty: 20, type: 'loot'    },
      { id: 'm0', tx: 16, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── lava-dead-e ─────────────────────────────────────────────────────────────
  // 24×32. Hot pocket. Single large vent. 2 loot. No enemies.
  {
    id:           'lava-dead-e',
    zone_act:     1,
    region_types: ['lava-shelf-platform', 'lava-shelf-deep'],
    type:         'dead-end',
    size:         { w: 24, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 31 },
    ],
    tiles: floor(24, 32),
    structures: [
      // Large central vent — 2×2
      { tx: 10, ty: 6, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 6, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 7, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 11, ty: 7, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 10, ty: 6, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 6,  ty: 20, type: 'loot' },
      { id: 'l1', tx: 16, ty: 20, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── lava-dead-f ─────────────────────────────────────────────────────────────
  // 32×48. Deep vent chamber. 4×4 vent structure. 2 loot, 2 mineral. 2 wanderers.
  {
    id:           'lava-dead-f',
    zone_act:     1,
    region_types: ['lava-shelf-deep', 'lava-shelf-edge'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // 4×4 central vent — blocked
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 14, ty: ty + 8, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 16, ty: 10, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 28, type: 'enemy'   },
      { id: 'e1', tx: 22, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 18, type: 'loot'    },
      { id: 'l1', tx: 22, ty: 18, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 38, type: 'mineral' },
      { id: 'm1', tx: 22, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── lava-dead-g ─────────────────────────────────────────────────────────────
  // 24×48. Late mineral tube end. 4 mineral near vent. 1 loot. 1 wanderer.
  {
    id:           'lava-dead-g',
    zone_act:     1,
    region_types: ['lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'dead-end',
    size:         { w: 24, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 47 },
    ],
    tiles: floor(24, 48),
    structures: [
      { tx: 10, ty: 6, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 30, type: 'enemy'   },
      { id: 'l0', tx: 12, ty: 38, type: 'loot'    },
      { id: 'm0', tx: 4,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 10, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 16, ty: 8,  type: 'mineral' },
      { id: 'm3', tx: 20, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── lava-dead-h ─────────────────────────────────────────────────────────────
  // 32×48. Rich guarded vent pocket. 3 loot, 3 mineral, 3 wanderers. Maximum heat.
  {
    id:           'lava-dead-h',
    zone_act:     1,
    region_types: ['lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // North wall vent
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 16 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      { tx: 16, ty: 2, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 22, type: 'enemy'   },
      { id: 'e1', tx: 16, ty: 18, type: 'enemy'   },
      { id: 'e2', tx: 24, ty: 22, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 8,  type: 'loot'    },
      { id: 'l1', tx: 16, ty: 6,  type: 'loot'    },
      { id: 'l2', tx: 24, ty: 8,  type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 36, type: 'mineral' },
      { id: 'm1', tx: 16, ty: 36, type: 'mineral' },
      { id: 'm2', tx: 24, ty: 36, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // JUNCTION ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-junction-a ─────────────────────────────────────────────────────────
  // 48×64. Vent east junction. Central 2×2 vent. E exit. 2 wanderers.
  {
    id:           'lava-junction-a',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents', 'lava-shelf-tube'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 47, ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // Central 2×2 vent
      { tx: 22, ty: 30, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 30, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 31, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 23, ty: 31, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 22, ty: 30, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 10, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 10, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-junction-b ─────────────────────────────────────────────────────────
  // 48×64. Vent west junction. W exit from cool side. 2 wanderers.
  {
    id:           'lava-junction-b',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents', 'lava-shelf-tube'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // East side vent
      { tx: 42, ty: 30, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 43, ty: 30, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 42, ty: 31, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 43, ty: 31, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 42, ty: 30, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 36, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-junction-c ─────────────────────────────────────────────────────────
  // 64×64. Quad vent cross junction. Four corner vents. All passages clear. 3 wanderers.
  {
    id:           'lava-junction-c',
    zone_act:     1,
    region_types: ['lava-shelf-vents', 'lava-shelf-platform'],
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
      // Four corner vents
      { tx: 4,  ty: 4,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 4,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 5,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 5,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 4,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 58, ty: 4,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 4,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 5,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 5,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 4,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 4,  ty: 58, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 58, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 59, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 59, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 58, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 58, ty: 58, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 58, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 59, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 59, ty: 59, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 58, ty: 58, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 40, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── lava-junction-d ─────────────────────────────────────────────────────────
  // 64×80. Tube east junction. Basalt walls north and west. E exit from open section.
  // 3 wanderers.
  {
    id:           'lava-junction-d',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-platform'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Basalt walls narrowing to east junction area
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Central vent
      { tx: 30, ty: 38, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 38, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 39, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 31, ty: 39, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 30, ty: 38, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-junction-e ─────────────────────────────────────────────────────────
  // 48×64. Crust junction. Crack lines across floor. W exit. 3 wanderers.
  {
    id:           'lava-junction-e',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-deep'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // Dense crack lines
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 20, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: i, ty: 44, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
      { tx: 24, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 30, ty: 10, type: 'enemy' },
      { id: 'e1', tx: 10, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 30, ty: 54, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-junction-f ─────────────────────────────────────────────────────────
  // 64×64. Wide shelf junction. Central vent landmark. All exits clear. 3 wanderers.
  {
    id:           'lava-junction-f',
    zone_act:     1,
    region_types: ['lava-shelf-platform', 'lava-shelf-edge'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // Central 4×4 vent landmark
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 30, ty: ty + 30, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 32, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 52, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 14, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── lava-junction-g ─────────────────────────────────────────────────────────
  // 64×64. Deep grid junction. Dense vents and cracks. All passages. 4 wanderers.
  {
    id:           'lava-junction-g',
    zone_act:     1,
    region_types: ['lava-shelf-deep', 'lava-shelf-edge'],
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
      // Vents at off-passage corners — each with glow
      { tx: 6,  ty: 6,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 6,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 7,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 7,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 54, ty: 6,  frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 55, ty: 6,  frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 54, ty: 7,  frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 55, ty: 7,  frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 54, ty: 6,  frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 6,  ty: 54, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 54, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 55, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 55, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 54, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 54, ty: 54, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 55, ty: 54, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 54, ty: 55, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 55, ty: 55, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 54, ty: 54, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 50, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-junction-h ─────────────────────────────────────────────────────────
  // 80×64. Large shelf junction. 4×4 central vent. Maximum glow. 4 wanderers orbital.
  {
    id:           'lava-junction-h',
    zone_act:     1,
    region_types: ['lava-shelf-deep', 'lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 32 },
    ],
    tiles: floor(80, 64),
    structures: [
      // 4×4 central vent
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 30, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 64, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 64, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS-APPROACH ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-approach-a ─────────────────────────────────────────────────────────
  // 64×80. Lava tube throat. Five vents line tube walls. 5 wanderers.
  {
    id:           'lava-approach-a',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // Basalt walls
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Five vents along tube walls
      { tx: 4,  ty: 10, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 10, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 56, ty: 22, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 57, ty: 22, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 56, ty: 22, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 4,  ty: 40, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 40, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 40, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 56, ty: 56, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 57, ty: 56, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 56, ty: 56, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 4,  ty: 70, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 5,  ty: 70, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 4,  ty: 70, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 30, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 58, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 72, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-approach-b ─────────────────────────────────────────────────────────
  // 80×64. Vent gauntlet. Three massive vent formations. 6 wanderers.
  {
    id:           'lava-approach-b',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // Three massive vent formations (4×4 each) staggered
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 4, ty: ty + 10, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 6,  ty: 12, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 28, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 30, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 68, ty: ty + 10, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 70, ty: 12, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Dense crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 48, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 56, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 18, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 62, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-approach-c ─────────────────────────────────────────────────────────
  // 64×96. Long tube approach. Basalt walls full length. Vent glows only illumination.
  // 6 wanderers.
  {
    id:           'lava-approach-c',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 64, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 96),
    structures: [
      // Basalt walls full height
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 61, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Vent glows — only illumination
      { tx: 32, ty: 8,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 32, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 32, ty: 48, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 32, ty: 72, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 32, ty: 88, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 64, type: 'enemy' },
      { id: 'e4', tx: 44, ty: 80, type: 'enemy' },
      { id: 'e5', tx: 32, ty: 88, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-approach-d ─────────────────────────────────────────────────────────
  // 80×80. Final approach. The shelf opens before the vent mouth. Dense heat glow.
  // 5 wanderers. Maximum TINT_LAVA_GLOW — room is predominantly orange light.
  {
    id:           'lava-approach-d',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Dense vents and basalt formations closing in from sides
      { tx: 4,  ty: 8,  frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 8,  frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 9,  frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 5,  ty: 9,  frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 4,  ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 70, ty: 8,  frame: 28, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 71, ty: 8,  frame: 29, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 70, ty: 9,  frame: 35, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 71, ty: 9,  frame: 36, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 70, ty: 8,  frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 12, ty: 32, frame: 28, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 13, ty: 32, frame: 29, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 12, ty: 33, frame: 35, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 13, ty: 33, frame: 36, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 12, ty: 32, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 64, ty: 32, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 65, ty: 32, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 64, ty: 33, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 65, ty: 33, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 64, ty: 32, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 4,  ty: 60, frame: 28, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 5,  ty: 60, frame: 29, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 4,  ty: 61, frame: 35, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 5,  ty: 61, frame: 36, tint: TINT_LAVA_VENT,   depth: 4, blocked: true },
      { tx: 4,  ty: 60, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      { tx: 70, ty: 60, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 71, ty: 60, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 70, ty: 61, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 71, ty: 61, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 70, ty: 60, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      // Maximum glow fills room
      { tx: 40, ty: 20, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 20, ty: 50, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 60, ty: 50, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 40, ty: 70, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 60, type: 'enemy' },
      { id: 'e4', tx: 56, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS ARENAS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-boss-a ─────────────────────────────────────────────────────────────
  // 80×80. The caldera vent. Massive 8×8 central vent. Four basalt column pairs at
  // 45° angles. 6 wanderers at cover positions. Boss at vent edge.
  {
    id:           'lava-boss-a',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Massive central 8×8 vent
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 8 }, (_, tx) =>
          ({ tx: tx + 36, ty: ty + 36, frame: tx < 4 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Four basalt column pairs at 45° angles from vent
      // NE pair
      { tx: 58, ty: 20, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 59, ty: 20, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 58, ty: 21, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 59, ty: 21, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 58, ty: 20, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      // NW pair
      { tx: 20, ty: 20, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 21, ty: 20, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 20, ty: 21, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 21, ty: 21, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 20, ty: 20, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      // SE pair
      { tx: 58, ty: 58, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 59, ty: 58, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 58, ty: 59, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 59, ty: 59, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 58, ty: 58, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
      // SW pair
      { tx: 20, ty: 58, frame: 28, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 21, ty: 58, frame: 29, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 20, ty: 59, frame: 35, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 21, ty: 59, frame: 36, tint: TINT_LAVA_BASALT, depth: 4, blocked: true },
      { tx: 20, ty: 58, frame: 7,  tint: TINT_LAVA_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 56, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-boss-b ─────────────────────────────────────────────────────────────
  // 64×80. Lava tube terminus. Long and narrow. Three massive vents (4×4) line walls.
  // Boss at far end. 6 markers. Tube channels fight.
  {
    id:           'lava-boss-b',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'boss',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
    ],
    tiles: floor(64, 80),
    structures: [
      // Basalt walls
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      // Three massive vents (4×4) lining the tube at equal spacing
      // West vent at ty=10
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 2, ty: ty + 10, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 4,  ty: 12, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // East vent at ty=34
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 58, ty: ty + 34, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 60, ty: 36, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // West vent at ty=58
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 2, ty: ty + 58, frame: tx < 2 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 4,  ty: 60, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 20, ty: 22, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 22, type: 'enemy' },
      { id: 'e3', tx: 32, ty: 46, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 66, type: 'enemy' },
      { id: 'e5', tx: 44, ty: 66, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-boss-c ─────────────────────────────────────────────────────────────
  // 80×64. Wide shelf collapse. Multiple crust ruptures (4×2 blocked) across arena
  // floor. Routes player through specific lanes. Boss exploits routing. 6 markers.
  {
    id:           'lava-boss-c',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'boss',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
    ],
    tiles: floor(80, 64),
    structures: [
      // Multiple crust ruptures at various positions — routed gaps
      // Row of 4×2 ruptures at ty=20, staggered
      { tx: 4,  ty: 18, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 5,  ty: 18, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 6,  ty: 18, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 7,  ty: 18, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 4,  ty: 19, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 5,  ty: 19, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 6,  ty: 19, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 7,  ty: 19, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 4,  ty: 18, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 28, ty: 16, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 29, ty: 16, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 30, ty: 16, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 16, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 28, ty: 17, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 29, ty: 17, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 30, ty: 17, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 31, ty: 17, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 28, ty: 16, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 52, ty: 18, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 53, ty: 18, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 54, ty: 18, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 55, ty: 18, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 52, ty: 19, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 53, ty: 19, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 54, ty: 19, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 55, ty: 19, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 52, ty: 18, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      { tx: 70, ty: 16, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 71, ty: 16, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 72, ty: 16, frame: 28, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 73, ty: 16, frame: 29, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 70, ty: 17, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 71, ty: 17, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 72, ty: 17, frame: 35, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 73, ty: 17, frame: 36, tint: TINT_LAVA_CRACK, depth: 4, blocked: true },
      { tx: 70, ty: 16, frame: 7,  tint: TINT_LAVA_GLOW,  depth: 2 },
      // Dense crack lines everywhere
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 40, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 40, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 64, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 24, ty: 48, type: 'enemy' },
      { id: 'e4', tx: 48, ty: 52, type: 'enemy' },
      { id: 'e5', tx: 68, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── lava-boss-d ─────────────────────────────────────────────────────────────
  // 96×80. Three concentric rings of vent structures. Boss at innermost ring centre.
  // Player must penetrate three rings. 6 wanderers across rings. Maximum lava glow.
  {
    id:           'lava-boss-d',
    zone_act:     1,
    region_types: ['lava-shelf-caldera'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Outer ring — 4 vents at radius ~32, 2 gaps each side (N/S)
      // North arc (ty=8) — gap at tx=44-51
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: i + 2, ty: 8, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 44 }, (_, i) =>
        ({ tx: i + 2, ty: 9, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        ({ tx: i + 52, ty: 8, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        ({ tx: i + 52, ty: 9, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      { tx: 48, ty: 8, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Middle ring — 4 vents at radius ~20, gaps at E/W
      // East side (tx=78-79) — gap at ty=36-43
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: 78, ty: i + 2, frame: 22, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: 79, ty: i + 2, frame: 22, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 78, ty: i + 44, frame: 22, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 79, ty: i + 44, frame: 22, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      { tx: 78, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // West side (tx=16-17) — gap at ty=36-43
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: 16, ty: i + 2, frame: 21, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 36 }, (_, i) =>
        ({ tx: 17, ty: i + 2, frame: 21, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 16, ty: i + 44, frame: 21, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 17, ty: i + 44, frame: 21, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
      ),
      { tx: 16, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Inner ring — central 8×8 vent (boss spawn)
      ...Array.from({ length: 8 }, (_, ty) =>
        Array.from({ length: 8 }, (_, tx) =>
          ({ tx: tx + 44, ty: ty + 36, frame: tx < 4 ? 28 : 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 48, ty: 40, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      // Maximum lava glow fills room
      { tx: 28, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 68, ty: 32, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 28, ty: 56, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 68, ty: 56, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // Outer ring
      { id: 'e0', tx: 30, ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 66, ty: 4,  type: 'enemy' },
      // Middle ring
      { id: 'e2', tx: 28, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 68, ty: 40, type: 'enemy' },
      // Inner ring (boss territory)
      { id: 'e4', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e5', tx: 56, ty: 40, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── lava-connector-a ────────────────────────────────────────────────────────
  // 12×24. Narrow hot crack. One vent at wall.
  {
    id:           'lava-connector-a',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents', 'lava-shelf-tube', 'lava-shelf-platform', 'lava-shelf-deep', 'lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'connector',
    size:         { w: 12, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 6, ty: 0  },
    ],
    tiles: floor(12, 24),
    structures: [
      // Single vent at wall
      { tx: 0,  ty: 10, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 1,  ty: 10, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 0,  ty: 10, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── lava-connector-b ────────────────────────────────────────────────────────
  // 16×16. Short basalt stub. One crack line.
  {
    id:           'lava-connector-b',
    zone_act:     1,
    region_types: ['lava-shelf-crust', 'lava-shelf-vents', 'lava-shelf-tube', 'lava-shelf-platform', 'lava-shelf-deep', 'lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'connector',
    size:         { w: 16, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 16),
    structures: [
      { tx: 8, ty: 7, frame: 13, tint: TINT_LAVA_CRACK, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── lava-connector-c ────────────────────────────────────────────────────────
  // 12×32. Long tube connector. Basalt walls. Two vent glows.
  {
    id:           'lava-connector-c',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-platform', 'lava-shelf-deep', 'lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'connector',
    size:         { w: 12, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 6, ty: 0  },
    ],
    tiles: floor(12, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 11, ty: i, frame: 22, tint: TINT_LAVA_BASALT, depth: 4, blocked: true })
      ),
      { tx: 6, ty: 8,  frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
      { tx: 6, ty: 24, frame: 7, tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── lava-connector-d ────────────────────────────────────────────────────────
  // 16×24. Wider connector. Central vent. Orange glow fills space.
  {
    id:           'lava-connector-d',
    zone_act:     1,
    region_types: ['lava-shelf-tube', 'lava-shelf-platform', 'lava-shelf-deep', 'lava-shelf-edge', 'lava-shelf-caldera'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      // Central vent
      { tx: 6,  ty: 10, frame: 28, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 10, frame: 29, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 11, frame: 35, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 7,  ty: 11, frame: 36, tint: TINT_LAVA_VENT, depth: 4, blocked: true },
      { tx: 6,  ty: 10, frame: 7,  tint: TINT_LAVA_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z6

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z6: RegionDef[] = [
  {
    id:             'lava-shelf-crust',
    label:          'Lava Shelf — Cooled Crust',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-vents',
    label:          'Lava Shelf — Vent Field',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-tube',
    label:          'Lava Shelf — Lava Tube',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   3,
    corridor_max:   6,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-platform',
    label:          'Lava Shelf — Hardened Platform Ring',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-deep',
    label:          'Lava Shelf — Deep Shelf Grid',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-edge',
    label:          'Lava Shelf — Shelf Edge',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
  {
    id:             'lava-shelf-caldera',
    label:          'Lava Shelf — Caldera Convergence',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_LAVA_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionCrust,
  regionVents,
  regionTube,
  regionPlatform,
  regionDeep,
  regionEdge,
  regionCaldera,
] = REGIONS_A1Z6;

export const ZONE_A1Z6: ZoneDef = {
  id:           'lava-shelf',
  label:        'Lava Shelf',
  zone_act:     1,
  region_defs:  [
    regionCrust,
    regionVents,
    regionTube,
    regionPlatform,
    regionDeep,
    regionEdge,
    regionCaldera,
  ],
  enemy_flavour: 'wanderers',
  tint:          TINT_LAVA_FLOOR,
};
