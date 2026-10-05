import { flightStep, trackVelocity, groundSpeedFor, planApproach, approachGuidance, readyForFinal, smooth } from './flight.js';
import { ANIMALS, POPULATION } from './species.js';
import { Herd } from './mammals.js';

// Behaviour of the birds (pure: no three.js, no game; the game is reached through a `world` adapter, see index.js,
// and scripts/wildlife.test.mjs drives the very same code with stand-ins).
//
//   WildlifeSim    the population around a centre (the samurai): flocks spawn out of view within ~150 m, by
//                  quality (one at a time, a couple of place searches per tick), and leave the simulation when they
//                  are far behind; step(dt) runs everything
//   Flock          a group of one species sharing a place and its decisions: settle, relocate now and then, flush
//                  together when one of them is startled (contagion within a fraction of a second), fly to cover
//   Bird           one bird: perched (tree crown, roof / torii beam, ground) with its idle life — head turns,
//                  pecking, walking or hopping, preening, wing flicks, cawing, watching a threat — or taking off
//                  (crouch, leap, climb), cruising (flap-glide, bounding, soaring), landing (approach into the wind,
//                  flare, braking strokes, touch-down at walking pace) on the physics of flight.js
//
// world adapter (all positions in metres, y up):
//   time, rng()                         clock (s) and random source of the simulation
//   center { x, z }                     the population centre (the player, else the camera)
//   groundAt(x, z), groundOK(x, z)      walkable ground height; a spot a bird may stand on (dry, flat, open)
//   wind(x, y, z, out)                  air velocity (m/s) → out { x, y, z }
//   obstacleTop(x, z)                   highest crown / roof at (x, z) (−Infinity where open)
//   findTree(sp, x, z, opts), findGround(sp, x, z, opts), findProp(sp, x, z, opts)   perches (see below)
//   sway(perch, out)                    displacement of a perch on a swaying crown → out { x, y, z }
//   threats [{ x, y, z, vx, vz, speed, scale }]   walkers, riders, horses (scale: how frightening at a given speed)
//   noises [{ x, z, r, t }]             loud events (a sword fight): everything within r takes off
//   alarm                               1 normally, more in a fight nearby
//   inView(x, y, z, far)                is the point on screen within `far` m (spawns never pop up in view)
//   emit(type, detail)                  'wildlife:flush' { x, y, z, species, count }, 'wildlife:caw' { x, y, z }
// The ground mammals (species with `ground`: the fox, the sika deer) live in Herds (mammals.js) kept in `flocks` beside
// the bird flocks, spawned and despawned by the same population management; see mammals.js for their own services.
// A perch: { x, y, z (where the feet go), kind: 'tree' | 'prop' | 'ground', tier, nx, nz (outward / approach hint),
//   yaw (facing, optional), key (unique, for occupancy), tree (sway data, optional) }
// findTree / findProp / findGround return { x, z, perches: [...] } (findGround: also tx, tz, the way the path runs) or
// null. opts: { rMin, rMax (ring around x, z), away: { x, z } | null (the threat), flee (only places away from it),
// count (perches wanted), tiers (crown perches: 'top' | 'outer' | 'inner'), cover (findTree: shrubs and low crowns) }

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));
const range = (rng, a, b) => a + (b - a) * rng();

// Height above the threat counts this much more than ground distance: a crow up a tree lets a walker pass under it
export const HEIGHT_SAFETY = 1.6;

// Is (cx, cz) on the far side of a bird at (x, z) from a threat (within ~75° of the way away from it)? A fleeing flock
// never heads back past the one that scared it (the destination finders filter with it when opts.flee is set).
export function awayFrom(x, z, threat, cx, cz) {
  if (!threat) return true;
  const ex = x - threat.x, ez = z - threat.z, el = Math.hypot(ex, ez);
  const dx = cx - x, dz = cz - z, dl = Math.hypot(dx, dz);
  if (el < 1e-3 || dl < 1e-3) return true;
  return (ex * dx + ez * dz) / (el * dl) > 0.25;
}

// How close a threat is relative to the bird's flight-initiation distance (< 1: flee, < alertK: alert). The distance
// grows with the threat's speed (a runner, a galloping horse), when it comes straight at the bird, with its size
// (scale: a horse) and in a fight (alarm).
export function threatRatio(sp, kind, bx, by, bz, t, alarm = 1) {
  const dx = bx - t.x, dz = bz - t.z, dy = by - t.y;
  const dh = Math.sqrt(dx * dx + dz * dz);
  const up = Math.max(0, dy) * HEIGHT_SAFETY;
  const deff = Math.sqrt(dh * dh + up * up);
  const speed = t.speed || 0;
  const speedMul = Math.min(2.6, 1 + 0.12 * Math.max(0, speed - 1.6));
  const closing = dh > 0.01 ? -(dx * (t.vx || 0) + dz * (t.vz || 0)) / dh : 0;
  const appMul = 1 + 0.25 * clamp(closing / Math.max(1, speed), 0, 1);
  const fid = (sp.fid[kind] || sp.fid.ground) * speedMul * appMul * (t.scale || 1) * alarm;
  return deff / fid;
}

// ------------------------------------------------------------------------------------------------------------ Bird

const PERCH_PITCH = { crow: [0.5, 0.26], sparrow: [0.48, 0.24], kite: [0.5, 0.3] }; // [in a tree / on a beam, on the ground]
const FLARE_PITCH = { crow: 0.95, sparrow: 0.8, kite: 0.9 };

export class Bird {
  constructor(sim, sp, flock, id) {
    const r = sim.rng;
    this.sim = sim;
    this.sp = sp;
    this.A = sp.aero;
    this.flock = flock;
    this.id = id;
    this.scale = 1 + (r() * 2 - 1) * sp.scaleVar;
    this.tint = 0.85 + 0.3 * r();
    // the physics point is the hip joint (the body pivots on it; the feet hang hipH below it when standing)
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.hx = 0;
    this.hz = 1;
    this.mode = 'perch'; // perch | crouch | fly
    this.stage = ''; // fly: climb | cruise | final | circle
    this.modeT = 0;
    this.perch = null;
    this.fx = 0; // feet (on the ground they move as the bird walks or hops)
    this.fy = 0;
    this.fz = 0;
    this.dest = null;
    this.plan = null;
    this.escape = null; // { x, z } unit direction of a flight away from a threat
    this.ctl = { ax: 0, ay: 0, az: 0, flap: 1, folded: false, flare: 0 };
    this.out = { V: 0, CL: 0, effort: 0, bank: 0, gamma: 0, ux: 0, uy: 0, uz: 1 };
    this.w = { x: 0, y: 0, z: 0 };
    this.windT = 0;
    this.safeT = 0;
    this.hSafe = -Infinity;
    // wingbeat oscillator and the flight pattern (flap-glide / bounds / soaring)
    this.phase = r();
    this.freq = sp.flapHz[0];
    this.amp = sp.flapAmp[0];
    this.effort = 0.3;
    this.flapOn = true;
    this.patT = 0;
    this.beats = 0;
    // pose (read by the renderer)
    this.yaw = r() * TAU;
    this.pitch = 0;
    this.roll = 0;
    this.stroke = 0;
    this.hand = 0;
    this.fold = 1;
    this.sweep = 0;
    this.flex = 0;
    this.cup = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.legs = 1;
    this.tailFan = 0;
    this.tailPitch = 0;
    this.step = 0;
    this.lift = 0;
    this.crouch = 0;
    this.headBob = 0;
    // perched life
    this.act = '';
    this.actT = 0;
    this.actDur = 0;
    this.actN = 0;
    this.walkYaw = 0;
    this.headT = 0;
    this.headWant = 0;
    this.pitchOff = 0;
    this.hopT = -1;
    this.hop = null;
    this.stepPh = 0;
    this.alert = 0;
    this.threat = null;
    this.threatT = r() * 0.1;
    this.startle = Infinity;
    this.alarmed = false;
    this.landT = 10;
    this.landPitch = 0;
    this.finalT = 0;
    this.goAroundT = 0;
  }

  get flying() {
    return this.mode === 'fly';
  }

  // Put the bird on a perch at once (spawning, tests)
  placeAt(perch) {
    this.perch = perch;
    this.fx = perch.x;
    this.fy = perch.y;
    this.fz = perch.z;
    this.x = perch.x;
    this.y = perch.y + this.sp.hipH;
    this.z = perch.z;
    this.vx = this.vy = this.vz = 0;
    this.mode = 'perch';
    this.stage = '';
    this.modeT = 0;
    this.dest = null;
    this.plan = null;
    this.fold = 1;
    this.legs = 1;
    this.stroke = this.hand = this.sweep = this.cup = this.tailFan = 0;
    this.roll = 0;
    this.yaw = this.perchYaw(perch);
    this.walkYaw = this.yaw;
    this.pitch = this.basePitch();
    this.landT = 10;
    this.act = '';
    this.startle = Infinity;
    this.startleAlarm = false;
    this.alarmed = false;
    this.sim.claim(perch, this);
  }

  basePitch() {
    const p = PERCH_PITCH[this.sp.name] || PERCH_PITCH.crow;
    return this.perch && this.perch.kind === 'ground' ? p[1] : p[0];
  }

