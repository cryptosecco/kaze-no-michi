// Tests for the trot lab (scripts/trotlab/): the metric primitives on synthetic data with known answers, the joint-angle
// sign conventions, and a calibration of the geometric probe on the real horse standing square. Nothing here pins how the
// horse trots: the lab is the instrument, the trot is what it measures (run: npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contactIntervals, stridesFrom, dutyFactors, contactFraction, coverage, suspension, pairLags, horizontalTravel, peakToPeak,
  meanSecondDerivative, argminParabolic, signedAngle, jointAngle, FLEX_SIGN, segmentAngle, legAngles, plantedWindow,
  solePitch, pitchOf, rollOf, inRange, evaluate, robust, analyze, standAngles,
} from './trotlab/metrics.mjs';
import { xform, relQuat, quatAngle, CONTACT_M } from './trotlab/markers.mjs';
import { simulate, scenarios } from './trotlab/sim.mjs';
import { buildHorseRig } from '../src/actors/horse/rig.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const R = [-1, 0, 0]; // the horse's right axis when it faces +z with its left on +x

test('contact intervals: touchdown and lift-off are interpolated where the height crosses the threshold', () => {
  // a V-shaped hoof height |t − 0.5| · 0.2 m sampled off-grid: within 4 mm for |t − 0.5| <= 0.02 s
  const t = [], h = [];
  for (let i = 0; i < 150; i++) (t.push(i * 0.007), h.push(Math.abs(i * 0.007 - 0.5) * 0.2));
  const iv = contactIntervals(t, h, 0.004);
  assert.equal(iv.length, 1);
  near(iv[0].td, 0.48, 1e-9, 'td');
  near(iv[0].lo, 0.52, 1e-9, 'lo');
  assert.ok(!iv[0].openStart && !iv[0].openEnd);
  // contact at the first / last sample is open (no real touchdown / lift-off seen)
  const iv2 = contactIntervals([0, 1, 2, 3], [0, 0.01, 0.01, 0], 0.004);
  assert.equal(iv2.length, 2);
  assert.ok(iv2[0].openStart && iv2[1].openEnd);
});

test('a known trot pattern: duty factor, suspension and diagonal dissociation come out exactly', () => {
  // stride 0.7 s, every hoof down 40 % of it; RH lands 20 ms before LF (hind first: + dissociation), LH 20 ms before RF;
  // the hinds lift off 20 ms before their fores too
  const T = 0.7, d = 0.4 * T, n = 8;
  const off = { LF: 0, RH: -0.02, RF: 0.35, LH: 0.33 };
  const iv = Object.fromEntries(Object.entries(off).map(([k, o]) => [k, Array.from({ length: n }, (_, s) => ({ td: o + s * T, lo: o + s * T + d }))]));
  const strides = stridesFrom(iv.LF.map((c) => c.td));
  assert.equal(strides.length, n - 1);
  near(strides[0].T, T, 1e-12);
  for (const k of Object.keys(off)) near(contactFraction(iv[k], strides[0].t0, strides.at(-1).t1), 0.4, 1e-9, `duty ${k}`);
  for (const v of dutyFactors(iv.LF, strides)) near(v, 0.4, 1e-9);
  // the two diagonals each cover [start, start + 0.30 s]: two 50 ms gaps per stride
  const s = suspension(Object.values(iv).flat(), strides);
  near(s.frac, 0.1 / T, 1e-9, 'suspension fraction');
  near(s.count, 2, 1e-9, 'suspensions per stride');
  const dap = pairLags(iv.LF.map((c) => c.td), iv.RH.map((c) => c.td), T / 4);
  assert.equal(dap.length, n);
  for (const v of dap) near(v, 0.02, 1e-9, 'LF − RH touchdown (+ = hind first)');
  for (const v of pairLags(iv.RF.map((c) => c.lo), iv.LH.map((c) => c.lo), T / 4)) near(v, 0.02, 1e-9, 'RF − LH lift-off');
  // coverage merges overlaps and returns the gaps
  const c = coverage([[0, 1], [0.5, 2], [3, 4]], 0, 5);
  assert.deepEqual(c.covered, [[0, 2], [3, 4]]);
  assert.deepEqual(c.gaps, [[2, 3], [4, 5]]);
});

