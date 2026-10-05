// Tests for the ground mammals (src/world/wildlife/quad.js, mammals.js, space.js): the footfall order and duty factor of
// every gait, measured from the simulated feet; planted feet that never slide; no terrain penetration over a long run;
// flight distances, the alarm running through a group; the pounce's ballistic arc; the far-away simplification; where
// the animals may be (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODIES, Loco, gaitAt, poseBones, makePose, legJointsWorld, G } from '../src/world/wildlife/quad.js';
import { WildlifeSim } from '../src/world/wildlife/sim.js';
import { MAMMALS } from '../src/world/wildlife/species.js';
import { Island } from '../src/world/wildlife/space.js';
import { standinWorld, mover } from './wildlife/standin.mjs';

const LEG = ['LF', 'RF', 'LH', 'RH'];
const flat = () => 4;
const hilly = (x, z) => 6 + 0.6 * Math.sin(x / 3.7) * Math.cos(z / 4.1) + 0.3 * Math.sin((x + z) / 2.3) + 2 * Math.sin(x / 23);
const fract = (x) => x - Math.floor(x);

// Run one animal at a steady speed (and gait mode) and record every foot's touchdowns and lift-offs, and the support
// (feet down) at every step
function gaitRun(name, v, { mode = null, scale = 1, ground = flat, secs = 8, yaw = 0.4 } = {}) {
  const L = new Loco(BODIES[name], { scale });
  L.place(0, 0, yaw, ground);
  const ev = [[], [], [], []];
  const prev = [0, 0, 0, 0];
  const dt = 1 / 240;
  let minSupport = 4, flight = 0, n = 0;
  for (let i = 0; i < secs / dt; i++) {
    L.step(dt, ground, { v, yaw, mode });
    const t = L.time;
    if (t < 3) {
      L.legs.forEach((g, l) => (prev[l] = g.st));
      continue;
    }
    let sup = 0;
    L.legs.forEach((g, l) => {
      if (g.st === 0) sup++;
      if (g.st !== prev[l]) ev[l].push({ t, down: g.st === 0 });
      prev[l] = g.st;
    });
    minSupport = Math.min(minSupport, sup);
    if (!sup) flight++;
    n++;
  }
  // stride period (mean between touchdowns of each leg), duty (stance / period), touchdown phases relative to LH
  const downs = ev.map((e) => e.filter((x) => x.down).map((x) => x.t));
  const periods = downs.flatMap((d) => d.slice(1).map((t, k) => t - d[k]));
  const T = periods.reduce((a, b) => a + b, 0) / periods.length;
  const stances = ev.map((e) => {
    const s = [];
    for (let k = 0; k < e.length - 1; k++) if (e[k].down && !e[k + 1].down) s.push(e[k + 1].t - e[k].t);
    return s;
  });
  const all = stances.flat();
  const duty = all.reduce((a, b) => a + b, 0) / all.length / T;
  const t0 = downs[2][1];
  const phase = downs.map((d) => fract((d.find((t) => t >= t0) - t0) / T));
  return { L, T, f: 1 / T, duty, phase, minSupport, flightFrac: flight / n, stride: v / (1 / T), forced: L.forcedLifts };
}

