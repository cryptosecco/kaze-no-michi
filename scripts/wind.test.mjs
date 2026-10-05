// Tests for the shared wind field's CPU mirror (run: npm test). The GPU chunk `kaze_wind` evaluates the same
// formula, so what holds here is what the grass, trees, leaves and cloth see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { wind, FRONT_SPEED, GUIDE_GAIN, GUIDE_RAMP_IN, GUIDE_RAMP_OUT, GUIDE_TURN_RATE } from '../src/world/Wind.js';
import { createNoise } from '../src/render/NoiseTexture.js';

wind.setNoise(createNoise(7)); // the game's noise (Game.js)
// re-anchors the wind clock (and with it every integrated part of the state, any guide in progress included)
const at = (t) => {
  wind.setTime(t);
  return wind.dir(new THREE.Vector2());
};
// gust along a line through (x0, z0) in the wind direction d, every `step` m over [-L, L]
const profile = (d, x0, z0, L, step) => {
  const out = [];
  for (let s = -L; s <= L; s += step) out.push(wind.gust(x0 + d.x * s, z0 + d.y * s));
  return out;
};
const median = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];

// ---- the guiding wind ------------------------------------------------------------------------------------------
const DT = 1 / 60;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const GOAL = [-260, 180]; // the first objective of the game, seen from the spawn
// the design values of the guide, written out: the exports must match them (see the test of the constants)
const RAMP_IN = 1.6, RAMP_OUT = 2.5, TURN_RATE = 0.6;
// 5 x 5 points 8 m apart around a place: the bend there, as the grass and the trees see it
const GRID = [];
for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) GRID.push([i * 8, j * 8]);
const snap = (x, z) => GRID.map(([ox, oz]) => wind.sample(x + ox, z + oz, new THREE.Vector2()));
const moved = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
const heading = () => {
  const d = wind.dir(new THREE.Vector2());
  return Math.atan2(d.y, d.x);
};
// the game's order within a step: the wind updates, then the origin follows the player
const advance = (x, z) => {
  wind.update(DT);
  wind.setOrigin(x, z);
};
const state = () => {
  const u = wind.uniforms;
  return {
    time: wind.time,
    uTime: u.uTime.value,
    uGuide: u.uGuide.value,
    uGuideSoft: u.uGuideSoft.value,
    uGuideDir: u.uGuideDir.value.toArray(),
    uGuidePhase: u.uGuidePhase.value.toArray(),
    uWindDir: u.uWindDir.value.toArray(),
    uWindFlow: u.uWindFlow.value.toArray(),
    uWaveDrift: u.uWaveDrift.value.toArray(),
  };
};

test('with no guide the CPU field is the ambient one it always was (recorded from the single-field code)', () => {
  // [clock, x, z, bend x, bend z, gust] from the single-field implementation, full precision
  const REF = [
    [2, 0, 0, 0.2012008022524277, 0.143563370427445, 0.24716837207763517],
    [2, 12, -7, 0.25523209691828985, 0.1821164710311778, 0.3135439878520351],
    [2, 300, -40, 0.5175870854249521, 0.3693153587931453, 0.635838206809882],
    [2, -120, 85, 0.19536558069579957, 0.13939974849113976, 0.24],
    [33.3, 0, 0, 0.6768821333758652, 0.47756724572978826, 0.8283959781876048],
    [33.3, 12, -7, 0.3626485607459703, 0.25586297197647384, 0.4438241082227931],
    [90, 0, 0, 0.4312710190153974, 0.34196409805876027, 0.5503945277741419],
    [90, 12, -7, 0.22968848423450944, 0.18212495596170244, 0.29313188051455363],
    [90, 300, -40, 0.18820953711178337, 0.14923540364809426, 0.24019582752795976],
    [90, 40, -260, 0.3099845420845105, 0.2457934330669756, 0.395606911049584],
    [600, 0, 0, 0.24054173345019866, 0.12368056012074882, 0.27047588891250285],
    [600, 12, -7, 0.21642433818661114, 0.11127999697492962, 0.243357210466945],
    [600, 300, -40, 0.6524498647488077, 0.3354734480598826, 0.7336438239117973],
    [600, -120, 85, 0.2247050362925866, 0.11553772541667592, 0.2526683979640348],
  ];
  const DIR = {
    2: [0.8140232528991649, 0.5808322853797491],
    33.3: [0.8170997339421817, 0.5764963354537614],
    90: [0.7835670546353476, 0.6213072274568244],
    600: [0.889327822961744, 0.4572701863298383],
  };
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);
  for (const [t, x, z, sx, sz, g] of REF) {
    const d = at(t);
    near(d.x, DIR[t][0], `dir.x at ${t}`);
    near(d.y, DIR[t][1], `dir.y at ${t}`);
    const s = wind.sample(x, z);
    near(s.x, sx, `bend.x at ${t} (${x}, ${z})`);
    near(s.y, sz, `bend.z at ${t} (${x}, ${z})`);
    near(wind.gust(x, z), g, `gust at ${t} (${x}, ${z})`);
  }
});

