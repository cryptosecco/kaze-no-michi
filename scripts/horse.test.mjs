// Tests for the horse: its pure logic (gaits, leg IK, steering and collision helpers), then the horse in the world — its
// spawn spot, grazing brain, the whistle and the mount prompt — with stand-ins for the game (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gaitAt, GAITS, footfalls, beats, support, legPhase } from '../src/actors/horse/gait.js';
import { solveFore, solveHind, segAngle, foreReach } from '../src/actors/horse/legIK.js';
import { loadShape, LOAD_PEAK, fetlockBell, BELL_PEAK, hermite, quintic, peakCurve, knotCurve, foldCurve, softReach, scapAngle, tipToReach } from '../src/actors/horse/stride.js';
import { HOOF_RINGS } from '../src/actors/horse/mesh.js';
import { wantedSpeed, maxTurnRate, approach, bodyCircles, circleContact, onStairs, stairLocal, slope, SPEEDS } from '../src/actors/horse/steer.js';
import { HORSE_BONES, LEG_CHAINS, buildHorseRig } from '../src/actors/horse/rig.js';
import { Horse, GRAZE_STEP, GRAZE_RANGE, GRAZE_CLEAR } from '../src/actors/horse/Horse.js';
import { Riding, MOUNT_REACH, HINT } from '../src/actors/horse/Riding.js';
import { HORSE_SPAWN, horseSpawn, installHorse } from '../src/actors/horse/index.js';
import { CameraRig } from '../src/actors/CameraRig.js';
import { Prompts } from '../src/actors/combat/Standoff.js';
import { t, setLang } from '../src/ui/i18n.js';
import { Colliders } from '../src/game/Colliders.js';
import { POI } from '../src/world/Layout.js';

const LF = 0, RF = 1, LH = 2, RH = 3;
const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('each gait is selected at its own pace, and the blends sit between them', () => {
  assert.equal(gaitAt(1.8).name, 'walk');
  assert.equal(gaitAt(4.0).name, 'trot');
  assert.equal(gaitAt(8.5).name, 'canter');
  assert.equal(gaitAt(13.5).name, 'gallop');
  for (const g of GAITS) {
    const b = gaitAt(g.speed);
    assert.equal(b.w, 0, `${g.name} is pure at its pace`);
    assert.ok(near(b.freq, g.freq, 1e-9), `${g.name} stride frequency at its pace`);
    assert.ok(near(b.stride, g.speed / g.freq, 1e-9));
  }
  // the transitions blend smoothly: no jump in the stride frequency
  let prev = gaitAt(0.6).freq;
  for (let v = 0.65; v <= 14; v += 0.05) {
    const f = gaitAt(v).freq;
    assert.ok(Math.abs(f - prev) < 0.06, `freq continuous at ${v.toFixed(2)} m/s (${prev.toFixed(3)} → ${f.toFixed(3)})`);
    prev = f;
  }
  // standing still: no steps
  assert.equal(gaitAt(0).amp, 0);
  assert.ok(gaitAt(0).freq < 0.01);
});

test('footfalls: the walk is a lateral 4-beat, the trot a diagonal 2-beat, the canter 3 beats, the gallop 4', () => {
  const walk = gaitAt(1.8), trot = gaitAt(4), canter = gaitAt(8.5), gallop = gaitAt(13.5);
  assert.equal(beats(walk), 4);
  assert.equal(beats(trot), 2);
  assert.equal(beats(canter), 3);
  assert.equal(beats(gallop), 4);
  // walk: LH → LF → RH → RF, evenly spaced
  const w = footfalls(walk).map((f) => f.leg);
  const order = [LH, LF, RH, RF];
  const k = w.indexOf(LH);
  assert.deepEqual([0, 1, 2, 3].map((i) => w[(k + i) % 4]), order);
  // trot: diagonal pairs land together, half a stride apart, the hind a hair first (positive diagonal dissociation,
  // 1–3 % of the stride: Holmström 1994)
  for (const [f, h] of [[LF, RH], [RF, LH]]) {
    const lead = (((trot.off[f] - trot.off[h]) % 1) + 1.5) % 1 - 0.5;
    assert.ok(lead > 0.005 && lead < 0.03, `hind ${h} lands ${lead.toFixed(3)} of a stride before fore ${f}`);
  }
  assert.ok(near(Math.abs(trot.off[LF] - trot.off[RF]), 0.5, 1e-9));
  // fore stances at least as long as the hind ones at the trot (Rhodin et al. 2022)
  assert.ok(trot.duty >= trot.dutyH);
  // canter (right lead): outside hind, then the diagonal pair together, then the leading fore
  assert.ok(near(canter.off[LF], canter.off[RH], 1e-9));
  const c = footfalls(canter).map((f) => f.leg);
  assert.equal(c[(c.indexOf(LH) + 3) % 4], RF);
  // gallop: LH, RH, LF, RF, then a suspension (no hoof down)
  const gl = footfalls(gallop).map((f) => f.leg);
  const j = gl.indexOf(LH);
  assert.deepEqual([0, 1, 2, 3].map((i) => gl[(j + i) % 4]), [LH, RH, LF, RF]);
  let air = false;
  for (let p = 0; p < 1; p += 0.01) if (support(gallop, p) === 0) air = true;
  assert.ok(air, 'the gallop has a moment of suspension');
  // the walk always keeps two or three hooves down
  for (let p = 0; p < 1; p += 0.01) assert.ok(support(walk, p) >= 2, `walk support at ${p.toFixed(2)}`);
  // duty factors fall with speed
  assert.ok(walk.duty > trot.duty && trot.duty > canter.duty && canter.duty > gallop.duty);
});

test('leg phase is a cycle position that starts at the touchdown', () => {
  assert.equal(legPhase(0.3, 0.3), 0);
  assert.ok(near(legPhase(0.1, 0.3), 0.8, 1e-12));
  assert.ok(near(legPhase(1.25, 0), 0.25, 1e-12));
});

// rig lengths of the 2D leg chains (as Horse.js measures them)
const rig = buildHorseRig();
const seg = (a, b) => Math.hypot(rig.rest[b].z - rig.rest[a].z, rig.rest[b].y - rig.rest[a].y);
const ang = (a, b) => Math.atan2(rig.rest[b].y - rig.rest[a].y, rig.rest[b].z - rig.rest[a].z);

test('the fore leg reaches its targets with the elbow behind and the carpus folding back', () => {
  const L = { a: seg('HumL', 'ForeL'), b: seg('ForeL', 'CanFL'), c: seg('CanFL', 'PasFL') };
  const S = { z: 0, y: 0 };
  for (const [tz, ty, kappa] of [[0.05, -0.75, 0], [0.3, -0.72, 0], [-0.25, -0.78, 0], [-0.1, -0.5, 1.6], [0.1, -0.6, 0.6]]) {
    const r = solveFore(S, { z: tz, y: ty }, L, kappa);
    assert.ok(r.reach, `reachable ${tz},${ty}`);
    assert.ok(Math.hypot(r.F.z - tz, r.F.y - ty) < 1e-6, `fetlock on target ${tz},${ty}`);
    // the elbow lies behind the shoulder → fetlock line (clockwise of a downward line: negative 2D cross)
    const cross = (tz - S.z) * (r.E.y - S.y) - (ty - S.y) * (r.E.z - S.z);
    assert.ok(cross < 0, 'elbow behind the line');
    // carpus angle: the cannon turned back from the forearm by kappa
    assert.ok(near(r.aR - r.aC, kappa, 1e-9));
    assert.ok(near(Math.hypot(r.K.z - r.E.z, r.K.y - r.E.y), L.b, 1e-9));
  }
  const far = solveFore(S, { z: 0, y: -2 }, L, 0);
  assert.equal(far.reach, false, 'out of reach is reported, the leg points at it');
});

test('the hind leg keeps femur and cannon turning together (reciprocal apparatus) with the stifle forward', () => {
  const L = { e: seg('FemL', 'TibL'), f: seg('TibL', 'CanHL'), g: seg('CanHL', 'PasHL') };
  const delta = ang('CanHL', 'PasHL') - ang('FemL', 'TibL');
  const P = { z: 0, y: 0 };
  // the rest pose is reproduced
  const F0 = { z: rig.rest.PasHL.z - rig.rest.FemL.z, y: rig.rest.PasHL.y - rig.rest.FemL.y };
  const r0 = solveHind(P, F0, L, delta);
  assert.ok(near(r0.aF, ang('FemL', 'TibL'), 1e-6) && near(r0.aT, ang('TibL', 'CanHL'), 1e-6), 'rest pose');
  for (const [tz, ty] of [[0.3, -0.8], [-0.4, -0.75], [0.0, -0.6], [-0.2, -0.85]]) {
    const r = solveHind(P, { z: tz, y: ty }, L, delta);
    assert.ok(r.reach);
    assert.ok(Math.hypot(r.F.z - tz, r.F.y - ty) < 1e-6, `fetlock on target ${tz},${ty}`);
    assert.ok(near(r.aC - r.aF, delta, 1e-9), 'cannon keeps its angle to the femur');
    // stifle in front of the hip → hock line, hock behind the stifle
    assert.ok(r.K.z > r.H.z, 'stifle ahead of the hock');
    assert.ok(near(segAngle(r.K, r.H), r.aT, 1e-9));
  }
});

test('the fore limb never straightens: past its reach the elbow stays flexed at its limit', () => {
  const L = { a: seg('HumL', 'ForeL'), b: seg('ForeL', 'CanFL'), c: seg('CanFL', 'PasFL') };
  for (const kappa of [0, 0.3, 1.2]) {
    const R = foreReach(L, kappa, 0.52);
    assert.ok(R < L.a + L.b + L.c, 'shorter than the straight limb');
    // a target beyond it: out of reach, the fetlock left at R, the elbow at no less than its limit
    const r = solveFore({ z: 0, y: 0 }, { z: 0.1, y: -1.2 }, L, kappa, undefined, R);
    assert.equal(r.reach, false);
    assert.ok(near(Math.hypot(r.F.z, r.F.y), R, 1e-6), `fetlock at the limit (${kappa})`);
    assert.ok(r.aR - r.aH >= 0.52 - 1e-6, `elbow flexed ${(((r.aR - r.aH) * 180) / Math.PI).toFixed(1)}°`);
    // within it: on target
    const ok = solveFore({ z: 0, y: 0 }, { z: 0.05, y: -(R - 0.02) }, L, kappa, undefined, R);
    assert.ok(ok.reach);
  }
});

