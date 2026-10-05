import * as THREE from 'three';
import { BONE_DEFS } from './rig/skeleton.js';
import { buildLibrary } from './anim/library.js';
import { SAMURAI, BANDITS } from './gen/character.js';
import { Actor } from './Actor.js';
import { Fighter } from './Fighter.js';
import { PlayerController } from './Player.js';
import { EnemyAI } from './Enemy.js';
import { CameraRig } from './CameraRig.js';
import { Combat } from './combat/Combat.js';
import { VFX } from './combat/VFX.js';
import { Standoff, Prompts } from './combat/Standoff.js';
import { Quests } from './quest/Quests.js';
import { POI } from '../world/Layout.js';
import { cameraFrame, inFrame, yawTo, s3Layout, registerDebugShots, DEBUG_STAGE } from './staging.js';
import { updateCharacterLighting } from './gen/charShading.js';
import { installRumble } from './rumble.js';
import { installHorse } from './horse/index.js';
import { Intro } from './intro.js';

// Actors module: samurai player, bandits, animation, cape, combat, standoff, guiding wind & quests.
// Public API (returned → game.modules.actors): { player, bandits, fighters, combat, standoff, quests, camRig, vfx, pc }

export async function install(game, ctx) {
  const boneNames = BONE_DEFS.map((d) => d[0]);
  const lib = buildLibrary(boneNames);
  const wind = game.wind;
  const groundAt = (x, z) => game.groundAt(x, z);
  const shotMode = !!game.opts.shot;

  const vfx = new VFX(game);
  game.scene.add(vfx.group);
  const camRig = new CameraRig(game);
  const combat = new Combat(game, vfx, camRig);
  const prompts = new Prompts(game);

  // ---- player ---------------------------------------------------------------------------------------------
  // night-blue cape, desaturated (it reads dark against the low sun, with a lit edge), a lighter lining; tied
  // across the upper back under the shoulder guards
  const cape = { color: '#1d2636', lining: '#2b303b', hem: '#6d665a', length: 1.28, topWidth: 0.36, bottomWidth: 1.1, windK: 1.6, seed: 3 };
  const player = new Actor(game, SAMURAI, lib, { weapon: 'katana', cape, hp: 100 });
  game.add(player.root);
  game.add(player.cape.mesh);
  game.player = player;
  const pf = combat.add(new Fighter(player, game));
  const pc = new PlayerController(game, pf, camRig, combat);
  const spawnYaw = Math.atan2(POI.shrine.x - POI.spawn.x, POI.shrine.z - POI.spawn.z);
  player.place(POI.spawn.x, POI.spawn.z, spawnYaw);
  pc.setCheckpoint(POI.spawn.x, POI.spawn.z, spawnYaw);

  // ---- bandits at the ginkgo-valley camp ------------------------------------------------------------------
  const specs = BANDITS;
  let seed = 7;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // around the camp fire in the farmhouse's front yard (props/camp.js builds it at POI.camp.fire)
  const fireAt = POI.camp.fire;
  const campSpot = (i) => {
    const a = (i / specs.length) * Math.PI * 2 + 0.4;
    const r = 3.6 + (i % 2) * 0.9;
    return { x: fireAt.x + Math.sin(a) * r, z: fireAt.z + Math.cos(a) * r, yaw: a + Math.PI };
  };
  const bandits = specs.map((spec, i) => {
    const a = new Actor(game, spec, lib, { weapon: spec.weapon, hp: 70 });
    game.add(a.root);
    const f = combat.add(new Fighter(a, game));
    const s = campSpot(i);
    const ai = new EnemyAI(game, f, combat, vfx, { group: 'camp', rng });
    ai.reset(s.x, s.z, s.yaw);
    return a;
  });
  const actors = [player, ...bandits];
  const standoff = new Standoff(game, combat, camRig, vfx, pc, prompts);
  const quests = new Quests(game, pc, combat, camRig, prompts);
  if (!shotMode) installRumble(game); // gamepad rumble on hits, parries, perfect dodges, guard breaks, kills
  // ---- the horse (src/actors/horse/): grazes near the spawn, ridden through a hook in the player controller;
  // never part of the canonical shots
  const horse = shotMode ? null : installHorse(game, { player, pc, camRig, combat, standoff, quests, prompts, lib });
  // ---- the opening cinematic (src/actors/intro.js): the first play after the title; the first quest, the vitals and
  // control begin when it lands behind the samurai (?nointro skips it, ?intro plays it without the title)
  const begin = () => {
    quests.start();
    game.emit('player:health', { hp: player.hp, max: player.maxHp });
    game.emit('player:resolve', { value: player.resolve, max: player.maxResolve });
  };
  const intro = shotMode ? null : new Intro(game, { player, pc, camRig, prompts, onDone: begin });

  // ---- per-frame systems -----------------------------------------------------------------------------------
  const aCtx = { groundAt, wind, time: 0 };
  let lastFar = 0;
  const perf = { ms: 0, max: 0 };
  game.addSystem({
    frame(dt, t) {
      const t0 = performance.now();
      frameActors(dt, t);
      const ms = performance.now() - t0;
      perf.ms += (ms - perf.ms) * 0.05;
      perf.max = Math.max(perf.max * 0.995, ms);
    },
  });
  // report the module's CPU cost through game.stats() (read by the shots harness → report.json)
  game.addStat(() => ({ actorsMs: +perf.ms.toFixed(3), actorsMsMax: +perf.max.toFixed(3) }));

  function frameActors(dt, t) {
    {
      aCtx.time = wind.time;
      const realDt = Math.min(0.1, (game.loop ? game.loop.lastFrameMs : 16) / 1000);
      if (!shotMode) {
        if (intro) intro.update(dt);
        pc.update(dt);
        if (horse) horse.update(dt);
        for (const b of bandits) {
          const f = b.fighter;
          f.update(dt);
          if (f.ai && b.root.visible) f.ai.update(dt);
        }
        standoff.update(dt);
        quests.update(dt);
        combat.update(realDt);
      }
      updateCharacterLighting(game);
      // far actors animate at a reduced rate
      const cam = game.camera.position;
      // grass parts around the nearest visible actors (shared 8-slot trample API; standoff uses its own group)
      if (game.grass && game.grass.setTrample) {
        const near = actors
          .filter((a) => a.root.visible && a.position.distanceTo(cam) < 90)
          .sort((a, b) => a.position.distanceTo(cam) - b.position.distanceTo(cam))
          .slice(0, 6);
        game.grass.setTrample(near.map((a) => ({ x: a.position.x, z: a.position.z, r: a.alive ? 1.25 : 1.4, s: 1 })), 'actors');
      }
      const farTick = t - lastFar > 0.2;
      if (farTick) lastFar = t;
      for (const a of actors) {
        if (!a.root.visible) continue;
        const far = a.position.distanceTo(cam) > 120;
        if (!far) a.update(dt, aCtx);
        else if (farTick) a.update(0.2, aCtx);
      }
      if (horse) horse.late(dt);
      vfx.update(dt, actors);
    }
  }

  // ---- game states -----------------------------------------------------------------------------------------
  let started = false;
  game.on('state', (e) => {
    const s = e.detail.state;
    if (s === 'play') {
      game.freeCam.enabled = false;
      game.cameraController = camRig;
      if (!started) {
        started = true;
        camRig.snapBehind(player);
        const p = ctx.params;
        if (intro && !p.has('nointro') && (e.detail.prev === 'title' || p.has('intro'))) intro.start({ waitReveal: !!game.ui });
        else begin();
      }
      pc.enabled = true;
    } else if (s === 'title') {
      pc.enabled = false;
    } else if (s === 'paused') {
      if (game.input.exitPointerLock) game.input.exitPointerLock();
    }
  });
  // after the player falls, surviving bandits return to camp healed (the encounter can be retried)
  game.on('respawn', () => {
    combat.tokens.clear();
    bandits.forEach((b, i) => {
      if (!b.alive || !b.fighter.ai) return;
      const s = campSpot(i);
      b.fighter.ai.reset(s.x, s.z, s.yaw);
    });
  });
  game.renderer.canvas.addEventListener('click', () => {
    if (game.state === 'play' && !game.freeCam.enabled && !shotMode) game.input.requestPointerLock();
  });

  // ---- shot staging -----------------------------------------------------------------------------------------
  registerDebugShots();
  const stage = (actor, x, z, yaw, base = null, clip = null) => {
    actor.setVisible(true);
    if (actor.saya) actor.saya.visible = true;
    actor.alive = true;
    actor.place(x, z, yaw);
    if (base) {
      actor.anim.setBase(base, clip, 0);
      actor.anim.base.prev = null;
    }
    actor.anim.layers = [];
    actor.anim.loco.speed = 0;
    // the same pose at every capture, whatever ran before: breathing restarts (idle and held clips alike: setBase
    // keeps the clock of an unchanged base, so a capture that ran longer, like the fps pass, caught another phase
    // of the S3 stance and its cape settled elsewhere), foot IK starts level
    actor.anim.loco.idleT = 0;
    actor.anim.base.time = 0;
    actor.anim.pelvis = 0;
  };
  const warm = (a) => {
    a.update(1 / 60, { ...aCtx, time: wind.time });
    if (a.cape) {
      a.cape.reset();
      a.cape.warm(240, { wind, time: wind.time, groundY: a.root.position.y });
    }
  };
  const resetCamp = () =>
    bandits.forEach((b, i) => {
      const s = campSpot(i);
      stage(b, s.x, s.z, s.yaw, b.weaponKind === 'spear' ? 'spear' : 'free');
    });
  game.onShot((id) => {
    // setShot moved the wind clock to the shot's t0: sync the gust field before the capes warm up in it, or
    // their state would depend on how long the page ran before (captures must repeat exactly)
    wind.update(0);
    const cf = cameraFrame(game.camera);
    resetCamp();
    if (game.grass && game.grass.setTrample) {
      game.grass.setTrample(null, 'standoff');
      game.grass.setTrample(null, 'shot');
    }
    player.cape.windBias = null;
    if (id === 'S1_field') {
      const p = inFrame(cf, 5.6, -0.34); // on the left third, a quarter of the frame tall, the torii above-right
      stage(player, p.x, p.z, cf.yaw + 0.12, 'free');
      // cinematic cross-gust: the cape flies out to screen-left at chest height, clear of the hip
      player.cape.windBias = new THREE.Vector2(-cf.right.x, -cf.right.z).multiplyScalar(1.6);
      // no susuki plume crosses his cape or torso: the plumes on the line from the lens to him give way (the blades
      // only part a little, like a trail through the field), a little upwind of it too, since the plumes there lean into
      // it in a gust; the grass right in front of him stays, so his legs stand in it
      if (game.grass && game.grass.setTrample) {
        const at = (k) => ({ x: cf.pos.x + (p.x - cf.pos.x) * k + cf.right.x * 0.7, z: cf.pos.z + (p.z - cf.pos.z) * k + cf.right.z * 0.7 });
        game.grass.setTrample([{ ...at(0.35), r: 1.6, s: 0.7 }, { ...at(0.62), r: 1.6, s: 0.7 }], 'shot');
      }
    } else if (id === 'S2_shrine') {
      // a small dark figure climbing the flights on their left side, whose size gives the gate hall its scale.
      // Placed on the stairs themselves (stair-local s, lat), so a new S2 camera keeps him on the steps.
      const sh = POI.shrine, u = sh.stairDir;
      // near the top of the second flight (s 18–34), left of the axis: from the raised T6_S2 camera lower on the same
      // flight he climbs in the lower left third, ~13 m away; lat > 0 = left when looking up the stairs
      const s = 32.5, lat = 1.6;
      stage(player, sh.stairsBase.x + u.x * s + u.z * lat, sh.stairsBase.z + u.z * s - u.x * lat, Math.atan2(u.x, u.z), 'climb', 'climb');
    } else if (id === 'S3_standoff') {
      // the samurai in profile on the left third, the bandits closing in on the right third, the sun between
      const L = s3Layout(cf);
      // the wind blows from the bandits past the samurai: his cape streams out taut behind him, downwind
      player.cape.windBias = new THREE.Vector2(-cf.right.x, -cf.right.z).multiplyScalar(1.1);
      stage(player, L.samurai.x, L.samurai.z, L.samurai.yaw, L.samurai.base, L.samurai.clip);
      // the bandits have cast their scabbards aside to fight: crouched, each one's scabbard would trail 0.65 m behind
      // his hip, across the legs of the comrade beside him in the long lens
      for (const s of L.bandits) {
        stage(bandits[s.i], s.x, s.z, s.yaw, s.base, s.clip);
        if (bandits[s.i].saya) bandits[s.i].saya.visible = false;
      }
      const mid = inFrame(cf, 8.2, 0.05);
      if (game.grass && game.grass.setTrample) game.grass.setTrample([{ x: mid.x, z: mid.z, r: 10, s: 0.9 }], 'standoff');
      if (game.post) game.post.params.letterbox = 1;
    } else if (id === 'S4_title') {
      const p = inFrame(cf, 11, 0.5);
      stage(player, p.x, p.z, cf.yaw - 0.2, 'free');
    } else if (id === 'S5_ginkgo') {
      // the samurai alone at the edge of the yard, left third, turned toward the farmhouse (a small figure)
      const p = inFrame(cf, 11.5, -0.47);
      stage(player, p.x, p.z, yawTo(p, POI.camp.house), 'free');
      for (const b of bandits) b.setVisible(false);
    } else if (id.startsWith('T8_')) {
      stage(player, DEBUG_STAGE.x, DEBUG_STAGE.z, DEBUG_STAGE.yaw, 'free');
      if (id === 'T8_group') {
        const f = new THREE.Vector3(Math.sin(DEBUG_STAGE.yaw), 0, Math.cos(DEBUG_STAGE.yaw));
        const r = new THREE.Vector3(-f.z, 0, f.x);
        bandits.slice(0, 4).forEach((b, i) => {
          const q = new THREE.Vector3(DEBUG_STAGE.x, 0, DEBUG_STAGE.z).addScaledVector(f, 4 + (i % 2) * 1.5).addScaledVector(r, -2.4 + i * 1.6);
          stage(b, q.x, q.z, yawTo(q, player.position), b.weaponKind === 'spear' ? 'spear' : 'combat');
        });
      }
    }
    for (const a of actors) if (a.root.visible) warm(a);
  });

  return { player, bandits, actors, fighters: combat.fighters, combat, standoff, quests, camRig, vfx, pc, prompts, lib, horse, intro };
}
