// Tests for the per-shot sky overrides (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Sky } from '../src/world/Sky.js';
import { drawnSunDir } from '../src/render/drawnSun.js';
import { GodRays } from '../src/render/Effects.js';
import { atmosphere } from '../src/render/Atmosphere.js';

const D2R = Math.PI / 180;
// direction from a compass bearing (degrees clockwise from north = -Z) and an elevation (degrees)
const dirAt = (azDeg, elDeg) =>
  new THREE.Vector3(Math.sin(azDeg * D2R) * Math.cos(elDeg * D2R), Math.sin(elDeg * D2R), -Math.cos(azDeg * D2R) * Math.cos(elDeg * D2R));
const elevation = (v) => Math.asin(v.y) / D2R;
const bearing = (v) => Math.atan2(v.x, -v.z);

const snapshot = (u) => ({
  sunSize: u.uSunSize.value,
  sunDisc: u.uSunDisc?.value,
  sunHalo: u.uSunHalo?.value,
  sunLift: u.uSunLift?.value,
  cover: u.uCloudCover.value,
  dark: u.uCloudDark.value,
  glow: u.uCloudGlow?.value,
  scale: u.uCloudScale.value,
  soft: u.uCloudSoft.value,
  offset: [u.uCloudOffset.value.x, u.uCloudOffset.value.y],
});

// kaze.setShot / scripts/variants.mjs apply one shot after another in the same page: a shot that sets no sky
// override must get the default sky back, including the cloud field position (which also drifts with the wind)
test('a shot without sky overrides restores every default, cloud offset included', () => {
  const sky = new Sky();
  const defaults = snapshot(sky.uniforms);
  sky.applyShot({ sunSize: 9, sunLift: 3, cloudCover: 0.64, cloudDark: 0.3, cloudSoft: 0.22, cloudScale: 0.5, cloudOffset: [0, 2] });
  assert.deepEqual(snapshot(sky.uniforms).offset, [0, 2]);
  sky.update({ position: new THREE.Vector3() }, 20, { x: 1, y: 0.5 }); // the clouds drift with the wind
  sky.applyShot(undefined);
  assert.deepEqual(snapshot(sky.uniforms), defaults);
});

// S3 dims its giant cinematic sun disc and its aureole, S2 widens the golden glow: the next shot that does not
// set them (here one that only changes the clouds) must get the default sun back
test('the sun disc and halo overrides fall back to their defaults', () => {
  const sky = new Sky();
  const defaults = snapshot(sky.uniforms);
  assert.equal(sky.defaults.sunDisc, 1);
  assert.equal(sky.defaults.sunHalo, 1);
  sky.applyShot({ sunSize: 9, sunDisc: 0.1, sunHalo: 0.3 });
  assert.equal(sky.uniforms.uSunDisc.value, 0.1);
  assert.equal(sky.uniforms.uSunHalo.value, 0.3);
  sky.applyShot({ cloudCover: 0.7 });
  assert.deepEqual(snapshot(sky.uniforms), { ...defaults, cover: 0.7 });
});

// S3 raises its giant cinematic disc above the hills (the light keeps the true sun direction): a shot that does not
// set the lift must draw the disc on the sun again
test('the sun disc lift falls back to its default', () => {
  const sky = new Sky();
  const defaults = snapshot(sky.uniforms);
  assert.equal(sky.defaults.sunLift, 0);
  assert.equal(sky.uniforms.uSunLift.value, 0);
  sky.applyShot({ sunSize: 9, sunLift: 4.5 });
  assert.equal(sky.uniforms.uSunLift.value, 4.5);
  sky.applyShot({ cloudScale: 2 });
  assert.equal(sky.uniforms.uSunLift.value, 0);
  assert.deepEqual(snapshot(sky.uniforms), { ...defaults, scale: 2 });
});

// S5 lights the breaks of its storm deck (the sunlit cloud sides and the pale air low in the sky glow brighter): a
// shot that does not set the glow must get the palette's clouds back
test('the storm glow override falls back to its default', () => {
  const sky = new Sky();
  const defaults = snapshot(sky.uniforms);
  assert.equal(sky.defaults.cloudGlow, 1);
  assert.equal(sky.uniforms.uCloudGlow.value, 1);
  sky.applyShot({ cloudDark: 0.15, cloudGlow: 1.9 });
  assert.equal(sky.uniforms.uCloudGlow.value, 1.9);
  sky.applyShot({ cloudCover: 0.7 });
  assert.equal(sky.uniforms.uCloudGlow.value, 1);
  assert.deepEqual(snapshot(sky.uniforms), { ...defaults, cover: 0.7 });
});

// The sky dome (GLSL) and the light shafts (render/Effects.js) must put the drawn sun on the same spot, so both go
// through the drawn-sun twins: no lift is the true sun untouched, a lift raises it by that angle on its own bearing
test('the drawn sun is the true sun without a lift and rises on its own bearing with one', () => {
  const sun = dirAt(259, 2.9); // S3's sunset sun
  const before = sun.toArray();
  assert.deepEqual(drawnSunDir(sun, 0, new THREE.Vector3()).toArray(), before);
  const up = drawnSunDir(sun, 4.2, new THREE.Vector3());
  assert.deepEqual(sun.toArray(), before); // the true sun is left as it is
  assert.ok(Math.abs(up.length() - 1) < 1e-12);
  assert.ok(Math.abs(elevation(up) - (2.9 + 4.2)) < 1e-9);
  assert.ok(Math.abs(bearing(up) - bearing(sun)) < 1e-12);
});

// the light shafts must radiate from the drawn disc, not from the true sun, which sits at the lower rim of S3's lifted
// giant disc; with no lift nothing changes; their strength stays the light's (the true sun's height)
test('the light shafts radiate from the drawn sun, and from the true sun when nothing is lifted', () => {
  const sky = new Sky(); // registers uSunLift globally, as in the game
  const sun = dirAt(259, 2.9);
  atmosphere.uniforms.uSunDir.value.copy(sun);
  const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.3, 20000); // S3's telephoto, low in the grass
  cam.position.set(40, 18.6, -20);
  cam.lookAt(cam.position.clone().add(dirAt(272, 1.2)));
  cam.updateMatrixWorld();
  const rays = new GodRays({ r: { reversedDepth: false }, params: {} });
  const onScreen = (d) => {
    const p = d.clone().multiplyScalar(1000).add(cam.position).project(cam);
    return [p.x * 0.5 + 0.5, p.y * 0.5 + 0.5];
  };
  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const uv = new THREE.Vector2();

  sky.applyShot({ sunSize: 9, sunLift: 4.2 });
  const visLifted = rays.sunOnScreen(cam, uv);
  assert.ok(near(uv.toArray(), onScreen(drawnSunDir(sun, 4.2, new THREE.Vector3()))));
  assert.ok(!near(uv.toArray(), onScreen(sun)));

  sky.applyShot({});
  const visTrue = rays.sunOnScreen(cam, uv);
  assert.ok(near(uv.toArray(), onScreen(sun)));
  assert.ok(visTrue > 0.1 && Math.abs(visLifted - visTrue) < 1e-9);
});

test('a shot overriding only the cover keeps the other defaults', () => {
  const sky = new Sky();
  const defaults = snapshot(sky.uniforms);
  sky.update({ position: new THREE.Vector3() }, 20, { x: -1, y: 0.2 });
  sky.applyShot({ cloudCover: 0.8 });
  assert.deepEqual(snapshot(sky.uniforms), { ...defaults, cover: 0.8 });
});
