/**
 * meridian/db.ts — DuckDB schema and query helpers for PHOBOS Meridian.
 *
 * Uses DatabaseManager.query<T>() and .run() — the same pattern as every
 * other store in the project. No raw duckdb-async calls.
 */

import crypto from 'node:crypto';
import type { DatabaseManager } from '../../db/DatabaseManager.js';

export type FileType = 'photo' | 'video' | 'raw' | 'unknown';

export interface MeridianFile {
  id: string; path: string; filename: string; ext: string; type: FileType;
  sizeBytes: number | null; width: number | null; height: number | null;
  durationMs: number | null; takenAt: string | null; indexedAt: string;
  mtime: number; thumbReady: boolean; thumbPath: string | null;
  exifJson: Record<string, unknown> | null; embedVec: number[] | null;
  labelsJson: Array<{ label: string; score: number }> | null;
  albumIds: string[]; userId: string; libraryId: string;
}

export interface MeridianAlbum {
  id: string; name: string; description: string | null; coverFileId: string | null;
  createdAt: string; updatedAt: string; userId: string; libraryId: string;
  autoRule: Record<string, unknown> | null;
}

export interface MeridianLibrary {
  id: string; path: string; label: string; enabled: boolean;
  lastScanAt: string | null; fileCount: number; userId: string; createdAt: string;
}

export interface ScanLog {
  id: string; libraryId: string; startedAt: string; finishedAt: string | null;
  filesAdded: number; filesRemoved: number; filesChanged: number; error: string | null;
}

type Row = Record<string, unknown>;

const TABLES = [
`CREATE TABLE IF NOT EXISTS meridian_files (
  id VARCHAR PRIMARY KEY, path VARCHAR NOT NULL, filename VARCHAR NOT NULL,
  ext VARCHAR NOT NULL, type VARCHAR NOT NULL DEFAULT 'unknown',
  size_bytes BIGINT, width INTEGER, height INTEGER, duration_ms INTEGER,
  taken_at TIMESTAMP, indexed_at TIMESTAMP NOT NULL DEFAULT now(),
  mtime BIGINT NOT NULL, thumb_ready BOOLEAN NOT NULL DEFAULT false,
  thumb_path VARCHAR, exif_json JSON, embed_vec FLOAT[768], labels_json JSON,
  album_ids VARCHAR[], user_id VARCHAR NOT NULL DEFAULT 'default',
  library_id VARCHAR NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS meridian_albums (
  id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, description VARCHAR,
  cover_file_id VARCHAR, created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  user_id VARCHAR NOT NULL DEFAULT 'default', library_id VARCHAR NOT NULL, auto_rule JSON
)`,
`CREATE TABLE IF NOT EXISTS meridian_libraries (
  id VARCHAR PRIMARY KEY, path VARCHAR NOT NULL,
  label VARCHAR NOT NULL DEFAULT 'Photos', enabled BOOLEAN NOT NULL DEFAULT true,
  last_scan_at TIMESTAMP, file_count INTEGER NOT NULL DEFAULT 0,
  user_id VARCHAR NOT NULL DEFAULT 'default', created_at TIMESTAMP NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS meridian_scan_log (
  id VARCHAR PRIMARY KEY, library_id VARCHAR NOT NULL,
  started_at TIMESTAMP NOT NULL, finished_at TIMESTAMP,
  files_added INTEGER NOT NULL DEFAULT 0, files_removed INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0, error VARCHAR
)`,
];

export class MeridianDB {
  constructor(private db: DatabaseManager) {}

  async ensureSchema(): Promise<void> {
    for (const stmt of TABLES) await this.db.run(stmt);
  }

  fileId(absolutePath: string): string {
    return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  }

  private j(v: unknown): unknown {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async getFile(id: string): Promise<MeridianFile | null> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_files WHERE id = ?', [id]);
    return rows.length > 0 ? this._mapFile(rows[0]) : null;
  }

