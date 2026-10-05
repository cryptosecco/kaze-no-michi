import { BODIES, Loco, makePose, poseBones } from './quad.js';
import { threatRatio, awayFrom } from './sim.js';

// The ground mammals' behaviour (pure: no three.js; scripts/mammals.test.mjs drives it with the stand-in world).
//
//   Herd     a group of one species sharing a place and its alarms (WildlifeSim keeps it beside the bird flocks: same
//            spawner, same `members` with x / y / z for the out-of-view despawn); the fox is a herd of one
//   Mammal   one animal: a brain deciding at ~10 Hz (perception of the threats, a state machine), steering around
//            what it can't walk through, its locomotion (quad.js Loco: gaits, planted feet) and the pose channels
//            (head, neck, ears, tail, rump) eased toward what the brain wants; poseBones() when it is drawn
//
// The red fox: patrols at a trot (the body a little crabwise, the brush level) along paths and field edges; pauses
//   to look and listen with its ears pricked; sits; sniffs along the ground; hunts voles in the grass: listens with
//   its head cocked, creeps, then the mousing pounce (a high ballistic leap, turned toward the north-north-east as foxes
//   do, landing fore feet first, nose down into the grass) and stays nose down a moment. A threat within alertK × FID
//   stops it (head up, ears forward, facing it); within the FID it bolts at a gallop toward cover (an alarm bark if it
//   was close), stops at a safe distance to look back, then trots off into the woods.
// The sika deer: a group of hinds and young (sometimes a stag in the rut) grazing at a forest edge or in a clearing,
//   head down, stepping a few paces and grazing again; lifting their heads to scan, ears turning. A threat within
//   alertK × FID: the alert posture (head high, ears forward, the tail up, the rump patch half flared, a foot stamp);
//   the alert spreads to the others. Within the FID (or the threat still coming): the alarm whistle and the group bolts
//   together, the white rump patches flared, tails up, the first bounds stotting, then a bounding run into the forest;
//   far enough, they stop, turn to look back, walk on and graze again.
//
// world adapter (besides the birds' services, see sim.js): walkable(x, z, sp) (ground a mammal may step on: dry land,
// not too steep, no floor / stairs / building, clear of trunks and rocks), cover(x, z) (0..1: forest, tall grass),
// findHabitat(sp, x, z, o) → { x, z, kind, spots: [{ x, z }] } (a place for a group in the ring o.rMin..o.rMax, away
// from o.away), findCover(sp, x, z, o) → { x, z } (a refuge in cover, away from o.away), camera { x, y, z } (LOD).
// Events: 'wildlife:alarm' { x, y, z, species, count } (the deer's whistle, the fox's bark), 'wildlife:stamp'.

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));
const range = (rng, a, b) => a + (b - a) * rng();
// foxes jump at their prey mostly toward the north-north-east (Červený et al. 2011); −z is north, +x east here
const POUNCE_AZ = (20 * Math.PI) / 180;

let HERD_ID = 1;

// ------------------------------------------------------------------------------------------------------------ Mammal
export class Mammal {
  constructor(herd, role) {
    const sim = herd.sim, sp = herd.sp, r = sim.rng;
    this.sim = sim;
    this.sp = sp;
    this.herd = herd;
    this.id = sim.nextId++;
    this.role = role; // 'fox' | 'hind' | 'calf' | 'stag'
    this.form = sp.name === 'fox' ? 'fox' : role === 'stag' ? 'stag' : 'deer';
    const base = role === 'calf' ? 0.76 : role === 'stag' ? 1.14 : 1;
    this.scale = base * (1 + (r() * 2 - 1) * sp.scaleVar);
    this.tint = 0.9 + 0.2 * r();
    this.loco = new Loco(BODIES[sp.body], { scale: this.scale });
    this.loco.onStep = (L, stamp) => this.onStep(L, stamp);
    this.ctl = { v: 0, yaw: 0, mode: null, sit: 0, crouch: 0, crabSide: r() < 0.5 ? 1 : -1, accel: sp.accel, decel: sp.decel };
    this.want = makePose();
    this.pose = makePose();
    this.state = '';
    this.stateT = 0;
    this.dur = 0;
    this.goal = null;
    this.look = null; // a point it looks at (null: free looking)
    this.lookT = 0;
    this.threat = null;
    this.ratio = Infinity;
    this.startle = Infinity; // the moment it bolts (an alarm spreading through the group)
    this.thinkT = r() * 0.1;
    this.out = {};
    this.posedAt = -1;
    this.avoidT = 0;
    this.stuck = 0;
    this.sub = ''; // a state's stage (the pounce: listen → crouch → air → pinned)
    this.subT = 0;
    this.barked = false;
  }

