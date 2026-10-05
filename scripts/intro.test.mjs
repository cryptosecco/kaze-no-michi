// Tests for the opening cinematic (src/actors/intro.js): the bars' timeline, the path's time warp, the keys, and the
// controller's hand-over and skip with stand-ins for the game, the camera rig and the player controller (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Intro, INTRO, KEYS, SKIP_HOLD, introBars, introProgress } from '../src/actors/intro.js';
import { FILM_ASPECT, filmBars } from '../src/render/PostFX.js';

const DT = 1 / 60;
const FILM = filmBars(16 / 9); // the film letterbox of a 16:9 frame: 0.128 of the frame per bar
const STEP = 0.0025; // the largest move of the bars between two samples (10 ms, or a 60 Hz frame): ~3 px at 1080p

// the height of the bars on screen: the final shader's rule (render/PostFX.js), the taller of letterbox and bars
const shown = (p, film) => Math.max(p.letterbox * film, p.bars);

test('the film letterbox leaves a 2.39:1 picture, and no bars on a frame at least that wide', () => {
  for (const a of [1, 4 / 3, 16 / 10, 16 / 9, 2]) {
    const h = filmBars(a);
    assert.ok(h > 0 && h < 0.5, `bars at ${a.toFixed(2)}`);
    const picture = a / (1 - 2 * h); // the ratio of what is left between the bars
    assert.ok(Math.abs(picture - FILM_ASPECT) < 1e-9, `2.39:1 at ${a.toFixed(2)}`);
  }
  assert.equal(filmBars(FILM_ASPECT), 0);
  assert.equal(filmBars(32 / 9), 0, 'a 32:9 window is wider than the film already');
});

test('the bars open slowly from black onto the film letterbox, easing in and out, and hold there', () => {
  const [o0, o1] = INTRO.open;
  assert.equal(introBars(0, FILM, FILM), 0.5, 'closed: the frame starts black');
  assert.equal(introBars(o0 - 1e-3, FILM, FILM), 0.5);
  assert.ok(o1 - o0 >= 4, 'a slow opening: at least four seconds');
  // 1.9 s in, where a quick opening would be over, the frame is still far from the film format
  assert.ok(introBars(o0 + 1.9, FILM, FILM) > FILM + 0.1, 'still wide open');
  assert.equal(introBars(o1, FILM, FILM), FILM, 'the film letterbox once open');
  for (let t = o1; t < INTRO.retract[0]; t += 0.05) assert.equal(introBars(t, FILM, FILM), FILM, `holds at ${t}`);
  assert.ok(INTRO.gust > o1, 'the wind turns once the bars have settled');
  // a gentle ease at both ends, symmetric; `open` is how far open the frame is: 0 black, 1 the film letterbox
  const open = (t) => (0.5 - introBars(t, FILM, FILM)) / (0.5 - FILM);
  assert.ok(open(o0 + 0.1 * (o1 - o0)) < 0.02, 'barely moving at first');
  assert.ok(1 - open(o0 + 0.9 * (o1 - o0)) < 0.02, 'barely moving at the end: no visible stop');
  assert.ok(Math.abs(open((o0 + o1) / 2) - 0.5) < 1e-9, 'half open half-way');
  assert.ok(introBars(o0 + 0.01, FILM, FILM) > 0.5 - 1e-6, 'no jump as it starts');
  assert.ok(introBars(o1 - 0.01, FILM, FILM) - FILM < 1e-6, 'no jump as it settles');
});

test('the bars never close again and never jump, whatever the frame and the play height', () => {
  for (const film of [FILM, filmBars(4 / 3), filmBars(21 / 9), 0]) {
    for (const play of [film, 0]) {
      let prev = 0.5;
      for (let t = 0; t <= INTRO.duration + 1; t += 0.01) {
        const b = introBars(t, film, play);
        const at = `${t.toFixed(2)} s, film ${film.toFixed(3)}, play ${play.toFixed(3)}`;
        assert.ok(b >= Math.min(film, play) - 1e-12 && b <= 0.5, `in range at ${at}`);
        assert.ok(b <= prev + 1e-12, `never closes again at ${at}`);
        assert.ok(prev - b < STEP, `no jump at ${at}`);
        prev = b;
      }
    }
  }
});

