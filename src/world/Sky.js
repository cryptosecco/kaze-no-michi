import * as THREE from 'three';
import { GLOBAL_UNIFORMS, registerGlobalUniforms } from '../render/globals.js';
import { DRAWN_SUN_GLSL } from '../render/drawnSun.js';

// Procedural HDR sky dome: golden-hour gradient driven by the sun, Mie halo, sun disc, a layer of
// lit fbm clouds (warm undersides, silver linings toward the sun), all composited through the SAME
// atmosphere model as the terrain so the horizon is seamless.

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
}
`;

const FRAG = /* glsl */ `
#include <kaze_common>
#include <kaze_atmosphere>
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyHorizonCool;
uniform vec3 uGroundColor;
uniform float uSunDisc; // disc brightness scale (1 = palette; a giant cinematic disc needs less to stay a readable disc)
uniform float uSunSize;
uniform float uSunLift; // degrees: the drawn sun (disc, aureole, cloud glow; the light shafts follow) above the true one
uniform float uCloudCover;
uniform float uCloudHeight;
uniform vec2 uCloudOffset;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudDark; // 1 = palette; lower = storm: dark grey bodies overhead, pale air between (silver linings kept)
uniform float uCloudGlow; // 1 = palette; > 1 = brighter sunlit cloud sides and, under a storm deck, brighter pale air low down
uniform float uCloudScale; // < 1 = bigger cloud masses
uniform float uCloudSoft;  // width of the density ramp at the cloud edge (soft, volumetric-looking bodies)
uniform float uEnvPass;
varying vec3 vDir;
${DRAWN_SUN_GLSL}
// Scattered cumulus: a large-scale coverage field gates billowy puffs (abs-fbm gives rounded lobes). Returns the
// raw field; the cover threshold (1 - uCloudCover) is applied by the caller.
float cloudField(vec2 uv) {
  vec2 w = vec2(kazeFbm(uv * 0.7 + vec2(3.1, 1.7)), kazeFbm(uv * 0.7 - vec2(1.3, 4.1))) * 0.22;
  float field = kazeFbm(uv * 0.45 + w * 0.4) * 0.5 + 0.5;
  float puff = kazeFbm(uv * 1.7 + w) * 0.58 + (1.0 - abs(kazeFbm(uv * 4.3 - w * 1.3))) * 0.3 + kazeFbm(uv * 10.5 + w) * 0.12;
  return field * 0.55 + (puff * 0.5 + 0.5) * 0.55 - 0.05;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float hp = max(h, 0.0);
  vec2 sxz = normalize(uSunDir.xz + vec2(1e-5));
  // the sun as drawn in the sky (render/drawnSun.js, shared with the light shafts): the true sun, or a shot's giant
  // disc raised by uSunLift so it rests above the hills. Lighting, haze and shadows keep the true direction.
  float mu = dot(dir, kazeDrawnSunDir(uSunDir, uSunLift));
  float muc = max(mu, 0.0);

  // base gradient: clear teal-blue overhead, warm band hugging the horizon (stronger on the sun side)
  vec2 dxz = normalize(dir.xz + vec2(1e-5));
  // clamped: float error can push the anti-sun direction a hair below 0 and pow(<0, x) is NaN
  float sunSide = clamp(0.5 + 0.5 * dot(dxz, sxz), 0.0, 1.0);
  // the warm band climbs high only within ~25° of the sun: a wider band mixed into the teal greys the upper
  // sky; elsewhere the teal dome comes down to a few degrees above the horizon
  float nearSun = pow(muc, 8.0);
  float band = exp(-hp * mix(12.0, 4.0, nearSun));
  vec3 zen = uSkyZenith * (1.25 + 0.6 * (1.0 - hp));
  // low sun: the teal-green zenith belongs to the sun side (blue seen through the warm forward-scattered
  // light); away from the sun it deepens to blue. The split fades out as the sun climbs.
  float lowSun = 1.0 - smoothstep(0.1, 0.35, uSunDir.y);
  zen *= mix(vec3(1.0), vec3(0.8, 0.95, 1.25), (1.0 - sunSide) * lowSun);
  // horizon: golden toward the sun, cool lilac-rose away from it (mixing teal with orange would go grey)
  vec3 hor = mix(uSkyHorizonCool, uSkyHorizon, pow(sunSide, 1.6));
  vec3 sky = mix(zen, hor, band);
  sky += uSunColor * 0.02 * pow(sunSide, 6.0) * exp(-hp * 6.0);
  // Mie halo: broad golden glow + tight bright corona (uSunHalo: aerosol weather, shared with kazeInscatter)
  sky += uSunColor * uSunHalo * (0.005 * pow(muc, 3.0) + 0.036 * pow(muc, 24.0) + 0.13 * pow(muc, 90.0) + 0.6 * pow(muc, 700.0));
  // hazy weather (uSunHalo > 1): the same aerosols that widen the aureole turn the sky milky, tinted by the
  // forward-scattered sunlight (white when there is no sun)
  vec3 sunTint = (uSunColor + 1e-3) / (max(uSunColor.r, max(uSunColor.g, uSunColor.b)) + 1e-3);
  float milk = dot(uHazeWarm, vec3(0.3, 0.5, 0.2)) * (0.9 + 1.4 * pow(muc, 4.0));
  sky = mix(sky, sunTint * milk, clamp((uSunHalo - 1.0) * 0.3, 0.0, 0.75));
  // storm weather (uCloudDark < 0.6): the humid air between the masses is pale, not the clear-day teal;
  // milder values only darken the cloud bodies (a dusk deck in shadow keeps its coloured sky)
  float storm = 1.0 - smoothstep(0.15, 0.6, uCloudDark);
  sky = mix(sky, vec3(dot(sky, vec3(0.3, 0.5, 0.2))) * vec3(1.06, 1.0, 0.9), storm * 0.85);
  // a glowing storm (uCloudGlow > 1): the low sun floods the humid air under the deck, brightest toward the horizon
  // (the dark deck overhead keeps its weight)
  sky *= 1.0 + (uCloudGlow - 1.0) * (1.0 - smoothstep(0.05, 0.45, h)) * storm;

  // cloud layer: dome projection (a flat plane would squash the puffs into streaks near the horizon)
  float cloudA = 0.0; // cloud opacity in front of the sun disc
  if (h > 0.0) {
    vec2 uv = (dir.xz / (h + 0.18) * (0.5 * 1900.0 / uCloudHeight) + cameraPosition.xz * 0.00011) * uCloudScale + uCloudOffset;
    float lo = 1.0 - uCloudCover;
    float n = cloudField(uv);
    float dens = smoothstep(lo, lo + uCloudSoft, n);
    if (dens > 0.001) {
      // optical depth: keeps rising well inside the edge ramp, so a large mass keeps its relief (thin lobes,
      // thick cores) instead of turning into a flat plate once the coverage saturates
      float depth = smoothstep(lo, lo + 0.12, n);
      // self-shadowing toward the sun, through the same optical depth: the side facing the sun is lit and the
      // light dies away gradually into the mass (a lit band, not a lit outline)
      vec2 toSun = sxz * 0.04;
      float o2 = smoothstep(lo, lo + 0.12, cloudField(uv + toSun));
      float o3 = smoothstep(lo, lo + 0.12, cloudField(uv + toSun * 2.4));
      float shade = exp(-(o2 * 2.4 + o3 * 1.5));
      // backlit: the thick body of a cloud between the viewer and the sun lets little light through and reads
      // darker, while its thin parts glow (silver lining). The glow follows the optical depth, so it fades into the
      // body from the edge instead of drawing a bright outline around it.
      float thick = smoothstep(0.3, 0.95, depth);
      float back = pow(muc, 6.0) * thick;
      float silver = pow(muc, 5.0) * 1.05 * (1.0 - depth) + pow(muc, 40.0) * 0.72 * (1.0 - 0.56 * depth);
      // a storm deck (uCloudDark < 1) is dark grey overhead, seen from below, but its distant masses show
      // their lit sides low in the sky and toward the sun: heavy weather keeps bright tears near the horizon
      // (uCloudDark = 1 is the palette cloud: lit side over shaded side)
      float lift = max(pow(muc, 6.0), 1.0 - smoothstep(0.08, 0.45, h));
      float dark = mix(uCloudDark, 1.0, lift);
      vec3 lit = uCloudGlow * uCloudLit * (0.5 + 0.8 * shade) * (1.0 - 0.6 * back) + uSunColor * silver * 0.35;
      // the shaded side also sees the bright horizon band (warm at golden hour, gone with the sun), and its thin
      // lobes let more of that light through than the core: relief inside the shade instead of a flat mauve plate
      float sunUp = min(1.0, dot(uSunColor, vec3(0.3, 0.5, 0.2)));
      vec3 body = (uCloudShade + uSkyHorizon * (0.3 * sunUp)) * mix(uCloudDark, 1.0, 0.5 * lift) * (1.4 - 0.8 * depth);
      body = mix(body, vec3(dot(body, vec3(0.3, 0.5, 0.2))) * vec3(1.1, 1.0, 0.88), storm * 0.68);
      vec3 col = mix(body, lit, (shade * 0.85 + 0.15) * dark);
      // thin edges pick up the sky colour
      col = mix(sky, col, smoothstep(0.0, 0.2, dens));
      float fade = smoothstep(0.0, 0.08, h);
      cloudA = dens * fade;
      sky = mix(sky, col, cloudA);
    }
  }

  // atmosphere / horizon haze, identical model to kazeAtmosphere() used by the terrain
  float mist;
  float T = kazeSkyTransmittance(cameraPosition, dir, mist);
  // the haze integral to "infinity" is only meaningful near the horizon (where it must match distant
  // terrain exactly); higher up it would wash the teal sky and the clouds out, so it fades away
  T = mix(T, 1.0, smoothstep(0.02, 0.2, h) * 0.95);
  vec3 col = sky * T + kazeInscatter(dir, mist) * (1.0 - T);

  // sun disc, attenuated by the atmosphere along its own path and hidden behind the clouds in front of it
  // (bands of cloud cross a low sun); the rim keeps the width of the natural disc (crisp at any size) and a
  // limb darkening warms it toward the edge, so a giant cinematic sun reads as a disc and not as a flat blob.
  // A raised disc (uSunLift) keeps the true sun's path through the air, hence its sunset colour and brightness.
  float mistS;
  float Ts = kazeSkyTransmittance(cameraPosition, uSunDir, mistS);
  float discR = 0.0082 * uSunSize;
  float disc = smoothstep(cos(discR), cos(max(discR - 0.00164, 0.0)), mu);
  float r2 = clamp((1.0 - mu) / max(1.0 - cos(discR), 1e-7), 0.0, 1.0); // (radius / disc radius)^2
  vec3 limb = mix(vec3(1.0), vec3(0.72, 0.52, 0.34), r2 * r2);
  col += uSunColor * limb * (80.0 * uSunDisc) * disc * (0.25 + Ts) * (1.0 - 0.9 * cloudA);

  // below the horizon (only ever seen by the environment probe): warm ground bounce
  float below = 1.0 - smoothstep(-0.12, 0.0, h); // ascending edges (edge0 > edge1 is undefined in GLSL), same ramp
  col = mix(col, uGroundColor * (0.6 + 0.4 * T) + kazeInscatter(dir, 1.0) * 0.25, below * uEnvPass);

  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  constructor() {
    this.uniforms = registerGlobalUniforms({
      uSkyZenith: { value: new THREE.Color(0.05, 0.13, 0.32) },
      uSkyHorizon: { value: new THREE.Color(0.9, 0.55, 0.32) },
      uSkyHorizonCool: { value: new THREE.Color(0.44, 0.38, 0.46) },
      uGroundColor: { value: new THREE.Color(0.09, 0.07, 0.04) },
      uSunDisc: { value: 1 }, // brightness scale of the sun disc (shots may dim a giant cinematic sun)
      uSunHalo: { value: 1 }, // aureole around the sun: sky Mie terms + the atmosphere's forward-scattering lobe
      uSunSize: { value: 1 }, // cinematic scale of the sun disc (shots/cutscenes may enlarge it)
      uSunLift: { value: 0 }, // degrees the drawn sun is raised above the true one (a shot's giant disc clearing the hills)
      uCloudCover: { value: 0.54 },
      uCloudHeight: { value: 1900 },
      uCloudOffset: { value: new THREE.Vector2(0.21, 0.63) },
      uCloudLit: { value: new THREE.Color(1.0, 0.62, 0.42) },
      uCloudShade: { value: new THREE.Color(0.2, 0.18, 0.26) },
      uCloudDark: { value: 1 },
      uCloudGlow: { value: 1 },
      uCloudScale: { value: 1 },
      uCloudSoft: { value: 0.12 },
    });
    // what applyShot() restores when a shot does not override it (the cloud offset also undoes the wind drift)
    const u = this.uniforms;
    this.defaults = {
      sunSize: u.uSunSize.value,
      sunLift: u.uSunLift.value,
      sunDisc: u.uSunDisc.value,
      sunHalo: u.uSunHalo.value,
      cloudCover: u.uCloudCover.value,
      cloudDark: u.uCloudDark.value,
      cloudGlow: u.uCloudGlow.value,
      cloudScale: u.uCloudScale.value,
      cloudSoft: u.uCloudSoft.value,
      cloudOffset: [u.uCloudOffset.value.x, u.uCloudOffset.value.y],
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...GLOBAL_UNIFORMS, uEnvPass: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.envMaterial = this.material.clone();
    this.envMaterial.uniforms = { ...GLOBAL_UNIFORMS, uEnvPass: { value: 1 } };

    const geo = new THREE.SphereGeometry(1, 64, 32);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
    this.radius = 9000;
    this.mesh.scale.setScalar(this.radius);

    // separate scene used to bake the environment probe (IBL)
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(geo, this.envMaterial);
    this.envMesh.scale.setScalar(1000);
    this.envScene.add(this.envMesh);
  }

  // Per-shot sky overrides { sunSize, sunLift, sunDisc, sunHalo, cloudCover, cloudDark, cloudGlow, cloudScale,
  // cloudSoft, cloudOffset: [x, y] }: every field the shot leaves out goes back to its default, so shots applied one
  // after another never leak.
  applyShot(sky = {}) {
    const d = this.defaults, u = this.uniforms, s = sky || {};
    u.uSunSize.value = s.sunSize ?? d.sunSize;
    u.uSunLift.value = s.sunLift ?? d.sunLift;
    u.uSunDisc.value = s.sunDisc ?? d.sunDisc;
    u.uSunHalo.value = s.sunHalo ?? d.sunHalo;
    u.uCloudCover.value = s.cloudCover ?? d.cloudCover;
    u.uCloudDark.value = s.cloudDark ?? d.cloudDark;
    u.uCloudGlow.value = s.cloudGlow ?? d.cloudGlow;
    u.uCloudScale.value = s.cloudScale ?? d.cloudScale;
    u.uCloudSoft.value = s.cloudSoft ?? d.cloudSoft;
    const o = s.cloudOffset ?? d.cloudOffset;
    u.uCloudOffset.value.set(o[0], o[1]);
  }

  // Keep the dome centered on the viewer; drift clouds with the wind.
  update(camera, dt, windDir) {
    this.mesh.position.copy(camera.position);
    const o = this.uniforms.uCloudOffset.value;
    o.x += windDir.x * dt * 0.0009;
    o.y += windDir.y * dt * 0.0009;
  }
}
