// =============================================================================
// brush.frag.ts
//
// Brush stamp fragment shader.
//
// Computes a soft round brush stamp analytically from v_uv.
// UV (0,0) is top-left of the quad, (0.5,0.5) is the stamp center.
//
// Uniforms:
//   u_color    — vec4, brush color in linear RGBA (pre-converted from sRGB)
//   u_hardness — float [0,1], controls the inner opaque radius
//   u_opacity  — float [0,1], overall brush opacity
//
// The hardness model matches PaintBrushTool._ensureStamp() exactly:
//   - Inside the hardness radius the stamp is fully opaque.
//   - From the hardness radius to the brush edge, opacity falls off smoothly.
//   - At the quad edge (dist == 0.5 in UV space) opacity is exactly 0.
//
// Composited into the layer FBO with standard source-over blending.
// The layer FBO uses non-premultiplied RGBA8 (matching OffscreenCanvas pixel format).
// GL blend state must be set to:
//   gl.blendEquation(gl.FUNC_ADD)
//   gl.blendFuncSeparate(
//     gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,   // RGB
//     gl.ONE,       gl.ONE_MINUS_SRC_ALPHA,   // A
//   )
// =============================================================================

export const BRUSH_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec4  u_color;     // RGBA, [0,1] per channel
uniform float u_hardness;  // [0,1]
uniform float u_opacity;   // [0,1]

in  vec2 v_uv;
out vec4 fragColor;

void main() {
  // Distance from stamp center in UV space. Stamp radius = 0.5.
  vec2  centered = v_uv - 0.5;
  float dist     = length(centered);

  // Analytical anti-aliasing at the circle boundary.
  // fwidth(dist) is the screen-space footprint of dist across one fragment —
  // it accounts for zoom level, brush size, and DPR automatically.
  // We blend from fully opaque to fully transparent across this one-fragment
  // band instead of hard-discarding. Eliminates the staircase at all zoom levels.
  float fw    = fwidth(dist);
  float edge  = smoothstep(0.5, 0.5 - fw, dist);

  if (edge <= 0.0) discard;

  // Normalised distance within the circle: 0 = center, 1 = edge.
  float t = dist * 2.0;  // [0, 1]

  // Hardness controls the inner fully-opaque radius.
  // Clamp to [0, 0.999] to avoid divide-by-zero at hardness == 1.
  float h = clamp(u_hardness, 0.0, 0.999);

  float alpha;
  if (t <= h) {
    alpha = 1.0;
  } else {
    // Smooth cubic falloff from 1 at the hardness boundary to 0 at the edge.
    // smoothstep produces the S-curve (3t² - 2t³) that Photoshop/paint.net use —
    // much softer and more natural than linear, no visible gradient banding.
    float tn = (t - h) / (1.0 - h);  // remap [h,1] → [0,1]
    alpha = 1.0 - smoothstep(0.0, 1.0, tn);
  }

  // Multiply by edge to apply the anti-aliased circle boundary.
  alpha *= edge * u_opacity;

  fragColor = vec4(u_color.rgb, u_color.a * alpha);
}
`;