// Tests for the birds (src/world/wildlife/): the flight physics, landing, terrain clearance over a long run, perches
// from the real tree geometry, flight-initiation distances and the flock's flush (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { flightStep, trackVelocity, levelFlight, stallSpeed, bankForTurn, G } from '../src/world/wildlife/flight.js';
import { SPECIES } from '../src/world/wildlife/species.js';
import { WildlifeSim, threatRatio, awayFrom } from '../src/world/wildlife/sim.js';
import { crownPerches, toWorld, trunkDistance } from '../src/world/wildlife/perches.js';
import { buildTree } from '../src/world/trees/generator.js';
import { standinWorld, mover } from './wildlife/standin.mjs';

const DEG = 180 / Math.PI;
const still = { x: 0, y: 0, z: 0 };

test('flight: level cruise holds its height on a lift equal to the weight, at plausible speeds and power', () => {
  for (const name of ['crow', 'sparrow']) {
    const sp = SPECIES[name], A = sp.aero;
    const b = { x: 0, y: 30, z: 0, vx: 0, vy: 0, vz: sp.cruise, hx: 0, hz: 1 };
    const c = { ax: 0, ay: 0, az: 0, flap: 1, folded: false, flare: 0 };
    const out = {};
    for (let i = 0; i < 600; i++) {
      trackVelocity(b, 0, 0, sp.cruise, 1.5, sp.accel, c);
      flightStep(b, A, c, still, 1 / 60, out);
    }
    assert.ok(Math.abs(b.y - 30) < 0.02, `${name} holds its height (${b.y.toFixed(3)})`);
    assert.ok(Math.abs(out.L / (A.m * G) - 1) < 0.01, `${name} lift / weight ${(out.L / (A.m * G)).toFixed(3)}`);
    // the flapping wings give back the drag: a moderate effort in cruise
    assert.ok(out.effort > 0.1 && out.effort < 0.5, `${name} cruise effort ${out.effort.toFixed(2)}`);
    const lf = levelFlight(A, sp.cruise);
    assert.ok(Math.abs(out.F - lf.D) < 0.01 * lf.D + 1e-4, `${name} thrust ${out.F.toFixed(4)} = drag ${lf.D.toFixed(4)}`);
    assert.ok(lf.LD > 6 && lf.LD < 16, `${name} glide ratio ${lf.LD.toFixed(1)}`);
  }
  // speeds: crows cruise at 10–14 m/s and stall well below; sparrows at 8–10 m/s
  assert.ok(SPECIES.crow.cruise >= 10 && SPECIES.crow.cruise <= 14);
  assert.ok(SPECIES.sparrow.cruise >= 8 && SPECIES.sparrow.cruise <= 10);
  assert.ok(stallSpeed(SPECIES.crow.aero) < SPECIES.crow.cruise * 0.75);
});

test('flight: a coordinated turn banks at atan(v·ω/g), into the turn', () => {
  for (const [v, R, side] of [[11, 25, 1], [11, 40, -1], [9, 15, 1]]) {
    const sp = SPECIES.crow, A = sp.aero;
    // start on the circle about the origin, flying along +z; side +1 = clockwise from above = a right turn
    const b = { x: side * R, y: 20, z: 0, vx: 0, vy: 0, vz: v, hx: 0, hz: 1 };
    const c = { ax: 0, ay: 0, az: 0, flap: 1, folded: false, flare: 0 };
    const out = {};
    let prev = Math.atan2(b.vx, b.vz), n = 0, err = 0, signOK = 0;
    for (let i = 0; i < 1800; i++) {
      const r = Math.hypot(b.x, b.z), ux = b.x / r, uz = b.z / r;
      // tangent direction of travel: a right turn (the centre on the bird's right, its right being −x at the start)
      const tx = -side * uz, tz = side * ux;
      c.ax = -ux * ((v * v) / R) + (tx * v - b.vx) * 2 - ux * (r - R) * 0.6;
      c.az = -uz * ((v * v) / R) + (tz * v - b.vz) * 2 - uz * (r - R) * 0.6;
      c.ay = (20 - b.y) - b.vy * 1.5;
      flightStep(b, A, c, still, 1 / 60, out);
      const h = Math.atan2(b.vx, b.vz);
      const dh = Math.atan2(Math.sin(h - prev), Math.cos(h - prev));
      prev = h;
      if (i > 900) {
        // turn rate to the right (heading = atan2(vx, vz) grows to the left)
        const omegaRight = (-dh * 60);
        err += Math.abs(out.bank - Math.atan((Math.hypot(b.vx, b.vz) * omegaRight) / G));
        if (Math.sign(out.bank) === side) signOK++;
        n++;
      }
    }
    assert.ok(err / n < 0.5 / DEG, `bank law at v=${v} R=${R}: mean error ${((err / n) * DEG).toFixed(3)}°`);
    assert.equal(signOK, n, 'the bird banks into the turn');
    assert.ok(Math.abs(Math.abs(out.bank) - bankForTurn(v, v / R)) < 1.5 / DEG, `bank ${(out.bank * DEG).toFixed(1)}° vs ${(bankForTurn(v, v / R) * DEG).toFixed(1)}°`);
  }
});

