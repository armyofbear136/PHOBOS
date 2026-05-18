/**
 * CraftingMaterials — PHOBOS material science system.
 *
 * Nine lines × 3 tiers + 3 special uncraftable drop materials.
 * Properties grounded in Primal Online framework:
 *   rho — Density g/cm³       → weight
 *   hv  — Vickers Hardness    → slash/pierce damage
 *   uts — Tensile Strength MPa → structural integrity
 *   cv  — Charpy Toughness J  → durability, blunt resist
 *   e   — Young's Modulus GPa → shaft stiffness/energy transfer
 *   cr  — Corrosion Resist 0–1→ passive durability decay
 *   tr  — Thermal Resist 0–1  → fire damage reduction
 * Derived:
 *   erf = hv / sqrt(cv * 100)    — edge retention
 *   sif = sqrt(uts * cv) / 100   — structural integrity factor
 */

export type MaterialCategory = 'textile' | 'stone' | 'wood';
export type MaterialTier     = 1 | 2 | 3;
export type MaterialLine     =
  | 'cloth' | 'pelt' | 'slough'
  | 'lightstone' | 'roughstone' | 'darkstone'
  | 'palewood' | 'heartwood' | 'deepwood';

export type ComponentRole =
  | 'head' | 'shaft' | 'grip' | 'hilt'
  | 'armor_backing' | 'armor_main'
  | 'bow_stave' | 'ring_base';

export interface MaterialProps {
  id: string; name: string;
  line: MaterialLine; category: MaterialCategory; tier: MaterialTier;
  dropName: string;
  rho: number; hv: number; uts: number; cv: number;
  e: number; cr: number; tr: number;
  erf: number; sif: number;
  roles: ComponentRole[];
  tint: number;
}

function mat(
  id: string, name: string, line: MaterialLine, cat: MaterialCategory, tier: MaterialTier,
  dropName: string, rho: number, hv: number, uts: number, cv: number,
  e: number, cr: number, tr: number, roles: ComponentRole[], tint: number
): MaterialProps {
  const erf = hv / Math.sqrt(cv * 100);
  const sif = Math.sqrt(uts * cv) / 100;
  return { id, name, line, category: cat, tier, dropName, rho, hv, uts, cv, e, cr, tr,
           erf: +erf.toFixed(3), sif: +sif.toFixed(3), roles, tint };
}

// ─── TEXTILE LINE 1 — Cloth → Fiber → Silk ──────────────────────────────
// Soft, featherlight, zero hardness — grip/backing only, no structural roles
export const TEXTILE_CLOTH: MaterialProps[] = [
  mat('cloth_t1',  'Cloth',  'cloth', 'textile', 1, 'Cloth',  0.20,  2,  20, 18, 0.01, 0.25, 0.10, ['grip','armor_backing'], 0xd4c49a),
  mat('cloth_t2',  'Fiber',  'cloth', 'textile', 2, 'Cloth',  0.22,  4,  60, 30, 0.02, 0.30, 0.12, ['grip','armor_backing'], 0xd4b870),
  mat('cloth_t3',  'Silk',   'cloth', 'textile', 3, 'Cloth',  0.28,  5, 480, 75, 0.14, 0.40, 0.22, ['grip','armor_backing','armor_main'], 0xf0e8c0),
];

// ─── TEXTILE LINE 2 — Pelt → Hide → Leather ──────────────────────────────
// Medium weight, good CV — grip, backing, soft armor
export const TEXTILE_PELT: MaterialProps[] = [
  mat('pelt_t1',   'Pelt',     'pelt', 'textile', 1, 'Pelt',  0.40,  8,  40, 28, 0.04, 0.28, 0.15, ['grip','armor_backing'], 0x8b5e3c),
  mat('pelt_t2',   'Hide',     'pelt', 'textile', 2, 'Pelt',  0.70, 12,  65, 38, 0.06, 0.33, 0.18, ['grip','armor_backing','armor_main'], 0x7a4c28),
  mat('pelt_t3',   'Leather',  'pelt', 'textile', 3, 'Pelt',  0.95, 15,  78, 42, 0.09, 0.35, 0.20, ['grip','armor_backing','armor_main'], 0x5c3a1e),
];

