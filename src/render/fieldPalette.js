import { registerChunk } from './globals.js';

// Shared autumn-field palette (linear albedo) so grass blades and the terrain "canopy" colour seen at
// distance are the same function: fields read continuous from the player's feet to the horizon.
registerChunk(
  'kaze_field',
  /* glsl */ `
#ifndef KAZE_FIELD
#define KAZE_FIELD
#include <kaze_common>
// autumn susuki blades: amber and bronze, not lemon (the lit field is a red-amber with brown shadows)
const vec3 KZ_TIP_GOLD   = vec3(0.66, 0.34, 0.12);
const vec3 KZ_TIP_STRAW  = vec3(0.72, 0.5, 0.25);
const vec3 KZ_TIP_GREEN  = vec3(0.22, 0.25, 0.065);
const vec3 KZ_TIP_BRONZE = vec3(0.5, 0.19, 0.07);
const vec3 KZ_BASE       = vec3(0.05, 0.042, 0.014);
// the dry thatch at the foot of a dense field: dead leaves and stems, amber-brown (never black soil)
const vec3 KZ_THATCH     = vec3(0.17, 0.1, 0.045);
// susuki plumes: a near-neutral silver that the golden light turns pink-gold (a cream albedo turned yellow)
const vec3 KZ_PLUME      = vec3(0.85, 0.78, 0.71);
const vec3 KZ_LILY       = vec3(0.64, 0.022, 0.018);

// large patches (x) and medium patches (y) of colour variation
vec2 kazeFieldVar(vec2 xz) {
  return vec2(kazeFbmLod(xz * 0.0019 + vec2(0.31, 0.93)), kazeFbmLod(xz * 0.0105 + vec2(0.71, 0.17)));
}
vec3 kazeGrassTip(vec2 xz, float rnd) {
  vec2 v = kazeFieldVar(xz);
  float golden = smoothstep(-0.75, -0.25, v.x + 0.1);
  float bronze = smoothstep(0.05, 0.45, v.y) * 0.6;
  float pale = smoothstep(0.2, 0.55, -v.y) * 0.5;
  vec3 tip = mix(KZ_TIP_GOLD, KZ_TIP_STRAW, rnd);
  tip = mix(tip, KZ_TIP_BRONZE, bronze);
  tip = mix(tip, KZ_TIP_STRAW * 1.1, pale);
  return mix(KZ_TIP_GREEN, tip, golden);
}
// average colour of a grass canopy as seen from afar (blade tips dominate), with pampas and lilies
vec3 kazeFieldCanopy(vec2 xz, vec4 mask) {
  vec3 c = mix(KZ_BASE * 1.6, kazeGrassTip(xz, 0.45), 0.5);
  // plume density follows pampas mask^0.35 in the grass layers (Grass.js)
  c = mix(c, KZ_PLUME * 0.82, pow(mask.g, 0.35) * 0.4);
  c = mix(c, KZ_LILY, mask.b * 0.42);
  return c;
}
#endif
`
);

// Grazed lawns (up to 4 { x, z, r, s }, fed by Grass.setLawn through the shared uLawn uniform): lawn weight 0..1 at xz,
// full inside 60% of each radius. Used by the grass prepass, the terrain and the fallen leaves.
registerChunk(
  'kaze_lawn',
  /* glsl */ `
#ifndef KAZE_LAWN
#define KAZE_LAWN
uniform vec4 uLawn[4];
float kazeLawnAt(vec2 xz) {
  float l = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 z = uLawn[i];
    if (z.z <= 0.0) continue;
    l = max(l, (1.0 - smoothstep(z.z * 0.6, z.z, length(xz - z.xy))) * z.w);
  }
  return l;
}
#endif
`
);
