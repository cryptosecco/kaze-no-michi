import * as THREE from 'three';
import { TerrainGen, GRID_N, CELL } from './TerrainGen.js';
import { WORLD } from './Layout.js';
import { registerChunk, registerGlobalUniforms } from '../render/globals.js';
import '../render/fieldPalette.js';
import assets from 'virtual:kaze-assets';

// Terrain of Hoshigashima: 16×16 LOD chunks (2 m and 8 m grids, skirts hide cracks) + a far ring out to
// ~7 km, a splat material driven by the generated masks, and GPU textures for vertex-shader sampling:
//   heightTexture (R32F, exact mesh heights)  maskTexture (R grass, G pampas, B flowers, A path)
//   surfTexture (R rock, G forest, B sand, A wet)  lightTexture (R baked sun visibility, G horizon AO)
// GLSL: #include <kaze_terrain> → kazeTerrainHeight(xz), kazeTerrainMask(xz), kazeTerrainSurf(xz), kazeTerrainLight(xz)

registerChunk(
  'kaze_terrain',
  /* glsl */ `
#ifndef KAZE_TERRAIN
#define KAZE_TERRAIN
uniform highp sampler2D uTerrainHeight;
uniform highp sampler2D uTerrainHeightL;
uniform sampler2D uTerrainMask;
uniform sampler2D uTerrainSurf;
uniform sampler2D uTerrainLight;
const float KZ_HALF = ${WORLD.half.toFixed(1)};
const float KZ_CELL = ${CELL.toFixed(1)};
const float KZ_N = ${GRID_N.toFixed(1)};
float kazeTerrainHeight(vec2 xz) {
  vec2 f = clamp((xz + KZ_HALF) / KZ_CELL, vec2(0.0), vec2(KZ_N - 1.001));
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  float h00 = texelFetch(uTerrainHeight, i, 0).r;
  float h10 = texelFetch(uTerrainHeight, i + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uTerrainHeight, i + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uTerrainHeight, i + ivec2(1, 1), 0).r;
  if (t.x + t.y <= 1.0) return h00 + (h10 - h00) * t.x + (h01 - h00) * t.y;
  return h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
}
vec2 kazeTerrainUV(vec2 xz) { return ((xz + KZ_HALF) / KZ_CELL + 0.5) / KZ_N; }
// one filtered fetch (half float): ~cm accuracy in the lowlands, for dense vegetation
float kazeTerrainHeightFast(vec2 xz) { return textureLod(uTerrainHeightL, kazeTerrainUV(xz), 0.0).r; }
vec4 kazeTerrainMask(vec2 xz) { return textureLod(uTerrainMask, kazeTerrainUV(xz), 0.0); }
vec4 kazeTerrainSurf(vec2 xz) { return textureLod(uTerrainSurf, kazeTerrainUV(xz), 0.0); }
vec4 kazeTerrainLight(vec2 xz) { return textureLod(uTerrainLight, (xz + KZ_HALF) / (2.0 * KZ_HALF), 0.0); }
#endif
`
);