  // a perched bird faces into the wind (feathers smooth), or across its beam
  perchYaw(perch) {
    const w = this.sim.world.wind(perch.x, perch.y, perch.z, this.w);
    let yaw = Math.hypot(w.x, w.z) > 0.3 ? Math.atan2(-w.x, -w.z) : this.yaw;
    if (perch.yaw !== undefined && perch.yaw !== null) {
      // across a beam: whichever side is nearer to facing the wind
      const a = perch.yaw, b = perch.yaw + Math.PI;
      yaw = Math.abs(wrap(a - yaw)) < Math.abs(wrap(b - yaw)) ? a : b;
      return yaw + (this.sim.rng() - 0.5) * 0.3;
    }
    return yaw + (this.sim.rng() - 0.5) * 1.2;
  }

  update(dt) {
    this.modeT += dt;
    if (this.mode === 'perch') this.updatePerch(dt);
    else if (this.mode === 'crouch') this.updateCrouch(dt);
    else this.updateFly(dt);
  }

  // ---------------------------------------------------------------------------------------------- threats
  perchKind() {
    const k = this.perch ? this.perch.kind : 'ground';
    return k === 'prop' ? 'prop' : k === 'tree' ? 'tree' : 'ground';
  }

  checkThreat(dt) {
    this.threatT -= dt;
    if (this.threatT > 0) return;
    this.threatT = 0.1;
    const sim = this.sim, w = sim.world, sp = this.sp;
    let best = Infinity, bt = null;
    const kind = this.perchKind();
    for (const t of w.threats) {
      const r = threatRatio(sp, kind, this.fx, this.fy, this.fz, t, w.alarm || 1);
      if (r < best) {
        best = r;
        bt = t;
      }
    }
    const now = sim.time;
    for (const n of w.noises || []) {
      if (now - n.t > 0.5) continue;
      const d = Math.hypot(this.fx - n.x, this.fz - n.z);
      if (d < n.r * (sp.name === 'crow' ? 1.15 : 1)) {
        best = Math.min(best, 0.5);
        if (!bt) bt = { x: n.x, y: this.fy, z: n.z, vx: 0, vz: 0, speed: 0 };
      }
    }
    this.threat = bt;
    this.alert = best < sp.alertK ? clamp((sp.alertK - best) / (sp.alertK - 1), 0, 1) : 0;
    if (best < 1) this.startleAt(now + (sp.name === 'crow' ? range(sim.rng, 0.08, 0.22) : range(sim.rng, 0.03, 0.12)), true);
  }

  // take off at time t: alarm (a threat: the flock flees) or not (the flock moves on of its own accord)
  startleAt(t, alarm) {
    if (t < this.startle || (alarm && !this.startleAlarm && t <= this.startle + 0.5)) {
      this.startle = Math.min(t, this.startle);
      this.startleAlarm = !!alarm;
    }
  }

  // ---------------------------------------------------------------------------------------------- perched life
  updatePerch(dt) {
    const sim = this.sim, w = sim.world, sp = this.sp, rng = sim.rng;
    this.checkThreat(dt);
    if (sim.time >= this.startle) {
      this.takeoff(this.startleAlarm);
      return;
    }
    this.landT += dt;
    const ground = this.perch.kind === 'ground';
    // the action of the moment
    this.actT += dt;
    if (!this.act || this.actT >= this.actDur || (this.alert > 0.45 && this.act !== 'watch' && this.act !== 'retreat')) this.pickAction();
    // targets of this frame, set by the action
    let headPitch = -0.05, pitchOff = 0, crouch = 0, fold = 1, tailPitch = 0, tailFan = 0, step = 0, lift = 0, headBob = 0;
    const a = this.act, t = this.actT;
    if (a === 'look' || a === 'idle') {
      this.headT -= dt;
      if (this.headT <= 0) {
        this.headT = range(rng, sp.name === 'crow' ? 0.5 : 0.25, sp.name === 'crow' ? 1.8 : 0.9);
        this.headWant = (rng() * 2 - 1) * (a === 'look' ? 1.5 : 0.7);
      }
      headPitch = a === 'look' ? -0.15 : -0.05;
    } else if (a === 'peck') {
      const pk = sp.name === 'crow' ? 0.34 : 0.17;
      const ph = (t % pk) / pk;
      const down = ph < 0.45 ? Math.sin((ph / 0.45) * Math.PI) : 0;
      headPitch = 1.05 * down;
      pitchOff = -0.55 * down - 0.12;
      this.headWant = this.headWant * 0.9;
    } else if (a === 'walk' || a === 'retreat') {
      const speed = sp.walkSpeed * (a === 'retreat' ? 1.7 : 1);
      this.stepPh += dt * sp.stepHz * (a === 'retreat' ? 1.5 : 1) * TAU;
      step = Math.sin(this.stepPh);
      lift = Math.max(0, Math.cos(this.stepPh));
      // walking birds thrust the head forward with each step, then hold it still in space
      headBob = 0.5 + 0.5 * Math.sin(this.stepPh * 2);
      this.headWant *= 0.8;
      this.walkOn(dt, speed);
      pitchOff = -0.05;
    } else if (a === 'hop' || a === 'hopfeed') {
      if (this.hopT < 0) this.hopWait -= dt;
      if (this.hopT < 0 && this.actN > 0 && this.hopWait <= 0) this.startHop(a === 'hop' ? range(rng, 0.35, 0.65) : range(rng, sp.hopLen[0], sp.hopLen[1]), a === 'hop' ? 0.32 : sp.hopTime);
      if (this.hopT >= 0) {
        const hh = this.updateHop(dt);
        fold = a === 'hop' ? 1 - 0.35 * Math.sin(hh * Math.PI) : 1;
        tailPitch = 0.25 * Math.sin(hh * Math.PI);
        crouch = hh < 0.15 ? 0.4 : 0;
      } else if (a === 'hopfeed') {
        // between hops: a peck or two
        const ph = (t % 0.2) / 0.2;
        headPitch = 0.9 * Math.sin(ph * Math.PI) * (this.actN % 2 ? 1 : 0.3);
        pitchOff = -0.3 * Math.sin(ph * Math.PI) * (this.actN % 2 ? 1 : 0.3);
      }
    } else if (a === 'turn') {
      const k = Math.min(1, t / 0.12);
      this.yaw = this.walkYaw0 + wrap(this.walkYaw - this.walkYaw0) * k;
      crouch = t < 0.06 ? 0.3 : 0;
      tailPitch = 0.3 * Math.sin(Math.min(1, t / this.actDur) * Math.PI);
    } else if (a === 'preen') {
      const side = this.actN % 2 ? 1 : -1;
      this.headWant = side * 2.2;
      headPitch = 0.55 + 0.12 * Math.sin(t * 17);
      fold = 0.93 + 0.03 * Math.sin(t * 11);
      crouch = 0.15;
    } else if (a === 'flick') {
      const k = Math.sin(clamp(t / 0.22, 0, 1) * Math.PI);
      fold = 1 - 0.4 * k;
      tailPitch = 0.45 * k;
    } else if (a === 'caw') {
      const per = 0.58;
      const ph = (t % per) / per;
      const bow = Math.sin(clamp(ph / 0.55, 0, 1) * Math.PI);
      pitchOff = -0.3 * bow;
      headPitch = -0.35 * bow;
      tailPitch = 0.35 * bow;
      fold = 1 - 0.12 * bow;
      if (ph < 0.05 && this.actN > 0 && t - this.cawT > per * 0.5) {
        this.cawT = t;
        this.actN--;
        this.sim.emit('wildlife:caw', { x: this.x, y: this.y, z: this.z, bird: this });
      }
    } else if (a === 'shuffle') {
      const k = Math.min(1, t / 0.5);
      this.yaw = this.walkYaw0 + wrap(this.walkYaw - this.walkYaw0) * smooth(0, 1, k);
    } else if (a === 'watch') {
      // head (and, past what the neck allows, the body) toward the threat; neck up, a little crouched
      const th = this.threat;
      if (th) {
        const want = Math.atan2(th.x - this.fx, th.z - this.fz);
        const rel = wrap(want - this.yaw);
        if (Math.abs(rel) > 1.5) this.yaw = ease(this.yaw, this.yaw + rel - Math.sign(rel) * 1.2, 4, dt);
        this.headWant = clamp(wrap(want - this.yaw), -1.6, 1.6);
      }
      headPitch = -0.2;
      crouch = 0.15;
      tailPitch = 0.1 * Math.sin(t * 6);
    }
    // the settle after a landing: legs take up the last of the speed, the wings fold with a little overshoot, the tail
    // closes and the body comes down from its flare
    const lk = this.landT;
    if (lk < 0.6) {
      const k = smooth(0, 0.45, lk);
      fold = Math.min(fold, k + 0.08 * Math.sin(k * Math.PI));
      tailFan = 1 - k;
      crouch = Math.max(crouch, 0.7 * (1 - smooth(0, 0.35, lk)));
      this.cup = (1 - k) * 0.5;
      pitchOff += (this.landPitch - this.basePitch()) * (1 - smooth(0, 0.3, lk));
    } else this.cup = ease(this.cup, 0, 10, dt);
    // smooth the pose toward its targets (head turns are quick saccades)
    this.headYaw = ease(this.headYaw, this.headWant, 22, dt);
    this.headPitch = ease(this.headPitch, headPitch, a === 'peck' || a === 'hopfeed' ? 40 : 14, dt);
    this.pitchOff = ease(this.pitchOff, pitchOff, a === 'peck' ? 30 : 10, dt);
    this.crouch = ease(this.crouch, crouch, 16, dt);
    this.fold = ease(this.fold, fold, 18, dt);
    this.tailPitch = ease(this.tailPitch, tailPitch, 14, dt);
    this.tailFan = ease(this.tailFan, tailFan, 12, dt);
    this.step = ease(this.step, step, 25, dt);
    this.lift = ease(this.lift, lift, 25, dt);
    this.headBob = ease(this.headBob, headBob, 30, dt);
    this.stroke = ease(this.stroke, 0, 12, dt);
    this.hand = ease(this.hand, 0, 12, dt);
    this.sweep = ease(this.sweep, 0, 12, dt);
    this.flex = ease(this.flex, 0, 12, dt);
    this.legs = 1;
    this.roll = ease(this.roll, 0, 10, dt);
    this.pitch = this.basePitch() + this.pitchOff;
    // where the hip is: over the feet (swaying with the crown in a tree), lowered by a crouch
    let hopY = 0;
    if (this.hop && this.hopT >= 0) hopY = this.hop.h * 4 * this.hopK * (1 - this.hopK);
    let sx = 0, sy = 0, sz = 0;
    if (this.perch.tree && w.sway) {
      const s = w.sway(this.perch, this.sw || (this.sw = { x: 0, y: 0, z: 0 }));
      if (s) (sx = s.x), (sy = s.y), (sz = s.z);
    }
    if (ground) this.fy = w.groundAt(this.fx, this.fz);
    this.x = this.fx + sx;
    this.y = this.fy + sy + hopY + sp.hipH * (1 - 0.35 * this.crouch);
    this.z = this.fz + sz;
  }

