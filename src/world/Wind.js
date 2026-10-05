import * as THREE from 'three';
import { registerChunk, registerGlobalUniforms } from '../render/globals.js';
import { clamp, smoothstep } from '../core/math.js';

// Global wind field. One set of uniforms shared by grass, trees, leaves, cloth and particles.
// GPU: #include <kaze_wind>  →  vec2 kazeWindBend(vec2 worldXZ), float kazeGust(vec2), vec2 kazeWindDir()
// CPU: wind.sample(x, z, outVec2) returns the same bend vector (for particles / cloth / audio).
// GPU against CPU, by hand (not part of npm test): node scripts/probe.mjs --file scripts/wind.gpu.js
//
// Two fields of gust fronts share the air. The ambient wind blows along uWindDir and its fronts cross the land at
// FRONT_SPEED. The guiding wind (T) is a second field with a heading (uGuideDir) and a pattern offset (uGuidePhase) of
// its own, integrated here on the CPU, so a front that is already crossing the land is never re-timed or turned when
// the guide fades in or out. The bend is the two bend vectors cross-faded by the guide envelope uGuide (0 = ambient
// only, 1 = guided only), and kazeGust() is its length. With no guide active the field is the ambient one: the CPU
// mirror reproduces bit for bit the values recorded in scripts/wind.test.mjs. kazeWindDir() is the heading of the air:
// the arc from the ambient heading to the guided one, walked by the envelope (so during a cross-fade dir × gust is not
// exactly the bend: ask for kazeWindBend() where a vector is needed).

// speed (m/s) at which the gust fronts cross the fields in the ambient wind
export const FRONT_SPEED = 7.5;
// the guided fronts run this much faster (m/s), and blow this many times harder in a gust (the GLSL shares the gain)
export const GUIDE_EXTRA_SPEED = 6;
export const GUIDE_GAIN = 1.85;
// the guide fades in over GUIDE_RAMP_IN s and out over GUIDE_RAMP_OUT s (smoothstep), the air turning with it
export const GUIDE_RAMP_IN = 1.6;
export const GUIDE_RAMP_OUT = 2.5;
// while a guide lasts its heading follows the objective at this turn rate (rad/s); an objective nearer than
// GUIDE_AIM_MIN (m) is too close to aim at, and leaves the heading as it is
export const GUIDE_TURN_RATE = 0.6;
export const GUIDE_AIM_MIN = 2;
// time constant (s) of uGuideSoft, the envelope for what should join and leave the guided wind gradually
export const GUIDE_SOFT_TIME = 0.8;

