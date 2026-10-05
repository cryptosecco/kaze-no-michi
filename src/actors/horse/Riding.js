import * as THREE from 'three';
import { wantedSpeed, SPEEDS, circleContact } from './steer.js';
import { SEAT, RIDER_ROOT, MOUNT_SPOT, LAND_SPOT } from './seat.js';
import { mountPath, dismountPath } from '../anim/ride.js';
import { POI } from '../../world/Layout.js';
import { t } from '../../ui/i18n.js';

// The samurai and his horse. Runs through one hook at the top of PlayerController.update (pc.mount = this):
//   drive(dt, control) → true while mounted or mounting (the on-foot controller is skipped), false on foot.
// On foot: H / d-pad left whistles the horse over; E by the saddle mounts (prayer and the standoff keep E where they
// apply; never in combat, a standoff, a prayer or the ending). Mounted: the move input, camera-relative as on foot,
// sets the heading (the horse turns toward it at a rate that shrinks with speed) and its magnitude the gait —
// walk / trot / canter; sprint gallops, Z holds a walk, releasing it slows to a stop, pulling back brakes and then
// backs up. E dismounts at a stand (at speed, hold E: the horse is pulled up first).
// A hit or a fight breaking out nearby throws the rider: he staggers on foot, the horse bolts 20–40 m and waits.
// A samurai who walks far from the horse without ever having whistled or ridden is shown the key once (HINT, prompt
// owner 'whistle'): it never takes the prompt line from the mount, interact, standoff or prayer prompts.
//   placeRider()   after horse.update: the rider sits the saddle (or follows the mount / dismount path)
//   late()         after the actors animated: the reins run from the bit to the rider's fists
// Sets: player.mounted, player.noiseRange (bandits hear hooves: Enemy.js), camRig.mount (profile), the cape's
// extra capsules (the horse's back), anim.footIK. Emits 'horse:whistle', 'horse:neigh', 'horse:mount',
// 'horse:dismount', 'horse:throw'.