test('stride shapes: a stance load of unit area peaking before mid-stance, a fetlock bell, Hermite paths', () => {
  let area = 0, peakU = 0, peak = 0;
  for (let i = 0; i < 1000; i++) {
    const u = (i + 0.5) / 1000, w = loadShape(u);
    area += w / 1000;
    if (w > peak) (peak = w), (peakU = u);
  }
  assert.ok(near(area, 1, 1e-3), `unit area ${area}`);
  assert.ok(near(peakU, LOAD_PEAK, 0.01), 'peaks at LOAD_PEAK (Hobbs et al. 2016: 43–48 % of the stance)');
  assert.equal(loadShape(0), 0);
  assert.equal(loadShape(1), 0);
  assert.ok(fetlockBell(0.001) < 1e-3 && near(fetlockBell(BELL_PEAK), 1, 1e-9), 'the fetlock takes the load up gently');
  // the Hermite curve meets its ends with its slopes; the peak curve tops out where asked
  assert.ok(near(hermite(1, 0.5, 3, -2, 0), 1, 1e-12) && near(hermite(1, 0.5, 3, -2, 1), 3, 1e-12));
  assert.ok(near(peakCurve(0.3, 0, 1, 2, 0.3, 0.5, -1), 2, 1e-12));
  for (let s = 0.01; s < 1; s += 0.01) assert.ok(peakCurve(s, 0, 1, 2, 0.3, 0.5, -1) <= 2 + 1e-9);
  // the quintic meets its ends with their values, slopes and curvatures
  const q = (s) => quintic(1, -2, 30, 4, -1, -20, s), e = 1e-5;
  assert.ok(near(q(0), 1, 1e-12) && near(q(1), 4, 1e-12));
  assert.ok(near((q(e) - q(0)) / e, -2, 1e-3) && near((q(1) - q(1 - e)) / e, -1, 1e-3));
  assert.ok(near((q(2 * e) - 2 * q(e) + q(0)) / (e * e), 30, 0.05) && near((q(1) - 2 * q(1 - e) + q(1 - 2 * e)) / (e * e), -20, 0.05));
  // the knot curve passes through its knots and turns at them where its slope is zero: here a peak, a trough, a peak
  const K = Float64Array.of(0, 0, 2, 0.25, 1, 0, 0.55, 0.6, 0, 0.8, 0.9, 0, 1, 0.1, -3);
  for (let i = 0; i < 5; i++) assert.ok(near(knotCurve(K[i * 3], K, 5), K[i * 3 + 1], 1e-12));
  for (let s = 0.005; s < 1; s += 0.01) {
    const y = knotCurve(s, K, 5);
    assert.ok(s < 0.55 ? y <= 1 + 1e-9 : s < 0.8 ? y >= 0.6 - 1e-9 && y <= 0.9 + 1e-9 : y <= 0.9 + 1e-9, `${s.toFixed(3)}: ${y}`);
  }
  // the swing's fold: rising at once from the lift-off (no pause), most at `at`, gone by `end` and nothing after
  assert.equal(foldCurve(0, 0.3, 0.85), 0);
  assert.ok(near(foldCurve(1e-4, 0.3, 0.85) / 1e-4, 2 / 0.3, 1e-2), 'it starts folding at once');
  assert.ok(near(foldCurve(0.3, 0.3, 0.85), 1, 1e-12) && foldCurve(0.85, 0.3, 0.85) === 0 && foldCurve(0.95, 0.3, 0.85) === 0);
  for (let s = 0.01, prev = 0; s <= 0.85; s += 0.01) {
    const f = foldCurve(s, 0.3, 0.85);
    assert.ok(s <= 0.3 + 1e-9 ? f >= prev - 1e-12 : f <= prev + 1e-12, `one fold, no second hump (${s.toFixed(2)})`);
    prev = f;
  }
  // soft reach: untouched below the knee, never past the limit, a hard limit at knee 1
  for (let d = 0; d < 2; d += 0.05) {
    const r = softReach(d, 1);
    assert.ok(r <= Math.min(d, 1) + 1e-12 && (d > 0.92 || r === d));
  }
  assert.equal(softReach(1.4, 1, 1), 1);
});

test('reach geometry: the shoulder blade swings as far as it must, a planted hoof rolls over its toe to be reached', () => {
  const out = { a: 0, reach: false };
  // the fetlock far ahead and low: the blade turns from its wanted angle just far enough
  const F = { z: 0.3, y: -1.15 }, r = 0.344, R = 0.866, rest = -0.951;
  scapAngle(F, r, rest, rest - 0.33, rest + 0.21, R, out);
  const J = { z: Math.cos(out.a) * r, y: Math.sin(out.a) * r };
  assert.ok(out.reach && Math.hypot(F.z - J.z, F.y - J.y) <= R + 1e-9);
  // already reachable at the wanted angle: it stays there
  scapAngle({ z: 0.1, y: -1.0 }, r, rest, rest - 0.33, rest + 0.21, R, out);
  assert.ok(out.reach && near(out.a, rest, 1e-12));
  // a fetlock left behind: rolling the hoof over its toe brings it forward into reach
  const toe = { z: -0.3, y: -1.25 }, fet = { z: -0.47, y: -1.12 }, root = { z: 0.1, y: -0.33 };
  assert.ok(Math.hypot(fet.z - root.z, fet.y - root.y) > R);
  const extra = tipToReach(toe, fet, root, R);
  assert.ok(extra > 0 && extra < Math.PI / 2, `rolls ${((extra * 180) / Math.PI).toFixed(1)}°`);
  const c = Math.cos(-extra), s = Math.sin(-extra), dz = fet.z - toe.z, dy = fet.y - toe.y;
  const rolled = { z: toe.z + dz * c - dy * s, y: toe.y + dz * s + dy * c };
  assert.ok(Math.hypot(rolled.z - root.z, rolled.y - root.y) <= R + 1e-6, 'and then it is reached');
  assert.equal(tipToReach(toe, root, root, R), 0, 'nothing to do when already in reach');
});

test('the horse rig: chains reach the ground, legs are mirrored', () => {
  assert.equal(new Set(HORSE_BONES.map((b) => b[0])).size, HORSE_BONES.length, 'unique bone names');
  for (const chain of LEG_CHAINS) {
    const sole = rig.rest[chain[chain.length - 1]];
    assert.ok(near(sole.y, 0, 1e-9), `${chain[0]} sole on the ground`);
  }
  for (const n of ['ScapL', 'HoofFL', 'FemL', 'HoofHL']) {
    const m = rig.rest[n.replace(/L$/, 'R')];
    assert.ok(near(rig.rest[n].x, -m.x, 1e-9) && near(rig.rest[n].y, m.y, 1e-9));
  }
});

test('steering: input magnitude picks the gait, turning slows with speed, speed approaches its target', () => {
  assert.equal(wantedSpeed(0.05), 0);
  assert.equal(wantedSpeed(0.3), SPEEDS.walk);
  assert.equal(wantedSpeed(0.6), SPEEDS.trot);
  assert.equal(wantedSpeed(1), SPEEDS.canter);
  assert.equal(wantedSpeed(1, { sprint: true }), SPEEDS.gallop);
  assert.equal(wantedSpeed(1, { walk: true }), SPEEDS.walk);
  let prev = Infinity;
  for (let v = 0; v <= 14; v += 0.5) {
    const r = maxTurnRate(v);
    assert.ok(r <= prev + 1e-12, 'turn rate never grows with speed');
    prev = r;
  }
  // turning circle at a gallop: wide, but not a ship's
  const radius = SPEEDS.gallop / maxTurnRate(SPEEDS.gallop);
  assert.ok(radius > 12 && radius < 30, `gallop turning radius ${radius.toFixed(1)} m`);
  assert.ok(SPEEDS.walk / maxTurnRate(SPEEDS.walk) < 1.5);
  let v = 0;
  for (let i = 0; i < 600; i++) v = approach(v, 13.5, 1 / 60, 3, 5);
  assert.equal(v, 13.5);
  for (let i = 0; i < 60; i++) v = approach(v, 0, 1 / 60, 3, 5);
  assert.ok(near(v, 8.5, 1e-6), 'decelerates at its own rate');
});

test('collision helper: chest and rump circles find the deepest contact and its push direction', () => {
  const c = new Colliders();
  c.addCircle(0, 2, 0.4, { tag: 'tree' });
  c.addBox(10, 0, 1, 3, 0, { tag: 'wall' });
  c.addCircle(-5, 0, 0.5, { tag: 'rock', top: 0.3 });
  const out = {};
  const b = bodyCircles(0, 0.9, 0, {});
  assert.ok(near(b.cz, 0.9 + 0.72, 1e-9) && near(b.rz, 0.9 - 0.6, 1e-9));
  circleContact(c, b.cx, b.cz, b.r, -Infinity, out);
  assert.ok(out.hit && out.tag === 'tree');
  assert.ok(out.nz < -0.99, 'pushed back, away from the trunk');
  assert.ok(near(out.depth, 0.4 + b.r - Math.abs(2 - b.cz), 1e-9));
  circleContact(c, 8.8, 0.5, 0.42, -Infinity, out);
  assert.ok(out.hit && out.tag === 'wall' && out.nx < -0.99, 'box face');
  circleContact(c, -5, 0.6, 0.42, 0, out);
  assert.ok(!out.hit, 'a low rock is stepped over');
  circleContact(c, 30, 30, 0.42, -Infinity, out);
  assert.ok(!out.hit);
});

test('the shrine stairs are off limits, the field is not; slope is rise over run', () => {
  const sh = POI.shrine;
  const u = sh.stairDir;
  const mid = { x: sh.stairsBase.x + u.x * 20, z: sh.stairsBase.z + u.z * 20 };
  assert.ok(onStairs(mid.x, mid.z));
  const l = stairLocal(mid.x, mid.z, {});
  assert.ok(near(l.s, 20, 1e-9) && near(l.lat, 0, 1e-9));
  assert.ok(!onStairs(POI.spawn.x, POI.spawn.z));
  assert.ok(!onStairs(sh.stairsBase.x - u.x * 6, sh.stairsBase.z - u.z * 6), 'the path below the stairs');
  const ramp = (x, z) => 0.5 * x;
  assert.ok(near(slope(ramp, 0, 0, 1, 0), 0.5, 1e-9));
  assert.ok(near(slope(ramp, 0, 0, -1, 0), -0.5, 1e-9));
});

