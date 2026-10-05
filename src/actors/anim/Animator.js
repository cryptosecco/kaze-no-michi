import * as THREE from 'three';
import { solveArm, solveLeg, worldQuat, setWorldQuat } from './ik.js';

// Layered animation evaluator for one character.
//   base locomotion blend (phase-synced by ground speed) or a looping base clip
//   + one-shot action layers (attacks, dodge, draw…) cross-faded on top
//   → sword track + IK (hands on the weapon / on the sheathed hilt) → foot planting → look-at / lean / armor
// A clip frame stores bone quaternions, a hips offset, an optional weapon frame (model space) and IK weights.

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _m = new THREE.Matrix4();

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// hand ↔ weapon frame: weapon Y (blade) = hand +Z, weapon Z (edge) = hand −Y, weapon X = hand +X
export const GRIP_Q = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0))
);
const GRIP_Q_INV = GRIP_Q.clone().invert();
// palm-over grip on a sheathed hilt: weapon X = hand −X, weapon Y = hand +Z, weapon Z = hand +Y
const FLIP_Q = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0))
);
const FLIP_Q_INV = FLIP_Q.clone().invert();
// fist center in hand-bone space (the hand bone origin is the wrist)
const FIST = { R: new THREE.Vector3(-0.07, -0.012, 0), L: new THREE.Vector3(0.07, -0.012, 0) };

