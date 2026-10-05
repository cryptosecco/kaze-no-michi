import * as THREE from 'three';
import { getTextures } from './textures.js';

// Material library for architecture & props. All MeshStandardMaterial (lights, sun shadows, IBL and the
// kaze atmosphere come for free via game.add), extended with:
//   - world-space weathering: moss on up-facing / crevice surfaces (uMoss), sun-faded blotches (uFade)
//   - cloth flutter driven by the shared wind field (kaze_wind): per-vertex aFlag = (weight, phase)
// Geometry carries metric UVs; texture density is set per material through map.repeat.

const WORLD_VARY = /* glsl */ `
{
  vec4 kzw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    kzw = instanceMatrix * kzw;
  #endif
  kzw = modelMatrix * kzw;
  vKzW = kzw.xyz;
  vec3 kzn = objectNormal;
  #ifdef USE_INSTANCING
    kzn = mat3(instanceMatrix) * kzn;
  #endif
  vKzN = normalize(mat3(modelMatrix) * kzn);
}
`;

const FLUTTER = /* glsl */ `
vec3 transformed = vec3(position);
vKzShade = 1.0;
{
  vec3 kzwp = (modelMatrix * vec4(position, 1.0)).xyz;
  float g = kazeGust(kzwp.xz);
  vec2 wd = kazeWindDir();
  float w = aFlag.x;
  float ph = aFlag.y;
  // two waves of fixed frequency cross-faded by the gust (a frequency that follows the gust is time times a changing
  // number: the phase races whenever the gust moves)
  float wave = mix(sin(uTime * 3.1 - w * 5.5 + ph), sin(uTime * 5.5 - w * 5.5 + ph * 1.3), clamp(g, 0.0, 1.0)) * 0.65
    + sin(uTime * 6.3 - w * 9.5 + ph * 1.7) * 0.3;
  float amp = w * (0.06 + 0.26 * g) * uFlutter;
  transformed += objectNormal * wave * amp;
  transformed.xz += wd * (g * 0.32 * w * w * uFlutter);
  vKzShade = 1.0 + wave * 0.16 * w * uFlutter;
}
`;

const WEATHER = /* glsl */ `
float kzMoss = 0.0;
{
  float kn1 = kazeFbm(vKzW.xz * 0.43 + vec2(vKzW.y * 0.29, vKzW.y * 0.17));
  float kn2 = kazeFbm(vKzW.xz * 2.1 + vec2(vKzW.y * 1.3, 0.37));
  if (uFade > 0.0) diffuseColor.rgb *= mix(1.0, 0.78 + 0.34 * (kn1 * 0.5 + 0.5), uFade);
  if (uMoss > 0.0) {
    float kao = 1.0;
    #ifdef USE_COLOR
      kao = vColor.g;
    #endif
    kzMoss = uMoss * smoothstep(0.5, 0.84, vKzN.y * 0.38 + kn1 * 0.48 + kn2 * 0.22 + (1.0 - kao) * 1.1);
    vec3 mossCol = mix(vec3(0.07, 0.095, 0.028), vec3(0.2, 0.215, 0.055), kn2 * 0.5 + 0.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, kzMoss);
  }
  #ifdef KZ_FLUTTER
    diffuseColor.rgb *= vKzShade;
  #endif
}
`;

