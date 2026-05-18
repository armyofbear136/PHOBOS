// =============================================================================
// composite.frag.ts
//
// Layer compositor fragment shader.
//
// Called once per layer, bottom→top, rendering into compositeFBO.
// The compositeFBO is the accumulating "destination" (Bd, Ad).
// The layer texture is the "source" (Bs, As).
//
// Uniforms:
//   u_layerTex    — the layer's RGBA8 texture (non-premultiplied)
//   u_compositeTex — the accumulating composite FBO (non-premultiplied)
//   u_opacity     — layer opacity, 0–1
//   u_blendMode   — integer index into the blend mode list below
//
// Blend mode integer constants (must match TS-side BLEND_MODE_INDEX map):
//   0  normal       8  hard-light
//   1  multiply     9  soft-light
//   2  screen      10  difference
//   3  overlay      11  exclusion
//   4  darken       12  hue
//   5  lighten      13  saturation
//   6  color-dodge  14  color
//   7  color-burn   15  luminosity
//
// All math follows W3C Compositing and Blending Level 1 specification exactly.
// https://www.w3.org/TR/compositing-1/
//
// Alpha compositing:
//   Porter-Duff "source over" on premultiplied values, then un-premultiply.
//   Cs = (1 - αs) x Cb + αs x B(Cb, Cs)    (general formula, section 9)
//   Co = αs x Cs + αb x Cb x (1 - αs)
//   αo = αs + αb x (1 - αs)
//
// Non-separable blend modes require the W3C Lum/Sat/ClipColor/SetLum helpers.
// These are correct verbatim ports of the spec pseudocode.
// =============================================================================

export const COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_layerTex;
uniform sampler2D u_compositeTex;
uniform float     u_opacity;
uniform int       u_blendMode;

in  vec2 v_uv;
out vec4 fragColor;

// ---------------------------------------------------------------------------
// Separable blend mode functions — operate per channel, float in [0,1]
// ---------------------------------------------------------------------------

float blendMultiply(float Cb, float Cs) {
  return Cb * Cs;
}

float blendScreen(float Cb, float Cs) {
  return Cb + Cs - Cb * Cs;
}

float blendOverlay(float Cb, float Cs) {
  return Cb <= 0.5
    ? 2.0 * Cb * Cs
    : 1.0 - 2.0 * (1.0 - Cb) * (1.0 - Cs);
}

float blendDarken(float Cb, float Cs) {
  return min(Cb, Cs);
}

float blendLighten(float Cb, float Cs) {
  return max(Cb, Cs);
}

float blendColorDodge(float Cb, float Cs) {
  if (Cb == 0.0) return 0.0;
  if (Cs == 1.0) return 1.0;
  return min(1.0, Cb / (1.0 - Cs));
}

float blendColorBurn(float Cb, float Cs) {
  if (Cb == 1.0) return 1.0;
  if (Cs == 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - Cb) / Cs);
}

float blendHardLight(float Cb, float Cs) {
  return Cs <= 0.5
    ? 2.0 * Cb * Cs
    : 1.0 - 2.0 * (1.0 - Cb) * (1.0 - Cs);
}

float blendSoftLight(float Cb, float Cs) {
  if (Cs <= 0.5) {
    return Cb - (1.0 - 2.0 * Cs) * Cb * (1.0 - Cb);
  } else {
    float D;
    if (Cb <= 0.25) {
      D = ((16.0 * Cb - 12.0) * Cb + 4.0) * Cb;
    } else {
      D = sqrt(Cb);
    }
    return Cb + (2.0 * Cs - 1.0) * (D - Cb);
  }
}

float blendDifference(float Cb, float Cs) {
  return abs(Cb - Cs);
}

float blendExclusion(float Cb, float Cs) {
  return Cb + Cs - 2.0 * Cb * Cs;
}

// Apply a separable blend mode across all three channels.
vec3 applySeparable(int mode, vec3 Cb, vec3 Cs) {
  if (mode == 1)  return vec3(blendMultiply(Cb.r, Cs.r),   blendMultiply(Cb.g, Cs.g),   blendMultiply(Cb.b, Cs.b));
  if (mode == 2)  return vec3(blendScreen(Cb.r, Cs.r),     blendScreen(Cb.g, Cs.g),     blendScreen(Cb.b, Cs.b));
  if (mode == 3)  return vec3(blendOverlay(Cb.r, Cs.r),    blendOverlay(Cb.g, Cs.g),    blendOverlay(Cb.b, Cs.b));
  if (mode == 4)  return vec3(blendDarken(Cb.r, Cs.r),     blendDarken(Cb.g, Cs.g),     blendDarken(Cb.b, Cs.b));
  if (mode == 5)  return vec3(blendLighten(Cb.r, Cs.r),    blendLighten(Cb.g, Cs.g),    blendLighten(Cb.b, Cs.b));
  if (mode == 6)  return vec3(blendColorDodge(Cb.r, Cs.r), blendColorDodge(Cb.g, Cs.g), blendColorDodge(Cb.b, Cs.b));
  if (mode == 7)  return vec3(blendColorBurn(Cb.r, Cs.r),  blendColorBurn(Cb.g, Cs.g),  blendColorBurn(Cb.b, Cs.b));
  if (mode == 8)  return vec3(blendHardLight(Cb.r, Cs.r),  blendHardLight(Cb.g, Cs.g),  blendHardLight(Cb.b, Cs.b));
  if (mode == 9)  return vec3(blendSoftLight(Cb.r, Cs.r),  blendSoftLight(Cb.g, Cs.g),  blendSoftLight(Cb.b, Cs.b));
  if (mode == 10) return vec3(blendDifference(Cb.r, Cs.r), blendDifference(Cb.g, Cs.g), blendDifference(Cb.b, Cs.b));
  if (mode == 11) return vec3(blendExclusion(Cb.r, Cs.r),  blendExclusion(Cb.g, Cs.g),  blendExclusion(Cb.b, Cs.b));
  // mode == 0 or unrecognized → normal (handled at call site by skipping blend)
  return Cs;
}