export class Animator {
  constructor(actor, library) {
    this.actor = actor;
    this.rig = actor.rig;
    this.bones = this.rig.list;
    this.n = this.bones.length;
    this.index = this.rig.index;
    this.clips = library.clips;
    this.gaits = library.gaits;
    this.q = new Float32Array(this.n * 4);
    this.hips = new THREE.Vector3();
    this.sword = { active: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), ikR: 0, ikL: 0 };
    this.layers = [];
    this.base = { mode: 'free', clip: 'idle', time: 0, fade: 1, prev: null, prevW: 0, prevTime: 0 };
    this.loco = { speed: 0, phase: 0, idleT: 0 };
    this.lookTarget = null;
    this.lookW = 0;
    this._look = new THREE.Vector2();
    this.lean = 0;
    this.settle = 0; // 0..1, set by the player controller when a sprint skids to a stop
    this.footIK = true;
    this.pelvis = 0;
    this.restHipsY = this.rig.bones.Hips.position.y;
    this.restHips = this.rig.bones.Hips.position.clone();
    this.weaponGrip = { R: 0.065, L: -0.075 }; // weapon-local Y of each fist center
    this.sheathGrip = { R: 0.07, L: 0.19, rest: 0.03 }; // weapon-local Y of sheathed grips (hilt / scabbard mouth / resting)
    this.strides = {};
    for (const g of ['walk', 'run', 'sprint', 'combat_move', 'spear_move']) if (this.clips[g]) this.strides[g] = this._measureStride(this.clips[g], g);
  }

  setBase(mode, clip = null, fade = 0.25) {
    if (this.base.mode === mode && this.base.clip === clip) return;
    this.base.prev = { mode: this.base.mode, clip: this.base.clip, time: this.base.time };
    this.base.prevW = 1;
    this.base.fadeDur = fade;
    this.base.mode = mode;
    this.base.clip = clip;
    this.base.time = 0;
  }

  play(name, { fade = 0.08, fadeOut = 0.16, speed = 1, hold = false, mask = null, onEnd = null, time = 0 } = {}) {
    const clip = this.clips[name];
    if (!clip) return null;
    for (const l of this.layers) if (!l.leaving) l.leaving = true; // superseded actions fade out underneath
    const layer = { clip, name, time, speed, w: fade > 0 ? 0 : 1, fade, fadeOut, hold, mask, onEnd, leaving: false, done: false, events: new Set() };
    this.layers.push(layer);
    return layer;
  }

  stopActions(fadeOut = 0.15) {
    for (const l of this.layers) {
      l.leaving = true;
      l.fadeOut = fadeOut;
    }
  }

  get action() {
    for (let i = this.layers.length - 1; i >= 0; i--) if (!this.layers[i].leaving) return this.layers[i];
    return null;
  }

  _sampleInto(clip, t, outQ, outHips, outSw) {
    const fr = clip.frames;
    let u = (t / clip.duration) * (fr.length - 1);
    if (clip.loop) u = ((u % (fr.length - 1)) + (fr.length - 1)) % (fr.length - 1);
    else u = Math.min(Math.max(u, 0), fr.length - 1);
    const i0 = Math.floor(u), i1 = Math.min(fr.length - 1, i0 + 1), k = u - i0;
    const A = fr[i0], B = fr[i1];
    for (let b = 0; b < this.n; b++) {
      const o = b * 4;
      _qa.set(A.q[o], A.q[o + 1], A.q[o + 2], A.q[o + 3]);
      _qb.set(B.q[o], B.q[o + 1], B.q[o + 2], B.q[o + 3]);
      _qa.slerp(_qb, k);
      outQ[o] = _qa.x;
      outQ[o + 1] = _qa.y;
      outQ[o + 2] = _qa.z;
      outQ[o + 3] = _qa.w;
    }
    outHips.set(A.hips[0] + (B.hips[0] - A.hips[0]) * k, A.hips[1] + (B.hips[1] - A.hips[1]) * k, A.hips[2] + (B.hips[2] - A.hips[2]) * k);
    outSw.active = !!(A.sw && B.sw);
    if (outSw.active) {
      outSw.p.set(A.sw[0] + (B.sw[0] - A.sw[0]) * k, A.sw[1] + (B.sw[1] - A.sw[1]) * k, A.sw[2] + (B.sw[2] - A.sw[2]) * k);
      _qa.set(A.sw[3], A.sw[4], A.sw[5], A.sw[6]);
      _qb.set(B.sw[3], B.sw[4], B.sw[5], B.sw[6]);
      outSw.q.copy(_qa).slerp(_qb, k);
    } else if (A.sw || B.sw) {
      const S = A.sw || B.sw;
      outSw.active = true;
      outSw.p.set(S[0], S[1], S[2]);
      outSw.q.set(S[3], S[4], S[5], S[6]);
    }
    outSw.ikR = A.ik[0] + (B.ik[0] - A.ik[0]) * k;
    outSw.ikL = A.ik[1] + (B.ik[1] - A.ik[1]) * k;
  }

  _blendInto(dstQ, dstHips, dstSw, srcQ, srcHips, srcSw, w, mask) {
    if (w <= 0) return;
    for (let b = 0; b < this.n; b++) {
      if (mask && !mask.has(this.bones[b].name)) continue;
      const o = b * 4;
      _qa.set(dstQ[o], dstQ[o + 1], dstQ[o + 2], dstQ[o + 3]);
      _qb.set(srcQ[o], srcQ[o + 1], srcQ[o + 2], srcQ[o + 3]);
      _qa.slerp(_qb, w);
      dstQ[o] = _qa.x;
      dstQ[o + 1] = _qa.y;
      dstQ[o + 2] = _qa.z;
      dstQ[o + 3] = _qa.w;
    }
    if (!mask || mask.has('Hips')) dstHips.lerp(srcHips, w);
    if (srcSw.active && dstSw.active) {
      dstSw.p.lerp(srcSw.p, w);
      dstSw.q.slerp(srcSw.q, w);
    } else if (srcSw.active && !dstSw.active) {
      dstSw.active = true;
      dstSw.p.copy(srcSw.p);
      dstSw.q.copy(srcSw.q);
      dstSw.ikR *= 1 - w;
    } else if (!srcSw.active && dstSw.active && w > 0.999) dstSw.active = false;
    dstSw.ikR = dstSw.ikR * (1 - w) + srcSw.ikR * w;
    dstSw.ikL = dstSw.ikL * (1 - w) + srcSw.ikL * w;
  }

  _tmp() {
    if (!this._t) this._t = { q: new Float32Array(this.n * 4), hips: new THREE.Vector3(), sw: { active: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), ikR: 0, ikL: 0 } };
    return this._t;
  }
  _tmp2() {
    if (!this._t2) this._t2 = { q: new Float32Array(this.n * 4), hips: new THREE.Vector3(), sw: { active: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), ikR: 0, ikL: 0 } };
    return this._t2;
  }

  // Evaluate a base mode (locomotion blend or looping clip) into dst.
  _evalBase(mode, clipName, time, dst) {
    const T = this._tmp2();
    const speed = this.loco.speed;
    const blend2 = (a, b, w, phaseA, phaseB) => {
      this._sampleInto(this.clips[a], phaseA, dst.q, dst.hips, dst.sw);
      if (b && w > 0) {
        this._sampleInto(this.clips[b], phaseB, T.q, T.hips, T.sw);
        this._blendInto(dst.q, dst.hips, dst.sw, T.q, T.hips, T.sw, w, null);
      }
    };
    const ph = this.loco.phase;
    if (mode === 'free') {
      if (speed < 1.5) blend2('idle', 'walk', smooth(speed / 1.3), this.loco.idleT, ph * this.clips.walk.duration);
      else if (speed < 4.2) blend2('walk', 'run', smooth((speed - 1.5) / 2.7), ph * this.clips.walk.duration, ph * this.clips.run.duration);
      else blend2('run', 'sprint', smooth((speed - 4.2) / 2.3), ph * this.clips.run.duration, ph * this.clips.sprint.duration);
    } else if (mode === 'combat') {
      blend2('combat_idle', 'combat_move', smooth(speed / 1.1), this.loco.idleT, ph * this.clips.combat_move.duration);
      // faster than the footwork's pace the stride opens into the drawn-sword run
      const r = this._drawnRun(speed);
      if (r > 0) {
        this._sampleInto(this.clips.combat_run, ph * this.clips.combat_run.duration, T.q, T.hips, T.sw);
        this._blendInto(dst.q, dst.hips, dst.sw, T.q, T.hips, T.sw, r, null);
      }
    } else if (mode === 'spear') {
      blend2('spear_idle', 'spear_move', smooth(speed / 1.1), this.loco.idleT, ph * this.clips.spear_move.duration);
    } else {
      this._sampleInto(this.clips[clipName || mode], time, dst.q, dst.hips, dst.sw);
    }
  }

  // weight of the drawn-sword run over the combat footwork (it shares the run's stride)
  _drawnRun(speed) {
    return this.clips.combat_run ? smooth((speed - 2.9) / 0.9) : 0;
  }

  update(dt, ctx = {}) {
    const rig = this.rig;
    // locomotion phase advance (distance-based → no foot sliding)
    const sp = this.loco.speed;
    this.loco.idleT += dt;
    const strideName = this.base.mode === 'combat' ? 'combat_move' : this.base.mode === 'spear' ? 'spear_move' : sp < 1.5 ? 'walk' : sp < 4.2 ? 'run' : 'sprint';
    let D = this.strides[strideName] || 1.4;
    if (this.base.mode === 'free' && sp >= 1.5 && sp < 4.2) D = THREE.MathUtils.lerp(this.strides.walk, this.strides.run, smooth((sp - 1.5) / 2.7));
    else if (this.base.mode === 'free' && sp >= 4.2) D = THREE.MathUtils.lerp(this.strides.run, this.strides.sprint, smooth((sp - 4.2) / 2.3));
    else if (this.base.mode === 'combat' && this._drawnRun(sp) > 0) D = THREE.MathUtils.lerp(D, this.strides.run, this._drawnRun(sp));
    this.loco.phase = (this.loco.phase + (dt * Math.max(sp, 0)) / Math.max(0.3, D)) % 1;
    this.base.time += dt;

    // base layer (with cross-fade from the previous base)
    const dst = { q: this.q, hips: this.hips, sw: this.sword };
    this._evalBase(this.base.mode, this.base.clip, this.base.time, dst);
    if (this.base.prev && this.base.prevW > 0) {
      this.base.prevW -= dt / Math.max(0.01, this.base.fadeDur || 0.25);
      this.base.prev.time += dt;
      if (this.base.prevW > 0) {
        const T = this._tmp();
        const saveBase = { q: this.q.slice(), hips: this.hips.clone(), sw: { ...this.sword, p: this.sword.p.clone(), q: this.sword.q.clone() } };
        this._evalBase(this.base.prev.mode, this.base.prev.clip, this.base.prev.time, T);
        // dst = mix(prev, current, 1 - prevW)
        this.q.set(T.q);
        this.hips.copy(T.hips);
        Object.assign(this.sword, { active: T.sw.active, ikR: T.sw.ikR, ikL: T.sw.ikL });
        this.sword.p.copy(T.sw.p);
        this.sword.q.copy(T.sw.q);
        this._blendInto(this.q, this.hips, this.sword, saveBase.q, saveBase.hips, saveBase.sw, smooth(1 - this.base.prevW), null);
      } else this.base.prev = null;
    }

    // action layers
    const T = this._tmp();
    for (const l of this.layers) {
      l.time += dt * l.speed;
      const c = l.clip;
      if (!l.leaving) {
        l.w = l.fade > 0 ? Math.min(1, l.w + dt / l.fade) : 1;
        if (!c.loop && !l.hold && l.time >= c.duration - l.fadeOut * l.speed) l.leaving = true;
      } else {
        l.w -= dt / Math.max(0.01, l.fadeOut);
      }
      if (ctx.onEvent && c.events) for (const e of c.events) if (!l.events.has(e.name) && l.time >= e.t) (l.events.add(e.name), ctx.onEvent(e.name, l));
      if (l.w <= 0 && l.leaving) {
        l.done = true;
        continue;
      }
      this._sampleInto(c, l.time, T.q, T.hips, T.sw);
      this._blendInto(this.q, this.hips, this.sword, T.q, T.hips, T.sw, smooth(Math.max(0, l.w)), l.mask);
    }
    for (const l of this.layers) if (l.done && l.onEnd) (l.onEnd(l), (l.onEnd = null));
    this.layers = this.layers.filter((l) => !l.done);

    // write FK
    for (let b = 0; b < this.n; b++) {
      const o = b * 4;
      this.bones[b].quaternion.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
    }
    rig.bones.Hips.position.copy(this.restHips).add(this.hips);
    // procedural: lean into turns; settle out of a sprint (body back over planted feet, a small dip)
    if (Math.abs(this.lean) > 1e-4) rig.bones.Hips.quaternion.premultiply(_qa.setFromAxisAngle(_va.set(0, 0, 1), this.lean));
    if (this.settle > 1e-3) {
      rig.bones.Hips.quaternion.premultiply(_qa.setFromAxisAngle(_va.set(1, 0, 0), -0.13 * this.settle));
      rig.bones.Hips.position.y -= 0.04 * this.settle;
    }
    this.actor.root.updateMatrixWorld(true);

    this._weapon(ctx);
    if (this.footIK && ctx.groundAt) this._feet(dt, ctx);
    this._lookAt(dt);
    this._helpers();
  }

  // Weapon: it lives in model space exactly on its authored track (or on the scabbard frame when sheathed);
  // hands are then solved onto it. Sheathed grips hold the hilt palm-over (FLIP); a draw rolls the wrist.
  _weapon(ctx) {
    const a = this.actor;
    const rig = this.rig;
    const sw = this.sword;
    const act = this.action;
    const meta = act ? act.clip.meta : null;
    const root = a.root;
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const rootInv = _m.copy(root.matrixWorld).invert();
    let sayaP = null, sayaQ = null;
    if (a.saya) {
      a.saya.updateMatrixWorld(true);
      const wm = a.saya.matrixWorld.clone().premultiply(rootInv);
      sayaP = new THREE.Vector3();
      sayaQ = new THREE.Quaternion();
      wm.decompose(sayaP, sayaQ, _vc);
    }
    const P = new THREE.Vector3(), Q = new THREE.Quaternion();
    let inHand = sw.active && sw.ikR > 0.5;
    let flip = 0; // right-hand grip: 0 = drawn grip, 1 = palm-over sheathed grip
    if (sw.active) {
      P.copy(sw.p);
      Q.copy(sw.q);
      if (sayaP && meta) {
        let k = -1;
        if (meta.drawFromSaya && act.time <= meta.drawFromSaya[1]) k = 1 - smooth((act.time - meta.drawFromSaya[0]) / (meta.drawFromSaya[1] - meta.drawFromSaya[0]));
        if (meta.toSaya && act.time >= meta.toSaya[0]) k = smooth((act.time - meta.toSaya[0]) / (meta.toSaya[1] - meta.toSaya[0]));
        if (k >= 0) {
          P.lerp(sayaP, k);
          Q.slerp(sayaQ, k);
          flip = k;
          if (meta.toSaya && k >= 0.999) inHand = false;
        }
      }
    }
    if (a.weapon) {
      if (inHand || !a.saya) {
        if (sw.active) {
          a.weapon.position.copy(P);
          a.weapon.quaternion.copy(Q);
        }
      } else {
        a.weapon.position.copy(sayaP);
        a.weapon.quaternion.copy(sayaQ);
      }
      a.weapon.updateMatrixWorld(true);
    }
    const toWorldP = (p) => p.clone().applyMatrix4(root.matrixWorld);
    const toWorldQ = (q) => rootQ.clone().multiply(q);
    const pole = (side) => {
      const sh = rig.bones[side > 0 ? 'LeftArm' : 'RightArm'].getWorldPosition(new THREE.Vector3());
      return sh.add(_vb.set(side * 0.5, -0.75, -0.3).applyQuaternion(rootQ));
    };
    const handQ = (Qw, k) => {
      const g = Qw.clone().multiply(GRIP_Q_INV);
      if (k <= 0) return g;
      const f = Qw.clone().multiply(FLIP_Q_INV);
      return k >= 1 ? f : g.slerp(f, k);
    };
    // right hand: on the drawn weapon, or on the sheathed hilt (standoff)
    if (inHand && a.weapon) {
      const Pw = toWorldP(P), Qw = toWorldQ(Q);
      const qh = handQ(Qw, flip);
      solveArm(rig, -1, this._wristFor(Pw, Qw, qh, this.weaponGrip.R, 'R'), pole(-1), 1);
      setWorldQuat(rig.bones.RightHand, qh, 1);
    } else if (sw.ikR > 0.01 && sayaP) {
      const Pw = toWorldP(sayaP), Qw = toWorldQ(sayaQ);
      const qh = handQ(Qw, 1);
      solveArm(rig, -1, this._wristFor(Pw, Qw, qh, this.sheathGrip.R, 'R'), pole(-1), sw.ikR);
      setWorldQuat(rig.bones.RightHand, qh, sw.ikR);
    }
    // left hand: second hand on the drawn hilt, on the scabbard mouth (standoff) or resting on the hilt
    if (sw.ikL > 0.01) {
      let wrist = null, qh = null;
      if (inHand && a.weapon) {
        const Pw = toWorldP(P), Qw = toWorldQ(Q);
        qh = handQ(Qw, 0);
        wrist = this._wristFor(Pw, Qw, qh, this.weaponGrip.L, 'L');
      } else if (sayaP) {
        const Pw = toWorldP(sayaP), Qw = toWorldQ(sayaQ);
        qh = handQ(Qw, 1);
        wrist = this._wristFor(Pw, Qw, qh, sw.ikR > 0.5 ? this.sheathGrip.L : this.sheathGrip.rest, 'L');
      }
      if (wrist) {
        solveArm(rig, 1, wrist, pole(1), sw.ikL);
        setWorldQuat(rig.bones.LeftHand, qh, sw.ikL);
      }
    }
    this.inHand = inHand;
  }

  // wrist position so that the fist center sits at weapon-local y = gripY
  _wristFor(P, Qw, qh, gripY, side) {
    const grip = _vc.set(0, gripY, 0).applyQuaternion(Qw).add(P);
    return grip.clone().sub(FIST[side].clone().applyQuaternion(qh));
  }

  _feet(dt, ctx) {
    const rig = this.rig;
    const root = this.actor.root;
    const rootY = root.position.y;
    const des = [];
    let drop = 0;
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const foot = rig.bones[L + 'Foot'];
      const p = foot.getWorldPosition(new THREE.Vector3());
      const g = ctx.groundAt(p.x, p.z);
      const want = g + (p.y - rootY);
      des.push({ side, L, p, want, q: worldQuat(foot, new THREE.Quaternion()) });
      drop = Math.min(drop, want - p.y);
    }
    // smooth pelvis adjustment (never raise above the animated height)
    this.pelvis += (drop - this.pelvis) * Math.min(1, dt * 12);
    if (Math.abs(this.pelvis) > 1e-4) {
      rig.bones.Hips.position.y += this.pelvis;
      root.updateMatrixWorld(true);
    }
    const fwd = _vb.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_qc));
    for (const d of des) {
      if (Math.abs(d.want - d.p.y) < 0.004 && Math.abs(this.pelvis) < 0.004) continue;
      const target = new THREE.Vector3(d.p.x, d.want, d.p.z);
      const knee = rig.bones[d.L + 'Leg'].getWorldPosition(new THREE.Vector3());
      const pole = knee.addScaledVector(fwd, 0.6);
      solveLeg(rig, d.side, target, pole, 1);
      setWorldQuat(rig.bones[d.L + 'Foot'], d.q, 1);
    }
  }

  _lookAt(dt) {
    const t = this.lookTarget;
    const want = t ? 1 : 0;
    this.lookW += (want - this.lookW) * Math.min(1, dt * 4);
    if (this.lookW < 0.01) return;
    const rig = this.rig;
    const head = rig.bones.Head;
    if (t) {
      const hp = head.getWorldPosition(_va);
      const inv = rig.bones.Spine2.getWorldQuaternion(_qa).invert();
      const dir = _vb.subVectors(t, hp).applyQuaternion(inv).normalize();
      const yaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -1.1, 1.1);
      const pitch = THREE.MathUtils.clamp(-Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), -0.5, 0.5);
      this._look.x += (yaw - this._look.x) * Math.min(1, dt * 6);
      this._look.y += (pitch - this._look.y) * Math.min(1, dt * 6);
    }
    const w = this.lookW;
    const add = (bone, k) => {
      _qa.setFromEuler(new THREE.Euler(this._look.y * k * w, this._look.x * k * w, 0, 'YXZ'));
      bone.quaternion.multiply(_qa);
    };
    add(rig.bones.Neck, 0.4);
    add(rig.bones.Head, 0.6);
    rig.bones.Neck.updateMatrixWorld(true);
  }

  // Armor that hangs from the body: shoulder guards follow the upper arm partially, tassets swing with the thighs.
  _helpers() {
    const b = this.rig.bones;
    if (!b.LeftSode) return;
    const ARM_DOWN = { Left: _qc.setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(-72))).clone(), Right: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(72))) };
    for (const L of ['Left', 'Right']) {
      const rel = ARM_DOWN[L].clone().invert().multiply(b[L + 'Arm'].quaternion);
      b[L + 'Sode'].quaternion.identity().slerp(rel, 0.38);
      const e = new THREE.Euler().setFromQuaternion(b[L + 'UpLeg'].quaternion, 'XYZ');
      const fwd = Math.min(0, e.x) * 0.62, side = e.z * 0.45;
      b[L + 'Kusazuri'].quaternion.setFromEuler(new THREE.Euler(fwd, 0, side));
    }
    const el = new THREE.Euler().setFromQuaternion(b.LeftUpLeg.quaternion, 'XYZ');
    const er = new THREE.Euler().setFromQuaternion(b.RightUpLeg.quaternion, 'XYZ');
    b.BackKusazuri.quaternion.setFromEuler(new THREE.Euler(Math.max(0, el.x, er.x) * 0.5, 0, 0));
    this.rig.bones.Hips.updateMatrixWorld(true);
  }

  // cycle distance of a gait clip: stance-foot travel relative to the body ÷ stance fraction
  _measureStride(clip, name) {
    const rig = this.rig;
    const L = rig.bones.LeftFoot;
    const zs = [];
    const T = this._tmp();
    const g = this.gaits[name === 'combat_move' || name === 'spear_move' ? 'cwalk' : name];
    const st = g ? g.stance : 0.5;
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const p = (i / steps) * st;
      this._sampleInto(clip, p * clip.duration, T.q, T.hips, T.sw);
      for (let b = 0; b < this.n; b++) {
        const o = b * 4;
        this.bones[b].quaternion.set(T.q[o], T.q[o + 1], T.q[o + 2], T.q[o + 3]);
      }
      rig.bones.Hips.position.copy(this.restHips).add(T.hips);
      rig.root.updateMatrixWorld(true);
      _m.copy(rig.root.matrixWorld).invert();
      zs.push(L.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m).z);
    }
    const dz = Math.max(...zs) - Math.min(...zs);
    return Math.max(0.3, dz / st);
  }
}
