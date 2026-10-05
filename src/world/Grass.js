import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GLOBAL_UNIFORMS, registerGlobalUniforms } from '../render/globals.js';
import { rng } from '../core/math.js';
import '../render/fieldPalette.js';
import { BLADE_ARC_GLSL, STALK_BEND_GLSL, PLUME_LENS_GLSL } from './grassBend.js';

// GPU grass for Hoshigashima.
// Each layer is one InstancedBufferGeometry drawn as a toroidal patch around the camera: instance i owns
// the lattice of world spots  aOffset + k * patchSize  and always renders the copy nearest the viewer,
// so blades never swim; randomness is hashed from (tile k, instance id) → stable per world spot.
// Layers:  near blades (dense, curved, 9 verts) · mid blades (sparse, wide, 3 verts)
//          susuki pampas (stalk + 3 feathery plume cards) · red spider lilies (stem + flower cards)
// All extend MeshStandardMaterial → sun cascades, IBL and atmosphere for free; a custom RE_Direct adds
// wrap lighting + backlit translucency (the golden-hour glow) + baked terrain sun visibility.
// Performance: a per-frame GPU prepass evaluates the expensive per-instance data once per blade
// (terrain height, baked sun visibility, wind bend, masks, tip colour, clump) into a 3-target float texture;
// every vertex then reads it with 3 texelFetch instead of re-sampling ~9 textures.

const U = registerGlobalUniforms({
  uPlayer: { value: new THREE.Vector4(0, -1000, 0, 0.9) }, // xyz position, w interaction radius
  uPlumeGlow: { value: new THREE.Color(0.35, 0.3, 0.3) }, // skylight scattered inside pampas plumes
  // up to 8 trampled zones (x, z, radius, strength): blades part and flatten around actors / arenas
  uTrample: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  // up to 4 grazed lawns (x, z, radius, strength): short grass, no susuki or lilies (e.g. the camp ground)
  uLawn: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  // view wedge for per-instance culling: xy = camera forward (XZ, unit), z = cos(half angle), w = enabled
  uGrassView: { value: new THREE.Vector4(0, -1, -1, 0) },
});
const _fwd = new THREE.Vector3();

const VERT_PARS = /* glsl */ `
#include <kaze_common>
#include <kaze_wind>
#include <kaze_terrain>
#include <kaze_field>
attribute vec2 aOffset;
uniform vec3 uGrassCenter;
uniform vec4 uGrassPatch;   // x patch size, y inner radius, z outer radius, w density scale
uniform vec4 uGrassShape;   // x height scale, y width scale, z far keep fraction, w pixel angle
uniform float uGrassCell;
uniform vec4 uGrassView;
uniform highp sampler2D uInst0;
uniform highp sampler2D uInst1;
uniform highp sampler2D uInst2;
uniform highp sampler2D uInst3;
uniform int uInstN;
varying vec3 vGrassColor;
varying vec4 vGrassData;    // x t along blade, y ao, z sheen (gust), w baked sun visibility
varying vec3 vGrassUv;      // cards: uv + part id
varying float vGrassFade;   // pampas plumes: dissolve near the lens

// Horizontal view-wedge culling: the toroidal patches surround the camera but only ~1/4 of them is on screen;
// instances outside the wedge (beyond 6 m) bail out before any texture fetch.
bool kzOutsideView(vec2 xz) {
  if (uGrassView.w < 0.5) return false;
  vec2 d = xz - uGrassCenter.xz;
  float l = length(d);
  return l > 6.0 && dot(d, uGrassView.xy) < uGrassView.z * l;
}
`;

// Locate an instance in the world (pure ALU, identical in the prepass and in the vertex shader):
// toroidal tile k, stable hashes per (tile, instance), jittered world position.
const LOCATE = /* glsl */ `
  vec2 kzOrigin = uGrassCenter.xz - 0.5 * uGrassPatch.x;
  vec2 kzK = ceil((kzOrigin - kzOffset) / uGrassPatch.x);
  ivec2 kzKi = ivec2(kzK);
  vec3 r1 = kazeHash3(ivec3(kzId, kzKi.x + 5003, kzKi.y + 7919));
  vec3 r2 = kazeHash3(ivec3(kzKi.x * 31 + 17, kzId * 3 + 1, kzKi.y * 131 + 5));
  vec3 r3 = kazeHash3(ivec3(kzKi.y * 17 + 3, kzKi.x * 71 + 11, kzId * 7 + 2));
  vec2 kzXZ = kzOffset + kzK * uGrassPatch.x + (r2.xy - 0.5) * uGrassCell;
`;

// Per-frame instance prepass: one fragment per instance writes the expensive samples.
const PREPASS_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const PREPASS_FRAG = /* glsl */ `
#include <kaze_common>
#include <kaze_wind>
#include <kaze_terrain>
#include <kaze_field>
#include <kaze_lawn>
uniform highp sampler2D uOffsetTex;
uniform vec3 uGrassCenter;
uniform vec4 uGrassPatch;
uniform float uGrassCell;
uniform int uInstN;
uniform vec4 uGrassView;
uniform vec4 uPlayer;
uniform vec4 uTrample[8];

// Horizontal view-wedge culling: the toroidal patches surround the camera but only ~1/4 of them is on screen;
// instances outside the wedge (beyond 6 m) bail out before any texture fetch.
bool kzOutsideView(vec2 xz) {
  if (uGrassView.w < 0.5) return false;
  vec2 d = xz - uGrassCenter.xz;
  float l = length(d);
  return l > 6.0 && dot(d, uGrassView.xy) < uGrassView.z * l;
}
layout(location = 0) out highp vec4 oInst0;
layout(location = 1) out highp vec4 oInst1;
layout(location = 2) out highp vec4 oInst2;
layout(location = 3) out highp vec4 oInst3;
void main() {
  ivec2 kzIJ = ivec2(gl_FragCoord.xy);
  int kzId = kzIJ.y * uInstN + kzIJ.x;
  vec2 kzOffset = texelFetch(uOffsetTex, kzIJ, 0).rg;
  ${LOCATE}
  if (kzOutsideView(kzXZ)) {
    oInst0 = vec4(0.0);
    oInst1 = vec4(0.0);
    oInst2 = vec4(0.0);
    oInst3 = vec4(0.0);
    return;
  }
  float kzH0 = kazeTerrainHeightFast(kzXZ);
  oInst0 = vec4(kzH0, kazeTerrainLight(kzXZ).r, kazeWindBend(kzXZ));
  oInst1 = kazeTerrainMask(kzXZ);
  oInst2 = vec4(kazeGrassTip(kzXZ, r3.x), kazeFbmLod(kzXZ * 0.21 + vec2(0.37, 0.91)));
  // interaction, once per instance: blades part around the player and flatten in trampled zones
  vec2 kzDp = kzXZ - uPlayer.xz;
  float kzDpl = length(kzDp);
  float kzPush = (1.0 - smoothstep(0.1, uPlayer.w, kzDpl)) * step(abs(kzH0 - uPlayer.y), 3.0);
  vec2 kzPushV = (kzDp / max(kzDpl, 1e-3)) * kzPush * 1.2;
  float kzFlat = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 tz = uTrample[i];
    if (tz.z <= 0.0) continue;
    vec2 td = kzXZ - tz.xy;
    float tl = length(td);
    float tf = (1.0 - smoothstep(tz.z * 0.35, tz.z, tl)) * tz.w;
    kzPushV += (td / max(tl, 1e-3)) * tf * 0.8;
    kzFlat = max(kzFlat, tf);
  }
  oInst3 = vec4(kzPushV, kzFlat, kazeLawnAt(kzXZ));
}
`;

