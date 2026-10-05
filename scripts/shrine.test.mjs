// Tests for the S2 shrine stairs: the forest walls against the S1 composition (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGen } from '../src/world/TerrainGen.js';
import { POI } from '../src/world/Layout.js';
import { SHOTS } from '../src/core/shots.js';
import { sunDirection } from '../src/world/Lighting.js';
import { placeTrees, S2_HEROES, S2_CLEAR, S1_CREST_CLEAR, stairPoint } from '../src/world/trees/placement.js';
import { SPECS } from '../src/world/trees/index.js';
import { buildTree } from '../src/world/trees/generator.js';
import { skyToriiSpot } from '../src/world/props/shrine.js';
import { skyToriiSightLines } from '../src/world/props/index.js';
import { drawnSunDir } from '../src/render/drawnSun.js';
import { hash2 } from '../src/core/math.js';

const terrain = new TerrainGen(1234).generate();
const { trees } = placeTrees(terrain, { seed: 1234, density: 1 });

// the sight lines the props module clears around the sky torii, built exactly as at runtime
const s1Pos = SHOTS.S1_field.pose(terrain).pos;
const sun = sunDirection(SHOTS.S1_field.hours);
const st = skyToriiSpot({ viewer: { x: s1Pos[0], z: s1Pos[2] }, sunAz: (Math.atan2(sun.x, -sun.z) * 180) / Math.PI });
st.y = terrain.heightAt(st.x, st.z);
const lines = skyToriiSightLines(s1Pos, st);
const segDist = (c, px, py, pz) => {
  const ax = c.x2 - c.x, ay = c.y2 - c.y, az = c.z2 - c.z;
  const t = Math.max(0, Math.min(1, ((px - c.x) * ax + (py - c.y) * ay + (pz - c.z) * az) / (ax * ax + ay * ay + az * az)));
  return Math.hypot(px - c.x - ax * t, py - c.y - ay * t, pz - c.z - az * t);
};

// every variant a record of this species can be given at runtime (trees/index.js picks one by a position hash)
const crowns = new Map();
const variantsFor = (r) => {
  const specs = r.variant ? SPECS.filter((s) => s.key === r.variant) : SPECS.filter((s) => s.kind === r.species && !s.big && !s.shape && !s.cls);
  return specs.map((s) => {
    if (!crowns.has(s.key)) crowns.set(s.key, buildTree(s.kind, s.seed, s.big || 1, { shape: s.shape }).crown);
    return { key: s.key, crown: crowns.get(s.key) };
  });
};

test('every S2 hero is planted', () => {
  const s2 = trees.filter((t) => t.tag === 'S2');
  assert.equal(s2.length, S2_HEROES.length, 'an S2 hero stands on the stairs, the summit or a path (see the [trees] warning)');
});

// trees.clear() removes any crown that comes within r of a sight line: an S2 hero there would silently vanish and the
// sky torii would never be in danger, but the S2 frame would lose its forest wall
test('the S2 forest walls keep clear of the S1 -> sky torii sight lines, whatever variant they get', () => {
  for (const r of trees.filter((t) => t.tag === 'S2')) {
    for (const { key, crown } of variantsFor(r)) {
      const cx = r.x + crown.c.x * r.scale, cy = r.y + crown.c.y * r.scale, cz = r.z + crown.c.z * r.scale;
      const cr = Math.max(crown.r.x, crown.r.y, crown.r.z) * r.scale * 0.85;
      for (const c of lines) {
        const d = segDist(c, cx, cy, cz);
        assert.ok(d >= c.r + cr, `${r.species} (${key}) at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}): crown ${d.toFixed(2)} m from a sight line, needs ${(c.r + cr).toFixed(2)}`);
      }
    }
  }
});