test('the hand-over is seamless: the bars stay on the film letterbox if play has it, else withdraw first', () => {
  const [r0, r1] = INTRO.retract;
  // play keeps the film letterbox: the cinematic's bars never go below it and end on it, nothing moves at the hand-over
  for (let t = INTRO.open[1]; t <= INTRO.duration + 1; t += 0.01) {
    assert.ok(introBars(t, FILM, FILM) >= FILM, `at ${t}`);
  }
  assert.equal(introBars(INTRO.duration, FILM, FILM), FILM);
  assert.equal(introBars(r1, FILM, FILM), FILM);
  // play has none: from the film height down to nothing, within the retract window, which ends before the hand-over
  assert.equal(introBars(r0, FILM, 0), FILM, 'the withdrawal starts from the film height');
  const mid = introBars((r0 + r1) / 2, FILM, 0);
  assert.ok(mid > 0 && mid < FILM, 'mid-withdrawal');
  assert.equal(introBars(r1, FILM, 0), 0, 'gone');
  assert.ok(r1 <= INTRO.duration, 'gone before the hand-over');
  assert.equal(introBars(INTRO.duration, FILM, 0), 0);
});

test('the path is already moving when the bars open and comes to rest at the end', () => {
  assert.equal(introProgress(0), 0);
  assert.ok(Math.abs(introProgress(INTRO.duration) - 1) < 1e-12);
  let prev = 0;
  for (let t = DT; t <= INTRO.duration; t += DT) {
    const u = introProgress(t);
    assert.ok(u >= prev, `monotonic at ${t.toFixed(3)}`);
    prev = u;
  }
  const mean = 1 / INTRO.duration, h = 1e-4;
  const v0 = introProgress(h) / h, v1 = (introProgress(INTRO.duration) - introProgress(INTRO.duration - h)) / h;
  assert.ok(Math.abs(v0 / mean - INTRO.v0) < 1e-3, 'starts at v0 × the mean speed');
  assert.ok(v1 / mean < 1e-3, 'stops at the end');
});

test('the keys come down from far and high toward the samurai, the lens widening toward the play camera', () => {
  for (let i = 1; i < KEYS.length; i++) {
    assert.ok(KEYS[i].back < KEYS[i - 1].back, 'closer behind him');
    assert.ok(KEYS[i].h < KEYS[i - 1].h, 'lower');
    assert.ok(KEYS[i].fov > KEYS[i - 1].fov, 'wider');
  }
  assert.ok(INTRO.gust > INTRO.open[1] && INTRO.gust < INTRO.retract[0], 'the wind turns while the shot plays');
  assert.ok(INTRO.converge[1] === INTRO.duration, 'the path settles on the rig exactly at the hand-over');
});