// Shared vertex prologue: locate, then read the prepass data for this instance.
const VERT_COMMON = /* glsl */ `
  vec2 kzOffset = aOffset;
  int kzId = gl_InstanceID;
  ${LOCATE}
  if (kzOutsideView(kzXZ)) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // outside the clip volume for both depth conventions
    return;
  }
  ivec2 kzIJ = ivec2(kzId % uInstN, kzId / uInstN);
  vec4 kzI0 = texelFetch(uInst0, kzIJ, 0);
  vec4 kzMask = texelFetch(uInst1, kzIJ, 0);
  vec4 kzI2 = texelFetch(uInst2, kzIJ, 0);
  float kzH0 = kzI0.x;
  vec3 kzTip = kzI2.rgb;
  float kzClump = kzI2.a;
  float kzDist = distance(kzXZ, uGrassCenter.xz);
  float kzOuter = uGrassPatch.z, kzInner = uGrassPatch.y;
  float kzThin = mix(1.0, uGrassShape.z, smoothstep(kzOuter * 0.15, kzOuter, kzDist));
  float kzFadeOut = 1.0 - smoothstep(kzOuter - 9.0, kzOuter, kzDist);
  float kzFadeIn = kzInner > 0.0 ? smoothstep(kzInner - 9.0, kzInner, kzDist) : 1.0;
  float kzAlive = step(r1.z, kzFadeOut) * step(1.0 - r1.z, kzFadeIn);
  vec2 kzWind = kzI0.zw;
  float kzGustL = length(kzWind);
  vec2 kzWindN = kzWind / max(kzGustL, 1e-3);
  // this plant's share of a passing gust front, 0 in a lull .. 1 in a front, and the sheen it brings (both per
  // instance, from the prepass's wind bend)
  float kzGustN = smoothstep(0.26, 0.95, kzGustL);
  float kzSheen = smoothstep(0.35, 0.9, kzGustL);
  // interaction (player push + trampled zones), precomputed per instance by the prepass
  vec4 kzI3 = texelFetch(uInst3, kzIJ, 0);
  vec2 kzPushV = kzI3.xy;
  float kzFlat = kzI3.z;
  float kzLawn = kzI3.w;
  float kzSunVis = kzI0.y;
  vGrassFade = 1.0;
`;

