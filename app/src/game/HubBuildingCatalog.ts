/**
 * HubBuildingCatalog — static data for all player-placeable hub buildings.
 *
 * Three vendor tiers:
 *   PLAZA_SHOP     — bought from the permanent Plaza Shop
 *   FAB_SHOP       — bought from the player's placed Frictionless Fab
 *   (none)         — not purchasable (permanent fixtures only)
 *
 * Material slots:
 *   Each slot has a required `points` total. Every accepted material has a
 *   `contribution` value (how many points 1 unit provides). The player fills
 *   the slot by supplying any mix of accepted materials until points are met.
 *
 *   Higher tiers intentionally contribute more so players are rewarded for
 *   refinement. Adjust `contribution` values freely — nothing else changes.
 *
 *   The `'metal'` category is reserved for Crystal Bars (Lumite, Ferrite, etc.)
 *   which are PENDING implementation. Slots that accept metal list the future
 *   material IDs with contribution values already set — they simply won't appear
 *   in the picker until those items exist in inventory.
 *
 * Footprints:
 *   Tile-space width × height. Anchor tile is top-left of the footprint.
 *   All footprint tiles are registered as blocked in TileWorld.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type MaterialCategory = 'textile' | 'stone' | 'wood' | 'metal';
export type VendorTier       = 'plaza_shop' | 'fab_shop';
export type BuildingState    = 'blueprint' | 'building' | 'built';
export type MachineMenuType  = 'generic' | 'rcs' | 'fab_shop';

export interface MaterialContribution {
  materialId:   string;
  category:     MaterialCategory;
  contribution: number;   // points provided per 1 unit of this material
}

export interface MaterialSlot {
  slotId:    string;         // unique within this building, e.g. 'frame', 'core'
  label:     string;         // display name shown in the build menu
  points:    number;         // total points required to fill this slot
  accepted:  MaterialContribution[];
}

export interface PermanentBuilding {
  id:         string;
  label:      string;
  spriteKey:  string;
  anchorTx:   number;
  anchorTy:   number;
  footprintW: number;
  footprintH: number;
}

export interface MachineEntry {
  id:           string;         // building_id stored in DB, e.g. 'machine-psi'
  label:        string;
  subtitle:     string;         // one-line description shown in shop + menu
  spriteKey:    string;         // Phaser texture key
  spriteKeyB?:  string;         // second sprite key for TST only
  footprintW:   number;
  footprintH:   number;
  etherCost:    number;
  vendor:       VendorTier;
  unlockReq:    string | null;  // machine id that must be 'built' first, or null
  slots:        MaterialSlot[];
  menuType:     MachineMenuType;
}

// ── Permanent buildings (hardcoded, not purchasable) ───────────────────────
// Collision registered in createZoneStructures() using registerBlocked().
// NOTE: Frictionless Fab is NOT in this list — it is player-placed.

export const PERMANENT_BUILDINGS: PermanentBuilding[] = [
  { id: 'perm-house',     label: 'House',           spriteKey: 'building-house',    anchorTx: 28, anchorTy: 18, footprintW: 2, footprintH: 2 },
  { id: 'perm-garage',    label: 'Garage',          spriteKey: 'building-garage',   anchorTx: 30, anchorTy: 18, footprintW: 3, footprintH: 2 },
  { id: 'perm-crafting',  label: 'Crafting Station',spriteKey: 'building-crafting', anchorTx: 27, anchorTy: 21, footprintW: 3, footprintH: 2 },
  { id: 'perm-shop',      label: 'Shop',            spriteKey: 'building-shop',     anchorTx: 16, anchorTy: 11, footprintW: 3, footprintH: 2 },
  { id: 'perm-gateway',   label: 'Space Gateway',   spriteKey: 'building-gateway',  anchorTx: 18, anchorTy: 13, footprintW: 3, footprintH: 2 },
];

// ── Material contribution tables ───────────────────────────────────────────
// Defined once, referenced by multiple slots across different machines.
// Tier 1 = 1pt, Tier 2 = 2pt, Tier 3 = 4pt — exponential reward for refinement.
// Metal entries (crystal bars) are stubbed with IDs matching the planned system.

const TEXTILE_ALL: MaterialContribution[] = [
  // Cloth line
  { materialId: 'cloth_t1',  category: 'textile', contribution: 1 },
  { materialId: 'cloth_t2',  category: 'textile', contribution: 2 },
  { materialId: 'cloth_t3',  category: 'textile', contribution: 4 },
  // Pelt line
  { materialId: 'pelt_t1',   category: 'textile', contribution: 1 },
  { materialId: 'pelt_t2',   category: 'textile', contribution: 2 },
  { materialId: 'pelt_t3',   category: 'textile', contribution: 4 },
  // Slough line — harder organic, contributes slightly more at T1
  { materialId: 'slough_t1', category: 'textile', contribution: 1 },
  { materialId: 'slough_t2', category: 'textile', contribution: 2 },
  { materialId: 'slough_t3', category: 'textile', contribution: 4 },
  // Special
  { materialId: 'solarhide', category: 'textile', contribution: 6 },
];

const STONE_ALL: MaterialContribution[] = [
  // Lightstone line — crystalline, precision
  { materialId: 'lightstone_t1', category: 'stone', contribution: 1 },
  { materialId: 'lightstone_t2', category: 'stone', contribution: 2 },
  { materialId: 'lightstone_t3', category: 'stone', contribution: 4 },
  // Roughstone line — dense, structural
  { materialId: 'roughstone_t1', category: 'stone', contribution: 1 },
  { materialId: 'roughstone_t2', category: 'stone', contribution: 2 },
  { materialId: 'roughstone_t3', category: 'stone', contribution: 4 },
  // Darkstone line — extreme hardness
  { materialId: 'darkstone_t1',  category: 'stone', contribution: 1 },
  { materialId: 'darkstone_t2',  category: 'stone', contribution: 2 },
  { materialId: 'darkstone_t3',  category: 'stone', contribution: 4 },
  // Specials
  { materialId: 'voidcrystal',   category: 'stone', contribution: 8 },
  { materialId: 'frostcore',     category: 'stone', contribution: 6 },
];

const WOOD_ALL: MaterialContribution[] = [
  // Palewood line — light, flexible
  { materialId: 'palewood_t1',  category: 'wood', contribution: 1 },
  { materialId: 'palewood_t2',  category: 'wood', contribution: 2 },
  { materialId: 'palewood_t3',  category: 'wood', contribution: 4 },
  // Heartwood line — dense, stiff
  { materialId: 'heartwood_t1', category: 'wood', contribution: 1 },
  { materialId: 'heartwood_t2', category: 'wood', contribution: 2 },
  { materialId: 'heartwood_t3', category: 'wood', contribution: 4 },
  // Deepwood line — maximum stiffness
  { materialId: 'deepwood_t1',  category: 'wood', contribution: 1 },
  { materialId: 'deepwood_t2',  category: 'wood', contribution: 2 },
  { materialId: 'deepwood_t3',  category: 'wood', contribution: 4 },
];

// Precision stone only — lightstone line + specials. Used for sensor/detector
// machines where crystalline structure matters, not raw density.
const STONE_PRECISION: MaterialContribution[] = [
  { materialId: 'lightstone_t1', category: 'stone', contribution: 1 },
  { materialId: 'lightstone_t2', category: 'stone', contribution: 2 },
  { materialId: 'lightstone_t3', category: 'stone', contribution: 4 },
  { materialId: 'voidcrystal',   category: 'stone', contribution: 8 },
  { materialId: 'frostcore',     category: 'stone', contribution: 6 },
];

// Dense stone only — roughstone + darkstone. Used for machines needing mass
// and EM-shielding rather than crystalline precision.
const STONE_DENSE: MaterialContribution[] = [
  { materialId: 'roughstone_t1', category: 'stone', contribution: 1 },
  { materialId: 'roughstone_t2', category: 'stone', contribution: 2 },
  { materialId: 'roughstone_t3', category: 'stone', contribution: 4 },
  { materialId: 'darkstone_t1',  category: 'stone', contribution: 1 },
  { materialId: 'darkstone_t2',  category: 'stone', contribution: 2 },
  { materialId: 'darkstone_t3',  category: 'stone', contribution: 4 },
  { materialId: 'frostcore',     category: 'stone', contribution: 6 },
];

// Structural wood — heartwood + deepwood only. Used where shaft stiffness and
// mass matter, not flexibility.
const WOOD_STRUCTURAL: MaterialContribution[] = [
  { materialId: 'heartwood_t1', category: 'wood', contribution: 1 },
  { materialId: 'heartwood_t2', category: 'wood', contribution: 2 },
  { materialId: 'heartwood_t3', category: 'wood', contribution: 4 },
  { materialId: 'deepwood_t1',  category: 'wood', contribution: 1 },
  { materialId: 'deepwood_t2',  category: 'wood', contribution: 2 },
  { materialId: 'deepwood_t3',  category: 'wood', contribution: 4 },
];

// Insulating textile — cloth + pelt only. Used for field damping and
// electromagnetic insulation layers.
const TEXTILE_INSULATING: MaterialContribution[] = [
  { materialId: 'cloth_t1',  category: 'textile', contribution: 1 },
  { materialId: 'cloth_t2',  category: 'textile', contribution: 2 },
  { materialId: 'cloth_t3',  category: 'textile', contribution: 4 },
  { materialId: 'pelt_t1',   category: 'textile', contribution: 1 },
  { materialId: 'pelt_t2',   category: 'textile', contribution: 2 },
  { materialId: 'pelt_t3',   category: 'textile', contribution: 4 },
  { materialId: 'solarhide', category: 'textile', contribution: 6 },
];

// Rigid textile — slough line only. Hard organic plates for structural shells.
const TEXTILE_RIGID: MaterialContribution[] = [
  { materialId: 'slough_t1', category: 'textile', contribution: 1 },
  { materialId: 'slough_t2', category: 'textile', contribution: 2 },
  { materialId: 'slough_t3', category: 'textile', contribution: 4 },
  { materialId: 'solarhide', category: 'textile', contribution: 6 },
];

// Metal stubs — Crystal Bars (PENDING). IDs match the planned gathering system.
// Contribution values set now; items simply won't appear until they exist in inventory.
const METAL_ALL: MaterialContribution[] = [
  { materialId: 'bar-lumite',   category: 'metal', contribution: 3 },
  { materialId: 'bar-ferrite',  category: 'metal', contribution: 4 },
  { materialId: 'bar-aurite',   category: 'metal', contribution: 3 },
  { materialId: 'bar-verdite',  category: 'metal', contribution: 3 },
  { materialId: 'bar-azurite',  category: 'metal', contribution: 3 },
  { materialId: 'bar-fluxite',  category: 'metal', contribution: 6 },
  { materialId: 'bar-solarium', category: 'metal', contribution: 8 },
  { materialId: 'ingot-prismatic', category: 'metal', contribution: 12 },
  { materialId: 'ingot-flux',      category: 'metal', contribution: 12 },
];

const METAL_PRECISION: MaterialContribution[] = [
  { materialId: 'bar-lumite',      category: 'metal', contribution: 3 },
  { materialId: 'bar-azurite',     category: 'metal', contribution: 3 },
  { materialId: 'bar-verdite',     category: 'metal', contribution: 3 },
  { materialId: 'ingot-prismatic', category: 'metal', contribution: 12 },
];

const METAL_STRUCTURAL: MaterialContribution[] = [
  { materialId: 'bar-ferrite',  category: 'metal', contribution: 4 },
  { materialId: 'bar-aurite',   category: 'metal', contribution: 3 },
  { materialId: 'bar-fluxite',  category: 'metal', contribution: 6 },
  { materialId: 'ingot-flux',   category: 'metal', contribution: 12 },
];

// ── Slot factory helpers ───────────────────────────────────────────────────

function slot(
  slotId: string,
  label: string,
  points: number,
  accepted: MaterialContribution[],
): MaterialSlot {
  return { slotId, label, points, accepted };
}

// ── Machine catalog ────────────────────────────────────────────────────────

export const MACHINE_CATALOG: MachineEntry[] = [

  // ── Frictionless Fab ────────────────────────────────────────────────────
  // The gateway building. Bought from Plaza Shop, no unlock requirement.
  // Once built, opens the Fab Shop for advanced machines.
  // Sprite tinted 0x44aaff to distinguish from the removed permanent fixture.
  {
    id:          'building-fab',
    label:       'Frictionless Fab',
    subtitle:    'Advanced fabrication facility. Unlocks machine construction.',
    spriteKey:   'building-fab',
    footprintW:  2,
    footprintH:  2,
    etherCost:   150,
    vendor:      'plaza_shop',
    unlockReq:   null,
    menuType:    'fab_shop',
    slots: [
      slot('frame',     'Frame',        8,  WOOD_STRUCTURAL),
      slot('insulator', 'Insulation',   4,  TEXTILE_INSULATING),
      slot('plating',   'Plating',      6,  STONE_DENSE),
    ],
  },

  // ── Phase-Shift Interferometer (PSI) ────────────────────────────────────
  // Sensor/detector for EM phase patterns. Lightest build — precision crystal
  // housing with insulating textile wrap. First research unlock.
  {
    id:          'machine-psi',
    label:       'Phase-Shift Interferometer',
    subtitle:    'Detects sub-c EM phase structures. Required for all advanced machines.',
    spriteKey:   'machine-psi',
    footprintW:  2,
    footprintH:  2,
    etherCost:   100,
    vendor:      'plaza_shop',
    unlockReq:   null,
    menuType:    'generic',
    slots: [
      slot('crystal',   'Crystal Housing', 6,  STONE_PRECISION),
      slot('insulator', 'Insulation',      4,  TEXTILE_INSULATING),
    ],
  },

  // ── Magnetic Projection Array (MPA) ─────────────────────────────────────
  // Superconducting Halbach magnets. Heaviest frame in the tree — needs dense
  // stone for EM shielding, structural wood for the magnet cradle, rigid
  // textile for the coil damping layer.
  {
    id:          'machine-mpa',
    label:       'Magnetic Projection Array',
    subtitle:    'Projects controlled EM-density gradients. Unlocks ZPR, SFG, SPC, FCS.',
    spriteKey:   'machine-mpa',
    footprintW:  2,
    footprintH:  2,
    etherCost:   200,
    vendor:      'fab_shop',
    unlockReq:   'machine-psi',
    menuType:    'generic',
    slots: [
      slot('shield',    'EM Shield',    10, STONE_DENSE),
      slot('cradle',    'Magnet Cradle', 8, WOOD_STRUCTURAL),
      slot('damping',   'Coil Damping',  6, TEXTILE_RIGID),
      slot('core',      'Core Plating',  6, METAL_STRUCTURAL),
    ],
  },

  // ── Zero Point Rectifier (ZPR) ──────────────────────────────────────────
  // Converts ZPF oscillation into directed work. Delicate and balanced —
  // precision crystal for the rectifier array, light wood for the chassis,
  // insulating textile to isolate the ZPF capture surface.
  {
    id:          'machine-zpr',
    label:       'Zero Point Rectifier',
    subtitle:    'Harvests Zero-Point Field energy. Future: passive power supply.',
    spriteKey:   'machine-zpr',
    footprintW:  1,
    footprintH:  2,
    etherCost:   180,
    vendor:      'fab_shop',
    unlockReq:   'machine-mpa',
    menuType:    'generic',
    slots: [
      slot('array',     'Rectifier Array', 8,  STONE_PRECISION),
      slot('chassis',   'Chassis',         4,  WOOD_ALL),
      slot('insulator', 'Insulation',      4,  TEXTILE_INSULATING),
    ],
  },

  // ── Stasis Field Generator (SFG) ────────────────────────────────────────
  // Displaces EM from a central volume. Needs maximum density stone to create
  // the displacement mass, plus soft textile as the field boundary lining.
  {
    id:          'machine-sfg',
    label:       'Stasis Field Generator',
    subtitle:    'Displaces local EM — stops time in a small volume. Future: passive XP zone.',
    spriteKey:   'machine-sfg',
    footprintW:  2,
    footprintH:  2,
    etherCost:   220,
    vendor:      'fab_shop',
    unlockReq:   'machine-mpa',
    menuType:    'generic',
    slots: [
      slot('mass',      'Displacement Mass', 12, STONE_DENSE),
      slot('lining',    'Field Lining',       6, TEXTILE_INSULATING),
      slot('shell',     'Outer Shell',        6, METAL_STRUCTURAL),
    ],
  },

  // ── Sub-Cycle Phase Computer (SPC) ──────────────────────────────────────
  // Computes at the 137 sub-cycle rate. Needs precision crystal for the
  // computation substrate, structural wood for the chassis housing, and
  // insulating textile to prevent field bleed between calculation stages.
  {
    id:          'machine-spc',
    label:       'Sub-Cycle Phase Computer',
    subtitle:    'Operates at α gear ratio — enables impossible calculation classes.',
    spriteKey:   'machine-spc',
    footprintW:  2,
    footprintH:  2,
    etherCost:   240,
    vendor:      'fab_shop',
    unlockReq:   'machine-mpa',
    menuType:    'generic',
    slots: [
      slot('substrate',  'Compute Substrate', 10, STONE_PRECISION),
      slot('chassis',    'Chassis',            6, WOOD_STRUCTURAL),
      slot('insulator',  'Stage Insulation',   6, TEXTILE_INSULATING),
      slot('core',       'Precision Core',     4, METAL_PRECISION),
    ],
  },

  // ── Resonant Cavitation Shell (RCS) ─────────────────────────────────────
  // Exploits EM cavitation to nucleate matter from ZPF. Passive material gen.
  // Needs precision crystal for cavitation nodes, rigid textile for the
  // nucleation membrane, and some dense stone for the containment ring.
  {
    id:          'machine-rcs',
    label:       'Resonant Cavitation Shell',
    subtitle:    'Nucleates matter from the ZPF. Generates materials over time.',
    spriteKey:   'machine-rcs',
    footprintW:  1,
    footprintH:  2,
    etherCost:   260,
    vendor:      'fab_shop',
    unlockReq:   'machine-spc',
    menuType:    'rcs',
    slots: [
      slot('nodes',     'Cavitation Nodes',    8,  STONE_PRECISION),
      slot('membrane',  'Nucleation Membrane', 6,  TEXTILE_RIGID),
      slot('ring',      'Containment Ring',    4,  STONE_DENSE),
      slot('catalyst',  'Catalyst',            4,  METAL_PRECISION),
    ],
  },

  // ── Flux Containment System (FCS) ───────────────────────────────────────
  // Contains a high-EM-density pocket. Prerequisite for Portable Flux
  // Capacitor. Needs the heaviest stone for the containment wall, structural
  // wood for the expansion joints, and metal for the flux-sealing layer.
  {
    id:          'machine-fcs',
    label:       'Flux Containment System',
    subtitle:    'Stabilises a high-density EM pocket. Prerequisite: Portable Flux Capacitor.',
    spriteKey:   'machine-fcs',
    footprintW:  2,
    footprintH:  2,
    etherCost:   280,
    vendor:      'fab_shop',
    unlockReq:   'machine-mpa',
    menuType:    'generic',
    slots: [
      slot('wall',    'Containment Wall',  12, STONE_ALL),
      slot('joints',  'Expansion Joints',   6, WOOD_STRUCTURAL),
      slot('seal',    'Flux Seal',          8, METAL_ALL),
    ],
  },

  // ── Toroidal Shear Thruster (TST) ───────────────────────────────────────
  // End-game drive system. Largest build in the tree — two-sprite, 3×2 footprint.
  // Requires the most materials across all four categories.
  // Unlock: SPC must be built (Fab is already a permanent player-placed building).
  {
    id:          'machine-tst',
    label:       'Toroidal Shear Thruster',
    subtitle:    'Peristaltic EM drive — creates a Density Bridge for space flight.',
    spriteKey:   'machine-tst-a',
    spriteKeyB:  'machine-tst-b',
    footprintW:  3,
    footprintH:  2,
    etherCost:   400,
    vendor:      'fab_shop',
    unlockReq:   'machine-spc',
    menuType:    'generic',
    slots: [
      slot('ring-a',   'Drive Ring A',        10, STONE_DENSE),
      slot('ring-b',   'Drive Ring B',        10, STONE_DENSE),
      slot('stator',   'Stator Winding',       8, WOOD_STRUCTURAL),
      slot('lining',   'Thrust Lining',        8, TEXTILE_RIGID),
      slot('core',     'EM Core',             10, METAL_ALL),
    ],
  },
];

// ── Lookup helpers ─────────────────────────────────────────────────────────

export const MACHINE_BY_ID = new Map<string, MachineEntry>(
  MACHINE_CATALOG.map(m => [m.id, m])
);

/**
 * Returns true if the machine's unlock requirement is satisfied.
 * builtIds is the set of building_ids that have state === 'built'.
 */
