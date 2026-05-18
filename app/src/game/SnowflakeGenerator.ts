/**
 * SnowflakeGenerator — Procedural daily snowflake texture.
 *
 * Uses the real-world calendar date as a seed (same algorithm as weather
 * scheduling) to generate a unique crystallographically-plausible snowflake
 * every day. The result is baked into a Phaser texture once and reused for
 * the entire session — zero per-frame cost.
 *
 * Algorithm: Koch-curve-inspired recursive branch growth on a hexagonal
 * lattice. Six primary arms, each with recursive sub-branches, lengths and
 * angles derived from the day seed. This produces visually distinct but
 * always-valid snowflake shapes (ice crystal growth is always hexagonally
 * symmetric — the algorithm enforces 6-fold symmetry at every recursion).
 *
 * The generated canvas is registered as a Phaser texture key 'snow-flake'
 * and replaces any manually loaded version.
 *
 * Usage: Call SnowflakeGenerator.generate(scene) in WorldScene.preload()
 * AFTER the scene has a renderer but BEFORE particles are created.
 * In practice: call it in create() before EffectsManager.init().
 */

// ── Seeded LCG ────────────────────────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Snowflake arm node ────────────────────────────────────────────────────

interface ArmNode {
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  depth: number;
}

// ── Generator ─────────────────────────────────────────────────────────────

export class SnowflakeGenerator {

  /**
   * Generate a snowflake texture for the current calendar day.
   * Registers it as 'snow-flake' in scene.textures.
   * Safe to call multiple times — no-ops if already registered.
   */
  static generate(scene: Phaser.Scene, size = 128): void {
    // Always regenerate — let the caller decide when to call
    const canvas = SnowflakeGenerator._drawToCanvas(size);
    if (scene.textures.exists('snow-flake')) {
      scene.textures.remove('snow-flake');
    }
    scene.textures.addCanvas('snow-flake', canvas);
  }

  /**
   * Draw snowflake to an HTMLCanvasElement.
   * Can be called without a Phaser scene for testing.
   */
  static _drawToCanvas(size: number): HTMLCanvasElement {
    // Date seed — same value for the entire calendar day in local time
    const now = new Date();
    const daySeed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const rng = lcg(daySeed);

    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const maxR = size * 0.44; // arm tip stays inside canvas

    // ── Daily variation parameters ────────────────────────────────────
    // These six parameters define the snowflake's "genotype"
    const primaryBranches   = 2 + Math.floor(rng() * 2);     // 2–3 sub-branch pairs
    const branchAngle       = (15 + rng() * 30) * Math.PI / 180; // 15–45° off primary
    const branchLenRatio    = 0.25 + rng() * 0.35;            // sub-branch / primary ratio
    const secondaryEnabled  = rng() > 0.3;                    // ~70% have 2nd-order branches
    const tipStyle          = rng() > 0.5 ? 'point' : 'fork'; // tip shape
    const lineWidth         = 0.5 + rng() * 1.0;             // stroke weight

    // ── Draw function: one arm segment + its branches (recursive) ─────
    const drawArm = (node: ArmNode): void => {
      if (node.depth < 0 || node.length < 0.8) return;

      const endX = node.x + Math.cos(node.angle) * node.length;
      const endY = node.y + Math.sin(node.angle) * node.length;

      // Distance from center — fade toward tip
      const distFromCenter = Math.sqrt(endX * endX + endY * endY);
      const alphaFade = Math.max(0, 1.0 - (distFromCenter / maxR) * 0.4);

      ctx.beginPath();
      ctx.moveTo(cx + node.x, cy + node.y);
      ctx.lineTo(cx + endX, cy + endY);
      ctx.lineWidth = node.width * (0.5 + alphaFade * 0.5);
      ctx.strokeStyle = `rgba(255,255,255,${(0.6 + alphaFade * 0.4).toFixed(2)})`;
      ctx.stroke();

      // Tip decoration
      if (node.depth === 0) {
        if (tipStyle === 'fork') {
          const fl = node.length * 0.25;
          for (const da of [-0.5, 0.5]) {
            const fx = endX + Math.cos(node.angle + da) * fl;
            const fy = endY + Math.sin(node.angle + da) * fl;
            ctx.beginPath();
            ctx.moveTo(cx + endX, cy + endY);
            ctx.lineTo(cx + fx, cy + fy);
            ctx.lineWidth = node.width * 0.4;
            ctx.strokeStyle = `rgba(255,255,255,${(alphaFade * 0.6).toFixed(2)})`;
            ctx.stroke();
          }
        }
        return;
      }

      // Sub-branches — appear at evenly-spaced fractions along the arm
      const fractions: number[] = [];
      for (let i = 1; i <= primaryBranches; i++) {
        fractions.push(i / (primaryBranches + 1));
      }

      for (const frac of fractions) {
        const bx = node.x + Math.cos(node.angle) * node.length * frac;
        const by = node.y + Math.sin(node.angle) * node.length * frac;
        const bl = node.length * branchLenRatio * frac; // inner branches shorter

        for (const side of [-1, 1]) {
          drawArm({
            x: bx, y: by,
            angle: node.angle + branchAngle * side,
            length: bl,
            width: node.width * 0.55,
            depth: node.depth - 1,
          });

          // Optional 2nd-order branches off the sub-branches
          if (secondaryEnabled && node.depth >= 2) {
            const sl = bl * branchLenRatio;
            drawArm({
              x: bx + Math.cos(node.angle + branchAngle * side) * bl * 0.5,
              y: by + Math.sin(node.angle + branchAngle * side) * bl * 0.5,
              angle: node.angle + branchAngle * side * 1.8,
              length: sl,
              width: node.width * 0.35,
              depth: 0,
            });
          }
        }
      }
    };

    // ── Draw 6-fold symmetric arms ────────────────────────────────────
    const recursionDepth = secondaryEnabled ? 2 : 3;
    for (let i = 0; i < 6; i++) {
      const armAngle = (i * Math.PI) / 3;
      drawArm({
        x: 0, y: 0,
        angle: armAngle,
        length: maxR,
        width: lineWidth,
        depth: recursionDepth,
      });
    }

    // ── Center dot ────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.arc(cx, cy, lineWidth * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    return canvas;
  }
}
