// Tests for the play camera's panorama zoom: the wheel's notches, the zoomed lens and boom, and the rig easing into it
// and out of it around fights, pauses and cutscenes (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraRig, ZOOM, zoomedFov, zoomedDist } from '../src/actors/CameraRig.js';
import { wheelNotches } from '../src/core/Input.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const D2R = Math.PI / 180;

test('a wheel event counts in notches, whatever the device: a quarter at least, one and a half at most', () => {
  assert.equal(wheelNotches(0), 0);
  assert.equal(wheelNotches(100), 1.5, 'a Windows notch (100 px) does not leap');
  assert.equal(wheelNotches(-100), -1.5, 'scrolling away from the user is negative');
  assert.equal(wheelNotches(4), 0.25, 'a slow macOS notch still moves');
  assert.ok(near(wheelNotches(30), 0.5, 1e-12), 'a trackpad event is proportional');
  assert.equal(wheelNotches(3, 1), 1.5, 'Firefox lines');
  assert.ok(near(wheelNotches(1, 1), 0.55, 1e-12));
  assert.equal(wheelNotches(1, 2), 1.5, 'pages');
});

test('the zoomed lens: the rig\'s own at 1, narrower below, wider above, always within its limits', () => {
  assert.ok(near(zoomedFov(52, 1), 52, 1e-9));
  let prev = 0;
  for (let s = ZOOM.min; s <= ZOOM.max + 1e-9; s += 0.05) {
    const f = zoomedFov(52, s);
    assert.ok(f > prev, `the lens widens with the zoom (${s.toFixed(2)} → ${f.toFixed(1)}°)`);
    assert.ok(f >= ZOOM.fovMin && f <= ZOOM.fovMax);
    prev = f;
  }
  assert.ok(zoomedFov(52, ZOOM.min) < 20, `the longest lens is a telephoto: ${zoomedFov(52, ZOOM.min).toFixed(1)}°`);
  assert.ok(zoomedFov(52, ZOOM.max) > 65, `the widest is a wide angle: ${zoomedFov(52, ZOOM.max).toFixed(1)}°`);
  assert.equal(zoomedFov(52, 0.01), ZOOM.fovMin);
  assert.equal(zoomedFov(52, 9), ZOOM.fovMax);
});

test('either way the camera draws back from the samurai and the land gets the room', () => {
  const lens = (s) => Math.tan((zoomedFov(52, s) * D2R) / 2);
  // the samurai's height on screen against the rig's own framing: inversely as the boom times the lens
  const him = (dist, s) => (dist * lens(1)) / (zoomedDist(dist, s) * lens(s));
  for (const dist of [3.7, 4.3, 5.8, 6.9]) {
    assert.ok(near(zoomedDist(dist, 1), dist, 1e-12));
    for (const s of [ZOOM.min, 0.5, 0.8, 1.2, ZOOM.max]) {
      const d = zoomedDist(dist, s);
      assert.ok(d > dist && d <= dist + ZOOM.maxExtra + 1e-9, `${dist} m, zoom ${s}: longer, at most maxExtra more`);
      // mounted (5.8–6.9 m) the boom reaches its cap at the longest lens: horse and rider then grow a little
      assert.ok(him(dist, s) < (s < 1 && dist > 5 ? 1.35 : 1.0 + 1e-9), `${dist} m, zoom ${s}: ${him(dist, s).toFixed(2)}× his usual size`);
    }
  }
  // on foot: a little smaller through the longest lens, a figure in the land through the widest
  assert.ok(him(3.7, ZOOM.min) < 0.9, `${him(3.7, ZOOM.min).toFixed(2)}× at the longest lens`);
  assert.ok(him(3.7, ZOOM.max) < 0.5, `${him(3.7, ZOOM.max).toFixed(2)}× at the widest`);
  // at the longest lens the land is magnified about 1 / s
  assert.ok(lens(1) / lens(ZOOM.min) > 3, `land magnified ${(lens(1) / lens(ZOOM.min)).toFixed(2)}×`);
});

// The rig on stand-ins: flat ground, nothing to collide with, a samurai standing at the origin, an input whose wheel and
// buttons the test sets each frame
function makeRig() {
  const inp = { wheelSteps: 0, press: null, pointerLocked: false, pad: { connected: false }, lookX: 0 };
  inp.look = () => ({ x: inp.lookX, y: 0 });
  inp.pressed = (a) => inp.press === a;
  const game = {
    state: 'play',
    camera: new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 2000),
    input: inp,
    player: { position: new THREE.Vector3(0, 0, 0), yaw: 0, anim: { loco: { speed: 0 } }, rig: { scale: 1 } },
    groundAt: () => 0,
    colliders: { nearby: () => [] },
    loop: { lastFrameMs: 1000 / 60 },
  };
  const rig = new CameraRig(game);
  // n frames at 60 Hz; `wheel` notches arrive on the first frame, `press` is held on the first frame
  rig.run = (seconds, { wheel = 0, press = null } = {}) => {
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) {
      inp.wheelSteps = i === 0 ? wheel : 0;
      inp.press = i === 0 ? press : null;
      rig.frame(1 / 60);
    }
  };
  const camDist = () => game.camera.position.distanceTo(new THREE.Vector3(0, 1.55, 0));
  return { rig, game, inp, camDist };
}