// footfall order of one stride starting at LH
const order = (phase) => phase.map((p, l) => [p, LEG[l]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ');
const near = (a, b, tol) => Math.abs(fract(a - b + 0.5) - 0.5) <= tol;

test('gaits: footfall order and duty factor of the walk, trot, gallops, bound and stott, measured from the feet', () => {
  // lateral-sequence walk: LH, LF, RH, RF evenly spaced, two or three feet always down, duty > 0.5
  for (const [name, v] of [['fox', 0.8], ['deer', 1.0]]) {
    const r = gaitRun(name, v);
    assert.equal(order(r.phase), 'LH LF RH RF', `${name} walk: lateral sequence (${r.phase.map((p) => p.toFixed(2))})`);
    assert.ok(near(r.phase[0], 0.25, 0.06) && near(r.phase[3], 0.5, 0.06) && near(r.phase[1], 0.75, 0.06), `${name} walk: four even beats`);
    assert.ok(r.duty > 0.55 && r.duty < 0.8, `${name} walk duty ${r.duty.toFixed(2)}`);
    assert.ok(r.minSupport >= 2, `${name} walk: always two feet down (${r.minSupport})`);
  }
  // diagonal trot: LF with RH, RF with LH, the pairs half a stride apart; duty 0.3–0.55
  for (const [name, v] of [['fox', 2.6], ['deer', 3.2]]) {
    const r = gaitRun(name, v);
    assert.ok(near(r.phase[0], r.phase[3], 0.05) && near(r.phase[1], r.phase[2], 0.05), `${name} trot: diagonal pairs (${r.phase.map((p) => p.toFixed(2))})`);
    assert.ok(near(r.phase[0], r.phase[1] + 0.5, 0.06), `${name} trot: 2 beats half a stride apart`);
    assert.ok(r.duty > 0.3 && r.duty < 0.55, `${name} trot duty ${r.duty.toFixed(2)}`);
  }
  // the fox's rotary gallop: LH, RH, RF, LF, with suspension
  {
    const r = gaitRun('fox', 9);
    assert.equal(order(r.phase), 'LH RH RF LF', `fox gallop: rotary (${r.phase.map((p) => p.toFixed(2))})`);
    assert.ok(r.duty > 0.15 && r.duty < 0.4, `fox gallop duty ${r.duty.toFixed(2)}`);
    assert.ok(r.flightFrac > 0.05, `fox gallop: suspension (${(r.flightFrac * 100).toFixed(0)} % of the stride)`);
  }
  // the deer's transverse gallop: LH, RH, LF, RF
  {
    const r = gaitRun('deer', 11);
    assert.equal(order(r.phase), 'LH RH LF RF', `deer gallop: transverse (${r.phase.map((p) => p.toFixed(2))})`);
    assert.ok(r.duty > 0.15 && r.duty < 0.4, `deer gallop duty ${r.duty.toFixed(2)}`);
    assert.ok(r.flightFrac > 0.1, `deer gallop: suspension (${(r.flightFrac * 100).toFixed(0)} %)`);
  }
  // the bound: hind feet together, then the fore feet, a long gathered flight
  {
    const r = gaitRun('deer', 10, { mode: 'bound' });
    assert.ok(near(r.phase[2], r.phase[3], 0.06), 'bound: the hind feet land together');
    assert.ok(fract(r.phase[0] - r.phase[2]) > 0.25 && fract(r.phase[1] - r.phase[2]) > 0.25, 'bound: the fore feet a good way after');
    assert.ok(r.flightFrac > 0.25, `bound: a long flight (${(r.flightFrac * 100).toFixed(0)} %)`);
  }
  // the stott: all four feet leave and land together, most of the cycle in the air, the legs held stiff
  {
    const r = gaitRun('deer', 2.4, { mode: 'stott' });
    const ph = r.phase.map((p) => fract(p + 0.5) - 0.5);
    assert.ok(Math.max(...ph) - Math.min(...ph) < 0.04, `stott: four feet together (${r.phase.map((p) => p.toFixed(3))})`);
    assert.ok(r.flightFrac > 0.6, `stott: in the air ${(r.flightFrac * 100).toFixed(0)} % of the time`);
    assert.ok(Math.abs(r.f - 1.15) < 0.05, `stott: a slow bounce (${r.f.toFixed(2)} Hz)`);
  }
  // no foot was ever picked up early (a leg that could not reach) in any steady gait on flat ground
  for (const [name, v, mode] of [['fox', 0.8], ['fox', 2.6], ['fox', 9], ['deer', 1.0], ['deer', 3.2], ['deer', 11], ['deer', 10, 'bound']]) assert.equal(gaitRun(name, v, { mode, secs: 5 }).forced, 0, `${name} ${v} m/s: no forced lift-off`);
});

test('gaits: stride length and frequency grow with speed, and with the animal\'s size the strides lengthen and slow', () => {
  for (const name of ['fox', 'deer']) {
    let last = null;
    for (const v of name === 'fox' ? [0.5, 1, 2, 3, 5, 8, 11] : [0.5, 1, 2, 3.5, 6, 9, 12]) {
      const g = gaitAt(BODIES[name], v, null);
      if (last) {
        assert.ok(g.stride > last.stride, `${name}: stride grows ${last.v} → ${v} m/s`);
        assert.ok(g.freq > last.freq * 0.97, `${name}: frequency does not fall ${last.v} → ${v} m/s`);
      }
      last = { ...g, v };
    }
  }
  // the same Froude number: geometrically similar strides (λ / h), a smaller animal steps quicker
  const fox = gaitAt(BODIES.fox, 2.5, null), h1 = BODIES.fox.hipH, h2 = BODIES.deer.hipH;
  const deer = gaitAt(BODIES.deer, 2.5 * Math.sqrt(h2 / h1), null);
  assert.ok(Math.abs(fox.stride / h1 - deer.stride / h2) / (fox.stride / h1) < 0.1, 'dynamic similarity: λ/h alike at the same Froude number');
  assert.ok(fox.freq > deer.freq, `the fox steps quicker (${fox.freq.toFixed(2)} vs ${deer.freq.toFixed(2)} Hz)`);
  // a calf beside its mother at the same speed: shorter, quicker strides
  const calf = gaitRun('deer', 1.0, { scale: 0.76, secs: 6 }), hind = gaitRun('deer', 1.0, { secs: 6 });
  assert.ok(calf.f > hind.f * 1.05 && calf.stride < hind.stride * 0.95, `calf ${calf.f.toFixed(2)} Hz / ${calf.stride.toFixed(2)} m, hind ${hind.f.toFixed(2)} Hz / ${hind.stride.toFixed(2)} m`);
  // the trot of a fox at its travelling pace: ~3 strides a second, a stride under a metre (red fox tracks)
  const ft = gaitRun('fox', 2.6, { secs: 6 });
  assert.ok(ft.f > 2.5 && ft.f < 3.8 && ft.stride > 0.6 && ft.stride < 1.05, `fox trot ${ft.f.toFixed(2)} Hz, ${ft.stride.toFixed(2)} m`);
});

// the posed skeleton through a steady run on hilly ground: how far a toe moves while its foot is planted, how far the
// IK falls short of its target in stance, the lowest joint against the ground
function plantRun(name, v, { mode = null, secs = 8, ground = hilly, scale = 1 } = {}) {
  const L = new Loco(BODIES[name], { scale });
  L.place(5, 5, 0.6, ground);
  const pose = makePose(), out = {};
  const start = [null, null, null, null];
  let slide = 0, ik = 0, low = Infinity, steps = 0;
  for (let i = 0; i < secs * 120; i++) {
    // a gentle curve: the feet must hold while the body turns over them
    L.step(1 / 120, ground, { v, yaw: 0.6 + 0.4 * Math.sin(i / 400), mode });
    if (i < 240) continue;
    poseBones(L, pose, out);
    steps++;
    for (let l = 0; l < 4; l++) {
      const J = legJointsWorld(L, out, l);
      const toe = J[J.length - 1];
      for (const j of J) low = Math.min(low, j.y - ground(j.x, j.z));
      if (L.legs[l].st === 0) {
        if (!start[l]) start[l] = toe;
        slide = Math.max(slide, Math.hypot(toe.x - start[l].x, toe.y - start[l].y, toe.z - start[l].z));
        ik = Math.max(ik, out.err[l]);
      } else start[l] = null;
    }
  }
  return { slide, ik, low, steps };
}

test('planted feet: a foot down does not slide through its stance (walk and trot, turning, on hilly ground)', () => {
  for (const [name, v] of [['fox', 0.8], ['fox', 2.6], ['deer', 1.1], ['deer', 3.2]]) {
    const r = plantRun(name, v);
    assert.ok(r.slide < 0.002, `${name} ${v} m/s: the planted toe moved ${(r.slide * 1000).toFixed(2)} mm`);
    assert.ok(r.ik < 0.002, `${name} ${v} m/s: the leg reaches its planted foot (${(r.ik * 1000).toFixed(2)} mm short)`);
  }
  // a calf and a stag: the same, at their sizes
  for (const scale of [0.76, 1.14]) {
    const r = plantRun('deer', 1.1, { scale });
    assert.ok(r.slide < 0.002 && r.ik < 0.002, `deer ×${scale}: slide ${(r.slide * 1000).toFixed(2)} mm, IK ${(r.ik * 1000).toFixed(2)} mm`);
  }
});

test('long run: the fox and the deer live, flee and come back for 10 minutes; no foot, joint or body in the ground', () => {
  const w = standinWorld({ seed: 23, trees: 70, size: 160 });
  w.camera = null; // full detail everywhere
  const sim = new WildlifeSim(w, { quality: 'high', population: { high: { fox: 2, deer: 2 } } });
  const walker = mover(-40, -30, 60, 40, 1.6);
  w.threats.push(walker);
  const out = {}, pose = makePose();
  let low = Infinity, lowBody = Infinity, bad = 0, flights = 0, alarms = 0, maxMammals = 0, offGround = 0, samples = 0;
  const seen = new Set();
  for (let i = 0; i < 600 * 60; i++) {
    if (i % (60 * 12) === 0) {
      const ms = sim.mammals;
      const target = ms.length && w.rng() < 0.6 ? ms[Math.floor(w.rng() * ms.length)] : { x: (w.rng() - 0.5) * 200, z: (w.rng() - 0.5) * 200 };
      const sp = w.rng() < 0.3 ? 4.5 : 1.6;
      const dx = target.x - walker.x, dz = target.z - walker.z, l = Math.hypot(dx, dz) || 1;
      Object.assign(walker, { vx: (dx / l) * sp, vz: (dz / l) * sp, speed: sp });
    }
    walker.step(1 / 60, w.groundAt);
    w.center.x = walker.x;
    w.center.z = walker.z;
    sim.step(1 / 60);
    const ms = sim.mammals;
    maxMammals = Math.max(maxMammals, ms.length);
    for (const m of ms) {
      if (m.state === 'flee' && !seen.has(m)) (seen.add(m), flights++);
      if (m.state !== 'flee') seen.delete(m);
      const L = m.loco;
      if (!Number.isFinite(L.x + L.z + L.bodyY + L.pitch + L.v)) bad++;
      // the body over walkable ground (dry land, no trunk, not too steep)
      samples++;
      if (!w.walkable(L.x, L.z, m.sp)) offGround++;
      if (i % 4) continue;
      poseBones(L, m.pose, out);
      for (let l = 0; l < 4; l++) for (const j of legJointsWorld(L, out, l)) low = Math.min(low, j.y - w.groundAt(j.x, j.z));
      lowBody = Math.min(lowBody, L.gy + L.bodyY - w.groundAt(L.x, L.z) - 0.35 * L.h);
    }
  }
  alarms = w.events.filter((e) => e.type === 'wildlife:alarm').length;
  assert.equal(bad, 0, 'no NaN');
  assert.ok(low > -0.01, `no leg joint or foot below the ground (worst ${(low * 1000).toFixed(1)} mm)`);
  assert.ok(lowBody > 0, `the body well above the ground (worst margin ${lowBody.toFixed(3)} m)`);
  assert.ok(offGround / samples < 0.01, `on walkable ground ${(100 - (offGround / samples) * 100).toFixed(2)} % of the time`);
  assert.ok(maxMammals >= 4, `the population was kept (${maxMammals})`);
  assert.ok(flights >= 3 && alarms >= 1, `the walker put them to flight (${flights} flights, ${alarms} alarms)`);
});

// a group (or the fox) in the open and a threat coming straight at it: the distance of the first flight, when the
// others follow, the alarm events, where they run
function fleeRun(name, n, threat, { alarm = 1, slip = false } = {}) {
  const w = standinWorld({ seed: 9, flat: true, trees: 60, size: 150 });
  w.camera = null;
  w.alarm = alarm;
  const sim = new WildlifeSim(w);
  sim.auto = false;
  const spots = [];
  for (let k = 0; spots.length < n && k < 200; k++) {
    const x = (w.rng() - 0.5) * 8, z = (w.rng() - 0.5) * 8;
    if (w.walkable(x, z, MAMMALS[name]) && !spots.some((s) => Math.hypot(s.x - x, s.z - z) < 2)) spots.push({ x, z, yaw: w.rng() * 6.28 });
  }
  const h = sim.addHerd(name, spots, { x: 0, z: 0 });
  for (const m of h.members) m.slipAway = slip;
  for (let i = 0; i < 180; i++) sim.step(1 / 60);
  w.threats.push(threat);
  let first = null, last = null, alertAt = null, vigilAt = null, maxV = 0, lookback = null;
  const went = new Set(), seq = [];
  for (let i = 0; i < 60 * 60; i++) {
    threat.step(1 / 60, w.groundAt);
    sim.step(1 / 60);
    const m0 = h.members[0];
    if (!seq.length || seq[seq.length - 1] !== m0.state) seq.push(m0.state);
    if (m0.state === 'flee') maxV = Math.max(maxV, m0.loco.v);
    if (m0.state === 'lookback' && !lookback) lookback = { d: Math.hypot(m0.x - threat.x, m0.z - threat.z) };
    for (const m of h.members) {
      if (!alertAt && m.state === 'alert') alertAt = { t: sim.time, d: Math.hypot(m.x - threat.x, m.z - threat.z), m };
      if (alertAt && !vigilAt && h.members.length > 1 && h.members.every((o) => o === alertAt.m || o.state !== 'graze')) vigilAt = sim.time;
      if (m.state === 'flee' && !went.has(m)) {
        went.add(m);
        const d = Math.hypot(m.x - threat.x, m.z - threat.z);
        if (!first) first = { t: sim.time, d, x: m.x, z: m.z, threat: { x: threat.x, z: threat.z } };
        last = { t: sim.time, d };
      }
    }
    if (went.size === n && sim.time - first.t > 8) break;
  }
  const alarms = w.events.filter((e) => e.type === 'wildlife:alarm');
  const states = h.members.map((m) => m.state);
  return { first, last, went: went.size, alarms, alertAt, vigilAt, h, states, sim, w, maxV, lookback, seq };
}

test('flight: the fox bolts at 20–30 m from a walker, farther from a runner, a galloping horse, in a fight; it stops to look back, then trots off', () => {
  const walk = fleeRun('fox', 1, mover(0, -70, 0, 0, 1.6));
  assert.ok(walk.first, 'the fox fled');
  assert.ok(walk.first.d >= 20 && walk.first.d <= 30, `fox FID from a walker ${walk.first.d.toFixed(1)} m`);
  assert.ok(walk.alertAt && walk.alertAt.d > walk.first.d + 10, `it watched the walker first (alert at ${walk.alertAt ? walk.alertAt.d.toFixed(0) : '–'} m)`);
  const run = fleeRun('fox', 1, mover(0, -90, 0, 0, 4.5));
  const horse = fleeRun('fox', 1, mover(0, -150, 0, 0, 13.5, 1.2));
  const fight = fleeRun('fox', 1, mover(0, -70, 0, 0, 1.6), { alarm: 1.6 });
  assert.ok(run.first.d > walk.first.d + 5, `farther from a runner (${run.first.d.toFixed(1)} m)`);
  assert.ok(horse.first.d > run.first.d + 15, `farther still from a galloping horse (${horse.first.d.toFixed(1)} m)`);
  assert.ok(fight.first.d > walk.first.d * 1.4, `farther in a fight (${fight.first.d.toFixed(1)} m)`);
  // the run: a gallop away from the walker, then the look back, then off at a trot into the trees
  assert.ok(walk.maxV > 8, `it galloped (${walk.maxV.toFixed(1)} m/s)`);
  assert.ok(walk.lookback && walk.lookback.d > 45, `it stopped to look back at a safe distance (${walk.lookback ? walk.lookback.d.toFixed(0) : '–'} m)`);
  const fox = walk.h.members[0], w = walk.w, sim = walk.sim;
  w.threats[0].vx = w.threats[0].vz = w.threats[0].speed = 0; // the walker stops where he is
  const s = walk.seq.slice();
  for (let i = 0; i < 60 * 30; i++) {
    sim.step(1 / 60);
    if (s[s.length - 1] !== fox.state) s.push(fox.state);
  }
  const iFlee = s.indexOf('flee'), iBack = s.indexOf('lookback', iFlee), iOff = s.indexOf('leave', iBack);
  assert.ok(iFlee >= 0 && iBack > iFlee && iOff > iBack, `flee → look back → leave (${s.join(' → ')})`);
});

test('flight: a deer group goes alert, whistles once and bolts together at 30–50 m from a walker, away from him, and settles far off', () => {
  const r = fleeRun('deer', 5, mover(0, -110, 0, 0, 1.6));
  assert.ok(r.first, 'the deer fled');
  assert.ok(r.first.d >= 30 && r.first.d <= 50, `deer FID from a walker ${r.first.d.toFixed(1)} m`);
  assert.ok(r.alertAt && r.alertAt.d > r.first.d + 10, `the alert came first (${r.alertAt ? r.alertAt.d.toFixed(0) : '–'} m)`);
  assert.ok(r.vigilAt && r.vigilAt - r.alertAt.t < 1.5, `the others lifted their heads within ${r.vigilAt ? (r.vigilAt - r.alertAt.t).toFixed(2) : '–'} s of the first alert`);
  assert.equal(r.went, 5, 'all five ran');
  assert.ok(r.last.t - r.first.t < 1, `together: the last went ${(r.last.t - r.first.t).toFixed(2)} s after the first`);
  assert.equal(r.alarms.length, 1, 'one alarm whistle');
  assert.equal(r.alarms[0].detail.species, 'deer');
  assert.equal(r.alarms[0].detail.count, 5);
  // where to: away from the walker
  const tgt = r.h.flee ? r.h.flee.target : null;
  if (tgt) {
    const ex = r.first.x - r.first.threat.x, ez = r.first.z - r.first.threat.z, dx = tgt.x - r.first.x, dz = tgt.z - r.first.z;
    assert.ok((ex * dx + ez * dz) / (Math.hypot(ex, ez) * Math.hypot(dx, dz)) > 0.25, 'they ran away from him');
  }
  // a runner and a galloping horse frighten them from farther
  const run = fleeRun('deer', 4, mover(0, -140, 0, 0, 4.5));
  const horse = fleeRun('deer', 4, mover(0, -220, 0, 0, 13.5, 1.2));
  assert.ok(run.first.d > r.first.d + 8, `farther from a runner (${run.first.d.toFixed(1)} m)`);
  assert.ok(horse.first.d > run.first.d + 20, `farther from a galloping horse (${horse.first.d.toFixed(1)} m)`);
  // the run's end: they stop, look back, then walk and graze again far from where they were
  const sim = r.sim, w = r.w;
  w.threats.length = 0;
  const seen = new Set();
  for (let i = 0; i < 60 * 60; i++) {
    sim.step(1 / 60);
    for (const m of r.h.members) seen.add(m.state);
  }
  assert.ok(seen.has('lookback'), 'they stopped to look back');
  assert.ok(r.h.members.every((m) => m.state !== 'flee') && seen.has('graze'), `they settled and grazed again (${[...seen].join(', ')})`);
  const c = r.h.centre();
  assert.ok(Math.hypot(c.x, c.z) > 50, `far from where they had been (${Math.hypot(c.x, c.z).toFixed(0)} m)`);
});

test('the pounce: a ballistic arc (gravity only), as high as asked, the fore feet down before the hind, the nose down', () => {
  const L = new Loco(BODIES.fox);
  L.place(0, 0, 0, flat);
  for (let i = 0; i < 60; i++) L.step(1 / 60, flat, { v: 0, yaw: 0 });
  assert.ok(L.leap({ dist: 1.5, height: 0.85, yaw: 0.35, drop: 0.12 }));
  const dt = 1 / 240;
  const ys = [], ts = [];
  let foreAt = null, hindAt = null, minPitch = 0, maxPitch = 0, apex = -Infinity, y0 = null;
  for (let i = 0; i < 3 / dt && L.air; i++) {
    L.step(dt, flat, { v: 0 });
    const A = L.air;
    if (!A) break;
    if (A.t >= 0 && A.t < A.T) {
      const y = L.gy + L.bodyY;
      if (y0 === null) y0 = y;
      ys.push(y);
      ts.push(A.t);
      apex = Math.max(apex, y - y0);
      minPitch = Math.min(minPitch, L.pitch);
      maxPitch = Math.max(maxPitch, L.pitch);
    }
    if (A.t >= A.T) {
      if (foreAt === null && L.legs[0].st === 0 && L.legs[1].st === 0) foreAt = A.t;
      if (hindAt === null && L.legs[2].st === 0 && L.legs[3].st === 0) hindAt = A.t;
    }
  }
  // the body's height over the flight: y'' = −g
  let accErr = 0;
  for (let k = 2; k < ys.length; k += 3) {
    const a = (ys[k] - 2 * ys[k - 1] + ys[k - 2]) / (dt * dt);
    accErr = Math.max(accErr, Math.abs(a + G));
  }
  assert.ok(accErr < 0.05, `ballistic: vertical acceleration −g (worst error ${accErr.toFixed(3)} m/s²)`);
  // the arc's apex is `height` over the higher of its ends (it lands propped on its fore legs, higher than it crouched)
  const over = apex - Math.max(0, ys[ys.length - 1] - y0);
  assert.ok(Math.abs(over - 0.85) < 0.03, `apex ${over.toFixed(3)} m over the higher end of the arc`);
  assert.ok(maxPitch > 0.5, `nose up out of the push (${((maxPitch * 180) / Math.PI).toFixed(0)}°)`);
  assert.ok(minPitch < -0.9, `nose down into the dive (${((minPitch * 180) / Math.PI).toFixed(0)}°)`);
  assert.ok(foreAt !== null && hindAt !== null && hindAt - foreAt > 0.1, `fore feet first, the hind ${(hindAt - foreAt).toFixed(2)} s later`);
  assert.ok(Math.abs(L.yaw - 0.35) < 0.05, 'it jumped where it aimed');
});

test('far from the camera: the same gait on fewer terrain samples, the feet still planted', () => {
  let calls = 0;
  const g = (x, z) => (calls++, hilly(x, z));
  const count = (lod) => {
    calls = 0;
    const L = new Loco(BODIES.deer);
    L.place(0, 0, 0.3, g);
    L.lod = lod;
    for (let i = 0; i < 60 * 10; i++) L.step(1 / 60, g, { v: 3, yaw: 0.3 });
    return { calls, L };
  };
  const full = count(0), far = count(1);
  assert.ok(far.calls < full.calls * 0.7, `lod 1: ${far.calls} ground samples vs ${full.calls}`);
  // the same footfalls either way
  assert.equal(far.L.g.name, 'trot');
  assert.ok(Math.abs(far.L.phase - full.L.phase) < 1e-9, 'the same stride phase');
});

// ------------------------------------------------------------------------------------------------------------ placement
// the real space.js Island on a synthetic game: rolling land, the sea to the west, a steep bank, a stone stair (a floor
// override), a building (a box collider on a raised floor), a wood with an edge, a clearing, a path, a susuki field
function syntheticGame() {
  const seaX = -120;
  const steep = (x) => (x > 60 && x < 75 ? (x - 60) * 1.2 : x >= 75 ? 18 : 0); // a 50° bank
  const heightAt = (x, z) => (x < seaX ? -3 : 4 + 0.8 * Math.sin(x / 31) * Math.cos(z / 27) + steep(x));
  const stairs = { x0: -20, x1: -14, z0: 30, z1: 60 };
  const house = { x: 20, z: -20, hw: 5, hd: 4 };
  const inRect = (x, z, r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  const overrides = [(x, z) => (inRect(x, z, stairs) ? heightAt(x, z) + (z - stairs.z0) * 0.3 : null), (x, z) => (Math.abs(x - house.x) < house.hw && Math.abs(z - house.z) < house.hd ? heightAt(x, z) + 0.4 : null)];
  const groundAt = (x, z) => {
    let h = heightAt(x, z);
    for (const f of overrides) {
      const o = f(x, z);
      if (o != null && o > h) h = o;
    }
    return h;
  };
  // trees: a wood north of z = −60 (its edge along z = −60), a ring around a clearing at (−60, 40), scattered shrubs
  const recs = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let x = -110; x < 55; x += 4.5) for (let z = -140; z < -60; z += 4.5) recs.push({ x: x + rnd() * 2, z: z + rnd() * 2, shrub: false });
  for (let a = 0; a < 40; a++) {
    const r = 18 + rnd() * 10;
    recs.push({ x: -60 + Math.sin(a) * r, z: 40 + Math.cos(a) * r, shrub: false });
  }
  for (let k = 0; k < 20; k++) recs.push({ x: (rnd() - 0.5) * 150, z: (rnd() - 0.5) * 150, shrub: true });
  const n = recs.length;
  const forest = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), vi: new Uint8Array(n), s: new Float32Array(n).fill(1), mat: new Float32Array(n * 16), cells: new Map() };
  const fkey = (i, j) => (i + 512) * 4096 + (j + 512);
  const colliders = [];
  recs.forEach((r, i) => {
    forest.x[i] = r.x;
    forest.z[i] = r.z;
    forest.y[i] = heightAt(r.x, r.z);
    forest.vi[i] = r.shrub ? 1 : 0;
    forest.mat[i * 16] = 1;
    const k = fkey(Math.floor(r.x / 32), Math.floor(r.z / 32));
    if (!forest.cells.has(k)) forest.cells.set(k, []);
    forest.cells.get(k).push(i);
    if (!r.shrub) colliders.push({ type: 'circle', x: r.x, z: r.z, r: 0.3, bound: 0.3, tag: 'tree', top: Infinity });
  });
  for (const [k, c] of forest.cells) forest.cells.set(k, Int32Array.from(c));
  colliders.push({ type: 'box', x: house.x, z: house.z, hw: house.hw, hd: house.hd, cos: 1, sin: 0, bound: Math.hypot(house.hw, house.hd), tag: 'minka', top: Infinity });
  const variants = [{ cls: 'tree', kind: 'maple', crown: { c: { x: 0, y: 6, z: 0 }, r: { x: 3, y: 3, z: 3 } } }, { cls: 'shrub', kind: 'shrub', crown: { c: { x: 0, y: 1, z: 0 }, r: { x: 1, y: 1, z: 1 } } }];
  const surfaceAt = (x, z) => {
    const forestM = z < -58 ? 1 : 0;
    const path = Math.abs(z - (0.3 * x + 5)) < 1.5 && x > -100 && x < 50 ? 1 : 0;
    const pampas = x > 25 && x < 55 && z > 10 && z < 60 ? 0.9 : 0;
    return { grass: forestM ? 0.1 : 0.7, pampas, flowers: 0, path, rock: 0, forest: forestM, sand: x < seaX + 8 ? 0.8 : 0, wet: 0 };
  };
  const game = {
    terrain: { heightAt, surfaceAt },
    groundAt,
    colliders: {
      items: colliders,
      nearby(x, z, r) {
        return colliders.filter((c) => Math.abs(c.x - x) < c.bound + r && Math.abs(c.z - z) < c.bound + r);
      },
    },
    modules: { trees: { forest, variants } },
    wind: null,
  };
  return { game, seaX, stairs, house, inRect, heightAt };
}

