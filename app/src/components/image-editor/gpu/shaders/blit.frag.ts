// =============================================================================
// blit.frag.ts
//
// Final screen blit — combines checkerboard and composite in one pass.
//
// For each screen pixel:
//   1. Compute doc UV via pan/zoom transform.
//   2. If outside the document: discard — CSS background-color fills those areas.
//   3. If inside: draw checkerboard behind the composite (source-over).
//
// Replaces both the old checkerboard pass and the blit pass. One draw call,
// doc-clipped, no overdraw outside the document.
//
// Uniforms:
//   u_tex         — composited layer stack (doc-sized FBO, non-premultiplied)
//   u_screenToDoc — mat3: screen physical px → doc UV [0,1]
//   u_resolution  — vec2: screen drawing buffer size in physical pixels
// =============================================================================

export const BLIT_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform mat3      u_screenToDoc;
uniform vec2      u_resolution;

in  vec2 v_uv;
out vec4 fragColor;

const vec3  CHECKER_LIGHT = vec3(0.80, 0.80, 0.80);
const vec3  CHECKER_DARK  = vec3(0.62, 0.62, 0.62);
const float CHECKER_SIZE  = 8.0;  // doc physical pixels per checker tile

void main() {
  // Flip v_uv.y: GL bottom-left → top-left (CSS/canvas convention).
  vec2 uv       = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 screenPx = uv * u_resolution;

  // Map to doc UV [0,1] via pan/zoom inverse transform.
  vec3 docPos = u_screenToDoc * vec3(screenPx, 1.0);
  vec2 docUV  = docPos.xy;

  // Discard pixels outside the document boundary.
  // The container div's CSS background-color handles those areas.
  if (docUV.x < 0.0 || docUV.x > 1.0 || docUV.y < 0.0 || docUV.y > 1.0) {
    discard;
  }

  // Sample composited layer stack.
  vec4 composite = texture(u_tex, docUV);

  // Checkerboard in doc physical pixel space (fixed to the document, scales with zoom).
  // sx = u_screenToDoc[0][0] = 1/(scale*physW). docPhysPx = docUV / sx.
  float sx       = u_screenToDoc[0][0];
  float sy       = u_screenToDoc[1][1];
  vec2  docPhysPx = vec2(docUV.x / sx, docUV.y / sy);
  vec2  cell     = floor(docPhysPx / CHECKER_SIZE);
  float which    = mod(cell.x + cell.y, 2.0);
  vec3  checker  = mix(CHECKER_LIGHT, CHECKER_DARK, which);

  // Source-over: composite over checkerboard (non-premultiplied source).
  float As  = composite.a;
  vec3  rgb = composite.rgb * As + checker * (1.0 - As);

  // Always fully opaque within the document.
  fragColor = vec4(rgb, 1.0);
}
`;
