import * as THREE from 'three';
import { turnToward } from './Enemy.js';
import { ActionBuffer } from '../core/ActionBuffer.js';
import { SprintControl, topSpeed, slopeFactor } from './locomotion.js';
import { canAct } from './combat/windows.js';

// Player controller (runs once per rendered frame so inputs are never doubled or missed).
//   WASD / left stick move (camera-relative) · Shift sprint (hold or toggle: settings) · Z walk toggle · Space/C dodge
//   LMB light combo · RMB / F heavy · Q block (tap on impact = parry) · R heal (resolve)
//   E interact / standoff · T guiding wind · F1 dev free camera · pad: L3 click toggles the sprint, B taps a dodge or
//   holds a sprint (locomotion.js)
// Combat presses are buffered (ActionBuffer): pressed up to 0.2 s before their action is legal, they fire the moment it
// is. Cancel windows come from the clips' meta (combat/windows.js): a dodge or a block cuts an attack's recovery once
// its hit window is over, an attack or a block cuts a dodge after its travel, and movement takes over the tail of either
// (`recover`) — with a direction and sprint still held, the run picks up again without pressing anything. Out of combat
// a sprint sheathes the blade on the run; in combat it is a slower drawn-sword sprint. Attacks turn into the foe they
// aim at and close a short gap to it (Fighter.actionMotion). A hard stop from a sprint skids and settles.
// Emits 'footstep' {surface, speed}, 'player:health', 'player:resolve', 'heal'.

// bindings (dodge, heavy, block, walk, freecam) live in the core action map: src/core/Input.js

const _w = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Vector3();
const ASSIST = 3.6; // m: an attack closes the gap to a foe this near (~3.5 m between bodies)

export class PlayerController {
  constructor(game, fighter, camRig, combat) {
    this.game = game;
    this.f = fighter;
    this.a = fighter.actor;
    this.cam = camRig;
    this.combat = combat;
    this.vel = new THREE.Vector3();
    this.walkMode = false;
    this.combo = 0;
    this.lastAttackEnd = 0;
    this.buffer = new ActionBuffer(0.2);
    this.sprintCtl = new SprintControl();
    this.sprinting = false;
    this.heavyHold = 0;
    this.enabled = false;
    this.sheatheTimer = 0;
    this.stepPhase = 0;
    this.respawn = null;
    this.checkpoint = null;
    this.time = 0;
    this.slope = 1;
    this.settle = 0; // skid out of a sprint (0..1), drives the animator's settle
    this.a.resolve = 1;
    this.a.maxResolve = 3;
    this.controlLock = 0; // seconds of locked control (cutscenes, prayer)
    this.mount = null; // riding hook, set by the horse module (src/actors/horse/Riding.js)
  }

  setCheckpoint(x, z, yaw) {
    this.checkpoint = { x, z, yaw };
  }

  update(dt) {
    const g = this.game, a = this.a, f = this.f, inp = g.input;
    this.time += dt;
    f.update(dt);
    if (inp.pressed('freecam')) {
      g.freeCam.enabled = !g.freeCam.enabled;
      if (g.freeCam.enabled) g.freeCam.syncFromCamera();
    }
    if (!a.alive) {
      if (!this.respawn) this.respawn = 4.5;
      this.respawn -= dt;
      this.a.anim.loco.speed = 0;
      if (this.respawn <= 0) this._respawn();
      return;
    }
    const control = this.enabled && g.state === 'play' && !g.freeCam.enabled && this.controlLock <= 0 && !g.standoffActive;
    if (this.controlLock > 0) this.controlLock -= dt;
    // ---- horse (src/actors/horse/Riding.js): mounting, riding or dismounting, the riding module drives --------
    if (this.mount && this.mount.drive(dt, control)) return;
    // camera-relative wish direction
    const m = control ? inp.move() : { x: 0, y: 0 };
    this.cam.forwardXZ(_f);
    this.cam.rightXZ(_r);
    const wish = _w.set(0, 0, 0).addScaledVector(_f, m.y).addScaledVector(_r, m.x);
    const mag = Math.min(1, Math.hypot(m.x, m.y));
    if (control && inp.pressed('walk')) this.walkMode = !this.walkMode;
    const intent = this._sprintIntent(dt, control, mag);
    const sprint = (this.sprinting = intent.sprint);

    // ---- actions --------------------------------------------------------------------------------------
    if (control) this._actions(dt, wish, mag, intent.dodge);
    else this.buffer.clear();

    // sheathe out of combat: at once when a sprint starts (on the run, the legs keep going), else after a quiet moment
    if (f.drawn && !this.combat.inCombat && !f.busy && !f.blocking) {
      this.sheatheTimer += dt;
      if (sprint || this.sheatheTimer > 3.5) f.sheatheSword({ moving: sprint || this.vel.length() > 0.5 });
    } else this.sheatheTimer = 0;
    // movement takes over the tail of a dodge or an attack
    if (control && mag > 0.25) this._moveCancel(wish);

    // ---- movement --------------------------------------------------------------------------------------
    this._move(dt, wish, mag, sprint);
  }

