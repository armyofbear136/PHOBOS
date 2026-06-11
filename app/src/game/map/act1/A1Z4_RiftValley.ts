/**
 * Act I — Zone 4 — RIFT VALLEY
 * Archetype index: 4
 * Tint: 0x4a5060 (cool steel-grey)
 * Enemy flavour: sentinels
 *
 * A deep tectonic rift cutting across the Phobos surface. The player descends
 * into the rift and traverses along its narrow floor. Sheer walls rise on both
 * sides — rooms are long and narrow, confinement is the defining feel. Sentinels
 * patrol in disciplined formation along the rift floor, using wall proximity for
 * cover. Exposed strata layers, rockfall debris, and seismic crack lines give the
 * floor its texture. This is the tightest zone in Act I.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_RIFT_FLOOR:  number = 0x4a5060;  // cool steel-grey rift floor
const TINT_RIFT_WALL:   number = 0x2a3040;  // deep shadow rift wall
const TINT_RIFT_STRATA: number = 0x6a7080;  // exposed rock strata highlight
const TINT_RIFT_DEBRIS: number = 0x38404e;  // rockfall debris
const TINT_RIFT_GLOW:   number = 0x4466aa;  // cool blue seismic glow

// ── Helper ────────────────────────────────────────────────────────────────────

function floor(w: number, h: number): Array<{ tx: number; ty: number; frame: number }> {
  const t: Array<{ tx: number; ty: number; frame: number }> = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++)
      t.push({ tx, ty, frame: 0 });
  return t;
}

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A1Z4: RoomDef[] = [

  // ════════════════════════════════════════════════════════════════════════════
  // TRAVERSAL ROOMS (12)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-traverse-a ─────────────────────────────────────────────────────────
  // 48×80. Sheer rift walls both edges (3-tile-wide blocked) leaving 26-tile floor
  // passage. Decorative strata lines running E-W at irregular intervals — exposed
  // geological layers. 3 sentinel markers in north-facing patrol line.
  {
    id:           'rift-traverse-a',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // West wall — 3 tiles wide, full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 3 tiles wide, full height
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 45, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Strata lines — non-blocked, depth 2, at irregular depths
      { tx: 4,  ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 8,  ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 12, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 16, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 20, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 24, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 28, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 32, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 36, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 40, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 5,  ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 10, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 15, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 20, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 25, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 30, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 35, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 40, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 6,  ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 12, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 18, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 24, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 30, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 36, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 42, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 34, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-traverse-b ─────────────────────────────────────────────────────────
  // 48×96. Longer section. Rockfall debris field at mid-depth — 6 scattered 2×1
  // blocked structures from east wall. Debris narrows passage to 14 tiles at
  // tightest. 4 sentinels — 2 south, 2 north of debris. Faint seismic glow east wall.
  {
    id:           'rift-traverse-b',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'standard',
    size:         { w: 48, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 96),
    structures: [
      // West wall
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Rockfall debris — 6 2×1 blocked structures from east wall
      { tx: 38, ty: 42, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 42, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 34, ty: 46, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 35, ty: 46, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 40, ty: 50, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 41, ty: 50, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 54, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 37, ty: 54, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 42, ty: 44, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 43, ty: 44, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 58, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 58, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      // Seismic glow along east wall
      { tx: 45, ty: 48, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 12, ty: 36, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 68, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 80, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-traverse-c ─────────────────────────────────────────────────────────
  // 64×80. Wider section where walls step back — 36-tile floor. A single large
  // fallen boulder (3×3 blocked, TINT_RIFT_DEBRIS) sits off-centre at mid-depth.
  // Brief exhale moment. 3 sentinel markers. Seismic glow at boulder.
  {
    id:           'rift-traverse-c',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall stepped back — starts at tx=12
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 12, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 13, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall stepped back — starts at tx=51
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 51, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 52, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Single large fallen boulder 3×3, off-centre
      { tx: 36, ty: 36, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 37, ty: 36, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 36, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 37, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 37, ty: 37, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 37, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 38, frame: 21, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 37, ty: 38, frame: 22, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 38, frame: 21, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      // Seismic glow at boulder
      { tx: 37, ty: 37, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 50, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-traverse-d ─────────────────────────────────────────────────────────
  // 48×64. Seismic crack running N-S down floor centre — 1-tile-wide non-blocked
  // decorative TINT_RIFT_GLOW line. Sentinels patrol on either side. 3 markers.
  {
    id:           'rift-traverse-d',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // N-S seismic crack down floor centre — non-blocked, depth 2
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 24, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 34, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 14, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-traverse-e ─────────────────────────────────────────────────────────
  // 64×64. Debris-choked section. Heavy rockfall — 10 debris structures (2×1 and
  // 1×1 mixed, blocked) from both walls. No single clear lane. 4 sentinel markers
  // exploiting debris as cover.
  {
    id:           'rift-traverse-e',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-narrows'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // 10 debris structures — mixed 2×1 and 1×1, from both walls
      { tx: 4,  ty: 10, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 10, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 14, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 14, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 24, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 52, ty: 20, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 4,  ty: 34, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 34, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 55, ty: 36, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 36, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 10, ty: 46, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 50, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 54, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 7,  ty: 54, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 54, ty: 52, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 50, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 12, ty: 28, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 48, ty: 30, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 14, ty: 58, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 46, ty: 56, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-traverse-f ─────────────────────────────────────────────────────────
  // 48×96. Long narrow with staggered wall protrusions. East wall protrudes at
  // ty=24–40 and ty=64–80; west wall protrudes at ty=44–60. Passage oscillates
  // between 26 and 14 tiles wide. 4 sentinel markers at each narrow section.
  {
    id:           'rift-traverse-f',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-narrows'],
    type:         'standard',
    size:         { w: 48, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 96),
    structures: [
      // Base west wall 2 tiles wide
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // West protrusion at ty=44-60 (3 extra tiles inward = tx 2-4)
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 2, ty: i + 44, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 3, ty: i + 44, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 4, ty: i + 44, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Base east wall 2 tiles wide
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East protrusions
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 43, ty: i + 24, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 44, ty: i + 24, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 45, ty: i + 24, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 43, ty: i + 64, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 44, ty: i + 64, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 17 }, (_, i) =>
        ({ tx: 45, ty: i + 64, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Glow at narrow points
      { tx: 24, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 24, ty: 52, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 24, ty: 72, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 52, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 72, type: 'enemy' },
      { id: 'e3', tx: 30, ty: 84, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-traverse-g ─────────────────────────────────────────────────────────
  // 64×80. Exposed strata section. East wall studded with strata line decorations
  // creating visible geological cross-section. Three debris clusters at wall base.
  // 4 sentinel markers.
  {
    id:           'rift-traverse-g',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-chambers'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Strata decorations on east wall face
      { tx: 60, ty: 8,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 16, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 24, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 32, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 40, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 48, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 56, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 64, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 60, ty: 72, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      // Second strata level on east wall
      { tx: 58, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 58, ty: 28, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 58, ty: 44, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 58, ty: 60, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 58, ty: 76, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      // Three debris clusters at east wall base
      { tx: 56, ty: 18, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 18, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 55, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 66, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 66, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 52, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-traverse-h ─────────────────────────────────────────────────────────
  // 80×64. Widest rift traversal — secondary erosion opened a wider section.
  // Opens to 48 tiles before narrowing at north. Three rockfall formations across
  // the wider section. 4 sentinel markers exploiting the temporary openness.
  {
    id:           'rift-traverse-h',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // South half walls narrow (x: 0-15 west, 64-79 east)
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i + 32, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 1, ty: i + 32, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 78, ty: i + 32, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 79, ty: i + 32, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // North half wider — walls still present but farther out (x: 0-7, 72-79)
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 72, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three rockfall formations in wide section
      { tx: 20, ty: 12, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 21, ty: 12, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 20, ty: 13, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 21, ty: 13, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 40, ty: 8,  frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 41, ty: 8,  frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 40, ty: 9,  frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 41, ty: 9,  frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 18, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 18, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 19, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 19, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 30, ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 54, ty: 10, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 44, type: 'enemy' },
      { id: 'e3', tx: 58, ty: 52, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-traverse-i ─────────────────────────────────────────────────────────
  // 48×80. Deep rift — walls close in again. Wall formations step inward from both
  // sides leaving 20-tile passage. Dense seismic cracks. 5 sentinel markers in tight
  // patrol. Glow intensifies.
  {
    id:           'rift-traverse-i',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-fault'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // West wall — 4 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 4 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 44, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 45, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Dense seismic crack lines
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 14, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 28, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 36, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 26, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 30, ty: 54, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-traverse-j ─────────────────────────────────────────────────────────
  // 64×64. Major diagonal crack line running SW to NE — non-blocked with strong
  // TINT_RIFT_GLOW. Sentinels position around the crack. 4 enemy markers. 1 mineral
  // at the brightest crack point.
  {
    id:           'rift-traverse-j',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-fault'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Diagonal crack SW to NE — non-blocked, depth 2
      { tx: 8,  ty: 56, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 12, ty: 50, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 44, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 20, ty: 38, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 24, ty: 32, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 28, ty: 26, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 32, ty: 20, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 36, ty: 14, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 40, ty: 8,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 44, ty: 4,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 50, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 56, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 44, type: 'enemy'   },
      { id: 'e1', tx: 34, ty: 22, type: 'enemy'   },
      { id: 'e2', tx: 48, ty: 8,  type: 'enemy'   },
      { id: 'e3', tx: 14, ty: 20, type: 'enemy'   },
      { id: 'm0', tx: 24, ty: 32, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── rift-traverse-k ─────────────────────────────────────────────────────────
  // 48×96. Pre-boss long narrow. Maximum wall confinement. Debris density highest.
  // 5 sentinel markers compressed. Seismic glow traces wall surfaces.
  {
    id:           'rift-traverse-k',
    zone_act:     1,
    region_types: ['rift-valley-fault', 'rift-valley-terminus'],
    type:         'standard',
    size:         { w: 48, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 96),
    structures: [
      // West wall — 5 tiles wide
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 4, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 5 tiles wide
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 43, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 44, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 45, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Glow traces along walls
      { tx: 5,  ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 5,  ty: 56, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 5,  ty: 80, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 42, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 42, ty: 64, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Dense debris
      { tx: 10, ty: 16, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 28, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 12, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 34, ty: 58, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 10, ty: 72, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 28, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 28, ty: 64, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 80, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-traverse-l ─────────────────────────────────────────────────────────
  // 64×80. Final traversal. Rift begins to open — walls taper outward from 16 tiles
  // wide at south to 40 tiles at north. 5 sentinel markers. Dramatic glow buildup.
  {
    id:           'rift-traverse-l',
    zone_act:     1,
    region_types: ['rift-valley-fault', 'rift-valley-terminus'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall — steps outward northward (funnel opening)
      { tx: 24, ty: 79, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 24, ty: 70, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 20, ty: 60, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 48, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 36, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 20, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 8,  frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      // East wall — steps outward northward
      { tx: 40, ty: 79, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 40, ty: 70, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 44, ty: 60, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 48, ty: 48, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 52, ty: 36, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 56, ty: 20, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 60, ty: 8,  frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      // Glow buildup northward
      { tx: 16, ty: 36, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 48, ty: 36, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 8,  ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 56, ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 72, type: 'enemy' },
      { id: 'e1', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e4', tx: 44, ty: 12, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // COMBAT ROOMS (10)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-combat-a ───────────────────────────────────────────────────────────
  // 48×64. Narrow rift ambush. Walls close to 16-tile passage. Two debris piles
  // flank the path. 5 sentinels — 2 front, 3 behind debris barricade at 2/3 depth.
  {
    id:           'rift-combat-a',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 64),
    structures: [
      // West wall — 5 tiles (passage at 16 wide)
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 4, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 5 tiles
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 43, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 44, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 45, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Debris barricade at ty=40 — two flanking piles, 4-tile gap at centre
      { tx: 5,  ty: 40, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 40, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 7,  ty: 40, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 41, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 41, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 7,  ty: 41, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 40, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 40, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 40, ty: 40, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 41, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 41, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 40, ty: 41, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 16, ty: 10, type: 'enemy' },
      { id: 'e3', tx: 24, ty: 10, type: 'enemy' },
      { id: 'e4', tx: 32, ty: 10, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-combat-b ───────────────────────────────────────────────────────────
  // 64×64. East wall alcove fight. E exit opens into cut alcove. 3 sentinels in
  // main rift, 2 in alcove. Sentinels coordinate across divide.
  {
    id:           'rift-combat-b',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-chambers'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall — full height
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove opening at ty=24-40 — no structure at those rows
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 62, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 63, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Alcove glow
      { tx: 60, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 36, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 20, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 56, ty: 24, type: 'enemy' },  // alcove
      { id: 'e4', tx: 56, ty: 40, type: 'enemy' },  // alcove
    ],
    min_room_tier: 0,
  },

  // ── rift-combat-c ───────────────────────────────────────────────────────────
  // 64×64. Mirror of combat-b. West wall alcove. W exit. 5 sentinel markers.
  {
    id:           'rift-combat-c',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-chambers'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // East wall — full height
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // West wall with alcove opening at ty=24-40
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 0, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 1, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Alcove glow
      { tx: 3, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 44, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 28, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 44, ty: 48, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 24, type: 'enemy' },  // alcove
      { id: 'e4', tx: 8,  ty: 40, type: 'enemy' },  // alcove
    ],
    min_room_tier: 0,
  },

  // ── rift-combat-d ───────────────────────────────────────────────────────────
  // 48×80. Staggered debris barricade. Four debris clusters staggered east/west,
  // creating broken wall — gaps alternating. 6 sentinel markers behind barricades.
  {
    id:           'rift-combat-d',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-chambers'],
    type:         'standard',
    size:         { w: 48, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 80),
    structures: [
      // West wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Barricade 1 (east side, gap west) at ty=18
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 12, ty: 18, frame: i < 8 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      // Barricade 2 (west side, gap east) at ty=34
      ...Array.from({ length: 18 }, (_, i) =>
        ({ tx: i + 2, ty: 34, frame: i < 9 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      // Barricade 3 (east side, gap west) at ty=52
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i + 14, ty: 52, frame: i < 8 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      // Barricade 4 (west side, gap east) at ty=66
      ...Array.from({ length: 18 }, (_, i) =>
        ({ tx: i + 2, ty: 66, frame: i < 9 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 28, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 20, ty: 26, type: 'enemy' },
      { id: 'e3', tx: 28, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 60, type: 'enemy' },
      { id: 'e5', tx: 28, ty: 72, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-combat-e ───────────────────────────────────────────────────────────
  // 64×64. Seismic event room. Large central seismic crack (4×2 blocked,
  // TINT_RIFT_GLOW) splits room E-W with 6-tile gaps on each end. Sentinels far side.
  // 6 enemy markers. Crack glows intensely.
  {
    id:           'rift-combat-e',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // 4×2 seismic crack — E-W, gaps of 6 tiles each end (tx=8-13, tx=50-55 are gaps)
      { tx: 14, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 15, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 16, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 17, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 18, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 19, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 20, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 21, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 22, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 23, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 24, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 25, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 26, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 27, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 31, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 32, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 33, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 34, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 35, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 36, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 37, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 38, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 39, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 40, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 41, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 42, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 43, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 44, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 45, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 46, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 47, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 48, ty: 30, frame: 28, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 49, ty: 30, frame: 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      // Row 2
      { tx: 14, ty: 31, frame: 35, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 20, ty: 31, frame: 36, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 28, ty: 31, frame: 35, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 36, ty: 31, frame: 36, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 44, ty: 31, frame: 35, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      { tx: 49, ty: 31, frame: 36, tint: TINT_RIFT_GLOW, depth: 4, blocked: true },
      // Glow source at crack centre
      { tx: 32, ty: 30, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 12, ty: 22, type: 'enemy' },
      { id: 'e3', tx: 52, ty: 22, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 44, type: 'enemy' },
      { id: 'e5', tx: 44, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-combat-f ───────────────────────────────────────────────────────────
  // 80×64. Wide rift chamber fight. Three large boulders (3×3 blocked) at equidistant
  // positions. 6 sentinel markers using each boulder as position anchor.
  {
    id:           'rift-combat-f',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three 3×3 boulders equidistant
      ...Array.from({ length: 3 }, (_, ty) =>
        Array.from({ length: 3 }, (_, tx) =>
          ({ tx: tx + 14, ty: ty + 28, frame: tx < 2 ? 28 : 22, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 15, ty: 29, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 3 }, (_, ty) =>
        Array.from({ length: 3 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 24, frame: tx < 2 ? 28 : 22, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 39, ty: 25, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 3 }, (_, ty) =>
        Array.from({ length: 3 }, (_, tx) =>
          ({ tx: tx + 60, ty: ty + 28, frame: tx < 2 ? 28 : 22, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 61, ty: 29, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e2', tx: 38, ty: 10, type: 'enemy' },
      { id: 'e3', tx: 44, ty: 38, type: 'enemy' },
      { id: 'e4', tx: 60, ty: 14, type: 'enemy' },
      { id: 'e5', tx: 66, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-combat-g ───────────────────────────────────────────────────────────
  // 64×64. Cross-rift junction combat. E and W alcoves both have sentinels. Main
  // rift caught in crossfire from three directions. 6 markers total.
  {
    id:           'rift-combat-g',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
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
      // West wall with alcove opening
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 0, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 1, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove opening
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 62, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 63, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      { tx: 3,  ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 60, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 48, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 32, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 32, type: 'enemy' },  // west alcove
      { id: 'e4', tx: 56, ty: 24, type: 'enemy' },  // east alcove
      { id: 'e5', tx: 56, ty: 40, type: 'enemy' },  // east alcove
    ],
    min_room_tier: 1,
  },

  // ── rift-combat-h ───────────────────────────────────────────────────────────
  // 48×48. Compressed kill zone. Tightest combat room. 6 sentinel markers in
  // close-formation. Dense debris. Minimal room to manoeuvre.
  {
    id:           'rift-combat-h',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-fault'],
    type:         'standard',
    size:         { w: 48, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 47 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
    ],
    tiles: floor(48, 48),
    structures: [
      // West wall — 5 tiles
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 4, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 5 tiles
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 43, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 44, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 45, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Dense debris blocking parts of passage
      { tx: 8,  ty: 10, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 14, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 10, ty: 24, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 34, ty: 28, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 38, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 36, ty: 36, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      // Glow
      { tx: 24, ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 28, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 16, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 28, ty: 20, type: 'enemy' },
      { id: 'e4', tx: 16, ty: 36, type: 'enemy' },
      { id: 'e5', tx: 28, ty: 36, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-combat-i ───────────────────────────────────────────────────────────
  // 64×64. Seismic collapse room. 10+ small debris fragments scattered (1×1 and
  // 1×2 mixed). 6 sentinel markers dispersed through debris. Maximum glow.
  {
    id:           'rift-combat-i',
    zone_act:     1,
    region_types: ['rift-valley-fault', 'rift-valley-terminus'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // 12 scattered fragments — 1×1 and 1×2 mixed
      { tx: 6,  ty: 8,  frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 8,  frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 22, ty: 10, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 22, ty: 10, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 42, ty: 8,  frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 12, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 22, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 9,  ty: 22, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 22, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 38, ty: 20, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 54, ty: 26, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 34, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 6,  ty: 34, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 26, ty: 36, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 27, ty: 36, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 52, ty: 38, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 52, ty: 38, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 10, ty: 50, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 48, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 52, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 14, type: 'enemy' },
      { id: 'e1', tx: 48, ty: 14, type: 'enemy' },
      { id: 'e2', tx: 28, ty: 28, type: 'enemy' },
      { id: 'e3', tx: 44, ty: 30, type: 'enemy' },
      { id: 'e4', tx: 20, ty: 44, type: 'enemy' },
      { id: 'e5', tx: 48, ty: 44, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-combat-j ───────────────────────────────────────────────────────────
  // 80×80. Final combat. Widest combat room — rift opening before terminus. Three
  // massive 4×4 boulder formations. 6 sentinel markers in strategic cover positions.
  // Maximum seismic glow.
  {
    id:           'rift-combat-j',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // West wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three massive 4×4 boulder formations
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 14, ty: ty + 16, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 16, ty: 18, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 38, ty: ty + 36, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 40, ty: 38, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 58, ty: ty + 56, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 60, ty: 58, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 30, type: 'enemy' },
      { id: 'e3', tx: 46, ty: 44, type: 'enemy' },
      { id: 'e4', tx: 56, ty: 50, type: 'enemy' },
      { id: 'e5', tx: 64, ty: 64, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DEAD-END ROOMS (8)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-dead-a ─────────────────────────────────────────────────────────────
  // 24×32. Narrow wall alcove. Strata decoration on back wall. 1 loot, 1 mineral.
  {
    id:           'rift-dead-a',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor', 'rift-valley-narrows'],
    type:         'dead-end',
    size:         { w: 24, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 31 },
    ],
    tiles: floor(24, 32),
    structures: [
      // Strata on back (north) wall
      { tx: 4,  ty: 2, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 8,  ty: 2, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 12, ty: 2, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 16, ty: 2, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 20, ty: 2, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 16, type: 'loot'    },
      { id: 'm0', tx: 16, ty: 16, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── rift-dead-b ─────────────────────────────────────────────────────────────
  // 32×32. Rockfall pocket. Three debris structures. 2 loot, 1 mineral. 1 sentinel.
  {
    id:           'rift-dead-b',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor'],
    type:         'dead-end',
    size:         { w: 32, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 31 },
    ],
    tiles: floor(32, 32),
    structures: [
      { tx: 4,  ty: 4,  frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 4,  frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 4,  ty: 5,  frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 5,  frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 20, ty: 6,  frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 14, ty: 10, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 22, ty: 22, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 18, type: 'loot'    },
      { id: 'l1', tx: 22, ty: 14, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── rift-dead-c ─────────────────────────────────────────────────────────────
  // 24×48. Deep crack pocket. Seismic glow from floor crack. 3 mineral, 1 loot.
  {
    id:           'rift-dead-c',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-chambers'],
    type:         'dead-end',
    size:         { w: 24, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 47 },
    ],
    tiles: floor(24, 48),
    structures: [
      // Floor crack — N-S non-blocked
      ...Array.from({ length: 48 }, (_, i) =>
        ({ tx: 12, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 8,  ty: 30, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 12, ty: 6,  type: 'mineral' },
      { id: 'm2', tx: 18, ty: 6,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── rift-dead-d ─────────────────────────────────────────────────────────────
  // 32×48. Strata exposure alcove. Dense strata decorations. 2 loot, 1 mineral.
  // 1 sentinel.
  {
    id:           'rift-dead-d',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Dense strata on all walls
      { tx: 2,  ty: 6,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 2,  ty: 14, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 2,  ty: 22, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 2,  ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 2,  ty: 38, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 28, ty: 6,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 28, ty: 14, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 28, ty: 22, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 28, ty: 30, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 28, ty: 38, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 10, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 20, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 16, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 14, type: 'loot'    },
      { id: 'l1', tx: 22, ty: 14, type: 'loot'    },
      { id: 'm0', tx: 16, ty: 8,  type: 'mineral' },
    ],
    min_room_tier: 1,
  },

  // ── rift-dead-e ─────────────────────────────────────────────────────────────
  // 24×32. Minimal debris pocket. 2 loot. No enemies.
  {
    id:           'rift-dead-e',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'dead-end',
    size:         { w: 24, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 31 },
    ],
    tiles: floor(24, 32),
    structures: [
      { tx: 10, ty: 6, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 11, ty: 6, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'l0', tx: 6,  ty: 18, type: 'loot' },
      { id: 'l1', tx: 16, ty: 18, type: 'loot' },
    ],
    min_room_tier: 1,
  },

  // ── rift-dead-f ─────────────────────────────────────────────────────────────
  // 32×48. Deep seismic vent pocket. Strong glow. 2 loot, 2 mineral. 2 sentinels.
  {
    id:           'rift-dead-f',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-fault'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // Seismic vent — 2×2 blocked at north centre
      { tx: 14, ty: 8,  frame: 28, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 8,  frame: 29, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 9,  frame: 35, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 9,  frame: 36, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 8,  frame: 7,  tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 28, type: 'enemy'   },
      { id: 'e1', tx: 22, ty: 28, type: 'enemy'   },
      { id: 'l0', tx: 8,  ty: 16, type: 'loot'    },
      { id: 'l1', tx: 22, ty: 16, type: 'loot'    },
      { id: 'm0', tx: 8,  ty: 38, type: 'mineral' },
      { id: 'm1', tx: 22, ty: 38, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── rift-dead-g ─────────────────────────────────────────────────────────────
  // 24×48. Late mineral crack. 4 mineral markers along crack line. 1 loot. 1 sentinel.
  {
    id:           'rift-dead-g',
    zone_act:     1,
    region_types: ['rift-valley-fault', 'rift-valley-terminus'],
    type:         'dead-end',
    size:         { w: 24, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 12, ty: 47 },
    ],
    tiles: floor(24, 48),
    structures: [
      // Crack line with minerals
      { tx: 12, ty: 6,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 12, ty: 14, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 12, ty: 22, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 12, ty: 30, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 38, type: 'enemy'   },
      { id: 'l0', tx: 6,  ty: 38, type: 'loot'    },
      { id: 'm0', tx: 6,  ty: 6,  type: 'mineral' },
      { id: 'm1', tx: 6,  ty: 14, type: 'mineral' },
      { id: 'm2', tx: 18, ty: 22, type: 'mineral' },
      { id: 'm3', tx: 18, ty: 30, type: 'mineral' },
    ],
    min_room_tier: 2,
  },

  // ── rift-dead-h ─────────────────────────────────────────────────────────────
  // 32×48. Rich guarded alcove. 3 loot, 3 mineral, 3 sentinels.
  {
    id:           'rift-dead-h',
    zone_act:     1,
    region_types: ['rift-valley-fault', 'rift-valley-terminus'],
    type:         'dead-end',
    size:         { w: 32, h: 48 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 16, ty: 47 },
    ],
    tiles: floor(32, 48),
    structures: [
      // North wall blocked
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 16 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      { tx: 16, ty: 4, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 22, type: 'enemy'   },
      { id: 'e1', tx: 16, ty: 20, type: 'enemy'   },
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

  // ── rift-junction-a ─────────────────────────────────────────────────────────
  // 48×64. Rift wall east cut. Central debris cluster. E exit into wall alcove.
  // 2 sentinels.
  {
    id:           'rift-junction-a',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor', 'rift-valley-narrows'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 47, ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove at ty=24-40
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 46, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 47, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Central debris cluster
      { tx: 16, ty: 28, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 17, ty: 28, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 16, ty: 29, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 17, ty: 29, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 12, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 12, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-junction-b ─────────────────────────────────────────────────────────
  // 48×64. Rift wall west cut. Mirror layout. W exit. 2 sentinels.
  {
    id:           'rift-junction-b',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor', 'rift-valley-narrows'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // West wall with alcove
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 0, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 1, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Central debris cluster
      { tx: 28, ty: 28, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 28, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 28, ty: 29, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 34, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 34, ty: 50, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-junction-c ─────────────────────────────────────────────────────────
  // 64×64. Both walls cut open. Four corner debris clusters. All passages clear.
  // 3 sentinels at centre.
  {
    id:           'rift-junction-c',
    zone_act:     1,
    region_types: ['rift-valley-floor', 'rift-valley-chambers'],
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
      // Corner debris clusters — all four corners
      { tx: 4,  ty: 4,  frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 4,  frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 4,  ty: 5,  frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 5,  frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 4,  frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 4,  frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 5,  frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 5,  frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 4,  ty: 58, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 58, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 4,  ty: 59, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 5,  ty: 59, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 58, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 58, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 58, ty: 59, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 59, ty: 59, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 28, ty: 32, type: 'enemy' },
      { id: 'e1', tx: 32, ty: 24, type: 'enemy' },
      { id: 'e2', tx: 36, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── rift-junction-d ─────────────────────────────────────────────────────────
  // 64×80. Deep east cut junction. Strata on north wall. E exit from alcove. 3 sentinels.
  {
    id:           'rift-junction-d',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-chambers', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 40 },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove at ty=32-48
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 31 }, (_, i) =>
        ({ tx: 62, ty: i + 49, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 31 }, (_, i) =>
        ({ tx: 63, ty: i + 49, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Strata on north wall
      { tx: 10, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 20, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 30, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 40, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 50, ty: 2,  frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      // Glow at alcove
      { tx: 60, ty: 40, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 44, ty: 40, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-junction-e ─────────────────────────────────────────────────────────
  // 48×64. West crack junction. Seismic glow at junction. W exit. 3 sentinels.
  {
    id:           'rift-junction-e',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 48, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 24, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 24, ty: 0  },
      { id: 'west-0',  edge: 'W', tx: 0,  ty: 32 },
    ],
    tiles: floor(48, 64),
    structures: [
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 46, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 47, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // West wall with alcove at ty=24-40
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 0, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 1, ty: i + 41, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Seismic glow at junction
      { tx: 2, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Seismic crack at junction
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 24, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 10, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 32, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-junction-f ─────────────────────────────────────────────────────────
  // 64×64. Wide junction. Central boulder landmark. All exits clear. 3 sentinels.
  {
    id:           'rift-junction-f',
    zone_act:     1,
    region_types: ['rift-valley-chambers', 'rift-valley-deep'],
    type:         'standard',
    size:         { w: 64, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 63, ty: 32 },
    ],
    tiles: floor(64, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove at ty=24-40
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 62, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 23 }, (_, i) =>
        ({ tx: 63, ty: i + 41, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Central boulder landmark 3×3
      { tx: 28, ty: 28, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 28, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 30, ty: 28, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 28, ty: 29, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 30, ty: 29, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 28, ty: 30, frame: 21, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 30, frame: 22, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 30, ty: 30, frame: 21, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 29, ty: 29, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 14, ty: 16, type: 'enemy' },
      { id: 'e1', tx: 50, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 14, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 1,
  },

  // ── rift-junction-g ─────────────────────────────────────────────────────────
  // 64×64. Deep grid junction. Dense debris. All passages maintained. 4 sentinels.
  {
    id:           'rift-junction-g',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-fault'],
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
      // Dense debris — 8 fragments off passage lanes, each with glow
      { tx: 8,  ty: 8,  frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 8,  frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 50, ty: 8,  frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 50, ty: 8,  frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 8,  ty: 50, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 8,  ty: 50, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 50, ty: 50, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 50, ty: 50, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 18, ty: 20, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 18, ty: 20, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 44, ty: 40, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 44, ty: 40, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 18, ty: 44, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 18, ty: 44, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 44, ty: 20, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 44, ty: 20, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
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

  // ── rift-junction-h ─────────────────────────────────────────────────────────
  // 80×80. Large wide junction. Three strata layers on walls. Central seismic crack.
  // 4 sentinels.
  {
    id:           'rift-junction-h',
    zone_act:     1,
    region_types: ['rift-valley-deep', 'rift-valley-terminus'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
      { id: 'east-0',  edge: 'E', tx: 79, ty: 40 },
    ],
    tiles: floor(80, 80),
    structures: [
      // West wall
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall with alcove at ty=32-48
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 31 }, (_, i) =>
        ({ tx: 78, ty: i + 49, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 31 }, (_, i) =>
        ({ tx: 79, ty: i + 49, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three strata layers on walls
      { tx: 4,  ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 4,  ty: 32, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 4,  ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 4,  ty: 68, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 76, ty: 12, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 76, ty: 32, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 76, ty: 52, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      { tx: 76, ty: 68, frame: 13, tint: TINT_RIFT_STRATA, depth: 3 },
      // Central seismic crack with glow
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 40, ty: i, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 })
      ),
      { tx: 40, ty: 40, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 20, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 60, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 20, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 60, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS-APPROACH ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-approach-a ─────────────────────────────────────────────────────────
  // 64×80. Rift constricts severely. 5 sentinels in narrow corridor.
  {
    id:           'rift-approach-a',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'standard',
    size:         { w: 64, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 80),
    structures: [
      // West wall — 5 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 2, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 4, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall — 5 tiles wide
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 59, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 60, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 61, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 62, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 63, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Maximised glow traces
      { tx: 5,  ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 5,  ty: 40, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 5,  ty: 64, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 58, ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 58, ty: 56, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 32, ty: 12, type: 'enemy' },
      { id: 'e1', tx: 20, ty: 26, type: 'enemy' },
      { id: 'e2', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e3', tx: 20, ty: 54, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 68, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-approach-b ─────────────────────────────────────────────────────────
  // 80×64. Debris gauntlet. Three dense debris lines. 6 sentinels.
  {
    id:           'rift-approach-b',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'standard',
    size:         { w: 80, h: 64 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 63 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 64),
    structures: [
      // West wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // East wall
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 64 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three debris lines — staggered gaps
      // Line 1 at ty=16 — gap at tx=56-63
      ...Array.from({ length: 54 }, (_, i) =>
        ({ tx: i + 2, ty: 16, frame: i < 27 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      { tx: 60, ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Line 2 at ty=32 — gap at tx=26-33
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: i + 2, ty: 32, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 42 }, (_, i) =>
        ({ tx: i + 34, ty: 32, frame: i < 21 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      { tx: 30, ty: 32, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Line 3 at ty=48 — gap at tx=8-15
      ...Array.from({ length: 62 }, (_, i) =>
        ({ tx: i + 16, ty: 48, frame: i < 31 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
      ),
      { tx: 12, ty: 48, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 62, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 20, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 30, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 60, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 12, ty: 56, type: 'enemy' },
      { id: 'e5', tx: 50, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-approach-c ─────────────────────────────────────────────────────────
  // 64×96. Long final descent. Walls close inward progressively. 6 sentinels.
  // Seismic glow traces all surfaces.
  {
    id:           'rift-approach-c',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'standard',
    size:         { w: 64, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 32, ty: 95 },
      { id: 'north-0', edge: 'N', tx: 32, ty: 0  },
    ],
    tiles: floor(64, 96),
    structures: [
      // West wall progressively closing
      { tx: 2,  ty: 80, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 64, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 48, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 32, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 16, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 4,  frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      // East wall progressively closing
      { tx: 61, ty: 80, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 59, ty: 64, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 57, ty: 48, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 55, ty: 32, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 53, ty: 16, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      { tx: 51, ty: 4,  frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true },
      // Seismic glow traces
      { tx: 4,  ty: 40, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 60, ty: 40, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 10, ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 54, ty: 16, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 32, ty: 80, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 80, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 80, type: 'enemy' },
      { id: 'e2', tx: 24, ty: 56, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 40, type: 'enemy' },
      { id: 'e4', tx: 26, ty: 20, type: 'enemy' },
      { id: 'e5', tx: 38, ty: 8,  type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-approach-d ─────────────────────────────────────────────────────────
  // 80×80. Rift terminus entry hall. Walls finally open wide. 5 sentinels in
  // defensive formation. Maximum glow.
  {
    id:           'rift-approach-d',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'standard',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
      { id: 'north-0', edge: 'N', tx: 40, ty: 0  },
    ],
    tiles: floor(80, 80),
    structures: [
      // Walls open wide — only at edges (2 tiles)
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Defensive formation boulders
      { tx: 20, ty: 20, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 21, ty: 20, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 20, ty: 21, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 21, ty: 21, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 20, ty: 20, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 56, ty: 20, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 20, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 21, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 57, ty: 21, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 56, ty: 20, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      { tx: 38, ty: 36, frame: 28, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 36, frame: 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 37, frame: 35, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 39, ty: 37, frame: 36, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 38, ty: 36, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
      // Maximum glow
      { tx: 2,  ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 2,  ty: 56, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 77, ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 77, ty: 56, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 40, ty: 60, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 20, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 40, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 60, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 24, ty: 28, type: 'enemy' },
      { id: 'e4', tx: 56, ty: 28, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // BOSS ARENAS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-boss-a ─────────────────────────────────────────────────────────────
  // 80×96. The rift terminus — valley dead-end. Sheer walls on north/east/west.
  // 64-tile wide floor (widest in zone). 8×4 blocked seismic crack at 2/3 depth.
  // Boss north of crack. 6 markers — 4 north, 2 south. Player must breach gap.
  {
    id:           'rift-boss-a',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'boss',
    size:         { w: 80, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 95 },
    ],
    tiles: floor(80, 96),
    structures: [
      // North, east, west sheer walls (2 tiles)
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 40 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 1, frame: i < 40 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 78, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // 8×4 seismic crack at ty=60-63 — gap of 6 tiles at centre (tx=37-42)
      ...Array.from({ length: 4 }, (_, row) =>
        [
          ...Array.from({ length: 35 }, (_, i) =>
            ({ tx: i + 2, ty: row + 60, frame: i < 18 ? 28 : 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true })
          ),
          ...Array.from({ length: 35 }, (_, i) =>
            ({ tx: i + 43, ty: row + 60, frame: i < 18 ? 28 : 29, tint: TINT_RIFT_GLOW, depth: 4, blocked: true })
          ),
        ]
      ).flat(),
      // Intense glow at crack and gap
      { tx: 20, ty: 62, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 40, ty: 62, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 60, ty: 62, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      // North of crack (boss territory)
      { id: 'e0', tx: 20, ty: 24, type: 'enemy' },
      { id: 'e1', tx: 40, ty: 16, type: 'enemy' },
      { id: 'e2', tx: 60, ty: 24, type: 'enemy' },
      { id: 'e3', tx: 40, ty: 40, type: 'enemy' },
      // South of crack (approach zone)
      { id: 'e4', tx: 20, ty: 76, type: 'enemy' },
      { id: 'e5', tx: 60, ty: 76, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-boss-b ─────────────────────────────────────────────────────────────
  // 96×80. Collapsed section. Multiple large 4×4 boulder formations create rubble
  // field. Boss navigates rubble. 6 markers distributed. Cover lanes different
  // for player vs boss.
  {
    id:           'rift-boss-b',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'boss',
    size:         { w: 96, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 79 },
    ],
    tiles: floor(96, 80),
    structures: [
      // Sheer walls on all non-exit sides
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 48 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 95, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Six 4×4 boulder formations — rubble field
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 10, ty: ty + 8, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 12, ty: 10, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 36, ty: ty + 12, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 38, ty: 14, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 64, ty: ty + 8, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 66, ty: 10, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 20, ty: ty + 40, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 22, ty: 42, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 50, ty: ty + 44, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 52, ty: 46, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 4 }, (_, tx) =>
          ({ tx: tx + 78, ty: ty + 40, frame: tx < 2 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 80, ty: 42, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 56, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 80, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 10, ty: 56, type: 'enemy' },
      { id: 'e4', tx: 40, ty: 60, type: 'enemy' },
      { id: 'e5', tx: 72, ty: 56, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-boss-c ─────────────────────────────────────────────────────────────
  // 80×80. Wide seismic chamber. Four seismic crack formations radiate from north
  // wall. Boss at crack origin. 6 sentinel markers around cracks. Glow per crack.
  {
    id:           'rift-boss-c',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'boss',
    size:         { w: 80, h: 80 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 40, ty: 79 },
    ],
    tiles: floor(80, 80),
    structures: [
      // Sheer walls
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 40 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: i, ty: 1, frame: i < 40 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 80 }, (_, i) =>
        ({ tx: 79, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Four crack formations radiating from north wall
      // Crack 1 — straight south from (16, 2)
      { tx: 16, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 8,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 16, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 24, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 32, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 16, ty: 40, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      // Crack 2 — angled SE from (32, 2)
      { tx: 32, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 34, ty: 8,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 36, ty: 16, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 38, ty: 24, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 40, ty: 32, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      // Crack 3 — angled SW from (48, 2)
      { tx: 48, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 46, ty: 8,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 44, ty: 16, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 42, ty: 24, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 40, ty: 32, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      // Crack 4 — straight south from (64, 2)
      { tx: 64, ty: 2,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 8,  frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 16, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 24, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 32, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 40, frame: 13, tint: TINT_RIFT_GLOW, depth: 2 },
      // Glow sources at crack origins
      { tx: 16, ty: 4,  frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 32, ty: 4,  frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 48, ty: 4,  frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 4,  frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 8,  type: 'enemy' },
      { id: 'e1', tx: 24, ty: 8,  type: 'enemy' },
      { id: 'e2', tx: 40, ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 56, ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 72, ty: 8,  type: 'enemy' },
      { id: 'e5', tx: 40, ty: 48, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ── rift-boss-d ─────────────────────────────────────────────────────────────
  // 96×96. Greatest opening — tectonic movement created a large flat chamber.
  // Three rock platforms (8×4 blocked each). Boss on central platform. 6 markers.
  // Maximum seismic glow fills room.
  {
    id:           'rift-boss-d',
    zone_act:     1,
    region_types: ['rift-valley-terminus'],
    type:         'boss',
    size:         { w: 96, h: 96 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 48, ty: 95 },
    ],
    tiles: floor(96, 96),
    structures: [
      // Sheer walls on three sides
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 48 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: i, ty: 1, frame: i < 48 ? 21 : 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 1, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 94, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 96 }, (_, i) =>
        ({ tx: 95, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      // Three 8×4 rock platforms
      // West platform
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 8 }, (_, tx) =>
          ({ tx: tx + 10, ty: ty + 36, frame: tx < 4 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 14, ty: 38, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Central platform
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 8 }, (_, tx) =>
          ({ tx: tx + 44, ty: ty + 28, frame: tx < 4 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 48, ty: 30, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // East platform
      ...Array.from({ length: 4 }, (_, ty) =>
        Array.from({ length: 8 }, (_, tx) =>
          ({ tx: tx + 76, ty: ty + 36, frame: tx < 4 ? 28 : 29, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true })
        )
      ).flat(),
      { tx: 80, ty: 38, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      // Maximum seismic glow fills room
      { tx: 30, ty: 60, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 64, ty: 60, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 48, ty: 76, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 12, ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
      { tx: 80, ty: 24, frame: 7, tint: TINT_RIFT_GLOW, depth: 2 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 8,  ty: 32, type: 'enemy' },
      { id: 'e1', tx: 22, ty: 32, type: 'enemy' },
      { id: 'e2', tx: 48, ty: 24, type: 'enemy' },  // central platform boss area
      { id: 'e3', tx: 52, ty: 24, type: 'enemy' },
      { id: 'e4', tx: 74, ty: 32, type: 'enemy' },
      { id: 'e5', tx: 88, ty: 32, type: 'enemy' },
    ],
    min_room_tier: 2,
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CONNECTOR ROOMS (4)
  // ════════════════════════════════════════════════════════════════════════════

  // ── rift-connector-a ────────────────────────────────────────────────────────
  // 12×24. Minimal crack passage. Wall formations both sides. Very tight.
  {
    id:           'rift-connector-a',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor', 'rift-valley-narrows', 'rift-valley-chambers', 'rift-valley-deep', 'rift-valley-fault', 'rift-valley-terminus'],
    type:         'connector',
    size:         { w: 12, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 6, ty: 0  },
    ],
    tiles: floor(12, 24),
    structures: [
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        ({ tx: 11, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── rift-connector-b ────────────────────────────────────────────────────────
  // 16×16. Short rift stub. One strata line decoration.
  {
    id:           'rift-connector-b',
    zone_act:     1,
    region_types: ['rift-valley-descent', 'rift-valley-floor', 'rift-valley-narrows', 'rift-valley-chambers', 'rift-valley-deep', 'rift-valley-fault', 'rift-valley-terminus'],
    type:         'connector',
    size:         { w: 16, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 16),
    structures: [
      // Strata line
      { tx: 4,  ty: 7, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 8,  ty: 7, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
      { tx: 12, ty: 7, frame: 13, tint: TINT_RIFT_STRATA, depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 0,
  },

  // ── rift-connector-c ────────────────────────────────────────────────────────
  // 12×32. Long narrow rift throat. Full-length wall structures both sides.
  {
    id:           'rift-connector-c',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-chambers', 'rift-valley-deep', 'rift-valley-fault', 'rift-valley-terminus'],
    type:         'connector',
    size:         { w: 12, h: 32 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 31 },
      { id: 'north-0', edge: 'N', tx: 6, ty: 0  },
    ],
    tiles: floor(12, 32),
    structures: [
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 21, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        ({ tx: 11, ty: i, frame: 22, tint: TINT_RIFT_WALL, depth: 4, blocked: true })
      ),
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

  // ── rift-connector-d ────────────────────────────────────────────────────────
  // 16×24. Slightly wider stub. One debris fragment at centre.
  {
    id:           'rift-connector-d',
    zone_act:     1,
    region_types: ['rift-valley-narrows', 'rift-valley-chambers', 'rift-valley-deep', 'rift-valley-fault', 'rift-valley-terminus'],
    type:         'connector',
    size:         { w: 16, h: 24 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 23 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: floor(16, 24),
    structures: [
      { tx: 7, ty: 11, frame: 14, tint: TINT_RIFT_DEBRIS, depth: 4, blocked: true },
      { tx: 7, ty: 11, frame: 7,  tint: TINT_RIFT_GLOW,   depth: 2 },
    ],
    variants: [],
    spawn_markers: [],
    min_room_tier: 1,
  },

];  // end ROOMS_A1Z4

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A1Z4: RegionDef[] = [
  {
    id:             'rift-valley-descent',
    label:          'Rift Valley — Descent',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-floor',
    label:          'Rift Valley — Rift Floor',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-narrows',
    label:          'Rift Valley — Narrows',
    zone_acts:      [1],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   3,
    corridor_max:   6,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-chambers',
    label:          'Rift Valley — Wall Chambers',
    zone_acts:      [1],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-deep',
    label:          'Rift Valley — Deep Rift Ring',
    zone_acts:      [1],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-fault',
    label:          'Rift Valley — Active Fault Branches',
    zone_acts:      [1],
    layout:         'branching',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   3,
    corridor_max:   6,
    tint:           TINT_RIFT_FLOOR,
  },
  {
    id:             'rift-valley-terminus',
    label:          'Rift Valley — Terminus',
    zone_acts:      [1],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_RIFT_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionDescent,
  regionFloor,
  regionNarrows,
  regionChambers,
  regionDeep,
  regionFault,
  regionTerminus,
] = REGIONS_A1Z4;

export const ZONE_A1Z4: ZoneDef = {
  id:           'rift-valley',
  label:        'Rift Valley',
  zone_act:     1,
  region_defs:  [
    regionDescent,
    regionFloor,
    regionNarrows,
    regionChambers,
    regionDeep,
    regionFault,
    regionTerminus,
  ],
  enemy_flavour: 'sentinels',
  tint:          TINT_RIFT_FLOOR,
};