  get x() {
    return this.loco.x;
  }
  get z() {
    return this.loco.z;
  }
  get y() {
    return this.loco.gy + this.loco.bodyY;
  }
  get speed() {
    return this.loco.v;
  }

  placeAt(x, z, yaw) {
    this.loco.place(x, z, yaw, this.sim.world.groundAt);
    this.ctl.yaw = yaw;
    this.ctl.v = 0;
  }

  set(state, dur = 0) {
    this.state = state;
    this.stateT = 0;
    this.dur = dur;
    this.sub = '';
    this.subT = 0;
  }

  // ---------------------------------------------------------------------------------------------- per step
  update(dt) {
    const w = this.sim.world;
    this.stateT += dt;
    this.subT += dt;
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT += 0.1;
      // the locomotion's detail by the camera's distance (with a little hysteresis)
      const cam = w.camera;
      if (cam) {
        const d = Math.hypot(this.x - cam.x, this.z - cam.z);
        this.loco.lod = d > (this.loco.lod ? 50 : 60) ? 1 : 0;
      }
      this.perceive();
      // (staged by hand: no decisions of its own)
      if (this.state !== 'drive') {
        if (this.sp.name === 'fox') this.thinkFox();
        else this.thinkDeer();
      }
      this.steer();
    }
    if (this.sim.time >= this.startle) {
      this.startle = Infinity;
      this.bolt(this.herd.fleeFrom || this.threat);
    }
    this.act(dt);
    const ox = this.loco.x, oz = this.loco.z;
    this.loco.step(dt, w.groundAt, this.ctl);
    // never onto ground it may not walk (the sea, a drop, a wall, a trunk): it slides along the edge, or stops
    if (w.walkable && !w.walkable(this.loco.x, this.loco.z, this.sp) && w.walkable(ox, oz, this.sp)) {
      const L = this.loco;
      if (w.walkable(L.x, oz, this.sp)) L.z = oz;
      else if (w.walkable(ox, L.z, this.sp)) L.x = ox;
      else (L.x = ox), (L.z = oz);
      L.v *= 0.6;
      this.blocked = (this.blocked || 0) + 1;
      if (this.blocked > 20 && this.state !== 'flee') this.goal = null;
    } else this.blocked = 0;
    this.easePose(dt);
  }

  // the most frightening threat (ratio < 1: inside the flight distance) and the loud noises
  perceive() {
    const w = this.sim.world, sp = this.sp;
    let best = Infinity, bt = null;
    const gy = this.loco.gy;
    for (const t of w.threats) {
      const r = threatRatio(sp, 'ground', this.x, gy, this.z, t, w.alarm || 1);
      if (r < best) (best = r), (bt = t);
    }
    const now = this.sim.time;
    for (const n of w.noises || []) {
      if (now - n.t > 0.5) continue;
      if (Math.hypot(this.x - n.x, this.z - n.z) < n.r * (sp.hear || 1)) {
        best = Math.min(best, 0.6);
        if (!bt) bt = { x: n.x, y: gy, z: n.z, vx: 0, vz: 0, speed: 0 };
      }
    }
    // a grazing deer, head down, notices later
    const k = this.state === 'graze' ? 1.25 : 1;
    this.ratio = best * (best > 1 ? k : 1);
    this.threat = bt;
  }

  // ---------------------------------------------------------------------------------------------- the fox
  thinkFox() {
    const sp = this.sp, rng = this.sim.rng, r = this.ratio, th = this.threat;
    const st = this.state;
    if (st === 'flee') {
      // run on until well clear of it, then stop to look back
      const far = !th || r > sp.safe;
      if (far && this.stateT > 2.5) {
        this.set('lookback', range(rng, 1.8, 3.6));
        return;
      }
      if (!this.goal || this.near(this.goal, 4)) this.goal = this.fleeGoal(th);
      return;
    }
    if (r < 1 || (r < 1.25 && st === 'lookback')) {
      this.bolt(th);
      return;
    }
    if (this.loco.air) return; // a pounce runs its course
    if (r < sp.alertK && st !== 'alert' && st !== 'lookback' && st !== 'leave') {
      this.set('alert', range(rng, 3, 7));
      return;
    }
    switch (st) {
      case 'alert':
        // watching it, until it comes inside the flight distance (above); now and then a fox slips away at a trot
        // before that, from one coming its way; one keeping away is forgotten after a while
        if (r < 1.4 && th && this.closing(th) && this.slipAway === undefined) this.slipAway = rng() < 0.3;
        if (r < 1.4 && th && this.closing(th) && this.slipAway) {
          this.set('leave', range(rng, 8, 14));
          this.goal = this.fleeGoal(th, 40);
        } else if (r > sp.alertK * 1.1 && this.stateT > this.dur) {
          this.slipAway = undefined;
          this.set('patrol');
        }
        return;
      case 'lookback':
        if (this.stateT > this.dur) {
          this.set('leave', range(rng, 10, 18));
          const c = this.sim.world.findCover ? this.sim.world.findCover(sp, this.x, this.z, { rMin: 15, rMax: 60, away: th ? { x: th.x, z: th.z } : null }) : null;
          this.goal = c || this.fleeGoal(th, 40);
        }
        return;
      case 'leave':
        if (this.stateT > this.dur || (this.goal && this.near(this.goal, 2))) {
          // a new home here: the patrol resumes from where it got to
          this.herd.area = { x: this.x, z: this.z, r: 45 };
          this.set('patrol');
        }
        return;
      case 'patrol':
        if (!this.goal) this.goal = this.patrolGoal();
        if (this.near(this.goal, 1.2) || this.stateT > 40) {
          this.goal = null;
          this.pickFox();
        }
        return;
      case 'pause':
      case 'sit':
      case 'sniff':
        if (this.stateT > this.dur) this.pickFox(st);
        return;
      case 'mouse':
        return; // stages in act()
      default:
        this.set('patrol');
    }
  }

  // what the fox does next (after a leg of its patrol, a pause...)
  pickFox(prev = 'patrol') {
    const rng = this.sim.rng, w = this.sim.world;
    const grass = w.cover ? w.cover(this.x, this.z, 'grass') : 0.5;
    const p = rng();
    if (prev !== 'patrol') {
      this.set('patrol');
      return;
    }
    if (p < 0.33) this.set('pause', range(rng, 1.8, 4.5));
    else if (p < 0.52) this.set('sniff', range(rng, 3, 7));
    else if (p < 0.78 && grass > 0.25) this.startMouse();
    // (a fox sits down on level ground)
    else if (p < 0.88 && Math.abs(this.loco.gPitch) < 0.12) this.set('sit', range(rng, 5, 12));
    else this.set('patrol');
  }

  startMouse() {
    const rng = this.sim.rng;
    this.set('mouse');
    this.sub = 'listen';
    // the vole in the grass a body length or two ahead, the fox turning toward the north-north-east to take it
    const az = POUNCE_AZ + (rng() - 0.5) * 0.7;
    const dx = Math.sin(az), dz = -Math.cos(az);
    const d = range(rng, 1.1, 1.8) * this.scale;
    this.prey = { x: this.x + dx * d, z: this.z + dz * d, yaw: Math.atan2(dx, dz) };
    this.dur = range(rng, 2, 4.5);
  }

  // ---------------------------------------------------------------------------------------------- the deer
  thinkDeer() {
    const sp = this.sp, rng = this.sim.rng, r = this.ratio, th = this.threat, h = this.herd;
    const st = this.state;
    if (st === 'flee') {
      if (!h.flee) return;
      const far = (!th || r > sp.safe) && this.stateT > 3;
      if (far && h.flee.run > 50) {
        this.set('lookback', range(rng, 2.5, 5));
        return;
      }
      return;
    }
    // inside the flight distance: the alarm, the whole group goes
    if (r < 1) {
      h.alarm(this, th);
      return;
    }
    if (st === 'lookback') {
      if (r < 1.3) h.alarm(this, th);
      else if (this.stateT > this.dur) {
        this.set('walk', range(rng, 6, 12));
        this.goal = h.flee && h.flee.target ? h.flee.target : this.wanderGoal(10);
      }
      return;
    }
    if (r < sp.alertK && st !== 'alert') {
      this.set('alert', range(rng, 6, 11));
      this.stampAt = range(rng, 0.6, 2) + (rng() < 0.55 ? 0 : 99);
      h.onAlert(this, th);
      return;
    }
    switch (st) {
      case 'alert':
        // the threat keeps coming within ~1.15 FID: the alarm; far away for a while: back to the grass, watchful
        if (th && r < 1.15 && this.closing(th) && this.stateT > 1.5) h.alarm(this, th);
        else if (r > sp.alertK * 1.05 && this.stateT > this.dur) this.set('scan', range(rng, 2, 4));
        return;
      case 'graze':
        if (this.stateT > this.dur) {
          if (rng() < 0.55) this.set('scan', range(rng, 1.8, 5));
          else {
            this.set('walk', range(rng, 2.5, 6));
            this.goal = this.grazeGoal();
          }
        } else if (this.stepT !== undefined && this.stateT > this.stepT) {
          // a few paces to the next mouthfuls
          this.goal = this.grazeGoal(2.5);
          this.stepT = this.stateT + range(rng, 3, 8);
        }
        return;
      case 'scan':
      case 'vigil':
        if (this.stateT > this.dur) this.startGraze();
        return;
      case 'walk':
        if (this.stateT > this.dur || (this.goal && this.near(this.goal, 0.8))) this.startGraze();
        return;
      default:
        this.startGraze();
    }
  }

  startGraze() {
    const rng = this.sim.rng;
    this.set('graze', range(rng, 6, 18));
    this.goal = null;
    this.stepT = range(rng, 2, 6);
  }

  // ---------------------------------------------------------------------------------------------- shared
  bolt(threat) {
    if (this.sp.name === 'fox') {
      if (this.state !== 'flee') {
        this.set('flee');
        this.slipAway = undefined;
        this.goal = this.fleeGoal(threat);
        // a sharp bark of alarm when startled close (not every time)
        if (this.ratio < 0.75 && !this.barked && this.sim.rng() < 0.6) {
          this.barked = true;
          this.sim.emit('wildlife:alarm', { x: this.x, y: this.y, z: this.z, species: 'fox', count: 1 });
        }
      }
      return;
    }
    this.herd.alarm(this, threat);
  }

  // a point to run to: cover away from the threat, else straight away from it
  fleeGoal(th, dist = 70) {
    const w = this.sim.world, sp = this.sp;
    const away = th ? { x: th.x, z: th.z } : null;
    const c = w.findCover ? w.findCover(sp, this.x, this.z, { rMin: dist * 0.6, rMax: dist * 1.6, away }) : null;
    if (c) return c;
    let ex = 0, ez = 1;
    if (th) {
      ex = this.x - th.x;
      ez = this.z - th.z;
      const l = Math.hypot(ex, ez) || 1;
      ex /= l;
      ez /= l;
    } else {
      ex = Math.sin(this.loco.yaw);
      ez = Math.cos(this.loco.yaw);
    }
    return { x: this.x + ex * dist, z: this.z + ez * dist };
  }

  patrolGoal() {
    const w = this.sim.world, rng = this.sim.rng, a = this.herd.area || { x: this.x, z: this.z, r: 40 };
    // along the patrol: somewhere in its home range, preferring its habitat (paths, edges), not back on itself
    for (let k = 0; k < 8; k++) {
      const ang = this.loco.yaw + (rng() - 0.5) * 2.4;
      const d = range(rng, 12, 35);
      let x = this.x + Math.sin(ang) * d, z = this.z + Math.cos(ang) * d;
      // drawn back toward home
      const hx = a.x - x, hz = a.z - z, hd = Math.hypot(hx, hz);
      if (hd > a.r) (x += hx * 0.5), (z += hz * 0.5);
      if (w.walkable && !w.walkable(x, z, this.sp)) continue;
      return { x, z };
    }
    return { x: a.x + (rng() - 0.5) * 20, z: a.z + (rng() - 0.5) * 20 };
  }

  grazeGoal(r = 6) {
    const w = this.sim.world, rng = this.sim.rng, h = this.herd;
    const a = h.area || { x: this.x, z: this.z, r: 12 };
    for (let k = 0; k < 6; k++) {
      const ang = this.loco.yaw + (rng() - 0.5) * 2.2;
      let x = this.x + Math.sin(ang) * range(rng, r * 0.4, r), z = this.z + Math.cos(ang) * range(rng, r * 0.4, r);
      // the group keeps together: back toward its middle, apart from the others
      const c = h.centre();
      const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz);
      if (d > 7) (x += dx * 0.4), (z += dz * 0.4);
      const ax = a.x - x, az = a.z - z;
      if (Math.hypot(ax, az) > a.r) (x += ax * 0.3), (z += az * 0.3);
      if (w.walkable && !w.walkable(x, z, this.sp)) continue;
      if (h.members.some((o) => o !== this && Math.hypot(o.x - x, o.z - z) < 1.6 * this.scale)) continue;
      return { x, z };
    }
    return null;
  }

  wanderGoal(r) {
    const rng = this.sim.rng;
    const ang = this.loco.yaw + (rng() - 0.5) * 1.5;
    return { x: this.x + Math.sin(ang) * r, z: this.z + Math.cos(ang) * r };
  }

  near(p, d) {
    return Math.hypot(p.x - this.x, p.z - this.z) < d;
  }

  closing(th) {
    const dx = this.x - th.x, dz = this.z - th.z;
    return dx * (th.vx || 0) + dz * (th.vz || 0) > 0.3 * Math.hypot(dx, dz);
  }

  // ---- steering: toward the goal around what can't be walked through (look-ahead probes along candidate headings)
  steer() {
    const w = this.sim.world, L = this.loco;
    if (!this.goal) return;
    const want = Math.atan2(this.goal.x - this.x, this.goal.z - this.z);
    if (!w.walkable) {
      this.ctl.yaw = want;
      return;
    }
    const v = Math.max(1, L.v);
    const reach = [0.8, 1.8, 3.2].map((d) => d * Math.max(this.scale, 0.8) * (0.7 + 0.3 * Math.min(v, 6)));
    let best = null, bc = Infinity;
    for (const off of OFFS) {
      const a = want + off;
      const sa = Math.sin(a), ca = Math.cos(a);
      let ok = true;
      for (const d of reach)
        if (!w.walkable(this.x + sa * d, this.z + ca * d, this.sp)) {
          ok = false;
          break;
        }
      if (!ok) continue;
      // keep near the present heading (no dithering), near the wanted one
      const cost = Math.abs(off) + 0.35 * Math.abs(wrap(a - L.yaw));
      if (cost < bc) (bc = cost), (best = a);
    }
    if (best === null) {
      // boxed in: turn about
      this.stuck++;
      this.ctl.yaw = L.yaw + Math.PI * 0.7;
      if (this.stuck > 30) this.goal = null;
      return;
    }
    this.stuck = 0;
    this.ctl.yaw = best;
  }

  // ---- what the state asks of the body this step (speed, gait mode, posture) and of the head, ears and tail
  act(dt) {
    const sp = this.sp, W = this.want, c = this.ctl, L = this.loco, rng = this.sim.rng;
    const fox = sp.name === 'fox';
    c.mode = null;
    c.sit = 0;
    c.crouch = 0;
    // defaults: relaxed
    W.neck = 0;
    W.graze = 0;
    W.cock = 0;
    W.prick = 0.55;
    W.earBack = 0;
    W.tail = fox ? -0.1 : 0;
    W.tailCurl = 0;
    W.flare = 0;
    let lookAt = null;
    let v = 0;
    const st = this.state;
    if (st === 'patrol') {
      v = sp.speeds.trot * (0.9 + 0.2 * Math.sin(this.id * 7.1));
      W.tail = -0.05; // the brush carried level
      W.prick = 0.6;
    } else if (st === 'pause' || st === 'alert' || st === 'lookback' || st === 'scan' || st === 'vigil') {
      v = 0;
      const th = this.threat;
      if ((st === 'alert' || st === 'lookback') && th) {
        lookAt = th;
        W.prick = 1;
        W.neck = fox ? 0.2 : 0.55;
        W.tail = fox ? -0.1 : 0.35;
        W.flare = fox ? 0 : st === 'alert' ? 0.45 : 0.3;
        // facing it (side-on is enough when looking back over the shoulder)
        const want = Math.atan2(th.x - this.x, th.z - this.z);
        const rel = wrap(want - L.yaw);
        if (Math.abs(rel) > (st === 'lookback' ? 1.3 : 0.6)) c.yaw = L.yaw + rel - Math.sign(rel) * (st === 'lookback' ? 1.1 : 0.35);
        else c.yaw = L.yaw;
        if (!fox && st === 'alert' && this.stateT > this.stampAt) {
          this.stampAt = 99;
          L.stamp(rng() < 0.5 ? 0 : 1);
        }
      } else {
        // looking and listening: the head turning now and then, the ears turning on their own
        this.lookT -= dt;
        if (this.lookT <= 0) {
          this.lookT = range(rng, 0.7, 2.2);
          this.freeLook = (rng() * 2 - 1) * 1.3;
          this.freeLookP = (rng() - 0.3) * 0.25;
          W.earL = (rng() - 0.5) * 0.8;
          W.earR = (rng() - 0.5) * 0.8;
        }
        W.prick = 0.9;
        W.neck = fox ? 0.1 : 0.4;
        c.yaw = L.yaw;
      }
    } else if (st === 'sit') {
      v = 0;
      c.sit = 1;
      c.yaw = L.yaw;
      W.tailCurl = 1;
      W.prick = 0.7;
      W.neck = 0.25;
      this.lookT -= dt;
      if (this.lookT <= 0) {
        this.lookT = range(rng, 1.5, 4);
        this.freeLook = (rng() * 2 - 1) * 1.1;
        this.freeLookP = 0;
      }
    } else if (st === 'sniff') {
      v = sp.speeds.sniff;
      W.graze = 0.8;
      W.prick = 0.4;
      W.tail = -0.2;
      if (!this.goal || this.near(this.goal, 0.6)) this.goal = this.wanderGoal(range(rng, 2, 4));
    } else if (st === 'mouse') {
      v = this.actMouse(dt, W, c);
    } else if (st === 'flee') {
      v = fox ? sp.speeds.run * (this.ratio < 0.8 ? 1.15 : 1) : this.herd.fleeSpeed(this);
      W.earBack = fox ? 0.85 : 0.5;
      W.prick = 0.2;
      W.tail = fox ? 0.0 : 0.95;
      W.flare = fox ? 0 : 1;
      // the head stretched forward into the run
      W.neck = fox ? -0.15 : -0.25;
      if (!fox) c.mode = this.herd.fleeMode(this);
    } else if (st === 'leave') {
      v = sp.speeds.trot * 1.05;
      W.prick = 0.5;
      W.tail = -0.1;
    } else if (st === 'graze') {
      v = this.goal && !this.near(this.goal, 0.4) ? sp.speeds.graze : 0;
      if (!v) this.goal = null;
      W.graze = 1;
      W.prick = 0.35;
      W.tail = 0.05 * Math.sin(this.sim.time * 3 + this.id);
      W.tailSway = Math.sin(this.sim.time * 5.3 + this.id) * 0.4 * (Math.sin(this.sim.time * 0.7 + this.id) > 0.6 ? 1 : 0);
    } else if (st === 'walk') {
      v = sp.speeds.walk;
      W.neck = 0.05;
      W.prick = 0.5;
    } else if (st === 'drive' && this.driven) {
      // staged by hand (captures, tests): this speed, this gait mode, this posture
      const d = this.driven;
      v = d.v || 0;
      c.mode = d.mode || null;
      if (d.sit) c.sit = d.sit;
      if (d.pose) Object.assign(W, d.pose);
      if (d.yaw !== undefined && !this.goal) c.yaw = d.yaw;
      if (d.stamp !== undefined && this.stateT > (d.stampAt || 0.5) && !d.stamped) {
        d.stamped = true;
        L.stamp(d.stamp);
      }
    }
    // a goal it has reached: stop
    if (this.goal && v > 0 && this.near(this.goal, 0.35) && st !== 'flee' && st !== 'drive') v = 0;
    if (!this.goal && st !== 'mouse') v = Math.min(v, st === 'patrol' || st === 'leave' ? v : 0);
    c.v = v * (this.role === 'calf' ? 0.97 : 1);
    if (!this.goal && v === 0 && st !== 'alert' && st !== 'lookback' && st !== 'mouse' && st !== 'drive') c.yaw = L.yaw;
    // the head: toward a point of interest, else free looking (none while grazing or running)
    if (lookAt) {
      const want = Math.atan2(lookAt.x - this.x, lookAt.z - this.z);
      W.lookYaw = clamp(wrap(want - L.yaw), -2, 2);
      W.lookPitch = 0.05;
    } else if (st === 'pause' || st === 'scan' || st === 'sit' || st === 'vigil') {
      W.lookYaw = this.freeLook || 0;
      W.lookPitch = this.freeLookP || 0;
    } else if (st === 'mouse' && this.prey) {
      const want = Math.atan2(this.prey.x - this.x, this.prey.z - this.z);
      W.lookYaw = clamp(wrap(want - L.yaw), -1.5, 1.5);
    } else {
      W.lookYaw = 0;
      W.lookPitch = st === 'flee' ? -0.1 : 0;
      W.earL = W.earR = 0;
    }
  }

  // the mousing hunt: listen (head cocked, ears forward, turned to the prey), a creep, the crouch, the pounce, pinned
  actMouse(dt, W, c) {
    const L = this.loco, rng = this.sim.rng, p = this.prey;
    W.prick = 1;
    W.tail = -0.15;
    if (!p) {
      this.set('patrol');
      return 0;
    }
    const want = p.yaw;
    if (this.sub === 'listen') {
      // turn to it, freeze, head cocked one way then the other, ears forward
      c.yaw = want;
      W.graze = 0.35;
      W.neck = 0.1;
      W.cock = 0.35 * Math.sin(this.subT * 1.7 + this.id);
      W.lookPitch = -0.35;
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      if (this.subT > this.dur && Math.abs(wrap(want - L.yaw)) < 0.25) {
        if (d > 1.9 * this.scale) {
          this.sub = 'creep';
          this.subT = 0;
        } else {
          this.sub = 'leap';
          this.subT = 0;
          const dist = Math.min(2.2 * this.scale, Math.max(0.9 * this.scale, d));
          L.leap({ dist, height: range(rng, 0.65, 0.95) * this.scale, yaw: want, drop: 0.12, crouchT: 0.42, settle: 1.1 });
        }
      }
      return 0;
    }
    if (this.sub === 'creep') {
      c.yaw = want;
      W.graze = 0.3;
      W.cock = 0;
      if (Math.hypot(p.x - this.x, p.z - this.z) < 1.5 * this.scale || this.subT > 3) {
        this.sub = 'listen';
        this.subT = 0;
        this.dur = range(rng, 0.5, 1.2);
      }
      this.goal = { x: p.x, z: p.z };
      return 0.25;
    }
    if (this.sub === 'leap') {
      W.cock = 0;
      if (L.air) {
        // eyes on the spot all the way: the head pitches down into the landing
        W.lookPitch = L.air.t < 0 ? -0.3 : -0.2 - 0.6 * Math.max(0, L.airPhase);
        W.neck = L.air.t < 0 ? 0 : 0.1;
        W.tail = L.air.t < 0 ? -0.2 : 0.5;
        W.prick = 1;
        return 0;
      }
      this.sub = 'pinned';
      this.subT = 0;
      this.dur = range(rng, 1.2, 2.6);
      return 0;
    }
    if (this.sub === 'pinned') {
      // nose down in the grass, the forefeet on it; then up, chewing or not
      W.graze = this.subT < this.dur ? 1 : 0.2;
      W.lookPitch = this.subT < this.dur ? -0.4 : 0;
      W.tail = -0.1;
      if (this.subT > this.dur + 1.2) {
        this.prey = null;
        this.set('patrol');
      }
      return 0;
    }
    return 0;
  }

  easePose(dt) {
    const P = this.pose, W = this.want;
    const run = this.state === 'flee';
    P.lookYaw = ease(P.lookYaw, W.lookYaw, 6, dt);
    P.lookPitch = ease(P.lookPitch, W.lookPitch, 6, dt);
    P.neck = ease(P.neck, W.neck, 4, dt);
    P.graze = ease(P.graze, W.graze, this.loco.air ? 6 : 2.5, dt);
    P.cock = ease(P.cock, W.cock, 5, dt);
    P.prick = ease(P.prick, W.prick, 8, dt);
    P.earBack = ease(P.earBack, W.earBack, 8, dt);
    P.earL = ease(P.earL, W.earL, 7, dt);
    P.earR = ease(P.earR, W.earR, 7, dt);
    P.tail = ease(P.tail, W.tail + (run ? 0 : 0) + (this.sp.name === 'fox' ? -0.6 * this.loco.bob : 0), 6, dt);
    P.tailCurl = ease(P.tailCurl, W.tailCurl, 2.5, dt);
    P.tailSway = ease(P.tailSway, W.tailSway + 0.25 * clamp(-this.loco.w * 0.3, -1, 1), 5, dt);
    P.flare = ease(P.flare, W.flare, W.flare > P.flare ? 9 : 1.2, dt);
  }

  onStep(L, stamp) {
    if (stamp) this.sim.emit('wildlife:stamp', { x: this.x, y: this.loco.gy, z: this.z, species: this.sp.name, count: 1 });
  }

  // the bones, once per frame when drawn (lod 1: a simpler leg pose far from the camera)
  posed() {
    poseBones(this.loco, this.pose, this.out);
    this.posedAt = this.sim.time;
    return this.out;
  }
}

