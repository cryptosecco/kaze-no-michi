import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../render/globals.js';
import { rng } from '../../core/math.js';
import { wind, FRONT_SPEED, GUIDE_EXTRA_SPEED } from '../Wind.js';
import { TREE_UNIFORMS } from './materials.js';

// Airborne life around the camera, fully on the GPU (no per-leaf CPU work):
//   FallingLeaves : tumbling maple/ginkgo leaves in a toroidal box that follows the camera. The box is
//                   world-anchored (a leaf never swims when the camera moves); drift is integrated on the CPU
//                   as one shared offset so gusts and the guiding wind accelerate the whole stream smoothly.
//                   Density follows the proximity of trees (litter mask B) with a base rate over open fields.
//   LeafSwarm     : leaves carried along the travelling gust fronts, over the open fields and up into the sky.
//   Motes         : pollen / dust specks that sparkle when looking toward the low sun (additive, HDR → bloom).
// Each has reset(): a shot restarts its drift from zero, so stills repeat whatever ran before them.

const QUAD = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
})();

function instanced(count, seed) {
  const r = rng(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) seeds[i] = r();
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = QUAD.index;
  geo.setAttribute('position', QUAD.getAttribute('position'));
  geo.setAttribute('uv', QUAD.getAttribute('uv'));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

const FALL_VERT_PARS = /* glsl */ `
#include <kaze_wind>
#include <kaze_terrain>
attribute vec4 aSeed;
uniform vec3 uFallCenter;
uniform vec4 uFallBox;      // x half size, y height, z base density (open fields), w size scale
uniform vec2 uFallDrift;
uniform sampler2D uLitterMask;
uniform vec4 uCellMaple;    // u0, vBottom, u1, vTop
uniform vec4 uCellGinkgo;
varying float vFallFade;
vec3 kzRot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

const FALL_VERT = /* glsl */ `
  vec2 kzBoxS = vec2(uFallBox.x * 2.0);
  vec2 kzOrg = uFallCenter.xz - uFallBox.x;
  vec2 kzXZ = aSeed.xy * kzBoxS + uFallDrift * mix(0.7, 1.3, aSeed.z);
  kzXZ = kzOrg + mod(kzXZ - kzOrg, kzBoxS);
  float kzFall = mix(0.5, 1.05, aSeed.z);
  float kzY01 = fract(aSeed.w - uTime * kzFall / uFallBox.y);
  float kzAng = uTime * (1.1 + 1.9 * aSeed.z) + aSeed.w * 31.0;
  kzXZ += vec2(cos(kzAng), sin(kzAng)) * 0.45 + kazeWindBend(kzXZ) * 0.9 * kzY01;
  float kzGround = kazeTerrainHeightFast(kzXZ);
  float kzY = kzGround + 0.06 + kzY01 * uFallBox.y;
  vec4 kzLit = textureLod(uLitterMask, (kzXZ + KZ_HALF) / (2.0 * KZ_HALF), 0.0);
  // the leaves of the ambient wind are in or out as they always were; the extra ones a guide brings down (uGuideSoft
  // rises and falls over ~1 s) grow in and shrink away over a narrow band of the density, not on and off in mid-air
  float kzDens0 = max(kzLit.b, uFallBox.z);
  float kzDens = max(kzLit.b, uFallBox.z + uGuideSoft * 0.35);
  float kzH1 = fract(aSeed.x * 91.7 + aSeed.w * 13.1);
  float kzAlive = max(step(kzH1, kzDens0), smoothstep(kzH1, kzH1 + 0.08, kzDens));
  float kzEdge = 1.0 - smoothstep(uFallBox.x * 0.72, uFallBox.x, length(kzXZ - uFallCenter.xz));
  float kzEnds = smoothstep(0.0, 0.02, kzY01) * (1.0 - smoothstep(0.93, 1.0, kzY01));
  vec3 kzC = vec3(kzXZ.x, kzY, kzXZ.y);
  float kzCamD = distance(kzC, cameraPosition);
  float kzCam = smoothstep(0.5, 1.5, kzCamD);
  float kzSize = kzLensCap(mix(0.1, 0.17, fract(aSeed.y * 7.7)) * uFallBox.w, kzCamD) * kzAlive * kzEnds * kzCam * step(0.001, kzEdge);
  vFallFade = kzEdge;
  vec3 kzAxis = normalize(vec3(fract(aSeed.y * 3.7) - 0.5, 0.45, fract(aSeed.z * 5.3) - 0.5));
  float kzRa = uTime * (2.2 + 5.0 * fract(aSeed.y * 11.3)) + aSeed.z * 6.2831853;
  vec3 kzPos = kzC + kzRot(vec3(position.xy, 0.0), kzAxis, kzRa) * kzSize;
  vec3 objectNormal = kzRot(vec3(0.0, 0.0, 1.0), kzAxis, kzRa);
  float kzGinkgoP = kzLit.g / max(kzLit.r + kzLit.g, 0.001);
  bool kzIsG = fract(aSeed.w * 17.3) < (kzLit.r + kzLit.g > 0.02 ? kzGinkgoP : 0.25);
  vec4 kzRect = kzIsG ? uCellGinkgo : uCellMaple;
  vMapUv = vec2(mix(kzRect.x, kzRect.z, uv.x), mix(kzRect.y, kzRect.w, uv.y));
#ifdef USE_COLOR
  float kzT = fract(aSeed.z * 23.9);
  vColor.rgb = kzIsG ? vec3(1.0, 0.92 + 0.1 * kzT, 0.8) * (0.85 + 0.3 * kzT)
                 : mix(vec3(1.0, 0.8, 0.8), vec3(1.05, 1.5, 0.85), step(0.7, kzT)) * (0.75 + 0.35 * fract(kzT * 7.0));
#endif
`;

// Lens-aware size and defocus, shared by both systems. The swarm draws its far leaves larger than life so they read
// in a wide frame; a long lens (fov under ~47°: S3, S4) magnifies them by itself, so there they keep little of that
// growth (kzTele), else the exaggerated ones turned into huge, sharp, flat cut-outs in the sky. Whatever the lens, a
// leaf covers at most ~120 px of a 1080p frame right in front of the lens and ~40 px from 12 m on. Out of the focus
// band the leaves go soft (a wider edge, a lighter body, and far off a paler colour): nearer than ~4 m to the lens
// (proportionally farther through a long lens, whose depth of field is shallower), farther than ~20 m.
const LEAF_VERT_PARS = /* glsl */ `
varying float vLeafNear;
varying float vLeafFar;
float kzTele() {
  return smoothstep(2.3, 2.9, projectionMatrix[1][1]);
}
float kzLensCap(float size, float dist) {
  float px = mix(120.0, 40.0, smoothstep(2.0, 12.0, dist));
  return min(size, px / 540.0 * dist / projectionMatrix[1][1]);
}
`;
const LEAF_DEFOCUS_VERT = /* glsl */ `
  float kzLensD = distance(kzPos, cameraPosition);
  float kzLensL = max(1.0, projectionMatrix[1][1] / 2.15);
  vLeafNear = 1.0 - smoothstep(1.2 * kzLensL, 4.0 * kzLensL, kzLensD);
  vLeafFar = smoothstep(20.0, 50.0, kzLensD);`;
const LEAF_SOFT_FRAG = /* glsl */ `
  float kzEdgeW = 0.03 + 0.35 * vLeafNear + 0.2 * vLeafFar;
  diffuseColor.a = smoothstep(0.5 - kzEdgeW, 0.5 + kzEdgeW, diffuseColor.a) * (1.0 - 0.45 * vLeafNear - 0.25 * vLeafFar);
#ifdef ALPHA_TO_COVERAGE
  if (diffuseColor.a < 0.02) discard;
#else
  if (diffuseColor.a < 0.5) discard;
#endif
`;

// Airborne-leaf material: the atlas leaf cut out (coverage with MSAA, else alpha test), lit on both faces, glowing
// when the low sun shines through it. `vert` must declare kzPos (world position) and objectNormal, and set
// vMapUv/vColor; its size may use kzLensCap(size, distance to the lens).
function leafMesh({ count, seed, atlas, msaa, uniforms, vertPars, vert, key, name }) {
  const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7, metalness: 0, vertexColors: true });
  mat.alphaToCoverage = msaa > 0;
  mat.userData.shaderKey = key;
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + LEAF_VERT_PARS + vertPars)
      .replace('#include <beginnormal_vertex>', vert)
      .replace('#include <begin_vertex>', 'vec3 transformed = kzPos;' + LEAF_DEFOCUS_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uLeafTrans;
uniform float uLeafWrap;
varying float vLeafNear;
varying float vLeafFar;
vec3 kzLeafTrans = vec3(0.0);`
      )
      // far leaves lose some colour (the swarm over the sky read as saturated stickers), the glow included
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114))), 0.35 * vLeafFar);
  kzLeafTrans = diffuseColor.rgb * uLeafTrans * 1.2;`
      )
      .replace('#include <alphatest_fragment>', LEAF_SOFT_FRAG)
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
#undef RE_Direct
void RE_Direct_Fall(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float NoL = abs(dot(geometryNormal, directLight.direction));
  reflectedLight.directDiffuse += (0.35 + 0.65 * NoL) * directLight.color * BRDF_Lambert(material.diffuseContribution);
  float VoL = clamp(dot(-geometryViewDir, directLight.direction), 0.0, 1.0);
  reflectedLight.directDiffuse += directLight.color * kzLeafTrans * (0.4 * pow(VoL, 3.0) + 1.0 * pow(VoL, 12.0));
}
#define RE_Direct RE_Direct_Fall`
      );
  };
  const mesh = new THREE.Mesh(instanced(count, seed), mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}