// Shading code shared by near chunks and the far ring.
const TERRAIN_FRAG_PARS = /* glsl */ `
#include <kaze_field>
#include <kaze_terrain>
#include <kaze_atmosphere>
#include <kaze_wind>
varying vec3 vTerrainWorld;
#ifdef KAZE_TERRAIN_PHOTO
uniform sampler2D uTexGrass;
uniform sampler2D uTexDirt;
uniform sampler2D uTexRock;
uniform vec3 uTexAvg[3];
#endif
float kzRough = 0.9;
float kzAO = 1.0;
float kzSunVis = 1.0;
// grazed lawns (Grass.setLawn, shared uniform): olive turf instead of the field's dry golden thatch
#include <kaze_lawn>
float kzCanopy = 0.0;
vec3 kzCanopyTrans = vec3(0.0);
vec3 kzSunDirV = vec3(0.0, 1.0, 0.0);

// autumn forest seen from afar: a crown-scale mottle of evergreen, maple red and ginkgo gold
vec3 kazeForestCanopy(vec2 xz) {
  float region = kazeFbm(xz * 0.0031 + vec2(7.1, 2.2));        // broad stands (more red in some valleys)
  float crown = kazeFbm(xz * 0.061 + vec2(2.3, 5.5));          // individual crowns (~15 m)
  float crown2 = kazeFbm(xz * 0.17 + vec2(9.1, 0.4));
  vec3 pine = vec3(0.02, 0.036, 0.018);
  vec3 maple = vec3(0.24, 0.04, 0.018);
  vec3 ginkgo = vec3(0.3, 0.17, 0.025);
  float redShare = mix(0.18, 0.45, smoothstep(-0.3, 0.4, region));
  float t = crown * 0.5 + 0.5;
  vec3 c = pine;
  c = mix(c, maple, smoothstep(1.0 - redShare - 0.08, 1.0 - redShare + 0.08, t));
  c = mix(c, ginkgo, smoothstep(0.62, 0.8, crown2 * 0.5 + 0.5) * 0.55);
  return c * (0.7 + 0.5 * (crown2 * 0.5 + 0.5));
}

vec3 kzPerturb(vec3 surfPos, vec3 surfNorm, float h) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}

#ifdef KAZE_TERRAIN_PHOTO
vec3 kzTri(sampler2D tex, vec3 p, vec3 n, float scale) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z);
  return texture2D(tex, p.zy * scale).rgb * w.x + texture2D(tex, p.xz * scale).rgb * w.y + texture2D(tex, p.xy * scale).rgb * w.z;
}
#endif
`;

