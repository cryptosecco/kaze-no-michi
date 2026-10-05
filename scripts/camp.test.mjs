// Tests for the bandit camp layout shared by the props and trees modules (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POI, campLocal, CAMP_CLEARINGS, inClearing } from '../src/world/Layout.js';
import { S5_HEROES } from '../src/world/trees/placement.js';
import { CAMP_MAKU, MAKU_BANNER, makuSpots, campToLocal } from '../src/world/props/camp.js';
import { SHOTS } from '../src/core/shots.js';

// where p lies relative to the sight line from the S5 viewpoint through q: `along` > 0 beyond q (behind it in the
// view), `lateral` = distance off the line
function offSight(o, q, p) {
  const dx = q.x - o.x, dz = q.z - o.z, L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L, px = p.x - o.x, pz = p.z - o.z;
  return { along: px * ux + pz * uz - L, lateral: Math.abs(px * uz - pz * ux) };
}

// the S5 lens on the ground (the shot's pose on a flat stand-in terrain: only its x, z matter here). The view is
// judged from where the shot really stands, which may sit off the nominal viewpoint POI.camp.view
function s5Lens() {
  const { pos } = SHOTS.S5_ginkgo.pose({ heightAt: () => 0 });
  return { x: pos[0], z: pos[2] };
}

test('the S5 lens stands in the cleared sight line', () => {
  const lens = s5Lens();
  const sight = CAMP_CLEARINGS.find((c) => c.x2 !== undefined);
  assert.ok(sight && inClearing(lens.x, lens.z, [sight]), `the S5 lens (${lens.x.toFixed(1)}, ${lens.z.toFixed(1)}) is outside the cleared sight line`);
});

// the props module clears these shapes after the trees are planted: an S5 hero ginkgo standing inside one would
// be deleted at runtime without any error, so every hero must stand outside all of them
test('the S5 hero trees stand outside every camp tree clearing', () => {
  assert.ok(S5_HEROES.length >= 4);
  for (const [species, lx, lz] of S5_HEROES) {
    const p = campLocal(lx, lz);
    const hit = CAMP_CLEARINGS.find((c) => inClearing(p.x, p.z, [c]));
    assert.equal(hit, undefined, `${species} at local (${lx}, ${lz}) is inside the clearing ${JSON.stringify(hit)}`);
  }
});

test('the camp clearings cover the farmhouse, the fire and the S5 sight line', () => {
  const { house, fire, view } = POI.camp;
  assert.ok(inClearing(house.x, house.z, CAMP_CLEARINGS));
  assert.ok(inClearing(fire.x, fire.z, CAMP_CLEARINGS));
  const mid = { x: (house.x + view.x) / 2, z: (house.z + view.z) / 2 };
  assert.ok(inClearing(mid.x, mid.z, CAMP_CLEARINGS));
  // circles and capsules: a point just outside a circle is not inside it
  assert.equal(inClearing(house.x + 11, house.z, [CAMP_CLEARINGS[0]]), false);
});

// the fire burns in the open yard: no hero trunk next to it, nor rising right behind the flame in the S5 view (it
// would read as a fire lit against the trunk)
test('the camp fire burns clear of the S5 hero trunks, also in the S5 view', () => {
  const { fire } = POI.camp;
  const lens = s5Lens();
  for (const [species, lx, lz] of S5_HEROES) {
    const p = campLocal(lx, lz);
    const d = Math.hypot(p.x - fire.x, p.z - fire.z);
    assert.ok(d >= 3, `${species} at local (${lx}, ${lz}) stands ${d.toFixed(1)} m from the fire`);
    const s = offSight(lens, fire, p);
    if (s.along > 0) assert.ok(s.lateral >= 2, `${species} at local (${lx}, ${lz}) rises behind the flame in the S5 view, ${s.lateral.toFixed(2)} m off its sight line`);
  }
});

// no banner hangs over the fire (smoke and sparks) nor right behind the flame in the S5 view
test('no maku banner hangs over the camp fire or behind its flame in the S5 view', () => {
  const { fire } = POI.camp;
  const lens = s5Lens();
  let n = 0;
  for (const line of CAMP_MAKU)
    for (const b of makuSpots(line)) {
      const p = campLocal(b.lx, b.lz);
      const d = Math.hypot(p.x - fire.x, p.z - fire.z);
      assert.ok(d >= 3, `banner at local (${b.lx.toFixed(1)}, ${b.lz.toFixed(1)}) hangs ${d.toFixed(1)} m from the fire`);
      const s = offSight(lens, fire, p);
      if (s.along > 0) assert.ok(s.lateral >= MAKU_BANNER.w / 2 + 0.6, `banner at local (${b.lx.toFixed(1)}, ${b.lz.toFixed(1)}) hangs behind the flame in the S5 view,${s.lateral.toFixed(2)} m off its sight line`);
      n++;
    }
  assert.ok(n >= 8, 'the camp keeps its banner lines');
  // the local frame inverse used to place the fire from POI.camp.fire round-trips
  const l = campToLocal(fire.x, fire.z), w = campLocal(l.x, l.z);
  assert.ok(Math.hypot(w.x - fire.x, w.z - fire.z) < 1e-9);
});
