import * as THREE from 'three';

// Standoff: near an unaware group press E → letterbox, low side camera, the lead bandit steps forward.
// Hold E; the bandit may feint; release exactly while he lunges → instant iai kill (slow-motion), chain up to 3.
// Releasing early or too late → you take the blow and the fight begins.
// Emits 'standoff:start' {enemies}, 'standoff:end' {result, kills}, 'standoff:ready' / 'standoff:lunge' / 'standoff:feint'.

const _v = new THREE.Vector3();

export class Standoff {
  constructor(game, combat, camRig, vfx, playerCtl, prompts) {
    this.game = game;
    this.combat = combat;
    this.cam = camRig;
    this.vfx = vfx;
    this.pc = playerCtl;
    this.prompts = prompts;
    this.state = 'none';
    this.kills = 0;
    this.lead = null;
    this.t = 0;
    this.rng = Math.random;
  }

  get player() {
    return this.pc.a;
  }

  _group() {
    const p = this.player.position;
    const list = this.combat.fighters.filter(
      (f) => f.ai && f.actor.alive && (f.ai.state === 'idle' || f.ai.state === 'watch') && f.actor.root.visible && f.actor.position.distanceTo(p) < 24
    );
    return list.sort((a, b) => a.actor.position.distanceTo(p) - b.actor.position.distanceTo(p));
  }

  update(dt) {
    const g = this.game, inp = g.input;
    const p = this.player;
    if (this.state === 'none') {
      // on foot only: in the saddle the riding module says to dismount first
      const can = g.state === 'play' && p.alive && !this.combat.inCombat && this.pc.controlLock <= 0 && !p.mounted;
      const grp = can ? this._group() : [];
      if (grp.length) {
        this.prompts.set('standoff', 'Sfida (standoff)', 'E');
        if (inp.pressed('interact')) this._start(grp);
      } else this.prompts.clear('standoff');
      return;
    }
    this.t += dt;
    const lead = this.lead;
    const holding = inp.down('interact');
    if (this.state === 'approach') {
      // lead walks to ~6.5 m in front of the player
      const ai = lead.ai;
      const d = _v.subVectors(p.position, lead.actor.position).setY(0);
      const dist = d.length();
      lead.actor.setYaw(Math.atan2(d.x, d.z));
      if (dist > 6.6) {
        const step = Math.min(dist - 6.5, 1.6 * dt);
        lead.actor.position.addScaledVector(d.normalize(), step);
        lead.actor.position.y = g.groundAt(lead.actor.position.x, lead.actor.position.z);
        lead.actor.anim.loco.speed = 1.6;
      } else lead.actor.anim.loco.speed = 0;
      void ai;
      if (this.t > 1.6 && dist <= 6.7) {
        this.state = 'wait';
        this.t = 0;
        this.waitFor = (this.kills ? 0.9 : 1.6) + this.rng() * (this.kills ? 1.6 : 2.6);
        this.feints = this.rng() < 0.65 ? [this.waitFor * (0.35 + this.rng() * 0.3)] : [];
        this.prompts.set('standoff', 'Tieni premuto… rilascia quando attacca', 'E');
        g.emit('standoff:ready', { lead: lead.actor });
      }
      if (!holding && this.t > 0.4) return this._fail('early');
      return;
    }
    if (this.state === 'wait') {
      if (!holding) return this._fail('early');
      if (this.feints.length && this.t >= this.feints[0]) {
        this.feints.shift();
        lead.actor.anim.play(lead.actor.weaponKind === 'spear' ? 'spear_idle' : 'block', { fade: 0.05, fadeOut: 0.12, speed: 3 });
        lead.actor.position.addScaledVector(lead.actor.forward(_v), 0.25);
        g.emit('standoff:feint', { lead: lead.actor });
      }
      if (this.t >= this.waitFor) {
        this.state = 'lunge';
        this.t = 0;
        lead.startAttack(lead.actor.weaponKind === 'spear' ? 'spear_thrust' : 'light1', { target: p, speed: 1.2 });
        g.emit('standoff:lunge', { lead: lead.actor });
      }
      return;
    }
    if (this.state === 'lunge') {
      // the bandit dashes in; the window lasts until he is in reach
      const d = _v.subVectors(p.position, lead.actor.position).setY(0);
      const dist = d.length();
      if (dist > 1.9) {
        lead.actor.position.addScaledVector(d.normalize(), Math.min(dist - 1.8, 11 * dt));
        lead.actor.position.y = g.groundAt(lead.actor.position.x, lead.actor.position.z);
      }
      if (!holding) return this._success();
      if (this.t > 0.5) return this._fail('late');
      return;
    }
    if (this.state === 'strike') {
      if (this.t > 1.25) {
        const next = this._group().filter((f) => f !== lead);
        if (this.kills < 3 && next.length && holding) {
          this.lead = next[0];
          this.lead.ai.state = 'idle';
          if (this.lead.actor.weaponKind === 'katana') this.lead.drawSword();
          this._arena();
          this.state = 'approach';
          this.t = 0;
          this.lead.actor.setVisible(true);
          p.fighter.drawn = false;
          p.anim.setBase('standoff', 'standoff', 0.5);
          p.anim.play('sheathe', { fade: 0.1, fadeOut: 0.3, speed: 1.3 });
        } else this._end('win');
      }
    }
  }