const TERRAIN_COLOR = /* glsl */ `
  vec2 kxz = vTerrainWorld.xz;
  float kdist = distance(vTerrainWorld, cameraPosition);
  vec3 kWN = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
  float n1 = kazeFbm(kxz * 0.043);
  float n2 = kazeFbm(kxz * 0.31 + vec2(3.7, 1.9));
  // fine detail only where it can be resolved (saves fetches on the far half of the screen)
  float n3 = 0.0;
  if (kdist < 120.0) n3 = kazeFbm(kxz * 1.9 + vec2(1.3, 7.7));
#ifdef KAZE_TERRAIN_FAR
  vec4 kmask = vec4(0.0);
  float slopeRock = smoothstep(0.62, 0.48, kWN.y);
  float coastSand = smoothstep(4.0, 1.5, vTerrainWorld.y) * (1.0 - slopeRock);
  vec4 ksurf = vec4(slopeRock, (1.0 - slopeRock) * smoothstep(3.0, 12.0, vTerrainWorld.y), coastSand, 0.0);
  vec4 klit = vec4(1.0);
#else
  vec4 kmask = texture(uTerrainMask, kazeTerrainUV(kxz));
  vec4 ksurf = texture(uTerrainSurf, kazeTerrainUV(kxz));
  vec4 klit = texture(uTerrainLight, (kxz + KZ_HALF) / (2.0 * KZ_HALF));
#endif
  // matted dry grass / soil under the blades
  vec3 soil = mix(vec3(0.034, 0.025, 0.015), vec3(0.062, 0.046, 0.027), n2 * 0.5 + 0.5);
  vec3 kcol = soil * 1.2;
  vec3 canopy = vec3(0.0);
  float clumps = 0.5;
  float canopyT = smoothstep(10.0, 70.0, kdist);
  if (kmask.r > 0.004) {
    // thatch: matted stems and dead blades as a soft mottle (the fine detail comes from the blades drawn over it)
    float thatch = 0.5 + 0.35 * n3 * (1.0 - smoothstep(20.0, 60.0, kdist));
    // canopy texture: wind-combed clumps with dark gaps (keeps distant fields from reading as sand)
    if (kdist < 450.0) {
      vec2 comb = vec2(kxz.x * 0.9 + kxz.y * 0.35, kxz.y * 0.28 - kxz.x * 0.12);
      float clumpA = kazeFbm(comb * 0.55 + vec2(1.3, 0.2)) * 0.5 + 0.5;
      clumps = mix(0.5, clumpA, 1.0 - smoothstep(150.0, 450.0, kdist));
    }
    float clumpB = kazeFbm(kxz * 0.12 + vec2(0.4, 3.3)) * 0.5 + 0.5;
    float canopyShade = mix(0.5, 1.12, clumps) * mix(0.8, 1.1, clumpB);
    canopy = kazeFieldCanopy(kxz, kmask) * (0.62 + 0.3 * (n1 * 0.5 + 0.5)) * canopyShade;
    // olive hollows and rust drifts at the 50–200 m scale
    float hollow = smoothstep(0.1, 0.6, kazeFbm(kxz * 0.007 + vec2(5.1, 2.7)));
    canopy = mix(canopy, canopy * vec3(0.62, 0.8, 0.5), hollow * 0.55);
    // under the blades: the field's dead thatch, in tone with the foot of the stems (Grass.js), never bare soil
    vec3 dryMat = mix(KZ_THATCH * mix(0.75, 1.1, thatch) * (0.9 + 0.1 * n2), canopy * 0.7, 0.3);
    vec3 grassCol = mix(dryMat, canopy * 0.86, canopyT);
    kcol = mix(kcol, grassCol, kmask.r);
  }
  float kzLawnF = kmask.r > 0.004 ? kazeLawnAt(kxz) : 0.0;
  if (kzLawnF > 0.001) {
    // olive turf
    vec3 turf = mix(vec3(0.075, 0.1, 0.026), vec3(0.14, 0.16, 0.045), n2 * 0.5 + 0.5) * (0.85 + 0.3 * n3);
    kcol = mix(kcol, turf, kzLawnF * kmask.r * (1.0 - kmask.a));
  }
  // packed-earth path with ruts and pebbles
  vec3 pathCol = mix(vec3(0.27, 0.2, 0.125), vec3(0.4, 0.31, 0.19), n3 * 0.5 + 0.5) * (0.85 + 0.25 * n2);
  kcol = mix(kcol, pathCol, kmask.a);
  // forest floor (red leaf litter) near, autumn forest canopy far
  if (ksurf.g > 0.004) {
    vec3 forestFloor = mix(vec3(0.045, 0.03, 0.017), vec3(0.15, 0.045, 0.02), smoothstep(0.05, 0.6, n2));
    float forestFarT = smoothstep(260.0, 800.0, kdist);
    vec3 forestCol = forestFloor;
    if (forestFarT > 0.0) forestCol = mix(forestFloor, kazeForestCanopy(kxz), forestFarT);
    kcol = mix(kcol, forestCol, ksurf.g * (0.7 + 0.3 * forestFarT));
  }
  // rock with moss on up-facing surfaces; trees cling to all but the sheerest faces
  if (ksurf.r > 0.004) {
    vec3 rockCol = mix(vec3(0.07, 0.065, 0.058), vec3(0.15, 0.135, 0.11), n2 * 0.5 + 0.5) * (0.78 + 0.3 * n3);
    rockCol = mix(rockCol, vec3(0.05, 0.07, 0.025), smoothstep(0.55, 0.95, kWN.y) * (0.35 + 0.35 * n1));
    kcol = mix(kcol, rockCol, ksurf.r * mix(1.0, 0.55, ksurf.g * smoothstep(300.0, 700.0, kdist)));
  }
  // beach sand, darker when wet
  vec3 sandCol = mix(vec3(0.42, 0.37, 0.28), vec3(0.2, 0.18, 0.15), ksurf.a);
  kcol = mix(kcol, sandCol, ksurf.b);
#ifdef KAZE_TERRAIN_PHOTO
  float photoT = 1.0 - smoothstep(25.0, 90.0, kdist);
  if (photoT > 0.001) {
    vec3 tg = texture2D(uTexGrass, kxz * 0.33).rgb / max(uTexAvg[0], vec3(0.02));
    vec3 td = texture2D(uTexDirt, kxz * 0.4).rgb / max(uTexAvg[1], vec3(0.02));
    vec3 tr = kzTri(uTexRock, vTerrainWorld, kWN, 0.17) / max(uTexAvg[2], vec3(0.02));
    vec3 detail = mix(tg, td, max(kmask.a, 1.0 - kmask.r));
    detail = mix(detail, tr, ksurf.r);
    kcol *= mix(vec3(1.0), clamp(detail, 0.2, 2.5), photoT);
  }
#endif
  diffuseColor.rgb = kcol;
  kzRough = mix(0.93, 0.86, kmask.a);
  kzRough = mix(kzRough, 0.78, ksurf.r);
  kzRough = mix(kzRough, mix(0.85, 0.35, ksurf.a), ksurf.b);
  kzAO = mix(1.0, klit.g, 0.6);
  // baked heightfield shadows only beyond the shadow-map range (4 m texels are too coarse up close)
  kzSunVis = mix(1.0, klit.r, smoothstep(110.0, 220.0, kdist));
  // the ground between dense blades sits in their shade (but light still filters through the thatch)
  float under = kmask.r * (1.0 - canopyT) * (1.0 - kmask.a) * (1.0 - 0.8 * kzLawnF);
  kzAO *= mix(1.0, 0.7, under);
  kzSunVis *= mix(1.0, 0.8, under);
  // grass canopy: wrap lighting + translucency so fields glow toward the sun like the blades (half strength on
  // the near thatch, whose blades are drawn)
  kzCanopy = kmask.r * (1.0 - kmask.a) * (1.0 - ksurf.r) * (1.0 - ksurf.g * 0.8) * mix(0.5, 1.0, smoothstep(8.0, 60.0, kdist)) * (1.0 - 0.8 * kzLawnF);
  kzCanopyTrans = canopy * vec3(1.0, 0.82, 0.55) * 0.5 * clumps;
  if (kzCanopy > 0.01) {
    // travelling gust fronts keep rolling across the fields beyond the grass rings (the blades' sheen ramp)
    float gw = smoothstep(0.35, 0.9, kazeGust(kxz));
    diffuseColor.rgb *= 1.0 + gw * 0.6 * kzCanopy;
    kzCanopyTrans *= 1.0 + gw * 0.8;
  }
  kzSunDirV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
`;

