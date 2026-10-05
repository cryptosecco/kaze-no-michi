import * as THREE from 'three';

// Registry of uniforms shared by every patched material (same objects → one update reaches all shaders).
// Game.patchMaterial() merges these into each shader's uniforms at compile time.
export const GLOBAL_UNIFORMS = {};

export function registerGlobalUniforms(uniforms) {
  for (const k in uniforms) GLOBAL_UNIFORMS[k] = uniforms[k];
  return uniforms;
}

// Registers a GLSL chunk usable as `#include <name>` in any material.
export function registerChunk(name, glsl) {
  THREE.ShaderChunk[name] = glsl;
}

// Common hashing / noise helpers. Integer hashing (pcg) keeps per-instance randomness stable across GPUs.
registerChunk(
  'kaze_common',
  /* glsl */ `
#ifndef KAZE_COMMON
#define KAZE_COMMON
uniform sampler2D uNoiseTex;

uvec3 kazePcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 kazeHash3(ivec3 p) { return vec3(kazePcg3(uvec3(p))) * (1.0 / 4294967295.0); }
float kazeHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// 4-octave tileable fbm in ~[-1,1] from one texture fetch.
float kazeFbm(vec2 uv) { return dot(texture(uNoiseTex, uv), vec4(0.5333, 0.2667, 0.1333, 0.0667)); }
float kazeFbmLod(vec2 uv) { return dot(textureLod(uNoiseTex, uv, 0.0), vec4(0.5333, 0.2667, 0.1333, 0.0667)); }
vec4 kazeNoise4(vec2 uv) { return texture(uNoiseTex, uv); }
vec4 kazeNoise4Lod(vec2 uv) { return textureLod(uNoiseTex, uv, 0.0); }
#endif
`
);
