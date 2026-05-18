/**
 * NebulaBackground — Generates a unique procedural deep-space background.
 *
 * Called ONCE at WorldScene.create(). Bakes the result into a RenderTexture
 * and returns an Image for WorldScene to place at depth 0.
 *
 * PERF tier: Phaser.Graphics concentric circles — fast CPU draw, zero GPU cost.
 * HIGH tier: WebGL shader quad rendered to RenderTexture, then shader destroyed.
 *
 * The session seed is Date.now() — unique nebula every launch.
 */

import * as Phaser from 'phaser';

// ── Seeded LCG — same algorithm used in WorldScene ────────────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = Math.imul(s, 1664525) + 1013904223 >>> 0;
    return s / 0x100000000;
  };
}

// ── GLSL source for the HIGH-tier nebula shader ───────────────────────────
const NEBULA_FRAG = `
precision mediump float;
uniform vec2  u_res;
uniform float u_seed;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
float hash1(float n) { return fract(sin(n) * 43758.5453); }

float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  mat2 r = mat2(0.8,-0.6,0.6,0.8);
  for(int i=0;i<4;i++){ v += a*vnoise(p); p = r*p*2.1; a*=0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = uv * 4.0 + vec2(u_seed * 0.001);
  vec3 col = vec3(0.0);

  // Nebula cloud 1 — violet
  float n1 = fbm(p + vec2(1.3, 0.7));
  n1 = smoothstep(0.52, 0.72, n1);
  col += vec3(0.18, 0.04, 0.35) * n1 * 0.6;

  // Nebula cloud 2 — teal
  float n2 = fbm(p * 0.8 + vec2(u_seed * 0.0007, 2.1));
  n2 = smoothstep(0.56, 0.76, n2);
  col += vec3(0.02, 0.12, 0.22) * n2 * 0.7;

  // Nebula cloud 3 — rose accent
  float n3 = fbm(p * 1.3 + vec2(3.7, u_seed * 0.0013));
  n3 = smoothstep(0.60, 0.78, n3);
  col += vec3(0.20, 0.03, 0.08) * n3 * 0.4;

  // Small background stars
  vec2 sc = floor(uv * 280.0);
  float sh = hash(sc + u_seed * 0.01);
  if (sh > 0.965) {
    vec2 sf = fract(uv * 280.0) - 0.5;
    float sd = length(sf);
    float star = smoothstep(0.18, 0.0, sd);
    float br = hash1(sh * 17.3) * 0.6 + 0.4;
    col += vec3(0.85, 0.90, 1.0) * star * br;
  }

  // Large bright stars with glow
  vec2 bc = floor(uv * 60.0);
  float bh = hash(bc + u_seed * 0.02 + 100.0);
  if (bh > 0.94) {
    vec2 bf = fract(uv * 60.0) - 0.5;
    float bd = length(bf);
    float bstar = smoothstep(0.3, 0.0, bd);
    float glow  = smoothstep(0.7, 0.0, bd) * 0.25;
    col += vec3(0.95, 0.95, 1.0) * (bstar + glow);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

// ── Public API ────────────────────────────────────────────────────────────

export class NebulaBackground {
  private static _instance: NebulaBackground | null = null;
  private _rt:    Phaser.GameObjects.RenderTexture | null = null;
  private _image: Phaser.GameObjects.Image | null = null;

  static getInstance(): NebulaBackground {
    if (!NebulaBackground._instance) {
      NebulaBackground._instance = new NebulaBackground();
    }
    return NebulaBackground._instance;
  }

  /** Generate the background. Call once in WorldScene.create() before tiles. */
  generate(scene: Phaser.Scene, highPerf: boolean): Phaser.GameObjects.Image {
    const W = scene.scale.width  || 1280;
    const H = scene.scale.height || 720;
    const seed = Date.now() % 99999;

    this._rt = scene.add.renderTexture(0, 0, W, H)
      .setOrigin(0, 0)
      .setDepth(0)
      .setScrollFactor(0);   // fixed to camera — background never scrolls

    if (highPerf && scene.sys.game.renderer.type === Phaser.WEBGL) {
      this._generateHigh(scene, W, H, seed);
    } else {
      this._generatePerf(scene, W, H, seed);
    }

    this._image = scene.add.image(0, 0, '__nebula_rt__')
      .setOrigin(0, 0)
      .setDepth(0)
      .setScrollFactor(0);

    return this._image;
  }

  // ── PERF: CPU-drawn concentric circles ──────────────────────────────────

  private _generatePerf(
    scene: Phaser.Scene, W: number, H: number, seed: number
  ): void {
    const rng = lcg(seed);
    const g = scene.add.graphics();

    // Black fill
    g.fillStyle(0x000000, 1.0);
    g.fillRect(0, 0, W, H);

    // Nebula blobs — 4 large soft radial gradients via nested circles
    const blobColors = [0x1a0030, 0x001a2a, 0x1a0010, 0x0a0820];
    const blobAlphas = [0.04, 0.05, 0.06, 0.05, 0.03];
    for (let b = 0; b < 4; b++) {
      const bx = rng() * W;
      const by = rng() * H * 0.7;
      const br = 80 + rng() * 200;
      const col = blobColors[b % blobColors.length];
      for (let step = 0; step < 5; step++) {
        const r = br * (1.0 - step * 0.18);
        g.fillStyle(col, blobAlphas[step]);
        g.fillEllipse(bx, by, r * 2.2, r);
      }
    }

    // Small stars (80 stars)
    for (let i = 0; i < 80; i++) {
      const sx = rng() * W;
      const sy = rng() * H;
      const sa = 0.4 + rng() * 0.6;
      g.fillStyle(0xe0e8ff, sa);
      g.fillCircle(sx, sy, 1);
    }

    // Bright stars (10 stars with glow)
    for (let i = 0; i < 10; i++) {
      const sx = rng() * W;
      const sy = rng() * H;
      g.fillStyle(0xffffff, 0.12);
      g.fillCircle(sx, sy, 4);
      g.fillStyle(0xf0f0ff, 0.6);
      g.fillCircle(sx, sy, 2);
      g.fillStyle(0xffffff, 1.0);
      g.fillCircle(sx, sy, 1);
    }

    this._rt!.draw(g, 0, 0);
    this._rt!.saveTexture('__nebula_rt__');
    g.destroy();
  }

  // ── HIGH: WebGL shader baked to RenderTexture ───────────────────────────

  private _generateHigh(
    scene: Phaser.Scene, W: number, H: number, seed: number
  ): void {
    // Phaser's Shader game object renders the GLSL to the scene,
    // then we snapshot it into the RenderTexture and destroy the shader.
    // Register GLSL source in Phaser's shader cache, then create the object.
    // add.shader() accepts max 6 args — inline fragShader goes via cache.shader.add().
    if (!scene.cache.shader.has('__nebula_shader__')) {
      scene.cache.shader.add('__nebula_shader__', new Phaser.Display.BaseShader(
        '__nebula_shader__', NEBULA_FRAG,
      ));
    }
    const shader = scene.add.shader(
      '__nebula_shader__',
      W / 2, H / 2, W, H,
      [],
    );

    // Set uniforms — Phaser shader uniforms accessed via .setUniform()
    shader.setUniform('u_res.value', { x: W, y: H });
    shader.setUniform('u_seed.value', seed);

    // Render one frame to the RenderTexture
    this._rt!.draw(shader, 0, 0);
    this._rt!.saveTexture('__nebula_rt__');

    // Destroy shader — never runs again
    shader.destroy();
  }

  destroy(): void {
    this._image?.destroy();
    this._rt?.destroy();
    NebulaBackground._instance = null;
  }
}