test('a parabola under gravity has a mean vertical acceleration of −9.81 m/s²; a parabola fit finds its minimum', () => {
  const dt = 1 / 240, y = [], t = [];
  for (let i = 0; i < 100; i++) (t.push(i * dt), y.push(1.1 + 0.8 * i * dt - 0.5 * 9.81 * (i * dt) ** 2));
  const a = meanSecondDerivative(y, dt, y.map(() => true));
  near(a.mean, -9.81, 1e-6, 'flight acceleration');
  assert.equal(a.n, 98);
  // only the masked samples count
  const half = meanSecondDerivative(y.map((v, i) => (i < 50 ? v : 0)), dt, y.map((_, i) => i > 2 && i < 40));
  near(half.mean, -9.81, 1e-6);
  // minimum of a sampled parabola between two samples
  const yy = t.map((x) => (x - 0.2013) ** 2 + 0.5);
  const m = argminParabolic(t, yy, 0, t.length - 1);
  near(m.t, 0.2013, 1e-9, 'time of the minimum');
  near(m.y, 0.5, 1e-9);
  near(peakToPeak([3, -1, 2]), 4, 0);
});

test('slip: a planted hoof has none, a sliding one has its own travel; the planted window ends where the heel lifts', () => {
  assert.equal(horizontalTravel([[1, 0, 2], [1, 0.3, 2], [1, -0.1, 2]]), 0, 'vertical motion is not slip');
  near(horizontalTravel([[0, 0, 0], [0.003, 0, 0.004], [0.001, 0, 0]]), 0.005, 1e-12);
  // a contact of 61 samples (0..0.25 s): flat until 0.2 s, then the heel rises while the toe stays down
  const dt = 1 / 240, t = [], toeH = [], heelH = [];
  for (let i = 0; i <= 60; i++) (t.push(i * dt), toeH.push(0), heelH.push(i * dt <= 0.2 ? 0 : (i * dt - 0.2) * 0.5));
  const c = { i0: 0, i1: 60, td: 0, lo: 0.25 };
  const w = plantedWindow(t, toeH, heelH, c, CONTACT_M);
  assert.equal(w.flat, true);
  near(w.start, 0.025, dt, 'starts at 10 % of the contact');
  near(w.bo, 0.2 + CONTACT_M / 0.5, dt, 'breakover: the heel above the threshold');
  // a toe that never sits flat is a scrape, not a plant
  assert.equal(plantedWindow(t, toeH, heelH.map(() => 0.02), c, CONTACT_M).flat, false);
  // through robust(): a synthetic run with one hoof planted, then the same hoof sliding at 0.2 m/s
  const run = (slide) => {
    const samples = [];
    for (let i = 0; i < 240; i++) {
      const tt = i * dt, down = tt >= 0.2 && tt <= 0.6;
      const legs = [0, 1, 2, 3].map((l) => {
        const sole = l === 0 && down ? [0.14, 0, 1 + slide * (tt - 0.2)] : [0.14 * (l % 2 ? -1 : 1), 0.2, l < 2 ? 1 : 0];
        const h = l === 0 && down ? 0 : 0.2;
        return { sole, low: sole, toe: sole, heel: sole, lowH: h, soleH: h, toeH: h, heelH: h };
      });
      samples.push({ t: tt, geo: { legs } });
    }
    return { samples, frames60: [], contactM: CONTACT_M, dt };
  };
  const still = robust(run(0));
  assert.equal(still.slip_mm, 0, 'planted: no slip');
  assert.equal(still.plants, 1);
  assert.equal(still.penetration_mm, 0);
  const slid = robust(run(0.2));
  // the window runs from 10 % of the 0.4 s contact to its end: 0.36 s at 0.2 m/s
  near(slid.slip_mm, 0.2 * 0.36 * 1000, 0.2 * dt * 1000 + 1e-9, 'sliding hoof');
});