test('gust fronts travel downwind at 6–10 m/s', () => {
  const speeds = [];
  for (const [t, x0, z0] of [[14, 150, 90], [21, 40, -20], [60, -80, 30], [230, 0, 0]]) {
    const d = at(t);
    const A = profile(d, x0, z0, 200, 0.25);
    at(t + 0.5);
    const B = profile(d, x0, z0, 200, 0.25);
    // the downwind shift (m) that best lines B up with A
    let best = 0, bestErr = Infinity;
    for (let k = 0; k <= 48; k++) {
      let e = 0;
      for (let i = 48; i < A.length; i++) e += (B[i] - A[i - k]) ** 2;
      if (e < bestErr) (bestErr = e), (best = k * 0.25);
    }
    speeds.push(best / 0.5);
  }
  for (const v of speeds) assert.ok(v >= 6 && v <= 10, `front speed ${v} m/s (${speeds.join(', ')})`);
});

test('fronts are bands 15–30 m deep with calm air between them', () => {
  const widths = [];
  let calm = 0, n = 0;
  for (const [t, x0, z0] of [[14, 150, 90], [21, 40, -20], [95, -120, 60]]) {
    const d = at(t);
    // several parallel lines across the field, 40 m apart
    for (let j = -2; j <= 2; j++) {
      const g = profile(d, x0 - d.y * 40 * j, z0 + d.x * 40 * j, 600, 0.5);
      let run = 0;
      for (const v of g) {
        n++;
        if (v < 0.3) calm++;
        if (v > 0.5) run += 0.5;
        else if (run > 0) (widths.push(run), (run = 0));
      }
    }
  }
  const w = median(widths);
  assert.ok(w >= 15 && w <= 30, `median band depth ${w} m (n ${widths.length})`);
  assert.ok(calm / n >= 0.35, `calm share ${(calm / n).toFixed(2)}`);
});

test('a steady breeze in the lulls, strong fronts (non-uniform field)', () => {
  at(40);
  const v = [];
  for (let x = -200; x < 200; x += 2.5) for (let z = -200; z < 200; z += 2.5) v.push(wind.gust(x, z));
  v.sort((a, b) => a - b);
  const q = (p) => v[Math.floor(p * (v.length - 1))];
  // (a field without the gust fronts: p10 0.24, p95 0.75, contrast 3.2)
  assert.ok(q(0.1) < 0.3, `p10 ${q(0.1).toFixed(2)}`);
  assert.ok(q(0.95) > 0.85, `p95 ${q(0.95).toFixed(2)}`);
  assert.ok(q(0.95) / q(0.1) > 3.5, `contrast ${(q(0.95) / q(0.1)).toFixed(1)}`);
});

test('sample() is the gust along the wind direction, and repeats exactly for the same clock', () => {
  const d = at(33.3);
  const s = wind.sample(12, -7);
  const g = wind.gust(12, -7);
  assert.ok(Math.abs(s.x - d.x * g) < 1e-12 && Math.abs(s.y - d.y * g) < 1e-12);
  at(50);
  at(33.3);
  const s2 = wind.sample(12, -7);
  assert.equal(s2.x, s.x);
  assert.equal(s2.y, s.y);
});

