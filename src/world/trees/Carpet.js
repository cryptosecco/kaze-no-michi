import * as THREE from 'three';
import '../../render/fieldPalette.js'; // kaze_lawn chunk

// Continuous fallen-leaf carpet under maples (crimson) and ginkgos (gold).
// A camera-following grid that lies exactly on the terrain: vertices snap to the 2 m terrain grid and the
// quads use the terrain mesh's triangle diagonal (v01–v10), so the carpet is the ground surface lifted by a
// few centimetres. Tileable alpha-tested leaf textures (two layers, rotated) give leaf-shaped edges; the
// coverage comes from the litter mask baked from the tree records, broken up with noise.

const CELL = 2;

const VERT_PARS = /* glsl */ `
#include <kaze_common>
#include <kaze_terrain>
uniform vec2 uCarpetOrigin;
uniform vec3 uCarpetCenter;
uniform vec2 uCarpetFade;
uniform sampler2D uLitterMask;
varying vec2 vCarpetXZ;
varying float vCarpetFade;
varying float vCarpetCov;
`;

const VERT = /* glsl */ `
  vec2 kzXZ = uCarpetOrigin + position.xz;
  float kzY = kazeTerrainHeight(kzXZ) + 0.035;
  float kzHl = kazeTerrainHeight(kzXZ - vec2(2.0, 0.0)), kzHr = kazeTerrainHeight(kzXZ + vec2(2.0, 0.0));
  float kzHd = kazeTerrainHeight(kzXZ - vec2(0.0, 2.0)), kzHu = kazeTerrainHeight(kzXZ + vec2(0.0, 2.0));
  vec3 objectNormal = normalize(vec3(kzHl - kzHr, 4.0, kzHd - kzHu));
  vCarpetXZ = kzXZ;
  vCarpetFade = 1.0 - smoothstep(uCarpetFade.x, uCarpetFade.y, distance(kzXZ, uCarpetCenter.xz));
  vec4 kzLitV = textureLod(uLitterMask, (kzXZ + KZ_HALF) / (2.0 * KZ_HALF), 0.0);
  vCarpetCov = max(kzLitV.r, kzLitV.g);
`;

const FRAG_PARS = /* glsl */ `
#include <kaze_common>
uniform sampler2D uLitterMask;
uniform sampler2D uTexMaple;
uniform sampler2D uTexGinkgo;
uniform float uCarpetHalf;
varying vec2 vCarpetXZ;
varying float vCarpetFade;
varying float vCarpetCov;
#include <kaze_lawn>
float kzIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const FRAG_DISCARD = /* glsl */ `
  if (vCarpetCov < 0.02 || kzIGN(gl_FragCoord.xy) >= vCarpetFade) discard;
