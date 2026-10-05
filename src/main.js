import { Game } from './game/Game.js';
import { installDebug } from './core/Debug.js';
import { installModules } from './game/modules.js';

// Boot: build the world, then hand control to the game (and to window.kaze for automation).
const params = new URLSearchParams(location.search);
const shot = params.get('shot');
const boot = document.getElementById('boot');
const bar = boot && boot.querySelector('.bar i');
if (shot && boot) boot.style.display = 'none'; // automated captures never show the boot card

const game = new Game(document.getElementById('app'), {
  quality: params.get('quality') || 'high',
  seed: Number(params.get('seed')) || 1234,
  shot,
  deterministic: !!shot || params.has('deterministic'),
  noFreeCam: false,
});

const api = installDebug(game, params);

game
  .init((p) => {
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  })
  .then(async () => {
    // ?grass=near,mid,pampas,lily → show only these grass layers (debugging)
    if (params.has('grass')) {
      const keep = params.get('grass').split(',');
      for (const l of game.grass.layers) l.mesh.visible = keep.includes(l.kind);
    }
    // feature modules (trees, props, actors, ui, audio) — each failure is isolated and logged
    await installModules(game, { params, shot }, (p) => {
      if (bar) bar.style.width = `${Math.round(90 + p * 10)}%`;
    });
    game._patchNew();
    await game.gl.compileAsync(game.scene, game.camera).catch(() => {});
    if (shot) {
      game.setState('shot');
      api.setShot(shot);
    } else game.setState(game.modules.ui ? 'title' : 'play');
    game.start();
    await game.loop.waitFrames(3);
    if (boot) {
      boot.classList.add('hide');
      setTimeout(() => boot.remove(), 900);
    }
    api.ready = true;
    window.dispatchEvent(new CustomEvent('kaze:ready', { detail: game }));
    // "Return to title" restarts the session cleanly (player, enemies and quests start over)
    game.on('ui:quit', () => location.reload());
  })
  .catch((err) => {
    console.error(err);
    if (boot) boot.textContent = 'Errore di avvio: ' + err.message;
  });

export { game };
