/**
 * WecloneStore — per-user DuckDB store for Digital Clone profiles.
 *
 * Supports multiple clones per user. Each clone has:
 *   - Full identity fields (# YOU ARE context)
 *   - Personality/inference tuning (existing fields)
 *   - A linked cartridge (LM training result)
 *   - A linked voice profile (voice training result)
 */

import { randomUUID } from 'crypto';
import { DatabaseManager } from './DatabaseManager.js';

export interface WecloneProfileRow {
  id:                  string;
  cartridge_id:        string | null;
  voice_profile_id:    string | null;
  slot:                'sayon' | 'seren';
  // ── Identity (# YOU ARE) ──────────────────────────────────────────────────
  display_name:        string;
  pronouns:            string;
  age:                 string;
  gender:              string;
  appearance:          string;
  personality_desc:    string;   // free-text self-description (distinct from communication_style)
  background:          string;
  interests:           string;
  dislikes:            string;
  hobbies:             string;
  goals:               string;
  fears:               string;
  values:              string;
  expertise:           string;
  relationship_style:  string;
  love_language:       string;
  dealbreakers:        string;
  // ── Personality / voice tuning ────────────────────────────────────────────
  communication_style: string;
  love_topics:         string;   // JSON array
  avoid_topics:        string;   // JSON array
  humor_style:         string;
  response_length:     number;
  formality:           number;
  first_person:        boolean;
  context_summary:     string;
  limits_summary:      string;
  // ── Inference tuning ──────────────────────────────────────────────────────
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
  voiceProfileId?:     string | null;
  slot?:               'sayon' | 'seren';
  // Identity
  displayName?:        string;
  pronouns?:           string;
  age?:                string;
  gender?:             string;
  appearance?:         string;
  personalityDesc?:    string;
  background?:         string;
  interests?:          string;
  dislikes?:           string;
  hobbies?:            string;
  goals?:              string;
  fears?:              string;
  values?:             string;
  expertise?:          string;
  relationshipStyle?:  string;
  loveLanguage?:       string;
  dealbreakers?:       string;
  // Personality
  communicationStyle?: string;
  loveTopics?:         string;
  avoidTopics?:        string;
  humorStyle?:         string;
  responseLength?:     number;
  formality?:          number;
  firstPerson?:        boolean;
  contextSummary?:     string;
  limitsSummary?:      string;
  // Inference
  temperature?:        number;
  topP?:               number;
  contextWindow?:      number;
  systemPrompt?:       string;
  published?:          boolean;
}

