import * as THREE from 'three';
import { POI } from '../../world/Layout.js';

// Quest chain + guiding wind.
//   1. "La via del vento": follow the wind to the shrine on the hill, pray at the summit (E) → blessing
//   2. "La valle dei ginkgo": free the bandit camp (all bandits of group 'camp' defeated; standoff available)
//   3. "Il tramonto sulla scogliera": reach the cliff at sunset → ending cinematic
// T (guide) turns the wind toward the current objective.
// Emits 'quest:update' {id, index, total, title, objective, target:{x,z}}, 'quest:complete' {id},
// 'guide' {x, z}, 'blessing', 'pray:start', 'pray:end', 'ending'.

export const QUESTS = [
  {
    id: 'shrine',
    title: 'La via del vento',
    objective: 'Segui il vento fino al santuario sulla collina',
    target: () => ({ x: POI.shrine.x, z: POI.shrine.z }),
    radius: 11,
  },
  {
    id: 'camp',
    title: 'La valle dei ginkgo',
    objective: "Libera l'accampamento dei banditi",
    target: () => ({ x: POI.camp.yard.x, z: POI.camp.yard.z }), // the bandits' fire in front of the farmhouse
    radius: 0,
  },
  {
    id: 'cliff',
    title: 'Il tramonto sulla scogliera',
    objective: 'Raggiungi la scogliera prima che il sole tramonti',
    target: () => ({ x: POI.cliff.x, z: POI.cliff.z }),
    radius: 16,
  },
];

export class Quests {
  constructor(game, playerCtl, combat, camRig, prompts) {
    this.game = game;
    this.pc = playerCtl;
    this.combat = combat;
    this.cam = camRig;
    this.prompts = prompts;
    this.index = 0;
    this.done = false;
    this.guideCool = 0;
    this.praying = 0;
    this.ending = 0;
    game.on('enemy:death', () => this._checkCamp());
  }

  get current() {
    return QUESTS[this.index] || null;
  }

  start() {
    this.index = 0;
    this.done = false;
    this._announce();
  }

  _announce() {
    const q = this.current;
    if (!q) return;
    this.game.emit('quest:update', { id: q.id, index: this.index, total: QUESTS.length, title: q.title, objective: q.objective, target: q.target() });
    if (q.id === 'camp') this._checkCamp(); // the camp may already have been freed out of order
  }

  _complete() {
    const q = this.current;
    this.game.emit('quest:complete', { id: q.id, title: q.title });
    this.index++;
    if (this.index < QUESTS.length) {
      const p = this.pc.a.position;
      this.pc.setCheckpoint(p.x, p.z, this.pc.a.yaw);
      setTimeout(() => this._announce(), 2200);
    } else this.done = true;
  }

  guide() {
    const q = this.current;
    if (!q || this.guideCool > 0) return;
    const t = q.target();
    this.game.wind.guideTo(t.x, t.z, 9);
    this.guideCool = 2.5;
    this.game.emit('guide', { x: t.x, z: t.z });
  }

  _checkCamp() {
    const q = this.current;
    if (!q || q.id !== 'camp') return;
    const left = this.combat.fighters.filter((f) => f.ai && f.ai.group === 'camp' && f.actor.alive);
    if (left.length === 0) setTimeout(() => this.current && this.current.id === 'camp' && this._complete(), 1800);
  }

  update(dt) {
    const g = this.game, inp = g.input, a = this.pc.a;
    if (this.guideCool > 0) this.guideCool -= dt;
    if (g.state !== 'play' || !a.alive) return;
    if (inp.pressed('guide')) this.guide();
    const q = this.current;
    if (!q) return;
    const t = q.target();
    const d = Math.hypot(a.position.x - t.x, a.position.z - t.z);
    if (q.id === 'shrine') {
      if (this.praying > 0) {
        this.praying -= dt;
        if (this.praying <= 0) {
          a.maxResolve = (a.maxResolve || 3) + 1;
          a.resolve = a.maxResolve;
          g.emit('pray:end', {});
          g.emit('blessing', { maxResolve: a.maxResolve });
          g.emit('player:resolve', { value: a.resolve, max: a.maxResolve });
          this._complete();
        }
        return;
      }
      // on foot only: in the saddle the riding module says to dismount first
      if (d < q.radius && !this.combat.inCombat && !a.mounted) {
        this.prompts.set('pray', 'Prega al santuario', 'E');
        if (inp.pressed('interact') && !g.standoffActive) {
          this.prompts.clear('pray');
          this.praying = 4.8;
          this.pc.controlLock = 4.9;
          this.pc.vel.set(0, 0, 0);
          a.setYaw(Math.atan2(t.x - a.position.x, t.z - a.position.z));
          if (this.pc.f.drawn) this.pc.f.sheatheSword();
          a.anim.play('pray', { fade: 0.3, fadeOut: 0.4 });
          g.emit('pray:start', {});
        }
      } else this.prompts.clear('pray');
    } else if (q.id === 'cliff') {
      if (this.ending > 0) {
        this.ending += dt;
        return;
      }
      if (d < q.radius) this._ending();
    }
  }

  _ending() {
    const g = this.game, a = this.pc.a;
    this.ending = 0.001;
    this.pc.controlLock = 1e9;
    this.pc.vel.set(0, 0, 0);
    if (this.pc.f.drawn) this.pc.f.sheatheSword();
    // face the sunset and let the camera orbit slowly
    const sun = g.lighting.sunDir;
    a.setYaw(Math.atan2(sun.x, sun.z));
    if (g.post) g.post.params.letterbox = 1;
    const t0 = performance.now();
    // the orbit follows him: on foot he stands still; arriving at a gallop, the horse pulls up and turns to the sun
    // (src/actors/horse/Riding.js) under the camera
    const center = a.position;
    const pos = () => {
      const k = (performance.now() - t0) / 1000;
      const ang = a.yaw + Math.PI + 0.9 - k * 0.06;
      const p = new THREE.Vector3(center.x + Math.sin(ang) * 6.5, 0, center.z + Math.cos(ang) * 6.5);
      p.y = Math.max(g.groundAt(p.x, p.z) + 1.2, center.y + 1.6 + k * 0.05);
      return p;
    };
    const target = () => new THREE.Vector3(center.x + Math.sin(a.yaw) * 6, center.y + 1.4, center.z + Math.cos(a.yaw) * 6);
    this.cam.setOverride({ pos, target, fov: 40 }, 2.5);
    g.emit('quest:complete', { id: 'cliff', title: QUESTS[2].title });
    g.emit('ending', {});
    this.done = true;
  }
}
