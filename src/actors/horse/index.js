import { Horse } from './Horse.js';
import { Riding, Reins } from './Riding.js';
import { reinsMaterial } from './mesh.js';

// Horse module, wired from src/actors/index.js (not a game module of its own: it needs the samurai, the camera rig,
// combat, the standoff, the quests and the prompts). Never installed for canonical shots (?shot=…).
//   installHorse(game, deps) → api { horse, riding, update(dt), late(dt) }
//     update(dt)  after the player controller (whose riding hook read the input): the horse moves, the rider sits
//     late(dt)    after the actors animated: the reins follow the rider's fists
// The horse lives only in 'play': hidden on the title screen, frozen with the rest of the world in pause and photo
// mode (dt = 0). Its CPU cost is reported as game.stats().horseMs / horseMsMax (rider animation not included: that is
// the samurai's, in actorsMs).
// It grazes where it is put down, near the samurai's spawn, and stands still through the opening cinematic ('intro:start'
// … 'intro:end', src/actors/intro.js): the film shows it where the first frame of play will, and it takes its first steps
// only a few seconds after the hand-over (without a cinematic, ?nointro, after 4 s of play).

// Grazing spot, in the samurai's own frame at his spawn: metres ahead of him and to his right, and the horse's heading
// as an angle from his own (radians, positive toward his left: it stands side-on, head toward the path). Picked from
// screenshots of the first frame of play and of the cinematic's last seconds: 24° to the right of the play camera's
// axis and 6.7 m from its lens, the whole horse in frame at 16:9 with most of it clear of the susuki, and beside him
// rather than on the line from the camera to him when the opening shot crosses behind him (farther ahead and nearer the
// path, it would be a small shape half hidden by the grass, then by his hat).
export const HORSE_SPAWN = { ahead: 2.5, right: 3.2, turn: 1.4 };
// the horse's first grazing step after the cinematic comes this many seconds after the hand-over
const FIRST_STEP = [6, 10];

// World pose { x, z, yaw } of the grazing spot for a samurai standing at (x, z) and facing `yaw`: his forward is
// (sin yaw, cos yaw) and his right (-cos yaw, sin yaw), as the camera rig has them.
export function horseSpawn(x, z, yaw, s = HORSE_SPAWN) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return { x: x + fx * s.ahead - fz * s.right, z: z + fz * s.ahead + fx * s.right, yaw: yaw + s.turn };
}

export function installHorse(game, deps) {
  const horse = new Horse(game);
  game.add(horse.root);
  horse.player = deps.player;
  // the samurai is already on his spawn, turned toward the shrine (src/actors/index.js)
  const spot = horseSpawn(deps.player.position.x, deps.player.position.z, deps.player.yaw);
  horse.place(spot.x, spot.z, spot.yaw);
  horse.mode = 'graze';
  horse.graze = 1;
  game.on('intro:start', () => (horse.still = true));
  game.on('intro:end', () => {
    horse.still = false;
    horse.stepT = FIRST_STEP[0] + Math.random() * (FIRST_STEP[1] - FIRST_STEP[0]);
  });
  const riding = new Riding(game, horse, deps);
  const reins = new Reins(reinsMaterial());
  game.add(reins.mesh);
  riding.reins = reins;

  // trampled grass under the horse (shared 8-slot API; one zone of its own)
  const zone = [{ x: 0, z: 0, r: 2.1, s: 1 }];
  let zoneOn = false;
  const setVisible = (v) => {
    horse.setVisible(v);
    reins.mesh.visible = v;
    if (game.grass && game.grass.setTrample && v !== zoneOn) {
      zoneOn = v;
      game.grass.setTrample(v ? zone : null, 'horse');
    }
  };
  setVisible(false);
  game.on('state', (e) => {
    const s = e.detail.state;
    if (s === 'play') setVisible(true);
    else if (s === 'title') setVisible(false);
  });

  const perf = { ms: 0, max: 0 };
  game.addStat(() => ({ horseMs: +perf.ms.toFixed(3), horseMsMax: +perf.max.toFixed(3) }));
  const measure = (ms) => {
    perf.ms += (ms - perf.ms) * 0.05;
    perf.max = Math.max(perf.max * 0.995, ms);
  };
  let acc = 0;
  return {
    horse,
    riding,
    update(dt) {
      if (game.state !== 'play' || !(dt > 0)) return;
      const t0 = performance.now();
      horse.update(dt);
      riding.placeRider();
      zone[0].x = horse.position.x;
      zone[0].z = horse.position.z;
      acc = performance.now() - t0;
    },
    late(dt) {
      if (game.state !== 'play' || !(dt > 0)) return;
      const t0 = performance.now();
      riding.late();
      measure(acc + performance.now() - t0);
    },
  };
}
