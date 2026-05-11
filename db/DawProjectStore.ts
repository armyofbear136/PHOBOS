import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DawProject {
  id:                string;
  thread_id:         string | null;
  name:              string;
  xtk_json:          string;             // Efflux XTK song blob, opaque to us
  created_at:        string;
  updated_at:        string;
  last_render_path:  string | null;
}

export interface DawProjectSummary {
  id:               string;
  name:             string;
  thread_id:        string | null;
  updated_at:       string;
  last_render_path: string | null;
}

// ── Raw row shapes ────────────────────────────────────────────────────────────

interface RawRow {
  id:               string;
  thread_id:        string | null;
  name:             string;
  xtk_json:         string;
  created_at:       Date | string;
  updated_at:       Date | string;
  last_render_path: string | null;
}

interface SummaryRow {
  id:               string;
  name:             string;
  thread_id:        string | null;
  updated_at:       Date | string;
  last_render_path: string | null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class DawProjectStore {
  private db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS daw_projects (
        id               VARCHAR PRIMARY KEY,
        thread_id        VARCHAR,
        name             VARCHAR NOT NULL,
        xtk_json         JSON    NOT NULL,
        created_at       TIMESTAMP NOT NULL DEFAULT now(),
        updated_at       TIMESTAMP NOT NULL DEFAULT now(),
        last_render_path VARCHAR
      )
    `);

    // Index for thread-scoped listing — the most common read path.
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_daw_projects_thread
        ON daw_projects (thread_id, updated_at DESC)
    `);
  }

  async get(id: string): Promise<DawProject | null> {
    const rows = await this.db.query<RawRow>(
      `SELECT id, thread_id, name, xtk_json, created_at, updated_at, last_render_path
         FROM daw_projects WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToProject(rows[0]);
  }

  async list(threadId?: string | null): Promise<DawProjectSummary[]> {
    let rows: SummaryRow[];

    if (threadId === undefined) {
      // No filter — return everything.
      rows = await this.db.query<SummaryRow>(
        `SELECT id, name, thread_id, updated_at, last_render_path
           FROM daw_projects ORDER BY updated_at DESC`,
        [],
      );
    } else if (threadId === null) {
      // Thread-less projects only (IS NULL cannot be parameterised).
      rows = await this.db.query<SummaryRow>(
        `SELECT id, name, thread_id, updated_at, last_render_path
           FROM daw_projects WHERE thread_id IS NULL
           ORDER BY updated_at DESC`,
        [],
      );
    } else {
      rows = await this.db.query<SummaryRow>(
        `SELECT id, name, thread_id, updated_at, last_render_path
           FROM daw_projects WHERE thread_id = ?
           ORDER BY updated_at DESC`,
        [threadId],
      );
    }

    return rows.map(r => ({
      id:               r.id,
      name:             r.name,
      thread_id:        r.thread_id,
      updated_at:       r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      last_render_path: r.last_render_path,
    }));
  }

  async save(
    id:        string,
    name:      string,
    xtkJson:   string,
    threadId:  string | null = null,
  ): Promise<DawProject> {
    await this.db.run(
      `DELETE FROM daw_projects WHERE id = ?`, [id]
    );
    await this.db.run(
      `INSERT INTO daw_projects (id, thread_id, name, xtk_json)
       VALUES (?, ?, ?, ?)`,
      [id, threadId, name, xtkJson],
    );
    const loaded = await this.get(id);
    if (!loaded) throw new Error(`Save succeeded but reload failed for project ${id}`);
    return loaded;
  }

  async setLastRender(id: string, renderPath: string): Promise<void> {
    await this.db.run(
      `UPDATE daw_projects SET last_render_path = ?, updated_at = now() WHERE id = ?`,
      [renderPath, id],
    );
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query<{ id: string }>(
      `SELECT id FROM daw_projects WHERE id = ?`,
      [id],
    );
    if (res.length === 0) return false;
    await this.db.run(`DELETE FROM daw_projects WHERE id = ?`, [id]);
    return true;
  }
}

// ── Row decoders ──────────────────────────────────────────────────────────────

function rowToProject(r: RawRow): DawProject {
  return {
    id:               r.id,
    thread_id:        r.thread_id,
    name:             r.name,
    xtk_json:         r.xtk_json,
    created_at:       r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updated_at:       r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    last_render_path: r.last_render_path,
  };
}