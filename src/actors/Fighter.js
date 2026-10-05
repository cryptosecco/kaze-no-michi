import * as THREE from 'three';
import { UPPER_BODY } from './anim/library.js';

// Combat behaviour shared by the player and the bandits, layered over an Actor:
// attacks (clip meta: hit window, reach, arc, damage, lunge), block & parry timing, dodge i-frames,
// hit reactions, posture/stagger, death, draw/sheathe. The Combat system resolves hits between fighters.
// The player's attacks carry an assist (startAttack { assist }): over the wind-up the body turns into the target and,
// within `assist` metres, closes the gap to striking distance before the blade arrives (bounded speed, never closer
// than STRIKE). cancelAttack() / endDodge() let another action or movement take over (cancel windows: Player.js).

const _v = new THREE.Vector3();
const STRIKE = 1.45; // m between centres where an assisted swing stops closing in
const ASSIST_SPEED = 9; // m/s, fastest assisted closing
const ASSIST_TURN = 22; // rad/s

export class Fighter {
  constructor(actor, game) {
    this.actor = actor;
    this.game = game;
    this.attack = null; // { name, layer, meta, hits:Set, dir }
    this.blocking = false;
    this.blockStart = -1;
    this.dodge = null; // { layer, dir, meta }
    this.stagger = 0;
    this.drawn = actor.weaponKind === 'spear';
    this.time = 0;
    this.moveOverride = null; // { layer, meta.move, dir }
  }

  get anim() {
    return this.actor.anim;
  }

  get busy() {
    return !!(this.attack || this.dodge || this.stagger > 0 || !this.actor.alive || (this.anim.action && this.anim.action.name === 'hit'));
  }

  startAttack(name, { target = null, speed = 1, unblockable, assist = 0 } = {}) {
    const a = this.actor;
    if (!a.alive) return false;
    const clip = this.anim.clips[name];
    if (!clip) return false;
    // facing: at once (bandits), or over the wind-up with the assist (actionMotion)
    if (target && !assist) a.setYaw(Math.atan2(target.position.x - a.position.x, target.position.z - a.position.z));
    this.stopBlock();
    const layer = this.anim.play(name, { fade: 0.05, fadeOut: 0.18, speed });
    this.attack = { name, layer, meta: clip.meta || {}, hits: new Set(), target, speed, unblockable, assist };
    layer.onEnd = () => {
      if (this.attack && this.attack.layer === layer) this.attack = null;
    };
    this.game.emit('swing', { actor: a, kind: name, heavy: !!clip.meta.heavy });
    return true;
  }

  // Let the current attack go: its layer fades under whatever takes over (another action, movement).
  cancelAttack(fadeOut = 0.16) {
    const at = this.attack;
    if (!at) return;
    at.layer.leaving = true;
    at.layer.fadeOut = fadeOut;
    this.attack = null;
  }

  attackPhase() {
    const at = this.attack;
    if (!at || at.layer.leaving) return null;
    return at.layer.time;
  }

  inHitWindow() {
    const at = this.attack;
    if (!at || !at.meta.hit) return false;
    const t = at.layer.time;
    return t >= at.meta.hit[0] && t <= at.meta.hit[1];
  }

  canCombo() {
    const at = this.attack;
    if (!at) return true;
    return at.meta.combo > 0 && at.layer.time >= at.meta.combo;
  }

  startBlock() {
    if (this.blocking || this.attack || this.dodge || !this.actor.alive) return;
    this.blocking = true;
    this.blockStart = this.time;
    this.blockLayer = this.anim.play('block', { fade: 0.05, hold: true });
  }

  stopBlock() {
    if (!this.blocking) return;
    this.blocking = false;
    if (this.blockLayer) {
      this.blockLayer.leaving = true;
      this.blockLayer.fadeOut = 0.12;
    }
    this.blockLayer = null;
  }

  isParryWindow() {
    return this.blocking && this.time - this.blockStart < 0.22;
  }

  // `clip`: 'dodge' (blade drawn) or 'dodge_free' (sheathed: the scabbard stays shut)
  startDodge(dir, clip = 'dodge') {
    const a = this.actor;
    if (this.dodge || !a.alive) return false;
    this.stopBlock();
    if (this.attack) {
      this.attack.layer.leaving = true;
      this.attack = null;
    }
    const layer = this.anim.play(this.anim.clips[clip] ? clip : 'dodge', { fade: 0.03, fadeOut: 0.14 });
    const d = dir.lengthSq() > 1e-4 ? dir.clone().normalize() : a.forward(new THREE.Vector3()).negate();
    this.dodge = { layer, dir: d, meta: layer.clip.meta };
    layer.onEnd = () => {
      if (this.dodge && this.dodge.layer === layer) this.dodge = null; // a chained dodge keeps its own
    };
    this.game.emit('dodge', { actor: a });
    return true;
  }

  // End the current dodge early (an attack, a block or movement takes over its tail).
  endDodge(fadeOut = 0.16) {
    const d = this.dodge;
    if (!d) return;
    d.layer.leaving = true;
    d.layer.fadeOut = fadeOut;
    this.dodge = null;
  }

  invulnerable() {
    const d = this.dodge;
    if (!d) return false;
    const t = d.layer.time, w = d.meta.iframes;
    return w && t >= w[0] && t <= w[1];
  }