test('scrolling up narrows the lens and lengthens the boom; scrolling down widens it; the wheel click resets', () => {
  const { rig, game, camDist } = makeRig();
  rig.run(2);
  assert.ok(near(game.camera.fov, 52, 0.05), 'the rig\'s own lens to begin with');
  const d0 = camDist();
  rig.run(1.5, { wheel: -3 });
  rig.run(1.5, { wheel: -2 });
  assert.ok(near(rig.zoom, Math.exp(-5 * ZOOM.step), 1e-9), 'five notches in');
  assert.ok(near(game.camera.fov, zoomedFov(52, rig.zoom), 0.05), `the eased lens arrives: ${game.camera.fov.toFixed(2)}°`);
  assert.ok(game.camera.fov < 30);
  assert.ok(camDist() > d0 + 1.5, `the boom lengthens: ${d0.toFixed(2)} → ${camDist().toFixed(2)} m`);
  // the zoom stops at its ends however far the wheel goes
  for (let i = 0; i < 12; i++) rig.run(0.1, { wheel: -3 });
  assert.equal(rig.zoom, ZOOM.min);
  for (let i = 0; i < 12; i++) rig.run(0.1, { wheel: 3 });
  assert.equal(rig.zoom, ZOOM.max);
  rig.run(1.5);
  assert.ok(game.camera.fov > 60, `wide: ${game.camera.fov.toFixed(1)}°`);
  assert.ok(camDist() > d0 + 1.5, `and drawn back: ${camDist().toFixed(2)} m`);
  rig.run(1.5, { press: 'zoomReset' });
  assert.equal(rig.zoom, 1);
  assert.ok(near(game.camera.fov, 52, 0.05), 'back to the rig\'s own lens');
});

test('the zoom eases in over a fraction of a second, without a jump', () => {
  const { rig, game } = makeRig();
  rig.run(1);
  let prev = game.camera.fov, biggest = 0;
  rig.frame(1 / 60);
  game.input.wheelSteps = -3;
  for (let i = 0; i < 90; i++) {
    rig.frame(1 / 60);
    game.input.wheelSteps = 0;
    biggest = Math.max(biggest, Math.abs(game.camera.fov - prev));
    prev = game.camera.fov;
  }
  assert.ok(biggest < 2.5, `at most ${biggest.toFixed(2)}° per frame`);
  assert.ok(near(game.camera.fov, zoomedFov(52, Math.exp(-3 * ZOOM.step)), 0.1), 'and it settles in 1.5 s');
});

test('a fight and a cutscene shot ease back to the rig\'s own lens; the zoom picked comes back after them', () => {
  const { rig, game } = makeRig();
  rig.run(1.5, { wheel: -3 });
  const zoomed = game.camera.fov;
  assert.ok(zoomed < 40);
  // a fight: the combat framing's own lens (55°), whatever the zoom
  rig.combatTarget = { alive: true, position: new THREE.Vector3(4, 0, 4) };
  rig.run(1.5, { wheel: -3 });
  assert.ok(near(game.camera.fov, 55, 0.3), `the fight's lens: ${game.camera.fov.toFixed(2)}°`);
  rig.combatTarget.alive = false;
  rig.run(2);
  assert.ok(game.camera.fov < 40, 'the zoom comes back after the fight');
  // a cutscene override holds its own lens and ignores the wheel
  const before = rig.zoom;
  rig.setOverride({ pos: new THREE.Vector3(0, 3, -8), target: new THREE.Vector3(0, 1, 0), fov: 40 }, 0.3);
  rig.run(1, { wheel: -3 });
  assert.equal(rig.zoom, before, 'the wheel does nothing during a cutscene shot');
  assert.ok(near(game.camera.fov, 40, 0.3), 'the shot\'s own lens');
  rig.clearOverride(0.3);
  rig.run(2);
  assert.ok(near(game.camera.fov, zoomedFov(52, before), 0.3), 'and the zoom after it');
});

test('paused or in a cutscene state the wheel does nothing', () => {
  const { rig, game } = makeRig();
  for (const state of ['paused', 'cutscene', 'title']) {
    game.state = state;
    rig.run(0.5, { wheel: -3 });
    assert.equal(rig.zoom, 1, state);
  }
  game.state = 'play';
  rig.lookLocked = true;
  rig.run(0.5, { wheel: -3 });
  assert.equal(rig.zoom, 1, 'nor while the look is locked');
});

test('through a longer lens the mouse turns the view less, in proportion', () => {
  const { rig, inp } = makeRig();
  inp.pointerLocked = true;
  rig.run(0.5);
  inp.lookX = 0.01;
  let y0 = rig.yaw;
  rig.run(0.5);
  const turnWide = y0 - rig.yaw;
  inp.lookX = 0;
  rig.run(2, { wheel: -3 });
  rig.run(1, { wheel: -3 });
  inp.lookX = 0.01;
  y0 = rig.yaw;
  rig.run(0.5);
  const turnLong = y0 - rig.yaw;
  assert.ok(near(turnLong / turnWide, rig.zoom, 0.02), `${(turnLong / turnWide).toFixed(3)} of the turn at zoom ${rig.zoom.toFixed(3)}`);
});