  pickAction() {
    const sp = this.sp, rng = this.sim.rng, ground = this.perch.kind === 'ground';
    this.actT = 0;
    this.headT = 0;
    this.walkYaw0 = this.yaw;
    if (this.alert > 0.45 && this.threat) {
      // a crow on the ground walks off from a walker coming its way, before it would have to fly
      const th = this.threat;
      const closing = -((this.fx - th.x) * (th.vx || 0) + (this.fz - th.z) * (th.vz || 0)) > 0;
      if (ground && sp.walk === 'walk' && closing && this.alert < 0.85) {
        this.act = 'retreat';
        this.actDur = range(rng, 0.8, 1.6);
        this.walkYaw = Math.atan2(this.fx - th.x, this.fz - th.z) + (rng() - 0.5) * 0.8;
        return;
      }
      this.act = 'watch';
      this.actDur = range(rng, 0.4, 1.2);
      return;
    }
    const W = ground
      ? sp.walk === 'walk'
        ? { walk: 3, peck: 3, look: 2, hop: 0.35, preen: 0.5, flick: 0.4, caw: 0.35 }
        : { hopfeed: 4.5, peck: 2.5, look: 1.5, turn: 1.6, flick: 1 }
      : sp.name === 'crow'
        ? { look: 4, preen: 1.4, flick: 0.8, caw: 1.1, shuffle: 0.8, idle: 1 }
        : { look: 3, preen: 1.2, flick: 1, shuffle: 1, idle: 1 };
    // crows call in bouts: one starts, another may answer, then the flock is quiet for a while
    const f = this.flock, now = this.sim.time;
    if ('caw' in W) W.caw = now < f.cawQuiet ? 0 : W.caw;
    let tot = 0;
    for (const k in W) tot += W[k];
    let r = rng() * tot, pick = 'look';
    for (const k in W) {
      r -= W[k];
      if (r <= 0) {
        pick = k;
        break;
      }
    }
    if (this.answerT && now >= this.answerT && now < this.answerT + 3) pick = 'caw';
    this.answerT = 0;
    if (pick === 'caw') {
      f.cawQuiet = now + range(rng, 14, 40);
      const other = f.members[Math.floor(rng() * f.members.length)];
      if (other !== this && rng() < 0.45) other.answerT = now + range(rng, 1.2, 3);
    }
    this.act = pick;
    switch (pick) {
      case 'look':
      case 'idle':
        this.actDur = range(rng, 0.8, 3);
        break;
      case 'peck':
        this.actN = 1 + Math.floor(rng() * 4);
        this.actDur = this.actN * (sp.name === 'crow' ? 0.34 : 0.17) + range(rng, 0.05, 0.3);
        break;
      case 'walk':
        this.actDur = range(rng, 1.2, 3.5);
        this.walkYaw = this.yaw + (rng() - 0.5) * 2.2;
        break;
      case 'hop':
        this.actN = 1;
        this.actDur = 0.45;
        this.hopWait = 0;
        this.walkYaw = this.yaw + (rng() - 0.5) * 1.6;
        break;
      case 'hopfeed':
        this.actN = 2 + Math.floor(rng() * 4);
        this.actDur = this.actN * 0.36;
        this.hopWait = 0;
        this.walkYaw = this.yaw + (rng() - 0.5) * 1.4;
        break;
      case 'turn':
        this.walkYaw = this.yaw + (rng() < 0.5 ? -1 : 1) * range(rng, 0.8, 2.6);
        this.actDur = 0.25;
        break;
      case 'preen':
        this.actN = Math.floor(rng() * 2);
        this.actDur = range(rng, 1.5, 4);
        break;
      case 'flick':
        this.actDur = 0.3;
        break;
      case 'caw':
        this.actN = 2 + Math.floor(rng() * 2);
        this.cawT = -1;
        this.actDur = this.actN * 0.58 + 0.2;
        break;
      case 'shuffle':
        this.walkYaw = this.yaw + (rng() - 0.5) * 1.4;
        this.actDur = 0.6;
        break;
    }
    // keep foragers inside their patch: head back toward its middle, away from a too-close neighbour
    if (ground && (pick === 'walk' || pick === 'hop' || pick === 'hopfeed' || pick === 'turn')) this.walkYaw = this.steerForage(this.walkYaw);
  }

  steerForage(yaw) {
    const f = this.flock, sp = this.sp;
    const cx = f.area ? f.area.x : this.fx, cz = f.area ? f.area.z : this.fz;
    const dx = this.fx - cx, dz = this.fz - cz, d = Math.hypot(dx, dz);
    if (d > sp.patch * 0.7) yaw = Math.atan2(-dx, -dz) + (this.sim.rng() - 0.5) * 0.9;
    let nx = 0, nz = 0;
    for (const o of f.members) {
      if (o === this || o.mode !== 'perch') continue;
      const ex = this.fx - o.fx, ez = this.fz - o.fz, e = ex * ex + ez * ez;
      if (e < sp.spacing * sp.spacing * 2.2 && e > 1e-8) (nx += ex / e), (nz += ez / e);
    }
    if (nx || nz) {
      const away = Math.atan2(nx, nz);
      yaw = yaw + wrap(away - yaw) * 0.6;
    }
    return yaw;
  }

  walkOn(dt, speed) {
    const w = this.sim.world;
    this.yaw = this.yaw + wrap(this.walkYaw - this.yaw) * Math.min(1, dt * 5);
    const nx = this.fx + Math.sin(this.yaw) * speed * dt, nz = this.fz + Math.cos(this.yaw) * speed * dt;
    if (w.groundOK(nx, nz) && this.roomAt(nx, nz)) {
      this.fx = nx;
      this.fz = nz;
    } else {
      this.walkYaw = this.yaw + Math.PI * (0.6 + 0.4 * this.sim.rng());
    }
  }

  roomAt(x, z) {
    const sp = this.sp;
    for (const o of this.flock.members) {
      if (o === this || o.mode !== 'perch') continue;
      const ex = x - o.fx, ez = z - o.fz;
      if (ex * ex + ez * ez < sp.spacing * sp.spacing * 0.5) {
        // moving away from it is fine
        if (ex * (x - this.fx) + ez * (z - this.fz) <= 0) return false;
      }
    }
    return true;
  }

  startHop(len, dur) {
    this.yaw = this.walkYaw;
    const w = this.sim.world;
    const tx = this.fx + Math.sin(this.yaw) * len, tz = this.fz + Math.cos(this.yaw) * len;
    if (!w.groundOK(tx, tz) || !this.roomAt(tx, tz)) {
      this.walkYaw = this.steerForage(this.yaw + Math.PI * (0.5 + this.sim.rng()));
      this.actN--;
      return;
    }
    this.hop = { x0: this.fx, z0: this.fz, x1: tx, z1: tz, dur, h: this.sp.name === 'crow' ? 0.12 : 0.03 };
    this.hopT = 0;
    this.hopK = 0;
  }