// Curved tapered blade (near + mid rings).  position.x = side (-1..1), position.y = t (0..1)
const VERT_BLADE = /* glsl */ `
  float t = position.y;
  float side = position.x;
  // tufts: density and height clump at ~1–3 m scale
  float clump = kzClump;
  float thatch = 0.0;
#ifdef GRASS_MID
  float keep = kzMask.r * uGrassPatch.w * kzThin * (1.0 - kzMask.a) * clamp(0.62 + clump * 1.1, 0.15, 1.35);
  kzAlive *= step(r1.x, keep);
  float kzHeight = mix(0.6, 1.15, r1.y) * uGrassShape.x * (1.0 + kzMask.g * 0.6) * (0.85 + 0.3 * clump) * (1.0 - 0.52 * kzLawn);
  float kzWidth = mix(0.14, 0.24, r2.z) * uGrassShape.y;
#else
  // close up the field stays full between its tufts (no bare patches of ground)
  float keep = kzMask.r * uGrassPatch.w * kzThin * (1.0 - kzMask.a) * clamp(0.8 + clump * 0.9, 0.45, 1.35);
  // grazed lawn: a dense turf gathered in irregular tufts (the clump noise) instead of the field's thinning
  keep = mix(keep, kzMask.r * (1.0 - kzMask.a) * uGrassPatch.w * (0.6 + 1.0 * smoothstep(-0.3, 0.35, clump)), kzLawn);
  kzAlive *= step(r1.x, keep);
  // three storeys: a short dry thatch bent over the ground, the body of the field, a few tall leaves
  float st = r1.y;
  thatch = step(st, 0.3);
  float kzHeight = st < 0.3 ? mix(0.2, 0.42, st / 0.3) : (st < 0.9 ? mix(0.5, 0.95, (st - 0.3) / 0.6) : mix(1.0, 1.15, (st - 0.9) / 0.1));
  kzHeight *= uGrassShape.x * mix(0.7, 1.12, kzMask.r) * (1.0 + kzMask.g * 0.3) * (0.82 + 0.3 * clump);
  // blades right at the lens (a low camera in the grass) stay below it instead of striping the frame
  kzHeight *= mix(0.55, 1.0, smoothstep(0.4, 1.4, kzDist));
  float kzWidth = mix(0.02, 0.038, r2.z) * (1.0 + 0.45 * thatch) * uGrassShape.y / sqrt(max(kzThin, 0.08));
  // the lawn's turf: uneven, taller in its tufts, a few long blades standing above it, finer blades
  kzHeight = mix(kzHeight, mix(0.12, 0.34, r1.y) * (0.65 + 0.75 * smoothstep(-0.3, 0.45, clump)) * (r3.x > 0.88 ? 1.6 : 1.0), kzLawn);
  kzWidth = mix(kzWidth, mix(0.024, 0.04, r2.z) * uGrassShape.y, kzLawn);
  thatch *= 1.0 - kzLawn;
#endif
  kzWidth = max(kzWidth, kzDist * uGrassShape.w);
  kzHeight *= kzAlive * (1.0 - 0.5 * kzFlat);
  float ang = r3.z * 6.2831853;
  vec2 across = vec2(cos(ang), sin(ang));
  vec2 facing = vec2(-across.y, across.x);
  vec2 leanDir = vec2(cos(r2.x * 6.2831853), sin(r2.x * 6.2831853));
  // in a lull the blades hold still, leaning in the steady breeze (the stillness between the fronts is what lets
  // the eye see the bands roll in); a front sets them fluttering, fast and wide
  float kzPh = r3.y * 37.0 + dot(kzXZ, vec2(0.61, 0.37));
  float fl = sin(uTime * (4.2 + r3.y * 3.8) + kzPh) * 0.13 * kzGustN * kzGustN;
  vec2 D = leanDir * mix(0.06 + 0.28 * r2.y, 0.75 + 0.5 * r2.y, thatch) + kzWind * (0.55 + 0.4 * r3.y) + kzPushV;
  D += vec2(-kzWindN.y, kzWindN.x) * fl;
  // the blade bows in an arc of constant length, its tip leaning further from the vertical the stronger the bend |D|
  // and never past ~86° (grassBend.js): a gust lays it over instead of stretching it into a needle, and the tip stays
  // above the root, so a blade bent uphill clears the slope. Trampling, stiffness, flutter and lean all arrive in D.
  float kzReach, kzRise;
  vec2 kzDir;
  float Dl = length(D);
  kzBladeArc(Dl, t, kzReach, kzRise, kzDir);
  vec2 Dn = D / max(Dl, 1e-4);
  float taper = pow(max(1.0 - t, 0.0), 0.85);
  vec3 kzPos;
  kzPos.xz = kzXZ + Dn * (kzHeight * kzReach) + across * (side * kzWidth * 0.5 * taper);
  kzPos.y = kzH0 - 0.04 + kzHeight * kzRise;
  // normal: blade plane normal, bent with the curve, turned toward the viewer, softened toward up
  vec3 tang = vec3(Dn.x * kzDir.x, kzDir.y, Dn.y * kzDir.x);
  vec3 bn = vec3(facing.x, 0.0, facing.y);
  bn = normalize(bn - tang * dot(bn, tang));
  vec3 toCam = cameraPosition - kzPos;
  bn *= sign(dot(bn, toCam) + 1e-4);
  bn = normalize(bn + vec3(across.x, 0.0, across.y) * side * 0.35);
  vec3 objectNormal = normalize(mix(bn, vec3(0.0, 1.0, 0.0), 0.52));
  // colour: dark base → olive middle → gold/straw tip
  vec3 tip = kzTip;
#ifdef GRASS_MID
  tip = mix(tip, KZ_PLUME * 0.95, kzMask.g * 0.72);
#else
  tip = mix(tip, KZ_PLUME * 0.9, kzMask.g * 0.18);
#endif
  // a few blades stay green, a few are bleached pale straw; grazed lawns regrow green
  float kind = r3.x;
  tip = mix(tip, KZ_TIP_GREEN * vec3(1.5, 1.45, 1.3), kzLawn * 0.85);
  tip = mix(tip, KZ_TIP_GREEN * 1.2, step(0.9, kind) * 0.7);
  tip = mix(tip, KZ_TIP_STRAW * 1.12, step(kind, 0.08) * 0.8);
  // the thatch storey is dead grass: pale straw, duller
  tip = mix(tip, KZ_TIP_STRAW * vec3(0.85, 0.72, 0.58), thatch * 0.6);
  vec3 midc = tip * vec3(0.52, 0.5, 0.36) + vec3(0.0, 0.012, 0.0);
#ifdef GRASS_MID
  vec3 col = mix(midc * 0.7, tip, smoothstep(0.0, 1.0, t));
#else
  // foot of the blade: amber-brown thatch in the field, dark olive in a lawn (no black soil between the stems)
  vec3 foot = mix(KZ_THATCH, KZ_TIP_GREEN * 0.55, kzLawn);
  vec3 col = mix(foot, midc, smoothstep(0.0, 0.45, t));
#endif
  col = mix(col, tip, smoothstep(0.5, 1.0, t));
  col *= mix(0.62 + 0.55 * r1.y, 0.8 + 0.3 * r2.y, thatch);
  vGrassColor = col;
  // lower parts of the blades are shaded by the canopy around them (by height above the ground, so the short
  // thatch sits in the shade of the tall blades)
#ifdef GRASS_MID
  float selfShadow = mix(0.7, 1.0, t);
  float kzAo = mix(0.12, 1.0, smoothstep(0.0, 0.8, t));
#else
  float kzLit = mix(smoothstep(0.04, 0.75, kzHeight * t), 1.0, kzLawn * 0.7);
  float selfShadow = mix(mix(0.42, 1.0, kzLit), 1.0, 1.0 - kzMask.r);
  float kzAo = mix(0.26, 1.0, kzLit);
#endif
  vGrassData = vec4(t, kzAo, kzSheen * t, kzSunVis * selfShadow);
  vGrassUv = vec3(0.0);
`;

// Susuki helpers, declared above main(): the stalk's response to the wind and the plant's dissolve near the lens
// (grassBend.js: the same functions run in node, in scripts/grassbend.test.mjs).
const PAMPAS_PARS = STALK_BEND_GLSL + PLUME_LENS_GLSL;