// ---- the horse in the world: stand-ins for the game, the samurai and the camera ------------------------------------------
// This file runs in its own process: the canvas the horse's textures are drawn on is a stand-in that draws nothing.
const blank = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const ctx2d = new Proxy({}, {
  get: (_, k) => (k === 'createImageData' || k === 'getImageData' ? blank : () => {}),
  set: () => true,
});
globalThis.document = { documentElement: {}, createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

// flat, dry ground and nothing to bump into: what is under test is the horse (or a given ground: groundAt(x, z))
function makeGame(groundAt = () => 1) {
  const events = new EventTarget();
  return {
    state: 'play',
    standoffActive: false,
    colliders: new Colliders(),
    terrain: { heightAt: groundAt, surfaceAt: () => ({ path: 0, rock: 0 }) },
    groundAt,
    wind: { sample: (x, z, out) => out.set(0, 0) },
    camera: new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 2000),
    emit: (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail })),
    on(type, fn) {
      events.addEventListener(type, fn);
      return () => events.removeEventListener(type, fn);
    },
    add() {},
    addStat() {},
  };
}

// Math.random from a seed (mulberry32): trials that differ from each other and repeat
const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
function seeded(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

// The real Horse (its brain and its kinematics); the gait and the pose only move legs and bones, never the horse, and are
// left out where thousands of simulated minutes are run
class BrainHorse extends Horse {
  _gait() {}
  _pose() {}
}

// the horse put down at (x, z) facing yaw, as installHorse leaves it: grazing, its first step 4 s off
function putDown(horse, x, z, yaw, mode = 'graze') {
  horse.place(x, z, yaw);
  Object.assign(horse.want, { speed: 0, yaw, brake: false });
  Object.assign(horse, { mode, modeT: 0, stepT: 4, stuckT: 0, still: false, ridden: false, noPush: false });
  horse.react.kind = null;
}

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('the horse is put ahead of the samurai and to his right, whole inside the play camera\'s first view', () => {
  const sp = POI.spawn, sh = POI.shrine;
  const rig = new CameraRig({ camera: new THREE.PerspectiveCamera(), input: {} });
  const rad = THREE.MathUtils.degToRad;
  // half the horizontal field of view of the rig's lens at an aspect ratio
  const half = (aspect) => Math.atan(Math.tan(rad(rig.fov) / 2) * aspect);
  const spawnYaw = Math.atan2(sh.x - sp.x, sh.z - sp.z); // his spawn yaw (src/actors/index.js): turned toward the shrine
  for (const yaw of [spawnYaw, 0, 1, -2, 2.9]) {
    const spot = horseSpawn(sp.x, sp.z, yaw);
    // metres ahead of him and to his right: his forward is (sin, cos), his right (-cos, sin), as the camera rig has them
    const rel = (x, z) => ({
      ahead: (x - sp.x) * Math.sin(yaw) + (z - sp.z) * Math.cos(yaw),
      right: -(x - sp.x) * Math.cos(yaw) + (z - sp.z) * Math.sin(yaw),
    });
    const c = rel(spot.x, spot.z);
    assert.ok(near(c.ahead, HORSE_SPAWN.ahead, 1e-9) && near(c.right, HORSE_SPAWN.right, 1e-9), 'in his own frame');
    assert.ok(c.ahead > 0 && c.right > 0, 'ahead of him and on his right');
    const turn = Math.atan2(Math.sin(spot.yaw - yaw), Math.cos(spot.yaw - yaw));
    assert.ok(near(turn, HORSE_SPAWN.turn, 1e-9), 'heading relative to his');
    assert.ok(Math.hypot(c.ahead, c.right) > 2.5, 'clear of the samurai: its body circles (steer.js) never reach him');
    // the play camera as the rig puts it at the start (snapBehind): behind him along his heading, the boom tilted by the
    // pitch, over his right shoulder, looking along his heading; the angle to the right of its axis of a point (in his frame)
    rig.snapBehind({ yaw });
    const back = rig.dist * Math.cos(rig.pitch);
    const lens = (p) => {
      const side = p.right - rig.shoulder, depth = p.ahead + back;
      return { off: Math.atan2(side, depth), dist: Math.hypot(side, depth) };
    };
    // the horse, nose to tail (about 1.4 m either side of its root), whole in the frame with a margin of its own at 16:9
    // and still in it at 16:10
    const ends = [-1.4, 1.4].map((s) => lens(rel(spot.x + Math.sin(spot.yaw) * s, spot.z + Math.cos(spot.yaw) * s)).off);
    for (const [aspect, margin] of [[16 / 9, 5], [16 / 10, 2]])
      for (const off of ends) assert.ok(Math.abs(off) < half(aspect) - rad(margin), `inside the frame at ${aspect.toFixed(2)}`);
    // it reads as a horse: at least 15% of the frame's height (1.5 m tall at the withers)
    const root = lens(c);
    assert.ok(1.5 / (2 * root.dist * Math.tan(rad(rig.fov) / 2)) > 0.15, `${root.dist.toFixed(1)} m from the lens`);
    // and it stands clear of him in the picture: the samurai's hat, the widest part (~0.5 m), is 5° from its nearest end
    const him = lens({ ahead: 0, right: 0 });
    assert.ok(Math.min(...ends) - him.off > Math.atan(0.5 / him.dist) + rad(5), 'beside him, not behind him');
  }
});

// a grazing step is a few strides: its length in range (a two-component vector would give anything from 0 to 3.5 m)
const stepsOk = (shortest, longest) => shortest >= GRAZE_STEP[0] - 1e-3 && longest <= GRAZE_STEP[1] + 1e-3;

test('place() records the home point; a grazing step is one heading and one length, a few strides', () => {
  const horse = new BrainHorse(makeGame());
  putDown(horse, 12.5, -4.25, 0.3);
  assert.deepEqual(horse.home, { x: 12.5, z: -4.25 });
  assert.ok(GRAZE_STEP[0] >= 1 && GRAZE_STEP[0] < GRAZE_STEP[1] && GRAZE_STEP[1] <= 4, 'a few metres');
  // a step begins when the countdown ends: the target is GRAZE_STEP m from the horse, whatever the heading
  let steps = 0, shortest = Infinity, longest = 0;
  for (let seed = 1; seed <= 200; seed++)
    seeded(seed, () => {
      putDown(horse, 12.5, -4.25, seed * 0.37);
      horse.stepT = 0;
      horse.update(1 / 60);
      assert.equal(horse.mode, 'amble');
      const len = dist2(horse.target, horse.position);
      shortest = Math.min(shortest, len);
      longest = Math.max(longest, len);
      steps++;
    });
  assert.equal(steps, 200);
  assert.ok(stepsOk(shortest, longest), `step lengths ${shortest.toFixed(2)}–${longest.toFixed(2)} m`);
  assert.ok(longest - shortest > 1, 'the lengths vary');
});

test('a grazing horse stays within 10 m of where it was put over 20 simulated minutes, in every one of 30 trials', () => {
  const horse = new BrainHorse(makeGame());
  const home = { x: 1.84, z: 5.23 };
  const bound = 10; // GRAZE_RANGE (6 m) plus one step (at most 3.5 m), with a little to spare
  assert.ok(GRAZE_RANGE + GRAZE_STEP[1] < bound);
  let farthest = 0, ambles = 0, shortest = Infinity, longest = 0, wanderers = 0;
  for (let seed = 1; seed <= 30; seed++)
    seeded(seed, () => {
      putDown(horse, home.x, home.z, seed * 0.9);
      let far = 0, was = horse.mode, from = null;
      for (let i = 0; i < 20 * 60 * 60; i++) {
        horse.update(1 / 60);
        if (horse.mode === 'amble' && was !== 'amble') {
          from = { x: horse.position.x, z: horse.position.z };
          shortest = Math.min(shortest, dist2(horse.target, from));
          longest = Math.max(longest, dist2(horse.target, from));
          ambles++;
        } else if (horse.mode !== 'amble' && was === 'amble') {
          // an amble ends within 0.6 m of its target or after 5 s at 0.6 m/s: never a stride beyond the step
          assert.ok(dist2(horse.position, from) <= GRAZE_STEP[1] + 0.3, 'one step is a step');
        }
        was = horse.mode;
        far = Math.max(far, dist2(horse.position, home));
      }
      farthest = Math.max(farthest, far);
      if (far > 2) wanderers++;
    });
  assert.ok(farthest < bound, `the farthest from home in 30 × 20 min: ${farthest.toFixed(2)} m`);
  assert.ok(ambles > 30 * 60, `the horse does graze about: ${ambles} steps in all`);
  assert.ok(wanderers === 30, 'every trial strays a few metres: it is a tether, not a stake');
  assert.ok(stepsOk(shortest, longest), `step lengths ${shortest.toFixed(2)}–${longest.toFixed(2)} m`);
});

test('a horse that strayed more than 6 m from home turns for home on its next step', () => {
  const horse = new BrainHorse(makeGame());
  for (let seed = 1; seed <= 300; seed++)
    seeded(seed, () => {
      putDown(horse, 0, 0, seed * 0.77);
      // pushed (or called, or ridden and left) out to 6.5–14 m on any side: it was put down at the origin
      const d = 6.5 + Math.random() * 7.5, a = Math.random() * Math.PI * 2;
      horse.position.x = Math.sin(a) * d;
      horse.position.z = Math.cos(a) * d;
      horse.stepT = 0;
      horse.update(1 / 60);
      assert.equal(horse.mode, 'amble');
      assert.ok(dist2(horse.target, horse.home) < dist2(horse.position, horse.home) - 1.0, `seed ${seed}: the step brings it home`);
    });
});

// The samurai as the brain sees him: where he stands, his body radius, alive. A body circle of the horse within 0.5 m + his
// radius pushes him aside (Horse._move) and nothing here moves him back, so a shove shows as a changed position.
const standing = (x, z) => ({ position: new THREE.Vector3(x, 1, z), yaw: 0, alive: true, radius: 0.38 });
const shoved = (samurai, x, z) => samurai.position.x !== x || samurai.position.z !== z;
// distance from the point (px, pz) to the straight run a → b
function runDist(a, b, px, pz) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(a.x + dx * t - px, a.z + dz * t - pz);
}