const cellVec = (c) => new THREE.Vector4(c.u0, c.vBottom, c.u1, c.vTop);

export class FallingLeaves {
  constructor({ count, atlas, litterMask, cellMaple, cellGinkgo, msaa }) {
    this.uniforms = {
      uFallCenter: { value: new THREE.Vector3() },
      uFallBox: { value: new THREE.Vector4(34, 16, 0.18, 1) },
      uFallDrift: { value: new THREE.Vector2() },
      uLitterMask: { value: litterMask },
      uCellMaple: { value: cellVec(cellMaple) },
      uCellGinkgo: { value: cellVec(cellGinkgo) },
      ...TREE_UNIFORMS,
    };
    this.mesh = leafMesh({ count, seed: 913, atlas, msaa, uniforms: this.uniforms, vertPars: FALL_VERT_PARS, vert: FALL_VERT, key: 'tree-fall', name: 'falling-leaves' });
    this._d = new THREE.Vector2();
  }

  // a shot restarts the stream from the same place (stills repeat whatever ran before them)
  reset() {
    this.uniforms.uFallDrift.value.set(0, 0);
  }

  update(dt, camera) {
    const U = this.uniforms;
    U.uFallCenter.value.copy(camera.position);
    // shared drift: the stream speeds up in gusts and races along the guiding wind
    const g = wind.gust(camera.position.x, camera.position.z);
    const guide = wind.uniforms.uGuide.value;
    const speed = 0.8 + 1.8 * g + 7.5 * guide;
    wind.dir(this._d);
    U.uFallDrift.value.addScaledVector(this._d, speed * dt);
    // keep the float offset small (the box wraps anyway)
    const P = U.uFallBox.value.x * 2 * 64;
    if (Math.abs(U.uFallDrift.value.x) > P) U.uFallDrift.value.x -= Math.sign(U.uFallDrift.value.x) * P;
    if (Math.abs(U.uFallDrift.value.y) > P) U.uFallDrift.value.y -= Math.sign(U.uFallDrift.value.y) * P;
  }
}

