import { DatabaseManager } from './DatabaseManager.js';

export interface CopilotRelationshipState {
  persona: 'sayon' | 'seren';
  bond_score: number;
  emotional_state: string;
  message_count: number;
  session_count: number;
  first_interaction_at: string | null;
  last_interaction_at: string | null;
}

/**
 * Tracks per-persona relationship state across sessions.
 *
 * Mirrors the AIEngine.gd relationship_level / emotional_state pattern from Primal Online.
 * Bond score grows incrementally per message exchange. Emotional state is set by the model
 * via [EMOTION <state>] inline tags in its output (same pattern as [REMEMBER]).
 *
 * One row per persona — upserted on first message, mutated from there.
 */
export class CopilotRelationshipStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS copilot_relationship (
        persona               VARCHAR PRIMARY KEY CHECK (persona IN ('sayon', 'seren')),
        bond_score            DOUBLE  NOT NULL DEFAULT 0.0,
        emotional_state       VARCHAR NOT NULL DEFAULT 'calm',
        message_count         INTEGER NOT NULL DEFAULT 0,
        session_count         INTEGER NOT NULL DEFAULT 0,
        first_interaction_at  TIMESTAMP,
        last_interaction_at   TIMESTAMP
      )
    `);
  }

  async getState(persona: 'sayon' | 'seren'): Promise<CopilotRelationshipState> {
    const row = await this.db.queryOne<CopilotRelationshipState>(
      `SELECT * FROM copilot_relationship WHERE persona = ?`,
      [persona]
    );
    return row ?? {
      persona,
      bond_score: 0,
      emotional_state: 'calm',
      message_count: 0,
      session_count: 0,
      first_interaction_at: null,
      last_interaction_at: null,
    };
  }

  /**
   * Called after each completed assistant response.
   * Bond delta: +0.004 per exchange — reaching ~0.4 after 100 exchanges (Mutual Respect).
   * Capped at 1.0. Mirrors AIEngine.gd _apply_relationship_delta().
   */
  async recordExchange(persona: 'sayon' | 'seren', bondDelta = 0.004): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.queryOne<CopilotRelationshipState>(
      `SELECT * FROM copilot_relationship WHERE persona = ?`,
      [persona]
    );

    if (!existing) {
      await this.db.run(
        `INSERT INTO copilot_relationship
          (persona, bond_score, emotional_state, message_count, session_count, first_interaction_at, last_interaction_at)
         VALUES (?, ?, 'calm', 1, 1, ?, ?)`,
        [persona, Math.min(bondDelta, 1.0), now, now]
      );
      return;
    }

    const newBond = Math.min(existing.bond_score + bondDelta, 1.0);
    await this.db.run(
      `UPDATE copilot_relationship
       SET bond_score = ?, message_count = message_count + 1, last_interaction_at = ?
       WHERE persona = ?`,
      [newBond, now, persona]
    );
  }

  async setEmotionalState(persona: 'sayon' | 'seren', emotion: string): Promise<void> {
    await this.db.run(
      `UPDATE copilot_relationship SET emotional_state = ? WHERE persona = ?`,
      [emotion.toLowerCase().trim(), persona]
    );
  }

  /** Called once per server start per persona to increment session counter. */
  async recordSession(persona: 'sayon' | 'seren'): Promise<void> {
    const existing = await this.db.queryOne<{ persona: string }>(
      `SELECT persona FROM copilot_relationship WHERE persona = ?`,
      [persona]
    );
    if (!existing) return; // No interaction yet — don't create a ghost row
    await this.db.run(
      `UPDATE copilot_relationship SET session_count = session_count + 1 WHERE persona = ?`,
      [persona]
    );
  }

  /** Days since first interaction, or 0 if no history. */
  async getDaysKnown(persona: 'sayon' | 'seren'): Promise<number> {
    const state = await this.getState(persona);
    if (!state.first_interaction_at) return 0;
    const first = new Date(state.first_interaction_at).getTime();
    const now = Date.now();
    return Math.floor((now - first) / (1000 * 60 * 60 * 24));
  }
}