const TERRAIN_NORMAL = /* glsl */ `
  {
    float fade1 = 1.0 - smoothstep(25.0, 110.0, kdist);
    float fade2 = 1.0 - smoothstep(120.0, 600.0, kdist);
    float bump = n1 * 0.42 * fade2 + n2 * 0.07 * fade1 + n3 * 0.025 * fade1;
    bump *= mix(1.0, 3.5, ksurf.r);
#ifndef KAZE_TERRAIN_FAR
    // tree crowns: lumpy canopy relief on distant forest
    float crownW = ksurf.g * smoothstep(120.0, 400.0, kdist) * (1.0 - smoothstep(1400.0, 2400.0, kdist));
    if (crownW > 0.001) bump += (kazeFbm(kxz * 0.09 + vec2(4.4, 1.2)) * 3.2 + kazeFbm(kxz * 0.23) * 1.1) * crownW;
#endif
    normal = kzPerturb(-vViewPosition, normal, bump);
    // grass-covered ground is lit like a canopy: blades, not the soil's micro-slopes, catch the light
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    normal = normalize(mix(normal, upV, kmask.r * (1.0 - kmask.a) * 0.65));
  }
`;

const TERRAIN_RE_DIRECT = /* glsl */ `
#undef RE_Direct
void RE_Direct_Terrain(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  IncidentLight l = directLight;
  if (dot(l.direction, kzSunDirV) > 0.9995) l.color *= kzSunVis;
  if (kzCanopy > 0.001) {
    float NoL = dot(geometryNormal, l.direction);
    float wrap = clamp((NoL + 0.55) / 1.55, 0.0, 1.0);
    reflectedLight.directDiffuse += l.color * BRDF_Lambert(material.diffuseContribution) * max(wrap - max(NoL, 0.0), 0.0) * kzCanopy * 0.55;
    float back = pow(clamp(dot(-geometryViewDir, l.direction), 0.0, 1.0), 3.0);
    reflectedLight.directDiffuse += l.color * kzCanopyTrans * back * kzCanopy * 0.9;
  }
  RE_Direct_Physical(l, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}
#define RE_Direct RE_Direct_Terrain
`;

function makeTerrainMaterial(far, photo) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0, envMapIntensity: 0.72 });
  mat.userData.shaderKey = 'terrain' + (far ? '-far' : '') + (photo ? '-photo' : '');
  mat.defines = {};
  if (far) mat.defines.KAZE_TERRAIN_FAR = '';
  if (photo) mat.defines.KAZE_TERRAIN_PHOTO = '';
  mat.userData.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TERRAIN_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + TERRAIN_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = kzRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TERRAIN_NORMAL)
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + TERRAIN_RE_DIRECT)
      .replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= kzAO * mix(vec3(1.0), vec3(1.12, 0.96, 0.78), kmask.r);\n  reflectedLight.indirectSpecular *= kzAO * mix(0.3, 0.6, ksurf.r);\n  reflectedLight.directSpecular *= mix(0.45, 1.0, ksurf.r);'
      );
  };
  return mat;
}