export class WecloneStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.ensureReady();
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS weclone_profiles (
        id                  VARCHAR PRIMARY KEY,
        cartridge_id        VARCHAR,
        voice_profile_id    VARCHAR,
        slot                VARCHAR NOT NULL DEFAULT 'seren',
        -- Identity
        display_name        VARCHAR NOT NULL DEFAULT '',
        pronouns            VARCHAR NOT NULL DEFAULT '',
        age                 VARCHAR NOT NULL DEFAULT '',
        gender              VARCHAR NOT NULL DEFAULT '',
        appearance          TEXT    NOT NULL DEFAULT '',
        personality_desc    TEXT    NOT NULL DEFAULT '',
        background          TEXT    NOT NULL DEFAULT '',
        interests           TEXT    NOT NULL DEFAULT '',
        dislikes            TEXT    NOT NULL DEFAULT '',
        hobbies             TEXT    NOT NULL DEFAULT '',
        goals               TEXT    NOT NULL DEFAULT '',
        fears               TEXT    NOT NULL DEFAULT '',
        values              TEXT    NOT NULL DEFAULT '',
        expertise           TEXT    NOT NULL DEFAULT '',
        relationship_style  TEXT    NOT NULL DEFAULT '',
        love_language       VARCHAR NOT NULL DEFAULT '',
        dealbreakers        TEXT    NOT NULL DEFAULT '',
        -- Personality / voice
        communication_style TEXT    NOT NULL DEFAULT '',
        love_topics         TEXT    NOT NULL DEFAULT '[]',
        avoid_topics        TEXT    NOT NULL DEFAULT '[]',
        humor_style         VARCHAR NOT NULL DEFAULT 'None',
        response_length     DOUBLE  NOT NULL DEFAULT 0.5,
        formality           DOUBLE  NOT NULL DEFAULT 0.4,
        first_person        BOOLEAN NOT NULL DEFAULT true,
        context_summary     TEXT    NOT NULL DEFAULT '',
        limits_summary      TEXT    NOT NULL DEFAULT '',
        -- Inference
        temperature         DOUBLE  NOT NULL DEFAULT 0.7,
        top_p               DOUBLE  NOT NULL DEFAULT 0.9,
        context_window      INTEGER NOT NULL DEFAULT 4096,
        system_prompt       TEXT    NOT NULL DEFAULT '',
        published           BOOLEAN NOT NULL DEFAULT false,
        created_at          TIMESTAMP NOT NULL DEFAULT now(),
        updated_at          TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Migrations for databases created before multi-clone + identity fields.
    // Rename old 'primary' id to a real UUID so list queries work uniformly.
    const migrations: string[] = [
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS voice_profile_id VARCHAR`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS age              VARCHAR NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS gender           VARCHAR NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS appearance       TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS personality_desc TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS background       TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS interests        TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS dislikes         TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS hobbies          TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS goals            TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS fears            TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS values           TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS expertise        TEXT    NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS relationship_style TEXT  NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS love_language    VARCHAR NOT NULL DEFAULT ''`,
      `ALTER TABLE weclone_profiles ADD COLUMN IF NOT EXISTS dealbreakers     TEXT    NOT NULL DEFAULT ''`,
    ];
    for (const sql of migrations) {
      try { await this.db.run(sql); } catch { /* column already exists */ }
    }

    // Migrate legacy 'primary' id to a real UUID.
    try {
      const legacy = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM weclone_profiles WHERE id = 'primary' LIMIT 1`, [],
      );
      if (legacy) {
        await this.db.run(
          `UPDATE weclone_profiles SET id = ? WHERE id = 'primary'`,
          [randomUUID()],
        );
      }
    } catch { /* non-fatal */ }
  }

  async listProfiles(): Promise<WecloneProfileRow[]> {
    return this.db.query<WecloneProfileRow>(
      `SELECT * FROM weclone_profiles ORDER BY created_at ASC`,
      [],
    );
  }

  async getProfile(id: string): Promise<WecloneProfileRow | null> {
    return this.db.queryOne<WecloneProfileRow>(
      `SELECT * FROM weclone_profiles WHERE id = ?`,
      [id],
    );
  }

  async createProfile(input: WecloneProfileInput): Promise<WecloneProfileRow> {
    const id  = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(`
      INSERT INTO weclone_profiles (
        id, cartridge_id, voice_profile_id, slot,
        display_name, pronouns, age, gender,
        appearance, personality_desc, background,
        interests, dislikes, hobbies,
        goals, fears, values, expertise,
        relationship_style, love_language, dealbreakers,
        communication_style, love_topics, avoid_topics,
        humor_style, response_length, formality, first_person,
        context_summary, limits_summary,
        temperature, top_p, context_window,
        system_prompt, published, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `, [
      id,
      input.cartridgeId        ?? null,
      input.voiceProfileId     ?? null,
      input.slot               ?? 'seren',
      input.displayName        ?? '',
      input.pronouns           ?? '',
      input.age                ?? '',
      input.gender             ?? '',
      input.appearance         ?? '',
      input.personalityDesc    ?? '',
      input.background         ?? '',
      input.interests          ?? '',
      input.dislikes           ?? '',
      input.hobbies            ?? '',
      input.goals              ?? '',
      input.fears              ?? '',
      input.values             ?? '',
      input.expertise          ?? '',
      input.relationshipStyle  ?? '',
      input.loveLanguage       ?? '',
      input.dealbreakers       ?? '',
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
    return (await this.getProfile(id))!;
  }

  async updateProfile(id: string, input: WecloneProfileInput): Promise<WecloneProfileRow> {
    const now = new Date().toISOString();
    await this.db.run(`
      UPDATE weclone_profiles SET
        cartridge_id        = COALESCE(?, cartridge_id),
        voice_profile_id    = CASE WHEN ? IS NULL THEN voice_profile_id ELSE ? END,
        slot                = COALESCE(?, slot),
        display_name        = COALESCE(?, display_name),
        pronouns            = COALESCE(?, pronouns),
        age                 = COALESCE(?, age),
        gender              = COALESCE(?, gender),
        appearance          = COALESCE(?, appearance),
        personality_desc    = COALESCE(?, personality_desc),
        background          = COALESCE(?, background),
        interests           = COALESCE(?, interests),
        dislikes            = COALESCE(?, dislikes),
        hobbies             = COALESCE(?, hobbies),
        goals               = COALESCE(?, goals),
        fears               = COALESCE(?, fears),
        values              = COALESCE(?, values),
        expertise           = COALESCE(?, expertise),
        relationship_style  = COALESCE(?, relationship_style),
        love_language       = COALESCE(?, love_language),
        dealbreakers        = COALESCE(?, dealbreakers),
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
      input.voiceProfileId !== undefined ? input.voiceProfileId : null,
      input.voiceProfileId !== undefined ? input.voiceProfileId : null,
      input.slot               ?? null,
      input.displayName        ?? null,
      input.pronouns           ?? null,
      input.age                ?? null,
      input.gender             ?? null,
      input.appearance         ?? null,
      input.personalityDesc    ?? null,
      input.background         ?? null,
      input.interests          ?? null,
      input.dislikes           ?? null,
      input.hobbies            ?? null,
      input.goals              ?? null,
      input.fears              ?? null,
      input.values             ?? null,
      input.expertise          ?? null,
      input.relationshipStyle  ?? null,
      input.loveLanguage       ?? null,
      input.dealbreakers       ?? null,
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
      id,
    ]);
    return (await this.getProfile(id))!;
  }

  async setVoiceProfile(id: string, voiceProfileId: string | null): Promise<void> {
    await this.db.run(
      `UPDATE weclone_profiles SET voice_profile_id = ?, updated_at = ? WHERE id = ?`,
      [voiceProfileId, new Date().toISOString(), id],
    );
  }

  async deleteProfile(id: string): Promise<void> {
    await this.db.run(`DELETE FROM weclone_profiles WHERE id = ?`, [id]);
  }

  /** Build the "# YOU ARE" context block for AI injection. */
  buildIdentityBlock(p: WecloneProfileRow): string {
    const lines: string[] = ['## YOU ARE', ''];
    const add = (label: string, val: string) => {
      if (val.trim()) lines.push(`${label}: ${val.trim()}`);
    };
    add('Name',     p.display_name);
    add('Age',      p.age);
    add('Gender',   p.gender);
    add('Pronouns', p.pronouns);
    if (p.appearance.trim())       lines.push('', `Appearance: ${p.appearance.trim()}`);
    if (p.personality_desc.trim()) lines.push(`Personality: ${p.personality_desc.trim()}`);
    if (p.background.trim())       lines.push(`Background: ${p.background.trim()}`);
    if (p.interests.trim())        lines.push('', `Interests: ${p.interests.trim()}`);
    if (p.dislikes.trim())         lines.push(`Dislikes: ${p.dislikes.trim()}`);
    if (p.hobbies.trim())          lines.push(`Hobbies: ${p.hobbies.trim()}`);
    if (p.goals.trim())            lines.push('', `Goals: ${p.goals.trim()}`);
    if (p.fears.trim())            lines.push(`Fears: ${p.fears.trim()}`);
    if (p.values.trim())           lines.push(`Values: ${p.values.trim()}`);
    if (p.expertise.trim())        lines.push('', `Expertise: ${p.expertise.trim()}`);
    if (p.relationship_style.trim()) lines.push('', `Relationship style: ${p.relationship_style.trim()}`);
    if (p.love_language.trim())    lines.push(`Love language: ${p.love_language.trim()}`);
    if (p.dealbreakers.trim())     lines.push(`Dealbreakers: ${p.dealbreakers.trim()}`);
    return lines.join('\n');
  }
}