test('placement: the deer at forest edges and clearings, the fox on paths and edges; never in the sea, on stairs or a building, nor on a steep bank', () => {
  const S = syntheticGame();
  let seed = 3;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const island = new Island(S.game, { rng });
  const deer = MAMMALS.deer, fox = MAMMALS.fox;
  // the ground: walkable only where it should be
  assert.equal(island.walkable(-130, 0, deer), false, 'the sea');
  assert.equal(island.walkable(-17, 45, deer), false, 'the stairs');
  assert.equal(island.walkable(20, -20, fox), false, 'the building');
  assert.equal(island.walkable(68, 0, deer), false, 'the steep bank');
  assert.equal(island.walkable(0, 20, deer), true, 'the open field');
  const kinds = { deer: {}, fox: {} };
  for (const sp of [deer, fox]) {
    for (let k = 0; k < 60; k++) {
      const x = -100 + rng() * 150, z = -100 + rng() * 170;
      const t = island.findHabitat(sp, x, z, { rMin: 0, rMax: 40, away: null, count: sp.name === 'fox' ? 1 : 4 });
      if (!t) continue;
      kinds[sp.name][t.kind] = (kinds[sp.name][t.kind] || 0) + 1;
      for (const s of t.spots) {
        const where = `${sp.name} ${t.kind} (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`;
        assert.ok(s.x > S.seaX + 2 && S.game.groundAt(s.x, s.z) > 0.5, `${where}: on dry land`);
        assert.ok(!S.inRect(s.x, s.z, S.stairs), `${where}: not on the stairs`);
        assert.ok(!(Math.abs(s.x - S.house.x) < S.house.hw + 0.5 && Math.abs(s.z - S.house.z) < S.house.hd + 0.5), `${where}: not in the building`);
        assert.ok(!(s.x > 60.5 && s.x < 75), `${where}: not on the steep bank`);
        assert.ok(island.walkable(s.x, s.z, sp), `${where}: walkable`);
        if (sp.name === 'deer') {
          // grass under open sky with the wood within reach, never the susuki
          const ta = island.treesAround(s.x, s.z, 30);
          assert.ok(t.kind === 'wood' || (ta.n >= 3 && ta.near > 4), `${where}: at the wood's edge (${ta.n} trunks within 30 m, nearest ${ta.near.toFixed(1)} m)`);
          assert.ok(S.game.terrain.surfaceAt(s.x, s.z).pampas < 0.6, `${where}: not in the susuki`);
        }
      }
    }
  }
  assert.ok((kinds.deer.edge || 0) + (kinds.deer.clearing || 0) > (kinds.deer.wood || 0), `deer mostly at edges and clearings (${JSON.stringify(kinds.deer)})`);
  assert.ok(kinds.deer.clearing > 0, 'the clearing is found');
  assert.ok((kinds.fox.path || 0) + (kinds.fox.edge || 0) > 0, `the fox on paths and edges (${JSON.stringify(kinds.fox)})`);
  // a refuge: in the wood, away from the threat
  for (let k = 0; k < 10; k++) {
    const c = island.findCover(deer, 0, -40, { rMin: 20, rMax: 80, away: { x: 0, z: 0 } });
    assert.ok(c && c.z < -40, `a refuge away from the threat (${c ? c.z.toFixed(0) : '–'})`);
    assert.ok(island.treesAround(c.x, c.z, 12).n >= 3, 'in the trees');
  }
});

