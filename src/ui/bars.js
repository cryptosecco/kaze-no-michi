import { filmBars } from '../render/PostFX.js';

// The film letterbox draws black bars over the top and the bottom of the frame (render/PostFX.js). They stay clean,
// like a film's: the in-play HUD keeps to the picture between them. styles.css places the objective, the vitals, the
// prompt, the toast and the quest card from --kz-bar, the height of one bar in CSS px, which trackBars() keeps on the
// UI root: 0px with the letterbox off, so nothing moves then.

// The height of one bar in CSS px on a frame `width` × `height` px, for the letterbox base `base` (1 on, 0 off): the
// final shader's rule, base × filmBars(aspect) of the frame's height, in the page's own pixels. 0 with the letterbox
// off, on a frame as wide as the film or wider, and on a frame with no size (a minimised window).
export function barPx(base, width, height) {
  if (!(base > 0 && width > 0 && height > 0)) return 0;
  return base * filmBars(width / height) * height;
}

// Writes --kz-bar on `root` now and again whenever the window is resized or the player's letterbox setting changes (not
// every frame). The base is the setting, post.defaults.letterbox (ui/settings.js): what a kill cam or a stand-off
// borrows for a while (post.params) and the opening cinematic's bars never move the HUD.
export function trackBars(game, root) {
  let last = null;
  const update = () => {
    const r = game.renderer;
    const px = Math.round(barPx(game.post.defaults.letterbox, r.width, r.height) * 100) / 100;
    if (px === last) return; // the renderer also calls back when dynamic resolution moves its scale
    last = px;
    root.style.setProperty('--kz-bar', `${px}px`);
  };
  update();
  game.renderer.onResize(update);
  game.on('settings', (e) => {
    if (e.detail && e.detail.key === 'letterbox') update();
  });
}