  // incoming damage already resolved by Combat: reaction + posture
  takeHit(amount, from, { posture = 10, heavy = false } = {}) {
    const a = this.actor;
    if (!a.alive) return;
    a.hp = Math.max(0, a.hp - amount);
    a.posture += posture;
    if (a.hp <= 0) return this.die(from);
    if (this.attack) {
      this.attack.layer.leaving = true;
      this.attack = null;
    }
    this.stopBlock();
    this.anim.play('hit', { fade: 0.03, fadeOut: 0.16, speed: heavy ? 0.85 : 1 });
    if (from) a.setYaw(Math.atan2(from.position.x - a.position.x, from.position.z - a.position.z));
    this.moveOverride = { t: 0, dur: 0.22, dist: heavy ? -1.0 : -0.5 };
  }

  staggerFor(sec, from) {
    const a = this.actor;
    if (!a.alive) return;
    if (this.attack) {
      this.attack.layer.leaving = true;
      this.attack = null;
    }
    this.stopBlock();
    this.stagger = sec;
    this.anim.play('hit', { fade: 0.03, fadeOut: 0.2, speed: 0.6 });
    if (from) a.setYaw(Math.atan2(from.position.x - a.position.x, from.position.z - a.position.z));
    this.moveOverride = { t: 0, dur: 0.3, dist: -0.8 };
  }

  die(from) {
    const a = this.actor;
    if (!a.alive) return;
    a.alive = false;
    a.hp = 0;
    this.attack = null;
    this.stopBlock();
    this.anim.stopActions(0.05);
    this.anim.play('death', { fade: 0.05, hold: true });
    if (from) a.setYaw(Math.atan2(from.position.x - a.position.x, from.position.z - a.position.z));
    this.anim.lookTarget = null;
  }

  drawSword(onDone) {
    if (this.drawn || this.actor.weaponKind !== 'katana') return;
    this.drawn = true;
    this.anim.setBase('combat', null, 0.3);
    const l = this.anim.play('draw', { fade: 0, fadeOut: 0.12 });
    if (l && onDone) l.onEnd = onDone;
    this.game.emit('draw', { actor: this.actor });
  }

  // `moving`: sheathe on the run — the arms only and a little quicker, so the legs keep their stride
  sheatheSword({ moving = false } = {}) {
    if (!this.drawn || this.actor.weaponKind !== 'katana') return;
    this.drawn = false;
    this.anim.setBase('free', null, 0.4);
    this.anim.play('sheathe', moving ? { fade: 0.1, fadeOut: 0.25, speed: 1.3, mask: UPPER_BODY } : { fade: 0.1, fadeOut: 0.25 });
    this.game.emit('sheathe', { actor: this.actor });
  }

  // Attack assist (see the header): turn into the target until the blade arrives and, when it is within reach of the
  // assist, close the gap. Returns true while it moves the fighter (it then replaces the clip's lunge).
  _assist(dt, out) {
    const at = this.attack, a = this.actor, tg = at.target, meta = at.meta;
    const end = meta.hit ? meta.hit[1] : 0;
    const t = at.layer.time;
    if (!tg || tg.alive === false || t >= end) return false;
    const dx = tg.position.x - a.position.x, dz = tg.position.z - a.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return false;
    let turn = Math.atan2(dx, dz) - a.yaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    a.setYaw(a.yaw + Math.sign(turn) * Math.min(Math.abs(turn), ASSIST_TURN * dt));
    if (d > at.assist) return false;
    const v = Math.min(ASSIST_SPEED, Math.max(0, d - STRIKE) / Math.max(0.05, (end - t) / at.speed));
    out.x += (dx / d) * v * dt;
    out.z += (dz / d) * v * dt;
    return true;
  }

  // Root motion from the current action: attack lunges, dodge travel, hit knock-back. Returns a displacement.
  actionMotion(dt, out) {
    out.set(0, 0, 0);
    const a = this.actor;
    const fwd = a.forward(_v);
    if (this.attack && this.attack.assist && this._assist(dt, out)) {
      // the assist carries the swing to its target
    } else if (this.attack && this.attack.meta.lunge) {
      const [t0, t1, dist] = this.attack.meta.lunge;
      const t = this.attack.layer.time;
      if (t > t0 && t < t1) {
        let k = dist / (t1 - t0);
        const tg = this.attack.target;
        if (tg && tg.alive !== false) {
          const d = Math.hypot(tg.position.x - a.position.x, tg.position.z - a.position.z);
          if (d < 1.3) k = 0;
          else if (d < 2.2) k *= 0.4;
        }
        out.addScaledVector(fwd, k * dt * this.attack.speed);
      }
    }
    if (this.dodge && this.dodge.meta.move) {
      const [t0, t1, dist] = this.dodge.meta.move;
      const t = this.dodge.layer.time;
      if (t > t0 && t < t1) out.addScaledVector(this.dodge.dir, (dist / (t1 - t0)) * dt * (1.4 - (t - t0) / (t1 - t0) * 0.8));
    }
    if (this.moveOverride) {
      const m = this.moveOverride;
      m.t += dt;
      if (m.t < m.dur) out.addScaledVector(fwd, (m.dist / m.dur) * dt);
      else this.moveOverride = null;
    }
    return out;
  }

  update(dt) {
    this.time += dt;
    if (this.stagger > 0) this.stagger -= dt;
    const a = this.actor;
    a.posture = Math.max(0, a.posture - dt * (this.blocking ? 4 : 9));
  }
}
