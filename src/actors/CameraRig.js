import * as THREE from 'three';

// Third-person camera: over-the-shoulder orbit (mouse / right stick), gentle auto-recenter while moving,
// combat framing between the player and the focused enemy, terrain + collider avoidance, FOV kick on sprint,
// shake impulses, and blended overrides (standoff side shot, kill-cam, ending orbit).
//   rig.frame(dt)  (installed as game.cameraController)
//   rig.setOverride({ pos, target, fov, roll }, blendSeconds) / rig.clearOverride(blendSeconds)
//     pos / target / fov may be functions, read every frame after the rig's own pose is known
//   rig.basePos / baseTarget / baseFov   the rig's own pose this frame, before any override (a cutscene that lands on
//                                        it hands over without a cut: src/actors/intro.js)
//   rig.lookLocked   ignore the mouse and the right stick (a cutscene holds the final framing still)
//   rig.zoom         the panorama zoom picked with the mouse wheel (ZOOM): 1 = the rig's own lens
//   rig.forwardXZ(out) / rig.rightXZ(out) for camera-relative movement

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
const D2R = Math.PI / 180;

// Panorama zoom on the mouse wheel, to take in the land. The zoom s scales the lens's tan(fov / 2): s < 1 is a longer
// lens (the land behind the samurai magnified 1 / s), s > 1 a wider one. Either way the camera also draws back from
// him, so the land gets the room:
//   - through a longer lens the boom lengthens a little more than the lens narrows (s^-dolly, dolly > 1, at most
//     maxExtra metres more): he shrinks as s^(dolly - 1), to ~0.83× at the longest lens, and the pivot slides right by
//     up to `shoulder` m so he stands off the centre that is being looked at;
//   - through a wider lens the boom lengthens too (by `back` per unit of zoom): the land opens around him and he becomes
//     a figure in it, ~0.4× at the widest;
//   - the longer boom also rises, `lift` m per metre it gained (a crane): the camera looks over the susuki instead of
//     through the plumes next to the lens, and he sits lower in the frame under the land.
// One wheel notch multiplies s by e^±step; the eased value follows a critically damped spring at `rate` rad/s. The
// final vertical fov stays within fovMin..fovMax degrees.
export const ZOOM = { min: 0.3, max: 1.45, step: 0.12, rate: 9, dolly: 1.15, back: 1.6, maxExtra: 11, shoulder: 0.9, lift: 0.1, fovMin: 15, fovMax: 75 };

// Vertical fov (degrees) of the rig's lens `baseFov` zoomed by s.
export function zoomedFov(baseFov, s) {
  const f = (2 * Math.atan(s * Math.tan((baseFov * D2R) / 2))) / D2R;
  return Math.min(ZOOM.fovMax, Math.max(ZOOM.fovMin, f));
}

// Boom length (m) for the rig's own `dist` at zoom s: never shorter than the rig's own, longer either way.
export function zoomedDist(dist, s) {
  const k = s < 1 ? Math.pow(s, -ZOOM.dolly) : 1 + ZOOM.back * (s - 1);
  return Math.min(dist * k, dist + ZOOM.maxExtra);
}

