import * as THREE from 'three';
import { SEA } from './Layout.js';

// The sea: a large plane following the viewer, lit by the sun (glitter path at golden hour) and the sky
// probe. Wave normals from scrolling fbm, depth-tinted from the terrain height texture, shoreline foam.

const PARS = /* glsl */ `
#include <kaze_common>
#include <kaze_terrain>
#include <kaze_wind>
varying vec3 vWaterWorld;
float kzWaterRough = 0.08;
vec3 kzPerturbW(vec3 surfPos, vec3 surfNorm, float h) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
// The waves drift downwind by uWaveDrift, the wind's own travel integrated over time: a heading that turns (the guiding
// wind) never moves the whole sea, as heading × clock did.
float kzWaves(vec2 p) {
  float w = kazeFbm(p * 0.018 + uWaveDrift * 0.012) * 0.55;
  w += kazeFbm(p * 0.061 - uWaveDrift.yx * 0.03 + vec2(0.3, 0.7)) * 0.3;
  w += kazeFbm(p * 0.23 + uWaveDrift * 0.06 + vec2(0.9, 0.1)) * 0.15;
  return w;
}
`;

const COLOR = /* glsl */ `
  vec2 wxz = vWaterWorld.xz;
  float wdist = distance(vWaterWorld, cameraPosition);
  float ground = (abs(wxz.x) < KZ_HALF && abs(wxz.y) < KZ_HALF) ? kazeTerrainHeight(wxz) : -40.0;
  float depth = max(0.0, ${SEA.level.toFixed(1)} - ground);
  vec3 deep = vec3(0.006, 0.026, 0.045);
  vec3 shallow = vec3(0.04, 0.13, 0.12);
  vec3 wcol = mix(shallow, deep, smoothstep(0.0, 14.0, depth));
  float foamN = kazeFbm(wxz * 0.35 + vec2(uTime * 0.05, 0.0)) * 0.5 + 0.5;
  float foam = (1.0 - smoothstep(0.0, 1.4, depth)) * smoothstep(0.35, 0.75, foamN + 0.25 * sin(uTime * 1.3 + depth * 5.0));
  wcol = mix(wcol, vec3(0.65, 0.66, 0.63), foam * 0.8);
  diffuseColor.rgb = wcol;
  kzWaterRough = mix(0.045, 0.2, smoothstep(40.0, 2500.0, wdist));
  kzWaterRough = mix(kzWaterRough, 0.7, foam);
`;

const NORMAL = /* glsl */ `
  {
    float amp = mix(0.32, 0.05, smoothstep(30.0, 1800.0, wdist));
    normal = kzPerturbW(-vViewPosition, normal, kzWaves(wxz) * amp);
  }
`;

export class Water {
  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0a2230, roughness: 0.08, metalness: 0.0 });
    mat.userData.shaderKey = 'water';
    mat.userData.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + COLOR)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = kzWaterRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL);
    };
    this.material = mat;
    const geo = new THREE.PlaneGeometry(40000, 40000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = SEA.level;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'sea';
    this.mesh.frustumCulled = false;
  }

  update(camera) {
    // follow the viewer in coarse steps (keeps float precision, no visible swimming: waves are world-space)
    this.mesh.position.x = Math.round(camera.position.x / 256) * 256;
    this.mesh.position.z = Math.round(camera.position.z / 256) * 256;
  }
}