test("the trees' gust peak is the ambient field's real maximum; its weakest gust stays over their floor", () => {
  // trees/materials.js leaves a crown's sway alone up to kazeGustPeak() (this mirror: wind.gustPeak()) and softly caps
  // what is beyond: the peak must bound the ambient gust, and the core of a front must reach it. The same shader fades
  // a crown's direction out below a gust of 0.15, so the ambient wind (a 0.24 breeze in a lull) must never go there.
  // The game's strength and gust amplitude, and another pair (the peak follows both)
  const u = wind.uniforms;
  const saved = [u.uWindStrength.value, u.uGust.value];
  try {
    for (const [strength, amplitude] of [saved, [0.5, 0.6]]) {
      u.uWindStrength.value = strength;
      u.uGust.value = amplitude;
      const peak = wind.gustPeak();
      let max = 0, min = Infinity, atPeak = 0, n = 0;
      for (const t of [2, 90, 600]) {
        at(t);
        for (let x = -300; x <= 300; x += 1.5) {
          for (let z = -300; z <= 300; z += 1.5) {
            const g = wind.gust(x, z);
            max = Math.max(max, g);
            min = Math.min(min, g);
            if (g > peak - 1e-9) atPeak++;
            n++;
          }
        }
      }
      const what = `(strength ${strength}, gust ${amplitude})`;
      assert.ok(max <= peak + 1e-9, `the ambient gust reaches ${max}, over the peak ${peak} ${what}`);
      assert.ok(atPeak >= 500, `${atPeak} of ${n} samples at the peak ${peak}, the largest ${max}: unreached ${what}`);
      if (strength === saved[0]) assert.ok(min > 0.15, `the weakest ambient gust is ${min}, under a crown's floor`);
    }
  } finally {
    [u.uWindStrength.value, u.uGust.value] = saved;
  }
});

test('the guide keeps its design values; the shader chunk takes its constants from the CPU exports', () => {
  assert.equal(GUIDE_RAMP_IN, RAMP_IN);
  assert.equal(GUIDE_RAMP_OUT, RAMP_OUT);
  assert.equal(GUIDE_TURN_RATE, TURN_RATE);
  const glsl = THREE.ShaderChunk.kaze_wind;
  assert.ok(glsl.includes(`#define KZ_FRONT_SPEED ${FRONT_SPEED.toFixed(2)}`));
  assert.ok(glsl.includes(`#define KZ_GUIDE_GAIN ${GUIDE_GAIN.toFixed(2)}`));
});

test('a guide fades in and out without strobing: the bend moves little between two steps, anywhere, any clock', () => {
  // a single-field implementation would move the bend by up to 1.39 between two 1/60 s steps (fronts re-timed by
  // uTime x speed, the pattern swept round the world origin); the guided gust itself is 1.85x the ambient one,
  // whose own largest step on these points is 0.03
  for (const t0 of [2, 90, 600]) {
    for (const [px, pz] of [[0, 0], [300, -40]]) {
      at(t0);
      wind.setOrigin(px, pz);
      wind.guideTo(GOAL[0], GOAL[1], 9);
      let prev = snap(px, pz), worst = 0, top = 0;
      for (let f = 0; f < 60 * 14; f++) {
        advance(px, pz);
        const cur = snap(px, pz);
        worst = Math.max(worst, moved(prev, cur));
        top = Math.max(top, wind.uniforms.uGuide.value);
        prev = cur;
      }
      assert.ok(worst < 0.2, `largest bend step ${worst.toFixed(3)} (clock ${t0}, at ${px}, ${pz})`);
      assert.equal(top, 1, 'the guide reaches its full strength');
      assert.equal(wind.uniforms.uGuide.value, 0, 'and ends');
    }
  }
});

test('the guide fades in over 1.6 s and out over 2.5 s, and holds in between', () => {
  at(90);
  wind.setOrigin(0, 0);
  wind.guideTo(GOAL[0], GOAL[1], 9);
  const level = [];
  for (let f = 0; f < 60 * 10; f++) {
    advance(0, 0);
    level.push(wind.uniforms.uGuide.value);
  }
  const up = level.findIndex((v) => v >= 1);
  const down = level.findIndex((v, i) => i > up && v < 1);
  const end = level.findIndex((v, i) => i > up && v === 0);
  assert.ok(Math.abs((up + 1) / 60 - RAMP_IN) <= 1 / 60, `full strength after ${(up + 1) / 60} s`);
  assert.ok(Math.abs(down / 60 - (9 - RAMP_OUT)) <= 2 / 60, `ramp-out starts at ${down / 60} s`);
  assert.ok(Math.abs((end + 1) / 60 - 9) <= 2 / 60, `over after ${(end + 1) / 60} s`);
  for (let i = 1; i < up; i++) assert.ok(level[i] > level[i - 1], 'rising all the way in');
  for (let i = down + 1; i < end; i++) assert.ok(level[i] < level[i - 1], 'falling all the way out');
});