  updateHop(dt) {
    const h = this.hop;
    this.hopT += dt;
    const k = Math.min(1, this.hopT / h.dur);
    this.hopK = k;
    this.fx = h.x0 + (h.x1 - h.x0) * k;
    this.fz = h.z0 + (h.z1 - h.z0) * k;
    if (k >= 1) {
      this.hopT = -1;
      this.hop = null;
      this.actN--;
      // a peck or a look between hops
      this.hopWait = range(this.sim.rng, 0.08, 0.35);
      if (this.act === 'hopfeed') this.walkYaw = this.steerForage(this.walkYaw + (this.sim.rng() - 0.5) * 0.9);
    }
    return k;
  }

  // ---------------------------------------------------------------------------------------------- take-off
  // alarm: a startled bird crouches for an instant only; a relaxed one gathers itself
  takeoff(alarm) {
    const sp = this.sp;
    if (this.mode !== 'perch') return;
    this.mode = 'crouch';
    this.modeT = 0;
    this.crouchDur = alarm ? sp.crouch * 0.6 : sp.crouch * range(this.sim.rng, 1, 1.6);
    this.alarmed = alarm;
    this.hopT = -1;
    this.hop = null;
    if (alarm) this.flock.onAlarm(this, this.threat);
    // a destination: the flock's (it picks one when it moves) or, alone, away from the threat
    if (!this.dest) this.flock.assign(this);
    this.escape = null;
    if (this.threat) {
      const ex = this.fx - this.threat.x, ez = this.fz - this.threat.z, l = Math.hypot(ex, ez) || 1;
      this.escape = { x: ex / l, z: ez / l };
    }
  }

  updateCrouch(dt) {
    const sp = this.sp;
    const k = Math.min(1, this.modeT / this.crouchDur);
    this.crouch = ease(this.crouch, 1, 30, dt);
    this.fold = ease(this.fold, 0.55, 14, dt);
    this.headPitch = ease(this.headPitch, -0.1, 14, dt);
    this.headYaw = ease(this.headYaw, 0, 20, dt);
    this.tailFan = ease(this.tailFan, 0.6, 12, dt);
    // face the way out
    const dir = this.launchDir();
    const want = Math.atan2(dir.x, dir.z);
    this.yaw += wrap(want - this.yaw) * Math.min(1, dt * (this.alarmed ? 22 : 8));
    this.pitch = ease(this.pitch, 0.15, 10, dt);
    if (this.perch && this.perch.kind === 'ground') this.fy = this.sim.world.groundAt(this.fx, this.fz);
    this.y = this.fy + sp.hipH * (1 - 0.35 * this.crouch);
    if (k >= 1) this.leap(dir);
  }

  // horizontal unit direction of the take-off: away from the threat, toward the destination, into the wind
  launchDir() {
    let x = 0, z = 0;
    const w = this.sim.world.wind(this.fx, this.fy, this.fz, this.w);
    const wl = Math.hypot(w.x, w.z);
    if (wl > 0.3) (x -= (w.x / wl) * 0.35), (z -= (w.z / wl) * 0.35);
    if (this.dest) {
      const dx = this.dest.x - this.fx, dz = this.dest.z - this.fz, l = Math.hypot(dx, dz);
      if (l > 0.5) (x += (dx / l) * 0.8), (z += (dz / l) * 0.8);
    }
    if (this.escape) (x += this.escape.x * 1.4), (z += this.escape.z * 1.4);
    const l = Math.hypot(x, z);
    if (l < 1e-3) return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
    return { x: x / l, z: z / l };
  }

  leap(dir) {
    const sp = this.sp;
    const fromGround = !this.perch || this.perch.kind === 'ground';
    const [v, ang] = fromGround ? sp.leap.ground : sp.leap.perch;
    const c = Math.cos(ang), s = Math.sin(ang);
    this.vx = dir.x * v * c;
    this.vy = v * s;
    this.vz = dir.z * v * c;
    this.hx = dir.x;
    this.hz = dir.z;
    this.sim.release(this.perch, this);
    this.perch = null;
    this.mode = 'fly';
    this.stage = 'climb';
    this.modeT = 0;
    this.flapOn = true;
    this.patT = 0;
    this.beats = 0;
    this.effort = 1;
    this.phase = 0.05; // the first stroke is a downstroke from the top
    this.climbDir = dir;
    this.legs = 1;
    this.startle = Infinity;
    this.startleAlarm = false;
    this.alert = 0;
    this.goAroundT = 0;
    this.finalT = 0;
  }

  // ---------------------------------------------------------------------------------------------- flight
  updateFly(dt) {
    const sim = this.sim, w = sim.world, sp = this.sp, c = this.ctl, out = this.out, rng = sim.rng;
    // wind at the bird (refreshed ~10×/s), a little weaker near the ground
    this.windT -= dt;
    if (this.windT <= 0) {
      this.windT = 0.1 + rng() * 0.03;
      w.wind(this.x, this.y, this.z, this.w);
      const agl = this.y - w.groundAt(this.x, this.z);
      const k = clamp(0.55 + 0.45 * (agl / 12), 0.55, 1);
      this.w.x *= k;
      this.w.z *= k;
      this.agl = agl;
    }
    // where to: a destination perch (to its approach gate, then down the approach line) or a circle (kite)
    let flare = 0, stageFlap = 1;
    c.folded = false;
    if (this.stage === 'climb' && (this.modeT > (sp.name === 'crow' ? 1.4 : 0.6) || (this.agl > sp.clear + 1 && this.modeT > 0.4))) this.stage = 'cruise';
    this.goAroundT -= dt;
    if (this.stage === 'cruise' && this.plan && this.goAroundT <= 0 && readyForFinal(this, this.plan)) {
      this.stage = 'final';
      this.finalT = 0;
    }
    if (this.stage === 'circle') this.guideCircle(dt);
    else if (this.stage === 'final' && this.plan) {
      const g = approachGuidance(this, this.plan, sp.approach.flare, c, sp.approach.look, 4, sp.accel * 1.5);
      flare = g.flare;
      this.finalD = g.d;
      this.finalT += dt;
      // touch-down: within a few centimetres, at walking pace (the legs take the rest)
      const v = Math.hypot(this.vx, this.vy, this.vz);
      if ((g.d < 0.05 && v < 0.3) || g.d < 0.012) {
        this.touchDown();
        return;
      }
      if (g.along < -1.5 || (this.finalT > 14 && g.d > 2)) {
        // overshot or stuck: go round, in from another side if there is a clear one
        const np = this.makePlan(this.dest, 0.9 + this.sim.rng() * 1.2);
        if (np.clear) this.plan = np;
        this.stage = 'cruise';
        this.goAroundT = 2.5;
      }
    } else this.guideCruise(dt);
    // flight pattern: when the wings beat
    stageFlap = this.flapPattern(dt);
    c.flap = stageFlap;
    c.folded = this.bound;
    c.flare = flare;
    flightStep(this, this.A, c, this.w, dt, out);
    // never into the ground (the landing target is above it: only the flare comes close)
    const gy = w.groundAt(this.x, this.z) + sp.hipH * 0.6;
    if (this.y < gy) {
      this.y = gy;
      if (this.vy < 0) this.vy = 0;
    }
    this.flightPose(dt, flare);
  }

