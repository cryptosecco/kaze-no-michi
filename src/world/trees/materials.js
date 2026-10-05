import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../render/globals.js';

// Tree materials. Everything extends the built-in materials (sun cascades, IBL and atmosphere for free):
//   bark  : MeshStandardMaterial + painted bark map/normal map + wind
//   leaves: MeshStandardMaterial + atlas (alpha-to-coverage, mip-coverage compensation) + wind + flutter +
//           wrap lighting and back-lit translucency (the golden-hour glow through maple and ginkgo crowns);
//           the atlas normal map tilts every leaf around the soft crown normal (derivative tangent frame)
// Both fade between LODs with a screen-door dither driven by the distance of the tree to the main camera
// (uTreeCam, also used by the shadow pass so LOD cross-fades cast consistent shadows).
// Matching MeshDepthMaterials repeat the wind so shadows sway with the crowns.

export const TREE_UNIFORMS = {
  uTreeCam: { value: new THREE.Vector3() },
  uLeafTrans: { value: new THREE.Color(1.0, 0.8, 0.55) },
  uLeafWrap: { value: 0.5 },
  // sunlight scattered through the canopy toward the viewer, not blocked by the crown's own shadow (backlit
  // ginkgo crowns glow through, not only at their rims); scales with the leaf colour, so gold glows, crimson less
  uLeafScatter: { value: 1.0 },
  uAtlasSize: { value: 2048 },
};

const VERT_PARS = /* glsl */ `
#include <kaze_wind>
attribute vec4 aWind;
uniform vec3 uTreeCam;
uniform vec4 uLodFade;
varying vec2 vTreeFade;
`;

// wind: whole-tree sway (∝ height²), branch bob (per-branch phase, continuous along the skeleton), leaf flutter
const VERT_WIND = /* glsl */ `
vec3 transformed = vec3(position);
#ifdef USE_INSTANCING
  vec3 kzBase = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  mat3 kzIR = mat3(instanceMatrix);
#else
  vec3 kzBase = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  mat3 kzIR = mat3(1.0);
#endif
float kzS2 = max(dot(kzIR[1], kzIR[1]), 1e-4);
vec2 kzW = kazeWindBend(kzBase.xz);
float kzGl = length(kzW);
// where the two winds cancel the direction fades out through zero instead of flipping in one frame (a unit vector would
// take the crown's constant flutter below with it); the ambient gust is never under 0.24, so there this is the unit vector
vec2 kzWd = kzW / max(kzGl, 0.15);
// a guided gust (up to 1.85x the ambient one) bends a crown at most ~20 % more than the strongest ambient gust, and
// softly: with the ambient wind nothing changes (a bamboo top swung up to 5.6 m in a guided gust, now up to ~3.8 m)
float kzGp = max(kazeGustPeak(), 1e-3);
float kzG = min(kzGl, kzGp) + 0.2 * kzGp * tanh(max(kzGl - kzGp, 0.0) / (0.2 * kzGp));
float kzPh = fract(sin(dot(floor(kzBase.xz * 2.0), vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
vec3 kzWL = (transpose(kzIR) * vec3(kzWd.x, 0.0, kzWd.y)) / kzS2;
float kzH = aWind.x;
float kzSway = kzG * (0.6 + 0.4 * sin(uTime * 0.72 + kzPh)) + 0.08 * sin(uTime * 1.9 + kzPh * 2.0);
transformed += kzWL * (kzH * kzH) * kzSway * 1.05;
float kzB = sin(uTime * (1.6 + 0.4 * sin(aWind.z * 3.1)) + aWind.z + kzPh);
transformed += (kzWL * (0.55 + 0.45 * kzB) + vec3(0.0, kzB * 0.16, 0.0) / sqrt(kzS2)) * aWind.y * kzG * 0.3;
float kzF = sin(uTime * (6.5 + 3.5 * fract(aWind.z * 7.31)) + aWind.z * 23.0 + dot(position, vec3(3.1, 1.7, 2.3)));
transformed += normal * (kzF * aWind.w * (0.02 + 0.055 * kzG));
float kzD = distance(kzBase.xz, uTreeCam.xz);
vTreeFade = vec2(smoothstep(uLodFade.x, uLodFade.y, kzD), 1.0 - smoothstep(uLodFade.z, uLodFade.w, kzD));
`;

const FRAG_PARS = /* glsl */ `
varying vec2 vTreeFade;
float kzIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// screen-door LOD cross-fade: a fading-in LOD keeps the pixels a fading-out LOD drops
const FRAG_FADE = /* glsl */ `
  {
    float kzN = kzIGN(gl_FragCoord.xy);
    if (kzN >= vTreeFade.y || kzN < 1.0 - vTreeFade.x) discard;
  }
`;

const LEAF_FRAG_PARS = /* glsl */ `
uniform vec3 uLeafTrans;
uniform float uLeafWrap;
uniform float uLeafScatter;
uniform float uAtlasSize;
vec3 kzLeafTrans = vec3(0.0);
`;

// canopy scattering (after the lights): the unshadowed sun (r186 SunLight: sunLights[], not directionalLights[]),
// a soft lobe toward it
const LEAF_SCATTER = /* glsl */ `
#include <lights_fragment_end>
#if NUM_SUN_LIGHTS > 0
  {
    float kzVoL = clamp(dot(-geometryViewDir, sunLights[0].direction), 0.0, 1.0);
    reflectedLight.directDiffuse += sunLights[0].color * kzLeafTrans * uLeafScatter * (0.18 * pow(kzVoL, 3.0) + 0.3 * pow(kzVoL, 12.0));
  }