export function isMachineUnlocked(machineId: string, builtIds: Set<string>): boolean {
  const entry = MACHINE_BY_ID.get(machineId);
  if (!entry) return false;
  if (entry.unlockReq === null) return true;
  return builtIds.has(entry.unlockReq);
}

/**
 * Returns all tiles in a building's footprint given its anchor tile.
 * Iterates width-first (x varies fastest) to match TileWorld key encoding.
 */
export function getFootprintTiles(
  anchorTx: number,
  anchorTy: number,
  footprintW: number,
  footprintH: number,
): Array<{ tx: number; ty: number }> {
  const tiles: Array<{ tx: number; ty: number }> = [];
  for (let dy = 0; dy < footprintH; dy++) {
    for (let dx = 0; dx < footprintW; dx++) {
      tiles.push({ tx: anchorTx + dx, ty: anchorTy + dy });
    }
  }
  return tiles;
}

/**
 * Computes how many points a given material+quantity contributes to a slot.
 * Returns 0 if the material is not accepted by that slot.
 */
export function computeContribution(
  slot: MaterialSlot,
  materialId: string,
  quantity: number,
): number {
  const entry = slot.accepted.find(a => a.materialId === materialId);
  if (!entry) return 0;
  return entry.contribution * quantity;
}

/**
 * Returns the total points already fulfilled in a slot given the supplied
 * materials record (materialId → quantity).
 */
