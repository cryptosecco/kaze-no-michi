import * as THREE from 'three';
import { WildlifeSim } from './sim.js';
import { SPECIES, MAMMALS, POPULATION } from './species.js';
import { Island } from './space.js';
import { BirdMesh } from './render.js';
import { BeastMesh } from './beasts.js';

// Ambient wildlife (feature module, src/game/modules.js; ?no=wildlife turns it off). Never installed for the canonical
// shots (?shot=…): their captures stay byte-identical.
//
// Birds of the island around the player, simulated and drawn within ~150 m, by quality (species.js POPULATION):
//   jungle crows   2–6, on treetops, torii beams and the ground (walking, pecking), deep slow beats and glides
//   tree sparrows  8–25, foraging on paths and lawns (hops, pecks), bursting into cover together, bounding flight
//   a black kite   soaring in wide circles high over the fields on fixed wings
// Flight is physics (flight.js), behaviour is sim.js (pure, tested in Node), the island as the birds see it is
// space.js (crowns, ground, torii, sway), drawing is render.js (one InstancedMesh per species, poses in the shader).
// Ground mammals, within ~180 m (mammals.js behaviour, quad.js bodies / gaits / planted feet / leg IK, beasts.js
// skinned instanced meshes):
//   a red fox      patrolling at a trot along paths, field edges and around the shrine hill; pauses, sits, sniffs,
//                  hunts voles with the mousing pounce; bolts from the samurai, looks back, trots off into the woods
//   sika deer      a group of hinds and young (a stag in the rut) grazing at forest edges and in clearings; the alert,
//                  the foot stamp, the alarm whistle, the flight in bounds with the white rump flared
// Threats: the samurai (more frightening running, mounted or with a drawn blade), the horse (galloping: very), the
// bandits; sword fights flush everything nearby. Events: 'wildlife:flush' { x, y, z, species, count } when a flock
// bursts up, 'wildlife:caw' { x, y, z }, 'wildlife:alarm' { x, y, z, species, count } (a deer's whistle, a fox's
// bark), 'wildlife:stamp' (the audio module plays wing flutters, caws, the whistle and the bark).
// CPU: game.stats().wildlifeMs / wildlifeMsMax (simulation + posing + instance upload per frame), birds and mammals
// (drawn).
//
// Public API (game.modules.wildlife): { sim, island, threats, meshes, beasts, debug }
//
// Adding a species: give it an entry in species.js (SPECIES for a bird, MAMMALS for a ground animal: sizes, speeds,
// group size, flight-initiation distances, quality counts in POPULATION) and a body (render.js for a bird; quad.js +
// beasts.js for a quadruped); a bird flies in a Flock, a mammal lives in a Herd (mammals.js), both spawned by
// WildlifeSim.populate (spawnFlock dispatches on `ground`) through the same services — world.threats + threatRatio()
// (the FID model), world.inView and the out-of-view placement, world.emit for events. The per-frame budget is shared:
// keep the brains' decisions at ~10 Hz.

const ACTIVE = new Set(['play', 'cutscene']);
// m/s of air per unit of the wind field's bend vector (a lull ~1.2 m/s, a gust front ~5 m/s, a guided gust ~9 m/s)
const WIND_MS = 5;