test('joint angles: 0 when straight, flexion positive for each joint, the standing fetlocks negative', () => {
  const down = [0, -1, 0];
  const at = (p, d, len) => [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len];
  const rot = (deg) => [0, -Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]; // down, turned forward by deg
  const a = [0, 1, 0], j = [0, 0.6, 0];
  near(jointAngle(a, j, at(j, down, 0.3), R, 1), 0, 1e-12, 'collinear');
  // the distal segment turned forward by 20°: + about the right axis
  near(signedAngle(down, rot(20), R) * (180 / Math.PI), 20, 1e-9);
  near(jointAngle(a, j, at(j, rot(20), 0.3), R, FLEX_SIGN.elbow), 20, 1e-9, 'elbow: forearm forward = flexion');
  near(jointAngle(a, j, at(j, rot(20), 0.3), R, FLEX_SIGN.hock), 20, 1e-9, 'hock: cannon forward = flexion');
  near(jointAngle(a, j, at(j, rot(-30), 0.3), R, FLEX_SIGN.carpus), 30, 1e-9, 'carpus: cannon back = flexion');
  near(jointAngle(a, j, at(j, rot(-30), 0.3), R, FLEX_SIGN.stifle), 30, 1e-9, 'stifle: tibia back = flexion');
  near(jointAngle(a, j, at(j, rot(-30), 0.3), R, FLEX_SIGN.fetlockF), 30, 1e-9, 'fetlock: pastern back = flexion');
  near(jointAngle(a, j, at(j, rot(35), 0.3), R, FLEX_SIGN.fetlockF), -35, 1e-9, 'fetlock: pastern forward = extension');
  near(segmentAngle([0, 1, 0], [0, 0, 0], { f: [0, 0, 1], u: [0, 1, 0] }), -90, 1e-9, 'straight down is −90°');
  // the rig's rest pose: the hock, stifle, elbow and shoulder are flexed, the fetlocks extended, the carpus nearly straight
  const rig = buildHorseRig();
  const p = (n) => [rig.rest[n].x, rig.rest[n].y, rig.rest[n].z];
  const ax = { f: [0, 0, 1], u: [0, 1, 0], l: [1, 0, 0] };
  const leg = (s, fore) =>
    fore
      ? { scapTop: p('Scap' + s), shoulder: p('Hum' + s), elbow: p('Fore' + s), carpus: p('CanF' + s), fetlock: p('PasF' + s), coronet: p('HoofF' + s) }
      : { hip: p('Fem' + s), stifle: p('Tib' + s), hock: p('CanH' + s), fetlock: p('PasH' + s), coronet: p('HoofH' + s) };
  const g = { chestAx: ax, pelvisAx: ax, legs: [leg('L', true), leg('R', true), leg('L', false), leg('R', false)] };
  for (const l of [0, 1]) {
    const A = legAngles(g, l);
    near(A.carpus, 4.5, 0.5, 'rest carpus');
    near(A.elbow, 39.5, 0.5, 'rest elbow');
    near(A.shoulder, 70.5, 0.5, 'rest shoulder');
    near(A.fetlock, -33.5, 0.5, 'rest fore fetlock (extended)');
    near(A.scap, -54.5, 0.5, 'scapula: down and forward');
  }
  for (const l of [2, 3]) {
    const A = legAngles(g, l);
    near(A.hock, 57.8, 0.5, 'rest hock');
    near(A.stifle, 84.0, 0.5, 'rest stifle');
    near(A.fetlock, -27.0, 0.5, 'rest hind fetlock (extended)');
  }
});

test('sole pitch, trunk pitch and roll, references', () => {
  near(solePitch([0, 0.02, 0.1], [0, 0, 0], 0.02, 0), Math.atan2(0.02, 0.1) * (180 / Math.PI), 1e-9, 'toe up = heel first = +');
  assert.ok(solePitch([0, 0, 0.1], [0, 0.02, 0], 0, 0.02) < 0, 'toe down = −');
  const a = 0.1;
  near(pitchOf({ f: [0, Math.sin(a), Math.cos(a)], u: [0, Math.cos(a), -Math.sin(a)], l: [1, 0, 0] }), (a * 180) / Math.PI, 1e-9, 'nose up = +');
  near(rollOf({ f: [0, 0, 1], u: [-Math.sin(a), Math.cos(a), 0], l: [Math.cos(a), Math.sin(a), 0] }), (a * 180) / Math.PI, 1e-9, 'left side up = +');
  assert.equal(inRange(5, { lo: 1, hi: 10 }), true);
  assert.equal(inRange(11, { lo: 1, hi: 10 }), false);
  assert.equal(inRange(-3, { hi: 0 }), true, 'one-sided');
  assert.equal(inRange(NaN, { lo: 0 }), null, 'not measurable');
  const rows = evaluate({ 'duty.fore': 0.3 }, { 'duty.fore': { lo: 0.35, hi: 0.45, unit: 'fraction' }, 'nope.key': { lo: 0 } });
  assert.equal(rows[0].pass, false);
  assert.equal(rows[1].pass, null);
});