  // the wanted acceleration toward the gate of the destination's approach (or the destination area), at the cruise
  // height, keeping clear of the ground, the crowns and the roofs ahead (look-ahead along the track)
  guideCruise(dt) {
    const sim = this.sim, w = sim.world, sp = this.sp, c = this.ctl;
    let tx, ty, tz;
    const p = this.plan;
    if (p) {
      tx = p.gx;
      ty = p.gy;
      tz = p.gz;
    } else if (this.dest) {
      tx = this.dest.x;
      tz = this.dest.z;
      ty = this.dest.y + 6;
    } else {
      // nowhere to go: keep on along the escape / current heading
      const h = this.escape || { x: this.hx, z: this.hz };
      tx = this.x + h.x * 50;
      tz = this.z + h.z * 50;
      ty = w.groundAt(tx, tz) + sp.cruiseAGL;
    }
    let dx = tx - this.x, dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-3) (dx /= dist), (dz /= dist);
    else (dx = this.hx), (dz = this.hz);
    // early in the climb the bird keeps to its launch direction
    if (this.stage === 'climb' && this.climbDir) {
      const k = clamp(1 - this.modeT / 1.2, 0, 1) * 0.8;
      dx = dx * (1 - k) + this.climbDir.x * k;
      dz = dz * (1 - k) + this.climbDir.z * k;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
    }
    const Va = sp.cruise * (this.stage === 'climb' ? clamp(0.45 + this.modeT * 0.6, 0.45, 1) : 1);
    let s = groundSpeedFor(dx, dz, Va, this.w.x, this.w.z);
    // ease into the gate (arrive near the plan's top speed, not faster)
    if (p && dist < 12) s = Math.min(s, Math.max(p.vmax * 0.9, 3));
    // height: the target's, the cruise height in transit, and what the look-ahead needs
    this.safeT -= dt;
    if (this.safeT <= 0) {
      this.safeT = 0.12;
      const near = p && dist < p.gate * 1.5;
      const clearG = near ? Math.min(sp.clear + 1, Math.max(0.6, p.gy - w.groundAt(p.gx, p.gz) - 0.4)) : sp.clear + 1.5;
      let hs = -Infinity;
      for (const tau of LOOK) {
        // look ahead along the track, not past the target (the gate: what lies beyond is the approach's business)
        const reach = Math.min(s * tau, dist + 1);
        const lx = this.x + dx * reach, lz = this.z + dz * reach;
        const g = w.groundAt(lx, lz) + clearG;
        let o = w.obstacleTop(lx, lz);
        if (near && p && (lx - p.cx) ** 2 + (lz - p.cz) ** 2 < 4) o = -Infinity; // the target crown itself
        hs = Math.max(hs, g, o + sp.clear);
      }
      this.hSafe = hs;
      this.cruiseH = p || this.dest ? ty : w.groundAt(this.x, this.z) + sp.cruiseAGL;
      if (!p && !this.dest) this.cruiseH = Math.max(this.cruiseH, ty);
    }
    let h = Math.max(this.cruiseH ?? ty, this.hSafe);
    if (this.stage === 'climb') h = Math.max(h, this.y + 2);
    const climbMax = sp.name === 'sparrow' ? 2.8 : 3.4;
    let vy = clamp((h - this.y) * 0.9, -2.5, climbMax);
    this.climbing = h - this.y > 1.5;
    // too steep to clear what is ahead: slow down to climb
    if (h - this.y > 4 && dist > 2) s *= clamp(1 - (h - this.y - 4) * 0.08, 0.5, 1);
    // a target high above and close by: no orbiting under it, the bird slows and climbs to it
    const dh = Math.abs(ty - this.y);
    if (dist < 2 * dh + 3) s = Math.min(s, Math.max(1.2, dist * 0.8));
    let vx = dx * s, vz = dz * s;
    // flockmates: keep a little room (sparrows close, crows apart), less so near the gate, where they all converge
    const sep = this.sp.name === 'crow' ? 2.2 : 0.7;
    const sepK = p ? clamp(dist / (p.gate * 1.5), 0.15, 1) : 1;
    for (const o of this.flock.members) {
      if (o === this || o.mode !== 'fly') continue;
      const ex = this.x - o.x, ey = this.y - o.y, ez = this.z - o.z, e2 = ex * ex + ey * ey + ez * ez;
      if (e2 < sep * sep && e2 > 1e-6) {
        const k = ((sep * sep - e2) / (sep * sep)) * 2.5 * sepK;
        vx += (ex / Math.sqrt(e2)) * k;
        vy += (ey / Math.sqrt(e2)) * k * 0.5;
        vz += (ez / Math.sqrt(e2)) * k;
      }
    }
    trackVelocity(this, vx, vy, vz, 1.6, sp.accel, c);
  }

  // kite: circling on fixed wings in a thermal that drifts with the wind
  guideCircle(dt) {
    const sp = this.sp, c = this.ctl, f = this.flock, w = this.sim.world;
    const cc = f.circle;
    if (!cc) return;
    const rx = this.x - cc.x, rz = this.z - cc.z, r = Math.hypot(rx, rz) || 1;
    const ux = rx / r, uz = rz / r;
    const dir = cc.dir; // +1 counter-clockwise seen from above
    const tx = -uz * dir, tz = ux * dir;
    const v = sp.cruise;
    const radial = (cc.r - r) * 0.35;
    const vx = tx * v + ux * radial, vz = tz * v + uz * radial;
    const ty = w.groundAt(cc.x, cc.z) + cc.agl;
    const vy = clamp((ty - this.y) * 0.25, -1.2, 1.2);
    trackVelocity(this, vx, vy, vz, 1.2, sp.accel, c);
    // the centripetal pull of the circle (a feed-forward: without it the tracker lags into a wider circle)
    const vh = Math.hypot(this.vx, this.vz);
    c.ax -= ux * ((vh * vh) / cc.r);
    c.az -= uz * ((vh * vh) / cc.r);
    // the thermal under the circle lifts the bird (rising air: wind.y)
    const inT = 1 - smooth(cc.r * 0.6, cc.r * 1.8, r);
    this.w.y = 0.85 * inT;
  }

  // when the wings beat: flap-glide (crow), bursts and bounds (sparrow), soaring (kite)
  flapPattern(dt) {
    const sp = this.sp, rng = this.sim.rng, st = this.stage, eff = this.out.effort || 0;
    this.bound = false;
    if (st === 'climb') {
      this.flapOn = true;
      return 1;
    }
    if (st === 'final') {
      // glide in, beat when the wing alone cannot hold the line (and hard in the flare)
      if (this.flapOn ? eff < 0.12 && (this.finalD || 9) > sp.approach.flare * 1.5 : eff > 0.3 || (this.finalD || 9) < sp.approach.flare * 1.2) this.flapOn = !this.flapOn;
      if (sp.pattern === 'bound' && !this.flapOn && (this.finalD || 9) > 2) this.flapOn = true;
      return 1;
    }
    this.patT -= dt;
    if (sp.pattern === 'flapglide') {
      const V = this.out.V || 0;
      if (this.flapOn) {
        if (this.patT <= 0 && V > sp.cruise * 0.9 && this.vy > -0.5 && this.y > this.hSafe - 1 && !this.climbing) {
          this.flapOn = false;
          this.patT = range(rng, sp.glideTime[0], sp.glideTime[1]);
        }
      } else if (this.patT <= 0 || V < sp.cruise * 0.78 || this.y < this.hSafe - 2) {
        this.flapOn = true;
        this.patT = range(rng, sp.flapTime[0], sp.flapTime[1]);
      }
      return this.flapOn ? 1 : 0;
    }
    if (sp.pattern === 'bound') {
      // no bounds while slow or climbing: the wings keep beating
      const slow = (this.out.V || 0) < sp.vStall * 1.2 || this.climbing;
      if (this.flapOn) {
        if (this.beats <= 0 && this.patT <= 0 && !slow) {
          this.flapOn = false;
          this.patT = range(rng, sp.boundTime[0], sp.boundTime[1]);
        }
      } else if (this.patT <= 0 || this.y < this.hSafe - 1.5) {
        this.flapOn = true;
        this.beats = Math.round(range(rng, sp.burstBeats[0], sp.burstBeats[1]));
        this.patT = 0;
      }
      this.bound = !this.flapOn;
      return this.flapOn ? 1 : 0;
    }
    // soaring: fixed wings; a few lazy beats if it sinks well below its circle
    const cc = this.flock.circle;
    const low = cc ? this.y < this.sim.world.groundAt(cc.x, cc.z) + cc.agl - 8 : false;
    this.flapOn = low;
    return low ? 1 : 0;
  }

  // wings, tail, legs and body attitude from the flight state
  flightPose(dt, flare) {
    const sp = this.sp, out = this.out;
    // effort → wingbeat frequency and amplitude (smoothed: no pops between patterns)
    this.effort = ease(this.effort, out.effort, 6, dt);
    const e = clamp(this.effort, 0, 1);
    const fHz = sp.flapHz[0] + (sp.flapHz[1] - sp.flapHz[0]) * e;
    const amp = sp.flapAmp[0] + (sp.flapAmp[1] - sp.flapAmp[0]) * Math.max(e, flare * 0.9);
    this.freq = ease(this.freq, fHz, 8, dt);
    this.amp = ease(this.amp, amp, 8, dt);
    let stroke, hand, fold, sweep, cup, flex;
    if (this.flapOn && !this.bound) {
      const prev = this.phase;
      this.phase = (this.phase + this.freq * dt) % 1;
      if (this.phase < prev) this.beats--;
      // the downstroke takes ~55 % of the beat, the wing spread and the hand trailing a little (the whip); in the
      // upstroke the hand flexes back at the wrist and the wing comes up shortened
      const p = this.phase;
      const q = p < 0.55 ? (p / 0.55) * 0.5 : 0.5 + ((p - 0.55) / 0.45) * 0.5;
      stroke = 0.1 + this.amp * Math.cos(q * TAU);
      hand = 0.3 * this.amp * Math.cos((q - 0.12) * TAU);
      const up = q > 0.5 ? Math.sin((q - 0.5) * 2 * Math.PI) : 0;
      flex = (sp.upFlex[0] + (sp.upFlex[1] - sp.upFlex[0]) * e) * Math.pow(up, 1.2);
      fold = 0;
      sweep = 0.12 * up - 0.06 * (1 - up) - 0.3 * flare;
      cup = 0.35 * flare;
    } else if (this.bound) {
      // a bound: wings shut against the body
      stroke = 0;
      hand = 0;
      fold = 1;
      sweep = 0;
      cup = 0;
      flex = 0;
    } else {
      // gliding: wings held out, a slight dihedral, tips a touch up (the kite's fingers curl up), the hand a little
      // swept for speed
      stroke = sp.name === 'kite' ? 0.09 : 0.07;
      hand = sp.name === 'kite' ? 0.14 : 0.06;
      fold = 0;
      sweep = 0.04 - 0.35 * flare;
      flex = (sp.name === 'kite' ? 0.32 : 0.18) * (1 - flare);
      cup = 0.5 * flare;
    }
    const rate = this.bound || !this.flapOn ? 18 : 60;
    this.stroke = ease(this.stroke, stroke, rate, dt);
    this.hand = ease(this.hand, hand, rate, dt);
    this.fold = ease(this.fold, fold, this.bound ? 30 : rate, dt);
    this.sweep = ease(this.sweep, sweep, rate, dt);
    this.flex = ease(this.flex, flex, rate, dt);
    this.cup = ease(this.cup, cup, 12, dt);
    // legs: dangling for the leap, lowered for the landing
    const legsDown = (this.stage === 'climb' && this.modeT < 0.35) || (this.stage === 'final' && (this.finalD ?? 99) < sp.approach.flare * 2.2);
    this.legs = ease(this.legs, legsDown ? 1 : 0, legsDown ? 10 : 5, dt);
    // tail: fanned in a turn, at low speed and in the flare (a brake and a rudder); twisted with the bank (kite)
    const V = out.V || 0;
    const slow = 1 - smooth(this.sp.vStall * 0.8, this.sp.vStall * 1.4, V);
    this.tailFan = ease(this.tailFan, clamp(Math.max(flare, slow * 0.8, Math.abs(out.bank) * 1.2), 0, 1), 8, dt);
    this.tailPitch = ease(this.tailPitch, -0.5 * flare + 0.15 * slow, 8, dt);
    this.crouch = ease(this.crouch, 0, 10, dt);
    this.headPitch = ease(this.headPitch, -0.05 - 0.15 * flare, 8, dt);
    // head: steady in the air, looking where the bird goes (into a turn)
    this.headYaw = ease(this.headYaw, clamp(out.bank * 0.6, -0.6, 0.6), 6, dt);
    this.step = ease(this.step, 0, 10, dt);
    this.lift = 0;
    this.headBob = 0;
    // attitude: heading of the airspeed (a crab in a crosswind), pitch = climb angle + angle of attack + flare, roll =
    // the bank of the lift
    let wantYaw = this.yaw;
    if (V > 1.5) wantYaw = Math.atan2(out.ux, out.uz);
    else if (this.plan && this.stage === 'final') wantYaw = Math.atan2(this.plan.dx, this.plan.dz);
    else if (Math.hypot(this.vx, this.vz) > 0.3) wantYaw = Math.atan2(this.vx, this.vz);
    this.yaw += wrap(wantYaw - this.yaw) * Math.min(1, dt * 9);
    const aoa = clamp((out.CL || 0) / 4.6, -0.1, 0.4);
    const fp = FLARE_PITCH[sp.name] || 0.9;
    const climbP = this.stage === 'climb' ? 0.2 * (1 - smooth(0.2, 0.9, this.modeT)) : 0;
    // a steep climb is flown nose up, never upright (only the flare stands the body up)
    const wantPitch = Math.min((V > 1.5 ? out.gamma : 0) + aoa + climbP, 0.9) + fp * flare;
    this.pitch = ease(this.pitch, clamp(wantPitch, -0.9, 1.25), 7, dt);
    this.roll = ease(this.roll, clamp(out.bank || 0, -1.2, 1.2), 7, dt);
    this.landPitch = this.pitch;
  }

  touchDown() {
    const d = this.dest;
    this.sim.release(this.dest, null);
    const keep = { pitch: this.pitch, yaw: this.yaw };
    this.placeAt(d);
    // the settle starts from the flare: the pose eases down (Bird.updatePerch)
    this.landT = 0;
    this.landPitch = keep.pitch;
    this.pitch = keep.pitch;
    this.fold = 0.1;
    this.cup = 0.5;
    this.tailFan = 1;
    this.crouch = 0.7;
    // a bird lands facing the way it came in: it turns on the perch afterwards (look / shuffle)
    this.yaw = keep.yaw;
    this.walkYaw = keep.yaw;
    this.y = this.fy + this.sp.hipH * (1 - 0.35 * this.crouch);
    this.flock.onLanded(this);
  }

  // ---------------------------------------------------------------------------------------------- destinations
  // A perch is only taken if a clear approach to it exists (false: the caller offers another one)
  setDest(perch) {
    const plan = perch ? this.makePlan(perch) : null;
    if (perch && !plan.clear) return false;
    if (this.dest && this.dest !== perch) this.sim.release(this.dest, this);
    this.dest = perch;
    if (perch) this.sim.claim(perch, this);
    this.plan = plan;
    if (this.mode === 'fly' && this.stage === 'final') this.stage = 'cruise';
    return true;
  }

  // landing into the wind, along a line clear of crowns and roofs; for a crown's flank the bird comes in from outside.
  // turn: rotate the preferred heading (a go-around tries another side)
  makePlan(perch, turn = 0) {
    const sp = this.sp, w = this.sim.world, ap = sp.approach;
    // the plan of a perch depends on the wind and the place only: shared for a few seconds (a flock lands together)
    const now = this.sim.time;
    if (!turn && perch._plan && perch._planSp === sp && now - perch._planT < 5) return perch._plan;
    const plan = this.findPlan(perch, turn);
    if (!turn) {
      perch._plan = plan;
      perch._planSp = sp;
      perch._planT = now;
    }
    return plan;
  }

  findPlan(perch, turn) {
    const sp = this.sp, w = this.sim.world, ap = sp.approach;
    const wv = w.wind(perch.x, perch.y + 2, perch.z, { x: 0, y: 0, z: 0 });
    const wl = Math.hypot(wv.x, wv.z);
    let ax = wl > 0.4 ? -wv.x / wl : Math.sin(this.yaw), az = wl > 0.4 ? -wv.z / wl : Math.cos(this.yaw);
    if (perch.nx !== undefined && (perch.nx || perch.nz) && perch.tier !== 'top') {
      // come in from the outside of the crown: travel against its outward normal
      ax = ax * 0.35 - perch.nx * 0.65;
      az = az * 0.35 - perch.nz * 0.65;
    }
    const base = Math.atan2(ax, az) + turn;
    const C = { x: perch.x, y: perch.y + sp.hipH, z: perch.z };
    let best = null;
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3, 2.0, -2.0, Math.PI]) {
      const a = base + off;
      const plan = planApproach(C.x, C.y, C.z, Math.sin(a), Math.cos(a), { slope: ap.slope, gate: ap.gate, decel: ap.decel, vmax: sp.cruise });
      plan.clear = this.lineClear(plan, perch);
      if (plan.clear) return plan;
      if (!best) best = plan;
    }
    return best;
  }

  // is the approach line above the ground and the crowns / roofs (but the last metres: the perch's own crown)?
  lineClear(plan, perch) {
    const w = this.sim.world, sp = this.sp;
    const n = Math.max(4, Math.ceil(plan.L / 1.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n; // 0 at the gate, 1 at the target
      const x = plan.gx + (plan.cx - plan.gx) * t, y = plan.gy + (plan.cy - plan.gy) * t, z = plan.gz + (plan.cz - plan.gz) * t;
      const toEnd = (1 - t) * plan.L;
      if (y < w.groundAt(x, z) + sp.hipH * 0.8) return false;
      if (toEnd < (perch.kind === 'tree' ? 2.5 : 1)) continue;
      if (y < w.obstacleTop(x, z) + 0.4) return false;
    }
    return true;
  }
}

