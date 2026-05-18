// =============================================================================
// checkerboard.frag.ts
//
// Transparency checkerboard background shader.
//
// Rendered once per frame behind all layers into the screen framebuffer.
// Fills the canvas with alternating light/dark squares to indicate transparency.
//
// Uniforms:
//   u_resolution — vec2, canvas size in CSS pixels
//   u_transform  — mat3, pan/zoom transform (same as composite blit)
//   u_squareSize — float, checker square size in CSS pixels (typically 8.0)
//
// The checkerboard is computed in document space (pre-transform) so it stays
// fixed to the document origin and scales/pans with the content.
// =============================================================================

export const CHECKERBOARD_FRAG = /* glsl */ `#version 300 es
precision mediump float;

uniform vec2  u_resolution;
uniform mat3  u_transform;   // canvas-space → document-space (inverse of pan/zoom)
uniform float u_squareSize;

in  vec2 v_uv;
out vec4 fragColor;

// Checker colours — match Photoshop / standard transparency grid.
const vec3 LIGHT = vec3(0.8,  0.8,  0.8);
const vec3 DARK  = vec3(0.62, 0.62, 0.62);

void main() {
  // v_uv origin is GL bottom-left. Flip Y so canvasPx has (0,0) at top-left,
  // matching the CSS coordinate convention used by the pan/zoom transform.
  vec2 uv       = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 canvasPx = uv * u_resolution;

  // Apply inverse transform to get document-space position.
  // u_transform maps document→canvas; we need canvas→document.
  // The inverse is passed in directly so we avoid computing it per-fragment.
  vec3 docPos = u_transform * vec3(canvasPx, 1.0);

  // Checker pattern in document space.
  vec2  cell  = floor(docPos.xy / u_squareSize);
  float which = mod(cell.x + cell.y, 2.0);

  fragColor = vec4(mix(LIGHT, DARK, which), 1.0);
}
`;