function seeded(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The samurai, the horse and the bandits as threats { x, y, z, vx, vz, speed, scale }: velocities from their motion
// (smoothed), how frightening each one is (scale); loud events (sword fights, a whistle) as noises; the alarm level.
class Threats {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.noises = [];
    this.track = new Map();
    this.alarm = 1;
    this.now = 0;
    const loud = (r) => (e) => {
      const d = (e && e.detail) || {};
      const a = d.target || d.actor || d.attacker;
      if (a && a.position) this.noises.push({ x: a.position.x, z: a.position.z, r, t: this.now });
    };
    game.on('hit', loud(30));
    game.on('guardbreak', loud(30));
    game.on('horse:neigh', loud(12));
    game.on('horse:whistle', () => {
      const p = game.player;
      if (p) this.noises.push({ x: p.position.x, z: p.position.z, r: 20, t: this.now });
    });
  }

  update(dt, now) {
    this.now = now;
    this.list.length = 0;
    const g = this.game;
    const act = g.modules && typeof g.modules.actors === 'object' ? g.modules.actors : null;
    const p = g.player;
    if (p && p.root && p.root.visible && p.alive !== false) {
      const drawn = !!(act && act.pc && act.pc.f && act.pc.f.drawn);
      // a rider is a horse with a man on it: bigger than either
      this.add(p, p.position, p.mounted ? 1.3 : drawn ? 1.15 : 1, dt);
    }
    const horse = act && act.horse && act.horse.horse;
    if (horse && horse.root && horse.root.visible && !horse.ridden && !(p && p.mounted)) this.add(horse, horse.position, (v) => (v < 0.7 ? 0.5 : 1.2), dt);
    if (act && act.bandits) for (const b of act.bandits) if (b.alive && b.root.visible) this.add(b, b.position, 0.95, dt);
    // noises fade after half a second (same array: the simulation holds it)
    let k = 0;
    for (const n of this.noises) if (now - n.t < 0.6) this.noises[k++] = n;
    this.noises.length = k;
    this.alarm = act && act.combat && act.combat.inCombat ? 1.6 : 1;
  }

  add(obj, pos, scale, dt) {
    let s = this.track.get(obj);
    if (!s) this.track.set(obj, (s = { x: pos.x, z: pos.z, vx: 0, vz: 0 }));
    if (dt > 0) {
      const dx = pos.x - s.x, dz = pos.z - s.z;
      // a jump faster than anything on the island runs (a respawn, a mount, a placed actor): no speed from it
      const lim = Math.max(1, 25 * dt);
      if (dx * dx + dz * dz > lim * lim) s.vx = s.vz = 0;
      else {
        const k = 1 - Math.exp(-dt / 0.15);
        s.vx += (dx / dt - s.vx) * k;
        s.vz += (dz / dt - s.vz) * k;
      }
      s.x = pos.x;
      s.z = pos.z;
    }
    const speed = Math.hypot(s.vx, s.vz);
    this.list.push({ x: pos.x, y: pos.y, z: pos.z, vx: s.vx, vz: s.vz, speed, scale: typeof scale === 'function' ? scale(speed) : scale });
  }
}