#endif`;

const LEAF_RE_DIRECT = /* glsl */ `
#undef RE_Direct
void RE_Direct_Leaf(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float NoL = dot(geometryNormal, directLight.direction);
  float wrapNL = clamp((NoL + uLeafWrap) / (1.0 + uLeafWrap), 0.0, 1.0);
  reflectedLight.directDiffuse += wrapNL * directLight.color * BRDF_Lambert(material.diffuseContribution);
  reflectedLight.directSpecular += clamp(NoL, 0.0, 1.0) * directLight.color * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material) * 0.35;
  float VoL = clamp(dot(-geometryViewDir, directLight.direction), 0.0, 1.0);
  float trans = 0.35 * pow(VoL, 3.0) + 0.9 * pow(VoL, 14.0);
  // light gets through a leaf whose back faces the sun: with the per-leaf normal, a backlit crown glows leaf by leaf
  trans *= clamp(0.55 - 0.75 * NoL, 0.2, 1.25);
  reflectedLight.directDiffuse += directLight.color * kzLeafTrans * trans;
}
#define RE_Direct RE_Direct_Leaf
`;

// Bark: plain Lambert plus a faint highlight. The stock GGX terms reach Fresnel ≈ 1 at grazing angles: with the
// camera looking into the low sun (S1, S2, S4) the sun and the bright hazy sky (image-based specular, which
// material.envMapIntensity does not scale under scene.environment) painted trunks and limbs as pale sticks.
const BARK_IBL_SPECULAR = /* glsl */ `
#if defined( RE_IndirectSpecular )
  radiance *= 0.12;
#endif
#include <lights_fragment_end>`;

const BARK_RE_DIRECT = /* glsl */ `
#undef RE_Direct
void RE_Direct_Bark(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float NoL = clamp(dot(geometryNormal, directLight.direction), 0.0, 1.0);
  reflectedLight.directDiffuse += NoL * directLight.color * BRDF_Lambert(material.diffuseContribution);
  reflectedLight.directSpecular += NoL * directLight.color * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material) * 0.1;
}
#define RE_Direct RE_Direct_Bark
`;

function injectVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <begin_vertex>', VERT_WIND);
}

function injectFade(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + FRAG_FADE);
}

function injectLeafFragment(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + LEAF_FRAG_PARS)
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
#ifdef USE_MAP
  {
    vec2 kzTs = vMapUv * uAtlasSize;
    float kzLod = max(0.0, 0.5 * log2(max(dot(dFdx(kzTs), dFdx(kzTs)), dot(dFdy(kzTs), dFdy(kzTs)))));
    diffuseColor.a *= 1.0 + kzLod * 0.32;
    // a card seen edge-on reads as a strip: fade it out (true face normal from the position derivatives)
    vec3 kzFn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    diffuseColor.a *= smoothstep(0.06, 0.28, abs(dot(kzFn, normalize(vViewPosition))));
  }
#endif`
    )
    .replace('#include <color_fragment>', '#include <color_fragment>\n  kzLeafTrans = diffuseColor.rgb * uLeafTrans;')
    .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
    .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + LEAF_RE_DIRECT)
    .replace('#include <lights_fragment_end>', LEAF_SCATTER);
}

export function makeBarkMaterial(textures, lodFade, tint = 0xffffff, key = 'bark') {
  const uniforms = { uLodFade: { value: lodFade }, ...TREE_UNIFORMS };
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    roughness: 0.92,
    metalness: 0,
    vertexColors: true,
  });
  mat.userData.shaderKey = 'tree-' + key;
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectFade(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + BARK_RE_DIRECT)
      .replace('#include <lights_fragment_end>', BARK_IBL_SPECULAR);
  };
  mat.userData.depth = makeDepthMaterial(uniforms, null, 'bark');
  return mat;
}

// atlas = createLeafAtlas() → { map, normalMap }. The normal map is packed RG (per-leaf tilt): three.js builds the
// tangent frame from screen derivatives around the vertex normal (the soft crown normal), so the tilt is blended
// with the crown shape; both faces keep that normal (see injectLeafFragment).
export function makeLeafMaterial(atlas, lodFade, msaa, key = 'leaf') {
  const uniforms = { uLodFade: { value: lodFade }, ...TREE_UNIFORMS };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlas.map,
    normalMap: atlas.normalMap || null,
    normalScale: new THREE.Vector2(1.6, 1.6), // painted tilts up to ~30°, ~45° here: leaves face every way
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
    alphaTest: 0.5,
  });
  mat.alphaToCoverage = msaa > 0;
  mat.userData.shaderKey = 'tree-' + key;
  mat.userData.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectFade(shader);
    injectLeafFragment(shader);
  };
  mat.userData.depth = makeDepthMaterial(uniforms, atlas.map, 'leaf');
  return mat;
}

// Shadow-pass material with the same wind (and alpha test for the cards). Not patched by game.add(), so it
// attaches the shared uniforms itself.
export function makeDepthMaterial(uniforms, atlas, key) {
  const mat = new THREE.MeshDepthMaterial({ map: atlas || null, alphaTest: atlas ? 0.5 : 0, side: atlas ? THREE.DoubleSide : THREE.FrontSide });
  mat.onBeforeCompile = (shader) => {
    for (const k in GLOBAL_UNIFORMS) if (!(k in shader.uniforms)) shader.uniforms[k] = GLOBAL_UNIFORMS[k];
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    injectFade(shader);
  };
  mat.customProgramCacheKey = () => 'kaze|tree-depth-' + key;
  return mat;
}
