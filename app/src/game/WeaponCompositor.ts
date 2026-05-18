/**
 * WeaponCompositor — bakes 3 tinted weapon part sprites into one composite.
 *
 * Each melee weapon is composed from three 316×316 px source sprites:
 *   Handle  (left)   — occupies x: 0..39      (40px, ~1/8 of frame)
 *   Shaft   (center) — occupies x: 40..197    (158px, ~1/2 of frame)
 *   Head    (right)  — occupies x: 198..315   (118px, ~3/8 of frame)
 *
 * TEMPLATE MARKERS (place these guides on your 316×316 art template):
 *   X = 39   — Handle | Shaft boundary (right edge of handle zone)
 *   X = 197  — Shaft  | Head  boundary (right edge of shaft zone)
 *   X = 19, Y = 158 — Grip anchor (character hand hold point, center of handle)
 *
 * Weapon orientation convention: points RIGHT (east-facing display).
 * The engine rotates/flips the composite per facing direction.
 *
 * Output: 316×316 composite texture registered in scene.textures.
 * Falls back to tinted rectangles if part textures are not loaded.
 */

import * as Phaser from 'phaser';
import type { WeaponAssembly } from './ItemDefinitions';

// ── Weapon composite frame size ──────────────────────────────────────────────
const COMPOSITE_SIZE = 316;

// ── Part division points (pixel coordinates in a 316×316 frame) ──────────────
// Use these as guides when authoring handle/shaft/head source sprites.
export const WEAPON_SEAM_HANDLE_SHAFT = 39;   // X: right edge of handle zone
export const WEAPON_SEAM_SHAFT_HEAD   = 197;  // X: right edge of shaft zone
export const WEAPON_GRIP_X = 19;              // grip anchor point X
export const WEAPON_GRIP_Y = 158;             // grip anchor point Y (vertical center)

// Part zone widths (derived, for reference)
export const WEAPON_HANDLE_WIDTH = WEAPON_SEAM_HANDLE_SHAFT + 1;              // 40px
export const WEAPON_SHAFT_WIDTH  = WEAPON_SEAM_SHAFT_HEAD - WEAPON_SEAM_HANDLE_SHAFT; // 158px
export const WEAPON_HEAD_WIDTH   = COMPOSITE_SIZE - WEAPON_SEAM_SHAFT_HEAD - 1;       // 118px

// ── Tint helper ──────────────────────────────────────────────────────────────

function tintImageData(imgData: ImageData, hexColor: string): void {
  const r = parseInt(hexColor.slice(1, 3), 16) / 255;
  const g = parseInt(hexColor.slice(3, 5), 16) / 255;
  const b = parseInt(hexColor.slice(5, 7), 16) / 255;
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.round(d[i]     * r);
    d[i + 1] = Math.round(d[i + 1] * g);
    d[i + 2] = Math.round(d[i + 2] * b);
    // alpha unchanged
  }
}

// ── Phaser-side compositor ───────────────────────────────────────────────────

/**
 * Bake a weapon assembly into a Phaser dynamic texture.
 * Returns the compositeKey. No-ops if already baked.
 */
export function bakeWeaponComposite(scene: Phaser.Scene, assembly: WeaponAssembly): string {
  const key = assembly.compositeKey;
  if (scene.textures.exists(key)) return key;

  const canvas = document.createElement('canvas');
  canvas.width  = COMPOSITE_SIZE;
  canvas.height = COMPOSITE_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Draw parts bottom-to-top: grip(2) → shaft(1) → head/blade(0)
  for (let i = assembly.parts.length - 1; i >= 0; i--) {
    const part = assembly.parts[i];
    const spriteKey = `wp-${part.variantId}`;

    if (scene.textures.exists(spriteKey)) {
      const source = scene.textures.get(spriteKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
      const tmp = document.createElement('canvas');
      tmp.width  = COMPOSITE_SIZE;
      tmp.height = COMPOSITE_SIZE;
      const tmpCtx = tmp.getContext('2d')!;
      tmpCtx.drawImage(source, 0, 0, COMPOSITE_SIZE, COMPOSITE_SIZE);
      const imgData = tmpCtx.getImageData(0, 0, COMPOSITE_SIZE, COMPOSITE_SIZE);
      tintImageData(imgData, part.tint);
      tmpCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(tmp, 0, 0);
    } else {
      // Fallback: tinted rectangle for each zone
      ctx.fillStyle = part.tint;
      ctx.globalAlpha = 0.7;
      // i=0 = head (right zone), i=1 = shaft (center), i=2 = handle (left)
      const x = i === 2 ? 0
              : i === 1 ? WEAPON_SEAM_HANDLE_SHAFT + 1
              : WEAPON_SEAM_SHAFT_HEAD + 1;
      const w = i === 2 ? WEAPON_HANDLE_WIDTH
              : i === 1 ? WEAPON_SHAFT_WIDTH
              : WEAPON_HEAD_WIDTH;
      ctx.fillRect(x, 2, w, COMPOSITE_SIZE - 4);
      ctx.globalAlpha = 1.0;
    }
  }

  scene.textures.addCanvas(key, canvas);
  return key;
}

// ── React/UI-side renderer (no Phaser required) ──────────────────────────────

/**
 * Render a weapon assembly to an HTMLCanvasElement for React UI.
 * Uses the same zone proportions as the Phaser compositor.
 */
export function renderWeaponToCanvas(assembly: WeaponAssembly, size = 64): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Scale zone widths proportionally to requested size
  const scale = size / COMPOSITE_SIZE;
  const handleW = Math.round(WEAPON_HANDLE_WIDTH * scale);
  const shaftW  = Math.round(WEAPON_SHAFT_WIDTH  * scale);
  const headW   = size - handleW - shaftW;
  const zones   = [handleW, shaftW, headW]; // left-to-right: handle, shaft, head
  const partCount = assembly.parts.length;

  // parts[2]=handle, parts[1]=shaft, parts[0]=head (assembly order)
  for (let i = 0; i < Math.min(partCount, 3); i++) {
    const partIdx = 2 - i; // map zone index to assembly part index
    if (partIdx >= partCount) continue;
    const part = assembly.parts[partIdx];
    const x = zones.slice(0, i).reduce((s, v) => s + v, 0);
    const w = zones[i];

    ctx.fillStyle = part.tint;
    ctx.beginPath();
    ctx.roundRect(x + 1, 2, w - 2, size - 4, 3);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  return canvas;
}

/**
 * Get a data URL for a weapon assembly for React <img> tags.
 */
export function weaponAssemblyToDataUrl(assembly: WeaponAssembly, size = 64): string {
  return renderWeaponToCanvas(assembly, size).toDataURL('image/png');
}
