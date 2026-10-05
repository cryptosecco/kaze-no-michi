// Tests for the in-play HUD keeping to the picture between the film letterbox's bars (src/ui/bars.js; run: npm test):
// the height of a bar in CSS px for any window and setting, and --kz-bar following the window and the player's setting,
// with stand-ins for the game, the renderer and the UI root. styles.css reads the variable: its rules are read as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { barPx, trackBars } from '../src/ui/bars.js';
import { FILM_ASPECT, filmBars } from '../src/render/PostFX.js';

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('a bar is 92.2 px on 1280×720, 138.3 on 1920×1080 and 169.8 on 1024×768: the film letterbox in px', () => {
  near(barPx(1, 1280, 720), 92.2);
  near(barPx(1, 1920, 1080), 138.3);
  near(barPx(1, 1024, 768), 169.8);
  const sizes = [[1280, 720], [1920, 1080], [1024, 768], [1280, 800], [1280, 1024], [1440, 960], [2560, 1080]];
  for (const [w, h] of sizes) {
    assert.equal(barPx(1, w, h), filmBars(w / h) * h, `the shader's rule on ${w}×${h}`);
    const picture = w / (h - 2 * barPx(1, w, h)); // what is left between the bars
    assert.ok(Math.abs(picture - FILM_ASPECT) < 1e-9, `2.39:1 on ${w}×${h}`);
  }
});

test('no bars on a frame at least as wide as the film, and none with the letterbox off', () => {
  assert.equal(barPx(1, 2390, 1000), 0, 'exactly 2.39:1');
  assert.equal(barPx(1, 3840, 1080), 0, '32:9');
  near(barPx(1, 2560, 1080), 4.4); // 21:9 is a hair narrower than the film: a hair of bar
  for (const [w, h] of [[1280, 720], [1024, 768], [1920, 1080], [3840, 1080]]) {
    assert.equal(barPx(0, w, h), 0, `off, ${w}×${h}`);
  }
});

test('the base scales the bars as the shader does; no size or no base gives none, never NaN', () => {
  near(barPx(0.5, 1280, 720), barPx(1, 1280, 720) / 2);
  const noSize = [[0, 0], [1280, 0], [0, 720], [-1280, 720], [1280, -720], [NaN, 720], [1280, NaN], [1280, undefined]];
  for (const [w, h] of noSize) assert.equal(barPx(1, w, h), 0, `${w}×${h}`);
  for (const base of [NaN, undefined, null, -1]) assert.equal(barPx(base, 1280, 720), 0, `base ${base}`);
});

// ---- --kz-bar on the UI root ---------------------------------------------------------------------------------------
// What trackBars() touches: the base in post.defaults (post.params is what a kill cam or a stand-off borrows), the
// renderer's size and its resize callbacks, the event bus, and the style of the root.
function stage(base, width, height) {
  const handlers = {}, resizers = [], writes = [];
  const game = {
    post: { params: { letterbox: base, bars: 0 }, defaults: { letterbox: base } },
    renderer: { width, height, onResize: (fn) => resizers.push(fn) },
    on: (type, fn) => (handlers[type] = [...(handlers[type] || []), fn]),
    emit: (type, detail) => (handlers[type] || []).forEach((fn) => fn({ detail })),
    resize(w, h) {
      game.renderer.width = w;
      game.renderer.height = h;
      resizers.forEach((fn) => fn(game.renderer));
    },
  };
  const root = { style: { setProperty: (name, value) => writes.push([name, value]) } };
  return { game, root, writes, now: () => writes.at(-1) && writes.at(-1)[1] };
}
// What Settings.apply('letterbox') does, and the event that Settings.set() emits after it.
const setLetterbox = (game, on) => {
  game.post.params.letterbox = game.post.defaults.letterbox = on ? 1 : 0;
  game.emit('settings', { settings: {}, key: 'letterbox' });
};

test('--kz-bar is on the root before the first frame, in px, and 0px with the letterbox off', () => {
  const on = stage(1, 1280, 720);
  trackBars(on.game, on.root);
  assert.deepEqual(on.writes, [['--kz-bar', '92.22px']]);
  const off = stage(0, 1280, 720);
  trackBars(off.game, off.root);
  assert.deepEqual(off.writes, [['--kz-bar', '0px']], 'with its unit: calc() in styles.css needs one');
});

test('--kz-bar follows the window: another size, another bar, and none on a frame as wide as the film', () => {
  const s = stage(1, 1280, 720);
  trackBars(s.game, s.root);
  s.game.resize(1920, 1080);
  assert.equal(s.now(), '138.33px');
  s.game.resize(1024, 768);
  assert.equal(s.now(), '169.77px');
  s.game.resize(3840, 1080);
  assert.equal(s.now(), '0px');
  s.game.resize(1280, 720);
  assert.equal(s.now(), '92.22px');
  assert.equal(s.writes.length, 5);
});

test('--kz-bar follows the setting, the pause menu\'s toggle, and nothing else touches it', () => {
  const s = stage(1, 1280, 720);
  trackBars(s.game, s.root);
  setLetterbox(s.game, false);
  assert.equal(s.now(), '0px');
  setLetterbox(s.game, true);
  assert.equal(s.now(), '92.22px');
  const n = s.writes.length;
  s.game.emit('settings', { settings: {}, key: 'grain' });
  s.game.emit('settings', undefined);
  s.game.emit('toast', { text: 'x' });
  assert.equal(s.writes.length, n, 'other settings and other events leave it alone');
});