  _start(grp) {
    const g = this.game, p = this.player;
    this.state = 'approach';
    this.t = 0;
    this.kills = 0;
    this.lead = grp[0];
    if (this.lead.actor.weaponKind === 'katana') this.lead.drawSword();
    g.standoffActive = true;
    this.prompts.set('standoff', 'Tieni premuto', 'E');
    p.anim.setBase('standoff', 'standoff', 0.4);
    p.setYaw(Math.atan2(this.lead.actor.position.x - p.position.x, this.lead.actor.position.z - p.position.z));
    this.pc.vel.set(0, 0, 0);
    if (g.post) g.post.params.letterbox = 1;
    const cam = this.cam;
    const side = () => {
      const a = p.position, b = this.lead.actor.position;
      const mid = a.clone().lerp(b, 0.5);
      const d = b.clone().sub(a).setY(0).normalize();
      const s = new THREE.Vector3(-d.z, 0, d.x);
      const pos = mid.clone().addScaledVector(s, 8.2).addScaledVector(d, -1.2);
      // above the grass tops, never below the duelists' ground (dips would hide them)
      pos.y = Math.max(g.groundAt(pos.x, pos.z), g.groundAt(mid.x, mid.z)) + 1.55;
      return pos;
    };
    const target = () => {
      const mid = p.position.clone().lerp(this.lead.actor.position, 0.5);
      mid.y = g.groundAt(mid.x, mid.z) + 1.0;
      return mid;
    };
    cam.setOverride({ pos: side, target, fov: 34 }, 1.1);
    // the rest of the group watches, weapons ready; the duel happens in trodden grass
    for (const f of grp) {
      if (f === this.lead) continue;
      f.ai.state = 'watch';
      if (f.actor.weaponKind === 'katana') f.drawSword();
    }
    this._arena();
    g.emit('standoff:start', { enemies: grp.map((f) => f.actor) });
  }

  _success() {
    const g = this.game, p = this.player, lead = this.lead;
    this.state = 'strike';
    this.t = 0;
    this.kills++;
    p.setYaw(Math.atan2(lead.actor.position.x - p.position.x, lead.actor.position.z - p.position.z));
    p.fighter.drawn = true;
    p.anim.setBase('combat', null, 0.6);
    p.fighter.startAttack('iai', { target: lead.actor });
    const hp = lead.actor.position.clone();
    hp.y += 1.25;
    lead.die(p);
    if (lead.ai) lead.ai.state = 'dead';
    this.vfx.bloodAt(hp, p.forward(new THREE.Vector3()), 46);
    this.combat.slowMo(0.3, 1.1);
    this.cam.shake(0.8);
    g.emit('hit', { attacker: p, target: lead.actor, kind: 'kill' });
    g.emit('enemy:death', { actor: lead.actor, group: lead.ai ? lead.ai.group : null });
    p.resolve = Math.min(p.maxResolve, (p.resolve || 0) + 0.5);
    g.emit('player:resolve', { value: p.resolve, max: p.maxResolve });
  }

  _fail(why) {
    const p = this.player, lead = this.lead;
    if (why === 'early' && lead && lead.actor.alive) {
      lead.startAttack(lead.actor.weaponKind === 'spear' ? 'spear_thrust' : 'light1', { target: p, speed: 1.3 });
    }
    p.fighter.takeHit(28, lead ? lead.actor : null, { posture: 30, heavy: true });
    this.game.emit('player:health', { hp: p.hp, max: p.maxHp });
    this._end('fail');
  }

  _arena() {
    const g = this.game;
    if (!g.grass || !g.grass.setTrample || !this.lead) return;
    const m = this.player.position.clone().lerp(this.lead.actor.position, 0.5);
    g.grass.setTrample([{ x: m.x, z: m.z, r: 10, s: 0.9 }], 'standoff');
  }

  _end(result) {
    const g = this.game, p = this.player;
    this.state = 'none';
    g.standoffActive = false;
    if (g.grass && g.grass.setTrample) g.grass.setTrample(null, 'standoff');
    this.prompts.clear('standoff');
    this.cam.clearOverride(0.9);
    if (g.post) g.post.params.letterbox = g.post.defaults.letterbox; // back to the player's, not to nothing
    if (p.alive && p.anim.base.mode === 'standoff') {
      p.fighter.drawn = true;
      p.anim.setBase('combat', null, 0.3);
      p.anim.play('draw', { fade: 0, fadeOut: 0.12 });
    }
    // everyone left in the group attacks
    for (const f of this.combat.fighters) if (f.ai && f.actor.alive && f.ai.state === 'idle' && f.actor.position.distanceTo(p.position) < 30) f.ai.alert();
    g.emit('standoff:end', { result, kills: this.kills });
  }
}

// Prompt arbiter: several systems may want the context prompt; the most recent owner wins.
export class Prompts {
  constructor(game) {
    this.game = game;
    this.stack = new Map();
    this.shown = null;
  }

  set(owner, text, key) {
    this.stack.delete(owner);
    this.stack.set(owner, { text, key });
    this._emit();
  }

  clear(owner) {
    if (!this.stack.has(owner)) return;
    this.stack.delete(owner);
    this._emit();
  }

  _emit() {
    const last = [...this.stack.values()].pop() || null;
    const sig = last ? last.text + '|' + last.key : null;
    if (sig === this.shown) return;
    this.shown = sig;
    if (last) this.game.emit('prompt', last);
    else this.game.emit('prompt:clear', {});
  }
}