// LeafSwarm: leaves torn off by the wind and carried along the gust fronts (the red maple leaves that cross the
// open fields and the sky). A toroidal box around the camera, like the falling leaves, but the stream
// rides the fronts at their own speed: a front carries more leaves, lifts them and swings them wider, the lulls
// let them sink toward the grass. Drift is one CPU offset (reset by every shot, so stills repeat exactly).
const SWARM_VERT_PARS = /* glsl */ `
#include <kaze_wind>
#include <kaze_terrain>
attribute vec4 aSeed;
uniform vec3 uSwarmCenter;
uniform vec4 uSwarmBox;     // x half size, y flight height, z share of the leaves aloft in a lull, w size scale
uniform vec2 uSwarmDrift;   // the stream's travel along the wind (m)
uniform sampler2D uLitterMask;
uniform vec4 uCellMaple;    // u0, vBottom, u1, vTop
uniform vec4 uCellGinkgo;
vec3 kzRot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

const SWARM_VERT = /* glsl */ `
  vec2 kzBoxS = vec2(uSwarmBox.x * 2.0);
  vec2 kzOrg = uSwarmCenter.xz - uSwarmBox.x;
  // each leaf rides the stream at its own pace (the heavier ones lag behind the front)
  vec2 kzXZ = aSeed.xy * kzBoxS + uSwarmDrift * mix(0.8, 1.05, aSeed.z);
  kzXZ = kzOrg + mod(kzXZ - kzOrg, kzBoxS);
  float kzGn = smoothstep(0.26, 0.95, kazeGust(kzXZ));
  // loops and side-slips around the stream line, wider in a front
  float kzAng = uTime * (0.8 + 1.4 * aSeed.w) + aSeed.w * 31.0;
  kzXZ += vec2(cos(kzAng), sin(kzAng)) * (0.35 + 0.9 * kzGn);
  float kzGround = kazeTerrainHeightFast(kzXZ);
  // flight height: from just above the grass up to the box top; a front lifts them all
  float kzH = pow(fract(aSeed.w * 7.31 + aSeed.x * 3.7), 1.1);
  float kzY = kzGround + 0.8 + kzH * uSwarmBox.y * (0.7 + 0.3 * kzGn) + sin(uTime * (1.1 + aSeed.y * 1.3) + aSeed.z * 17.0) * (0.25 + 0.4 * kzGn);
  vec4 kzLit = textureLod(uLitterMask, (kzXZ + KZ_HALF) / (2.0 * KZ_HALF), 0.0);
  // more leaves aloft in a front: each one grows in (or dwindles away) over its own short band of the gust;
  // the stream crosses open ground (under the trees the falling leaves take over: litter B = tree nearby)
  float kzH1 = fract(aSeed.x * 91.7 + aSeed.w * 13.1);
  // (uGuideSoft, the guide envelope low-passed over ~1 s: the extra leaves of a guide join and leave gradually)
  float kzDens = (uSwarmBox.z + (1.0 - uSwarmBox.z) * kzGn + uGuideSoft * 0.3) * (1.0 - 0.9 * kzLit.b);
  float kzAlive = smoothstep(kzH1 - 0.06, kzH1 + 0.06, kzDens);
  float kzEdge = 1.0 - smoothstep(uSwarmBox.x * 0.7, uSwarmBox.x, length(kzXZ - uSwarmCenter.xz));
  vec3 kzC = vec3(kzXZ.x, kzY, kzXZ.y);
  float kzCamD = distance(kzC, cameraPosition);
  // a few cross just in front of the lens, large and out of focus
  float kzCam = smoothstep(0.7, 1.6, kzCamD);
  // red maple over the open fields, ginkgo where the ginkgo litter says so
  float kzGinkgoP = kzLit.g / max(kzLit.r + kzLit.g, 0.001);
  bool kzIsG = fract(aSeed.w * 17.3) < (kzLit.r + kzLit.g > 0.02 ? kzGinkgoP : 0.06);
  // leaf-sized within a few metres of the lens (no flat leaf fills the frame), drawn larger beyond it so the stream
  // reads against the sky: the red maple leaves torn off over the open fields 3x from ~12 m (20–40 px at 1080p
  // near the camera, a scatter of smaller ones far off); the ginkgo leaves of the valley grow less (the gold lies
  // on the ground, no big fans drifting over the roofs); little of it through a long lens (see kzTele)
  float kzGrow = (kzIsG ? 1.2 * smoothstep(6.0, 30.0, kzCamD) : 2.0 * smoothstep(3.0, 12.0, kzCamD)) * (1.0 - 0.7 * kzTele());
  float kzSize = kzLensCap(mix(0.13, 0.22, fract(aSeed.y * 7.7)) * (1.0 + kzGrow) * uSwarmBox.w, kzCamD) * kzAlive * kzEdge * kzCam;
  // tumbling, faster for the light ones
  vec3 kzAxis = normalize(vec3(fract(aSeed.y * 3.7) - 0.5, 0.35, fract(aSeed.z * 5.3) - 0.5));
  float kzRa = uTime * (2.6 + 5.5 * fract(aSeed.y * 11.3)) + aSeed.z * 6.2831853;
  vec3 kzPos = kzC + kzRot(vec3(position.xy, 0.0), kzAxis, kzRa) * kzSize;
  vec3 objectNormal = kzRot(vec3(0.0, 0.0, 1.0), kzAxis, kzRa);
  vec4 kzRect = kzIsG ? uCellGinkgo : uCellMaple;
  vMapUv = vec2(mix(kzRect.x, kzRect.z, uv.x), mix(kzRect.y, kzRect.w, uv.y));