registerChunk(
  'kaze_wind',
  /* glsl */ `
#ifndef KAZE_WIND
#define KAZE_WIND
#include <kaze_common>
#define KZ_FRONT_SPEED ${FRONT_SPEED.toFixed(2)}
#define KZ_GUIDE_GAIN ${GUIDE_GAIN.toFixed(2)}
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uGust;
uniform vec2 uGuideDir;     // heading of the guided wind (unit)
uniform float uGuide;       // guide envelope 0..1: how much of the air is the guided wind
uniform vec2 uGuidePhase;   // how far the guided fronts have travelled along uGuideDir and slid across it (m)
uniform vec2 uWindFlow;     // heading of the air (unit): the arc from the ambient heading to uGuideDir, by uGuide
uniform float uGuideSoft;   // uGuide low-passed (~0.8 s): for what should join and leave the guided wind gradually
uniform vec2 uWaveDrift;    // how far the sea's waves have drifted downwind (m), integrated on the CPU

// the ambient heading, normalised as it always was
vec2 kzAmbientDir() {
  float l = length(uWindDir);
  return l > 1e-4 ? uWindDir / l : uWindDir;
}

vec2 kazeWindDir() { return uGuide > 0.0 ? uWindFlow : kzAmbientDir(); }

// Wind speed factor of one field of gust fronts, at the point whose coordinates in the field's own travelling frame
// are (along, lateral): a steady breeze that keeps the fields leaning, and gust fronts rolling across them: bands
// ~20 m deep, ~46 m apart (an ~8 m leading edge, a ~15 m core of full gust, an ~7 m trailing edge), broken into
// patches, with ~16 m of steady air between them (the lulls hold still, so the eye sees the bands move). Everything is
// sampled in the fronts' own frame, so a gust patch keeps its shape as it crosses the field. Two noise fetches.
// ~0.25 in a lull .. ~1 in a front.
float kzFronts(float along, float lateral) {
  vec4 nL = textureLod(uNoiseTex, vec2(lateral, along) * 0.0021 + vec2(0.37, 0.11), 0.0);
  vec4 nS = textureLod(uNoiseTex, vec2(lateral, along) * 0.011 + vec2(0.71, 0.29), 0.0);
  // the fronts bend into long arcs (r: ~120 m) with ragged edges (small r: ~20 m)
  float s = fract((along + nL.r * 30.0 + nS.r * 6.0) * (1.0 / 46.0));
  float front = smoothstep(0.35, 0.52, s) * (1.0 - smoothstep(0.82, 1.0, s));
  // patches ~40–80 m across (g, b) and cat's paws inside them (small g, b); the lulls are steady air
  float patchy = smoothstep(-0.4, 0.35, nL.g + 0.35 * nL.b);
  float paws = clamp(0.5 + 0.9 * nS.g + 0.5 * nS.b, 0.0, 1.0);
  float g = 0.3 + uGust * front * patchy * (0.8 + 0.4 * paws);
  return uWindStrength * g;
}

// the strongest gust the ambient wind has (the core of a front where the cat's paws peak): the most a crown should bend
float kazeGustPeak() { return uWindStrength * (0.3 + uGust * 1.2); }

// The bend of both fields cross-faded by the envelope, and the ambient gust on its own (a: what the field has always
// been, ~0.25 in a lull .. ~1 in a front; the guided gust reaches ~1.8). There is no branch: while no guide blows the
// guided fetches read the ambient texels (cache hits) and their term is multiplied by zero. With a branch around the
// guided fetches the compiler fused the consumers' arithmetic differently, by an ulp, and a few pixels of every
// canonical capture moved with it; without it S1 and S3 stay byte-identical to the single-field shader.
void kzBlend(vec2 p, out vec2 b, out float a) {
  vec2 d = kzAmbientDir();
  float alongA = dot(p, d) - uTime * KZ_FRONT_SPEED;
  float lateralA = dot(p, vec2(-d.y, d.x));
  a = kzFronts(alongA, lateralA);
  bool live = uGuide > 0.0;
  float alongG = live ? dot(p, uGuideDir) - uGuidePhase.x : alongA;
  float lateralG = live ? dot(p, vec2(-uGuideDir.y, uGuideDir.x)) - uGuidePhase.y : lateralA;
  float guided = kzFronts(alongG, lateralG);
  b = d * (a * (1.0 - uGuide)) + uGuideDir * (guided * (KZ_GUIDE_GAIN * uGuide));
}

float kazeGust(vec2 p) {
  vec2 b;
  float a;
  kzBlend(p, b, a);
  return uGuide > 0.0 ? length(b) : a;
}

vec2 kazeWindBend(vec2 p) {
  vec2 b;
  float a;
  kzBlend(p, b, a);
  return b;
}
#endif
`
);

const _v2 = new THREE.Vector2();
const _v2b = new THREE.Vector2();
const TWO_PI = Math.PI * 2;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// the t in [0, 1] whose smoothstep is y
const invSmoothstep = (y) => 0.5 - Math.sin(Math.asin(1 - 2 * clamp(y, 0, 1)) / 3);

class Wind {
  constructor() {
    const dir0 = new THREE.Vector2(0.86, 0.51).normalize();
    this.uniforms = registerGlobalUniforms({
      uTime: { value: 0 },
      uWindDir: { value: dir0.clone() },
      uWindStrength: { value: 0.8 },
      uGust: { value: 0.9 },
      uGuideDir: { value: new THREE.Vector2(1, 0) },
      uGuide: { value: 0 },
      uGuidePhase: { value: new THREE.Vector2() },
      uWindFlow: { value: dir0.clone() },
      uGuideSoft: { value: 0 },
      uWaveDrift: { value: new THREE.Vector2() },
    });
    // the ambient wind comes from the west-north-west (off the sea, past the low sun of the field shots) and
    // blows toward the east-south-east: in the west-facing field and duel shots it runs toward the camera and to
    // screen-left, the way the shots stage the capes, so cloth, grass, plumes and leaves all go one way
    this.baseAngle = Math.atan2(0.51, 0.86);
    this.noise = null;
    this.origin = new THREE.Vector2();
    this._guide = null; // { x, z, t, dur }
    this._time = 0;
    this._angle = this.baseAngle; // the ambient heading now (rad)
    this._guideAngle = 0; // the guided heading (rad), turning toward the objective
    this._flowDelta = 0; // signed arc (rad) from the ambient to the guided heading, continuous while a guide lasts
  }

  setNoise(noise) {
    this.noise = noise;
  }

  // The wind clock. Setting it re-anchors everything that is integrated over time (the guided pattern, the sea's
  // drift, the slow envelope, any guide in progress) to that clock alone, so a state depends on the clock and the
  // frames since, not on how long the page ran before: the capture harness relies on it (scripts/shots.mjs).
  get time() {
    return this._time;
  }

  set time(t) {
    this.setTime(t);
  }

