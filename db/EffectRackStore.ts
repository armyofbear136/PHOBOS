import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EffectContext = 'daw' | 'polaris' | 'game' | 'custom';

export interface EffectParamMap {
  [pluginKey: string]: {       // 'helm' | 'surge' | 'crystal'
    [paramId: string]: number; // plugin parameter id → value (legacy schema; see EffectRack note in routes/audio.ts)
  };
}

export interface CarlaRouting {
  /** Which synth plugins feed the Crystal FX send. Default: all. */
  sendsToCrystal: string[];    // e.g. ['helm', 'surge']
  /** Master wet mix for the Crystal send. 0 = dry, 1 = full wet. */
  crystalSend:    number;
}

export interface EffectPreset {
  id:         string;
  label:      string;
  context:    EffectContext;
  params:     EffectParamMap;
  routing:    CarlaRouting;
  created_at: string;
  updated_at: string;
}

// ── Default seeds ─────────────────────────────────────────────────────────────
// Three factory presets seeded on first ensureTable(). Minimal values — the
// expectation is that a user (or AI) adjusts from these starting points.

const DEFAULT_PRESETS: Array<Omit<EffectPreset, 'created_at' | 'updated_at'>> = [
  {
    id:      'daw-dry',
    label:   'DAW — Dry',
    context: 'daw',
    params: {
      crystal: { '14': 0.0 },             // mix = 0 (Crystal bypassed)
    },
    routing: { sendsToCrystal: [], crystalSend: 0.0 },
  },
  {
    id:      'polaris-mastered',
    label:   'Polaris — Mastered',
    context: 'polaris',
    params: {
      crystal: { '14': 0.15 },            // gentle shimmer
    },
    routing: { sendsToCrystal: ['helm', 'surge'], crystalSend: 0.15 },
  },
  {
    id:      'game-combat',
    label:   'Game — Combat',
    context: 'game',
    params: {
      crystal: { '14': 0.35 },            // more present in combat
    },
    routing: { sendsToCrystal: ['helm', 'surge'], crystalSend: 0.35 },
  },
];

// ── Raw row shape ────────────────────────────────────────────────────────────

interface RawRow {
  id:           string;
  label:        string;
  context:      string;
  params_json:  string;
  routing_json: string;
  created_at:   Date | string;
  updated_at:   Date | string;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class EffectRackStore {
  private db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS audio_effect_presets (
        id           VARCHAR PRIMARY KEY,
        label        VARCHAR NOT NULL,
        context      VARCHAR NOT NULL,
        params_json  JSON    NOT NULL,
        routing_json JSON    NOT NULL,
        created_at   TIMESTAMP NOT NULL DEFAULT now(),
        updated_at   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Seed factory presets idempotently.
    for (const p of DEFAULT_PRESETS) {
      await this.db.run(
        `INSERT INTO audio_effect_presets (id, label, context, params_json, routing_json)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM audio_effect_presets WHERE id = ?)`,
        [p.id, p.label, p.context, JSON.stringify(p.params), JSON.stringify(p.routing), p.id],
      );
    }
  }

  async get(id: string): Promise<EffectPreset | null> {
    const rows = await this.db.query<RawRow>(
      `SELECT id, label, context, params_json, routing_json, created_at, updated_at
         FROM audio_effect_presets WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToPreset(rows[0]);
  }

  async list(context?: EffectContext): Promise<EffectPreset[]> {
    const rows = context
      ? await this.db.query<RawRow>(
          `SELECT id, label, context, params_json, routing_json, created_at, updated_at
             FROM audio_effect_presets WHERE context = ? ORDER BY label`,
          [context],
        )
      : await this.db.query<RawRow>(
          `SELECT id, label, context, params_json, routing_json, created_at, updated_at
             FROM audio_effect_presets ORDER BY context, label`,
          [],
        );
    return rows.map(rowToPreset);
  }

  async upsert(preset: Omit<EffectPreset, 'created_at' | 'updated_at'>): Promise<EffectPreset> {
    await this.db.run(`DELETE FROM audio_effect_presets WHERE id = ?`, [preset.id]);
    await this.db.run(
      `INSERT INTO audio_effect_presets (id, label, context, params_json, routing_json)
       VALUES (?, ?, ?, ?, ?)`,
      [preset.id, preset.label, preset.context,
       JSON.stringify(preset.params),
       JSON.stringify(preset.routing)],
    );
    const loaded = await this.get(preset.id);
    if (!loaded) throw new Error(`Upsert succeeded but reload failed for preset ${preset.id}`);
    return loaded;
  }

  async delete(id: string): Promise<boolean> {
    // Factory presets are not deletable — their presence is a wire contract
    // relied on by Polaris, the DAW, and game-state defaults.
    if (DEFAULT_PRESETS.some(p => p.id === id)) return false;
    await this.db.run(`DELETE FROM audio_effect_presets WHERE id = ?`, [id]);
    return true;
  }

  /**
   * Diff two presets and return (pluginKey, paramId, newValue) tuples for
   * every param that changed. Legacy from the Carla per-param OSC path; left
   * intact pending the EffectRackStore redesign for PhobosHost (Session 5+).
   */
  static diff(from: EffectPreset | null, to: EffectPreset): Array<{
    pluginKey: string;
    paramId:   string;
    value:     number;
  }> {
    const changes: Array<{ pluginKey: string; paramId: string; value: number }> = [];

    for (const pluginKey in to.params) {
      const toP   = to.params[pluginKey];
      const fromP = from?.params?.[pluginKey];
      for (const paramId in toP) {
        const newVal = toP[paramId];
        const oldVal = fromP ? fromP[paramId] : undefined;
        if (oldVal === undefined || oldVal !== newVal) {
          changes.push({ pluginKey, paramId, value: newVal });
        }
      }
    }
    return changes;
  }
}

// ── Row decoder ───────────────────────────────────────────────────────────────

function rowToPreset(r: RawRow): EffectPreset {
  return {
    id:         r.id,
    label:      r.label,
    context:    r.context as EffectContext,
    params:     JSON.parse(r.params_json) as EffectParamMap,
    routing:    JSON.parse(r.routing_json) as CarlaRouting,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}