  async getFileMtime(id: string): Promise<{ mtime: number; thumbReady: boolean } | null> {
    const rows = await this.db.query<Row>('SELECT mtime, thumb_ready FROM meridian_files WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    return { mtime: Number(rows[0].mtime), thumbReady: Boolean(rows[0].thumb_ready) };
  }

  async upsertFile(f: MeridianFile): Promise<void> {
    await this.db.run(`
      INSERT INTO meridian_files
        (id,path,filename,ext,type,size_bytes,width,height,duration_ms,
         taken_at,mtime,thumb_ready,thumb_path,exif_json,album_ids,user_id,library_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET
        path=excluded.path, filename=excluded.filename, ext=excluded.ext,
        type=excluded.type, size_bytes=excluded.size_bytes,
        width=excluded.width, height=excluded.height, duration_ms=excluded.duration_ms,
        taken_at=excluded.taken_at, mtime=excluded.mtime,
        thumb_ready=excluded.thumb_ready, thumb_path=excluded.thumb_path,
        exif_json=excluded.exif_json
    `, [f.id,f.path,f.filename,f.ext,f.type,
        f.sizeBytes??null, f.width??null, f.height??null, f.durationMs??null,
        f.takenAt??null, f.mtime, f.thumbReady?1:0, f.thumbPath??null,
        f.exifJson?JSON.stringify(f.exifJson):null,
        f.albumIds.length>0?JSON.stringify(f.albumIds):null,
        f.userId, f.libraryId]);
  }

  async markThumbReady(id: string, thumbPath: string): Promise<void> {
    await this.db.run('UPDATE meridian_files SET thumb_ready=true, thumb_path=? WHERE id=?', [thumbPath,id]);
  }

  async setEmbedding(id: string, vec: number[]): Promise<void> {
    await this.db.run('UPDATE meridian_files SET embed_vec=? WHERE id=?', [JSON.stringify(vec),id]);
  }

  async setLabels(id: string, labels: Array<{ label: string; score: number }>): Promise<void> {
    await this.db.run('UPDATE meridian_files SET labels_json=? WHERE id=?', [JSON.stringify(labels),id]);
  }

  async deleteFilesNotIn(libraryId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) {
      const r = await this.db.query<Row>('SELECT COUNT(*) as c FROM meridian_files WHERE library_id=?',[libraryId]);
      await this.db.run('DELETE FROM meridian_files WHERE library_id=?',[libraryId]);
      return Number(r[0]?.c??0);
    }
    const ph = ids.map(()=>'?').join(',');
    const r = await this.db.query<Row>(
      `SELECT COUNT(*) as c FROM meridian_files WHERE library_id=? AND id NOT IN (${ph})`,
      [libraryId,...ids]);
    await this.db.run(`DELETE FROM meridian_files WHERE library_id=? AND id NOT IN (${ph})`,[libraryId,...ids]);
    return Number(r[0]?.c??0);
  }

  async listFiles(opts: {
    userId: string; libraryId?: string; limit: number; offset: number;
    orderBy: 'taken_at'|'indexed_at'|'filename'; type?: FileType;
  }): Promise<{ files: MeridianFile[]; total: number }> {
    const conds: string[] = ['user_id=?']; const params: unknown[] = [opts.userId];
    if (opts.libraryId) { conds.push('library_id=?'); params.push(opts.libraryId); }
    if (opts.type)      { conds.push('type=?');       params.push(opts.type); }
    const w = conds.join(' AND ');
    const col = (['taken_at','indexed_at','filename'] as const).includes(opts.orderBy) ? opts.orderBy : 'taken_at';
    const cr = await this.db.query<Row>(`SELECT COUNT(*) as t FROM meridian_files WHERE ${w}`, params);
    const rows = await this.db.query<Row>(
      `SELECT * FROM meridian_files WHERE ${w} ORDER BY ${col} DESC NULLS LAST LIMIT ? OFFSET ?`,
      [...params, opts.limit, opts.offset]);
    return { files: rows.map(r=>this._mapFile(r)), total: Number(cr[0]?.t??0) };
  }

  async searchFiles(opts: { userId:string; query:string; limit:number; offset:number }): Promise<{ files: MeridianFile[]; total: number }> {
    const q = `%${opts.query.toLowerCase()}%`;
    const rows = await this.db.query<Row>(`
      SELECT * FROM meridian_files WHERE user_id=?
        AND (lower(filename) LIKE ? OR lower(labels_json::VARCHAR) LIKE ?)
      ORDER BY taken_at DESC NULLS LAST LIMIT ? OFFSET ?
    `, [opts.userId,q,q,opts.limit,opts.offset]);
    const cr = await this.db.query<Row>(`
      SELECT COUNT(*) as t FROM meridian_files WHERE user_id=?
        AND (lower(filename) LIKE ? OR lower(labels_json::VARCHAR) LIKE ?)
    `, [opts.userId,q,q]);
    return { files: rows.map(r=>this._mapFile(r)), total: Number(cr[0]?.t??0) };
  }