const OFFS = [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.15, -1.15, 1.6, -1.6, 2.2, -2.2, Math.PI];

// ------------------------------------------------------------------------------------------------------------ Herd
export class Herd {
  constructor(sim, sp, n, roles = null) {
    this.sim = sim;
    this.sp = sp;
    this.id = HERD_ID++;
    this.ground = true; // a group of mammals (the bird flocks have no such flag)
    this.members = [];
    const rng = sim.rng;
    if (sp.name === 'fox') this.members.push(new Mammal(this, 'fox'));
    else if (roles) for (const r of roles) this.members.push(new Mammal(this, r));
    else {
      // hinds and the year's calves; in the rut a stag with them now and then
      const stag = n >= 3 && rng() < 0.4;
      const calves = n >= 3 ? 1 + (rng() < 0.4 ? 1 : 0) : 0;
      for (let i = 0; i < n; i++) this.members.push(new Mammal(this, stag && i === 0 ? 'stag' : i >= n - calves ? 'calf' : 'hind'));
    }
    this.area = null; // { x, z, r }: the home range (grazing area, fox's patrol)
    this.alarmT = -99;
    this.flee = null; // { target: { x, z }, from: { x, z }, leader, run, t0 }
    this.fleeFrom = null;
    this.state = 'settled';
  }

