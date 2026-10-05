import * as THREE from 'three';
import { GLOBAL_UNIFORMS, registerChunk, registerGlobalUniforms } from './globals.js';

// Atmospheric perspective for EVERY material: two exponential height layers
//   - ground mist   (dense, falls off in tens of meters → fills valleys, separates depth planes)
//   - aerial haze   (thin, falls off over ~1 km → mountains fade to blue-violet)
// plus an in-scattering lobe toward the sun (golden glow when looking into the light), which on objects needs a long
// column of air: near hills stay dark silhouettes in front of the glow of the sky and the far ranges.
// Built-in materials get it through overridden fog chunks; custom shaders use:
//   #include <kaze_atmosphere>   vec3 kazeAtmosphere(vec3 color, vec3 worldPos)
// The sky uses kazeSkyTransmittance()/kazeInscatter() so the horizon matches distant terrain exactly.

registerChunk(
  'kaze_atmosphere',
  /* glsl */ `
#ifndef KAZE_ATMOSPHERE
#define KAZE_ATMOSPHERE
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uScatter;
uniform float uHazeDensity;
uniform float uHazeFalloff;
uniform vec3 uHazeColor;
uniform vec3 uHazeWarm;
uniform float uSunHalo; // aerosol glow around the sun: a weather value owned by Sky (shots override it)

// optical depth of an exponential layer along a ray segment of length d starting at height h0
float kazeLayerDepth(float density, float k, float h0, float dirY, float d) {
  float e0 = exp(-k * clamp(h0, -50.0, 5000.0));
  float kdy = k * dirY;
  if (abs(kdy) < 1e-6) return density * e0 * d;
  return density * e0 * (1.0 - exp(clamp(-kdy * d, -60.0, 60.0))) / kdy;
}

// Haze colour: golden only within ~30° of the sun's bearing, blue-violet everywhere else (the distant ranges
// beside the low sun fade to layered blue-violet, not to a beige veil).
vec3 kazeHazeColor(vec3 dir, float mistFrac) {
  vec2 dxz = normalize(dir.xz + vec2(1e-5));
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-5));
  float side = clamp(0.5 + 0.5 * dot(dxz, sxz), 0.0, 1.0);
  float warm = pow(side, 16.0); // 0.61 at 20° off the sun's bearing, 0.33 at 30°, 0.08 at 45°
  vec3 haze = mix(uHazeColor, uHazeWarm, warm);
  vec3 mist = uFogColor * mix(vec3(0.82, 0.86, 0.98), vec3(1.08, 1.0, 0.9), warm);
  return mix(haze, mist, mistFrac);
}

// Forward-scattering lobe: the air glows around the low sun.
vec3 kazeSunGlow(vec3 dir) {
  float mu = max(dot(dir, uSunDir), 0.0);
  float lobe = 0.042 * pow(mu, 2.0) + 0.15 * pow(mu, 8.0) + 0.42 * pow(mu, 32.0) + 0.9 * pow(mu, 260.0);
  return uSunColor * (uScatter * uSunHalo * lobe);
}

vec3 kazeInscatter(vec3 dir, float mistFrac) {
  return kazeHazeColor(dir, mistFrac) + kazeSunGlow(dir);
}

vec3 kazeAtmosphereRay(vec3 color, vec3 origin, vec3 dir, float d) {
  float tm = kazeLayerDepth(uFogDensity, uFogHeightFalloff, origin.y, dir.y, d);
  float th = kazeLayerDepth(uHazeDensity, uHazeFalloff, origin.y, dir.y, d);
  float T = exp(-(tm + th));
  float mistFrac = tm / max(tm + th, 1e-5);
  // the glow around a low sun needs a long column of lit air: the sky and the far ranges (1 - T > 0.35) get all of
  // it, a hill a few hundred metres off (1 - T ≈ 0.1) little and the near field none, so what stands in front of the
  // sun keeps its dark backlit silhouette against the glow instead of turning into a golden veil
  float glow = smoothstep(0.03, 0.35, 1.0 - T);
  return color * T + (kazeHazeColor(dir, mistFrac) + kazeSunGlow(dir) * glow) * (1.0 - T);
}

vec3 kazeAtmosphere(vec3 color, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float d = length(v);
  if (d < 1e-3) return color;
  return kazeAtmosphereRay(color, cameraPosition, v / d, d);
}

// Transmittance of a ray to "infinity" (sky): used by the sky dome so it blends into the same haze.
float kazeSkyTransmittance(vec3 origin, vec3 dir, out float mistFrac) {
  float dy = max(dir.y, 0.0015);
  float d = 60000.0;
  float tm = kazeLayerDepth(uFogDensity, uFogHeightFalloff, origin.y, dy, d);
  float th = kazeLayerDepth(uHazeDensity, uHazeFalloff, origin.y, dy, d);
  mistFrac = tm / max(tm + th, 1e-5);
  return exp(-(tm + th));
}
#endif
`
);

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vKazeFogWorld;
#endif
`;

// World position from the view-space position that every built-in shader has at this point
// (works for instancing, batching, skinning and morphing without touching `transformed`).
const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vKazeFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vKazeFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  #include <kaze_atmosphere>
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = kazeAtmosphere(gl_FragColor.rgb, vKazeFogWorld);
#endif
`;

class Atmosphere {
  constructor() {
    this.uniforms = registerGlobalUniforms({
      uSunDir: { value: new THREE.Vector3(-0.8, 0.17, 0.55).normalize() },
      uSunColor: { value: new THREE.Color(3.0, 1.6, 0.7) },
      uFogColor: { value: new THREE.Color(0.55, 0.5, 0.52) },
      uFogDensity: { value: 0.0008 },
      uFogHeightFalloff: { value: 1 / 22 },
      uScatter: { value: 0.55 },
      uHazeDensity: { value: 0.0001 },
      uHazeFalloff: { value: 1 / 1400 },
      uHazeColor: { value: new THREE.Color(0.36, 0.42, 0.62) },
      uHazeWarm: { value: new THREE.Color(0.8, 0.55, 0.3) },
    });
    this.installed = false;
  }

  install() {
    if (this.installed) return;
    THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
    THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
    THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
    THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
    this.installed = true;
  }

  // Attach the shared atmosphere uniforms to a material compiled outside Game.patchMaterial(), plus the sun's
  // aureole (uSunHalo: weather owned by Sky, registered globally; unset it would read 0 = no glow).
  patchMaterial(mat) {
    const prev = mat.onBeforeCompile;
    const uniforms = this.uniforms;
    mat.onBeforeCompile = function (shader, renderer) {
      prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      if (GLOBAL_UNIFORMS.uSunHalo) shader.uniforms.uSunHalo = GLOBAL_UNIFORMS.uSunHalo;
    };
    mat.needsUpdate = true;
    return mat;
  }
}

export const atmosphere = new Atmosphere();