  setTime(t) {
    const u = this.uniforms;
    this._time = t;
    this._guide = null;
    this._guideAngle = 0;
    this._flowDelta = 0;
    u.uGuide.value = 0;
    u.uGuideSoft.value = 0;
    u.uGuideDir.value.set(1, 0);
    u.uGuidePhase.value.set(0, 0);
    this.update(0); // sync uTime, the headings and the CPU mirror with the new clock
    // the waves have drifted as far as the heading times the clock would have taken them
    u.uWaveDrift.value.copy(u.uWindDir.value).multiplyScalar(t);
  }

  // Position the guidance is computed from (player or camera), updated by the game every frame.
  setOrigin(x, z) {
    this.origin.set(x, z);
  }

  // Guiding wind: gusts turn toward (x, z) for `seconds`, then relax back to the ambient wind. A guide asked for
  // while none is blowing latches its heading and its pattern; one asked for while a guide is blowing carries on from
  // the level the air has now (no drop to zero), turns toward the new objective at the usual rate and lasts `seconds`
  // from now (or its ramp-out, if that is longer).
  guideTo(x, z, seconds = 6) {
    const u = this.uniforms;
    const level = u.uGuide.value;
    const live = this._guide !== null && level > 0;
    if (!live) {
      const dx = x - this.origin.x, dz = z - this.origin.y;
      this._guideAngle = dx * dx + dz * dz > GUIDE_AIM_MIN * GUIDE_AIM_MIN ? Math.atan2(dz, dx) : this._angle;
      u.uGuideDir.value.set(Math.cos(this._guideAngle), Math.sin(this._guideAngle));
      // a pattern that depends on the clock alone: the fronts of the guided field then travel by integration
      u.uGuidePhase.value.set(this._time * (FRONT_SPEED + GUIDE_EXTRA_SPEED), 0);
      this._flowDelta = wrapAngle(this._guideAngle - this._angle);
    }
    const t0 = live ? GUIDE_RAMP_IN * invSmoothstep(level) : 0; // resume the ramp-in from where the level is
    // a guide that is blowing lasts at least its ramp-out from here, or the envelope would step down at the press
    this._guide = { x, z, t: t0, dur: t0 + (live ? Math.max(seconds, GUIDE_RAMP_OUT) : seconds) };
  }

  update(dt) {
    this._time += dt;
    const u = this.uniforms;
    u.uTime.value = this._time;
    // slow natural veering of the ambient wind (±12°)
    const a = this.baseAngle + Math.sin(this._time * 0.021) * 0.13 + Math.sin(this._time * 0.057 + 1.3) * 0.08;
    this._angle = a;
    u.uWindDir.value.set(Math.cos(a), Math.sin(a));
    let level = 0;
    const g = this._guide;
    if (g) {
      g.t += dt;
      this._steer(dt);
      // the guided fronts travel: the pattern offset is integrated, never time * speed (a speed that changes would
      // re-time every front already on the land)
      u.uGuidePhase.value.x += (FRONT_SPEED + GUIDE_EXTRA_SPEED) * dt;
      level = smoothstep(0, GUIDE_RAMP_IN, g.t) * (1 - smoothstep(g.dur - GUIDE_RAMP_OUT, g.dur, g.t));
      if (g.t >= g.dur) {
        this._guide = null;
        level = 0;
      }
    }
    u.uGuide.value = level;
    // the heading of the air: the arc from the ambient to the guided heading, walked by the envelope; the arc keeps
    // the side it was started on (an objective straight upwind must not flip the air round when it crosses 180°)
    if (level > 0) {
      let delta = wrapAngle(this._guideAngle - a);
      delta += TWO_PI * Math.round((this._flowDelta - delta) / TWO_PI);
      this._flowDelta = delta;
      const f = a + delta * level;
      u.uWindFlow.value.set(Math.cos(f), Math.sin(f));
    } else u.uWindFlow.value.copy(u.uWindDir.value);
    u.uWaveDrift.value.addScaledVector(u.uWindFlow.value, dt);
    const soft = u.uGuideSoft.value + (level - u.uGuideSoft.value) * (1 - Math.exp(-dt / GUIDE_SOFT_TIME));
    u.uGuideSoft.value = level === 0 && soft < 1e-3 ? 0 : soft;
  }