  async getUnclassifiedFiles(userId: string, limit: number): Promise<MeridianFile[]> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM meridian_files WHERE user_id=? AND embed_vec IS NULL AND type IN ('photo','raw') LIMIT ?`,
      [userId,limit]);
    return rows.map(r=>this._mapFile(r));
  }

  async rawQuery(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.db.query<Row>(sql, params);
  }

  // ── Libraries ──────────────────────────────────────────────────────────────

  async getLibrary(id: string): Promise<MeridianLibrary | null> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_libraries WHERE id=?',[id]);
    return rows.length>0 ? this._mapLibrary(rows[0]) : null;
  }

  async getLibraryByPath(p: string, userId: string): Promise<MeridianLibrary | null> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_libraries WHERE path=? AND user_id=?',[p,userId]);
    return rows.length>0 ? this._mapLibrary(rows[0]) : null;
  }

  async listLibraries(userId: string): Promise<MeridianLibrary[]> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_libraries WHERE user_id=? ORDER BY created_at ASC',[userId]);
    return rows.map(r=>this._mapLibrary(r));
  }

  async upsertLibrary(lib: MeridianLibrary): Promise<void> {
    await this.db.run(`
      INSERT INTO meridian_libraries (id,path,label,enabled,user_id)
      VALUES (?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET path=excluded.path,label=excluded.label,enabled=excluded.enabled
    `, [lib.id,lib.path,lib.label,lib.enabled?1:0,lib.userId]);
  }

  async updateLibraryScanTime(id: string, fileCount: number): Promise<void> {
    await this.db.run('UPDATE meridian_libraries SET last_scan_at=now(), file_count=? WHERE id=?',[fileCount,id]);
  }

  async deleteLibrary(id: string): Promise<void> {
    await this.db.run('DELETE FROM meridian_libraries WHERE id=?', [id]);
  }

  // ── Albums ─────────────────────────────────────────────────────────────────

  async getAlbum(id: string): Promise<MeridianAlbum | null> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_albums WHERE id=?',[id]);
    return rows.length>0 ? this._mapAlbum(rows[0]) : null;
  }

  async listAlbums(userId: string): Promise<MeridianAlbum[]> {
    const rows = await this.db.query<Row>('SELECT * FROM meridian_albums WHERE user_id=? ORDER BY updated_at DESC',[userId]);
    return rows.map(r=>this._mapAlbum(r));
  }

  async createAlbum(album: MeridianAlbum): Promise<void> {
    await this.db.run(`INSERT INTO meridian_albums (id,name,description,user_id,library_id,auto_rule) VALUES (?,?,?,?,?,?)`,
      [album.id,album.name,album.description??null,album.userId,album.libraryId,album.autoRule?JSON.stringify(album.autoRule):null]);
  }

  async updateAlbum(id: string, patch: Partial<Pick<MeridianAlbum,'name'|'description'|'coverFileId'>>): Promise<void> {
    const sets: string[]=[]; const params: unknown[]=[];
    if (patch.name!==undefined)        { sets.push('name=?');          params.push(patch.name); }
    if (patch.description!==undefined) { sets.push('description=?');   params.push(patch.description); }
    if (patch.coverFileId!==undefined) { sets.push('cover_file_id=?'); params.push(patch.coverFileId); }
    if (!sets.length) return;
    sets.push('updated_at=now()'); params.push(id);
    await this.db.run(`UPDATE meridian_albums SET ${sets.join(',')} WHERE id=?`, params);
  }

  async deleteAlbum(id: string): Promise<void> {
    await this.db.run('DELETE FROM meridian_albums WHERE id=?',[id]);
    await this.db.run(`UPDATE meridian_files SET album_ids=array_filter(COALESCE(album_ids,[]),x->x!=?) WHERE array_contains(COALESCE(album_ids,[]),?)`,[id,id]);
  }

  async addFileToAlbum(fileId: string, albumId: string): Promise<void> {
    await this.db.run(`UPDATE meridian_files SET album_ids=array_append(COALESCE(album_ids,[]),?) WHERE id=? AND NOT array_contains(COALESCE(album_ids,[]),?)`,[albumId,fileId,albumId]);
    await this.db.run('UPDATE meridian_albums SET updated_at=now() WHERE id=?',[albumId]);
  }

  async removeFileFromAlbum(fileId: string, albumId: string): Promise<void> {
    await this.db.run(`UPDATE meridian_files SET album_ids=array_filter(COALESCE(album_ids,[]),x->x!=?) WHERE id=?`,[albumId,fileId]);
    await this.db.run('UPDATE meridian_albums SET updated_at=now() WHERE id=?',[albumId]);
  }

  async getAlbumFiles(albumId: string, userId: string): Promise<MeridianFile[]> {
    const rows = await this.db.query<Row>(`SELECT * FROM meridian_files WHERE user_id=? AND array_contains(COALESCE(album_ids,[]),?) ORDER BY taken_at DESC NULLS LAST`,[userId,albumId]);
    return rows.map(r=>this._mapFile(r));
  }

  // ── Scan log ───────────────────────────────────────────────────────────────

  async insertScanLog(log: ScanLog): Promise<void> {
    await this.db.run(`INSERT INTO meridian_scan_log (id,library_id,started_at,finished_at,files_added,files_removed,files_changed,error) VALUES (?,?,?,?,?,?,?,?)`,
      [log.id,log.libraryId,log.startedAt,log.finishedAt??null,log.filesAdded,log.filesRemoved,log.filesChanged,log.error??null]);
  }

  async updateScanLog(id: string, patch: Partial<ScanLog>): Promise<void> {
    const sets: string[]=[]; const params: unknown[]=[];
    if (patch.finishedAt!==undefined)  { sets.push('finished_at=?');   params.push(patch.finishedAt); }
    if (patch.filesAdded!==undefined)  { sets.push('files_added=?');   params.push(patch.filesAdded); }
    if (patch.filesRemoved!==undefined){ sets.push('files_removed=?'); params.push(patch.filesRemoved); }
    if (patch.filesChanged!==undefined){ sets.push('files_changed=?'); params.push(patch.filesChanged); }
    if (patch.error!==undefined)       { sets.push('error=?');         params.push(patch.error); }
    if (!sets.length) return;
    params.push(id);
    await this.db.run(`UPDATE meridian_scan_log SET ${sets.join(',')} WHERE id=?`, params);
  }

  // ── Mappers ────────────────────────────────────────────────────────────────

  private _mapFile(r: Row): MeridianFile {
    return {
      id: r.id as string, path: r.path as string, filename: r.filename as string,
      ext: r.ext as string, type: r.type as FileType,
      sizeBytes:  r.size_bytes!=null  ? Number(r.size_bytes)  : null,
      width:      r.width!=null       ? Number(r.width)       : null,
      height:     r.height!=null      ? Number(r.height)      : null,
      durationMs: r.duration_ms!=null ? Number(r.duration_ms) : null,
      takenAt: r.taken_at as string|null, indexedAt: r.indexed_at as string,
      mtime: Number(r.mtime), thumbReady: Boolean(r.thumb_ready),
      thumbPath: r.thumb_path as string|null,
      exifJson:   this.j(r.exif_json)   as Record<string,unknown>|null,
      embedVec:   this.j(r.embed_vec)   as number[]|null,
      labelsJson: this.j(r.labels_json) as Array<{label:string;score:number}>|null,
      albumIds:   (this.j(r.album_ids) as string[]|null) ?? [],
      userId: r.user_id as string, libraryId: r.library_id as string,
    };
  }

  private _mapLibrary(r: Row): MeridianLibrary {
    return {
      id: r.id as string, path: r.path as string, label: r.label as string,
      enabled: Boolean(r.enabled), lastScanAt: r.last_scan_at as string|null,
      fileCount: Number(r.file_count??0), userId: r.user_id as string,
      createdAt: r.created_at as string,
    };
  }

  private _mapAlbum(r: Row): MeridianAlbum {
    return {
      id: r.id as string, name: r.name as string,
      description: r.description as string|null, coverFileId: r.cover_file_id as string|null,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      userId: r.user_id as string, libraryId: r.library_id as string,
      autoRule: this.j(r.auto_rule) as Record<string,unknown>|null,
    };
  }
}
