// Tests for what borrows the film letterbox and has to give the player's back (run: npm test): the kill cam (Combat)
// and the stand-off (Standoff), with stand-ins for the game, the camera rig and the actors. The base is the player's
// setting, post.defaults.letterbox (src/ui/settings.js): 1 with the film letterbox on in play, 0 with it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Combat } from '../src/actors/combat/Combat.js';
import { Standoff } from '../src/actors/combat/Standoff.js';

const fakeGame = (base) => ({
  post: { params: { letterbox: base }, defaults: { letterbox: base } },
  standoffActive: false,
  opts: {},
  groundAt: () => 0,
  emit() {},
});
const camRig = { setOverride() {}, clearOverride() {} };
const at = (x) => ({ position: new THREE.Vector3(x, 0, 0) });

// the kill cam lasts 1.9 s of real time: let it run out
const runOut = (combat) => {
  for (let i = 0; i < 40; i++) combat.update(0.05);
  assert.ok(combat.killCam <= 0, 'the kill cam is over');
};

for (const base of [1, 0]) {
  const setting = base ? 'on' : 'off';

  test(`the kill cam lifts the letterbox to at least 0.6 and gives the player's back (letterbox ${setting})`, () => {
    const g = fakeGame(base);
    const combat = new Combat(g, null, camRig);
    combat.startKillCam(at(0), at(2));
    assert.equal(g.post.params.letterbox, Math.max(base, 0.6));
    runOut(combat);
    assert.equal(g.post.params.letterbox, base);
    assert.equal(g.post.defaults.letterbox, base, 'the base itself is not touched');
  });

  test(`a stand-off raises the letterbox to the film format and gives the player's back (letterbox ${setting})`, () => {
    const g = fakeGame(base);
    const player = {
      position: new THREE.Vector3(),
      alive: true,
      anim: { setBase() {}, play() {}, base: { mode: 'standoff' } },
      setYaw() {},
      fighter: { drawn: false },
    };
    const pc = { a: player, vel: new THREE.Vector3(), controlLock: 0 };
    const prompts = { set() {}, clear() {} };
    const standoff = new Standoff(g, { fighters: [], inCombat: false }, camRig, null, pc, prompts);
    const lead = { actor: { position: new THREE.Vector3(8, 0, 0), weaponKind: 'spear' }, ai: { state: 'idle' } };
    standoff._start([lead]); // update() gets here on E, near an unaware group
    assert.equal(g.standoffActive, true);
    assert.equal(g.post.params.letterbox, 1);
    standoff._end('win'); // and here when the duel is over, won or lost
    assert.equal(g.standoffActive, false);
    assert.equal(g.post.params.letterbox, base);
    assert.equal(g.post.defaults.letterbox, base, 'the base itself is not touched');
  });
}

test('a kill cam that ends during a stand-off leaves the letterbox to the stand-off', () => {
  const g = fakeGame(0);
  const combat = new Combat(g, null, camRig);
  combat.startKillCam(at(0), at(2));
  g.standoffActive = true;
  g.post.params.letterbox = 1; // what the stand-off raised it to
  runOut(combat);
  assert.equal(g.post.params.letterbox, 1, 'not the kill cam\'s to give back');
});

test('a setting toggled while the kill cam runs only matters once it is over: the base read then is right', () => {
  const g = fakeGame(1);
  const combat = new Combat(g, null, camRig);
  combat.startKillCam(at(0), at(2));
  g.post.defaults.letterbox = 0; // the toggle in Settings, while the kill cam runs
  runOut(combat);
  assert.equal(g.post.params.letterbox, 0);
});
