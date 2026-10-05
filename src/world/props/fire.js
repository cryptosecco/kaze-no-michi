import * as THREE from 'three';
import { getTextures } from './textures.js';

// Camp fire: flame billboards (cylindrical, noise-animated, additive HDR so bloom picks them up; each one a soft
// mantle around a hot core, no cut-out edge), a soft glow disc, and a GPU smoke column (instanced billboards rising
// and drifting downwind with the shared wind field). Both shaders run through the kaze atmosphere so they sit in the
// same haze as the world.

const FLAME_VERT = /* glsl */ `
#include <kaze_common>
uniform float uTime;
attribute vec4 aFlame; // x offset, z offset, scale, phase
varying vec2 vUv;
varying float vPhase;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vPhase = aFlame.w;
  vec3 base = (modelMatrix * vec4(aFlame.x, 0.0, aFlame.y, 1.0)).xyz;
  // cylindrical billboard: quad turns around Y to face the camera
  vec3 toCam = cameraPosition - base;
  toCam.y = 0.0;
  vec3 side = normalize(vec3(-toCam.z, 0.0, toCam.x) + 1e-5);
  float s = aFlame.z * (0.9 + 0.12 * sin(uTime * 7.0 + aFlame.w * 11.0));
  vec3 p = base + side * position.x * s * 0.8 + vec3(0.0, (position.y + 0.5) * s * 1.7, 0.0);
  // lick sideways with a little turbulence
  p += side * sin(uTime * 5.3 + position.y * 4.0 + aFlame.w * 6.0) * 0.08 * s * (position.y + 0.5);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FLAME_FRAG = /* glsl */ `