  // The guided heading follows the objective as the player moves, at a limited turn rate. The pattern pivots about
  // the origin (the player): the point of the field under him keeps its place, so turning never sweeps the fronts
  // across the land.
  _steer(dt) {
    const g = this._guide, c = this.origin, u = this.uniforms;
    const dx = g.x - c.x, dz = g.z - c.y;
    if (dx * dx + dz * dz <= GUIDE_AIM_MIN * GUIDE_AIM_MIN) return;
    const max = GUIDE_TURN_RATE * dt;
    const turn = clamp(wrapAngle(Math.atan2(dz, dx) - this._guideAngle), -max, max);
    if (turn === 0) return;
    const gd = u.uGuideDir.value, ph = u.uGuidePhase.value;
    this._guideAngle = wrapAngle(this._guideAngle + turn);
    const nx = Math.cos(this._guideAngle), ny = Math.sin(this._guideAngle);
    ph.x += c.x * nx + c.y * ny - (c.x * gd.x + c.y * gd.y);
    ph.y += -c.x * ny + c.y * nx - (-c.x * gd.y + c.y * gd.x);
    gd.set(nx, ny);
  }

  // The ambient heading, normalised the way the shader does.
  _ambientDir(out) {
    const w = this.uniforms.uWindDir.value;
    out.copy(w);
    const l = out.length();
    if (l > 1e-4) out.multiplyScalar(1 / l);
    return out;
  }

  // CPU mirror of kazeWindDir()
  dir(out = new THREE.Vector2()) {
    const u = this.uniforms;
    return u.uGuide.value > 0 ? out.copy(u.uWindFlow.value) : this._ambientDir(out);
  }

  // CPU mirror of kzFronts(): the two fetches of the shader (no closures here: the cloth calls this hundreds of
  // times per frame)
  _fronts(along, lateral) {
    const u = this.uniforms;
    const n = this.noise;
    const lu = lateral * 0.0021 + 0.37, lv = along * 0.0021 + 0.11;
    const su = lateral * 0.011 + 0.71, sv = along * 0.011 + 0.29;
    const nLr = n ? n.sample(lu, lv, 0) : 0, nLg = n ? n.sample(lu, lv, 1) : 0, nLb = n ? n.sample(lu, lv, 2) : 0;
    const nSr = n ? n.sample(su, sv, 0) : 0, nSg = n ? n.sample(su, sv, 1) : 0, nSb = n ? n.sample(su, sv, 2) : 0;
    const a = (along + nLr * 30 + nSr * 6) * (1 / 46);
    const s = a - Math.floor(a);
    const front = smoothstep(0.35, 0.52, s) * (1 - smoothstep(0.82, 1, s));
    const patchy = smoothstep(-0.4, 0.35, nLg + 0.35 * nLb);
    const paws = clamp(0.5 + 0.9 * nSg + 0.5 * nSb, 0, 1);
    const g = 0.3 + u.uGust.value * front * patchy * (0.8 + 0.4 * paws);
    return u.uWindStrength.value * g;
  }

  // CPU mirror of kzBlend(): the bend of both fields cross-faded by the envelope (while a guide is blowing)
  _blend(x, z, out) {
    const u = this.uniforms;
    const k = u.uGuide.value;
    const gd = u.uGuideDir.value, ph = u.uGuidePhase.value;
    const gs = this._fronts(x * gd.x + z * gd.y - ph.x, -x * gd.y + z * gd.x - ph.y) * (GUIDE_GAIN * k);
    let bx = gd.x * gs, bz = gd.y * gs;
    if (k < 1) {
      const d = this._ambientDir(_v2b);
      const as = this._fronts(x * d.x + z * d.y - u.uTime.value * FRONT_SPEED, -x * d.y + z * d.x) * (1 - k);
      bx += d.x * as;
      bz += d.y * as;
    }
    return out.set(bx, bz);
  }

  // CPU mirror of kazeGust()
  gust(x, z) {
    if (this.uniforms.uGuide.value > 0) {
      const b = this._blend(x, z, _v2);
      return Math.sqrt(b.x * b.x + b.y * b.y);
    }
    const d = this._ambientDir(_v2);
    return this._fronts(x * d.x + z * d.y - this.uniforms.uTime.value * FRONT_SPEED, -x * d.y + z * d.x);
  }

  // CPU mirror of kazeWindBend(): bend vector (direction * strength) at world (x, z).
  sample(x, z, out = new THREE.Vector2()) {
    if (this.uniforms.uGuide.value > 0) return this._blend(x, z, out);
    const g = this.gust(x, z);
    const d = this.dir(out);
    return out.set(d.x * g, d.y * g);
  }

  // CPU mirror of kazeGustPeak(): the strongest gust the ambient field has (the core of a front where the cat's paws
  // peak). The trees' soft cap leaves everything up to it alone.
  gustPeak() {
    const u = this.uniforms;
    return u.uWindStrength.value * (0.3 + u.uGust.value * 1.2);
  }

  // Convenience for audio / UI: overall wind intensity 0..~1.7 at a point.
  intensity(x, z) {
    return clamp(this.gust(x, z), 0, 3);
  }
}

export const wind = new Wind();
