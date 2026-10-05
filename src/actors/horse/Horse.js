import * as THREE from 'three';
import { buildHorse, HAIR_UNIFORMS } from './mesh.js';
import { LEG_CHAINS } from './rig.js';
import { gaitAt, makeGait, legPhase } from './gait.js';
import { solveFore, solveHind, makeFore, makeHind, foreReach } from './legIK.js';
import { loadFrac, loadImpulse, fetlockBell, softReach, quintic, peakCurve, knotCurve, foldCurve, scapAngle, tipToReach } from './stride.js';
import { maxTurnRate, approach, bodyCircles, circleContact, onStairs, slope, SPEEDS, SLOPE } from './steer.js';

// The horse in the world: kinematics (speed, heading, turn-rate limits, collisions, terrain rules), procedural
// locomotion, body motion (lean into turns, rear / stumble on impact), neck and head (grazing, looking), ears, a
// spring-chain tail and wind-blown mane and tail hair, plus the riderless brain: graze, come when called, flee, wait.
// Locomotion is a contact cycle per hoof (gait.js sets its timing, stride.js its shapes):
//   stance  the hoof is planted in the world where it landed and stays there: flat, then rolling over its toe (the
//           breakover) until it leaves the ground; the limb reaches it with the shoulder blade swinging as a segment
//           of the fore limb, the fetlock sinking under the load
//   swing   from where the hoof left the ground to where it will land relative to the body: it rises with the limb
//           folding, reaches forward, and is drawn back before it lands (swing retraction), heel first
//   trunk   a spring-mass: the hooves' loads push it up through each stance, gravity alone moves it in the air; the
//           stance's braking and pushing pitch it, the alternate hind stances roll the pelvis and sway it aside, the
//           head lags on the neck like a damped pendulum
//   horse.want = { speed, yaw, brake }   control intent, set by the brain or by the rider (Riding.js)
//   horse.update(dt)                     fixed per-frame order: brain → move → gait → pose
//   horse.seatFrame(pos, quat)           world pose of the saddle seat (where the rider's pelvis rests)
//   horse.home = { x, z }                where it was last put down (place): a grazing horse never strays far from it
//   horse.still                          true: no grazing step begins (the opening cinematic films it where it stands)
// Events: 'horse:step' {surface, speed, gait, leg, actor}, 'horse:breath' {actor, k}, 'horse:snort' {actor},
// 'horse:impact' {strength, actor}, 'horse:neigh' {actor}.

const TAU = Math.PI * 2;
const smooth = (a, b, x) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// 0 → 1 → 0 over [0, 1] with the peak at `at`
const bump = (s, at, end = 1) => (s <= 0 || s >= end ? 0 : s < at ? smooth(0, at, s) : 1 - smooth(at, end, s));

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();
const _X = new THREE.Vector3(1, 0, 0), _Z = new THREE.Vector3(0, 0, 1);
const _bc = { cx: 0, cz: 0, rx: 0, rz: 0, r: 0 };
const _hit = { hit: false, depth: 0, nx: 0, nz: 0, tag: '' };
const _w2 = new THREE.Vector2();
const _S = { z: 0, y: 0 }, _F = { z: 0, y: 0 }, _T = { z: 0, y: 0 }, _P = { z: 0, y: 0 };
const _O3 = new THREE.Vector3();
const _sa = { a: 0, reach: true };

const G = 9.81;
const ALPHA0 = Math.atan2(0.083, -0.055); // rest pastern: coronet → fetlock, up and back (~123.5°)
// The hoof capsule (mesh.js hoofMesh), from its coronet (the hoof bone's origin): the ground ring is centred 0.03 m
// ahead, its toe 0.088 m ahead and its heel 0.028 m behind, 0.072 m below
const HOOF = { h: 0.072, sole: 0.03, toe: 0.088, heel: -0.028 };
// weight on each fore / hind hoof of a standing horse: 58 % on the forehand
const SHARE = [0.29, 0.21];
// the elbow never straightens: it opens to ~146° at most (Martuzzi et al. 2009), 30° short of straight here
const ELBOW_MIN = 0.52;
// hip → fetlock: the hock opens at most ~12° past its standing angle (the tarsus never straightens: Gnagey et al. 2006)
const HIND_MAX = 0.895;
// the shoulder blade swings about its top, near the withers: back (retraction) / forward of its rest angle (rad), no
// faster than SCAP_RATE (rad/s: ~400°/s, a heavy segment); in the air it follows the angle it needs, and on the ground
// its share of the limb's swing, critically damped at SCAP_W (rad/s)
const SCAP_SWING = [-0.35, 0.21], SCAP_RATE = 7, SCAP_W = 60;
// the share of the limb's swing (the line from its root to the fetlock) the blade takes of its own accord
const SCAP_SHARE = 0.35;
// the stance: the heel lands first, toe up by TD_TIP (Clayton 1990: heel-first or flat landings in sound horses), the
// sole settles flat over the first U_SETTLE of the stance; the heel lifts at U_HO and the hoof rolls over its toe as far
// as the gait's toeOff at lift-off (breakover: Clayton, Mechanics of equine locomotion; heel off at ~0.78 of the stance,
// Gottleib et al. 2025); the fetlock sinks under the load, the gait's ext past its standing angle at the peak (at the
// trot fore 25–30°: Martuzzi 2009, hind less: Hobbs et al. 2016), and the carpus locks slightly over-straight under it
// and starts to fold with the breakover (Back et al. 1995a; Clayton et al. 2004)
const TD_TIP = -0.05, U_SETTLE = 0.08, U_HO = [0.7, 0.7], LOAD_STAND = 0.25;
const CARPUS_HYP = 0.07, CARPUS_BO = 0.3;
// how much of the hoof's roll over its toe the pastern follows [fore, hind] (the coffin joint takes the rest), and the
// fastest the limb's reach may roll it (rad/s). The fore, which leaves the most rolled, shares its roll evenly with the
// coffin joint: a pastern that followed most of it would turn past upright over the coronet late in the breakover, its
// fetlock dropping back as the toe leaves, and the elbow would snap straight to reach it
const PASTERN_ROLL = [0.5, 0.7], TIP_RATE = 20;
// the shortest the roll over the toe lasts (s): the trot's breakover is ~0.07 s (Gottleib et al. 2025: 70–77 ms)
const BO_MIN = 0.04;
// the hoof goes on rolling as its toe leaves the ground: the digit's flexors carry the breakover on into the swing, the
// sole turning back and up behind the fetlock (Muybridge 1887, plate 596: a hind just off the ground shows its sole), at
// the rate it was rolling and easing off over BO_CARRY s. A hoof that stopped rolling the instant its toe left would
// carry the toe forward with the coronet, low along the ground
const BO_CARRY = 0.05;
// the swing: the fetlock folds (the digit flexes behind the cannon) and the hoof peaks early, then reaches forward
const FLEX_FETLOCK = [-0.4, -0.6], LIFT_AT = [0.3, 0.3], V_DOWN = [1.5, 0.6];
// the swing's fore-aft path [fore, hind]: how hard the folding limb pulls the hoof forward as it leaves the ground and
// how hard the hoof is braked into its landing, in units of the ground speed over the swing (the quintic's end
// curvatures; a plain cubic would have ~8 and ~7). The hind is lifted a moment before it is drawn forward: pulled
// harder, its toe would be swept along the ground as it rises; much softer, the hoof would lag behind the hip and
// stretch the limb open after the toe has left
const PULL = [14, 16], BRAKE = [8, 8];
// the fore hoof's flight: its early peak, its mid-swing trough and its late peak, as fractions of the swing (their
// heights are the gait's: lift and arc)
const ARC_F = [0.22, 0.55, 0.8];
// the carpus in the swing: folded most at CARPUS_SW[0], straight again by CARPUS_SW[1] (Clayton et al. 2004: the carpus
// is most flexed between 0.3 and 0.6 of the swing)
const CARPUS_SW = [0.42, 0.92];
// the coronet's upward speed as the toe leaves the ground (m/s) [fore, hind]: the fore is flicked up off its toe by
// the digit's elastic recoil and the flexors (Clayton, Mechanics of equine locomotion), fast enough to be up and
// folded before the hind of its side comes in beneath it (Muybridge 1887, plates 596 and 601); the hind is picked up
// as fast by its hock and fetlock folding together (the reciprocal apparatus: Back et al. 1995b), so that its toe is
// some centimetres up before the limb swings it forward rather than skimming along the ground
const V_UP = [1.6, 1.6];
// the hind limb in the swing: the reciprocal apparatus flexes stifle and hock together from the lift-off (Back et
// al. 1995b), the hock further than the stifle (tarsus ROM ~54° against the stifle's ~41°: Martuzzi et al. 2009).
// The cannon's turn from the femur beyond its standing one (rad): HOCK_FOLD[0] at its most, at HOCK_FOLD[1] of the
// swing, gone by HOCK_FOLD[2]: the hoof is carried forward folded under the body and the limb unfolds to land
const HOCK_FOLD = [0.26, 0.32, 0.85];
// the longest a swing lasts (s): a leg that has left the ground lands even when the stride stops
const SWING_MAX = 0.65;
// the head on the neck: natural frequency (rad/s), damping ratio, and how hard the trunk's vertical acceleration
// (m/s²) swings it (rad/s² per m/s²)
const NECK_W = 24, NECK_Z = 0.35, NECK_K = 0.25;
// the trunk's pitch: its two ends' height difference over SPAN (m, the fore hooves' rest spots to the hind ones'), held level by
// a slow spring in the back (BACK_W, rad/s)
const SPAN = 1.035, BACK_W = 3;
// the tail's hanging segments: gravity's pull back toward the vertical (1/s²: a pendulum of ~0.2 m) and their damping (1/s)
const TAIL_G = 50, TAIL_D = 3.5;
// the centre of mass, ahead of the trunk's centre (m): where 58 % of the weight on the fore hooves puts it
const COM_Z = 0.14;
// the trunk's mean height: low-pass (rad/s) of its motion, and the spring (1/s²) and damper (1/s) that hold it
const MEAN_W = 7, MEAN_K = 4, MEAN_D = 4;
// critically damped second-order follow: the new rate of x toward `want` at natural frequency w over a step h
const follow2 = (x, v, want, w, h) => v + (w * w * (want - x) - 2 * w * v) * h;
// grazing: a few steps to fresh grass every 7–16 s, each toward a spot GRAZE_STEP m off (the amble ends within 0.6 m of
// it, or after 5 s at 0.6 m/s: ~3 m at most); a horse further than GRAZE_RANGE m from its home point walks back toward it
export const GRAZE_STEP = [2, 3.5];
export const GRAZE_RANGE = 6;
// ... and never over the samurai: any of the body's circles within 0.88 m pushes him aside (steer.js: the chest circle is
// 0.72 m ahead of the root, and a horse that has to turn as it sets off walks an arc some 0.35 m off its straight run), so
// a step whose run comes within GRAZE_CLEAR m of him (about 2 m just touches him) is drawn again, up to GRAZE_TRIES times;
// if none is clear the horse grazes on until its next turn
export const GRAZE_CLEAR = 2.2;
export const GRAZE_TRIES = 4;

