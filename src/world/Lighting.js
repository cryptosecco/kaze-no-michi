import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { clamp } from '../core/math.js';

// Sun (native cascaded-shadow SunLight of r186 — works for every built-in lit material with no per-material
// setup), time-of-day palette, and image-based lighting baked from the sky dome into a PMREM.

// Palette keyed by sun elevation in degrees. Linear HDR values, art-directed for an autumn golden hour.
// haze = aerial haze away from the sun (cool, blue-violet), hazeWarm = the same haze on the sun side (gold).
// Below 4° the dusk turns crimson (deep red sky, maroon zenith). The crimson 1.5° key has no effect above 4°: the 4°
// key is the golden-hour 1.5°→8° ramp (the one without the crimson key) at 4° (within 6e-4) for every field except
// zen. Above 4° the palette is the golden-hour one except three fields, tuned by eye (the difference fades out toward
// the 22° key):
//   zen — darker teal-green: at S1 (6.46°) (0.030, 0.149, 0.170) where the ramp would give (0.037, 0.164, 0.226). The
//     8° zenith is solved for that S1 value; the 4° zenith lies on the line from the golden-hour 1.5° zenith to that 8°
//     one, not on the ramp;
//   cloudLit / cloudShade — peach-cream clouds rather than salmon: the 4° values lie on the ramp, the 8° values are
//     solved so that S1 gets (1.85, 1.19, 0.64) / (0.22, 0.16, 0.17).
// Sky also deepens the zenith to blue away from a low sun.
const KEYS = [
  {
    el: -4, sun: [1.0, 0.25, 0.08], sunI: 0.0, zen: [0.012, 0.025, 0.07], hor: [0.42, 0.17, 0.1], horCool: [0.14, 0.07, 0.1],
    haze: [0.1, 0.09, 0.16], hazeWarm: [0.3, 0.14, 0.09], mist: [0.26, 0.15, 0.12], cloudLit: [0.5, 0.2, 0.16], cloudShade: [0.06, 0.05, 0.09], env: 0.35, fill: [0.3, 0.2, 0.2], fillI: 0.1,
  },
  {
    el: 1.5, sun: [1.0, 0.26, 0.06], sunI: 2.4, zen: [0.07, 0.035, 0.07], hor: [1.1, 0.14, 0.03], horCool: [0.34, 0.09, 0.11],
    haze: [0.24, 0.1, 0.14], hazeWarm: [0.9, 0.16, 0.05], mist: [0.55, 0.14, 0.07], cloudLit: [1.6, 0.24, 0.09], cloudShade: [0.15, 0.04, 0.05], env: 0.75, fill: [1.0, 0.45, 0.25], fillI: 0.62,
  },
  {
    el: 4, sun: [1.0, 0.4155, 0.1586], sunI: 2.939, zen: [0.045, 0.1147, 0.16], hor: [1.142, 0.431, 0.172], horCool: [0.428, 0.269, 0.325],
    haze: [0.245, 0.189, 0.289], hazeWarm: [0.892, 0.396, 0.177], mist: [0.62, 0.337, 0.195], cloudLit: [1.923, 0.699, 0.322], cloudShade: [0.208, 0.111, 0.132], env: 0.738, fill: [1.0, 0.546, 0.331], fillI: 0.593,
  },
  {
    el: 8, sun: [1.0, 0.6, 0.3], sunI: 3.8, zen: [0.021, 0.17, 0.176], hor: [1.05, 0.64, 0.32], horCool: [0.44, 0.38, 0.46],
    haze: [0.22, 0.25, 0.4], hazeWarm: [0.8, 0.55, 0.3], mist: [0.62, 0.46, 0.3], cloudLit: [1.8, 1.5, 0.84], cloudShade: [0.23, 0.19, 0.19], env: 0.72, fill: [1.0, 0.7, 0.46], fillI: 0.55,
  },
  {
    el: 22, sun: [1.0, 0.8, 0.6], sunI: 4.4, zen: [0.05, 0.16, 0.43], hor: [0.66, 0.66, 0.7], horCool: [0.5, 0.56, 0.68],
    haze: [0.36, 0.43, 0.6], hazeWarm: [0.6, 0.54, 0.48], mist: [0.62, 0.6, 0.58], cloudLit: [1.6, 1.4, 1.2], cloudShade: [0.3, 0.32, 0.4], env: 0.85, fill: [0.9, 0.78, 0.66], fillI: 0.3,
  },
  {
    el: 55, sun: [1.0, 0.95, 0.88], sunI: 5.0, zen: [0.05, 0.19, 0.52], hor: [0.55, 0.66, 0.82], horCool: [0.5, 0.62, 0.8],
    haze: [0.45, 0.54, 0.72], hazeWarm: [0.52, 0.58, 0.7], mist: [0.66, 0.7, 0.76], cloudLit: [1.7, 1.66, 1.6], cloudShade: [0.42, 0.45, 0.54], env: 0.95, fill: [0.82, 0.82, 0.82], fillI: 0.22,
  },
];