`;

const FRAG_COLOR = /* glsl */ `
  {
    vec4 kzLit = texture(uLitterMask, (vCarpetXZ + uCarpetHalf) / (2.0 * uCarpetHalf));
    float kzDens = max(kzLit.r, kzLit.g);
    float kzN = kazeFbm(vCarpetXZ * 0.23 + vec2(0.31, 0.77));
    float kzCov = smoothstep(0.16, 0.55, kzDens + kzN * 0.25);
    // on a grazed lawn the leaves lie everywhere, thicker in drifts toward the trees, the turf showing through in a
    // few open stretches
    float kzLawnC = kazeLawnAt(vCarpetXZ);
    if (kzLawnC > 0.001) {
      float kzDrift = kazeFbm(vCarpetXZ * 0.16 + vec2(0.13, 0.57)) + kazeFbm(vCarpetXZ * 0.53 + vec2(0.71, 0.29)) * 0.3;
      kzDrift = smoothstep(-0.62, 0.02, kzDrift + (kzDens - 0.55) * 0.7);
      kzCov = mix(kzCov, max(kzCov, 0.62) * kzDrift, kzLawnC);
    }
    if (kzCov < 0.01) discard;
    float kzWG = kzLit.g / max(kzLit.r + kzLit.g, 1e-3);
    vec2 kzUV1 = vCarpetXZ * 0.42;
    vec2 kzUV2 = mat2(0.8, -0.6, 0.6, 0.8) * vCarpetXZ * 0.36 + vec2(0.37, 0.61);
    vec4 kzA1 = mix(texture(uTexMaple, kzUV1), texture(uTexGinkgo, kzUV1), kzWG);
    vec4 kzA2 = mix(texture(uTexMaple, kzUV2), texture(uTexGinkgo, kzUV2), kzWG);
    // mip-coverage compensation: keep the carpet dense in the distance
    vec2 kzTs = kzUV1 * 1024.0;
    float kzLod = max(0.0, 0.5 * log2(max(dot(dFdx(kzTs), dFdx(kzTs)), dot(dFdy(kzTs), dFdy(kzTs)))));
    float kzBoost = 1.0 + kzLod * 0.35;
    vec3 kzCol = kzA1.a > 0.45 ? kzA1.rgb : kzA2.rgb * 0.82;
    // older drifts brown and dull, fresh falls stay golden: tone patches at the scale of a few metres
    float kzAge = smoothstep(0.05, 0.55, kazeFbm(vCarpetXZ * 0.09 + vec2(0.47, 0.11)));
    kzCol = mix(kzCol, kzCol * vec3(0.78, 0.6, 0.46), kzAge * 0.55);
    diffuseColor.rgb = kzCol * (0.85 + 0.25 * kzN);
    // a drift thins out leaf by leaf (a noise of ~14 cm cells against the coverage) instead of ending on a smooth
    // outline cut through the leaves, which reads as a decal; far away the noise averages out to the plain coverage
    float kzRag = 0.15 + 0.7 * clamp(kazeFbm(vCarpetXZ * 1.8 + vec2(0.53, 0.19)) * 0.5 + 0.5, 0.0, 1.0);
    diffuseColor.a = clamp(max(kzA1.a, kzA2.a * 0.95) * kzBoost, 0.0, 1.0) * smoothstep(kzRag - 0.06, kzRag + 0.06, kzCov);
  }
`;

// fallen leaves are dry and matte: a flat carpet with the default dielectric sheen turned into pale, sharp-edged
// patches under the low backlight (the grazing-angle specular of the whole drift at once)
const FRAG_MATTE = /* glsl */ `
  material.specularColor = vec3(0.0);
  material.specularColorBlended = vec3(0.0);
  material.specularF90 = 0.0;
`;

export class LeafCarpet {
  constructor({ litterMask, tiles, cells = 112, fade = [70, 106], msaa = 0 }) {
    this.cells = cells;
    const V = cells + 1;
    const pos = new Float32Array(V * V * 3);
    for (let j = 0; j < V; j++)
      for (let i = 0; i < V; i++) {
        const o = (j * V + i) * 3;
        pos[o] = i * CELL;
        pos[o + 1] = 0;
        pos[o + 2] = j * CELL;
      }
    const idx = new Uint32Array(cells * cells * 6);
    let k = 0;
    for (let b = 0; b < cells; b++)
      for (let a = 0; a < cells; a++) {
        const v00 = b * V + a, v10 = v00 + 1, v01 = v00 + V, v11 = v01 + 1;
        // same diagonal as the terrain chunks (v01–v10)
        idx[k++] = v00;
        idx[k++] = v01;
        idx[k++] = v10;
        idx[k++] = v01;
        idx[k++] = v11;
        idx[k++] = v10;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uCarpetOrigin: { value: new THREE.Vector2() },
      uCarpetCenter: { value: new THREE.Vector3() },
      uCarpetFade: { value: new THREE.Vector2(fade[0], fade[1]) },
      uCarpetHalf: { value: 1024 },
      uLitterMask: { value: litterMask },
      uTexMaple: { value: tiles.maple },
      uTexGinkgo: { value: tiles.ginkgo },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, alphaTest: 0.5 });
    mat.alphaToCoverage = msaa > 0;
    mat.userData.shaderKey = 'tree-carpet';
    const U = this.uniforms;
    mat.userData.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_PARS)
        .replace('#include <beginnormal_vertex>', VERT)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(kzXZ.x, kzY, kzXZ.y);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + FRAG_DISCARD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + FRAG_MATTE);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'leaf-carpet';
  }

  update(camera) {
    const half = (this.cells * CELL) / 2;
    const ox = Math.round((camera.position.x - half + 1024) / CELL) * CELL - 1024;
    const oz = Math.round((camera.position.z - half + 1024) / CELL) * CELL - 1024;
    this.uniforms.uCarpetOrigin.value.set(ox, oz);
    this.uniforms.uCarpetCenter.value.copy(camera.position);
  }
}