test('matrix helpers: a point carried by a matrix, the rotation between two frames', () => {
  // translation (1, 2, 3) after a 90° turn about +Y (column-major, three.js layout)
  const e = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1];
  assert.deepEqual(xform(e, 1, 0, 0).map((v) => +v.toFixed(12)), [1, 2, 2]);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const q = relQuat(I, e);
  near(quatAngle([0, 0, 0, 1], q) * (180 / Math.PI), 90, 1e-9, 'relative rotation');
  near(quatAngle(relQuat(e, e), [0, 0, 0, 1]), 0, 1e-9);
});

test('calibration on the real horse: standing square, all four hooves flat on the ground and still', () => {
  const S = scenarios();
  const run = simulate('stand', S.stand, { dt: 1 / 240 });
  assert.ok(run.samples.length > 100);
  for (const s of run.samples)
    for (const L of s.geo.legs) {
      assert.ok(L.contact, 'every hoof in contact');
      assert.ok(Math.abs(L.lowH) < 0.0005 && Math.abs(L.toeH) < 0.0005 && Math.abs(L.heelH) < 0.0005, `flat on the ground (${L.lowH})`);
    }
  // and still: within half a millimetre (the breathing lifts the body a few mm and re-tilts the leg planes a hair)
  for (let l = 0; l < 4; l++) assert.ok(horizontalTravel(run.samples.map((s) => s.geo.legs[l].sole)) < 5e-4, 'and still');
  // the hoof capsule read from the mesh: a ground ring at y = 0, the toe ~11 cm ahead of the heel, the sole centre between
  for (const h of run.hoof) {
    assert.ok(Math.abs(h.sole[1]) < 1e-6 && h.count > 40);
    near(h.toe[2] - h.heel[2], 0.113, 0.01, 'hoof length');
    near((h.toe[2] + h.heel[2]) / 2, h.sole[2], 1e-9);
  }
  const st = standAngles(run);
  for (const l of [0, 1]) assert.ok(st.legs[l].fetlock < 0, 'standing fore fetlock extended');
  for (const l of [2, 3]) assert.ok(st.legs[l].hock > 0 && st.legs[l].fetlock < 0);
});

test('a steady trot is measured over at least four whole strides, the same at 240 Hz and at the game\'s 60 Hz', () => {
  const S = scenarios();
  const res = {};
  for (const hz of [240, 60]) {
    const stand = standAngles(simulate('stand', S.stand, { dt: 1 / hz }));
    const run = simulate('steady_4.0', S['steady_4.0'], { dt: 1 / hz });
    res[hz] = analyze(run, { stand });
    assert.ok(res[hz].details.strides >= 4, `${res[hz].details.strides} strides at ${hz} Hz`);
    // the stride's length over its period is the speed the scenario holds
    near(res[hz].metrics['stride.speed_mps'], 4.0, 0.04, 'measured speed');
  }
  near(res[60].metrics['stride.freq_hz'], res[240].metrics['stride.freq_hz'], 0.01 * res[240].metrics['stride.freq_hz'], 'stride frequency');
  near(res[60].metrics['trunk.withers_dy_mm'], res[240].metrics['trunk.withers_dy_mm'], 3, 'withers excursion');
  near(res[60].metrics['duty.fore'], res[240].metrics['duty.fore'], 0.03, 'duty fore');
  near(res[60].metrics['duty.hind'], res[240].metrics['duty.hind'], 0.03, 'duty hind');
});
