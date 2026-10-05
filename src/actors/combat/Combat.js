import * as THREE from 'three';

// Combat director: resolves sword hits between fighters (range + arc during the clip's hit window),
// dodge i-frames, block / perfect parry / guard break, unblockable attacks, damage, deaths; limits how many
// enemies attack at once (tokens); owns time effects (hit-stop, slow-motion) and the kill-cam on the last foe.
// Emits: 'hit' {attacker, target, kind}, 'combat:start', 'combat:end', 'player:health', 'player:resolve',
//        'player:death', 'enemy:death', 'guardbreak', 'perfect-dodge'.

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Combat {
  constructor(game, vfx, camRig) {
    this.game = game;
    this.vfx = vfx;
    this.cam = camRig;
    this.fighters = [];
    this.tokens = new Set();
    this.maxTokens = 2;
    this.inCombat = false;
    this.endTimer = 0;
    this.hitStop = 0;
    this.slow = 0;
    this.slowScale = 1;
    this.killCam = 0;
    this.player = null;
  }

  add(fighter) {
    this.fighters.push(fighter);
    fighter.actor.fighter = fighter;
    if (fighter.actor.team === 'player') this.player = fighter;
    return fighter;
  }

  requestToken(ai) {
    if (this.tokens.has(ai)) return true;
    if (this.tokens.size >= this.maxTokens) return false;
    this.tokens.add(ai);
    return true;
  }

  releaseToken(ai) {
    this.tokens.delete(ai);
  }

  hitStopFor(sec) {
    this.hitStop = Math.max(this.hitStop, sec);
  }

  slowMo(scale, sec) {
    if (this.slow > 0 && scale > this.slowScale) return;
    this.slowScale = scale;
    this.slow = Math.max(this.slow, sec);
  }

  engaged() {
    return this.fighters.filter((f) => f.ai && f.actor.alive && f.ai.state === 'engage');
  }

  _arc(F, G, meta) {
    const A = F.actor, D = G.actor;
    const dx = D.position.x - A.position.x, dz = D.position.z - A.position.z;
    const dist = Math.hypot(dx, dz) - D.radius;
    if (dist > (meta.reach || 2)) return false;
    if (Math.abs(D.position.y - A.position.y) > 1.6) return false;
    let ang = Math.atan2(dx, dz) - A.yaw;
    ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    const arc = meta.arc || [-60, 60];
    const lim = THREE.MathUtils.degToRad(Math.max(Math.abs(arc[0]), Math.abs(arc[1]))) + (dist < 0.6 ? 0.8 : 0);
    return Math.abs(ang) <= lim;
  }

  _resolve(F, G) {
    const meta = F.attack.meta;
    const A = F.actor, D = G.actor;
    const toA = _a.subVectors(A.position, D.position).setY(0).normalize();
    const hitP = D.position.clone().add(new THREE.Vector3(0, 1.25 * D.rig.scale, 0)).addScaledVector(toA, 0.22);
    const unblockable = F.attack.unblockable ?? meta.unblockable;
    if (G.invulnerable()) {
      if (D.team === 'player' && G.dodge && G.dodge.layer.time < 0.2) {
        this.slowMo(0.35, 0.45);
        this.game.emit('perfect-dodge', { actor: D, attacker: A });
      }
      return;
    }
    const facing = Math.cos(Math.atan2(toA.x, toA.z) - D.yaw) > 0.1;
    if (G.blocking && facing && !unblockable) {
      if (G.isParryWindow()) {
        F.staggerFor(1.35, D);
        this.vfx.sparksAt(hitP, toA.clone().negate(), 48);
        this.hitStopFor(0.09);
        this.slowMo(0.4, 0.4);
        this.cam && this.cam.shake(0.7);
        if (D.team === 'player') this._resolveGain(0.25);
        this.game.emit('hit', { attacker: A, target: D, kind: 'parry' });
        return;
      }
      D.posture += (meta.posture || 10) * 1.4;
      this.vfx.sparksAt(hitP, toA.clone().negate(), 18);
      this.hitStopFor(0.04);
      this.cam && D.team === 'player' && this.cam.shake(0.3);
      this.game.emit('hit', { attacker: A, target: D, kind: 'block' });
      if (D.posture >= 100) {
        D.posture = 0;
        G.staggerFor(1.1, A);
        this.game.emit('guardbreak', { actor: D });
      }
      return;
    }
    const dmg = (meta.damage || 15) * (A.team === 'bandit' ? 0.6 : 1);
    G.takeHit(dmg, A, { posture: meta.posture || 10, heavy: !!meta.heavy });
    const cut = new THREE.Vector3(-toA.z, 0.2, toA.x).multiplyScalar(Math.random() < 0.5 ? 1 : -1).addScaledVector(toA, -0.6).normalize();
    this.vfx.bloodAt(hitP, cut, D.alive ? 22 : 40);
    this.hitStopFor(meta.heavy ? 0.1 : 0.055);
    this.cam && this.cam.shake(meta.heavy ? 0.9 : 0.45);
    if (D.alive && D.team === 'bandit' && D.posture >= 100) {
      D.posture = 0;
      G.staggerFor(1.3, A);
    }
    this.game.emit('hit', { attacker: A, target: D, kind: D.alive ? 'slash' : 'kill' });
    if (D.team === 'player') this.game.emit('player:health', { hp: D.hp, max: D.maxHp });
    if (!D.alive) this._onKill(A, D);
  }

  _resolveGain(v) {
    const p = this.player && this.player.actor;
    if (!p) return;
    p.resolve = Math.min(p.maxResolve, (p.resolve || 0) + v);
    this.game.emit('player:resolve', { value: p.resolve, max: p.maxResolve });
  }

  _onKill(A, D) {
    if (D.team === 'player') {
      this.game.emit('player:death', { actor: D });
      return;
    }
    const ai = D.fighter && D.fighter.ai;
    if (ai) this.releaseToken(ai);
    this.game.emit('enemy:death', { actor: D, group: ai ? ai.group : null });
    this._resolveGain(0.35);
    const left = this.fighters.filter((f) => f.ai && f.actor.alive && f.ai.group === (ai && ai.group) && f.ai.state !== 'idle');
    if (left.length === 0 && A.team === 'player') this.startKillCam(A, D);
  }

  startKillCam(A, D) {
    this.slowMo(0.22, 1.5);
    this.killCam = 1.9;
    const mid = A.position.clone().lerp(D.position, 0.5);
    const d = _b.subVectors(D.position, A.position).setY(0).normalize();
    const side = new THREE.Vector3(-d.z, 0, d.x);
    const pos = mid.clone().addScaledVector(side, 3.4).addScaledVector(d, -0.8);
    pos.y = this.game.groundAt(pos.x, pos.z) + 1.05;
    const target = mid.clone();
    target.y = this.game.groundAt(mid.x, mid.z) + 1.1;
    this.cam && this.cam.setOverride({ pos, target, fov: 42 }, 0.25);
    if (this.game.post) this.game.post.params.letterbox = Math.max(this.game.post.params.letterbox || 0, 0.6);
    this.game.emit('killcam', { attacker: A, target: D });
  }

  update(realDt) {
    // hits
    for (const F of this.fighters) {
      if (!F.actor.alive || !F.attack || !F.inHitWindow()) continue;
      for (const G of this.fighters) {
        if (G === F || !G.actor.alive || G.actor.team === F.actor.team || F.attack.hits.has(G)) continue;
        if (!G.actor.root.visible) continue;
        if (this._arc(F, G, F.attack.meta)) {
          F.attack.hits.add(G);
          this._resolve(F, G);
          if (!F.attack) break;
        }
      }
    }
    // time effects (real time)
    if (this.hitStop > 0) this.hitStop -= realDt;
    if (this.slow > 0) this.slow -= realDt;
    if (this.killCam > 0) {
      this.killCam -= realDt;
      if (this.killCam <= 0) {
        this.cam && this.cam.clearOverride(0.7);
        const post = this.game.post; // the letterbox goes back to the player's (post.defaults), not to nothing
        if (post && !this.game.standoffActive) post.params.letterbox = post.defaults.letterbox;
      }
    }
    const scale = this.hitStop > 0 ? 0.05 : this.slow > 0 ? this.slowScale : 1;
    if (this.game.loop && !this.game.opts.shot) this.game.loop.timeScale = scale;
    // encounter state
    const eng = this.engaged();
    if (eng.length && !this.inCombat) {
      this.inCombat = true;
      this.endTimer = 0;
      this.game.emit('combat:start', { enemies: eng.map((f) => f.actor) });
    } else if (!eng.length && this.inCombat) {
      this.endTimer += realDt;
      if (this.endTimer > 1.5) {
        this.inCombat = false;
        this.game.emit('combat:end', {});
      }
    }
    // camera combat target: nearest engaged enemy
    if (this.cam && this.player) {
      let best = null, bd = 14;
      for (const f of eng) {
        const d = f.actor.position.distanceTo(this.player.actor.position);
        if (d < bd) (bd = d), (best = f.actor);
      }
      this.cam.combatTarget = best;
    }
  }
}
