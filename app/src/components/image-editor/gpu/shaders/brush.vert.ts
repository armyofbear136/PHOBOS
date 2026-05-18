// =============================================================================
// brush.vert.ts
//
// Brush stamp vertex shader.
//
// Renders a single axis-aligned quad into the layer FBO.
// The quad is defined in physical pixel space (layer FBO dimensions).
//
// Attributes (per-vertex, 4 verts as a triangle strip):
//   a_position — vec2, physical pixel position in layer space
//   a_uv       — vec2, [0,1] UV within the stamp quad (for radial gradient)
//
// Uniforms:
//   u_resolution — vec2, layer FBO physical size in pixels (for NDC conversion)
//
// The vertex shader converts physical pixel coords to NDC for gl_Position,
// and passes UV through to the fragment shader unchanged.
// =============================================================================

export const BRUSH_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_position;  // physical pixel coord in layer FBO space
in vec2 a_uv;        // [0,1] within the stamp quad

uniform vec2 u_resolution;  // layer FBO size in physical pixels

out vec2 v_uv;

void main() {
  // Convert physical pixel position to NDC.
  // Physical px [0, resolution] → NDC [-1, 1].
  //
  // Our FBO convention: image top is at GL row 0 (bottom), because texSubImage2D
  // uploads source row 0 to GL row 0 without UNPACK_FLIP_Y. This is maintained
  // consistently across all passes. To stamp at the correct position we must NOT
  // flip Y here — physY=0 (image top) must map to ndc.y=-1 (GL bottom = row 0).
  vec2 ndc = (a_position / u_resolution) * 2.0 - 1.0;

  v_uv        = a_uv;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