const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Matrix4();
const _path = { x: 0, y: 0, z: 0 };
const _hit = { hit: false };
const smooth = (a, b, x) => {
  const k = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return k * k * (3 - 2 * k);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const MOUNT_TIME = 0.8, DISMOUNT_TIME = 0.75, APPROACH_MAX = 0.75;
const CALL_FAR = 80; // beyond this the horse comes back from just out of view
const CALL_NEAR = 35; // beyond this, a horse that isn't on screen also comes back from just out of view (no long wait)
// E mounts from within this distance (m) of the horse's body line. A called horse pulls up 2.9 m from the samurai, facing
// him (Horse.js, mode 'come'), which is 2.1 m from its chest: the reach covers that, so the mount prompt is there when it
// arrives and he need not step toward it.
export const MOUNT_REACH = 2.3;
// The whistle's key, shown once: farther than `far` m from the horse, `time` s in all (it can step aside meanwhile)
export const HINT = { far: 20, time: 8 };

export class Riding {
  constructor(game, horse, { player, pc, camRig, combat, standoff, quests, prompts }) {
    this.game = game;
    this.horse = horse;
    this.a = player;
    this.pc = pc;
    this.cam = camRig;
    this.combat = combat;
    this.standoff = standoff;
    this.quests = quests;
    this.prompts = prompts;
    this.state = 'off'; // off | approach | mounting | riding | dismounting
    this.t = 0;
    this.holdE = 0;
    this.pullUp = false;
    this.callT = -1;
    this.hintT = 0;
    this.callHint = { on: false, t: 0, done: false }; // the whistle's key: showing, seconds shown, never again
    this.ending = false;
    this.gaitClip = null;
    this.start = new THREE.Vector3();
    this.startYaw = 0;
    this.camK = 0;
    this.camState = { k: 0, gallop: 0, speed: 0, yaw: 0 };
    this.groupT = 0;
    this.groupNear = false;
    this.capsules = [
      [new THREE.Vector3(), new THREE.Vector3(), 0.3],
      [new THREE.Vector3(), new THREE.Vector3(), 0.2],
    ];
    player.mounted = false;
    player.noiseRange = 0;
    pc.mount = this;
    horse.onStuck = () => this._comeBack();
    // the rules of the saddle
    game.on('hit', (e) => {
      const d = e.detail || {};
      if (d.target === player && this.state !== 'off') this.throwOff(d.attacker);
    });
    game.on('combat:start', (e) => {
      if (this.state === 'off') return;
      const list = (e.detail && e.detail.enemies) || [];
      let near = null, best = 35;
      for (const en of list) {
        const dd = en.position.distanceTo(player.position);
        if (dd < best) (best = dd), (near = en);
      }
      if (near) this.throwOff(near);
    });
    game.on('ending', () => {
      if (this.state !== 'off') this.ending = true;
    });
    game.on('respawn', () => {
      if (this.state !== 'off') this._toFoot();
    });
    // a fallen samurai is shown nothing (this controller does not run until he gets up)
    game.on('player:death', () => this._hideCallHint());
  }

  get mounted() {
    return this.state !== 'off';
  }

  // ---- the hook in the player controller ----------------------------------------------------------------
  drive(dt, control) {
    const g = this.game, inp = g.input, a = this.a;
    if (this.state === 'off') {
      this._onFoot(dt, control);
      return this.state !== 'off';
    }
    this.t += dt;
    const h = this.horse, w = h.want;
    a.anim.loco.speed = Math.abs(h.speed);
    this.pc.vel.copy(h.vel);
    this.cam.sprinting = false; // in the saddle the mounted profile widens the frame at a gallop (CameraRig)
    if (this.state === 'approach') {
      // a few quick steps to the stirrup, then up
      const spot = this._spot(MOUNT_SPOT, _p);
      const dx = spot.x - a.position.x, dz = spot.z - a.position.z;
      const d = Math.hypot(dx, dz);
      const step = Math.min(d, 3.4 * dt);
      if (d > 1e-3) {
        a.position.x += (dx / d) * step;
        a.position.z += (dz / d) * step;
        a.setYaw(Math.atan2(dx, dz));
      }
      a.position.y = g.groundAt(a.position.x, a.position.z);
      a.anim.loco.speed = d > 0.05 ? 3 : 0;
      w.speed = 0;
      w.yaw = h.yaw;
      if (d < 0.08 || this.t > APPROACH_MAX) this._beginMount();
      return true;
    }
    if (this.state === 'mounting' || this.state === 'dismounting') {
      w.speed = 0;
      w.brake = true;
      w.yaw = h.yaw;
      a.anim.loco.speed = 0;
      if (this.state === 'mounting' && this.t >= MOUNT_TIME) this._seated();
      else if (this.state === 'dismounting' && this.t >= DISMOUNT_TIME) this._toFoot();
      return true;
    }
    // ---- riding ----
    w.brake = false;
    if (this.ending) {
      // the cliff at sunset: pull up and turn to face it
      const sun = g.lighting.sunDir;
      w.speed = 0;
      w.brake = true;
      w.yaw = Math.atan2(sun.x, sun.z);
      this.prompts.clear('horse');
      return true;
    }
    const m = control ? inp.move() : { x: 0, y: 0 };
    const mag = Math.min(1, Math.hypot(m.x, m.y));
    this.cam.forwardXZ(_f);
    this.cam.rightXZ(_r);
    const wx = _f.x * m.y + _r.x * m.x, wz = _f.z * m.y + _r.z * m.x;
    if (control && inp.pressed('walk')) this.pc.walkMode = !this.pc.walkMode;
    // the sprint asks for the gallop, read as on foot: Shift held or toggled (settings), the pad's L3 click or its
    // held dodge button (a tap of it does nothing in the saddle)
    const sprint = this.pc._sprintIntent(dt, control, mag).sprint;
    const fx = Math.sin(h.yaw), fz = Math.cos(h.yaw);
    if (mag > 0.15) {
      const wl = Math.hypot(wx, wz) || 1;
      const along = (wx * fx + wz * fz) / wl;
      const camBehind = _f.x * fx + _f.z * fz > 0.3;
      if (along < -0.75 && camBehind) {
        // pulling back: brake, then a slow back-up
        if (h.speed > 0.6) {
          w.speed = 0;
          w.brake = true;
        } else w.speed = SPEEDS.back * Math.min(1, mag * 1.2);
        w.yaw = h.yaw;
      } else {
        w.yaw = Math.atan2(wx, wz);
        w.speed = wantedSpeed(mag, { sprint, walk: this.pc.walkMode && !sprint });
        // from a stand a big turn is walked round first
        if (Math.abs(h.speed) < 1.2 && Math.abs(wrap(w.yaw - h.yaw)) > 1.0) w.speed = Math.min(w.speed, SPEEDS.walk);
      }
    } else {
      w.speed = 0;
      w.yaw = h.yaw;
    }
    // E: get off at a stand; held at speed, pull the horse up first
    if (control && inp.down('interact')) this.holdE += dt;
    if (control && inp.pressed('interact')) {
      if (Math.abs(h.speed) < 1.0) this._beginDismount();
      else this.hintT = 2.5;
    }
    if (!inp.down('interact')) this.holdE = 0;
    if (this.holdE > 0.4) this.pullUp = true;
    if (this.pullUp) {
      w.speed = 0;
      w.brake = true;
      if (Math.abs(h.speed) < 1.0) {
        this.pullUp = false;
        this._beginDismount();
      }
    }
    if (this.hintT > 0) this.hintT -= dt;
    this._prompts(dt);
    // bandits hear the hooves: a gallop carries far
    const sp = Math.abs(h.speed);
    a.noiseRange = sp > 10 ? 38 : sp > 6 ? 26 : sp > 2.6 ? 15 : sp > 0.5 ? 9 : 0;
    if (g.grass && g.grass.setPlayer) g.grass.setPlayer(h.position.x, h.position.y, h.position.z, 1.6);
    return true;
  }

  _prompts(dt) {
    const h = this.horse, P = this.prompts;
    if (this.state !== 'riding') return P.clear('horse');
    // an unaware group within standoff range (checked a few times a second)
    this.groupT -= dt;
    if (this.groupT <= 0) {
      this.groupT = 0.25;
      this.groupNear = !this.combat.inCombat && this.standoff.state === 'none' && this.standoff._group().length > 0;
    }
    const q = this.quests.current;
    const nearShrine = q && q.id === 'shrine' && Math.hypot(this.a.position.x - POI.shrine.x, this.a.position.z - POI.shrine.z) < q.radius;
    if (h.refused === 'stairs' || h.refused === 'building') P.set('horse', t('horseRefuse'), 'E');
    else if (nearShrine && !this.combat.inCombat) P.set('horse', t('horsePray'), 'E');
    else if (!this.combat.inCombat && this.standoff.state === 'none' && this.groupNear) P.set('horse', t('horseStandoff'), 'E');
    else if (this.hintT > 0) P.set('horse', t('horseSlow'), 'E');
    else if (Math.abs(h.speed) < 0.4 && h.refused !== 'slope') P.set('horse', t('horseDismount'), 'E');
    else P.clear('horse');
  }

  // ---- on foot: the whistle, the mount prompt -------------------------------------------------------------
  _onFoot(dt, control) {
    const g = this.game, inp = g.input, a = this.a;
    a.noiseRange = 0;
    if (this.callT >= 0) {
      this.callT -= dt;
      if (this.callT < 0) this._answer();
    }
    if (control && inp.pressed('horse') && a.alive) {
      g.emit('horse:whistle', { actor: a });
      this.callT = 0.45;
      this._endCallHint();
    }
    const can = control && this._canMount();
    if (can) this.prompts.set('horse', t('horseMount'), 'E');
    else this.prompts.clear('horse');
    if (can && inp.pressed('interact')) this._beginApproach();
    this._callHint(dt, control);
  }

  // The key that calls the horse, shown once: the first time the samurai, on foot and in control, is far from a horse he
  // never whistled for nor rode. It stays up HINT.time s in all, until he whistles or mounts; it hides while he is
  // fighting, in a standoff or a prayer, or while any other prompt holds the line (and shows again when that is gone).
  _callHint(dt, control) {
    const c = this.callHint, P = this.prompts;
    if (c.done) return;
    const a = this.a, h = this.horse, q = this.quests;
    // free to read it (in control, not fighting, not in a standoff, a prayer or the ending) and far from the horse
    let show = control && a.alive && !this.combat.inCombat && this.standoff.state === 'none';
    show = show && !(q.praying > 0) && !(q.ending > 0);
    show = show && Math.hypot(h.position.x - a.position.x, h.position.z - a.position.z) > HINT.far;
    // the line is the other prompts' first (Prompts shows the last one set: this one is never set over them)
    if (show) for (const owner of P.stack.keys()) if (owner !== 'whistle') show = false;
    if (show) {
      if (!c.on) {
        c.on = true;
        P.set('whistle', t('horseCall'), 'H');
      }
      c.t += dt;
      if (c.t >= HINT.time) this._endCallHint();
    } else this._hideCallHint();
  }

  // off the prompt line (it may come back)
  _hideCallHint() {
    if (!this.callHint.on) return;
    this.callHint.on = false;
    this.prompts.clear('whistle');
  }

  // off the prompt line for good: he whistled, mounted, or has seen it for HINT.time s
  _endCallHint() {
    this.callHint.done = true;
    this._hideCallHint();
  }

  _canMount() {
    const g = this.game, a = this.a, h = this.horse, f = this.pc.f;
    if (!a.alive || !h.visible || f.busy) return false;
    if (this.combat.inCombat || g.standoffActive || this.pc.controlLock > 0) return false;
    if (this.quests.praying > 0 || this.quests.ending > 0) return false;
    if (Math.abs(h.speed) > 1.5 || h.mode === 'flee' || h.react.kind) return false;
    // within reach of the saddle: distance to the horse's body line
    const p = h.position, s = Math.sin(h.yaw), c = Math.cos(h.yaw);
    const dx = a.position.x - p.x, dz = a.position.z - p.z;
    const along = Math.max(-0.7, Math.min(0.75, dx * s + dz * c));
    const d = Math.hypot(dx - s * along, dz - c * along);
    if (d > MOUNT_REACH) return false;
    // E belongs to the prayer and the standoff where they apply
    const q = this.quests.current;
    if (q && q.id === 'shrine' && Math.hypot(a.position.x - q.target().x, a.position.z - q.target().z) < q.radius) return false;
    if (this.standoff.state === 'none' && this.standoff._group().length) return false;
    return true;
  }

  // the whistle reaches the horse: it neighs and comes, or reappears just out of view if it is far or cut off
  _answer() {
    const h = this.horse, a = this.a;
    if (this.state !== 'off' || !a.alive) return;
    const d = Math.hypot(h.position.x - a.position.x, h.position.z - a.position.z);
    h.alert = 1;
    if (d < 4) {
      h._lookAt(a.position, 1);
      this.game.emit('horse:neigh', { actor: h });
      return;
    }
    if (d > CALL_FAR || (d > CALL_NEAR && !this._onScreen(h.position)) || !this._clearLine(h.position, a.position)) this._comeBack();
    h.mode = 'come';
    h.modeT = 0;
    h.stuckT = 0;
    h.lastDist = d;
    this.game.emit('horse:neigh', { actor: h });
  }

  // the horse reappears ~30 m away, behind the camera, on open ground with a clear run to the samurai
  _comeBack() {
    const g = this.game, a = this.a, h = this.horse;
    const cam = g.camera;
    cam.getWorldDirection(_a);
    const back = Math.atan2(-_a.x, -_a.z);
    for (const dist of [32, 24, 40, 18]) {
      for (const off of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
        const ang = back + off;
        const x = a.position.x + Math.sin(ang) * dist, z = a.position.z + Math.cos(ang) * dist;
        if (!h._groundOK(x, z, -Math.sin(ang), -Math.cos(ang)).ok) continue;
        if (circleContact(g.colliders, x, z, 1.4, -Infinity, _hit).hit) continue;
        _b.set(x, 0, z);
        if (!this._clearLine(_b, a.position)) continue;
        // out of the frame
        _b.set(x, g.groundAt(x, z), z);
        if (this._onScreen(_b)) continue;
        h.place(x, z, Math.atan2(a.position.x - x, a.position.z - z));
        h.speed = SPEEDS.canter;
        h.mode = 'come';
        h.modeT = 0;
        h.stuckT = 0;
        h.lastDist = dist;
        return true;
      }
    }
    return false;
  }

  // within the camera's horizontal view (with a margin), the body a metre above the ground at `pos`
  _onScreen(pos) {
    const cam = this.game.camera;
    cam.getWorldDirection(_a);
    _c.set(pos.x - cam.position.x, pos.y + 1 - cam.position.y, pos.z - cam.position.z).normalize();
    return _c.dot(_a) > Math.cos(THREE.MathUtils.degToRad(cam.fov * 0.5 * cam.aspect + 12));
  }

  _clearLine(from, to) {
    const g = this.game, h = this.horse;
    const dx = to.x - from.x, dz = to.z - from.z;
    const d = Math.hypot(dx, dz);
    const n = Math.max(1, Math.floor(d / 2));
    for (let i = 1; i < n; i++) {
      const x = from.x + (dx * i) / n, z = from.z + (dz * i) / n;
      if (circleContact(g.colliders, x, z, 0.75, -Infinity, _hit).hit) return false;
      if (!h._groundOK(x, z, dx / d, dz / d).ok) return false;
    }
    return true;
  }

  // ---- transitions ----------------------------------------------------------------------------------------
  _spot(local, out) {
    const h = this.horse, p = h.position, s = Math.sin(h.yaw), c = Math.cos(h.yaw);
    out.set(p.x + local.x * c + local.z * s, 0, p.z - local.x * s + local.z * c);
    out.y = this.game.groundAt(out.x, out.z);
    return out;
  }

  _beginApproach() {
    const a = this.a, h = this.horse;
    this.state = 'approach';
    this.t = 0;
    a.mounted = true;
    h.ridden = true;
    h.noPush = true;
    h.mode = 'ridden';
    h.want.speed = 0;
    h.want.yaw = h.yaw;
    this.pc.vel.set(0, 0, 0);
    this.prompts.clear('horse');
    this._endCallHint();
    if (this.pc.f.drawn) this.pc.f.sheatheSword();
  }

  _beginMount() {
    const a = this.a;
    this.state = 'mounting';
    this.t = 0;
    this.start.copy(a.position);
    this.startYaw = a.yaw;
    a.anim.footIK = false;
    a.anim.setBase('ride', 'ride_idle', 0.6);
    a.anim.play('mount', { fade: 0.08, fadeOut: 0.22 });
    this.game.emit('horse:mount', { actor: a });
  }

  _seated() {
    this.state = 'riding';
    this.t = 0;
    this.horse.noPush = false;
    this.gaitClip = 'ride_idle';
  }

  _beginDismount() {
    const a = this.a;
    this.state = 'dismounting';
    this.t = 0;
    this.prompts.clear('horse');
    a.anim.play('dismount', { fade: 0.08, fadeOut: 0.2 });
    this.horse.noPush = true;
    this.game.emit('horse:dismount', { actor: a });
  }

  // back on his feet beside the horse (end of the dismount, a throw, a respawn)
  _toFoot() {
    const a = this.a, h = this.horse;
    this.state = 'off';
    this.ending = false;
    this.pullUp = false;
    a.mounted = false;
    a.noiseRange = 0;
    a.anim.footIK = true;
    a.anim.setBase(this.pc.f.drawn ? 'combat' : 'free', null, 0.25);
    a.setYaw(a.yaw);
    a.position.y = this.game.groundAt(a.position.x, a.position.z);
    a.root.updateMatrixWorld(true);
    if (a.cape) a.cape.extraCapsules = null;
    this.cam.mount = null;
    h.ridden = false;
    h.noPush = false;
    if (h.mode === 'ridden') h.mode = 'wait';
    h.want.speed = 0;
    h.want.yaw = h.yaw;
    this.prompts.clear('horse');
  }

  throwOff(from) {
    if (this.state === 'off') return;
    const a = this.a, h = this.horse, g = this.game;
    // down on the near side (or the far one if something stands there)
    let spot = this._spot(LAND_SPOT, _p);
    if (circleContact(g.colliders, spot.x, spot.z, 0.4, -Infinity, _hit).hit || g.groundAt(spot.x, spot.z) < 0.3) spot = this._spot({ x: -LAND_SPOT.x, z: LAND_SPOT.z }, _p);
    a.position.copy(spot);
    a.setYaw(h.yaw);
    a.anim.layers = [];
    this._toFoot();
    a.anim.setBase('free', null, 0);
    a.anim.base.prev = null;
    if (a.alive) this.pc.f.staggerFor(1.1, from && from.position ? from : null);
    this.cam.shake(0.6);
    g.emit('horse:throw', { actor: a });
    // the horse bolts away from the trouble, 20–40 m, and waits there
    const tx = from && from.position ? from.position.x : a.position.x, tz = from && from.position ? from.position.z : a.position.z;
    let ang = Math.atan2(h.position.x - tx, h.position.z - tz);
    const dist = 20 + Math.random() * 20;
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
      const x = h.position.x + Math.sin(ang + off) * dist, z = h.position.z + Math.cos(ang + off) * dist;
      if (h._groundOK(x, z, Math.sin(ang + off), Math.cos(ang + off)).ok && this._clearLine(h.position, _b.set(x, 0, z))) {
        ang += off;
        break;
      }
    }
    h.target.set(h.position.x + Math.sin(ang) * dist, 0, h.position.z + Math.cos(ang) * dist);
    h.mode = 'flee';
    h.modeT = 0;
    h.startReact('shy', 6);
    g.emit('horse:neigh', { actor: h });
  }

  // ---- after the horse moved: the rider on the saddle ------------------------------------------------------
  placeRider() {
    if (this.state === 'off' || this.state === 'approach') {
      this.camK += (0 - this.camK) * 0.1;
      return;
    }
    const a = this.a, h = this.horse;
    const root = a.root;
    if (this.state === 'riding') {
      h.seatFrame(_p, _q);
      // the rider's root sits below the seat by RIDER_ROOT, in the saddle's frame
      _a.set(RIDER_ROOT.x - SEAT.x, RIDER_ROOT.y - SEAT.y, RIDER_ROOT.z - SEAT.z).applyQuaternion(_q);
      root.position.copy(_p).add(_a);
      root.quaternion.copy(_q);
      a.yaw = h.yaw;
      this._gaitClip();
    } else {
      // mounting / dismounting: along the path in the horse's frame, turning to the horse's heading
      const k = this.state === 'mounting' ? this.t / MOUNT_TIME : this.t / DISMOUNT_TIME;
      if (this.state === 'mounting') mountPath(k, _path);
      else dismountPath(k, _path);
      h.root.updateMatrixWorld(true);
      _b.set(_path.x, _path.y, _path.z).applyMatrix4(h.root.matrixWorld);
      if (this.state === 'mounting') {
        // from where he stood, onto the path
        const s = smooth(0, 0.3, k);
        _c.copy(this.start).lerp(_b, s);
        _b.copy(_c);
        if (_path.y === 0) _b.y = Math.max(_b.y, this.game.groundAt(_b.x, _b.z));
      } else if (k > 0.9) _b.y = Math.max(_b.y, this.game.groundAt(_b.x, _b.z));
      root.position.copy(_b);
      const yaw = this.state === 'mounting' ? this.startYaw + wrap(h.yaw - this.startYaw) * smooth(0, 0.35, k) : h.yaw;
      a.yaw = yaw;
      root.quaternion.setFromAxisAngle(_r.set(0, 1, 0), yaw);
      if (this.state === 'dismounting' && k > 0.55 && a.anim.base.mode === 'ride') a.anim.setBase('free', null, 0.3);
    }
    a.anim.lean = 0;
    root.updateMatrixWorld(true);
    // the cape lies over the horse's back and croup
    if (a.cape) {
      const B = h.bones.Body;
      const [c1, c2] = this.capsules;
      c1[0].set(0, 0.06, 0.25).applyMatrix4(B.matrixWorld);
      c1[1].set(0, 0.07, -0.55).applyMatrix4(B.matrixWorld);
      c2[0].set(0, 0.0, -0.6).applyMatrix4(B.matrixWorld);
      c2[1].set(0, -0.12, -0.78).applyMatrix4(B.matrixWorld);
      a.cape.extraCapsules = this.capsules;
    }
    // camera: the mounted profile, wider at a gallop
    const sp = Math.abs(h.speed);
    this.camK += ((this.state === 'riding' ? 1 : 0.6) - this.camK) * 0.08;
    const cs = this.camState;
    cs.k = this.camK;
    cs.gallop = smooth(8.5, 13.5, sp);
    cs.speed = sp;
    cs.yaw = h.yaw;
    this.cam.mount = cs;
  }

  // the seated clip that matches the horse's gait, its time locked to the stride
  _gaitClip() {
    const h = this.horse, a = this.a, g = h.gait;
    const sp = Math.abs(h.speed);
    let clip = 'ride_idle';
    if (sp > 0.35) clip = g.index === 0 ? (g.w > 0.5 ? 'ride_trot' : 'ride_walk') : g.index === 1 ? (g.w > 0.5 ? 'ride_canter' : 'ride_trot') : g.index === 2 ? (g.w > 0.5 ? 'ride_gallop' : 'ride_canter') : 'ride_gallop';
    if (clip !== this.gaitClip) {
      a.anim.setBase('ride', clip, 0.4);
      this.gaitClip = clip;
    }
    if (clip !== 'ride_idle') a.anim.base.time = h.phase * a.anim.clips[clip].duration;
  }

  // ---- reins: from the bit rings to the rider's fists (or back over the neck to the pommel) --------------------
  late() {
    const r = this.reins;
    if (!r) return;
    const h = this.horse, a = this.a;
    const seated = this.state === 'riding' || (this.state === 'mounting' && this.t > MOUNT_TIME * 0.7) || (this.state === 'dismounting' && this.t < DISMOUNT_TIME * 0.3);
    for (let i = 0; i < 2; i++) {
      h.bits[i].getWorldPosition(_a);
      if (seated) {
        const hand = a.rig.bones[i === 0 ? 'LeftHand' : 'RightHand'];
        hand.getWorldPosition(_b);
        // the fist's centre, a little past the wrist
        _c.set(i === 0 ? 0.07 : -0.07, -0.01, 0).applyQuaternion(hand.getWorldQuaternion(_q));
        _b.add(_c);
      } else {
        h.pommel.getWorldPosition(_b);
        _b.x += (i === 0 ? 1 : -1) * 0.05 * Math.cos(h.yaw);
        _b.z -= (i === 0 ? 1 : -1) * 0.05 * Math.sin(h.yaw);
      }
      r.set(i, _a, _b, seated ? 0.05 : 0.09);
    }
    r.commit();
  }
}

