/**
 * CoordSystem — single source of truth for all coordinate transforms.
 *
 * Phaser 4 camera render matrix (regular camera, no rotation):
 *   canvasX = (worldX - scrollX - halfW) * zoom + halfW + cam.x
 *   canvasY = (worldY - scrollY - halfH) * zoom + halfH + cam.y
 *
 * Inverse (canvas-local → world):
 *   worldX = (canvasX - halfW - cam.x) / zoom + scrollX + halfW
 *   worldY = (canvasY - halfH - cam.y) / zoom + scrollY + halfH
 *
 * halfW = canvas CSS pixel width  / 2
 * halfH = canvas CSS pixel height / 2
 *
 * These are read from canvas.getBoundingClientRect() on init and on resize.
 * WorldScene calls updateTransform() once per frame from update().
 * All reads are pure math — no Phaser imports, no scene reference.
 */

import { TileWorld } from './TileWorld';

// ── Transform state ────────────────────────────────────────────────────────

export interface CameraTransform {
  scrollX: number;
  scrollY: number;
  zoom:    number;
  camX:    number;    // Phaser cam.x — viewport offset within canvas (0 for fullscreen)
  camY:    number;
  halfW:   number;    // canvas CSS pixel width  / 2  (Phaser camera originX)
  halfH:   number;    // canvas CSS pixel height / 2  (Phaser camera originY)
  rectLeft: number;   // canvas.getBoundingClientRect().left  (viewport → canvas-local)
  rectTop:  number;
}

const _t: CameraTransform = {
  scrollX: 0, scrollY: 0,
  zoom:    1,
  camX:    0, camY:    0,
  halfW:   0, halfH:   0,
  rectLeft: 0, rectTop: 0,
};

let _ready    = false;
let _observer: ResizeObserver | null = null;

// ── Lifecycle ──────────────────────────────────────────────────────────────

export function initCoordSystem(canvas: HTMLCanvasElement): void {
  const updateRect = () => {
    const r     = canvas.getBoundingClientRect();
    _t.rectLeft = r.left;
    _t.rectTop  = r.top;
    _t.halfW    = r.width  / 2;
    _t.halfH    = r.height / 2;
  };

  updateRect();

  if (_observer) _observer.disconnect();
  _observer = new ResizeObserver(updateRect);
  _observer.observe(canvas);

  window.addEventListener('resize', updateRect, { passive: true });

  _ready = true;
}

export function destroyCoordSystem(): void {
  _observer?.disconnect();
  _observer = null;
  _ready    = false;
}

export function updateTransform(
  scrollX: number, scrollY: number, zoom: number,
  camX: number,    camY: number,
): void {
  _t.scrollX = scrollX;
  _t.scrollY = scrollY;
  _t.zoom    = zoom;
  _t.camX    = camX;
  _t.camY    = camY;
}

export function coordSystemReady(): boolean { return _ready; }
export function getTransform(): Readonly<CameraTransform> { return _t; }

// ── Core transforms ────────────────────────────────────────────────────────

/** Viewport (clientX/Y) → canvas-local CSS pixels. */
export function viewportToLocal(clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: clientX - _t.rectLeft,
    y: clientY - _t.rectTop,
  };
}

/**
 * Canvas-local CSS pixels → Phaser world coords.
 * Exact inverse of Phaser 4 camera render matrix.
 */
export function localToWorld(localX: number, localY: number): { x: number; y: number } {
  return {
    x: (localX - _t.halfW - _t.camX) / _t.zoom + _t.scrollX + _t.halfW,
    y: (localY - _t.halfH - _t.camY) / _t.zoom + _t.scrollY + _t.halfH,
  };
}

/**
 * Phaser world coords → canvas-local CSS pixels.
 * Exact Phaser 4 camera render matrix.
 */
export function worldToLocal(worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: (worldX - _t.scrollX - _t.halfW) * _t.zoom + _t.halfW + _t.camX,
    y: (worldY - _t.scrollY - _t.halfH) * _t.zoom + _t.halfH + _t.camY,
  };
}

/** Canvas-local CSS pixels → viewport (clientX/Y space). */
export function localToViewport(localX: number, localY: number): { x: number; y: number } {
  return {
    x: localX + _t.rectLeft,
    y: localY + _t.rectTop,
  };
}

// ── Composed pipelines ─────────────────────────────────────────────────────

export function viewportToWorld(clientX: number, clientY: number): { x: number; y: number } {
  return localToWorld(clientX - _t.rectLeft, clientY - _t.rectTop);
}

export function worldToViewport(worldX: number, worldY: number): { x: number; y: number } {
  const l = worldToLocal(worldX, worldY);
  return { x: l.x + _t.rectLeft, y: l.y + _t.rectTop };
}

export function viewportToTile(clientX: number, clientY: number): { tx: number; ty: number } {
  const w = viewportToWorld(clientX, clientY);
  return TileWorld.getInstance().worldToTile(w.x, w.y);
}

export function tileToViewport(tx: number, ty: number): { x: number; y: number } {
  const w = TileWorld.getInstance().tileToWorld(tx, ty);
  return worldToViewport(w.x, w.y);
}

/**
 * Aim angle (radians) from a world-space origin to the current mouse position.
 * Use for weapon tilt, laser direction — correct at all zoom levels and scroll positions.
 */
export function aimAngleToViewport(
  originWorldX: number, originWorldY: number,
  clientX: number,      clientY: number,
): number {
  const cursor = viewportToWorld(clientX, clientY);
  return Math.atan2(cursor.y - originWorldY, cursor.x - originWorldX);
}