export class Horse {
  constructor(game) {
    this.game = game;
    const b = buildHorse();
    this.root = b.root;
    this.rig = b.rig;
    this.meshes = b.meshes;
    this.seat = b.seat;
    this.stirrups = b.stirrups;
    this.bits = b.bits;
    this.pommel = b.pommel;
    this.root.name = 'horse';
    this.bones = this.rig.bones;
    // kinematics
    this.yaw = 0;
    this.speed = 0; // signed, along the heading (m/s)
    this.yawRate = 0;
    this.vel = new THREE.Vector3();
    this.want = { speed: 0, yaw: 0, brake: false, turnOnly: false };
    this.maxSpeed = SPEEDS.gallop;
    this.refused = null; // 'stairs' | 'slope' | 'sea' | 'building' while a rule blocks the way
    this.ridden = false;
    this.radius = 0.6;
    // gait
    this.gait = makeGait();
    this.phase = 0;
    this.duty = 0.6;
    this.legPh = new Float32Array(4);
    this.stance = [true, true, true, true];
    this.neutral = [];
    // body pose (smoothed)
    this.ground = { y: 0, pitch: 0, roll: 0 };
    this.lean = 0;
    this.react = { kind: null, t: 0, dur: 0, k: 0 };
    // head and neck
    this.graze = 0;
    this.grazeWant = 0;
    this.alert = 0;
    this.lookYaw = 0;
    this.lookWant = 0;
    this.nodK = 0;
    this.ear = [{ a: 0, want: 0, t: 1 }, { a: 0, want: 0, t: 2.3 }];
    // tail: per bone pitch (x) / yaw (y) angle and velocity
    this.tail = [0, 1, 2, 3, 4].map(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));
    this.swishT = 3;
    // brain
    this.mode = 'graze';
    this.target = new THREE.Vector3();
    this.home = { x: 0, z: 0 };
    this.still = false;
    this.modeT = 0;
    this.stepT = 4;
    this.stuckT = 0;
    this.lastDist = 0;
    this.snortT = 9;
    this.breathPh = 0;
    this.time = 0;
    this.visible = true;
    this.onArrive = null;
    this.player = null; // set by the module: the samurai actor (the horse keeps out of him)
    this.rearW = 0;
    this._ga = (x, z) => game.groundAt(x, z);

