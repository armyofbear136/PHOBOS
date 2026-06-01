/**
 * UserProfileStore — system-DB store for the owner's self-description.
 *
 * This is the "# YOU ARE TALKING TO" context that gets injected into both
 * clone sessions and regular copilot context when clone mode is active.
 * Lives in the system DB (one record per installation, keyed 'owner').
 */

import { DatabaseManager } from './DatabaseManager.js';

export interface UserProfileRow {
  id:                string;   // always 'owner'
  // Basic identity
  display_name:      string;
  age:               string;
  gender:            string;
  pronouns:          string;
  // Self-description
  appearance:        string;
  personality:       string;
  background:        string;
  // Preferences
  interests:         string;
  dislikes:          string;
  hobbies:           string;
  // Inner life
  goals:             string;
  fears:             string;
  values:            string;
  // Communication
  speech_style:      string;
  humor_style:       string;
  // Expertise
  expertise:         string;
  // Relationship
  relationship_style: string;
  love_language:     string;
  dealbreakers:      string;
  updated_at:        string;
}

export interface UserProfileInput {
  displayName?:       string;
  age?:               string;
  gender?:            string;
  pronouns?:          string;
  appearance?:        string;
  personality?:       string;
  background?:        string;
  interests?:         string;
  dislikes?:          string;
  hobbies?:           string;
  goals?:             string;
  fears?:             string;
  values?:            string;
  speechStyle?:       string;
  humorStyle?:        string;
  expertise?:         string;
  relationshipStyle?: string;
  loveLanguage?:      string;
  dealbreakers?:      string;
}

const OWNER_ID = 'owner';

