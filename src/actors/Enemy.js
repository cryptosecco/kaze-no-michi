import * as THREE from 'three';

// Bandit AI: idle at camp → alert (draw, shout) → engage: keep spacing, circle, take an attack token
// (max 2 attackers at once), telegraph unblockable attacks with a gold glint, react, die.
// Movement goes through the same collision / ground path as the player.

const _v = new THREE.Vector3(), _d = new THREE.Vector3();

export class EnemyAI {
  constructor(game, fighter, combat, vfx, { group = 'camp', rng = Math.random } = {}) {
    this.game = game;
    this.f = fighter;
    this.a = fighter.actor;
    this.combat = combat;
    this.vfx = vfx;
    this.group = group;
    this.rng = rng;
    this.state = 'idle';
    this.home = this.a.position.clone();
    this.homeYaw = this.a.yaw;
    this.cool = 1.2 + rng() * 1.5;
    this.circleDir = rng() < 0.5 ? -1 : 1;
    this.switchT = 2 + rng() * 3;
    this.alertT = 0;
    this.vel = new THREE.Vector3();
    this.token = false;
    this.spear = this.a.weaponKind === 'spear';
    this.reach = this.spear ? 2.9 : 2.2;
    fighter.ai = this;
  }

  reset(x, z, yaw) {
    this.a.alive = true;
    this.a.hp = this.a.maxHp;
    this.a.posture = 0;
    this.a.place(x, z, yaw);
    this.home.copy(this.a.position);
    this.homeYaw = yaw;
    this.state = 'idle';
    this.token = false;
    this.f.attack = null;
    this.f.drawn = this.spear;
    this.a.anim.stopActions(0);
    this.a.anim.layers = [];
    this.a.anim.setBase(this.spear ? 'spear' : 'free', null, 0);
    this.a.anim.base.prev = null;
    this.a.setVisible(true);
  }

  alert() {
    if ((this.state !== 'idle' && this.state !== 'watch') || !this.a.alive) return;
    this.state = 'alert';
    this.alertT = 0.5 + this.rng() * 0.4;
    if (!this.spear) this.f.drawSword();
    this.game.emit('enemy:alert', { actor: this.a, group: this.group });
    // alert the rest of the group
    for (const f of this.combat.fighters) if (f.ai && f.ai !== this && f.ai.group === this.group) f.ai.alert();
  }

  update(dt) {
    const a = this.a, f = this.f;
    if (!a.alive) {
      if (this.token) this.combat.releaseToken(this), (this.token = false);
      this.state = 'dead';
      a.anim.loco.speed = 0;
      return;
    }
    const player = this.game.player;
    if (!player) return;
    const pp = player.position;
    const dx = pp.x - a.position.x, dz = pp.z - a.position.z;
    const dist = Math.hypot(dx, dz);
    const yawToP = Math.atan2(dx, dz);
    let wish = _v.set(0, 0, 0);
    let speed = 0;
    if (this.state === 'idle') {
      turnToward(a, this.homeYaw, dt, 2);
      // hearing: sprinting is loud, walking is quiet (the standoff can be offered from ~24 m); hooves carry further
      // (player.noiseRange, set while riding: src/actors/horse/Riding.js)
      const ps = player.anim.loco.speed;
      const noisy = Math.max(ps > 5 ? 20 : ps > 2.5 ? 12 : 8.5, player.noiseRange || 0);
      if (player.alive && dist < noisy && this.game.state === 'play' && !this.game.standoffActive) this.alert();
    } else if (this.state === 'watch') {
      // standoff spectator: face the samurai, weapon ready, wait
      turnToward(a, yawToP, dt, 4);
    } else if (this.state === 'alert') {
      turnToward(a, yawToP, dt, 6);
      this.alertT -= dt;
      if (this.alertT <= 0) this.state = 'engage';
    } else if (this.state === 'engage') {
      if (!player.alive) {
        this.state = 'idle';
        return;
      }
      this.cool -= dt;
      this.switchT -= dt;
      if (this.switchT <= 0) {
        this.circleDir *= -1;
        this.switchT = 2 + this.rng() * 3.5;
      }
      if (!f.busy) {
        turnToward(a, yawToP, dt, 7);
        if (!this.token && this.cool <= 0 && dist < 7) this.token = this.combat.requestToken(this);
        const want = this.token ? this.reach - 0.2 : 4.4 + (this.spear ? 0.6 : 0);
        const radial = dist - want;
        const dir = _d.set(dx, 0, dz).normalize();
        wish.addScaledVector(dir, THREE.MathUtils.clamp(radial, -1, 1));
        if (!this.token) wish.add(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.circleDir * 0.55));
        // separation from other bandits
        for (const g of this.combat.fighters) {
          if (g === f || !g.ai || !g.actor.alive) continue;
          const ox = a.position.x - g.actor.position.x, oz = a.position.z - g.actor.position.z;
          const od = Math.hypot(ox, oz);
          if (od < 2.2 && od > 1e-3) wish.add(new THREE.Vector3(ox / od, 0, oz / od).multiplyScalar((2.2 - od) * 0.9));
        }
        speed = Math.min(1, wish.length()) * (radial > 2.5 ? 3.4 : 1.7);
        if (this.token && this.cool <= 0 && dist <= this.reach + 0.4) this._attack(player);
      }
    }
    // integrate
    if (wish.lengthSq() > 1e-6) wish.normalize();
    const target = wish.multiplyScalar(speed);
    this.vel.lerp(target, 1 - Math.exp(-dt * 8));
    const motion = f.actionMotion(dt, new THREE.Vector3());
    const p = a.position;
    p.x += this.vel.x * dt + motion.x;
    p.z += this.vel.z * dt + motion.z;
    this.game.colliders.resolve(p, a.radius * 0.8);
    // keep out of the player
    const px = p.x - pp.x, pz = p.z - pp.z, pd = Math.hypot(px, pz), min = a.radius + player.radius;
    if (pd < min && pd > 1e-4 && player.alive) {
      p.x = pp.x + (px / pd) * min;
      p.z = pp.z + (pz / pd) * min;
    }
    p.y = this.game.groundAt(p.x, p.z);
    a.anim.loco.speed = f.busy ? 0 : this.vel.length();
    a.anim.lookTarget = this.state === 'engage' || this.state === 'alert' ? new THREE.Vector3(pp.x, pp.y + 1.5, pp.z) : null;
  }

  _attack(player) {
    const r = this.rng();
    let name, unblockable = false;
    if (this.spear) {
      if (r < 0.28) (name = 'spear_sweep'), (unblockable = true);
      else name = 'spear_thrust';
    } else if (r < 0.18) (name = 'heavy'), (unblockable = true);
    else name = r < 0.62 ? 'light1' : 'light2';
    const ok = this.f.startAttack(name, { target: player, speed: this.spear ? 1 : 0.88, unblockable });
    if (!ok) return;
    if (unblockable) {
      this.vfx.glint(this.a, 0.55);
      this.game.emit('glint', { actor: this.a });
    }
    this.cool = 1.4 + this.rng() * 1.6;
    const layer = this.f.attack.layer;
    const prev = layer.onEnd;
    layer.onEnd = (l) => {
      if (prev) prev(l);
      this.combat.releaseToken(this);
      this.token = false;
    };
  }
}

export function turnToward(actor, yaw, dt, rate) {
  let d = yaw - actor.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const step = Math.sign(d) * Math.min(Math.abs(d), rate * dt);
  actor.setYaw(actor.yaw + step);
  return step / Math.max(1e-4, dt);
}