export async function install(game, ctx) {
  if (ctx && ctx.shot) return null;
  const t0 = performance.now();
  const rng = seeded((game.seed || 1234) * 7 + 3);
  const island = new Island(game, { rng });
  const threats = new Threats(game);
  const cam = game.camera;
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sph = new THREE.Sphere(new THREE.Vector3(), 1.5);
  const v2 = new THREE.Vector2();
  const world = {
    time: 0,
    rng,
    center: { x: 0, z: 0 },
    threats: threats.list,
    noises: threats.noises,
    alarm: 1,
    groundAt: (x, z) => game.groundAt(x, z),
    groundOK: (x, z) => island.groundOK(x, z),
    wind(x, y, z, out) {
      game.wind.sample(x, z, v2);
      out.x = v2.x * WIND_MS;
      out.y = 0;
      out.z = v2.y * WIND_MS;
      return out;
    },
    obstacleTop: (x, z) => island.obstacleTop(x, z),
    findTree: (sp, x, z, o) => island.findTree(sp, x, z, o),
    findGround: (sp, x, z, o) => island.findGround(sp, x, z, o),
    findProp: (sp, x, z, o) => island.findProp(sp, x, z, o),
    sway: (perch, out) => island.sway(perch, out),
    // the mammals' island (space.js)
    walkable: (x, z, sp) => island.walkable(x, z, sp),
    cover: (x, z, kind) => island.cover(x, z, kind),
    findHabitat: (sp, x, z, o) => island.findHabitat(sp, x, z, o),
    findCover: (sp, x, z, o) => island.findCover(sp, x, z, o),
    camera: { x: 0, y: 0, z: 0 },
    // on screen (a spawn never pops up in view); far birds are specks anyway (a deer is seen from farther: `far`)
    inView(x, y, z, far = 130) {
      const dx = x - cam.position.x, dz = z - cam.position.z;
      if (dx * dx + dz * dz > far * far) return false;
      sph.center.set(x, y, z);
      return frustum.intersectsSphere(sph);
    },
    emit(type, d) {
      game.emit(type, { x: d.x, y: d.y, z: d.z, species: d.species, count: d.count });
    },
  };
  const sim = new WildlifeSim(world, { quality: game.quality.name, population: POPULATION });
  const meshes = {};
  const MAX = { crow: 32, sparrow: 84, kite: 2 };
  for (const name of Object.keys(SPECIES)) {
    meshes[name] = new BirdMesh(name, MAX[name] || 16);
    game.add(meshes[name].mesh);
  }
  const groups = Object.fromEntries(Object.keys(SPECIES).map((k) => [k, []]));
  // the mammals: one mesh per form (a calf is a scaled hind)
  const beasts = { fox: new BeastMesh('fox', 4), deer: new BeastMesh('deer', 14), stag: new BeastMesh('stag', 4) };
  for (const k in beasts) game.add(beasts[k].mesh);
  const forms = { fox: [], deer: [], stag: [] };

  // ---- per frame: the simulation (sub-steps of ≤ 1/60 s), then the instance buffers --------------------------
  let visible = true; // until the first state change (main.js compiles the shaders with the meshes in the scene)
  let manual = false; // captures step the simulation themselves
  let calm = false; // captures: nothing frightens the animals
  const setVisible = (v) => {
    visible = v;
    for (const k in meshes) meshes[k].mesh.visible = v;
    for (const k in beasts) beasts[k].mesh.visible = v;
  };
  game.on('state', (e) => {
    const s = e.detail && e.detail.state;
    if (ACTIVE.has(s)) setVisible(true);
    else if (s === 'title') setVisible(false);
  });
  // a canonical shot staged in a running session hides the birds (until play resumes)
  game.onShot(() => {
    setVisible(false);
    sim.clear();
  });

  const step = (dt) => {
    const c = game.player && game.player.root ? game.player.position : cam.position;
    world.center.x = c.x;
    world.center.z = c.z;
    world.camera.x = cam.position.x;
    world.camera.y = cam.position.y;
    world.camera.z = cam.position.z;
    island.center = world.center;
    threats.update(dt, sim.time);
    if (calm) threats.list.length = threats.noises.length = 0;
    world.alarm = threats.alarm;
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm, THREE.WebGLCoordinateSystem, cam.reversedDepth);
    const n = Math.min(4, Math.max(1, Math.ceil(dt * 60 - 0.01)));
    for (let i = 0; i < n; i++) sim.step(dt / n);
  };
  let drawn = 0, drawnBeasts = 0, frameNo = 0;
  const bsph = new THREE.Sphere(new THREE.Vector3(), 2);
  const sync = () => {
    frameNo++;
    for (const k in groups) groups[k].length = 0;
    for (const k in forms) forms[k].length = 0;
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm, THREE.WebGLCoordinateSystem, cam.reversedDepth);
    for (const f of sim.flocks) {
      if (f.ground) {
        // a mammal is posed (bones) only when it will be drawn: within reach and on screen (or casting a shadow in)
        for (const m of f.members) {
          const dx = m.x - cam.position.x, dz = m.z - cam.position.z;
          if (dx * dx + dz * dz > 260 * 260) continue;
          bsph.center.set(m.x, m.y, m.z);
          bsph.radius = 2.5 * m.scale;
          if (!frustum.intersectsSphere(bsph) && dx * dx + dz * dz > 30 * 30) continue;
          // far ones are posed every other frame (in turn), near ones every frame
          if (dx * dx + dz * dz < 90 * 90 || !m.out.bones || (frameNo + m.id) % 2 === 0 || manual) m.posed();
          forms[m.form].push(m);
        }
        continue;
      }
      const list = groups[f.sp.name];
      if (list) for (const b of f.members) list.push(b);
    }
    drawn = 0;
    for (const k in meshes) drawn += meshes[k].sync(groups[k], cam.position);
    drawnBeasts = 0;
    for (const k in beasts) drawnBeasts += beasts[k].sync(forms[k], cam.position);
  };
  const perf = { ms: 0, max: 0 };
  game.addSystem({
    frame(dt) {
      const t1 = performance.now();
      if (visible && !manual && dt > 0 && ACTIVE.has(game.state)) step(dt);
      if (visible) sync();
      const ms = performance.now() - t1;
      perf.ms += (ms - perf.ms) * 0.05;
      perf.max = Math.max(perf.max * 0.995, ms);
    },
  });
  game.addStat(() => ({ wildlifeMs: +perf.ms.toFixed(3), wildlifeMsMax: +perf.max.toFixed(3), birds: drawn, mammals: drawnBeasts }));

  // ---- staging for captures and probes (scripts/wildlife/capture.mjs) ---------------------------------------------
  const debug = {
    manual(on = true) {
      manual = !!on;
    },
    step(dt = 1 / 60, n = 1) {
      for (let i = 0; i < n; i++) step(dt);
      sync();
      return sim.time;
    },
    sync,
    clear() {
      sim.clear();
      sync();
    },
    auto(on = true) {
      sim.auto = !!on;
    },
    calm(on = true) {
      calm = !!on;
    },
    show(on = true) {
      setVisible(!!on);
    },
    // a flock on the ground near (x, z) / in a crown / on a torii / in the air
    spawnGround(name, x, z, n, r = 8) {
      const sp = SPECIES[name];
      const t = island.findGround(sp, x, z, { rMin: 0, rMax: r, away: null, count: n });
      if (!t) return null;
      const f = sim.addFlock(name, Math.min(n, t.perches.length));
      f.settle({ kind: 'ground', x: t.x, z: t.z, tx: t.tx, tz: t.tz }, t.perches);
      sync();
      return f;
    },
    spawnTree(name, i, n, tiers) {
      const sp = SPECIES[name];
      const c = island.crown(i);
      const perches = island.treePerches(c, tiers || sp.perchTiers).filter((p) => !sim.claimed(p));
      if (!perches.length) return null;
      const f = sim.addFlock(name, Math.min(n, perches.length));
      f.settle({ kind: 'tree', x: c.x, z: c.z }, perches);
      sync();
      return f;
    },
    spawnFlying(name, n, x, y, z, vx, vz) {
      const f = sim.addFlock(name, n);
      f.members.forEach((b, k) => {
        Object.assign(b, { mode: 'fly', stage: 'cruise', x: x + (k % 3) * 1.5, y: y + (k % 2) * 0.8, z: z + Math.floor(k / 3) * 1.5, vx, vy: 0, vz, hx: vx, hz: vz, fold: 0, legs: 0 });
        b.yaw = Math.atan2(vx, vz);
      });
      f.state = 'moving';
      sync();
      return f;
    },
    // send a flock (or one bird) to these perches; returns how many got a clear approach
    land(f, perches) {
      let k = 0;
      f.members.forEach((b, i) => {
        if (perches[i] && b.setDest(perches[i])) k++;
      });
      f.state = 'moving';
      return k;
    },
    trees(x, z, r, filter = () => true) {
      const out = [];
      const fi0 = Math.floor((x - r) / 32), fi1 = Math.floor((x + r) / 32), fj0 = Math.floor((z - r) / 32), fj1 = Math.floor((z + r) / 32);
      for (let fj = fj0; fj <= fj1; fj++)
        for (let fi = fi0; fi <= fi1; fi++)
          island.forestCell(fi, fj, (c) => {
            const d = Math.hypot(c.x - x, c.z - z);
            if (d <= r && filter(c)) out.push({ i: c.i, x: c.x, y: c.y, z: c.z, d, top: c.top, cx: c.cx, cy: c.cy, cz: c.cz, rh: c.rh, ry: c.ry, kind: c.kind, shrub: c.shrub });
          });
      return out.sort((a, b) => a.d - b.d);
    },
    perches: (i, tiers) => island.treePerches(island.crown(i), tiers).map((p) => ({ x: p.x, y: p.y, z: p.z, tier: p.tier, key: p.key })),
    torii: () => island.props,
    birds() {
      const out = [];
      for (const f of sim.flocks)
        if (!f.ground)
          for (const b of f.members)
            out.push({
              species: f.sp.name, flock: f.id, mode: b.mode, stage: b.stage, act: b.act, x: b.x, y: b.y, z: b.z, fx: b.fx, fy: b.fy, fz: b.fz,
              vx: b.vx, vy: b.vy, vz: b.vz, yaw: b.yaw, pitch: b.pitch, roll: b.roll, fold: b.fold, stroke: b.stroke, effort: b.effort,
              perch: b.perch ? b.perch.kind : null, dest: b.dest ? { x: b.dest.x, y: b.dest.y, z: b.dest.z, kind: b.dest.kind } : null,
            });
      return out;
    },
    // ---- the mammals
    // a group of `n` put down in its habitat near (x, z) (or exactly on `spots` [{ x, z, yaw }])
    spawnHerd(name, x, z, n = 1, r = 40, spots = null, roles = null) {
      const sp = MAMMALS[name];
      if (!spots) {
        const t = island.findHabitat(sp, x, z, { rMin: 0, rMax: r, away: null, count: n });
        if (!t) return null;
        spots = t.spots;
      }
      const h = sim.addHerd(name, spots.slice(0, n), null, roles);
      sync();
      return h;
    },
    mammals() {
      const out = [];
      for (const f of sim.flocks)
        if (f.ground)
          for (const m of f.members) {
            const L = m.loco;
            out.push({
              species: f.sp.name, herd: f.id, role: m.role, form: m.form, state: m.state, sub: m.sub, x: m.x, y: m.y, z: m.z, gy: L.gy, yaw: L.yaw, v: L.v,
              gait: L.g.name, phase: L.phase, standing: L.standing, air: !!L.air, ratio: m.ratio, scale: m.scale,
              legs: L.legs.map((g) => ({ st: g.st, cx: g.cx, cy: g.cy, cz: g.cz, fx: g.fx, fy: g.fy, fz: g.fz })),
            });
          }
      return out;
    },
    // drive one mammal by hand: { state, dur, goal: { x, z } } puts it in a state of its own; { v, mode, yaw, pose,
    // sit, stamp } stages it ('drive': no decisions of its own); { pounce: { dist, height, yaw } } makes it leap
    drive(i, o = {}) {
      const m = sim.mammals[i];
      if (!m) return null;
      if (o.state) m.set(o.state, o.dur || 0);
      if (o.v !== undefined || o.pose || o.mode || o.sit || o.stamp !== undefined) {
        if (m.state !== 'drive') m.set('drive');
        m.driven = { v: o.v || 0, mode: o.mode || null, pose: o.pose || null, yaw: o.yaw, sit: o.sit || 0, stamp: o.stamp, stampAt: o.stampAt };
      }
      if (o.goal !== undefined) m.goal = o.goal;
      if (o.pounce) {
        m.set('mouse');
        m.sub = 'leap';
        m.prey = { x: m.x + Math.sin(o.pounce.yaw) * o.pounce.dist, z: m.z + Math.cos(o.pounce.yaw) * o.pounce.dist, yaw: o.pounce.yaw };
        m.loco.leap({ dist: o.pounce.dist, height: o.pounce.height, yaw: o.pounce.yaw, drop: 0.12, crouchT: 0.42, settle: 1.1 });
      }
      return m.state;
    },
    sim,
    island,
    threats,
    beasts,
  };

  console.info(`[wildlife] ready in ${(performance.now() - t0).toFixed(0)} ms: ${island.statics.length} obstacles, ${[...island.ground.values()].reduce((a, b) => a + b.length, 0)} ground spots, ${island.props.length} torii`);
  return { sim, island, threats, meshes, beasts, debug };
}