// the variant a random record gets at runtime (trees/index.js: a position hash over the species' plain variants)
const plain = {};
for (const s of SPECS) if (s.key !== 'mapleHero' && !s.key.startsWith('ginkgoCol') && !s.cls) (plain[s.kind] ||= []).push(s);
const runtimeCrown = (r) => {
  const specs = r.variant ? SPECS.filter((s) => s.key === r.variant) : plain[r.species];
  const s = r.variant ? specs[0] : specs[Math.floor(hash2(Math.round(r.x * 10), Math.round(r.z * 10)) * specs.length)];
  if (!crowns.has(s.key)) crowns.set(s.key, buildTree(s.kind, s.seed, s.big || 1, { shape: s.shape }).crown);
  return crowns.get(s.key);
};

// the low sun burns above the shrine hill's crest beside the torii, clear of the trees. From the S1 camera no crown of
// the random forest may reach into the drawn disc (sunSize, sunLift of the shot) or the core of its glow; the heroes are
// the S2 stair canopy, framed by the S2 shot, and stay below the lifted disc.
test('the drawn S1 sun stands clear: no random crown reaches into its disc and the core of its glow', () => {
  const sky = SHOTS.S1_field.sky || {};
  const sd = drawnSunDir(sun, sky.sunLift || 0);
  const need = 0.0082 * (sky.sunSize || 1) + (0.5 * Math.PI) / 180;
  for (const r of trees.filter((t) => !t.hero)) {
    const crown = runtimeCrown(r);
    const dx = r.x + crown.c.x * r.scale - s1Pos[0], dy = r.y + crown.c.y * r.scale - s1Pos[1], dz = r.z + crown.c.z * r.scale - s1Pos[2];
    const d = Math.hypot(dx, dy, dz);
    const gap = Math.acos(Math.min(1, (dx * sd.x + dy * sd.y + dz * sd.z) / d)) - Math.atan2(Math.max(crown.r.x, crown.r.y, crown.r.z) * r.scale, d);
    assert.ok(gap >= need, `${r.species} at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) reaches ${((gap * 180) / Math.PI).toFixed(2)}° from the drawn sun, needs ${((need * 180) / Math.PI).toFixed(2)}°`);
  }
});

// Right of the sky torii the crest is bare: the S2 accent crowns that rose over it from S1 (a dark cedar spike and two
// pines, out of the S2 frame) are taken out. The S2 canopy left of the torii stays: it hides the gate hall from S1.
test('the crest right of the sky torii stays bare from S1: the S2 accent crowns taken out stay out', () => {
  assert.ok(S1_CREST_CLEAR.length > 0);
  for (const [s, lat] of S1_CREST_CLEAR) {
    const p = stairPoint(s, lat);
    assert.ok(trees.every((t) => Math.hypot(t.x - p.x, t.z - p.z) > 1.5), `a tree still stands at stair (${s}, ${lat})`);
    assert.ok(S2_HEROES.every(([, hs, hl]) => Math.hypot(hs - s, hl - lat) > 3), `stair (${s}, ${lat}) is an S2 forest wall`);
  }
});

test('the stair crowns taken out stay out, and nothing stands on the widened steps', () => {
  for (const [s, lat] of S2_CLEAR) {
    const p = stairPoint(s, lat);
    assert.ok(trees.every((t) => Math.hypot(t.x - p.x, t.z - p.z) > 1.5), `a tree still stands at stair (${s}, ${lat})`);
  }
  const SH = POI.shrine, u = SH.stairDir;
  const L = Math.hypot(SH.stairsTop.x - SH.stairsBase.x, SH.stairsTop.z - SH.stairsBase.z);
  for (const t of trees) {
    const dx = t.x - SH.stairsBase.x, dz = t.z - SH.stairsBase.z;
    const s = dx * u.x + dz * u.z, lat = dx * u.z - dz * u.x;
    if (s > -1 && s < L + 1) assert.ok(Math.abs(lat) > SH.stairHalf + 0.9, `${t.species} at stair (${s.toFixed(1)}, ${lat.toFixed(1)}) stands on the steps or their curb`);
  }
});