// Susuki pampas: a thin stalk (part 0, position = side,t) + the plume (part 1..n, position = u,s).
// The plume carries on the stalk's arc from its tip and curls further downwind (more in a gust), nodding a
// little at its end: a quadratic curve from the node. Near layer (PAMPAS_STRIPS > 1): one feathered strip per
// raceme, opening from the node into a fan; far layer: one feathered card for the whole plume. Every strip and
// the stalk turn around their own axis to face the camera, so no plume is ever seen as a card on edge.
const VERT_PAMPAS = /* glsl */ `
  float part = uv.y;
  // susuki grows in tussocks: the plumes gather in clumps (the ~5 m clump noise) with thinner ground between them, and
  // stand taller where they crowd, instead of an even carpet of identical plumes
  float tuss = smoothstep(-0.35, 0.3, kzClump);
  // the plumes thin out gently where the pampas mask is low (the field's edges) instead of vanishing
  float keep = pow(kzMask.g, 0.35) * uGrassPatch.w * kzThin * (1.0 - kzLawn) * mix(0.3, 1.3, tuss);
  kzAlive *= step(r1.x, keep);
  // trampled ground (the duel arena, around actors): the stalks go down and only the grass stands; each plant
  // shrinks away over its own short band of the trampling, so a walking actor never pops plumes on and off
  kzAlive *= clamp((1.0 - smoothstep(0.3, 0.62, kzFlat) - 0.75 * r3.y) * 4.0, 0.0, 1.0);
  // no two plants alike: short and tall stalks, small and long plumes, most upright and a few leaning far over; the
  // plumes nod just above the blades rather than standing on tall poles
  float stalkH = mix(0.95, 1.95, r1.y) * mix(0.8, 1.12, tuss) * uGrassShape.x * kzAlive * (1.0 - 0.35 * kzFlat);
  float plumeL = mix(0.5, 1.1, r2.z) * uGrassShape.x * kzAlive;
  vec2 leanDir = vec2(cos(r2.x * 6.2831853), sin(r2.x * 6.2831853));
  // still in a lull (like the blades), a fast swing in a front
  float kzPh = r3.y * 23.0 + dot(kzXZ, vec2(0.41, 0.27));
  float fl = sin(uTime * (2.6 + r3.y * 2.0) + kzPh) * 0.12 * kzGustN;
  vec2 D = leanDir * (0.03 + 0.36 * r2.y * r2.y) + kzWind * (0.62 + 0.35 * r3.y) + kzPushV * 0.8;
  D += vec2(-kzWindN.y, kzWindN.x) * fl;
  // the stalk is stiff: its bend saturates, and only ever grows with the gust (a front can't lay it down into the
  // grass, where its plume would seem to float stalkless in mid-air, nor straighten it again at the gust's peak); the
  // soft plume takes the rest of the gust (Tend below)
  float kzDl = length(D);
  D *= kzStalkBend(kzDl) / max(kzDl, 1e-4);
  float dd = dot(D, D);
  vec3 kzPos;
  vec3 objectNormal;
  // stalk: xz = base + D·H·t², y = base + H·t·(1 − 0.36·|D|²·t)
  vec2 tipXZ = kzXZ + D * stalkH;
  vec3 tipPos = vec3(tipXZ.x, kzH0 - 0.05 + stalkH * (1.0 - 0.36 * dd), tipXZ.y);
  vec3 tipTan = normalize(vec3(D.x * 2.0, 1.0 - 0.72 * dd, D.y * 2.0) + vec3(0.0, 1e-4, 0.0));
  vec3 W3 = vec3(kzWindN.x, 0.0, kzWindN.y);
  vec3 P3 = vec3(-kzWindN.y, 0.0, kzWindN.x);
  float gust = min(kzGustL, 1.5);
  // end direction of the arch: the stalk's own direction curled well downwind (more in a gust) and drooping
  // under the plume's weight, fluttering sideways with the stalk
  vec3 Tend = normalize(tipTan * 0.7 + W3 * (0.3 + 0.35 * gust) + vec3(0.0, -(0.06 + 0.36 * r3.y), 0.0) + P3 * (fl * 3.0));
  vec3 C = tipTan * (0.5 * plumeL);
  vec3 E = C + Tend * (0.5 * plumeL);
  // near the lens a plume at eye height would fill the frame, and one streaming downwind from a plant beside or behind
  // the camera (the guiding wind blows from behind it) sweeps right across the view: so the plant (plume and stalk)
  // dissolves within ~3.6 m of the part of it nearest the camera, the node, the middle of the plume or its end, not of
  // the stalk's tip alone (the ones a raised camera looks down on, a field shot's foreground, stay whole down to ~1 m),
  // and a plume that would span half the frame's height lets go, however far it is. Each part fades on its own and the
  // plant by the least of them: every input moves smoothly with the wind, so the dissolve is gradual in time.
  float kzLens = kzPlantLens(tipPos - cameraPosition, C, E, plumeL);
  if (part < 0.5) {
    float t = position.y, side = position.x;
    kzPos.xz = kzXZ + D * (stalkH * t * t);
    kzPos.y = kzH0 - 0.05 + stalkH * t * (1.0 - 0.36 * dd * t);
    vec3 stT = normalize(vec3(2.0 * t * D.x, 1.0 - 0.72 * dd * t, 2.0 * t * D.y) + vec3(0.0, 1e-4, 0.0));
    vec3 toC = cameraPosition - kzPos;
    float camD = length(toC);
    // a thin stem that stays visible close to the camera (it goes only with its dissolving plume, or within
    // the last decimetres before the lens)
    float w = max(mix(0.012, 0.02, r3.x) * uGrassShape.y, camD * uGrassShape.w) * (1.0 - 0.45 * t) * smoothstep(0.15, 0.45, camD) * kzLens;
    vec3 sd = cross(stT, toC);
    float sdl = length(sd);
    sd = sdl > 1e-5 ? sd / sdl : vec3(1.0, 0.0, 0.0);
    kzPos += sd * (side * w * 0.5 * kzAlive);
    vec3 bn = normalize(cross(sd, stT) + 1e-5);
    bn *= sign(dot(bn, toC) + 1e-4);
    objectNormal = normalize(mix(bn, vec3(0.0, 1.0, 0.0), 0.45));
    vGrassColor = mix(vec3(0.1, 0.07, 0.025), vec3(0.58, 0.44, 0.19), smoothstep(0.05, 0.9, t));
    vGrassData = vec4(t, mix(0.35, 1.0, t), 0.0, kzSunVis);
    vGrassUv = vec3(0.0);
  } else {
    float u = position.x, s = position.y;
    // frame at the node for the splay of the racemes (P3 is horizontal, never along the stalk tangent)
    vec3 B2 = normalize(cross(P3, tipTan));
    vec3 B1 = cross(tipTan, B2);
#if PAMPAS_STRIPS > 1
    vec3 rk = kazeHash3(ivec3(kzId, int(part) * 131 + 7, kzKi.x * 7 + kzKi.y * 3));
    float lk = mix(0.8, 1.0, rk.x);
    float phi = (part - 1.0 + 0.2 + 0.6 * rk.y) * (6.2831853 / float(PAMPAS_STRIPS)) + r3.z * 6.2831853;
    // the racemes open from the node into a fan; a strong gust combs them together
    float splay = mix(0.04, 0.22, rk.z) * (1.0 - 0.3 * min(gust, 1.0));
    float wS = mix(0.065, 0.12, rk.x) * uGrassShape.y;
#else
    float lk = 1.0, phi = 0.0, splay = 0.0;
    float wS = mix(0.11, 0.21, r1.y) * uGrassShape.y;
#endif
    // lanceolate: narrow at the node, full before the middle, a soft point at the end
    float prof = sin(3.14159 * pow(s, 0.72)) * (1.0 - 0.2 * s) + 0.1 * (1.0 - s);
    vec3 sp = B1 * cos(phi) + B2 * sin(phi);
    float x = s * lk;
    vec3 Q = tipPos + (2.0 * (1.0 - x) * x) * C + (x * x) * E + sp * (splay * plumeL * x * (1.0 - 0.3 * x));
    vec3 T = normalize(lk * (2.0 * (1.0 - x) * C + 2.0 * x * (E - C)) + sp * (splay * plumeL * lk * (1.0 - 0.6 * x)) + vec3(0.0, 1e-5, 0.0));
    vec3 V = cameraPosition - Q;
    vec3 side = cross(T, V);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : B1;
    kzPos = Q + side * (u * wS * prof * 0.5 * kzAlive);
    vec3 cn = normalize(cross(side, T));
    cn *= sign(dot(cn, V) + 1e-4);
    objectNormal = normalize(cn + side * (u * 0.55) + vec3(0.0, 0.25, 0.0));
    // each plant its own shade and tint, from rosy to silver
    vec3 plume = KZ_PLUME * mix(0.3, 0.56, r3.x) * mix(vec3(1.0, 0.93, 0.88), vec3(0.93, 0.97, 1.0), r2.y);
    plume = mix(plume * vec3(0.82, 0.62, 0.56), plume, smoothstep(0.0, 0.6, s)); // rosy-brown node, silver ends
    vGrassColor = plume;
    vGrassData = vec4(1.0, mix(0.7, 1.0, s), kzSheen * 0.6 * s, kzSunVis);
    vGrassUv = vec3(u, max(s, 1e-3), r2.y * 17.0 + part * 3.1);
    vGrassFade = kzLens;
  }
`;