  get alive() {
    return this.members.length > 0;
  }

  // put the group down at once (spawning): on these spots, facing around
  settle(area, spots) {
    const rng = this.sim.rng;
    this.area = { x: area.x, z: area.z, r: this.sp.name === 'fox' ? 45 : 14 };
    this.members.forEach((m, i) => {
      const s = spots[i % spots.length];
      m.placeAt(s.x, s.z, s.yaw ?? rng() * TAU);
      if (this.sp.name === 'fox') m.set('patrol');
      else m.startGraze();
      m.stateT = rng() * 4;
    });
  }

  centre() {
    let x = 0, z = 0;
    for (const m of this.members) (x += m.x), (z += m.z);
    const n = this.members.length || 1;
    return { x: x / n, z: z / n };
  }

  update(dt) {
    const f = this.flee;
    if (f) {
      // the run: how far the group has come; it ends when every member has stopped running
      const c = this.centre();
      f.run = Math.hypot(c.x - f.c0.x, c.z - f.c0.z);
      if (this.members.every((m) => m.state !== 'flee')) {
        this.flee = null;
        this.fleeFrom = null;
        this.area = { x: c.x, z: c.z, r: 14 };
      }
    }
  }

  // one of them saw the threat close: it starts the alarm (the whistle) and every other one bolts a moment later
  alarm(by, threat) {
    const sim = this.sim, now = sim.time;
    if (!this.flee) {
      const c = this.centre();
      const away = threat ? { x: threat.x, z: threat.z } : null;
      const w = sim.world;
      const target = (w.findCover && w.findCover(this.sp, c.x, c.z, { rMin: 70, rMax: 170, away })) || by.fleeGoal(threat, 120);
      this.flee = { target, from: away, leader: by, c0: c, run: 0, t0: now };
      this.fleeFrom = threat;
      this.alarmT = now;
      sim.emit('wildlife:alarm', { x: by.x, y: by.y + 0.6 * by.scale, z: by.z, species: this.sp.name, count: this.members.length });
    }
    if (by.state !== 'flee') this.startFlee(by);
    for (const m of this.members) {
      if (m === by || m.state === 'flee') continue;
      const d = Math.hypot(m.x - by.x, m.z - by.z);
      m.startle = Math.min(m.startle, now + 0.12 + d * 0.02 + sim.rng() * 0.3);
      m.threat = m.threat || threat;
    }
  }

