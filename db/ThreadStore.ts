import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export interface Thread {
  id: string;
  title: string;
  type: 'planning' | 'execution';
  project_id: string | null;
  parent_thread_id: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface CreateThreadInput {
  title?: string;
  type?: 'planning' | 'execution';
  project_id?: string | null;
  parent_thread_id?: string | null;
  mode?: string;
}

export class ThreadStore {
  constructor(private db: DatabaseManager) {}

  async getAll(): Promise<Thread[]> {
    return this.db.query<Thread>(
      `SELECT * FROM threads
       WHERE id NOT IN ('copilot-global', 'copilot-sayon', 'copilot-seren')
       ORDER BY updated_at DESC`
    );
  }

  async getById(id: string): Promise<Thread | null> {
    return this.db.queryOne<Thread>(
      `SELECT * FROM threads WHERE id = ?`,
      [id]
    );
  }

  async getByProject(project_id: string): Promise<Thread[]> {
    return this.db.query<Thread>(
      `SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC`,
      [project_id]
    );
  }

  async insert(data: { id: string } & CreateThreadInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO threads (id, title, type, project_id, parent_thread_id, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.title ?? 'New conversation',
        data.type ?? 'execution',
        data.project_id ?? null,
        data.parent_thread_id ?? null,
        data.mode ?? 'code',
        now,
        now,
      ]
    );
  }

  async create(input: CreateThreadInput): Promise<Thread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO threads (id, title, type, project_id, parent_thread_id, mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.title ?? 'New conversation',
        input.type ?? 'execution',
        input.project_id ?? null,
        input.parent_thread_id ?? null,
        input.mode ?? 'code',
        now,
        now,
      ]
    );
    return (await this.getById(id))!;
  }

  async fork(parentId: string): Promise<Thread> {
    const parent = await this.getById(parentId);
    if (!parent) throw new Error(`Thread ${parentId} not found`);
    return this.create({
      title: `${parent.title} (fork)`,
      type: parent.type,
      project_id: parent.project_id,
      parent_thread_id: parentId,
      mode: parent.mode,
    });
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.db.run(
      `UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`,
      [title, new Date().toISOString(), id]
    );
  }

  async updateProject(id: string, projectId: string | null): Promise<void> {
    await this.db.run(
      `UPDATE threads SET project_id = ?, updated_at = ? WHERE id = ?`,
      [projectId, new Date().toISOString(), id]
    );
  }

  async touch(id: string): Promise<void> {
    await this.db.run(
      `UPDATE threads SET updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM threads WHERE id = ?`, [id]);
  }
}