test('placement: spawned around a moving centre, out of sight, by quality; despawned far behind', () => {
  const w = standinWorld({ seed: 31, trees: 80, size: 200 });
  w.camera = null;
  const sims = {};
  for (const q of ['low', 'high', 'ultra']) {
    const sim = new WildlifeSim(w, { quality: q });
    sim.flocks = [];
    for (let i = 0; i < 60 * 20; i++) sim.step(1 / 60);
    sims[q] = sim.flocks.filter((f) => f.ground);
  }
  const count = (q, name) => sims[q].filter((f) => f.sp.name === name).length;
  assert.ok(count('low', 'deer') <= count('high', 'deer') && count('high', 'fox') <= count('ultra', 'fox'), 'more groups with the quality');
  assert.ok(count('high', 'deer') >= 1 && count('high', 'fox') >= 1, 'deer and a fox around the player on high');
  for (const f of sims.high) for (const m of f.members) assert.ok(w.walkable(m.x, m.z, m.sp), 'spawned on walkable ground');
  // far behind: they leave the simulation
  const sim = new WildlifeSim(w, { quality: 'high' });
  for (let i = 0; i < 60 * 5; i++) sim.step(1 / 60);
  const before = sim.flocks.filter((f) => f.ground);
  assert.ok(before.length >= 2, 'a population at the start');
  w.center.x = 260;
  w.center.z = -10;
  for (let i = 0; i < 60 * 4; i++) sim.step(1 / 60);
  assert.ok(before.every((f) => !sim.flocks.includes(f) || f.members.some((m) => Math.hypot(m.x - 260, m.z + 10) < 240)), 'the far groups were dropped');
});
