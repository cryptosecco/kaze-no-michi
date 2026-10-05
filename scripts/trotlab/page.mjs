// Trot lab — the page side of the browser capture (capture.mjs imports it into the running game through Vite, so
// 'three' here is the game's own instance). It takes the horse over without changing how it moves: the game loop is
// paused (rendering goes on, the simulation stops) and the horse is stepped here, riderless (horse.ridden = true, want
// set every step) or with the samurai seated through the Riding api, with Math.random seeded while it steps.
//   setup(kaze, opts)   → lab: pause, free the camera, hide the samurai, find the flattest straight run near the spawn
//                         (findRun), set the light, lay the lab grid under the run
//   lab.reset({ rider })   horse at the run's start at speed, settled for opts.settle s (the rider mounted first); every
//                       reset replays the same motion (same start, same seed), so a stride measured once by probe() is
//                       photographed exactly after the next reset
//   lab.probe(n)        step on until n LF touchdowns more (geometry): their times, the period, the last LF contact
//   lab.stepTo(t)       step the horse to time t (s since reset)
//   lab.view(name)      camera for a named view (VIEWS), tracking the horse's root
//   lab.state()         time, contacts from geometry (markers.mjs), lowest-point heights
//   lab.teardown()      grid removed, camera controller back
import * as THREE from 'three';
import { makeProbe, CONTACT_M } from './markers.mjs';
import { contactIntervals, plantedWindow } from './metrics.mjs';

const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// camera views: side / angle (rad, from the horse's left toward its front), distance (m), camera height and aim height
// above the root (m), aim offset along the heading (m), vertical field of view (deg)
// (side views: the horse, nose to tail ~2.3 m, fills ~70 % of a 3:2 frame's width)
export const VIEWS = {
  side_left: { angle: 0, dist: 6.4, h: 1.0, aimH: 0.82, along: 0.25, fov: 21 },
  side_right: { angle: Math.PI, dist: 6.4, h: 1.0, aimH: 0.82, along: 0.25, fov: 21 },
  front34: { angle: Math.PI / 4, dist: 6.8, h: 1.35, aimH: 0.8, along: 0.25, fov: 21 },
  rear34: { angle: -Math.PI / 4, dist: 6.8, h: 1.35, aimH: 0.8, along: 0.15, fov: 21 },
  legs: { angle: 0, dist: 4.0, h: 0.42, aimH: 0.45, along: 0.05, fov: 21 },
  rider: { angle: 0, dist: 8.2, h: 1.25, aimH: 1.15, along: 0.2, fov: 21 },
};

// least-squares plane h = a + b·s + c·o over samples [s, o, h]; → { b, c, r (largest residual) }
function planeFit(pts) {
  const n = pts.length;
  let ms = 0, mo = 0, mh = 0;
  for (const [s, o, h] of pts) (ms += s / n), (mo += o / n), (mh += h / n);
  let ss = 0, oo = 0, so = 0, sh = 0, oh = 0;
  for (const [s, o, h] of pts) {
    const S = s - ms, O = o - mo, Hh = h - mh;
    (ss += S * S), (oo += O * O), (so += S * O), (sh += S * Hh), (oh += O * Hh);
  }
  const det = ss * oo - so * so || 1;
  const b = (sh * oo - oh * so) / det, c = (oh * ss - sh * so) / det;
  let r = 0;
  for (const [s, o, h] of pts) r = Math.max(r, Math.abs(h - (mh + b * (s - ms) + c * (o - mo))));
  return { b, c, r };
}