  // Sprint intent from Shift (hold / toggle, per the settings), the pad's L3 click and its dodge button (held).
  _sprintIntent(dt, control, mag) {
    const g = this.game, inp = g.input, s = this.sprintCtl;
    s.mode = (g.settings && g.settings.sprintMode) || 'hold';
    if (!control) {
      s.reset();
      return { sprint: false, dodge: false };
    }
    return s.update(dt, {
      key: inp.down('sprint', 'key'),
      keyPressed: inp.pressed('sprint', 'key'),
      padClick: inp.pressed('sprint', 'pad'),
      padDodge: inp.down('dodge', 'pad'),
      padDodgePressed: inp.pressed('dodge', 'pad'),
      moving: mag > 0.25,
      combat: this.combat.inCombat || !!this.cam.combatTarget,
    });
  }

  // Combat presses go through the buffer; the newest press whose action is legal (cancel windows) fires.
  _actions(dt, wish, mag, padDodge) {
    const g = this.game, a = this.a, f = this.f, inp = g.input, buf = this.buffer, now = this.time;
    if (inp.pressed('dodge', 'key') || padDodge) buf.press('dodge', now);
    if (inp.pressed('attack')) buf.press('light', now);
    if (inp.pressed('heavy')) this.heavyHold = 0;
    if (inp.down('heavy')) this.heavyHold += dt;
    if (inp.released('heavy')) buf.press('heavy', now);
    const state = this._combatState();
    const next = buf.newest(['dodge', 'light', 'heavy'].filter((k) => canAct(k, state)), now);
    if (next === 'dodge') {
      buf.clear('dodge');
      this._dodge(wish, mag);
    } else if (next) {
      buf.clear('light');
      buf.clear('heavy');
      this._attack(next, wish);
    }
    // block / parry (held): as soon as it is legal, cutting an attack's recovery or a dodge's tail short
    if (inp.down('block')) {
      if (!f.blocking && canAct('block', this._combatState())) {
        f.cancelAttack(0.1);
        f.endDodge(0.1);
        if (!f.drawn) f.drawSword();
        f.startBlock();
      }
    } else f.stopBlock();
    if (inp.pressed('heal') && (a.resolve || 0) >= 1 && a.hp < a.maxHp && !f.busy) {
      a.resolve -= 1;
      a.hp = Math.min(a.maxHp, a.hp + 38);
      g.emit('heal', { actor: a });
      g.emit('player:health', { hp: a.hp, max: a.maxHp });
      g.emit('player:resolve', { value: a.resolve, max: a.maxResolve });
    }
  }

  // the fighter's state as the cancel windows read it (combat/windows.js)
  _combatState() {
    const f = this.f, at = f.attack, dg = f.dodge, act = f.anim.action;
    return {
      stagger: f.stagger,
      hitT: act && act.name === 'hit' ? act.time : -1,
      blocking: f.blocking,
      attack: at ? { t: at.layer.time, hit: at.meta.hit, combo: at.meta.combo } : null,
      dodge: dg ? { t: dg.layer.time, cancel: dg.meta.cancel, chain: dg.meta.chain } : null,
    };
  }

  _dodge(wish, mag) {
    const f = this.f, a = this.a;
    const dir = mag > 0.2 ? wish.clone() : a.forward(new THREE.Vector3()).negate();
    f.endDodge(0.06); // a chained dodge
    // in a fight the dodge comes out with the blade; out of one the scabbard stays shut (dodge_free)
    const fight = this.combat.inCombat || !!this.cam.combatTarget;
    if (!f.drawn && a.weaponKind === 'katana' && fight) f.drawSword();
    f.startDodge(dir, f.drawn ? 'dodge' : 'dodge_free');
  }