// fly a bird in from afar to a perch in the stand-in world and watch the touch-down
function landOn(name, perchOf, start, wind = [3, 1]) {
  const w = standinWorld({ seed: 3, flat: true, trees: 0, wind });
  const tree = { i: 0, x: 0, z: 0, y: 4, H: 14, shrub: false, cy: 4 + 14 * 0.62, rh: 14 * 0.28, ry: 14 * 0.26, perches: null };
  w.trees.push(tree);
  const sim = new WildlifeSim(w);
  sim.auto = false;
  const f = sim.addFlock(name, 1);
  const b = f.members[0];
  b.mode = 'fly';
  b.stage = 'cruise';
  Object.assign(b, { x: start[0], y: start[1], z: start[2], vx: start[3], vy: 0, vz: start[4], hx: 1, hz: 0, fold: 0, legs: 0 });
  const perch = perchOf(w, tree);
  assert.ok(b.setDest(perch), 'a clear approach exists');
  f.state = 'moving';
  const plan = b.plan;
  let touch = null;
  const orig = b.touchDown.bind(b);
  b.touchDown = () => {
    touch = { v: Math.hypot(b.vx, b.vy, b.vz), d: Math.hypot(b.x - perch.x, b.y - (perch.y + b.sp.hipH), b.z - perch.z), t: sim.time, plan: b.plan };
    orig();
  };
  let minY = Infinity;
  for (let i = 0; i < 60 * 60 && !touch; i++) {
    sim.step(1 / 60);
    if (b.mode === 'fly') minY = Math.min(minY, b.y - w.groundAt(b.x, b.z));
  }
  return { touch, b, perch, plan, minY, wind };
}

test('landing: into the wind, down the approach, a flare, touch-down at walking pace on the perch', () => {
  const top = (w, t) => ({ x: t.x, y: t.cy + t.ry * 0.97, z: t.z, kind: 'tree', tier: 'top', nx: 0, nz: 0, key: 'top', tree: t });
  const outer = (w, t) => ({ x: t.x + t.rh * 0.72, y: t.cy + t.ry * 0.66, z: t.z, kind: 'tree', tier: 'outer', nx: 1, nz: 0, key: 'out', tree: t });
  const ground = (w) => ({ x: 30, y: w.groundAt(30, 20), z: 20, kind: 'ground', key: 'g' });
  const cases = [
    ['crow', top, [60, 25, -40, -8, 6]],
    ['crow', top, [-50, 20, 30, 9, 0]],
    ['crow', outer, [-60, 22, -10, 10, 0]],
    ['crow', ground, [-30, 15, -40, 6, 6]],
    ['sparrow', outer, [40, 12, 30, -6, -4]],
    ['sparrow', ground, [5, 8, 45, 0, -8]],
  ];
  for (const [name, perchOf, start] of cases) {
    const r = landOn(name, perchOf, start);
    const label = `${name} → ${r.perch.tier || r.perch.kind} from (${start.slice(0, 3)})`;
    assert.ok(r.touch, `${label}: lands`);
    assert.ok(r.touch.v < 0.35, `${label}: touch-down speed ${r.touch.v.toFixed(2)} m/s`);
    assert.ok(r.touch.d < 0.06, `${label}: on the perch (${r.touch.d.toFixed(3)} m)`);
    assert.equal(r.b.mode, 'perch');
    assert.ok(Math.abs(r.b.fx - r.perch.x) < 1e-9 && Math.abs(r.b.fz - r.perch.z) < 1e-9, `${label}: feet on the perch`);
    // into the wind (the outer perch is approached from outside the crown: within 70° of it)
    const wl = Math.hypot(r.wind[0], r.wind[1]);
    const into = -(r.touch.plan.dx * r.wind[0] + r.touch.plan.dz * r.wind[1]) / wl;
    assert.ok(into > (r.perch.tier === 'outer' ? 0.3 : 0.7), `${label}: lands into the wind (cos ${into.toFixed(2)})`);
    assert.ok(r.minY > r.b.sp.hipH * 0.5, `${label}: clear of the ground on the way (${r.minY.toFixed(2)} m)`);
  }
});