test('_crosses: whether a straight run passes within a distance of a standing actor, its two ends included', () => {
  const horse = new BrainHorse(makeGame());
  const a = { x: 0, z: 0 }, b = { x: 0, z: 3 };
  assert.equal(horse._crosses(standing(1.5, 1.5), a, b, 1.8), true, 'beside the middle, 1.5 m off');
  assert.equal(horse._crosses(standing(2.0, 1.5), a, b, 1.8), false, '2 m off');
  assert.equal(horse._crosses(standing(0, 4.5), a, b, 1.8), true, 'past the far end, 1.5 m from it');
  assert.equal(horse._crosses(standing(0, 5.0), a, b, 1.8), false, '2 m past it');
  assert.equal(horse._crosses(standing(-1.2, -1.2), a, b, 1.8), true, 'behind the start, 1.7 m from it');
  assert.equal(horse._crosses(standing(-1.4, -1.4), a, b, 1.8), false, '2 m behind it');
  assert.equal(horse._crosses(standing(1, 1), a, a, 1.8), true, 'a run of no length is a spot');
  assert.equal(horse._crosses(null, a, b, 1.8), false, 'nobody there: nothing to cross');
});

test('a grazing step that would cross the samurai is drawn again; one that cannot be drawn clear is not taken', () => {
  const sp = POI.spawn, yaw = Math.atan2(POI.shrine.x - sp.x, POI.shrine.z - sp.z);
  const spot = horseSpawn(sp.x, sp.z, yaw);
  const horse = new BrainHorse(makeGame());
  horse.player = standing(sp.x, sp.z);
  // at his spawn: every step taken stays clear of him and within the step's length range, and nearly every step is taken
  // (a single draw would be refused one time in three there)
  const seeds = 400;
  let taken = 0;
  for (let seed = 1; seed <= seeds; seed++)
    seeded(seed, () => {
      putDown(horse, spot.x, spot.z, spot.yaw);
      horse.stepT = 0;
      horse.update(1 / 60);
      if (horse.mode !== 'amble') return;
      taken++;
      const len = dist2(horse.target, horse.position), clear = runDist(horse.position, horse.target, sp.x, sp.z);
      assert.ok(len >= GRAZE_STEP[0] - 1e-3 && len <= GRAZE_STEP[1] + 1e-3, `seed ${seed}: a step of ${len.toFixed(2)} m`);
      assert.ok(clear >= GRAZE_CLEAR, `seed ${seed}: passes ${clear.toFixed(2)} m from him, margin ${GRAZE_CLEAR} m`);
    });
  assert.ok(taken >= seeds * 0.95, `and the horse still grazes about: ${taken} of ${seeds} steps taken`);
  // right beside him, within the margin: no step at all, and the next try is 7–16 s off as after any step
  for (const near of [0.55, 0.8, 0.95])
    for (let k = 0; k < 8; k++)
      seeded(k + 1, () => {
        const a = (k / 8) * Math.PI * 2, d = near * GRAZE_CLEAR;
        horse.player = standing(spot.x + Math.sin(a) * d, spot.z + Math.cos(a) * d);
        putDown(horse, spot.x, spot.z, spot.yaw);
        horse.stepT = 0;
        horse.update(1 / 60);
        assert.equal(horse.mode, 'graze', `${d.toFixed(2)} m from him: it stays where it is`);
        assert.ok(horse.stepT >= 7 && horse.stepT <= 16, `and tries again in ${horse.stepT.toFixed(1)} s`);
      });
});

test('the grazing horse never shoves a samurai who stands still at his spawn, in 2 minutes, from either start', () => {
  const sp = POI.spawn, yaw = Math.atan2(POI.shrine.x - sp.x, POI.shrine.z - sp.z);
  const spot = horseSpawn(sp.x, sp.z, yaw);
  const horse = new BrainHorse(makeGame());
  // ?nointro: the first step 4 s into play; after the cinematic: 6–10 s after the hand-over (FIRST_STEP, horse/index.js)
  const starts = { '?nointro': () => 4, 'after the cinematic': () => 6 + Math.random() * 4 };
  const trials = 100;
  for (const [name, firstStep] of Object.entries(starts)) {
    let bumped = 0, steps = 0;
    for (let seed = 1; seed <= trials; seed++)
      seeded(seed, () => {
        const samurai = standing(sp.x, sp.z);
        horse.player = samurai;
        putDown(horse, spot.x, spot.z, spot.yaw);
        horse.stepT = firstStep();
        let was = horse.mode;
        for (let i = 0; i < 120 * 60 && !shoved(samurai, sp.x, sp.z); i++) {
          horse.update(1 / 60);
          if (horse.mode === 'amble' && was !== 'amble') steps++;
          was = horse.mode;
        }
        if (shoved(samurai, sp.x, sp.z)) bumped++;
      });
    assert.equal(bumped, 0, `${name}: the horse shoved the samurai in ${bumped} of ${trials} trials`);
    assert.ok(steps > trials * 6, `${name}: it kept grazing about, ${(steps / trials).toFixed(1)} steps in 2 minutes`);
  }
});

test('a strayed horse does not walk through a samurai who stands on its way home, in 90 s', () => {
  const horse = new BrainHorse(makeGame());
  const trials = 100;
  let bumped = 0;
  for (let seed = 1; seed <= trials; seed++)
    seeded(seed, () => {
      putDown(horse, 0, 0, 0); // home: the origin
      // pushed out 6.5–12 m on some side, facing any way; the samurai 25–75% of the way back, within 1 m of the line
      const out = 6.5 + Math.random() * 5.5, a = Math.random() * Math.PI * 2;
      const f = 0.25 + Math.random() * 0.5, off = Math.random() * 2 - 1;
      horse.position.x = Math.sin(a) * out;
      horse.position.z = Math.cos(a) * out;
      horse.yaw = Math.random() * Math.PI * 2;
      const sx = Math.sin(a) * out * (1 - f) + Math.cos(a) * off, sz = Math.cos(a) * out * (1 - f) - Math.sin(a) * off;
      const samurai = standing(sx, sz);
      horse.player = samurai;
      for (let i = 0; i < 90 * 60 && !shoved(samurai, sx, sz); i++) horse.update(1 / 60);
      if (shoved(samurai, sx, sz)) bumped++;
    });
  assert.equal(bumped, 0, `the horse shoved the samurai in ${bumped} of ${trials} trials`);
});

test('a samurai standing close by keeps clear of the grazing horse\'s body, whichever way it faces and has to turn', () => {
  // A horse sets off while it turns, walking an arc off its straight run, and its chest circle sits 0.72 m ahead of its
  // root. With the push off, how close does any body circle come to him over a step the brain agrees to take? He stands
  // 1.7–2.6 m from its root, on every side of it (of its way home, when it has strayed), and it faces every way round.
  const horse = new BrainHorse(makeGame());
  const push = 0.5 + 0.38; // a body circle this close pushes him aside (Horse._move: 0.5 m and his radius)
  const bc = {};
  let accepted = 0, closest = Infinity, at = '';
  for (const strayed of [false, true])
    for (const r of [1.7, 1.9, 2.1, 2.3, 2.6])
      for (let i = 0; i < 12; i++)
        for (let j = 0; j < 8; j++)
          for (let s = 1; s <= 3; s++)
            seeded(s * 7919 + i * 101 + j * 13 + Math.round(r * 10) + (strayed ? 5 : 0), () => {
              putDown(horse, 0, 0, 0); // home: the origin
              if (strayed) horse.position.x = 7; // 7 m out, past GRAZE_RANGE: the step heads for home, along -x
              const hx = horse.position.x, toward = (i / 12) * Math.PI * 2 + (strayed ? -Math.PI / 2 : 0);
              const sx = hx + Math.sin(toward) * r, sz = Math.cos(toward) * r;
              horse.player = standing(sx, sz);
              horse.noPush = true; // measure how close the body comes, not where it would shove him
              horse.yaw = toward + (j / 8) * Math.PI * 2; // j = 0: facing him
              horse.stepT = 0;
              horse.update(1 / 60);
              if (horse.mode !== 'amble') return;
              accepted++;
              for (let f = 0; f < 10 * 60 && horse.mode === 'amble'; f++) {
                const p = horse.position, away = (x, z) => Math.hypot(x - sx, z - sz);
                bodyCircles(p.x, p.z, horse.yaw, bc);
                const d = Math.min(away(p.x, p.z), away(bc.cx, bc.cz), away(bc.rx, bc.rz)); // root, chest, rump
                if (d < closest) {
                  closest = d;
                  at = `${r} m out, strayed ${strayed}, bearing ${i}, facing ${j}, seed ${s}`;
                }
                horse.update(1 / 60);
              }
            });
  assert.ok(accepted > 400, `the horse does take steps with him around: ${accepted} of 2880`);
  assert.ok(closest >= push + 0.15, `a body circle came ${closest.toFixed(2)} m from him (${at}), pushing at ${push} m`);
});

test('only a grazing horse takes grazing steps: a waiting one stands where it is', () => {
  const horse = new BrainHorse(makeGame());
  putDown(horse, 3, 4, 1, 'wait');
  horse.stepT = -100;
  for (let i = 0; i < 10 * 60 * 60; i++) horse.update(1 / 60);
  assert.equal(horse.mode, 'wait');
  assert.ok(near(horse.position.x, 3, 1e-9) && near(horse.position.z, 4, 1e-9));
});

// installHorse with the real Horse and Riding on the stand-ins: the module as src/actors/index.js wires it
function install() {
  const game = makeGame();
  const player = { position: new THREE.Vector3(0, 1, 0), yaw: 0.8, alive: true, mounted: false, noiseRange: 0, radius: 0.38 };
  const pc = { f: { busy: false, drawn: false }, controlLock: 0, vel: new THREE.Vector3(), walkMode: false };
  const deps = {
    player, pc, camRig: {}, combat: { inCombat: false }, standoff: { state: 'none', _group: () => [] },
    quests: { current: null, praying: 0, ending: 0 }, prompts: new Prompts(game),
  };
  game.input = { pressed: () => false, down: () => false, move: () => ({ x: 0, y: 0 }) };
  const api = installHorse(game, deps);
  game.emit('state', { state: 'play', prev: 'title' });
  return { game, api, horse: api.horse, player };
}