export class CameraRig {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.input = game.input;
    this.yaw = 0;
    this.pitch = -0.1;
    this.dist = 3.7;
    this.fov = 52;
    this.focus = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.shoulder = 0.5;
    this.idleLook = 0;
    this.shakeAmp = 0;
    this.combatTarget = null;
    this.sprinting = false;
    this.override = null;
    this.overrideW = 0;
    this.overrideRate = 1;
    this.snapNext = true;
    this.sensitivity = 1;
    this.mount = null; // { k, gallop } while riding (src/actors/horse/Riding.js)
    this.lookLocked = false;
    this.basePos = new THREE.Vector3();
    this.baseTarget = new THREE.Vector3();
    this.baseFov = this.fov;
    this.zoom = 1; // the zoom picked with the wheel (ZOOM)
    this.zoomL = 0; // ln of the eased zoom: the spring runs in log space, so every notch takes the same time
  }

  forwardXZ(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  rightXZ(out = new THREE.Vector3()) {
    return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  snapBehind(actor) {
    this.yaw = actor.yaw;
    this.pitch = -0.12;
    this.snapNext = true;
  }

  shake(amount) {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  setOverride(o, blend = 0.6) {
    this.override = o;
    this.overrideRate = 1 / Math.max(0.01, blend);
  }

  clearOverride(blend = 0.8) {
    this.overrideRate = 1 / Math.max(0.01, blend);
    this.override = null;
  }

  // Critically damped spring of this[key] toward `want` (angular frequency w): smooth in value and rate, no overshoot.
  _spring(key, want, w, dt) {
    const vel = this._springV || (this._springV = {});
    const x = this[key] - want, v = vel[key] || 0;
    const e = Math.exp(-w * dt), tmp = (v + w * x) * dt;
    vel[key] = (v - w * tmp) * e;
    return want + (x + tmp) * e;
  }

  frame(dt) {
    const game = this.game;
    const player = game.player;
    if (!player) return;
    const inp = this.input;
    const rdt = Math.min(0.05, game.loop ? game.loop.lastFrameMs / 1000 : dt); // camera runs on real time
    // panorama zoom: the wheel picks it while exploring; a fight or a cutscene shot eases back to the rig's own lens,
    // and the zoom that was picked comes back after them
    const free = game.state === 'play' && !this.lookLocked && !this.override;
    if (free) {
      const steps = THREE.MathUtils.clamp(inp.wheelSteps || 0, -3, 3);
      if (steps) this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(ZOOM.step * steps), ZOOM.min, ZOOM.max);
      if (inp.pressed && inp.pressed('zoomReset')) this.zoom = 1;
    }
    const fighting = !!(this.combatTarget && this.combatTarget.alive);
    this.zoomL = this._spring('zoomL', free && !fighting ? Math.log(this.zoom) : 0, ZOOM.rate, rdt);
    const zs = Math.exp(this.zoomL);
    // look input; through a longer lens the mouse turns the view less, so a hand's movement still sweeps the same share
    // of the picture (as through a spyglass)
    const look = inp.look(rdt);
    const hasLook = (inp.pointerLocked || inp.pad.connected) && (Math.abs(look.x) + Math.abs(look.y) > 1e-5);
    if (!this.lookLocked && (inp.pointerLocked || inp.pad.connected)) {
      const sens = this.sensitivity * Math.min(1, zs);
      this.yaw -= look.x * sens;
      this.pitch = THREE.MathUtils.clamp(this.pitch - look.y * sens, -1.05, 0.55);
    }
    this.idleLook = hasLook ? 0 : this.idleLook + rdt;
    // mounted profile (src/actors/horse/Riding.js): higher pivot, longer boom, wider at a gallop, quicker recenter
    const mt = this.mount, mk = mt ? mt.k : 0, mg = mt ? mt.gallop * mt.k : 0;
    // gentle recenter behind the heading while moving (never fights the mouse)
    const sp = player.anim.loco.speed;
    if (this.idleLook > 1.2 && sp > 0.8 && !this.combatTarget) {
      let d = player.yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, rdt * (0.6 + 0.5 * mk) * Math.min(1, sp / 4));
      this.pitch += (-0.12 - 0.1 * mk - this.pitch) * Math.min(1, rdt * 0.4);
    }
    // focus & distance
    const want = _v.copy(player.position);
    want.y += 1.55 * player.rig.scale + 0.55 * mk;
    let wantDist = (this.sprinting ? 4.3 : 3.7) + 2.1 * mk + 1.1 * mg;
    let wantFov = (this.sprinting ? 60 : 52) + 2 * mk + 8 * mg;
    if (this.combatTarget && this.combatTarget.alive) {
      const tp = this.combatTarget.position;
      want.lerp(_w.set(tp.x, want.y, tp.z), 0.28);
      wantDist = 4.9;
      wantFov = 55;
    }
    const k = this.snapNext ? 1 : 1 - Math.exp(-rdt * 9);
    this.focus.lerp(want, k);
    // boom and FOV ride critically damped springs: the sprint kick (and any framing change) eases in and out without
    // a jolt at either end
    this.dist = this._spring('dist', wantDist, 3.6, rdt);
    this.fov = this._spring('fov', wantFov, 4.2, rdt);
    // desired position
    const cp = Math.cos(this.pitch);
    const dir = _w.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const right = this.rightXZ(_t);
    // the zoom's dolly, crane and side step, on top of the rig's own boom (ZOOM)
    let dist = zoomedDist(this.dist, zs);
    const pivot = _p.copy(this.focus).addScaledVector(right, this.shoulder + ZOOM.shoulder * Math.max(0, 1 - zs));
    pivot.y += ZOOM.lift * (dist - this.dist);
    // terrain & collider avoidance along the boom
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * dist;
      const x = pivot.x - dir.x * d, y = pivot.y - dir.y * d, z = pivot.z - dir.z * d;
      const g = game.groundAt(x, z) + 0.35;
      if (y < g) {
        dist = Math.max(0.8, d - dist / steps);
        break;
      }
      const hit = game.colliders.nearby(x, z, 0.4).some((c) => y < c.top && inside(c, x, z, 0.3));
      if (hit) {
        dist = Math.max(0.8, d - dist / steps);
        break;
      }
    }
    const pos = new THREE.Vector3().copy(pivot).addScaledVector(dir, -dist);
    const gy = game.groundAt(pos.x, pos.z) + 0.35;
    if (pos.y < gy) pos.y = gy;
    const target = new THREE.Vector3().copy(pivot).addScaledVector(dir, 2);
    // the rig's own pose this frame: a cutscene override that lands on it hands over without a cut
    const lensFov = zoomedFov(this.fov, zs);
    this.basePos.copy(pos);
    this.baseTarget.copy(target);
    this.baseFov = lensFov;
    if (this.shakeAmp > 0.001) {
      const a = this.shakeAmp;
      pos.x += (Math.random() - 0.5) * a * 0.12;
      pos.y += (Math.random() - 0.5) * a * 0.12;
      target.x += (Math.random() - 0.5) * a * 0.05;
      this.shakeAmp *= Math.exp(-rdt * 10);
    }
    // override blend
    const wantW = this.override ? 1 : 0;
    this.overrideW += Math.sign(wantW - this.overrideW) * Math.min(Math.abs(wantW - this.overrideW), rdt * this.overrideRate);
    const ow = smooth(this.overrideW);
    let fov = lensFov;
    if (this.override || ow > 0) {
      if (this.override) this._last = this.override;
      const o = this._last;
      if (o) {
        const op = typeof o.pos === 'function' ? o.pos() : o.pos;
        const ot = typeof o.target === 'function' ? o.target() : o.target;
        const of = typeof o.fov === 'function' ? o.fov() : o.fov;
        pos.lerp(op, ow);
        target.lerp(ot, ow);
        fov = THREE.MathUtils.lerp(fov, of || fov, ow);
      }
    }
    if (this.snapNext) {
      this.pos.copy(pos);
      this.lookAt.copy(target);
      this.snapNext = false;
    } else {
      const kk = 1 - Math.exp(-rdt * 14);
      this.pos.lerp(pos, kk);
      this.lookAt.lerp(target, kk);
    }
    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.lookAt(this.lookAt);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}

function inside(c, x, z, r) {
  if (c.type === 'circle') return Math.hypot(x - c.x, z - c.z) < c.r + r;
  const dx = x - c.x, dz = z - c.z;
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  return Math.abs(lx) < c.hw + r && Math.abs(lz) < c.hd + r;
}

function smooth(x) {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}