// ─── TEXTILE LINE 3 — Slough → Scale → Exoskeleton ───────────────────────
// Hard organic plates — hilt reinforcement, scale armor
export const TEXTILE_SLOUGH: MaterialProps[] = [
  mat('slough_t1', 'Slough',       'slough', 'textile', 1, 'Slough',  1.10,  35,  90, 18, 5.0,  0.38, 0.22, ['grip','hilt','armor_main'], 0x5a7a50),
  mat('slough_t2', 'Scale',        'slough', 'textile', 2, 'Slough',  1.35,  75, 160, 28, 9.0,  0.46, 0.28, ['hilt','armor_main'], 0x3d6b44),
  mat('slough_t3', 'Exoskeleton',  'slough', 'textile', 3, 'Slough',  1.65, 130, 260, 35, 15.0, 0.52, 0.32, ['hilt','armor_main'], 0x2a5030),
];

// ─── STONE LINE 1 — Lightstone → Gleamstone → Gemstone ───────────────────
// Crystalline, very hard, brittle — weapon heads, ring crafting
export const STONE_LIGHT: MaterialProps[] = [
  mat('lightstone_t1', 'Lightstone', 'lightstone', 'stone', 1, 'Lightstone', 2.60, 200,  60, 3, 45, 0.78, 0.55, ['head','ring_base'], 0xe8e0f0),
  mat('lightstone_t2', 'Gleamstone', 'lightstone', 'stone', 2, 'Lightstone', 2.72, 380,  90, 5, 62, 0.84, 0.65, ['head','ring_base'], 0xc8b4f0),
  mat('lightstone_t3', 'Gemstone',   'lightstone', 'stone', 3, 'Lightstone', 2.88, 620, 130, 7, 78, 0.91, 0.75, ['head','ring_base'], 0xa080ff),
];

// ─── STONE LINE 2 — Roughstone → Hardstone → Corestone ───────────────────
// Dense volcanic/igneous — heavy weapon heads, plate armor
export const STONE_ROUGH: MaterialProps[] = [
  mat('roughstone_t1', 'Roughstone', 'roughstone', 'stone', 1, 'Roughstone', 2.80, 140,  80,  8, 55, 0.62, 0.48, ['head','hilt','armor_main'], 0x888880),
  mat('roughstone_t2', 'Hardstone',  'roughstone', 'stone', 2, 'Roughstone', 3.10, 280, 150, 14, 72, 0.70, 0.58, ['head','hilt','armor_main'], 0x606060),
  mat('roughstone_t3', 'Corestone',  'roughstone', 'stone', 3, 'Roughstone', 3.45, 460, 240, 22, 90, 0.76, 0.66, ['head','hilt','armor_main'], 0x404048),
];

// ─── STONE LINE 3 — Darkstone → Sootstone → Abyssstone ───────────────────
// Obsidian-analogue — extreme hardness, very brittle — weapon heads only
export const STONE_DARK: MaterialProps[] = [
  mat('darkstone_t1', 'Darkstone',  'darkstone', 'stone', 1, 'Darkstone',  2.38, 480,  50, 2, 68, 0.55, 0.18, ['head'], 0x2a2030),
  mat('darkstone_t2', 'Sootstone',  'darkstone', 'stone', 2, 'Darkstone',  2.55, 680,  80, 4, 82, 0.62, 0.22, ['head'], 0x1a1028),
  mat('darkstone_t3', 'Abyssstone', 'darkstone', 'stone', 3, 'Darkstone',  2.70, 950, 120, 6, 95, 0.70, 0.28, ['head'], 0x0d0818),
];

// ─── WOOD LINE 1 — Palewood → Sheerwood → Ilumiwood ──────────────────────
// Light, flexible — fast weapons, ranged weapon staves
export const WOOD_PALE: MaterialProps[] = [
  mat('palewood_t1',  'Palewood',  'palewood',  'wood', 1, 'Palewood',  0.52, 12,  55, 28, 9.5,  0.38, 0.30, ['shaft','bow_stave'], 0xe8d8b0),
  mat('palewood_t2',  'Sheerwood', 'palewood',  'wood', 2, 'Palewood',  0.58, 18,  90, 38, 11.5, 0.42, 0.33, ['shaft','bow_stave'], 0xd4c080),
  mat('palewood_t3',  'Ilumiwood', 'palewood',  'wood', 3, 'Palewood',  0.63, 25, 145, 52, 13.5, 0.48, 0.38, ['shaft','bow_stave'], 0xf0e860),
];