test('the horse takes no grazing step while the opening cinematic plays, and its first comes some seconds after', () => {
  seeded(11, () => {
    const { game, api, horse } = install();
    const spot = { x: horse.position.x, z: horse.position.z };
    assert.ok(near(spot.x, horseSpawn(0, 0, 0.8).x, 1e-9) && near(spot.z, horseSpawn(0, 0, 0.8).z, 1e-9), 'put in his frame');
    game.emit('intro:start', {});
    // the cinematic is 13.5 s, after the title's ink has cleared: 60 s is more than any wait
    for (let i = 0; i < 60 * 60; i++) {
      api.update(1 / 60);
      assert.equal(horse.mode, 'graze', `still at ${(i / 60).toFixed(1)} s`);
    }
    assert.equal(dist2(horse.position, spot), 0, 'it did not move');
    game.emit('intro:end', { skipped: false });
    let t = 0;
    while (horse.mode === 'graze' && t < 30) {
      api.update(1 / 60);
      t += 1 / 60;
    }
    assert.equal(horse.mode, 'amble');
    assert.ok(t >= 6 - 0.02 && t <= 10 + 0.05, `first step ${t.toFixed(1)} s after the hand-over: a pause of several seconds`);
  });
});

test('without the cinematic (?nointro) the horse grazes about as before', () => {
  seeded(12, () => {
    const { api, horse } = install();
    let t = 0;
    while (horse.mode === 'graze' && t < 30) {
      api.update(1 / 60);
      t += 1 / 60;
    }
    assert.equal(horse.mode, 'amble');
    assert.ok(t > 1 && t < 8, `first step after ${t.toFixed(1)} s of play`);
  });
});

// The riding hook (whistle, mount prompt, the whistle's key) on the stand-ins: the samurai on foot at the origin facing +z, the
// real Horse wherever a test puts it, the real Prompts, and a HUD that remembers what the prompt line shows
function scene() {
  const game = makeGame();
  const player = { position: new THREE.Vector3(0, 1, 0), yaw: 0, alive: true, mounted: false, noiseRange: 0, radius: 0.38 };
  const pc = { f: { busy: false, drawn: false }, controlLock: 0, vel: new THREE.Vector3(), walkMode: false };
  const combat = { inCombat: false };
  const standoff = { state: 'none', _group: () => [] };
  const quests = { current: null, praying: 0, ending: 0 };
  const prompts = new Prompts(game);
  const keys = new Set(); // the actions pressed this frame
  game.input = { pressed: (a) => keys.has(a), down: (a) => keys.has(a), move: () => ({ x: 0, y: 0 }) };
  const horse = new Horse(game);
  horse.player = player;
  const riding = new Riding(game, horse, { player, pc, camRig: {}, combat, standoff, quests, prompts });
  // the play camera behind the samurai, as the rig holds it (a horse called from far comes back from behind it)
  game.camera.position.set(0, 2, -3.7);
  game.camera.lookAt(0, 1.8, 2);
  game.camera.updateMatrixWorld(true);
  const hud = { text: null, key: null, shown: [] };
  game.on('prompt', (e) => {
    hud.text = e.detail.text;
    hud.key = e.detail.key;
    hud.shown.push(e.detail.text);
  });
  game.on('prompt:clear', () => (hud.text = hud.key = null));
  const s = { game, player, pc, combat, standoff, quests, prompts, horse, riding, hud, keys };
  // the horse put down at (x, z) facing yaw, grazing, and the samurai back at the origin
  s.put = (x, z, yaw = 0, mode = 'graze') => {
    putDown(horse, x, z, yaw, mode);
    player.position.set(0, 1, 0);
  };
  // seconds of frames: the controller (riding.drive), the horse (when `moving`), then `after(frame)` for what runs after the
  // controller in the game (the standoff and the quests set their prompts there); `press` is held for the first frame
  s.run = (seconds, { dt = 1 / 60, control = true, moving = false, press = null, after = null } = {}) => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      keys.clear();
      if (press && i === 0) keys.add(press);
      riding.drive(dt, control);
      if (moving) horse.update(dt);
      if (after) after(i);
    }
    keys.clear();
  };
  return s;
}

test('the whistle\'s key is shown once, to a samurai far from a horse he never called, for 8 s in all', () => {
  setLang('en');
  const s = scene();
  const text = t('horseCall');
  assert.equal(text, 'Call the horse');
  const shows = () => s.hud.shown.filter((x) => x === text).length;
  s.put(HINT.far - 5, 0); // close enough to see it: nothing to say
  s.run(5);
  assert.equal(s.hud.shown.length, 0);
  s.put(HINT.far + 5, 0);
  s.run(0.1);
  assert.equal(s.hud.text, text);
  assert.equal(s.hud.key, 'H', 'the key it names, as the other prompts name theirs');
  assert.equal(s.prompts.stack.has('whistle'), true, 'a prompt owner of its own');
  s.run(HINT.time - 1);
  assert.equal(s.hud.text, text, 'still up before the time is out');
  s.run(1.2);
  assert.equal(s.hud.text, null, 'gone when it is');
  assert.equal(s.prompts.stack.size, 0);
  // never again, near or far
  for (const d of [3, 40, 120, HINT.far + 1]) {
    s.put(d, 0);
    s.run(HINT.time + 2);
  }
  assert.equal(shows(), 1);
  setLang('it');
  assert.equal(t('horseCall'), 'Chiama il cavallo');
  setLang('en');
});

test('the whistle\'s key goes when he whistles or mounts, and a samurai who already did is never shown it', () => {
  setLang('en');
  const text = t('horseCall');
  // whistles while it shows
  let s = scene();
  s.put(HINT.far + 10, 0);
  s.run(2);
  assert.equal(s.hud.text, text);
  s.run(0.05, { press: 'horse' });
  assert.notEqual(s.hud.text, text, 'the whistle takes it away at once');
  s.put(HINT.far + 30, 0);
  s.run(HINT.time + 5);
  assert.equal(s.hud.shown.filter((x) => x === text).length, 1, 'and it does not come back');
  // mounts while it shows (E near the saddle starts the approach; the rest of the mount is not under test here)
  s = scene();
  s.put(HINT.far + 10, 0);
  s.run(2);
  assert.equal(s.hud.text, text);
  s.riding._beginApproach();
  assert.notEqual(s.hud.text, text, 'mounting takes it away');
  s.riding.state = 'off'; // dismounted again
  s.player.mounted = false;
  s.put(HINT.far + 30, 0);
  s.run(HINT.time + 5);
  assert.equal(s.hud.shown.filter((x) => x === text).length, 1);
  // whistled before ever going far: never shown it
  s = scene();
  s.put(3, 0);
  s.run(0.05, { press: 'horse' });
  s.run(1);
  s.put(HINT.far + 30, 0);
  s.run(HINT.time + 5);
  assert.equal(s.hud.shown.filter((x) => x === text).length, 0);
});

test('the whistle\'s key waits for him to be free: not in a cutscene, a fight, a standoff, a prayer or the ending', () => {
  setLang('en');
  const text = t('horseCall');
  const blockers = {
    'out of control (cutscene)': { on: () => {}, opts: { control: false }, off: () => {} },
    'in combat': { on: (s) => (s.combat.inCombat = true), off: (s) => (s.combat.inCombat = false) },
    'in a standoff': { on: (s) => (s.standoff.state = 'wait'), off: (s) => (s.standoff.state = 'none') },
    'praying': { on: (s) => (s.quests.praying = 3), off: (s) => (s.quests.praying = 0) },
    'at the ending': { on: (s) => (s.quests.ending = 1), off: (s) => (s.quests.ending = 0) },
  };
  for (const [name, b] of Object.entries(blockers)) {
    const s = scene();
    s.put(HINT.far + 10, 0);
    b.on(s);
    s.run(HINT.time + 3, b.opts || {});
    assert.equal(s.hud.shown.length, 0, `${name}: nothing shown`);
    b.off(s);
    s.run(0.2);
    assert.equal(s.hud.text, text, `${name}: shown once he is free`);
  }
  // when he falls the line is cleared (this controller does not run while he is down)
  const s = scene();
  s.put(HINT.far + 10, 0);
  s.run(1);
  assert.equal(s.hud.text, text);
  s.game.emit('player:death', {});
  assert.equal(s.hud.text, null, 'a fallen samurai is shown nothing');
});

test('the whistle\'s key never takes the line from the mount, standoff or prayer prompts', () => {
  setLang('en');
  const text = t('horseCall');
  // the standoff's prompt holds the line (Standoff.update sets it every frame, after the controller): what the player sees
  // is what the line says at the end of each frame, and it is never the key
  let s = scene();
  s.put(HINT.far + 10, 0);
  let over = 0;
  s.run(10, { after: () => (s.prompts.set('standoff', 'Sfida (standoff)', 'E'), s.hud.text === text && over++) });
  assert.equal(over, 0, 'never shown over the standoff prompt');
  assert.equal(s.hud.text, 'Sfida (standoff)');
  // a prompt that is set once and stays (the last one set is the one shown): the key does not come over it either
  s = scene();
  s.put(HINT.far + 10, 0);
  s.prompts.set('pray', 'Prega al santuario', 'E');
  s.run(10);
  assert.equal(s.hud.text, 'Prega al santuario');
  assert.equal(s.hud.shown.includes(text), false);
  s.prompts.clear('pray');
  s.run(0.1);
  assert.equal(s.hud.text, text, 'it is shown once the line is free');
  // a prayer starts while it shows: its prompt at once, the key's gone for the time being and comes back after, for what
  // is left of its 8 s
  s = scene();
  s.put(HINT.far + 10, 0);
  let seen = 0;
  const count = () => {
    if (s.hud.text === text) seen++;
  };
  s.run(2, { after: count });
  assert.equal(s.hud.text, text);
  s.run(3, { after: () => (s.prompts.set('pray', 'Prega al santuario', 'E'), count()) });
  assert.equal(s.hud.text, 'Prega al santuario', 'the prayer prompt shows');
  const during = seen;
  s.prompts.clear('pray');
  s.run(HINT.time + 2, { after: count });
  assert.equal(s.hud.text, null);
  assert.ok(during <= 2 * 60 + 2, 'it stepped aside the moment the prayer prompt came');
  assert.ok(Math.abs(seen - HINT.time * 60) <= 4, `8 s of it in all, shown for ${(seen / 60).toFixed(2)} s`);
  // the mount prompt is the controller's own, and E mounts: with the horse in reach nothing else is on the line
  s = scene();
  s.put(2, 0);
  s.run(1);
  assert.equal(s.hud.text, t('horseMount'));
  assert.equal(s.hud.shown.includes(text), false);
});