// Red spider lily: stem (part 0) + two crossed flower cards (part 1, 2)
const VERT_LILY = /* glsl */ `
  float part = uv.y;
  float keep = kzMask.b * uGrassPatch.w * kzThin * (1.0 - kzLawn);
  kzAlive *= step(r1.x, keep);
  float stemH = mix(0.34, 0.55, r1.y) * kzAlive * (1.0 - 0.6 * kzFlat);
  float headR = mix(0.1, 0.15, r2.z) * kzAlive;
  vec2 D = kzWind * 0.22 + kzPushV * 0.6;
  vec2 tipXZ = kzXZ + D * stemH;
  vec3 tipPos = vec3(tipXZ.x, kzH0 + stemH, tipXZ.y);
  vec3 kzPos;
  vec3 objectNormal;
  vec3 toCam = normalize(cameraPosition - tipPos);
  if (part < 0.5) {
    float t = position.y, side = position.x;
    float w = max(0.008, kzDist * uGrassShape.w) * (1.0 - 0.3 * t);
    vec2 across = vec2(cos(r3.z * 6.2831853), sin(r3.z * 6.2831853));
    kzPos.xz = kzXZ + D * (stemH * t * t) + across * side * w * 0.5;
    kzPos.y = kzH0 - 0.03 + stemH * t;
    vec3 bn = normalize(vec3(-across.y, 0.0, across.x));
    bn *= sign(dot(bn, toCam) + 1e-4);
    objectNormal = normalize(mix(bn, vec3(0.0, 1.0, 0.0), 0.4));
    vGrassColor = vec3(0.07, 0.12, 0.03);
    vGrassData = vec4(t, mix(0.35, 1.0, t), 0.0, kzSunVis);
    vGrassUv = vec3(0.0);
  } else {
    float u = position.x, v = position.y; // -1..1 square
    float a = (part - 1.0) * 1.5708 + r3.z * 6.2831853;
    vec3 cardDir = vec3(cos(a), 0.0, sin(a));
    vec3 upDir = normalize(vec3(D.x, 1.0, D.y) + vec3(cos(a + 1.57), 0.0, sin(a + 1.57)) * 0.35);
    kzPos = tipPos + cardDir * (u * headR) + upDir * (v * headR) + vec3(0.0, headR * 0.35, 0.0);
    vec3 cn = normalize(cross(cardDir, upDir));
    cn *= sign(dot(cn, toCam) + 1e-4);
    objectNormal = normalize(mix(cn, vec3(0.0, 1.0, 0.0), 0.3));
    vGrassColor = KZ_LILY * mix(0.85, 1.1, r3.x);
    vGrassData = vec4(1.0, 1.0, 0.0, kzSunVis);
    vGrassUv = vec3(u, v, r2.y * 13.0);
  }
`;

// Far tufts (GRASS_TUFT): camera-facing clump cards that texture the fields out to ~280 m
const VERT_TUFT = /* glsl */ `
  float keep = kzMask.r * uGrassPatch.w * kzThin * (1.0 - kzMask.a);
  kzAlive *= step(r1.x, keep);
  float u = position.x, v = position.y;
  float th = mix(0.55, 1.05, r1.y) * uGrassShape.x * (1.0 + kzMask.g * 0.6) * kzAlive * (1.0 - 0.6 * kzFlat) * (1.0 - 0.75 * kzLawn);
  float tw = mix(1.0, 1.7, r2.z) * uGrassShape.y * kzAlive;
  vec3 toCamT = cameraPosition - vec3(kzXZ.x, kzH0, kzXZ.y);
  vec3 rightT = normalize(vec3(toCamT.z, 0.0, -toCamT.x) + vec3(1e-4, 0.0, 0.0));
  vec2 bend = (kzWind * 0.5 + vec2(cos(r3.z * 6.2831853), sin(r3.z * 6.2831853)) * 0.12) * th * v * v;
  vec3 kzPos = vec3(kzXZ.x, kzH0 - 0.06, kzXZ.y) + rightT * (u * tw * 0.5) + vec3(bend.x, v * th, bend.y);
  vec3 objectNormal = normalize(mix(normalize(vec3(toCamT.x, 0.0, toCamT.z) + 1e-4), vec3(0.0, 1.0, 0.0), 0.62));
  vec3 tipT = kzTip;
  tipT = mix(tipT, KZ_PLUME * 0.9, kzMask.g * 0.7);
  vGrassColor = mix(tipT * vec3(0.5, 0.48, 0.34), tipT, v) * (0.75 + 0.4 * r1.y);
  vGrassData = vec4(v, mix(0.35, 1.0, v), kzSheen * v, kzSunVis);
  vGrassUv = vec3(u, max(v, 0.002), r2.y * 11.0);
`;

const FRAG_PARS = /* glsl */ `
#include <kaze_common>
#include <kaze_atmosphere>
varying vec3 vGrassColor;
varying vec4 vGrassData;
varying vec3 vGrassUv;
varying float vGrassFade;
float kzTransK = 1.0;        // pampas plumes: light passes through the thin hair tips, less through the heart
uniform vec3 uTransColor;
uniform float uTransStrength;
uniform float uWrap;
uniform vec3 uPlumeGlow;
vec3 kzTrans = vec3(0.0);
float kzSunVisF = 1.0;
vec3 kzSunDirV = vec3(0.0, 1.0, 0.0);
`;

const FRAG_RE_DIRECT = /* glsl */ `
#undef RE_Direct
void RE_Direct_Grass(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  vec3 lc = directLight.color;
  if (dot(directLight.direction, kzSunDirV) > 0.9995) lc *= kzSunVisF;
  float NoL = dot(geometryNormal, directLight.direction);
  float wrapNL = clamp((NoL + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  reflectedLight.directDiffuse += wrapNL * lc * BRDF_Lambert(material.diffuseContribution);
  reflectedLight.directSpecular += clamp(NoL, 0.0, 1.0) * lc * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material) * 0.6;
  // light passing through the blade toward the viewer
  float back = pow(clamp(dot(-geometryViewDir, directLight.direction), 0.0, 1.0), 3.0);
  float fwd = 0.25 * pow(clamp(dot(-geometryViewDir, directLight.direction), 0.0, 1.0), 12.0);
  reflectedLight.directDiffuse += lc * kzTrans * (back + fwd);
}
#define RE_Direct RE_Direct_Grass
`;