#ifdef USE_COLOR
  float kzT = fract(aSeed.z * 23.9);
  vColor.rgb = kzIsG ? vec3(1.0, 0.92 + 0.1 * kzT, 0.8) * (0.85 + 0.3 * kzT)
                 : mix(vec3(1.0, 0.78, 0.78), vec3(1.05, 1.35, 0.85), step(0.82, kzT)) * (0.78 + 0.32 * fract(kzT * 7.0));
#endif
`;

// box: [half size (m), flight height (m), share aloft in a lull, size scale] — the trees module runs a wide
// swarm for the fields and the sky and a small, denser one for the leaves that cross close to the camera
export class LeafSwarm {
  constructor({ count, atlas, litterMask, cellMaple, cellGinkgo, msaa, box = [36, 11, 0.35, 1], seed = 577, name = 'leaf-swarm' }) {
    this.uniforms = {
      uSwarmCenter: { value: new THREE.Vector3() },
      uSwarmBox: { value: new THREE.Vector4(...box) },
      uSwarmDrift: { value: new THREE.Vector2() },
      uLitterMask: { value: litterMask },
      uCellMaple: { value: cellVec(cellMaple) },
      uCellGinkgo: { value: cellVec(cellGinkgo) },
      ...TREE_UNIFORMS,
    };
    this.mesh = leafMesh({ count, seed, atlas, msaa, uniforms: this.uniforms, vertPars: SWARM_VERT_PARS, vert: SWARM_VERT, key: 'tree-swarm', name });
    this._d = new THREE.Vector2();
  }

  update(dt, camera) {
    const U = this.uniforms;
    U.uSwarmCenter.value.copy(camera.position);
    // the stream travels with the gust fronts (faster along a guiding wind, like the fronts)
    wind.dir(this._d);
    U.uSwarmDrift.value.addScaledVector(this._d, (FRONT_SPEED + GUIDE_EXTRA_SPEED * wind.uniforms.uGuide.value) * dt);
    // keep the float offset bounded (every leaf jumps once when it wraps: every ~80 min of play for the wide
    // swarm, ~25 min for the near one)
    const P = U.uSwarmBox.value.x * 2 * 512;
    if (Math.abs(U.uSwarmDrift.value.x) > P) U.uSwarmDrift.value.x -= Math.sign(U.uSwarmDrift.value.x) * P;
    if (Math.abs(U.uSwarmDrift.value.y) > P) U.uSwarmDrift.value.y -= Math.sign(U.uSwarmDrift.value.y) * P;
  }

  reset() {
    this.uniforms.uSwarmDrift.value.set(0, 0);
  }
}

const MOTE_VERT = /* glsl */ `
#include <kaze_common>
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoteCenter;
uniform vec4 uMoteBox;    // x half size, y height, z intensity
uniform vec2 uMoteDrift;
varying vec3 vMote;
varying vec2 vQ;
void main() {
  vec2 box = vec2(uMoteBox.x * 2.0);
  vec2 org = uMoteCenter.xz - uMoteBox.x;
  vec2 xz = aSeed.xy * box + uMoteDrift * mix(0.35, 0.8, aSeed.z);
  xz = org + mod(xz - org, box);
  xz += vec2(sin(uTime * 0.37 + aSeed.w * 40.0), cos(uTime * 0.29 + aSeed.z * 33.0)) * 0.6;
  float y = uMoteCenter.y - 1.6 + fract(aSeed.w + uTime * 0.012 * (aSeed.x - 0.5)) * uMoteBox.y + sin(uTime * 0.6 + aSeed.y * 25.0) * 0.25;
  vec3 wp = vec3(xz.x, y, xz.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  float size = mix(0.008, 0.024, aSeed.z);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  vec3 V = normalize(wp - cameraPosition);
  float fwd = pow(max(dot(V, uSunDir), 0.0), 7.0);
  float d = length(mv.xyz);
  float fade = smoothstep(0.4, 1.6, d) * (1.0 - smoothstep(uMoteBox.x * 0.55, uMoteBox.x, d));
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed.x * 3.0) + aSeed.y * 50.0);
  vMote = uSunColor * (0.05 + 1.6 * fwd) * fade * tw * uMoteBox.z;
  vQ = position.xy;
}
`;

const MOTE_FRAG = /* glsl */ `
varying vec3 vMote;
varying vec2 vQ;
void main() {
  float r = length(vQ) * 2.0;
  float a = exp(-r * r * 5.0);
  gl_FragColor = vec4(vMote * a, 1.0);
}
`;

export class Motes {
  constructor({ count }) {
    this.uniforms = {
      uTime: GLOBAL_UNIFORMS.uTime,
      uSunDir: GLOBAL_UNIFORMS.uSunDir,
      uSunColor: GLOBAL_UNIFORMS.uSunColor,
      uNoiseTex: GLOBAL_UNIFORMS.uNoiseTex,
      uMoteCenter: { value: new THREE.Vector3() },
      uMoteBox: { value: new THREE.Vector4(18, 7, 0.06, 0) },
      uMoteDrift: { value: new THREE.Vector2() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(instanced(count, 377), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'sun-motes';
    this._d = new THREE.Vector2();
  }

  update(dt, camera) {
    this.uniforms.uMoteCenter.value.copy(camera.position);
    wind.dir(this._d);
    this.uniforms.uMoteDrift.value.addScaledVector(this._d, (0.35 + 0.6 * wind.uniforms.uWindStrength.value) * dt);
  }

  reset() {
    this.uniforms.uMoteDrift.value.set(0, 0);
  }
}