// Two thin dynamic tubes; positions rewritten in place every frame (no allocation).
export class Reins {
  constructor(material, segs = 10, sides = 4, radius = 0.007) {
    this.segs = segs;
    this.sides = sides;
    this.radius = radius;
    const ring = sides + 1;
    const nv = 2 * (segs + 1) * ring;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(nv * 3);
    this.nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const c = new THREE.Color('#7a1c12');
    for (let i = 0; i < nv; i++) col.set([c.r, c.g, c.b], i * 3);
    const idx = [];
    for (let r = 0; r < 2; r++)
      for (let s = 0; s < segs; s++)
        for (let k = 0; k < sides; k++) {
          const a = r * (segs + 1) * ring + s * ring + k, b = a + 1, cc = a + ring, d = cc + 1;
          idx.push(a, cc, b, b, cc, d);
        }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'horse-reins';
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._bn = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  // rein i from a to b, sagging by `sag` m at the middle
  set(i, a, b, sag) {
    const { segs, sides, radius } = this;
    const ring = sides + 1;
    const T = this._t.subVectors(b, a).normalize();
    const N = this._n.set(0, 1, 0).addScaledVector(T, -T.y);
    if (N.lengthSq() < 1e-6) N.set(1, 0, 0);
    N.normalize();
    const Bn = this._bn.crossVectors(T, N);
    for (let s = 0; s <= segs; s++) {
      const u = s / segs;
      const p = this._p.copy(a).lerp(b, u);
      p.y -= sag * 4 * u * (1 - u);
      for (let k = 0; k <= sides; k++) {
        const th = (k / sides) * Math.PI * 2;
        const cx = Math.cos(th), sy = Math.sin(th);
        const nx = N.x * cx + Bn.x * sy, ny = N.y * cx + Bn.y * sy, nz = N.z * cx + Bn.z * sy;
        const o = (i * (segs + 1) * ring + s * ring + k) * 3;
        this.pos[o] = p.x + nx * radius;
        this.pos[o + 1] = p.y + ny * radius;
        this.pos[o + 2] = p.z + nz * radius;
        this.nor[o] = nx;
        this.nor[o + 1] = ny;
        this.nor[o + 2] = nz;
      }
    }
  }

  commit() {
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }
}