  startFlee(m) {
    const rng = this.sim.rng;
    m.set('flee');
    m.goal = this.flee.target;
    // a few stotting bounds first for some (the alarm display), then the bounding run
    m.stottUntil = rng() < 0.45 ? this.sim.time + range(rng, 1.2, 2.4) : 0;
    m.boundUntil = this.sim.time + range(rng, 1.5, 3);
    m.startle = Infinity;
  }

  // the alert of one makes the others look up (they then judge the threat themselves)
  onAlert(by, threat) {
    const rng = this.sim.rng;
    for (const m of this.members) {
      if (m === by || m.state === 'alert' || m.state === 'flee') continue;
      if (m.state === 'graze' || m.state === 'walk') {
        m.set('vigil', range(rng, 3, 6));
        m.freeLook = threat ? wrap(Math.atan2(threat.x - m.x, threat.z - m.z) - m.loco.yaw) * 0.8 : 0;
      }
    }
  }

  fleeSpeed(m) {
    const sp = this.sp, now = this.sim.time;
    if (m.stottUntil > now) return 2.4;
    // the young keep up; the group runs about as one
    return sp.speeds.run * (m.role === 'stag' ? 1.04 : 1) * (0.96 + 0.08 * Math.sin(m.id * 3.3));
  }

  fleeMode(m) {
    const now = this.sim.time;
    if (m.stottUntil > now) return 'stott';
    if (m.boundUntil > now || m.loco.v > 9) return 'bound';
    return null;
  }
}