test('long run: no bird ever goes into the ground, perched birds stand on it, nothing breaks', () => {
  const w = standinWorld({ seed: 11 });
  const sim = new WildlifeSim(w, { quality: 'high' });
  const walker = mover(-60, -40, 60, 40, 1.6);
  w.threats.push(walker);
  const dt = 1 / 60;
  let worstFly = Infinity, worstStand = 0, bad = 0, landings = 0, maxBirds = 0;
  const prev = new Map();
  for (let i = 0; i < 600 * 60; i++) {
    // the walker wanders, sometimes at a run, straight through the flocks now and then
    if (i % (60 * 15) === 0) {
      const target = sim.birds.length && w.rng() < 0.5 ? sim.birds[Math.floor(w.rng() * sim.birds.length)] : { x: (w.rng() - 0.5) * 160, z: (w.rng() - 0.5) * 160 };
      const sp = w.rng() < 0.3 ? 4.5 : 1.6;
      const dx = target.x - walker.x, dz = target.z - walker.z, l = Math.hypot(dx, dz) || 1;
      Object.assign(walker, { vx: (dx / l) * sp, vz: (dz / l) * sp, speed: sp });
    }
    walker.step(dt, w.groundAt);
    w.center.x = walker.x;
    w.center.z = walker.z;
    sim.step(dt);
    const birds = sim.birds;
    maxBirds = Math.max(maxBirds, birds.length);
    for (const b of birds) {
      if (!Number.isFinite(b.x + b.y + b.z + b.vx + b.vy + b.vz + b.yaw + b.pitch + b.roll + b.stroke + b.fold)) bad++;
      if (b.mode === 'fly') worstFly = Math.min(worstFly, b.y - w.groundAt(b.x, b.z) - b.sp.hipH * 0.5);
      else if (b.perch && b.perch.kind === 'ground') {
        worstStand = Math.max(worstStand, Math.abs(b.fy - w.groundAt(b.fx, b.fz)));
        if (b.y < b.fy) bad++;
      }
      if (prev.get(b) === 'fly' && b.mode === 'perch') landings++;
      prev.set(b, b.mode);
    }
  }
  assert.equal(bad, 0, 'no NaN, no hip below the feet');
  assert.ok(worstFly >= 0, `flying birds keep clear of the terrain (worst margin ${worstFly.toFixed(3)} m)`);
  assert.ok(worstStand < 1e-9, `perched birds stand on the ground (worst ${worstStand} m)`);
  assert.ok(maxBirds >= 25, `a population was kept around the walker (${maxBirds})`);
  assert.ok(landings > 100, `the birds moved and landed again and again (${landings})`);
  assert.ok(w.events.some((e) => e.type === 'wildlife:flush'), 'the walker flushed a flock at least once');
});

