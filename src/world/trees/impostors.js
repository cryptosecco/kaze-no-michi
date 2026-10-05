import * as THREE from 'three';
import { TREE_UNIFORMS } from './materials.js';

// Far forest: every tree variant is baked once (albedo, alpha) from the side into a 2048² atlas of
// 256×512 cells; the far field is one instanced mesh of camera-facing (Y-axis) cards, lit with a soft
// pseudo-spherical crown normal + the same back-lit translucency as the real leaves, cross-faded against
// LOD1 with the screen-door dither. Cheap enough to cover every tree on the island.

const COLS = 8, ROWS = 4, CW = 256, CH = 512;
export const IMPOSTOR_CAPACITY = COLS * ROWS;

export function bakeImpostors(renderer, variants, barkTextures, atlas) {
  const rt = new THREE.WebGLRenderTarget(COLS * CW, ROWS * CH, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  rt.texture.anisotropy = 4;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  cam.position.set(0, 0, 300);
  cam.lookAt(0, 0, 0);

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();

  renderer.setClearColor(0x4a3322, 0); // foliage-ish colour in the transparent texels: no dark mip fringes
  rt.scissorTest = false;
  rt.viewport.set(0, 0, COLS * CW, ROWS * CH);
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, false);
  renderer.autoClear = false;

  const leafMat = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const barkMats = {};
  const cells = [];
  variants.forEach((v, i) => {
    if (i >= IMPOSTOR_CAPACITY) return;
    const cx = i % COLS, cy = Math.floor(i / COLS);
    const W = v.radius * 2 + 0.6, H = v.box.max.y + 0.5;
    const y0 = -0.35;
    const Hc = Math.max(H - y0, (W * CH) / CW);
    const Wc = (Hc * CW) / CH;
    cam.left = -Wc / 2;
    cam.right = Wc / 2;
    cam.bottom = y0;
    cam.top = y0 + Hc;
    cam.updateProjectionMatrix();
    if (!barkMats[v.kind]) barkMats[v.kind] = new THREE.MeshBasicMaterial({ map: barkTextures[v.kind].map, vertexColors: true, color: v.barkTint });
    const bark = new THREE.Mesh(v.lod0.bark, barkMats[v.kind]);
    const leaves = new THREE.Mesh(v.lod0.leaves, leafMat);
    scene.add(bark, leaves);
    rt.viewport.set(cx * CW, cy * CH, CW, CH);
    rt.scissor.set(cx * CW, cy * CH, CW, CH);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    scene.remove(bark, leaves);
    cells.push({ u0: cx / COLS, u1: (cx + 1) / COLS, v0: cy / ROWS, v1: (cy + 1) / ROWS, w: Wc, h: Hc, y0 });
  });
  rt.scissorTest = false;
  rt.viewport.set(0, 0, COLS * CW, ROWS * CH);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.setClearColor(prevColor, prevAlpha);
  leafMat.dispose();
  for (const k in barkMats) barkMats[k].dispose();
  return { texture: rt.texture, cells, rt };
}

const VERT_PARS = /* glsl */ `
#include <kaze_wind>
attribute vec4 aImpPos;   // base xyz, scale
attribute vec4 aImpUV;    // atlas rect u0 v0 u1 v1
attribute vec4 aImpSize;  // card width, height, base offset, flip
attribute float aImpTint;
uniform vec3 uTreeCam;
uniform vec4 uLodFade;
varying vec2 vTreeFade;
`;