// ─── WOOD LINE 2 — Heartwood → Primewood → Starwood ──────────────────────
// Dense, stiff — heavy weapon shafts, two-handed weapons
export const WOOD_HEART: MaterialProps[] = [
  mat('heartwood_t1', 'Heartwood', 'heartwood', 'wood', 1, 'Heartwood', 0.75, 22, 100, 35, 13.0, 0.48, 0.36, ['shaft','bow_stave'], 0x6b3a1e),
  mat('heartwood_t2', 'Primewood', 'heartwood', 'wood', 2, 'Heartwood', 0.88, 35, 155, 50, 15.5, 0.54, 0.41, ['shaft','bow_stave'], 0x4a2810),
  mat('heartwood_t3', 'Starwood',  'heartwood', 'wood', 3, 'Heartwood', 1.02, 55, 230, 68, 18.0, 0.60, 0.46, ['shaft','bow_stave'], 0x301808),
];

// ─── WOOD LINE 3 — Deepwood → Cinderwood → Stonewood ─────────────────────
// Maximum stiffness/density — mass weapons, maximum damage transfer
export const WOOD_DEEP: MaterialProps[] = [
  mat('deepwood_t1',  'Deepwood',   'deepwood',  'wood', 1, 'Deepwood',  1.05,  45, 160, 30, 17.0, 0.55, 0.42, ['shaft'], 0x1a1008),
  mat('deepwood_t2',  'Cinderwood', 'deepwood',  'wood', 2, 'Deepwood',  1.18,  70, 235, 40, 19.5, 0.60, 0.55, ['shaft'], 0x0f0c04),
  mat('deepwood_t3',  'Stonewood',  'deepwood',  'wood', 3, 'Deepwood',  1.35, 110, 340, 52, 22.5, 0.66, 0.62, ['shaft'], 0x080804),
];

// ─── Special uncraftable — enemy drop only ────────────────────────────────
export const SPECIAL_MATERIALS: MaterialProps[] = [
  // Voidcrystal — from Void bosses — extreme HV (best slash/pierce head)
  mat('voidcrystal', 'Voidcrystal', 'darkstone', 'stone', 3, 'Voidcrystal Shard',
      2.90, 1400, 140, 4, 105, 0.80, 0.35, ['head'], 0x6600cc),
  // Solarhide — from Fire/Plasma bosses — highest CV anywhere (best durability + blunt)
  mat('solarhide', 'Solarhide', 'pelt', 'textile', 3, 'Solarhide Scrap',
      1.20, 20, 95, 120, 0.12, 0.55, 0.88, ['armor_main','armor_backing','grip'], 0xff8800),
  // Frostcore — from Ice bosses — balanced HV+CV (no tradeoff, best all-round head)
  mat('frostcore', 'Frostcore', 'roughstone', 'stone', 3, 'Frostcore Fragment',
      3.20, 520, 300, 38, 98, 0.88, 0.08, ['head','armor_main'], 0x80e8ff),
];

// ─── Master tables ────────────────────────────────────────────────────────
export const ALL_MATERIALS: MaterialProps[] = [
  ...TEXTILE_CLOTH, ...TEXTILE_PELT, ...TEXTILE_SLOUGH,
  ...STONE_LIGHT, ...STONE_ROUGH, ...STONE_DARK,
  ...WOOD_PALE, ...WOOD_HEART, ...WOOD_DEEP,
  ...SPECIAL_MATERIALS,
];

export const MATERIAL_BY_ID = new Map<string, MaterialProps>(
  ALL_MATERIALS.map(m => [m.id, m])
);

export const CRAFTABLE_MATERIALS = ALL_MATERIALS.filter(
  m => !['voidcrystal','solarhide','frostcore'].includes(m.id)
);

export const DROPPABLE_MATERIALS = CRAFTABLE_MATERIALS.filter(m => m.tier === 1);

/** Returns next refinement tier, or null if already tier 3 */
export function getNextTier(mat: MaterialProps): MaterialProps | null {
  if (mat.tier >= 3) return null;
  return MATERIAL_BY_ID.get(mat.id.replace(/_t\d$/, `_t${mat.tier + 1}`)) ?? null;
}

export function canFillRole(mat: MaterialProps, role: ComponentRole): boolean {
  return mat.roles.includes(role);
}

export function getMaterialsForRole(role: ComponentRole, includeSpecial = false): MaterialProps[] {
  const pool = includeSpecial ? ALL_MATERIALS : CRAFTABLE_MATERIALS;
  return pool.filter(m => canFillRole(m, role)).sort((a, b) => a.tier - b.tier);
}

/** Quantity of previous tier needed to refine 1 unit of next tier */
export const REFINE_COST: Record<MaterialTier, number> = { 1: 0, 2: 4, 3: 4 };