export class UserProfileStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.ensureReady();
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id                 VARCHAR PRIMARY KEY,
        display_name       VARCHAR NOT NULL DEFAULT '',
        age                VARCHAR NOT NULL DEFAULT '',
        gender             VARCHAR NOT NULL DEFAULT '',
        pronouns           VARCHAR NOT NULL DEFAULT '',
        appearance         TEXT    NOT NULL DEFAULT '',
        personality        TEXT    NOT NULL DEFAULT '',
        background         TEXT    NOT NULL DEFAULT '',
        interests          TEXT    NOT NULL DEFAULT '',
        dislikes           TEXT    NOT NULL DEFAULT '',
        hobbies            TEXT    NOT NULL DEFAULT '',
        goals              TEXT    NOT NULL DEFAULT '',
        fears              TEXT    NOT NULL DEFAULT '',
        values             TEXT    NOT NULL DEFAULT '',
        speech_style       TEXT    NOT NULL DEFAULT '',
        humor_style        VARCHAR NOT NULL DEFAULT '',
        expertise          TEXT    NOT NULL DEFAULT '',
        relationship_style TEXT    NOT NULL DEFAULT '',
        love_language      VARCHAR NOT NULL DEFAULT '',
        dealbreakers       TEXT    NOT NULL DEFAULT '',
        updated_at         TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async getProfile(): Promise<UserProfileRow | null> {
    return this.db.queryOne<UserProfileRow>(
      `SELECT * FROM user_profiles WHERE id = ?`,
      [OWNER_ID],
    );
  }

  async upsertProfile(input: UserProfileInput): Promise<UserProfileRow> {
    const existing = await this.getProfile();
    const now      = new Date().toISOString();

    if (existing) {
      await this.db.run(`
        UPDATE user_profiles SET
          display_name       = COALESCE(NULLIF(?, ''), display_name),
          age                = COALESCE(?, age),
          gender             = COALESCE(?, gender),
          pronouns           = COALESCE(?, pronouns),
          appearance         = COALESCE(?, appearance),
          personality        = COALESCE(?, personality),
          background         = COALESCE(?, background),
          interests          = COALESCE(?, interests),
          dislikes           = COALESCE(?, dislikes),
          hobbies            = COALESCE(?, hobbies),
          goals              = COALESCE(?, goals),
          fears              = COALESCE(?, fears),
          values             = COALESCE(?, values),
          speech_style       = COALESCE(?, speech_style),
          humor_style        = COALESCE(?, humor_style),
          expertise          = COALESCE(?, expertise),
          relationship_style = COALESCE(?, relationship_style),
          love_language      = COALESCE(?, love_language),
          dealbreakers       = COALESCE(?, dealbreakers),
          updated_at         = ?
        WHERE id = ?
      `, [
        input.displayName       ?? null,
        input.age               ?? null,
        input.gender            ?? null,
        input.pronouns          ?? null,
        input.appearance        ?? null,
        input.personality       ?? null,
        input.background        ?? null,
        input.interests         ?? null,
        input.dislikes          ?? null,
        input.hobbies           ?? null,
        input.goals             ?? null,
        input.fears             ?? null,
        input.values            ?? null,
        input.speechStyle       ?? null,
        input.humorStyle        ?? null,
        input.expertise         ?? null,
        input.relationshipStyle ?? null,
        input.loveLanguage      ?? null,
        input.dealbreakers      ?? null,
        now,
        OWNER_ID,
      ]);
    } else {
      await this.db.run(`
        INSERT INTO user_profiles (
          id, display_name, age, gender, pronouns,
          appearance, personality, background,
          interests, dislikes, hobbies,
          goals, fears, values,
          speech_style, humor_style, expertise,
          relationship_style, love_language, dealbreakers,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        OWNER_ID,
        input.displayName       ?? '',
        input.age               ?? '',
        input.gender            ?? '',
        input.pronouns          ?? '',
        input.appearance        ?? '',
        input.personality       ?? '',
        input.background        ?? '',
        input.interests         ?? '',
        input.dislikes          ?? '',
        input.hobbies           ?? '',
        input.goals             ?? '',
        input.fears             ?? '',
        input.values            ?? '',
        input.speechStyle       ?? '',
        input.humorStyle        ?? '',
        input.expertise         ?? '',
        input.relationshipStyle ?? '',
        input.loveLanguage      ?? '',
        input.dealbreakers      ?? '',
        now,
      ]);
    }

    return (await this.getProfile())!;
  }

  /** Build the "# YOU ARE TALKING TO" context block for AI injection. */
  buildContextBlock(p: UserProfileRow): string {
    const lines: string[] = ['## YOU ARE TALKING TO', ''];
    const add = (label: string, val: string) => {
      if (val.trim()) lines.push(`${label}: ${val.trim()}`);
    };
    add('Name',               p.display_name);
    add('Age',                p.age);
    add('Gender',             p.gender);
    add('Pronouns',           p.pronouns);
    if (p.appearance.trim())  lines.push('', `Appearance: ${p.appearance.trim()}`);
    if (p.personality.trim()) lines.push(`Personality: ${p.personality.trim()}`);
    if (p.background.trim())  lines.push(`Background: ${p.background.trim()}`);
    if (p.interests.trim())   lines.push('', `Interests: ${p.interests.trim()}`);
    if (p.dislikes.trim())    lines.push(`Dislikes: ${p.dislikes.trim()}`);
    if (p.hobbies.trim())     lines.push(`Hobbies: ${p.hobbies.trim()}`);
    if (p.goals.trim())       lines.push('', `Goals: ${p.goals.trim()}`);
    if (p.fears.trim())       lines.push(`Fears: ${p.fears.trim()}`);
    if (p.values.trim())      lines.push(`Values: ${p.values.trim()}`);
    if (p.speech_style.trim()) lines.push('', `Speech style: ${p.speech_style.trim()}`);
    if (p.humor_style.trim()) lines.push(`Humor: ${p.humor_style.trim()}`);
    if (p.expertise.trim())   lines.push(`Expertise: ${p.expertise.trim()}`);
    if (p.relationship_style.trim()) lines.push('', `Relationship style: ${p.relationship_style.trim()}`);
    if (p.love_language.trim())      lines.push(`Love language: ${p.love_language.trim()}`);
    if (p.dealbreakers.trim())       lines.push(`Dealbreakers: ${p.dealbreakers.trim()}`);
    return lines.join('\n');
  }

  /**
   * Fetch the owner profile and return the context block in one call.
   * Returns an empty string if no profile has been saved yet — the copilot
   * route treats empty string as "don't inject" so the system prompt is
   * unchanged when the owner hasn't filled in their profile.
   */
  async buildContextBlockForOwner(): Promise<string> {
    const p = await this.getProfile();
    if (!p) return '';
    // Only inject if at least one meaningful field is filled.
    const hasContent = [
      p.display_name, p.personality, p.background, p.interests,
    ].some(v => v.trim().length > 0);
    return hasContent ? this.buildContextBlock(p) : '';
  }
}