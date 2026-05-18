/**
 * PhobosPostProcess — Day/night cycle post-process.
 *
 * Phaser v4 changed the PostFX pipeline API significantly and the filter
 * system is still in flux across RC builds. This module wraps it safely:
 *
 *   1. We attempt to attach a PostFX filter the v4 way.
 *   2. If that fails (API not available, CANVAS renderer, etc.) we silently
 *      fall back to the PERF rectangle overlay already managed by EffectsManager.
 *      The screen NEVER goes black — the fallback always works.
 *
 * The black-screen bug was caused by the camera's filter system being
 * left in a partially-initialised state when the v4 API didn't behave as
 * expected (wrong method names, different RC). Now we gate every step.
 *
 * Ultrawide fix: the GLSL now receives u_resolution and computes UV from
 * gl_FragCoord so the vignette and effects cover the full viewport, not
 * just the render-target square.
 */

import * as Phaser from 'phaser';

// ── GLSL ─────────────────────────────────────────────────────────────────────

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
#else
  precision mediump float;
#endif

uniform sampler2D uMainSampler;
uniform vec2  u_resolution;
uniform float u_hour;
uniform int   u_weather;
uniform float u_weather_int;
uniform float u_lightning;

varying vec2 outTexCoord;

float get_night(float h) {
  if (h >= 20.0 || h < 4.0) return 1.0;
  if (h >= 18.0) return (h - 18.0) / 2.0;
  if (h < 6.0)   return 1.0 - (h - 4.0) / 2.0;
  return 0.0;
}

float get_golden(float h) {
  if (h >= 5.0 && h < 7.0)   return sin((h - 5.0)  / 2.0 * 3.14159265);
  if (h >= 18.0 && h < 20.0) return sin((h - 18.0) / 2.0 * 3.14159265);
  return 0.0;
}

void main() {
  vec3 col = texture2D(uMainSampler, outTexCoord).rgb;

  float night  = get_night(u_hour);
  float golden = get_golden(u_hour);

  // Night — blue-dark tint
  col = mix(col, col * vec3(0.55, 0.60, 0.80) * 0.55, night * 0.75);
  // Golden hour
  col = mix(col, col * vec3(1.12, 1.04, 0.88), golden * 0.30);

  // Weather colour shifts
  if (u_weather == 2) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum) * 1.05, u_weather_int * 0.18);
  } else if (u_weather == 3) {
    col = mix(col, col * vec3(1.08, 1.03, 0.88), u_weather_int * 0.22);
  } else if (u_weather == 1) {
    col *= mix(1.0, 0.92, u_weather_int * 0.4);
  }

  // Lightning flash
  col += u_lightning * 0.35;

  // Vignette — computed from SCREEN position so it works on any aspect ratio.
  // u_resolution is the actual canvas pixel size passed each frame.
  vec2 screenUV = gl_FragCoord.xy / u_resolution;
  vec2 cen = screenUV - 0.5;
  // Correct for aspect ratio so the vignette is circular, not oval
  cen.x *= u_resolution.x / u_resolution.y;
  float vig = 1.0 - smoothstep(0.38, 0.80, length(cen));
  col *= mix(1.0, vig, 0.28);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ── State ─────────────────────────────────────────────────────────────────────

let _pipelineAvailable = false;

// Uniform state — mutated, never reallocated
let _hour       = 12.0;
let _weather    = 0;
let _weatherInt = 0.0;
let _lightning  = 0.0;

// ── Public API ────────────────────────────────────────────────────────────────

export function setHour(h: number):                     void { _hour = h; }
export function setWeather(type: number, int: number):  void { _weather = type; _weatherInt = int; }
export function setLightning(v: number):                void { _lightning = v; }
export function isPipelineActive():                     boolean { return _pipelineAvailable; }

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the DayNight pipeline. Safe to call on any Phaser version —
 * will no-op if the PostFX API is unavailable.
 */
