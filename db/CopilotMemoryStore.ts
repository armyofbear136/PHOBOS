import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export interface CopilotMemory {
  id: string;
  persona: string;
  category: string;
  key_name: string;
  value: string;
  created_at: string;
}

/**
 * Persistent memory store for the Copilot personas.
 * Mirrors the PersonaSystem memory pattern from Primal Online:
 * each persona accumulates memories about the user across sessions.
 *
 * Categories:
 *   user_preferences — coding style, tone, stack, conventions
 *   project_context  — what the user is working on, goals, blockers
 *   personal_notes   — name, timezone, anything personal they share
 *   reminders        — things to follow up on or flag later
 */
export class CopilotMemoryStore {
  constructor(private db: DatabaseManager) {}

  /** Called once at DB init — creates the table if missing. */
  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS copilot_memories (
        id         VARCHAR PRIMARY KEY,
        persona    VARCHAR NOT NULL,
        category   VARCHAR NOT NULL,
        key_name   VARCHAR NOT NULL,
        value      TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_copilot_memories_persona
        ON copilot_memories(persona, category)
    `);
    await this._migrateDropPersonaCheck();
  }

  /**
   * DuckDB enforces CHECK constraints on insert.  The original schema had
   * CHECK (persona IN ('sayon','seren')) which rejects clone persona strings.
   * This migration drops and recreates the table without the constraint,
   * preserving all existing rows.
   */
  private async _migrateDropPersonaCheck(): Promise<void> {
    try {
      // Probe: attempt an insert with a clone-style persona value.
      // If it succeeds the constraint is already gone and we roll back cleanly.
      // If it throws we do the full drop/recreate migration.
      await this.db.run(
        `INSERT INTO copilot_memories (id, persona, category, key_name, value)
           VALUES ('__probe__', 'copilot-clone-probe', '__probe__', '__probe__', '__probe__')`,
      );
      await this.db.run(`DELETE FROM copilot_memories WHERE id = '__probe__'`);
    } catch {
      // Constraint still present — migrate.
      await this.db.exec(`
        ALTER TABLE copilot_memories RENAME TO copilot_memories_old;
        CREATE TABLE copilot_memories (
          id         VARCHAR PRIMARY KEY,
          persona    VARCHAR NOT NULL,
          category   VARCHAR NOT NULL,
          key_name   VARCHAR NOT NULL,
          value      TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT now()
        );
        INSERT INTO copilot_memories SELECT * FROM copilot_memories_old;
        DROP TABLE copilot_memories_old;
        CREATE INDEX IF NOT EXISTS idx_copilot_memories_persona
          ON copilot_memories(persona, category);
      `);
    }
  }

  /** Store a memory. Upserts on (persona, category, key_name). */
  async store(
    persona: string,
    category: string,
    key: string,
    value: string
  ): Promise<CopilotMemory> {
    // Check for existing entry with same persona + category + key
    const existing = await this.db.queryOne<CopilotMemory>(
      `SELECT * FROM copilot_memories WHERE persona = ? AND category = ? AND key_name = ?`,
      [persona, category, key]
    );

    if (existing) {
      await this.db.run(
        `UPDATE copilot_memories SET value = ?, created_at = now() WHERE id = ?`,
        [value, existing.id]
      );
      return { ...existing, value, created_at: new Date().toISOString() };
    }

    const id = randomUUID();
    await this.db.run(
      `INSERT INTO copilot_memories (id, persona, category, key_name, value)
       VALUES (?, ?, ?, ?, ?)`,
      [id, persona, category, key, value]
    );
    return (await this.db.queryOne<CopilotMemory>(
      `SELECT * FROM copilot_memories WHERE id = ?`, [id]
    ))!;
  }

  /** Recall all memories for a persona, optionally filtered by category. */
  async recall(
    persona: string,
    category?: string
  ): Promise<CopilotMemory[]> {
    if (category) {
      return this.db.query<CopilotMemory>(
        `SELECT * FROM copilot_memories WHERE persona = ? AND category = ? ORDER BY created_at DESC`,
        [persona, category]
      );
    }
    return this.db.query<CopilotMemory>(
      `SELECT * FROM copilot_memories WHERE persona = ? ORDER BY category, created_at DESC`,
      [persona]
    );
  }

  /** Recall all memories (both personas) for injection into system prompts. */
  async recallAll(): Promise<CopilotMemory[]> {
    return this.db.query<CopilotMemory>(
      `SELECT * FROM copilot_memories ORDER BY persona, category, created_at DESC`
    );
  }

  /** Delete a specific memory by id. */
  async forget(id: string): Promise<void> {
    await this.db.run(`DELETE FROM copilot_memories WHERE id = ?`, [id]);
  }

  /** Render memories as a context block for injection into system prompts. */
  async renderMemoryContext(persona: string): Promise<string> {
    const memories = await this.recall(persona);
    if (memories.length === 0) return '';

    const byCategory = new Map<string, CopilotMemory[]>();
    for (const m of memories) {
      if (!byCategory.has(m.category)) byCategory.set(m.category, []);
      byCategory.get(m.category)!.push(m);
    }

    const lines = ['<user_memory>'];
    for (const [cat, entries] of byCategory) {
      lines.push(`  [${cat}]`);
      for (const e of entries) {
        lines.push(`    ${e.key_name}: ${e.value}`);
      }
    }
    lines.push('</user_memory>');
    return lines.join('\n');
  }
}