  _attack(kind, wish) {
    const f = this.f;
    const target = this._pickTarget(wish);
    f.endDodge(0.08); // a strike straight out of a dodge
    if (!f.drawn) f.drawSword(); // draw-cut: the attack starts right away over the draw
    if (kind === 'light') {
      if (!f.attack && this.time - this.lastAttackEnd > 0.7) this.combo = 0;
      this.combo = (this.combo % 3) + 1;
      f.startAttack('light' + this.combo, { target, assist: ASSIST });
    } else {
      f.startAttack('heavy', { target, speed: this.heavyHold > 0.5 ? 1.15 : 1, assist: ASSIST });
      this.combo = 0;
    }
    const layer = f.attack && f.attack.layer;
    if (layer) {
      const prev = layer.onEnd;
      layer.onEnd = (l) => {
        if (prev) prev(l);
        this.lastAttackEnd = this.time;
      };
    }
    this.heavyHold = 0;
    this.sheatheTimer = 0;
  }

  // Movement input takes over the tail of a dodge or an attack (clip meta `recover`). A dodge keeps the part of its
  // exit speed that goes where the stick points, so a held sprint carries straight on out of it.
  _moveCancel(wish) {
    const f = this.f, dg = f.dodge, at = f.attack;
    if (dg && dg.layer.time >= (dg.meta.recover ?? Infinity)) {
      const [t0, t1, dist] = dg.meta.move || [0, 1, 0];
      const along = Math.max(0, (dg.dir.x * wish.x + dg.dir.z * wish.z) / Math.max(1e-4, Math.hypot(wish.x, wish.z)));
      f.endDodge(0.2);
      this.vel.copy(dg.dir).multiplyScalar((dist / (t1 - t0)) * 0.6 * along);
    } else if (at && at.layer.time >= (at.meta.recover ?? Infinity)) f.cancelAttack(0.2);
  }