// card alpha shapes
const FRAG_ALPHA = /* glsl */ `
#ifdef GRASS_PAMPAS
  // a susuki plume: a plush, near-opaque heart of silky hairs with a fringe of loose hair tips at its edge (near: one
  // raceme of the fan; far: the whole plume). Each hair reaches its own length (a ragged, soft silhouette); inside the
  // heart the hairs only streak the colour along their slant, in the fringe they part and glow against the sun.
  float kzU = vGrassUv.x, kzV = max(vGrassUv.y, 1e-3);
#if PAMPAS_STRIPS > 1
  // fine hairs lying almost along the raceme toward its tip (silky streaks, not a fishbone), their slant wavering
  float bz = kzV * 70.0 - abs(kzU) * (18.0 + 5.0 * sin(kzV * 4.3 + vGrassUv.z)) + vGrassUv.z;
#else
  float bz = kzV * 34.0 - abs(kzU) * 9.0 + vGrassUv.z;
#endif
  // uneven spacing: the hairs bunch and part along the axis instead of ruling a fishbone
  bz += sin(kzV * 11.0 + vGrassUv.z * 1.7) * 2.0 + sin(kzV * 23.0 + vGrassUv.z) * 0.8 + sin(kzV * 41.0 + vGrassUv.z * 2.3) * 0.35;
  // hairs and plume half-widths per pixel (outside the per-primitive branch: well-defined derivatives)
  float bzW = fwidth(bz);
  float auW = fwidth(abs(kzU));
  if (vGrassUv.y > 0.0 || vGrassUv.x != 0.0) {
    float u = kzU, v = kzV, au = abs(u), seed = vGrassUv.z;
    float bid = floor(bz);
    float br = fract(sin(bid * 12.9898 + seed * 3.1 + step(0.0, u) * 7.7) * 43758.5453);
    float reach = mix(0.55, 1.0, br) * (0.55 + 0.45 * smoothstep(0.0, 0.3, v)) * (1.0 - 0.35 * smoothstep(0.75, 1.0, v));
    float along = au / max(reach, 0.05);                 // 0 at the axis … 1 at the hair's tip
    float alongW = auW / max(reach, 0.05);
    float bc = abs(fract(bz + sin(au * 5.0 + br * 6.28) * 0.12) - 0.5) * 2.0;
    // a second set of hairs at another slant and spacing tangles the grain into silk instead of ruled stripes
    float bc2 = abs(fract(bz * 0.77 + au * 4.0 + seed * 1.3) - 0.5) * 2.0;
    // the heart is solid out to about half of its hairs' reach (a third on the far cards), with a pixel-wide edge (a
    // wide soft alpha ramp dithers into a stippled band under alpha-to-coverage); beyond it the hairs part, thinner
    // toward their tips
#if PAMPAS_STRIPS > 1
    const float kzHeart = 0.55;
#else
    const float kzHeart = 0.35; // a whole plume on one card: a slimmer heart, more fringe (no solid leaf at a distance)
#endif
    float heart = 1.0 - smoothstep(kzHeart - alongW, kzHeart + alongW, along);
    float thick = 0.3 + 0.26 * (1.0 - along) + 0.35 * clamp(bzW - 0.35, 0.0, 1.0);
    float hair = 1.0 - smoothstep(thick, thick + 0.3, bc);
    float hair2 = 1.0 - smoothstep(thick, thick + 0.3, bc2);
    float fringe = max(hair, 0.9 * hair2) * (1.0 - smoothstep(0.78, 1.0, along));
    // the fibre streaks in the colour fade out where several hairs share a pixel (no moiré at a distance)
    float fibre = mix(0.5 * (hair + hair2), 0.5, clamp(bzW * 1.2 - 0.3, 0.0, 1.0));
    float rachis = (1.0 - smoothstep(0.04, 0.1, au)) * (1.0 - smoothstep(0.85, 0.97, v));
    float a = max(max(heart * smoothstep(0.02, 0.1, v), fringe), rachis) * smoothstep(0.0, 0.03, v) * (1.0 - smoothstep(0.95, 1.0, v));
    float kzEdge = smoothstep(0.35, 0.95, along) * (0.6 + 0.4 * br);
    diffuseColor.a = a * vGrassFade;
    // the heart in its own shade and streaked by its hairs, the fringe brighter and glowing against the sun
    diffuseColor.rgb *= mix(0.7, 1.1, kzEdge) * (0.7 + 0.45 * fibre) * (0.88 + 0.24 * br);
    kzTransK = (0.35 + 0.95 * kzEdge) * (0.75 + 0.5 * fibre);
  }
#endif
#ifdef GRASS_TUFT
  {
    float u = vGrassUv.x, v = vGrassUv.y;
    float ang = atan(u * 0.8, v + 0.08);
    float fan = ang * 9.0 + vGrassUv.z;
    float sid = floor(fan);
    float srnd = fract(sin(sid * 17.13 + vGrassUv.z) * 43758.5453);
    float cell = abs(fract(fan) - 0.5) * 2.0;
    float blade = 1.0 - smoothstep(0.3, 0.75, cell / max(1.0 - v, 0.05));
    float tipCut = 1.0 - smoothstep(0.55 + 0.45 * srnd, 0.6 + 0.45 * srnd, v);
    diffuseColor.a = blade * tipCut * (1.0 - smoothstep(0.85, 1.0, abs(u)));
  }
#endif
#ifdef GRASS_LILY
  if (vGrassUv.x != 0.0 || vGrassUv.y != 0.0) {
    vec2 p = vGrassUv.xy;
    float r = length(p);
    float th = atan(p.y, p.x) + vGrassUv.z;
    // six narrow, recurved petals + long stamens curving outward (Lycoris radiata)
    float curl = th + 0.55 * r * r;
    float petal = pow(abs(cos(curl * 3.0)), 14.0) * (1.0 - smoothstep(0.55, 0.72, r));
    float core = 1.0 - smoothstep(0.1, 0.18, r);
    float stam = pow(abs(cos(th * 3.0 + 1.5708 - 0.9 * r)), 220.0) * smoothstep(0.2, 0.35, r) * (1.0 - smoothstep(0.93, 1.0, r));
    diffuseColor.a = max(max(petal * 1.4, core), stam * 1.2);
    diffuseColor.rgb *= mix(0.55, 1.2, smoothstep(0.05, 0.5, r));
  }
#endif
`;

