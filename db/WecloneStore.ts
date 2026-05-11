/**
 * WecloneStore — per-user DuckDB store for Digital Clone profiles.
 *
 * Lives in the user DB (getUserDb()), never the system DB.
 * One profile per user maximum — upsert pattern via fixed id 'primary'.
 */

import { DatabaseManager } from './DatabaseManager.js';

export interface WecloneProfileRow {
  id:                  string;
  cartridge_id:        string | null;
  slot:                'sayon' | 'seren';
  display_name:        string;
  pronouns:            string;
  communication_style: string;
  love_topics:         string;   // JSON array
  avoid_topics:        string;   // JSON array
  humor_style:         string;
  response_length:     number;
  formality:           number;
  first_person:        boolean;
  context_summary:     string;
  limits_summary:      string;
  temperature:         number;
  top_p:               number;
  context_window:      number;
  system_prompt:       string;
  published:           boolean;
  created_at:          string;
  updated_at:          string;
}

export interface WecloneProfileInput {
  cartridgeId?:        string;
  slot?:               'sayon' | 'seren';
  displayName?:        string;
  pronouns?:           string;
  communicationStyle?: string;
  loveTopics?:         string;
  avoidTopics?:        string;
  humorStyle?:         string;
  responseLength?:     number;
  formality?:          number;
  firstPerson?:        boolean;
  contextSummary?:     string;
  limitsSummary?:      string;
  temperature?:        number;
  topP?:               number;
  contextWindow?:      number;
  systemPrompt?:       string;
  published?:          boolean;
}

const PRIMARY_ID = 'primary';

export class WecloneStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS weclone_profiles (
        id                  VARCHAR PRIMARY KEY,
        cartridge_id        VARCHAR,
        slot                VARCHAR NOT NULL DEFAULT 'seren',
        display_name        VARCHAR NOT NULL DEFAULT '',
        pronouns            VARCHAR NOT NULL DEFAULT '',
        communication_style TEXT    NOT NULL DEFAULT '',
        love_topics         TEXT    NOT NULL DEFAULT '[]',
        avoid_topics        TEXT    NOT NULL DEFAULT '[]',
        humor_style         VARCHAR NOT NULL DEFAULT 'None',
        response_length     DOUBLE  NOT NULL DEFAULT 0.5,
        formality           DOUBLE  NOT NULL DEFAULT 0.4,
        first_person        BOOLEAN NOT NULL DEFAULT true,
        context_summary     TEXT    NOT NULL DEFAULT '',
        limits_summary      TEXT    NOT NULL DEFAULT '',
        temperature         DOUBLE  NOT NULL DEFAULT 0.7,
        top_p               DOUBLE  NOT NULL DEFAULT 0.9,
        context_window      INTEGER NOT NULL DEFAULT 4096,
        system_prompt       TEXT    NOT NULL DEFAULT '',
        published           BOOLEAN NOT NULL DEFAULT false,
        created_at          TIMESTAMP NOT NULL DEFAULT now(),
        updated_at          TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async getProfile(): Promise<WecloneProfileRow | null> {
    return this.db.queryOne<WecloneProfileRow>(
      `SELECT * FROM weclone_profiles WHERE id = ?`,
      [PRIMARY_ID],
    );
  }

  async upsertProfile(input: WecloneProfileInput): Promise<WecloneProfileRow> {
    const existing = await this.getProfile();
    const now      = new Date().toISOString();

    if (existing) {
      await this.db.run(`
        UPDATE weclone_profiles SET
          cartridge_id        = COALESCE(?, cartridge_id),
          slot                = COALESCE(?, slot),
          display_name        = COALESCE(?, display_name),
          pronouns            = COALESCE(?, pronouns),
          communication_style = COALESCE(?, communication_style),
          love_topics         = COALESCE(?, love_topics),
          avoid_topics        = COALESCE(?, avoid_topics),
          humor_style         = COALESCE(?, humor_style),
          response_length     = COALESCE(?, response_length),
          formality           = COALESCE(?, formality),
          first_person        = COALESCE(?, first_person),
          context_summary     = COALESCE(?, context_summary),
          limits_summary      = COALESCE(?, limits_summary),
          temperature         = COALESCE(?, temperature),
          top_p               = COALESCE(?, top_p),
          context_window      = COALESCE(?, context_window),
          system_prompt       = COALESCE(?, system_prompt),
          published           = COALESCE(?, published),
          updated_at          = ?
        WHERE id = ?
      `, [
        input.cartridgeId        ?? null,
        input.slot               ?? null,
        input.displayName        ?? null,
        input.pronouns           ?? null,
        input.communicationStyle ?? null,
        input.loveTopics         ?? null,
        input.avoidTopics        ?? null,
        input.humorStyle         ?? null,
        input.responseLength     ?? null,
        input.formality          ?? null,
        input.firstPerson        ?? null,
        input.contextSummary     ?? null,
        input.limitsSummary      ?? null,
        input.temperature        ?? null,
        input.topP               ?? null,
        input.contextWindow      ?? null,
        input.systemPrompt       ?? null,
        input.published          ?? null,
        now,
        PRIMARY_ID,
      ]);
    } else {
      await this.db.run(`
        INSERT INTO weclone_profiles (
          id, cartridge_id, slot, display_name, pronouns, communication_style,
          love_topics, avoid_topics, humor_style, response_length, formality,
          first_person, context_summary, limits_summary, temperature, top_p,
          context_window, system_prompt, published, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        PRIMARY_ID,
        input.cartridgeId        ?? null,
        input.slot               ?? 'seren',
        input.displayName        ?? '',
        input.pronouns           ?? '',
        input.communicationStyle ?? '',
        input.loveTopics         ?? '[]',
        input.avoidTopics        ?? '[]',
        input.humorStyle         ?? 'None',
        input.responseLength     ?? 0.5,
        input.formality          ?? 0.4,
        input.firstPerson        ?? true,
        input.contextSummary     ?? '',
        input.limitsSummary      ?? '',
        input.temperature        ?? 0.7,
        input.topP               ?? 0.9,
        input.contextWindow      ?? 4096,
        input.systemPrompt       ?? '',
        input.published          ?? false,
        now,
        now,
      ]);
    }

    return (await this.getProfile())!;
  }

  async deleteProfile(): Promise<void> {
    await this.db.run(`DELETE FROM weclone_profiles WHERE id = ?`, [PRIMARY_ID]);
  }
}