const LOOK = [0, 0.6, 1.3, 2.2];

// ------------------------------------------------------------------------------------------------------------ Flock

let FLOCK_ID = 1;

export class Flock {
  constructor(sim, sp, n) {
    this.sim = sim;
    this.sp = sp;
    this.id = FLOCK_ID++;
    this.members = [];
    for (let i = 0; i < n; i++) this.members.push(new Bird(sim, sp, this, sim.nextId++));
    this.state = 'settled'; // settled | moving
    this.area = null; // { kind, x, z, tx, tz (on a path: the way it runs), cover }
    this.restT = range(sim.rng, sp.restTime[0], sp.restTime[1]);
    this.alarmT = -99;
    this.retargetT = -99;
    this.cawQuiet = sim.time + range(sim.rng, 3, 20);
    this.coverT = 0;
    this.pending = []; // perches of the move in progress, handed out to the members as they leave
    this.circle = null;
  }

  get alive() {
    return this.members.length > 0;
  }

  // Settle the flock at once on these perches (spawning)
  settle(area, perches) {
    this.area = area;
    this.state = 'settled';
    this.members.forEach((b, i) => b.placeAt(perches[i % perches.length]));
    for (const b of this.members) {
      b.act = '';
      b.actT = this.sim.rng() * 2;
    }
  }

  update(dt) {
    const sim = this.sim, sp = this.sp;
    if (sp.pattern === 'soar') return this.updateSoar(dt);
    if (this.state === 'settled') {
      const calm = this.members.every((b) => b.mode === 'perch' && b.alert < 0.2);
      if (calm) this.restT -= dt;
      if (this.restT <= 0) this.relocate(false, null);
    } else if (this.state === 'moving') {
      if (this.members.every((b) => b.mode === 'perch')) {
        this.state = 'settled';
        this.restT = range(sim.rng, sp.restTime[0], sp.restTime[1]) * (this.area && this.area.cover ? 0.4 : 1);
      }
    }
    // members heading for a perch that became unsafe (the threat walked up to it), or flying with nowhere to go: the
    // flock looks again (not more than every 1.5 s)
    if (this.state === 'moving' && sim.time - this.retargetT > 1.5) {
      const w = sim.world;
      for (const b of this.members) {
        if (b.mode !== 'fly') continue;
        if (!b.dest) {
          this.retargetT = sim.time;
          this.relocate(true, nearestThreat(w, b.x, b.z), b);
          return;
        }
        for (const t of w.threats) {
          if (threatRatio(sp, b.dest.kind === 'ground' ? 'ground' : 'tree', b.dest.x, b.dest.y, b.dest.z, t, w.alarm || 1) < 1.2) {
            this.retargetT = sim.time;
            this.relocate(true, t, b);
            return;
          }
        }
      }
    }
  }