  _move(dt, wish, mag, sprint) {
    const g = this.game, a = this.a, f = this.f;
    const busy = f.busy;
    const foe = this.cam.combatTarget;
    const facingFoe = f.drawn && !!foe && !busy && (!sprint || f.blocking); // a combat sprint faces where it runs
    // facing the foe, the drawn footwork carries sideways and back; straight at him it opens into the drawn run
    let strafe = 0;
    if (facingFoe && mag > 0.1) {
      const dx = foe.position.x - a.position.x, dz = foe.position.z - a.position.z;
      const at = (wish.x * dx + wish.z * dz) / (Math.max(1e-4, Math.hypot(dx, dz)) * Math.max(1e-4, Math.hypot(wish.x, wish.z)));
      strafe = 1 - THREE.MathUtils.smoothstep(at, 0.6, 0.85);
    }
    // slopes: uphill slower, downhill a touch faster (smoothed, the ground is noisy)
    this.slope += (this._slopeAt(wish, mag) - this.slope) * Math.min(1, dt * 6);
    const top = topSpeed({ drawn: f.drawn, sprint, walk: this.walkMode || mag < 0.55, guard: f.blocking, strafe }) * this.slope;
    const target = _m.copy(wish).multiplyScalar(busy ? 0 : top * (mag > 0 ? Math.max(mag, 0.35) : 0));
    // quick to get going, quicker to stop; letting go out of a sprint skids a short way and settles
    const spd0 = this.vel.length();
    const stopping = target.lengthSq() < 0.01 && !busy;
    if (stopping && spd0 > 5) this.settle = Math.max(this.settle, Math.min(1, (spd0 - 4) / 2.4));
    const rate = target.lengthSq() > spd0 * spd0 ? 12 : stopping && this.settle > 0.3 ? 8 : 16;
    this.vel.lerp(target, 1 - Math.exp(-dt * rate));
    this.settle = Math.max(0, this.settle - dt * (stopping ? 2.6 : 6));
    a.anim.settle += (this.settle - a.anim.settle) * Math.min(1, dt * 14);
    const spd = this.vel.length();
    this.cam.sprinting = sprint && !f.drawn && (spd > 4.5 || !!f.dodge);
    let turnRate = 0;
    if (facingFoe) {
      const t = foe.position;
      turnRate = turnToward(a, Math.atan2(t.x - a.position.x, t.z - a.position.z), dt, 9);
    } else if (!busy && (spd > 0.25 || mag > 0.2)) {
      // face the stick from a standstill or at low speed (a quick pivot), the velocity at speed (smooth arcs)
      const dir = mag > 0.2 && spd < 2.5 ? wish : this.vel;
      const rate = THREE.MathUtils.lerp(18, 7.5, THREE.MathUtils.smoothstep(spd, 1, 6.4));
      turnRate = turnToward(a, Math.atan2(dir.x, dir.z), dt, rate);
    }
    a.anim.lean += (THREE.MathUtils.clamp(-turnRate * spd * 0.018, -0.22, 0.22) - a.anim.lean) * Math.min(1, dt * 6);
    const motion = f.actionMotion(dt, new THREE.Vector3());
    const p = a.position;
    p.x += this.vel.x * dt + motion.x;
    p.z += this.vel.z * dt + motion.z;
    g.colliders.resolve(p, a.radius, p.y);
    const lim = 1000;
    p.x = THREE.MathUtils.clamp(p.x, -lim, lim);
    p.z = THREE.MathUtils.clamp(p.z, -lim, lim);
    const gy = g.groundAt(p.x, p.z);
    // keep out of the sea
    if (gy < 0.3) {
      p.x -= this.vel.x * dt + motion.x;
      p.z -= this.vel.z * dt + motion.z;
      this.vel.set(0, 0, 0);
    }
    p.y = g.groundAt(p.x, p.z);
    a.anim.loco.speed = busy ? 0 : spd;
    if (g.grass && g.grass.setPlayer) g.grass.setPlayer(p.x, p.y, p.z, 0.95);
    // footsteps (two per gait cycle)
    if (spd > 0.5) {
      const ph = a.anim.loco.phase;
      const step = Math.floor(ph * 2);
      if (step !== this.stepPhase) {
        this.stepPhase = step;
        const s = g.terrain.surfaceAt(p.x, p.z);
        const surface = s.path > 0.5 ? 'dirt' : s.rock > 0.5 ? 'stone' : 'grass';
        g.emit('footstep', { surface, speed: spd, actor: a });
      }
    }
  }

  // speed factor of the ground's slope along the wish direction
  _slopeAt(wish, mag) {
    if (mag < 0.1) return 1;
    const g = this.game, p = this.a.position;
    const l = Math.hypot(wish.x, wish.z) || 1, ux = (wish.x / l) * 0.6, uz = (wish.z / l) * 0.6;
    return slopeFactor((g.groundAt(p.x + ux, p.z + uz) - g.groundAt(p.x - ux, p.z - uz)) / 1.2);
  }

  _pickTarget(wish) {
    const a = this.a;
    let best = null, bs = -1;
    for (const f of this.combat.fighters) {
      if (!f.ai || !f.actor.alive || !f.actor.root.visible) continue;
      const dx = f.actor.position.x - a.position.x, dz = f.actor.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 5.5) continue;
      const dir = wish.lengthSq() > 0.01 ? wish : a.forward(new THREE.Vector3());
      const dot = (dx * dir.x + dz * dir.z) / (d * Math.max(1e-4, Math.hypot(dir.x, dir.z)));
      const score = dot * 2 - d * 0.35;
      if (dot > -0.2 && score > bs) (bs = score), (best = f.actor);
    }
    return best;
  }

  _respawn() {
    const a = this.a, g = this.game;
    this.respawn = null;
    const c = this.checkpoint || { x: 0, z: 0, yaw: 0 };
    a.alive = true;
    a.hp = a.maxHp;
    a.posture = 0;
    a.anim.stopActions(0);
    a.anim.layers = [];
    this.f.drawn = false;
    this.f.attack = null;
    this.f.dodge = null;
    this.buffer.clear();
    this.vel.set(0, 0, 0);
    a.anim.setBase('free', null, 0);
    a.place(c.x, c.z, c.yaw);
    if (a.cape) a.cape.reset();
    this.cam.snapBehind(a);
    g.emit('player:health', { hp: a.hp, max: a.maxHp });
    g.emit('respawn', { actor: a });
  }
}
