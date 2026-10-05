// Feature modules are loaded dynamically after the core world is built, so a module that fails to load or
// install is logged and skipped instead of taking the whole game down.
// Each module's index.js exports `async install(game, ctx)` where ctx = { params, shot } and may return an
// object that is stored in game.modules[name].
//   ?only=trees,props   load only these modules        ?no=audio   skip these modules
// Order matters: world content first (actors query colliders/ground), wildlife after actors (it reads the samurai,
// the horse, the trees and the props), UI after actors, audio last.

export const MODULES = {
  trees: () => import('../world/trees/index.js'),
  props: () => import('../world/props/index.js'),
  actors: () => import('../actors/index.js'),
  wildlife: () => import('../world/wildlife/index.js'),
  ui: () => import('../ui/index.js'),
  audio: () => import('../audio/index.js'),
};

export async function installModules(game, ctx, onProgress = () => {}) {
  const list = (k) => (ctx.params.get(k) || '').split(',').filter(Boolean);
  const only = list('only');
  const skip = list('no');
  const names = Object.keys(MODULES).filter((n) => (!only.length || only.includes(n)) && !skip.includes(n));
  game.modules = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const mod = await MODULES[name]();
      game.modules[name] = (await mod.install(game, ctx)) || true;
    } catch (err) {
      console.error(`[kaze] module "${name}" failed to install:`, err);
    }
    onProgress((i + 1) / names.length, name);
  }
}
