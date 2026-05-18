// =============================================================================
// composite.vert.ts
//
// Fullscreen quad vertex shader for layer compositing.
// Driven by a hard-coded triangle that covers the viewport — no VBO needed.
// gl_VertexID 0,1,2 produces a CCW triangle large enough to cover NDC [-1,1].
//
// Outputs:
//   v_uv  — [0,1] texcoord for sampling the layer texture and composite FBO.
//           Origin is bottom-left in GL convention, matching texSubImage2D upload.
// =============================================================================

export const COMPOSITE_VERT = /* glsl */ `#version 300 es
precision highp float;

// Fullscreen triangle — no attributes. Vertices come from gl_VertexID.
// Triangle covers NDC: (-1,-1) (3,-1) (-1,3)
// The quad [0,1]×[0,1] UV space maps to the canvas.

out vec2 v_uv;

void main() {
  vec2 pos;
  if      (gl_VertexID == 0) { pos = vec2(-1.0, -1.0); }
  else if (gl_VertexID == 1) { pos = vec2( 3.0, -1.0); }
  else                       { pos = vec2(-1.0,  3.0); }

  v_uv        = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;