test('the air turns at a bounded rate toward any objective, upwind included, and dir() stays a unit vector', () => {
  // the heading follows the envelope: a half turn in the 1.6 s of the ramp-in peaks at 1.5 pi / 1.6 = 2.95 rad/s (a
  // single-field implementation would peak at 4.4 rad/s and jump ~90 degrees in one step for an objective upwind)
  const maxStep = 0.057; // rad per 1/60 s step (3.3 degrees, 3.4 rad/s)
  for (const rel of [0, 90, 135, 179, 180, -179, -135, -90]) {
    const a0 = at(90).angle();
    const goal = [Math.cos(a0 + (rel * Math.PI) / 180) * 300, Math.sin(a0 + (rel * Math.PI) / 180) * 300];
    wind.setOrigin(0, 0);
    wind.guideTo(goal[0], goal[1], 9);
    let prev = heading(), worst = 0, unit = 0, plateau = null;
    for (let f = 0; f < 60 * 14; f++) {
      advance(0, 0);
      const d = wind.dir(new THREE.Vector2());
      unit = Math.max(unit, Math.abs(d.length() - 1));
      const h = Math.atan2(d.y, d.x);
      worst = Math.max(worst, Math.abs(wrap(h - prev)));
      prev = h;
      if (f === 60 * 4) plateau = h;
    }
    assert.ok(worst < maxStep, `largest turn ${worst.toFixed(4)} rad in one step (objective ${rel} deg off the wind)`);
    assert.ok(unit < 1e-12, `dir() off unit length by ${unit}`);
    // and it does end up looking at the objective, whichever way round it went
    const aim = a0 + (rel * Math.PI) / 180;
    assert.ok(Math.abs(wrap(plateau - aim)) < 0.05, `heading on the plateau ${plateau} vs ${aim}`);
  }
});

test('the air does not flip round when the wind veers across an objective that is almost exactly upwind', () => {
  // at clock 145 the ambient heading is turning at -0.007 rad/s: the objective, 0.006 rad short of straight upwind, is
  // crossed by the veering ~0.8 s into the ramp-in. The shortest arc from the ambient to the guided heading changes
  // side there; the air keeps going round the way it started (a flip at level 0.5 would swing it by ~180 degrees)
  const a0 = at(145).angle();
  const aim = a0 + Math.PI - 0.006;
  wind.setOrigin(0, 0);
  wind.guideTo(Math.cos(aim) * 300, Math.sin(aim) * 300, 9);
  let prev = heading(), worst = 0;
  for (let f = 0; f < 60 * 12; f++) {
    advance(0, 0);
    const h = heading();
    worst = Math.max(worst, Math.abs(wrap(h - prev)));
    prev = h;
  }
  assert.ok(worst < 0.057, `largest turn ${worst.toFixed(4)} rad in one step`);
});

test('the guided heading follows a moving objective at a limited rate, and the pattern pivots about the player', () => {
  at(90);
  wind.setOrigin(0, 0);
  wind.guideTo(300, 0, 30); // due east
  for (let f = 0; f < 60 * 3; f++) advance(0, 0);
  // the player is moved 90 degrees round the objective in one step: the bearing of the objective jumps from 0 to 90 deg
  const P = [300, -150];
  wind.setOrigin(P[0], P[1]);
  const around = () => wind.uniforms.uGuideDir.value.angle();
  let prevAng = around(), worstTurn = 0, worstAt = 0, prev = snap(P[0], P[1]);
  for (let f = 0; f < 60 * 4; f++) {
    advance(P[0], P[1]);
    const ang = around();
    worstTurn = Math.max(worstTurn, Math.abs(wrap(ang - prevAng)));
    prevAng = ang;
    const cur = snap(P[0], P[1]);
    worstAt = Math.max(worstAt, moved(prev, cur));
    prev = cur;
  }
  const limit = TURN_RATE * DT + 1e-9;
  assert.ok(worstTurn <= limit, `guided heading turned ${worstTurn} rad in one step (limit ${limit})`);
  assert.ok(Math.abs(wrap(prevAng - Math.PI / 2)) < 1e-6, 'and got there');
  // the field around the player keeps its place while the pattern pivots (a world-origin pivot would sweep it by metres)
  assert.ok(worstAt < 0.2, `bend around the player moved ${worstAt.toFixed(3)} in one step while turning`);
  // an objective closer than 2 m is not aimed at: the heading stays
  wind.setOrigin(300, 0.5);
  const keep = around();
  for (let f = 0; f < 30; f++) advance(300, 0.5);
  assert.equal(around(), keep);
});