export function slotFulfillment(
  slot: MaterialSlot,
  supplied: Record<string, number>,
): number {
  let total = 0;
  for (const [matId, qty] of Object.entries(supplied)) {
    total += computeContribution(slot, matId, qty);
  }
  return Math.min(total, slot.points); // never exceeds requirement
}

/**
 * Returns overall build progress [0, 1] across all slots.
 * suppliedBySlot: slotId → { materialId → quantity }
 */
export function buildProgress(
  entry: MachineEntry,
  suppliedBySlot: Record<string, Record<string, number>>,
): number {
  if (entry.slots.length === 0) return 1;
  let totalRequired = 0;
  let totalFulfilled = 0;
  for (const s of entry.slots) {
    totalRequired  += s.points;
    totalFulfilled += slotFulfillment(s, suppliedBySlot[s.slotId] ?? {});
  }
  return totalRequired === 0 ? 1 : totalFulfilled / totalRequired;
}

/**
 * Derives BuildingState from progress ratio.
 *   0        → 'blueprint'
 *   0 < p<1  → 'building'
 *   1        → 'built'
 */
export function progressToState(progress: number): BuildingState {
  if (progress <= 0) return 'blueprint';
  if (progress < 1)  return 'building';
  return 'built';
}

// ── RCS constants ──────────────────────────────────────────────────────────

/** Minutes between each unit of RCS output. */
export const RCS_MINUTES_PER_UNIT = 10;

/** Maximum units the RCS can hold before collection (24 hours). */
export const RCS_MAX_STORED = 144;

/**
 * Calculates how many units an RCS has accumulated since last collection.
 * lastCollectedAt: ISO timestamp string or null (null = use placed_at).
 */
export function rcsAccumulatedUnits(
  lastCollectedAt: string | null,
  placedAt: string,
): number {
  const since = lastCollectedAt ?? placedAt;
  const elapsedMs = Date.now() - new Date(since).getTime();
  const units = Math.floor(elapsedMs / (RCS_MINUTES_PER_UNIT * 60 * 1000));
  return Math.min(units, RCS_MAX_STORED);
}