test('a called horse arrives within mount reach: the prompt shows without the samurai moving, from near and from far', () => {
  setLang('en');
  const s = scene();
  const mountText = t('horseMount');
  let worst = 0, scenarios = 0, nearest = Infinity;
  const call = (x, z, yaw, dt) => {
    s.put(x, z, yaw);
    s.run(dt, { dt, press: 'horse' }); // the whistle…
    let elapsed = 0;
    while (s.horse.mode !== 'wait' && elapsed < 30) {
      s.run(dt, { dt, moving: true }); // …and the horse comes
      elapsed += dt;
    }
    assert.equal(s.horse.mode, 'wait', `it arrives (${x.toFixed(0)}, ${z.toFixed(0)}) at ${dt.toFixed(3)} s steps`);
    s.run(2 / 60, { moving: true }); // the controller reads the new state
    // the distance to the horse's body line, as Riding._canMount measures it
    const p = s.horse.position, sn = Math.sin(s.horse.yaw), cs = Math.cos(s.horse.yaw);
    const dx = s.player.position.x - p.x, dz = s.player.position.z - p.z;
    const along = Math.max(-0.7, Math.min(0.75, dx * sn + dz * cs));
    worst = Math.max(worst, Math.hypot(dx - sn * along, dz - cs * along));
    nearest = Math.min(nearest, Math.hypot(dx, dz));
    assert.equal(s.hud.text, mountText, 'the mount prompt is on the line');
    assert.equal(s.hud.key, 'E');
    assert.equal(s.riding._canMount(), true);
    assert.deepEqual([s.player.position.x, s.player.position.z], [0, 0], 'the samurai neither moved nor was pushed');
    scenarios++;
  };
  // from near (7–24 m: it runs straight to him) and from far (over 80 m: it comes back from behind the camera), from every
  // side, at three frame rates, the horse starting out turned either way
  const around = (d, bearings, yaw, dt) => bearings.forEach((b) => call(Math.sin(b) * d, Math.cos(b) * d, yaw, dt));
  for (const dt of [1 / 30, 1 / 60, 1 / 144])
    for (const yaw of [0, 3]) {
      for (const d of [7, 12, 24]) around(d, [0, Math.PI / 2, Math.PI, -Math.PI / 2], yaw, dt);
      for (const d of [150, 400]) around(d, [0, Math.PI], yaw, dt);
    }
  assert.equal(scenarios, 3 * 2 * (12 + 4));
  const reach = `reach ${MOUNT_REACH} m`;
  assert.ok(worst <= MOUNT_REACH - 0.1, `the samurai is at most ${worst.toFixed(2)} m from the horse's body line: ${reach}`);
  assert.ok(nearest > 2.5, `and never closer than ${nearest.toFixed(2)} m from the samurai: no push, no overlap`);
});

// ---- the stride's physics on the real horse: a steady trot on flat ground (the trot lab measures it in full) ----------
// The horse driven as a rider drives it, the ground flat at y = 1; after `settle` s every frame of `secs` s is kept: per
// leg its sole centre and toe in the world (the hoof capsule's ground ring, mesh.js: 0.03 m and 0.088 m ahead of the
// coronet, 0.072 m below it), its contact state and reach, the trunk's height and its acceleration, the bones' turns.
function trot(speed, { dt = 1 / 240, settle = 5, secs = 3, yaw = 0, ground } = {}) {
  return seeded(3, () => {
    const horse = new Horse(makeGame(ground));
    horse.place(0, 0, 0);
    Object.assign(horse, { ridden: true, mode: 'ridden', graze: 0, speed });
    const sole = new THREE.Vector3(), toe = new THREE.Vector3(), body = new THREE.Vector3(), top = new THREE.Vector3();
    const hoofs = horse.legs.map((L) => L.segs[L.segs.length - 1].bone);
    // the withers on the chest (mesh.js top line: z 0.40 m, y 1.35 m in the model), in the chest bone's frame
    const withers = new THREE.Vector3(0, 1.35, 0.4).sub(horse.rig.rest.Chest);
    const frames = [];
    let t = 0;
    while (t < settle + secs) {
      horse.want.speed = speed;
      horse.want.yaw = horse.yaw + yaw * 0.12;
      horse.update(dt);
      t += dt;
      if (t < settle) continue;
      horse.root.updateMatrixWorld(true);
      horse.bones.Body.getWorldPosition(body);
      frames.push({
        t,
        bodyY: body.y,
        withers: withers.clone().applyMatrix4(horse.bones.Chest.matrixWorld).toArray(),
        acc: horse.trunk.acc,
        legs: horse.legs.map((L, l) => {
          sole.set(0, -0.072, 0.03).applyMatrix4(hoofs[l].matrixWorld);
          toe.set(0, -0.072, 0.088).applyMatrix4(hoofs[l].matrixWorld);
          // the limb's root joint: the hip, or the fore's shoulder joint (the humerus's head)
          L.segs[L.fore ? 1 : 0].bone.getWorldPosition(top);
          return { stance: L.inStance, u: L.u, s: L.s, tip: L.tip, reach: L.ik.reach, sole: sole.toArray(), toe: toe.toArray(), root: top.toArray(), m: hoofs[l].matrixWorld.clone() };
        }),
        angles: horse.legs.map((L) => L.segs.map((sg) => sg.ang)),
        quats: horse.rig.list.map((b) => b.quaternion.clone()),
      });
    }
    return { horse, frames };
  });
}

test('a steady trot: each hoof stays where it landed, flat then rolling over a toe that does not move', () => {
  const { frames } = trot(4.0);
  let worstSole = 0, worstToe = 0, stances = 0, deepest = 0;
  for (let l = 0; l < 4; l++) {
    let start = null, toeAt = null;
    for (const f of frames) {
      const L = f.legs[l];
      deepest = Math.min(deepest, L.sole[1] - 1, L.toe[1] - 1);
      if (!L.stance) {
        if (start) stances++;
        start = toeAt = null;
        continue;
      }
      // past the heel's landing, the sole centre stays put while the hoof is flat
      if (L.u > 0.1 && L.tip === 0) {
        if (!start) start = L.sole;
        worstSole = Math.max(worstSole, Math.hypot(L.sole[0] - start[0], L.sole[2] - start[2]));
      }
      // through the breakover the toe stays put, on the ground
      if (L.tip > 0) {
        if (!toeAt) toeAt = L.toe;
        worstToe = Math.max(worstToe, Math.hypot(L.toe[0] - toeAt[0], L.toe[2] - toeAt[2]), Math.abs(L.toe[1] - 1));
      }
    }
  }
  assert.ok(stances >= 16, `${stances} stances seen`);
  assert.ok(worstSole < 0.003, `a planted sole slid ${(worstSole * 1000).toFixed(1)} mm`);
  assert.ok(worstToe < 0.003, `the toe moved ${(worstToe * 1000).toFixed(1)} mm while the hoof rolled over it`);
  assert.ok(deepest > -0.002, `a hoof went ${(-deepest * 1000).toFixed(1)} mm into the ground`);
});

test('a steady trot: the trunk flies under gravity alone and sinks through each stance, the same on both diagonals', () => {
  const { frames } = trot(4.0);
  // in the air (no hoof down) the trunk's own vertical acceleration is gravity
  const air = frames.filter((f) => f.legs.every((L) => !L.stance));
  assert.ok(air.length > 40, `${air.length} airborne frames`);
  const a = air.reduce((s, f) => s + f.acc, 0) / air.length;
  assert.ok(Math.abs(a + 9.81) < 0.5, `mean acceleration in the air ${a.toFixed(2)} m/s²`);
  // each diagonal stance carries the trunk down to the same low point (a sound, symmetric trot)
  const lows = [[], []];
  let lo = Infinity, diag = -1;
  for (const f of frames) {
    const d = f.legs[0].stance ? 0 : f.legs[1].stance ? 1 : -1;
    if (d !== diag && diag >= 0 && lo < Infinity) lows[diag].push(lo), (lo = Infinity);
    if (d >= 0) lo = Math.min(lo, f.bodyY);
    diag = d;
  }
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  assert.ok(lows[0].length >= 3 && lows[1].length >= 3);
  assert.ok(Math.abs(mean(lows[0]) - mean(lows[1])) < 0.004, `diagonal lows ${mean(lows[0]).toFixed(4)} vs ${mean(lows[1]).toFixed(4)}`);
  const ys = frames.map((f) => f.bodyY);
  const travel = Math.max(...ys) - Math.min(...ys);
  assert.ok(travel > 0.035 && travel < 0.085, `the trunk travels ${(travel * 1000).toFixed(0)} mm up and down`);
});

test('a steady trot, at the game\'s 60 Hz too: every limb reaches its target and no bone jumps between frames', () => {
  for (const dt of [1 / 240, 1 / 60]) {
    const { frames, horse } = trot(4.0, { dt });
    const unreached = frames.filter((f) => f.legs.some((L) => !L.reach)).length;
    assert.ok(unreached <= 0.01 * frames.length, `${unreached} of ${frames.length} frames with a limb out of reach (dt ${dt.toFixed(4)})`);
    // the largest turn of a leg or trunk bone relative to its parent between two 60 Hz frames
    const every = Math.round(1 / 60 / dt);
    const bones = horse.rig.list;
    let worst = 0, which = '';
    for (let i = every; i < frames.length; i += every)
      for (let b = 0; b < bones.length; b++) {
        if (/^(Ear|Tail)/.test(bones[b].name)) continue;
        const ang = frames[i].quats[b].angleTo(frames[i - every].quats[b]);
        if (ang > worst) (worst = ang), (which = bones[b].name);
      }
    assert.ok(worst < (18 * Math.PI) / 180, `${which} turns ${((worst * 180) / Math.PI).toFixed(1)}° in one frame`);
  }
});

