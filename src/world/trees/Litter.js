import * as THREE from 'three';
import { rng } from '../../core/math.js';
import '../../render/fieldPalette.js'; // kaze_lawn chunk

// Close-up leaf detail on top of the carpet (Carpet.js): single maple/ginkgo leaves lying around the camera
// in a toroidal patch, slightly tilted and lifted so they catch the light; density and species from the
// litter mask. World-stable randomness (hashed from the world position of each leaf).

const VERT_PARS = /* glsl */ `
#include <kaze_common>
#include <kaze_terrain>
attribute vec2 aSeed;
uniform vec3 uLitCenter;
uniform vec4 uLitBox;       // x half patch, y fade start, z fade end, w size scale
uniform sampler2D uLitterMask;
uniform vec4 uCellLitMaple; // u0, vBottom, u1, vTop
uniform vec4 uCellLitGinkgo;
#include <kaze_lawn>
varying float vLitFade;
varying float vLitAO;
`;

const VERT = /* glsl */ `
  vec2 kzBox = vec2(uLitBox.x * 2.0);
  vec2 kzOrg = uLitCenter.xz - uLitBox.x;
  vec2 kzXZ = kzOrg + mod(aSeed * kzBox - kzOrg, kzBox);
  vec2 kzCellId = floor(kzXZ * 61.0);
  float kzH = kazeHash12(kzCellId);
  float kzH2 = kazeHash12(kzCellId + 17.31);
  float kzH3 = kazeHash12(kzCellId + 41.7);
  vec4 kzLit = textureLod(uLitterMask, (kzXZ + KZ_HALF) / (2.0 * KZ_HALF), 0.0);
  float kzDens = max(kzLit.r, kzLit.g);
  // on a grazed lawn the fallen leaves lie thick over the whole turf, where the litter mask is kept thin
  float kzLawnL = kazeLawnAt(kzXZ);
  float kzAlive = step(kzH, mix(kzDens * 0.95, min(1.0, 0.75 + kzDens), kzLawnL));
  float kzDist = distance(kzXZ, uLitCenter.xz);
  vLitFade = 1.0 - smoothstep(uLitBox.y, uLitBox.z, kzDist);
  // leaves of every size, from small fresh ones to big curled ones (a little bigger on the lawn, over the turf)
  float kzS = mix(0.6, 1.45, kzH2) * (1.0 + 0.25 * kzLawnL) * uLitBox.w * kzAlive * step(0.001, vLitFade);
  // on a lawn the leaves rest on top of the turf instead of under it
  float kzY = kazeTerrainHeightFast(kzXZ) + 0.02 + kzLawnL * mix(0.05, 0.14, kzH3);
  float kzHx = kazeTerrainHeightFast(kzXZ + vec2(0.7, 0.0)) - kazeTerrainHeightFast(kzXZ - vec2(0.7, 0.0));
  float kzHz = kazeTerrainHeightFast(kzXZ + vec2(0.0, 0.7)) - kazeTerrainHeightFast(kzXZ - vec2(0.0, 0.7));
  vec3 kzN = normalize(vec3(-kzHx / 1.4, 1.0, -kzHz / 1.4) + vec3(kzH2 - 0.5, 0.0, kzH3 - 0.5) * 0.7);
  float kzA = kzH3 * 6.2831853;
  vec3 kzT0 = vec3(cos(kzA), 0.0, sin(kzA));
  vec3 kzT = normalize(kzT0 - kzN * dot(kzT0, kzN));
  vec3 kzB = cross(kzN, kzT);
  vec3 kzPos = vec3(kzXZ.x, kzY + 0.03 + kzH2 * 0.02, kzXZ.y) + (kzT * position.x + kzB * position.y) * kzS;
  vec3 objectNormal = kzN;
  vLitAO = mix(1.0, kazeTerrainLight(kzXZ).g, 0.6);
  bool kzIsG = kzH2 * (kzLit.r + kzLit.g) < kzLit.g;
  vec4 kzRect = kzIsG ? uCellLitGinkgo : uCellLitMaple;
  vMapUv = vec2(mix(kzRect.x, kzRect.z, uv.x), mix(kzRect.y, kzRect.w, uv.y));
#ifdef USE_COLOR
  // tones: golden fresh leaves, a share turned rust-brown, a few bleached pale
  float kzTone = kazeHash12(kzCellId + 63.1);
  vColor.rgb = vec3(0.7 + 0.4 * kzH3) * mix(vec3(1.0), vec3(0.82, 0.58, 0.4), step(0.7, kzTone));
  vColor.rgb *= mix(vec3(1.0), vec3(1.08, 1.06, 0.92), step(kzTone, 0.12));
#endif
`;

export class Litter {
  constructor({ atlas, litterMask, cellMaple, cellGinkgo, half = 38, density = 1.4, msaa }) {
    const n = Math.round(Math.sqrt(density) * half * 2);
    const r = rng(5151);
    const seeds = new Float32Array(n * n * 2);
    let k = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        seeds[k++] = (i + r()) / n;
        seeds[k++] = (j + r()) / n;
      }
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    base.setIndex([0, 1, 2, 1, 3, 2]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2));
    geo.instanceCount = n * n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = {
      uLitCenter: { value: new THREE.Vector3() },
      uLitBox: { value: new THREE.Vector4(half, half * 0.7, half * 0.95, 1) },
      uLitterMask: { value: litterMask },
      uCellLitMaple: { value: new THREE.Vector4(cellMaple.u0, cellMaple.vBottom, cellMaple.u1, cellMaple.vTop) },
      uCellLitGinkgo: { value: new THREE.Vector4(cellGinkgo.u0, cellGinkgo.vBottom, cellGinkgo.u1, cellGinkgo.vTop) },
    };
    const mat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, roughness: 0.82, metalness: 0, vertexColors: true });
    mat.alphaToCoverage = msaa > 0;
    mat.userData.shaderKey = 'tree-litter';
    const U = this.uniforms;
    mat.userData.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_PARS)
        .replace('#include <beginnormal_vertex>', VERT)
        .replace('#include <begin_vertex>', 'vec3 transformed = kzPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vLitFade;
varying float vLitAO;
float kzIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`
        )
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (kzIGN(gl_FragCoord.xy) >= vLitFade) discard;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vLitAO;');
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'leaf-litter';
  }

  update(camera) {
    this.uniforms.uLitCenter.value.copy(camera.position);
  }
}