  // A member took off in alarm: everyone else goes within a fraction of a second (the wave runs through the flock),
  // and the flock flees to cover / far crowns away from the threat.
  onAlarm(bird, threat) {
    const sim = this.sim, now = sim.time, sp = this.sp;
    if (now - this.alarmT > 2.5) {
      this.alarmT = now;
      this.relocate(true, threat, bird);
      sim.emit('wildlife:flush', { x: bird.x, y: bird.y, z: bird.z, species: sp.name, count: this.members.length, flock: this });
    }
    const base = sp.name === 'crow' ? 0.12 : 0.05;
    const per = sp.name === 'crow' ? 0.03 : 0.02;
    const jit = sp.name === 'crow' ? 0.25 : 0.12;
    for (const o of this.members) {
      if (o === bird || o.mode !== 'perch') continue;
      const d = Math.hypot(o.fx - bird.fx, o.fz - bird.fz);
      o.startleAt(now + base + d * per + sim.rng() * jit, true);
      if (!o.threat) o.threat = threat;
    }
    // other flocks of the same kind close by catch the panic too
    for (const f of sim.flocks) {
      if (f === this || f.sp !== sp) continue;
      for (const o of f.members) {
        if (o.mode !== 'perch') continue;
        const d = Math.hypot(o.fx - bird.fx, o.fz - bird.fz);
        if (d < (sp.name === 'crow' ? 25 : 12)) {
          o.startleAt(now + base * 2 + d * per * 1.5 + sim.rng() * jit, true);
          if (!o.threat) o.threat = threat;
        }
      }
    }
  }

  onLanded() {}

  // Choose where the flock goes next and hand the perches out; flying members re-target at once, perched ones take
  // off staggered (alarm: they are already startled; calm: one after the other, over a second or two).
  relocate(alarm, threat, first = null) {
    const sim = this.sim, sp = this.sp, w = sim.world, rng = sim.rng;
    const from = first || this.members[0];
    const fx = from ? (from.mode === 'fly' ? from.x : from.fx) : w.center.x;
    const fz = from ? (from.mode === 'fly' ? from.z : from.fz) : w.center.z;
    const away = threat ? { x: threat.x, z: threat.z } : nearestThreat(w, fx, fz);
    const n = this.members.length;
    let target = null;
    const crow = sp.name === 'crow';
    const inCover = this.area && this.area.cover;
    const order = [];
    if (crow) {
      if (alarm) order.push(['tree', 40, 130], ['prop', 40, 150], ['tree', 25, 160], ['ground', 50, 140]);
      else {
        const r = rng();
        if (r < 0.5) order.push(['tree', 30, 110], ['ground', 30, 100]);
        else if (r < 0.82) order.push(['ground', 25, 100], ['tree', 30, 110]);
        else order.push(['prop', 30, 150], ['tree', 30, 110]);
      }
    } else if (alarm) order.push(['cover', 6, 35], ['cover', 6, 60], ['ground', 25, 60]);
    else if (inCover) order.push(['ground', 6, 35], ['ground', 6, 60], ['cover', 8, 40]);
    else if (rng() < 0.6) order.push(['ground', 5, 28], ['cover', 6, 30]);
    else order.push(['cover', 6, 30], ['ground', 5, 30]);
    for (const [kind, rMin, rMax] of order) {
      const opts = { rMin, rMax, away, flee: !!(alarm && threat), count: n, tiers: kind === 'cover' ? ['inner', 'outer'] : sp.perchTiers, flock: this };
      if (kind === 'tree' || kind === 'cover') target = w.findTree(sp, fx, fz, { ...opts, cover: kind === 'cover' });
      else if (kind === 'prop') target = w.findProp ? w.findProp(sp, fx, fz, opts) : null;
      else target = w.findGround(sp, fx, fz, opts);
      if (target && target.perches && target.perches.length) {
        target.kind = kind;
        break;
      }
      target = null;
    }
    if (!target) {
      // nowhere to go: stay (a calm flock tries again later)
      this.restT = range(rng, 5, 12);
      return false;
    }
    // claimable perches only (others may be taken by a neighbouring flock)
    const free = target.perches.filter((p) => !sim.claimed(p));
    if (!free.length) {
      this.restT = range(rng, 5, 12);
      return false;
    }
    // members nearest the target take the nearest perches; a perch with no clear approach is passed over
    const ms = this.members.slice().sort((a, b) => Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(b.x - target.x, b.z - target.z));
    const pool = free.filter((p) => ms[0].makePlan(p).clear);
    // a calm flock moves only if there is room for all; a fleeing one goes anyway (the others find a place later)
    if (!pool.length || (!alarm && pool.length < n)) {
      this.restT = range(rng, 5, 12);
      return false;
    }
    ms.forEach((b, i) => {
      if (i >= pool.length) {
        if (b.mode === 'fly') b.setDest(null);
        return;
      }
      b.setDest(pool[i]);
      if (b.mode === 'perch' && !alarm) b.startleAt(sim.time + (crow ? range(rng, 0, 2.2) : range(rng, 0, 0.5)) + i * (crow ? 0.25 : 0.03), false);
    });
    this.area = { kind: target.kind, x: target.x, z: target.z, tx: target.tx, tz: target.tz, cover: target.kind === 'cover' };
    this.state = 'moving';
    this.coverT = 0;
    return true;
  }

  // a member about to leave without a destination of its own gets one (the flock decides)
  assign(bird) {
    if (!bird.dest) this.relocate(bird.alarmed, bird.threat, bird);
  }

  // the kite: circles in a thermal that drifts downwind; past the edge of the area it glides to a new one
  updateSoar(dt) {
    const sim = this.sim, w = sim.world, cc = this.circle;
    if (!cc) return;
    const wv = w.wind(cc.x, cc.agl, cc.z, { x: 0, y: 0, z: 0 });
    cc.x += wv.x * 0.25 * dt;
    cc.z += wv.z * 0.25 * dt;
    const d = Math.hypot(cc.x - w.center.x, cc.z - w.center.z);
    if (d > 150) {
      const a = sim.rng() * TAU, r = 40 + sim.rng() * 60;
      cc.x = w.center.x + Math.sin(a) * r;
      cc.z = w.center.z + Math.cos(a) * r;
    }
  }
}

function nearestThreat(w, x, z) {
  let best = null, bd = Infinity;
  for (const t of w.threats) {
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < bd) (bd = d), (best = { x: t.x, z: t.z });
  }
  return best || { x: w.center.x, z: w.center.z };
}

// ------------------------------------------------------------------------------------------------------------ Sim

