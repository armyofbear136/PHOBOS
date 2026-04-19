/**
 * meridian/idle-classifier.ts — Idle-time enrichment pipeline for PHOBOS Meridian.
 *
 * Runs only when PHOBOS is idle. Enriches indexed files with:
 *   1. SYBIL text embeddings (enables vector search) — v1 implemented
 *   2. Visual classification labels via ClassifierPlugin — v2 hook, no implementation
 *
 * Checks PHOBOS global state before processing each file. Pauses immediately
 * on any activity and resumes automatically when idle again.
 */

import http from 'node:http';
import path from 'node:path';
import type { MeridianDB } from './db/db.js';
import type { MeridianConfig } from './db/config.js';

// ── SYBIL constants ───────────────────────────────────────────────────────────

const SYBIL_PORT         = 16315;
const SYBIL_TIMEOUT_MS   = 10_000;
const PROCESS_INTERVAL_MS = 500;   // 2 files/sec ceiling
const BATCH_SIZE          = 10;    // files fetched per idle tick

// ── ClassifierPlugin interface (v2 hook) ──────────────────────────────────────

export interface ClassifierPlugin {
  /** Human-readable name, e.g. "MobileNet v3 Small" */
  name:      string;
  /** Absolute path to the ONNX model file */
  modelPath: string;
  /** Classify a single image. Returns empty array on failure — never throws. */
  classify(imagePath: string): Promise<Array<{ label: string; score: number }>>;
}

// ── AutoRule interface (v2 hook) ──────────────────────────────────────────────

export interface AutoRule {
  type:   'label_match' | 'date_range' | 'camera_model' | 'location_radius';
  params: Record<string, unknown>;
}

// ── SYBIL embed call ──────────────────────────────────────────────────────────

function sybildEmbed(text: string): Promise<number[] | null> {
  return new Promise(resolve => {
    const body = JSON.stringify({ content: text.slice(0, 8_000) });
    const req  = http.request({
      hostname: '127.0.0.1',
      port:     SYBIL_PORT,
      path:     '/embedding',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  SYBIL_TIMEOUT_MS,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          let vec: number[] | undefined;
          if (Array.isArray(json) && json.length > 0) {
            const raw = json[0]?.embedding;
            vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
          } else {
            const raw = json.embedding;
            vec = Array.isArray(raw?.[0]) ? raw[0] : raw;
          }
          resolve(Array.isArray(vec) && vec.length > 0 ? vec : null);
        } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body);
    req.end();
  });
}

function buildEmbedText(file: {
  filename:  string;
  takenAt:   string | null;
  exifJson:  Record<string, unknown> | null;
  labelsJson: Array<{ label: string; score: number }> | null;
}): string {
  const parts: string[] = [path.basename(file.filename, path.extname(file.filename))];

  if (file.takenAt) {
    const d = new Date(file.takenAt);
    parts.push(`taken ${d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
  }

  if (file.exifJson) {
    const e = file.exifJson as Record<string, unknown>;
    if (e.Make && e.Model) parts.push(`shot with ${e.Make} ${e.Model}`);
    else if (e.Model)      parts.push(`shot with ${e.Model}`);
  }

  if (file.labelsJson && file.labelsJson.length > 0) {
    const labels = file.labelsJson.slice(0, 5).map(l => l.label).join(', ');
    parts.push(`contains ${labels}`);
  }

  return parts.join(', ');
}

// ── Idle state source ─────────────────────────────────────────────────────────
// Meridian server receives idle state via config or a shared module import.
// We use a simple shared flag set by the server on each request.

let _isIdle = true;
export function setIdle(idle: boolean): void { _isIdle = idle; }

// ── Classifier registry ───────────────────────────────────────────────────────

const _plugins: ClassifierPlugin[] = [];
export function registerClassifier(plugin: ClassifierPlugin): void {
  _plugins.push(plugin);
  console.log(`[Meridian/Classifier] Registered: ${plugin.name}`);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class IdleClassifier {
  private running = false;
  private timer:   ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db:     MeridianDB,
    private config: MeridianConfig,
  ) {}

  start(): void {
    if (!this.config.idleEnabled) return;
    if (this.running) return;
    this.running = true;
    this._schedule();
    console.log('[Meridian/Classifier] Idle pipeline started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private _schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this._tick(), PROCESS_INTERVAL_MS);
  }

  private async _tick(): Promise<void> {
    if (!this.running) return;

    if (!_isIdle) {
      // Not idle — back off for 5 seconds
      this.timer = setTimeout(() => this._tick(), 5_000);
      return;
    }

    try {
      const files = await this.db.getUnclassifiedFiles(this.config.userId, BATCH_SIZE);

      for (const file of files) {
        if (!_isIdle || !this.running) break;

        // Step 1: SYBIL text embedding
        const text = buildEmbedText({
          filename:   file.filename,
          takenAt:    file.takenAt,
          exifJson:   file.exifJson,
          labelsJson: file.labelsJson,
        });
        const vec = await sybildEmbed(text);
        if (vec) await this.db.setEmbedding(file.id, vec);

        // Step 2: Visual classification (v2 — no plugins registered in v1)
        if (_plugins.length > 0 && (file.type === 'photo' || file.type === 'raw')) {
          const labels: Array<{ label: string; score: number }> = [];
          for (const plugin of _plugins) {
            try {
              const results = await plugin.classify(file.path);
              labels.push(...results);
            } catch (err) {
              console.warn(`[Meridian/Classifier] Plugin ${plugin.name} failed:`, (err as Error).message);
            }
          }
          if (labels.length > 0) {
            labels.sort((a, b) => b.score - a.score);
            await this.db.setLabels(file.id, labels.slice(0, 20));
          }
        } else if (_plugins.length === 0 && vec) {
          // Mark as classified (with empty labels) so we don't re-process forever
          await this.db.setLabels(file.id, []);
        }
      }
    } catch (err) {
      console.error('[Meridian/Classifier] Tick error:', (err as Error).message);
    }

    this._schedule();
  }
}