    // leg chains: 2D rest offsets (z, y) and lengths of each bone to the next joint, in the parent's frame
    const R = this.rig.rest;
    this.legs = LEG_CHAINS.map((chain, l) => {
      const fore = l < 2;
      const segs = chain.slice(0, -1).map((n, i) => {
        const a = R[n], c = R[chain[i + 1]];
        const dz = c.z - a.z, dy = c.y - a.y;
        return { name: n, bone: this.bones[n], len: Math.hypot(dz, dy), rest: Math.atan2(dy, dz), ang: 0 };
      });
      const parent = fore ? 'Chest' : 'Pelvis';
      const root = R[chain[0]].clone().sub(R[parent]);
      const sole = R[chain[chain.length - 1]], cor = R[chain[chain.length - 2]];
      const d = cor.clone().sub(R[chain[0]]);
      const fet = R[chain[chain.length - 3]].clone().sub(R[chain[0]]);
      return {
        fore, segs, parent: this.bones[parent], root, side: l % 2 === 0 ? 1 : -1,
        // rest spot of the hoof's sole centre (root frame: x left, z forward)
        neutral: new THREE.Vector2(cor.x, cor.z + HOOF.sole),
        restTilt: Math.atan2(d.x, -d.y), restDrop: Math.hypot(d.x, d.y) / Math.max(1e-4, -d.y),
        // the limb's line at rest (root joint → fetlock), from which the shoulder blade's share of its swing is taken
        fetAng: Math.atan2(fet.z, -fet.y),
        // the cannon against that line: on the ground (carpus locked, hock held by the reciprocal apparatus) the cannon
        // turns with the limb's line to the fetlock
        cOff: segs[fore ? 3 : 2].rest - Math.atan2(fet.y, fet.z),
        ik: fore ? makeFore() : makeHind(),
        L: fore ? { a: segs[1].len, b: segs[2].len, c: segs[3].len } : { e: segs[0].len, f: segs[1].len, g: segs[2].len },
        delta: fore ? 0 : segs[2].rest - segs[0].rest,
        target: new THREE.Vector3(), // the coronet's world target
        swing: 0,
        stanceU: 0,
        // the contact cycle: psi the leg's own phase (0 = touchdown), u the stance progress, s the swing progress
        psi: 0, rate: 0, inStance: true, u: 0, s: 0, dutyNow: 0.6, swDuty: 0.6, lost: false,
        plant: new THREE.Vector3(), // the sole centre on the ground while the hoof is down (world)
        land: { x: 0, z: 0 }, // where the hoof will land, sole centre (root frame)
        lo: { x: 0, z: 0, h: 0, vx: 0, vz: 0, vh: 0, tip: 0, tipV: 0, e: 0, eV: 0, kappa: 0, kRate: 0, amp: 0 }, // the swing's start (root frame)
        tsw: 0.4, // the swing's duration (s), as _swing plans it
        hk: new Float64Array(15), // the swing's height knots (stride.js knotCurve)
        kk: new Float64Array(12), // the carpus's swing knots
        // the shoulder blade's angle, rate, the angle it needed and its share of the limb's swing, last frame
        scapA: segs[0].rest, scapV: 0, scapT: segs[0].rest, scapW: segs[0].rest,
        kRate: 0, // the carpus's folding rate in the stance (rad/s)
        now: { x: 0, z: 0, h: 0, px: 0, pz: 0, ph: 0 }, // the coronet in the root frame, this frame and the last
        tip: 0, // hoof roll on the ground (rad): + the heel up, rolling over the toe; − the toe up, landing on the heel
        tipV: 0, // and its rate (rad/s)
        uPrev: 1, imp: 0, // the stance progress last frame, and the hoof's push over this frame (g · s)
        kappa: 0, // carpus flexion (rad)
        ePlan: 0, // swing: the pastern's turn ahead of the cannon (rad, + toward the standing extension)
        extTd: 0, // the fetlock's extension past standing the hoof will land with (unloaded: below it)
        aCg: -Math.PI / 2, // the cannon's last angle against the ground (leg plane)
        // the pastern's turn ahead of the cannon standing (the fetlock's dorsal extension), now, and its rate (rad/s)
        eRest: fore ? segs[4].rest - segs[3].rest : segs[3].rest - segs[2].rest,
        eNow: fore ? segs[4].rest - segs[3].rest : segs[3].rest - segs[2].rest,
        eV: 0,
        beta: 0,
      };
    });
    this.restBody = this.bones.Body.position.clone();
    this.restRot = {};
    for (const n of ['Neck1', 'Neck2', 'Neck3', 'Head']) this.restRot[n] = this.bones[n].quaternion.clone();
    // the trunk's own motion: vertical spring-mass (y, vy, acceleration), pitch, chest and pelvis roll, lateral sway,
    // the head's lag on the neck (each angle with its rate)
    this.trunk = { y: 0, vy: 0, ym: 0, ymV: 0, dyn: 0, acc: 0, ends: 0, endsV: 0, roll: 0, rollV: 0, pelvis: 0, pelvisV: 0, lat: 0, latV: 0, nod: 0, nodV: 0 };
    this.idleT = 0;
    this.inStep = 1;
    this._resetLegs();
  }

  // every hoof down on its rest spot, the leg's clock on the stride's (after place(), or at birth)
  _resetLegs() {
    const p = this.root.position, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    gaitAt(Math.abs(this.speed), this.gait);
    for (let l = 0; l < 4; l++) {
      const L = this.legs[l];
      const nx = L.neutral.x, nz = L.neutral.y;
      L.psi = legPhase(this.phase, this.gait.off[l]);
      L.inStance = true;
      L.u = 0;
      L.s = 0;
      L.tip = L.tipV = 0;
      L.uPrev = 1;
      L.imp = 0;
      L.kappa = 0;
      L.lost = false;
      L.scapA = L.segs[0].rest;
      L.scapV = 0;
      L.scapT = L.scapW = L.scapA;
      const wx = p.x + nx * c + nz * s, wz = p.z - nx * s + nz * c;
      L.plant.set(wx, this.game.groundAt(wx, wz), wz);
      L.land.x = nx;
      L.land.z = nz;
      L.now.x = L.now.px = nx;
      L.now.z = L.now.pz = nz - HOOF.sole;
      L.now.h = L.now.ph = HOOF.h;
    }
    const T = this.trunk;
    T.y = T.vy = T.ym = T.ymV = T.dyn = T.acc = T.ends = T.endsV = T.roll = T.rollV = T.pelvis = T.pelvisV = T.lat = T.latV = T.nod = T.nodV = 0;
  }

  get position() {
    return this.root.position;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  setVisible(v) {
    this.visible = v;
    this.root.visible = v;
  }

  // Put the horse down: where it grazes from now on (home) until it is called or ridden away.
  place(x, z, yaw) {
    this.root.position.set(x, this.game.groundAt(x, z), z);
    this.home.x = x;
    this.home.z = z;
    this.yaw = yaw;
    this.root.rotation.set(0, yaw, 0);
    this.speed = 0;
    this.yawRate = 0;
    this.ground.y = this.root.position.y;
    this.ground.pitch = this.ground.roll = 0;
    // put down, not walked there: the hooves stand on their rest spots under it
    this._resetLegs();
  }

  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    this._dt = dt;
    if (!this.ridden) this._brain(dt);
    else this.grazeWant = 0;
    this._move(dt);
    this._gait(dt);
    this._pose(dt);
  }

  // ---- riderless brain ------------------------------------------------------------------------------
  _brain(dt) {
    const w = this.want, p = this.root.position;
    this.modeT += dt;
    w.brake = false;
    if (this.mode === 'graze' || this.mode === 'wait') {
      w.speed = 0;
      w.yaw = this.yaw;
      this.grazeWant = this.mode === 'graze' ? 1 : 0;
      // now and then a few steps to fresh grass: one heading and one length per step, drawn together; the heading is
      // within a radian of where the horse faces, or (a horse that strayed past GRAZE_RANGE) of the way back home. A
      // step that would carry it over the samurai is drawn again; if none of the tries is clear it stays and grazes
      if (!this.still) this.stepT -= dt;
      if (this.mode === 'graze' && this.stepT <= 0) {
        this.stepT = 7 + Math.random() * 9;
        const hx = this.home.x - p.x, hz = this.home.z - p.z;
        const strayed = Math.hypot(hx, hz) > GRAZE_RANGE;
        for (let k = 0; k < GRAZE_TRIES; k++) {
          const heading = (strayed ? Math.atan2(hx, hz) : this.yaw) + (Math.random() - 0.5) * (strayed ? 1 : 2);
          const len = GRAZE_STEP[0] + Math.random() * (GRAZE_STEP[1] - GRAZE_STEP[0]);
          this.target.set(p.x + Math.sin(heading) * len, 0, p.z + Math.cos(heading) * len);
          if (this._crosses(this.player, p, this.target, GRAZE_CLEAR)) continue;
          this.mode = 'amble';
          this.modeT = 0;
          break;
        }
      }
      if (this.mode === 'wait' && this.player) this._lookAt(this.player.position, 0.6);
    } else if (this.mode === 'amble') {
      const d = this._steerTo(this.target, 0.6, 0.7);
      this.grazeWant = 0.6;
      if (d < 0.6 || this.modeT > 5) this.mode = 'graze';
    } else if (this.mode === 'come') {
      this.grazeWant = 0;
      const pl = this.player;
      if (!pl) return (this.mode = 'wait');
      this.target.copy(pl.position);
      const d = Math.hypot(this.target.x - p.x, this.target.z - p.z);
      const v = d > 26 ? SPEEDS.gallop : d > 12 ? SPEEDS.canter : d > 5.5 ? SPEEDS.trot : d > 2.9 ? SPEEDS.walk : 0;
      this._steerTo(this.target, v, 2.7);
      this._lookAt(pl.position, 0.8);
      // stuck behind something, or slower than expected: count it
      if (this.modeT > 0.5) {
        if (this.lastDist - d < 0.4 * dt * Math.max(1, v * 0.3) && d > 3.2) this.stuckT += dt;
        else this.stuckT = Math.max(0, this.stuckT - dt * 0.5);
      }
      this.lastDist = d;
      if (d <= 2.9 && Math.abs(this.speed) < 0.3) {
        this.mode = 'wait';
        this.modeT = 0;
        if (this.onArrive) this.onArrive();
      } else if (this.stuckT > 2.2 && this.onStuck) {
        this.stuckT = 0;
        this.onStuck();
      }
    } else if (this.mode === 'flee') {
      this.grazeWant = 0;
      const far = Math.hypot(this.target.x - p.x, this.target.z - p.z) > 8;
      const d = this._steerTo(this.target, far ? SPEEDS.gallop : SPEEDS.canter, 2);
      if (d < 3 || this.modeT > 9) {
        this.mode = 'wait';
        this.modeT = 0;
      }
    }
  }

  // Head toward (x, z) at `speed` with a simple look-ahead avoidance of trunks and walls; returns the distance.
  _steerTo(t, speed, stopAt) {
    const p = this.root.position, w = this.want;
    const dx = t.x - p.x, dz = t.z - p.z;
    const d = Math.hypot(dx, dz);
    let yaw = Math.atan2(dx, dz);
    if (d > stopAt + 1 && speed > 0) {
      // probe ahead along the wanted heading; if blocked, try turning either way
      const ahead = Math.min(7, 2 + Math.abs(this.speed) * 0.5);
      if (this._blocked(p.x, p.z, yaw, ahead)) {
        for (const off of [0.5, -0.5, 1.0, -1.0, 1.5, -1.5]) {
          const y2 = yaw + off * (this.avoidSide || 1);
          if (!this._blocked(p.x, p.z, y2, ahead)) {
            yaw = y2;
            this.avoidSide = Math.sign(off) * (this.avoidSide || 1);
            break;
          }
        }
      }
    }
    w.yaw = yaw;
    w.speed = d > stopAt ? speed * smooth(stopAt, stopAt + 2.5 + speed * 0.4, d) + (d > stopAt ? 0.6 : 0) : 0;
    if (w.speed > speed) w.speed = speed;
    return d;
  }

  _blocked(x, z, yaw, dist) {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    for (let k = 1; k <= 3; k++) {
      const px = x + s * (dist * k) / 3, pz = z + c * (dist * k) / 3;
      if (circleContact(this.game.colliders, px, pz, 0.7, -Infinity, _hit).hit) return true;
      if (!this._groundOK(px, pz, s, c).ok) return true;
    }
    return false;
  }

  // Does the straight run a → b come within r m of the actor's feet (no actor: never)?
  _crosses(actor, a, b, r) {
    if (!actor) return false;
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = clamp(((actor.position.x - a.x) * dx + (actor.position.z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return Math.hypot(a.x + dx * t - actor.position.x, a.z + dz * t - actor.position.z) < r;
  }

  _lookAt(pos, k) {
    const p = this.root.position;
    this.lookWant = clamp(wrap(Math.atan2(pos.x - p.x, pos.z - p.z) - this.yaw), -0.9, 0.9) * k;
  }

  // ---- world rules: sea, the shrine stairs, raised floors, slopes ---------------------------------------
  _groundOK(x, z, fx, fz) {
    const g = this.game;
    const r = this._gres || (this._gres = { ok: true, why: null, maxSpeed: 99 });
    r.ok = true;
    r.why = null;
    r.maxSpeed = 99;
    const gy = g.groundAt(x, z);
    if (gy < 0.3) return (r.ok = false), (r.why = 'sea'), r;
    if (Math.abs(x) > 990 || Math.abs(z) > 990) return (r.ok = false), (r.why = 'sea'), r;
    if (onStairs(x, z)) return (r.ok = false), (r.why = 'stairs'), r;
    if (gy - g.terrain.heightAt(x, z) > 0.25) return (r.ok = false), (r.why = 'building'), r;
    const sl = slope(this._ga, x, z, fx, fz, 1.4);
    if (Math.abs(sl) > SLOPE.refuse) return (r.ok = false), (r.why = 'slope'), r;
    if (Math.abs(sl) > SLOPE.slow) r.maxSpeed = SPEEDS.gallop + (SPEEDS.walk - SPEEDS.gallop) * smooth(SLOPE.slow, SLOPE.refuse, Math.abs(sl));
    return r;
  }

  // ---- kinematics -----------------------------------------------------------------------------------
  _move(dt) {
    const g = this.game, w = this.want, p = this.root.position;
    const react = this.react;
    let target = clamp(w.speed, SPEEDS.back, this.maxSpeed);
    // a rear or a stumble holds the horse still
    if (react.kind) {
      react.t += dt;
      if (react.t >= react.dur) react.kind = null;
      target = 0;
    }
    this.rearW = react.kind === 'rear' ? bump(react.t / react.dur, 0.35, 1) * react.k : 0;
    // sharp turns at speed: the horse slows to make them
    const err = wrap(w.yaw - this.yaw);
    if (Math.abs(this.speed) > 6 && Math.abs(err) > 0.9) target = Math.min(target, 6.5);
    // the rules of the ground ahead (or behind, backing up)
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const dir = this.speed < -0.05 || target < 0 ? -1 : 1;
    // look as far ahead as the horse needs to pull up (12 m/s² when refusing)
    const probe = dir > 0 ? 1.35 + (this.speed * Math.max(0, this.speed)) / 24 + 0.4 : -1.1;
    const gr = this._groundOK(p.x + fx * probe, p.z + fz * probe, fx * dir, fz * dir);
    this.refused = gr.ok ? null : gr.why;
    if (!gr.ok && target * dir > 0) target = 0;
    if (gr.ok) target = clamp(target, -gr.maxSpeed, gr.maxSpeed);
    // a quick horse: canter in ~2 s, full gallop in ~3.6 s (ridden, or answering the whistle)
    const up = this.speed > 8.5 ? 2.8 : 4.4;
    const down = w.brake ? 9 : !gr.ok ? 12 : 4.6;
    this.speed = approach(this.speed, target, dt, up, down);
    // turning: the rate limit shrinks with speed; a short lag keeps it smooth
    const rate = maxTurnRate(this.speed) * (react.kind ? 0.2 : 1);
    const wantRate = clamp(err / Math.max(dt, 0.12), -rate, rate);
    this.yawRate += (wantRate - this.yawRate) * Math.min(1, dt * 7);
    this.yaw = wrap(this.yaw + this.yawRate * dt);
    // integrate
    const ox = p.x, oz = p.z;
    p.x += Math.sin(this.yaw) * this.speed * dt;
    p.z += Math.cos(this.yaw) * this.speed * dt;
    // collisions: a chest and a hindquarters circle against the static colliders
    const footY = p.y + 0.4;
    for (let pass = 0; pass < 2; pass++) {
      bodyCircles(p.x, p.z, this.yaw, _bc);
      const hc = circleContact(g.colliders, _bc.cx, _bc.cz, _bc.r, footY, _hit);
      let nx = 0, nz = 0, depth = 0, front = false;
      if (hc.hit) (nx = hc.nx), (nz = hc.nz), (depth = hc.depth), (front = true);
      const hr = circleContact(g.colliders, _bc.rx, _bc.rz, _bc.r, footY, _hit);
      if (hr.hit && hr.depth > depth) (nx = hr.nx), (nz = hr.nz), (depth = hr.depth), (front = false);
      if (depth <= 0) break;
      p.x += nx * depth;
      p.z += nz * depth;
      // speed into the obstacle (positive = driving into it)
      const vn = -(Math.sin(this.yaw) * nx + Math.cos(this.yaw) * nz) * this.speed;
      if (pass === 0 && vn > 3.6 && !react.kind) {
        this.startReact(vn > 7.5 && front ? 'rear' : 'stumble', vn);
        this.speed = 0;
      } else if (vn > 0) {
        // rubbing along: keep only the part of the speed that slides past
        this.speed *= clamp(1 - Math.abs(Math.sin(this.yaw) * nx + Math.cos(this.yaw) * nz), 0, 1);
      }
    }
    // keep out of the samurai when he is on foot (no collider for actors)
    const pl = this.player;
    if (pl && !this.ridden && pl.alive !== false && !this.noPush) {
      bodyCircles(p.x, p.z, this.yaw, _bc);
      for (const [cx, cz] of [[_bc.cx, _bc.cz], [p.x, p.z], [_bc.rx, _bc.rz]]) {
        const dx = pl.position.x - cx, dz = pl.position.z - cz;
        const d = Math.hypot(dx, dz), min = 0.5 + (pl.radius || 0.38);
        if (d < min && d > 1e-4) {
          pl.position.x = cx + (dx / d) * min;
          pl.position.z = cz + (dz / d) * min;
        }
      }
    }
    // never into the sea, whatever pushed us: the leading end of the body stays on dry ground
    const lead = this.speed >= 0 ? 0.72 : -0.6;
    if (g.groundAt(p.x + Math.sin(this.yaw) * lead, p.z + Math.cos(this.yaw) * lead) < 0.3) {
      p.x = ox;
      p.z = oz;
      this.speed = 0;
    }
    this.vel.set((p.x - ox) / dt, 0, (p.z - oz) / dt);
    this.root.rotation.set(0, this.yaw, 0);
    // ground under the four hooves' rest spots → body height, pitch and roll (smoothed)
    const fy = this._gAt(0, 0.58), hy = this._gAt(0, -0.46), ly = this._gAt(0.3, 0.06), ry = this._gAt(-0.3, 0.06);
    const gy = Math.max((fy + hy) / 2, g.groundAt(p.x, p.z) - 0.05);
    const k = Math.min(1, dt * 10);
    this.ground.y += (gy - this.ground.y) * (Math.abs(gy - this.ground.y) > 0.6 ? 1 : k);
    this.ground.pitch += (Math.atan2(fy - hy, 1.04) - this.ground.pitch) * k;
    this.ground.roll += (Math.atan2(ly - ry, 0.6) * 0.5 - this.ground.roll) * k;
    p.y = this.ground.y;
    // lean into turns
    const lean = clamp(-this.yawRate * this.speed * 0.03, -0.2, 0.2);
    this.lean += (lean - this.lean) * Math.min(1, dt * 5);
  }

  _gAt(lx, lz) {
    const p = this.root.position, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return this.game.groundAt(p.x + lx * c + lz * s, p.z - lx * s + lz * c);
  }

  startReact(kind, strength = 4) {
    this.react.kind = kind;
    this.react.t = 0;
    this.react.dur = kind === 'rear' ? 1.5 : kind === 'shy' ? 0.7 : 0.75;
    this.react.k = clamp(strength / 9, 0.4, 1);
    this.game.emit('horse:impact', { strength, kind, actor: this });
    this.game.emit('horse:snort', { actor: this });
  }

  // ---- gait: each hoof's contact cycle, the swing's path, footfall events ---------------------------------------
  _gait(dt) {
    const g = this.gait, p = this.root.position;
    const vEff = Math.hypot(this.speed, this.yawRate * 0.9);
    gaitAt(vEff, g);
    const f = g.freq, amp = g.amp;
    this.phase = (this.phase + f * dt) % 1;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let swinging = 0, maxErr = 0;
    for (let l = 0; l < 4; l++) {
      const L = this.legs[l];
      const k = L.fore ? 0 : 1;
      const nx = L.neutral.x, nz = L.neutral.y;
      // the ground's velocity under the hoof's rest spot (root frame): the body's speed and its turn
      const vx = this.yawRate * nz, vz = this.speed - this.yawRate * nx;
      const vg = Math.hypot(vx, vz);
      // the stance lasts the gait's duty, but no longer than the limb can sweep a planted hoof under the body: at speed
      // the stance shortens (the duty factor falls with speed: Weishaupt et al. 2010)
      const dutyT = L.fore ? g.duty : g.dutyH;
      const duty = clamp(f > 1e-4 && vg > 1e-3 ? Math.min(dutyT, (g.sweep[k] * f) / vg) : dutyT, 0.12, 0.95);
      L.dutyNow = duty;
      // the leg's own clock runs with the stride's and catches up on any shift of the footfall pattern (a change of
      // gait) by running a little faster or slower: never a jump, so a hoof only lands at the end of its swing and
      // only lifts off at the end of its stance
      // (both clocks as they were at the start of this frame: compared after the stride's has moved on, the leg's would
      // settle a frame ahead of it, and its hooves land a frame's travel early at a coarse frame rate)
      let err = legPhase(this.phase - f * dt, g.off[l]) - L.psi;
      err -= Math.round(err);
      maxErr = Math.max(maxErr, Math.abs(err));
      L.rate = f * (1 + clamp(3 * err, -0.45, 0.45));
      L.psi += L.rate * dt;
      if (L.psi >= 1) L.psi -= 1;
      // where the hoof will land: ahead of its rest spot by a share of the stance it will sweep (the ground under it
      // moves back at vg for duty / f seconds), so that the stance sweeps about the limb's pivot
      const sweep = f > 1e-4 && vg > 1e-3 ? Math.min((vg * duty) / f, g.sweep[k]) : 0;
      const kk = vg > 1e-3 ? (sweep * g.place[k]) / vg : 0;
      L.land.x = nx + vx * kk;
      L.land.z = nz + vz * kk;
      L.imp = 0;
      if (L.inStance) {
        L.u = clamp(L.psi / duty, 0, 1);
        // the hoof's push over this frame (in g · s): its share of the weight times the part of its stance's impulse
        // delivered since the last frame (stride.js loadImpulse; the stance lasts duty / rate seconds)
        if (L.u > L.uPrev) L.imp = (SHARE[k] * (loadImpulse(L.u) - loadImpulse(L.uPrev))) / Math.max(L.rate, 1e-3);
        L.uPrev = L.u;
        // lift-off: the stance has run its course, or the limb can no longer reach the hoof (pushed, turned on the spot)
        if (L.psi >= duty || L.lost) this._liftOff(L, duty, vx, vz);
      } else {
        // the swing runs on its own clock (the stride's, or at least 1 / SWING_MAX when the stride slows to a stop)
        const rs = Math.max(L.rate / Math.max(0.05, 1 - L.swDuty), 1 / SWING_MAX);
        L.s += rs * dt;
        // the hoof met the ground (s - 1) / rs seconds ago, within this frame
        if (L.s >= 1) this._touchDown(L, l, g, amp, Math.min(dt, (L.s - 1) / rs), vx, vz);
      }
      if (!L.inStance) {
        swinging++;
        this._swing(L, k, g, amp, vx, vz, p, s, c);
      }
      this.stance[l] = L.inStance;
      this.legPh[l] = L.psi;
      L.stanceU = L.inStance ? L.u : 1;
      L.swing = L.inStance ? 0 : L.s;
    }
    this.duty = this.legs[0].dutyNow;
    // the hooves are in their footfall pattern (1) or still finding it after a change of pace (0)
    this.inStep = 1 - smooth(0.06, 0.16, maxErr);
    // standing about: a hoof left far from its rest spot when the horse stopped steps back under it, one at a time
    this.idleT += dt;
    if (amp < 0.12 && swinging === 0 && this.idleT > 0.6 && this.rearW <= 0) {
      let worst = null, far = 0.1;
      for (const L of this.legs) {
        const lx = (L.plant.x - p.x) * c - (L.plant.z - p.z) * s, lz = (L.plant.x - p.x) * s + (L.plant.z - p.z) * c;
        const d = Math.hypot(lx - L.neutral.x, lz - L.neutral.y);
        if (d > far) (far = d), (worst = L);
      }
      if (worst) {
        this._liftOff(worst, worst.dutyNow, 0, 0);
        this.idleT = 0;
      }
    }
    // snorts at rest and after a hard run
    this.snortT -= dt;
    if (this.snortT <= 0) {
      this.snortT = 9 + Math.random() * 14;
      if (Math.abs(this.speed) < 2 && this.visible) this.game.emit('horse:snort', { actor: this });
    }
  }

  // The toe leaves the ground: the swing starts where the coronet is (root frame), moving as it was (the breakover swings
  // it up and forward round the toe), with the hoof and the pastern still turning as they were over the toe.
  _liftOff(L, duty, vx, vz) {
    const n = L.now, lo = L.lo, dt = this._dt;
    L.inStance = false;
    L.lost = false;
    // a hoof picked up early swings for the rest of the cycle: it lands when its clock comes round, in step
    L.swDuty = clamp(Math.min(duty, L.psi), 0, 0.95);
    // the toe left the ground `late` seconds ago, within this frame (the stance clock ran past its end): the swing
    // starts then, from the hoof as it was last frame carried on to that moment, so that the lift-off is the same at
    // any frame rate
    const rate = Math.max(L.rate, 1e-4), late = L.psi >= duty ? clamp((L.psi - duty) / rate, 0, dt) : 0;
    const early = dt - late, k = dt > 0 ? early / dt : 0;
    L.s = clamp((late * rate) / Math.max(0.05, 1 - L.swDuty), 0, 0.2);
    lo.x = n.x + (n.x - n.px) * k;
    lo.z = n.z + (n.z - n.pz) * k;
    lo.h = n.h + (n.h - n.ph) * k;
    const idt = dt > 0 ? 1 / dt : 60;
    lo.vx = -vx;
    // the coronet leaves with the velocity it had: the planted hoof trails the body at the ground's speed under it, and
    // the breakover swings the coronet up and forward round the toe on top of that. A swing that started from rest in the
    // world would first drag the hoof back along the ground, stretching the limb after the toe has left (the hock would go
    // on opening in the air)
    lo.vz = clamp((n.z - n.pz) * idt, -vz - 0.5, -vz + 2.0);
    lo.vh = clamp((n.h - n.ph) * idt, -0.5, 2.5);
    lo.tip = L.tip + L.tipV * early;
    // (the rate of the hoof's roll over its toe, and of the pastern's turn from the cannon: the swing carries them on)
    lo.tipV = Math.max(0, L.tipV);
    lo.kRate = L.fore ? L.kRate : 0;
    lo.amp = this.gait.amp;
    lo.kappa = L.kappa + lo.kRate * early;
    lo.e = L.eNow;
    lo.eV = L.eV;
  }

  // The hoof lands where its swing was headed (root frame), and stays there in the world for the whole stance. It met
  // the ground `late` seconds ago, within this frame: it was planted where its landing spot was then (the body has moved
  // on since, at vx / vz over the ground under it), so that a hoof lands on the same spot at any frame rate.
  _touchDown(L, l, g, amp, late = 0, vx = 0, vz = 0) {
    const p = this.root.position, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    L.inStance = true;
    L.u = 0;
    L.tip = 0;
    L.tipV = 0;
    L.uPrev = 0;
    // a swing that ends just before the clock comes round: the stance starts now, the clock keeps its count
    if (L.psi > 0.5) L.psi -= 1;
    const lx = L.land.x - vx * late, lz = L.land.z - vz * late;
    const wx = p.x + lx * c + lz * s, wz = p.z - lx * s + lz * c;
    const gy = this.game.groundAt(wx, wz);
    L.plant.set(wx, gy, wz);
    if (amp > 0.2 && this.visible) {
      this.game.emit('horse:step', { surface: this._surface(wx, wz, gy), speed: Math.abs(this.speed), gait: g.name, leg: l, actor: this, x: wx, z: wz });
      if (l === 0 && g.index >= 2 && Math.abs(this.speed) > 6) this.game.emit('horse:breath', { actor: this, k: smooth(6, 13.5, Math.abs(this.speed)) });
    }
  }

  // The swing (root frame): the coronet from where it left the ground to where it will land, as cubic Hermite curves
  // whose end slopes are the hoof's real velocities: it keeps sliding back under the body a moment after the toe leaves,
  // reaches forward, and is drawn back before it lands so that it meets the ground at a fraction of the body's speed
  // (swing retraction: Holmström 1994; Clayton & Hobbs 2019), dropping at V_DOWN; it peaks early in the swing (Clayton
  // 1990). Also plans the carpus and the fetlock: the digit folds behind the cannon and opens again before the landing.
  _swing(L, k, g, amp, vx, vz, p, sn, cs) {
    const s = clamp(L.s, 0, 1), lo = L.lo;
    const Tsw = 1 / Math.max(L.rate / Math.max(0.05, 1 - L.swDuty), 1 / SWING_MAX);
    L.tsw = Tsw;
    // the landing coronet: the heel touches first with the toe up by TD_TIP, the sole centre on L.land
    const th = TD_TIP * amp, ct = Math.cos(th), st = Math.sin(th);
    const z1 = L.land.z + HOOF.heel - HOOF.sole - HOOF.heel * ct + HOOF.h * st;
    const h1 = HOOF.heel * st + HOOF.h * ct;
    const back = 1 - g.tdv[k];
    // fore and aft: the hoof leaves the ground still (it was planted), is pulled forward by the folding limb (PULL: the
    // flexors snap the joints shut as the toe leaves), swings through under the body and is braked into its landing
    // (BRAKE: a short, sharp retraction, Back et al. 1995c), meeting the ground at a fraction of the body's speed
    const x = quintic(lo.x, lo.vx * Tsw, PULL[k] * vx * Tsw, L.land.x, -vx * back * Tsw, -BRAKE[k] * vx * Tsw, s);
    const z = quintic(lo.z, lo.vz * Tsw, PULL[k] * vz * Tsw, z1, -vz * back * Tsw, -BRAKE[k] * vz * Tsw, s);
    // up and down: flicked up off the toe by the digit's elastic recoil (Clayton, Mechanics of equine locomotion), the hoof
    // peaks early in the swing as the limb folds (fore: the carpus snaps shut with the forearm still back), then the
    // fore hoof dips while the forearm swings forward and rises a little again before the limb opens to land (Clayton
    // 1990; Gottleib et al. 2025: an early and a late peak); the hind's single arc comes down gradually as the limb
    // reaches forward, so that it arrives low under the fore that has just left the ground
    // (a hoof picked up to step in place still folds a little at the carpus and the fetlock, which tips its toe down: it
    // is lifted proportionally higher than it folds, so that the toe clears the ground)
    // (a hoof in the air keeps the arc it left the ground with: a horse pulling up does not drop it onto the ground)
    const aH = Math.max(amp, lo.amp), lift = Math.max(amp, 0.35), liftH = Math.max(aH, 0.65), K = L.hk;
    const v0 = Math.max(lo.vh, V_UP[k] * liftH) * Tsw, top = g.lift[k] * liftH;
    K[0] = 0;
    K[1] = lo.h;
    K[2] = v0;
    let n = 3;
    if (L.fore) {
      K[3] = ARC_F[0];
      K[4] = h1 + top;
      K[5] = 0;
      K[6] = ARC_F[1];
      K[7] = h1 + top * g.arc[0];
      K[8] = 0;
      K[9] = ARC_F[2];
      K[10] = h1 + top * g.arc[1];
      K[11] = 0;
      n = 5;
    } else {
      K[3] = LIFT_AT[1];
      K[4] = h1 + top;
      K[5] = 0;
    }
    const j = (n - 1) * 3;
    K[j] = 1;
    K[j + 1] = h1;
    K[j + 2] = -V_DOWN[k] * aH * Tsw;
    const h = knotCurve(s, K, n);
    const wx = p.x + x * cs + z * sn, wz = p.z - x * sn + z * cs;
    L.target.set(wx, this.game.groundAt(wx, wz) + h, wz);
    L.now.px = L.now.x;
    L.now.pz = L.now.z;
    L.now.ph = L.now.h;
    L.now.x = x;
    L.now.z = z;
    L.now.h = h;
    // the carpus folds in one wave: on at the rate it was folding as the toe left (no pause at the lift-off: it starts in
    // the breakover, Clayton et al. 2004), most flexed at CARPUS_SW[0] of the swing with the hoof tucked up under the
    // forearm (Muybridge 1887, plates 596 and 601), then opening steadily to straight by CARPUS_SW[1] as the forearm
    // swings forward to reach for the ground: no plateau, and no late snap open that the elbow would have to take up
    if (L.fore) {
      const C = L.kk, kMax = g.flex * lift;
      C[0] = 0;
      C[1] = lo.kappa;
      C[2] = lo.kRate * Tsw;
      C[3] = CARPUS_SW[0];
      C[4] = kMax;
      C[5] = 0;
      C[6] = CARPUS_SW[1];
      C[7] = 0;
      C[8] = 0;
      L.kappa = knotCurve(s, C, 3);
    }
    // the digit flexes behind the cannon early in the swing, then opens toward its landing angle; it goes on flexing at
    // the rate it was as the toe left (the breakover had it turning), so that the hoof's own roll carries on with it
    // rather than against a pastern that stopped (a monotonic rise to the peak: no faster than three times the mean)
    const eFlex = L.eRest + (FLEX_FETLOCK[k] - L.eRest) * lift, ePk = 0.25 / 0.85, dE = eFlex - lo.e;
    const m0 = dE * lo.eV > 0 ? Math.sign(dE) * Math.min(Math.abs(lo.eV * 0.85 * Tsw), (3 * Math.abs(dE)) / ePk) : 0;
    L.ePlan = peakCurve(Math.min(1, s / 0.85), lo.e, m0, eFlex, ePk, L.eRest - 0.2 * lift, 0);
    L.extTd = -(g.ext[k] * amp * LOAD_STAND) / (1 - LOAD_STAND);
  }

  _surface(x, z, gy) {
    if (gy - this.game.terrain.heightAt(x, z) > 0.04) return 'stone';
    const s = this.game.terrain.surfaceAt(x, z);
    return s.path > 0.5 ? 'dirt' : s.rock > 0.5 ? 'stone' : 'grass';
  }

  // ---- trunk: a spring-mass on the hooves in stance ---------------------------------------------------------
  // Each hoof in stance pushes the trunk up with its share of the weight shaped over its stance (stride.js loadShape):
  // the pushes average to the body's weight over a stride, so the trunk sinks through each diagonal stance and rises
  // again, and with no hoof down it flies under gravity alone (a trot is a bouncing gait: Hobbs & Clayton 2019). Its two
  // ends ride their own pairs of limbs, which pitches it a degree or so per diagonal (Hobbs et al. 2016); the alternate
  // hind stances roll the pelvis toward the loaded side (Hardeman et al. 2020: median 8.5°), the chest rolls less toward
  // its own loaded fore, so the thorax and the pelvis twist against each other along the back (Faber et al. 2001). The
  // trunk sways aside toward the loaded fore: each hoof of a diagonal pushes its end of the trunk back toward the midline,
  // the fore (58 % of the weight) harder than the hind on the other side, so the trunk is pushed toward the hind's side
  // through the stance and, swinging about the midline from stance to stance, sits furthest toward the fore at
  // mid-stance; with the chest's roll the withers sway with it (Buchner et al. 2000: the trunk ~25 mm side to side). The
  // head rides the neck like a damped pendulum, lagging the withers a little.
  _trunk(dt, g, amp) {
    const T = this.trunk;
    let F = 0, Ff = 0, rollC = 0, rollP = 0, lat = 0;
    const idt = dt > 0 ? 1 / dt : 0;
    for (let l = 0; l < 4; l++) {
      const L = this.legs[l];
      // the hooves' mean pushes over this frame (in g), from their impulses (_gait): a hoof that left the ground within
      // the frame still pushed for part of it
      F += L.imp * idt;
      if (L.fore) Ff += L.imp * idt;
      if (!L.inStance) continue;
      const lf = loadFrac(L.u);
      if (L.fore) {
        rollC -= L.side * lf;
        lat += L.side * lf;
      } else rollP -= L.side * lf;
    }
    // vertical: the hooves' pushes (in g) minus gravity. Over a steady stride they average to the weight; a spring and a
    // damper hold the mean height at the gait's carriage (lower still uphill where the body pitches up) through starts,
    // turns and changes of gait. They act on the trunk's motion low-passed below the stride, so they barely touch the
    // bounce or the free fall in the air. At the trot the limbs, flexed through every stance, carry the trunk some 5 cm
    // below its standstill height: limbs that sweep ±20–28° about their pivots are then only a few per cent longer than
    // standing as they land and as they push off (a limb 10 % longer would be locked out straight: Hobbs & Clayton 2019)
    const yT = -(0.02 + 0.03 * g.slip) * amp - 0.07 * Math.max(0, this.ground.pitch);
    const h0 = Math.min(dt, 1 / 40);
    T.ymV = follow2(T.ym, T.ymV, T.y, MEAN_W, h0);
    T.ym += T.ymV * h0;
    // (the bounce is the footfall pattern's: while the hooves are still finding it the trunk is only held up, and it
    // grows into its bounce over a stride or two once they have)
    const want = amp * this.inStep;
    T.dyn += (want - T.dyn) * Math.min(1, dt * (want > T.dyn ? 1.5 : 8));
    const dyn = T.dyn;
    const a = dyn * G * (F - 1) + MEAN_K * (yT - T.ym) - MEAN_D * T.ymV - (1 - dyn) * 4 * T.vy;
    T.vy += a * dt;
    T.y += T.vy * dt;
    if (T.y < -0.12 || T.y > 0.08) {
      T.y = clamp(T.y, -0.12, 0.08);
      T.vy = 0;
    }
    T.acc = a;
    // pitch: the forehand rides its fore hooves and the hindquarters their hind ones. With the trunk's weight over its
    // two pairs of limbs (58 / 42 %), each end of it rises and falls with its own limbs' push, as the two ends of a
    // dumbbell do: the croup, on the shorter hind stance that lands first, dips as far as the withers or further and a
    // little before them (Hardeman et al. 2020; Rhodin et al. 2022: each end lowest at ~40 % of its own limb's stance).
    // The back keeps the two ends from drifting apart (a slow spring). (The braking then pushing at the ground would nod
    // the trunk, but the ground's push points close to the centre of mass through the stance: its moments about it and
    // those of the vertical pushes, ahead of it early and behind it late, nearly cancel.)
    const n = Math.max(1, Math.ceil(dt * 240)), hp = dt / n;
    const dA = dyn * G * (Ff / (2 * SHARE[0]) - (F - Ff) / (2 * SHARE[1]));
    for (let i = 0; i < n; i++) {
      T.endsV += (dA - BACK_W * BACK_W * T.ends - 2 * BACK_W * T.endsV) * hp;
      T.ends += T.endsV * hp;
    }
    // the angles follow their pushes with a little inertia (critically damped); a long frame is taken in short steps
    const h = Math.min(dt, 1 / 40);
    T.rollV = follow2(T.roll, T.rollV, 0.034 * amp * rollC, 22, h);
    T.roll += T.rollV * h;
    T.pelvisV = follow2(T.pelvis, T.pelvisV, 0.1 * amp * rollP, 22, h);
    T.pelvis += T.pelvisV * h;
    T.latV = follow2(T.lat, T.latV, 0.014 * amp * lat, 14, h);
    T.lat += T.latV * h;
    // the head: a pendulum on the neck, driven by the withers' vertical acceleration (the authored bob's at the other
    // gaits), lagging it a little (Rhodin et al. 2022: head minima within a few % of the stride of the withers')
    const ph = this.phase;
    const aBob = g.bob * amp * (TAU * g.beats * g.freq) ** 2 * Math.cos(TAU * (g.beats * ph - g.bobAt));
    const drive = g.slip * a + (1 - g.slip) * aBob;
    T.nodV += (-NECK_W * NECK_W * T.nod - 2 * NECK_Z * NECK_W * T.nodV + NECK_K * drive) * h;
    T.nod += T.nodV * h;
  }

  // ---- pose -----------------------------------------------------------------------------------------
  _pose(dt) {
    const B = this.bones, g = this.gait, ph = this.phase, amp = g.amp;
    const react = this.react;
    // body: the spring-mass trunk at the trot, the authored bob / pitch / roll of the other gaits, the ground's pitch
    // and roll, the lean, reactions
    this._trunk(dt, g, amp);
    const T = this.trunk, sl = g.slip;
    // (the two ends' pitch turns the trunk about its centre of mass, COM_Z ahead of the body's centre: 58 % of the weight
    // on the forehand)
    const bob = sl * (T.y - COM_Z * (T.ends / SPAN)) - (1 - sl) * g.bob * amp * Math.cos(TAU * (g.beats * ph - g.bobAt));
    const gPitch = (sl * T.ends) / SPAN + (1 - sl) * g.pitch * amp * Math.sin(TAU * (ph - g.pitchAt));
    const gRoll = sl * T.roll + (1 - sl) * g.roll * amp * Math.sin(TAU * ph);
    let rPitch = 0, rLift = 0, rBack = 0;
    if (react.kind === 'rear') {
      const k = bump(react.t / react.dur, 0.35, 1) * react.k;
      rPitch = 0.62 * k;
      rLift = 0.12 * k;
      rBack = -0.32 * k;
    } else if (react.kind === 'stumble') {
      const k = bump(react.t / react.dur, 0.2, 1) * react.k;
      rPitch = -0.14 * k;
      rLift = -0.08 * k;
    } else if (react.kind === 'shy') {
      const k = bump(react.t / react.dur, 0.25, 1);
      rPitch = 0.12 * k;
    }
    this.rearK = rPitch;
    const speedK = smooth(6, 13.5, Math.abs(this.speed));
    const breathe = 0.004 * Math.sin(this.time * 1.7);
    B.Body.position.set(this.restBody.x + sl * T.lat, this.restBody.y + bob + rLift - 0.035 * speedK + breathe, this.restBody.z + rBack);
    // pitch about the hind feet when rearing: the rotation pivots on the body centre, so lift it back
    const pitch = this.ground.pitch + gPitch + rPitch;
    if (rPitch > 0) B.Body.position.y += Math.sin(rPitch) * 0.55;
    _e.set(-pitch, 0, this.ground.roll + gRoll + this.lean, 'YXZ');
    B.Body.quaternion.setFromEuler(_e);
    // a little spine flexion at the canter and the gallop; the pelvis rolls on its own at the trot
    const flex = 0.03 * speedK * Math.sin(TAU * (ph - g.pitchAt + 0.25));
    B.Chest.quaternion.setFromAxisAngle(_X, flex);
    _e.set(-flex, 0, sl * (T.pelvis - T.roll), 'XYZ');
    B.Pelvis.quaternion.setFromEuler(_e);
    // neck and head: the gait's nod and the head's lag, a longer and lower carriage at speed, grazing, rearing, looking
    this.graze += (this.grazeWant * (Math.abs(this.speed) < 1.2 ? 1 : 0) - this.graze) * Math.min(1, dt * 1.6);
    const gz = smooth(0, 1, this.graze);
    const nod = g.nod * amp * Math.sin(TAU * (g.nodBeats * ph - g.nodAt)) + T.nod;
    this.lookYaw += (this.lookWant - this.lookYaw) * Math.min(1, dt * 2.5);
    this.lookWant *= Math.exp(-dt * 0.5);
    const idleLook = (1 - amp) * (0.12 * Math.sin(this.time * 0.31) + 0.06 * Math.sin(this.time * 0.73 + 1));
    const yaw = (this.lookYaw + idleLook) * (1 - 0.7 * gz);
    const ext = 0.22 * speedK; // the neck stretches forward at a gallop
    const rearUp = -rPitch * 0.7;
    this._bone('Neck1', 0.06 + 0.5 * gz + nod * 0.4 + ext * 0.5 + rearUp, yaw * 0.25);
    this._bone('Neck2', 0.04 + 0.42 * gz + nod * 0.35 + ext * 0.4, yaw * 0.3);
    this._bone('Neck3', 0.0 + 0.3 * gz + nod * 0.25 + ext * 0.1, yaw * 0.3);
    this._bone('Head', -0.08 + 0.1 * gz - nod * 0.3 - ext * 0.9 - 0.15 * this.alert, yaw * 0.15, 0.05 * Math.sin(this.time * 0.5) * (1 - amp));
    // the grazing chew: small head bobs while the muzzle is down
    if (gz > 0.5) B.Head.quaternion.multiply(_q.setFromAxisAngle(_X, 0.05 * Math.max(0, Math.sin(this.time * 6.5)) * gz));
    this.root.updateMatrixWorld(true);
    for (let l = 0; l < 4; l++) this._leg(l, g, amp, speedK);
    // ears: flick now and then, laid back at a gallop, pricked when alert
    for (let i = 0; i < 2; i++) {
      const e = this.ear[i];
      e.t -= dt;
      if (e.t <= 0) {
        e.t = 1.5 + Math.random() * 5;
        e.want = Math.random() < 0.5 ? -0.9 : 0.35;
        e.hold = 0.25 + Math.random() * 0.4;
      }
      if (e.hold > 0) e.hold -= dt;
      else e.want *= Math.exp(-dt * 3);
      const want = e.want - 0.55 * speedK + 0.3 * this.alert;
      e.a += (want - e.a) * Math.min(1, dt * 10);
      const ear = B[i ? 'EarR' : 'EarL'];
      _e.set(-0.25 * e.a, e.a * (i ? -0.6 : 0.6), 0, 'XYZ');
      ear.quaternion.setFromEuler(_e);
    }
    this.alert *= Math.exp(-dt * 0.5);
    this._tail(dt, speedK);
    // mane and tail hair: the wind in the horse's frame and the flap of the gait
    const p = this.root.position;
    this.game.wind.sample(p.x, p.z, _w2);
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // relative air: the wind plus the headwind of the run
    const ax = _w2.x * 0.09 - s * this.speed * 0.012, az = _w2.y * 0.09 - c * this.speed * 0.012;
    HAIR_UNIFORMS.uHairWind.value.set(ax * c - az * s, 0.004 * Math.abs(this.speed), ax * s + az * c);
    HAIR_UNIFORMS.uHairFlap.value = 0.006 + 0.012 * amp + 0.018 * speedK;
    HAIR_UNIFORMS.uHairTime.value = this.time;
  }

  _bone(name, pitchDown, yaw, roll = 0) {
    _e.set(pitchDown, yaw, roll, 'YXZ');
    this.bones[name].quaternion.setFromEuler(_e);
  }

  // One leg: its coronet target (planted, or on its swing path) into the leg's parent frame, the plane tilted toward it,
  // the pastern hung from it up to the fetlock, the 2D solve within the limb's anatomical reach, the bones.
  _leg(l, g, amp) {
    const L = this.legs[l];
    const segs = L.segs, k = L.fore ? 0 : 1;
    const pas = segs[L.fore ? 4 : 3], hoof = segs[L.fore ? 5 : 4];
    _m.copy(L.parent.matrixWorld).invert();
    // the parent's pitch against the ground, to author ground-frame angles (hoof flat, pastern)
    const me = L.parent.matrixWorld.elements;
    const zl = Math.hypot(me[8], me[9], me[10]) || 1;
    const phi = Math.asin(clamp(me[9] / zl, -1, 1)) - this.ground.pitch;
    const p = this.root.position, sn = Math.sin(this.yaw), cs = Math.cos(this.yaw);
    const stance = L.inStance;
    const rear = L.fore ? this.rearW : 0;
    let tip = 0, alpha = ALPHA0, kappa = 0, ext = 0;
    if (stance) {
      const u = L.u, fb = fetlockBell(u);
      // the hoof's roll on the ground: landing on the heel, flat, then over its toe. The roll takes some time whatever the
      // pace (BO_MIN): in a gallop's short stance the heel lifts earlier, as the fetlock recoils and the limb sweeps past
      // the hoof, rather than the whole roll being crammed into the last few hundredths of a second
      const uHo = Math.max(0.35, Math.min(U_HO[k], 1 - (BO_MIN * Math.max(L.rate, 1e-3)) / Math.max(L.dutyNow, 1e-3)));
      if (u < U_SETTLE) tip = TD_TIP * amp * (1 - smooth(0, U_SETTLE, u));
      else if (u > uHo) tip = g.toeOff[k] * amp * Math.pow((u - uHo) / (1 - uHo), 1.6);
      // once the heel is up the hoof only rolls on over its toe until it leaves the ground, and no faster than the digit
      // turns (a gallop's stance is too short for the whole roll: the hoof leaves less rolled)
      if (u > 0.4 && L.tip > tip) tip = L.tip;
      if (u > 0.4 && tip > L.tip) tip = Math.min(tip, L.tip + TIP_RATE * this._dt);
      // the fetlock sinks with the load: past its standing angle at the peak, above it when unloaded
      ext = (g.ext[k] * amp * (fb - LOAD_STAND)) / (1 - LOAD_STAND);
      if (L.fore) {
        // the carpus unlocks with the breakover and is folding ever faster as the toe leaves (its rate carries on into
        // the swing)
        const a = U_HO[k] - 0.06, r = u > a ? (u - a) / (1 - a) : 0;
        kappa = amp * (-CARPUS_HYP * fb + CARPUS_BO * r * r);
        L.kRate = (amp * CARPUS_BO * 2 * r * Math.max(0, L.rate)) / ((1 - a) * Math.max(0.12, L.dutyNow));
      }
      this._stanceCoronet(L, tip, sn, cs, rear);
    } else kappa = L.fore ? L.kappa : 0;
    if (rear > 0) kappa = Math.max(kappa, 1.9 * rear);
    this._toPlane(L, L.target, _T, true);
    // the swing hangs the pastern from the cannon (solved twice: the cannon's angle is the solve's own result)
    let r = null, R = HIND_MAX;
    const sc = segs[0];
    const tz = _T.z, ty = _T.y;
    for (let it = 0; it < (stance ? 1 : 2); it++) {
      if (!stance) {
        _T.z = tz;
        _T.y = ty;
        const aC = it === 0 ? L.aCg : r.aC + phi;
        const al = aC + L.ePlan + Math.PI;
        // before it lands the digit takes the angle the stance starts with
        const w = smooth(0.7, 1, L.s);
        alpha = al;
        if (w > 0) {
          this._fetlock(al - phi, pas.len);
          alpha += wrap(this._stanceAlpha(L, L.extTd, 0) + phi - al) * w;
        }
        this._fetlock(alpha - phi, pas.len);
      } else {
        const roll = PASTERN_ROLL[k] * Math.max(0, tip);
        this._fetlock(ALPHA0 + ext - roll - phi, pas.len);
        this._fetlock(this._stanceAlpha(L, ext, roll), pas.len);
      }
      if (L.fore) {
        // the shoulder blade swings about its top with a share of the limb's swing, and further as the limb needs to
        // reach the fetlock: it is the top segment of the fore limb's reach (Back et al. 1995a). It is a heavy segment
        // and turns no faster than SCAP_RATE: near the edge of the limb's reach the angle it needs moves very fast (the
        // reachable arc opens as the square root of the slack), and a blade that followed it would snap the shoulder
        R = foreReach(L.L, kappa, ELBOW_MIN);
        const want = sc.rest + clamp(SCAP_SHARE * (Math.atan2(_F.z, -_F.y) - L.fetAng), SCAP_SWING[0], SCAP_SWING[1]);
        scapAngle(_F, sc.len, want, sc.rest + SCAP_SWING[0], sc.rest + SCAP_SWING[1], R, _sa);
        if (it === (stance ? 0 : 1)) {
          // in the air the blade follows the angle it needs smoothly (critically damped at SCAP_W): that angle turns
          // sharply where the limb's reach stops binding, and a blade that followed it there would jerk the elbow
          const dt = this._dt;
          let a = L.scapA, v = L.scapV;
          if (stance) {
            // on the ground the blade follows its share of the limb's swing as smoothly (the share's own rate fed
            // forward, so that it does not lag), and turns further, no faster than SCAP_RATE, only where the limb could
            // not reach the planted hoof from there. A blade that swung back to its share the instant the limb came
            // within reach would snap the shoulder: the reachable arc opens as the square root of the slack, and
            // downhill or at the gallop the fore lands at full stretch
            const vW = dt > 0 ? clamp((want - L.scapW) / dt, -SCAP_RATE, SCAP_RATE) : 0;
            const n = Math.max(1, Math.ceil(dt * SCAP_W * 8)), h = dt / n;
            let fa = a, fv = v;
            for (let i = 1; i <= n; i++) {
              const tg = L.scapW + vW * h * i;
              fv = clamp(fv + (SCAP_W * SCAP_W * (tg - fa) + 2 * SCAP_W * (vW - fv)) * h, -SCAP_RATE, SCAP_RATE);
              fa += fv * h;
            }
            if ((_F.z - Math.cos(fa) * sc.len) ** 2 + (_F.y - Math.sin(fa) * sc.len) ** 2 <= R * R) (a = fa), (v = fv);
            else {
              // the angle the planted hoof needs, no faster than SCAP_RATE
              const na = a + clamp(_sa.a - a, -SCAP_RATE * dt, SCAP_RATE * dt);
              v = dt > 0 ? (na - a) / dt : 0;
              a = na;
            }
          } else {
            // (tracking the needed angle's own rate too, so that it does not lag a steady swing; the needed angle is
            // taken as moving steadily through the frame)
            // (and ever more closely as the hoof reaches for the ground, which the limb must reach where it lands)
            const vT = dt > 0 ? clamp((_sa.a - L.scapT) / dt, -SCAP_RATE, SCAP_RATE) : 0;
            const w = SCAP_W * (1 + 4 * smooth(0.75, 0.95, L.s));
            const n = Math.max(1, Math.ceil(dt * w * 8)), h = dt / n;
            for (let i = 1; i <= n; i++) {
              const tg = L.scapT + vT * h * i;
              v = clamp(v + (w * w * (tg - a) + 2 * w * (vT - v)) * h, -SCAP_RATE, SCAP_RATE);
              a += v * h;
            }
          }
          L.scapT = _sa.a;
          L.scapW = want;
          _sa.a = a;
          L.scapA = a;
          L.scapV = v;
        }
        _S.z = Math.cos(_sa.a) * sc.len;
        _S.y = Math.sin(_sa.a) * sc.len;
      } else _S.z = _S.y = 0;
      // in the swing the limb cannot stretch past its reach: as the hoof leaves the ground at full stretch it is drawn
      // after the limb, and once the limb folds it rides higher rather than the limb snapping straight (the pastern and
      // the hoof move with the fetlock); not as it meets the ground, where the limb reaches the landing spot as it is
      const wc = stance ? 0 : 1 - smooth(0.65, 0.9, L.s);
      if (wc > 0) {
        const fz = _F.z - _S.z, fy = _F.y - _S.y, d = Math.hypot(fz, fy);
        const d2 = softReach(d, R, 1 - 0.03 * smooth(0, 0.2, L.s));
        if (d2 < d) {
          const m = (d2 / d - 1) * wc;
          _F.z += fz * m;
          _F.y += fy * m;
          _T.z += fz * m;
          _T.y += fy * m;
        }
      }
      // a planted hoof the limb cannot reach any more (late in the stance) rolls further over its toe: the breakover
      // comes as the limb passes over the hoof, not at a set time
      if (stance && rear <= 0 && L.u > 0.4 && (_F.z - _S.z) ** 2 + (_F.y - _S.y) ** 2 > R * R) {
        this._toePlane(L, sn, cs);
        const extra = tipToReach(_P, _F, _S, R - 0.003);
        if (extra > 0) {
          // the hoof rolls over its toe no faster than the digit can turn (~1100°/s)
          tip = Math.min(Math.max(0, tip) + extra, Math.max(tip, L.tip + TIP_RATE * this._dt));
          this._stanceCoronet(L, tip, sn, cs, rear);
          this._toPlane(L, L.target, _T, false);
          this._fetlock(this._stanceAlpha(L, ext, PASTERN_ROLL[k] * tip), pas.len);
        }
        // still out of reach by more than a few cm (pushed, turned on the spot): the hoof will be picked up
        L.lost = Math.hypot(_F.z - _S.z, _F.y - _S.y) > R + 0.03;
      }
      // (the hind: in the swing the hock folds further than the stifle, turning the cannon from the femur)
      const delta = stance || L.fore ? L.delta : L.delta + HOCK_FOLD[0] * amp * foldCurve(L.s, HOCK_FOLD[1], HOCK_FOLD[2]);
      r = L.fore ? solveFore(_S, _F, L.L, kappa, L.ik, R) : solveHind(_S, _F, L.L, delta, L.ik, R);
    }
    if (L.fore) {
      segs[0].ang = _sa.a;
      segs[1].ang = r.aH;
      segs[2].ang = r.aR;
      segs[3].ang = r.aC;
    } else {
      segs[0].ang = r.aF;
      segs[1].ang = r.aT;
      segs[2].ang = r.aC;
    }
    pas.ang = Math.atan2(_T.y - r.F.y, _T.z - r.F.z);
    L.aCg = r.aC + phi;
    const eNow = wrap(pas.ang - r.aC);
    L.eV = stance && this._dt > 0 ? wrap(eNow - L.eNow) / this._dt : 0;
    L.eNow = eNow;
    // hoof: on the ground in the stance (flat, or rolled over its heel or toe); in the swing it leaves rolled, follows
    // the pastern, and is turned to its landing angle before it lands
    if (stance) {
      hoof.ang = hoof.rest - phi - tip;
      L.tipV = this._dt > 0 ? (tip - L.tip) / this._dt : 0;
      L.tip = tip;
      L.kappa = kappa;
      const n = L.now, t = L.target;
      n.px = n.x;
      n.pz = n.z;
      n.ph = n.h;
      n.x = (t.x - p.x) * cs - (t.z - p.z) * sn;
      n.z = (t.x - p.x) * sn + (t.z - p.z) * cs;
      // its height above the ground under it, as the swing measures it (on a slope the coronet of a hoof rolled over its
      // toe stands well ahead of where the sole was planted: measured from the plant, the swing would start a centimetre
      // off and drive the toe into a downhill slope)
      n.h = t.y - this.game.groundAt(t.x, t.z);
    } else {
      const follow = pas.ang + (hoof.rest - pas.rest);
      // (rolling on over the toe it has just left at the rate it had, easing off: the toe lifts where it was)
      const tau = L.s * L.tsw, carry = L.lo.tipV * (tau < BO_CARRY ? tau * (1 - tau / (2 * BO_CARRY)) : BO_CARRY / 2);
      const start = hoof.rest - phi - L.lo.tip - carry, end = hoof.rest - phi - TD_TIP * amp;
      let a = start + wrap(follow - start) * smooth(0, 0.18, L.s);
      a += wrap(end - a) * smooth(0.72, 1, L.s);
      hoof.ang = a;
    }
    // bones: the root gets the abduction then its sagittal turn, every child the difference to its parent
    let prev = 0;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      const a = sg.rest - sg.ang;
      if (i === 0) {
        _q.setFromAxisAngle(_Z, L.beta);
        _q2.setFromAxisAngle(_X, a);
        sg.bone.quaternion.multiplyQuaternions(_q, _q2);
      } else sg.bone.quaternion.setFromAxisAngle(_X, a - prev);
      prev = a;
    }
    // a hoof on the ground does not roll with the trunk: the leg plane leans with its parent's roll and its abduction,
    // the hoof turns back about its own length to stand flat (the digit takes the twist), easing in and out at the ends
    // of the swing
    const wr = stance ? 1 : 1 - smooth(0, 0.15, L.s) * (1 - smooth(0.88, 1, L.s));
    if (wr > 0) hoof.bone.quaternion.multiply(_q.setFromAxisAngle(_Z, -wr * (Math.asin(clamp(me[1] / (Math.hypot(me[0], me[1], me[2]) || 1), -1, 1)) + L.beta)));
  }

  // the fetlock target _F: the pastern (length len, at angle aL in the leg plane) up from the coronet _T
  _fetlock(aL, len) {
    _F.z = _T.z + Math.cos(aL) * len;
    _F.y = _T.y + Math.sin(aL) * len;
  }

  // The pastern's angle (leg plane) of a hoof on the ground, as the fetlock joint's own: turned from the cannon by its
  // standing extension plus `ext` (the load), less `roll` (the digit flexing as the hoof rolls over its toe). The cannon
  // is taken along the limb's line to the fetlock (_F, a first guess on entry): with the carpus locked and the hock
  // held by the reciprocal apparatus it turns with the limb, so the joint opens most at mid-stance with the cannon
  // upright under the peak load (Clayton, Mechanics of equine locomotion; Hobbs et al. 2016).
  _stanceAlpha(L, ext, roll) {
    return Math.atan2(_F.y, _F.z) + L.cOff + Math.PI + L.eRest + ext - roll;
  }

  // A world point into the leg's sagittal plane (parent frame in _m): z forward, y down along the plane tilted toward
  // it (the abduction, kept in L.beta when asked).
  _toPlane(L, wv, out, setBeta) {
    _w.copy(wv).applyMatrix4(_m);
    const dx = _w.x - L.root.x, dy = _w.y - L.root.y, dz = _w.z - L.root.z;
    if (setBeta) L.beta = Math.atan2(dx, -dy) - L.restTilt;
    out.z = dz;
    out.y = -Math.hypot(dx, dy) / L.restDrop;
  }

  // A planted hoof's coronet (world, into L.target): the hoof on the slope with its sole centre on the plant, rolled by
  // `tip` over its toe (tip > 0) or its heel (tip < 0), which stays where it is on the ground; a rearing fore lifted.
  _stanceCoronet(L, tip, sn, cs, rear) {
    const gp = this.ground.pitch;
    const oz = tip > 1e-6 ? HOOF.toe : tip < -1e-6 ? HOOF.heel : HOOF.sole;
    const d = oz - HOOF.sole;
    const a = gp - tip, ca = Math.cos(a), sa = Math.sin(a);
    const fz = d * Math.cos(gp) - oz * ca - HOOF.h * sa;
    const fy = d * Math.sin(gp) - oz * sa + HOOF.h * ca;
    L.target.set(L.plant.x + sn * fz, L.plant.y + fy + 0.75 * rear, L.plant.z + cs * fz);
  }

  // the planted hoof's toe in the leg plane, into _P
  _toePlane(L, sn, cs) {
    const gp = this.ground.pitch, d = HOOF.toe - HOOF.sole;
    _O3.set(L.plant.x + sn * d * Math.cos(gp), L.plant.y + d * Math.sin(gp), L.plant.z + cs * d * Math.cos(gp));
    this._toPlane(L, _O3, _P, false);
  }

  // Tail: a damped chain hanging from the croup; carried higher at speed, swinging against the turns, pushed by the wind,
  // with an idle swish now and then. The dock is held against the pelvis by its muscles; below it the tail hangs, and
  // gravity pulls each segment back toward the vertical (TAIL_G, 1/s²): as the pelvis rolls from one hind to the other
  // the hanging tail lags it and swings from side to side, and as the trunk bounces it drops while the trunk is pushed
  // up and flicks up as it falls (Muybridge 1887, plate 596, rear view). It swings aside about each segment's own long
  // axis, which turns a hanging tail sideways (about the vertical it would only spin).
  _tail(dt, speedK) {
    const B = this.bones, T = this.tail;
    const tr = this.trunk, sl = this.gait.slip;
    const lagY = -0.5 * sl * tr.acc;
    // the root's roll in the world: the ground's, the lean into a turn, the pelvis's own on the alternate hind stances
    let absY = this.ground.roll + this.lean + sl * tr.pelvis;
    const p = this.root.position;
    this.game.wind.sample(p.x, p.z, _w2);
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const side = _w2.x * c - _w2.y * s; // wind toward the horse's left (+x)
    const back = -(_w2.x * s + _w2.y * c) - this.speed * 0.08;
    this.swishT -= dt;
    if (this.swishT <= 0) {
      this.swishT = 2 + Math.random() * 6;
      if (Math.abs(this.speed) < 3) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        for (let i = 1; i < 5; i++) T[i].vy += dir * (2.2 + i * 0.6);
      }
    }
    const carriage = 0.25 * this.gait.tail * this.gait.amp + 0.15 * speedK;
    for (let i = 0; i < 5; i++) {
      const t = T[i];
      const k = i / 4;
      const wantX = (i === 0 ? carriage * 1.6 : carriage * (0.5 - k * 0.3)) + Math.max(0, back) * 0.04 * k + (this.rearK || 0) * -0.3;
      const wantY = side * 0.12 * (0.3 + k) - this.yawRate * 0.18 * k;
      const ax = 60 * (wantX - t.x) - 7 * t.vx + (i > 0 ? (T[i - 1].vx * 0.4) : 0) + lagY * (0.4 + k);
      // the dock follows the pelvis; the hanging segments are pulled toward hanging straight in the world
      const pull = i === 0 ? 45 * (wantY - t.y) : TAIL_G * (wantY - absY - t.y);
      const ay = pull - TAIL_D * t.vy + (i > 0 ? T[i - 1].vy * 0.5 : 0) + Math.sin(this.time * 3.1 + i) * 0.6 * speedK;
      t.vx += ax * dt;
      t.vy += ay * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.x = clamp(t.x, -0.6, 1.2);
      t.y = clamp(t.y, -0.9, 0.9);
      absY += t.y;
      _e.set(t.x, 0, t.y, 'XYZ');
      B['Tail' + (i + 1)].quaternion.setFromEuler(_e);
    }
  }

  // world pose of the seat (the rider's pelvis rests there)
  seatFrame(pos, quat) {
    this.seat.getWorldPosition(pos);
    if (quat) this.seat.getWorldQuaternion(quat);
    return pos;
  }
}
