// Tests for the canonical shot poses (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOTS } from '../src/core/shots.js';
import { POI } from '../src/world/Layout.js';

// a tilted plane stands in for the island (poses only sample heights)
const terrain = { heightAt: (x, z) => 2 + 0.01 * x - 0.015 * z };

test('Layout exposes the camp farmhouse and the camp entrance view point', () => {
  assert.ok(POI.camp.house && Number.isFinite(POI.camp.house.x) && Number.isFinite(POI.camp.house.z));
  assert.ok(POI.camp.view && Number.isFinite(POI.camp.view.x) && Number.isFinite(POI.camp.view.z));
});

// trees are planted (from the S5 frame) before the props module registers its shots: the S5 pose must be the
// same before and after that registration, or the hero ginkgos frame a camera that is never used
test('S5 pose does not depend on the props module having registered T6_S5', () => {
  const saved = SHOTS.T6_S5;
  delete SHOTS.T6_S5;
  const before = SHOTS.S5_ginkgo.pose(terrain);
  SHOTS.T6_S5 = { pose: () => ({ pos: [0, 0, 0], target: [POI.camp.house.x, 99, POI.camp.house.z] }) };
  const after = SHOTS.S5_ginkgo.pose(terrain);
  if (saved) SHOTS.T6_S5 = saved;
  else delete SHOTS.T6_S5;
  assert.deepEqual(after, before);
});

test('S5 camera looks at the farmhouse', () => {
  const { target } = SHOTS.S5_ginkgo.pose(terrain);
  assert.ok(Math.hypot(target[0] - POI.camp.house.x, target[2] - POI.camp.house.z) < 10);
});

// the camp is built in a local frame (props/camp.js) that the trees module must reproduce to plant the S5 hero
// ginkgos around the house: origin at the house, +z into the house from the viewpoint, +x to its left
test('campLocal maps the camp frame: viewpoint 36 m in front, yard 12 m in front, +x to the viewer\'s left', async () => {
  const { campLocal } = await import('../src/world/Layout.js');
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 1e-6;
  assert.ok(near(campLocal(0, -36), POI.camp.view));
  assert.ok(near(campLocal(0, -12), POI.camp.yard));
  // standing at the viewpoint looking at the house, "right" is (-fz, fx) for the forward f
  const v = POI.camp.view, h = POI.camp.house;
  const fx = (h.x - v.x) / 36, fz = (h.z - v.z) / 36;
  const left = campLocal(1, 0);
  assert.ok(Math.abs((left.x - h.x) * -fz + (left.z - h.z) * fx + 1) < 1e-6);
});