function samplePalette(elDeg) {
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (elDeg >= KEYS[i].el && elDeg <= KEYS[i + 1].el) {
      a = KEYS[i];
      b = KEYS[i + 1];
      break;
    }
  }
  const t = a === b ? 0 : clamp((elDeg - a.el) / (b.el - a.el), 0, 1);
  const mix = (x, y) => x.map((v, i) => v + (y[i] - v) * t);
  const out = {};
  for (const k of Object.keys(a)) out[k] = Array.isArray(a[k]) ? mix(a[k], b[k]) : a[k] + (b[k] - a[k]) * t;
  if (elDeg < KEYS[0].el) Object.assign(out, KEYS[0]);
  if (elDeg > KEYS[KEYS.length - 1].el) Object.assign(out, KEYS[KEYS.length - 1]);
  return out;
}

// Sun position for the island (autumn): golden hour ≈ 17.6–18.3 h with the sun low in the west-south-west
// (az ≈ 250–262°), so the shrine hill (SW of the field) does not shade the susuki basin at sunset.
export function sunDirection(hours, out = new THREE.Vector3()) {
  const el = THREE.MathUtils.degToRad(42 * Math.sin((Math.PI * (hours - 6.4)) / 12.2));
  const az = THREE.MathUtils.degToRad(180 + (hours - 12.3) * 13.16); // clockwise from north
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c).normalize();
}

export class Lighting {
  constructor({ renderer, scene, quality, atmosphere, sky }) {
    this.renderer = renderer;
    this.scene = scene;
    this.atmosphere = atmosphere;
    this.sky = sky;
    this.hours = 17.7;
    this.sunDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.palette = null;

    const sun = new SunLight(0xffffff, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = quality.shadowFar;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.35; // grazing golden-hour sun: generous normal offset kills terrain acne
    sun.shadow.radius = 2.5;
    this.sun = sun;
    scene.add(sun);
    // warm golden-hour fill: scattered light from the bright sun-side sky + bounce off the fields
    this.fill = new THREE.HemisphereLight(0xffffff, 0x886644, 0.3);
    scene.add(this.fill);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCamera = new THREE.CubeCamera(1, 5000, this.cubeRT);
    this.sky.envScene.add(this.cubeCamera);
    this.envRT = null;
    this.envDirty = true;
    this.envIntensity = 1;
  }

  setQuality(q) {
    this.sun.shadow.camera.far = q.shadowFar;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
  }

  setTimeOfDay(hours) {
    this.hours = hours;
    sunDirection(hours, this.sunDir);
    const elDeg = THREE.MathUtils.radToDeg(Math.asin(this.sunDir.y));
    const p = samplePalette(elDeg);
    this.palette = p;
    this.sunColor.setRGB(p.sun[0], p.sun[1], p.sun[2]);

    this.sun.position.copy(this.sunDir);
    this.sun.color.copy(this.sunColor);
    this.sun.intensity = p.sunI;

    const a = this.atmosphere.uniforms;
    a.uSunDir.value.copy(this.sunDir);
    a.uSunColor.value.setRGB(p.sun[0] * p.sunI, p.sun[1] * p.sunI, p.sun[2] * p.sunI);
    a.uHazeColor.value.setRGB(...p.haze);
    a.uHazeWarm.value.setRGB(...p.hazeWarm);
    a.uFogColor.value.setRGB(...p.mist);

    const s = this.sky.uniforms;
    s.uSkyZenith.value.setRGB(...p.zen);
    s.uSkyHorizon.value.setRGB(...p.hor);
    s.uSkyHorizonCool.value.setRGB(...p.horCool);
    s.uCloudLit.value.setRGB(...p.cloudLit);
    s.uCloudShade.value.setRGB(...p.cloudShade);
    this.fill.color.setRGB(p.fill[0], p.fill[1], p.fill[2]);
    this.fill.groundColor.setRGB(p.fill[0] * 0.42, p.fill[1] * 0.34, p.fill[2] * 0.22);
    this.fill.intensity = p.fillI;
    this.envIntensity = p.env;
    this.envDirty = true;
  }

  bakeEnvironment() {
    this.cubeCamera.position.set(0, 30, 0);
    this.sky.envMesh.position.set(0, 30, 0);
    this.cubeCamera.update(this.renderer, this.sky.envScene);
    const rt = this.pmrem.fromCubemap(this.cubeRT.texture);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = this.envIntensity;
    this.envDirty = false;
  }

  update() {
    if (this.envDirty) this.bakeEnvironment();
  }
}