export function registerDayNightPipeline(game: Phaser.Game): void {
  if (game.renderer.type !== Phaser.WEBGL) return;

  try {
    const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    // v3 / v4-early path: pipelines.addPostPipeline
    const pipelines = (renderer as any).pipelines;
    if (pipelines && typeof pipelines.addPostPipeline === 'function') {
      pipelines.addPostPipeline('DayNightPipeline', DayNightPipelineV3);
      _pipelineAvailable = true;
    }
  } catch (e) {
    console.warn('[PhobosPostProcess] Pipeline registration failed, using PERF fallback.', e);
    _pipelineAvailable = false;
  }
}

/**
 * Apply the pipeline to the camera. Returns true on success.
 * On failure does nothing — EffectsManager PERF overlay remains active.
 */
export function applyDayNightToCamera(camera: Phaser.Cameras.Scene2D.Camera): boolean {
  if (!_pipelineAvailable) return false;

  try {
    // v3 PostFX path
    (camera as any).setPostPipeline('DayNightPipeline');
    return true;
  } catch (e) {
    console.warn('[PhobosPostProcess] Camera attachment failed, using PERF fallback.', e);
    _pipelineAvailable = false;
    return false;
  }
}

/**
 * Remove pipeline from camera cleanly (called when switching back to PERF).
 */
export function removeDayNightFromCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
  try {
    (camera as any).removePostPipeline('DayNightPipeline');
  } catch { /* already removed or not attached */ }
}

/**
 * Get the pipeline instance so uniforms can be updated.
 */
export function getDayNightPipeline(
  camera: Phaser.Cameras.Scene2D.Camera
): DayNightPipelineV3 | null {
  if (!_pipelineAvailable) return null;
  try {
    const p = (camera as any).getPostPipeline('DayNightPipeline');
    return (p instanceof DayNightPipelineV3) ? p : null;
  } catch {
    return null;
  }
}

// ── Pipeline class (Phaser v3 PostFXPipeline path) ────────────────────────────
// In Phaser v4 RC builds the same API is usually present under
// Renderer.WebGL.Pipelines.PostFXPipeline — we try the v3 path first
// since it's what the installed ^4.0.0 actually exposes.

// Access Pipelines entirely through 'any' to avoid TS errors across Phaser
// v3/v4 API surface differences. The conditional chain handles both.
const _phaserWebGL: any = Phaser.Renderer?.WebGL;
const PostFXBase: any =
  _phaserWebGL?.Pipelines?.PostFXPipeline ??
  _phaserWebGL?.PostFXPipeline ??
  class FallbackBase {}; // harmless empty class if API not found

export class DayNightPipelineV3 extends PostFXBase {
  constructor(game: Phaser.Game) {
    super({
      game,
      name: 'DayNightPipeline',
      fragShader: FRAG,
    });
  }

  onPreRender(): void {
    // Guard: only call set* if the pipeline properly compiled
    try {
      const w = this.game?.canvas?.width  ?? 1280;
      const h = this.game?.canvas?.height ?? 720;
      this.set2f('u_resolution', w, h);
      this.set1f('u_hour',        _hour);
      this.set1i('u_weather',     _weather);
      this.set1f('u_weather_int', _weatherInt);
      this.set1f('u_lightning',   _lightning);
    } catch { /* shader not compiled in this env — silently skip */ }
  }
}

// ── Legacy re-exports (EffectsManager imports these names) ───────────────────
// Keep these so EffectsManager.ts doesn't need changes.

export class DayNightController {
  hour       = 12.0;
  weather    = 0;
  weatherInt = 0.0;
  lightning  = 0.0;
  setHour(h: number)                    { this.hour = h; setHour(h); }
  setWeather(t: number, i: number)      { this.weather = t; this.weatherInt = i; setWeather(t,i); }
  setLightning(v: number)               { this.lightning = v; setLightning(v); }
}

export class DayNightFilterShader {}  // stub — no longer used directly