// Straight runs of `len` m within `radius` m of the spawn, scored by how far the ground strays from a plane: over the
// whole run (3 m wide), and above all over the stretch where the photographed stride is trotted (`zone`, metres from the
// start: after the settling and the stride measurement) 6 m wide, so the grid is seen whole from either side; plus a
// little of the grade. Only headings that put the sun on the side-left camera's side, 25–55° off its axis, and only runs
// the horse accepts (Horse._groundOK: no sea, stairs, buildings or steep slopes) with room for the cameras.
export function findRun(game, horse, { len, sunDir, radius = 200, step = 8, zone = [14, 36], sunOff = [25, 55], centre = [0, 0] }) {
  const H = (x, z) => game.groundAt(x, z);
  const sunAz = Math.atan2(sunDir.z, sunDir.x); // angle of the sun's horizontal direction in the x–z plane
  const heads = [];
  for (const off of [-1, 1]) for (let k = sunOff[0]; k <= sunOff[1]; k += 5) heads.push(-(sunAz + (off * k * Math.PI) / 180)); // the camera side (left) is at angle −yaw
  let best = null;
  for (let cx = centre[0] - radius; cx <= centre[0] + radius; cx += step)
    for (let cz = centre[1] - radius; cz <= centre[1] + radius; cz += step)
      for (const yaw of heads) {
        const fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw);
        const x0 = cx - (fx * len) / 2, z0 = cz - (fz * len) / 2;
        const sample = (s0, s1, ds, offs) => {
          const pts = [];
          for (let s = s0; s <= s1 + 1e-9; s += ds)
            for (const o of offs) {
              const h = H(x0 + fx * s + lx * o, z0 + fz * s + lz * o);
              if (h < 0.5) return null;
              pts.push([s, o, h]);
            }
          return pts;
        };
        const all = sample(0, len, 1, [-1.5, 0, 1.5]);
        if (!all) continue;
        const A = planeFit(all);
        const slope = 5 * Math.abs(A.b) + 5 * Math.abs(A.c);
        if (best && 0.5 * A.r + slope >= best.score) continue;
        const Z = planeFit(sample(zone[0], zone[1], 0.5, [-3, -1.5, 0, 1.5, 3]));
        const score = Z.r + 0.5 * A.r + slope;
        if (best && score >= best.score) continue;
        const r = A.r, b = A.b, c = A.c;
        // the horse's own rules along the line, and the cameras' ground clearance either side
        let ok = true;
        for (let s = 0; s <= len && ok; s += 2) {
          const x = x0 + fx * s, z = z0 + fz * s;
          if (!horse._groundOK(x, z, fx, fz).ok) ok = false;
          const g = H(x, z);
          for (const side of [-1, 1]) {
            if (H(x + lx * 5.6 * side, z + lz * 5.6 * side) > g + 0.6) ok = false;
            if (H(x + lx * 4.3 * side, z + lz * 4.3 * side) > g + 0.25) ok = false;
          }
        }
        if (!ok) continue;
        best = { score, x0, z0, yaw, len, residual: r, zoneResidual: Z.r, grade: b, cross: c, centre: [cx, cz] };
      }
  return best;
}