function makeGrassMaterial(kind, uniforms, strips = 1) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const cards = kind === 'pampas' || kind === 'lily' || kind === 'tuft';
  if (cards) {
    mat.alphaTest = kind === 'pampas' ? 0.22 : 0.42;
    mat.alphaToCoverage = true;
  }
  mat.defines = {};
  if (kind === 'mid') mat.defines.GRASS_MID = '';
  if (kind === 'pampas') {
    mat.defines.GRASS_PAMPAS = '';
    mat.defines.PAMPAS_STRIPS = strips; // > 1: one strip per raceme (near layer); 1: one card per plume
  }
  if (kind === 'lily') mat.defines.GRASS_LILY = '';
  if (kind === 'tuft') mat.defines.GRASS_TUFT = '';
  mat.userData.shaderKey = 'grass-' + kind + (kind === 'pampas' ? '-' + strips : '');
  const body = kind === 'pampas' ? VERT_PAMPAS : kind === 'lily' ? VERT_LILY : kind === 'tuft' ? VERT_TUFT : VERT_BLADE;
  // the blades' arc and the susuki's stalk and lens are functions of grassBend.js, declared above main() in the shaders
  // that use them
  const pars = VERT_PARS + (kind === 'pampas' ? PAMPAS_PARS : kind === 'lily' || kind === 'tuft' ? '' : BLADE_ARC_GLSL);
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + pars)
      .replace('#include <beginnormal_vertex>', VERT_COMMON + body)
      .replace('#include <begin_vertex>', 'vec3 transformed = kzPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  // gust sheen (vGrassData.z): blades combed over by a passing front turn a paler, glossier face to the light,
  // in the diffuse and in the light through the blade alike, so the band also reads against the low sun
  vec3 kzPale = vec3(dot(vGrassColor, vec3(0.2126, 0.7152, 0.0722))) * vec3(1.3, 1.24, 1.1) + vec3(0.05, 0.04, 0.025);
  vec3 kzCol = mix(vGrassColor, mix(vGrassColor * 1.15, kzPale, 0.7), vGrassData.z);
  diffuseColor.rgb = kzCol;
  ${FRAG_ALPHA}
  // the low sun shines through the thin upper leaves and the plumes; lower down the blades stand in the shade of the
  // field around them: backlit tips glow, the body of the field keeps deep amber shadows
  kzTrans = kzCol * uTransColor * uTransStrength * (0.06 + 0.94 * vGrassData.x * vGrassData.x) * kzTransK;
  kzSunVisF = vGrassData.w;
  kzSunDirV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);`
      )
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + FRAG_RE_DIRECT)
      .replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= vGrassData.y;\n  reflectedLight.indirectSpecular *= vGrassData.y * 0.6;' +
          (kind === 'pampas' ? '\n  if (vGrassUv.y > 0.0 || vGrassUv.x != 0.0) reflectedLight.indirectDiffuse += vGrassColor * uPlumeGlow;' : '')
      );
  };
  return mat;
}

// base geometries
function bladeGeometry(levels) {
  const pos = [];
  for (let i = 0; i < levels.length; i++) {
    pos.push(-1, levels[i], 0, 1, levels[i], 0);
  }
  pos.push(0, 1, 0);
  const idx = [];
  for (let i = 0; i < levels.length - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const L = levels.length;
  idx.push((L - 1) * 2, (L - 1) * 2 + 1, L * 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  return g;
}

// stalk/stem (part 0) + `cards` cards (part 1..n) with `vseg` segments along v
function stalkCardsGeometry(stalkLevels, cards, vseg, square) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < stalkLevels.length; i++) {
    pos.push(-1, stalkLevels[i], 0, 1, stalkLevels[i], 0);
    uv.push(0, 0, 0, 0);
  }
  pos.push(0, 1, 0);
  uv.push(0, 0);
  for (let i = 0; i < stalkLevels.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const L = stalkLevels.length;
  idx.push((L - 1) * 2, (L - 1) * 2 + 1, L * 2);
  for (let c = 0; c < cards; c++) {
    const base = pos.length / 3;
    for (let s = 0; s <= vseg; s++) {
      const v = square ? -1 + (2 * s) / vseg : s / vseg;
      pos.push(-1, v, 0, 1, v, 0);
      uv.push(0, c + 1, 0, c + 1);
    }
    for (let s = 0; s < vseg; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function quadGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0, 1, 0, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

function makeLayer({ kind, base, patch, density, inner, outer, heightScale, widthScale, farKeep, seed, strips = 1 }) {
  const n = Math.max(8, Math.round(patch * Math.sqrt(density)));
  const cell = patch / n;
  const offsets = new Float32Array(n * n * 2);
  const r = rng(seed);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      offsets[k++] = (i + r()) * cell;
      offsets[k++] = (j + r()) * cell;
    }
  }
  const offsetTex = new THREE.DataTexture(offsets, n, n, THREE.RGFormat, THREE.FloatType);
  offsetTex.minFilter = offsetTex.magFilter = THREE.NearestFilter;
  offsetTex.generateMipmaps = false;
  offsetTex.needsUpdate = true;
  const instRT = new THREE.WebGLRenderTarget(n, n, {
    count: 4,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  for (const t of instRT.textures) t.colorSpace = THREE.NoColorSpace;

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
  geo.instanceCount = n * n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6));

  const uniforms = {
    uGrassCenter: { value: new THREE.Vector3() },
    uGrassPatch: { value: new THREE.Vector4(patch, inner, outer, 1) },
    uGrassShape: { value: new THREE.Vector4(heightScale, widthScale, farKeep, 0.001) },
    uGrassCell: { value: cell },
    // light through the blades turns gold; through the near-neutral plume hairs it stays a pale silver-gold
    uTransColor: { value: kind === 'pampas' ? new THREE.Color(1.0, 0.9, 0.76) : new THREE.Color(1.0, 0.86, 0.62) },
    uTransStrength: { value: kind === 'pampas' ? 0.8 : kind === 'lily' ? 0.9 : 1.1 },
    uWrap: { value: kind === 'pampas' ? 0.6 : 0.45 },
    uPlumeGlow: U.uPlumeGlow,
    uInst0: { value: instRT.textures[0] },
    uInst1: { value: instRT.textures[1] },
    uInst2: { value: instRT.textures[2] },
    uInst3: { value: instRT.textures[3] },
    uInstN: { value: n },
  };
  const prepass = new THREE.ShaderMaterial({
    vertexShader: PREPASS_VERT,
    fragmentShader: PREPASS_FRAG,
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...GLOBAL_UNIFORMS,
      uOffsetTex: { value: offsetTex },
      uGrassCenter: uniforms.uGrassCenter,
      uGrassPatch: uniforms.uGrassPatch,
      uGrassCell: uniforms.uGrassCell,
      uInstN: uniforms.uInstN,
    },
    depthTest: false,
    depthWrite: false,
  });
  const mat = makeGrassMaterial(kind, uniforms, strips);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'grass-' + kind;
  mesh.userData.instances = n * n;
  mesh.userData.verts = base.getAttribute('position').count;
  return { mesh, uniforms, kind, instRT, prepass };
}

export class Grass {
  constructor({ quality }) {
    this.group = new THREE.Group();
    this.group.name = 'grass';
    this.layers = [];
    const q = quality;
    const D = q.grassDensity;
    const near = q.grassNear;

    const closeR = 17;
    // ground cover around the camera: a denser underlayer of shorter blades that thins out between ~2 and 11 m,
    // so no soil shows between the stems in the foreground (the near blades are broad enough to close the field)
    this.layers.push(
      makeLayer({
        kind: 'near',
        base: bladeGeometry([0, 0.4, 0.75]),
        patch: 26,
        density: 64 * D,
        inner: 0,
        outer: 11,
        heightScale: 0.8,
        widthScale: 1.3,
        farKeep: 1.0,
        seed: 13,
      })
    );
    this.layers.push(
      makeLayer({
        kind: 'near',
        base: bladeGeometry([0, 0.3, 0.58, 0.82]),
        patch: closeR * 2 + 6,
        density: 46 * D,
        inner: 0,
        outer: closeR,
        heightScale: 1.08,
        widthScale: 1.3,
        farKeep: 0.75,
        seed: 11,
      })
    );
    this.layers.push(
      makeLayer({
        kind: 'near',
        base: bladeGeometry([0, 0.5]),
        patch: near * 2 + 8,
        density: 24 * D,
        inner: closeR,
        outer: near,
        heightScale: 1.05,
        widthScale: 1.35,
        farKeep: 0.4,
        seed: 12,
      })
    );
    if (q.grassMid) {
      this.layers.push(
        makeLayer({
          kind: 'mid',
          base: bladeGeometry([0, 0.55]),
          patch: 330,
          density: 2.6 * D,
          inner: near,
          outer: 165,
          heightScale: 1.0,
          widthScale: 1.0,
          farKeep: 0.45,
          seed: 23,
        })
      );
    }
    if (q.grassMid) {
      this.layers.push(
        makeLayer({
          kind: 'tuft',
          base: quadGeometry(),
          patch: 580,
          density: 0.32 * D,
          inner: 160,
          outer: 285,
          heightScale: 1.0,
          widthScale: 1.0,
          farKeep: 0.6,
          seed: 29,
        })
      );
    }
    // susuki: near the camera each plume is a fan of raceme strips on a curved stalk; beyond ~24 m one card per
    // plume (same density, the two cross-fade over 15–24 m)
    const pampasR = 24;
    this.layers.push(
      makeLayer({
        kind: 'pampas',
        strips: 3,
        base: stalkCardsGeometry([0, 0.4, 0.75], 3, 3, false),
        patch: pampasR * 2 + 8,
        density: 4.2 * q.pampasDensity,
        inner: 0,
        outer: pampasR,
        heightScale: 1.0,
        widthScale: 1.0,
        farKeep: 1.0,
        seed: 37,
      })
    );
    this.layers.push(
      makeLayer({
        kind: 'pampas',
        strips: 1,
        base: stalkCardsGeometry([0, 0.55], 1, 2, false),
        patch: 170,
        density: 4.2 * q.pampasDensity,
        inner: pampasR,
        outer: 82,
        heightScale: 1.0,
        widthScale: 1.0,
        // thinner toward its far edge: scattered plumes over the rolling field, not a wall hiding its slopes
        farKeep: 0.18,
        seed: 38,
      })
    );
    this.layers.push(
      makeLayer({
        kind: 'lily',
        base: stalkCardsGeometry([0, 0.6], 2, 1, true),
        patch: 96,
        density: 3 * D,
        inner: 0,
        outer: 46,
        heightScale: 1.0,
        widthScale: 1.0,
        farKeep: 0.4,
        seed: 51,
      })
    );
    for (const l of this.layers) this.group.add(l.mesh);
    this.playerUniform = U.uPlayer;
    this.quad = new FullScreenQuad(null);
  }

  // Feed the actor that parts the grass (player). y is used to ignore blades far above/below.
  setPlayer(x, y, z, radius = 0.9) {
    U.uPlayer.value.set(x, y, z, radius);
  }

  // Trampled zones (8 slots shared by all modules): setTrample([{ x, z, r, s }], group) replaces the zones of
  // `group` only, so modules don't overwrite each other — e.g. group 'actors' (r ≈ 1, s = 1 per enemy),
  // 'standoff' (r ≈ 9, s ≈ 0.55), 'camp', 'shot' (a canonical shot's staging). Blades inside part outward and
  // shorten by up to ~60% × s.
  setTrample(zones, group = 'default') {
    if (!this._trample) this._trample = new Map();
    if (zones && zones.length) this._trample.set(group, zones);
    else this._trample.delete(group);
    const all = [...this._trample.values()].flat();
    const arr = U.uTrample.value;
    for (let i = 0; i < arr.length; i++) {
      const z = all[i];
      if (z) arr[i].set(z.x, z.z, z.r, z.s ?? 1);
      else arr[i].set(0, 0, 0, 0);
    }
  }

  // Grazed lawns (up to 4 { x, z, r, s }): blades half as tall and greener, no susuki or lilies. Static ground
  // data (the camp), so a plain replace; null clears.
  setLawn(zones) {
    const arr = U.uLawn.value;
    for (let i = 0; i < arr.length; i++) {
      const z = zones && zones[i];
      if (z) arr[i].set(z.x, z.z, z.r, z.s ?? 1);
      else arr[i].set(0, 0, 0, 0);
    }
  }

  // Per frame, before the scene render: recenter the patches and run the instance prepasses.
  update(camera, renderHeight, renderer) {
    const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / Math.max(1, renderHeight);
    // view wedge: half horizontal FOV + margin (blades lean/bend into view), widened when pitched
    camera.getWorldDirection(_fwd);
    const gv = U.uGrassView.value;
    const flat = Math.hypot(_fwd.x, _fwd.z);
    if (flat > 0.35) {
      const halfV = THREE.MathUtils.degToRad(camera.fov) * 0.5;
      const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
      const pitch = Math.abs(Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1)));
      const lim = Math.min(Math.PI * 0.49, halfH + THREE.MathUtils.degToRad(14) + pitch * 0.6);
      gv.set(_fwd.x / flat, _fwd.z / flat, Math.cos(lim), 1);
    } else gv.w = 0;
    const prevRT = renderer ? renderer.getRenderTarget() : null;
    for (const l of this.layers) {
      l.uniforms.uGrassCenter.value.copy(camera.position);
      l.uniforms.uGrassShape.value.w = pixelAngle * 1.1;
      if (renderer && l.mesh.visible) {
        this.quad.material = l.prepass;
        renderer.setRenderTarget(l.instRT);
        this.quad.render(renderer);
      }
    }
    if (renderer) renderer.setRenderTarget(prevRT);
  }

  stats() {
    return this.layers.map((l) => ({ kind: l.kind, instances: l.mesh.userData.instances, verts: l.mesh.userData.verts }));
  }
}

export { GLOBAL_UNIFORMS };