const VERT_BODY = /* glsl */ `
  vec3 kzC = aImpPos.xyz;
  float kzSc = aImpPos.w;
  vec3 kzTo = uTreeCam - kzC;
  kzTo.y = 0.0;
  float kzDist = length(kzTo);
  vec3 kzFwd = kzTo / max(kzDist, 1e-3);
  vec3 kzRight = vec3(kzFwd.z, 0.0, -kzFwd.x);
  vTreeFade = vec2(smoothstep(uLodFade.x, uLodFade.y, kzDist), 1.0 - smoothstep(uLodFade.z, uLodFade.w, kzDist));
  float kzAlive = step(0.0001, vTreeFade.x) * step(0.0001, vTreeFade.y);
  vec2 kzWind = kazeWindBend(kzC.xz);
  vec3 kzPos = kzC + kzRight * (position.x * aImpSize.x * kzSc) + vec3(0.0, (aImpSize.z + position.y * aImpSize.y) * kzSc, 0.0);
  kzPos.xz += kzWind * (position.y * position.y) * 0.35 * kzSc;
  // tilt the card back a little so it doesn't read as a vertical sheet from above
  kzPos -= kzFwd * position.y * aImpSize.y * kzSc * 0.12;
  kzPos = mix(kzC, kzPos, kzAlive);
  float kzU = aImpSize.w > 0.5 ? 1.0 - uv.x : uv.x;
  vMapUv = vec2(mix(aImpUV.x, aImpUV.z, kzU), mix(aImpUV.y, aImpUV.w, uv.y));
  vec3 objectNormal = normalize(kzFwd * 0.7 + kzRight * position.x * 1.1 + vec3(0.0, 0.25 + position.y * 0.45, 0.0));
#ifdef USE_COLOR
  vColor.rgb = vec3(aImpTint);
#endif
`;

export function makeImpostorMesh(entries, cells, texture, lodFade, msaa) {
  // entries: [{ x, y, z, scale, variant, flip, tint }]
  const n = entries.length;
  const pos = new Float32Array(n * 4), uvr = new Float32Array(n * 4), size = new Float32Array(n * 4), tint = new Float32Array(n);
  let k = 0;
  for (const e of entries) {
    const c = cells[e.variant];
    if (!c) continue;
    pos.set([e.x, e.y, e.z, e.scale], k * 4);
    uvr.set([c.u0, c.v0, c.u1, c.v1], k * 4);
    size.set([c.w, c.h, c.y0, e.flip ? 1 : 0], k * 4);
    tint[k] = e.tint;
    k++;
  }
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  base.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  base.setIndex([0, 1, 2, 1, 3, 2]);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.setAttribute('aImpPos', new THREE.InstancedBufferAttribute(pos.subarray(0, k * 4), 4));
  geo.setAttribute('aImpUV', new THREE.InstancedBufferAttribute(uvr.subarray(0, k * 4), 4));
  geo.setAttribute('aImpSize', new THREE.InstancedBufferAttribute(size.subarray(0, k * 4), 4));
  geo.setAttribute('aImpTint', new THREE.InstancedBufferAttribute(tint.subarray(0, k), 1));
  geo.instanceCount = k;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const uniforms = { uLodFade: { value: lodFade }, ...TREE_UNIFORMS };
  const mat = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, roughness: 0.85, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
  mat.alphaToCoverage = msaa > 0;
  mat.userData.shaderKey = 'tree-impostor';
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = kzPos;')
      .replace('#include <color_vertex>', '#include <color_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vTreeFade;
uniform vec3 uLeafTrans;
uniform float uLeafWrap;
uniform float uAtlasSize;
vec3 kzLeafTrans = vec3(0.0);
float kzIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  { float kzN = kzIGN(gl_FragCoord.xy); if (kzN >= vTreeFade.y || kzN < 1.0 - vTreeFade.x) discard; }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  {
    vec2 kzTs = vMapUv * uAtlasSize;
    float kzLod = max(0.0, 0.5 * log2(max(dot(dFdx(kzTs), dFdx(kzTs)), dot(dFdy(kzTs), dFdy(kzTs)))));
    diffuseColor.a *= 1.0 + kzLod * 0.3;
  }`
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\n  kzLeafTrans = diffuseColor.rgb * uLeafTrans * 0.8;')
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
#undef RE_Direct
void RE_Direct_Imp(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float NoL = dot(geometryNormal, directLight.direction);
  float wrapNL = clamp((NoL + uLeafWrap) / (1.0 + uLeafWrap), 0.0, 1.0);
  reflectedLight.directDiffuse += wrapNL * directLight.color * BRDF_Lambert(material.diffuseContribution);
  float VoL = clamp(dot(-geometryViewDir, directLight.direction), 0.0, 1.0);
  reflectedLight.directDiffuse += directLight.color * kzLeafTrans * (0.35 * pow(VoL, 3.0) + 0.9 * pow(VoL, 14.0));
}
#define RE_Direct RE_Direct_Imp`
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'tree-impostors';
  return mesh;
}