test('a second guideTo during a guide never lowers the level, re-aims without a jump and extends it', () => {
  for (const press of [0.8, 3, 7.6]) {
    at(90);
    wind.setOrigin(0, 0);
    wind.guideTo(GOAL[0], GOAL[1], 9);
    let f = 0;
    for (; f < Math.round(press * 60); f++) advance(0, 0);
    const before = wind.uniforms.uGuide.value;
    const dirBefore = wind.uniforms.uGuideDir.value.clone();
    wind.guideTo(GOAL[0] + 40, GOAL[1] - 40, 9); // a slightly different objective
    assert.equal(wind.uniforms.uGuide.value, before, 'the call itself changes nothing');
    // nor the heading: it turns toward the new objective at the usual rate
    assert.deepEqual(wind.uniforms.uGuideDir.value.toArray(), dirBefore.toArray());
    let prev = before, drop = 0, full = false, ang = wind.uniforms.uGuideDir.value.angle(), turn = 0;
    for (let k = 0; k < 60 * 14; k++, f++) {
      advance(0, 0);
      const l = wind.uniforms.uGuide.value;
      const a = wind.uniforms.uGuideDir.value.angle();
      turn = Math.max(turn, Math.abs(wrap(a - ang)));
      ang = a;
      // from the call on the level climbs back to 1 and then holds until the extended guide ramps out
      if (!full) drop = Math.min(drop, l - prev);
      if (l >= 1) full = true;
      prev = l;
      // the guide the second press asked for: 9 s from the press, the last 2.5 s of them the ramp-out
      const held = 9 - RAMP_OUT - 0.1;
      if (k === Math.round(held * 60)) assert.equal(l, 1, `plateau holding ${held} s after the press at ${press} s`);
    }
    assert.ok(drop >= -1e-12, `the level dropped by ${-drop} on the way back to 1 (press at ${press} s)`);
    assert.ok(full);
    assert.ok(turn <= TURN_RATE * DT + 1e-9, `re-aimed by ${turn} rad in one step`);
    assert.equal(wind.uniforms.uGuide.value, 0, 'and ends');
  }
  // a press that asks for less than the ramp-out lets the level fall smoothly from where it is, never in a step
  for (const press of [1.2, 4, 7]) {
    at(90);
    wind.setOrigin(0, 0);
    wind.guideTo(GOAL[0], GOAL[1], 9);
    for (let f = 0; f < Math.round(press * 60); f++) advance(0, 0);
    const before = wind.uniforms.uGuide.value;
    wind.guideTo(GOAL[0], GOAL[1], 0.5);
    advance(0, 0);
    const after = wind.uniforms.uGuide.value;
    assert.ok(after > before - 1e-3, `a short press at ${press} s: ${before} to ${after}`);
  }
  // a press with the previous guide long over starts a new one from nothing
  at(90);
  wind.setOrigin(0, 0);
  wind.guideTo(GOAL[0], GOAL[1], 3);
  for (let f = 0; f < 60 * 4; f++) advance(0, 0);
  assert.equal(wind.uniforms.uGuide.value, 0);
  wind.guideTo(100, 100, 3);
  advance(0, 0);
  assert.ok(wind.uniforms.uGuide.value < 0.01);
});

test('during a guide the bend is the two fields cross-faded, and gust() is its length', () => {
  at(90);
  wind.setOrigin(0, 0);
  wind.guideTo(GOAL[0], GOAL[1], 9);
  const heading0 = Math.atan2(GOAL[1], GOAL[0]);
  for (let f = 0; f < 60 * 8; f++) {
    advance(0, 0);
    const k = wind.uniforms.uGuide.value;
    if (f % 20 !== 0) continue;
    for (const [x, z] of [[0, 0], [37, -15], [-120, 60]]) {
      const s = wind.sample(x, z, new THREE.Vector2());
      assert.ok(Math.abs(Math.hypot(s.x, s.y) - wind.gust(x, z)) < 1e-12, `gust is |bend| at level ${k.toFixed(3)}`);
      // on the plateau the bend lies along the guided heading
      if (k === 1) assert.ok(Math.abs(s.x * Math.sin(heading0) - s.y * Math.cos(heading0)) < 1e-9);
    }
  }
});