export class Terrain {
  constructor({ seed = 1234, quality }) {
    this.quality = quality;
    this.gen = new TerrainGen(seed).generate();
    this.size = WORLD.size;
    this.half = WORLD.half;
    this.group = new THREE.Group();
    this.group.name = 'terrain';

    const N = GRID_N;
    // --- GPU textures
    this.heightTexture = new THREE.DataTexture(this.gen.H, N, N, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.minFilter = this.heightTexture.magFilter = THREE.NearestFilter;
    this.heightTexture.generateMipmaps = false;
    this.heightTexture.needsUpdate = true;
    const half = new Uint16Array(N * N);
    for (let i = 0; i < N * N; i++) half[i] = THREE.DataUtils.toHalfFloat(this.gen.H[i]);
    this.heightTextureLinear = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTextureLinear.minFilter = this.heightTextureLinear.magFilter = THREE.LinearFilter;
    this.heightTextureLinear.generateMipmaps = false;
    this.heightTextureLinear.needsUpdate = true;

    const mk = (data) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.maskTexture = mk(this.gen.mask);
    this.surfTexture = mk(this.gen.surf);
    this.lightTexture = new THREE.DataTexture(new Uint8Array(4 * 4).fill(255), 2, 2);
    this.lightTexture.needsUpdate = true;

    this.uniforms = registerGlobalUniforms({
      uTerrainHeight: { value: this.heightTexture },
      uTerrainHeightL: { value: this.heightTextureLinear },
      uTerrainMask: { value: this.maskTexture },
      uTerrainSurf: { value: this.surfTexture },
      uTerrainLight: { value: this.lightTexture },
    });

    this.material = makeTerrainMaterial(false, false);
    this.farMaterial = makeTerrainMaterial(true, false);
    this._buildChunks();
    this._buildFarRing();
  }

  heightAt(x, z) {
    return this.gen.heightAt(x, z);
  }
  normalAt(x, z, out = new THREE.Vector3()) {
    return this.gen.normalAt(x, z, out);
  }
  surfaceAt(x, z) {
    return this.gen.surfaceAt(x, z);
  }

  bakeLighting(sunDir) {
    const { data, res } = this.gen.bakeLighting(sunDir, 512);
    if (!this._lightTex || this._lightTex.image.width !== res) {
      this._lightTex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._lightTex.minFilter = THREE.LinearFilter;
      this._lightTex.magFilter = THREE.LinearFilter;
      this._lightTex.generateMipmaps = false;
      this._lightTex.colorSpace = THREE.NoColorSpace;
      this.uniforms.uTerrainLight.value = this._lightTex;
    } else {
      this._lightTex.image.data.set(data);
    }
    this._lightTex.needsUpdate = true;
  }

  // Try to load optional photographic detail textures from /assets/textures (added by the art pass).
  async loadPhotoTextures(renderer) {
    const names = ['ground_grass', 'ground_dirt', 'rock_moss'];
    if (!names.every((n) => assets.textures.includes(n + '.jpg'))) return false;
    const loader = new THREE.TextureLoader();
    const load = (n) =>
      new Promise((res) => {
        loader.load(`assets/textures/${n}.jpg`, (t) => res(t), undefined, () => res(null));
      });
    const texs = await Promise.all(names.map(load));
    if (texs.some((t) => !t)) return false;
    const avgs = texs.map((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      t.needsUpdate = true;
      // mean colour (linear) so the texture only contributes detail, the palette stays art-directed
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const g = c.getContext('2d');
      g.drawImage(t.image, 0, 0, 16, 16);
      const px = g.getImageData(0, 0, 16, 16).data;
      const acc = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) acc[k] += Math.pow(px[i + k] / 255, 2.2);
      return new THREE.Vector3(acc[0] / 256, acc[1] / 256, acc[2] / 256);
    });
    const mat = makeTerrainMaterial(false, true);
    const prev = mat.userData.onBeforeCompile;
    mat.userData.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      shader.uniforms.uTexGrass = { value: texs[0] };
      shader.uniforms.uTexDirt = { value: texs[1] };
      shader.uniforms.uTexRock = { value: texs[2] };
      shader.uniforms.uTexAvg = { value: avgs };
    };
    this._swapMaterial(this.material, mat);
    this.material = mat;
    return true;
  }

  _swapMaterial(oldMat, newMat) {
    this.group.traverse((o) => {
      if (o.isMesh && o.material === oldMat) o.material = newMat;
    });
    if (this.onMaterialSwap) this.onMaterialSwap(newMat);
  }

  _buildChunks() {
    const CH = 16;
    const chunkSize = WORLD.size / CH; // 128 m
    const cellsPerChunk = chunkSize / CELL; // 64
    const lods = [
      { step: 1, skirt: 5 },
      { step: 4, skirt: 14 },
    ];
    const indexCache = new Map();
    const g = this.gen;
    const N = GRID_N;
    const normalAtGrid = (i, j, out, o) => {
      const hl = g.hAt(i - 1, j), hr = g.hAt(i + 1, j), hd = g.hAt(i, j - 1), hu = g.hAt(i, j + 1);
      let nx = hl - hr, ny = 2 * CELL, nz = hd - hu;
      const l = Math.hypot(nx, ny, nz);
      out[o] = nx / l;
      out[o + 1] = ny / l;
      out[o + 2] = nz / l;
    };

    const buildIndex = (q) => {
      if (indexCache.has(q)) return indexCache.get(q);
      const V = q + 1;
      const idx = [];
      for (let b = 0; b < q; b++) {
        for (let a = 0; a < q; a++) {
          const v00 = b * V + a, v10 = v00 + 1, v01 = v00 + V, v11 = v01 + 1;
          idx.push(v00, v01, v10, v01, v11, v10);
        }
      }
      // skirts: 4 edges, each edge vertex duplicated below (appended after the grid)
      const base = V * V;
      const edges = [];
      for (let a = 0; a <= q; a++) edges.push([a, 0]); // z-min edge
      for (let b = 0; b <= q; b++) edges.push([q, b]); // x-max edge
      for (let a = q; a >= 0; a--) edges.push([a, q]); // z-max edge
      for (let b = q; b >= 0; b--) edges.push([0, b]); // x-min edge
      for (let k = 0; k < edges.length - 1; k++) {
        const [a0, b0] = edges[k], [a1, b1] = edges[k + 1];
        if (a0 === a1 && b0 === b1) continue;
        const t0 = b0 * V + a0, t1 = b1 * V + a1, s0 = base + k, s1 = base + k + 1;
        idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);
      }
      const attr = { idx, edges };
      indexCache.set(q, attr);
      return attr;
    };

    this.chunks = [];
    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const i0 = cx * cellsPerChunk, j0 = cz * cellsPerChunk;
        const cxw = -WORLD.half + (cx + 0.5) * chunkSize, czw = -WORLD.half + (cz + 0.5) * chunkSize;
        const lod = new THREE.LOD();
        lod.position.set(cxw, 0, czw);
        lod.name = `chunk_${cx}_${cz}`;
        for (let li = 0; li < lods.length; li++) {
          const { step, skirt } = lods[li];
          const q = cellsPerChunk / step;
          const V = q + 1;
          const { idx, edges } = buildIndex(q);
          const nVerts = V * V + edges.length;
          const pos = new Float32Array(nVerts * 3);
          const nor = new Float32Array(nVerts * 3);
          for (let b = 0; b <= q; b++) {
            for (let a = 0; a <= q; a++) {
              const gi = i0 + a * step, gj = j0 + b * step;
              const v = b * V + a;
              pos[v * 3] = -WORLD.half + gi * CELL - cxw;
              pos[v * 3 + 1] = g.H[Math.min(N - 1, gj) * N + Math.min(N - 1, gi)];
              pos[v * 3 + 2] = -WORLD.half + gj * CELL - czw;
              normalAtGrid(gi, gj, nor, v * 3);
            }
          }
          for (let k = 0; k < edges.length; k++) {
            const [a, b] = edges[k];
            const src = b * V + a, dst = V * V + k;
            pos[dst * 3] = pos[src * 3];
            pos[dst * 3 + 1] = pos[src * 3 + 1] - skirt;
            pos[dst * 3 + 2] = pos[src * 3 + 2];
            nor[dst * 3] = nor[src * 3];
            nor[dst * 3 + 1] = nor[src * 3 + 1];
            nor[dst * 3 + 2] = nor[src * 3 + 2];
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
          geo.setIndex(idx);
          geo.computeBoundingSphere();
          geo.computeBoundingBox();
          const mesh = new THREE.Mesh(geo, this.material);
          mesh.castShadow = li === 0;
          mesh.receiveShadow = true;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          lod.addLevel(mesh, li === 0 ? 0 : this.quality.terrainLodDist);
        }
        lod.updateMatrix();
        this.group.add(lod);
        this.chunks.push(lod);
      }
    }
  }

  _buildFarRing() {
    const g = this.gen;
    const SP = 64;
    const EXT = 7168;
    const n = (EXT * 2) / SP; // cells per side
    const V = n + 1;
    const pos = new Float32Array(V * V * 3);
    const nor = new Float32Array(V * V * 3);
    for (let b = 0; b <= n; b++) {
      for (let a = 0; a <= n; a++) {
        const x = -EXT + a * SP, z = -EXT + b * SP;
        const v = b * V + a;
        const inside = Math.abs(x) <= WORLD.half && Math.abs(z) <= WORLD.half;
        const h = inside ? g.heightAt(x, z) : g.height(x, z);
        pos[v * 3] = x;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = z;
        const e = 48;
        const hl = g.height(x - e, z), hr = g.height(x + e, z), hd = g.height(x, z - e), hu = g.height(x, z + e);
        let nx = hl - hr, ny = 2 * e, nz = hd - hu;
        const l = Math.hypot(nx, ny, nz);
        nor[v * 3] = nx / l;
        nor[v * 3 + 1] = ny / l;
        nor[v * 3 + 2] = nz / l;
      }
    }
    const idx = [];
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const x0 = -EXT + a * SP, z0 = -EXT + b * SP;
        // skip cells covered by the detailed chunks
        if (x0 >= -WORLD.half && x0 + SP <= WORLD.half && z0 >= -WORLD.half && z0 + SP <= WORLD.half) continue;
        const v00 = b * V + a, v10 = v00 + 1, v01 = v00 + V, v11 = v01 + 1;
        idx.push(v00, v01, v10, v01, v11, v10);
      }
    }
    // inner skirt hanging below the hole's rim (hides slivers where the coarse ring meets the chunks)
    const rim = [];
    const aMin = (EXT - WORLD.half) / SP, aMax = (EXT + WORLD.half) / SP;
    for (let a = aMin; a <= aMax; a++) rim.push([a, aMin]);
    for (let b = aMin + 1; b <= aMax; b++) rim.push([aMax, b]);
    for (let a = aMax - 1; a >= aMin; a--) rim.push([a, aMax]);
    for (let b = aMax - 1; b >= aMin; b--) rim.push([aMin, b]);
    const extra = new Float32Array(rim.length * 3);
    const extraN = new Float32Array(rim.length * 3);
    rim.forEach(([a, b], k) => {
      const v = b * V + a;
      extra[k * 3] = pos[v * 3];
      extra[k * 3 + 1] = pos[v * 3 + 1] - 90;
      extra[k * 3 + 2] = pos[v * 3 + 2];
      extraN[k * 3] = nor[v * 3];
      extraN[k * 3 + 1] = nor[v * 3 + 1];
      extraN[k * 3 + 2] = nor[v * 3 + 2];
    });
    const base = V * V;
    for (let k = 0; k < rim.length - 1; k++) {
      const t0 = rim[k][1] * V + rim[k][0], t1 = rim[k + 1][1] * V + rim[k + 1][0];
      const s0 = base + k, s1 = base + k + 1;
      idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);
    }
    const allPos = new Float32Array(pos.length + extra.length);
    allPos.set(pos);
    allPos.set(extra, pos.length);
    const allNor = new Float32Array(nor.length + extraN.length);
    allNor.set(nor);
    allNor.set(extraN, nor.length);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(allPos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(allNor, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.farMaterial);
    mesh.name = 'terrain_far';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.far = mesh;
    this.group.add(mesh);
  }
}