#include <kaze_common>
#include <kaze_atmosphere>
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vPhase;
varying vec3 vWorld;
void main() {
  vec2 uv = vUv;
  float n = texture2D(uNoiseTex, vec2(uv.x * 0.35 + vPhase, uv.y * 0.22 - uTime * 0.55)).r;
  float n2 = texture2D(uNoiseTex, vec2(uv.x * 0.9 - vPhase, uv.y * 0.6 - uTime * 1.3)).g;
  float width = mix(0.46, 0.06, pow(uv.y, 0.8));
  float dx = abs(uv.x - 0.5 + (n2 - 0.5) * 0.18 * uv.y);
  // soft layers instead of a cut-out card: a wide dim mantle that thins out across its whole width and licks
  // higher, and a narrow hot core low in the flame
  float mantle = 1.0 - smoothstep(0.0, width, dx);
  mantle *= mantle;
  float core = 1.0 - smoothstep(0.0, width * 0.45, dx);
  float top = 1.0 - smoothstep(0.3, 1.0, uv.y + (n - 0.5) * 0.55);
  float coreTop = 1.0 - smoothstep(0.1, 0.62, uv.y + (n - 0.5) * 0.35);
  float bottom = smoothstep(0.0, 0.14, uv.y);
  float i = (mantle * top * 0.62 + core * core * coreTop * 0.55) * bottom;
  if (i < 0.008) discard;
  vec3 col = mix(vec3(0.9, 0.12, 0.02), vec3(1.0, 0.4, 0.07), smoothstep(0.08, 0.45, i));
  col = mix(col, vec3(1.0, 0.66, 0.26), smoothstep(0.5, 0.95, i));
  col *= i * uIntensity;
  // additive: keep only the transmitted part of the atmosphere
  col = kazeAtmosphere(col, vWorld) - kazeAtmosphere(vec3(0.0), vWorld);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
#include <kaze_common>
#include <kaze_atmosphere>
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
varying float vPhase;
varying vec3 vWorld;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float g = pow(max(0.0, 1.0 - r), 2.2) * (0.85 + 0.15 * sin(uTime * 9.0 + vPhase * 20.0));
  vec3 col = vec3(1.0, 0.42, 0.1) * g * uIntensity;
  col = kazeAtmosphere(col, vWorld) - kazeAtmosphere(vec3(0.0), vWorld);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

const SMOKE_VERT = /* glsl */ `
#include <kaze_wind>
attribute vec2 aSmoke; // phase, size jitter
uniform float uRate;
uniform float uHeight;
varying vec2 vUv;
varying float vAge;
varying vec3 vWorld;
varying float vRot;
void main() {
  vUv = uv;
  float age = fract(uTime * uRate + aSmoke.x);
  vAge = age;
  vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 wd = kazeWindDir();
  float g = kazeGust(base.xz);
  vec3 c = base + vec3(0.0, 0.6 + age * uHeight, 0.0);
  c.xz += wd * pow(age, 1.35) * (3.0 + 9.0 * g);
  c.xz += vec2(sin(age * 9.0 + aSmoke.x * 20.0), cos(age * 7.0 + aSmoke.x * 13.0)) * age * 0.8;
  float size = mix(0.6, 5.2, pow(age, 0.8)) * (0.8 + 0.4 * aSmoke.y);
  float rot = aSmoke.x * 6.2831 + age * 1.3;
  vRot = rot;
  vec2 corner = vec2(cos(rot) * position.x - sin(rot) * position.y, sin(rot) * position.x + cos(rot) * position.y);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += corner * size;
  vWorld = (inverse(viewMatrix) * mv).xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const SMOKE_FRAG = /* glsl */ `
#include <kaze_common>
#include <kaze_atmosphere>
uniform sampler2D uPuff;
uniform vec3 uSmokeColor;
varying vec2 vUv;
varying float vAge;
varying vec3 vWorld;
varying float vRot;
void main() {
  float a = texture2D(uPuff, vUv).a;
  a *= smoothstep(0.0, 0.1, vAge) * pow(1.0 - vAge, 1.5) * 0.42;
  if (a < 0.004) discard;
  // soft lighting: brighter where the puff faces the low sun (upper side), warm sun tint
  float lit = 0.55 + 0.45 * (vUv.y - 0.5) * sin(vRot + 1.57) + 0.2;
  vec3 col = uSmokeColor * (0.5 + 0.5 * lit) + uSunColor * 0.035 * lit;
  col = kazeAtmosphere(col, vWorld);
  gl_FragColor = vec4(col, a);
}
`;

export function makeCampfire({ flames = 5, radius = 0.35, intensity = 6.5, smoke = 28, height = 16 } = {}) {
  const group = new THREE.Group();
  group.name = 'campfire';
  // flames
  const quad = new THREE.PlaneGeometry(1, 1, 1, 4);
  const fgeo = new THREE.InstancedBufferGeometry();
  fgeo.index = quad.index;
  fgeo.setAttribute('position', quad.getAttribute('position'));
  fgeo.setAttribute('uv', quad.getAttribute('uv'));
  const fa = new Float32Array(flames * 4);
  for (let i = 0; i < flames; i++) {
    const a = (i / flames) * Math.PI * 2;
    const r = i === 0 ? 0 : radius * (0.4 + 0.6 * ((i * 37) % 10) / 10);
    fa.set([Math.cos(a) * r, Math.sin(a) * r, i === 0 ? 1.25 : 0.75 + ((i * 53) % 10) / 25, i * 0.137], i * 4);
  }
  fgeo.setAttribute('aFlame', new THREE.InstancedBufferAttribute(fa, 4));
  fgeo.instanceCount = flames;
  fgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
  const flameMat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    uniforms: { uIntensity: { value: intensity } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  flameMat.userData.shaderKey = 'props-flame';
  const flame = new THREE.Mesh(fgeo, flameMat);
  flame.frustumCulled = true;
  flame.renderOrder = 10;
  group.add(flame);

  // glow disc (billboard via the same vertex path: one wide instance)
  const ggeo = new THREE.InstancedBufferGeometry();
  ggeo.index = quad.index;
  ggeo.setAttribute('position', quad.getAttribute('position'));
  ggeo.setAttribute('uv', quad.getAttribute('uv'));
  ggeo.setAttribute('aFlame', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 2.6, 0.5]), 4));
  ggeo.instanceCount = 1;
  ggeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 4);
  const glowMat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uIntensity: { value: 0.18 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  glowMat.userData.shaderKey = 'props-glow';
  const glow = new THREE.Mesh(ggeo, glowMat);
  glow.position.y = -0.6;
  glow.renderOrder = 9;
  group.add(glow);

  // smoke column
  const sq = new THREE.PlaneGeometry(1, 1);
  const sgeo = new THREE.InstancedBufferGeometry();
  sgeo.index = sq.index;
  sgeo.setAttribute('position', sq.getAttribute('position'));
  sgeo.setAttribute('uv', sq.getAttribute('uv'));
  const sa = new Float32Array(smoke * 2);
  for (let i = 0; i < smoke; i++) sa.set([i / smoke + ((i * 7919) % 97) / 9700, ((i * 31) % 17) / 17], i * 2);
  sgeo.setAttribute('aSmoke', new THREE.InstancedBufferAttribute(sa, 2));
  sgeo.instanceCount = smoke;
  sgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.6, 0), height + 12);
  const smokeMat = new THREE.ShaderMaterial({
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    uniforms: {
      uPuff: { value: getTextures().smoke },
      uRate: { value: 0.055 },
      uHeight: { value: height },
      uSmokeColor: { value: new THREE.Color(0.36, 0.34, 0.33) },
    },
    transparent: true,
    depthWrite: false,
  });
  smokeMat.userData.shaderKey = 'props-smoke';
  const smokeMesh = new THREE.Mesh(sgeo, smokeMat);
  smokeMesh.renderOrder = 11;
  group.add(smokeMesh);
  return group;
}
