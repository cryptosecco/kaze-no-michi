import * as THREE from 'three';
import { buildCharacter } from './gen/character.js';
import { makeKatana, makeSaya, makeSpear } from './gen/weapons.js';
import { Animator } from './anim/Animator.js';
import { swordFrame } from './anim/pose.js';
import { Cape } from './Cape.js';

// One character in the world: body (skinned), weapon, scabbard, cape, animator and gameplay state.
// root.position = feet on the ground, root.rotation.y = yaw (model faces +Z).

// Scabbard worn through the obi on the left hip, edge up, hilt forward-up (model space). It trails back and down
// at ~33° below the horizontal and ~27° out past the hakama, so from behind it still reads as a short
// diagonal at the left hip instead of vanishing behind the body, without sticking out like a wing.
const SAYA = swordFrame({ p: [0.15, 1.06, 0.235], d: [0.38, -0.54, -0.75], e: [0.1, 0.87, -0.45] });

export class Actor {
  constructor(game, spec, library, opts = {}) {
    this.game = game;
    this.spec = spec;
    this.kind = spec.kind;
    const built = buildCharacter(spec);
    this.body = built.root;
    this.rig = built.rig;
    this.meshes = built.meshes;
    this.root = new THREE.Group();
    this.root.name = 'actor-' + spec.kind;
    this.root.add(this.body);
    this.weaponKind = opts.weapon || spec.weapon || 'katana';
    const s = this.rig.scale;
    if (this.weaponKind === 'katana') {
      this.saya = makeSaya(spec.kind === 'bandit' ? { color: 0x2b1e16, cord: 0x4d3b2a } : {});
      const hips = this.rig.bones.Hips;
      this.saya.position.copy(SAYA.p).multiplyScalar(s).sub(this.rig.rest.Hips);
      this.saya.quaternion.copy(SAYA.q);
      hips.add(this.saya);
      this.weapon = makeKatana({ rusty: spec.kind === 'bandit', scale: 1 });
      this.root.add(this.weapon);
    } else if (this.weaponKind === 'spear') {
      this.weapon = makeSpear({ rusty: true });
      this.root.add(this.weapon);
    }
    this.anim = new Animator(this, library);
    if (this.weaponKind === 'spear') {
      this.anim.weaponGrip = { R: -0.62, L: 0.0 };
      this.anim.setBase('spear', null, 0);
      this.anim.base.prev = null;
    }
    this.cape = opts.cape ? new Cape(this, opts.cape) : null;

    // gameplay state
    this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.radius = 0.38 * s;
    this.height = 1.75 * s;
    this.maxHp = opts.hp || 100;
    this.hp = this.maxHp;
    this.posture = 0;
    this.alive = true;
    this.team = spec.kind === 'samurai' ? 'player' : 'bandit';
  }

  get position() {
    return this.root.position;
  }

  setYaw(y) {
    this.yaw = y;
    this.root.rotation.set(0, y, 0);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  // world position of the weapon tip / base (for trails and hit tests)
  bladeSegment(outBase, outTip) {
    if (!this.weapon) return null;
    const ud = this.weapon.userData;
    this.weapon.updateMatrixWorld(true);
    outBase.copy(ud.base).applyMatrix4(this.weapon.matrixWorld);
    outTip.copy(ud.tip).applyMatrix4(this.weapon.matrixWorld);
    return [outBase, outTip];
  }

  place(x, z, yaw) {
    const y = this.game.groundAt ? this.game.groundAt(x, z) : this.game.terrain.heightAt(x, z);
    this.root.position.set(x, y, z);
    if (yaw !== undefined) this.setYaw(yaw);
    this.root.updateMatrixWorld(true);
  }

  update(dt, ctx) {
    this.anim.update(dt, ctx);
    if (this.cape) this.cape.update(dt, { wind: ctx.wind, time: ctx.time, groundY: this.root.position.y });
  }

  setVisible(v) {
    this.root.visible = v;
    if (this.cape) this.cape.mesh.visible = v;
  }
}