test('perches: on the real crowns (tops, flanks, inside the leaves), never in a trunk', () => {
  const CASES = [['maple', 11, 1, {}], ['maple', 21, 1.3, {}], ['ginkgo', 31, 1, {}], ['ginkgo', 34, 1, { shape: 'columnar' }], ['pine', 41, 1, {}], ['pine', 43, 1, {}], ['cedar', 51, 1, {}], ['bamboo', 61, 1, {}], ['shrub', 72, 1, {}]];
  for (const [kind, seed, big, opts] of CASES) {
    const v = buildTree(kind, seed, big, opts);
    v.cls = kind === 'shrub' ? 'shrub' : 'tree';
    const P = crownPerches(v);
    const pos = v.lod0.leaves.getAttribute('position');
    const cards = [];
    for (let k = 0; k < pos.count / 4; k++) {
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 4; j++) (x += pos.getX(k * 4 + j)), (y += pos.getY(k * 4 + j)), (z += pos.getZ(k * 4 + j));
      cards.push([x / 4, y / 4, z / 4]);
    }
    const label = `${kind} ${seed}`;
    assert.ok(P.top.length >= 1, `${label}: a top perch`);
    if (kind === 'maple' || kind === 'ginkgo') assert.ok(P.outer.length >= 5 && P.inner.length >= 4, `${label}: perches all round (${P.outer.length} outer, ${P.inner.length} inner)`);
    const box = v.box.clone().expandByScalar(0.3);
    for (const p of [...P.top, ...P.outer, ...P.inner]) {
      const where = `${label} ${p.tier} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      const { d, r } = trunkDistance(v.trunk, p.x, p.y, p.z);
      assert.ok(d > r, `${where}: outside the trunk (${d.toFixed(3)} m from its axis, radius ${r.toFixed(3)})`);
      assert.ok(box.containsPoint(new THREE.Vector3(p.x, p.y, p.z)), `${where}: inside the tree's bounds`);
      // among the leaves: cards all round it
      const near = cards.filter((c) => Math.hypot(c[0] - p.x, c[1] - p.y, c[2] - p.z) < 0.6).length;
      assert.ok(near >= (p.tier === 'inner' ? 1 : 3), `${where}: on foliage (${near} cards within 0.6 m)`);
      if (p.tier !== 'inner' && !(kind === 'cedar' && p.tier === 'top')) {
        // on the surface: open air over it, no leaves piled above
        const above = cards.filter((c) => Math.hypot(c[0] - p.x, c[2] - p.z) < 0.3 && c[1] > p.y + 0.25).length;
        assert.equal(above, 0, `${where}: on top of the leaves, not buried in them`);
      }
    }
    // the cedar's spire: the crow grips the top of the leader
    if (kind === 'cedar') {
      const tip = v.trunk.pts[v.trunk.pts.length - 1];
      assert.ok(Math.abs(P.top[0].y - tip[1]) < 0.7, 'cedar: the top perch is at the tip of the spire');
    }
  }
  // world placement: the instance's position, rotation about y and scale, as the forest's instance matrix has them
  const v = buildTree('maple', 11, 1);
  const p = crownPerches(v).outer[0];
  for (const [rot, s] of [[0.7, 1.2], [-2.1, 0.9]]) {
    const t = { x: 12, y: 3, z: -7, s, cos: Math.cos(rot), sin: Math.sin(rot) };
    const wpt = toWorld(t, p);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(12, 3, -7), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(s, s, s));
    const e = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m);
    assert.ok(Math.hypot(e.x - wpt.x, e.y - wpt.y, e.z - wpt.z) < 1e-9, 'perch to world = the instance matrix');
  }
});

