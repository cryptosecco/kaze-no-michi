// Tests for the title screen's look (hour, sky, grade) around a debug shot (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOTS } from '../src/core/shots.js';
import { TitleLook } from '../src/ui/Title.js';

// the parts of Game that TitleLook touches: the hour, the sky's shot overrides and the grade parameters
function fakeGame() {
  const g = {
    timeOfDay: 17.7,
    skyShot: undefined, // the overrides the sky was last given (undefined = the gameplay defaults)
    setTimeOfDay: (h) => {
      g.timeOfDay = h;
    },
    sky: {
      applyShot: (o) => {
        g.skyShot = o;
      },
    },
    post: { params: { grain: 0.028 } },
  };
  // every grade value the shots set, at a neutral default of its own
  for (const id of ['S1_field', 'S4_title']) for (const k of Object.keys(SHOTS[id].post)) g.post.params[k] = 0.5;
  return g;
}

// what kaze.setShot() does to the look (core/Debug.js): the shot's hour, its sky, the grade reset and the shot's values
function setShot(g, id) {
  const s = SHOTS[id];
  g.setTimeOfDay(s.hours);
  g.sky.applyShot(s.sky);
  Object.assign(g.post.params, s.post);
}

test('the title shows the S4 look and, when it closes, brings back the hour, the sky and the grade it found', () => {
  const g = fakeGame(), look = new TitleLook(g);
  const before = { ...g.post.params };
  look.apply();
  assert.equal(g.timeOfDay, SHOTS.S4_title.hours);
  assert.equal(g.skyShot, SHOTS.S4_title.sky);
  assert.equal(g.post.params.exposure, SHOTS.S4_title.post.exposure);
  look.restore();
  assert.equal(g.timeOfDay, 17.7);
  assert.equal(g.skyShot, undefined); // Sky.applyShot() with no overrides: the gameplay sky
  assert.deepEqual(g.post.params, before);
});

test('a shot set while the title is up keeps its own hour, sky and grade once the title is discarded and hidden', () => {
  const g = fakeGame(), look = new TitleLook(g);
  look.apply();
  setShot(g, 'S1_field');
  look.discard(); // UI.onShot, before the title hides
  look.restore(); // Title.hide(): nothing left to put back over the shot
  assert.equal(g.timeOfDay, SHOTS.S1_field.hours);
  assert.equal(g.skyShot, SHOTS.S1_field.sky);
  assert.equal(g.post.params.exposure, SHOTS.S1_field.post.exposure);
  assert.equal(g.post.params.vignette, SHOTS.S1_field.post.vignette);
});

test('discarding without a look saved is harmless, and the title can save a fresh look afterwards', () => {
  const g = fakeGame(), look = new TitleLook(g);
  look.discard();
  look.restore();
  assert.equal(g.timeOfDay, 17.7);
  setShot(g, 'S1_field');
  look.apply(); // a title shown again over the S1 look saves that one
  look.restore();
  assert.equal(g.timeOfDay, SHOTS.S1_field.hours);
  assert.equal(g.skyShot, undefined);
});