export class WildlifeSim {
  constructor(world, { quality = 'high', population = POPULATION, species = ANIMALS, seed = 1 } = {}) {
    this.world = world;
    this.species = species;
    this.population = population[quality] || population.high;
    this.flocks = [];
    this.time = 0;
    this.nextId = 1;
    this.occupied = new Map();
    let s = seed >>> 0 || 1;
    this.rng =
      world.rng ||
      (() => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      });
    this.spawnT = 0;
    this.spawnTurn = 0;
    this.lastCenter = null;
    this.first = true;
    this.listeners = [];
    this.auto = true; // population management on (tests and captures stage flocks by hand)
  }

  get birds() {
    const out = [];
    for (const f of this.flocks) if (!f.ground) for (const b of f.members) out.push(b);
    return out;
  }

  // the ground mammals (every member of every herd)
  get mammals() {
    const out = [];
    for (const f of this.flocks) if (f.ground) for (const b of f.members) out.push(b);
    return out;
  }

  emit(type, detail) {
    if (this.world.emit) this.world.emit(type, detail);
  }

  // perch occupancy (two birds never land on the same twig)
  claim(p, bird) {
    if (p && p.key) this.occupied.set(p.key, bird || true);
  }
  release(p, bird) {
    if (p && p.key && (!bird || this.occupied.get(p.key) === bird || this.occupied.get(p.key) === true)) this.occupied.delete(p.key);
  }
  claimed(p) {
    return !!(p && p.key && this.occupied.has(p.key));
  }

  step(dt) {
    this.time += dt;
    this.world.time = this.time;
    if (this.auto) this.populate(dt);
    for (const f of this.flocks) f.update(dt);
    for (const f of this.flocks) for (const b of f.members) b.update(dt);
  }

  // ---------------------------------------------------------------------------------------------- population
  populate(dt) {
    const w = this.world, c = w.center;
    if (this.lastCenter && Math.hypot(c.x - this.lastCenter.x, c.z - this.lastCenter.z) > 120) {
      // a jump (respawn, teleport): start over around the new place
      this.clear();
      this.first = true;
    }
    this.lastCenter = { x: c.x, z: c.z };
    this.spawnT -= dt;
    if (this.spawnT > 0) return;
    this.spawnT = this.first ? 0 : 1 + this.rng();
    // flocks far behind leave the simulation (never in view); a deer is seen from farther than a bird
    for (const f of this.flocks.slice()) {
      const lim = f.ground ? DESPAWN_GROUND : DESPAWN;
      const far = f.members.every((b) => Math.hypot(b.x - c.x, b.z - c.z) > lim && !w.inView(b.x, b.y, b.z, f.ground ? VIEW_GROUND : undefined));
      if (far) this.removeFlock(f);
    }
    const have = (sp) => this.flocks.reduce((n, f) => n + (f.sp === sp), 0);
    if (this.first) {
      // the whole population at once (the start, a teleport: the picture changes anyway)
      this.first = false;
      for (const name in this.population) {
        const sp = this.species[name];
        for (let i = have(sp); i < this.population[name]; i++) if (!this.spawnFlock(sp, true)) break;
      }
      return;
    }
    // once running: one missing flock at a time, the species in turn, and only a few searches per tick (a search can
    // build crown tiles and perches: spread over frames it never shows as a hitch); a miss tries again shortly
    const short = Object.keys(this.population).filter((name) => have(this.species[name]) < this.population[name]);
    if (!short.length) return;
    const name = short[this.spawnTurn++ % short.length];
    if (!this.spawnFlock(this.species[name], false, SPAWN_TRIES)) this.spawnT = 0.25;
  }

  clear() {
    for (const f of this.flocks.slice()) this.removeFlock(f);
  }

  removeFlock(f) {
    for (const b of f.members) {
      this.release(b.perch, b);
      this.release(b.dest, b);
    }
    this.flocks = this.flocks.filter((x) => x !== f);
  }

  // A new flock out of sight: perched in a crown, foraging on the ground or (crows) flying in from afar; the kite
  // circling high up. `tries`: how many place searches it may make (null when they all miss).
  spawnFlock(sp, initial = false, tries = Infinity) {
    if (sp.ground) return this.spawnHerd(sp, initial, tries);
    const w = this.world, c = w.center, rng = this.rng;
    const n = Math.round(range(rng, sp.flock[0], sp.flock[1]));
    const f = new Flock(this, sp, n);
    const rMin = initial ? 25 : 55, rMax = initial ? 130 : 145;
    const hidden = (x, y, z) => initial || !w.inView(x, y, z) || Math.hypot(x - c.x, z - c.z) > 115;
    if (sp.pattern === 'soar') {
      for (let k = 0; k < 8; k++) {
        const a = rng() * TAU, r = range(rng, 40, 120);
        const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
        const agl = range(rng, 55, 85);
        const y = w.groundAt(x, z) + agl;
        if (!initial && w.inView(x, y, z) && r < 90) continue;
        f.circle = { x, z, r: range(rng, 28, 42), agl, dir: rng() < 0.5 ? 1 : -1 };
        const b = f.members[0];
        b.x = x + f.circle.r;
        b.y = y;
        b.z = z;
        b.vx = 0;
        b.vy = 0;
        b.vz = sp.cruise * f.circle.dir;
        b.mode = 'fly';
        b.stage = 'circle';
        b.legs = 0;
        b.fold = 0;
        b.flapOn = false;
        f.state = 'moving';
        this.flocks.push(f);
        return f;
      }
      return null;
    }
    const kinds = sp.name === 'crow' ? (rng() < 0.55 ? ['tree', 'ground', 'arrive'] : rng() < 0.6 ? ['ground', 'tree', 'arrive'] : ['arrive', 'tree', 'ground']) : rng() < 0.7 ? ['ground', 'cover'] : ['cover', 'ground'];
    for (const kind of kinds) {
      for (let k = 0; k < 6; k++) {
        if (tries-- <= 0) return null;
        const a = rng() * TAU, r = range(rng, rMin, rMax);
        const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
        const opts = { rMin: 0, rMax: kind === 'ground' ? 25 : 30, away: { x: c.x, z: c.z }, count: n, tiers: kind === 'cover' ? ['inner', 'outer'] : sp.perchTiers, flock: f, cover: kind === 'cover' };
        if (kind === 'arrive') {
          // crows flying in from beyond the edge to a crown or a field
          const t = (rng() < 0.6 ? w.findTree(sp, x, z, { ...opts, rMax: 40 }) : null) || w.findGround(sp, x, z, { ...opts, rMax: 40 });
          if (!t || !t.perches.length) continue;
          const ang = Math.atan2(t.x - c.x, t.z - c.z) + (rng() - 0.5) * 2;
          const sx = c.x + Math.sin(ang) * 165, sz = c.z + Math.cos(ang) * 165;
          const sy = w.groundAt(sx, sz) + sp.cruiseAGL + 8;
          const free = t.perches.filter((p) => !this.claimed(p) && f.members[0].makePlan(p).clear);
          if (free.length < Math.min(n, 2)) continue;
          f.area = { kind: 'tree', x: t.x, z: t.z };
          f.state = 'moving';
          f.members.forEach((b, i) => {
            b.mode = 'fly';
            b.stage = 'cruise';
            b.x = sx + (rng() - 0.5) * 8;
            b.y = sy + (rng() - 0.5) * 3;
            b.z = sz + (rng() - 0.5) * 8;
            const dx = t.x - sx, dz = t.z - sz, l = Math.hypot(dx, dz) || 1;
            b.vx = (dx / l) * sp.cruise;
            b.vz = (dz / l) * sp.cruise;
            b.vy = 0;
            b.hx = dx / l;
            b.hz = dz / l;
            b.yaw = Math.atan2(dx, dz);
            b.fold = 0;
            b.legs = 0;
            if (i < free.length) b.setDest(free[i]);
          });
          this.flocks.push(f);
          return f;
        }
        const t = kind === 'ground' ? w.findGround(sp, x, z, opts) : w.findTree(sp, x, z, opts);
        if (!t || !t.perches.length) continue;
        if (!hidden(t.x, t.perches[0].y, t.z)) continue;
        if (Math.hypot(t.x - c.x, t.z - c.z) < (initial ? 18 : 40)) continue;
        const free = t.perches.filter((p) => !this.claimed(p));
        if (free.length < Math.min(n, 2)) continue;
        f.settle({ kind, x: t.x, z: t.z, tx: t.tx, tz: t.tz, cover: kind === 'cover' }, free);
        this.flocks.push(f);
        return f;
      }
    }
    return null;
  }

  // A group of ground mammals out of sight, in its habitat (world.findHabitat: forest edges and clearings for the
  // deer; paths, field edges and the shrine's surroundings for the fox), farther out than the birds (a deer in the
  // open is seen from far). `tries`: place searches it may make.
  spawnHerd(sp, initial = false, tries = Infinity) {
    const w = this.world, c = w.center, rng = this.rng;
    if (!w.findHabitat) return null;
    const n = Math.round(range(rng, sp.group[0], sp.group[1]));
    const rMin = initial ? 35 : 70, rMax = initial ? 150 : 175;
    for (let k = 0; k < 6; k++) {
      if (tries-- <= 0) return null;
      const a = rng() * TAU, r = range(rng, rMin, rMax);
      const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
      const t = w.findHabitat(sp, x, z, { rMin: 0, rMax: 35, away: { x: c.x, z: c.z }, count: n });
      if (!t || t.spots.length < n) continue;
      const d = Math.hypot(t.x - c.x, t.z - c.z);
      if (d < (initial ? 30 : 60)) continue;
      // never popping up on screen (nor on its edge: a deer is a metre and more)
      if (!initial && d < 220 && t.spots.some((s) => w.inView(s.x, w.groundAt(s.x, s.z) + 0.6, s.z, VIEW_GROUND))) continue;
      // not on top of another group of its kind
      if (this.flocks.some((f) => f.ground && f.area && Math.hypot(f.area.x - t.x, f.area.z - t.z) < 40)) continue;
      const h = new Herd(this, sp, n);
      h.settle(t, t.spots);
      this.flocks.push(h);
      return h;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------- staging (tests, captures)
  addFlock(name, n) {
    const f = new Flock(this, this.species[name], n);
    this.flocks.push(f);
    return f;
  }

  // a group of mammals put down at once on these spots ({ x, z, yaw? }), with no spawner checks; roles (deer):
  // 'hind' | 'calf' | 'stag' per spot (default: drawn as the spawner does)
  addHerd(name, spots, area = null, roles = null) {
    const sp = this.species[name];
    const h = new Herd(this, sp, spots.length, roles);
    const c = area || spots.reduce((a, s) => ({ x: a.x + s.x / spots.length, z: a.z + s.z / spots.length }), { x: 0, z: 0 });
    h.settle(c, spots);
    this.flocks.push(h);
    return h;
  }
}

const DESPAWN = 175;
const DESPAWN_GROUND = 230;
const VIEW_GROUND = 260; // m: how far inView() looks for a mammal
const SPAWN_TRIES = 2; // place searches per spawner tick once the population runs
