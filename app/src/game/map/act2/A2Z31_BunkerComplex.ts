/**
 * Act II — Zone 31 — BUNKER COMPLEX
 * Archetype index: 31
 * Tint: 0x0e0e12 (deep blue-black)
 * Enemy flavour: sentinels
 *
 * Migrated from ExplorationZoneManager.ts (barracks-block).
 * This is the Act II reference implementation — the first three-tier zone.
 * Tight military corridors, bunker rooms, a crimson-palette convergence boss arena.
 */

import type { RoomDef, RegionDef, ZoneDef } from '../../ExplorationZoneManager';

// ── Tint constants ────────────────────────────────────────────────────────────

const TINT_BUNKER_FLOOR:  number = 0x4a4858;
const TINT_BUNKER_WALL:   number = 0x6a6880;
const TINT_BUNKER_DETAIL: number = 0x7a6898;
const TINT_BOSS_FLOOR:    number = 0x2a1010;  // deep red-black — boss arena floor
const TINT_BOSS_WALL:     number = 0x6a1818;  // dark crimson — boss walls
const TINT_BOSS_DETAIL:   number = 0xc04020;  // red-orange — boss accent structures

// ── Room catalogue ────────────────────────────────────────────────────────────

export const ROOMS_A2Z31: RoomDef[] = [

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
      // Desk detail
      { tx: 2, ty: 1, frame: 7, tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 5, ty: 1, frame: 7, tint: TINT_BUNKER_DETAIL, depth: 5 },
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
      { tx: 0, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 4, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 6, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 8, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 3, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 5, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 7, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 9, frame: 15, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 1, ty: 9, type: 'enemy' },
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
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 4; tx++)
          t.push({ tx, ty, frame: 7 });
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
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 4; tx < 8; tx++)
          t.push({ tx, ty, frame: 7 });
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
    region_types: ['bunker-corridor', 'bunker-branch'],
    type: 'standard',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 2, ty: 7 },
      { id: 'north-0', edge: 'N', tx: 2, ty: 0 },
      { id: 'east-0',  edge: 'E', tx: 7, ty: 4 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 5; tx++)
          t.push({ tx, ty, frame: 7 });
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
    region_types: ['bunker-corridor', 'bunker-branch'],
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
      { tx: 8,  ty: 1, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 9,  ty: 1, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 10, ty: 1, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 10, ty: 6, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [
      { tx: 4, ty: 4, frames: [0, 7] },
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
  // 12×12. Boss lead-in. South connection only. High enemy density.
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
      // North wall
      { tx: 0,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Corner pillars
      { tx: 0,  ty: 4,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0,  ty: 8,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 4,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 8,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
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

  // ── bunker-barracks-hall ──────────────────────────────────────────────────
  // 16×12. Large throughRoom. Open bunk hall with wall pillars on both sides.
  {
    id: 'bunker-barracks-hall',
    zone_act: 2,
    region_types: ['bunker-corridor', 'bunker-depot', 'bunker-command', 'bunker-convergence'],
    type: 'standard',
    size: { w: 16, h: 12 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 11 },
      { id: 'north-0', edge: 'N', tx: 8, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 12; ty++)
        for (let tx = 0; tx < 16; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 8 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // West wall pillars
      { tx: 0,  ty: 3,  frame: 21, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 0,  ty: 7,  frame: 21, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 0,  ty: 11, frame: 21, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      // East wall pillars
      { tx: 15, ty: 3,  frame: 22, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 15, ty: 7,  frame: 22, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 15, ty: 11, frame: 22, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      // Bunk frames
      { tx: 1,  ty: 2,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 1,  ty: 5,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 1,  ty: 8,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 14, ty: 2,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 14, ty: 5,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 14, ty: 8,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      // Central debris scatter
      { tx: 6,  ty: 5,  frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 9,  ty: 5,  frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 7,  ty: 7,  frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 3,  ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 12, ty: 4,  type: 'enemy' },
      { id: 'e2', tx: 3,  ty: 8,  type: 'enemy' },
      { id: 'e3', tx: 12, ty: 8,  type: 'enemy' },
      { id: 'e4', tx: 7,  ty: 6,  type: 'enemy' },
      { id: 'l0', tx: 8,  ty: 10, type: 'loot'  },
    ],
    min_room_tier: 0,
  },

  // ── bunker-storage-bay ────────────────────────────────────────────────────
  // 12×16. Large throughRoom. Tall storage bay with crate stacks on east/west walls.
  {
    id: 'bunker-storage-bay',
    zone_act: 2,
    region_types: ['bunker-corridor', 'bunker-depot', 'bunker-command', 'bunker-convergence'],
    type: 'standard',
    size: { w: 12, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 15 },
      { id: 'north-0', edge: 'N', tx: 6, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 16; ty++)
        for (let tx = 0; tx < 12; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 6 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // West crate stacks — blocked
      { tx: 0, ty: 2,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 1, ty: 2,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 0, ty: 5,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 1, ty: 5,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 0, ty: 9,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 1, ty: 9,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 0, ty: 12, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 1, ty: 12, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      // East crate stacks — blocked
      { tx: 10, ty: 2,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 11, ty: 2,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 10, ty: 5,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 11, ty: 5,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 10, ty: 9,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 11, ty: 9,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 10, ty: 12, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      { tx: 11, ty: 12, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 4, blocked: true },
      // Lone crate in the aisle
      { tx: 5, ty: 7, frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 3,  ty: 3,  type: 'enemy' },
      { id: 'e1', tx: 8,  ty: 3,  type: 'enemy' },
      { id: 'e2', tx: 3,  ty: 10, type: 'enemy' },
      { id: 'e3', tx: 8,  ty: 10, type: 'enemy' },
      { id: 'e4', tx: 5,  ty: 13, type: 'enemy' },
      { id: 'l0', tx: 5,  ty: 7,  type: 'loot'  },
      { id: 'm0', tx: 2,  ty: 14, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-crossroads ─────────────────────────────────────────────────────
  // 8×8 throughRoom. Open crossroads with a central support column and N/S/E connections.
  {
    id: 'bunker-crossroads',
    zone_act: 2,
    region_types: ['bunker-corridor', 'bunker-depot', 'bunker-command', 'bunker-branch', 'bunker-grid'],
    type: 'standard',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 4, ty: 7 },
      { id: 'north-0', edge: 'N', tx: 4, ty: 0 },
      { id: 'east-0',  edge: 'E', tx: 7, ty: 4 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 8; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall with gap at connection
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // gap at tx 3-5
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Central support pillar
      { tx: 3, ty: 3, frame: 35, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 3, frame: 36, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 4, frame: 28, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 4, frame: 29, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 1, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 6, ty: 2, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-tight-corridor ─────────────────────────────────────────────────
  // 4×20 throughRoom connector. Long tight corridor with a console alcove.
  {
    id: 'bunker-tight-corridor',
    zone_act: 2,
    region_types: ['bunker-command'],
    type: 'connector',
    size: { w: 4, h: 20 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 2, ty: 19 },
      { id: 'north-0', edge: 'N', tx: 2, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 20; ty++)
        for (let tx = 0; tx < 4; tx++)
          t.push({ tx, ty, frame: 7 });
      return t;
    })(),
    structures: [
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: 0, ty: i, frame: 13, tint: TINT_BUNKER_DETAIL, depth: 3 })
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        ({ tx: 3, ty: i, frame: 13, tint: TINT_BUNKER_DETAIL, depth: 3 })
      ),
      // Mid-point console alcove
      { tx: 0, ty: 9, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 10, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-armoury ────────────────────────────────────────────────────────
  // 12×8 dead-end. Armoury room with weapon racks on north wall, good loot.
  {
    id: 'bunker-armoury',
    zone_act: 2,
    region_types: ['bunker-corridor', 'bunker-depot', 'bunker-command', 'bunker-branch'],
    type: 'dead-end',
    size: { w: 12, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 6, ty: 7 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 12; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall — full blocked
      ...Array.from({ length: 12 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 6 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // Weapon rack row along north wall
      { tx: 1,  ty: 1, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 3,  ty: 1, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 5,  ty: 1, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 7,  ty: 1, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 9,  ty: 1, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      // Corner lockers — blocked
      { tx: 0,  ty: 3, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 3, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 3,  ty: 4, type: 'enemy' },
      { id: 'e1', tx: 8,  ty: 4, type: 'enemy' },
      { id: 'l0', tx: 2,  ty: 5, type: 'loot'  },
      { id: 'l1', tx: 10, ty: 5, type: 'loot'  },
      { id: 'l2', tx: 6,  ty: 3, type: 'loot'  },
    ],
    min_room_tier: 0,
  },

  // ── bunker-collapsed-section ──────────────────────────────────────────────
  // 8×8 dead-end. Partially collapsed room, rubble blocking east half.
  {
    id: 'bunker-collapsed-section',
    zone_act: 2,
    region_types: ['bunker-corridor', 'bunker-depot', 'bunker-command'],
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
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 4 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // Rubble fill — east half irregular
      { tx: 5, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 2, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 2, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 3, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 3, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty: 4, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5, frame: 14, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Scattered floor debris — walkable
      { tx: 2, ty: 3, frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 3, ty: 5, frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 1, ty: 6, frame: 14, tint: TINT_BUNKER_DETAIL, depth: 3 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 1, ty: 4, type: 'enemy'   },
      { id: 'e1', tx: 3, ty: 2, type: 'enemy'   },
      { id: 'e2', tx: 2, ty: 6, type: 'enemy'   },
      { id: 'm0', tx: 4, ty: 3, type: 'mineral' },
      { id: 'm1', tx: 3, ty: 6, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-entry-b ────────────────────────────────────────────────────────
  // 8×8 entry variant. Guard post details, two enemies at the flanks.
  {
    id: 'bunker-entry-b',
    zone_act: 2,
    region_types: ['bunker-depot', 'bunker-command'],
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
      // North wall
      ...Array.from({ length: 8 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 4 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // Guard post consoles
      { tx: 1, ty: 2, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 6, ty: 2, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      // Side lockers — blocked
      { tx: 0, ty: 5, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 4, type: 'enemy' },
      { id: 'e1', tx: 5, ty: 4, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-command-room ───────────────────────────────────────────────────
  // 16×16 boss room. Command centre with raised map table, console banks.
  {
    id: 'bunker-command-room',
    zone_act: 2,
    region_types: ['bunker-command'],
    type: 'boss',
    size: { w: 16, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 8, ty: 15 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 16; ty++)
        for (let tx = 0; tx < 16; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // Full north wall
      ...Array.from({ length: 16 }, (_, i) =>
        ({ tx: i, ty: 0, frame: i < 8 ? 21 : 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true })
      ),
      // East and west wall banks
      { tx: 0,  ty: 3,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0,  ty: 7,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0,  ty: 11, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 3,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 7,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 11, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Console banks
      { tx: 1,  ty: 2,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 2,  ty: 2,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 13, ty: 2,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 14, ty: 2,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 1,  ty: 12, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 2,  ty: 12, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 13, ty: 12, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      { tx: 14, ty: 12, frame: 29, tint: TINT_BUNKER_DETAIL, depth: 3 },
      // Central map table — blocked 2×2
      { tx: 7,  ty: 6,  frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 8,  ty: 6,  frame: 29, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 7,  ty: 7,  frame: 35, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 8,  ty: 7,  frame: 36, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 3,  ty: 4,  type: 'enemy' },
      { id: 'e1', tx: 12, ty: 4,  type: 'enemy' },
      { id: 'e2', tx: 3,  ty: 10, type: 'enemy' },
      { id: 'e3', tx: 12, ty: 10, type: 'enemy' },
      { id: 'e4', tx: 5,  ty: 13, type: 'enemy' },
      { id: 'e5', tx: 10, ty: 13, type: 'enemy' },
      { id: 'e6', tx: 7,  ty: 3,  type: 'enemy' },
      { id: 'e7', tx: 8,  ty: 3,  type: 'enemy' },
      { id: 'l0', tx: 4,  ty: 13, type: 'loot'  },
      { id: 'l1', tx: 11, ty: 13, type: 'loot'  },
    ],
    min_room_tier: 1,
  },

  // ── bunker-cell-cross ─────────────────────────────────────────────────────
  // 8×8 four-way grid cell: S + N + E + W. Primary interior room for the grid layout.
  {
    id: 'bunker-cell-cross',
    zone_act: 2,
    region_types: ['bunker-grid'],
    type: 'standard',
    size: { w: 8, h: 8 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 4, ty: 7 },
      { id: 'north-0', edge: 'N', tx: 4, ty: 0 },
      { id: 'east-0',  edge: 'E', tx: 7, ty: 4 },
      { id: 'west-0',  edge: 'W', tx: 0, ty: 4 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 8; ty++)
        for (let tx = 0; tx < 8; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall — gap at tx 3-5 for N corridor
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // gap at tx 3-5
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // East wall — gap at ty 3-5 for E corridor
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 1, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 2, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 6, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 7, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // West wall — gap at ty 3-5 for W corridor
      { tx: 0, ty: 1, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 2, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 6, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 7, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Central column
      { tx: 3, ty: 3, frame: 35, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 3, frame: 36, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 4, frame: 28, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 4, frame: 29, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 1, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 6, ty: 2, type: 'enemy' },
      { id: 'm0', tx: 6, ty: 6, type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-cell-dead-end ──────────────────────────────────────────────────
  // 8×8 grid dead-end. S connection only. Loot/mineral terminal at the back.
  {
    id: 'bunker-cell-dead-end',
    zone_act: 2,
    region_types: ['bunker-grid'],
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
      // South wall — solid (no S slot; ring arrives from E and W)
      { tx: 0, ty: 7, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 7, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 7, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 7, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 7, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty: 7, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 7, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 7, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // North wall — full
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 3, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 5, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Central objective marker
      { tx: 3, ty: 3, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 4, ty: 3, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 3, ty: 4, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
      { tx: 4, ty: 4, frame: 28, tint: TINT_BUNKER_DETAIL, depth: 5, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 1, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 6, ty: 2, type: 'enemy' },
      { id: 'l0', tx: 2, ty: 2, type: 'loot'  },
      { id: 'l1', tx: 5, ty: 5, type: 'loot'  },
    ],
    min_room_tier: 0,
  },

  // ── bunker-ring-side-a ────────────────────────────────────────────────────
  // 8×8 ring side room: S + N only. Guarded corridor between ring base and apex.
  {
    id: 'bunker-ring-side-a',
    zone_act: 2,
    region_types: ['bunker-ring', 'bunker-convergence'],
    type: 'standard',
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
      // North wall — gap at tx 3-5
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Solid east and west walls
      { tx: 0, ty: 1, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 2, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 3, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 4, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 5, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 6, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 1, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 2, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 3, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 4, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 6, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Central obstacle
      { tx: 3, ty: 3, frame: 35, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 4, ty: 3, frame: 36, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 5, type: 'enemy' },
      { id: 'e1', tx: 5, ty: 2, type: 'enemy' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-ring-side-b ────────────────────────────────────────────────────
  // 8×12 ring side room: S + N. Wider ring side variant with a patrol alcove.
  {
    id: 'bunker-ring-side-b',
    zone_act: 2,
    region_types: ['bunker-ring', 'bunker-convergence'],
    type: 'standard',
    size: { w: 8, h: 12 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 4, ty: 11 },
      { id: 'north-0', edge: 'N', tx: 4, ty: 0  },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 12; ty++)
        for (let tx = 0; tx < 8; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall — gap at tx 3-5
      { tx: 0, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 1, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 2, ty: 0, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 6, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 0, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Solid east and west walls
      { tx: 0, ty: 1,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 2,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 3,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 4,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 5,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 6,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 7,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 8,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 9,  frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 0, ty: 10, frame: 21, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 1,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 2,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 3,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 4,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 5,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 6,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 7,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 8,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 9,  frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      { tx: 7, ty: 10, frame: 22, tint: TINT_BUNKER_WALL, depth: 4, blocked: true },
      // Patrol alcove obstacle mid-room
      { tx: 2, ty: 5, frame: 35, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 3, ty: 5, frame: 36, tint: TINT_BUNKER_WALL,   depth: 4, blocked: true },
      { tx: 4, ty: 7, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
      { tx: 5, ty: 7, frame: 7,  tint: TINT_BUNKER_DETAIL, depth: 5 },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 2, ty: 3,  type: 'enemy' },
      { id: 'e1', tx: 5, ty: 8,  type: 'enemy' },
      { id: 'l0', tx: 3, ty: 9,  type: 'loot'  },
      { id: 'm0', tx: 1, ty: 2,  type: 'mineral' },
    ],
    min_room_tier: 0,
  },

  // ── bunker-convergence-boss ───────────────────────────────────────────────
  // 20×16 final boss arena. Single south connection — all three feed corridors
  // converge here. Crimson palette. Six enemy markers, three loot drops.
  {
    id: 'bunker-convergence-boss',
    zone_act: 2,
    region_types: ['bunker-convergence'],
    type: 'boss',
    size: { w: 20, h: 16 },
    connections: [
      { id: 'south-0', edge: 'S', tx: 10, ty: 15 },
    ],
    tiles: ((): Array<{ tx: number; ty: number; frame: number }> => {
      const t: Array<{ tx: number; ty: number; frame: number }> = [];
      for (let ty = 0; ty < 16; ty++)
        for (let tx = 0; tx < 20; tx++)
          t.push({ tx, ty, frame: 0 });
      return t;
    })(),
    structures: [
      // North wall — solid crimson
      { tx: 0,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 1,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 2,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 3,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 5,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 6,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 7,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 8,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 9,  ty: 0, frame: 21, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 10, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 11, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 12, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 13, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 14, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 17, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 18, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 19, ty: 0, frame: 22, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      // Four corner pillars
      { tx: 3,  ty: 3,  frame: 35, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 3,  frame: 36, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 3,  ty: 4,  frame: 28, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 4,  frame: 29, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 3,  frame: 35, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 3,  frame: 36, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 4,  frame: 28, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 4,  frame: 29, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 3,  ty: 11, frame: 35, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 11, frame: 36, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 3,  ty: 12, frame: 28, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 4,  ty: 12, frame: 29, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 11, frame: 35, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 11, frame: 36, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 15, ty: 12, frame: 28, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      { tx: 16, ty: 12, frame: 29, tint: TINT_BOSS_WALL, depth: 4, blocked: true },
      // Central objective
      { tx: 9,  ty: 7, frame: 7,  tint: TINT_BOSS_DETAIL, depth: 5 },
      { tx: 10, ty: 7, frame: 7,  tint: TINT_BOSS_DETAIL, depth: 5 },
      { tx: 9,  ty: 8, frame: 28, tint: TINT_BOSS_DETAIL, depth: 5, blocked: true },
      { tx: 10, ty: 8, frame: 28, tint: TINT_BOSS_DETAIL, depth: 5, blocked: true },
    ],
    variants: [],
    spawn_markers: [
      { id: 'e0', tx: 7,  ty: 6,  type: 'enemy' },
      { id: 'e1', tx: 12, ty: 6,  type: 'enemy' },
      { id: 'e2', tx: 2,  ty: 10, type: 'enemy' },
      { id: 'e3', tx: 17, ty: 10, type: 'enemy' },
      { id: 'e4', tx: 7,  ty: 13, type: 'enemy' },
      { id: 'e5', tx: 12, ty: 13, type: 'enemy' },
      { id: 'l0', tx: 1,  ty: 2,  type: 'loot'  },
      { id: 'l1', tx: 18, ty: 2,  type: 'loot'  },
      { id: 'l2', tx: 9,  ty: 12, type: 'loot'  },
    ],
    min_room_tier: 1,
  },

];  // end ROOMS_A2Z31

// ── Region definitions ────────────────────────────────────────────────────────

export const REGIONS_A2Z31: RegionDef[] = [
  {
    id:             'bunker-corridor',
    label:          'Bunker Corridor',
    zone_acts:      [2],
    layout:         'spine',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   4,
    corridor_max:   10,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-depot',
    label:          'Bunker Depot',
    zone_acts:      [2],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 7,
    corridor_min:   3,
    corridor_max:   8,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-command',
    label:          'Bunker Command',
    zone_acts:      [2],
    layout:         'spine',
    room_count_min: 4,
    room_count_max: 6,
    corridor_min:   5,
    corridor_max:   12,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-branch',
    label:          'Bunker Branch Wing',
    zone_acts:      [2],
    layout:         'branching',
    room_count_min: 5,
    room_count_max: 8,
    corridor_min:   3,
    corridor_max:   8,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-grid',
    label:          'Bunker Grid Block',
    zone_acts:      [2],
    layout:         'grid',
    room_count_min: 4,
    room_count_max: 8,
    corridor_min:   3,
    corridor_max:   6,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-ring',
    label:          'Bunker Ring Sector',
    zone_acts:      [2],
    layout:         'ring',
    room_count_min: 4,
    room_count_max: 5,
    corridor_min:   3,
    corridor_max:   7,
    tint:           TINT_BUNKER_FLOOR,
  },
  {
    id:             'bunker-convergence',
    label:          'Bunker Convergence Point',
    zone_acts:      [2],
    layout:         'convergence',
    room_count_min: 3,
    room_count_max: 4,
    corridor_min:   4,
    corridor_max:   8,
    tint:           TINT_BUNKER_FLOOR,
  },
];

// ── ZoneDef ───────────────────────────────────────────────────────────────────

const [
  regionCorridor,
  regionDepot,
  regionCommand,
  regionBranch,
  regionGrid,
  regionRing,
  regionConvergence,
] = REGIONS_A2Z31;

export const ZONE_A2Z31: ZoneDef = {
  id:           'bunker-complex',
  label:        'Bunker Complex',
  zone_act:     2,
  region_defs:  [
    regionCorridor,
    regionDepot,
    regionBranch,
    regionGrid,
    regionRing,
    regionCommand,
    regionConvergence,
  ],
  enemy_flavour: 'sentinels',
  tint:          TINT_BUNKER_FLOOR,
};