// The hoof capsule as a solid (mesh.js HOOF_RINGS: elliptic rings lofted from the coronet to the sole, in the hoof
// bone's frame): the signed distance of a point to it, negative inside, and points spread over its surface.
function hoofDistance(p) {
  const R = HOOF_RINGS, top = R[0][0], bottom = R[R.length - 1][0];
  const y = Math.min(top, Math.max(bottom, p.y));
  let i = 0;
  while (i < R.length - 2 && y < R[i + 1][0]) i++;
  const a = R[i], b = R[i + 1], k = (a[0] - y) / (a[0] - b[0]);
  const rx = a[1] + (b[1] - a[1]) * k, rz = a[2] + (b[2] - a[2]) * k, dz = a[3] + (b[3] - a[3]) * k;
  const px = p.x, pz = p.z - dz, r = Math.hypot(px, pz), e = Math.hypot(px / rx, pz / rz);
  const side = e > 1e-9 ? r - r / e : -Math.min(rx, rz);
  const vert = Math.max(bottom - p.y, p.y - top);
  if (side <= 0 && vert <= 0) return Math.max(side, vert);
  return Math.hypot(Math.max(side, 0), Math.max(vert, 0));
}
const HOOF_SURFACE = [];
for (const [y, rx, rz, dz] of HOOF_RINGS)
  for (let k = 0; k < 24; k++) HOOF_SURFACE.push(new THREE.Vector3(rx * Math.cos((k / 24) * 2 * Math.PI), y, dz + rz * Math.sin((k / 24) * 2 * Math.PI)));
for (const f of [0, 0.4, 0.75])
  for (let k = 0; k < (f ? 10 : 1); k++) {
    const [y, rx, rz, dz] = HOOF_RINGS[HOOF_RINGS.length - 1];
    HOOF_SURFACE.push(new THREE.Vector3(rx * f * Math.cos((k / 10) * 2 * Math.PI), y, dz + rz * f * Math.sin((k / 10) * 2 * Math.PI)));
  }
// the gap between two hoof capsules (their bones' world matrices): negative when one is inside the other
const _hc = new THREE.Vector3(), _hm = new THREE.Matrix4();
function hoofGap(mA, mB) {
  let gap = Infinity;
  for (const [m, n] of [[mA, mB], [mB, mA]]) {
    _hm.copy(m).invert();
    for (const p of HOOF_SURFACE) gap = Math.min(gap, hoofDistance(_hc.copy(p).applyMatrix4(n).applyMatrix4(_hm)));
  }
  return gap;
}

test('a steady trot, at 240 and at 60 Hz: each hind hoof passes under the fore of its side, never into it (no forging)', () => {
  // with overtrack the hind lands ahead of the print its fore has just left: the fore must be up and folded by then and
  // the hind come in low beneath it (Muybridge 1887, plates 596 and 601); a hind toe striking the fore is forging
  for (const dt of [1 / 240, 1 / 60]) {
    const { frames } = trot(4.0, { dt });
    let worst = Infinity;
    for (const f of frames) for (const [fore, hind] of [[LF, LH], [RF, RH]]) worst = Math.min(worst, hoofGap(f.legs[fore].m, f.legs[hind].m));
    assert.ok(worst > 0.02, `the hooves of a side come within ${(worst * 1000).toFixed(1)} mm of each other (dt ${dt.toFixed(4)})`);
  }
});

test('a steady trot: the hind limb folds early in its swing, the fore hoof flies an early and a late arc, its toe clear', () => {
  const { frames } = trot(4.0, { secs: 2 });
  // hind: the hock (the cannon's turn from the tibia) folds most in the first half of the swing (Back et al. 1995b), the
  // hoof no higher than 13 cm; fore: an early peak in the first third, a lower path at mid-swing with the toe well off the
  // ground, a second smaller rise before the landing (Clayton 1990; Gottleib et al. 2025)
  let hock = -Infinity, hockAt = 0, hindTop = 0;
  const bins = new Array(10).fill(-Infinity), toeMid = [];
  for (const f of frames) {
    const H = f.legs[LH], F = f.legs[LF];
    if (!H.stance) {
      const a = f.angles[LH], flex = a[2] - a[1];
      if (flex > hock) (hock = flex), (hockAt = H.s);
      hindTop = Math.max(hindTop, H.sole[1] - 1);
    }
    if (!F.stance) {
      const b = Math.min(9, Math.floor(F.s * 10));
      bins[b] = Math.max(bins[b], F.sole[1] - 1);
      if (F.s > 0.45 && F.s < 0.65) toeMid.push(F.toe[1] - 1);
    }
  }
  assert.ok(hockAt > 0.25 && hockAt < 0.55, `the hock folds most at ${hockAt.toFixed(2)} of the swing`);
  assert.ok(hindTop < 0.13, `the hind hoof rises ${(hindTop * 1000).toFixed(0)} mm`);
  const early = Math.max(...bins.slice(1, 4)), mid = Math.min(...bins.slice(5, 7)), late = Math.max(...bins.slice(7, 9));
  assert.ok(early < 0.15 && early > mid + 0.03 && late > mid + 0.005, `fore arc: early ${early.toFixed(3)}, mid ${mid.toFixed(3)}, late ${late.toFixed(3)} m`);
  assert.ok(Math.min(...toeMid) > 0.03, `the fore toe passes ${(Math.min(...toeMid) * 1000).toFixed(0)} mm off the ground mid-swing`);
});

test('a steady trot: the hind pushes off at about its standing length and angle, and its hock folds as the toe leaves', () => {
  for (const dt of [1 / 240, 1 / 60]) {
    const { frames, horse } = trot(4.0, { dt, secs: 3 });
    const L = horse.legs[LH], R = horse.rig.rest;
    // standing: hip → sole centre, and the hock's flexion (the cannon's turn from the tibia)
    const stand = Math.hypot(R.FemL.x - R.SoleHL.x, R.FemL.y - R.SoleHL.y, R.FemL.z - (R.HoofHL.z + 0.03));
    const hock0 = L.segs[2].rest - L.segs[1].rest;
    const hock = (f) => f.angles[LH][2] - f.angles[LH][1];
    let n = 0, longest = 0, worstLO = 0, slowest = 0, deepest = Infinity;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      if (!(a.legs[LH].stance && !b.legs[LH].stance)) continue;
      // at the push-off: a few per cent longer than it stands, the hock back at about its standing angle — not a limb
      // locked out straight (Hobbs & Clayton 2019; the tarsus ends its stance near its standing angle: Gnagey et al. 2006)
      const r = a.legs[LH].root, s = a.legs[LH].sole;
      longest = Math.max(longest, Math.hypot(r[0] - s[0], r[1] - s[1], r[2] - s[2]) / stand);
      worstLO = Math.max(worstLO, Math.abs(hock(a) - hock0));
      // then stifle and hock fold together at once (the reciprocal apparatus: Back et al. 1995b), the hock to well
      // past its standing angle in the first half of the swing
      let j = i, most = -Infinity;
      while (j < frames.length && hock(frames[j]) < hock(a) + (5 * Math.PI) / 180) j++;
      if (j >= frames.length) continue;
      slowest = Math.max(slowest, frames[j].t - a.t);
      for (let k = i; k < frames.length && !frames[k].legs[LH].stance; k++) most = Math.max(most, hock(frames[k]));
      deepest = Math.min(deepest, most - hock0);
      n++;
    }
    assert.ok(n >= 3, `${n} lift-offs seen`);
    assert.ok(longest < 1.06, `the hind pushes off ${((longest - 1) * 100).toFixed(1)} % longer than it stands (dt ${dt.toFixed(4)})`);
    assert.ok(worstLO < (6 * Math.PI) / 180, `the hock leaves ${((worstLO * 180) / Math.PI).toFixed(1)}° off its standing angle`);
    // (the toe left somewhere within the last stance frame: up to a frame more at 60 Hz)
    assert.ok(slowest < 0.035 + dt, `the hock takes ${(slowest * 1000).toFixed(0)} ms to start folding`);
    assert.ok(deepest > (35 * Math.PI) / 180, `the hock folds only ${((deepest * 180) / Math.PI).toFixed(1)}° past standing`);
  }
});

test('a steady trot, at 240 and at 60 Hz: each toe rises off the ground as it leaves it, not carried along it', () => {
  // the toe is the breakover's pivot: it leaves the ground at rest, the hoof rolling on over it as the digit flexes and
  // the limb picks it up, so it is up before it swings forward (a sound horse does not drag its toe: Clayton, Mechanics
  // of equine locomotion; Muybridge 1887, plate 596: a hind just off the ground shows its sole)
  for (const dt of [1 / 240, 1 / 60]) {
    const { frames } = trot(4.0, { dt, secs: 3 });
    // per fore / hind: the toe's travel along the run from its last frame on the ground until it is 1 cm and 2 cm up
    // (interpolated within the frame in which it gets there)
    const worst = [[0, 0], [0, 0]];
    let n = 0;
    for (let l = 0; l < 4; l++)
      for (let i = 1; i < frames.length; i++) {
        if (!(frames[i - 1].legs[l].stance && !frames[i].legs[l].stance)) continue;
        const z0 = frames[i - 1].legs[l].toe[2];
        for (const [q, up] of [[0, 0.01], [1, 0.02]]) {
          let j = i;
          while (j < frames.length && frames[j].legs[l].toe[1] - 1 < up) j++;
          if (j >= frames.length) continue;
          const a = frames[j - 1].legs[l].toe, b = frames[j].legs[l].toe, k = (up - (a[1] - 1)) / (b[1] - a[1]);
          worst[l < 2 ? 0 : 1][q] = Math.max(worst[l < 2 ? 0 : 1][q], a[2] + (b[2] - a[2]) * k - z0);
        }
        n++;
      }
    const mm = (v) => (v * 1000).toFixed(1);
    assert.ok(n >= 12, `${n} lift-offs seen`);
    assert.ok(worst[0][0] < 0.015 && worst[0][1] < 0.025, `a fore toe runs ${mm(worst[0][0])} / ${mm(worst[0][1])} mm along the ground before it is 1 / 2 cm up (dt ${dt.toFixed(4)})`);
    assert.ok(worst[1][0] < 0.015 && worst[1][1] < 0.035, `a hind toe runs ${mm(worst[1][0])} / ${mm(worst[1][1])} mm along the ground before it is 1 / 2 cm up (dt ${dt.toFixed(4)})`);
  }
});