function extend(mat, key, { moss = 0, fade = 0, flutter = 0 } = {}) {
  const uniforms = {
    uMoss: { value: moss },
    uFade: { value: fade },
    uFlutter: { value: flutter },
  };
  mat.userData.shaderKey = 'props-' + key;
  mat.userData.kz = uniforms;
  mat.userData.flutter = flutter > 0;
  if (flutter > 0) mat.defines = { ...(mat.defines || {}), KZ_FLUTTER: '' };
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const vp = `#include <common>
#include <kaze_wind>
varying vec3 vKzW;
varying vec3 vKzN;
${flutter > 0 ? 'attribute vec2 aFlag;\nuniform float uFlutter;\nvarying float vKzShade;' : ''}`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', vp)
      .replace('#include <begin_vertex>', flutter > 0 ? FLUTTER : '#include <begin_vertex>')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + WORLD_VARY);
    const fp = `#include <common>
#include <kaze_common>
varying vec3 vKzW;
varying vec3 vKzN;
uniform float uMoss;
uniform float uFade;
${flutter > 0 ? 'varying float vKzShade;' : ''}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fp)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WEATHER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.97, kzMoss);');
  };
  return mat;
}

function tex(t, repeat) {
  const c = t.clone();
  c.repeat.set(repeat, repeat);
  c.needsUpdate = true;
  return c;
}

let cache = null;

export function getMaterials() {
  if (cache) return cache;
  const T = getTextures();
  const std = (key, params, ext) => extend(new THREE.MeshStandardMaterial({ vertexColors: true, ...params }), key, ext);
  const pbr = (fam, repeat) => ({ map: tex(fam.albedo, repeat), normalMap: tex(fam.normal, repeat) });

  const m = {
    lacquer: std('lacquer', { ...pbr(T.lacquer, 0.5), roughness: 0.6, normalScale: new THREE.Vector2(0.45, 0.45) }, { fade: 0.55 }),
    black: std('black', { ...pbr(T.black, 0.6), roughness: 0.5, normalScale: new THREE.Vector2(0.4, 0.4) }, { fade: 0.3 }),
    stone: std('stone', { ...pbr(T.granite, 0.55), color: new THREE.Color(0.93, 0.92, 0.9), roughness: 0.9, normalScale: new THREE.Vector2(0.9, 0.9) }, { moss: 0.4, fade: 0.2 }),
    stoneStep: std('stoneStep', { ...pbr(T.granite, 0.5), color: new THREE.Color(0.72, 0.73, 0.74), roughness: 0.86, normalScale: new THREE.Vector2(0.7, 0.7) }, { moss: 0.12, fade: 0.25 }),
    stoneMossy: std('stoneMossy', { ...pbr(T.granite, 0.55), color: new THREE.Color(0.86, 0.86, 0.83), roughness: 0.92, normalScale: new THREE.Vector2(1.0, 1.0) }, { moss: 0.8, fade: 0.25 }),
    woodDark: std('woodDark', { ...pbr(T.wood, 0.45), color: new THREE.Color(0.27, 0.2, 0.155), roughness: 0.8, normalScale: new THREE.Vector2(0.8, 0.8) }, { fade: 0.25 }),
    woodAged: std('woodAged', { ...pbr(T.wood, 0.45), color: new THREE.Color(0.66, 0.6, 0.53), roughness: 0.86, normalScale: new THREE.Vector2(1.0, 1.0) }, { fade: 0.3, moss: 0.15 }),
    woodRaw: std('woodRaw', { ...pbr(T.wood, 0.5), color: new THREE.Color(0.58, 0.45, 0.33), roughness: 0.86, normalScale: new THREE.Vector2(1.0, 1.0) }, { fade: 0.35 }),
    plaster: std('plaster', { ...pbr(T.plaster, 0.4), color: new THREE.Color(0.88, 0.86, 0.8), roughness: 0.93, normalScale: new THREE.Vector2(0.5, 0.5) }, { fade: 0.15 }),
    earthWall: std('earthWall', { ...pbr(T.plaster, 0.35), color: new THREE.Color(0.56, 0.46, 0.34), roughness: 0.95, normalScale: new THREE.Vector2(0.8, 0.8) }, { fade: 0.3 }),
    bark: std('bark', { ...pbr(T.bark, 0.42), color: new THREE.Color(0.86, 0.8, 0.76), roughness: 0.93, normalScale: new THREE.Vector2(1.0, 1.0) }, { moss: 0.28, fade: 0.25 }),
    tile: std('tile', { ...pbr(T.tile, 0.42), roughness: 0.66, normalScale: new THREE.Vector2(1.0, 1.0) }, { moss: 0.12, fade: 0.2 }),
    // old silvered thatch (albedo ~0.2, near neutral grey so that dusk light and the warm grade land on brown, not
    // red or olive): its bundles and courses stay readable in the shade and against the light
    thatch: std('thatch', { ...pbr(T.thatch, 0.4), color: new THREE.Color(1.6, 1.82, 2.2), roughness: 1.0, normalScale: new THREE.Vector2(1.4, 1.4) }, { moss: 0.15, fade: 0.4 }),
    // the trimmed eave edge: the cut butt ends of the straw, denser and a little darker
    thatchEdge: std('thatchEdge', { ...pbr(T.thatch, 0.85), color: new THREE.Color(1.3, 1.48, 1.75), roughness: 1.0, normalScale: new THREE.Vector2(1.6, 1.6) }, { fade: 0.35 }),
    straw: std('straw', { ...pbr(T.straw, 0.9), color: new THREE.Color(0.92, 0.84, 0.66), roughness: 0.95, normalScale: new THREE.Vector2(1.0, 1.0) }, { fade: 0.2 }),
    tent: std('tent', { ...pbr(T.cloth, 0.6), color: new THREE.Color(0.34, 0.28, 0.21), roughness: 0.95, side: THREE.DoubleSide }, { fade: 0.45, flutter: 0.45 }),
    // dark oiled tarps (lean-to, covers thrown over the piles)
    tarp: std('tarp', { ...pbr(T.cloth, 0.7), color: new THREE.Color(0.2, 0.21, 0.23), roughness: 0.9, side: THREE.DoubleSide }, { fade: 0.5, flutter: 0.3 }),
    banner: std('banner', { map: T.banners, roughness: 0.92, side: THREE.DoubleSide, alphaTest: 0.5 }, { fade: 0.2, flutter: 1.0 }),
    paper: std('paper', { map: T.shide, roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.5, color: new THREE.Color(1.1, 1.08, 1.02) }, { flutter: 1.3 }),
    redCloth: std('redCloth', { ...pbr(T.cloth, 1.2), color: new THREE.Color(0.62, 0.07, 0.045), roughness: 0.95, side: THREE.DoubleSide }, { fade: 0.4, flutter: 0.35 }),
    bronze: std('bronze', { color: new THREE.Color(0.2, 0.3, 0.24), metalness: 0.55, roughness: 0.52 }, { fade: 0.6 }),
    iron: std('iron', { color: new THREE.Color(0.07, 0.065, 0.06), metalness: 0.65, roughness: 0.55 }, { fade: 0.4 }),
    ash: std('ash', { ...pbr(T.granite, 1.0), color: new THREE.Color(0.14, 0.13, 0.12), roughness: 1.0 }, {}),
    charcoal: std('charcoal', { ...pbr(T.wood, 1.0), color: new THREE.Color(0.06, 0.05, 0.045), roughness: 0.95, emissive: new THREE.Color(0.9, 0.22, 0.03), emissiveIntensity: 0.0 }, {}),
  };
  // loose straw hanging below the thatch eaves (alpha strip: u in metres along the eave, v down the strands)
  {
    const map = T.thatchFringe.clone();
    map.repeat.set(1.3, 1);
    map.needsUpdate = true;
    m.thatchFringe = extend(new THREE.MeshStandardMaterial({ map, color: new THREE.Color(1.3, 1.45, 1.8), roughness: 1, side: THREE.DoubleSide, alphaTest: 0.45 }), 'thatchFringe', { fade: 0.3 });
  }
  // fallen leaves on stone (tiny: no shadow casting)
  m.leaves = extend(new THREE.MeshStandardMaterial({ map: T.leaves, roughness: 0.75, side: THREE.DoubleSide, alphaTest: 0.5 }), 'leaves', {});
  m.leaves.userData.noShadow = true;
  // candle glow inside stone lanterns
  m.lanternGlow = new THREE.MeshStandardMaterial({ color: 0x140a04, emissive: new THREE.Color(1.0, 0.52, 0.18), emissiveIntensity: 1.6, roughness: 1 });
  m.lanternGlow.userData.shaderKey = 'props-lanternGlow';
  m.lanternGlow.userData.noShadow = true;
  // glowing embers under the logs of the camp fire
  m.embers = new THREE.MeshStandardMaterial({ color: 0x1a0d08, emissive: new THREE.Color(1.0, 0.28, 0.05), emissiveIntensity: 3.2, roughness: 1 });
  m.embers.userData.shaderKey = 'props-embers';
  cache = m;
  return m;
}