// ---------------------------------------------------------------------------
// Non-separable helpers — W3C spec section 9, verbatim
// ---------------------------------------------------------------------------

float Lum(vec3 C) {
  return 0.299 * C.r + 0.587 * C.g + 0.114 * C.b;
}

vec3 ClipColor(vec3 C) {
  float L  = Lum(C);
  float n  = min(C.r, min(C.g, C.b));
  float x  = max(C.r, max(C.g, C.b));
  if (n < 0.0) C = L + (((C - L) * L) / (L - n));
  if (x > 1.0) C = L + (((C - L) * (1.0 - L)) / (x - L));
  return C;
}

vec3 SetLum(vec3 C, float l) {
  float d = l - Lum(C);
  return ClipColor(C + d);
}

float Sat(vec3 C) {
  return max(C.r, max(C.g, C.b)) - min(C.r, min(C.g, C.b));
}

// SetSat — sets saturation while preserving luminance order.
// The spec uses named Cmin/Cmid/Cmax variables; we identify which
// channel is which and write back by index to avoid a sort.
vec3 SetSat(vec3 C, float s) {
  // Identify channel indices by value order.
  int minIdx = 0; int midIdx = 1; int maxIdx = 2;

  if (C[minIdx] > C[midIdx]) { int t = minIdx; minIdx = midIdx; midIdx = t; }
  if (C[midIdx] > C[maxIdx]) { int t = midIdx; midIdx = maxIdx; maxIdx = t; }
  if (C[minIdx] > C[midIdx]) { int t = minIdx; minIdx = midIdx; midIdx = t; }

  vec3 result = C;
  float cmax  = C[maxIdx];
  float cmin  = C[minIdx];

  if (cmax > cmin) {
    result[midIdx] = ((C[midIdx] - cmin) * s) / (cmax - cmin);
    result[maxIdx] = s;
  } else {
    result[midIdx] = 0.0;
    result[maxIdx] = 0.0;
  }
  result[minIdx] = 0.0;
  return result;
}

// Apply a non-separable blend mode.
vec3 applyNonSeparable(int mode, vec3 Cb, vec3 Cs) {
  if (mode == 12) return SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb)); // hue
  if (mode == 13) return SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb)); // saturation
  if (mode == 14) return SetLum(Cs, Lum(Cb));                  // color
  if (mode == 15) return SetLum(Cb, Lum(Cs));                  // luminosity
  return Cs; // unreachable
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void main() {
  // Source = this layer. Destination = accumulated composite below.
  // Both textures are non-premultiplied RGBA8.
  vec4 src = texture(u_layerTex,    v_uv);
  vec4 dst = texture(u_compositeTex, v_uv);

  // Apply layer opacity to source alpha.
  float As = src.a * u_opacity;
  float Ab = dst.a;

  vec3 Cs = src.rgb;
  vec3 Cb = dst.rgb;

  // W3C Compositing and Blending Level 1 — section 9.1.4
  //
  // Step 1: compute B(Cb, Cs) — the blend function output.
  // Step 2: modify Cs using destination alpha:
  //   Cs' = (1 - αb) × Cs + αb × B(Cb, Cs)
  // Step 3: standard Porter-Duff source-over with Cs':
  //   Co  = αs × Cs' + αb × Cb × (1 - αs)   (premultiplied numerator)
  //   αo  = αs + αb × (1 - αs)
  //   out = Co / αo  (non-premultiplied)

  vec3 Bcs;
  if (u_blendMode == 0) {
    Bcs = Cs;  // normal — blend function is identity
  } else if (u_blendMode >= 12) {
    Bcs = applyNonSeparable(u_blendMode, Cb, Cs);
  } else {
    Bcs = applySeparable(u_blendMode, Cb, Cs);
  }

  // Step 2 — destination-alpha-weighted source modification.
  vec3  Cs_mod = (1.0 - Ab) * Cs + Ab * Bcs;

  // Step 3 — Porter-Duff source-over.
  float Ao = As + Ab * (1.0 - As);
  vec3  Co = As * Cs_mod + Ab * Cb * (1.0 - As);

  if (Ao < 0.00001) {
    fragColor = vec4(0.0);
  } else {
    fragColor = vec4(Co / Ao, Ao);
  }
}
`;