// The lab grid: lines every 10 cm (thin, dark), 50 cm (yellow) and 1 m (white), draped on the ground under the run, a
// few mm above it; fixed in the world, so a planted hoof visibly stays on the same line.
function makeGrid(game, run, { width = 3, lift = 0.008 } = {}) {
  const H = (x, z) => game.groundAt(x, z);
  const fx = Math.sin(run.yaw), fz = Math.cos(run.yaw), lx = Math.cos(run.yaw), lz = -Math.sin(run.yaw);
  const pos = [], col = [], idx = [];
  const C = { minor: new THREE.Color(0.16, 0.15, 0.14), half: new THREE.Color(1.0, 0.8, 0.2), metre: new THREE.Color(1, 1, 1) };
  // a strip from (s0, o0) to (s1, o1) in run coordinates (along, across), w wide, draped every 0.2 m
  const strip = (s0, o0, s1, o1, w, c) => {
    const L = Math.hypot(s1 - s0, o1 - o0), n = Math.max(1, Math.ceil(L / 0.2));
    const ds = (s1 - s0) / L, dO = (o1 - o0) / L;
    const ps = -dO * (w / 2), po = ds * (w / 2); // perpendicular half width in (s, o)
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n, o = o0 + ((o1 - o0) * i) / n;
      for (const k of [-1, 1]) {
        const S = s + ps * k, O = o + po * k;
        const x = run.x0 + fx * S + lx * O, z = run.z0 + fz * S + lz * O;
        pos.push(x, H(x, z) + lift, z);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  const half = width / 2;
  for (let k = 0; k <= Math.round(run.len * 10); k++) {
    const s = k / 10, m = k % 10 === 0, h = k % 5 === 0;
    strip(s, -half, s, half, m ? 0.022 : h ? 0.014 : 0.006, m ? C.metre : h ? C.half : C.minor);
  }
  for (let k = 0; k <= Math.round(width * 10); k++) {
    const o = -half + k / 10, m = k % 10 === 5, h = k % 5 === 0;
    strip(0, o, run.len, o, m ? 0.022 : h ? 0.014 : 0.006, m ? C.metre : h ? C.half : C.minor);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'trotlab-grid';
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

export async function setup(kaze, opts = {}) {
  const game = kaze.game;
  const o = { hours: 13, speed: 4.0, len: 40, settle: 4, dt: 1 / 240, seed: 1, radius: 'auto', ...opts };
  const api = game.modules.actors && game.modules.actors.horse;
  if (!api || !api.horse) throw new Error('trotlab: no horse in this game (the horse is not installed in ?shot= mode)');
  const horse = api.horse, riding = api.riding, player = game.player;
  game.loop.paused = true;
  game.cameraController = null;
  if (game.freeCam) game.freeCam.enabled = false;
  Object.assign(game.post.params, { letterbox: 0, bars: 0, dofAperture: 0, fade: 0, bw: 0 });
  kaze.setTime(o.hours);
  const sunDir = game.lighting.sunDir.clone();
  // the samurai out of the frame (the riderless passes)
  player.setVisible(false);
  // the run: within o.radius m of the spawn; by default ('auto') within 200 m, and if the ground where the stride is
  // photographed strays more than 10 cm from a plane there, within 400 m (the terrain round the spawn is a rolling field)
  let run = null;
  if (o.radius === 'auto' || o.radius == null) {
    run = findRun(game, horse, { len: o.len, sunDir, radius: 200 });
    if (!run || run.zoneResidual > 0.1) {
      const far = findRun(game, horse, { len: o.len, sunDir, radius: 400, step: 10 });
      if (far && (!run || far.score < run.score)) run = { ...far, nearBest: run && { centre: run.centre, zoneResidual: run.zoneResidual, residual: run.residual } };
    }
  } else run = findRun(game, horse, { len: o.len, sunDir, radius: Number(o.radius) });
  if (!run) throw new Error('trotlab: no straight run found near the spawn');
  run.fromSpawn = Math.hypot(run.centre[0], run.centre[1]);
  const grid = makeGrid(game, run);
  game.add(grid);
  const probe = makeProbe(horse, { contactM: CONTACT_M });
  const groundAt = (x, z) => game.groundAt(x, z);
  const lab = {
    o, run, horse, riding, player, probe, grid,
    t: 0, rider: false, rand: mulberry32(o.seed), hist: [],
    info: { run: { ...run, x0: +run.x0.toFixed(3), z0: +run.z0.toFixed(3) }, hours: o.hours, sun: sunDir.toArray().map((v) => +v.toFixed(4)), speed: o.speed, dt: o.dt, settle: o.settle },
  };

  lab.reset = ({ rider = false } = {}) => {
    lab.rand = mulberry32(o.seed);
    lab.t = 0;
    lab.hist = [];
    lab.rider = rider;
    const h = horse;
    h.place(run.x0, run.z0, run.yaw);
    Object.assign(h, { ridden: true, mode: 'ridden', noPush: true, graze: 0, grazeWant: 0, lookYaw: 0, lookWant: 0, alert: 0, rearW: 0, lean: 0, yawRate: 0, phase: 0, time: 0, snortT: 9, swishT: 3 });
    h.react.kind = null;
    h.tail.forEach((t) => Object.assign(t, { x: 0, y: 0, vx: 0, vy: 0 }));
    h.ear.forEach((e, i) => Object.assign(e, { a: 0, want: 0, t: i ? 2.3 : 1, hold: 0 }));
    h.speed = o.speed;
    if (rider) {
      // the samurai mounts through the Riding api, then the clip layers of the mount are dropped
      player.setVisible(true);
      player.alive = true;
      if (riding.state !== 'off') riding._toFoot();
      riding._beginApproach();
      riding._beginMount();
      riding._seated();
      player.anim.layers = [];
      h.speed = o.speed;
    } else {
      if (riding.state !== 'off') riding._toFoot();
      h.ridden = true;
      h.mode = 'ridden';
      player.setVisible(false);
    }
    const n = Math.round(o.settle / o.dt);
    for (let i = 0; i < n; i++) lab.step(o.dt, false);
    lab.hist = [];
    return lab.state();
  };

  // one step of the horse (and the seated rider) at dt; Math.random seeded meanwhile
  lab.step = (dt, record = true) => {
    const real = Math.random;
    Math.random = lab.rand;
    try {
      horse.want.speed = o.speed;
      horse.want.yaw = run.yaw;
      horse.want.brake = false;
      horse.update(dt);
      if (lab.rider) {
        riding.placeRider();
        player.update(dt, { groundAt, wind: game.wind, time: game.wind.time });
        riding.late();
      }
    } finally {
      Math.random = real;
    }
    lab.t += dt;
    if (record) {
      horse.root.updateMatrixWorld(true);
      const r = probe.sample(groundAt);
      lab.hist.push({ t: lab.t, legs: r.legs.map((L) => ({ lowH: L.lowH, toeH: L.toeH, heelH: L.heelH, contact: L.contact })) });
    }
  };

  lab.stepTo = (t) => {
    while (lab.t < t - 1e-9) lab.step(Math.min(o.dt, t - lab.t));
    horse.root.updateMatrixWorld(true);
    return lab.state();
  };

  // step on until n more LF touchdowns (geometric) have been seen; the last LF contact interval with its planted window
  lab.probe = (n = 3) => {
    const t0 = lab.t;
    const tds = () => {
      const t = lab.hist.map((s) => s.t), h = lab.hist.map((s) => s.legs[0].lowH);
      return contactIntervals(t, h, CONTACT_M).filter((c) => !c.openStart);
    };
    while (tds().length < n + 1 && lab.t - t0 < 10) lab.step(o.dt);
    // and on to the end of that contact and the next touchdown, so its lift-off and breakover are known
    while (lab.t - t0 < 10) {
      const c = tds();
      if (c.length >= n + 2) break;
      lab.step(o.dt);
    }
    const t = lab.hist.map((s) => s.t);
    const iv = tds();
    const T = (iv[iv.length - 1].td - iv[0].td) / (iv.length - 1);
    const last = iv[iv.length - 2];
    const w = plantedWindow(t, lab.hist.map((s) => s.legs[0].toeH), lab.hist.map((s) => s.legs[0].heelH), last, CONTACT_M);
    return { tds: iv.map((c) => c.td), T, last: { td: last.td, lo: last.lo, bo: w.bo, flat: w.flat, nextTd: iv[iv.length - 1].td }, now: lab.t };
  };

  lab.view = (name) => {
    const v = VIEWS[name];
    const cam = game.camera, p = horse.root.position;
    const yaw = horse.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw);
    // direction from the horse to the camera: its left turned toward its front by `angle`
    const dx = lx * Math.cos(v.angle) + fx * Math.sin(v.angle), dz = lz * Math.cos(v.angle) + fz * Math.sin(v.angle);
    const tx = p.x + fx * v.along, tz = p.z + fz * v.along;
    const cx = tx + dx * v.dist, cz = tz + dz * v.dist;
    const cy = Math.max(p.y + v.h, game.groundAt(cx, cz) + 0.3);
    cam.fov = v.fov;
    cam.updateProjectionMatrix();
    cam.position.set(cx, cy, cz);
    cam.lookAt(tx, p.y + v.aimH, tz);
    cam.updateMatrixWorld(true);
    return { name, pos: cam.position.toArray().map((x) => +x.toFixed(3)), fov: v.fov };
  };

  lab.state = () => {
    horse.root.updateMatrixWorld(true);
    const r = probe.sample(groundAt);
    return { t: +lab.t.toFixed(6), contact: r.legs.map((L) => L.contact), lowH: r.legs.map((L) => +(L.lowH * 1000).toFixed(1)), phaseLabel: +horse.phase.toFixed(4), gait: horse.gait.name, speed: +horse.speed.toFixed(3), pos: [horse.root.position.x, horse.root.position.y, horse.root.position.z].map((x) => +x.toFixed(3)) };
  };

  lab.teardown = () => {
    if (grid.parent) grid.parent.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  };
  return lab;
}