// a flock on open flat ground and a threat coming straight at it: the distance of the first take-off, and how fast the
// rest follow
function flushRun(name, n, threat, alarm = 1) {
  const w = standinWorld({ seed: 5, flat: true, trees: 0 });
  w.alarm = alarm;
  const sim = new WildlifeSim(w);
  sim.auto = false;
  const f = sim.addFlock(name, n);
  const sp = SPECIES[name];
  const perches = [];
  for (let i = 0; perches.length < n && i < 500; i++) {
    const a = w.rng() * Math.PI * 2, r = Math.sqrt(w.rng()) * sp.patch * 0.6;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (perches.some((p) => Math.hypot(p.x - x, p.z - z) < sp.spacing)) continue;
    perches.push({ x, y: w.groundAt(x, z), z, kind: 'ground', key: `g${i}` });
  }
  f.settle({ kind: 'ground', x: 0, z: 0 }, perches);
  // let them settle into their life before the threat comes
  for (let i = 0; i < 120; i++) sim.step(1 / 60);
  w.threats.push(threat);
  let first = null, last = null;
  const left = new Set();
  for (let i = 0; i < 60 * 40 && left.size < n; i++) {
    threat.step(1 / 60, w.groundAt);
    sim.step(1 / 60);
    for (const b of f.members) {
      if (b.mode !== 'perch' && !left.has(b)) {
        left.add(b);
        const d = Math.hypot(b.fx - threat.x, b.fz - threat.z);
        if (!first) first = { t: sim.time, d, alarm: b.alarmed, threat: { x: threat.x, z: threat.z } };
        last = { t: sim.time, d };
      }
    }
  }
  const flushes = w.events.filter((e) => e.type === 'wildlife:flush');
  // where the flock fled to (its new area) and where the birds are bound
  const dests = f.members.filter((b) => b.dest).map((b) => b.dest);
  return { first, last, left: left.size, flushes, area: f.area, dests };
}

test('flush: flight-initiation distances by species and threat; one startled bird sets the flock off at once', () => {
  // sparrows: 5–8 m from a walker coming straight at them; the whole flock within ~0.6 s
  const sp = flushRun('sparrow', 15, mover(0, -30, 0, 0, 1.6));
  assert.ok(sp.first && sp.first.alarm, 'the sparrows flee');
  assert.ok(sp.first.d >= 5 && sp.first.d <= 8, `sparrow FID from a walker ${sp.first.d.toFixed(1)} m`);
  assert.equal(sp.left, 15, 'every sparrow went');
  assert.ok(sp.last.t - sp.first.t < 0.6, `the flock left within ${(sp.last.t - sp.first.t).toFixed(2)} s`);
  assert.equal(sp.flushes.length, 1, 'one flush event');
  assert.equal(sp.flushes[0].detail.count, 15);
  assert.equal(sp.flushes[0].detail.species, 'sparrow');
  // they flee away from him, not back past him
  assert.ok(sp.dests.length > 0 && sp.dests.every((d) => awayFrom(0, 0, sp.first.threat, d.x, d.z)), 'the sparrows head away from the walker');
  // crows: 8–12 m from a walker, farther from a runner, farther still from a galloping horse or in a fight
  const walk = flushRun('crow', 4, mover(0, -40, 0, 0, 1.6));
  const run = flushRun('crow', 4, mover(0, -60, 0, 0, 5.0));
  const gallop = flushRun('crow', 4, mover(0, -90, 0, 0, 13.5, 1.2));
  const fight = flushRun('crow', 4, mover(0, -40, 0, 0, 1.6), 1.8);
  assert.ok(walk.first.d >= 8 && walk.first.d <= 12, `crow FID from a walker ${walk.first.d.toFixed(1)} m`);
  assert.ok(run.first.d > walk.first.d + 2, `farther from a runner (${run.first.d.toFixed(1)} m)`);
  assert.ok(gallop.first.d > run.first.d + 5, `farther from a galloping horse (${gallop.first.d.toFixed(1)} m)`);
  assert.ok(fight.first.d > walk.first.d * 1.5, `farther in a fight (${fight.first.d.toFixed(1)} m)`);
  assert.equal(walk.left, 4);
  assert.ok(walk.last.t - walk.first.t < 0.9, `the crows left together (${(walk.last.t - walk.first.t).toFixed(2)} s)`);
  assert.ok(walk.dests.length > 0 && walk.dests.every((d) => awayFrom(0, 0, walk.first.threat, d.x, d.z)), 'the crows head away from the walker');
  // a crow up a tree lets a walker come closer than one on the ground (height is safety)
  const t = { x: 0, y: 0, z: 0, vx: 0, vz: 1.6, speed: 1.6 };
  const crow = SPECIES.crow;
  assert.ok(threatRatio(crow, 'tree', 0, 12, 7, t) > threatRatio(crow, 'ground', 0, 0, 7, t), 'a crow in a tree is safer than on the ground');
});
