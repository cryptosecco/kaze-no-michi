// Gamepad rumble for combat feedback, kept subtle: hits dealt and taken, block, parry, perfect dodge, guard break,
// kill and death. Off with the 'vibration' setting (game.settings.vibration === false); input.rumble() is a no-op
// without a pad that can rumble.
//   installRumble(game) → the effect table { kind: [strong, weak, ms] }

export const RUMBLE = {
  dealt: [0.1, 0.3, 70],
  kill: [0.4, 0.55, 150],
  taken: [0.5, 0.35, 170],
  block: [0.1, 0.25, 60],
  parry: [0.25, 0.6, 110],
  perfect: [0, 0.45, 140],
  guardbreak: [0.65, 0.45, 230],
  death: [0.7, 0.5, 320],
};

export function installRumble(game) {
  const fire = (kind) => {
    if (game.settings && game.settings.vibration === false) return;
    const [strong, weak, ms] = RUMBLE[kind];
    game.input.rumble(strong, weak, ms);
  };
  const me = (a) => !!a && a === game.player;
  game.on('hit', (e) => {
    const { attacker, target, kind } = e.detail || {};
    if (me(target)) fire(kind === 'parry' ? 'parry' : kind === 'block' ? 'block' : 'taken');
    else if (me(attacker)) fire(kind === 'kill' ? 'kill' : 'dealt');
  });
  game.on('perfect-dodge', () => fire('perfect'));
  game.on('guardbreak', (e) => me(e.detail && e.detail.actor) && fire('guardbreak'));
  game.on('player:death', () => fire('death'));
  return RUMBLE;
}