test('it is written when something changed, not at every resize callback (dynamic resolution calls back too)', () => {
  const s = stage(1, 1280, 720);
  trackBars(s.game, s.root);
  for (let i = 0; i < 10; i++) s.game.resize(1280, 720);
  setLetterbox(s.game, true);
  assert.equal(s.writes.length, 1);
});

test('the base is the setting: a stand-off, a kill cam or the cinematic borrowing the letterbox do not move it', () => {
  const off = stage(0, 1280, 720);
  trackBars(off.game, off.root);
  off.game.post.params.letterbox = 1; // a stand-off raises the letterbox to the film format
  off.game.post.params.bars = 0.3; // the opening cinematic
  off.game.resize(1920, 1080);
  assert.equal(off.now(), '0px');
  const on = stage(1, 1280, 720);
  trackBars(on.game, on.root);
  on.game.post.params.letterbox = 0; // a photo is taken without bars
  on.game.post.params.bars = 0.5;
  on.game.resize(1024, 768);
  assert.equal(on.now(), '169.77px', 'the bars of the setting, whatever the params show for a while');
});

// ---- styles.css reads it -------------------------------------------------------------------------------------------
const css = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const declaration = (selector, prop) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`));
  assert.ok(rule, `a rule for ${selector}`);
  const d = rule[1].match(new RegExp(`\\n\\s*${prop}: ([^;]+);`));
  assert.ok(d, `${selector} sets ${prop}`);
  return d[1];
};

test('the objective, the vitals, the prompt, the toast and the quest card are placed from the picture\'s edge', () => {
  for (const [selector, prop] of [
    ['.kz-objective', 'top'],
    ['.kz-hud .kz-vitals', 'bottom'],
    ['.kz-prompt', 'bottom'],
    ['.kz-toast', 'top'],
    ['.kz-card', 'top'],
  ]) {
    assert.match(declaration(selector, prop), /var\(--kz-bar, 0px\)/, `${selector} ${prop}`);
  }
  // the screen-edge margins stay, and the prompt is never lower than its own screen-edge margin
  assert.match(declaration('.kz-objective', 'top'), /clamp\(30px, 5vh, 56px\)/);
  assert.match(declaration('.kz-hud .kz-vitals', 'bottom'), /clamp\(30px, 5\.2vh, 60px\)/);
  assert.match(declaration('.kz-toast', 'top'), /clamp\(40px, 8vh, 90px\)/);
  assert.match(declaration('.kz-prompt', 'bottom'), /^max\(clamp\(96px, 15vh, 170px\), /);
});

test('the damage vignette covers the picture only: its box is inset by a bar at the top and at the bottom', () => {
  assert.equal(declaration('.kz-dmg', 'inset'), 'var(--kz-bar, 0px) 0');
});

// The quest card is centred on its `top`: max(34%, bar + max(17%, 130px)), read from the CSS, for a window `h` tall.
const cardRule = declaration('.kz-card', 'top').replace(/\s+/g, ' ');
const cardParts = cardRule.match(/^max\((\d+)%, calc\(var\(--kz-bar, 0px\) \+ max\((\d+)%, (\d+)px\)\)\)$/);
const cardCentre = (bar, h) => {
  assert.ok(cardParts, `the card's top is max(34%, calc(var(--kz-bar, 0px) + max(17%, 130px))), not ${cardRule}`);
  const [share, floorShare, floorPx] = [cardParts[1] / 100, cardParts[2] / 100, Number(cardParts[3])];
  return Math.max(share * h, bar + Math.max(floorShare * h, floorPx));
};

test('the quest card keeps its first line off the top bar: 202 px or 243 px tall, on windows from 640×480 up', () => {
  assert.equal(cardRule, 'max(34%, calc(var(--kz-bar, 0px) + max(17%, 130px)))');
  const windows = [
    [1920, 1080], [1366, 768], [1280, 720], [1280, 800], [1024, 768], [1280, 1024], // 16:9, 16:10, 4:3, 5:4
    [1024, 576], [960, 540], [800, 600], [854, 480], [640, 480], // small ones, where the card is wrapped
  ];
  for (const [w, h] of windows) {
    const bar = barPx(1, w, h);
    for (const tall of [202.2, 243.2]) {
      // (a card is 202 px tall with its title on one line, 243 px with it wrapped: measured)
      const firstLine = cardCentre(bar, h) - tall / 2;
      const under = (firstLine - bar).toFixed(1);
      assert.ok(firstLine >= bar + 8, `${w}×${h}, ${tall} px card: first line ${under} px under the bar`);
    }
  }
});

test('the quest card stays where it was where 34% is already lower, and with the bars off', () => {
  for (const [w, h] of [[1920, 1080], [2560, 1440], [1366, 768], [1280, 720], [1280, 800], [1440, 900], [1920, 1200]]) {
    assert.equal(cardCentre(barPx(1, w, h), h), 0.34 * h, `${w}×${h}: 34%`);
  }
  for (const h of [480, 540, 600, 720, 1080, 1440]) {
    assert.equal(cardCentre(0, h), 0.34 * h, `letterbox off, ${h} px tall`);
  }
});