// stand-ins: just what the controller touches. `base`: the player's letterbox (1 on, 0 off: post.defaults.letterbox,
// which the live param starts from); `aspect`: the shape of the window (the renderer's drawing size)
function rig({ base = 1, aspect = 16 / 9 } = {}) {
  const ev = [], handlers = new Map();
  const input = { keys: new Set(), mouseButtons: new Set(), padButtons: new Set(), held: new Set(), down: (n) => input.held.has(n) };
  const game = {
    state: 'play',
    input,
    camera: { position: new THREE.Vector3(30, 10, 30) },
    renderer: { drawingWidth: Math.round(1080 * aspect), drawingHeight: 1080 },
    post: {
      params: { bars: 0, fade: 0, dofAperture: 0, dofFocus: 12, dofMaxBlur: 10, letterbox: base },
      defaults: { bars: 0, fade: 0, dofAperture: 0, dofFocus: 12, dofMaxBlur: 10, letterbox: base },
    },
    wind: { guided: null, guideTo(x, z, s) { this.guided = { x, z, s }; } },
    groundAt: () => 0,
    emit(type, detail) {
      ev.push(type);
      for (const fn of handlers.get(type) || []) fn({ detail });
    },
    on(type, fn) {
      handlers.set(type, [...(handlers.get(type) || []), fn]);
    },
  };
  const camRig = {
    basePos: new THREE.Vector3(0, 2, -3.7), baseTarget: new THREE.Vector3(0, 1.6, 2), baseFov: 52,
    lookLocked: false, overrideW: 0, override: null, snapNext: false,
    snapBehind() { this.snapNext = true; },
    setOverride(o) { this.override = o; },
    clearOverride() { this.override = null; },
  };
  const player = { position: new THREE.Vector3(0, 0, 0), yaw: 0 };
  const pc = { controlLock: 0, vel: new THREE.Vector3(1, 0, 0) };
  const prompts = { shown: new Map(), set(o, text, key) { this.shown.set(o, { text, key }); }, clear(o) { this.shown.delete(o); } };
  let done = 0;
  const intro = new Intro(game, { player, pc, camRig, prompts, onDone: () => done++ });
  return { game, camRig, pc, prompts, intro, ev, done: () => done };
}

test('the intro takes the camera, waits for the ink, plays, and hands over once', () => {
  const r = rig();
  r.intro.start({ waitReveal: true });
  assert.equal(r.pc.controlLock, Infinity, 'no control during the film');
  assert.equal(r.pc.vel.length(), 0);
  assert.equal(r.camRig.lookLocked, true);
  assert.equal(r.camRig.overrideW, 1, 'the override owns the camera from the first frame');
  assert.equal(r.game.post.params.bars, 0.5, 'black');
  for (let i = 0; i < 120; i++) r.intro.update(DT);
  assert.equal(r.intro.t, 0, 'the clock waits for the ink to dissolve');
  r.game.emit('ui:revealed');
  for (let t = 0; t < INTRO.duration + 1; t += DT) r.intro.update(DT);
  assert.equal(r.done(), 1, 'onDone once');
  assert.deepEqual(r.ev.filter((e) => e.startsWith('intro') || e === 'guide'), ['intro:start', 'intro:open', 'guide', 'intro:end']);
  assert.ok(r.game.wind.guided, 'the wind turned toward the shrine');
  assert.equal(r.pc.controlLock, 0);
  assert.equal(r.camRig.override, null);
  assert.equal(r.camRig.overrideW, 0);
  assert.equal(r.camRig.lookLocked, false);
  const p = r.game.post.params;
  assert.deepEqual([p.bars, p.fade, p.dofAperture, p.dofFocus, p.dofMaxBlur], [0, 0, 0, 12, 10], 'post back to play');
});