test('a steady trot, at 240 and at 60 Hz: the fore\'s elbow hands the stance over to the swing without a snap', () => {
  // the elbow straightens gradually through the second half of the stance and flexes in the swing (Back et al. 1995a),
  // rather than snapping straight in the last instants before the toe leaves
  const elbow = (f, l) => (f.angles[l][2] - f.angles[l][1]) * (180 / Math.PI);
  for (const dt of [1 / 240, 1 / 60]) {
    const { frames } = trot(4.0, { dt, secs: 3 });
    let worst = 0, n = 0;
    for (const l of [LF, RF])
      for (let i = 1; i < frames.length; i++) {
        if (!(frames[i - 1].legs[l].stance && !frames[i].legs[l].stance)) continue;
        // how far it straightens over the last 20 ms on the ground
        const a = frames[i - 1];
        let j = i - 1;
        while (j > 0 && a.t - frames[j - 1].t <= 0.02 + 1e-9) j--;
        worst = Math.max(worst, elbow(frames[j], l) - elbow(a, l));
        n++;
      }
    assert.ok(n >= 6, `${n} fore lift-offs seen`);
    assert.ok(worst < 7.5, `the elbow straightens ${worst.toFixed(1)}° in the last 20 ms of a stance (dt ${dt.toFixed(4)})`);
  }
});

test('galloping, and trotting down a 15 % slope: no bone turns further between two 60 Hz frames than the trot lab allows', () => {
  // the trot lab's robustness ranges (docs/trot-lab.md): sampled at 60 Hz, at most 25° at the gallop and 20°
  // trotting downhill. A gallop's stance lasts some 75 ms, a few frames: the limbs must not land or leave at full
  // stretch, where the joints snap between frames as the limb comes into reach
  const worstStep = (frames, every) => {
    let worst = 0, which = '';
    for (let i = every; i < frames.length; i += every)
      frames[i].quats.forEach((q, b) => {
        const name = frames[0].names[b];
        if (/^(Ear|Tail)/.test(name)) return;
        const a = (q.angleTo(frames[i - every].quats[b]) * 180) / Math.PI;
        if (a > worst) (worst = a), (which = name);
      });
    return { worst, which };
  };
  const named = (run) => (run.frames.forEach((f) => (f.names = run.horse.rig.list.map((b) => b.name))), run.frames);
  const gallop = worstStep(named(trot(13.5, { settle: 4, secs: 4.5 })), 4);
  assert.ok(gallop.worst < 25, `galloping, ${gallop.which} turns ${gallop.worst.toFixed(1)}° in one frame`);
  const down = worstStep(named(trot(4.0, { settle: 4, secs: 6.5, ground: (x, z) => 60 - 0.15 * z })), 4);
  assert.ok(down.worst < 20, `trotting downhill, ${down.which} turns ${down.worst.toFixed(1)}° in one frame`);
  // and at the game's own 60 Hz step the gallop does not snap either
  const g60 = worstStep(named(trot(13.5, { dt: 1 / 60, settle: 4, secs: 4.5 })), 1);
  assert.ok(g60.worst < 30, `galloping at 60 Hz, ${g60.which} turns ${g60.worst.toFixed(1)}° in one frame`);
});

test('a steady trot: the trunk sways toward the loaded fore, the withers with it', () => {
  const { frames } = trot(4.0, { secs: 3 });
  // each diagonal's fore (58 % of the weight) pushes its end of the trunk back toward the midline harder than its
  // hind does the other end: the trunk is furthest toward the fore at mid-stance (Buchner et al. 2000), and the chest
  // rolls toward it too, so the withers sway with it rather than standing still
  const xs = frames.map((f) => f.withers[0]);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sway = Math.max(...xs) - Math.min(...xs);
  const at = (leg) => frames.filter((f) => f.legs[leg].stance && f.legs[leg].u > 0.35 && f.legs[leg].u < 0.65).map((f) => f.withers[0] - mean);
  const left = at(LF), right = at(RF);
  const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  assert.ok(sway > 0.015 && sway < 0.06, `the withers sway ${(sway * 1000).toFixed(0)} mm`);
  assert.ok(avg(left) > 0.004 && avg(right) < -0.004, `toward the loaded fore: ${(avg(left) * 1000).toFixed(1)} / ${(avg(right) * 1000).toFixed(1)} mm`);
});

test('trotting down a 15 % slope, no hoof goes into the ground as it leaves it', () => {
  // the coronet of a hoof rolled over its toe stands well ahead of where its sole was planted: a swing measured from
  // the plant instead of the ground under it would start a centimetre too low downhill
  const ground = (x, z) => 10 - 0.15 * z;
  const { frames } = trot(4.0, { ground, secs: 3 });
  let deepest = 0;
  for (const f of frames) for (const L of f.legs) deepest = Math.min(deepest, L.sole[1] - ground(L.sole[0], L.sole[2]), L.toe[1] - ground(L.toe[0], L.toe[2]));
  assert.ok(deepest > -0.004, `a hoof goes ${(-deepest * 1000).toFixed(1)} mm into the slope`);
});

test('a steady trot leaves the same hoofprints at 240 Hz and at the game\'s 60 Hz', () => {
  // events fall within a frame: a hoof planted on the frame after it met the ground would land up to a frame's travel
  // (67 mm at 4 m/s) too far forward of where it touched
  const prints = (dt) => {
    const { frames } = trot(4.0, { dt, secs: 3 });
    return [0, 1, 2, 3].map((l) => {
      const out = [];
      let was = true;
      for (const f of frames) {
        if (f.legs[l].stance && !was) out.push(f.legs[l].sole[2]);
        was = f.legs[l].stance;
      }
      return out;
    });
  };
  const a = prints(1 / 240), b = prints(1 / 60);
  let worst = 0, n = 0;
  for (let l = 0; l < 4; l++)
    for (const z of b[l]) {
      const d = Math.min(...a[l].map((y) => Math.abs(y - z)));
      if (d < 0.5) (worst = Math.max(worst, d)), n++;
    }
  assert.ok(n >= 16, `${n} prints compared`);
  assert.ok(worst < 0.01, `a 60 Hz print lies ${(worst * 1000).toFixed(1)} mm from its 240 Hz one`);
});

test('the other paces and a turn: the hooves come down and never into the ground', () => {
  for (const [speed, yaw] of [[1.8, 0], [4.0, 0.5], [8.5, 0], [13.5, 0]]) {
    const { frames } = trot(speed, { yaw, secs: 2 });
    assert.ok(frames.some((f) => f.legs.some((L) => L.stance)), `${speed} m/s: hooves come down`);
    let deepest = 0;
    for (const f of frames) for (const L of f.legs) deepest = Math.min(deepest, L.sole[1] - 1, L.toe[1] - 1);
    assert.ok(deepest > -0.004, `${speed} m/s: a hoof ${(-deepest * 1000).toFixed(1)} mm into the ground`);
  }
});

test('from a standstill up through the walk and the trot to a canter and back to a stop, at 60 Hz: no limb snaps, no hoof drags', () => {
  seeded(7, () => {
    const horse = new Horse(makeGame());
    horse.place(0, 0, 0);
    Object.assign(horse, { ridden: true, mode: 'ridden', graze: 0 });
    const bones = horse.rig.list, hoofs = horse.legs.map((L) => L.segs[L.segs.length - 1].bone);
    const toe = new THREE.Vector3();
    let prev = null, worst = 0, which = '', deepest = 0, t = 0;
    const drag = [0, 0, 0, 0];
    for (const [until, v] of [[2, 0], [6, 1.8], [10, 4], [14, 8.5], [19, 0]])
      while (t < until) {
        horse.want.speed = v;
        horse.want.yaw = 0;
        horse.update(1 / 60);
        t += 1 / 60;
        horse.root.updateMatrixWorld(true);
        const q = bones.map((b) => b.quaternion.clone());
        if (prev)
          for (let b = 0; b < bones.length; b++) {
            if (/^(Ear|Tail)/.test(bones[b].name)) continue;
            const a = q[b].angleTo(prev[b]);
            if (a > worst) (worst = a), (which = `${bones[b].name} at ${t.toFixed(2)} s`);
          }
        prev = q;
        horse.legs.forEach((L, l) => {
          toe.set(0, -0.072, 0.088).applyMatrix4(hoofs[l].matrixWorld);
          deepest = Math.min(deepest, toe.y - 1);
          // a hoof in the air that runs along the ground: its toe within 2 mm of it through the middle of its swing
          if (!L.inStance && toe.y - 1 < 0.002 && L.s > 0.25 && L.s < 0.85) drag[l]++;
        });
      }
    // (what is left is the canter's short fore stance, where the fetlock's sinking, the roll over the toe and the limb's
    // sweep add up in the pastern; the shoulder does not snap as the limb reaches the edge of its reach)
    assert.ok(worst < (30 * Math.PI) / 180, `${which} turns ${((worst * 180) / Math.PI).toFixed(1)}° in one frame`);
    assert.ok(deepest > -0.003, `a toe goes ${(-deepest * 1000).toFixed(1)} mm into the ground`);
    assert.deepEqual(drag, [0, 0, 0, 0], 'no hoof drags its toe along the ground in the swing');
  });
});

test('stopped from a trot, the horse squares up: every hoof steps back under it', () => {
  seeded(5, () => {
    const horse = new Horse(makeGame());
    horse.place(0, 0, 0);
    Object.assign(horse, { ridden: true, mode: 'ridden', graze: 0, speed: 4 });
    horse.want.yaw = 0;
    for (let i = 0; i < 4 * 60; i++) (horse.want.speed = 4), horse.update(1 / 60);
    for (let i = 0; i < 8 * 60; i++) (horse.want.speed = 0), horse.update(1 / 60);
    const p = horse.position, s = Math.sin(horse.yaw), c = Math.cos(horse.yaw);
    for (const L of horse.legs) {
      assert.ok(L.inStance, 'down');
      const lx = (L.plant.x - p.x) * c - (L.plant.z - p.z) * s, lz = (L.plant.x - p.x) * s + (L.plant.z - p.z) * c;
      assert.ok(Math.hypot(lx - L.neutral.x, lz - L.neutral.y) <= 0.1 + 1e-9, 'under the body');
    }
  });
});