test('setting the clock re-anchors every integrated part of the state, whatever ran before', () => {
  const scenario = (before) => {
    before();
    wind.setOrigin(0, 0);
    wind.time = 123.5; // the setter and setTime() are the same entry point
    for (let f = 0; f < 30; f++) advance(0, 0);
    return state();
  };
  const A = scenario(() => {
    at(500);
    wind.setOrigin(5, 5);
    wind.guideTo(GOAL[0], GOAL[1], 9);
    for (let f = 0; f < 200; f++) advance(5, 5);
  });
  const B = scenario(() => {
    at(7);
    for (let f = 0; f < 1000; f++) advance(0, 0); // no guide, a long run: the sea drifted, the clock moved on
  });
  const C = scenario(() => {
    at(90);
    wind.guideTo(100, 100, 3);
    for (let f = 0; f < 20; f++) advance(0, 0);
  });
  assert.deepEqual(A, B);
  assert.deepEqual(B, C);
  assert.equal(A.uGuide, 0);
  assert.equal(A.uGuideSoft, 0);
});

test('a guide ends and leaves the ambient field exactly as it was', () => {
  at(90);
  wind.setOrigin(0, 0);
  wind.guideTo(GOAL[0], GOAL[1], 9);
  for (let f = 0; f < 60 * (9 + 8); f++) advance(0, 0);
  const u = wind.uniforms;
  assert.equal(u.uGuide.value, 0);
  assert.equal(u.uGuideSoft.value, 0, 'the slow envelope has settled');
  assert.deepEqual(u.uWindFlow.value.toArray(), u.uWindDir.value.toArray(), 'the air blows as the ambient wind does');
  const pts = [[0, 0], [12, -7], [300, -40], [-120, 85], [40, -260]];
  const after = pts.map(([x, z]) => [wind.sample(x, z).toArray(), wind.gust(x, z)]);
  const d = wind.dir(new THREE.Vector2()).toArray();
  // the same clock, never guided
  at(wind.time);
  assert.deepEqual(
    pts.map(([x, z]) => [wind.sample(x, z).toArray(), wind.gust(x, z)]),
    after
  );
  assert.deepEqual(wind.dir(new THREE.Vector2()).toArray(), d);
});

test('random presses, a walking player and objectives near and far keep the state sound', () => {
  // half an hour at 60 steps/s: presses of 1-13 s (some during a guide), objectives from inside 2 m to 2 km away
  let seed = 99;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const u = wind.uniforms;
  at(0);
  let x = 0, z = 0, vx = 0, vz = 0, presses = 0, held = 0;
  const v = new THREE.Vector2();
  for (let f = 0; f < 60 * 1800; f++) {
    if (f % 600 === 0) {
      vx = (rnd() - 0.5) * 12;
      vz = (rnd() - 0.5) * 12;
    }
    if (rnd() < 1 / 400) {
      const r = [1, 30, 300, 1500][Math.floor(rnd() * 4)] * (0.5 + rnd());
      const a = rnd() * Math.PI * 2;
      const before = u.uGuide.value;
      wind.guideTo(x + Math.cos(a) * r, z + Math.sin(a) * r, 1 + rnd() * 12);
      advance(x, z);
      presses++;
      if (before > 0) {
        held++;
        assert.ok(u.uGuide.value > before - 1e-3, `a press stepped the level down: ${before} to ${u.uGuide.value}`);
      }
    } else advance(x, z);
    x += vx * DT;
    z += vz * DT;
    wind.setOrigin(x, z);
    assert.ok(u.uGuide.value >= 0 && u.uGuide.value <= 1, `level ${u.uGuide.value}`);
    if (f % 7) continue;
    const all = [u.uGuideSoft.value, ...u.uGuideDir.value.toArray(), ...u.uGuidePhase.value.toArray()];
    all.push(...u.uWindFlow.value.toArray(), ...u.uWaveDrift.value.toArray());
    for (const n of all) assert.ok(Number.isFinite(n));
    assert.ok(Math.abs(wind.dir(v).length() - 1) < 1e-12);
    const s = wind.sample(x + 5, z - 3, v);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
    assert.ok(wind.gust(x + 5, z - 3) < 2.3);
  }
  assert.ok(presses > 50 && held > 20, `${presses} presses, ${held} of them during a guide`);
});