for (const base of [1, 0]) {
  const setting = base ? 'on' : 'off';

  test(`what the frame shows only ever opens, and play starts where the cinematic ended (letterbox ${setting})`, () => {
    const r = rig({ base });
    const p = r.game.post.params, d = r.game.post.defaults;
    r.intro.start({});
    let prev = shown(p, FILM), first = prev, last = prev;
    assert.equal(first, 0.5, 'black at the start');
    let frames = 0;
    for (; r.intro.active && frames < 60 * 30; frames++) {
      last = prev;
      r.intro.update(DT);
      const now = shown(p, FILM);
      assert.ok(now <= prev + 1e-12, `never closes again (${r.intro.t.toFixed(2)} s)`);
      assert.ok(prev - now < STEP, `no jump (${r.intro.t.toFixed(2)} s)`);
      assert.equal(p.letterbox, base, 'the cinematic leaves the letterbox alone');
      assert.equal(d.letterbox, base, 'and its base');
      // its own bars (the shader hides what the letterbox covers): never under the film height while play keeps it,
      // settled on what play shows before the hand-over
      const t = r.intro.t;
      if (r.intro.active && t >= INTRO.open[1]) assert.ok(p.bars >= base * FILM - 1e-12, `bars at ${t}`);
      if (r.intro.active && t >= INTRO.retract[1]) assert.equal(p.bars, base * FILM, `settled at ${t}`);
      prev = now;
    }
    assert.equal(r.intro.active, false, 'it ended');
    assert.equal(p.bars, 0, 'the cinematic lets go of the bars');
    // the frame shows what play shows: the film letterbox with the setting on, nothing with it off, and nothing moved
    assert.equal(shown(p, FILM), base * FILM);
    assert.ok(Math.abs(last - shown(p, FILM)) < 1e-9, 'the hand-over frame does not move the bars');
  });

  test(`skipping dips to black and lands on what play shows (letterbox ${setting})`, () => {
    const r = rig({ base });
    const p = r.game.post.params;
    r.intro.start({});
    for (let t = 0; t < 3; t += DT) r.intro.update(DT); // in the middle of the opening
    assert.ok(p.bars > FILM + 0.1, 'the bars are still opening');
    r.game.input.keys.add('KeyE');
    r.game.input.held.add('interact');
    for (let held = 0; held < SKIP_HOLD + 0.1; held += DT) r.intro.update(DT);
    r.game.input.held.clear();
    assert.ok(r.intro.skip, 'skipping');
    for (let i = 0; i < 120 && r.intro.active; i++) r.intro.update(DT);
    assert.equal(r.intro.active, false);
    assert.equal(r.done(), 1);
    assert.equal(p.fade, 0);
    assert.equal(p.bars, 0);
    assert.equal(shown(p, FILM), base * FILM, 'the film letterbox if play has it, else none');
    assert.equal(p.letterbox, base);
  });
}

test('the bars follow the window: the film height is read from the live drawing size every frame', () => {
  const r = rig();
  const p = r.game.post.params, rend = r.game.renderer;
  r.intro.start({});
  while (r.intro.t < INTRO.open[1] + 0.5) r.intro.update(DT);
  assert.ok(Math.abs(p.bars - FILM) < 1e-12, 'the film letterbox of 16:9');
  [rend.drawingWidth, rend.drawingHeight] = [1280, 1024]; // the window is dragged to 5:4
  r.intro.update(DT);
  assert.ok(Math.abs(p.bars - filmBars(1.25)) < 1e-12, 'the film letterbox of 5:4');
  [rend.drawingWidth, rend.drawingHeight] = [3840, 1080]; // an ultra-wide one: the frame is wider than the film already
  r.intro.update(DT);
  assert.equal(p.bars, 0);
});

test('pause freezes it; holding the skip key dips to black and lands on the play framing', () => {
  const r = rig();
  r.intro.start({});
  for (let i = 0; i < 60; i++) r.intro.update(DT);
  const t = r.intro.t;
  r.game.state = 'paused';
  for (let i = 0; i < 60; i++) r.intro.update(0);
  assert.equal(r.intro.t, t, 'frozen in pause');
  r.game.state = 'play';
  r.game.input.keys.add('KeyE');
  r.game.input.held.add('interact');
  r.intro.update(DT);
  assert.ok(r.prompts.shown.get('intro'), 'the skip hint shows after a key press');
  for (let held = 0; held < SKIP_HOLD + 0.1; held += DT) r.intro.update(DT);
  r.game.input.held.clear();
  assert.ok(r.intro.skip, 'skipping');
  let maxFade = 0;
  for (let i = 0; i < 120 && r.intro.active; i++) {
    r.intro.update(DT);
    maxFade = Math.max(maxFade, r.game.post.params.fade);
  }
  assert.equal(maxFade, 1, 'a full dip to black');
  assert.equal(r.done(), 1);
  assert.equal(r.intro.active, false);
  assert.equal(r.game.post.params.fade, 0);
  assert.equal(r.game.post.params.bars, 0);
  assert.equal(r.prompts.shown.size, 0, 'hint cleared');
  // after the jump the override sits on the rig's own pose
  r.intro.active = true;
  const pose = r.intro._eval();
  assert.ok(pose.pos.equals(r.camRig.basePos) && pose.target.equals(r.camRig.baseTarget) && pose.fov === r.camRig.baseFov);
});
